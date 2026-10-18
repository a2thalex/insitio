//! `ORIG_HEAD`: the commit `HEAD` was at before a pull moved anything, written so that real git
//! and `nsit pull --abort` both find it.
//!
//! nsit writes the file itself (`<id>\n`, as git does) rather than relying on libgit2. libgit2's
//! `git_merge` does write it (`git_merge__setup`'s first step), but a fast-forward is not a
//! `git_merge`, and when `git_merge` refuses to go on (a local change in the way) it removes the
//! rest of its merge state yet leaves `ORIG_HEAD` rewritten. So nsit writes it before it moves
//! anything, remembers what was there, and puts that back if the pull fails.

use std::path::PathBuf;

use git2::{Commit, Oid, Repository};

use crate::error::NsitError;

/// `ORIG_HEAD`, written by this pull, and what it held before.
pub struct OrigHead {
    file: PathBuf,
    /// The bytes it had; `None` when there was no such file.
    previous: Option<Vec<u8>>,
}

impl OrigHead {
    /// Write `ORIG_HEAD` as git does (`<id>\n`), remembering what was there.
    pub fn set(repo: &Repository, id: Oid) -> Result<OrigHead, NsitError> {
        let file = repo.path().join("ORIG_HEAD");
        let previous = match std::fs::read(&file) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        std::fs::write(&file, format!("{id}\n"))?;
        Ok(OrigHead { file, previous })
    }

    /// The pull failed: put back what was there. A failure to do even that is not reported: the
    /// pull's own error is what matters, and `ORIG_HEAD` is only a pointer to the commit the
    /// branch was at, which the next pull or merge writes again.
    pub fn restore(self) {
        let _ = match self.previous {
            Some(bytes) => std::fs::write(&self.file, bytes),
            None => std::fs::remove_file(&self.file),
        };
    }
}

/// The commit `ORIG_HEAD` names: `None` when there is no such file, it does not hold an object
/// id, or that object is not a commit in this repository.
pub fn commit(repo: &Repository) -> Option<Commit<'_>> {
    let text = std::fs::read_to_string(repo.path().join("ORIG_HEAD")).ok()?;
    let id = Oid::from_str(text.trim()).ok()?;
    repo.find_commit(id).ok()
}

#[cfg(test)]
mod tests {
    use git2::build::CheckoutBuilder;
    use git2::ErrorCode;

    use super::*;
    use crate::git::pull::Theirs;
    use crate::test_support::{
        commit_file, diverged_without_conflict, fetch_main, head, local_repo, merge_state,
        orig_head_text, write_file, REMOTE_URL,
    };

    #[test]
    fn orig_head_is_written_as_git_writes_it_and_can_be_put_back() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "a\n");
        let id = head(&repo);

        // Nothing there before: restoring removes it again.
        let set = OrigHead::set(&repo, id).unwrap();
        assert_eq!(orig_head_text(&repo), Some(format!("{id}\n")));
        assert_eq!(repo.revparse_single("ORIG_HEAD").unwrap().id(), id);
        set.restore();
        assert_eq!(orig_head_text(&repo), None);

        // Something there before, even if it is not an object id: its bytes come back.
        std::fs::write(repo.path().join("ORIG_HEAD"), b"older\xff value").unwrap();
        let set = OrigHead::set(&repo, id).unwrap();
        assert_eq!(orig_head_text(&repo), Some(format!("{id}\n")));
        set.restore();
        assert_eq!(
            std::fs::read(repo.path().join("ORIG_HEAD")).unwrap(),
            b"older\xff value"
        );
    }

    #[test]
    fn the_commit_it_names_is_found_and_anything_else_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "a\n");
        let id = head(&repo);
        let file = repo.path().join("ORIG_HEAD");

        assert!(commit(&repo).is_none(), "no file");
        std::fs::write(&file, format!("{id}\n")).unwrap();
        assert_eq!(commit(&repo).unwrap().id(), id);
        for damaged in [
            "this is not an object id\n",
            "0123456789abcdef0123456789abcdef01234567\n",
            "",
        ] {
            std::fs::write(&file, damaged).unwrap();
            assert!(commit(&repo).is_none(), "{damaged:?}");
        }
        // An object that is not a commit (here, a blob) is none too.
        let blob = repo.blob(b"not a commit").unwrap();
        std::fs::write(&file, format!("{blob}\n")).unwrap();
        assert!(commit(&repo).is_none());
    }

    /// Why nsit writes `ORIG_HEAD` itself and puts it back when a pull fails: libgit2's merge
    /// writes it first thing (so it is written for a merge, though not for a fast-forward, which
    /// is not a `git_merge` at all), and removes the rest of its merge state when it then
    /// refuses to go on, but leaves `ORIG_HEAD` rewritten.
    #[test]
    fn libgit2_rewrites_orig_head_even_for_a_merge_it_refuses() {
        let dir = tempfile::tempdir().unwrap();
        let (server, _one, two) = diverged_without_conflict(dir.path());
        let tip = fetch_main(&two, &server);
        write_file(&two, "a.txt", "dirty, and in the way\n");
        let theirs = Theirs {
            id: tip,
            branch: "main",
            label: "origin/main",
            url: REMOTE_URL,
        };
        let annotated = two
            .annotated_commit_from_fetchhead("refs/heads/main", theirs.url, &theirs.id)
            .unwrap();

        let mut checkout = CheckoutBuilder::new();
        checkout.safe();
        let err = two
            .merge(&[&annotated], None, Some(&mut checkout))
            .unwrap_err();
        assert_eq!(err.code(), ErrorCode::Conflict, "{err}");
        assert_eq!(orig_head_text(&two), Some(format!("{}\n", head(&two))));
        assert!(merge_state(&two).is_empty(), "the rest was cleaned up");
    }
}
