//! The Insitio JSON API (`/api/v1`) as a blocking client.
//!
//! Every call sends `Authorization: Bearer <token>` (except the two public
//! device-login calls) and a `User-Agent: nsit/<version>`. Errors come back as
//! `NsitError`: a 401 is `Auth`, any other error status is `Api { status, code,
//! message }` from the server's `{"error":{"code","message"}}` body, and a
//! network failure is a one-line `Other`.
//!
//! The token is never put in an error message or in `Debug` output, and the
//! client never follows a redirect, so a bearer token cannot be forwarded to
//! another host.

use std::fmt;
use std::io::Read;
use std::time::Duration;

use reqwest::blocking::{Client, Response};
use reqwest::header::{ACCEPT, RETRY_AFTER};
use reqwest::{redirect, Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;

use crate::config::{base_url, is_loopback};
use crate::credentials::{host_key, is_well_formed};
use crate::error::{one_line, NsitError};

const USER_AGENT: &str = concat!("nsit/", env!("CARGO_PKG_VERSION"));
const TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// A bigger answer than this is not from a healthy Insitio server.
const MAX_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;

// ---- what the server sends -----------------------------------------------------

/// `GET /api/v1/user`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserJson {
    pub login: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub is_admin: bool,
}

/// A repository, as listed and returned by `/api/v1/repos`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoJson {
    pub owner: String,
    pub name: String,
    pub full_name: String,
    #[serde(default)]
    pub description: String,
    pub private: bool,
    pub default_branch: String,
    pub clone_url: String,
    pub html_url: String,
    /// ISO-8601.
    pub created_at: String,
}

/// `POST /api/v1/device/code`: what to show the user and how to poll.
#[derive(Clone, Deserialize)]
pub struct DeviceCodeJson {
    /// Secret: whoever holds it can collect the token once it is approved.
    pub device_code: String,
    /// Shown to the user, `XXXX-XXXX`.
    pub user_code: String,
    pub verification_uri: String,
    /// Seconds until the code stops working.
    pub expires_in: u64,
    /// Seconds to wait between polls.
    pub interval: u64,
}

// Not derived: the device code is a credential.
impl fmt::Debug for DeviceCodeJson {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DeviceCodeJson")
            .field("device_code", &"<redacted>")
            .field("user_code", &self.user_code)
            .field("verification_uri", &self.verification_uri)
            .field("expires_in", &self.expires_in)
            .field("interval", &self.interval)
            .finish()
    }
}

/// One answer to polling `POST /api/v1/device/token`. The "not yet" answers
/// are values, not errors, because the login loop acts on each of them.
#[derive(Clone, PartialEq, Eq)]
pub enum DevicePoll {
    /// The user approved; this is the new access token.
    Approved { token: String, login: String },
    /// `authorization_pending`: keep polling.
    Pending,
    /// `slow_down`: keep polling, but wait longer between polls.
    SlowDown,
    /// `access_denied`: the user said no.
    Denied,
    /// `expired_token`: the code ran out; start again.
    Expired,
}

// Not derived: `Approved` holds a token.
impl fmt::Debug for DevicePoll {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DevicePoll::Approved { login, .. } => f
                .debug_struct("Approved")
                .field("token", &"<redacted>")
                .field("login", login)
                .finish(),
            DevicePoll::Pending => f.write_str("Pending"),
            DevicePoll::SlowDown => f.write_str("SlowDown"),
            DevicePoll::Denied => f.write_str("Denied"),
            DevicePoll::Expired => f.write_str("Expired"),
        }
    }
}

/// The 200 body of `device/token`. No `Debug`: it holds the token.
#[derive(Deserialize)]
struct DeviceTokenJson {
    access_token: String,
    login: String,
}

/// `{"error":{"code","message"}}`, the shape of every API failure.
#[derive(Deserialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Deserialize)]
struct ErrorBody {
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
}

// ---- the client ------------------------------------------------------------------

/// A connection to one Insitio server, with the token to use on it (if any).
pub struct Api {
    base: Url,
    token: Option<String>,
    client: Client,
}

// Not derived: a derived `Debug` would print the token.
impl fmt::Debug for Api {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Api")
            .field("base", &self.base.as_str())
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .finish_non_exhaustive()
    }
}

/// What came back, before it is judged a success or a failure.
struct Reply {
    status: StatusCode,
    retry_after: Option<u64>,
    body: Vec<u8>,
}

impl Api {
    /// Connect to `host` (a bare name or a URL; https only, except loopback).
    /// `token` is sent on every call that needs one. A token that could not be
    /// an `Authorization` value is refused.
    pub fn new(host: &str, token: Option<String>) -> Result<Api, NsitError> {
        let base = base_url(host)?;
        if token.as_deref().is_some_and(|t| !is_well_formed(t)) {
            return Err(NsitError::Usage(
                "the access token is not valid: it must be one line of printable ASCII \
                 without spaces"
                    .into(),
            ));
        }
        let client = build_client(&base)?;
        Ok(Api {
            base,
            token,
            client,
        })
    }

    /// `GET /api/v1/user`: who the token belongs to.
    pub fn user(&self) -> Result<UserJson, NsitError> {
        let url = self.endpoint(&["user"])?;
        let reply = self.send_authed(Method::GET, url, None)?;
        decode(&reply, "user")
    }

    /// `GET /api/v1/repos[?owner=<name>]`: every repository the token can see,
    /// or only the ones owned by `owner`.
    pub fn repos(&self, owner: Option<&str>) -> Result<Vec<RepoJson>, NsitError> {
        let mut url = self.endpoint(&["repos"])?;
        if let Some(owner) = owner {
            url.query_pairs_mut().append_pair("owner", owner);
        }
        let reply = self.send_authed(Method::GET, url, None)?;
        decode(&reply, "repository list")
    }

    /// `POST /api/v1/repos`. Without a `description` the key is left out.
    pub fn create_repo(
        &self,
        name: &str,
        description: Option<&str>,
        private: bool,
    ) -> Result<RepoJson, NsitError> {
        let url = self.endpoint(&["repos"])?;
        let mut body = json!({ "name": name, "private": private });
        if let Some(description) = description {
            body["description"] = json!(description);
        }
        let reply = self.send_authed(Method::POST, url, Some(&body))?;
        decode(&reply, "repository")
    }

    /// `GET /api/v1/repos/<owner>/<name>`. A repository the token may not see
    /// is a 404, like a missing one.
    pub fn repo(&self, owner: &str, name: &str) -> Result<RepoJson, NsitError> {
        let url = self.endpoint(&["repos", owner, name])?;
        let reply = self.send_authed(Method::GET, url, None)?;
        decode(&reply, "repository")
    }

    /// `POST /api/v1/device/code`: start signing in. Public: no token is sent.
    pub fn device_code(&self, client_name: &str) -> Result<DeviceCodeJson, NsitError> {
        let url = self.endpoint(&["device", "code"])?;
        let body = json!({ "client_name": client_name });
        let reply = self.send(Method::POST, url, Some(&body), None)?;
        decode(&self.require_success(reply)?, "device code")
    }

    /// `POST /api/v1/device/token`: ask whether the user has approved yet.
    /// Public: no token is sent. The four "not approved" answers are values;
    /// any other failure is an error.
    pub fn device_token(&self, device_code: &str) -> Result<DevicePoll, NsitError> {
        let url = self.endpoint(&["device", "token"])?;
        let body = json!({ "device_code": device_code });
        let reply = self.send(Method::POST, url, Some(&body), None)?;
        if reply.status.is_success() {
            let approved: DeviceTokenJson = decode(&reply, "device token")?;
            if !is_well_formed(&approved.access_token) {
                return Err(NsitError::Other(
                    "unexpected response from the server (device token)".into(),
                ));
            }
            return Ok(DevicePoll::Approved {
                token: approved.access_token,
                login: approved.login,
            });
        }
        // These codes are the poll outcomes only on a 400.
        if reply.status == StatusCode::BAD_REQUEST {
            if let Ok(envelope) = serde_json::from_slice::<ErrorEnvelope>(&reply.body) {
                match envelope.error.code.as_str() {
                    "authorization_pending" => return Ok(DevicePoll::Pending),
                    "slow_down" => return Ok(DevicePoll::SlowDown),
                    "access_denied" => return Ok(DevicePoll::Denied),
                    "expired_token" => return Ok(DevicePoll::Expired),
                    _ => {}
                }
            }
        }
        Err(self.error_for(&reply))
    }

    /// `DELETE /api/v1/user/tokens/current`: revoke the token this client
    /// holds (logout).
    pub fn revoke_current(&self) -> Result<(), NsitError> {
        let url = self.endpoint(&["user", "tokens", "current"])?;
        self.send_authed(Method::DELETE, url, None).map(|_| ())
    }

    // ---- plumbing ----

    /// `<base>/api/v1/<segments...>`, each segment percent-encoded. A segment
    /// that is empty, `.`/`..` or contains a slash is refused, so a repository
    /// name can never steer the request to a different endpoint.
    fn endpoint(&self, segments: &[&str]) -> Result<Url, NsitError> {
        for segment in segments {
            let bad = segment.is_empty()
                || *segment == "."
                || *segment == ".."
                || segment.contains(['/', '\\'])
                || segment.chars().any(char::is_control);
            if bad {
                return Err(NsitError::Usage(format!(
                    "invalid name in the request: {:?}",
                    one_line(segment, 60)
                )));
            }
        }
        let mut url = self.base.clone();
        url.path_segments_mut()
            .map_err(|()| NsitError::Usage("invalid host".into()))?
            .pop_if_empty()
            .extend(["api", "v1"])
            .extend(segments);
        Ok(url)
    }

    /// A call that needs the token. Without one it fails here, with no network
    /// traffic, exactly as the server's 401 would.
    fn send_authed(
        &self,
        method: Method,
        url: Url,
        body: Option<&Value>,
    ) -> Result<Reply, NsitError> {
        let Some(token) = self.token.as_deref() else {
            return Err(NsitError::Auth("not signed in; run nsit auth login".into()));
        };
        let reply = self.send(method, url, body, Some(token))?;
        self.require_success(reply)
    }

    fn send(
        &self,
        method: Method,
        url: Url,
        body: Option<&Value>,
        token: Option<&str>,
    ) -> Result<Reply, NsitError> {
        let mut request = self
            .client
            .request(method, url)
            .header(ACCEPT, "application/json");
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().map_err(|e| {
            let reason = if e.is_timeout() {
                "the request timed out".to_string()
            } else {
                root_cause(&e)
            };
            self.unreachable(&reason)
        })?;
        let status = response.status();
        let retry_after = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok());
        let body = self.read_body(response)?;
        Ok(Reply {
            status,
            retry_after,
            body,
        })
    }

    /// Read the whole body, but no more than `MAX_RESPONSE_BYTES`.
    fn read_body(&self, response: Response) -> Result<Vec<u8>, NsitError> {
        let mut body = Vec::new();
        response
            .take(MAX_RESPONSE_BYTES + 1)
            .read_to_end(&mut body)
            .map_err(|e| {
                self.unreachable(&format!("the response broke off: {}", root_cause(&e)))
            })?;
        if body.len() as u64 > MAX_RESPONSE_BYTES {
            return Err(NsitError::Other(
                "the server's response is too large; is this really an Insitio server?".into(),
            ));
        }
        Ok(body)
    }

    fn unreachable(&self, reason: &str) -> NsitError {
        NsitError::Other(format!(
            "cannot reach {}: {}",
            host_key(&self.base),
            one_line(reason, 200)
        ))
    }

    fn require_success(&self, reply: Reply) -> Result<Reply, NsitError> {
        if reply.status.is_success() {
            Ok(reply)
        } else {
            Err(self.error_for(&reply))
        }
    }

    /// Turn a failed reply into the right `NsitError`. Server text is cut to one
    /// short line. Nothing from the request, the token included, is repeated.
    fn error_for(&self, reply: &Reply) -> NsitError {
        let status = reply.status;
        let number = status.as_u16();
        if status.is_redirection() {
            return NsitError::Api {
                status: number,
                code: "redirect".into(),
                message: "the server answered with a redirect; nsit does not follow \
                          redirects, so check the host name"
                    .into(),
            };
        }
        if status == StatusCode::UNAUTHORIZED {
            return NsitError::Auth(
                "the server did not accept the access token; run nsit auth login".into(),
            );
        }
        let (code, message) = match serde_json::from_slice::<ErrorEnvelope>(&reply.body) {
            Ok(envelope) => (
                one_line(&envelope.error.code, 64),
                one_line(&envelope.error.message, 300),
            ),
            Err(_) => (String::new(), String::new()),
        };
        let code = if code.is_empty() {
            format!("http_{number}")
        } else {
            code
        };
        let mut message = if message.is_empty() {
            status
                .canonical_reason()
                .map_or_else(|| format!("HTTP {number}"), str::to_string)
        } else {
            message
        };
        if let Some(seconds) = reply.retry_after {
            message.push_str(&format!(" (retry after {seconds} s)"));
        }
        NsitError::Api {
            status: number,
            code,
            message,
        }
    }
}

/// The client every call goes through: rustls, a 30 s timeout, `nsit/<version>`
/// and **no redirects**, so a token can never follow a redirect to another
/// scheme, host or port. Loopback servers (tests) skip any system proxy.
fn build_client(base: &Url) -> Result<Client, NsitError> {
    let mut builder = Client::builder()
        .redirect(redirect::Policy::none())
        .timeout(TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(USER_AGENT);
    if is_loopback(base) {
        builder = builder.no_proxy();
    }
    builder.build().map_err(|e| {
        NsitError::Other(format!(
            "cannot set up the HTTP client: {}",
            one_line(&root_cause(&e), 200)
        ))
    })
}

fn decode<T: DeserializeOwned>(reply: &Reply, what: &str) -> Result<T, NsitError> {
    // serde's own message can quote the offending value, so it is not shown.
    serde_json::from_slice(&reply.body)
        .map_err(|_| NsitError::Other(format!("unexpected response from the server ({what})")))
}

/// The innermost message of an error chain, which for network errors is the
/// useful part ("connection refused", "invalid peer certificate: ...").
fn root_cause(err: &(dyn std::error::Error + 'static)) -> String {
    let mut deepest = err;
    while let Some(source) = deepest.source() {
        deepest = source;
    }
    deepest.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use std::time::Duration;

    use serde_json::{json, Value};

    const TOKEN: &str = "ins_test_token_123";
    const VERSION: &str = env!("CARGO_PKG_VERSION");

    const REPO: &str = r#"{"owner":"ada","name":"hello","full_name":"ada/hello","description":"A repo","private":true,"default_branch":"main","clone_url":"https://git.iam.bot/ada/hello.git","html_url":"https://git.iam.bot/ada/hello","created_at":"2026-10-18T12:00:00.000Z"}"#;

    fn sample_repo() -> RepoJson {
        RepoJson {
            owner: "ada".into(),
            name: "hello".into(),
            full_name: "ada/hello".into(),
            description: "A repo".into(),
            private: true,
            default_branch: "main".into(),
            clone_url: "https://git.iam.bot/ada/hello.git".into(),
            html_url: "https://git.iam.bot/ada/hello".into(),
            created_at: "2026-10-18T12:00:00.000Z".into(),
        }
    }

    // ---- a tiny in-process HTTP server -------------------------------------

    /// One request as the server saw it.
    #[derive(Clone, Debug)]
    struct Seen {
        method: String,
        target: String,
        headers: Vec<(String, String)>,
        body: String,
    }

    impl Seen {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.as_str())
        }

        fn path(&self) -> &str {
            self.target.split('?').next().unwrap_or("")
        }

        fn json_body(&self) -> Value {
            serde_json::from_str(&self.body).unwrap_or_else(|e| panic!("{e}: {:?}", self.body))
        }
    }

    /// The canned answer to one request.
    struct Canned {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl Canned {
        fn with_header(mut self, name: &str, value: &str) -> Canned {
            self.headers.push((name.into(), value.into()));
            self
        }
    }

    fn json_reply(status: u16, body: &str) -> Canned {
        Canned {
            status,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: body.as_bytes().to_vec(),
        }
    }

    fn api_error(status: u16, code: &str, message: &str) -> Canned {
        json_reply(
            status,
            &json!({"error": {"code": code, "message": message}}).to_string(),
        )
    }

    struct TestServer {
        port: u16,
        seen: Arc<Mutex<Vec<Seen>>>,
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl TestServer {
        fn start(handler: impl Fn(&Seen) -> Canned + Send + 'static) -> TestServer {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let seen = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let thread = {
                let (seen, stop) = (seen.clone(), stop.clone());
                std::thread::spawn(move || {
                    for stream in listener.incoming() {
                        if stop.load(Ordering::SeqCst) {
                            break;
                        }
                        let Ok(mut stream) = stream else { continue };
                        let Some(request) = read_request(&mut stream) else {
                            continue;
                        };
                        let canned = handler(&request);
                        seen.lock().unwrap().push(request);
                        // The client may hang up early (oversized body test).
                        let _ = write_response(&mut stream, &canned);
                    }
                })
            };
            TestServer {
                port,
                seen,
                stop,
                thread: Some(thread),
            }
        }

        fn url(&self) -> String {
            format!("http://127.0.0.1:{}", self.port)
        }

        fn seen(&self) -> Vec<Seen> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            // Wake the accept loop so it can notice the flag.
            let _ = TcpStream::connect(("127.0.0.1", self.port));
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn read_request(stream: &mut TcpStream) -> Option<Seen> {
        stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
        let mut reader = BufReader::new(stream.try_clone().ok()?);
        let mut line = String::new();
        reader.read_line(&mut line).ok()?;
        let mut parts = line.split_whitespace();
        let method = parts.next()?.to_string();
        let target = parts.next()?.to_string();
        let mut headers = Vec::new();
        let mut length = 0usize;
        loop {
            line.clear();
            reader.read_line(&mut line).ok()?;
            let header = line.trim_end();
            if header.is_empty() {
                break;
            }
            let (name, value) = header.split_once(':')?;
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().ok()?;
            }
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
        let mut body = vec![0u8; length];
        reader.read_exact(&mut body).ok()?;
        Some(Seen {
            method,
            target,
            headers,
            body: String::from_utf8_lossy(&body).into_owned(),
        })
    }

    fn write_response(stream: &mut TcpStream, canned: &Canned) -> std::io::Result<()> {
        let mut head = format!(
            "HTTP/1.1 {} Test\r\nContent-Length: {}\r\nConnection: close\r\n",
            canned.status,
            canned.body.len()
        );
        for (name, value) in &canned.headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str("\r\n");
        stream.write_all(head.as_bytes())?;
        stream.write_all(&canned.body)?;
        stream.flush()
    }

    fn client(server: &TestServer, token: Option<&str>) -> Api {
        Api::new(&server.url(), token.map(String::from)).unwrap()
    }

    // ---- requests and decoding ---------------------------------------------

    #[test]
    fn user_decodes_and_sends_the_bearer_token_and_user_agent() {
        let server = TestServer::start(|_| {
            json_reply(
                200,
                r#"{"login":"ada","name":"Ada Lovelace","email":"ada@example.com","is_admin":true}"#,
            )
        });
        let user = client(&server, Some(TOKEN)).user().unwrap();
        assert_eq!(
            user,
            UserJson {
                login: "ada".into(),
                name: "Ada Lovelace".into(),
                email: "ada@example.com".into(),
                is_admin: true,
            }
        );
        let seen = server.seen();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].method, "GET");
        assert_eq!(seen[0].path(), "/api/v1/user");
        assert_eq!(
            seen[0].header("authorization"),
            Some(format!("Bearer {TOKEN}").as_str())
        );
        assert_eq!(
            seen[0].header("user-agent"),
            Some(format!("nsit/{VERSION}").as_str())
        );
        assert_eq!(seen[0].header("accept"), Some("application/json"));
    }

    #[test]
    fn user_with_empty_profile_fields_decodes() {
        let server = TestServer::start(|_| {
            json_reply(
                200,
                r#"{"login":"ada","name":"","email":"","is_admin":false,"extra":"ignored"}"#,
            )
        });
        let user = client(&server, Some(TOKEN)).user().unwrap();
        assert_eq!(user.login, "ada");
        assert_eq!(user.name, "");
        assert!(!user.is_admin);
    }

    #[test]
    fn an_endpoint_that_needs_a_token_fails_locally_when_there_is_none() {
        let server = TestServer::start(|_| json_reply(200, "{}"));
        let api = client(&server, None);
        for err in [
            api.user().unwrap_err(),
            api.repos(None).unwrap_err(),
            api.create_repo("x", None, true).unwrap_err(),
            api.repo("ada", "x").unwrap_err(),
            api.revoke_current().unwrap_err(),
        ] {
            assert!(matches!(err, NsitError::Auth(_)), "{err:?}");
            assert_eq!(err.exit_code(), 3);
            assert!(err.to_string().contains("nsit auth login"), "{err}");
        }
        assert!(server.seen().is_empty(), "no request without a token");
    }

    #[test]
    fn repos_lists_everything_visible() {
        let server = TestServer::start(|_| json_reply(200, &format!("[{REPO},{REPO}]")));
        let repos = client(&server, Some(TOKEN)).repos(None).unwrap();
        assert_eq!(repos, vec![sample_repo(), sample_repo()]);
        assert_eq!(server.seen()[0].target, "/api/v1/repos");
    }

    #[test]
    fn repos_by_owner_sends_an_encoded_owner_query() {
        let server = TestServer::start(|_| json_reply(200, "[]"));
        let api = client(&server, Some(TOKEN));
        assert!(api.repos(Some("ada")).unwrap().is_empty());
        assert!(api.repos(Some("a b&c")).unwrap().is_empty());
        let seen = server.seen();
        assert_eq!(seen[0].target, "/api/v1/repos?owner=ada");
        assert_eq!(seen[1].target, "/api/v1/repos?owner=a+b%26c");
    }

    #[test]
    fn a_path_prefix_on_the_host_is_kept() {
        let server = TestServer::start(|_| json_reply(200, "[]"));
        for host in ["/insitio", "/insitio/", "/a/b"] {
            let api = Api::new(&format!("{}{host}", server.url()), Some(TOKEN.into())).unwrap();
            api.repos(None).unwrap();
        }
        let targets: Vec<_> = server.seen().iter().map(|s| s.target.clone()).collect();
        assert_eq!(
            targets,
            [
                "/insitio/api/v1/repos",
                "/insitio/api/v1/repos",
                "/a/b/api/v1/repos"
            ]
        );
    }

    #[test]
    fn create_repo_posts_json_and_decodes_201() {
        let server = TestServer::start(|_| json_reply(201, REPO));
        let api = client(&server, Some(TOKEN));
        assert_eq!(
            api.create_repo("hello", Some("A repo"), false).unwrap(),
            sample_repo()
        );
        api.create_repo("hello", None, true).unwrap();
        let seen = server.seen();
        assert_eq!(seen[0].method, "POST");
        assert_eq!(seen[0].path(), "/api/v1/repos");
        assert_eq!(seen[0].header("content-type"), Some("application/json"));
        assert_eq!(
            seen[0].header("authorization"),
            Some(format!("Bearer {TOKEN}").as_str())
        );
        assert_eq!(
            seen[0].json_body(),
            json!({"name": "hello", "description": "A repo", "private": false})
        );
        // No description: the key is left out (the server wants a string).
        assert_eq!(
            seen[1].json_body(),
            json!({"name": "hello", "private": true})
        );
    }

    #[test]
    fn create_repo_422s_keep_their_codes() {
        for (code, message) in [
            ("name_taken", "Repository ada/hello already exists"),
            ("invalid", "Repository names may only contain letters"),
        ] {
            let server = TestServer::start(move |_| api_error(422, code, message));
            let err = client(&server, Some(TOKEN))
                .create_repo("hello", None, true)
                .unwrap_err();
            match &err {
                NsitError::Api {
                    status,
                    code: got,
                    message: text,
                } => {
                    assert_eq!(*status, 422);
                    assert_eq!(got, code);
                    assert_eq!(text, message);
                }
                other => panic!("{other:?}"),
            }
            assert_eq!(err.exit_code(), 1);
            assert_eq!(err.to_string(), message);
        }
    }

    #[test]
    fn repo_decodes_and_hits_the_owner_name_path() {
        let server = TestServer::start(|_| json_reply(200, REPO));
        let repo = client(&server, Some(TOKEN)).repo("ada", "hello").unwrap();
        assert_eq!(repo, sample_repo());
        assert_eq!(server.seen()[0].target, "/api/v1/repos/ada/hello");
    }

    #[test]
    fn repo_404_is_an_api_error_with_the_not_found_code() {
        let server = TestServer::start(|_| api_error(404, "not_found", "Repository not found"));
        let err = client(&server, Some(TOKEN))
            .repo("ada", "nope")
            .unwrap_err();
        match &err {
            NsitError::Api {
                status,
                code,
                message,
            } => {
                assert_eq!(*status, 404);
                assert_eq!(code, "not_found");
                assert_eq!(message, "Repository not found");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(err.exit_code(), 1);
    }

    #[test]
    fn repo_path_segments_are_encoded_and_dangerous_ones_refused() {
        let server = TestServer::start(|_| json_reply(200, REPO));
        let api = client(&server, Some(TOKEN));
        api.repo("a b", "c?d#e%f").unwrap();
        assert_eq!(server.seen()[0].target, "/api/v1/repos/a%20b/c%3Fd%23e%25f");

        for (owner, name) in [
            ("ada", ".."),
            ("..", "x"),
            (".", "x"),
            ("ada", "../x"),
            ("ada/evil", "x"),
            ("ada", "a/b"),
            ("a\\b", "x"),
            ("ada", ""),
            ("", "x"),
        ] {
            let err = api.repo(owner, name).unwrap_err();
            assert!(
                matches!(err, NsitError::Usage(_)),
                "{owner:?}/{name:?}: {err:?}"
            );
        }
        assert_eq!(
            server.seen().len(),
            1,
            "refused names must not be requested"
        );
    }

    #[test]
    fn revoke_current_deletes_and_accepts_204() {
        let server = TestServer::start(|_| Canned {
            status: 204,
            headers: vec![],
            body: vec![],
        });
        client(&server, Some(TOKEN)).revoke_current().unwrap();
        let seen = server.seen();
        assert_eq!(seen[0].method, "DELETE");
        assert_eq!(seen[0].path(), "/api/v1/user/tokens/current");
        assert_eq!(
            seen[0].header("authorization"),
            Some(format!("Bearer {TOKEN}").as_str())
        );
    }

    // ---- device login --------------------------------------------------------

    const DEVICE_CODE: &str = r#"{"device_code":"dc_very_secret","user_code":"BCDF-GHJK","verification_uri":"https://git.iam.bot/login/device","expires_in":600,"interval":5}"#;

    #[test]
    fn device_code_posts_the_client_name_and_never_sends_a_token() {
        let server = TestServer::start(|_| json_reply(200, DEVICE_CODE));
        // Even an Api that has a token keeps it away from this public endpoint.
        let code = client(&server, Some(TOKEN))
            .device_code("GREGORY-PC")
            .unwrap();
        assert_eq!(code.device_code, "dc_very_secret");
        assert_eq!(code.user_code, "BCDF-GHJK");
        assert_eq!(code.verification_uri, "https://git.iam.bot/login/device");
        assert_eq!(code.expires_in, 600);
        assert_eq!(code.interval, 5);
        let seen = server.seen();
        assert_eq!(seen[0].method, "POST");
        assert_eq!(seen[0].path(), "/api/v1/device/code");
        assert_eq!(seen[0].json_body(), json!({"client_name": "GREGORY-PC"}));
        assert_eq!(seen[0].header("authorization"), None);
        assert_eq!(
            seen[0].header("user-agent"),
            Some(format!("nsit/{VERSION}").as_str())
        );
    }

    #[test]
    fn device_code_rate_limit_is_an_api_error_that_mentions_retry_after() {
        let server = TestServer::start(|_| {
            api_error(429, "rate_limited", "Too many sign-in requests.")
                .with_header("retry-after", "30")
        });
        let err = client(&server, None).device_code("pc").unwrap_err();
        match &err {
            NsitError::Api {
                status,
                code,
                message,
            } => {
                assert_eq!(*status, 429);
                assert_eq!(code, "rate_limited");
                assert!(message.contains("Too many sign-in requests."), "{message}");
                assert!(message.contains("30"), "{message}");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn device_token_turns_every_outcome_into_a_value() {
        let server = TestServer::start(|req| {
            let code = req.json_body()["device_code"].as_str().unwrap().to_string();
            match code.as_str() {
                "approved" => json_reply(
                    200,
                    r#"{"access_token":"ins_new_token","token_type":"bearer","login":"ada"}"#,
                ),
                "pending" => api_error(400, "authorization_pending", "not yet"),
                "slow" => api_error(400, "slow_down", "too fast"),
                "denied" => api_error(400, "access_denied", "no"),
                "expired" => api_error(400, "expired_token", "too late"),
                other => panic!("unexpected device code {other}"),
            }
        });
        let api = client(&server, None);
        let cases = [
            (
                "approved",
                DevicePoll::Approved {
                    token: "ins_new_token".into(),
                    login: "ada".into(),
                },
            ),
            ("pending", DevicePoll::Pending),
            ("slow", DevicePoll::SlowDown),
            ("denied", DevicePoll::Denied),
            ("expired", DevicePoll::Expired),
        ];
        for (code, want) in cases {
            assert_eq!(api.device_token(code).unwrap(), want, "{code}");
        }
        let seen = server.seen();
        assert_eq!(seen[0].method, "POST");
        assert_eq!(seen[0].path(), "/api/v1/device/token");
        assert_eq!(seen[0].header("authorization"), None);
        assert_eq!(seen[0].json_body(), json!({"device_code": "approved"}));
    }

    #[test]
    fn device_token_failures_that_are_not_poll_outcomes_stay_errors() {
        let cases: Vec<(Canned, u16, &str)> = vec![
            (api_error(400, "bad_request", "no"), 400, "bad_request"),
            (api_error(400, "invalid", "no"), 400, "invalid"),
            // The poll codes only count on a 400.
            (
                api_error(500, "authorization_pending", "no"),
                500,
                "authorization_pending",
            ),
            (api_error(429, "rate_limited", "no"), 429, "rate_limited"),
            (json_reply(502, "<html>Bad Gateway</html>"), 502, "http_502"),
        ];
        for (canned, status, code) in cases {
            let canned = Arc::new(Mutex::new(Some(canned)));
            let server = TestServer::start(move |_| canned.lock().unwrap().take().unwrap());
            let err = client(&server, None).device_token("dc").unwrap_err();
            match &err {
                NsitError::Api {
                    status: s, code: c, ..
                } => assert_eq!((*s, c.as_str()), (status, code)),
                other => panic!("{other:?}"),
            }
        }
    }

    #[test]
    fn approved_token_that_cannot_be_a_header_is_refused_without_echoing_it() {
        let server = TestServer::start(|_| {
            json_reply(
                200,
                r#"{"access_token":"ins_bad token","token_type":"bearer","login":"ada"}"#,
            )
        });
        let err = client(&server, None).device_token("dc").unwrap_err();
        assert!(matches!(err, NsitError::Other(_)), "{err:?}");
        assert!(!err.to_string().contains("ins_bad"), "{err}");
    }

    // ---- errors ----------------------------------------------------------------

    #[test]
    fn a_401_is_an_auth_error_with_a_sign_in_hint_and_no_token() {
        let server = TestServer::start(|_| {
            api_error(
                401,
                "unauthorized",
                "A valid access token is required (Authorization: Bearer <token>).",
            )
            .with_header("www-authenticate", "Bearer")
        });
        let api = client(&server, Some(TOKEN));
        for err in [
            api.user().unwrap_err(),
            api.repos(None).unwrap_err(),
            api.create_repo("x", None, true).unwrap_err(),
            api.repo("ada", "x").unwrap_err(),
            api.revoke_current().unwrap_err(),
        ] {
            assert!(matches!(err, NsitError::Auth(_)), "{err:?}");
            assert_eq!(err.exit_code(), 3);
            let text = err.to_string();
            assert!(text.contains("nsit auth login"), "{text}");
            assert!(!text.contains(TOKEN) && !text.contains("Bearer"), "{text}");
            assert!(!text.contains('\n'), "{text:?}");
        }
    }

    #[test]
    fn a_non_json_error_body_becomes_a_short_http_code_error() {
        let server = TestServer::start(|_| Canned {
            status: 502,
            headers: vec![("Content-Type".into(), "text/html".into())],
            body: b"<html><body><h1>502 Bad Gateway</h1>\n<p>nginx</p></body></html>".to_vec(),
        });
        let err = client(&server, Some(TOKEN)).user().unwrap_err();
        match &err {
            NsitError::Api {
                status,
                code,
                message,
            } => {
                assert_eq!(*status, 502);
                assert_eq!(code, "http_502");
                assert_eq!(message, "Bad Gateway");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(err.to_string(), "Bad Gateway");
    }

    #[test]
    fn server_text_is_cleaned_to_one_short_line() {
        let long = "x".repeat(1000);
        let server = TestServer::start(move |_| {
            api_error(
                422,
                "inv\u{1b}[31malid",
                &format!("first line\nsecond\tline \u{1b}[2J{long}"),
            )
        });
        let err = client(&server, Some(TOKEN))
            .create_repo("x", None, true)
            .unwrap_err();
        let NsitError::Api { code, message, .. } = &err else {
            panic!("{err:?}")
        };
        assert_eq!(code, "inv[31malid");
        assert!(
            message.starts_with("first line second line [2J"),
            "{message}"
        );
        assert!(message.chars().count() < 400, "{}", message.len());
        assert!(!err.to_string().contains(['\n', '\t', '\u{1b}']), "{err:?}");
    }

    #[test]
    fn json_error_without_a_code_falls_back_to_the_status() {
        let server = TestServer::start(|_| json_reply(403, r#"{"error":{"message":"nope"}}"#));
        let err = client(&server, Some(TOKEN)).user().unwrap_err();
        match err {
            NsitError::Api {
                status,
                code,
                message,
            } => {
                assert_eq!((status, code.as_str()), (403, "http_403"));
                assert_eq!(message, "nope");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_success_with_an_unexpected_body_is_a_clean_error() {
        for body in ["not json", "{\"login\": 5}", "[]", ""] {
            let server = TestServer::start(move |_| json_reply(200, body));
            let err = client(&server, Some(TOKEN)).user().unwrap_err();
            assert!(matches!(err, NsitError::Other(_)), "{body:?}: {err:?}");
            assert!(err.to_string().contains("unexpected response"), "{err}");
            assert!(!err.to_string().contains('\n'), "{err:?}");
        }
    }

    #[test]
    fn redirects_are_refused_and_the_token_goes_nowhere_else() {
        let elsewhere = TestServer::start(|_| {
            json_reply(
                200,
                r#"{"login":"mallory","name":"","email":"","is_admin":false}"#,
            )
        });
        let target = format!("{}/api/v1/user", elsewhere.url());
        for status in [301u16, 302, 303, 307, 308] {
            let location = target.clone();
            let origin = TestServer::start(move |_| Canned {
                status,
                headers: vec![("Location".into(), location.clone())],
                body: vec![],
            });
            let err = client(&origin, Some(TOKEN)).user().unwrap_err();
            match &err {
                NsitError::Api {
                    status: s, code, ..
                } => {
                    assert_eq!(*s, status);
                    assert_eq!(code, "redirect");
                }
                other => panic!("{status}: {other:?}"),
            }
            assert!(!err.to_string().contains(TOKEN), "{err}");
            assert!(!err.to_string().contains("127.0.0.1"), "{err}");
            assert_eq!(origin.seen().len(), 1, "{status}: followed the redirect");
        }
        assert!(
            elsewhere.seen().is_empty(),
            "a redirect target was contacted: {:?}",
            elsewhere.seen()
        );
    }

    #[test]
    fn an_unreachable_server_is_a_one_line_error_without_the_token() {
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        }; // closed again: nothing listens on `port`
        let api = Api::new(&format!("http://127.0.0.1:{port}"), Some(TOKEN.into())).unwrap();
        let err = api.user().unwrap_err();
        assert!(matches!(err, NsitError::Other(_)), "{err:?}");
        assert_eq!(err.exit_code(), 1);
        let text = err.to_string();
        assert!(
            text.starts_with(&format!("cannot reach 127.0.0.1:{port}: ")),
            "{text}"
        );
        assert!(!text.contains('\n'), "{text:?}");
        assert!(!text.contains(TOKEN) && !text.contains("Bearer"), "{text}");
    }

    #[test]
    fn an_oversized_response_is_refused() {
        let server = TestServer::start(|_| json_reply(200, &" ".repeat(17 * 1024 * 1024)));
        let err = client(&server, Some(TOKEN)).user().unwrap_err();
        assert!(matches!(err, NsitError::Other(_)), "{err:?}");
        assert!(err.to_string().contains("too large"), "{err}");
    }

    // ---- construction and Debug ------------------------------------------------

    #[test]
    fn debug_output_never_contains_the_token() {
        let api = Api::new("https://git.iam.bot", Some("ins_super_secret".into())).unwrap();
        let shown = format!("{api:?} {api:#?}");
        assert!(!shown.contains("ins_super_secret"), "{shown}");
        assert!(shown.contains("git.iam.bot"), "{shown}");
        assert!(shown.contains("redacted"), "{shown}");
        let anonymous = format!("{:?}", Api::new("https://git.iam.bot", None).unwrap());
        assert!(!anonymous.contains("redacted"), "{anonymous}");
    }

    #[test]
    fn debug_output_of_device_values_hides_codes_and_tokens() {
        let code: DeviceCodeJson = serde_json::from_str(DEVICE_CODE).unwrap();
        let shown = format!("{code:?} {code:#?}");
        assert!(!shown.contains("dc_very_secret"), "{shown}");
        assert!(
            shown.contains("BCDF-GHJK"),
            "the user code is meant to be shown"
        );

        let poll = DevicePoll::Approved {
            token: "ins_new_token".into(),
            login: "ada".into(),
        };
        let shown = format!("{poll:?} {poll:#?}");
        assert!(!shown.contains("ins_new_token"), "{shown}");
        assert!(shown.contains("ada"), "{shown}");
        assert_eq!(format!("{:?}", DevicePoll::Pending), "Pending");
    }

    #[test]
    fn https_hosts_build_a_client_with_rustls() {
        assert!(Api::new("git.iam.bot", None).is_ok());
        assert!(Api::new("https://git.iam.bot:8443/", Some(TOKEN.into())).is_ok());
    }

    #[test]
    fn plain_http_is_only_for_loopback_and_credentials_in_the_host_are_refused() {
        for host in [
            "http://example.com",
            "http://10.0.0.5:3000",
            "ftp://example.com",
            "",
        ] {
            let err = Api::new(host, Some(TOKEN.into())).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{host:?}: {err:?}");
        }
        assert!(Api::new("http://localhost:3000", None).is_ok());
        assert!(Api::new("http://[::1]:3000", None).is_ok());
        let err = Api::new("https://ada:hunter2@example.com", None).unwrap_err();
        assert!(!err.to_string().contains("hunter2"), "{err}");
    }

    #[test]
    fn a_token_that_cannot_be_a_header_value_is_refused_without_echoing_it() {
        for bad in ["", "two words", "new\nline", "ins_caf\u{e9}", "tab\there"] {
            let err = Api::new("https://git.iam.bot", Some(bad.to_string())).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{bad:?}: {err:?}");
            if !bad.trim().is_empty() {
                assert!(!err.to_string().contains(bad.trim()), "{err}");
            }
        }
    }
}
