//! The safe checkout: what `nsit switch` and the fast-forward of `nsit pull` both do to the
//! working directory, so that they cannot differ in what they are willing to overwrite.
//!
//! *Safe* means nothing of the user's is replaced:
//!
//! * a change that is not committed (an edited or staged file the target changes too) stops the
//!   checkout, as libgit2's safe mode does;
//! * an **untracked** file that is in the way of a tracked one stops it, also libgit2's safe mode;
//! * an **ignored** file in the way stops it too, which libgit2 does *not* do by itself: its safe
//!   mode overwrites an ignored file that is where an incoming file goes, and a person's `.env`
//!   or build output is exactly what is ignored. `overwrite_ignored(false)` is what turns that
//!   off, and `safe_options` is the one place it is spelled (the merge in `git::pull` starts
//!   from the same options).
//!
//! When something is in the way, **nothing has been written**, and the caller is told which files
//! (relative to the repository, with forward slashes) to name in its own error. Changes that the
//! two commits agree on, and files the checkout does not touch, are carried along as git does.

use std::cell::RefCell;
use std::rc::Rc;

use git2::build::CheckoutBuilder;
use git2::{CheckoutNotificationType, Commit, ErrorCode, Repository};

use super::paths::slash;
use crate::error::NsitError;

/// The options of every checkout that must not lose the user's work: safe mode, and no
/// overwriting of ignored files (see the module documentation).
pub fn safe_options() -> CheckoutBuilder<'static> {
    let mut options = CheckoutBuilder::new();
    options.safe().overwrite_ignored(false);
    options
}

/// Check out `target`'s tree into the working directory and the index. `HEAD` is not moved:
/// that is the caller's step, after this has gone through.
///
/// If a file is in the way, nothing is written and the error is `in_the_way(files)`: the caller
/// words it (the files are in the order libgit2 found them, and may be empty when it could not
/// say which). Any other failure is the git error.
pub fn checkout_safely(
    repo: &Repository,
    target: &Commit<'_>,
    in_the_way: impl FnOnce(&[String]) -> NsitError,
) -> Result<(), NsitError> {
    let found = Rc::new(RefCell::new(Vec::<String>::new()));
    let sink = Rc::clone(&found);
    let mut options = safe_options();
    options
        .notify_on(CheckoutNotificationType::CONFLICT)
        .notify(move |_, path, _, _, _| {
            if let Some(path) = path {
                sink.borrow_mut().push(slash(path));
            }
            true
        });
    match repo.checkout_tree(target.as_object(), Some(&mut options)) {
        Ok(()) => Ok(()),
        Err(e) if e.code() == ErrorCode::Conflict => Err(in_the_way(&found.borrow())),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::test_support::{commit_file, local_repo, write_file};

    /// `main` has `f.txt` and `same.txt`; the branch `feature` has another `f.txt` and a `new.txt`.
    /// HEAD is on `main`. Returns the tip of `feature`.
    fn main_and_feature(dir: &Path) -> (Repository, git2::Oid) {
        let repo = local_repo(dir);
        commit_file(&repo, "f.txt", "main\n");
        commit_file(&repo, "same.txt", "same\n");
        let tip = {
            let base = repo.head().unwrap().peel_to_commit().unwrap();
            repo.branch("feature", &base, false).unwrap();
            repo.set_head("refs/heads/feature").unwrap();
            commit_file(&repo, "f.txt", "feature\n");
            commit_file(&repo, "new.txt", "from feature\n");
            repo.head().unwrap().target().unwrap()
        };
        repo.set_head("refs/heads/main").unwrap();
        repo.checkout_head(Some(CheckoutBuilder::new().force()))
            .unwrap();
        (repo, tip)
    }

    /// A safe checkout of `tip`: `Err` holds the files it said were in the way.
    fn try_checkout(repo: &Repository, tip: git2::Oid) -> Result<(), Vec<String>> {
        let target = repo.find_commit(tip).unwrap();
        let mut named = None;
        let result = checkout_safely(repo, &target, |files| {
            named = Some(files.to_vec());
            NsitError::Other("in the way".into())
        });
        match result {
            Ok(()) => Ok(()),
            Err(_) => Err(named.expect("refused only for files in the way")),
        }
    }

    fn read(dir: &Path, rel: &str) -> String {
        std::fs::read_to_string(dir.join(rel)).unwrap()
    }

    #[test]
    fn a_clean_checkout_writes_the_files_of_the_target() {
        let dir = tempfile::tempdir().unwrap();
        let (repo, tip) = main_and_feature(dir.path());
        try_checkout(&repo, tip).unwrap();
        assert_eq!(read(dir.path(), "new.txt"), "from feature\n");
        assert_eq!(read(dir.path(), "f.txt"), "feature\n");
    }

    #[test]
    fn untracked_and_ignored_files_in_the_way_are_named_and_never_overwritten() {
        for ignored in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let (repo, tip) = main_and_feature(dir.path());
            write_file(&repo, "new.txt", "my own file\n");
            if ignored {
                let info = repo.path().join("info");
                std::fs::create_dir_all(&info).unwrap();
                std::fs::write(info.join("exclude"), "new.txt\n").unwrap();
                assert!(repo.status_should_ignore(Path::new("new.txt")).unwrap());
            }
            write_file(&repo, "elsewhere.txt", "not in the way\n");

            assert_eq!(
                try_checkout(&repo, tip).unwrap_err(),
                ["new.txt"],
                "ignored={ignored}"
            );
            assert_eq!(
                read(dir.path(), "new.txt"),
                "my own file\n",
                "ignored={ignored}: it is not overwritten"
            );
            assert_eq!(read(dir.path(), "f.txt"), "main\n", "nothing was written");
            assert!(dir.path().join("elsewhere.txt").exists());
        }
    }

    #[test]
    fn an_edit_of_a_file_the_target_changes_is_in_the_way_and_one_it_does_not_is_carried_along() {
        let dir = tempfile::tempdir().unwrap();
        let (repo, tip) = main_and_feature(dir.path());
        write_file(&repo, "f.txt", "edited\n");
        write_file(&repo, "same.txt", "edited too\n");
        assert_eq!(try_checkout(&repo, tip).unwrap_err(), ["f.txt"]);
        assert_eq!(read(dir.path(), "f.txt"), "edited\n");
        assert!(!dir.path().join("new.txt").exists(), "nothing was written");

        // Without the edit of f.txt the checkout goes through and keeps the other edit.
        write_file(&repo, "f.txt", "main\n");
        try_checkout(&repo, tip).unwrap();
        assert_eq!(read(dir.path(), "same.txt"), "edited too\n");
        assert_eq!(read(dir.path(), "f.txt"), "feature\n");
    }
}
