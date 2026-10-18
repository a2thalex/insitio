//! `nsit commit`: stage every change (or, with `--staged`, only what `nsit add`
//! staged), run the secret guard, and commit.
//!
//! This file is the command line side: the message, the `--allow-secret` paths
//! typed relative to where nsit runs, and what is printed. Staging, the checks
//! and the commit itself are `git::commit::commit_changes`, which `nsit init`
//! shares; its module documents why a refusal leaves the index file untouched.

use std::path::Path;

use git2::Repository;
use serde::Serialize;

use super::commit_signature;
use crate::cli::{CommitArgs, GlobalArgs};
use crate::error::NsitError;
use crate::git::commit::{commit_changes, finish_message, Outcome, Request, Staging};
use crate::git::open_repo;
use crate::git::paths::repo_relative;
use crate::git::stage::merge_heads;
use crate::output::{for_display, Out};

/// `--json` for `nsit commit`: `{sha, files}`; `sha` is null when there was
/// nothing to commit.
#[derive(Debug, Serialize)]
struct CommitJson {
    sha: Option<String>,
    files: Vec<String>,
}

pub fn run(
    args: &CommitArgs,
    global: &GlobalArgs,
    out: &Out,
    base: &Path,
) -> Result<(), NsitError> {
    let repo = open_repo(base)?;
    let message = message_for(&repo, args.message.as_deref())?;
    let who = commit_signature(&repo, global)?;
    let allow_secret = args
        .allow_secret
        .iter()
        .map(|typed| allowed_path(&repo, base, typed))
        .collect::<Result<Vec<_>, _>>()?;
    let request = Request {
        message,
        staging: if args.staged {
            Staging::AsStaged
        } else {
            Staging::Everything
        },
        allow_secret,
    };
    let outcome = commit_changes(&repo, &who, &request)?;
    let json = match &outcome {
        Outcome::NothingToCommit => CommitJson {
            sha: None,
            files: Vec::new(),
        },
        Outcome::Committed(done) => CommitJson {
            sha: Some(done.id.to_string()),
            files: done.changes.iter().map(|c| c.path.clone()).collect(),
        },
    };
    out.data(&json, |_| describe(&outcome, out.tty))
}

/// The message to commit with: `-m`, or the message a merge in progress left
/// for its commit. Never an editor: nothing here waits for input.
fn message_for(repo: &Repository, given: Option<&str>) -> Result<String, NsitError> {
    match given {
        Some(text) => finish_message(text, None),
        None if !merge_heads(repo)?.is_empty() => {
            // Read as bytes: git wrote it, and a person may have edited it.
            let saved = std::fs::read(repo.path().join("MERGE_MSG")).unwrap_or_default();
            finish_message(&String::from_utf8_lossy(&saved), Some(b'#')).map_err(|_| {
                NsitError::Usage(
                    "finish the merge with a message: nsit commit -m \"Merge ...\"".into(),
                )
            })
        }
        None => Err(NsitError::Usage(
            "say what changed: nsit commit -m \"message\"".into(),
        )),
    }
}

/// `--allow-secret <typed>` as a repository-relative path of a file.
fn allowed_path(repo: &Repository, base: &Path, typed: &Path) -> Result<String, NsitError> {
    let path = repo_relative(repo, base, typed)?;
    if path.is_empty() {
        return Err(NsitError::Usage(
            "--allow-secret takes the path of a file".into(),
        ));
    }
    Ok(path)
}

/// The text for people: `[main abc1234] subject`, then one `A`/`M`/`D` line
/// per file; or `nothing to commit`.
fn describe(outcome: &Outcome, tty: bool) -> String {
    match outcome {
        Outcome::NothingToCommit => "nothing to commit".to_string(),
        Outcome::Committed(done) => {
            let sha = done.id.to_string();
            let on = done.branch.as_deref().unwrap_or("detached HEAD");
            let mut lines = vec![format!(
                "[{} {}] {}",
                for_display(on, tty),
                &sha[..7],
                for_display(&done.subject, tty)
            )];
            lines.extend(
                done.changes
                    .iter()
                    .map(|c| format!(" {}  {}", c.code, for_display(&c.path, tty))),
            );
            lines.join("\n")
        }
    }
}

#[cfg(test)]
mod tests {
    use git2::{Oid, Signature};

    use super::*;
    use crate::git::commit::{Change, Committed};
    use crate::test_support::{
        checkout_branch as checkout, commit_file, diverged_repo as diverged, local_repo,
        merge_branch as merge_in, write_file as write,
    };

    #[test]
    fn a_message_is_required_and_cannot_be_blank() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        for given in [None, Some(""), Some("  \n\t")] {
            let err = message_for(&repo, given).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{given:?}: {err:?}");
            assert_eq!(err.exit_code(), 2);
        }
        assert_eq!(message_for(&repo, Some("fix")).unwrap(), "fix\n");
    }

    #[test]
    fn a_merge_commit_can_take_its_message_from_the_merge() {
        let dir = tempfile::tempdir().unwrap();
        let repo = diverged(dir.path());
        checkout(&repo, "theirs");
        commit_file(&repo, "b.txt", "theirs\n");
        checkout(&repo, "main");
        commit_file(&repo, "c.txt", "ours\n");
        merge_in(&repo, "theirs");
        let message = message_for(&repo, None).unwrap();
        assert!(message.starts_with("Merge branch 'theirs'"), "{message}");
        assert!(
            !message.contains('#'),
            "comment lines are dropped: {message}"
        );
    }

    #[test]
    fn describe_gives_a_header_and_one_line_per_file() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, "a.txt", "a");
        write(&repo, "dir/b.txt", "b");
        let who = Signature::now("Test", "test@example.com").unwrap();
        let request = Request {
            message: finish_message("Add two", None).unwrap(),
            staging: Staging::Everything,
            allow_secret: Vec::new(),
        };
        let outcome = commit_changes(&repo, &who, &request).unwrap();
        let text = describe(&outcome, false);
        let lines: Vec<&str> = text.lines().collect();
        let Outcome::Committed(done) = &outcome else {
            panic!("committed")
        };
        assert_eq!(
            lines[0],
            format!("[main {}] Add two", &done.id.to_string()[..7])
        );
        assert_eq!(&lines[1..], [" A  a.txt", " A  dir/b.txt"]);
        assert_eq!(
            describe(&Outcome::NothingToCommit, false),
            "nothing to commit"
        );
    }

    #[test]
    fn describe_names_a_detached_head_and_cleans_text_for_a_terminal() {
        let done = Committed {
            id: Oid::from_str("0123456789abcdef0123456789abcdef01234567").unwrap(),
            branch: None,
            subject: "sub\u{1b}[31mject".to_string(),
            changes: vec![Change {
                code: 'M',
                path: "a\u{7}.txt".to_string(),
            }],
        };
        let outcome = Outcome::Committed(done);
        let plain = describe(&outcome, false);
        assert!(
            plain.starts_with("[detached HEAD 0123456] sub"),
            "{plain:?}"
        );
        let cleaned = describe(&outcome, true);
        assert_eq!(cleaned, "[detached HEAD 0123456] sub[31mject\n M  a.txt");
    }
}
