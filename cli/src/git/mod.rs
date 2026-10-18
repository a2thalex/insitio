//! The git engine's shared helpers: finding the repository, who commits,
//! `name` / `owner/name` / URL references to repositories on an Insitio server,
//! and what libgit2 needs to talk to one (credentials, progress).
//!
//! nsit does all git work through libgit2 (`git2`), so no `git` program is
//! needed. The token reaches libgit2 only through its credentials callback,
//! as HTTP Basic auth: the account's login as the user name and the token as
//! the password, which is what Insitio's git endpoint expects. It never goes
//! into a remote URL, `.git/config`, a log line or an error message.
//!
//! The commands that use most of this (`init`, `clone`, `commit`, `pull`,
//! `push`) arrive in later tasks; until then the helpers they will call are
//! marked `allow(dead_code)`, and the allows go away with the callers.

use std::fmt;
use std::io::{self, IsTerminal, Write};
use std::path::Path;
use std::rc::Rc;

use git2::{Cred, CredentialType, ErrorClass, ErrorCode, RemoteCallbacks, Repository, Signature};
use url::Url;

use crate::api::Api;
use crate::config::{base_url, is_loopback, Config, HostConfig};
use crate::credentials::{host_entry, host_key, host_key_for, token_for, TokenSource};
use crate::error::NsitError;
use crate::output::Out;

// ---- finding the repository ------------------------------------------------------

/// The repository that contains `dir`, found by looking in `dir` and then in
/// each parent directory, as git does.
///
/// Outside any repository this is a usage error (exit 2) that says what to
/// do. A `dir` that does not exist is reported as that, not as a missing
/// repository.
#[allow(dead_code)]
pub fn open_repo(dir: &Path) -> Result<Repository, NsitError> {
    if !dir.is_dir() {
        return Err(NsitError::Usage(format!(
            "cannot use {}: not a directory",
            dir.display()
        )));
    }
    Repository::discover(dir).map_err(map_discover_error)
}

/// Only "nothing found" means "not a repository"; anything else (an unreadable
/// config, a repository owned by someone else) keeps libgit2's own words.
fn map_discover_error(err: git2::Error) -> NsitError {
    if err.code() == ErrorCode::NotFound {
        NsitError::Usage("not a git repository (run nsit init)".into())
    } else {
        NsitError::Git(err)
    }
}

// ---- who commits ------------------------------------------------------------------

/// The author and committer for a new commit: `user.name` and `user.email`
/// from the git configuration libgit2 sees for `repo` (repository, global and
/// system files, so it matches what git itself would use), then the name and
/// email nsit saved at sign-in for this host (`host_cfg`).
///
/// Each of the two is looked up on its own, so a git config that has only a
/// name still gets the email from nsit. With neither source able to supply
/// both, this is a usage error that says how to fix it.
#[allow(dead_code)]
pub fn signature(
    repo: &Repository,
    host_cfg: Option<&HostConfig>,
) -> Result<Signature<'static>, NsitError> {
    signature_from(&repo.config()?, host_cfg)
}

fn signature_from(
    config: &git2::Config,
    host_cfg: Option<&HostConfig>,
) -> Result<Signature<'static>, NsitError> {
    let name = git_setting(config, "user.name")?
        .or_else(|| host_cfg.and_then(|h| non_blank(h.name.as_deref())));
    let email = git_setting(config, "user.email")?
        .or_else(|| host_cfg.and_then(|h| non_blank(h.email.as_deref())));
    let (Some(name), Some(email)) = (name, email) else {
        return Err(NsitError::Usage(
            "set your name and email: run nsit auth login (it uses your Insitio profile), \
             or set user.name and user.email in your git config"
                .into(),
        ));
    };
    Signature::now(&name, &email).map_err(|e| {
        NsitError::Usage(format!(
            "the name or email to commit as is not usable ({}); check user.name and user.email",
            e.message()
        ))
    })
}

/// A git setting's value, `None` when it is not set or is blank.
fn git_setting(config: &git2::Config, key: &str) -> Result<Option<String>, NsitError> {
    match config.get_string(key) {
        Ok(value) => Ok(non_blank(Some(&value))),
        Err(e) if e.code() == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn non_blank(text: Option<&str>) -> Option<String> {
    text.map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

// ---- naming a repository --------------------------------------------------------------

/// The longest repository name the server accepts.
const MAX_NAME_LEN: usize = 100;

/// A repository on an Insitio server, as the user named it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
pub struct RepoRef {
    pub owner: String,
    pub name: String,
    /// `<server>/<owner>/<name>.git`, never with a user name or token in it.
    pub clone_url: Url,
    /// The server this repository is on, as a base URL (`https://git.iam.bot/`,
    /// or `http://127.0.0.1:3000/` for a test server). **Credentials for this
    /// repository must be looked up with this host and no other**: pass it to
    /// `token_for_repo`, `remote_callbacks` or `Api::new`, never the host the
    /// command was started with, because a full URL can name another server.
    pub host: String,
}

impl RepoRef {
    /// The canonical `host[:port]` of `host`, as used for stored tokens.
    #[allow(dead_code)]
    pub fn host_key(&self) -> String {
        host_key_for(&self.host).unwrap_or_else(|_| self.host.clone())
    }
}

/// Read `input` as a repository: `name` (owned by `default_owner`),
/// `owner/name`, or a full URL such as `https://git.iam.bot/ada/rocket.git`.
///
/// A trailing `.git` and one trailing slash are dropped. Empty parts, more
/// than owner and name, `.` and `..`, and anything outside what the server
/// allows in a name (letters, digits, `.`, `-`, `_`; at most 100 characters)
/// are usage errors, and so are query strings, fragments and user names or
/// passwords in a URL. Errors never repeat the input, which may hold a secret.
///
/// `base` is the server the command is aimed at: it is where a `name` or
/// `owner/name` lives. A full URL on the same server (scheme, host and port)
/// uses `base`, including any path prefix it has. A URL on another server must
/// pass the same https-or-loopback rule as `base_url`, and the result's `host`
/// is that server, not `base`.
pub fn parse_repo_ref(input: &str, default_owner: &str, base: &Url) -> Result<RepoRef, NsitError> {
    let input = input.trim();
    if input.contains("://") {
        return parse_url(input, base);
    }
    let path = input.strip_suffix('/').unwrap_or(input);
    let parts: Vec<&str> = path.split('/').collect();
    let (owner, name) = match parts.as_slice() {
        [name] => {
            if default_owner.is_empty() {
                return Err(NsitError::Usage(
                    "say which repository: owner/name (a bare name needs to know who you are)"
                        .into(),
                ));
            }
            (default_owner, *name)
        }
        [owner, name] => (*owner, *name),
        _ => return Err(not_a_repository()),
    };
    build_ref(owner, name, base)
}

/// Does `input` name a repository without saying whose it is? Then the
/// caller has to find out who is signed in before `parse_repo_ref`.
pub fn needs_default_owner(input: &str) -> bool {
    let input = input.trim();
    if input.contains("://") {
        return false;
    }
    !input.strip_suffix('/').unwrap_or(input).contains('/')
}

/// The name to create a repository with: the server's rule, and no `.git` at
/// the end (the server would refuse it).
pub fn validate_repo_name(name: &str) -> Result<(), NsitError> {
    check_segment("repository name", name)?;
    if strip_dot_git(name) != name {
        return Err(NsitError::Usage(
            "a repository name cannot end in .git".into(),
        ));
    }
    Ok(())
}

fn not_a_repository() -> NsitError {
    NsitError::Usage(
        "cannot read that as a repository: use name, owner/name, or a repository URL".into(),
    )
}

fn parse_url(input: &str, base: &Url) -> Result<RepoRef, NsitError> {
    // Nothing below repeats the input: it could be `https://ada:<token>@host/..`.
    let url = Url::parse(input).map_err(|_| not_a_repository())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(NsitError::Usage(
            "a repository URL must not contain a username or password; nsit keeps tokens out \
             of URLs"
                .into(),
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(not_a_repository());
    }

    let (server, rest) = if url.origin() == base.origin() && url.path().starts_with(base.path()) {
        (base.clone(), &url.path()[base.path().len()..])
    } else {
        // Another server: it has to pass the same checks as the one we were told
        // to use (https, or loopback http). Its path prefix, if any, is unknown.
        let mut root = url.clone();
        root.set_path("/");
        let server = base_url(root.as_str())?;
        (server, url.path().strip_prefix('/').unwrap_or_default())
    };
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    match rest.split('/').collect::<Vec<_>>().as_slice() {
        [owner, name] => build_ref(owner, name, &server),
        _ => Err(not_a_repository()),
    }
}

/// Check the parts and make the reference. `name` may still end in `.git`.
fn build_ref(owner: &str, name: &str, server: &Url) -> Result<RepoRef, NsitError> {
    let name = strip_dot_git(name);
    check_segment("owner", owner)?;
    validate_repo_name(name)?;
    // Both parts are ASCII letters, digits, `.`, `-` and `_` now, so they cannot
    // add a path, a query, a scheme or a different host to the URL.
    let clone_url = server
        .join(&format!("{owner}/{name}.git"))
        .map_err(|_| not_a_repository())?;
    Ok(RepoRef {
        owner: owner.to_string(),
        name: name.to_string(),
        clone_url,
        host: server.as_str().to_string(),
    })
}

/// One part of a repository's name: the server's rule for names.
fn check_segment(what: &str, segment: &str) -> Result<(), NsitError> {
    let usage = |why: &str| Err(NsitError::Usage(format!("invalid {what}: {why}")));
    if segment.is_empty() {
        return usage("it is empty");
    }
    if segment == "." || segment == ".." {
        return usage("it cannot be . or ..");
    }
    if !segment
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return usage("use only letters, numbers, '.', '-' and '_'");
    }
    if segment.len() > MAX_NAME_LEN {
        return usage("it is longer than 100 characters");
    }
    Ok(())
}

/// `name` without a final `.git` (any case), as the server reads it too.
fn strip_dot_git(name: &str) -> &str {
    let bytes = name.as_bytes();
    match bytes.len().checked_sub(4) {
        // The last four bytes are ASCII, so `cut` is a character boundary.
        Some(cut) if bytes[cut..].eq_ignore_ascii_case(b".git") => &name[..cut],
        _ => name,
    }
}

// ---- who the token belongs to ----------------------------------------------------------

/// The login of the account `source`'s token belongs to: it is the user name
/// for git's Basic auth, and the owner for a bare repository name.
///
/// A token nsit stored belongs to the account the config remembers for the
/// host, so nothing is asked. `NSIT_TOKEN` can be anyone's (and the config may
/// name someone else), so the server is asked, once, with `api`.
pub fn signed_in_login(host: &str, source: TokenSource, api: &Api) -> Result<String, NsitError> {
    login_for(source, configured_login(host)?, || Ok(api.user()?.login))
}

/// The account the config remembers for `host`, if any.
fn configured_login(host: &str) -> Result<Option<String>, NsitError> {
    let key = host_key_for(host)?;
    let config = Config::load()?;
    Ok(host_entry(&config, &key)
        .map(|entry| entry.user.clone())
        .filter(|user| !user.is_empty()))
}

fn login_for(
    source: TokenSource,
    configured: Option<String>,
    ask: impl FnOnce() -> Result<String, NsitError>,
) -> Result<String, NsitError> {
    match (source, configured) {
        (TokenSource::Keychain | TokenSource::File, Some(user)) => Ok(user),
        _ => ask(),
    }
}

/// The token for the server `target` lives on. A token nsit stored is looked
/// up under that server's own name. `NSIT_TOKEN` counts only when the
/// repository is on the server selected with `--host` / `NSIT_HOST` (or the
/// default): a full URL for some other server must not get a token meant for
/// the one you chose, so an agent cannot be talked into mailing it elsewhere.
pub fn token_for_repo(
    selected_host: &str,
    target: &RepoRef,
) -> Result<(String, TokenSource), NsitError> {
    let (token, source) = token_for(&target.host, None)?;
    if source == TokenSource::Env
        && base_url(selected_host)?.origin() != base_url(&target.host)?.origin()
    {
        return Err(NsitError::Auth(format!(
            "{} is not the host you selected, so nsit will not send it the token in NSIT_TOKEN; \
             use --host {} to say you mean it",
            target.host_key(),
            target.host
        )));
    }
    Ok((token, source))
}

// ---- credentials and progress for libgit2 ---------------------------------------------

/// Everything libgit2 needs to fetch from or push to the server at `host`:
/// the credentials, and progress on stderr when there is a terminal to show
/// it on (stdout and stderr are terminals and `-q` was not given).
///
/// Fails with `Auth` (exit 3) before anything touches the network when nobody
/// is signed in; this never reads from stdin. The one network call it may
/// make is `GET /api/v1/user`, to learn whose `NSIT_TOKEN` it is.
///
/// Pass each set of callbacks to one operation only: the credentials are
/// offered once, and a second request means the server refused them. Use the
/// repository's own host (`RepoRef::host`), not the command's.
#[allow(dead_code)]
pub fn remote_callbacks<'a>(host: &str, out: &'a Out) -> Result<RemoteCallbacks<'a>, NsitError> {
    let key = host_key_for(host)?;
    // Eagerly, so that signed out is an error here and not a surprise later.
    let (token, source) = token_for(host, None)?;
    let login = login_for(source, configured_login(host)?, || {
        Ok(Api::new(host, Some(token.clone()))?.user()?.login)
    })?;
    let provider = CredentialProvider::new(&key, &login, &token);
    let show = progress_wanted(out.tty && io::stderr().is_terminal(), out.quiet);
    let progress = show.then(|| Rc::new(write_to_stderr) as Sink<'a>);
    Ok(build_callbacks(provider, progress))
}

/// What a failed fetch or push should say. libgit2 reports "the server
/// refused the credentials" (and our own refusal to try twice) as an
/// authentication error: that is exit 3 with a sign-in hint, not a git error.
#[allow(dead_code)]
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
        let on_our_host = Url::parse(url).is_ok_and(|u| {
            let scheme_ok = match u.scheme() {
                "https" => true,
                "http" => is_loopback(&u),
                _ => false,
            };
            scheme_ok && host_key(&u) == self.host_key
        });
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

/// Where progress text is written (stderr; a test collects it in memory).
type Sink<'a> = Rc<dyn Fn(&str) + 'a>;

/// Progress is for people at a terminal, and `-q` turns it off.
fn progress_wanted(tty: bool, quiet: bool) -> bool {
    tty && !quiet
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

/// Show the three kinds of progress libgit2 reports: the download, what the
/// remote says while it prepares one, and the upload. They only ever write
/// through `sink`; none of them can stop the operation.
fn install_progress<'a>(callbacks: &mut RemoteCallbacks<'a>, sink: Sink<'a>) {
    let mut download = LineProgress::new();
    let download_sink = Rc::clone(&sink);
    callbacks.transfer_progress(move |p| {
        let stats = TransferStats {
            total_objects: p.total_objects(),
            received_objects: p.received_objects(),
            total_deltas: p.total_deltas(),
            indexed_deltas: p.indexed_deltas(),
            received_bytes: p.received_bytes(),
        };
        if let Some((line, done)) = transfer_line(&stats) {
            if let Some(text) = download.show(&line, done) {
                download_sink(&text);
            }
        }
        true
    });

    let remote_sink = Rc::clone(&sink);
    callbacks.sideband_progress(move |data| {
        let text = clean_sideband(data);
        if !text.is_empty() {
            remote_sink(&text);
        }
        true
    });

    let mut upload = LineProgress::new();
    callbacks.push_transfer_progress(move |current, total, bytes| {
        if let Some((line, done)) = push_line(current, total, bytes) {
            if let Some(text) = upload.show(&line, done) {
                sink(&text);
            }
        }
    });
}

/// Progress goes to stderr, never stdout, and a closed stderr is not an error.
fn write_to_stderr(text: &str) {
    let mut stderr = io::stderr().lock();
    let _ = stderr.write_all(text.as_bytes());
    let _ = stderr.flush();
}

/// A status line that is rewritten in place (`\r`), shown again only when it
/// changes, and ended with a newline once it is done.
struct LineProgress {
    last: String,
    /// How wide the row on the screen is, so a shorter line can cover it.
    width: usize,
}

impl LineProgress {
    fn new() -> LineProgress {
        LineProgress {
            last: String::new(),
            width: 0,
        }
    }

    /// The text to write for `line`, or `None` when it is the one on screen.
    fn show(&mut self, line: &str, done: bool) -> Option<String> {
        if line == self.last {
            return None;
        }
        let mut text = format!("\r{line:<width$}", width = self.width);
        self.width = self.width.max(line.chars().count());
        if done {
            text.push('\n');
        }
        self.last = line.to_string();
        Some(text)
    }
}

/// What libgit2 reports while it downloads a pack.
struct TransferStats {
    total_objects: usize,
    received_objects: usize,
    total_deltas: usize,
    indexed_deltas: usize,
    received_bytes: usize,
}

/// The status line for a download, and whether it is the last one.
fn transfer_line(s: &TransferStats) -> Option<(String, bool)> {
    if s.total_objects == 0 {
        return None;
    }
    if s.received_objects < s.total_objects {
        return Some((
            format!(
                "Receiving objects: {}% ({}/{}), {}",
                percent(s.received_objects, s.total_objects),
                s.received_objects,
                s.total_objects,
                human_bytes(s.received_bytes)
            ),
            false,
        ));
    }
    if s.total_deltas > 0 {
        let done = s.indexed_deltas >= s.total_deltas;
        let end = if done { ", done." } else { "" };
        return Some((
            format!(
                "Resolving deltas: {}% ({}/{}){end}",
                percent(s.indexed_deltas, s.total_deltas),
                s.indexed_deltas.min(s.total_deltas),
                s.total_deltas
            ),
            done,
        ));
    }
    Some((
        format!(
            "Receiving objects: 100% ({n}/{n}), {}, done.",
            human_bytes(s.received_bytes),
            n = s.total_objects
        ),
        true,
    ))
}

/// The status line for an upload, and whether it is the last one.
fn push_line(current: usize, total: usize, bytes: usize) -> Option<(String, bool)> {
    if total == 0 {
        return None;
    }
    let done = current >= total;
    let end = if done { ", done." } else { "" };
    Some((
        format!(
            "Writing objects: {}% ({}/{}), {}{end}",
            percent(current, total),
            current.min(total),
            total,
            human_bytes(bytes)
        ),
        done,
    ))
}

fn percent(part: usize, whole: usize) -> u64 {
    (part.min(whole) as u64 * 100 / whole as u64).min(100)
}

/// `1.5 KiB`, `20.0 MiB`; plain bytes below 1 KiB.
fn human_bytes(n: usize) -> String {
    const UNITS: [&str; 4] = ["KiB", "MiB", "GiB", "TiB"];
    if n < 1024 {
        return format!("{n} bytes");
    }
    let mut value = n as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

/// Text the remote sent along with the pack ("Counting objects..."), made safe
/// for a terminal: `\r` and `\n` stay (that is how it redraws its lines) and
/// every other control character, escape sequences included, is dropped.
fn clean_sideband(data: &[u8]) -> String {
    String::from_utf8_lossy(data)
        .chars()
        .filter(|c| matches!(c, '\n' | '\r') || !c.is_control())
        .collect()
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use git2::{ConfigLevel, ErrorClass, ErrorCode, FetchOptions};

    use super::*;
    use crate::config::{Config, HostConfig};
    use crate::credentials::{store_token, token_for, NO_KEYCHAIN_ENV, TOKEN_ENV};
    use crate::test_env::EnvGuard;

    const BASE: &str = "https://git.iam.bot/";

    fn base() -> Url {
        Url::parse(BASE).unwrap()
    }

    fn quiet_out(tty: bool, quiet: bool) -> Out {
        Out {
            json: false,
            jq: None,
            tty,
            color: false,
            quiet,
        }
    }

    /// File store only, in a throwaway config dir; the real credential store
    /// and the real config are never touched.
    fn env(dir: &Path) -> EnvGuard {
        EnvGuard::lock()
            .set("NSIT_CONFIG_DIR", dir)
            .set(NO_KEYCHAIN_ENV, "1")
            .unset(TOKEN_ENV)
            .unset("NSIT_HOST")
    }

    fn host_entry_for(user: &str, name: Option<&str>, email: Option<&str>) -> HostConfig {
        HostConfig {
            user: user.into(),
            name: name.map(str::to_string),
            email: email.map(str::to_string),
        }
    }

    // ---- parse_repo_ref -----------------------------------------------------------

    fn parse(input: &str) -> Result<RepoRef, NsitError> {
        parse_repo_ref(input, "gregory", &base())
    }

    #[test]
    fn a_bare_name_belongs_to_the_default_owner() {
        let r = parse("rocket").unwrap();
        assert_eq!((r.owner.as_str(), r.name.as_str()), ("gregory", "rocket"));
        assert_eq!(
            r.clone_url.as_str(),
            "https://git.iam.bot/gregory/rocket.git"
        );
        assert_eq!(r.host, "https://git.iam.bot/");
        assert_eq!(r.host_key(), "git.iam.bot");
    }

    #[test]
    fn owner_slash_name_names_the_owner() {
        let r = parse("ada/rocket").unwrap();
        assert_eq!((r.owner.as_str(), r.name.as_str()), ("ada", "rocket"));
        assert_eq!(r.clone_url.as_str(), "https://git.iam.bot/ada/rocket.git");
    }

    #[test]
    fn a_full_url_on_the_same_host_is_read_apart() {
        let r = parse("https://git.iam.bot/gregory/rocket.git").unwrap();
        assert_eq!((r.owner.as_str(), r.name.as_str()), ("gregory", "rocket"));
        assert_eq!(
            r.clone_url.as_str(),
            "https://git.iam.bot/gregory/rocket.git"
        );
        assert_eq!(r.host, "https://git.iam.bot/");
    }

    #[test]
    fn trailing_dot_git_and_slash_are_dropped_in_every_shape() {
        for input in [
            "rocket.git",
            "rocket/",
            "rocket.git/",
            "gregory/rocket.GIT",
            "https://git.iam.bot/gregory/rocket",
            "https://git.iam.bot/gregory/rocket/",
            "https://git.iam.bot/gregory/rocket.git/",
            "  rocket  ",
        ] {
            let r = parse(input).unwrap_or_else(|e| panic!("{input:?}: {e}"));
            assert_eq!(r.name, "rocket", "{input:?}");
            assert_eq!(r.owner, "gregory", "{input:?}");
            assert_eq!(
                r.clone_url.as_str(),
                "https://git.iam.bot/gregory/rocket.git",
                "{input:?}"
            );
        }
    }

    #[test]
    fn a_loopback_http_url_works_for_tests() {
        let base = Url::parse("http://127.0.0.1:3000/").unwrap();
        let r = parse_repo_ref("http://127.0.0.1:3000/ada/tools.git", "x", &base).unwrap();
        assert_eq!(r.clone_url.as_str(), "http://127.0.0.1:3000/ada/tools.git");
        assert_eq!(r.host, "http://127.0.0.1:3000/");
        assert_eq!(r.host_key(), "127.0.0.1:3000");
        // A bare name on that server gets that server's URL.
        let r = parse_repo_ref("tools", "ada", &base).unwrap();
        assert_eq!(r.clone_url.as_str(), "http://127.0.0.1:3000/ada/tools.git");
    }

    #[test]
    fn a_url_on_another_host_carries_that_hosts_credentials_key() {
        let r = parse("https://Other.Example/ada/rocket.git").unwrap();
        assert_eq!(r.clone_url.as_str(), "https://other.example/ada/rocket.git");
        // Credentials for this repository come from this host and no other.
        assert_eq!(r.host, "https://other.example/");
        assert_eq!(r.host_key(), "other.example");
        assert_eq!(
            crate::credentials::host_key_for(&r.host).unwrap(),
            "other.example"
        );
        // A different port is a different server too.
        let r = parse("https://git.iam.bot:8443/ada/rocket").unwrap();
        assert_eq!(r.host, "https://git.iam.bot:8443/");
        assert_eq!(r.host_key(), "git.iam.bot:8443");
    }

    #[test]
    fn a_url_on_another_host_must_pass_the_https_or_loopback_rule() {
        for url in [
            "http://other.example/ada/rocket.git",
            "http://10.0.0.5/ada/rocket",
            "http://localhost.evil.example/ada/rocket",
            "ssh://git.iam.bot/ada/rocket.git",
            "ftp://git.iam.bot/ada/rocket.git",
            "file:///ada/rocket",
        ] {
            let err = parse(url).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{url}: {err:?}");
        }
        // Loopback http is fine even when it is not the base host.
        let r = parse("http://localhost:3000/ada/rocket").unwrap();
        assert_eq!(r.host, "http://localhost:3000/");
    }

    #[test]
    fn credentials_in_a_url_are_refused_and_never_echoed() {
        for url in [
            "https://ada:hunter2@git.iam.bot/ada/rocket.git",
            "https://hunter2@git.iam.bot/ada/rocket.git",
            "http://ada:hunter2@127.0.0.1:3000/ada/rocket",
        ] {
            let err = parse(url).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{url}: {err:?}");
            assert!(!err.to_string().contains("hunter2"), "{err}");
        }
    }

    #[test]
    fn a_path_prefix_on_the_base_is_kept_for_that_host_only() {
        let base = Url::parse("https://example.com/insitio/").unwrap();
        let r = parse_repo_ref("ada/rocket", "x", &base).unwrap();
        assert_eq!(
            r.clone_url.as_str(),
            "https://example.com/insitio/ada/rocket.git"
        );
        let r = parse_repo_ref("https://example.com/insitio/ada/rocket.git", "x", &base).unwrap();
        assert_eq!((r.owner.as_str(), r.name.as_str()), ("ada", "rocket"));
        assert_eq!(
            r.clone_url.as_str(),
            "https://example.com/insitio/ada/rocket.git"
        );
        assert_eq!(r.host, "https://example.com/insitio/");
        // Another host has no known prefix: it is owner/name at its root.
        let r = parse_repo_ref("https://other.example/ada/rocket", "x", &base).unwrap();
        assert_eq!(r.clone_url.as_str(), "https://other.example/ada/rocket.git");
    }

    #[test]
    fn empty_extra_and_dot_segments_are_usage_errors() {
        for input in [
            "",
            "   ",
            "/",
            "/rocket",
            "ada//rocket",
            "a/b/c",
            "ada/rocket/extra",
            ".",
            "..",
            "ada/.",
            "../rocket",
            "ada/..",
            ".git",
            "ada/.git",
            "rocket.git.git",
            "https://git.iam.bot/",
            "https://git.iam.bot/ada",
            "https://git.iam.bot/ada/rocket/tree/main",
            "https://git.iam.bot/ada//rocket",
            "https://git.iam.bot/ada/..",
            "https://git.iam.bot/ada/rocket?tab=readme",
            "https://git.iam.bot/ada/rocket#readme",
        ] {
            let err = parse(input).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{input:?}: {err:?}");
            assert_eq!(err.exit_code(), 2);
        }
    }

    #[test]
    fn names_outside_the_servers_rule_are_usage_errors() {
        for input in [
            "ro cket",
            "ro$cket",
            "ro:cket",
            "ada/ro%20cket",
            "ada/rocket\\x",
            "ada@git.iam.bot:ada/rocket",
            "über",
            "C:\\Users\\ada\\rocket",
            "ro\u{1b}[31mcket",
        ] {
            let err = parse(input).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{input:?}: {err:?}");
        }
        // What the server accepts.
        for input in [
            "a", "A.b-c_d", "ada/a.b", "ada/1", "ada/_x", "ada/-x", "ada/...",
        ] {
            parse(input).unwrap_or_else(|e| panic!("{input:?} should be accepted: {e}"));
        }
        // 100 characters is the limit.
        let max = "a".repeat(100);
        assert_eq!(parse(&max).unwrap().name, max);
        assert!(parse(&"a".repeat(101)).is_err());
    }

    #[test]
    fn a_bare_name_without_a_default_owner_is_a_usage_error() {
        let err = parse_repo_ref("rocket", "", &base()).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        // The owner is not needed when the input has one.
        assert!(parse_repo_ref("ada/rocket", "", &base()).is_ok());
        assert!(parse_repo_ref("https://git.iam.bot/ada/rocket", "", &base()).is_ok());
    }

    #[test]
    fn a_default_owner_that_is_not_a_name_is_refused() {
        for owner in ["a/b", "..", "a b"] {
            let err = parse_repo_ref("rocket", owner, &base()).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{owner:?}: {err:?}");
        }
    }

    #[test]
    fn the_clone_url_is_built_from_validated_segments_only() {
        // Nothing a user types can steer the URL anywhere but owner/name.git.
        for input in ["ada/rocket", "rocket", "https://git.iam.bot/ada/rocket.git"] {
            let r = parse(input).unwrap();
            assert_eq!(r.clone_url.scheme(), "https");
            assert_eq!(r.clone_url.host_str(), Some("git.iam.bot"));
            assert!(r.clone_url.username().is_empty() && r.clone_url.password().is_none());
            assert!(r.clone_url.query().is_none() && r.clone_url.fragment().is_none());
            assert_eq!(
                r.clone_url.path(),
                format!("/{}/{}.git", r.owner, r.name),
                "{input}"
            );
        }
    }

    #[test]
    fn which_inputs_need_the_default_owner() {
        for bare in ["rocket", "rocket.git", "rocket/", " rocket "] {
            assert!(needs_default_owner(bare), "{bare:?}");
        }
        for full in [
            "ada/rocket",
            "ada/rocket/",
            "https://git.iam.bot/ada/rocket",
            "http://127.0.0.1:3000/ada/rocket.git",
        ] {
            assert!(!needs_default_owner(full), "{full:?}");
        }
    }

    #[test]
    fn creating_a_repository_follows_the_servers_name_rule() {
        for ok in ["tools", "a", "A.b-c_d", "..."] {
            validate_repo_name(ok).unwrap_or_else(|e| panic!("{ok:?}: {e}"));
        }
        for bad in [
            "",
            ".",
            "..",
            "bad name",
            "a/b",
            "tools.git",
            "tools.GIT",
            ".git",
            "über",
        ] {
            let err = validate_repo_name(bad).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{bad:?}: {err:?}");
        }
        assert!(validate_repo_name(&"a".repeat(100)).is_ok());
        assert!(validate_repo_name(&"a".repeat(101)).is_err());
    }

    // ---- open_repo ----------------------------------------------------------------

    fn commit_file(repo: &Repository, name: &str, content: &str) {
        std::fs::write(repo.workdir().unwrap().join(name), content).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(name)).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, name, &tree, &parents)
            .unwrap();
    }

    #[test]
    fn open_repo_finds_the_repository_from_a_subdirectory() {
        let dir = tempfile::tempdir().unwrap();
        Repository::init(dir.path()).unwrap();
        let deep = dir.path().join("src").join("deep");
        std::fs::create_dir_all(&deep).unwrap();
        let repo = open_repo(&deep).unwrap();
        let found = std::fs::canonicalize(repo.workdir().unwrap()).unwrap();
        assert_eq!(found, std::fs::canonicalize(dir.path()).unwrap());
    }

    #[test]
    fn open_repo_works_in_a_path_with_spaces_and_non_ascii() {
        let dir = tempfile::tempdir().unwrap();
        let place = dir.path().join("VideoInk - OG Édition");
        std::fs::create_dir(&place).unwrap();
        Repository::init(&place).unwrap();
        let repo = open_repo(&place).unwrap();
        assert!(std::fs::canonicalize(repo.workdir().unwrap())
            .unwrap()
            .ends_with("VideoInk - OG Édition"));
    }

    #[test]
    fn outside_a_repository_it_says_to_run_nsit_init() {
        let dir = tempfile::tempdir().unwrap();
        // Only meaningful when nothing above the temp dir is a repository.
        let inside_one = dir.path().ancestors().any(|p| p.join(".git").exists());
        if inside_one {
            eprintln!("skipped: the temp dir is inside a git repository");
            return;
        }
        let err = open_repo(dir.path()).err().expect("not a repository");
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert_eq!(err.to_string(), "not a git repository (run nsit init)");
        assert_eq!(err.exit_code(), 2);
    }

    #[test]
    fn a_missing_directory_is_not_reported_as_a_missing_repository() {
        let dir = tempfile::tempdir().unwrap();
        let err = open_repo(&dir.path().join("nope"))
            .err()
            .expect("no such dir");
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert!(!err.to_string().contains("nsit init"), "{err}");
        assert!(err.to_string().contains("not a directory"), "{err}");
    }

    #[test]
    fn only_not_found_means_not_a_repository() {
        let not_found = git2::Error::new(ErrorCode::NotFound, ErrorClass::Repository, "nope");
        assert_eq!(
            map_discover_error(not_found).to_string(),
            "not a git repository (run nsit init)"
        );
        let other = git2::Error::new(
            ErrorCode::Owner,
            ErrorClass::Config,
            "owned by someone else",
        );
        let err = map_discover_error(other);
        assert!(matches!(err, NsitError::Git(_)), "{err:?}");
        assert_eq!(err.to_string(), "owned by someone else");
    }

    // ---- signature ----------------------------------------------------------------

    fn who(sig: &Signature<'_>) -> (String, String) {
        (
            sig.name().unwrap().to_string(),
            sig.email().unwrap().to_string(),
        )
    }

    /// A git config made from this file alone: no global or system settings.
    fn config_of(dir: &Path, text: &str) -> git2::Config {
        let path = dir.join("gitconfig");
        std::fs::write(&path, text).unwrap();
        git2::Config::open(&path).unwrap()
    }

    #[test]
    fn git_config_user_wins() {
        let dir = tempfile::tempdir().unwrap();
        let config = config_of(
            dir.path(),
            "[user]\n\tname = Ada Lovelace\n\temail = ada@git.example\n",
        );
        let host = host_entry_for("ada", Some("Nsit Name"), Some("nsit@example.com"));
        let sig = signature_from(&config, Some(&host)).unwrap();
        assert_eq!(
            who(&sig),
            ("Ada Lovelace".to_string(), "ada@git.example".to_string())
        );
    }

    #[test]
    fn nsit_config_fills_in_what_git_lacks() {
        let dir = tempfile::tempdir().unwrap();
        let none = config_of(dir.path(), "");
        let host = host_entry_for("ada", Some("Ada Lovelace"), Some("ada@example.com"));
        let sig = signature_from(&none, Some(&host)).unwrap();
        assert_eq!(
            who(&sig),
            ("Ada Lovelace".to_string(), "ada@example.com".to_string())
        );

        // Field by field: git has the name, nsit has the email.
        let name_only = config_of(dir.path(), "[user]\n\tname = Git Name\n");
        let sig = signature_from(&name_only, Some(&host)).unwrap();
        assert_eq!(
            who(&sig),
            ("Git Name".to_string(), "ada@example.com".to_string())
        );
    }

    #[test]
    fn without_a_name_and_email_anywhere_it_is_a_usage_error_saying_how_to_fix_it() {
        let dir = tempfile::tempdir().unwrap();
        let none = config_of(dir.path(), "");
        let blank_host = host_entry_for("ada", None, Some("ada@example.com"));
        for host in [None, Some(&blank_host)] {
            let err = signature_from(&none, host)
                .err()
                .expect("nothing to sign with");
            assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
            assert_eq!(err.exit_code(), 2);
            let text = err.to_string();
            assert!(text.contains("name and email"), "{text}");
            assert!(
                text.contains("nsit auth login") && text.contains("user.name"),
                "{text}"
            );
            assert!(!text.contains('\n'), "one line please: {text:?}");
        }
    }

    #[test]
    fn blank_values_count_as_missing() {
        let dir = tempfile::tempdir().unwrap();
        let blank = config_of(dir.path(), "[user]\n\tname = \"  \"\n\temail = \"\"\n");
        let host = host_entry_for("ada", Some(" "), Some(""));
        assert!(signature_from(&blank, Some(&host)).is_err());
        let host = host_entry_for("ada", Some("Ada"), Some("ada@example.com"));
        let sig = signature_from(&blank, Some(&host)).unwrap();
        assert_eq!(
            who(&sig),
            ("Ada".to_string(), "ada@example.com".to_string())
        );
    }

    #[test]
    fn a_repository_with_local_user_settings_uses_them() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        {
            let mut config = repo.config().unwrap();
            config.set_str("user.name", "Local Name").unwrap();
            config.set_str("user.email", "local@example.com").unwrap();
        }
        // The local file outranks any global one, so this does not depend on
        // the developer's own git configuration.
        let sig = signature(&repo, None).unwrap();
        assert_eq!(
            who(&sig),
            ("Local Name".to_string(), "local@example.com".to_string())
        );
        let host = host_entry_for("ada", Some("Nsit"), Some("nsit@example.com"));
        let sig = signature(&repo, Some(&host)).unwrap();
        assert_eq!(who(&sig).0, "Local Name");
    }

    #[test]
    fn a_repository_without_local_user_settings_falls_back_to_nsit() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        // Only this repository's own file: hermetic, whatever is in ~/.gitconfig.
        let local = repo
            .config()
            .unwrap()
            .open_level(ConfigLevel::Local)
            .unwrap();
        let host = host_entry_for("ada", Some("Ada Lovelace"), Some("ada@example.com"));
        let sig = signature_from(&local, Some(&host)).unwrap();
        assert_eq!(who(&sig).0, "Ada Lovelace");
        let err = signature_from(&local, None)
            .err()
            .expect("nothing to sign with");
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
    }

    #[test]
    fn a_name_libgit2_cannot_sign_with_is_a_usage_error_not_a_crash() {
        let dir = tempfile::tempdir().unwrap();
        let config = config_of(dir.path(), "[user]\n\tname = <>\n\temail = a@b.c\n");
        let err = signature_from(&config, None).err().expect("unusable name");
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
    }

    // ---- who the token belongs to ------------------------------------------------

    #[test]
    fn tokens_nsit_stored_belong_to_the_account_in_the_config_without_asking() {
        for source in [TokenSource::Keychain, TokenSource::File] {
            let login = login_for(source, Some("grace".into()), || {
                panic!("must not ask the server")
            })
            .unwrap();
            assert_eq!(login, "grace");
        }
    }

    #[test]
    fn an_environment_token_belongs_to_whoever_the_server_says() {
        // Even with an account in the config: NSIT_TOKEN may be someone else's.
        let login = login_for(TokenSource::Env, Some("grace".into()), || Ok("ada".into())).unwrap();
        assert_eq!(login, "ada");
        let login = login_for(TokenSource::Env, None, || Ok("ada".into())).unwrap();
        assert_eq!(login, "ada");
        // With no config entry to read, a stored token also needs the server.
        let login = login_for(TokenSource::File, None, || Ok("ada".into())).unwrap();
        assert_eq!(login, "ada");
        let err = login_for(TokenSource::Env, None, || {
            Err(NsitError::Auth("rejected".into()))
        })
        .unwrap_err();
        assert_eq!(err.exit_code(), 3);
    }

    /// A server that answers one request with `body` and reports what it was
    /// sent. It is on the loopback interface, so `Api` talks plain http to it.
    fn serve_once(body: &'static str) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let host = format!("http://{}", listener.local_addr().unwrap());
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut seen = Vec::new();
            let mut buf = [0u8; 1024];
            while !seen.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = stream.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                seen.extend_from_slice(&buf[..n]);
            }
            let reply = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(reply.as_bytes()).unwrap();
            String::from_utf8_lossy(&seen).into_owned()
        });
        (host, handle)
    }

    #[test]
    fn signed_in_login_reads_the_config_or_asks_the_server_as_the_source_requires() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        let mut config = Config::default();
        config
            .hosts
            .insert("git.iam.bot".into(), host_entry_for("grace", None, None));
        config.save().unwrap();

        // Stored token: the config answers; nothing listens on port 9, so a
        // network call would be an error.
        let nowhere = Api::new("http://127.0.0.1:9", Some("ins_t".into())).unwrap();
        let login = signed_in_login("git.iam.bot", TokenSource::File, &nowhere).unwrap();
        assert_eq!(login, "grace");

        // NSIT_TOKEN: the server answers, and its answer beats the config.
        let (server, seen) = serve_once(r#"{"login":"ada","name":"","email":"","is_admin":false}"#);
        let api = Api::new(&server, Some("ins_envtoken".into())).unwrap();
        let login = signed_in_login("git.iam.bot", TokenSource::Env, &api).unwrap();
        assert_eq!(login, "ada");
        let request = seen.join().unwrap();
        assert!(request.starts_with("GET /api/v1/user "), "{request}");
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer ins_envtoken"));
    }

    // ---- token_for_repo -------------------------------------------------------------

    fn other_host_ref() -> RepoRef {
        parse("https://other.example/ada/rocket").unwrap()
    }

    #[test]
    fn nsit_token_is_only_for_the_selected_host() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path()).set(TOKEN_ENV, "ins_agent_token");
        // A repository on the selected host: fine.
        let same = parse("ada/rocket").unwrap();
        let (token, source) = token_for_repo("git.iam.bot", &same).unwrap();
        assert_eq!(
            (token.as_str(), source),
            ("ins_agent_token", TokenSource::Env)
        );
        // The same server spelled as a URL is still the same server.
        let (_, source) = token_for_repo("https://GIT.iam.bot/", &same).unwrap();
        assert_eq!(source, TokenSource::Env);
        // A repository somewhere else must not get it.
        let err = token_for_repo("git.iam.bot", &other_host_ref()).unwrap_err();
        assert!(matches!(err, NsitError::Auth(_)), "{err:?}");
        assert_eq!(err.exit_code(), 3);
        let text = err.to_string();
        assert!(
            text.contains("NSIT_TOKEN") && text.contains("--host"),
            "{text}"
        );
        assert!(!text.contains("ins_agent_token"), "{text}");
        // ...unless that host is the one selected.
        assert!(token_for_repo("https://other.example", &other_host_ref()).is_ok());
    }

    #[test]
    fn a_stored_token_is_found_by_the_repositorys_own_host() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        store_token("other.example", "ada", "ins_other_token").unwrap();
        let mut config = Config::default();
        config
            .hosts
            .insert("other.example".into(), host_entry_for("ada", None, None));
        config.save().unwrap();
        let (token, source) = token_for_repo("git.iam.bot", &other_host_ref()).unwrap();
        assert_eq!(
            (token.as_str(), source),
            ("ins_other_token", TokenSource::File)
        );
        // Nothing stored for the selected host: still signed out there.
        let err = token_for_repo("git.iam.bot", &parse("ada/rocket").unwrap()).unwrap_err();
        assert_eq!(err.exit_code(), 3);
    }

    // ---- the credentials callback ---------------------------------------------------

    fn provider() -> CredentialProvider {
        CredentialProvider::new("git.iam.bot", "ada", "ins_secret_token")
    }

    const URL: &str = "https://git.iam.bot/ada/rocket.git";

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

    // ---- remote_callbacks -----------------------------------------------------------

    #[test]
    fn signed_out_is_an_auth_error_before_any_network_use() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        let out = quiet_out(false, false);
        // Nothing listens on port 9: had anything tried the network, the error
        // would be about that and not about signing in.
        let started = Instant::now();
        let err = remote_callbacks("http://127.0.0.1:9", &out)
            .err()
            .expect("signed out");
        assert!(matches!(err, NsitError::Auth(_)), "{err:?}");
        assert_eq!(err.exit_code(), 3);
        assert!(err.to_string().contains("nsit auth login"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_stored_token_with_a_known_account_builds_callbacks_without_the_network() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        store_token("http://127.0.0.1:9", "ada", "ins_stored_token").unwrap();
        let mut config = Config::default();
        config
            .hosts
            .insert("127.0.0.1:9".into(), host_entry_for("ada", None, None));
        config.save().unwrap();
        assert!(token_for("http://127.0.0.1:9", None).is_ok());
        let out = quiet_out(false, false);
        assert!(remote_callbacks("http://127.0.0.1:9", &out).is_ok());
    }

    #[test]
    fn an_environment_token_has_its_account_resolved_before_any_git_traffic() {
        let dir = tempfile::tempdir().unwrap();
        let (server, seen) = serve_once(r#"{"login":"ada","name":"","email":"","is_admin":false}"#);
        let _env = env(dir.path()).set(TOKEN_ENV, "ins_env_token");
        let out = quiet_out(false, false);
        assert!(remote_callbacks(&server, &out).is_ok());
        let request = seen.join().unwrap();
        assert!(request.starts_with("GET /api/v1/user "), "{request}");
    }

    #[test]
    fn a_host_nsit_would_not_talk_to_fails_before_anything_else() {
        let out = quiet_out(false, false);
        let err = remote_callbacks("http://example.com", &out)
            .err()
            .expect("plain http to a remote host");
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
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

    // ---- libgit2 against a server that refuses every login ---------------------------

    /// What a request carried that matters here.
    #[derive(Debug, Clone)]
    struct Seen {
        request_line: String,
        authorization: Option<String>,
    }

    /// An HTTP server on the loopback interface that answers every request with
    /// `401 Unauthorized` and a Basic challenge, and records what it was sent.
    /// It stands in for Insitio's git endpoint with a token it does not accept;
    /// it is nothing but a local socket.
    struct RefusingServer {
        port: u16,
        seen: Arc<Mutex<Vec<Seen>>>,
        stop: Arc<AtomicBool>,
    }

    impl RefusingServer {
        fn start() -> RefusingServer {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let port = listener.local_addr().unwrap().port();
            let seen = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let (seen_by_thread, stop_by_thread) = (Arc::clone(&seen), Arc::clone(&stop));
            thread::spawn(move || {
                while !stop_by_thread.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let seen = Arc::clone(&seen_by_thread);
                            thread::spawn(move || refuse_requests(stream, &seen));
                        }
                        Err(_) => thread::sleep(Duration::from_millis(10)),
                    }
                }
            });
            RefusingServer { port, seen, stop }
        }

        fn host(&self) -> String {
            format!("http://127.0.0.1:{}", self.port)
        }

        fn requests(&self) -> Vec<Seen> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl Drop for RefusingServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
        }
    }

    /// Answer each request on this connection with a 401 until the client leaves.
    fn refuse_requests(mut stream: TcpStream, seen: &Mutex<Vec<Seen>>) {
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        let mut pending = Vec::new();
        let mut buf = [0u8; 2048];
        loop {
            while let Some(end) = pending.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&pending[..end]).into_owned();
                // These requests are GETs; none has a body to skip.
                pending.drain(..end + 4);
                let mut lines = head.lines();
                let request_line = lines.next().unwrap_or_default().to_string();
                let authorization = lines
                    .filter_map(|l| l.split_once(':'))
                    .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
                    .map(|(_, value)| value.trim().to_string());
                seen.lock().unwrap().push(Seen {
                    request_line,
                    authorization,
                });
                let reply = "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"insitio\"\r\nContent-Length: 0\r\n\r\n";
                if stream.write_all(reply.as_bytes()).is_err() {
                    return;
                }
            }
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => pending.extend_from_slice(&buf[..n]),
            }
        }
    }

    fn base64(input: &str) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in input.as_bytes().chunks(3) {
            let n = chunk
                .iter()
                .enumerate()
                .fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
            for i in 0..4 {
                if i <= chunk.len() {
                    out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    #[test]
    fn the_test_base64_matches_the_known_encoding() {
        assert_eq!(base64("ada:secret"), "YWRhOnNlY3JldA==");
        assert_eq!(base64("ab"), "YWI=");
        assert_eq!(base64("abc"), "YWJj");
    }

    #[test]
    fn libgit2_sends_login_and_token_once_and_a_refusal_ends_as_an_auth_error() {
        let server = RefusingServer::start();
        let host = server.host();
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let mut remote = repo
            .remote_anonymous(&format!("{host}/ada/rocket.git"))
            .unwrap();
        let provider = CredentialProvider::new(
            &format!("127.0.0.1:{}", server.port),
            "ada",
            "ins_secret_token",
        );

        let started = Instant::now();
        let err = remote
            .connect_auth(
                git2::Direction::Fetch,
                Some(build_callbacks(provider, None)),
                None,
            )
            .err()
            .expect("the server refuses every login");
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "it must give up, not keep retrying"
        );

        // libgit2 reports that as an authentication error: exit 3, a sign-in hint.
        assert_eq!(err.code(), ErrorCode::Auth, "{err}");
        let mapped = remote_error(err, &host);
        assert!(matches!(mapped, NsitError::Auth(_)), "{mapped:?}");
        assert_eq!(
            mapped.to_string(),
            format!(
                "authentication failed for 127.0.0.1:{}; run nsit auth login",
                server.port
            )
        );
        assert!(!mapped.to_string().contains("ins_secret_token"));

        // On the wire: the first request has no credentials, the one after the
        // challenge has `login:token` as Basic auth, and nothing is sent a third time.
        let seen = server.requests();
        assert!(
            seen[0].request_line.contains("/ada/rocket.git/info/refs"),
            "{seen:?}"
        );
        assert_eq!(seen[0].authorization, None, "{seen:?}");
        let want = format!("Basic {}", base64("ada:ins_secret_token"));
        assert_eq!(
            seen[1].authorization.as_deref(),
            Some(want.as_str()),
            "{seen:?}"
        );
        assert_eq!(seen.len(), 2, "credentials were offered once: {seen:?}");
        // The token is not in the URL either.
        assert!(seen
            .iter()
            .all(|s| !s.request_line.contains("ins_secret_token")));
    }

    // ---- progress -------------------------------------------------------------------

    #[test]
    fn progress_is_for_terminals_and_never_with_quiet() {
        assert!(progress_wanted(true, false));
        assert!(!progress_wanted(true, true), "-q silences it");
        assert!(!progress_wanted(false, false), "not a terminal");
        assert!(!progress_wanted(false, true));
    }

    /// Fetch everything from `source` into a new repository with `callbacks`.
    fn fetch_with(source: &Path, dest: &Path, callbacks: RemoteCallbacks<'_>) {
        let repo = Repository::init(dest).unwrap();
        let mut remote = repo.remote_anonymous(source.to_str().unwrap()).unwrap();
        let mut options = FetchOptions::new();
        options.remote_callbacks(callbacks);
        remote
            .fetch(
                &["+refs/heads/*:refs/remotes/src/*"],
                Some(&mut options),
                None,
            )
            .unwrap();
    }

    fn source_repo(dir: &Path) -> PathBuf {
        let path = dir.join("source");
        std::fs::create_dir(&path).unwrap();
        let repo = Repository::init(&path).unwrap();
        for i in 0..5 {
            commit_file(
                &repo,
                &format!("file{i}.txt"),
                &format!("contents {i}\n").repeat(50),
            );
        }
        path
    }

    #[test]
    fn progress_is_written_only_when_it_was_installed() {
        let dir = tempfile::tempdir().unwrap();
        let source = source_repo(dir.path());
        let shown = Rc::new(RefCell::new(String::new()));

        let sink: Rc<dyn Fn(&str)> = {
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
        assert!(
            text.ends_with("done.\n") || text.contains("done.\n"),
            "{text:?}"
        );

        // Not installed: nothing is written, and the fetch works the same.
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

    #[test]
    fn transfer_lines_follow_receiving_then_resolving() {
        let stats = |recv, total, ideltas, tdeltas, bytes| TransferStats {
            total_objects: total,
            received_objects: recv,
            total_deltas: tdeltas,
            indexed_deltas: ideltas,
            received_bytes: bytes,
        };
        assert_eq!(transfer_line(&stats(0, 0, 0, 0, 0)), None);
        assert_eq!(
            transfer_line(&stats(42, 100, 0, 0, 1536)),
            Some((
                "Receiving objects: 42% (42/100), 1.5 KiB".to_string(),
                false
            ))
        );
        assert_eq!(
            transfer_line(&stats(100, 100, 3, 10, 2048)),
            Some(("Resolving deltas: 30% (3/10)".to_string(), false))
        );
        assert_eq!(
            transfer_line(&stats(100, 100, 10, 10, 2048)),
            Some(("Resolving deltas: 100% (10/10), done.".to_string(), true))
        );
        assert_eq!(
            transfer_line(&stats(7, 7, 0, 0, 700)),
            Some((
                "Receiving objects: 100% (7/7), 700 bytes, done.".to_string(),
                true
            ))
        );
        // Never past 100%.
        let (line, _) = transfer_line(&stats(5, 3, 0, 0, 1)).unwrap();
        assert!(
            line.starts_with("Resolving") || line.contains("100%"),
            "{line}"
        );
    }

    #[test]
    fn push_lines_count_objects_written() {
        assert_eq!(push_line(0, 0, 0), None);
        assert_eq!(
            push_line(1, 4, 100),
            Some(("Writing objects: 25% (1/4), 100 bytes".to_string(), false))
        );
        assert_eq!(
            push_line(4, 4, 3 * 1024 * 1024),
            Some((
                "Writing objects: 100% (4/4), 3.0 MiB, done.".to_string(),
                true
            ))
        );
    }

    #[test]
    fn sizes_read_naturally() {
        assert_eq!(human_bytes(0), "0 bytes");
        assert_eq!(human_bytes(1023), "1023 bytes");
        assert_eq!(human_bytes(1024), "1.0 KiB");
        assert_eq!(human_bytes(1536), "1.5 KiB");
        assert_eq!(human_bytes(20 * 1024 * 1024), "20.0 MiB");
        assert_eq!(human_bytes(5 * 1024 * 1024 * 1024), "5.0 GiB");
    }

    #[test]
    fn a_progress_line_rewrites_itself_and_skips_repeats() {
        let mut p = LineProgress::new();
        assert_eq!(
            p.show("Receiving objects: 10%", false).unwrap(),
            "\rReceiving objects: 10%"
        );
        assert_eq!(
            p.show("Receiving objects: 10%", false),
            None,
            "same line, no output"
        );
        // A shorter line is padded so nothing of the old one is left behind.
        let next = p.show("Done", false).unwrap();
        assert!(next.starts_with("\rDone"), "{next:?}");
        assert_eq!(
            next.chars().count(),
            1 + "Receiving objects: 10%".chars().count()
        );
        // The last line ends the row.
        assert!(p.show("Done, really.", true).unwrap().ends_with('\n'));
    }

    #[test]
    fn text_from_the_remote_cannot_carry_terminal_escapes() {
        assert_eq!(
            clean_sideband(b"Counting objects: 50%\rCounting objects: 100%, done.\n"),
            "Counting objects: 50%\rCounting objects: 100%, done.\n"
        );
        let cleaned = clean_sideband(b"\x1b[2J\x1b]0;title\x07hello\x00 \x08world\n");
        assert!(
            !cleaned
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\r'),
            "{cleaned:?}"
        );
        assert!(cleaned.contains("hello") && cleaned.contains("world"));
        // Bytes that are not text do not panic.
        assert!(!clean_sideband(&[0xff, 0xfe, b'o', b'k']).is_empty());
    }
}
