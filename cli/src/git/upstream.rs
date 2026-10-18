//! The upstream of a branch: the two settings `branch.<b>.remote` and `branch.<b>.merge`.
//!
//! One place reads and writes them. `nsit push` sets them (the first push of a branch, and
//! `-u`), `nsit clone` sets them for the branch of an empty repository, and `nsit pull` reads
//! them, so what one command writes is exactly what the next one looks for. Writes go to the
//! repository's own config (`.git/config`), never to a global one.

use git2::{Config, ConfigLevel, ErrorCode, Repository};

use crate::error::NsitError;

/// Where a branch gets its new commits from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Upstream {
    /// `branch.<b>.remote`: the name of a remote (`origin`).
    pub remote: String,
    /// `branch.<b>.merge`: the branch on that remote, as a ref (`refs/heads/main`).
    pub merge: String,
}

impl Upstream {
    /// The branch's name on the remote (`main`), or `None` when `merge` is not a branch.
    pub fn branch(&self) -> Option<&str> {
        self.merge
            .strip_prefix("refs/heads/")
            .filter(|name| !name.is_empty())
    }
}

/// `branch`'s upstream, as git itself would read it (every config level), or `None` when either
/// setting is missing or blank.
pub fn upstream(repo: &Repository, branch: &str) -> Result<Option<Upstream>, NsitError> {
    read(&repo.config()?, branch)
}

/// Does `branch` have both settings in this repository's own config?
pub fn has_upstream(repo: &Repository, branch: &str) -> Result<bool, NsitError> {
    let own = repo.config()?.open_level(ConfigLevel::Local)?;
    Ok(read(&own, branch)?.is_some())
}

/// Make `<remote>/<branch>` the upstream of `branch`, in this repository's own config.
pub fn set_upstream(repo: &Repository, branch: &str, remote: &str) -> Result<(), NsitError> {
    let mut config = repo.config()?.open_level(ConfigLevel::Local)?;
    config.set_str(&key(branch, "remote"), remote)?;
    config.set_str(&key(branch, "merge"), &format!("refs/heads/{branch}"))?;
    Ok(())
}

/// Forget `branch`'s upstream settings (what is not there is not an error).
pub fn clear_upstream(repo: &Repository, branch: &str) -> Result<(), NsitError> {
    let mut config = repo.config()?.open_level(ConfigLevel::Local)?;
    for setting in ["remote", "merge"] {
        match config.remove(&key(branch, setting)) {
            Ok(()) => {}
            Err(e) if e.code() == ErrorCode::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

fn key(branch: &str, setting: &str) -> String {
    format!("branch.{branch}.{setting}")
}

/// A setting's value; blank counts as missing.
fn setting(config: &Config, branch: &str, name: &str) -> Result<Option<String>, NsitError> {
    match config.get_string(&key(branch, name)) {
        Ok(value) => Ok(Some(value.trim().to_string()).filter(|value| !value.is_empty())),
        Err(e) if e.code() == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn read(config: &Config, branch: &str) -> Result<Option<Upstream>, NsitError> {
    let remote = setting(config, branch, "remote")?;
    let merge = setting(config, branch, "merge")?;
    Ok(remote
        .zip(merge)
        .map(|(remote, merge)| Upstream { remote, merge }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::local_repo;

    /// A setting from this repository's own config file.
    fn local(repo: &Repository, key: &str) -> Option<String> {
        repo.config()
            .unwrap()
            .open_level(ConfigLevel::Local)
            .unwrap()
            .get_string(key)
            .ok()
    }

    fn up(remote: &str, merge: &str) -> Upstream {
        Upstream {
            remote: remote.into(),
            merge: merge.into(),
        }
    }

    #[test]
    fn a_branch_without_tracking_settings_has_no_upstream_until_one_is_set() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        assert!(!has_upstream(&repo, "main").unwrap());
        assert_eq!(upstream(&repo, "main").unwrap(), None);
        set_upstream(&repo, "main", "origin").unwrap();
        assert!(has_upstream(&repo, "main").unwrap());
        assert_eq!(
            local(&repo, "branch.main.remote").as_deref(),
            Some("origin")
        );
        assert_eq!(
            local(&repo, "branch.main.merge").as_deref(),
            Some("refs/heads/main")
        );
        assert_eq!(
            upstream(&repo, "main").unwrap(),
            Some(up("origin", "refs/heads/main"))
        );
        // Another branch is still without.
        assert!(!has_upstream(&repo, "dev").unwrap());
        assert_eq!(upstream(&repo, "dev").unwrap(), None);
    }

    #[test]
    fn half_a_setting_is_not_an_upstream_and_setting_one_repairs_it() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        repo.config()
            .unwrap()
            .set_str("branch.main.remote", "origin")
            .unwrap();
        assert!(!has_upstream(&repo, "main").unwrap());
        assert_eq!(upstream(&repo, "main").unwrap(), None);
        set_upstream(&repo, "main", "origin").unwrap();
        assert!(has_upstream(&repo, "main").unwrap());
        // Blank is as good as missing.
        let other = repo.config().unwrap();
        let mut other = other;
        other.set_str("branch.dev.remote", "  ").unwrap();
        other.set_str("branch.dev.merge", "refs/heads/dev").unwrap();
        assert_eq!(upstream(&repo, "dev").unwrap(), None);
    }

    #[test]
    fn setting_the_upstream_replaces_what_was_there_and_handles_dots_and_slashes() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        {
            let mut config = repo.config().unwrap();
            config.set_str("branch.release/1.0.remote", "fork").unwrap();
            config
                .set_str("branch.release/1.0.merge", "refs/heads/other")
                .unwrap();
        }
        assert!(has_upstream(&repo, "release/1.0").unwrap());
        assert_eq!(
            upstream(&repo, "release/1.0").unwrap(),
            Some(up("fork", "refs/heads/other"))
        );
        set_upstream(&repo, "release/1.0", "origin").unwrap();
        assert_eq!(
            local(&repo, "branch.release/1.0.remote").as_deref(),
            Some("origin")
        );
        assert_eq!(
            local(&repo, "branch.release/1.0.merge").as_deref(),
            Some("refs/heads/release/1.0")
        );
    }

    #[test]
    fn the_remote_can_be_any_remote() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        set_upstream(&repo, "main", "insitio").unwrap();
        assert_eq!(
            upstream(&repo, "main").unwrap(),
            Some(up("insitio", "refs/heads/main"))
        );
    }

    #[test]
    fn the_branch_on_the_remote_is_read_from_the_merge_ref() {
        assert_eq!(up("origin", "refs/heads/main").branch(), Some("main"));
        assert_eq!(
            up("origin", "refs/heads/release/1.0").branch(),
            Some("release/1.0")
        );
        // Not a branch: a tag, a pull request ref, a bare name, nothing after the prefix.
        for merge in [
            "refs/tags/v1",
            "refs/pull/1/head",
            "main",
            "refs/heads/",
            "",
        ] {
            assert_eq!(up("origin", merge).branch(), None, "{merge:?}");
        }
    }

    #[test]
    fn clearing_removes_both_settings_and_forgives_what_is_not_there() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        set_upstream(&repo, "main", "origin").unwrap();
        clear_upstream(&repo, "main").unwrap();
        assert_eq!(local(&repo, "branch.main.remote"), None);
        assert_eq!(local(&repo, "branch.main.merge"), None);
        assert!(!has_upstream(&repo, "main").unwrap());
        // Nothing there, or one half only: not an error.
        clear_upstream(&repo, "main").unwrap();
        repo.config()
            .unwrap()
            .set_str("branch.dev.merge", "refs/heads/dev")
            .unwrap();
        clear_upstream(&repo, "dev").unwrap();
        assert_eq!(local(&repo, "branch.dev.merge"), None);
    }
}
