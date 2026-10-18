//! API tokens: where nsit keeps them and how it finds the one to use.
//!
//! Resolution order (see the spec, "Configuration and auth"):
//!
//! 1. `NSIT_TOKEN`, for agents and CI. It applies to whichever host is asked
//!    about and is never stored anywhere.
//! 2. The OS credential store (Windows Credential Manager, macOS Keychain,
//!    Secret Service on other Unix): service `insitio:<host>`, account
//!    `<username>`.
//! 3. An owner-only token file in the config directory, used **only** when
//!    the machine has no credential store at all (a headless Linux box).
//!    A store that exists but fails (locked, access denied, ...) is an
//!    error, never a reason to write the token to disk in plain text.
//!
//! `NSIT_NO_KEYCHAIN=1` pretends there is no credential store; the tests use
//! it so they can never touch the real one.
//!
//! Nothing here puts a token in an error message, a `Debug` string or a log.

use std::collections::BTreeMap;
use std::fmt;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};
use url::Url;

use crate::config::{base_url, config_dir, write_private_file, Config, HostConfig};
use crate::error::{one_line, NsitError};

/// Environment variable that supplies a token directly.
pub const TOKEN_ENV: &str = "NSIT_TOKEN";
/// Set to `1` to skip the OS credential store and use the token file.
pub const NO_KEYCHAIN_ENV: &str = "NSIT_NO_KEYCHAIN";
/// The token file, inside the config directory.
pub const TOKEN_FILE: &str = "tokens.toml";

/// Where a token came from, for `nsit auth status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenSource {
    /// The `NSIT_TOKEN` environment variable.
    Env,
    /// The OS credential store.
    Keychain,
    /// The owner-only token file.
    File,
}

impl TokenSource {
    /// Short stable name, for `--json` output: the variant name (`"Env"`,
    /// `"Keychain"`, `"File"`), which is what the end-to-end tests look for.
    pub fn as_str(self) -> &'static str {
        match self {
            TokenSource::Env => "Env",
            TokenSource::Keychain => "Keychain",
            TokenSource::File => "File",
        }
    }

    /// Human wording, for `nsit auth status`.
    pub fn describe(self) -> &'static str {
        match self {
            TokenSource::Env => "the NSIT_TOKEN environment variable",
            TokenSource::Keychain => "the OS credential store",
            TokenSource::File => "the token file",
        }
    }
}

// ---- host keys -------------------------------------------------------------

/// The one canonical name for a server, used as the credential-store service
/// suffix and as the token-file key: lowercase `host[:port]`, no scheme, no
/// path. `git.iam.bot`, `https://git.iam.bot` and `https://git.iam.bot/` all
/// give `git.iam.bot`.
pub fn host_key(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    }
}

/// `host_key` for a host as the user typed it (a bare name or a full URL).
/// Fails like `base_url` does: plain http to a remote host is refused.
pub fn host_key_for(host: &str) -> Result<String, NsitError> {
    Ok(host_key(&base_url(host)?))
}

fn service_name(key: &str) -> String {
    format!("insitio:{key}")
}

fn not_signed_in(key: &str) -> NsitError {
    NsitError::Auth(format!("not signed in to {key}; run nsit auth login"))
}

// ---- tokens ------------------------------------------------------------------

/// Can this string be sent as `Authorization: Bearer <token>`? Insitio tokens
/// look like `ins_<base64url>`: printable ASCII, no spaces.
pub(crate) fn is_well_formed(token: &str) -> bool {
    !token.is_empty() && token.bytes().all(|b| b.is_ascii_graphic())
}

/// A token read back from a store, or `None` if it is unusable (blank or
/// garbled), which is treated as "not signed in" so signing in again fixes it.
fn usable(token: String) -> Option<String> {
    is_well_formed(&token).then_some(token)
}

/// `NSIT_TOKEN`, trimmed. Blank counts as unset. A value that could not be a
/// token is refused, and the error does not repeat it.
fn env_token() -> Result<Option<String>, NsitError> {
    let bad = || {
        NsitError::Usage(format!(
            "{TOKEN_ENV} is not a valid token: it must be one line of printable \
             ASCII without spaces"
        ))
    };
    match std::env::var(TOKEN_ENV) {
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(bad()),
        Ok(raw) => match raw.trim() {
            "" => Ok(None),
            token if is_well_formed(token) => Ok(Some(token.to_string())),
            _ => Err(bad()),
        },
    }
}

/// The config entry for the host with this canonical key. The config may spell
/// the host any way (`https://Git.Iam.Bot/`), so entries are matched by key.
pub(crate) fn host_entry<'c>(config: &'c Config, key: &str) -> Option<&'c HostConfig> {
    config
        .hosts
        .iter()
        .find(|(host, _)| host_key_for(host).is_ok_and(|k| k == key))
        .map(|(_, entry)| entry)
}

/// The signed-in user for the host with this canonical key (`host_key_for`), according to the
/// config file; `None` when it has no entry (or one without a user).
pub(crate) fn configured_user(key: &str) -> Result<Option<String>, NsitError> {
    let config = Config::load()?;
    Ok(host_entry(&config, key)
        .map(|entry| entry.user.clone())
        .filter(|user| !user.is_empty()))
}

/// Find the token for `host`: `NSIT_TOKEN`, else the credential store (or the
/// token file when there is no store).
///
/// `user` is the account the token was stored under. When `None`, the user
/// recorded for this host in the config file is used. Nothing found gives
/// `Auth("not signed in to <host>; run nsit auth login")`.
pub fn token_for(host: &str, user: Option<&str>) -> Result<(String, TokenSource), NsitError> {
    token_for_with(keychain(), host, user)
}

/// Save a token for `host` and `user` in the credential store, or in the token
/// file when the machine has no credential store. Says which.
pub fn store_token(host: &str, user: &str, token: &str) -> Result<TokenSource, NsitError> {
    store_token_with(keychain(), host, user, token)
}

/// Forget the stored token for `host` and `user`, wherever it is. Not an error
/// when there was none. (`NSIT_TOKEN` is not stored, so it is not touched.)
pub fn delete_token(host: &str, user: &str) -> Result<(), NsitError> {
    delete_token_with(keychain(), host, user)
}

fn token_for_with(
    kc: &dyn Keychain,
    host: &str,
    user: Option<&str>,
) -> Result<(String, TokenSource), NsitError> {
    let key = host_key_for(host)?;
    if let Some(token) = env_token()? {
        return Ok((token, TokenSource::Env));
    }
    let user = match user.filter(|u| !u.is_empty()) {
        Some(user) => user.to_string(),
        None => configured_user(&key)?.ok_or_else(|| not_signed_in(&key))?,
    };
    match kc.get(&service_name(&key), &user) {
        Ok(found) => found
            .and_then(usable)
            .map(|token| (token, TokenSource::Keychain))
            .ok_or_else(|| not_signed_in(&key)),
        Err(KeychainError::NoBackend) => TokenFile::load(&config_dir()?)?
            .get(&key, &user)
            .map(|token| (token.to_string(), TokenSource::File))
            .ok_or_else(|| not_signed_in(&key)),
        Err(KeychainError::Failed(why)) => Err(NsitError::Other(format!(
            "cannot read the token from the OS credential store: {why}"
        ))),
    }
}

fn store_token_with(
    kc: &dyn Keychain,
    host: &str,
    user: &str,
    token: &str,
) -> Result<TokenSource, NsitError> {
    let key = host_key_for(host)?;
    if user.is_empty() {
        return Err(NsitError::Usage(
            "cannot store a token without a user name".into(),
        ));
    }
    if !is_well_formed(token) {
        return Err(NsitError::Usage(
            "the token is empty or contains spaces or control characters".into(),
        ));
    }
    match kc.set(&service_name(&key), user, token) {
        Ok(()) => {
            // A plaintext copy left from a headless session must not outlive
            // the safe one. Best effort: the token is already stored safely.
            let _ = remove_from_file(&key, user);
            Ok(TokenSource::Keychain)
        }
        Err(KeychainError::NoBackend) => {
            let dir = config_dir()?;
            let mut file = TokenFile::load(&dir)?;
            file.set(&key, user, token);
            file.save(&dir)?;
            Ok(TokenSource::File)
        }
        Err(KeychainError::Failed(why)) => Err(NsitError::Other(format!(
            "cannot save the token in the OS credential store: {why}"
        ))),
    }
}

fn delete_token_with(kc: &dyn Keychain, host: &str, user: &str) -> Result<(), NsitError> {
    let key = host_key_for(host)?;
    // Clean the file first so a failing credential store cannot leave a
    // plaintext copy behind; report the store's failure afterwards.
    let from_file = remove_from_file(&key, user);
    match kc.delete(&service_name(&key), user) {
        Ok(()) | Err(KeychainError::NoBackend) => from_file,
        Err(KeychainError::Failed(why)) => Err(NsitError::Other(format!(
            "cannot remove the token from the OS credential store: {why}"
        ))),
    }
}

/// Remove one entry from the token file (and the file itself once empty).
/// Not an error when there is no file or no such entry.
fn remove_from_file(key: &str, user: &str) -> Result<(), NsitError> {
    let dir = config_dir()?;
    let mut file = TokenFile::load(&dir)?;
    if file.remove(key, user) {
        file.save(&dir)?;
    }
    Ok(())
}

// ---- the OS credential store -------------------------------------------------

/// Why the OS credential store could not answer.
#[derive(Debug)]
enum KeychainError {
    /// This machine has no credential store (for instance a headless Linux
    /// box with no Secret Service). The only case that uses the token file.
    NoBackend,
    /// A store exists but failed or refused: locked, access denied, a broken
    /// D-Bus connection... Always reported, never papered over.
    Failed(String),
}

/// The three operations nsit needs from a credential store. `OsKeychain` is
/// the real one; tests use a fake.
trait Keychain {
    /// `Ok(None)` when the store works but has no such entry.
    fn get(&self, service: &str, user: &str) -> Result<Option<String>, KeychainError>;
    fn set(&self, service: &str, user: &str, token: &str) -> Result<(), KeychainError>;
    /// Not an error when there is no such entry.
    fn delete(&self, service: &str, user: &str) -> Result<(), KeychainError>;
}

/// `NSIT_NO_KEYCHAIN` is on for any value except blank, `0` and `false`.
fn keychain_disabled() -> bool {
    std::env::var(NO_KEYCHAIN_ENV).is_ok_and(|value| {
        let value = value.trim();
        !(value.is_empty() || value == "0" || value.eq_ignore_ascii_case("false"))
    })
}

fn keychain() -> &'static dyn Keychain {
    if keychain_disabled() {
        &NoKeychain
    } else {
        &OsKeychain
    }
}

/// Stands in for a machine without a credential store: `NSIT_NO_KEYCHAIN=1`.
struct NoKeychain;

impl Keychain for NoKeychain {
    fn get(&self, _service: &str, _user: &str) -> Result<Option<String>, KeychainError> {
        Err(KeychainError::NoBackend)
    }
    fn set(&self, _service: &str, _user: &str, _token: &str) -> Result<(), KeychainError> {
        Err(KeychainError::NoBackend)
    }
    fn delete(&self, _service: &str, _user: &str) -> Result<(), KeychainError> {
        Err(KeychainError::NoBackend)
    }
}

/// The platform credential store through the `keyring` crate.
struct OsKeychain;

impl OsKeychain {
    fn entry(service: &str, user: &str) -> Result<keyring::Entry, KeychainError> {
        if cfg!(test) {
            panic!("tests must never touch the real OS credential store; set {NO_KEYCHAIN_ENV}=1");
        }
        keyring::Entry::new(service, user).map_err(classify)
    }
}

impl Keychain for OsKeychain {
    fn get(&self, service: &str, user: &str) -> Result<Option<String>, KeychainError> {
        match Self::entry(service, user)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(classify(err)),
        }
    }

    fn set(&self, service: &str, user: &str, token: &str) -> Result<(), KeychainError> {
        Self::entry(service, user)?
            .set_password(token)
            .map_err(classify)
    }

    fn delete(&self, service: &str, user: &str) -> Result<(), KeychainError> {
        match Self::entry(service, user)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(classify(err)),
        }
    }
}

/// Sort a keyring error into "no credential store here" and "it failed".
///
/// `NoDefaultStore` is what `keyring::Entry::new` returns when the platform
/// store could not be set up at all: on Linux, no D-Bus session or no Secret
/// Service provider. Everything else, `NoStorageAccess` (locked, denied)
/// included, is a real failure.
fn classify(err: keyring::Error) -> KeychainError {
    match err {
        keyring::Error::NoDefaultStore => KeychainError::NoBackend,
        other => KeychainError::Failed(one_line(&other.to_string(), 300)),
    }
}

// ---- the token file ------------------------------------------------------------

/// Contents of `tokens.toml`: tokens by canonical host key, then by user.
///
/// ```toml
/// [hosts."git.iam.bot"]
/// ada = "ins_..."
/// ```
#[derive(Default, Serialize, Deserialize)]
struct TokenFile {
    #[serde(default)]
    hosts: BTreeMap<String, BTreeMap<String, String>>,
}

// Not derived: a derived `Debug` would print the tokens.
impl fmt::Debug for TokenFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let accounts: BTreeMap<&String, Vec<&String>> = self
            .hosts
            .iter()
            .map(|(host, users)| (host, users.keys().collect()))
            .collect();
        f.debug_struct("TokenFile")
            .field("accounts", &accounts)
            .finish()
    }
}

impl TokenFile {
    fn get(&self, key: &str, user: &str) -> Option<&str> {
        self.hosts
            .get(key)?
            .get(user)
            .map(String::as_str)
            .filter(|token| is_well_formed(token))
    }

    fn set(&mut self, key: &str, user: &str, token: &str) {
        self.hosts
            .entry(key.to_string())
            .or_default()
            .insert(user.to_string(), token.to_string());
    }

    /// Returns whether there was an entry. Hosts left with no users are dropped.
    fn remove(&mut self, key: &str, user: &str) -> bool {
        let Some(users) = self.hosts.get_mut(key) else {
            return false;
        };
        let removed = users.remove(user).is_some();
        if users.is_empty() {
            self.hosts.remove(key);
        }
        removed
    }

    /// Read `tokens.toml` from `dir`. A missing file is an empty one.
    ///
    /// Errors never include the file's content: parse messages can quote it.
    fn load(dir: &Path) -> Result<TokenFile, NsitError> {
        check_dir(dir)?;
        let path = dir.join(TOKEN_FILE);
        let Some(text) = read_private(&path)? else {
            return Ok(TokenFile::default());
        };
        toml::from_str(&text).map_err(|_| {
            NsitError::Other(format!(
                "{} is not a valid token file; delete it and run nsit auth login",
                path.display()
            ))
        })
    }

    /// Write `tokens.toml` into `dir` (owner-only), or remove it when there is
    /// nothing left to keep.
    fn save(&self, dir: &Path) -> Result<(), NsitError> {
        check_dir(dir)?;
        let path = dir.join(TOKEN_FILE);
        if self.hosts.is_empty() {
            return match std::fs::remove_file(&path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(NsitError::Other(format!(
                    "cannot remove {}: {e}",
                    path.display()
                ))),
            };
        }
        let text = toml::to_string(self)
            .map_err(|_| NsitError::Other("cannot encode the token file".into()))?;
        write_private_file(dir, TOKEN_FILE, text.as_bytes())
            .map_err(|e| NsitError::Other(format!("cannot write {}: {e}", path.display())))
    }
}

#[cfg(unix)]
fn refuse_dir(dir: &Path, why: &str) -> NsitError {
    NsitError::Other(format!("will not keep tokens in {}: {why}", dir.display()))
}

/// Unix: the config directory must not be a symlink and must belong to the
/// current user, or tokens could be read from or sent to someone else's
/// directory. A directory that does not exist yet is fine; nsit creates it
/// owner-only.
#[cfg(unix)]
fn check_dir(dir: &Path) -> Result<(), NsitError> {
    use std::os::unix::fs::MetadataExt;
    let meta = match std::fs::symlink_metadata(dir) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(refuse_dir(dir, &e.to_string())),
    };
    if meta.file_type().is_symlink() {
        return Err(refuse_dir(dir, "it is a symbolic link"));
    }
    if !meta.is_dir() {
        return Err(refuse_dir(dir, "it is not a directory"));
    }
    if meta.uid() != current_uid() {
        return Err(refuse_dir(dir, "it belongs to another user"));
    }
    Ok(())
}

/// Windows: the config directory is under the user's `%APPDATA%`, which is
/// owner-only by default, so there is nothing to check.
#[cfg(not(unix))]
fn check_dir(_dir: &Path) -> Result<(), NsitError> {
    Ok(())
}

#[cfg(unix)]
fn current_uid() -> u32 {
    // SAFETY: `geteuid` has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

/// Unix: open without following a symlink, and insist the file is a regular
/// file of the current user that nobody else can read.
#[cfg(unix)]
fn read_private(path: &Path) -> Result<Option<String>, NsitError> {
    use std::fs::OpenOptions;
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let cannot_read =
        |why: &str| NsitError::Other(format!("cannot read {}: {why}", path.display()));
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) => {
            return Err(cannot_read("it is a symbolic link"));
        }
        Err(e) => return Err(cannot_read(&e.to_string())),
    };
    let meta = file.metadata().map_err(|e| cannot_read(&e.to_string()))?;
    if !meta.is_file() {
        return Err(cannot_read("it is not a regular file"));
    }
    if meta.uid() != current_uid() {
        return Err(cannot_read("it belongs to another user"));
    }
    if meta.mode() & 0o077 != 0 {
        return Err(NsitError::Other(format!(
            "{} can be read by other users; run chmod 600 on it, or delete it and sign in again",
            path.display()
        )));
    }
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|e| cannot_read(&e.to_string()))?;
    Ok(Some(text))
}

#[cfg(not(unix))]
fn read_private(path: &Path) -> Result<Option<String>, NsitError> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(NsitError::Other(format!(
            "cannot read {}: {e}",
            path.display()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, HostConfig};
    use crate::test_env::EnvGuard;
    use std::cell::{Cell, RefCell};

    const TOKEN: &str = "ins_AbCdEf-123_xyz";
    const HOST: &str = "git.iam.bot";

    /// File store only, in a throwaway config dir; nothing from the real
    /// environment can leak in, and the OS credential store is never used.
    fn env(dir: &Path) -> EnvGuard {
        EnvGuard::lock()
            .set("NSIT_CONFIG_DIR", dir)
            .set(NO_KEYCHAIN_ENV, "1")
            .unset(TOKEN_ENV)
            .unset("NSIT_HOST")
    }

    fn token_file_path(dir: &Path) -> std::path::PathBuf {
        dir.join(TOKEN_FILE)
    }

    // ---- host keys -------------------------------------------------------

    fn key(host: &str) -> String {
        host_key_for(host).unwrap_or_else(|e| panic!("{host}: {e}"))
    }

    #[test]
    fn every_spelling_of_a_host_has_one_key_and_one_service_name() {
        for host in [
            "git.iam.bot",
            "GIT.IAM.BOT",
            "https://git.iam.bot",
            "https://git.iam.bot/",
            "https://Git.Iam.Bot:443/",
            "  git.iam.bot  ",
        ] {
            assert_eq!(key(host), "git.iam.bot", "{host:?}");
            assert_eq!(service_name(&key(host)), "insitio:git.iam.bot", "{host:?}");
        }
    }

    #[test]
    fn host_key_keeps_the_port_and_drops_scheme_and_path() {
        assert_eq!(key("https://example.com:8443"), "example.com:8443");
        assert_eq!(key("https://example.com/insitio/sub"), "example.com");
        assert_eq!(key("http://127.0.0.1:3000"), "127.0.0.1:3000");
        assert_eq!(key("http://localhost:8080/"), "localhost:8080");
        assert_eq!(key("http://[::1]:3000"), "[::1]:3000");
        assert_eq!(key("http://[::1]"), "[::1]");
    }

    #[test]
    fn host_key_of_a_url_is_lowercase_host_and_optional_port() {
        let url = Url::parse("https://Example.COM:8443/a/b?c=d#e").unwrap();
        assert_eq!(host_key(&url), "example.com:8443");
    }

    #[test]
    fn hosts_nsit_would_not_talk_to_have_no_key() {
        for host in [
            "http://example.com",
            "ftp://example.com",
            "",
            "https://ada:hunter2@example.com",
        ] {
            let err = host_key_for(host).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{host:?}: {err:?}");
            assert!(!err.to_string().contains("hunter2"), "{err}");
        }
    }

    // ---- token resolution order and the file store -----------------------

    #[test]
    fn nsit_token_wins_over_a_stored_token() {
        let dir = tempfile::tempdir().unwrap();
        let env = env(dir.path());
        assert_eq!(store_token(HOST, "ada", TOKEN).unwrap(), TokenSource::File);
        assert_eq!(
            token_for(HOST, Some("ada")).unwrap(),
            (TOKEN.to_string(), TokenSource::File)
        );

        let _env = env.set(TOKEN_ENV, "ins_from_the_environment");
        assert_eq!(
            token_for(HOST, Some("ada")).unwrap(),
            ("ins_from_the_environment".to_string(), TokenSource::Env)
        );
        // It applies to any host and needs no user or stored token at all.
        assert_eq!(
            token_for("other.example", None).unwrap(),
            ("ins_from_the_environment".to_string(), TokenSource::Env)
        );
    }

    #[test]
    fn nsit_token_is_trimmed_and_blank_means_unset() {
        let dir = tempfile::tempdir().unwrap();
        let env = env(dir.path()).set(TOKEN_ENV, "  ins_padded\n");
        assert_eq!(token_for(HOST, None).unwrap().0, "ins_padded");
        let _env = env.set(TOKEN_ENV, "   ");
        let err = token_for(HOST, Some("ada")).unwrap_err();
        assert!(matches!(err, NsitError::Auth(_)), "{err:?}");
    }

    #[test]
    fn malformed_nsit_token_is_a_usage_error_that_does_not_echo_it() {
        let dir = tempfile::tempdir().unwrap();
        for bad in [
            "ins_two words",
            "ins_new\nline",
            "ins_tab\tbed",
            "ins_caf\u{e9}",
        ] {
            let _env = env(dir.path()).set(TOKEN_ENV, bad);
            let err = token_for(HOST, Some("ada")).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{bad:?}: {err:?}");
            assert_eq!(err.exit_code(), 2);
            assert!(err.to_string().contains(TOKEN_ENV), "{err}");
            assert!(!err.to_string().contains("ins_"), "{err}");
        }
    }

    #[test]
    fn file_store_writes_one_private_token_file_in_the_config_dir() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        assert_eq!(store_token(HOST, "ada", TOKEN).unwrap(), TokenSource::File);
        let path = token_file_path(dir.path());
        assert!(path.is_file(), "no token file at {}", path.display());
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains(TOKEN) && text.contains("ada"), "{text}");
        // Only the token file is left behind: no temporary files.
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![TOKEN_FILE.to_string()]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "token file must be owner-only");
        }
    }

    #[test]
    fn token_file_lives_under_a_dir_nsit_creates_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("fresh").join("insitio");
        let _env = env(&nested);
        store_token(HOST, "ada", TOKEN).unwrap();
        assert!(token_file_path(&nested).is_file());
        assert_eq!(token_for(HOST, Some("ada")).unwrap().0, TOKEN);
    }

    #[test]
    fn nothing_stored_is_not_signed_in() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        for host in [HOST, "https://git.iam.bot/", "http://127.0.0.1:3000"] {
            let err = token_for(host, Some("ada")).unwrap_err();
            assert!(matches!(err, NsitError::Auth(_)), "{host}: {err:?}");
            assert_eq!(err.exit_code(), 3);
            assert_eq!(
                err.to_string(),
                format!("not signed in to {}; run nsit auth login", key(host))
            );
        }
        // No user known and none configured: same answer, no stored file needed.
        let err = token_for(HOST, None).unwrap_err();
        assert!(matches!(err, NsitError::Auth(_)), "{err:?}");
        assert!(!token_file_path(dir.path()).exists());
    }

    #[test]
    fn a_config_entry_is_found_by_the_hosts_canonical_key_however_it_is_spelled() {
        let entry = |user: &str| HostConfig {
            user: user.into(),
            name: None,
            email: None,
        };
        let mut config = Config::default();
        config
            .hosts
            .insert("https://GIT.iam.bot/".into(), entry("ada"));
        config
            .hosts
            .insert("http://127.0.0.1:3000".into(), entry("grace"));
        assert_eq!(host_entry(&config, "git.iam.bot").unwrap().user, "ada");
        assert_eq!(host_entry(&config, "127.0.0.1:3000").unwrap().user, "grace");
        assert!(host_entry(&config, "other.example").is_none());
        assert!(host_entry(&Config::default(), "git.iam.bot").is_none());
    }

    #[test]
    fn spellings_of_one_host_share_a_token() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        store_token("https://git.iam.bot/", "ada", TOKEN).unwrap();
        for host in ["git.iam.bot", "GIT.iam.bot", "https://git.iam.bot"] {
            assert_eq!(token_for(host, Some("ada")).unwrap().0, TOKEN, "{host}");
        }
        let text = std::fs::read_to_string(token_file_path(dir.path())).unwrap();
        assert_eq!(text.matches(TOKEN).count(), 1, "{text}");
    }

    #[test]
    fn hosts_and_users_keep_separate_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        store_token(HOST, "ada", "ins_ada_main").unwrap();
        store_token(HOST, "grace", "ins_grace_main").unwrap();
        store_token("http://127.0.0.1:3000", "ada", "ins_ada_local").unwrap();
        assert_eq!(token_for(HOST, Some("ada")).unwrap().0, "ins_ada_main");
        assert_eq!(token_for(HOST, Some("grace")).unwrap().0, "ins_grace_main");
        assert_eq!(
            token_for("http://127.0.0.1:3000", Some("ada")).unwrap().0,
            "ins_ada_local"
        );
        assert!(token_for("http://127.0.0.1:3001", Some("ada")).is_err());
        assert!(token_for(HOST, Some("nobody")).is_err());
    }

    #[test]
    fn storing_again_replaces_the_token() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        store_token(HOST, "ada", "ins_old").unwrap();
        store_token(HOST, "ada", "ins_new").unwrap();
        assert_eq!(token_for(HOST, Some("ada")).unwrap().0, "ins_new");
        let text = std::fs::read_to_string(token_file_path(dir.path())).unwrap();
        assert!(!text.contains("ins_old"), "{text}");
    }

    #[test]
    fn without_a_user_the_signed_in_user_comes_from_the_config() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        store_token(HOST, "ada", TOKEN).unwrap();
        // Config knows nobody yet.
        assert!(matches!(
            token_for(HOST, None).unwrap_err(),
            NsitError::Auth(_)
        ));

        let mut cfg = Config::default();
        cfg.hosts.insert(
            // The config key need not be spelled like the host asked for.
            "https://GIT.iam.bot/".to_string(),
            HostConfig {
                user: "ada".into(),
                name: None,
                email: None,
            },
        );
        cfg.save().unwrap();
        assert_eq!(
            token_for("git.iam.bot", None).unwrap(),
            (TOKEN.to_string(), TokenSource::File)
        );
        // An explicit user beats the config.
        assert!(token_for("git.iam.bot", Some("grace")).is_err());
    }

    #[test]
    fn delete_removes_only_that_entry_and_the_file_once_empty() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        store_token(HOST, "ada", "ins_a").unwrap();
        store_token(HOST, "grace", "ins_g").unwrap();
        store_token("http://127.0.0.1:3000", "ada", "ins_l").unwrap();

        delete_token("https://git.iam.bot", "ada").unwrap();
        assert!(token_for(HOST, Some("ada")).is_err());
        assert_eq!(token_for(HOST, Some("grace")).unwrap().0, "ins_g");
        assert_eq!(
            token_for("http://127.0.0.1:3000", Some("ada")).unwrap().0,
            "ins_l"
        );

        delete_token(HOST, "grace").unwrap();
        delete_token("http://127.0.0.1:3000", "ada").unwrap();
        assert!(
            !token_file_path(dir.path()).exists(),
            "an empty token file should be removed"
        );
    }

    #[test]
    fn delete_is_not_an_error_when_nothing_is_stored() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        delete_token(HOST, "ada").unwrap();
        store_token(HOST, "grace", "ins_g").unwrap();
        delete_token(HOST, "ada").unwrap();
        assert_eq!(token_for(HOST, Some("grace")).unwrap().0, "ins_g");
    }

    #[test]
    fn ill_formed_tokens_and_users_are_refused_and_nothing_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        for bad in ["", "   ", "ins_two words", "ins_new\nline", "ins_caf\u{e9}"] {
            let err = store_token(HOST, "ada", bad).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{bad:?}: {err:?}");
            assert!(!err.to_string().contains("ins_"), "{err}");
        }
        let err = store_token(HOST, "", TOKEN).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert!(!token_file_path(dir.path()).exists());
    }

    #[test]
    fn corrupt_token_file_is_an_error_that_does_not_echo_its_content() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        std::fs::write(
            token_file_path(dir.path()),
            "hosts = \"ins_secret_token_text\"",
        )
        .unwrap();
        // On Unix a file others can read is refused before it is parsed; make
        // it private so this test reaches the parse error it is about.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                token_file_path(dir.path()),
                std::fs::Permissions::from_mode(0o600),
            )
            .unwrap();
        }
        for result in [
            token_for(HOST, Some("ada")).map(|_| ()),
            store_token(HOST, "ada", TOKEN).map(|_| ()),
            delete_token(HOST, "ada"),
        ] {
            let err = result.unwrap_err();
            assert!(matches!(err, NsitError::Other(_)), "{err:?}");
            assert!(err.to_string().contains(TOKEN_FILE), "{err}");
            assert!(!err.to_string().contains("ins_secret"), "{err}");
            assert!(!err.to_string().contains('\n'), "{err:?}");
        }
        // And the corrupt file was left alone, not overwritten.
        assert!(std::fs::read_to_string(token_file_path(dir.path()))
            .unwrap()
            .contains("ins_secret_token_text"));
    }

    #[test]
    fn token_file_debug_never_shows_tokens() {
        let mut file = TokenFile::default();
        file.hosts
            .entry(HOST.to_string())
            .or_default()
            .insert("ada".into(), TOKEN.into());
        let shown = format!("{file:?} {file:#?}");
        assert!(!shown.contains(TOKEN), "{shown}");
    }

    #[test]
    fn token_sources_have_stable_names_for_json_and_words_for_people() {
        let all = [
            (TokenSource::Env, "Env", "NSIT_TOKEN"),
            (TokenSource::Keychain, "Keychain", "credential store"),
            (TokenSource::File, "File", "token file"),
        ];
        for (source, name, words) in all {
            assert_eq!(source.as_str(), name);
            assert!(source.describe().contains(words), "{}", source.describe());
        }
    }

    #[test]
    fn no_keychain_hook_accepts_1_and_rejects_blank_0_false() {
        let mut env = EnvGuard::lock().unset(NO_KEYCHAIN_ENV);
        assert!(!keychain_disabled(), "unset means the OS store is allowed");
        for (value, disabled) in [
            ("1", true),
            ("yes", true),
            ("", false),
            ("  ", false),
            ("0", false),
            ("false", false),
        ] {
            env = env.set(NO_KEYCHAIN_ENV, value);
            assert_eq!(keychain_disabled(), disabled, "{value:?}");
        }
    }

    // ---- the OS credential store, through a fake -------------------------

    #[derive(Clone, Copy, PartialEq)]
    enum Mode {
        Working,
        NoBackend,
        Locked,
    }

    struct FakeKeychain {
        mode: Cell<Mode>,
        items: RefCell<BTreeMap<(String, String), String>>,
    }

    impl FakeKeychain {
        fn new(mode: Mode) -> FakeKeychain {
            FakeKeychain {
                mode: Cell::new(mode),
                items: RefCell::new(BTreeMap::new()),
            }
        }

        fn has(&self, service: &str, user: &str) -> bool {
            self.items
                .borrow()
                .contains_key(&(service.to_string(), user.to_string()))
        }

        fn check(&self) -> Result<(), KeychainError> {
            match self.mode.get() {
                Mode::Working => Ok(()),
                Mode::NoBackend => Err(KeychainError::NoBackend),
                Mode::Locked => Err(KeychainError::Failed("the keychain is locked".into())),
            }
        }
    }

    impl Keychain for FakeKeychain {
        fn get(&self, service: &str, user: &str) -> Result<Option<String>, KeychainError> {
            self.check()?;
            Ok(self
                .items
                .borrow()
                .get(&(service.to_string(), user.to_string()))
                .cloned())
        }

        fn set(&self, service: &str, user: &str, token: &str) -> Result<(), KeychainError> {
            self.check()?;
            self.items
                .borrow_mut()
                .insert((service.to_string(), user.to_string()), token.to_string());
            Ok(())
        }

        fn delete(&self, service: &str, user: &str) -> Result<(), KeychainError> {
            self.check()?;
            self.items
                .borrow_mut()
                .remove(&(service.to_string(), user.to_string()));
            Ok(())
        }
    }

    #[test]
    fn keychain_entry_is_service_insitio_host_and_account_user() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        let kc = FakeKeychain::new(Mode::Working);
        assert_eq!(
            store_token_with(&kc, "https://git.iam.bot/", "ada", TOKEN).unwrap(),
            TokenSource::Keychain
        );
        assert!(kc.has("insitio:git.iam.bot", "ada"));
        assert_eq!(
            token_for_with(&kc, HOST, Some("ada")).unwrap(),
            (TOKEN.to_string(), TokenSource::Keychain)
        );
        // The file store was never touched.
        assert!(!token_file_path(dir.path()).exists());
    }

    #[test]
    fn nsit_token_beats_the_keychain() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path()).set(TOKEN_ENV, "ins_env");
        let kc = FakeKeychain::new(Mode::Working);
        store_token_with(&kc, HOST, "ada", TOKEN).unwrap();
        assert_eq!(
            token_for_with(&kc, HOST, Some("ada")).unwrap(),
            ("ins_env".to_string(), TokenSource::Env)
        );
    }

    #[test]
    fn a_working_keychain_without_an_entry_means_not_signed_in_not_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        // A token left in the file (say, from a headless session)...
        store_token_with(&FakeKeychain::new(Mode::NoBackend), HOST, "ada", TOKEN).unwrap();
        // ...is only for machines with no credential store.
        let err = token_for_with(&FakeKeychain::new(Mode::Working), HOST, Some("ada")).unwrap_err();
        assert!(matches!(err, NsitError::Auth(_)), "{err:?}");
    }

    #[test]
    fn no_credential_store_falls_back_to_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        let kc = FakeKeychain::new(Mode::NoBackend);
        assert_eq!(
            store_token_with(&kc, HOST, "ada", TOKEN).unwrap(),
            TokenSource::File
        );
        assert_eq!(
            token_for_with(&kc, HOST, Some("ada")).unwrap(),
            (TOKEN.to_string(), TokenSource::File)
        );
    }

    #[test]
    fn a_locked_keychain_is_an_error_never_a_silent_plaintext_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        let locked = FakeKeychain::new(Mode::Locked);

        let err = store_token_with(&locked, HOST, "ada", TOKEN).unwrap_err();
        assert!(matches!(err, NsitError::Other(_)), "{err:?}");
        assert_eq!(err.exit_code(), 1);
        assert!(err.to_string().contains("locked"), "{err}");
        assert!(!err.to_string().contains(TOKEN), "{err}");
        assert!(
            !token_file_path(dir.path()).exists(),
            "the token must not be written to a file when the keychain merely failed"
        );

        // Even with a file token present, a failing keychain is reported.
        store_token_with(&FakeKeychain::new(Mode::NoBackend), HOST, "ada", TOKEN).unwrap();
        let err = token_for_with(&locked, HOST, Some("ada")).unwrap_err();
        assert!(matches!(err, NsitError::Other(_)), "{err:?}");
        assert!(err.to_string().contains("locked"), "{err}");
    }

    #[test]
    fn saving_to_the_keychain_forgets_a_stale_file_token() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        store_token_with(
            &FakeKeychain::new(Mode::NoBackend),
            HOST,
            "ada",
            "ins_stale",
        )
        .unwrap();
        store_token_with(
            &FakeKeychain::new(Mode::NoBackend),
            HOST,
            "grace",
            "ins_keep",
        )
        .unwrap();

        let kc = FakeKeychain::new(Mode::Working);
        store_token_with(&kc, HOST, "ada", TOKEN).unwrap();
        let text = std::fs::read_to_string(token_file_path(dir.path())).unwrap();
        assert!(!text.contains("ins_stale"), "{text}");
        assert!(text.contains("ins_keep"), "{text}");
    }

    #[test]
    fn delete_clears_the_keychain_and_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        let kc = FakeKeychain::new(Mode::Working);
        store_token_with(&kc, HOST, "ada", TOKEN).unwrap();
        store_token_with(&FakeKeychain::new(Mode::NoBackend), HOST, "ada", "ins_file").unwrap();
        delete_token_with(&kc, HOST, "ada").unwrap();
        assert!(!kc.has("insitio:git.iam.bot", "ada"));
        assert!(!token_file_path(dir.path()).exists());
        // Nothing left: still fine.
        delete_token_with(&kc, HOST, "ada").unwrap();
    }

    #[test]
    fn delete_reports_a_locked_keychain_but_still_cleans_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let _env = env(dir.path());
        store_token_with(&FakeKeychain::new(Mode::NoBackend), HOST, "ada", TOKEN).unwrap();
        let err = delete_token_with(&FakeKeychain::new(Mode::Locked), HOST, "ada").unwrap_err();
        assert!(matches!(err, NsitError::Other(_)), "{err:?}");
        assert!(err.to_string().contains("locked"), "{err}");
        assert!(!token_file_path(dir.path()).exists());
    }

    #[test]
    fn keyring_errors_split_into_no_backend_and_real_failures() {
        assert!(matches!(
            classify(keyring::Error::NoDefaultStore),
            KeychainError::NoBackend
        ));
        let boxed = || -> Box<dyn std::error::Error + Send + Sync> {
            Box::new(std::io::Error::other("the collection is\nlocked"))
        };
        for err in [
            keyring::Error::NoStorageAccess(boxed()),
            keyring::Error::PlatformFailure(boxed()),
            keyring::Error::Invalid("service".into(), "empty".into()),
        ] {
            match classify(err) {
                KeychainError::Failed(why) => {
                    assert!(!why.is_empty());
                    assert!(!why.contains('\n'), "{why:?}");
                }
                KeychainError::NoBackend => panic!("a real failure was taken for 'no backend'"),
            }
        }
    }

    // ---- Unix file safety --------------------------------------------------

    #[cfg(unix)]
    mod unix {
        use super::*;
        use crate::error::NsitError;
        use std::os::unix::fs::{symlink, PermissionsExt};
        use std::path::Path;

        fn mode(p: &Path) -> u32 {
            std::fs::metadata(p).unwrap().permissions().mode() & 0o777
        }

        #[test]
        fn new_config_dir_is_owner_only() {
            let dir = tempfile::tempdir().unwrap();
            let nested = dir.path().join("a").join("insitio");
            let _env = env(&nested);
            store_token(HOST, "ada", TOKEN).unwrap();
            assert_eq!(mode(&nested), 0o700);
            assert_eq!(mode(&token_file_path(&nested)), 0o600);
        }

        #[test]
        fn a_symlink_at_the_token_file_is_refused_and_never_written_through() {
            let dir = tempfile::tempdir().unwrap();
            let victim = dir.path().join("victim");
            std::fs::write(&victim, "untouched").unwrap();
            let cfg = dir.path().join("cfg");
            std::fs::create_dir(&cfg).unwrap();
            symlink(&victim, token_file_path(&cfg)).unwrap();
            let _env = env(&cfg);
            let err = store_token(HOST, "ada", TOKEN).unwrap_err();
            assert!(matches!(err, NsitError::Other(_)), "{err:?}");
            assert!(err.to_string().contains("symbolic link"), "{err}");
            assert_eq!(std::fs::read_to_string(&victim).unwrap(), "untouched");
        }

        #[test]
        fn a_dangling_symlink_at_the_token_file_is_refused_too() {
            let dir = tempfile::tempdir().unwrap();
            let cfg = dir.path().join("cfg");
            std::fs::create_dir(&cfg).unwrap();
            let victim = dir.path().join("does-not-exist");
            symlink(&victim, token_file_path(&cfg)).unwrap();
            let _env = env(&cfg);
            let err = store_token(HOST, "ada", TOKEN).unwrap_err();
            assert!(err.to_string().contains("symbolic link"), "{err}");
            assert!(!victim.exists(), "wrote through a dangling symlink");
        }

        #[test]
        fn a_symlinked_token_file_is_not_read() {
            let dir = tempfile::tempdir().unwrap();
            let real = dir.path().join("real.toml");
            std::fs::write(&real, format!("[hosts.\"{HOST}\"]\nada = \"{TOKEN}\"\n")).unwrap();
            std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o600)).unwrap();
            let cfg = dir.path().join("cfg");
            std::fs::create_dir(&cfg).unwrap();
            symlink(&real, token_file_path(&cfg)).unwrap();
            let _env = env(&cfg);
            let err = token_for(HOST, Some("ada")).unwrap_err();
            assert!(matches!(err, NsitError::Other(_)), "{err:?}");
            assert!(err.to_string().contains("symbolic link"), "{err}");
        }

        #[test]
        fn a_token_file_readable_by_others_is_refused() {
            let dir = tempfile::tempdir().unwrap();
            let _env = env(dir.path());
            store_token(HOST, "ada", TOKEN).unwrap();
            let path = token_file_path(dir.path());
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            let err = token_for(HOST, Some("ada")).unwrap_err();
            assert!(matches!(err, NsitError::Other(_)), "{err:?}");
            assert!(err.to_string().contains("chmod 600"), "{err}");
            assert!(!err.to_string().contains(TOKEN), "{err}");
        }

        #[test]
        fn a_symlinked_config_dir_is_refused_for_reading_and_writing() {
            let dir = tempfile::tempdir().unwrap();
            let real = dir.path().join("real");
            std::fs::create_dir(&real).unwrap();
            let link = dir.path().join("link");
            symlink(&real, &link).unwrap();
            let _env = env(&link);
            for result in [
                store_token(HOST, "ada", TOKEN).map(|_| ()),
                token_for(HOST, Some("ada")).map(|_| ()),
                delete_token(HOST, "ada"),
            ] {
                let err = result.unwrap_err();
                assert!(matches!(err, NsitError::Other(_)), "{err:?}");
                assert!(err.to_string().contains("symbolic link"), "{err}");
            }
            assert!(!token_file_path(&real).exists());
        }
    }
}
