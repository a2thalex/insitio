//! `nsit switch <branch> [-c]`: move to another branch, or make one first.
//!
//! The checkout is *safe*: it never replaces a change that is not committed.
//! If the move would overwrite one (an edited file that differs on the other
//! branch, an untracked file in the way of a tracked one), nothing is touched,
//! `HEAD` stays where it is and the command fails (exit 1) naming the files.
//! Changes the two branches agree on are carried over, as git does.
//!
//! `--json`: `{branch, created, sha}`.

use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;

use git2::build::CheckoutBuilder;
use git2::{CheckoutNotificationType, Commit, ErrorCode, Repository, RepositoryState};
use serde::Serialize;

use super::branch::{check_name, create as create_branch, find_local};
use crate::cli::{GlobalArgs, SwitchArgs};
use crate::error::NsitError;
use crate::git::open_repo;
use crate::git::paths::slash;
use crate::git::stage::{current_branch, head_commit};
use crate::output::{clean_for_terminal, Out};

/// Where `switch` ended up.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Switched {
    pub branch: String,
    /// The branch was made by this command (`-c`).
    pub created: bool,
    /// The commit it is on; null for a new branch in a repository with no commits.
    pub sha: Option<String>,
    /// Not part of the JSON: `HEAD` was on this branch already.
    #[serde(skip)]
    pub already_there: bool,
}

pub fn run(
    args: &SwitchArgs,
    _global: &GlobalArgs,
    out: &Out,
    base: &Path,
) -> Result<(), NsitError> {
    let repo = open_repo(base)?;
    let done = switch(&repo, &args.branch, args.create)?;
    out.data(&done, |d| describe(d, out.tty))
}

fn describe(done: &Switched, tty: bool) -> String {
    let name = if tty {
        clean_for_terminal(&done.branch)
    } else {
        done.branch.clone()
    };
    if done.already_there {
        format!("Already on '{name}'")
    } else if done.created {
        format!("Switched to a new branch '{name}'")
    } else {
        format!("Switched to branch '{name}'")
    }
}

/// Make `name` the current branch, creating it from `HEAD` first with `create`.
pub fn switch(repo: &Repository, name: &str, create: bool) -> Result<Switched, NsitError> {
    if repo.state() != RepositoryState::Clean {
        return Err(NsitError::Other(
            "a merge is in progress: finish it with nsit commit, or abandon it with \
             nsit pull --abort, before switching branches"
                .into(),
        ));
    }
    if create {
        return switch_to_new(repo, name);
    }
    let branch = find_local(repo, name).map_err(|e| match e {
        NsitError::Usage(text) => {
            NsitError::Usage(format!("{text}; create it with nsit switch -c {name}"))
        }
        other => other,
    })?;
    let target = branch.get().peel_to_commit()?;
    if current_branch(repo).as_deref() == Some(name) {
        return Ok(Switched {
            branch: name.to_string(),
            created: false,
            sha: Some(target.id().to_string()),
            already_there: true,
        });
    }
    checkout_safely(repo, &target, name)?;
    repo.set_head(&format!("refs/heads/{name}"))?;
    Ok(Switched {
        branch: name.to_string(),
        created: false,
        sha: Some(target.id().to_string()),
        already_there: false,
    })
}

/// `-c`: the new branch starts where `HEAD` is, so no file changes and
/// uncommitted work comes along. Before the first commit there is no commit
/// to start from: `HEAD` just points at the new, still empty branch.
fn switch_to_new(repo: &Repository, name: &str) -> Result<Switched, NsitError> {
    let sha = match head_commit(repo)? {
        Some(_) => {
            // `create` checks the name and refuses one that exists.
            let made = create_branch(repo, name).map_err(|e| match e {
                NsitError::Usage(text) if text.contains("already exists") => {
                    NsitError::Usage(format!("{text}; use nsit switch {name} to go to it"))
                }
                other => other,
            })?;
            Some(made.sha)
        }
        None => {
            check_name(name)?;
            None
        }
    };
    repo.set_head(&format!("refs/heads/{name}"))?;
    Ok(Switched {
        branch: name.to_string(),
        created: true,
        sha,
        already_there: false,
    })
}

/// Check out `target` without losing any uncommitted change. On a conflict
/// nothing has been written and the error names the files in the way.
fn checkout_safely(repo: &Repository, target: &Commit<'_>, name: &str) -> Result<(), NsitError> {
    let in_the_way = Rc::new(RefCell::new(Vec::<String>::new()));
    let sink = Rc::clone(&in_the_way);
    let mut options = CheckoutBuilder::new();
    options
        .safe()
        .notify_on(CheckoutNotificationType::CONFLICT)
        .notify(move |_, path, _, _, _| {
            if let Some(path) = path {
                sink.borrow_mut().push(slash(path));
            }
            true
        });
    match repo.checkout_tree(target.as_object(), Some(&mut options)) {
        Ok(()) => Ok(()),
        Err(e) if e.code() == ErrorCode::Conflict => {
            let files = in_the_way.borrow();
            let files: Vec<String> = files
                .iter()
                .map(|f| f.chars().filter(|c| !c.is_control()).collect())
                .collect();
            Err(NsitError::Other(if files.is_empty() {
                format!(
                    "cannot switch to {name}: it would overwrite changes that are not committed"
                )
            } else {
                format!(
                    "cannot switch to {name}: it would overwrite changes that are not committed \
                     in {}; commit them first",
                    files.join(", ")
                )
            }))
        }
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::stage::{stage_all, stage_paths};
    use crate::test_support::{commit_file, local_repo};

    fn read(dir: &Path, rel: &str) -> String {
        std::fs::read_to_string(dir.join(rel)).unwrap()
    }

    fn write(dir: &Path, rel: &str, text: &str) {
        std::fs::write(dir.join(rel), text).unwrap();
    }

    fn on(repo: &Repository) -> Option<String> {
        current_branch(repo)
    }

    /// `main` has f.txt = "main\n"; a branch `feature` has f.txt = "feature\n"
    /// and a file only it has. HEAD is back on `main`.
    fn two_branches(dir: &Path) -> Repository {
        let repo = local_repo(dir);
        commit_file(&repo, "f.txt", "main\n");
        commit_file(&repo, "same.txt", "same\n");
        switch(&repo, "feature", true).unwrap();
        commit_file(&repo, "f.txt", "feature\n");
        commit_file(&repo, "only-feature.txt", "x\n");
        switch(&repo, "main", false).unwrap();
        repo
    }

    #[test]
    fn switch_c_then_back_restores_the_files() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "f.txt", "main\n");
        let made = switch(&repo, "feature", true).unwrap();
        assert!(made.created && !made.already_there);
        assert_eq!(made.branch, "feature");
        assert_eq!(on(&repo).as_deref(), Some("feature"));
        commit_file(&repo, "f.txt", "feature\n");
        commit_file(&repo, "extra.txt", "extra\n");

        let back = switch(&repo, "main", false).unwrap();
        assert!(!back.created);
        assert_eq!(on(&repo).as_deref(), Some("main"));
        assert_eq!(read(dir.path(), "f.txt"), "main\n");
        assert!(!dir.path().join("extra.txt").exists());

        switch(&repo, "feature", false).unwrap();
        assert_eq!(read(dir.path(), "f.txt"), "feature\n");
        assert_eq!(read(dir.path(), "extra.txt"), "extra\n");
        // The index follows the checkout: nothing shows as changed.
        let statuses = repo.statuses(None).unwrap();
        assert!(statuses.is_empty(), "{} entries", statuses.len());
    }

    #[test]
    fn the_result_names_the_commit_the_branch_is_on() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "f.txt", "main\n");
        let head = repo.head().unwrap().target().unwrap().to_string();
        assert_eq!(switch(&repo, "x", true).unwrap().sha, Some(head.clone()));
        assert_eq!(switch(&repo, "main", false).unwrap().sha, Some(head));
    }

    #[test]
    fn an_edited_file_that_differs_on_the_target_stops_the_switch_and_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let repo = two_branches(dir.path());
        write(dir.path(), "f.txt", "my unsaved work\n");
        let before = repo.head().unwrap().target();
        let err = switch(&repo, "feature", false).unwrap_err();
        assert!(matches!(err, NsitError::Other(_)), "{err:?}");
        assert_eq!(err.exit_code(), 1);
        assert!(err.to_string().contains("f.txt"), "{err}");
        assert_eq!(read(dir.path(), "f.txt"), "my unsaved work\n");
        assert!(
            !dir.path().join("only-feature.txt").exists(),
            "nothing was checked out"
        );
        assert_eq!(on(&repo).as_deref(), Some("main"));
        assert_eq!(repo.head().unwrap().target(), before);
    }

    #[test]
    fn a_staged_change_that_differs_on_the_target_also_stops_the_switch() {
        let dir = tempfile::tempdir().unwrap();
        let repo = two_branches(dir.path());
        write(dir.path(), "f.txt", "staged work\n");
        let mut index = repo.index().unwrap();
        stage_paths(&repo, &mut index, &["f.txt".to_string()]).unwrap();
        index.write().unwrap();
        let err = switch(&repo, "feature", false).unwrap_err();
        assert!(err.to_string().contains("f.txt"), "{err}");
        assert_eq!(read(dir.path(), "f.txt"), "staged work\n");
        assert_eq!(on(&repo).as_deref(), Some("main"));
    }

    #[test]
    fn an_untracked_file_in_the_way_of_a_tracked_one_stops_the_switch() {
        let dir = tempfile::tempdir().unwrap();
        let repo = two_branches(dir.path());
        write(dir.path(), "only-feature.txt", "I made this myself\n");
        let err = switch(&repo, "feature", false).unwrap_err();
        assert!(err.to_string().contains("only-feature.txt"), "{err}");
        assert_eq!(read(dir.path(), "only-feature.txt"), "I made this myself\n");
        assert_eq!(on(&repo).as_deref(), Some("main"));
    }

    #[test]
    fn changes_both_branches_agree_on_come_along() {
        let dir = tempfile::tempdir().unwrap();
        let repo = two_branches(dir.path());
        write(dir.path(), "same.txt", "edited on main, same on feature\n");
        write(dir.path(), "untracked.txt", "new\n");
        switch(&repo, "feature", false).unwrap();
        assert_eq!(
            read(dir.path(), "same.txt"),
            "edited on main, same on feature\n"
        );
        assert_eq!(read(dir.path(), "untracked.txt"), "new\n");
        assert_eq!(read(dir.path(), "f.txt"), "feature\n");
    }

    #[test]
    fn switch_c_never_touches_files_so_work_in_progress_comes_along() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "f.txt", "main\n");
        write(dir.path(), "f.txt", "in progress\n");
        let mut index = repo.index().unwrap();
        stage_all(&mut index).unwrap();
        index.write().unwrap();
        switch(&repo, "topic", true).unwrap();
        assert_eq!(read(dir.path(), "f.txt"), "in progress\n");
        assert_eq!(on(&repo).as_deref(), Some("topic"));
    }

    #[test]
    fn a_missing_branch_without_c_is_a_usage_error_with_a_hint() {
        let dir = tempfile::tempdir().unwrap();
        let repo = two_branches(dir.path());
        let err = switch(&repo, "nope", false).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert_eq!(err.exit_code(), 2);
        let text = err.to_string();
        assert!(
            text.contains("nope") && text.contains("nsit switch -c nope"),
            "{text}"
        );
        assert_eq!(on(&repo).as_deref(), Some("main"));
    }

    #[test]
    fn c_with_a_taken_or_invalid_name_is_a_usage_error_and_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let repo = two_branches(dir.path());
        let err = switch(&repo, "feature", true).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert!(err.to_string().contains("already exists"), "{err}");
        for bad in ["a b", "x..y", "-x", ""] {
            let err = switch(&repo, bad, true).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{bad:?}: {err:?}");
        }
        assert_eq!(on(&repo).as_deref(), Some("main"));
        assert_eq!(read(dir.path(), "f.txt"), "main\n");
    }

    #[test]
    fn switching_to_where_you_are_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let repo = two_branches(dir.path());
        let done = switch(&repo, "main", false).unwrap();
        assert!(done.already_there);
        assert_eq!(describe(&done, false), "Already on 'main'");
    }

    #[test]
    fn switch_c_before_the_first_commit_points_head_at_the_new_branch() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let done = switch(&repo, "start", true).unwrap();
        assert_eq!(done.sha, None);
        assert_eq!(on(&repo).as_deref(), Some("start"));
        commit_file(&repo, "a.txt", "a");
        assert!(repo.find_reference("refs/heads/start").is_ok());
        assert!(repo.find_reference("refs/heads/main").is_err());
        let other = tempfile::tempdir().unwrap();
        let empty = local_repo(other.path());
        let err = switch(&empty, "bad name", true).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert_eq!(on(&empty).as_deref(), Some("main"));
    }

    #[test]
    fn a_detached_head_can_switch_to_a_branch() {
        let dir = tempfile::tempdir().unwrap();
        let repo = two_branches(dir.path());
        let id = repo.head().unwrap().target().unwrap();
        repo.set_head_detached(id).unwrap();
        assert_eq!(on(&repo), None);
        switch(&repo, "feature", false).unwrap();
        assert_eq!(on(&repo).as_deref(), Some("feature"));
        assert_eq!(read(dir.path(), "f.txt"), "feature\n");
    }

    #[test]
    fn nothing_switches_while_a_merge_is_in_progress() {
        let dir = tempfile::tempdir().unwrap();
        let repo = two_branches(dir.path());
        std::fs::write(
            repo.path().join("MERGE_HEAD"),
            format!("{}\n", repo.head().unwrap().target().unwrap()),
        )
        .unwrap();
        assert_eq!(repo.state(), RepositoryState::Merge);
        let err = switch(&repo, "feature", false).unwrap_err();
        assert!(err.to_string().contains("merge is in progress"), "{err}");
        assert!(switch(&repo, "x", true).is_err());
        assert_eq!(on(&repo).as_deref(), Some("main"));
    }

    #[test]
    fn the_text_says_what_happened() {
        let moved = Switched {
            branch: "feature".into(),
            created: false,
            sha: None,
            already_there: false,
        };
        assert_eq!(describe(&moved, false), "Switched to branch 'feature'");
        let created = Switched {
            created: true,
            ..moved.clone()
        };
        assert_eq!(
            describe(&created, false),
            "Switched to a new branch 'feature'"
        );
        let json = serde_json::to_string(&created).unwrap();
        assert_eq!(json, r#"{"branch":"feature","created":true,"sha":null}"#);
    }
}
