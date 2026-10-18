//! The git engine's helpers that are not about talking to a server: finding
//! the repository, and who commits.
//!
//! nsit does all git work through libgit2 (`git2`), so no `git` program is
//! needed. Talking to an Insitio server (credentials, progress, redirects) is
//! in `auth` and `progress`; every network operation goes through
//! `auth::run_remote`. Naming a repository is `crate::repo_ref`.
//!
//! The commands that use most of this (`init`, `clone`, `commit`, `pull`,
//! `push`) arrive in later tasks; until then what they will call is marked
//! `allow(dead_code)` / `allow(unused_imports)`, and the allows go away with
//! the callers.

pub mod auth;
pub mod progress;

// What the git commands import from `crate::git`.
#[allow(unused_imports)]
pub use auth::{remote_callbacks, remote_error, run_remote, RemoteAccess};

use std::path::Path;

use git2::{ErrorCode, Repository, Signature};

use crate::config::HostConfig;
use crate::error::NsitError;
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

#[cfg(test)]
mod tests {
    use git2::{ConfigLevel, ErrorClass};

    use super::*;
    use crate::test_support::host_entry_for;
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
}
