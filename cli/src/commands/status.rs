//! `nsit status`: what is staged, what is changed but not staged, what is new,
//! what is in conflict, and how the branch stands against its upstream.
//!
//! `--json` is `{branch, upstream, ahead, behind, staged[], unstaged[],
//! untracked[], conflicted[]}`: the four lists hold repository-relative paths
//! with forward slashes. `branch` is null on a detached `HEAD`; `upstream` is
//! null (and `ahead` and `behind` are 0) when the branch has none. A file
//! staged and then edited again is in both `staged` and `unstaged`; a file in
//! conflict is only in `conflicted`. Ignored files are not listed anywhere.

use std::path::Path;

use git2::{BranchType, Repository, Status, StatusOptions};
use serde::Serialize;

use crate::cli::GlobalArgs;
use crate::error::NsitError;
use crate::git::open_repo;
use crate::git::stage::{current_branch, head_commit};
use crate::output::{for_display, Out};

/// `--json` for `nsit status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StatusJson {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub staged: Vec<String>,
    pub unstaged: Vec<String>,
    pub untracked: Vec<String>,
    pub conflicted: Vec<String>,
}

/// A changed path and the letter that says how: `A` added, `M` modified,
/// `D` deleted, `R` renamed, `T` type changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub code: char,
    pub path: String,
}

/// Everything `status` knows. The JSON is made from it, and so is the text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub json: StatusJson,
    pub staged: Vec<Entry>,
    pub unstaged: Vec<Entry>,
    /// Where `HEAD` is when it is not on a branch (the short id).
    pub detached_at: Option<String>,
    /// The branch has no commit yet.
    pub no_commits: bool,
}

pub fn run(_global: &GlobalArgs, out: &Out, base: &Path) -> Result<(), NsitError> {
    let repo = open_repo(base)?;
    let report = collect(&repo)?;
    out.data(&report.json, |_| render(&report, out.tty))
}

/// Read the state of `repo`.
pub fn collect(repo: &Repository) -> Result<Report, NsitError> {
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .renames_head_to_index(true);
    let statuses = repo.statuses(Some(&mut options))?;

    let (mut staged, mut unstaged) = (Vec::new(), Vec::new());
    let (mut untracked, mut conflicted) = (Vec::new(), Vec::new());
    for item in statuses.iter() {
        let path = String::from_utf8_lossy(item.path_bytes()).into_owned();
        let status = item.status();
        if status.contains(Status::CONFLICTED) {
            conflicted.push(path);
            continue;
        }
        if let Some(code) = staged_code(status) {
            staged.push(Entry {
                code,
                path: path.clone(),
            });
        }
        if let Some(code) = unstaged_code(status) {
            unstaged.push(Entry {
                code,
                path: path.clone(),
            });
        }
        if status.contains(Status::WT_NEW) {
            untracked.push(path);
        }
    }

    let branch = current_branch(repo);
    let head = head_commit(repo)?;
    let detached_at = match (&branch, &head) {
        (None, Some(commit)) => Some(commit.id().to_string()[..7].to_string()),
        _ => None,
    };
    let (upstream, ahead, behind) = match &branch {
        Some(name) => against_upstream(repo, name),
        None => (None, 0, 0),
    };
    let paths = |entries: &[Entry]| entries.iter().map(|e| e.path.clone()).collect();
    Ok(Report {
        json: StatusJson {
            branch,
            upstream,
            ahead,
            behind,
            staged: paths(&staged),
            unstaged: paths(&unstaged),
            untracked,
            conflicted,
        },
        staged,
        unstaged,
        detached_at,
        no_commits: head.is_none(),
    })
}

fn staged_code(status: Status) -> Option<char> {
    [
        (Status::INDEX_NEW, 'A'),
        (Status::INDEX_MODIFIED, 'M'),
        (Status::INDEX_DELETED, 'D'),
        (Status::INDEX_RENAMED, 'R'),
        (Status::INDEX_TYPECHANGE, 'T'),
    ]
    .into_iter()
    .find(|(flag, _)| status.contains(*flag))
    .map(|(_, code)| code)
}

fn unstaged_code(status: Status) -> Option<char> {
    [
        (Status::WT_MODIFIED, 'M'),
        (Status::WT_DELETED, 'D'),
        (Status::WT_RENAMED, 'R'),
        (Status::WT_TYPECHANGE, 'T'),
    ]
    .into_iter()
    .find(|(flag, _)| status.contains(*flag))
    .map(|(_, code)| code)
}

/// The upstream of local branch `name` (`origin/main`) and how many commits
/// the branch is ahead of and behind it. No upstream, an upstream that has not
/// been fetched yet, or a branch with no commits: `(None, 0, 0)`.
fn against_upstream(repo: &Repository, name: &str) -> (Option<String>, usize, usize) {
    let Ok(branch) = repo.find_branch(name, BranchType::Local) else {
        return (None, 0, 0);
    };
    let Ok(upstream) = branch.upstream() else {
        return (None, 0, 0);
    };
    let label = upstream.name().ok().flatten().map(str::to_string);
    let (Some(local), Some(remote)) = (branch.get().target(), upstream.get().target()) else {
        return (label, 0, 0);
    };
    let (ahead, behind) = repo.graph_ahead_behind(local, remote).unwrap_or((0, 0));
    (label, ahead, behind)
}

/// The text for people, in sections like git's.
pub fn render(report: &Report, tty: bool) -> String {
    let clean = |text: &str| for_display(text, tty);
    let json = &report.json;
    let mut lines = Vec::new();
    match (&json.branch, &report.detached_at) {
        (Some(branch), _) => lines.push(format!("On branch {}", clean(branch))),
        (None, Some(at)) => lines.push(format!("HEAD detached at {at}")),
        (None, None) => lines.push("HEAD is not on a branch".to_string()),
    }
    if report.no_commits {
        lines.push("No commits yet.".to_string());
    }
    if let Some(upstream) = &json.upstream {
        let upstream = clean(upstream);
        lines.push(match (json.ahead, json.behind) {
            (0, 0) => format!("Up to date with '{upstream}'."),
            (ahead, 0) => format!("Ahead of '{upstream}' by {}.", commits(ahead)),
            (0, behind) => format!("Behind '{upstream}' by {}.", commits(behind)),
            (ahead, behind) => format!(
                "Diverged from '{upstream}': {} ahead, {} behind.",
                commits(ahead),
                commits(behind)
            ),
        });
    }

    let section = |lines: &mut Vec<String>, title: &str, rows: Vec<String>| {
        if !rows.is_empty() {
            lines.push(String::new());
            lines.push(format!("{title}:"));
            lines.extend(rows);
        }
    };
    let lettered = |entries: &[Entry]| -> Vec<String> {
        entries
            .iter()
            .map(|e| format!("  {}  {}", e.code, clean(&e.path)))
            .collect()
    };
    let plain = |paths: &[String]| -> Vec<String> {
        paths.iter().map(|p| format!("  {}", clean(p))).collect()
    };
    section(&mut lines, "Conflicted", plain(&json.conflicted));
    section(&mut lines, "Staged", lettered(&report.staged));
    section(&mut lines, "Unstaged", lettered(&report.unstaged));
    section(&mut lines, "Untracked", plain(&json.untracked));

    let clean_tree = json.staged.is_empty()
        && json.unstaged.is_empty()
        && json.untracked.is_empty()
        && json.conflicted.is_empty();
    if clean_tree && !report.no_commits {
        lines.push(String::new());
        lines.push("nothing to commit, working tree clean".to_string());
    }
    lines.join("\n")
}

fn commits(n: usize) -> String {
    if n == 1 {
        "1 commit".to_string()
    } else {
        format!("{n} commits")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::stage::{stage_all, stage_paths};
    use crate::test_support::{
        checkout_branch, commit_file, diverged_repo, local_repo, merge_branch, write_file as write,
    };

    fn stage(repo: &Repository, rels: &[&str]) {
        let mut index = repo.index().unwrap();
        let rels: Vec<String> = rels.iter().map(|s| s.to_string()).collect();
        stage_paths(repo, &mut index, &rels).unwrap();
        index.write().unwrap();
    }

    #[test]
    fn a_clean_repository_has_four_empty_lists_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "a");
        let report = collect(&repo).unwrap();
        assert_eq!(
            report.json,
            StatusJson {
                branch: Some("main".into()),
                upstream: None,
                ahead: 0,
                behind: 0,
                staged: vec![],
                unstaged: vec![],
                untracked: vec![],
                conflicted: vec![],
            }
        );
        let text = render(&report, false);
        assert_eq!(
            text,
            "On branch main\n\nnothing to commit, working tree clean"
        );
    }

    #[test]
    fn the_json_has_exactly_the_documented_fields_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "a");
        let report = collect(&repo).unwrap();
        let text = serde_json::to_string(&report.json).unwrap();
        assert_eq!(
            text,
            r#"{"branch":"main","upstream":null,"ahead":0,"behind":0,"staged":[],"unstaged":[],"untracked":[],"conflicted":[]}"#
        );
    }

    #[test]
    fn staged_unstaged_and_untracked_files_are_told_apart() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "keep.txt", "1");
        commit_file(&repo, "edit.txt", "1");
        commit_file(&repo, "gone.txt", "1");
        write(&repo, "staged-new.txt", "n");
        write(&repo, "edit.txt", "2");
        std::fs::remove_file(dir.path().join("gone.txt")).unwrap();
        write(&repo, "d/untracked.txt", "u");
        stage(&repo, &["staged-new.txt", "gone.txt"]);
        let report = collect(&repo).unwrap();
        assert_eq!(report.json.staged, ["gone.txt", "staged-new.txt"]);
        assert_eq!(report.json.unstaged, ["edit.txt"]);
        assert_eq!(report.json.untracked, ["d/untracked.txt"]);
        assert!(report.json.conflicted.is_empty());
        let codes: Vec<(char, &str)> = report
            .staged
            .iter()
            .map(|e| (e.code, e.path.as_str()))
            .collect();
        assert_eq!(codes, [('D', "gone.txt"), ('A', "staged-new.txt")]);
        assert_eq!(report.unstaged[0].code, 'M');
    }

    #[test]
    fn a_file_edited_after_staging_is_both_staged_and_unstaged() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "1");
        write(&repo, "a.txt", "2");
        stage(&repo, &["a.txt"]);
        write(&repo, "a.txt", "3");
        let report = collect(&repo).unwrap();
        assert_eq!(report.json.staged, ["a.txt"]);
        assert_eq!(report.json.unstaged, ["a.txt"]);
    }

    #[test]
    fn ignored_files_are_not_listed_and_untracked_directories_are_expanded() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, ".gitignore", "dist/\n*.log\n");
        write(&repo, "dist/out.js", "x");
        write(&repo, "run.log", "x");
        write(&repo, "src/a.rs", "a");
        write(&repo, "src/deep/b.rs", "b");
        let report = collect(&repo).unwrap();
        assert_eq!(
            report.json.untracked,
            [".gitignore", "src/a.rs", "src/deep/b.rs"]
        );
    }

    #[test]
    fn before_the_first_commit_everything_staged_is_new() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, "a.txt", "a");
        write(&repo, "b.txt", "b");
        stage(&repo, &["a.txt"]);
        let report = collect(&repo).unwrap();
        assert_eq!(report.json.branch.as_deref(), Some("main"));
        assert_eq!(report.json.staged, ["a.txt"]);
        assert_eq!(report.json.untracked, ["b.txt"]);
        assert!(report.no_commits);
        let text = render(&report, false);
        assert!(
            text.starts_with("On branch main\nNo commits yet.\n"),
            "{text}"
        );
    }

    #[test]
    fn a_detached_head_has_no_branch() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "a");
        let id = repo.head().unwrap().target().unwrap();
        repo.set_head_detached(id).unwrap();
        let report = collect(&repo).unwrap();
        assert_eq!(report.json.branch, None);
        assert_eq!(report.json.upstream, None);
        assert_eq!(report.detached_at.as_deref(), Some(&id.to_string()[..7]));
        assert!(render(&report, false).starts_with("HEAD detached at "));
    }

    /// `repo` with `main` tracking `origin/main`, `ahead` commits ahead and
    /// `behind` behind. `origin/main` is a plain ref here: nothing needs a server.
    fn tracking(repo: &Repository, ahead: usize, behind: usize) {
        commit_file(repo, "base.txt", "base");
        let base = repo.head().unwrap().peel_to_commit().unwrap();
        // The remote side: `behind` commits on top of base.
        let mut remote_tip = base.clone();
        for i in 0..behind {
            let tree = remote_tip.tree().unwrap();
            let sig = git2::Signature::now("R", "r@example.com").unwrap();
            let id = repo
                .commit(
                    None,
                    &sig,
                    &sig,
                    &format!("remote {i}"),
                    &tree,
                    &[&remote_tip],
                )
                .unwrap();
            remote_tip = repo.find_commit(id).unwrap();
        }
        repo.reference("refs/remotes/origin/main", remote_tip.id(), true, "test")
            .unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("branch.main.remote", "origin").unwrap();
        config
            .set_str("branch.main.merge", "refs/heads/main")
            .unwrap();
        config
            .set_str("remote.origin.url", "https://git.example.invalid/ada/x.git")
            .unwrap();
        config
            .set_str("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
            .unwrap();
        for i in 0..ahead {
            commit_file(repo, &format!("local{i}.txt"), "x");
        }
    }

    #[test]
    fn ahead_and_behind_are_counted_against_the_upstream() {
        for (ahead, behind, text) in [
            (0, 0, "Up to date with 'origin/main'."),
            (2, 0, "Ahead of 'origin/main' by 2 commits."),
            (1, 0, "Ahead of 'origin/main' by 1 commit."),
            (0, 3, "Behind 'origin/main' by 3 commits."),
            (
                1,
                2,
                "Diverged from 'origin/main': 1 commit ahead, 2 commits behind.",
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let repo = local_repo(dir.path());
            tracking(&repo, ahead, behind);
            let report = collect(&repo).unwrap();
            assert_eq!(report.json.upstream.as_deref(), Some("origin/main"));
            assert_eq!(
                (report.json.ahead, report.json.behind),
                (ahead, behind),
                "{text}"
            );
            assert!(render(&report, false).contains(text), "{text}");
        }
    }

    #[test]
    fn an_upstream_that_was_never_fetched_counts_as_none() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "a");
        let mut config = repo.config().unwrap();
        config.set_str("branch.main.remote", "origin").unwrap();
        config
            .set_str("branch.main.merge", "refs/heads/main")
            .unwrap();
        let report = collect(&repo).unwrap();
        assert_eq!(report.json.upstream, None);
        assert_eq!((report.json.ahead, report.json.behind), (0, 0));
        assert!(!render(&report, false).contains("origin"));
    }

    #[test]
    fn a_file_in_conflict_is_listed_only_as_conflicted() {
        let dir = tempfile::tempdir().unwrap();
        let repo = diverged_repo(dir.path());
        checkout_branch(&repo, "theirs");
        commit_file(&repo, "a.txt", "theirs\n");
        checkout_branch(&repo, "main");
        commit_file(&repo, "a.txt", "ours\n");
        merge_branch(&repo, "theirs");

        let report = collect(&repo).unwrap();
        assert_eq!(report.json.conflicted, ["a.txt"]);
        assert!(report.json.staged.is_empty() && report.json.unstaged.is_empty());
        assert!(report.json.untracked.is_empty());
        let text = render(&report, false);
        assert!(text.contains("Conflicted:\n  a.txt"), "{text}");
        assert!(!text.contains("nothing to commit"), "{text}");
    }

    #[test]
    fn the_text_has_git_like_sections_with_a_letter_per_change() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "edit.txt", "1");
        write(&repo, "edit.txt", "2");
        write(&repo, "new.txt", "n");
        write(&repo, "other.txt", "o");
        stage(&repo, &["new.txt"]);
        let text = render(&collect(&repo).unwrap(), false);
        assert_eq!(
            text,
            "On branch main\n\nStaged:\n  A  new.txt\n\nUnstaged:\n  M  edit.txt\n\nUntracked:\n  other.txt"
        );
    }

    #[test]
    fn file_names_are_cleaned_for_a_terminal_only() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "a");
        let mut report = collect(&repo).unwrap();
        report.json.untracked = vec!["x\u{1b}[31m.txt".to_string()];
        assert!(render(&report, false).contains('\u{1b}'));
        assert!(!render(&report, true).contains('\u{1b}'));
    }

    #[test]
    fn staging_everything_then_reading_does_not_need_a_commit() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, "a.txt", "a");
        let mut index = repo.index().unwrap();
        stage_all(&mut index).unwrap();
        index.write().unwrap();
        assert_eq!(collect(&repo).unwrap().json.staged, ["a.txt"]);
    }
}
