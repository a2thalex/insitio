//! `nsit switch <branch> [-c]`: move to another branch, or make one first.
//!
//! The checkout is *safe* (`git::checkout`, the same one `nsit pull` uses): it never
//! replaces a change that is not committed, nor a file that is untracked or ignored.
//! If the move would overwrite one (an edited file that differs on the other
//! branch, an untracked or ignored file in the way of a tracked one), nothing is
//! touched, `HEAD` stays where it is and the command fails (exit 1) naming the files.
//! Changes the two branches agree on are carried over, as git does.
//!
//! While a merge (or any other operation) is in progress nothing is switched: that is a
//! usage error, exit 2, as it is for `nsit pull`.
//!
//! `--json`: `{branch, created, sha}`.

use std::path::Path;

use git2::{Repository, RepositoryState};
use serde::Serialize;

use super::branch::{check_name, create as create_branch, find_local};
use crate::cli::{GlobalArgs, SwitchArgs};
use crate::error::NsitError;
use crate::git::abort::operation_name;
use crate::git::checkout::checkout_safely;
use crate::git::open_repo;
use crate::git::paths::listed;
use crate::git::stage::{current_branch, head_commit};
use crate::output::{for_display, strip_controls, Out};

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
    let name = for_display(&done.branch, tty);
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
    // A usage error (exit 2), as for `nsit pull` in the same state: nothing was asked wrongly of
    // the repository, the person has to finish what is under way first.
    match repo.state() {
        RepositoryState::Clean => {}
        RepositoryState::Merge => {
            return Err(NsitError::Usage(
                "a merge is in progress: finish it with nsit commit, or abandon it with \
                 nsit pull --abort, before switching branches"
                    .into(),
            ));
        }
        other => {
            return Err(NsitError::Usage(format!(
                "the repository is in the middle of {}: finish or abort that before switching \
                 branches",
                operation_name(other)
            )));
        }
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
    checkout_safely(repo, &target, |files| overwrite_error(name, files))?;
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

/// "Cannot switch to ...", with the files in the way named (or without them, when libgit2 does
/// not say which). The checkout itself is `git::checkout::checkout_safely`, the one `pull` uses.
fn overwrite_error(name: &str, files: &[String]) -> NsitError {
    let name = strip_controls(name);
    NsitError::Other(if files.is_empty() {
        format!(
            "cannot switch to {name}: it would overwrite local changes; commit or move them first"
        )
    } else {
        format!(
            "cannot switch to {name}: it would overwrite local changes in {}; commit or move \
             them first",
            listed(files)
        )
    })
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
        // A usage error, as it is for `nsit pull` in the same state.
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert_eq!(err.exit_code(), 2);
        let err = switch(&repo, "x", true).unwrap_err();
        assert_eq!(err.exit_code(), 2, "{err}");
        assert_eq!(on(&repo).as_deref(), Some("main"));
    }

    #[test]
    fn another_operation_in_progress_is_named_for_what_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let repo = two_branches(dir.path());
        std::fs::write(
            repo.path().join("CHERRY_PICK_HEAD"),
            format!("{}\n", repo.head().unwrap().target().unwrap()),
        )
        .unwrap();
        let err = switch(&repo, "feature", false).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert_eq!(err.exit_code(), 2);
        let text = err.to_string();
        assert!(text.contains("a cherry-pick"), "{text}");
        assert!(!text.contains("merge is in progress"), "{text}");
        assert_eq!(on(&repo).as_deref(), Some("main"));
    }

    #[test]
    fn an_ignored_file_in_the_way_of_a_tracked_one_stops_the_switch_and_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let repo = two_branches(dir.path());
        // Hidden from git the way a person does it locally, and made by hand: a build output or
        // a settings file. `feature` has a tracked file of that name.
        let info = repo.path().join("info");
        std::fs::create_dir_all(&info).unwrap();
        std::fs::write(info.join("exclude"), "only-feature.txt\n").unwrap();
        assert!(repo
            .status_should_ignore(Path::new("only-feature.txt"))
            .unwrap());
        write(dir.path(), "only-feature.txt", "my local settings\n");

        let err = switch(&repo, "feature", false).unwrap_err();
        assert!(matches!(err, NsitError::Other(_)), "{err:?}");
        assert!(err.to_string().contains("only-feature.txt"), "{err}");
        assert_eq!(
            read(dir.path(), "only-feature.txt"),
            "my local settings\n",
            "the ignored file was not overwritten"
        );
        assert_eq!(read(dir.path(), "f.txt"), "main\n", "nothing was written");
        assert_eq!(on(&repo).as_deref(), Some("main"));

        // Moved out of the way, the switch goes through.
        std::fs::remove_file(dir.path().join("only-feature.txt")).unwrap();
        switch(&repo, "feature", false).unwrap();
        assert_eq!(read(dir.path(), "only-feature.txt"), "x\n");
    }

    #[test]
    fn a_long_list_of_files_in_the_way_is_cut_like_pulls() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "f.txt", "main\n");
        switch(&repo, "topic", true).unwrap();
        for n in 0..12 {
            commit_file(&repo, &format!("n{n:02}.txt"), "theirs\n");
        }
        switch(&repo, "main", false).unwrap();
        for n in 0..12 {
            write(dir.path(), &format!("n{n:02}.txt"), "mine\n");
        }
        let err = switch(&repo, "topic", false).unwrap_err();
        let text = err.to_string();
        assert!(
            text.contains("n00.txt") && text.contains("n09.txt"),
            "{text}"
        );
        assert!(!text.contains("n10.txt"), "{text}");
        assert!(text.contains("and 2 more"), "{text}");
        assert!(!text.contains('\n'), "{text:?}");
        assert_eq!(read(dir.path(), "n05.txt"), "mine\n");
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
