//! Turning what a person typed into paths inside a repository.
//!
//! Commands take paths relative to the directory nsit runs in (the process
//! directory, or `-C <dir>`), as git does. libgit2 wants paths relative to the
//! working directory with forward slashes. Everything printed back to the user
//! uses the second form too.

use std::ffi::OsString;
use std::io;
use std::path::{Component, Path, PathBuf};

use git2::Repository;

use crate::error::NsitError;
use crate::output::strip_controls;

/// A path as the repository stores it: forward slashes, whatever the OS uses.
/// Names that are not valid Unicode are shown with replacement characters.
pub fn slash(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) {
        text.replace('\\', "/")
    } else {
        text.into_owned()
    }
}

/// A path exactly as the index stores it: bytes, forward slashes. Not always
/// text (on Unix a file name may be any bytes but NUL and `/`), so anything that
/// has to *decide* something about a path works on these and never on `display`.
pub type RawPath = Vec<u8>;

/// A raw path for people to read: invalid UTF-8 shows as U+FFFD. For messages
/// only; two different raw paths can look the same here.
pub fn display(raw: &[u8]) -> String {
    String::from_utf8_lossy(raw).into_owned()
}

/// The most file names an error line lists.
const MAX_LISTED: usize = 10;

/// File names for a one-line message: at most `MAX_LISTED` of them, comma separated, without
/// control characters (a name comes from the working directory and may carry terminal escapes),
/// and how many more there were.
pub fn listed(files: &[String]) -> String {
    let mut shown: Vec<String> = files
        .iter()
        .take(MAX_LISTED)
        .map(|file| strip_controls(file))
        .collect();
    if files.len() > MAX_LISTED {
        shown.push(format!("and {} more", files.len() - MAX_LISTED));
    }
    shown.join(", ")
}

/// The working directory of `repo`, or a usage error for a bare repository.
pub fn workdir(repo: &Repository) -> Result<&Path, NsitError> {
    repo.workdir().ok_or_else(|| {
        NsitError::Usage("this is a bare repository: it has no working files".into())
    })
}

/// Where `user_path` (as typed, relative to `base`) is inside `repo`'s working
/// directory: forward slashes, no `.` or `..`, and the empty string for the
/// working directory itself.
///
/// The path need not exist (a deleted file can still be staged). A path that
/// leads outside the repository is a usage error. Symbolic links in the
/// directories leading to it are resolved first, so `base` can be reached
/// through any of them.
pub fn repo_relative(
    repo: &Repository,
    base: &Path,
    user_path: &Path,
) -> Result<String, NsitError> {
    let root = workdir(repo)?
        .canonicalize()
        .map_err(|e| NsitError::Other(format!("cannot read the repository directory: {e}")))?;
    let wanted = lexically_normal(&base.join(user_path));
    let resolved = canonical_even_if_missing(&wanted)
        .map_err(|e| NsitError::Usage(format!("cannot use {}: {e}", user_path.display())))?;
    let inside = resolved.strip_prefix(&root).map_err(|_| {
        NsitError::Usage(format!("{} is outside the repository", user_path.display()))
    })?;
    let mut parts = Vec::new();
    for component in inside.components() {
        let Component::Normal(name) = component else {
            continue;
        };
        let name = name.to_str().ok_or_else(|| {
            NsitError::Usage(format!("{} is not a valid UTF-8 path", user_path.display()))
        })?;
        parts.push(name);
    }
    Ok(parts.join("/"))
}

/// `path` with `.` removed and `..` applied to the component before it. `..`
/// at the very top stays at the top.
fn lexically_normal(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push(component);
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// `std::fs::canonicalize`, but a trailing part that does not exist yet is
/// kept as it is: the nearest existing parent is resolved, the rest appended.
fn canonical_even_if_missing(path: &Path) -> io::Result<PathBuf> {
    let mut missing: Vec<OsString> = Vec::new();
    let mut existing = path;
    loop {
        match existing.canonicalize() {
            Ok(mut found) => {
                found.extend(missing.iter().rev());
                return Ok(found);
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                match (existing.file_name(), existing.parent()) {
                    (Some(name), Some(parent)) => {
                        missing.push(name.to_os_string());
                        existing = parent;
                    }
                    _ => return Err(e),
                }
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_in(dir: &Path) -> Repository {
        Repository::init(dir).unwrap()
    }

    #[test]
    fn a_list_of_files_is_cut_and_has_no_control_characters() {
        let names: Vec<String> = (0..12).map(|n| format!("f{n}.txt")).collect();
        let text = listed(&names);
        assert!(text.starts_with("f0.txt, f1.txt"), "{text}");
        assert!(
            text.contains("f9.txt") && !text.contains("f10.txt"),
            "{text}"
        );
        assert!(text.ends_with("and 2 more"), "{text}");
        assert_eq!(listed(&["a\u{1b}[31m\nb.txt".to_string()]), "a[31mb.txt");
        assert_eq!(listed(&[]), "");
        let ten: Vec<String> = (0..10).map(|n| n.to_string()).collect();
        assert!(!listed(&ten).contains("more"));
    }

    #[test]
    fn slash_turns_native_separators_into_forward_slashes() {
        let path: PathBuf = ["src", "deep", "file.txt"].iter().collect();
        assert_eq!(slash(&path), "src/deep/file.txt");
    }

    #[test]
    fn a_path_is_relative_to_the_directory_nsit_runs_in() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repo_in(dir.path());
        let sub = dir.path().join("src").join("deep");
        std::fs::create_dir_all(&sub).unwrap();
        // From the root.
        assert_eq!(
            repo_relative(&repo, dir.path(), Path::new("src/deep/a.txt")).unwrap(),
            "src/deep/a.txt"
        );
        // From a subdirectory: the same file, named from there.
        assert_eq!(
            repo_relative(&repo, &sub, Path::new("a.txt")).unwrap(),
            "src/deep/a.txt"
        );
        assert_eq!(
            repo_relative(&repo, &sub, Path::new("../top.txt")).unwrap(),
            "src/top.txt"
        );
        assert_eq!(
            repo_relative(&repo, &sub, Path::new("../../x.txt")).unwrap(),
            "x.txt"
        );
    }

    #[test]
    fn the_working_directory_itself_is_the_empty_path() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repo_in(dir.path());
        for typed in [".", "./", "src/.."] {
            std::fs::create_dir_all(dir.path().join("src")).unwrap();
            assert_eq!(
                repo_relative(&repo, dir.path(), Path::new(typed)).unwrap(),
                "",
                "{typed}"
            );
        }
    }

    #[test]
    fn an_absolute_path_inside_the_repository_is_accepted() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repo_in(dir.path());
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        assert_eq!(
            repo_relative(&repo, Path::new("."), &dir.path().join("a.txt")).unwrap(),
            "a.txt"
        );
        // Not there (a deleted file): still resolved.
        assert_eq!(
            repo_relative(&repo, Path::new("."), &dir.path().join("gone/deep.txt")).unwrap(),
            "gone/deep.txt"
        );
    }

    #[test]
    fn a_path_outside_the_repository_is_a_usage_error() {
        let parent = tempfile::tempdir().unwrap();
        let inside = parent.path().join("repo");
        std::fs::create_dir(&inside).unwrap();
        let repo = repo_in(&inside);
        for typed in ["../elsewhere.txt", "../../x"] {
            let err = repo_relative(&repo, &inside, Path::new(typed)).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{typed}: {err:?}");
            assert!(err.to_string().contains("outside the repository"), "{err}");
        }
        let err = repo_relative(&repo, &inside, &parent.path().join("other.txt")).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
    }

    #[test]
    fn spaces_and_non_ascii_names_come_back_as_they_are() {
        let parent = tempfile::tempdir().unwrap();
        let dir = parent.path().join("Vidéo Ink - OG Edition");
        std::fs::create_dir(&dir).unwrap();
        let repo = repo_in(&dir);
        std::fs::create_dir(dir.join("clips ünï")).unwrap();
        assert_eq!(
            repo_relative(&repo, &dir, Path::new("clips ünï/scène 1.txt")).unwrap(),
            "clips ünï/scène 1.txt"
        );
    }

    #[test]
    fn a_bare_repository_has_no_working_files() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init_bare(dir.path()).unwrap();
        let err = repo_relative(&repo, dir.path(), Path::new("a")).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
    }
}
