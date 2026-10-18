//! One module per `nsit` command. Each exposes a `run` that main dispatches to.
//!
//! The commands that work on a local repository (`init`, `status`, `add`,
//! `commit`, `log`, `branch`, `switch`, `readme`) take the directory they act
//! in as `base`: the process directory, or `-C <dir>` resolved against it once
//! (`working_dir`). They never change the process directory, so everything they
//! read or write is explicit.

pub mod add;
pub mod auth;
pub mod branch;
pub mod commit;
pub mod init;
pub mod log;
pub mod readme;
pub mod repo;
pub mod status;
pub mod switch;

use std::path::{Path, PathBuf};

use git2::{Repository, Signature};

use crate::cli::GlobalArgs;
use crate::config::{resolve_host, Config, HostConfig};
use crate::credentials::{host_entry, host_key_for};
use crate::error::NsitError;
use crate::git;

/// The directory a local command acts in: `-C <dir>` (relative to the process
/// directory, absolute as given) or the process directory itself. It must be an
/// existing directory.
pub fn working_dir(dir: Option<&Path>) -> Result<PathBuf, NsitError> {
    let here = std::env::current_dir()
        .map_err(|e| NsitError::Other(format!("cannot find the current directory: {e}")))?;
    let Some(dir) = dir else {
        return Ok(here);
    };
    // `join` keeps `dir` as it is when it is absolute.
    let base = here.join(dir);
    if !base.is_dir() {
        return Err(NsitError::Usage(format!(
            "cannot use -C {}: not a directory",
            dir.display()
        )));
    }
    Ok(base)
}

/// Who a commit is by: the git configuration for `repo`, then the name and email
/// nsit saved when this machine signed in to the selected host. A problem
/// reading nsit's own config only means that fallback is missing.
pub fn commit_signature(
    repo: &Repository,
    global: &GlobalArgs,
) -> Result<Signature<'static>, NsitError> {
    let host = resolve_host(global.host.as_deref());
    git::signature(repo, saved_account(&host).as_ref())
}

/// What nsit remembers about the account signed in on `host`.
fn saved_account(host: &str) -> Option<HostConfig> {
    let key = host_key_for(host).ok()?;
    let config = Config::load().ok()?;
    host_entry(&config, &key).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn without_c_the_process_directory_is_used() {
        assert_eq!(working_dir(None).unwrap(), std::env::current_dir().unwrap());
    }

    #[test]
    fn a_relative_c_is_taken_from_the_process_directory_and_an_absolute_one_as_is() {
        let here = std::env::current_dir().unwrap();
        // `src` exists next to Cargo.toml, where the tests run.
        assert_eq!(
            working_dir(Some(Path::new("src"))).unwrap(),
            here.join("src")
        );
        let absolute = tempfile::tempdir().unwrap();
        assert_eq!(
            working_dir(Some(absolute.path())).unwrap(),
            absolute.path().to_path_buf()
        );
    }

    #[test]
    fn a_c_that_is_not_a_directory_is_a_usage_error() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a file.txt");
        std::fs::write(&file, "x").unwrap();
        for bad in [dir.path().join("missing"), file] {
            let err = working_dir(Some(&bad)).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
            assert_eq!(err.exit_code(), 2);
            assert!(err.to_string().contains("not a directory"), "{err}");
        }
    }
}
