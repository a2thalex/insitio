//! nsit's own settings file, and how the target host is chosen.

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use url::{Host, Url};

use crate::error::NsitError;

pub const DEFAULT_HOST: &str = "git.iam.bot";
pub const CONFIG_FILE: &str = "nsit.toml";

/// Contents of `nsit.toml`. It never holds tokens.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub hosts: BTreeMap<String, HostConfig>,
}

/// What nsit remembers about the account signed in on one host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostConfig {
    pub user: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

impl Config {
    pub fn load() -> Result<Config, NsitError> {
        Config::load_from(&config_dir()?)
    }

    pub fn save(&self) -> Result<(), NsitError> {
        self.save_to(&config_dir()?)
    }

    /// Read `nsit.toml` from `dir`. A missing file is an empty config.
    pub fn load_from(dir: &Path) -> Result<Config, NsitError> {
        let path = dir.join(CONFIG_FILE);
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Config::default()),
            Err(e) => {
                return Err(NsitError::Other(format!(
                    "cannot read {}: {e}",
                    path.display()
                )));
            }
        };
        toml::from_str(&text).map_err(|e| {
            NsitError::Other(format!("{} is not valid: {}", path.display(), e.message()))
        })
    }

    /// Write `nsit.toml` into `dir`, creating `dir` if needed (owner-only on
    /// Unix).
    ///
    /// The content goes to a uniquely named temporary file in `dir`, created
    /// with `create_new` so it can never be a pre-planted file or symlink,
    /// and is then renamed over the target. A crash cannot leave half a
    /// config behind, and a symlink at `nsit.toml` is replaced, not followed.
    pub fn save_to(&self, dir: &Path) -> Result<(), NsitError> {
        let path = dir.join(CONFIG_FILE);
        let cannot_write = |e: &dyn std::fmt::Display| {
            NsitError::Other(format!("cannot write {}: {e}", path.display()))
        };
        let text = toml::to_string(self).map_err(|e| cannot_write(&e))?;
        create_private_dir(dir).map_err(|e| cannot_write(&e))?;
        let (tmp, mut file) = create_temp_file(dir).map_err(|e| cannot_write(&e))?;
        let written = file
            .write_all(text.as_bytes())
            .and_then(|()| file.sync_all());
        drop(file); // close before renaming: Windows cannot rename an open file
        written
            .and_then(|()| std::fs::rename(&tmp, &path))
            .map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                cannot_write(&e)
            })
    }
}

/// Create `dir` and any missing parents. On Unix the new directories are
/// owner-only (0700), because the token file may live here.
fn create_private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

/// Create a file that must not exist yet. `create_new` fails on any existing
/// path, a symlink included, instead of following it. Owner-only on Unix.
fn create_new_private(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Create a uniquely named temporary file inside `dir`.
fn create_temp_file(dir: &Path) -> io::Result<(PathBuf, File)> {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    for _ in 0..16 {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let name = format!("{CONFIG_FILE}.{}.{nanos}.{n}.tmp", std::process::id());
        let path = dir.join(name);
        match create_new_private(&path) {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "no unused temporary file name",
    ))
}

/// The directory holding `nsit.toml` (and, when no credential store exists,
/// the token file): `NSIT_CONFIG_DIR` if set, else the per-user default.
///
/// There is deliberately no fallback to a temp or working directory: both can
/// be shared with other users or be a repository. With no home directory and
/// no `NSIT_CONFIG_DIR`, this is an error.
pub fn config_dir() -> Result<PathBuf, NsitError> {
    config_dir_from(
        std::env::var_os("NSIT_CONFIG_DIR").as_deref(),
        std::env::var_os("XDG_CONFIG_HOME").as_deref(),
        platform_config_dir(),
    )
}

/// The operating system's per-user config base: `%APPDATA%` on Windows and
/// `~/.config` elsewhere (macOS included: this is a command-line tool, not
/// an app bundle). `None` when the home directory cannot be determined.
fn platform_config_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        dirs::config_dir()
    } else {
        dirs::home_dir().map(|home| home.join(".config"))
    }
}

/// `config_dir` with the environment and the platform lookup passed in, so
/// it can be tested.
///
/// - `NSIT_CONFIG_DIR` wins and must be an absolute path; empty means unset.
/// - Off Windows, an absolute `XDG_CONFIG_HOME` is the next choice.
/// - Otherwise `<platform_config_dir>/insitio`.
pub fn config_dir_from(
    nsit_config_dir: Option<&OsStr>,
    xdg_config_home: Option<&OsStr>,
    platform_config_dir: Option<PathBuf>,
) -> Result<PathBuf, NsitError> {
    if let Some(dir) = nsit_config_dir.filter(|s| !s.is_empty()) {
        let dir = PathBuf::from(dir);
        if !dir.is_absolute() {
            return Err(NsitError::Usage(
                "NSIT_CONFIG_DIR must be an absolute path".into(),
            ));
        }
        return Ok(dir);
    }
    let xdg = xdg_config_home
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute());
    let base = if cfg!(windows) {
        platform_config_dir
    } else {
        xdg.or(platform_config_dir)
    };
    base.map(|base| base.join("insitio"))
        .ok_or_else(|| NsitError::Other("cannot find a home directory; set NSIT_CONFIG_DIR".into()))
}

/// Pick the host: `--host` flag, then `NSIT_HOST`, then the default.
pub fn resolve_host(flag: Option<&str>) -> String {
    resolve_host_from(flag, env_value("NSIT_HOST").as_deref())
}

/// `resolve_host` with the environment passed in, so it can be tested.
pub fn resolve_host_from(flag: Option<&str>, nsit_host: Option<&str>) -> String {
    [flag, nsit_host]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|s| !s.is_empty())
        .unwrap_or(DEFAULT_HOST)
        .to_string()
}

/// Turn a host (`git.iam.bot`, or a full URL) into the server's base URL.
/// HTTPS only; plain HTTP is allowed solely for loopback test servers.
pub fn base_url(host: &str) -> Result<Url, NsitError> {
    let host = host.trim();
    if host.is_empty() {
        return Err(NsitError::Usage("host is empty".into()));
    }
    let candidate = if host.contains("://") {
        host.to_string()
    } else {
        format!("https://{host}")
    };
    // Error text below never repeats the host: it may carry credentials.
    let mut url =
        Url::parse(&candidate).map_err(|e| NsitError::Usage(format!("invalid host: {e}")))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(NsitError::Usage(
            "the host must not contain a username or password; nsit keeps tokens out of URLs"
                .into(),
        ));
    }
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(&url) => {}
        "http" => {
            return Err(NsitError::Usage(format!(
                "refusing to talk to {} over plain http: use https \
                 (http is only allowed for localhost, 127.0.0.1 and [::1])",
                url.host_str().unwrap_or("that host")
            )));
        }
        other => {
            return Err(NsitError::Usage(format!(
                "unsupported scheme {other:?}: the host must be https"
            )));
        }
    }
    if url.host().is_none() {
        return Err(NsitError::Usage("invalid host: no host name".into()));
    }
    // Callers join "api/v1/..." onto this, which only works with a trailing slash.
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url)
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(name)) => name == "localhost",
        Some(Host::Ipv4(ip)) => ip == Ipv4Addr::LOCALHOST,
        Some(Host::Ipv6(ip)) => ip == Ipv6Addr::LOCALHOST,
        None => false,
    }
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env::EnvGuard;

    fn sample() -> Config {
        let mut hosts = BTreeMap::new();
        hosts.insert(
            "git.iam.bot".to_string(),
            HostConfig {
                user: "ada".into(),
                name: Some("Ada Lovelace".into()),
                email: Some("ada@example.com".into()),
            },
        );
        hosts.insert(
            "http://127.0.0.1:3000".to_string(),
            HostConfig {
                user: "grace".into(),
                name: None,
                email: None,
            },
        );
        Config { hosts }
    }

    #[test]
    fn config_round_trips_through_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = sample();
        cfg.save_to(dir.path()).unwrap();
        assert!(dir.path().join(CONFIG_FILE).is_file());
        assert_eq!(Config::load_from(dir.path()).unwrap(), cfg);
    }

    #[test]
    fn save_creates_missing_directories() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a").join("b");
        sample().save_to(&nested).unwrap();
        assert_eq!(Config::load_from(&nested).unwrap(), sample());
    }

    #[test]
    fn missing_file_loads_as_empty_config() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(Config::load_from(dir.path()).unwrap(), Config::default());
    }

    #[test]
    fn broken_file_is_a_readable_error_naming_the_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(CONFIG_FILE), "hosts = [not toml").unwrap();
        let err = Config::load_from(dir.path()).unwrap_err();
        assert!(matches!(err, NsitError::Other(_)), "{err:?}");
        assert!(err.to_string().contains(CONFIG_FILE), "{err}");
    }

    #[test]
    fn saved_file_has_no_token_fields_and_omits_empty_options() {
        let dir = tempfile::tempdir().unwrap();
        sample().save_to(dir.path()).unwrap();
        let text = std::fs::read_to_string(dir.path().join(CONFIG_FILE)).unwrap();
        assert!(text.contains("user = \"ada\""), "{text}");
        assert!(!text.to_lowercase().contains("token"), "{text}");
        // grace has no name or email, so those keys must not be written.
        assert_eq!(text.matches("name =").count(), 1, "{text}");
        assert_eq!(text.matches("email =").count(), 1, "{text}");
    }

    /// An absolute path on every platform (`/tmp/..` is relative on Windows).
    fn abs(name: &str) -> PathBuf {
        std::env::temp_dir().join(name)
    }

    fn os(s: &str) -> Option<&OsStr> {
        Some(OsStr::new(s))
    }

    #[test]
    fn config_dir_honors_the_override_exactly() {
        let want = abs("nsit-test");
        let got =
            config_dir_from(Some(want.as_os_str()), os("/xdg"), Some(abs("platform"))).unwrap();
        assert_eq!(got, want);
    }

    #[test]
    fn override_works_even_without_a_home_directory() {
        let want = abs("nsit-test");
        assert_eq!(
            config_dir_from(Some(want.as_os_str()), None, None).unwrap(),
            want
        );
    }

    #[test]
    fn relative_override_is_a_usage_error() {
        for bad in ["relative/dir", ".", "..", "nsit", "  "] {
            let err = config_dir_from(os(bad), None, Some(abs("platform"))).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{bad:?}: {err:?}");
            assert_eq!(err.to_string(), "NSIT_CONFIG_DIR must be an absolute path");
            assert_eq!(err.exit_code(), 2);
        }
    }

    #[test]
    fn empty_override_means_unset() {
        let platform = Some(abs("platform"));
        let with_empty = config_dir_from(os(""), None, platform.clone()).unwrap();
        let without = config_dir_from(None, None, platform).unwrap();
        assert_eq!(with_empty, without);
    }

    #[test]
    fn default_config_dir_is_insitio_under_the_platform_config_dir() {
        let platform = abs("platform-config");
        let got = config_dir_from(None, None, Some(platform.clone())).unwrap();
        assert_eq!(got, platform.join("insitio"));
    }

    #[test]
    fn no_home_and_no_override_is_an_error_not_a_shared_directory() {
        for xdg in [None, os(""), os("relative")] {
            let err = config_dir_from(None, xdg, None).unwrap_err();
            assert!(matches!(err, NsitError::Other(_)), "{err:?}");
            assert_eq!(
                err.to_string(),
                "cannot find a home directory; set NSIT_CONFIG_DIR"
            );
            assert_eq!(err.exit_code(), 1);
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn xdg_config_home_beats_the_platform_dir_off_windows() {
        let got = config_dir_from(None, os("/xdg"), Some(abs("platform"))).unwrap();
        assert_eq!(got, PathBuf::from("/xdg/insitio"));
        // ...and stands in for a missing home directory.
        assert_eq!(
            config_dir_from(None, os("/xdg"), None).unwrap(),
            PathBuf::from("/xdg/insitio")
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn relative_xdg_config_home_is_ignored() {
        let platform = abs("platform");
        let got = config_dir_from(None, os("relative/xdg"), Some(platform.clone())).unwrap();
        assert_eq!(got, platform.join("insitio"));
    }

    #[cfg(windows)]
    #[test]
    fn xdg_config_home_is_ignored_on_windows() {
        let platform = abs("platform");
        let got = config_dir_from(None, os("C:\\xdg"), Some(platform.clone())).unwrap();
        assert_eq!(got, platform.join("insitio"));
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_override_is_kept_not_silently_dropped() {
        use std::os::unix::ffi::OsStrExt;
        let raw = OsStr::from_bytes(b"/tmp/nsit-\xff");
        assert_eq!(
            config_dir_from(Some(raw), None, None).unwrap(),
            PathBuf::from(raw)
        );
    }

    #[cfg(windows)]
    #[test]
    fn non_unicode_override_is_kept_not_silently_dropped() {
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;
        // `C:\` followed by an unpaired surrogate, which is not valid UTF-16.
        let raw = OsString::from_wide(&[b'C' as u16, b':' as u16, b'\\' as u16, 0xD800]);
        assert_eq!(
            config_dir_from(Some(raw.as_os_str()), None, None).unwrap(),
            PathBuf::from(&raw)
        );
    }

    #[test]
    fn config_round_trips_through_nsit_config_dir() {
        let dir = tempfile::tempdir().unwrap();
        let _env = EnvGuard::lock().set("NSIT_CONFIG_DIR", dir.path());
        assert_eq!(config_dir().unwrap(), dir.path());
        sample().save().unwrap();
        assert!(dir.path().join(CONFIG_FILE).is_file());
        assert_eq!(Config::load().unwrap(), sample());
    }

    #[test]
    fn relative_nsit_config_dir_in_the_environment_fails_load_and_save() {
        let _env = EnvGuard::lock().set("NSIT_CONFIG_DIR", "relative");
        assert!(matches!(config_dir(), Err(NsitError::Usage(_))));
        assert!(matches!(Config::load(), Err(NsitError::Usage(_))));
        assert!(matches!(sample().save(), Err(NsitError::Usage(_))));
    }

    #[test]
    fn save_replaces_an_existing_config_and_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        Config::default().save_to(dir.path()).unwrap();
        sample().save_to(dir.path()).unwrap();
        assert_eq!(Config::load_from(dir.path()).unwrap(), sample());
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![CONFIG_FILE.to_string()]);
    }

    #[test]
    fn temp_files_get_unique_names_in_the_target_directory() {
        let dir = tempfile::tempdir().unwrap();
        let (a, _fa) = create_temp_file(dir.path()).unwrap();
        let (b, _fb) = create_temp_file(dir.path()).unwrap();
        assert_ne!(a, b);
        for p in [&a, &b] {
            assert_eq!(p.parent().unwrap(), dir.path());
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            assert!(
                name.starts_with("nsit.toml.") && name.ends_with(".tmp"),
                "{name}"
            );
            assert!(name.contains(&std::process::id().to_string()), "{name}");
        }
    }

    #[test]
    fn creating_over_an_existing_file_fails_and_keeps_its_content() {
        let dir = tempfile::tempdir().unwrap();
        let planted = dir.path().join("planted");
        std::fs::write(&planted, "precious").unwrap();
        let err = create_new_private(&planted).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(&planted).unwrap(), "precious");
    }

    #[cfg(unix)]
    #[test]
    fn creating_never_follows_a_planted_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let victim = dir.path().join("victim");
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&victim, &link).unwrap();
        let err = create_new_private(&link).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert!(!victim.exists(), "wrote through the symlink");
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_config_file_is_replaced_not_written_through() {
        let dir = tempfile::tempdir().unwrap();
        let victim = dir.path().join("victim");
        std::fs::write(&victim, "untouched").unwrap();
        std::os::unix::fs::symlink(&victim, dir.path().join(CONFIG_FILE)).unwrap();
        sample().save_to(dir.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "untouched");
        assert_eq!(Config::load_from(dir.path()).unwrap(), sample());
    }

    #[cfg(unix)]
    #[test]
    fn new_config_dir_and_file_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a").join("insitio");
        sample().save_to(&nested).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&nested), 0o700);
        assert_eq!(mode(&dir.path().join("a")), 0o700);
        assert_eq!(mode(&nested.join(CONFIG_FILE)), 0o600);
    }

    #[test]
    fn host_flag_beats_env_beats_default() {
        assert_eq!(
            resolve_host_from(Some("flag.example"), Some("env.example")),
            "flag.example"
        );
        assert_eq!(resolve_host_from(None, Some("env.example")), "env.example");
        assert_eq!(resolve_host_from(None, None), "git.iam.bot");
    }

    #[test]
    fn blank_host_values_fall_through() {
        assert_eq!(
            resolve_host_from(Some("  "), Some("env.example")),
            "env.example"
        );
        assert_eq!(resolve_host_from(Some(""), Some("")), "git.iam.bot");
    }

    #[test]
    fn resolve_host_reads_nsit_host() {
        let env = EnvGuard::lock().set("NSIT_HOST", "from-env.example");
        assert_eq!(resolve_host(None), "from-env.example");
        assert_eq!(resolve_host(Some("flag.example")), "flag.example");
        let _env = env.unset("NSIT_HOST");
        assert_eq!(resolve_host(None), "git.iam.bot");
    }

    #[test]
    fn bare_host_becomes_https() {
        let url = base_url("example.com").unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("example.com"));
        assert_eq!(url.as_str(), "https://example.com/");
    }

    #[test]
    fn default_host_is_valid() {
        assert_eq!(
            base_url(DEFAULT_HOST).unwrap().as_str(),
            "https://git.iam.bot/"
        );
    }

    #[test]
    fn https_urls_and_ports_pass_through() {
        assert_eq!(
            base_url("https://example.com:8443").unwrap().as_str(),
            "https://example.com:8443/"
        );
    }

    #[test]
    fn path_prefix_gets_a_trailing_slash() {
        assert_eq!(
            base_url("https://example.com/insitio").unwrap().as_str(),
            "https://example.com/insitio/"
        );
    }

    #[test]
    fn plain_http_to_a_remote_host_is_a_usage_error() {
        for host in [
            "http://evil.example",
            "http://example.com:3000",
            "http://10.0.0.5",
        ] {
            let err = base_url(host).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{host}: {err:?}");
            assert!(err.to_string().contains("https"), "{err}");
        }
    }

    #[test]
    fn plain_http_is_allowed_for_loopback_only() {
        for host in [
            "http://127.0.0.1:3000",
            "http://localhost:8080",
            "http://localhost",
            "http://[::1]:3000",
        ] {
            let url = base_url(host).unwrap_or_else(|e| panic!("{host} should be allowed: {e}"));
            assert_eq!(url.scheme(), "http", "{host}");
        }
    }

    #[test]
    fn loopback_lookalikes_are_refused() {
        for host in [
            "http://localhost.evil.example",
            "http://127.0.0.1.evil.example",
            "http://127.0.0.2:3000",
        ] {
            let err = base_url(host).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{host}: {err:?}");
        }
    }

    #[test]
    fn other_schemes_and_empty_hosts_are_usage_errors() {
        for host in [
            "ftp://example.com",
            "file:///etc/passwd",
            "ssh://example.com",
            "",
            "   ",
            "https://",
        ] {
            let err = base_url(host).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{host:?}: {err:?}");
        }
    }

    #[test]
    fn credentials_in_the_host_are_refused_and_never_echoed() {
        for host in [
            "https://ada:hunter2@example.com",
            "http://ada:hunter2@127.0.0.1:3000",
        ] {
            let err = base_url(host).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{host}: {err:?}");
            assert!(!err.to_string().contains("hunter2"), "{err}");
        }
    }
}
