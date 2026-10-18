//! `nsit auth`: sign in, sign out, and show who is signed in.
//!
//! Signing in either reads a token from stdin (`--with-token`, never from an
//! argument) or runs the device flow: nsit asks the server for a one-time code,
//! prints it with the URL to approve it at, and polls until the user has
//! approved or denied it in a browser, or the code runs out. Either way the
//! token is checked against `GET /api/v1/user` before anything is stored. It
//! is then kept by `credentials` (OS credential store, else an owner-only
//! file); only the account name, display name and email go into `nsit.toml`.
//!
//! Nothing here prints a token. The device flow's code and URL go to stderr in
//! a fixed, greppable form so an agent that cannot open a browser can read
//! them. A browser is opened only when stdin and stdout are terminals.

use std::io::{self, IsTerminal, Read, Write};
use std::time::{Duration, Instant};

use serde::Serialize;
use url::Url;

use crate::api::{Api, DeviceCodeJson, DevicePoll, UserJson};
use crate::cli::{AuthArgs, AuthCommand, GlobalArgs, LoginArgs};
use crate::config::{config_dir, is_loopback, resolve_host, Config, HostConfig};
use crate::credentials::{
    delete_token, host_entry, host_key_for, store_token, token_for, TokenSource, TOKEN_ENV,
    TOKEN_FILE,
};
use crate::error::{one_line, NsitError};
use crate::output::Out;

/// A server that says `slow_down` gets this much more time between polls.
const SLOW_DOWN_STEP: Duration = Duration::from_secs(5);
/// Failed polls in a row (network trouble, a 5xx) to ride out before giving up.
const MAX_TRANSIENT_FAILURES: u32 = 3;
/// Bounds on what the server may ask for, so a broken one cannot make nsit
/// poll in a tight loop or wait for hours.
const MIN_INTERVAL_SECS: u64 = 1;
const MAX_INTERVAL_SECS: u64 = 60;
const MAX_LIFETIME_SECS: u64 = 3600;
/// A token is a few dozen characters; this is already far too much.
const MAX_TOKEN_INPUT: u64 = 16 * 1024;

pub fn run(args: &AuthArgs, global: &GlobalArgs, out: &Out) -> Result<(), NsitError> {
    let host = resolve_host(global.host.as_deref());
    match &args.command {
        AuthCommand::Login(login) => sign_in(&host, login, out),
        AuthCommand::Logout => sign_out(&host, out),
        AuthCommand::Status => status(&host, out),
    }
}

/// What `login` and `status` print with `--json`. Never the token.
#[derive(Debug, Serialize)]
struct Account {
    host: String,
    user: String,
    token_source: &'static str,
}

/// What `logout` prints with `--json`.
#[derive(Debug, Serialize)]
struct SignedOut {
    host: String,
    user: String,
    revoked: bool,
}

// ---- login -----------------------------------------------------------------

fn sign_in(host: &str, args: &LoginArgs, out: &Out) -> Result<(), NsitError> {
    let key = host_key_for(host)?;
    let (token, user) = if args.with_token {
        token_from_stdin(host)?
    } else {
        token_from_browser(host, out)?
    };
    let source = save_login(host, &key, &user, &token)?;
    if source == TokenSource::File {
        warn(&format!(
            "no OS credential store is available here, so the token was saved to an \
             owner-only file: {}",
            config_dir()?.join(TOKEN_FILE).display()
        ));
    }
    if env_token_is_set() {
        warn(&format!(
            "{TOKEN_ENV} is set, so nsit keeps using it instead of the token just saved; \
             unset it to use the saved one"
        ));
    }
    let account = Account {
        host: key,
        user: user.login,
        token_source: source.as_str(),
    };
    out.data(&account, |a| {
        format!("Signed in to {} as {}.", a.host, a.user)
    })
}

/// `--with-token`: the token comes from stdin, is checked with the server, and
/// is returned with the account it belongs to.
fn token_from_stdin(host: &str) -> Result<(String, UserJson), NsitError> {
    let stdin = io::stdin();
    // Reading a token typed at a terminal would echo it and wait for ever.
    if stdin.is_terminal() {
        return Err(NsitError::Usage(
            "--with-token reads the token from stdin; pipe it in, for example \
             `nsit auth login --with-token < token.txt`"
                .into(),
        ));
    }
    let token = read_token(stdin.lock())?;
    let user = Api::new(host, Some(token.clone()))?
        .user()
        .map_err(|e| match e {
            NsitError::Auth(_) => NsitError::Auth("the server did not accept that token".into()),
            other => other,
        })?;
    Ok((token, user))
}

/// The device flow: show a one-time code, wait for approval, return the new
/// token with the account it belongs to.
fn token_from_browser(host: &str, out: &Out) -> Result<(String, UserJson), NsitError> {
    let anonymous = Api::new(host, None)?;
    let code = anonymous.device_code(&client_name())?;
    let expires_in = Duration::from_secs(code.expires_in.min(MAX_LIFETIME_SECS));
    let interval = Duration::from_secs(code.interval.clamp(MIN_INTERVAL_SECS, MAX_INTERVAL_SECS));
    show_code(&code, expires_in, out);
    if out.is_interactive() {
        open_browser(&code.verification_uri, out);
    }
    let token = wait_for_approval(&mut SystemClock::start(), expires_in, interval, || {
        anonymous.device_token(&code.device_code)
    })?;
    let user = Api::new(host, Some(token.clone()))?.user()?;
    Ok((token, user))
}

/// The code and URL, on stderr in a form scripts can match. These two lines
/// are the whole point of the command, so `-q` does not hide them.
fn show_code(code: &DeviceCodeJson, expires_in: Duration, out: &Out) {
    // Both come from the server: no terminal escapes, no multi-line text.
    say(&format!(
        "First copy your one-time code: {}",
        one_line(&code.user_code, 32)
    ));
    say(&format!(
        "Then open: {}",
        one_line(&code.verification_uri, 300)
    ));
    out.info(&format!(
        "Waiting for approval; the code expires in {}.",
        describe_wait(expires_in.as_secs())
    ));
}

fn open_browser(uri: &str, out: &Out) {
    let Some(url) = openable(uri) else { return };
    // Detached: some openers only return when the browser is closed.
    if open::that_detached(url.as_str()).is_ok() {
        out.info("Opening your browser...");
    }
}

/// The verification URL, if it is safe to hand to the operating system's
/// opener: https (or http on loopback, for a local server), with no
/// credentials in it. The URL comes from the server, so a `file:` path or a
/// made-up scheme that would start a program is never opened.
fn openable(uri: &str) -> Option<Url> {
    let url = Url::parse(uri).ok()?;
    let scheme_ok = match url.scheme() {
        "https" => true,
        "http" => is_loopback(&url),
        _ => false,
    };
    let plain = url.host().is_some() && url.username().is_empty() && url.password().is_none();
    (scheme_ok && plain).then_some(url)
}

/// Wait for the user to approve the one-time code, polling every `interval`.
///
/// Returns the new token. `Denied` and `Expired` answers, and running out of
/// time, are `Auth` errors (exit 3). `slow_down` adds five seconds to every
/// later wait, as RFC 8628 asks. A few failed polls in a row (a network blip,
/// a 5xx) are ridden out; any other error ends the wait at once.
///
/// The clock is passed in so the arithmetic can be tested without sleeping.
fn wait_for_approval(
    clock: &mut dyn Clock,
    expires_in: Duration,
    interval: Duration,
    mut poll: impl FnMut() -> Result<DevicePoll, NsitError>,
) -> Result<String, NsitError> {
    let mut interval = interval;
    let mut failures = 0;
    loop {
        // The next poll would land on or after the expiry, when the server
        // answers "expired" whatever the user did: stop here instead. (nsit's
        // clock starts after the server's, so it never gives up late.)
        if expires_in.saturating_sub(clock.elapsed()) <= interval {
            return Err(code_expired());
        }
        clock.sleep(interval);
        match poll() {
            Ok(DevicePoll::Approved { token, .. }) => return Ok(token),
            Ok(DevicePoll::Pending) => failures = 0,
            Ok(DevicePoll::SlowDown) => {
                failures = 0;
                interval += SLOW_DOWN_STEP;
            }
            Ok(DevicePoll::Denied) => {
                return Err(NsitError::Auth(
                    "the sign-in request was denied in the browser".into(),
                ));
            }
            Ok(DevicePoll::Expired) => return Err(code_expired()),
            Err(err) if is_transient(&err) && failures < MAX_TRANSIENT_FAILURES => failures += 1,
            Err(err) => return Err(err),
        }
    }
}

/// A poll failure worth trying again: the network or the server, not us.
fn is_transient(err: &NsitError) -> bool {
    match err {
        // "cannot reach <host>", a response that broke off or made no sense.
        NsitError::Other(_) => true,
        NsitError::Api { status, .. } => *status == 429 || *status >= 500,
        _ => false,
    }
}

fn code_expired() -> NsitError {
    NsitError::Auth(
        "the one-time code expired before it was approved; run nsit auth login for a new one"
            .into(),
    )
}

/// Time as the poll loop sees it. Real life sleeps; tests just add up.
trait Clock {
    /// Time since the code was issued.
    fn elapsed(&self) -> Duration;
    fn sleep(&mut self, how_long: Duration);
}

struct SystemClock(Instant);

impl SystemClock {
    fn start() -> SystemClock {
        SystemClock(Instant::now())
    }
}

impl Clock for SystemClock {
    fn elapsed(&self) -> Duration {
        self.0.elapsed()
    }

    fn sleep(&mut self, how_long: Duration) {
        std::thread::sleep(how_long);
    }
}

/// "10 minutes", "90 seconds".
fn describe_wait(secs: u64) -> String {
    let (minutes, rest) = (secs / 60, secs % 60);
    let (count, unit) = if minutes > 0 && rest == 0 {
        (minutes, "minute")
    } else {
        (secs, "second")
    };
    let plural = if count == 1 { "" } else { "s" };
    format!("{count} {unit}{plural}")
}

/// This machine's name for the approval page ("nsit on <name>").
fn client_name() -> String {
    let name = hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = one_line(&name, 64);
    if name.is_empty() {
        "unknown".to_string()
    } else {
        name
    }
}

/// The token from stdin: whitespace around it is dropped. Empty input, text
/// that is not UTF-8, and far too much input are usage errors that do not
/// repeat what was read.
fn read_token(input: impl Read) -> Result<String, NsitError> {
    let mut bytes = Vec::new();
    // One byte past the limit tells "exactly at it" from "more than that".
    input.take(MAX_TOKEN_INPUT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_TOKEN_INPUT {
        return Err(NsitError::Usage(
            "too much input on stdin for an access token".into(),
        ));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| NsitError::Usage("the token on stdin is not valid text".into()))?;
    // Windows PowerShell and many editors start a file with a byte-order mark.
    // It is not whitespace, so `trim` would leave it in the token.
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let token = text.trim();
    if token.is_empty() {
        return Err(NsitError::Usage(
            "no token on stdin; pipe it in, for example `nsit auth login --with-token < token.txt`"
                .into(),
        ));
    }
    Ok(token.to_string())
}

/// Remember a successful sign-in: the token in the credential store (or
/// file) first, then who it belongs to in the config, so a failure never
/// leaves a token that nothing points to.
///
/// One account per host: signing in as someone else replaces the account in
/// the config and forgets the previous account's token here (it is not
/// revoked on the server). Returns where the token ended up.
fn save_login(
    host: &str,
    key: &str,
    user: &UserJson,
    token: &str,
) -> Result<TokenSource, NsitError> {
    let mut config = Config::load()?;
    let previous = remembered_user(&config, key);

    let source = store_token(host, &user.login, token)?;

    forget_host(&mut config, key);
    config.hosts.insert(
        key.to_string(),
        HostConfig {
            user: user.login.clone(),
            name: non_empty(&user.name),
            email: non_empty(&user.email),
        },
    );
    if let Err(err) = config.save() {
        // Best effort: do not leave a token that no config entry points to.
        let _ = delete_token(host, &user.login);
        return Err(err);
    }
    // Best effort too: the new token is already safely stored.
    if let Some(old) = previous.filter(|old| *old != user.login) {
        let _ = delete_token(host, &old);
    }
    Ok(source)
}

// ---- status ------------------------------------------------------------------

fn status(host: &str, out: &Out) -> Result<(), NsitError> {
    let key = host_key_for(host)?;
    // Not signed in is decided here, without any network call or prompt.
    let (token, source) = token_for(host, None)?;
    // Ask the server: a token revoked elsewhere is not "signed in", and an
    // `NSIT_TOKEN` has no account in the config to read the name from.
    let user = Api::new(host, Some(token))?.user().map_err(|e| match e {
        NsitError::Auth(_) => NsitError::Auth(match source {
            TokenSource::Env => format!("{key} did not accept the token in {TOKEN_ENV}"),
            _ => format!("{key} did not accept the saved token; run nsit auth login"),
        }),
        other => other,
    })?;
    let account = Account {
        host: key,
        user: user.login,
        token_source: source.as_str(),
    };
    out.data(&account, |a| {
        format!(
            "Signed in to {} as {}; token from {}.",
            a.host,
            a.user,
            source.describe()
        )
    })
}

// ---- logout ------------------------------------------------------------------

/// What happened to the token on the server.
#[derive(Debug)]
enum Revocation {
    Revoked,
    /// The server no longer knew the token (401): nothing left to revoke.
    AlreadyRevoked,
    /// The config names an account but no token was stored for it.
    NoToken,
    /// The server could not be asked (network, 5xx): the token is still valid.
    Failed(NsitError),
}

/// Revoke the token on the server, then delete it here and forget the account.
///
/// If the server cannot be reached the token is still deleted here, and the
/// command then fails (exit 1) saying the token stays valid: the machine is
/// clean either way, and a script is told the revocation did not happen.
///
/// The same holds when the token cannot even be read (a locked credential
/// store, a damaged token file): deleting it is still attempted, and the
/// account is forgotten once that worked. The original error is what is
/// reported.
fn sign_out(host: &str, out: &Out) -> Result<(), NsitError> {
    sign_out_with(host, out, revoke)
}

/// `sign_out` with the "read the token and revoke it" step passed in, so a
/// failing read can be tested.
fn sign_out_with(
    host: &str,
    out: &Out,
    revoke: impl FnOnce(&str, &str) -> Result<Revocation, NsitError>,
) -> Result<(), NsitError> {
    let key = host_key_for(host)?;
    // The revoke call revokes whichever token `token_for` finds, and that would
    // be the one in the environment: an agent's credential, not ours to destroy.
    if env_token_is_set() {
        return Err(NsitError::Usage(format!(
            "{TOKEN_ENV} is set, and nsit cannot sign out of a token held in the \
             environment; unset it first (then run this again to forget a saved token)"
        )));
    }
    let mut config = Config::load()?;
    let user = remembered_user(&config, &key).ok_or_else(|| {
        NsitError::Auth(format!("not signed in to {key}; nothing to sign out of"))
    })?;

    // Whatever happens to the revocation, the local token is deleted.
    let revocation = revoke(host, &user);
    let deleted = delete_token(host, &user);
    // Only once the token is gone does the config forget the account: a failed
    // delete can then be retried, because logout can still find the account.
    let saved = if deleted.is_ok() {
        forget_host(&mut config, &key);
        config.save()
    } else {
        Ok(())
    };

    let (revoked, note) = match sign_out_outcome(revocation, deleted, saved)? {
        Revocation::Failed(why) => {
            return Err(NsitError::Other(format!(
                "signed out here, but the token could not be revoked on the server ({why}); \
                 it stays valid until you revoke it in your account settings"
            )));
        }
        Revocation::Revoked => (true, "the token was revoked"),
        Revocation::AlreadyRevoked => (false, "the token had already been revoked"),
        Revocation::NoToken => (false, "no saved token was found"),
    };
    let result = SignedOut {
        host: key,
        user,
        revoked,
    };
    out.data(&result, |r| format!("Signed out of {}; {note}.", r.host))
}

/// What logout reports once it has tried to revoke the token, delete it and
/// update the config.
///
/// If the token could not be read, that original error comes first (exit 1,
/// the wording the user needs to fix it); a cleanup failure on top of it is
/// added to the same line. If it was read, a failed delete or a failed config
/// write is the error.
fn sign_out_outcome(
    revocation: Result<Revocation, NsitError>,
    deleted: Result<(), NsitError>,
    saved: Result<(), NsitError>,
) -> Result<Revocation, NsitError> {
    match revocation {
        Ok(revocation) => {
            deleted?;
            saved?;
            Ok(revocation)
        }
        Err(original) => {
            let first = original.to_string();
            let also: Vec<String> = [deleted, saved]
                .into_iter()
                .filter_map(Result::err)
                .map(|e| e.to_string())
                .filter(|text| *text != first)
                .collect();
            if also.is_empty() {
                Err(original)
            } else {
                Err(NsitError::Other(format!(
                    "{first}; cleaning up here failed too ({})",
                    also.join("; ")
                )))
            }
        }
    }
}

fn revoke(host: &str, user: &str) -> Result<Revocation, NsitError> {
    let token = match token_for(host, Some(user)) {
        Ok((token, _)) => token,
        Err(NsitError::Auth(_)) => return Ok(Revocation::NoToken),
        Err(other) => return Err(other),
    };
    Ok(match Api::new(host, Some(token))?.revoke_current() {
        Ok(()) => Revocation::Revoked,
        Err(NsitError::Auth(_)) => Revocation::AlreadyRevoked,
        Err(other) => Revocation::Failed(other),
    })
}

// ---- config entries ----------------------------------------------------------

/// The account the config remembers for the host with this canonical key. The
/// config may spell the host any way (`https://Git.Iam.Bot/`), so entries are
/// matched by key, as `credentials` does.
fn remembered_user(config: &Config, key: &str) -> Option<String> {
    host_entry(config, key).map(|entry| entry.user.clone())
}

/// Drop every config entry for the host with this key, however it is spelled.
fn forget_host(config: &mut Config, key: &str) {
    config
        .hosts
        .retain(|host, _| !host_key_for(host).is_ok_and(|k| k == key));
}

fn non_empty(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

// ---- small helpers -----------------------------------------------------------

/// Is `NSIT_TOKEN` set to something? Blank counts as unset, as in `credentials`.
fn env_token_is_set() -> bool {
    std::env::var_os(TOKEN_ENV).is_some_and(|v| !v.to_string_lossy().trim().is_empty())
}

/// A line on stderr. A closed stderr must not turn into a panic.
fn say(line: &str) {
    let _ = writeln!(io::stderr(), "{line}");
}

/// A warning on stderr: something worth knowing that did not stop the command.
/// Not hidden by `-q`, which is for progress and hints.
fn warn(msg: &str) {
    say(&format!("nsit: warning: {msg}"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::NO_KEYCHAIN_ENV;
    use crate::error::NsitError;
    use crate::test_env::EnvGuard;
    use std::collections::VecDeque;
    use std::io::Cursor;
    use std::path::Path;

    // ---- the poll loop, on a clock that only counts ---------------------------

    const fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    /// Time that passes only when someone sleeps.
    #[derive(Default)]
    struct FakeClock {
        now: Duration,
        naps: Vec<Duration>,
    }

    impl Clock for FakeClock {
        fn elapsed(&self) -> Duration {
            self.now
        }

        fn sleep(&mut self, how_long: Duration) {
            self.now += how_long;
            self.naps.push(how_long);
        }
    }

    fn approved() -> Result<DevicePoll, NsitError> {
        Ok(DevicePoll::Approved {
            token: "ins_new_token".into(),
            login: "ada".into(),
        })
    }

    fn pending() -> Result<DevicePoll, NsitError> {
        Ok(DevicePoll::Pending)
    }

    fn slow_down() -> Result<DevicePoll, NsitError> {
        Ok(DevicePoll::SlowDown)
    }

    fn network_down(n: u32) -> Result<DevicePoll, NsitError> {
        Err(NsitError::Other(format!(
            "cannot reach the server (try {n})"
        )))
    }

    /// Runs the loop against a fixed list of answers (it fails if polled more
    /// often), and reports how often it was polled.
    fn scripted(
        expires_in: Duration,
        interval: Duration,
        answers: Vec<Result<DevicePoll, NsitError>>,
    ) -> (Result<String, NsitError>, FakeClock, usize) {
        let mut clock = FakeClock::default();
        let mut answers: VecDeque<_> = answers.into();
        let mut polls = 0;
        let result = wait_for_approval(&mut clock, expires_in, interval, || {
            polls += 1;
            answers
                .pop_front()
                .expect("polled more often than scripted")
        });
        (result, clock, polls)
    }

    #[test]
    fn the_first_poll_comes_one_interval_after_the_code_was_issued() {
        let (result, clock, polls) = scripted(secs(600), secs(5), vec![approved()]);
        assert_eq!(result.unwrap(), "ins_new_token");
        assert_eq!(polls, 1);
        assert_eq!(clock.naps, [secs(5)]);
    }

    #[test]
    fn it_polls_every_interval_while_the_answer_is_pending() {
        let (result, clock, polls) =
            scripted(secs(600), secs(5), vec![pending(), pending(), approved()]);
        assert_eq!(result.unwrap(), "ins_new_token");
        assert_eq!(polls, 3);
        assert_eq!(clock.naps, [secs(5), secs(5), secs(5)]);
    }

    #[test]
    fn slow_down_adds_five_seconds_to_every_later_wait() {
        let (result, clock, _) = scripted(
            secs(600),
            secs(5),
            vec![pending(), slow_down(), pending(), slow_down(), approved()],
        );
        assert_eq!(result.unwrap(), "ins_new_token");
        assert_eq!(
            clock.naps,
            [secs(5), secs(5), secs(10), secs(10), secs(15)],
            "each slow_down makes every later wait five seconds longer"
        );
    }

    #[test]
    fn a_server_with_its_own_interval_is_honored() {
        let (_, clock, _) = scripted(secs(600), secs(7), vec![pending(), approved()]);
        assert_eq!(clock.naps, [secs(7), secs(7)]);
    }

    #[test]
    fn it_gives_up_with_an_auth_error_when_the_code_runs_out() {
        let mut clock = FakeClock::default();
        let mut polls = 0;
        let err = wait_for_approval(&mut clock, secs(600), secs(5), || {
            polls += 1;
            pending()
        })
        .unwrap_err();
        assert!(matches!(err, NsitError::Auth(_)), "{err:?}");
        assert_eq!(err.exit_code(), 3);
        assert!(err.to_string().contains("expired"), "{err}");
        assert!(err.to_string().contains("nsit auth login"), "{err}");
        // Polls at 5 s, 10 s, ... 595 s: the next would land on the expiry itself.
        assert_eq!(polls, 119);
        assert!(
            clock.now <= secs(600),
            "waited past expiry: {:?}",
            clock.now
        );
    }

    #[test]
    fn it_never_sleeps_past_the_expiry_when_the_interval_does_not_divide_it() {
        let mut clock = FakeClock::default();
        let mut polls = 0;
        let err = wait_for_approval(&mut clock, secs(12), secs(5), || {
            polls += 1;
            pending()
        })
        .unwrap_err();
        assert_eq!(err.exit_code(), 3);
        assert_eq!(
            polls, 2,
            "polls at 5 s and 10 s; 15 s is past the 12 s life"
        );
        assert_eq!(clock.now, secs(10));
    }

    #[test]
    fn slow_down_can_use_up_what_is_left_of_the_code() {
        // 30 s life: poll at 5 s (slow_down, wait now 10 s), poll at 15 s
        // (slow_down, wait now 15 s), and 15 s is all that is left.
        let (result, clock, polls) = scripted(secs(30), secs(5), vec![slow_down(), slow_down()]);
        assert_eq!(result.unwrap_err().exit_code(), 3);
        assert_eq!(polls, 2);
        assert_eq!(clock.now, secs(15));
    }

    #[test]
    fn a_code_that_lives_less_than_one_interval_is_never_polled() {
        let (result, clock, polls) = scripted(secs(3), secs(5), vec![]);
        assert_eq!(result.unwrap_err().exit_code(), 3);
        assert_eq!(polls, 0);
        assert!(clock.naps.is_empty());
    }

    #[test]
    fn denied_ends_the_wait_with_an_auth_error() {
        let (result, clock, polls) =
            scripted(secs(600), secs(5), vec![pending(), Ok(DevicePoll::Denied)]);
        let err = result.unwrap_err();
        assert!(matches!(err, NsitError::Auth(_)), "{err:?}");
        assert_eq!(err.exit_code(), 3);
        assert!(err.to_string().contains("denied"), "{err}");
        assert_eq!(polls, 2, "no polling after a denial");
        assert_eq!(clock.naps.len(), 2);
    }

    #[test]
    fn the_server_reporting_expiry_is_an_auth_error_too() {
        let (result, _, polls) = scripted(secs(600), secs(5), vec![Ok(DevicePoll::Expired)]);
        let err = result.unwrap_err();
        assert!(matches!(err, NsitError::Auth(_)), "{err:?}");
        assert!(err.to_string().contains("expired"), "{err}");
        assert_eq!(polls, 1);
    }

    #[test]
    fn a_few_failed_polls_in_a_row_are_ridden_out() {
        let (result, clock, polls) = scripted(
            secs(600),
            secs(5),
            vec![
                network_down(1),
                network_down(2),
                network_down(3),
                approved(),
            ],
        );
        assert_eq!(result.unwrap(), "ins_new_token");
        assert_eq!(polls, 4);
        assert_eq!(
            clock.naps.len(),
            4,
            "it still waits an interval before each retry"
        );
    }

    #[test]
    fn an_answer_resets_the_count_of_failures() {
        let (result, _, polls) = scripted(
            secs(600),
            secs(5),
            vec![
                network_down(1),
                network_down(2),
                network_down(3),
                pending(),
                network_down(4),
                network_down(5),
                network_down(6),
                approved(),
            ],
        );
        assert_eq!(result.unwrap(), "ins_new_token");
        assert_eq!(polls, 8);
    }

    #[test]
    fn too_many_failures_in_a_row_give_up_with_the_last_one() {
        let (result, _, polls) = scripted(
            secs(600),
            secs(5),
            vec![
                network_down(1),
                network_down(2),
                network_down(3),
                network_down(4),
            ],
        );
        let err = result.unwrap_err();
        assert_eq!(err.to_string(), "cannot reach the server (try 4)");
        assert_eq!(err.exit_code(), 1);
        assert_eq!(polls, 4);
    }

    #[test]
    fn server_errors_are_retried_but_other_errors_are_not() {
        let api = |status: u16| {
            Err(NsitError::Api {
                status,
                code: "x".into(),
                message: "m".into(),
            })
        };
        for status in [500u16, 502, 503, 429] {
            let (result, _, polls) = scripted(secs(600), secs(5), vec![api(status), approved()]);
            assert!(result.is_ok(), "{status} should be retried");
            assert_eq!(polls, 2);
        }
        for status in [400u16, 403, 404, 422] {
            let (result, _, polls) = scripted(secs(600), secs(5), vec![api(status)]);
            assert!(result.is_err(), "{status} should end the wait");
            assert_eq!(polls, 1);
        }
        let (result, _, polls) = scripted(
            secs(600),
            secs(5),
            vec![Err(NsitError::Auth("nope".into()))],
        );
        assert_eq!(result.unwrap_err().exit_code(), 3);
        assert_eq!(polls, 1);
        let (result, _, polls) = scripted(
            secs(600),
            secs(5),
            vec![Err(NsitError::Usage("bad".into()))],
        );
        assert_eq!(result.unwrap_err().exit_code(), 2);
        assert_eq!(polls, 1);
    }

    #[test]
    fn the_device_code_is_not_in_any_error_the_loop_produces() {
        // The loop never sees the code (the poll closure holds it); what it
        // reports comes from fixed text or from the poll's own error.
        for answer in [Ok(DevicePoll::Denied), Ok(DevicePoll::Expired)] {
            let (result, _, _) = scripted(secs(600), secs(5), vec![answer]);
            let text = result.unwrap_err().to_string();
            assert!(!text.contains("ins_") && !text.contains("dc_"), "{text}");
        }
    }

    #[test]
    fn waits_read_naturally() {
        assert_eq!(describe_wait(600), "10 minutes");
        assert_eq!(describe_wait(60), "1 minute");
        assert_eq!(describe_wait(120), "2 minutes");
        assert_eq!(describe_wait(90), "90 seconds");
        assert_eq!(describe_wait(1), "1 second");
        assert_eq!(describe_wait(0), "0 seconds");
    }

    // ---- reading the token ----------------------------------------------------

    #[test]
    fn whitespace_around_the_token_is_dropped() {
        for raw in [
            "ins_abc",
            "ins_abc\n",
            "  ins_abc\r\n",
            "\n\n\tins_abc  \n\n",
        ] {
            assert_eq!(read_token(Cursor::new(raw)).unwrap(), "ins_abc", "{raw:?}");
        }
    }

    #[test]
    fn empty_input_is_a_usage_error_with_a_hint() {
        for raw in ["", "   ", "\r\n", " \n\t "] {
            let err = read_token(Cursor::new(raw)).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{raw:?}: {err:?}");
            assert_eq!(err.exit_code(), 2);
            assert!(err.to_string().contains("no token on stdin"), "{err}");
        }
    }

    #[test]
    fn input_that_is_not_text_is_refused_without_repeating_it() {
        let err = read_token(Cursor::new(b"ins_\xff\xfe".to_vec())).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert!(!err.to_string().contains("ins_"), "{err}");
    }

    #[test]
    fn it_never_reads_more_than_a_token_can_be() {
        // An endless reader must end in an error, not in memory exhaustion.
        let err = read_token(io::repeat(b'a')).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert!(err.to_string().contains("too much"), "{err}");
        // Exactly the limit is still accepted.
        let at_limit = "a".repeat(MAX_TOKEN_INPUT as usize);
        assert_eq!(read_token(Cursor::new(at_limit.clone())).unwrap(), at_limit);
    }

    #[test]
    fn a_leading_byte_order_mark_is_dropped() {
        // Windows PowerShell and many editors put one first (EF BB BF).
        for raw in [
            "\u{feff}ins_abc",
            "\u{feff}ins_abc\r\n",
            "\u{feff}  ins_abc \n",
            "\u{feff}\n\tins_abc",
        ] {
            assert_eq!(read_token(Cursor::new(raw)).unwrap(), "ins_abc", "{raw:?}");
        }
        let bytes = b"\xEF\xBB\xBFins_abc\r\n".to_vec();
        assert_eq!(read_token(Cursor::new(bytes)).unwrap(), "ins_abc");
    }

    #[test]
    fn a_byte_order_mark_alone_is_no_token() {
        let err = read_token(Cursor::new("\u{feff}\r\n")).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert!(err.to_string().contains("no token on stdin"), "{err}");
    }

    #[test]
    fn only_a_leading_byte_order_mark_is_dropped() {
        // Anywhere else it is part of the text, and the token stays unusable
        // (and is refused later) instead of being silently repaired.
        for raw in [
            "ins_\u{feff}abc",
            "\u{feff}\u{feff}ins_abc",
            "ins_abc\u{feff}",
        ] {
            let token = read_token(Cursor::new(raw)).unwrap();
            assert!(!crate::credentials::is_well_formed(&token), "{raw:?}");
        }
    }

    #[test]
    fn a_failing_reader_is_an_io_error() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::other("pipe broke"))
            }
        }
        let err = read_token(Broken).unwrap_err();
        assert!(matches!(err, NsitError::Io(_)), "{err:?}");
    }

    // ---- which URLs may be opened ---------------------------------------------

    #[test]
    fn https_and_loopback_http_urls_may_be_opened() {
        for uri in [
            "https://git.iam.bot/login/device",
            "https://example.com:8443/login/device",
            "http://127.0.0.1:3000/login/device",
            "http://localhost:8080/login/device",
            "http://[::1]:3000/login/device",
        ] {
            let url = openable(uri).unwrap_or_else(|| panic!("{uri} should be openable"));
            assert_eq!(url.as_str(), uri);
        }
    }

    #[test]
    fn anything_else_is_never_handed_to_the_opener() {
        for uri in [
            "http://example.com/login/device",
            "http://10.0.0.5/login/device",
            "http://localhost.evil.example/",
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "ms-settings:network",
            "ssh://example.com",
            "https://ada:hunter2@example.com/login/device",
            "git.iam.bot/login/device",
            "calc.exe",
            "",
            "   ",
        ] {
            assert!(openable(uri).is_none(), "{uri:?} must not be opened");
        }
    }

    // ---- remembering a login ------------------------------------------------------

    const HOST: &str = "git.iam.bot";

    /// File store only, in a throwaway config dir; the real credential store
    /// and the real config are never touched.
    fn env(dir: &Path) -> EnvGuard {
        EnvGuard::lock()
            .set("NSIT_CONFIG_DIR", dir)
            .set(NO_KEYCHAIN_ENV, "1")
            .unset(TOKEN_ENV)
            .unset("NSIT_HOST")
    }

    fn account(login: &str, name: &str, email: &str) -> UserJson {
        UserJson {
            login: login.into(),
            name: name.into(),
            email: email.into(),
            is_admin: false,
        }
    }

    #[test]
    fn a_login_stores_the_token_and_remembers_the_account() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        let ada = account("ada", "Ada Lovelace", "ada@example.com");
        assert_eq!(
            save_login(HOST, HOST, &ada, "ins_ada_token").unwrap(),
            TokenSource::File
        );
        let config = Config::load().unwrap();
        assert_eq!(
            config.hosts.get(HOST),
            Some(&HostConfig {
                user: "ada".into(),
                name: Some("Ada Lovelace".into()),
                email: Some("ada@example.com".into()),
            })
        );
        // Without naming the user, the token is found through the config.
        assert_eq!(
            token_for(HOST, None).unwrap(),
            ("ins_ada_token".to_string(), TokenSource::File)
        );
        let config_text = std::fs::read_to_string(dir.path().join("nsit.toml")).unwrap();
        assert!(!config_text.contains("ins_ada_token"), "{config_text}");
    }

    #[test]
    fn a_blank_name_or_email_is_not_written() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        save_login(HOST, HOST, &account("ada", "  ", ""), "ins_t").unwrap();
        let entry = Config::load().unwrap().hosts[HOST].clone();
        assert_eq!((entry.name, entry.email), (None, None));
    }

    #[test]
    fn signing_in_as_someone_else_replaces_the_account_and_forgets_its_token() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        save_login(HOST, HOST, &account("ada", "", ""), "ins_ada").unwrap();
        save_login(HOST, HOST, &account("grace", "", ""), "ins_grace").unwrap();

        let config = Config::load().unwrap();
        assert_eq!(config.hosts.len(), 1);
        assert_eq!(config.hosts[HOST].user, "grace");
        assert_eq!(token_for(HOST, None).unwrap().0, "ins_grace");
        // Ada's token is no longer anywhere on this machine.
        assert!(token_for(HOST, Some("ada")).is_err());
        let tokens = std::fs::read_to_string(dir.path().join(TOKEN_FILE)).unwrap();
        assert!(!tokens.contains("ins_ada"), "{tokens}");
    }

    #[test]
    fn signing_in_again_as_the_same_account_replaces_the_token() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        save_login(HOST, HOST, &account("ada", "", ""), "ins_old").unwrap();
        save_login(HOST, HOST, &account("ada", "", ""), "ins_new").unwrap();
        assert_eq!(token_for(HOST, None).unwrap().0, "ins_new");
    }

    #[test]
    fn one_host_spelled_two_ways_is_one_config_entry() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        let mut config = Config::default();
        config.hosts.insert(
            "https://GIT.iam.bot/".to_string(),
            HostConfig {
                user: "ada".into(),
                name: None,
                email: None,
            },
        );
        config.save().unwrap();
        save_login(HOST, HOST, &account("grace", "", ""), "ins_grace").unwrap();
        let config = Config::load().unwrap();
        assert_eq!(config.hosts.keys().collect::<Vec<_>>(), [HOST]);
        assert_eq!(config.hosts[HOST].user, "grace");
    }

    #[test]
    fn other_hosts_are_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        save_login(HOST, HOST, &account("ada", "", ""), "ins_main").unwrap();
        save_login(
            "http://127.0.0.1:3000",
            "127.0.0.1:3000",
            &account("ada", "", ""),
            "ins_local",
        )
        .unwrap();
        assert_eq!(token_for(HOST, None).unwrap().0, "ins_main");
        assert_eq!(
            token_for("http://127.0.0.1:3000", None).unwrap().0,
            "ins_local"
        );
        assert_eq!(Config::load().unwrap().hosts.len(), 2);
    }

    #[test]
    fn a_login_that_cannot_be_stored_leaves_the_config_alone() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        // A token the credential layer refuses (it would not fit in a header).
        let err = save_login(HOST, HOST, &account("ada", "", ""), "two words").unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert!(Config::load().unwrap().hosts.is_empty());
    }

    #[test]
    fn forgetting_a_host_removes_it_however_it_is_spelled() {
        let mut config = Config::default();
        for spelling in ["git.iam.bot", "https://Git.Iam.Bot/", "other.example"] {
            config.hosts.insert(
                spelling.to_string(),
                HostConfig {
                    user: "ada".into(),
                    name: None,
                    email: None,
                },
            );
        }
        assert_eq!(remembered_user(&config, HOST).as_deref(), Some("ada"));
        forget_host(&mut config, HOST);
        assert_eq!(config.hosts.keys().collect::<Vec<_>>(), ["other.example"]);
        assert_eq!(remembered_user(&config, HOST), None);
    }

    // ---- logout: the local token goes away on every path -------------------------

    fn quiet_out() -> Out {
        Out {
            json: false,
            jq: None,
            tty: false,
            color: false,
            quiet: true,
        }
    }

    #[test]
    fn a_token_that_cannot_be_read_is_still_deleted_and_the_account_forgotten() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        save_login(HOST, HOST, &account("ada", "", ""), "ins_ada_token").unwrap();
        assert!(dir.path().join(TOKEN_FILE).exists());

        let original = "cannot read the token from the OS credential store: locked";
        let err = sign_out_with(HOST, &quiet_out(), |_, _| {
            Err(NsitError::Other(original.into()))
        })
        .unwrap_err();
        // The original failure is what gets reported (exit 1)...
        assert!(matches!(err, NsitError::Other(_)), "{err:?}");
        assert_eq!(err.to_string(), original);
        assert_eq!(err.exit_code(), 1);
        // ...but the token is gone here and the account is forgotten.
        assert!(!dir.path().join(TOKEN_FILE).exists());
        assert!(token_for(HOST, Some("ada")).is_err());
        assert!(Config::load().unwrap().hosts.is_empty());
    }

    #[test]
    fn a_token_file_that_cannot_be_read_or_deleted_keeps_the_account_so_logout_can_be_retried() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        save_login(HOST, HOST, &account("ada", "", ""), "ins_ada_token").unwrap();
        let garbage = "this is [not toml";
        std::fs::write(dir.path().join(TOKEN_FILE), garbage).unwrap();

        // Reading the token fails before any network call, so no server is needed.
        let err = sign_out_with(HOST, &quiet_out(), revoke).unwrap_err();
        assert!(matches!(err, NsitError::Other(_)), "{err:?}");
        let text = err.to_string();
        assert!(text.contains("not a valid token file"), "{text}");
        assert!(!text.contains('\n'), "one line please: {text:?}");
        assert!(!text.contains("ins_ada_token"), "{text}");
        // Neither the file nor the account was thrown away.
        assert_eq!(
            std::fs::read_to_string(dir.path().join(TOKEN_FILE)).unwrap(),
            garbage
        );
        assert_eq!(Config::load().unwrap().hosts[HOST].user, "ada");
    }

    #[test]
    fn what_logout_reports_when_cleaning_up_goes_wrong() {
        let ok = || Ok(());
        let read_failed = || Err(NsitError::Other("cannot read the token".into()));
        let failure = |why: &str| Err(NsitError::Other(why.into()));

        // Cleanup fine: the original error, untouched.
        let err = sign_out_outcome(read_failed(), ok(), ok()).unwrap_err();
        assert_eq!(err.to_string(), "cannot read the token");
        // Cleanup failed too: both are said, on one line.
        let err = sign_out_outcome(read_failed(), failure("cannot remove it"), ok()).unwrap_err();
        let text = err.to_string();
        assert!(text.starts_with("cannot read the token"), "{text}");
        assert!(text.contains("cannot remove it"), "{text}");
        assert!(!text.contains('\n'), "{text:?}");
        // The same words are not said twice.
        let err =
            sign_out_outcome(read_failed(), failure("cannot read the token"), ok()).unwrap_err();
        assert_eq!(err.to_string(), "cannot read the token");
        // A failed config save after a failed read is mentioned as well.
        let err =
            sign_out_outcome(read_failed(), ok(), failure("cannot write nsit.toml")).unwrap_err();
        assert!(err.to_string().contains("cannot write nsit.toml"), "{err}");

        // The token was read: the revocation result stands, unless cleanup failed.
        assert!(matches!(
            sign_out_outcome(Ok(Revocation::Revoked), ok(), ok()),
            Ok(Revocation::Revoked)
        ));
        assert!(matches!(
            sign_out_outcome(Ok(Revocation::NoToken), ok(), ok()),
            Ok(Revocation::NoToken)
        ));
        let err =
            sign_out_outcome(Ok(Revocation::Revoked), failure("cannot delete"), ok()).unwrap_err();
        assert_eq!(err.to_string(), "cannot delete");
        let err =
            sign_out_outcome(Ok(Revocation::Revoked), ok(), failure("cannot save")).unwrap_err();
        assert_eq!(err.to_string(), "cannot save");
    }

    // ---- small things -----------------------------------------------------------

    #[test]
    fn the_client_name_is_one_short_clean_line() {
        let name = client_name();
        assert!(!name.is_empty());
        assert!(name.chars().count() <= 67, "{name}");
        assert!(!name.chars().any(char::is_control), "{name:?}");
    }

    #[test]
    fn env_token_counts_only_when_it_has_content() {
        let env = EnvGuard::lock().unset(TOKEN_ENV);
        assert!(!env_token_is_set());
        let env = env.set(TOKEN_ENV, "   ");
        assert!(!env_token_is_set(), "blank means unset");
        let _env = env.set(TOKEN_ENV, "ins_abc");
        assert!(env_token_is_set());
    }

    #[test]
    fn account_json_has_exactly_host_user_and_token_source() {
        let json = serde_json::to_value(Account {
            host: "git.iam.bot".into(),
            user: "ada".into(),
            token_source: TokenSource::File.as_str(),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"host": "git.iam.bot", "user": "ada", "token_source": "File"})
        );
    }

    #[test]
    fn transient_errors_are_the_network_and_the_server_only() {
        assert!(is_transient(&NsitError::Other("cannot reach x".into())));
        assert!(!is_transient(&NsitError::Auth("a".into())));
        assert!(!is_transient(&NsitError::Usage("u".into())));
    }
}
