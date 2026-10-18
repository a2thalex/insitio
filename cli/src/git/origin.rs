//! `origin`, as a repository on the selected Insitio server.

use git2::Repository;
use url::Url;

use crate::config::base_url;
use crate::credentials::host_key_for;
use crate::repo_ref::{parse_repo_ref, RepoRef};

/// A remote's URL as a repository on an Insitio server, for the commands that talk to one
/// (`push` to `origin`, `pull` from the upstream remote).
///
/// Only a full URL counts: `owner/name` alone would be read as being on `base`'s server, and git
/// would take it for a path. The server may be any server (the result carries its own `host`, and
/// `run_remote` picks the token for that host and no other); `base` is the selected one, which an
/// `NSIT_TOKEN` is bound to. `Err` is the reason in a few words, and never repeats the URL, which
/// might hold a token.
pub fn repo_ref_from_url(url: &str, base: &Url) -> Result<RepoRef, String> {
    if !url.contains("://") {
        return Err("it is not a URL".to_string());
    }
    parse_repo_ref(url, "", base).map_err(|e| e.to_string())
}

/// `origin`, when it is a repository on `host` (the selected Insitio server).
/// Another server, or a URL that is not an Insitio repository, is `None`.
pub fn origin_on(repo: &Repository, host: &str) -> Option<RepoRef> {
    let remote = repo.find_remote("origin").ok()?;
    let url = remote.url().ok()?;
    let base = base_url(host).ok()?;
    let target = parse_repo_ref(url, "", &base).ok()?;
    (target.host_key() == host_key_for(host).ok()?).then_some(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::local_repo;

    fn base() -> Url {
        base_url("git.iam.bot").unwrap()
    }

    #[test]
    fn a_full_url_is_a_repository_on_whatever_server_it_names() {
        let same = repo_ref_from_url("https://git.iam.bot/ada/rocket.git", &base()).unwrap();
        assert_eq!((same.owner.as_str(), same.name.as_str()), ("ada", "rocket"));
        assert_eq!(same.host_key(), "git.iam.bot");
        // Without `.git`, and on another server: that server is the one the credentials are for.
        let other = repo_ref_from_url("https://other.example/ada/rocket", &base()).unwrap();
        assert_eq!(other.host_key(), "other.example");
        assert_eq!(
            other.clone_url.as_str(),
            "https://other.example/ada/rocket.git"
        );
        let local = repo_ref_from_url("http://127.0.0.1:3000/ada/rocket.git", &base()).unwrap();
        assert_eq!(local.host_key(), "127.0.0.1:3000");
    }

    #[test]
    fn anything_else_is_refused_with_a_reason_that_never_repeats_the_url() {
        for url in [
            "ada/rocket",
            "../rocket.git",
            "/srv/git/rocket.git",
            "git@git.iam.bot:ada/rocket.git",
            "C:\\repos\\rocket",
            "",
        ] {
            assert_eq!(
                repo_ref_from_url(url, &base()).unwrap_err(),
                "it is not a URL",
                "{url:?}"
            );
        }
        for url in [
            "https://ada:ins_secret_value@git.iam.bot/ada/rocket.git",
            "https://ins_secret_value@git.iam.bot/ada/rocket.git",
            "ssh://git@git.iam.bot/ada/rocket.git",
            "http://git.iam.bot/ada/rocket.git",
            "https://git.iam.bot/ada/rocket/extra.git",
            "https://git.iam.bot/ada",
            "file:///srv/git/rocket.git",
        ] {
            let why = repo_ref_from_url(url, &base()).unwrap_err();
            assert!(!why.is_empty(), "{url}");
            assert!(!why.contains("ins_secret_value"), "{url}: {why}");
            assert!(!why.contains('\n'), "{why:?}");
        }
    }

    #[test]
    fn origin_is_recognised_only_on_the_selected_host() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        assert!(origin_on(&repo, "git.iam.bot").is_none(), "no origin yet");

        repo.remote("origin", "https://git.iam.bot/ada/rocket.git")
            .unwrap();
        let found = origin_on(&repo, "git.iam.bot").unwrap();
        assert_eq!(
            (found.owner.as_str(), found.name.as_str()),
            ("ada", "rocket")
        );
        assert!(origin_on(&repo, "https://other.example").is_none());
        assert!(origin_on(&repo, "").is_none());

        repo.remote_set_url("origin", "https://github.com/ada/rocket.git")
            .unwrap();
        assert!(origin_on(&repo, "git.iam.bot").is_none());
        repo.remote_set_url("origin", "git@git.iam.bot:ada/rocket.git")
            .unwrap();
        assert!(origin_on(&repo, "git.iam.bot").is_none());
    }
}
