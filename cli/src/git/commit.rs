//! Making a commit: the part of `nsit commit` that is not about the command
//! line, so that `nsit init --readme` (and, later, anything else that commits)
//! uses exactly the same checks.
//!
//! The order is what makes a failure safe: everything is staged **in memory**,
//! the checks look at what would be committed, and the index file is written
//! only after the commit itself has succeeded. A refusal (exit 5), a conflict
//! (exit 4), a usage error, "nothing to commit", and a commit that libgit2 cannot
//! make (a locked branch, say) therefore all leave the index file exactly as it
//! was. The one thing written before the commit is `.nsit-allow-secrets`, and
//! only for `--allow-secret` paths, once the guard has nothing left to refuse; if
//! the commit then fails (or turns out to be empty) that file is put back byte for
//! byte, or removed if it was not there.
//!
//! A merge in progress (`MERGE_HEAD`, left by `nsit pull`) is finished by the
//! same call: two parents, and the merge state is cleared.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use git2::{message_prettify, Commit, Delta, Index, Oid, Repository, Signature, Tree};
use regex::bytes::Regex;

use super::paths::{display, RawPath};
use super::secrets::{allowed_paths, check_recordable, record_allowances, scan_index};
use super::stage::{
    changed_paths, conflicted_paths, current_branch, entries_at, entry, head_commit, merge_heads,
    read_start, stage_all,
};
use crate::error::NsitError;

/// How much of a file is read to see whether conflict markers are left in it.
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
/// whose type it changes (`T`). The path is for showing: see `paths::display`.
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

/// `text` as git stores a commit message: no blank lines at the ends, no
/// trailing spaces, a final newline. `comment` lines (a merge's `# Conflicts:`)
/// are dropped when a comment character is given. A message with nothing in it
/// is a usage error.
pub fn finish_message(text: &str, comment: Option<u8>) -> Result<String, NsitError> {
    let message = message_prettify(text, comment)
        .map_err(|_| NsitError::Usage("the commit message cannot be used".into()))?;
    if message.trim().is_empty() {
        return Err(NsitError::Usage("the commit message is empty".into()));
    }
    Ok(message)
}

/// Make the commit `request` describes, or say there is nothing to commit.
///
/// Errors, none of them leaving anything half done: `Conflict` (exit 4) while
/// files from a merge are unresolved or still hold conflict markers,
/// `SecretGuard` (exit 5) listing every refused path, `Usage` for an
/// `--allow-secret` path that is not part of the commit or cannot be recorded.
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
        return Err(NsitError::Conflict(shown(&unresolved)));
    }

    // What this commit adds or changes: against HEAD, or in a merge against the
    // branch being merged in (the merged-in side is not ours to vouch for; what
    // differs from it is).
    let head_tree = head.as_ref().map(Commit::tree).transpose()?;
    let merged_tree = match merging.first() {
        Some(oid) => Some(repo.find_commit(*oid)?.tree()?),
        None => None,
    };
    let candidates = changed_paths(repo, &index, merged_tree.as_ref().or(head_tree.as_ref()))?;

    // Staging a file with conflict markers resolves it as far as the index is
    // concerned, and so does `nsit add`; committing the markers is almost never
    // what anyone wants. Files that were in conflict are checked, and while a merge
    // is being finished so is every file that **both** differs from the merged-in
    // branch and differs from `HEAD`: that is a file this merge (or the person finishing
    // it) changed. A file only our side changed, earlier, is not this commit's doing:
    // documentation that shows what a conflict looks like must not block the merge.
    let mut to_check: BTreeSet<RawPath> = in_conflict.into_iter().collect();
    if !merging.is_empty() {
        let differs_from_head: BTreeSet<RawPath> = changed_paths(repo, &index, head_tree.as_ref())?
            .into_iter()
            .collect();
        to_check.extend(
            candidates
                .iter()
                .filter(|path| differs_from_head.contains(*path))
                .cloned(),
        );
    }
    let marked = with_conflict_markers(repo, &index, &to_check.into_iter().collect::<Vec<_>>())?;
    if !marked.is_empty() {
        return Err(NsitError::Conflict(shown(&marked)));
    }

    // The guard. `--allow-secret` paths are let through here, before they are
    // recorded: nothing is written for a commit that is still refused.
    let pending = pending_allowances(repo, &index, &request.allow_secret)?;
    let hits = scan_index(repo, &index, &candidates, &pending)?;
    if !hits.is_empty() {
        return Err(NsitError::SecretGuard(hits));
    }
    // Past the guard: record the allowances in one write and stage the file in
    // this same index, so they travel with this commit.
    let backup = record_allowances(repo, &mut index, &pending)?;

    // The allow file is now changed in the working directory. Until a commit exists
    // anything that goes wrong (and "nothing to commit") takes the change back, so a
    // commit that is not made leaves no allowance behind and an allow file that was
    // there is exactly as it was.
    let (id, changes) = match commit_tree(
        repo,
        who,
        request,
        &mut index,
        head.as_ref(),
        head_tree.as_ref(),
        &merging,
    ) {
        Ok(Some(made)) => made,
        Ok(None) => {
            if let Some(backup) = backup {
                backup.restore()?;
            }
            return Ok(Outcome::NothingToCommit);
        }
        Err(err) => {
            return Err(match backup {
                Some(backup) => backup.restore_after(err),
                None => err,
            });
        }
    };
    // The merge is over once its commit exists, so its state goes before anything else can
    // fail: a write of the index that does not work must not leave a `MERGE_HEAD` waiting
    // over a finished merge (the next commit would be a second merge of the same parents).
    if !merging.is_empty() {
        repo.cleanup_state()?;
    }
    // Only now does the index reach the disk: if the commit had failed, the
    // index file would still be what it was before.
    index.write()?;
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

/// The commit itself: the tree of `index`, committed on `HEAD` with `head` and every commit
/// being merged in as its parents. `None` when there is nothing to commit (and no merge to
/// finish). Writes the tree to the object database and moves the branch, and nothing else.
fn commit_tree(
    repo: &Repository,
    who: &Signature<'_>,
    request: &Request,
    index: &mut Index,
    head: Option<&Commit<'_>>,
    head_tree: Option<&Tree<'_>>,
    merging: &[Oid],
) -> Result<Option<(Oid, Vec<Change>)>, NsitError> {
    let tree_id = index.write_tree()?;
    let same_as_head = head_tree.map(Tree::id) == Some(tree_id);
    let nothing_at_all = head.is_none() && index.is_empty();
    if merging.is_empty() && (same_as_head || nothing_at_all) {
        return Ok(None);
    }

    let tree = repo.find_tree(tree_id)?;
    let changes = changes_between(repo, head_tree, &tree)?;
    let merged: Vec<Commit<'_>> = merging
        .iter()
        .map(|oid| repo.find_commit(*oid))
        .collect::<Result<_, _>>()?;
    let parents: Vec<&Commit<'_>> = head.into_iter().chain(merged.iter()).collect();
    let id = repo.commit(Some("HEAD"), who, who, &request.message, &tree, &parents)?;
    Ok(Some((id, changes)))
}

/// Raw paths for an error message.
fn shown(paths: &[RawPath]) -> Vec<String> {
    paths.iter().map(|path| display(path)).collect()
}

/// The `--allow-secret` paths that `.nsit-allow-secrets` does not list yet,
/// each once. **Every** wanted path is checked here, before anything is
/// recorded: it has to be part of this commit (a typo, or something
/// `.gitignore` hides, would record an allowance for nothing) and has to be
/// something the allow file can hold. So a bad path, however late in the list,
/// means nothing is written for any of them.
fn pending_allowances(
    repo: &Repository,
    index: &Index,
    wanted: &[String],
) -> Result<Vec<String>, NsitError> {
    for path in wanted {
        if entry(index, path).is_none() {
            return Err(NsitError::Usage(format!(
                "--allow-secret {path}: that file is not part of this commit \
                 (is it missing, or ignored by .gitignore?)"
            )));
        }
        check_recordable(path)?;
    }
    let listed = allowed_paths(repo, index)?;
    let pending: BTreeSet<&String> = wanted
        .iter()
        .filter(|path| !listed.contains(path.as_bytes()))
        .collect();
    Ok(pending.into_iter().cloned().collect())
}

/// Which of `paths` have conflict markers left in what is staged: a line that
/// starts `<<<<<<< ` or one that starts `>>>>>>> `, as libgit2 and git write
/// them. Either one alone is enough (a `=======` line is not looked at: it is
/// ordinary text in too many files). A path that is not staged is skipped:
/// a file resolved by deleting it has nothing left to check.
fn with_conflict_markers(
    repo: &Repository,
    index: &Index,
    paths: &[RawPath],
) -> Result<Vec<RawPath>, NsitError> {
    static MARKER: OnceLock<Regex> = OnceLock::new();
    let marker = MARKER
        .get_or_init(|| Regex::new(r"(?m)^(<<<<<<< |>>>>>>> )").expect("a valid built-in pattern"));
    let staged = entries_at(index, paths);
    let mut marked = Vec::new();
    for path in paths {
        let Some(file) = staged.get(path) else {
            continue;
        };
        let start = read_start(repo, file.id, MARKER_SCAN_LIMIT)?;
        if marker.is_match(&start) {
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
            let path = delta
                .new_file()
                .path_bytes()
                .or(delta.old_file().path_bytes())?;
            Some(Change {
                code,
                path: display(path),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use git2::ErrorCode;

    use super::*;
    use crate::git::secrets::ALLOW_FILE;
    use crate::test_support::{
        checkout_branch as checkout, commit_file, diverged_repo as diverged, local_repo,
        merge_branch as merge_in, stage_raw, write_file as write,
    };
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
        write(&repo, "deploy.sh", format!("export TOKEN={secret}\n"));
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

    // ---- the branch ref -------------------------------------------------------------

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

    // ---- paths that are not text ---------------------------------------------------

    #[test]
    fn a_secret_name_that_is_not_text_is_refused_not_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        // `donn\xe9es` is Latin-1, not UTF-8: the old lookup by text missed this
        // file, so neither the name rule nor the content rule ever ran on it.
        stage_raw(&repo, b"donn\xe9es/.env", b"KEY=1\n");
        stage_raw(&repo, b"ok.txt", b"fine\n");
        let staged = Request {
            staging: Staging::AsStaged,
            ..request("x")
        };
        let hits = refused(&repo, &staged);
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(hits[0].1, "name matches .env");
        assert!(hits[0].0.starts_with("donn") && hits[0].0.ends_with("es/.env"));
        assert_eq!(head_id(&repo), None);
        assert!(
            !repo.path().join("index").exists(),
            "the index file was written"
        );
    }

    #[test]
    fn a_token_in_a_file_whose_name_is_not_text_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let token = format!("ghp_{}", "Zy9".repeat(14));
        stage_raw(&repo, b"caf\xe9.txt", format!("TOKEN={token}\n").as_bytes());
        let staged = Request {
            staging: Staging::AsStaged,
            ..request("x")
        };
        let err = commit_changes(&repo, &me(), &staged).unwrap_err();
        assert_eq!(err.exit_code(), 5, "{err:?}");
        assert!(!err.to_string().contains(&token), "{err}");
    }

    #[test]
    fn conflict_markers_are_found_in_a_file_whose_name_is_not_text() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        stage_raw(&repo, b"d\xe9/merged.txt", b"one\n<<<<<<< ours\nx\n");
        stage_raw(&repo, b"d\xe9/clean.txt", b"one\ntwo\n");
        let index = repo.index().unwrap();
        let paths = vec![b"d\xe9/merged.txt".to_vec(), b"d\xe9/clean.txt".to_vec()];
        let marked = with_conflict_markers(&repo, &index, &paths).unwrap();
        assert_eq!(marked, [b"d\xe9/merged.txt".to_vec()]);
    }

    /// Real files with names that are not UTF-8, which only a Unix file system can
    /// hold. They go through the whole of `nsit commit` (staging by `add_all`, the
    /// diff, the guard). These cannot run on Windows.
    #[cfg(unix)]
    mod non_utf8_files {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        use super::*;

        fn write_raw(repo: &Repository, rel: &[u8], content: &[u8]) {
            let mut path = repo.workdir().unwrap().to_path_buf();
            for part in rel.split(|b| *b == b'/') {
                path.push(OsStr::from_bytes(part));
            }
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }

        #[test]
        fn an_env_file_in_a_directory_with_a_non_utf8_name_is_refused() {
            let dir = tempfile::tempdir().unwrap();
            let repo = local_repo(dir.path());
            write_raw(&repo, b"donn\xe9es/.env", b"KEY=1\n");
            write_raw(&repo, b"fine.txt", b"fine\n");
            let hits = refused(&repo, &request("x"));
            assert_eq!(hits.len(), 1, "{hits:?}");
            assert_eq!(hits[0].1, "name matches .env");
            assert_eq!(head_id(&repo), None);
            assert!(!repo.path().join("index").exists());
        }

        #[test]
        fn a_token_inside_a_file_with_a_non_utf8_name_is_refused() {
            let dir = tempfile::tempdir().unwrap();
            let repo = local_repo(dir.path());
            let token = format!("ghp_{}", "Zy9".repeat(14));
            write_raw(&repo, b"caf\xe9.txt", format!("TOKEN={token}\n").as_bytes());
            let hits = refused(&repo, &request("x"));
            assert_eq!(hits.len(), 1, "{hits:?}");
            assert_eq!(hits[0].1, "contains a GitHub token");
        }

        #[test]
        fn a_harmless_file_with_a_non_utf8_name_commits() {
            let dir = tempfile::tempdir().unwrap();
            let repo = local_repo(dir.path());
            write_raw(&repo, b"caf\xe9.txt", b"harmless\n");
            let done = made(commit(&repo, "first"));
            assert_eq!(done.changes.len(), 1);
        }
    }

    // ---- binary files ---------------------------------------------------------------

    #[test]
    fn a_private_key_in_a_file_that_looks_binary_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        // One stray NUL in front, which is all the binary check looks for.
        let mut key = vec![0u8];
        key.extend_from_slice(b"-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n");
        write(&repo, "deploy.dat", &key);
        write(&repo, "fine.txt", "fine");
        let hits = refused(&repo, &request("x"));
        assert_eq!(
            hits,
            [(
                "deploy.dat".to_string(),
                "contains a private key".to_string()
            )]
        );
    }

    // ---- conflict markers -----------------------------------------------------------

    /// A merge of `theirs` into `main` that has no conflict: they add b.txt, we add c.txt.
    fn clean_merge(dir: &Path) -> Repository {
        let repo = diverged(dir);
        checkout(&repo, "theirs");
        commit_file(&repo, "b.txt", "theirs\n");
        checkout(&repo, "main");
        commit_file(&repo, "c.txt", "ours\n");
        merge_in(&repo, "theirs");
        repo
    }

    #[test]
    fn markers_left_in_a_file_resolved_with_add_are_still_refused_in_a_merge() {
        let dir = tempfile::tempdir().unwrap();
        let repo = diverged(dir.path());
        checkout(&repo, "theirs");
        commit_file(&repo, "a.txt", "theirs line\n");
        checkout(&repo, "main");
        commit_file(&repo, "a.txt", "our line\n");
        merge_in(&repo, "theirs");
        // `nsit add a.txt` resolves the conflict in the index, markers and all.
        {
            let mut index = repo.index().unwrap();
            crate::git::stage::stage_paths(&repo, &mut index, &["a.txt".to_string()]).unwrap();
            index.write().unwrap();
        }
        assert!(!repo.index().unwrap().has_conflicts());
        let staged = Request {
            staging: Staging::AsStaged,
            ..request("Merge")
        };
        let err = commit_changes(&repo, &me(), &staged).unwrap_err();
        assert!(
            matches!(&err, NsitError::Conflict(files) if files == &["a.txt"]),
            "{err:?}"
        );
        assert_eq!(err.exit_code(), 4);
        assert_eq!(repo.state(), git2::RepositoryState::Merge, "still merging");
    }

    #[test]
    fn one_marker_line_in_a_changed_file_is_enough_while_a_merge_is_finished() {
        for line in ["<<<<<<< ours", ">>>>>>> theirs", "text\n<<<<<<< HEAD\nmore"] {
            let dir = tempfile::tempdir().unwrap();
            let repo = clean_merge(dir.path());
            // Our own change to c.txt (not conflicted in the index) keeps a marker.
            write(&repo, "c.txt", format!("ours\n{line}\n"));
            let err = commit_changes(&repo, &me(), &request("Merge")).unwrap_err();
            assert!(
                matches!(&err, NsitError::Conflict(files) if files == &["c.txt"]),
                "{line:?}: {err:?}"
            );
            assert_eq!(err.exit_code(), 4);
            assert_eq!(repo.state(), git2::RepositoryState::Merge);
        }
    }

    #[test]
    fn marker_text_in_a_file_only_our_side_changed_does_not_block_the_merge_commit() {
        let dir = tempfile::tempdir().unwrap();
        let repo = diverged(dir.path());
        checkout(&repo, "theirs");
        commit_file(&repo, "b.txt", "theirs\n");
        checkout(&repo, "main");
        // Earlier, on our side alone: documentation that shows what a conflict looks like. It is
        // not in conflict, and this merge does not change it.
        commit_file(
            &repo,
            "docs.md",
            "How to read a conflict:\n<<<<<<< ours\n=======\n>>>>>>> theirs\n",
        );
        commit_file(&repo, "c.txt", "ours\n");
        merge_in(&repo, "theirs");

        let done = made(commit(&repo, "Merge theirs"));
        assert_eq!(repo.find_commit(done.id).unwrap().parent_count(), 2);
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
    }

    #[test]
    fn marker_lines_in_a_file_both_sides_changed_or_the_person_edited_are_still_refused() {
        // Both sides changed the file (merged without a conflict), and the person left a marker
        // line in the result.
        let dir = tempfile::tempdir().unwrap();
        let repo = diverged(dir.path());
        checkout(&repo, "theirs");
        commit_file(&repo, "a.txt", "base\ntheirs line\n");
        checkout(&repo, "main");
        commit_file(&repo, "a.txt", "our line\nbase\n");
        merge_in(&repo, "theirs");
        assert!(repo
            .index()
            .unwrap()
            .get_path(Path::new("a.txt"), 0)
            .is_some());
        write(
            &repo,
            "a.txt",
            "our line\nbase\ntheirs line\n<<<<<<< left over\n",
        );
        let err = commit_changes(&repo, &me(), &request("Merge")).unwrap_err();
        assert!(
            matches!(&err, NsitError::Conflict(files) if files == &["a.txt"]),
            "{err:?}"
        );
        assert_eq!(repo.state(), git2::RepositoryState::Merge);
    }

    #[test]
    fn a_lone_separator_line_or_an_indented_marker_is_ordinary_text() {
        let dir = tempfile::tempdir().unwrap();
        let repo = clean_merge(dir.path());
        write(
            &repo,
            "c.txt",
            "Title\n=======\n    <<<<<<< indented\nx >>>>>>> not at the start\n<<<<<<<no-space\n",
        );
        let done = made(commit(&repo, "Merge"));
        assert_eq!(repo.find_commit(done.id).unwrap().parent_count(), 2);
    }

    #[test]
    fn marker_lines_are_only_looked_for_in_a_merge_or_in_files_that_were_in_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(
            &repo,
            "docs.md",
            "How to read a conflict:\n<<<<<<< ours\n=======\n>>>>>>> theirs\n",
        );
        let done = made(commit(&repo, "document markers"));
        assert_eq!(paths(&done), ["docs.md"]);
    }

    // ---- allowances: one write, validated first -------------------------------------

    #[test]
    fn a_bad_later_allow_secret_path_records_nothing_for_any_of_them() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, ".env", "TOKEN=abc\n");
        // Part of the commit, but the allow file has no way to hold a name that
        // starts with `#`.
        write(&repo, "#notes.env", "x\n");
        let both = Request {
            allow_secret: vec![".env".to_string(), "#notes.env".to_string()],
            ..request("x")
        };
        let err = commit_changes(&repo, &me(), &both).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert!(err.to_string().contains("#notes.env"), "{err}");
        assert!(
            !dir.path().join(ALLOW_FILE).exists(),
            "the first path was recorded although the second was refused"
        );
        assert!(staged_on_disk(dir.path()).is_empty());
        assert_eq!(head_id(&repo), None);
    }

    #[test]
    fn every_new_allowance_is_in_one_allow_file_in_the_same_commit() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, ".env", "TOKEN=abc\n");
        write(&repo, "k.pem", "x");
        write(&repo, "a.txt", "a");
        let both = Request {
            allow_secret: vec!["k.pem".to_string(), ".env".to_string()],
            ..request("two secrets")
        };
        let done = made(commit_changes(&repo, &me(), &both).unwrap());
        assert_eq!(
            paths(&done),
            [".env", ".nsit-allow-secrets", "a.txt", "k.pem"]
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join(ALLOW_FILE)).unwrap(),
            ".env\nk.pem\n"
        );
    }

    // ---- the index file is written after the commit ----------------------------------

    #[test]
    fn a_commit_that_fails_leaves_the_index_file_byte_for_byte_as_it_was() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "1");
        let index_file = repo.path().join("index");
        let before = std::fs::read(&index_file).unwrap();

        write(&repo, "a.txt", "2");
        write(&repo, "new.txt", "n");
        // A leftover lock on the branch makes libgit2 unable to move it.
        let lock = repo.path().join("refs").join("heads").join("main.lock");
        std::fs::write(&lock, "").unwrap();
        let err = commit_changes(&repo, &me(), &request("blocked")).unwrap_err();
        assert!(matches!(err, NsitError::Git(_)), "{err:?}");
        assert_eq!(
            std::fs::read(&index_file).unwrap(),
            before,
            "the index file changed although no commit was made"
        );
        let fresh = Repository::open(dir.path()).unwrap();
        assert_eq!(head_id(&fresh), head_id(&repo));
        assert_eq!(committed_files(dir.path()), ["a.txt"]);

        // Once the lock is gone the same call works and the index follows.
        std::fs::remove_file(&lock).unwrap();
        let done = made(commit(&repo, "now it works"));
        assert_eq!(paths(&done), ["a.txt", "new.txt"]);
        assert_eq!(staged_on_disk(dir.path()), ["a.txt", "new.txt"]);
    }

    #[test]
    fn a_commit_that_fails_after_the_allowance_was_written_removes_an_allow_file_that_was_not_there(
    ) {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "1");
        write(&repo, ".env", "TOKEN=abc\n");
        let allowed = Request {
            allow_secret: vec![".env".to_string()],
            ..request("with env")
        };
        // A leftover lock on the branch makes libgit2 unable to move it: the commit fails after
        // the allowance was written to the working directory.
        let lock = repo.path().join("refs").join("heads").join("main.lock");
        std::fs::write(&lock, "").unwrap();
        let err = commit_changes(&repo, &me(), &allowed).unwrap_err();
        assert!(matches!(err, NsitError::Git(_)), "{err:?}");
        assert!(
            !dir.path().join(ALLOW_FILE).exists(),
            "the failed commit left an allowance behind"
        );
        assert_eq!(staged_on_disk(dir.path()), ["a.txt"]);

        // With the lock gone, the same request works and records the allowance again.
        std::fs::remove_file(&lock).unwrap();
        let done = made(commit_changes(&repo, &me(), &allowed).unwrap());
        assert_eq!(paths(&done), [".env", ".nsit-allow-secrets"]);
        assert_eq!(
            std::fs::read_to_string(dir.path().join(ALLOW_FILE)).unwrap(),
            ".env\n"
        );
    }

    #[test]
    fn a_commit_that_fails_after_the_allowance_was_written_restores_the_allow_file_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "1");
        // An allow file that is already there, with a comment and a name that is not text.
        let original = b"# reviewed\nold.env\n# caf\xe9\n".to_vec();
        std::fs::write(dir.path().join(ALLOW_FILE), &original).unwrap();
        write(&repo, ".env", "TOKEN=abc\n");
        let allowed = Request {
            allow_secret: vec![".env".to_string()],
            ..request("with env")
        };
        let lock = repo.path().join("refs").join("heads").join("main.lock");
        std::fs::write(&lock, "").unwrap();
        assert!(commit_changes(&repo, &me(), &allowed).is_err());
        assert_eq!(
            std::fs::read(dir.path().join(ALLOW_FILE)).unwrap(),
            original,
            "the allow file is not what it was"
        );
        assert_eq!(staged_on_disk(dir.path()), ["a.txt"]);
    }

    #[test]
    fn the_merge_is_over_once_the_commit_is_made_even_if_the_index_file_cannot_be_written_after() {
        let dir = tempfile::tempdir().unwrap();
        let repo = clean_merge(dir.path());
        // Something else holds the index file's lock: the commit goes in, the index write cannot.
        let lock = repo.path().join("index.lock");
        std::fs::write(&lock, "").unwrap();
        let err = commit_changes(&repo, &me(), &request("Merge")).unwrap_err();
        assert!(matches!(err, NsitError::Git(_)), "{err:?}");
        let fresh = Repository::open(dir.path()).unwrap();
        assert_eq!(
            fresh
                .head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .parent_count(),
            2,
            "the merge commit was made"
        );
        // So no MERGE_HEAD may be left waiting over a merge that is finished: the next
        // `nsit commit` would otherwise make a second merge commit with the same parents.
        assert_eq!(fresh.state(), git2::RepositoryState::Clean);
        assert!(!repo.path().join("MERGE_HEAD").exists());
    }

    #[test]
    fn a_failed_commit_also_leaves_a_merge_waiting() {
        let dir = tempfile::tempdir().unwrap();
        let repo = clean_merge(dir.path());
        let lock = repo.path().join("refs").join("heads").join("main.lock");
        std::fs::write(&lock, "").unwrap();
        assert!(commit_changes(&repo, &me(), &request("Merge")).is_err());
        assert_eq!(repo.state(), git2::RepositoryState::Merge);
        std::fs::remove_file(&lock).unwrap();
        made(commit(&repo, "Merge"));
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
    }
}
