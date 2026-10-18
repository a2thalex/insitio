//! nsit's own settings file, and how the target host is chosen.

use std::collections::BTreeMap;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};

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
        Config::load_from(&config_dir())
    }

    pub fn save(&self) -> Result<(), NsitError> {
        self.save_to(&config_dir())
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

    /// Write `nsit.toml` into `dir`, creating `dir` if needed. The file is
    /// written beside the target and renamed, so a crash cannot leave half
    /// a config behind.
    pub fn save_to(&self, dir: &Path) -> Result<(), NsitError> {
        let path = dir.join(CONFIG_FILE);
        let cannot_write = |e: &dyn std::fmt::Display| {
            NsitError::Other(format!("cannot write {}: {e}", path.display()))
        };
        let text = toml::to_string(self).map_err(|e| cannot_write(&e))?;
        std::fs::create_dir_all(dir).map_err(|e| cannot_write(&e))?;
        let tmp = dir.join(format!("{CONFIG_FILE}.tmp"));
        std::fs::write(&tmp, text).map_err(|e| cannot_write(&e))?;
        std::fs::rename(&tmp, &path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            cannot_write(&e)
        })
    }
}

/// The directory holding `nsit.toml` (and, when no credential store exists,
/// the token file): `NSIT_CONFIG_DIR` if set, else the per-user default.
pub fn config_dir() -> PathBuf {
    config_dir_from(
        env_value("NSIT_CONFIG_DIR").as_deref(),
        env_value("XDG_CONFIG_HOME").as_deref(),
    )
}

/// `config_dir` with the environment passed in, so it can be tested.
///
/// The default is `%APPDATA%\insitio` on Windows and
/// `$XDG_CONFIG_HOME/insitio` or `~/.config/insitio` elsewhere (macOS
/// included: this is a command-line tool, not an app bundle).
pub fn config_dir_from(nsit_config_dir: Option<&str>, xdg_config_home: Option<&str>) -> PathBuf {
    if let Some(dir) = nsit_config_dir.map(str::trim).filter(|s| !s.is_empty()) {
        return PathBuf::from(dir);
    }
    let base = if cfg!(windows) {
        dirs::config_dir()
    } else {
        xdg_config_home
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| dirs::home_dir().map(|home| home.join(".config")))
    };
    // With no home directory at all (a bare container), fall back to the
    // temp directory rather than the current directory, which may be a
    // repository where a stray config would get committed.
    base.unwrap_or_else(std::env::temp_dir).join("insitio")
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
    use std::sync::Mutex;

    /// Serializes the tests that change process-wide environment variables.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

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

    #[test]
    fn config_dir_honors_the_override_exactly() {
        let dir = config_dir_from(Some("/tmp/nsit-test"), Some("/xdg"));
        assert_eq!(dir, PathBuf::from("/tmp/nsit-test"));
    }

    #[test]
    fn empty_override_is_ignored() {
        let with_empty = config_dir_from(Some(""), None);
        let without = config_dir_from(None, None);
        assert_eq!(with_empty, without);
    }

    #[test]
    fn default_config_dir_is_per_user_insitio_folder() {
        let dir = config_dir_from(None, None);
        assert_eq!(dir.file_name().unwrap(), "insitio");
    }

    #[cfg(not(windows))]
    #[test]
    fn xdg_config_home_is_used_off_windows() {
        let dir = config_dir_from(None, Some("/xdg"));
        assert_eq!(dir, PathBuf::from("/xdg/insitio"));
    }

    #[test]
    fn config_round_trips_through_nsit_config_dir() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("NSIT_CONFIG_DIR", dir.path());
        let result = (|| {
            assert_eq!(config_dir(), dir.path());
            sample().save()?;
            assert!(dir.path().join(CONFIG_FILE).is_file());
            Config::load()
        })();
        std::env::remove_var("NSIT_CONFIG_DIR");
        assert_eq!(result.unwrap(), sample());
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
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("NSIT_HOST", "from-env.example");
        let from_env = resolve_host(None);
        let from_flag = resolve_host(Some("flag.example"));
        std::env::remove_var("NSIT_HOST");
        assert_eq!(from_env, "from-env.example");
        assert_eq!(from_flag, "flag.example");
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
