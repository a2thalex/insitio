//! Credentials for libgit2's network operations (fetch, clone, push).
//!
//! The token reaches libgit2 only through its credentials callback, as HTTP
//! Basic auth: the account's login as the user name and the token as the
//! password, which is what Insitio's git endpoint expects. It never goes into
//! a remote URL, `.git/config`, a log line or an error message.
//!
//! **Every network operation goes through `run_remote`.** It is the one
//! function that
//!
//! 1. picks the token for the repository's own server (`token_for_repo`: an
//!    `NSIT_TOKEN` is never offered to a server other than the selected one),
//!    before anything touches the network;
//! 2. builds the credentials and progress callbacks, and hands them over as
//!    options that refuse redirects to other hosts and follow the machine's
//!    proxy settings (`uses_system_proxy`; libgit2 reads none unless told to); and
//! 3. turns every git error into the right `NsitError`, so a refused login is
//!    exit 3 with a sign-in hint instead of a bare libgit2 message.
//!
//! `remote_callbacks` is the first step of that and private to this module, so
//! nothing can build credentials without also getting the redirect policy and
//! the error mapping.

use std::fmt;
use std::io::{self, IsTerminal};
use std::rc::Rc;

use git2::{
    Cred, CredentialType, ErrorClass, ErrorCode, FetchOptions, ProxyOptions, PushOptions,
    PushUpdate, RemoteCallbacks, RemoteRedirect,
};
use url::Url;

use super::progress::{install_progress, progress_wanted, write_to_stderr, Sink};
use crate::config::{is_loopback, scheme_allowed};
use crate::credentials::{host_key, host_key_for};
use crate::error::NsitError;
use crate::output::Out;
use crate::repo_ref::{signed_in_login, token_for_repo, RepoRef};

/// The credentials and progress for one network operation on `target`,
/// returned only after the token for `target`'s server has been chosen with
/// `token_for_repo(selected_host, target)`: signed out is `Auth` (exit 3),
/// and an `NSIT_TOKEN` is refused for a server other than `selected_host`
/// (also `Auth`), in both cases before anything touches the network and
/// without ever reading stdin. The one request it may make is
/// `GET /api/v1/user` to `target`'s server, to learn whose `NSIT_TOKEN` it is.
///
/// Progress is added only when stdout and stderr are terminals and `-q` was
/// not given, and goes to stderr.
///
/// Use each set of callbacks for one operation only: the credentials are
/// offered once, and a second request means the server refused them. Private:
/// `run_remote` is the way in, and it also refuses redirects and maps errors.
fn remote_callbacks<'a>(
    target: &RepoRef,
    selected_host: &str,
    out: &'a Out,
) -> Result<RemoteCallbacks<'a>, NsitError> {
    // First: which token may go to this server. Nothing else happens before
    // this answers, so a refusal means nothing was sent anywhere.
    let (token, source) = token_for_repo(selected_host, target)?;
    // The login is asked of `target`'s server only now that it may have the token.
    let login = signed_in_login(&target.host, source, &token)?;
    let provider = CredentialProvider::new(&target.host_key(), &login, &token);
    let show = progress_wanted(out.tty && io::stderr().is_terminal(), out.quiet);
    let progress = show.then(|| Rc::new(write_to_stderr) as Sink<'a>);
    Ok(build_callbacks(provider, progress))
}

/// The callbacks for one operation, wrapped so that they can only become
/// fetch or push options that refuse off-site redirects.
pub struct RemoteAccess<'a> {
    callbacks: RemoteCallbacks<'a>,
    /// Whether this operation follows the proxy the machine names: see `uses_system_proxy`.
    system_proxy: bool,
}

impl<'a> RemoteAccess<'a> {
    /// Options for `Remote::fetch`, and for `RepoBuilder::fetch_options` (which
    /// is how `nsit clone` gets its credentials): these callbacks, and no
    /// redirect to another host.
    pub fn fetch_options(self) -> FetchOptions<'a> {
        let mut options = FetchOptions::new();
        options
            .remote_callbacks(self.callbacks)
            .proxy_options(proxy_options(self.system_proxy))
            .follow_redirects(RemoteRedirect::None);
        options
    }

    /// Options for `Remote::push`: these callbacks, and no redirect to
    /// another host.
    ///
    /// A push has two things to watch, and they are the only additions the
    /// caller may make to the callbacks (it cannot replace the credentials or
    /// the progress): `on_negotiation` runs once the server has advertised its
    /// branches and before anything is uploaded, with the updates the push
    /// would make (an error cancels the push); `on_status` runs for each
    /// branch after the upload, with the server's reason when it refused the
    /// update (an error stops libgit2 from updating remote-tracking refs).
    pub fn push_options(
        self,
        on_negotiation: impl FnMut(&[PushUpdate<'_>]) -> Result<(), git2::Error> + 'a,
        on_status: impl FnMut(&str, Option<&str>) -> Result<(), git2::Error> + 'a,
    ) -> PushOptions<'a> {
        let mut callbacks = self.callbacks;
        callbacks
            .push_negotiation(on_negotiation)
            .push_update_reference(on_status);
        let mut options = PushOptions::new();
        options
            .remote_callbacks(callbacks)
            .proxy_options(proxy_options(self.system_proxy))
            .follow_redirects(RemoteRedirect::None);
        options
    }
}

/// Run one network operation on `target` with the right credentials.
///
/// `op` gets a `RemoteAccess` to turn into `fetch_options()` or
/// `push_options()` (use it for exactly one fetch or push); whatever git error
/// it returns is mapped with `remote_error`. If nobody is signed in, or the
/// token may not go to `target`'s server, `op` is never called.
///
/// ```ignore
/// run_remote(&repo_ref, selected_host, out, |access| {
///     let mut options = access.fetch_options();
///     remote.fetch(&["+refs/heads/*:refs/remotes/origin/*"], Some(&mut options), None)
/// })?;
/// ```
pub fn run_remote<T>(
    target: &RepoRef,
    selected_host: &str,
    out: &Out,
    op: impl FnOnce(RemoteAccess<'_>) -> Result<T, git2::Error>,
) -> Result<T, NsitError> {
    let callbacks = remote_callbacks(target, selected_host, out)?;
    let access = RemoteAccess {
        callbacks,
        system_proxy: uses_system_proxy(target),
    };
    op(access).map_err(|err| remote_error(err, &target.host))
}

/// How long libgit2 waits for a TCP connection to a server, in milliseconds.
const CONNECT_TIMEOUT_MS: i32 = 30_000;

/// How long libgit2 waits for the server to read or send the next piece of data, in
/// milliseconds. An *idle* limit, not a limit on the whole operation: a push of gigabytes is
/// fine as long as bytes keep moving. It is long because the server says nothing while it
/// unpacks and indexes what it was sent, which for a very large push can take minutes.
const IDLE_TIMEOUT_MS: i32 = 10 * 60 * 1000;

/// Give libgit2's network sockets a connect timeout and an idle timeout. libgit2 defaults both
/// to 0, which means for ever: a server that accepts the connection and then says nothing
/// would hang `clone`, `push` and `pull` until somebody kills them.
///
/// Call it **once, first thing in `main`**, before anything else uses libgit2 and while the
/// process has one thread: libgit2 keeps these in two plain global variables that it reads
/// without any locking.
///
/// **Which transports it reaches** (checked in libgit2 1.9.7, the vendored copy):
///
/// * The two settings live in `git_socket_stream` (`streams/socket.c`), which reads them when
///   it makes a stream. Everything that opens a socket by itself goes through it: the TLS
///   streams of the OpenSSL build (Linux) and of SecureTransport (macOS), and libgit2's own
///   plain-HTTP client (a loopback test server). The connect timeout bounds `connect`; the
///   idle timeout bounds each wait for the socket to become readable or writable.
/// * **Not the WinHTTP transport**, which is what a Windows build uses for both `https` and
///   `http` (`transports/winhttp.c`, `GIT_WINHTTP`). It never opens a socket of its own and
///   sets its own limits with `WinHttpSetTimeouts`: 60 s to connect, and no limit (infinite)
///   to resolve, send or receive. So on Windows a connect is bounded at 60 s whatever is set
///   here, and a server that connects and then stalls is not timed out by libgit2.
pub fn set_network_timeouts() -> Result<(), NsitError> {
    // SAFETY: `git2::opts` writes libgit2 globals without synchronization, so it must not run
    // concurrently with other libgit2 calls or threads. This is called once, at the very start
    // of `main`, before any other libgit2 call and before nsit has started a thread.
    unsafe {
        git2::opts::set_server_connect_timeout_in_milliseconds(CONNECT_TIMEOUT_MS)?;
        git2::opts::set_server_timeout_in_milliseconds(IDLE_TIMEOUT_MS)?;
    }
    Ok(())
}

/// Does git traffic to `target` go through the proxy the machine names (`http.proxy` in the
/// git configuration, then `HTTPS_PROXY`/`HTTP_PROXY`, minus `NO_PROXY`)?
///
/// Yes, for every server but a loopback one: the same rule as the API client, which uses the
/// system proxy except for a loopback server (`api::build_client`). That keeps a developer's
/// proxy out of the way of a local test server, and means `auth`, `repo`, `clone`, `push` and
/// `pull` all reach a server the same way.
fn uses_system_proxy(target: &RepoRef) -> bool {
    !is_loopback(&target.clone_url)
}

/// The proxy options of a fetch or push. libgit2 reads no proxy setting unless it is told to
/// (`git_proxy_t` defaults to none, and then `HTTPS_PROXY`, `NO_PROXY` and `http.proxy` are all
/// ignored); `auto` makes it look them up for the server it connects to, and honor `NO_PROXY`.
///
/// Nothing here sets proxy credentials (libgit2 asks for them through a callback of its own,
/// separate from the one that hands out the token, and nsit sets none): the token can only ever
/// be offered to the server, never to a proxy in front of it.
fn proxy_options(system_proxy: bool) -> ProxyOptions<'static> {
    let mut options = ProxyOptions::new();
    if system_proxy {
        options.auto();
    }
    options
}

/// What a failed fetch or push should say. libgit2 reports "the server
/// refused the credentials" (and our own refusal to try twice) as an
/// authentication error: that is exit 3 with a sign-in hint, not a git error.
pub fn remote_error(err: git2::Error, host: &str) -> NsitError {
    if err.code() == ErrorCode::Auth {
        let key = host_key_for(host).unwrap_or_else(|_| "the server".to_string());
        return NsitError::Auth(format!(
            "authentication failed for {key}; run nsit auth login"
        ));
    }
    NsitError::Git(err)
}

/// The answer to libgit2's "credentials, please".
struct CredentialProvider {
    /// The one server the token may go to (`host[:port]`).
    host_key: String,
    login: String,
    token: String,
    requests: u32,
}

// Not derived: a derived `Debug` would print the token.
impl fmt::Debug for CredentialProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CredentialProvider")
            .field("host_key", &self.host_key)
            .field("login", &self.login)
            .field("token", &"<redacted>")
            .finish()
    }
}

impl CredentialProvider {
    fn new(host_key: &str, login: &str, token: &str) -> CredentialProvider {
        CredentialProvider {
            host_key: host_key.to_string(),
            login: login.to_string(),
            token: token.to_string(),
            requests: 0,
        }
    }

    /// libgit2 asks again after every 401, which for a password that is
    /// wrong would go on for ever. So the first request is answered and any
    /// later one is an authentication failure.
    ///
    /// Nothing is handed out unless the URL is on the server the token is
    /// for, and only as a username and password (never as the other kinds
    /// libgit2 may offer: ssh keys, the system's default credentials).
    fn provide(&mut self, url: &str, allowed: CredentialType) -> Result<Cred, git2::Error> {
        // The same rule as for the host itself: https, or http only on loopback.
        let on_our_host =
            Url::parse(url).is_ok_and(|u| scheme_allowed(&u) && host_key(&u) == self.host_key);
        if !on_our_host {
            // Not an authentication failure: nothing was tried, and nothing sent.
            return Err(git2::Error::new(
                ErrorCode::User,
                ErrorClass::Http,
                format!(
                    "refusing to send your token to a host other than {}",
                    self.host_key
                ),
            ));
        }
        if !allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
            return Err(git2::Error::new(
                ErrorCode::User,
                ErrorClass::Http,
                "the server asked for a kind of sign-in that nsit does not support",
            ));
        }
        self.requests += 1;
        if self.requests > 1 {
            return Err(git2::Error::new(
                ErrorCode::Auth,
                ErrorClass::Http,
                "the server did not accept the access token",
            ));
        }
        Cred::userpass_plaintext(&self.login, &self.token)
    }
}

/// The callbacks for one operation: credentials always, progress when
/// `progress` says where to write it.
fn build_callbacks<'a>(
    mut provider: CredentialProvider,
    progress: Option<Sink<'a>>,
) -> RemoteCallbacks<'a> {
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |url, _username_from_url, allowed| provider.provide(url, allowed));
    if let Some(sink) = progress {
        install_progress(&mut callbacks, sink);
    }
    callbacks
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::time::{Duration, Instant};

    use git2::Repository;

    use super::*;
    use crate::config::Config;
    use crate::credentials::{store_token, TOKEN_ENV};
    use crate::repo_ref::parse_repo_ref;
    use crate::test_env::EnvGuard;
    use crate::test_support::{
        base64, fetch_with, host_entry_for, isolated_env, out_with, serve_once, source_repo,
        StubServer,
    };

    fn provider() -> CredentialProvider {
        CredentialProvider::new("git.iam.bot", "ada", "ins_secret_token")
    }

    const URL: &str = "https://git.iam.bot/ada/rocket.git";

    /// `remote_callbacks` builds credentials without the redirect policy or the
    /// error mapping, so only this module may call it: `run_remote` is the one
    /// public way onto the network. Rust cannot assert that an item is private,
    /// so this reads the two source files that would show it.
    #[test]
    fn run_remote_is_the_only_public_network_entry_point() {
        let auth = include_str!("auth.rs");
        // Built from pieces so that this test's own text does not match.
        let public = format!("pub {} remote_callbacks", "fn");
        let private = format!("\n{} remote_callbacks<", "fn");
        assert!(
            !auth.contains(&public),
            "remote_callbacks must not be public"
        );
        assert!(
            auth.contains(&private),
            "remote_callbacks should be a private fn"
        );
        assert!(auth.contains("pub fn run_remote<"));
        let module = include_str!("mod.rs");
        assert!(
            !module.contains("remote_callbacks"),
            "git/mod.rs must not re-export remote_callbacks"
        );
        assert!(module.contains("run_remote"));
    }

    #[test]
    fn the_first_request_gets_the_login_and_the_token() {
        let mut p = provider();
        let cred = p.provide(URL, CredentialType::USER_PASS_PLAINTEXT).unwrap();
        assert!(cred.has_username());
        assert_ne!(
            cred.credtype() as u32 & CredentialType::USER_PASS_PLAINTEXT.bits(),
            0
        );
        // libgit2 usually offers several kinds at once.
        let mut p = provider();
        let any = CredentialType::USER_PASS_PLAINTEXT | CredentialType::DEFAULT;
        assert!(p.provide(URL, any).is_ok());
    }

    #[test]
    fn the_second_request_fails_as_an_authentication_failure_so_libgit2_stops_retrying() {
        let mut p = provider();
        assert!(p.provide(URL, CredentialType::USER_PASS_PLAINTEXT).is_ok());
        for _ in 0..3 {
            let err = p
                .provide(URL, CredentialType::USER_PASS_PLAINTEXT)
                .err()
                .expect("a retry means the server said no");
            assert_eq!(err.code(), ErrorCode::Auth, "{err}");
            assert!(!err.message().contains("ins_secret_token"), "{err}");
        }
    }

    #[test]
    fn it_offers_a_token_only_where_a_password_is_allowed() {
        for allowed in [
            CredentialType::SSH_KEY,
            CredentialType::USERNAME,
            CredentialType::DEFAULT,
            CredentialType::empty(),
        ] {
            let mut p = provider();
            let err = p.provide(URL, allowed).err().expect("no password allowed");
            assert!(!err.message().contains("ins_secret_token"), "{err}");
        }
    }

    #[test]
    fn it_never_hands_the_token_to_another_host() {
        for url in [
            "https://evil.example/ada/rocket.git",
            "https://git.iam.bot.evil.example/ada/rocket.git",
            "http://git.iam.bot/ada/rocket.git",
            "https://git.iam.bot:8443/ada/rocket.git",
            "ssh://git.iam.bot/ada/rocket.git",
            "not a url",
            "",
        ] {
            let mut p = provider();
            let err = p
                .provide(url, CredentialType::USER_PASS_PLAINTEXT)
                .err()
                .unwrap_or_else(|| panic!("{url:?} must not get the token"));
            assert!(!err.message().contains("ins_secret_token"), "{err}");
            // Refusing is not "wrong password": it is not reported as one.
            assert_ne!(err.code(), ErrorCode::Auth, "{url:?}");
            // And the refusal did not use up the attempt for the right host.
            assert!(p.provide(URL, CredentialType::USER_PASS_PLAINTEXT).is_ok());
        }
    }

    #[test]
    fn the_host_check_ignores_case_and_default_ports() {
        let mut p = provider();
        assert!(p
            .provide(
                "https://GIT.iam.bot:443/ada/rocket.git",
                CredentialType::USER_PASS_PLAINTEXT
            )
            .is_ok());
        let mut p = CredentialProvider::new("127.0.0.1:3000", "ada", "ins_t");
        assert!(p
            .provide(
                "http://127.0.0.1:3000/ada/x.git",
                CredentialType::USER_PASS_PLAINTEXT
            )
            .is_ok());
    }

    #[test]
    fn the_provider_never_prints_the_token() {
        let p = provider();
        let shown = format!("{p:?}");
        assert!(!shown.contains("ins_secret_token"), "{shown}");
    }

    // ---- remote_callbacks and run_remote -------------------------------------------

    /// `ada/rocket` on the server at `host` (a base URL, as `RepoRef.host` is).
    fn repo_on(host: &str) -> RepoRef {
        parse_repo_ref("ada/rocket", "ada", &Url::parse(host).unwrap()).unwrap()
    }

    /// Store `token` for `account` on the server at `host`, as `nsit auth login` would.
    fn sign_in_to(host: &str, account: &str, token: &str) {
        store_token(host, account, token).unwrap();
        let mut config = Config::load().unwrap();
        config.hosts.insert(
            host_key_for(host).unwrap(),
            host_entry_for(account, None, None),
        );
        config.save().unwrap();
    }

    /// A fetch of everything the remote has, the way a caller of `run_remote` writes it.
    fn fetch_all(
        access: RemoteAccess<'_>,
        repo: &Repository,
        url: &str,
    ) -> Result<(), git2::Error> {
        let mut remote = repo.remote_anonymous(url)?;
        let mut options = access.fetch_options();
        remote.fetch(
            &["+refs/heads/*:refs/remotes/o/*"],
            Some(&mut options),
            None,
        )
    }

    fn empty_repo() -> (tempfile::TempDir, Repository) {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        (dir, repo)
    }

    const NO_WAIT: Duration = Duration::ZERO;
    const SETTLE: Duration = Duration::from_millis(300);

    #[test]
    fn signed_out_is_an_auth_error_before_any_network_use() {
        let dir = tempfile::tempdir().unwrap();
        let _env = isolated_env(dir.path());
        let server = StubServer::refusing();
        let target = repo_on(&server.host());
        let out = out_with(false, false);

        let started = Instant::now();
        let err = remote_callbacks(&target, &server.host(), &out)
            .err()
            .expect("signed out");
        assert!(matches!(err, NsitError::Auth(_)), "{err:?}");
        assert_eq!(err.exit_code(), 3);
        assert!(err.to_string().contains("nsit auth login"), "{err}");

        // run_remote says the same and never runs the operation.
        let mut ran = false;
        let err = run_remote(&target, &server.host(), &out, |_| {
            ran = true;
            Ok(())
        })
        .unwrap_err();
        assert_eq!(err.exit_code(), 3, "{err}");
        assert!(!ran, "the operation must not start while signed out");

        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(server.connections_after(SETTLE), 0, "no request at all");
    }

    #[test]
    fn nsit_token_is_not_sent_to_another_host_and_no_request_reaches_either_server() {
        let dir = tempfile::tempdir().unwrap();
        let _env = isolated_env(dir.path()).set(TOKEN_ENV, "ins_agent_token");
        // The command was aimed at `selected`; the URL it was given names `other`.
        let selected = StubServer::refusing();
        let other = StubServer::refusing();
        let target = repo_on(&other.host());
        let out = out_with(false, false);

        let err = remote_callbacks(&target, &selected.host(), &out)
            .err()
            .expect("an NSIT_TOKEN must not follow a URL to another host");
        assert!(matches!(err, NsitError::Auth(_)), "{err:?}");
        assert_eq!(err.exit_code(), 3);
        assert_eq!(
            err.to_string(),
            format!(
                "NSIT_TOKEN is sent only to the selected host, and {} is not it",
                other.host_key()
            )
        );
        assert!(!err.to_string().contains("ins_agent_token"), "{err}");

        let mut ran = false;
        let err = run_remote(&target, &selected.host(), &out, |_| {
            ran = true;
            Ok(())
        })
        .unwrap_err();
        assert_eq!(err.exit_code(), 3, "{err}");
        assert!(!ran);

        // Not the login lookup (`GET /api/v1/user`) either: nobody was contacted.
        assert_eq!(selected.connections_after(SETTLE), 0);
        assert_eq!(other.connections_after(NO_WAIT), 0);
    }

    #[test]
    fn a_stored_token_reaches_libgit2_as_the_logged_in_account_and_token_once() {
        let dir = tempfile::tempdir().unwrap();
        let _env = isolated_env(dir.path());
        let server = StubServer::refusing();
        // The account (grace) is not the repository's owner (ada): the login comes
        // from the config, not from the name in the URL.
        sign_in_to(&server.host(), "grace", "ins_stored_token");
        let target = repo_on(&server.host());
        let (_dir, repo) = empty_repo();

        let started = Instant::now();
        let err = run_remote(&target, &server.host(), &out_with(false, false), |access| {
            fetch_all(access, &repo, target.clone_url.as_str())
        })
        .unwrap_err();
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "it must give up, not keep retrying"
        );

        // The server refused the token: exit 3 with a sign-in hint, not a git error.
        assert!(matches!(err, NsitError::Auth(_)), "{err:?}");
        assert_eq!(err.exit_code(), 3);
        assert_eq!(
            err.to_string(),
            format!(
                "authentication failed for {}; run nsit auth login",
                server.host_key()
            )
        );
        assert!(!err.to_string().contains("ins_stored_token"));

        // On the wire: the first request has no credentials, the one after the
        // challenge has `login:token` as Basic auth, and nothing is sent a third time.
        let seen = server.requests();
        assert!(
            seen[0].request_line.contains("/ada/rocket.git/info/refs"),
            "{seen:?}"
        );
        assert_eq!(seen[0].authorization, None, "{seen:?}");
        let want = format!("Basic {}", base64("grace:ins_stored_token"));
        assert_eq!(
            seen[1].authorization.as_deref(),
            Some(want.as_str()),
            "{seen:?}"
        );
        assert_eq!(seen.len(), 2, "credentials were offered once: {seen:?}");
        // The token is not in the URL either.
        assert!(seen
            .iter()
            .all(|s| !s.request_line.contains("ins_stored_token")));
    }

    #[test]
    fn a_push_gets_the_same_credentials_and_the_same_error_mapping() {
        let dir = tempfile::tempdir().unwrap();
        let _env = isolated_env(dir.path());
        let server = StubServer::refusing();
        sign_in_to(&server.host(), "ada", "ins_stored_token");
        let target = repo_on(&server.host());
        let (_dir, repo) = empty_repo();

        let err = run_remote(&target, &server.host(), &out_with(false, false), |access| {
            let mut remote = repo.remote_anonymous(target.clone_url.as_str())?;
            let mut options = access.push_options(|_| Ok(()), |_, _| Ok(()));
            remote.push(&["refs/heads/main:refs/heads/main"], Some(&mut options))
        })
        .unwrap_err();
        assert!(matches!(err, NsitError::Auth(_)), "{err:?}");
        let seen = server.requests();
        let want = format!("Basic {}", base64("ada:ins_stored_token"));
        assert_eq!(
            seen.last().and_then(|s| s.authorization.as_deref()),
            Some(want.as_str()),
            "{seen:?}"
        );
        assert!(
            seen[0]
                .request_line
                .contains("info/refs?service=git-receive-pack"),
            "{seen:?}"
        );
    }

    #[test]
    fn run_remote_maps_every_git_error_through_remote_error() {
        let dir = tempfile::tempdir().unwrap();
        let _env = isolated_env(dir.path());
        let server = StubServer::refusing();
        sign_in_to(&server.host(), "ada", "ins_stored_token");
        let target = repo_on(&server.host());
        let out = out_with(false, false);

        // Success passes the value through.
        let ok = run_remote(&target, &server.host(), &out, |_| Ok(42)).unwrap();
        assert_eq!(ok, 42);

        // An authentication failure is exit 3 whatever the operation was.
        let auth = git2::Error::new(ErrorCode::Auth, ErrorClass::Http, "rejected");
        let err = run_remote(&target, &server.host(), &out, |_| Err::<(), _>(auth)).unwrap_err();
        assert!(matches!(err, NsitError::Auth(_)), "{err:?}");
        assert!(err.to_string().contains("nsit auth login"), "{err}");

        // Anything else keeps libgit2's own words, as a general failure.
        let boom = git2::Error::new(ErrorCode::GenericError, ErrorClass::Net, "connection reset");
        let err = run_remote(&target, &server.host(), &out, |_| Err::<(), _>(boom)).unwrap_err();
        assert!(matches!(err, NsitError::Git(_)), "{err:?}");
        assert_eq!(err.to_string(), "connection reset");
        assert_eq!(err.exit_code(), 1);

        assert_eq!(
            server.connections_after(SETTLE),
            0,
            "none of that needed the server"
        );
    }

    // What this proves: whatever the transport does with a redirect to another
    // host, the other server is never contacted and no credentials go anywhere.
    // `follow_redirects(None)` in the option builders is what guarantees that on
    // libgit2's own HTTP client (Linux and macOS). The WinHTTP transport used on
    // Windows asks the original server again instead of following, with or
    // without it, so on Windows this test cannot tell the two apart.
    #[test]
    fn a_redirect_cannot_carry_the_token_to_another_host() {
        let dir = tempfile::tempdir().unwrap();
        let _env = isolated_env(dir.path());
        // libgit2 treats the same host name on another port as the same site, so
        // the server is reached as `localhost` and sends the client to `127.0.0.1`.
        let elsewhere = StubServer::refusing();
        let redirecting = {
            let to = elsewhere.host();
            StubServer::start(move |_| {
                format!(
                    "HTTP/1.1 302 Found\r\nLocation: {to}/ada/rocket.git/info/refs?service=git-upload-pack\r\nContent-Length: 0\r\n\r\n"
                )
            })
        };
        let host = format!("http://localhost:{}", redirecting.port());
        sign_in_to(&host, "ada", "ins_stored_token");
        let target = repo_on(&host);
        let (_dir, repo) = empty_repo();

        let result = run_remote(&target, &host, &out_with(false, false), |access| {
            fetch_all(access, &repo, target.clone_url.as_str())
        });
        let err = result.expect_err("a redirect to another host is not followed");
        assert!(!err.to_string().contains("ins_stored_token"), "{err}");

        // The other server was never contacted, and nothing carried the token.
        assert_eq!(elsewhere.connections_after(SETTLE), 0);
        let seen = redirecting.requests();
        assert!(
            seen.iter().all(|s| s.authorization.is_none()),
            "no credentials went anywhere: {seen:?}"
        );
    }

    #[test]
    fn an_environment_token_has_its_account_resolved_before_any_git_traffic() {
        let dir = tempfile::tempdir().unwrap();
        let (server, seen) = serve_once(r#"{"login":"ada","name":"","email":"","is_admin":false}"#);
        let _env = isolated_env(dir.path()).set(TOKEN_ENV, "ins_env_token");
        let target = repo_on(&server);
        let out = out_with(false, false);
        // The selected host is the target's own: the token may go there.
        assert!(remote_callbacks(&target, &server, &out).is_ok());
        let request = seen.join().unwrap();
        assert!(request.starts_with("GET /api/v1/user "), "{request}");
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer ins_env_token"));
    }

    #[test]
    fn a_host_nsit_would_not_talk_to_fails_before_anything_else() {
        // A hand-made reference: `parse_repo_ref` would not produce this one.
        let target = RepoRef {
            owner: "ada".into(),
            name: "rocket".into(),
            clone_url: Url::parse("http://example.com/ada/rocket.git").unwrap(),
            host: "http://example.com/".into(),
        };
        let out = out_with(false, false);
        let err = remote_callbacks(&target, "git.iam.bot", &out)
            .err()
            .expect("plain http to a remote host");
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
    }

    #[test]
    fn libgit2_gets_a_connect_timeout_and_an_idle_timeout() {
        use git2::opts::{
            get_server_connect_timeout_in_milliseconds, get_server_timeout_in_milliseconds,
            set_server_connect_timeout_in_milliseconds, set_server_timeout_in_milliseconds,
        };
        // SAFETY: these two libgit2 globals are only ever written with these same values (by
        // this test and by `main`), and read as plain integers. The test puts back what it found.
        unsafe {
            let connect = get_server_connect_timeout_in_milliseconds().unwrap();
            let idle = get_server_timeout_in_milliseconds().unwrap();
            set_server_connect_timeout_in_milliseconds(0).unwrap();
            set_server_timeout_in_milliseconds(0).unwrap();

            set_network_timeouts().unwrap();
            assert_eq!(
                get_server_connect_timeout_in_milliseconds().unwrap(),
                30_000,
                "connecting to a server that does not answer gives up after 30 s"
            );
            assert_eq!(
                get_server_timeout_in_milliseconds().unwrap(),
                600_000,
                "a server that goes quiet is given 10 minutes (it may be indexing a big push)"
            );

            set_server_connect_timeout_in_milliseconds(connect).unwrap();
            set_server_timeout_in_milliseconds(idle).unwrap();
        }
    }

    // ---- proxies ---------------------------------------------------------------------
    //
    // libgit2 sends git traffic through a proxy only when the fetch or push options say
    // `auto`; without that it never reads `HTTPS_PROXY`, `NO_PROXY` or `http.proxy`, and
    // behind a proxy-only network `auth` and `repo` (which use the system proxy) work while
    // `clone`, `push` and `pull` cannot reach the server. A proxy shows itself here as a
    // `CONNECT <host>:443` it is asked for: what libgit2 sends a proxy to reach an https server.

    /// Stands in for a proxy: records what it is asked for and refuses every request.
    fn proxy_stub() -> StubServer {
        StubServer::start(|_| {
            "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
        })
    }

    /// `env` for a machine whose proxy is `proxy`, by every variable libgit2 reads.
    fn behind(env: EnvGuard, proxy: &StubServer) -> EnvGuard {
        let url = proxy.host();
        env.set("https_proxy", &url)
            .set("HTTPS_PROXY", &url)
            .set("http_proxy", &url)
            .set("HTTP_PROXY", &url)
            .unset("no_proxy")
            .unset("NO_PROXY")
    }

    /// An `http.proxy` in the machine's git configuration beats the environment. These tests
    /// then cannot tell which proxy was used, so the ones that depend on the environment
    /// do not run there (they would also talk to that proxy).
    fn machine_names_a_git_proxy() -> bool {
        git2::Config::open_default().is_ok_and(|config| config.get_string("http.proxy").is_ok())
    }

    /// A fetch and a push of `repo` to `target`, and a clone of it: the three ways nsit goes
    /// to the network, each through `run_remote`. They fail (nothing real is listening);
    /// where they went is what the caller looks at.
    fn try_fetch_and_push(target: &RepoRef, host: &str, repo: &Repository) {
        let out = out_with(false, false);
        let _ = run_remote(target, host, &out, |access| {
            fetch_all(access, repo, target.clone_url.as_str())
        });
        let _ = run_remote(target, host, &out, |access| {
            let mut remote = repo.remote_anonymous(target.clone_url.as_str())?;
            let mut options = access.push_options(|_| Ok(()), |_, _| Ok(()));
            remote.push(&["refs/heads/main:refs/heads/main"], Some(&mut options))
        });
    }

    fn try_clone(target: &RepoRef, host: &str) {
        let dir = tempfile::tempdir().unwrap();
        let _ = run_remote(target, host, &out_with(false, false), |access| {
            let mut builder = git2::build::RepoBuilder::new();
            builder.fetch_options(access.fetch_options());
            builder.clone(target.clone_url.as_str(), &dir.path().join("clone"))
        });
    }

    fn asked_for(proxy: &StubServer) -> Vec<String> {
        proxy
            .requests()
            .into_iter()
            .map(|seen| seen.request_line)
            .collect()
    }

    #[test]
    fn only_a_loopback_server_is_kept_off_the_system_proxy() {
        for host in [
            "https://git.iam.bot",
            "https://other.example:8443",
            // Loopback is exactly localhost, 127.0.0.1 and [::1] (as for the API client).
            "https://127.0.0.2",
        ] {
            assert!(uses_system_proxy(&repo_on(host)), "{host}");
        }
        for host in [
            "http://127.0.0.1:3000",
            "http://localhost:3000",
            "http://[::1]:3000",
            "https://localhost",
        ] {
            assert!(!uses_system_proxy(&repo_on(host)), "{host}");
        }
    }

    #[test]
    fn fetch_clone_and_push_go_through_the_proxy_the_environment_names() {
        let dir = tempfile::tempdir().unwrap();
        if machine_names_a_git_proxy() {
            eprintln!("skipped: this machine's git configuration sets http.proxy");
            return;
        }
        let proxy = proxy_stub();
        let _env = behind(isolated_env(dir.path()), &proxy);
        // A name that never resolves: only the proxy can be what it reaches.
        let host = "https://git.proxytest.invalid";
        sign_in_to(host, "ada", "ins_stored_token");
        let target = repo_on(host);
        let (_repo_dir, repo) = empty_repo();

        try_fetch_and_push(&target, host, &repo);
        let after_fetch_and_push = asked_for(&proxy);
        try_clone(&target, host);
        let all = asked_for(&proxy);

        assert!(
            after_fetch_and_push.len() >= 2,
            "a fetch and a push must each ask the proxy: {after_fetch_and_push:?}"
        );
        assert!(
            all.len() > after_fetch_and_push.len(),
            "a clone must ask the proxy too: {all:?}"
        );
        for line in &all {
            assert!(
                line.starts_with("CONNECT git.proxytest.invalid:443 "),
                "{line}"
            );
        }
        // The token is only ever offered to the server, which the proxy never let us reach.
        assert!(proxy.requests().iter().all(|s| s.authorization.is_none()));
    }

    #[test]
    fn http_proxy_in_the_git_configuration_is_honored_too() {
        let dir = tempfile::tempdir().unwrap();
        // The environment says nothing here, and what the repository says wins over the
        // machine's own configuration.
        let proxy = proxy_stub();
        let _env = isolated_env(dir.path())
            .unset("https_proxy")
            .unset("HTTPS_PROXY")
            .unset("http_proxy")
            .unset("HTTP_PROXY");
        let host = "https://git.proxytest.invalid";
        sign_in_to(host, "ada", "ins_stored_token");
        let target = repo_on(host);
        let (_repo_dir, repo) = empty_repo();
        repo.config()
            .unwrap()
            .set_str("http.proxy", &proxy.host())
            .unwrap();

        try_fetch_and_push(&target, host, &repo);
        let asked = asked_for(&proxy);
        assert!(asked.len() >= 2, "{asked:?}");
        assert!(
            asked
                .iter()
                .all(|line| line.starts_with("CONNECT git.proxytest.invalid:443 ")),
            "{asked:?}"
        );
    }

    #[test]
    fn a_loopback_server_is_reached_directly_even_when_a_proxy_is_set() {
        let dir = tempfile::tempdir().unwrap();
        let proxy = proxy_stub();
        let _env = behind(isolated_env(dir.path()), &proxy);
        let server = StubServer::refusing();
        sign_in_to(&server.host(), "ada", "ins_stored_token");
        let target = repo_on(&server.host());
        let (_repo_dir, repo) = empty_repo();
        // Even a proxy named in the repository's own configuration is not used for it.
        repo.config()
            .unwrap()
            .set_str("http.proxy", &proxy.host())
            .unwrap();

        try_fetch_and_push(&target, &server.host(), &repo);
        try_clone(&target, &server.host());

        assert!(
            !server.requests().is_empty(),
            "the server itself was reached"
        );
        assert_eq!(
            proxy.connections_after(SETTLE),
            0,
            "the proxy was never asked: {:?}",
            asked_for(&proxy)
        );
    }

    #[test]
    fn libgit2s_auth_failures_become_the_nsit_sign_in_message() {
        let auth = git2::Error::new(ErrorCode::Auth, ErrorClass::Http, "authentication failed");
        let err = remote_error(auth, "http://127.0.0.1:3000");
        assert!(matches!(err, NsitError::Auth(_)), "{err:?}");
        assert_eq!(err.exit_code(), 3);
        assert_eq!(
            err.to_string(),
            "authentication failed for 127.0.0.1:3000; run nsit auth login"
        );
        // Anything else keeps libgit2's own message.
        let net = git2::Error::new(
            ErrorCode::GenericError,
            ErrorClass::Net,
            "connection refused",
        );
        let err = remote_error(net, "git.iam.bot");
        assert!(matches!(err, NsitError::Git(_)), "{err:?}");
        assert_eq!(err.to_string(), "connection refused");
        assert_eq!(err.exit_code(), 1);
    }

    #[test]
    fn callbacks_show_progress_only_when_it_was_asked_for() {
        let dir = tempfile::tempdir().unwrap();
        let source = source_repo(dir.path());
        let shown = Rc::new(RefCell::new(String::new()));

        let sink: Sink<'static> = {
            let shown = Rc::clone(&shown);
            Rc::new(move |text: &str| shown.borrow_mut().push_str(text))
        };
        fetch_with(
            &source,
            &dir.path().join("with"),
            build_callbacks(provider(), Some(sink)),
        );
        let text = shown.borrow().clone();
        assert!(text.contains("Receiving objects"), "{text:?}");

        // Not asked for: nothing is written, and the fetch works the same.
        shown.borrow_mut().clear();
        fetch_with(
            &source,
            &dir.path().join("without"),
            build_callbacks(provider(), None),
        );
        assert_eq!(*shown.borrow(), "");
        let fetched = Repository::open(dir.path().join("without")).unwrap();
        assert!(
            fetched.references().unwrap().count() > 0,
            "the fetch itself still works"
        );
    }
}
