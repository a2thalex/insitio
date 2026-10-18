//! Staging, and the questions about the repository's state that `add`,
//! `commit`, `init`, `status` and `switch` all ask.
//!
//! Nothing here writes the index file: callers change an `Index` in memory and
//! decide when to `write()` it. That is how `commit` can refuse (exit 5) and
//! leave the index on disk exactly as it was.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Read;
use std::path::Path;

use git2::{Commit, Delta, ErrorCode, Index, IndexAddOption, IndexEntry, Oid, Repository, Tree};

use super::paths::{slash, workdir, RawPath};
use crate::error::NsitError;

/// Stage every change in the working directory, new files included. Files
/// matched by `.gitignore`, `.git/info/exclude` and the global excludes file
/// are left alone; tracked files that were changed or deleted are updated.
pub fn stage_all(index: &mut Index) -> Result<(), NsitError> {
    index.add_all(["*"], IndexAddOption::DEFAULT, None)?;
    index.update_all(["*"], None)?;
    Ok(())
}

/// Stage the given repository-relative paths (files or directories; `""` is
/// the whole working directory). Returns the paths whose entries changed.
///
/// A deleted file that is tracked is staged as deleted. A path that does not
/// exist and is not tracked, or that `.gitignore` excludes and that is not
/// already tracked, is a usage error and nothing for it is staged. Names are
/// taken literally: `[` and `*` in a file name are not patterns.
pub fn stage_paths(
    repo: &Repository,
    index: &mut Index,
    rels: &[String],
) -> Result<Vec<String>, NsitError> {
    let root = workdir(repo)?;
    // Refuse before staging anything, so a mistake in the last path does not
    // leave the first ones staged.
    for rel in rels {
        check_stageable(repo, index, root, rel)?;
    }
    let mut changed = BTreeSet::new();
    for rel in rels {
        let patterns = literal_pathspecs(rel);
        let specs = || patterns.iter().map(String::as_str);
        let mut record = |path: &Path, _: &[u8]| -> i32 {
            changed.insert(slash(path));
            0
        };
        if rel.is_empty() || root.join(rel).symlink_metadata().is_ok() {
            index.add_all(specs(), IndexAddOption::DEFAULT, Some(&mut record))?;
        }
        // Deletions (of the file itself or of files below a directory).
        index.update_all(specs(), Some(&mut record))?;
    }
    Ok(changed.into_iter().collect())
}

/// The patterns that select exactly the file `rel`, or the files below the
/// directory `rel`, and nothing else; `*` for the whole working directory
/// (`rel` empty).
///
/// libgit2 reads the paths it is given as patterns, and its flag that is meant
/// to turn that off (`DISABLE_PATHSPEC_MATCH`) does nothing in `add_all` and
/// `update_all`. A file called `a[1].txt` would otherwise also stage `a1.txt`.
/// So what means something in a pattern is made literal:
///
/// * `*`, `?`, `[` (and `\` where that is a file name character) go in a
///   one-character class, `[*]`. Backslash escapes cannot be used: git2 turns
///   backslashes in paths into slashes on Windows.
/// * A leading `/` keeps a name that starts with `!` or `#` from being read as a
///   negated pattern or a comment. libgit2 drops that slash.
fn literal_pathspecs(rel: &str) -> Vec<String> {
    if rel.is_empty() {
        return vec!["*".to_string()];
    }
    let mut literal = String::with_capacity(rel.len() + 2);
    literal.push('/');
    for c in rel.chars() {
        match c {
            '*' | '?' | '[' => {
                literal.push('[');
                literal.push(c);
                literal.push(']');
            }
            // Inside a class a backslash escapes the next character, so it is doubled.
            '\\' if cfg!(not(windows)) => literal.push_str("[\\\\]"),
            other => literal.push(other),
        }
    }
    let below = format!("{literal}/*");
    vec![literal, below]
}

fn check_stageable(
    repo: &Repository,
    index: &Index,
    root: &Path,
    rel: &str,
) -> Result<(), NsitError> {
    if rel.is_empty() {
        return Ok(());
    }
    if rel == ".git" || rel.starts_with(".git/") {
        return Err(NsitError::Usage("cannot stage anything in .git".into()));
    }
    // libgit2 cuts a pattern at a line break and drops trailing spaces, so such
    // a name would select a different file (or none, which libgit2 takes to
    // mean every file). `nsit commit` still stages these files: it needs no names.
    if rel.chars().any(char::is_control) || rel.ends_with(char::is_whitespace) {
        return Err(NsitError::Usage(format!(
            "cannot stage {rel:?} by name: names with control characters or a trailing space \
             are only staged by nsit commit"
        )));
    }
    let tracked = is_tracked(index, rel);
    if root.join(rel).symlink_metadata().is_err() {
        return if tracked {
            Ok(())
        } else {
            Err(NsitError::Usage(format!(
                "{rel} did not match any files (it is not there and was never committed)"
            )))
        };
    }
    if !tracked && repo.is_path_ignored(rel)? {
        return Err(NsitError::Usage(format!("{rel} is ignored by .gitignore")));
    }
    Ok(())
}

/// Is `rel` (a file, or a directory with files in it) in the index?
fn is_tracked(index: &Index, rel: &str) -> bool {
    if entry(index, rel).is_some() {
        return true;
    }
    let below = format!("{rel}/");
    index.iter().any(|e| e.path.starts_with(below.as_bytes()))
}

/// The stage-0 entry for a repository-relative path, if there is one.
/// (`Index::get_path` panics on an empty path or one with `.`/`..` parts, so
/// those are answered here.)
pub fn entry(index: &Index, rel: &str) -> Option<IndexEntry> {
    let usable = !rel.is_empty()
        && rel
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..");
    if !usable || rel.starts_with('/') || (cfg!(windows) && rel.contains(':')) {
        return None;
    }
    index.get_path(Path::new(rel), 0)
}

/// The commit `HEAD` points at, or `None` on a branch with no commits yet.
pub fn head_commit(repo: &Repository) -> Result<Option<Commit<'_>>, NsitError> {
    match repo.head() {
        Ok(head) => Ok(Some(head.peel_to_commit()?)),
        Err(e) if matches!(e.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// The branch `HEAD` names (`main`), also before it has a first commit. `None`
/// when `HEAD` is detached.
pub fn current_branch(repo: &Repository) -> Option<String> {
    let head = repo.find_reference("HEAD").ok()?;
    let target = head.symbolic_target().ok()??;
    target.strip_prefix("refs/heads/").map(str::to_string)
}

/// The commits a merge in progress is bringing in (`.git/MERGE_HEAD`), empty
/// when there is none.
pub fn merge_heads(repo: &Repository) -> Result<Vec<Oid>, NsitError> {
    let text = match std::fs::read_to_string(repo.path().join("MERGE_HEAD")) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| Oid::from_str(line).map_err(NsitError::from))
        .collect()
}

/// The paths a commit made from `index` would add or change compared with
/// `base` (`None`: an empty tree, as before the first commit), as raw bytes.
/// Deleted paths are not included: there is nothing left to check in them.
pub fn changed_paths(
    repo: &Repository,
    index: &Index,
    base: Option<&Tree<'_>>,
) -> Result<Vec<RawPath>, NsitError> {
    let diff = repo.diff_tree_to_index(base, Some(index), None)?;
    Ok(diff
        .deltas()
        .filter(|delta| delta.status() != Delta::Deleted)
        .filter_map(|delta| delta.new_file().path_bytes().map(<[u8]>::to_vec))
        .collect())
}

/// `GIT_INDEX_ENTRY_STAGEMASK`: the two bits of an entry's flags that hold its
/// merge stage (0 is a normal entry, 1 to 3 are the sides of a conflict).
const STAGE_MASK: u16 = 0x3000;

/// The normal (stage 0) index entries at the given raw paths, found by comparing
/// bytes. `Index::get_path` takes a `Path`, which cannot carry every byte
/// string (a file name that is not UTF-8 on Windows, and on any system one that
/// merely looks different once turned into text), so a lookup through it can
/// miss a file that is in the index. A path that is not in the result is not in
/// the index.
pub fn entries_at(index: &Index, wanted: &[RawPath]) -> HashMap<RawPath, IndexEntry> {
    let wanted: HashSet<&[u8]> = wanted.iter().map(Vec::as_slice).collect();
    index
        .iter()
        .filter(|entry| entry.flags & STAGE_MASK == 0 && wanted.contains(entry.path.as_slice()))
        .map(|entry| (entry.path.clone(), entry))
        .collect()
}

/// The first `limit` bytes of a blob. Streams from the object database where it
/// can (a loose object, which is what staging writes), so a huge file is not
/// loaded whole; otherwise reads the blob.
pub fn read_start(repo: &Repository, id: Oid, limit: usize) -> Result<Vec<u8>, NsitError> {
    if let Ok((reader, _, _)) = repo.odb()?.reader(id) {
        let mut start = Vec::new();
        if reader.take(limit as u64).read_to_end(&mut start).is_ok() {
            return Ok(start);
        }
    }
    read_start_from_blob(repo, id, limit)
}

fn read_start_from_blob(repo: &Repository, id: Oid, limit: usize) -> Result<Vec<u8>, NsitError> {
    let blob = repo.find_blob(id)?;
    let content = blob.content();
    Ok(content[..content.len().min(limit)].to_vec())
}

/// The paths with unresolved merge conflicts in `index`, sorted, as raw bytes.
pub fn conflicted_paths(index: &Index) -> Result<Vec<RawPath>, NsitError> {
    let mut paths = BTreeSet::new();
    for conflict in index.conflicts()? {
        let conflict = conflict?;
        if let Some(side) = conflict.our.or(conflict.their).or(conflict.ancestor) {
            paths.insert(side.path);
        }
    }
    Ok(paths.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{local_repo, stage_raw, write_file as write};

    fn staged_names(repo: &Repository) -> Vec<String> {
        let mut index = repo.index().unwrap();
        index.read(true).unwrap();
        index
            .iter()
            .map(|e| String::from_utf8_lossy(&e.path).into_owned())
            .collect()
    }

    #[test]
    fn stage_all_takes_new_and_changed_files_but_not_ignored_ones() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, ".gitignore", "dist/\n*.log\n");
        write(&repo, "a.txt", "a");
        write(&repo, "src/b.txt", "b");
        write(&repo, "dist/out.js", "x");
        write(&repo, "build.log", "x");
        write(&repo, ".env.example", "KEY=");
        let mut index = repo.index().unwrap();
        stage_all(&mut index).unwrap();
        let names: Vec<String> = index
            .iter()
            .map(|e| String::from_utf8_lossy(&e.path).into_owned())
            .collect();
        assert_eq!(names, [".env.example", ".gitignore", "a.txt", "src/b.txt"]);
        // Nothing is on disk until the caller writes.
        assert!(staged_names(&repo).is_empty());
    }

    #[test]
    fn stage_all_records_deletions_and_edits_of_tracked_files() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, "keep.txt", "1");
        write(&repo, "edit.txt", "1");
        write(&repo, "gone.txt", "1");
        let mut index = repo.index().unwrap();
        stage_all(&mut index).unwrap();
        index.write().unwrap();
        write(&repo, "edit.txt", "2");
        std::fs::remove_file(repo.workdir().unwrap().join("gone.txt")).unwrap();
        stage_all(&mut index).unwrap();
        let names: Vec<String> = index
            .iter()
            .map(|e| String::from_utf8_lossy(&e.path).into_owned())
            .collect();
        assert_eq!(names, ["edit.txt", "keep.txt"]);
        let edited = index.get_path(Path::new("edit.txt"), 0).unwrap();
        assert_eq!(repo.find_blob(edited.id).unwrap().content(), b"2");
    }

    #[test]
    fn stage_paths_stages_files_and_directories_and_reports_them() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, "a.txt", "a");
        write(&repo, "d/one.txt", "1");
        write(&repo, "d/two/three.txt", "3");
        write(&repo, "other.txt", "o");
        let mut index = repo.index().unwrap();
        let changed = stage_paths(&repo, &mut index, &["a.txt".into(), "d".into()]).unwrap();
        assert_eq!(changed, ["a.txt", "d/one.txt", "d/two/three.txt"]);
        assert!(entry(&index, "other.txt").is_none());
        // Again: nothing new.
        let again = stage_paths(&repo, &mut index, &["a.txt".into(), "d".into()]).unwrap();
        assert!(again.is_empty(), "{again:?}");
    }

    #[test]
    fn stage_paths_takes_names_literally() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, "a[1].txt", "bracket");
        write(&repo, "a1.txt", "one");
        write(&repo, "!bang.txt", "bang");
        write(&repo, "#hash.txt", "hash");
        write(&repo, "d[1]/inside.txt", "in");
        write(&repo, "d1/other.txt", "other");
        let mut wanted: Vec<String> = ["a[1].txt", "!bang.txt", "#hash.txt", "d[1]"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let mut expected = vec!["!bang.txt", "#hash.txt", "a[1].txt", "d[1]/inside.txt"];
        let mut unwanted = vec!["a1.txt", "d1/other.txt"];
        // Windows does not allow `*` or `?` in a file name.
        if cfg!(unix) {
            write(&repo, "star*.txt", "star");
            write(&repo, "starry.txt", "no");
            write(&repo, "one?.txt", "q");
            write(&repo, "oneX.txt", "no");
            write(&repo, "back\\slash.txt", "bs");
            wanted.extend(["star*.txt", "one?.txt", "back\\slash.txt"].map(String::from));
            expected.extend(["back\\slash.txt", "one?.txt", "star*.txt"]);
            unwanted.extend(["starry.txt", "oneX.txt"]);
        }
        expected.sort_unstable();
        let mut index = repo.index().unwrap();
        let changed = stage_paths(&repo, &mut index, &wanted).unwrap();
        assert_eq!(changed, expected);
        for name in unwanted {
            assert!(
                entry(&index, name).is_none(),
                "{name} was staged by a pattern"
            );
        }
    }

    #[test]
    fn stage_paths_stages_a_deleted_tracked_file_and_refuses_an_unknown_one() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, "a.txt", "a");
        write(&repo, "d/b.txt", "b");
        let mut index = repo.index().unwrap();
        stage_all(&mut index).unwrap();
        index.write().unwrap();
        std::fs::remove_file(dir.path().join("a.txt")).unwrap();
        std::fs::remove_dir_all(dir.path().join("d")).unwrap();
        let changed = stage_paths(&repo, &mut index, &["a.txt".into(), "d".into()]).unwrap();
        assert_eq!(changed, ["a.txt", "d/b.txt"]);
        assert!(index.is_empty());

        let err = stage_paths(&repo, &mut index, &["never.txt".into()]).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert!(err.to_string().contains("never.txt"), "{err}");
    }

    #[test]
    fn an_explicitly_named_ignored_path_is_a_usage_error_and_stages_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, ".gitignore", "dist/\nsecret.log\n");
        write(&repo, "a.txt", "a");
        write(&repo, "dist/out.js", "x");
        write(&repo, "secret.log", "x");
        let mut index = repo.index().unwrap();
        for ignored in ["dist", "dist/out.js", "secret.log"] {
            let err =
                stage_paths(&repo, &mut index, &["a.txt".into(), ignored.into()]).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{ignored}: {err:?}");
            assert_eq!(
                err.to_string(),
                format!("{ignored} is ignored by .gitignore")
            );
            assert!(index.is_empty(), "{ignored}: a.txt was staged anyway");
        }
        // The same files inside a directory that is named are skipped quietly.
        let changed = stage_paths(&repo, &mut index, &["".into()]).unwrap();
        assert_eq!(changed, [".gitignore", "a.txt"]);
    }

    #[test]
    fn a_tracked_file_that_is_now_ignored_can_still_be_staged() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, "made.log", "1");
        let mut index = repo.index().unwrap();
        stage_all(&mut index).unwrap();
        index.write().unwrap();
        write(&repo, ".gitignore", "*.log\n");
        write(&repo, "made.log", "2");
        let changed = stage_paths(&repo, &mut index, &["made.log".into()]).unwrap();
        assert_eq!(changed, ["made.log"]);
    }

    #[test]
    fn names_libgit2_would_misread_as_patterns_are_refused_before_anything_is_staged() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, "a.txt", "a");
        let mut index = repo.index().unwrap();
        for rel in [
            "line\nbreak",
            "tab\t",
            "space ",
            "bell\u{7}",
            "  ",
            "\u{1b}[31m",
        ] {
            let err = stage_paths(&repo, &mut index, &["a.txt".into(), rel.into()]).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{rel:?}: {err:?}");
            assert!(
                err.to_string()
                    .contains("control characters or a trailing space"),
                "{rel:?}: {err}"
            );
            assert!(index.is_empty(), "{rel:?}: a.txt was staged anyway");
        }
        // A space inside a name, or at the start, is fine.
        write(&repo, " lead and inner.txt", "x");
        let changed = stage_paths(&repo, &mut index, &[" lead and inner.txt".into()]).unwrap();
        assert_eq!(changed, [" lead and inner.txt"]);
    }

    #[test]
    fn nothing_inside_dot_git_can_be_staged() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let mut index = repo.index().unwrap();
        for rel in [".git", ".git/config"] {
            let err = stage_paths(&repo, &mut index, &[rel.into()]).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{rel}: {err:?}");
        }
    }

    #[test]
    fn entry_never_panics_on_paths_libgit2_would_reject() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let index = repo.index().unwrap();
        for rel in ["", ".", "./a", "../a", "a//b", "/a", "a/./b", "a/../b"] {
            assert!(entry(&index, rel).is_none(), "{rel:?}");
        }
    }

    #[test]
    fn the_branch_is_known_before_the_first_commit_and_not_when_detached() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        assert_eq!(current_branch(&repo).as_deref(), Some("main"));
        assert!(head_commit(&repo).unwrap().is_none());
        crate::test_support::commit_file(&repo, "a.txt", "a");
        let head = head_commit(&repo).unwrap().expect("a commit now");
        assert_eq!(current_branch(&repo).as_deref(), Some("main"));
        repo.set_head_detached(head.id()).unwrap();
        assert_eq!(current_branch(&repo), None);
        assert_eq!(head_commit(&repo).unwrap().unwrap().id(), head.id());
    }

    #[test]
    fn changed_paths_lists_additions_and_edits_not_deletions() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        crate::test_support::commit_file(&repo, "old.txt", "1");
        crate::test_support::commit_file(&repo, "edit.txt", "1");
        write(&repo, "edit.txt", "2");
        write(&repo, "new.txt", "n");
        std::fs::remove_file(dir.path().join("old.txt")).unwrap();
        let mut index = repo.index().unwrap();
        stage_all(&mut index).unwrap();
        let head_tree = head_commit(&repo).unwrap().unwrap().tree().unwrap();
        let paths = changed_paths(&repo, &index, Some(&head_tree)).unwrap();
        assert_eq!(paths, [b"edit.txt".to_vec(), b"new.txt".to_vec()]);
        // Before the first commit everything staged is new.
        let empty_dir = tempfile::tempdir().unwrap();
        let fresh = local_repo(empty_dir.path());
        write(&fresh, "x.txt", "x");
        let mut index = fresh.index().unwrap();
        stage_all(&mut index).unwrap();
        let paths = changed_paths(&fresh, &index, None).unwrap();
        assert_eq!(paths, [b"x.txt".to_vec()]);
    }

    #[test]
    fn changed_paths_and_entries_keep_names_that_are_not_text_as_raw_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let odd = b"donn\xe9es/.env".to_vec();
        let plain = b"plain.txt".to_vec();
        stage_raw(&repo, &odd, b"secret");
        stage_raw(&repo, &plain, b"fine");
        let index = repo.index().unwrap();
        let mut paths = changed_paths(&repo, &index, None).unwrap();
        paths.sort();
        assert_eq!(paths, [odd.clone(), plain.clone()]);

        // Found by their bytes, where a lookup by the lossy text would miss.
        let found = entries_at(&index, &paths);
        assert_eq!(found.len(), 2);
        assert!(found.contains_key(&odd));
        let lossy = String::from_utf8_lossy(&odd).into_owned();
        assert!(
            entry(&index, &lossy).is_none(),
            "the text form is a different path"
        );
        // Only what was asked for, and only normal entries.
        assert_eq!(entries_at(&index, std::slice::from_ref(&plain)).len(), 1);
        assert!(entries_at(&index, &[b"missing".to_vec()]).is_empty());
    }

    #[test]
    fn reading_the_start_of_a_blob_works_streamed_and_whole() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let id = repo.blob(&vec![b'z'; 5000]).unwrap();
        assert_eq!(read_start(&repo, id, 100).unwrap(), vec![b'z'; 100]);
        assert_eq!(
            read_start_from_blob(&repo, id, 100).unwrap(),
            vec![b'z'; 100]
        );
        assert_eq!(read_start(&repo, id, 10_000).unwrap().len(), 5000);
        assert_eq!(read_start_from_blob(&repo, id, 10_000).unwrap().len(), 5000);
    }

    #[test]
    fn no_merge_means_no_merge_heads() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        assert!(merge_heads(&repo).unwrap().is_empty());
        let oid = "0123456789abcdef0123456789abcdef01234567";
        std::fs::write(repo.path().join("MERGE_HEAD"), format!("{oid}\n{oid}\n")).unwrap();
        let heads = merge_heads(&repo).unwrap();
        assert_eq!(heads.len(), 2);
        assert_eq!(heads[0].to_string(), oid);
    }
}
