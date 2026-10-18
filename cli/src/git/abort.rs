//! Undoing a merge that stopped on conflicts: `nsit pull --abort`.
//!
//! **What it does.** `reset --hard` to where the merge started (`ORIG_HEAD`, or `HEAD` when that
//! is missing or is not a commit) and `cleanup_state`. The files and the index go back to exactly
//! what they were before the pull: **your conflict resolutions are thrown away**, and so is any
//! other change to a file the merge touched. Files that are not tracked are left alone (see the
//! second refusal below for the one way the reset could still reach one).
//!
//! **What it refuses to do.** Before it resets, `abort` refuses (exit 2, naming the files,
//! nothing changed) in two cases, because a hard reset would destroy work without a word:
//!
//! * A hard reset would revert a tracked file the merge never touched if somebody edited it,
//!   staged it or deleted it *after the pull stopped* (a pull that has to merge starts only with
//!   the tracked files committed, so such a change can only be from then). `abort` works out the
//!   **merge set** and refuses when any tracked file *outside* it differs from where the merge
//!   started, in the index or in the working directory.
//! * A hard reset puts back the files the merge deleted, and a *forced* checkout writes over
//!   whatever is there. A file recreated at such a path since (untracked, or ignored, which is
//!   as good as invisible) would be overwritten, so `abort` refuses while one is (see
//!   `untracked_in_the_way`). Untracked files anywhere else are left alone, as promised.
//!
//! **The merge set** is what the merge changed: the paths whose content differs between the
//! commit the merge started from and the merge's own result, plus every path that is in
//! conflict. The result is worked out again, in memory, from `ORIG_HEAD` and `MERGE_HEAD` with
//! the options `pull` used, rather than read from the index, because the index now holds
//! whatever the person has staged since. (It is not "everything `MERGE_HEAD` differs in": that
//! would include files only our own side changed, which the merge leaves as they are.)

use std::collections::BTreeSet;
use std::io;
use std::path::Path;

use git2::build::CheckoutBuilder;
use git2::{
    Commit, Delta, DiffDelta, DiffOptions, FileMode, Oid, Repository, RepositoryState, ResetType,
};

use super::orig_head;
use super::paths::{display, in_workdir, listed, raw_name, workdir, RawPath};
use super::stage::{conflicted_paths, head_commit, merge_heads};
use crate::error::NsitError;

/// Abandon the merge in progress and return the commit `HEAD` is back at. Without a merge in
/// progress it is a usage error and **nothing is touched** (a hard reset there would discard
/// work); so it is when a tracked file outside the merge has changes that the reset would lose.
pub fn abort(repo: &Repository) -> Result<Oid, NsitError> {
    match repo.state() {
        RepositoryState::Merge => {}
        RepositoryState::Clean => {
            return Err(NsitError::Usage(
                "there is no merge in progress, so there is nothing to abort".into(),
            ));
        }
        other => {
            return Err(NsitError::Usage(format!(
                "there is no merge in progress to abort (the repository is in the middle of {}, \
                 which nsit cannot abort)",
                operation_name(other)
            )));
        }
    }
    let target = restore_point(repo)?;

    let outside = edits_outside_the_merge(repo, &target)?;
    if !outside.is_empty() {
        return Err(NsitError::Usage(format!(
            "cannot abort the merge: changes to {} were made after the pull stopped and are not \
             part of the merge, so aborting would lose them; put them back as they were before \
             the pull (or save a copy elsewhere), then run nsit pull --abort again",
            listed(&outside)
        )));
    }
    let in_the_way = untracked_in_the_way(repo, &target)?;
    if !in_the_way.is_empty() {
        return Err(NsitError::Usage(format!(
            "cannot abort the merge: {} would be overwritten, because the merge deleted files at \
             those paths and aborting puts them back, and what is there now is not tracked (or \
             is ignored); move yours elsewhere, then run nsit pull --abort again",
            listed(&in_the_way)
        )));
    }

    repo.reset(
        target.as_object(),
        ResetType::Hard,
        Some(CheckoutBuilder::new().force()),
    )?;
    repo.cleanup_state()?;
    Ok(target.id())
}

/// What an operation other than a merge is called in a sentence ("a rebase").
pub fn operation_name(state: RepositoryState) -> &'static str {
    match state {
        RepositoryState::Revert | RepositoryState::RevertSequence => "a revert",
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => "a cherry-pick",
        RepositoryState::Bisect => "a bisect",
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge => "a rebase",
        RepositoryState::ApplyMailbox | RepositoryState::ApplyMailboxOrRebase => "applying patches",
        RepositoryState::Merge | RepositoryState::Clean => "something",
    }
}

/// Where an abort goes back to: `ORIG_HEAD` if it names a commit, else `HEAD`.
fn restore_point(repo: &Repository) -> Result<Commit<'_>, NsitError> {
    if let Some(commit) = orig_head::commit(repo) {
        return Ok(commit);
    }
    head_commit(repo)?.ok_or_else(|| {
        NsitError::Other(
            "cannot tell where the merge started: there is no ORIG_HEAD and no HEAD".into(),
        )
    })
}

/// The paths a diff delta is about (both sides: they differ for a rename).
fn delta_paths(delta: &DiffDelta<'_>) -> Vec<RawPath> {
    [delta.old_file().path_bytes(), delta.new_file().path_bytes()]
        .into_iter()
        .flatten()
        .map(<[u8]>::to_vec)
        .collect()
}

/// The merge set (see the module documentation): what a merge of `MERGE_HEAD` into `base` changes,
/// and what is in conflict now.
fn merge_set(repo: &Repository, base: &Commit<'_>) -> Result<BTreeSet<RawPath>, NsitError> {
    let base_tree = base.tree()?;
    let mut set = BTreeSet::new();
    match merge_heads(repo)?.as_slice() {
        [theirs] => {
            let merged = repo.merge_commits(base, &repo.find_commit(*theirs)?, None)?;
            let diff = repo.diff_tree_to_index(Some(&base_tree), Some(&merged), None)?;
            for delta in diff.deltas() {
                set.extend(delta_paths(&delta));
            }
            set.extend(conflicted_paths(&merged)?);
        }
        // More than one commit being merged in (git's octopus merge; nsit never starts one):
        // the result cannot be worked out again here, so everything the merged-in sides differ
        // in counts: more than the merge changes, never less.
        heads => {
            for head in heads {
                let theirs = repo.find_commit(*head)?.tree()?;
                let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&theirs), None)?;
                for delta in diff.deltas() {
                    set.extend(delta_paths(&delta));
                }
            }
        }
    }
    let mut current = repo.index()?;
    current.read(true)?;
    set.extend(conflicted_paths(&current)?);
    Ok(set)
}

/// The tracked files outside the merge set that differ from `base`, in the index or in the
/// working directory (edited, staged, added or deleted since the pull stopped), sorted. Untracked
/// and ignored files are not listed: a hard reset spares them.
fn edits_outside_the_merge(repo: &Repository, base: &Commit<'_>) -> Result<Vec<String>, NsitError> {
    let merged = merge_set(repo, base)?;
    let mut options = DiffOptions::new();
    options.ignore_submodules(true);
    let diff = repo.diff_tree_to_workdir_with_index(Some(&base.tree()?), Some(&mut options))?;
    let mut outside = BTreeSet::new();
    for delta in diff.deltas() {
        let paths = delta_paths(&delta);
        if paths.is_empty() {
            // Fail closed: a change that cannot be placed is not a change that can be ignored.
            return Err(NsitError::Other(
                "cannot tell which file a change is about, so it cannot be checked before the \
                 abort (this is a bug in nsit)"
                    .into(),
            ));
        }
        outside.extend(paths.into_iter().filter(|path| !merged.contains(path)));
    }
    Ok(outside.iter().map(|path| display(path)).collect())
}

/// The untracked **and ignored** files of the working directory that the reset would
/// overwrite, sorted: at every path the target has a file at and the index does not (the merge
/// deleted it, and the reset puts it back), whatever is there now is somebody's own file; and
/// so is a file where a directory has to be made for one, and a directory holding such a file
/// where one has to be written. `edits_outside_the_merge` never lists these (they are not
/// tracked), and a forced checkout, which the reset is, replaces them without a word.
///
/// A path the index has in any stage is tracked, and what the reset does to it is part of
/// undoing the merge.
fn untracked_in_the_way(repo: &Repository, target: &Commit<'_>) -> Result<Vec<String>, NsitError> {
    let root = workdir(repo)?;
    let mut current = repo.index()?;
    current.read(true)?;
    let tracked: BTreeSet<RawPath> = current.iter().map(|entry| entry.path).collect();
    let diff = repo.diff_tree_to_index(Some(&target.tree()?), Some(&current), None)?;
    let mut in_the_way = BTreeSet::new();
    for delta in diff.deltas() {
        // In the target's tree and not in the index. (Not a submodule: nsit does not make them.)
        if delta.status() != Delta::Deleted || delta.old_file().mode() == FileMode::Commit {
            continue;
        }
        if let Some(path) = delta.old_file().path_bytes() {
            in_the_way.extend(blocked_at(root, path, &tracked));
        }
    }
    Ok(in_the_way.iter().map(|path| display(path)).collect())
}

/// What stands in the way of writing the file `path` (raw, forward slashes, under `root`): the
/// path of the untracked thing that the write would replace, if there is one. Each leading
/// directory is looked at in turn, because a file where a directory goes is in the way too.
fn blocked_at(root: &Path, path: &[u8], tracked: &BTreeSet<RawPath>) -> Option<RawPath> {
    let slashes = path
        .iter()
        .enumerate()
        .filter(|(_, byte)| **byte == b'/')
        .map(|(at, _)| at);
    for end in slashes.chain([path.len()]) {
        let part = &path[..end];
        let on_disk = in_workdir(root, part)?;
        let meta = match on_disk.symlink_metadata() {
            Ok(meta) => meta,
            // Nothing here, so nothing below it either.
            Err(e) if e.kind() == io::ErrorKind::NotFound => return None,
            // Cannot look: that is not "free".
            Err(_) => return Some(part.to_vec()),
        };
        if meta.is_dir() {
            if end == path.len() && holds_untracked(&on_disk, part, tracked) {
                return Some(part.to_vec());
            }
            continue;
        }
        // A file or a symlink: the reset replaces it, unless it is tracked (then replacing it
        // is part of the merge being undone).
        return (!tracked.contains(part)).then(|| part.to_vec());
    }
    None
}

/// Does the directory `dir` (at `rel`) hold a file that the index does not have? A directory that
/// cannot be read is taken to.
fn holds_untracked(dir: &Path, rel: &[u8], tracked: &BTreeSet<RawPath>) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return true;
    };
    for entry in entries {
        let Ok(entry) = entry else {
            return true;
        };
        let mut child = rel.to_vec();
        child.push(b'/');
        child.extend(raw_name(&entry.file_name()));
        // `file_type` does not follow symbolic links: a link is a file here, as it is to git.
        let is_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
        let untracked = if is_dir {
            holds_untracked(&entry.path(), &child, tracked)
        } else {
            !tracked.contains(&child)
        };
        if untracked {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::git::pull::{integrate, Pulled};
    use crate::test_support::{
        all_refs, clone_main, commit_file, delete_file, diverged_with_conflict, fetch_main, files,
        head, index_on_disk, me, merge_state, no_changes, orig_head_text, push_main, server_at,
        theirs, two_clones, work_repo, write_file,
    };

    /// A pull that stopped on a conflict in a.txt (and brought added.txt in cleanly). `ours` is
    /// where it started. Our side also changed `ours-only.txt` earlier, which the merge leaves
    /// alone, and there is an untracked `scratch.txt`.
    fn stopped_on_a_conflict(dir: &Path) -> (Repository, Oid) {
        let (server, _one, two) = diverged_with_conflict(dir);
        commit_file(&two, "ours-only.txt", "ours only\n");
        write_file(&two, "scratch.txt", "untracked\n");
        let ours = head(&two);
        let tip = fetch_main(&two, &server);
        let pulled = integrate(&two, "main", &theirs(tip), me).unwrap();
        assert!(matches!(pulled, Pulled::Conflict { .. }), "{pulled:?}");
        (two, ours)
    }

    fn stage(repo: &Repository, path: &str) {
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(path)).unwrap();
        index.write().unwrap();
    }

    // ---- what it undoes ---------------------------------------------------------------------------

    #[test]
    fn abort_puts_head_the_files_and_the_index_back_and_leaves_untracked_files() {
        let dir = tempfile::tempdir().unwrap();
        let (server, _one, two) = diverged_with_conflict(dir.path());
        write_file(&two, "scratch.txt", "untracked\n");
        let ours = head(&two);
        let (files_before, index_before) = (files(&two), index_on_disk(&two));
        let tip = fetch_main(&two, &server);
        let pulled = integrate(&two, "main", &theirs(tip), me).unwrap();
        assert!(matches!(pulled, Pulled::Conflict { .. }));
        assert!(
            files(&two).contains_key("added.txt"),
            "the merge brought it in"
        );
        // A person had begun on the conflict, and had touched a file the merge brought in.
        write_file(&two, "a.txt", "half resolved\n");
        write_file(&two, "added.txt", "edited by me\n");

        let back = abort(&two).unwrap();
        assert_eq!(back, ours);
        assert_eq!(head(&two), ours);
        assert_eq!(
            files(&two),
            files_before,
            "the resolutions are gone, added.txt is gone, scratch.txt is not"
        );
        assert_eq!(index_on_disk(&two), index_before);
        assert!(merge_state(&two).is_empty());
        assert_eq!(two.state(), RepositoryState::Clean);
        assert!(!two.index().unwrap().has_conflicts());
        assert_eq!(files(&two)["scratch.txt"], "untracked\n");
    }

    #[test]
    fn abort_also_undoes_a_resolution_that_was_staged() {
        let dir = tempfile::tempdir().unwrap();
        let (server, _one, two) = diverged_with_conflict(dir.path());
        let ours = head(&two);
        let tip = fetch_main(&two, &server);
        integrate(&two, "main", &theirs(tip), me).unwrap();
        write_file(&two, "a.txt", "resolved\n");
        stage(&two, "a.txt");

        abort(&two).unwrap();
        assert_eq!(files(&two)["a.txt"], "ours\n");
        assert!(!files(&two).contains_key("added.txt"));
        assert_eq!(head(&two), ours);
        assert!(no_changes(&two));
    }

    #[test]
    fn abort_goes_back_to_head_when_orig_head_is_missing_or_is_not_a_commit() {
        for damage in ["missing", "garbage", "not a commit"] {
            let dir = tempfile::tempdir().unwrap();
            let (server, _one, two) = diverged_with_conflict(dir.path());
            let ours = head(&two);
            let tip = fetch_main(&two, &server);
            integrate(&two, "main", &theirs(tip), me).unwrap();
            let orig = two.path().join("ORIG_HEAD");
            match damage {
                "missing" => std::fs::remove_file(&orig).unwrap(),
                "garbage" => std::fs::write(&orig, "this is not an object id\n").unwrap(),
                _ => std::fs::write(&orig, "0123456789abcdef0123456789abcdef01234567\n").unwrap(),
            }
            let back = abort(&two).unwrap();
            assert_eq!(back, ours, "{damage}");
            assert_eq!(head(&two), ours, "{damage}");
            assert_eq!(files(&two)["a.txt"], "ours\n", "{damage}");
            assert!(merge_state(&two).is_empty(), "{damage}");
        }
    }

    // ---- what it refuses to undo --------------------------------------------------------------------

    /// Everything an abort that is refused must leave exactly as it was.
    #[derive(Debug, PartialEq)]
    struct Snapshot {
        refs: Vec<(String, String)>,
        files: std::collections::BTreeMap<String, String>,
        index: Vec<(String, u16, Oid)>,
        orig_head: Option<String>,
        merge_state: Vec<&'static str>,
    }

    fn state(repo: &Repository) -> Snapshot {
        Snapshot {
            refs: all_refs(repo),
            files: files(repo),
            index: index_on_disk(repo),
            orig_head: orig_head_text(repo),
            merge_state: merge_state(repo),
        }
    }

    #[test]
    fn abort_refuses_to_discard_edits_to_files_the_merge_did_not_touch_and_changes_nothing() {
        // (what was done after the pull stopped, and how to take it back)
        type Edit = fn(&Repository);
        let cases: [(&str, Edit, Edit); 5] = [
            (
                "keep.txt",
                |r| write_file(r, "keep.txt", "my edit\n"),
                |r| write_file(r, "keep.txt", "keep\n"),
            ),
            (
                "keep.txt",
                |r| {
                    write_file(r, "keep.txt", "staged edit\n");
                    stage(r, "keep.txt");
                },
                |r| {
                    write_file(r, "keep.txt", "keep\n");
                    stage(r, "keep.txt");
                },
            ),
            (
                "keep.txt",
                |r| std::fs::remove_file(r.workdir().unwrap().join("keep.txt")).unwrap(),
                |r| write_file(r, "keep.txt", "keep\n"),
            ),
            (
                "mine.txt",
                |r| {
                    write_file(r, "mine.txt", "a new file\n");
                    stage(r, "mine.txt");
                },
                |r| {
                    let mut index = r.index().unwrap();
                    index.remove_path(Path::new("mine.txt")).unwrap();
                    index.write().unwrap();
                    std::fs::remove_file(r.workdir().unwrap().join("mine.txt")).unwrap();
                },
            ),
            // Only our own side changed this file, long before: the merge leaves it as it is, so
            // it is not part of the merge, even though MERGE_HEAD's tree differs from it.
            (
                "ours-only.txt",
                |r| write_file(r, "ours-only.txt", "edited during the resolution\n"),
                |r| write_file(r, "ours-only.txt", "ours only\n"),
            ),
        ];
        for (n, (name, edit, undo)) in cases.into_iter().enumerate() {
            let dir = tempfile::tempdir().unwrap();
            let (two, ours) = stopped_on_a_conflict(dir.path());
            let conflicted = std::fs::read_to_string(two.workdir().unwrap().join("a.txt")).unwrap();
            assert!(conflicted.contains("<<<<<<<"));
            edit(&two);
            let before = state(&two);

            let err = abort(&two).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "case {n}: {err:?}");
            assert_eq!(err.exit_code(), 2, "case {n}");
            let text = err.to_string();
            assert!(text.contains(name), "case {n}: {text}");
            // Advice that can be followed in the middle of a merge: not "commit them first".
            assert!(
                text.contains("put them back as they were before the pull"),
                "case {n}: {text}"
            );
            assert!(
                text.contains("run nsit pull --abort again"),
                "case {n}: {text}"
            );
            assert!(!text.contains("commit"), "case {n}: {text}");
            assert!(!text.contains('\n'), "case {n}: {text:?}");
            assert!(
                !text.contains("scratch.txt"),
                "case {n}: untracked files are not listed"
            );
            assert_eq!(state(&two), before, "case {n}: nothing changed");
            assert_eq!(two.state(), RepositoryState::Merge, "case {n}");
            assert_eq!(
                std::fs::read_to_string(two.workdir().unwrap().join("a.txt")).unwrap(),
                conflicted,
                "case {n}: the conflict is still there"
            );
            assert_eq!(files(&two)["scratch.txt"], "untracked\n", "case {n}");

            // Once that is taken back, the abort goes through.
            undo(&two);
            let back = abort(&two).unwrap_or_else(|e| panic!("case {n}: {e}"));
            assert_eq!(back, ours, "case {n}");
            assert_eq!(head(&two), ours, "case {n}");
            assert!(merge_state(&two).is_empty(), "case {n}");
            assert_eq!(files(&two)["scratch.txt"], "untracked\n", "case {n}");
        }
    }

    /// A pull that stopped on a conflict in a.txt, in which the merge also deleted each of
    /// `deleted` (files our side has and their side removed; the merge takes them out of the
    /// working directory). `ours` is where the pull started.
    fn stopped_after_the_merge_deleted(dir: &Path, deleted: &[&str]) -> (Repository, Oid) {
        let server = server_at(dir);
        let one = work_repo(dir, "one", &server);
        commit_file(&one, "a.txt", "base\n");
        for name in deleted {
            write_file(&one, name, "mine to lose\n");
            commit_file(&one, name, "mine to lose\n");
        }
        push_main(&one, &server);
        let two = clone_main(dir, "two", &server);
        commit_file(&one, "a.txt", "theirs\n");
        for name in deleted {
            delete_file(&one, name);
        }
        push_main(&one, &server);
        commit_file(&two, "a.txt", "ours\n");
        let ours = head(&two);
        let tip = fetch_main(&two, &server);
        let pulled = integrate(&two, "main", &theirs(tip), me).unwrap();
        assert!(matches!(pulled, Pulled::Conflict { .. }), "{pulled:?}");
        for name in deleted {
            assert!(
                !two.workdir().unwrap().join(name).exists(),
                "the merge took {name} away"
            );
        }
        (two, ours)
    }

    /// Hide `name` from `repo` the way a person does locally: `.git/info/exclude`.
    fn ignore(repo: &Repository, name: &str) {
        let info = repo.path().join("info");
        std::fs::create_dir_all(&info).unwrap();
        std::fs::write(info.join("exclude"), format!("{name}\n")).unwrap();
        assert!(repo.status_should_ignore(Path::new(name)).unwrap());
    }

    #[test]
    fn abort_refuses_to_overwrite_a_file_you_made_where_the_merge_deleted_one() {
        // The file is untracked, or it is ignored (and so not shown by status either).
        for ignored in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let (two, ours) = stopped_after_the_merge_deleted(dir.path(), &["gone.txt"]);
            write_file(&two, "scratch.txt", "untracked, and in nobody's way\n");
            write_file(&two, "gone.txt", "my own work\n");
            if ignored {
                ignore(&two, "gone.txt");
            }
            let before = state(&two);

            let err = abort(&two).unwrap_err();
            assert!(
                matches!(err, NsitError::Usage(_)),
                "ignored={ignored}: {err:?}"
            );
            assert_eq!(err.exit_code(), 2, "ignored={ignored}");
            let text = err.to_string();
            assert!(text.contains("gone.txt"), "ignored={ignored}: {text}");
            assert!(
                !text.contains("scratch.txt"),
                "only files in the way are named: {text}"
            );
            assert!(!text.contains('\n'), "{text:?}");
            assert!(
                text.contains("run nsit pull --abort again"),
                "it says how to go on: {text}"
            );
            assert_eq!(state(&two), before, "ignored={ignored}: nothing changed");
            assert_eq!(two.state(), RepositoryState::Merge);
            assert_eq!(
                files(&two)["gone.txt"],
                "my own work\n",
                "ignored={ignored}"
            );

            // Once it is out of the way the abort goes through, and puts the file back.
            std::fs::remove_file(two.workdir().unwrap().join("gone.txt")).unwrap();
            assert_eq!(abort(&two).unwrap(), ours, "ignored={ignored}");
            assert_eq!(
                files(&two)["gone.txt"],
                "mine to lose\n",
                "ignored={ignored}"
            );
            assert_eq!(
                files(&two)["scratch.txt"],
                "untracked, and in nobody's way\n"
            );
            assert!(merge_state(&two).is_empty());
        }
    }

    #[test]
    fn a_file_where_the_merge_deleted_a_directory_or_where_a_directory_has_to_go_is_in_the_way_too()
    {
        // The merge deleted `dir/inner.txt` (and with it the directory), and a *file* called
        // `dir` was made since: the abort would have to replace it with the directory.
        let dir = tempfile::tempdir().unwrap();
        let (two, ours) = stopped_after_the_merge_deleted(dir.path(), &["dir/inner.txt"]);
        write_file(&two, "dir", "a file where a directory goes\n");
        let before = state(&two);
        let err = abort(&two).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert!(err.to_string().contains("dir"), "{err}");
        assert_eq!(state(&two), before);
        std::fs::remove_file(two.workdir().unwrap().join("dir")).unwrap();
        assert_eq!(abort(&two).unwrap(), ours);
        assert_eq!(files(&two)["dir/inner.txt"], "mine to lose\n");

        // The merge deleted the file `docs`, and a *directory* with a file of yours in it was
        // made there since: the abort would have to replace it with the file.
        let dir = tempfile::tempdir().unwrap();
        let (two, ours) = stopped_after_the_merge_deleted(dir.path(), &["docs"]);
        write_file(&two, "docs/mine.txt", "my notes\n");
        let before = state(&two);
        let err = abort(&two).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert!(err.to_string().contains("docs"), "{err}");
        assert_eq!(state(&two), before);
        assert_eq!(files(&two)["docs/mine.txt"], "my notes\n");
        std::fs::remove_dir_all(two.workdir().unwrap().join("docs")).unwrap();
        assert_eq!(abort(&two).unwrap(), ours);
        assert_eq!(files(&two)["docs"], "mine to lose\n");
    }

    #[test]
    fn untracked_files_beside_what_the_merge_deleted_are_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let (two, ours) = stopped_after_the_merge_deleted(dir.path(), &["dir/inner.txt"]);
        // Next to the file the abort puts back, but not in its way.
        write_file(&two, "dir/other.txt", "mine\n");
        write_file(&two, "scratch.txt", "mine too\n");
        assert_eq!(abort(&two).unwrap(), ours);
        let found = files(&two);
        assert_eq!(found["dir/inner.txt"], "mine to lose\n");
        assert_eq!(found["dir/other.txt"], "mine\n");
        assert_eq!(found["scratch.txt"], "mine too\n");
    }

    #[test]
    fn every_file_outside_the_merge_that_was_changed_is_named_and_a_long_list_is_cut() {
        let dir = tempfile::tempdir().unwrap();
        let (two, _ours) = stopped_on_a_conflict(dir.path());
        write_file(&two, "keep.txt", "edited\n");
        write_file(&two, "ours-only.txt", "edited\n");
        let err = abort(&two).unwrap_err();
        assert!(err.to_string().contains("keep.txt, ours-only.txt"), "{err}");
        assert_eq!(two.state(), RepositoryState::Merge);
    }

    #[test]
    fn the_merge_set_is_what_the_merge_changed_and_what_is_in_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let (two, ours) = stopped_on_a_conflict(dir.path());
        let base = two.find_commit(ours).unwrap();
        let set: Vec<String> = merge_set(&two, &base)
            .unwrap()
            .iter()
            .map(|path| display(path))
            .collect();
        // The conflicted file and the file that came in; not keep.txt, which nobody changed, and
        // not ours-only.txt, which only our side changed.
        assert_eq!(set, ["a.txt", "added.txt"]);
    }

    #[test]
    fn a_merge_of_several_commits_is_counted_generously_and_never_less() {
        let dir = tempfile::tempdir().unwrap();
        let (two, ours) = stopped_on_a_conflict(dir.path());
        // As git's octopus merge would leave it: more than one line in MERGE_HEAD.
        let merge_head = two.path().join("MERGE_HEAD");
        let text = std::fs::read_to_string(&merge_head).unwrap();
        std::fs::write(&merge_head, format!("{text}{text}")).unwrap();

        write_file(&two, "keep.txt", "edited\n");
        let err = abort(&two).unwrap_err();
        assert!(err.to_string().contains("keep.txt"), "{err}");
        write_file(&two, "keep.txt", "keep\n");
        assert_eq!(abort(&two).unwrap(), ours);
        assert!(merge_state(&two).is_empty());
    }

    #[test]
    fn abort_without_a_merge_is_a_usage_error_and_touches_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (_server, _one, two) = two_clones(dir.path());
        // Work that a hard reset would destroy.
        write_file(&two, "a.txt", "my work\n");
        let before = state(&two);

        let err = abort(&two).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert_eq!(err.exit_code(), 2);
        assert!(err.to_string().contains("no merge in progress"), "{err}");
        assert!(!err.to_string().contains('\n'));
        assert_eq!(state(&two), before);

        // Another operation's state is not a merge either.
        std::fs::write(
            two.path().join("CHERRY_PICK_HEAD"),
            format!("{}\n", head(&two)),
        )
        .unwrap();
        let err = abort(&two).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert!(err.to_string().contains("no merge in progress"), "{err}");
        assert!(err.to_string().contains("a cherry-pick"), "{err}");
        assert_eq!(files(&two)["a.txt"], "my work\n");
    }
}
