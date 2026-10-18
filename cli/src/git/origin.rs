//! `origin`, as a repository on the selected Insitio server.

use git2::Repository;

use crate::config::base_url;
use crate::credentials::host_key_for;
use crate::repo_ref::{parse_repo_ref, RepoRef};
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
