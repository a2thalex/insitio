//! `nsit branch`: list the branches, create one at `HEAD`, or delete one.
//!
//! Deleting is deliberately cautious and has no force option in v1: it refuses
//! the branch you are on, and a branch with commits that are not reachable from
//! `HEAD` (deleting it would lose them).
//!
//! `--json`: listing is an array of `{name, current, sha}`; creating and
//! deleting give `{action, name, sha}` (`sha` is the branch's tip).

use std::path::Path;

use git2::{Branch, BranchType, ErrorCode, Repository};
use serde::Serialize;

use crate::cli::{BranchArgs, GlobalArgs};
use crate::error::NsitError;
use crate::git::open_repo;
use crate::git::stage::head_commit;
use crate::output::{clean_for_terminal, Out};

/// One line of the listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub current: bool,
    pub sha: String,
}

/// What `branch <name>` and `branch -d <name>` did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BranchAction {
    pub action: &'static str,
    pub name: String,
    pub sha: String,
}

pub fn run(
    args: &BranchArgs,
    _global: &GlobalArgs,
    out: &Out,
    base: &Path,
) -> Result<(), NsitError> {
    let repo = open_repo(base)?;
    match (&args.name, &args.delete) {
        (Some(name), _) => {
            let done = create(&repo, name)?;
            out.data(&done, |d| {
                format!(
                    "created branch {} at {}",
                    clean(&d.name, out.tty),
                    &d.sha[..7]
                )
            })
        }
        (None, Some(name)) => {
            let done = delete(&repo, name)?;
            out.data(&done, |d| {
                format!(
                    "deleted branch {} (was {})",
                    clean(&d.name, out.tty),
                    &d.sha[..7]
                )
            })
        }
        (None, None) => {
            let branches = list(&repo)?;
            out.data(&branches, |all| listing(all, out.tty))
        }
    }
}

fn clean(text: &str, tty: bool) -> String {
    if tty {
        clean_for_terminal(text)
    } else {
        text.to_string()
    }
}

/// The local branches by name, with the one `HEAD` is on marked.
pub fn list(repo: &Repository) -> Result<Vec<BranchInfo>, NsitError> {
    let mut branches = Vec::new();
    for item in repo.branches(Some(BranchType::Local))? {
        let (branch, _) = item?;
        let name = String::from_utf8_lossy(branch.name_bytes()?).into_owned();
        let Some(tip) = branch.get().target() else {
            continue;
        };
        branches.push(BranchInfo {
            current: branch.is_head(),
            sha: tip.to_string(),
            name,
        });
    }
    branches.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(branches)
}

fn listing(branches: &[BranchInfo], tty: bool) -> String {
    branches
        .iter()
        .map(|b| {
            format!(
                "{} {}",
                if b.current { '*' } else { ' ' },
                clean(&b.name, tty)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Make branch `name` at the commit `HEAD` is on. It does not switch to it.
pub fn create(repo: &Repository, name: &str) -> Result<BranchAction, NsitError> {
    check_name(name)?;
    let Some(head) = head_commit(repo)? else {
        return Err(NsitError::Usage(
            "there are no commits yet: make one before creating a branch".into(),
        ));
    };
    match repo.branch(name, &head, false) {
        Ok(_) => Ok(BranchAction {
            action: "created",
            name: name.to_string(),
            sha: head.id().to_string(),
        }),
        Err(e) if e.code() == ErrorCode::Exists => Err(NsitError::Usage(format!(
            "a branch named {name} already exists"
        ))),
        Err(e) => Err(e.into()),
    }
}

/// Delete branch `name`, unless it is the current branch or has commits that
/// `HEAD` does not have.
pub fn delete(repo: &Repository, name: &str) -> Result<BranchAction, NsitError> {
    let mut branch = find_local(repo, name)?;
    if branch.is_head() {
        return Err(NsitError::Other(format!(
            "cannot delete {name}: it is the branch you are on; switch to another branch first"
        )));
    }
    let tip = branch.get().peel_to_commit()?.id();
    let merged = match head_commit(repo)? {
        Some(head) => head.id() == tip || repo.graph_descendant_of(head.id(), tip)?,
        None => false,
    };
    if !merged {
        return Err(NsitError::Other(format!(
            "{name} has commits that the current branch does not have, so it was not deleted \
             (nsit has no force option); merge it into this branch first"
        )));
    }
    branch.delete()?;
    Ok(BranchAction {
        action: "deleted",
        name: name.to_string(),
        sha: tip.to_string(),
    })
}

/// The local branch `name`, or a usage error that says it is not there.
pub fn find_local<'r>(repo: &'r Repository, name: &str) -> Result<Branch<'r>, NsitError> {
    match repo.find_branch(name, BranchType::Local) {
        Ok(branch) => Ok(branch),
        Err(e) if matches!(e.code(), ErrorCode::NotFound | ErrorCode::InvalidSpec) => {
            Err(NsitError::Usage(format!("there is no branch named {name}")))
        }
        Err(e) => Err(e.into()),
    }
}

/// A usage error unless `name` is a name git accepts for a branch.
pub fn check_name(name: &str) -> Result<(), NsitError> {
    if Branch::name_is_valid(name)? {
        Ok(())
    } else {
        Err(NsitError::Usage(format!(
            "{name:?} is not a valid branch name"
        )))
    }
}

#[cfg(test)]
mod tests {
    use git2::build::CheckoutBuilder;

    use super::*;
    use crate::test_support::{commit_file, local_repo};

    fn switch(repo: &Repository, name: &str) {
        repo.set_head(&format!("refs/heads/{name}")).unwrap();
        repo.checkout_head(Some(CheckoutBuilder::new().force()))
            .unwrap();
    }

    fn names(repo: &Repository) -> Vec<String> {
        list(repo).unwrap().into_iter().map(|b| b.name).collect()
    }

    #[test]
    fn listing_marks_the_current_branch_and_sorts_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        assert!(list(&repo).unwrap().is_empty(), "no commits, no branches");
        commit_file(&repo, "a.txt", "a");
        create(&repo, "zeta").unwrap();
        create(&repo, "alpha").unwrap();
        let all = list(&repo).unwrap();
        let shown: Vec<(&str, bool)> = all.iter().map(|b| (b.name.as_str(), b.current)).collect();
        assert_eq!(shown, [("alpha", false), ("main", true), ("zeta", false)]);
        assert_eq!(listing(&all, false), "  alpha\n* main\n  zeta");
        let tip = repo.head().unwrap().target().unwrap().to_string();
        assert!(all.iter().all(|b| b.sha == tip));
    }

    #[test]
    fn create_makes_a_branch_at_head_without_switching() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "a");
        let made = create(&repo, "feature/login").unwrap();
        assert_eq!(made.action, "created");
        assert_eq!(made.name, "feature/login");
        assert_eq!(made.sha, repo.head().unwrap().target().unwrap().to_string());
        assert_eq!(names(&repo), ["feature/login", "main"]);
        assert_eq!(repo.head().unwrap().shorthand().unwrap(), "main");
    }

    #[test]
    fn create_refuses_bad_names_existing_names_and_an_empty_repository() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let err = create(&repo, "early").unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert!(err.to_string().contains("no commits yet"), "{err}");

        commit_file(&repo, "a.txt", "a");
        for bad in [
            "",
            "has space",
            "a..b",
            "-dash",
            "end.",
            "x~1",
            "a:b",
            "@{x}",
        ] {
            let err = create(&repo, bad).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{bad:?}: {err:?}");
            assert_eq!(err.exit_code(), 2);
        }
        create(&repo, "taken").unwrap();
        let err = create(&repo, "taken").unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert!(err.to_string().contains("already exists"), "{err}");
        assert_eq!(names(&repo), ["main", "taken"]);
    }

    #[test]
    fn a_merged_branch_can_be_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "a");
        let made = create(&repo, "done").unwrap();
        // It is at HEAD: nothing would be lost.
        let gone = delete(&repo, "done").unwrap();
        assert_eq!((gone.action, gone.name.as_str()), ("deleted", "done"));
        assert_eq!(gone.sha, made.sha);
        assert_eq!(names(&repo), ["main"]);
        // Also when HEAD has moved on past it.
        create(&repo, "old").unwrap();
        commit_file(&repo, "b.txt", "b");
        delete(&repo, "old").unwrap();
        assert_eq!(names(&repo), ["main"]);
    }

    #[test]
    fn deleting_refuses_the_current_branch_and_an_unmerged_one() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "a");
        let err = delete(&repo, "main").unwrap_err();
        assert!(err.to_string().contains("branch you are on"), "{err}");
        assert_eq!(err.exit_code(), 1);

        create(&repo, "side").unwrap();
        switch(&repo, "side");
        commit_file(&repo, "only-on-side.txt", "s");
        switch(&repo, "main");
        let err = delete(&repo, "side").unwrap_err();
        assert!(
            err.to_string().contains("not delete") || err.to_string().contains("not deleted"),
            "{err}"
        );
        assert_eq!(err.exit_code(), 1);
        // Both are still there.
        assert_eq!(names(&repo), ["main", "side"]);
    }

    #[test]
    fn deleting_a_branch_that_is_not_there_is_a_usage_error() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "a");
        for name in ["nope", "origin/main", "bad name"] {
            let err = delete(&repo, name).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{name}: {err:?}");
            assert!(err.to_string().contains("no branch named"), "{err}");
        }
    }

    #[test]
    fn deleting_a_branch_forgets_its_upstream_settings_too() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "a");
        create(&repo, "topic").unwrap();
        {
            let mut config = repo.config().unwrap();
            config.set_str("branch.topic.remote", "origin").unwrap();
            config
                .set_str("branch.topic.merge", "refs/heads/topic")
                .unwrap();
        }
        delete(&repo, "topic").unwrap();
        let config = Repository::open(dir.path()).unwrap().config().unwrap();
        assert!(config.get_string("branch.topic.remote").is_err());
    }
}
