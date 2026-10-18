//! `nsit commit`: stage every change (or, with `--staged`, only what `nsit add`
//! staged), run the secret guard, and commit.
//!
//! The order is what makes a refusal safe: everything is staged **in memory**,
//! the guard looks at what would be committed, and only when it passes is the
//! index written and the commit made. A refusal (exit 5) therefore leaves the
//! index file exactly as it was; so does any other error before that point. The
//! one thing written before the commit is `.nsit-allow-secrets`, and only for
//! `--allow-secret` paths once the guard has nothing left to refuse.
//!
//! A merge in progress (`MERGE_HEAD`, left by `nsit pull`) is finished by the
//! same command: two parents, and the merge state is cleared.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::OnceLock;

use git2::{message_prettify, Commit, Delta, Oid, Repository, Signature, Tree};
use regex::bytes::Regex;
use serde::Serialize;

use super::commit_signature;
use crate::cli::{CommitArgs, GlobalArgs};
use crate::error::NsitError;
use crate::git::open_repo;
use crate::git::paths::repo_relative;
use crate::git::secrets::{allow, allowed_paths, scan};
use crate::git::stage::{
    changed_paths, conflicted_paths, current_branch, entry, head_commit, merge_heads, read_start,
    stage_all,
};
use crate::output::{clean_for_terminal, Out};

/// How much of a file that was in conflict is read to see whether markers are left.
const MARKER_SCAN_LIMIT: usize = 1024 * 1024;

/// What goes into the commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Staging {
    /// Stage every change in the working directory first (`nsit commit`).
    Everything,
    /// Commit the index as it is (`nsit commit --staged`).
    AsStaged,
}

/// One commit to make.
#[derive(Debug, Clone)]
pub struct Request {
    /// The finished message (see `finish_message`).
    pub message: String,
    pub staging: Staging,
    /// Repository-relative paths to record in `.nsit-allow-secrets`.
    pub allow_secret: Vec<String>,
}

/// A path the commit adds (`A`), changes (`M`), deletes (`D`), renames (`R`) or
/// whose type it changes (`T`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    pub code: char,
    pub path: String,
}

#[derive(Debug)]
pub struct Committed {
    pub id: Oid,
    /// `None` on a detached `HEAD`.
    pub branch: Option<String>,
    pub subject: String,
    pub changes: Vec<Change>,
}

#[derive(Debug)]
pub enum Outcome {
    /// The tree is what `HEAD` already has and no merge is waiting: nothing made.
    NothingToCommit,
    Committed(Committed),
}

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

/// `text` as git stores a commit message: no blank lines at the ends, no
/// trailing spaces, a final newline. `comment` lines (a merge's `# Conflicts:`)
/// are dropped when a comment character is given. A message with nothing in it
/// is a usage error.
fn finish_message(text: &str, comment: Option<u8>) -> Result<String, NsitError> {
    let message = message_prettify(text, comment)
        .map_err(|_| NsitError::Usage("the commit message cannot be used".into()))?;
    if message.trim().is_empty() {
        return Err(NsitError::Usage("the commit message is empty".into()));
    }
    Ok(message)
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

/// Make the commit `request` describes, or say there is nothing to commit.
///
/// Errors, none of them leaving anything half done: `Conflict` (exit 4) while
/// files from a merge are unresolved or still hold conflict markers,
/// `SecretGuard` (exit 5) listing every refused path, `Usage` for an
/// `--allow-secret` path that is not part of the commit.
pub fn commit_changes(
    repo: &Repository,
    who: &Signature<'_>,
    request: &Request,
) -> Result<Outcome, NsitError> {
    let mut index = repo.index()?;
    let head = head_commit(repo)?;
    let merging = merge_heads(repo)?;
    let in_conflict = conflicted_paths(&index)?;

    if request.staging == Staging::Everything {
        stage_all(&mut index)?;
    }
    // Still unresolved after staging: only `--staged` can leave conflicts.
    let unresolved = conflicted_paths(&index)?;
    if !unresolved.is_empty() {
        return Err(NsitError::Conflict(unresolved));
    }
    // Staging a file with conflict markers resolves it as far as the index is
    // concerned; committing the markers is almost never what anyone wants.
    let marked = with_conflict_markers(repo, &index, &in_conflict)?;
    if !marked.is_empty() {
        return Err(NsitError::Conflict(marked));
    }

    // The guard looks at what this commit adds or changes: against HEAD, or in a
    // merge against the branch being merged in (the merged-in side is not ours
    // to vouch for; what differs from it is).
    let head_tree = head.as_ref().map(Commit::tree).transpose()?;
    let merged_tree = match merging.first() {
        Some(oid) => Some(repo.find_commit(*oid)?.tree()?),
        None => None,
    };
    let candidates = changed_paths(repo, &index, merged_tree.as_ref().or(head_tree.as_ref()))?;
    let pending = pending_allowances(repo, &index, &request.allow_secret)?;
    // `scan` reads the repository's index as it is in memory, which is the one
    // filled above. `--allow-secret` paths are let through here, before they are
    // recorded: nothing is written for a commit that is still refused.
    let mut hits = scan(repo, &candidates)?;
    hits.retain(|hit| !pending.contains(&hit.path));
    if !hits.is_empty() {
        return Err(NsitError::SecretGuard(hits));
    }
    // Past the guard: record the allowances (this stages `.nsit-allow-secrets`
    // in the same index, so they travel with this commit).
    for path in &pending {
        allow(repo, path)?;
    }

    let tree_id = index.write_tree()?;
    let same_as_head = head_tree.as_ref().map(Tree::id) == Some(tree_id);
    let nothing_at_all = head.is_none() && index.is_empty();
    if merging.is_empty() && (same_as_head || nothing_at_all) {
        return Ok(Outcome::NothingToCommit);
    }

    index.write()?;
    let tree = repo.find_tree(tree_id)?;
    let changes = changes_between(repo, head_tree.as_ref(), &tree)?;
    let mut parents: Vec<Commit<'_>> = head.into_iter().collect();
    for oid in &merging {
        parents.push(repo.find_commit(*oid)?);
    }
    let parent_refs: Vec<&Commit<'_>> = parents.iter().collect();
    let id = repo.commit(
        Some("HEAD"),
        who,
        who,
        &request.message,
        &tree,
        &parent_refs,
    )?;
    if !merging.is_empty() {
        repo.cleanup_state()?;
    }
    Ok(Outcome::Committed(Committed {
        id,
        branch: current_branch(repo),
        subject: request
            .message
            .lines()
            .next()
            .unwrap_or_default()
            .to_string(),
        changes,
    }))
}

/// The `--allow-secret` paths that `.nsit-allow-secrets` does not list yet,
/// each once. Every one has to be part of this commit: a path that is not
/// staged (a typo, or something `.gitignore` hides) would record an allowance for
/// nothing.
fn pending_allowances(
    repo: &Repository,
    index: &git2::Index,
    wanted: &[String],
) -> Result<Vec<String>, NsitError> {
    for path in wanted {
        if entry(index, path).is_none() {
            return Err(NsitError::Usage(format!(
                "--allow-secret {path}: that file is not part of this commit \
                 (is it missing, or ignored by .gitignore?)"
            )));
        }
    }
    let listed = allowed_paths(repo, index)?;
    let pending: BTreeSet<&String> = wanted.iter().filter(|p| !listed.contains(*p)).collect();
    Ok(pending.into_iter().cloned().collect())
}

/// Which of the files that were in conflict (`paths`) still have conflict
/// markers in what is staged: a line starting `<<<<<<< ` and one starting
/// `>>>>>>> `, as libgit2 and git write them.
fn with_conflict_markers(
    repo: &Repository,
    index: &git2::Index,
    paths: &[String],
) -> Result<Vec<String>, NsitError> {
    static MARKERS: OnceLock<(Regex, Regex)> = OnceLock::new();
    let (open, close) = MARKERS.get_or_init(|| {
        (
            Regex::new(r"(?m)^<<<<<<< ").expect("a valid built-in pattern"),
            Regex::new(r"(?m)^>>>>>>> ").expect("a valid built-in pattern"),
        )
    });
    let mut marked = Vec::new();
    for path in paths {
        let Some(staged) = entry(index, path) else {
            continue;
        };
        let start = read_start(repo, staged.id, MARKER_SCAN_LIMIT)?;
        if open.is_match(&start) && close.is_match(&start) {
            marked.push(path.clone());
        }
    }
    Ok(marked)
}

/// What a commit of `new` on top of `old` (`None`: no commits yet) changes.
fn changes_between(
    repo: &Repository,
    old: Option<&Tree<'_>>,
    new: &Tree<'_>,
) -> Result<Vec<Change>, NsitError> {
    let diff = repo.diff_tree_to_tree(old, Some(new), None)?;
    Ok(diff
        .deltas()
        .filter_map(|delta| {
            let code = match delta.status() {
                Delta::Added => 'A',
                Delta::Deleted => 'D',
                Delta::Renamed => 'R',
                Delta::Typechange => 'T',
                _ => 'M',
            };
            let path = delta.new_file().path().or(delta.old_file().path())?;
            Some(Change {
                code,
                path: crate::git::paths::slash(path),
            })
        })
        .collect())
}

/// The text for people: `[main abc1234] subject`, then one `A`/`M`/`D` line
/// per file; or `nothing to commit`.
fn describe(outcome: &Outcome, tty: bool) -> String {
    let clean = |text: &str| {
        if tty {
            clean_for_terminal(text)
        } else {
            text.to_string()
        }
    };
    match outcome {
        Outcome::NothingToCommit => "nothing to commit".to_string(),
        Outcome::Committed(done) => {
            let sha = done.id.to_string();
            let on = done.branch.as_deref().unwrap_or("detached HEAD");
            let mut lines = vec![format!(
                "[{} {}] {}",
                clean(on),
                &sha[..7],
                clean(&done.subject)
            )];
            lines.extend(
                done.changes
                    .iter()
                    .map(|c| format!(" {}  {}", c.code, clean(&c.path))),
            );
            lines.join("\n")
        }
    }
}

#[cfg(test)]
mod tests {
    use git2::{BranchType, ErrorCode};

    use super::*;
    use crate::git::secrets::ALLOW_FILE;
    use crate::test_support::{commit_file, local_repo};

    fn write(repo: &Repository, rel: &str, text: &str) {
        let path = repo.workdir().unwrap().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn me() -> Signature<'static> {
        Signature::now("Test", "test@example.com").unwrap()
    }

    fn request(message: &str) -> Request {
        Request {
            message: finish_message(message, None).unwrap(),
            staging: Staging::Everything,
            allow_secret: Vec::new(),
        }
    }

    fn commit(repo: &Repository, message: &str) -> Outcome {
        commit_changes(repo, &me(), &request(message)).unwrap()
    }

    fn made(outcome: Outcome) -> Committed {
        match outcome {
            Outcome::Committed(done) => done,
            Outcome::NothingToCommit => panic!("expected a commit"),
        }
    }

    fn refused(repo: &Repository, request: &Request) -> Vec<(String, String)> {
        match commit_changes(repo, &me(), request) {
            Err(NsitError::SecretGuard(hits)) => {
                hits.into_iter().map(|h| (h.path, h.reason)).collect()
            }
            other => panic!("expected the secret guard, got {other:?}"),
        }
    }

    fn paths(done: &Committed) -> Vec<String> {
        done.changes.iter().map(|c| c.path.clone()).collect()
    }

    /// The files in HEAD's tree, as they are in a fresh handle on the repository.
    fn committed_files(dir: &Path) -> Vec<String> {
        let repo = Repository::open(dir).unwrap();
        let tree = repo.head().unwrap().peel_to_tree().unwrap();
        let mut names = Vec::new();
        tree.walk(git2::TreeWalkMode::PreOrder, |root, entry| {
            if entry.kind() == Some(git2::ObjectType::Blob) {
                names.push(format!("{root}{}", entry.name().unwrap()));
            }
            0
        })
        .unwrap();
        names
    }

    /// What is staged on disk: a fresh handle, so nothing in memory is counted.
    fn staged_on_disk(dir: &Path) -> Vec<String> {
        let repo = Repository::open(dir).unwrap();
        let mut index = repo.index().unwrap();
        index.read(true).unwrap();
        index
            .iter()
            .map(|e| String::from_utf8_lossy(&e.path).into_owned())
            .collect()
    }

    fn head_id(repo: &Repository) -> Option<Oid> {
        repo.head().ok().and_then(|h| h.target())
    }

    // ---- what gets committed -----------------------------------------------------

    #[test]
    fn commit_stages_new_and_modified_files_but_not_ignored_ones() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, ".gitignore", "dist/\n");
        write(&repo, "a.txt", "one");
        write(&repo, "src/b.txt", "bee");
        write(&repo, "dist/out.js", "ignored");
        let first = made(commit(&repo, "first"));
        assert_eq!(paths(&first), [".gitignore", "a.txt", "src/b.txt"]);
        assert!(first.changes.iter().all(|c| c.code == 'A'));
        assert_eq!(
            committed_files(dir.path()),
            [".gitignore", "a.txt", "src/b.txt"]
        );

        write(&repo, "a.txt", "one, edited");
        write(&repo, "c.txt", "sea");
        write(&repo, "dist/more.js", "ignored too");
        std::fs::remove_file(dir.path().join("src/b.txt")).unwrap();
        let second = made(commit(&repo, "second"));
        let by_code: Vec<(char, &str)> = second
            .changes
            .iter()
            .map(|c| (c.code, c.path.as_str()))
            .collect();
        assert_eq!(
            by_code,
            [('M', "a.txt"), ('A', "c.txt"), ('D', "src/b.txt")]
        );
        assert_eq!(
            committed_files(dir.path()),
            [".gitignore", "a.txt", "c.txt"]
        );
        // The index on disk matches what was committed.
        assert_eq!(staged_on_disk(dir.path()), [".gitignore", "a.txt", "c.txt"]);
    }

    #[test]
    fn the_commit_has_the_message_with_a_final_newline_and_the_given_author() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, "a.txt", "x");
        // Trailing spaces and runs of blank lines go, as git's own cleanup does.
        let done = made(commit(&repo, "\n\nAdd a  \n\n\n\nbecause  \n\n"));
        let found = repo.find_commit(done.id).unwrap();
        assert_eq!(found.message().unwrap(), "Add a\n\nbecause\n");
        assert_eq!(found.author().name().unwrap(), "Test");
        assert_eq!(found.parent_count(), 0);
        assert_eq!(done.subject, "Add a");
        assert_eq!(done.branch.as_deref(), Some("main"));
        assert_eq!(head_id(&repo), Some(done.id));
        assert_eq!(repo.head().unwrap().shorthand().unwrap(), "main");
    }

    #[test]
    fn the_second_commit_has_the_first_as_its_parent() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, "a.txt", "1");
        let first = made(commit(&repo, "first"));
        write(&repo, "a.txt", "2");
        let second = made(commit(&repo, "second"));
        let found = repo.find_commit(second.id).unwrap();
        assert_eq!(found.parent_count(), 1);
        assert_eq!(found.parent_id(0).unwrap(), first.id);
    }

    #[test]
    fn nothing_to_commit_when_the_tree_matches_head() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        // No commits yet and nothing in the directory.
        assert!(matches!(commit(&repo, "x"), Outcome::NothingToCommit));
        assert_eq!(head_id(&repo), None);

        write(&repo, "a.txt", "1");
        let first = made(commit(&repo, "first"));
        assert!(matches!(commit(&repo, "again"), Outcome::NothingToCommit));
        assert_eq!(head_id(&repo), Some(first.id), "no commit may be made");
        // An edit that is changed back is no change.
        write(&repo, "a.txt", "2");
        write(&repo, "a.txt", "1");
        assert!(matches!(commit(&repo, "again"), Outcome::NothingToCommit));
    }

    #[test]
    fn staged_commits_only_what_was_added() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, "a.txt", "a");
        write(&repo, "b.txt", "b");
        {
            let mut index = repo.index().unwrap();
            crate::git::stage::stage_paths(&repo, &mut index, &["a.txt".to_string()]).unwrap();
            index.write().unwrap();
        }
        let staged = Request {
            staging: Staging::AsStaged,
            ..request("only a")
        };
        let done = made(commit_changes(&repo, &me(), &staged).unwrap());
        assert_eq!(paths(&done), ["a.txt"]);
        assert_eq!(committed_files(dir.path()), ["a.txt"]);
        // `--staged` with nothing staged is nothing to commit, not a sweep.
        let again = commit_changes(&repo, &me(), &staged).unwrap();
        assert!(matches!(again, Outcome::NothingToCommit));
        assert_eq!(staged_on_disk(dir.path()), ["a.txt"]);
    }

    // ---- messages ----------------------------------------------------------------

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

    // ---- the secret guard --------------------------------------------------------

    #[test]
    fn env_files_are_refused_and_example_env_files_are_not() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, ".env", "TOKEN=abc\n");
        write(&repo, ".env.example", "TOKEN=\n");
        write(&repo, "src/.env.local", "x");
        let hits = refused(&repo, &request("x"));
        assert_eq!(
            hits,
            [
                (".env".to_string(), "name matches .env".to_string()),
                (
                    "src/.env.local".to_string(),
                    "name matches .env.*".to_string()
                ),
            ]
        );
        // Without the secrets it commits, example file included.
        std::fs::remove_file(dir.path().join(".env")).unwrap();
        std::fs::remove_file(dir.path().join("src/.env.local")).unwrap();
        let done = made(commit(&repo, "x"));
        assert_eq!(paths(&done), [".env.example"]);
    }

    #[test]
    fn a_private_key_in_any_file_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(
            &repo,
            "notes.txt",
            "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n",
        );
        write(&repo, "fine.txt", "nothing here");
        let hits = refused(&repo, &request("x"));
        assert_eq!(
            hits,
            [(
                "notes.txt".to_string(),
                "contains a private key".to_string()
            )]
        );
    }

    #[test]
    fn the_refusal_never_includes_the_secret() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let secret = format!("ghp_{}", "Ab1".repeat(14));
        write(&repo, "deploy.sh", &format!("export TOKEN={secret}\n"));
        let err = commit_changes(&repo, &me(), &request("x")).unwrap_err();
        assert_eq!(err.exit_code(), 5);
        let text = err.to_string();
        assert!(
            text.contains("deploy.sh") && text.contains("GitHub token"),
            "{text}"
        );
        assert!(
            !text.contains(&secret) && !text.contains("Ab1Ab1"),
            "{text}"
        );
    }

    #[test]
    fn a_refused_commit_leaves_the_index_as_it_was() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, "a.txt", "a");
        {
            // The user staged a.txt with `nsit add` ...
            let mut index = repo.index().unwrap();
            crate::git::stage::stage_paths(&repo, &mut index, &["a.txt".to_string()]).unwrap();
            index.write().unwrap();
        }
        // ... then created .env and a new file, and ran `nsit commit -m x`.
        write(&repo, ".env", "TOKEN=abc\n");
        write(&repo, "b.txt", "b");
        assert_eq!(refused(&repo, &request("x")).len(), 1);

        assert_eq!(staged_on_disk(dir.path()), ["a.txt"]);
        let fresh = Repository::open(dir.path()).unwrap();
        assert_eq!(head_id(&fresh), None, "no commit was made");
        let mut options = git2::StatusOptions::new();
        options.include_untracked(true);
        let statuses = fresh.statuses(Some(&mut options)).unwrap();
        let untracked: Vec<String> = statuses
            .iter()
            .filter(|s| s.status() == git2::Status::WT_NEW)
            .filter_map(|s| s.path().ok().map(str::to_string))
            .collect();
        assert_eq!(untracked, [".env", "b.txt"]);
    }

    #[test]
    fn a_refused_commit_leaves_staged_edits_and_deletions_as_they_were() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "keep.txt", "1");
        commit_file(&repo, "drop.txt", "1");
        let before = staged_on_disk(dir.path());
        write(&repo, "keep.txt", "2");
        std::fs::remove_file(dir.path().join("drop.txt")).unwrap();
        write(&repo, "server.pem", "x");
        assert_eq!(refused(&repo, &request("x")).len(), 1);
        assert_eq!(staged_on_disk(dir.path()), before);
        let fresh = Repository::open(dir.path()).unwrap();
        let index = fresh.index().unwrap();
        let kept = index.get_path(Path::new("keep.txt"), 0).unwrap();
        assert_eq!(fresh.find_blob(kept.id).unwrap().content(), b"1");
    }

    #[test]
    fn the_guard_applies_to_staged_commits_too() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, "id_rsa", "x");
        {
            let mut index = repo.index().unwrap();
            crate::git::stage::stage_paths(&repo, &mut index, &["id_rsa".to_string()]).unwrap();
            index.write().unwrap();
        }
        let staged = Request {
            staging: Staging::AsStaged,
            ..request("x")
        };
        assert_eq!(
            refused(&repo, &staged),
            [("id_rsa".to_string(), "name matches id_rsa*".to_string())]
        );
        assert_eq!(staged_on_disk(dir.path()), ["id_rsa"]);
    }

    #[test]
    fn allow_secret_commits_the_file_and_records_the_path_in_the_same_commit() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, ".env", "TOKEN=abc\n");
        write(&repo, "a.txt", "a");
        let allowed = Request {
            allow_secret: vec![".env".to_string()],
            ..request("with env")
        };
        let done = made(commit_changes(&repo, &me(), &allowed).unwrap());
        assert_eq!(paths(&done), [".env", ".nsit-allow-secrets", "a.txt"]);
        assert_eq!(
            std::fs::read_to_string(dir.path().join(ALLOW_FILE)).unwrap(),
            ".env\n"
        );
        assert_eq!(
            committed_files(dir.path()),
            [".env", ".nsit-allow-secrets", "a.txt"]
        );
        // Nothing is left over: the working tree is clean.
        assert!(matches!(commit(&repo, "again"), Outcome::NothingToCommit));
    }

    #[test]
    fn a_later_change_to_an_allowed_file_commits_without_the_flag() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, ".env", "TOKEN=abc\n");
        let allowed = Request {
            allow_secret: vec![".env".to_string()],
            ..request("with env")
        };
        made(commit_changes(&repo, &me(), &allowed).unwrap());
        write(&repo, ".env", "TOKEN=changed\n");
        write(&repo, "other.pem", "x");
        // The allowed file passes; a different secret still does not.
        assert_eq!(refused(&repo, &request("x")).len(), 1);
        std::fs::remove_file(dir.path().join("other.pem")).unwrap();
        let done = made(commit(&repo, "update env"));
        assert_eq!(paths(&done), [".env"]);
    }

    #[test]
    fn allow_secret_for_one_path_does_not_let_another_through_and_records_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, ".env", "TOKEN=abc\n");
        write(&repo, "k.pem", "x");
        let allowed = Request {
            allow_secret: vec![".env".to_string()],
            ..request("x")
        };
        let hits = refused(&repo, &allowed);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, "k.pem");
        assert!(
            !dir.path().join(ALLOW_FILE).exists(),
            "a refused commit must not leave an allowance behind"
        );
        assert!(staged_on_disk(dir.path()).is_empty());
    }

    #[test]
    fn allow_secret_must_name_a_file_in_the_commit() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, ".gitignore", "*.local\n");
        write(&repo, "a.txt", "a");
        write(&repo, "x.local", "ignored");
        for typed in ["typo.env", "x.local"] {
            let bad = Request {
                allow_secret: vec![typed.to_string()],
                ..request("x")
            };
            let err = commit_changes(&repo, &me(), &bad).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{typed}: {err:?}");
            assert!(err.to_string().contains(typed), "{err}");
        }
        assert!(!dir.path().join(ALLOW_FILE).exists());
        assert!(staged_on_disk(dir.path()).is_empty());
    }

    #[test]
    fn allow_secret_for_an_already_allowed_path_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, ".env", "TOKEN=abc\n");
        let allowed = Request {
            allow_secret: vec![".env".to_string()],
            ..request("one")
        };
        made(commit_changes(&repo, &me(), &allowed).unwrap());
        write(&repo, ".env", "TOKEN=two\n");
        let again = Request {
            allow_secret: vec![".env".to_string(), ".env".to_string()],
            ..request("two")
        };
        let done = made(commit_changes(&repo, &me(), &again).unwrap());
        assert_eq!(paths(&done), [".env"]);
        assert_eq!(
            std::fs::read_to_string(dir.path().join(ALLOW_FILE)).unwrap(),
            ".env\n"
        );
    }

    // ---- merges ------------------------------------------------------------------

    fn checkout(repo: &Repository, branch: &str) {
        repo.set_head(&format!("refs/heads/{branch}")).unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
    }

    /// `main` and `theirs` both at a.txt = "base\n"; HEAD is on `main`.
    fn diverged(dir: &Path) -> Repository {
        let repo = local_repo(dir);
        commit_file(&repo, "a.txt", "base\n");
        {
            let base = repo.head().unwrap().peel_to_commit().unwrap();
            repo.branch("theirs", &base, false).unwrap();
        }
        repo
    }

    fn merge_in(repo: &Repository, branch: &str) {
        let theirs = repo.find_branch(branch, BranchType::Local).unwrap();
        let theirs = repo.reference_to_annotated_commit(theirs.get()).unwrap();
        repo.merge(&[&theirs], None, None).unwrap();
    }

    #[test]
    fn finishing_a_clean_merge_makes_a_commit_with_two_parents_and_clears_the_merge() {
        let dir = tempfile::tempdir().unwrap();
        let repo = diverged(dir.path());
        checkout(&repo, "theirs");
        commit_file(&repo, "b.txt", "theirs\n");
        let theirs_tip = head_id(&repo).unwrap();
        checkout(&repo, "main");
        commit_file(&repo, "c.txt", "ours\n");
        let ours_tip = head_id(&repo).unwrap();
        merge_in(&repo, "theirs");
        assert_eq!(repo.state(), git2::RepositoryState::Merge);

        let done = made(commit(&repo, "Merge theirs"));
        let merged = repo.find_commit(done.id).unwrap();
        assert_eq!(merged.parent_count(), 2);
        assert_eq!(merged.parent_id(0).unwrap(), ours_tip);
        assert_eq!(merged.parent_id(1).unwrap(), theirs_tip);
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
        assert!(!repo.path().join("MERGE_HEAD").exists());
        assert_eq!(committed_files(dir.path()), ["a.txt", "b.txt", "c.txt"]);
    }

    #[test]
    fn a_merge_whose_tree_equals_head_is_still_committed() {
        let dir = tempfile::tempdir().unwrap();
        let repo = diverged(dir.path());
        checkout(&repo, "theirs");
        commit_file(&repo, "b.txt", "theirs\n");
        checkout(&repo, "main");
        merge_in(&repo, "theirs");
        std::fs::remove_file(dir.path().join("b.txt")).unwrap();
        // Keep ours: the merge result has no b.txt, which is HEAD's own tree.
        let done = made(commit(&repo, "Merge theirs, keeping ours"));
        assert_eq!(repo.find_commit(done.id).unwrap().parent_count(), 2);
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
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
    fn conflicts_still_in_the_files_stop_the_commit_with_exit_4() {
        let dir = tempfile::tempdir().unwrap();
        let repo = diverged(dir.path());
        checkout(&repo, "theirs");
        commit_file(&repo, "a.txt", "theirs line\n");
        checkout(&repo, "main");
        commit_file(&repo, "a.txt", "our line\n");
        merge_in(&repo, "theirs");
        let content = std::fs::read_to_string(dir.path().join("a.txt")).unwrap();
        assert!(content.contains("<<<<<<<"), "{content}");

        let err = commit_changes(&repo, &me(), &request("Merge")).unwrap_err();
        assert!(
            matches!(&err, NsitError::Conflict(files) if files == &["a.txt"]),
            "{err:?}"
        );
        assert_eq!(err.exit_code(), 4);
        // Nothing moved: still merging, still conflicted on disk.
        let fresh = Repository::open(dir.path()).unwrap();
        assert_eq!(fresh.state(), git2::RepositoryState::Merge);
        assert!(fresh.index().unwrap().has_conflicts());

        // Resolved by hand, the same command finishes the merge.
        std::fs::write(dir.path().join("a.txt"), "resolved\n").unwrap();
        let done = made(commit(&repo, "Merge theirs"));
        assert_eq!(repo.find_commit(done.id).unwrap().parent_count(), 2);
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "resolved\n"
        );
    }

    #[test]
    fn staged_with_unresolved_conflicts_is_exit_4_too() {
        let dir = tempfile::tempdir().unwrap();
        let repo = diverged(dir.path());
        checkout(&repo, "theirs");
        commit_file(&repo, "a.txt", "theirs line\n");
        checkout(&repo, "main");
        commit_file(&repo, "a.txt", "our line\n");
        merge_in(&repo, "theirs");
        let staged = Request {
            staging: Staging::AsStaged,
            ..request("x")
        };
        let err = commit_changes(&repo, &me(), &staged).unwrap_err();
        assert!(
            matches!(&err, NsitError::Conflict(files) if files == &["a.txt"]),
            "{err:?}"
        );
    }

    #[test]
    fn in_a_merge_the_guard_checks_only_what_differs_from_the_merged_in_branch() {
        let dir = tempfile::tempdir().unwrap();
        let repo = diverged(dir.path());
        // Their side already has a .env (committed with some other tool).
        checkout(&repo, "theirs");
        commit_file(&repo, ".env", "THEIRS=1\n");
        checkout(&repo, "main");
        commit_file(&repo, "c.txt", "ours\n");
        merge_in(&repo, "theirs");
        // Our own changes are fine and the .env came in unchanged: not our doing.
        let done = made(commit(&repo, "Merge theirs"));
        assert_eq!(repo.find_commit(done.id).unwrap().parent_count(), 2);
        assert!(committed_files(dir.path()).contains(&".env".to_string()));
    }

    #[test]
    fn in_a_merge_a_secret_the_user_changed_is_still_refused() {
        let dir = tempfile::tempdir().unwrap();
        let repo = diverged(dir.path());
        checkout(&repo, "theirs");
        commit_file(&repo, ".env", "THEIRS=1\n");
        checkout(&repo, "main");
        commit_file(&repo, "c.txt", "ours\n");
        merge_in(&repo, "theirs");
        // Edited while finishing the merge: now it differs from theirs.
        write(&repo, ".env", "MINE=1\n");
        let hits = refused(&repo, &request("Merge theirs"));
        assert_eq!(hits[0].0, ".env");
        assert_eq!(repo.state(), git2::RepositoryState::Merge, "still merging");
    }

    // ---- reporting ---------------------------------------------------------------

    #[test]
    fn describe_gives_a_header_and_one_line_per_file() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, "a.txt", "a");
        write(&repo, "dir/b.txt", "b");
        let outcome = commit(&repo, "Add two");
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

    #[test]
    fn a_committed_unborn_branch_creates_the_branch_ref() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        assert_eq!(
            repo.find_reference("refs/heads/main")
                .err()
                .map(|e| e.code()),
            Some(ErrorCode::NotFound)
        );
        write(&repo, "a.txt", "a");
        let done = made(commit(&repo, "first"));
        let main = repo.find_reference("refs/heads/main").unwrap();
        assert_eq!(main.target(), Some(done.id));
    }
}
