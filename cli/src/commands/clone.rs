//! `nsit clone <repo> [dir]`: copy a repository from Insitio into a new directory.
//!
//! * `<repo>` is `name` (yours), `owner/name` or a full URL, as for `nsit repo
//!   view`. Signed out is exit 3 before anything touches the network or the
//!   disk: v1 needs a token for the lookup, so there is no anonymous clone.
//! * The repository is looked up with the API first, so a missing or hidden one
//!   fails at once with `repository not found or no access` (exit 1), and the
//!   clone URL and default branch are the server's own. The URL is checked like
//!   any repository URL (same server, no user name or password in it) and is
//!   what `origin` is set to: `.git/config` never holds a credential.
//! * `[dir]` is where to clone, relative to the working directory (or `-C`);
//!   without it, the repository's name. An existing directory must be empty (exit
//!   2, and it is left exactly as it was); a missing one is made, parents too.
//! * The fetch goes through `git::run_remote`, the only way onto the network: it
//!   picks the token for this repository's server and refuses redirects to other
//!   hosts, and turns a refused login into exit 3. Its `RemoteAccess` becomes the
//!   fetch options of libgit2's `RepoBuilder`.
//! * The default branch is checked out and tracks `origin/<branch>`, so `push`
//!   and `pull` need no `-u`. An empty repository has no branch yet: `HEAD`
//!   points at the server's default branch, unborn, with the same tracking.
//! * When the clone fails, what nsit made is removed (the new directory, and the
//!   parents made for it) and nothing else: not a directory that was there
//!   already, not what was in it, and nothing at all when libgit2 reports that
//!   the directory has been filled in since it was checked (another process
//!   put something there: it is theirs). A removal that fails is reported on
//!   stderr even with `-q`, because it means debris is left.
//!
//! `--json`: `{owner, name, dir, default_branch}`.

use std::io;
use std::path::{Path, PathBuf};

use git2::build::RepoBuilder;
use git2::{Branch, ErrorCode, Repository};
use serde::Serialize;

use super::repo::{named_repo, not_found};
use crate::api::{Api, RepoJson};
use crate::cli::{CloneArgs, GlobalArgs};
use crate::config::{base_url, resolve_host};
use crate::error::NsitError;
use crate::git::run_remote;
use crate::git::stage::{current_branch, head_commit};
use crate::git::upstream::{clear_upstream, set_upstream};
use crate::output::{for_display, strip_controls, Out};
use crate::repo_ref::{parse_repo_ref, token_for_repo, RepoRef};

/// The branch to use when the server names one that is not a branch name.
const FALLBACK_BRANCH: &str = "main";

/// `--json` for `nsit clone`.
#[derive(Debug, Serialize)]
struct CloneJson {
    owner: String,
    name: String,
    dir: String,
    default_branch: String,
}

/// Where a clone goes, and what nsit will have made to get it there.
#[derive(Debug)]
struct Destination {
    path: PathBuf,
    /// The topmost directory that does not exist yet (`path` itself, or one of
    /// its parents): what a failed clone removes. `None` for an existing, empty
    /// directory: nsit did not make that, so it stays.
    created: Option<PathBuf>,
}

/// Where `HEAD` stands once the clone is done.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Head {
    /// The default branch has commits and is checked out.
    CheckedOut,
    /// The server has no commits at all.
    Empty,
    /// The server has branches, but not its default one: nothing was checked out.
    Missing,
}

pub fn run(args: &CloneArgs, global: &GlobalArgs, out: &Out, base: &Path) -> Result<(), NsitError> {
    let host = resolve_host(global.host.as_deref());
    let typed = named_repo(&host, &args.repo)?;
    // Signed out is exit 3 here: before the network, and before any directory is
    // made. (The token is for the server the repository is on, not the selected one.)
    let (token, _) = token_for_repo(&host, &typed)?;
    let repo = Api::new(&typed.host, Some(token))?
        .repo(&typed.owner, &typed.name)
        .map_err(not_found)?;
    let target = server_ref(&repo, &typed)?;
    let dest = Destination::check(destination(base, &target.name, args.directory.as_deref())?)?;
    let branch = default_branch(&repo);

    match clone_repo(&target, &host, &branch, out, &dest)? {
        Head::CheckedOut => {}
        Head::Empty => {
            out.info("The repository is empty: add files, run nsit commit, then nsit push.")
        }
        Head::Missing => out.info(&format!(
            "warning: the default branch {} is not on the server, so nothing was checked out",
            strip_controls(&branch)
        )),
    }
    let json = CloneJson {
        owner: target.owner,
        name: target.name,
        dir: dest.path.display().to_string(),
        default_branch: branch,
    };
    out.data(&json, |json| describe(json, out.tty))
}

/// The directory to clone into: `dir` as typed, or the repository's `name`,
/// taken from `base` and written without `.` parts.
fn destination(base: &Path, name: &str, dir: Option<&Path>) -> Result<PathBuf, NsitError> {
    let chosen = match dir {
        Some(dir) if dir.as_os_str().is_empty() => {
            return Err(NsitError::Usage(
                "the directory to clone into is empty: name one, or leave it out".into(),
            ));
        }
        Some(dir) => dir,
        // `...` is a fine repository name and no directory name (Windows reads it as `.`).
        None if name.chars().all(|c| c == '.') => {
            return Err(NsitError::Usage(
                "the repository's name cannot be a directory name: say where to clone, as in \
                 nsit clone <repo> <dir>"
                    .into(),
            ));
        }
        None => Path::new(name),
    };
    Ok(base.join(chosen).components().collect())
}

impl Destination {
    /// Check `path` before anything is made: an existing directory must be empty
    /// (usage error, and it is not touched), and a missing one is noted as ours.
    fn check(path: PathBuf) -> Result<Destination, NsitError> {
        let shown = strip_controls(&path.display().to_string());
        // `symlink_metadata`: a symlink, even a dangling one, is something that is there.
        if path.symlink_metadata().is_ok() {
            if !path.is_dir() {
                return Err(NsitError::Usage(format!(
                    "{shown} exists and is not a directory"
                )));
            }
            let mut entries = std::fs::read_dir(&path)
                .map_err(|e| NsitError::Other(format!("cannot read {shown}: {e}")))?;
            if entries.next().is_some() {
                return Err(NsitError::Usage(format!(
                    "{shown} already exists and is not an empty directory"
                )));
            }
            return Ok(Destination {
                path,
                created: None,
            });
        }
        // Missing: the clone makes it, and any parents that are missing too. The
        // topmost of those is what to remove if the clone fails.
        let mut top = path.as_path();
        for parent in path.ancestors().skip(1) {
            if parent.symlink_metadata().is_ok() {
                break;
            }
            top = parent;
        }
        let created = Some(top.to_path_buf());
        Ok(Destination { path, created })
    }

    /// Remove what nsit made. What is already gone (libgit2 removes its own
    /// work when a clone fails) is fine.
    fn clean_up(&self) -> io::Result<()> {
        let Some(root) = &self.created else {
            return Ok(());
        };
        match std::fs::remove_dir_all(root) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }
}

/// The repository as the server names it, from its clone URL: the server's own
/// spelling of owner and name, and the URL `origin` is set to.
///
/// The URL is read like any repository URL (no user name or password, https or
/// loopback) and must be on the server that was asked, because that is the only
/// server the token may go to. Nothing the server sent is echoed back.
fn server_ref(repo: &RepoJson, typed: &RepoRef) -> Result<RepoRef, NsitError> {
    let named = parse_repo_ref(&repo.clone_url, "", &base_url(&typed.host)?).map_err(|_| {
        NsitError::Other("the server sent a repository URL that nsit will not use".into())
    })?;
    if named.host != typed.host {
        return Err(NsitError::Other(format!(
            "the server says this repository is at a different address than {}; nsit will not \
             send your token there",
            typed.host_key()
        )));
    }
    Ok(named)
}

/// The server's default branch, or `main` if it is not a usable branch name.
fn default_branch(repo: &RepoJson) -> String {
    let name = repo.default_branch.trim();
    if Branch::name_is_valid(name).unwrap_or(false) {
        name.to_string()
    } else {
        FALLBACK_BRANCH.to_string()
    }
}

/// Point an unborn `HEAD` at `branch`, with the tracking settings a clone gives
/// a branch (`remote = origin`, `merge = refs/heads/<branch>`).
///
/// libgit2 leaves an empty clone's `HEAD` on the branch `init.defaultBranch`
/// names, with tracking settings for that name. When the server's default branch
/// is another, those settings are removed with the move.
fn point_unborn_head_at(repo: &Repository, branch: &str) -> Result<(), NsitError> {
    if let Some(guessed) = current_branch(repo).filter(|guessed| guessed != branch) {
        clear_upstream(repo, &guessed)?;
    }
    repo.set_head(&format!("refs/heads/{branch}"))?;
    set_upstream(repo, branch, "origin")
}

/// After the fetch: a `HEAD` with commits is left as libgit2 made it (checked
/// out, tracking `origin/<branch>`); an unborn one follows the server's default
/// branch, and says whether the server has anything at all.
fn settle_head(repo: &Repository, branch: &str) -> Result<Head, NsitError> {
    if head_commit(repo)?.is_some() {
        return Ok(Head::CheckedOut);
    }
    point_unborn_head_at(repo, branch)?;
    let fetched_any = repo
        .references_glob("refs/remotes/origin/*")?
        .next()
        .is_some();
    Ok(if fetched_any {
        Head::Missing
    } else {
        Head::Empty
    })
}

/// `RepoBuilder` clones `target` into `path`, with the fetch options that
/// `run_remote` hands out: the token for this repository's server, no redirect
/// to another host, progress on a terminal, and a refused login as exit 3.
fn fetch(
    target: &RepoRef,
    selected_host: &str,
    out: &Out,
    path: &Path,
) -> Result<Repository, NsitError> {
    run_remote(target, selected_host, out, |access| {
        let mut builder = RepoBuilder::new();
        builder.fetch_options(access.fetch_options());
        builder.clone(target.clone_url.as_str(), path)
    })
}

/// Clone `target` into `dest`; on failure, what nsit made for it is removed.
fn clone_repo(
    target: &RepoRef,
    selected_host: &str,
    branch: &str,
    out: &Out,
    dest: &Destination,
) -> Result<Head, NsitError> {
    // The repository is closed again before anything is removed (Windows cannot
    // remove files that are open).
    let result =
        fetch(target, selected_host, out, &dest.path).and_then(|repo| settle_head(&repo, branch));
    if let Err(err) = &result {
        clean_up_after(err, dest, Destination::clean_up, |warning| {
            out.warn(warning)
        });
    }
    result
}

/// Whether what nsit made should be removed after a clone failed with `err`.
///
/// Not when libgit2 says the directory exists and is not empty: the checks before the
/// clone found the place free, so somebody else (another process) filled it in since,
/// and what is there is theirs. Removing it would delete their files.
fn should_clean_up(err: &NsitError) -> bool {
    !matches!(err, NsitError::Git(e) if e.code() == ErrorCode::Exists)
}

/// After a failed clone: remove what nsit made (`clean`), unless `should_clean_up` says
/// it may not. A removal that fails leaves debris, which a person must hear about
/// whatever they asked for, so it is a warning that `-q` does not silence (`warn`).
fn clean_up_after(
    err: &NsitError,
    dest: &Destination,
    clean: impl FnOnce(&Destination) -> io::Result<()>,
    warn: impl FnOnce(&str),
) {
    if !should_clean_up(err) {
        return;
    }
    if let Err(e) = clean(dest) {
        let left = dest.created.as_ref().unwrap_or(&dest.path);
        warn(&format!(
            "warning: could not remove {}: {e}",
            strip_controls(&left.display().to_string())
        ));
    }
}

fn describe(json: &CloneJson, tty: bool) -> String {
    format!(
        "Cloned {}/{} into {}",
        json.owner,
        json.name,
        for_display(&json.dir, tty)
    )
}

#[cfg(test)]
mod tests {
    use git2::{Repository, RepositoryInitOptions};
    use url::Url;

    use super::*;
    use crate::config::Config;
    use crate::credentials::{host_key_for, store_token};
    use crate::repo_ref::parse_repo_ref;
    use crate::test_support::{
        commit_file, host_entry_for, isolated_env, local_repo, out_with, StubServer,
    };

    // ---- where the clone goes -----------------------------------------------------------

    #[test]
    fn the_directory_is_the_one_given_or_the_repository_name() {
        let base = Path::new("/work");
        assert_eq!(
            destination(base, "tools", None).unwrap(),
            base.join("tools")
        );
        assert_eq!(
            destination(base, "tools", Some(Path::new("mine"))).unwrap(),
            base.join("mine")
        );
        assert_eq!(
            destination(base, "tools", Some(Path::new("a/b"))).unwrap(),
            base.join("a").join("b")
        );
        // Typed paths are written without `.` parts and trailing slashes.
        assert_eq!(
            destination(base, "tools", Some(Path::new("./a/./b/"))).unwrap(),
            base.join("a").join("b")
        );
        assert_eq!(
            destination(base, "tools", Some(Path::new("."))).unwrap(),
            base.to_path_buf()
        );
    }

    #[test]
    fn an_absolute_directory_is_used_as_it_is() {
        let elsewhere = tempfile::tempdir().unwrap();
        let wanted = elsewhere.path().join("target");
        assert_eq!(
            destination(Path::new("/work"), "tools", Some(&wanted)).unwrap(),
            wanted
        );
    }

    #[test]
    fn spaces_and_accents_in_the_directory_are_kept() {
        let base = tempfile::tempdir().unwrap();
        let name = "Vidéo Ink - OG Edition";
        let typed = destination(base.path(), "tools", Some(Path::new(name))).unwrap();
        assert_eq!(typed, base.path().join(name));
        let made = Destination::check(typed).unwrap();
        assert!(made.created.is_some());
    }

    #[test]
    fn an_empty_directory_argument_and_a_name_made_of_dots_are_usage_errors() {
        for (name, dir) in [("tools", Some("")), ("...", None), ("..", None)] {
            let err = destination(Path::new("/work"), name, dir.map(Path::new)).unwrap_err();
            assert!(
                matches!(err, NsitError::Usage(_)),
                "{name:?} {dir:?}: {err:?}"
            );
            assert_eq!(err.exit_code(), 2);
            assert!(!err.to_string().contains('\n'), "{err}");
        }
        // A name with dots in it is fine.
        assert!(destination(Path::new("/work"), "a.b", None).is_ok());
        // `...` is fine when the user chose where to clone.
        assert!(destination(Path::new("/work"), "...", Some(Path::new("here"))).is_ok());
    }

    // ---- what is made, and what is cleaned up ------------------------------------------

    #[test]
    fn a_directory_with_anything_in_it_is_refused_and_left_alone() {
        let base = tempfile::tempdir().unwrap();
        let taken = base.path().join("taken");
        std::fs::create_dir(&taken).unwrap();
        std::fs::write(taken.join("keep.txt"), "mine\n").unwrap();
        std::fs::create_dir(taken.join(".hidden")).unwrap();
        let err = Destination::check(taken.clone()).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert_eq!(err.exit_code(), 2);
        let text = err.to_string();
        assert!(text.contains("not an empty directory"), "{text}");
        assert!(!text.contains('\n'), "{text}");
        // Not a byte of it was touched.
        assert_eq!(
            std::fs::read_to_string(taken.join("keep.txt")).unwrap(),
            "mine\n"
        );
        assert!(taken.join(".hidden").is_dir());
        assert_eq!(std::fs::read_dir(&taken).unwrap().count(), 2);
    }

    #[test]
    fn a_file_is_not_a_place_to_clone_to() {
        let base = tempfile::tempdir().unwrap();
        let file = base.path().join("afile");
        std::fs::write(&file, "x").unwrap();
        let err = Destination::check(file.clone()).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert!(err.to_string().contains("not a directory"), "{err}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "x");
    }

    #[test]
    fn an_existing_empty_directory_is_used_and_is_not_ours_to_remove() {
        let base = tempfile::tempdir().unwrap();
        let empty = base.path().join("empty");
        std::fs::create_dir(&empty).unwrap();
        let dest = Destination::check(empty.clone()).unwrap();
        assert_eq!(dest.created, None);
        // Even with something in it, a directory that was there stays.
        std::fs::write(empty.join("partial"), "x").unwrap();
        dest.clean_up().unwrap();
        assert!(empty.join("partial").exists());
    }

    #[test]
    fn a_missing_directory_is_ours_with_the_parents_made_for_it() {
        let base = tempfile::tempdir().unwrap();
        let deep = base.path().join("a").join("b").join("c");
        let dest = Destination::check(deep.clone()).unwrap();
        assert_eq!(dest.created, Some(base.path().join("a")));
        // Nothing is made by checking.
        assert!(!base.path().join("a").exists());

        // A partial clone, as libgit2 may leave one.
        std::fs::create_dir_all(deep.join(".git").join("objects")).unwrap();
        std::fs::write(deep.join(".git").join("objects").join("pack"), "x").unwrap();
        dest.clean_up().unwrap();
        assert!(
            !base.path().join("a").exists(),
            "everything nsit made is gone"
        );
        assert!(base.path().exists());
    }

    #[test]
    fn only_the_directories_below_the_last_one_that_existed_are_removed() {
        let base = tempfile::tempdir().unwrap();
        let keep = base.path().join("keep");
        std::fs::create_dir(&keep).unwrap();
        std::fs::write(keep.join("mine.txt"), "mine\n").unwrap();
        let dest = Destination::check(keep.join("new").join("sub")).unwrap();
        assert_eq!(dest.created, Some(keep.join("new")));
        std::fs::create_dir_all(keep.join("new").join("sub")).unwrap();
        dest.clean_up().unwrap();
        assert!(!keep.join("new").exists());
        assert_eq!(
            std::fs::read_to_string(keep.join("mine.txt")).unwrap(),
            "mine\n"
        );
    }

    #[test]
    fn cleaning_up_what_is_already_gone_is_fine() {
        // libgit2 removes its own work when a clone fails, so there may be nothing left.
        let base = tempfile::tempdir().unwrap();
        let dest = Destination::check(base.path().join("gone")).unwrap();
        dest.clean_up().unwrap();
        dest.clean_up().unwrap();
    }

    #[test]
    fn read_only_files_do_not_stop_the_clean_up() {
        // libgit2 writes pack files read-only.
        let base = tempfile::tempdir().unwrap();
        let dest = Destination::check(base.path().join("repo")).unwrap();
        let pack = base.path().join("repo").join(".git").join("pack-1.pack");
        std::fs::create_dir_all(pack.parent().unwrap()).unwrap();
        std::fs::write(&pack, "x").unwrap();
        let mut permissions = std::fs::metadata(&pack).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&pack, permissions).unwrap();
        dest.clean_up().unwrap();
        assert!(!base.path().join("repo").exists());
    }

    // ---- what the server says ----------------------------------------------------------

    fn repo_json(clone_url: &str, default_branch: &str) -> RepoJson {
        RepoJson {
            owner: "ada".into(),
            name: "tools".into(),
            full_name: "ada/tools".into(),
            description: String::new(),
            private: true,
            default_branch: default_branch.into(),
            clone_url: clone_url.into(),
            html_url: "https://git.iam.bot/ada/tools".into(),
            created_at: "2026-10-18T09:30:00.000Z".into(),
        }
    }

    fn typed(input: &str) -> RepoRef {
        parse_repo_ref(input, "ada", &Url::parse("https://git.iam.bot/").unwrap()).unwrap()
    }

    #[test]
    fn the_servers_clone_url_is_used_when_it_is_the_same_server() {
        // The server's spelling wins: here the case the user typed differs.
        let named = server_ref(
            &repo_json("https://git.iam.bot/ada/tools.git", "main"),
            &typed("Ada/TOOLS"),
        )
        .unwrap();
        assert_eq!(
            (named.owner.as_str(), named.name.as_str()),
            ("ada", "tools")
        );
        assert_eq!(
            named.clone_url.as_str(),
            "https://git.iam.bot/ada/tools.git"
        );
        assert_eq!(named.host, "https://git.iam.bot/");
    }

    #[test]
    fn a_clone_url_on_another_server_or_with_credentials_is_refused_and_never_echoed() {
        for url in [
            "https://evil.example/ada/tools.git",
            "https://git.iam.bot:8443/ada/tools.git",
            "http://git.iam.bot/ada/tools.git",
            "https://ada:ins_stolen_secret@git.iam.bot/ada/tools.git",
            "https://ins_stolen_secret@git.iam.bot/ada/tools.git",
            "ssh://git@git.iam.bot/ada/tools.git",
            "file:///ada/tools.git",
            "not a url",
            "",
        ] {
            let err = server_ref(&repo_json(url, "main"), &typed("ada/tools")).unwrap_err();
            assert!(matches!(err, NsitError::Other(_)), "{url:?}: {err:?}");
            assert_eq!(err.exit_code(), 1);
            assert!(!err.to_string().contains("ins_stolen_secret"), "{err}");
            assert!(!err.to_string().contains("evil.example"), "{err}");
            assert!(!err.to_string().contains('\n'), "{err}");
        }
    }

    #[test]
    fn a_server_branch_that_is_not_a_branch_name_becomes_main() {
        for (given, wanted) in [
            ("main", "main"),
            ("master", "master"),
            ("release/1.0", "release/1.0"),
            (" trunk ", "trunk"),
            ("", "main"),
            ("a b", "main"),
            ("a..b", "main"),
            ("-x", "main"),
            ("x.lock", "main"),
            ("x\u{1b}[31m", "main"),
        ] {
            let json = repo_json("https://git.iam.bot/ada/tools.git", given);
            assert_eq!(default_branch(&json), wanted, "{given:?}");
        }
    }

    // ---- HEAD ----------------------------------------------------------------------------

    /// A repository as an empty clone leaves it: libgit2 points `HEAD` at the
    /// branch `init.defaultBranch` names (`initial`) and writes tracking for it.
    fn empty_clone(dir: &Path, initial: &str) -> Repository {
        let mut options = RepositoryInitOptions::new();
        options.initial_head(initial);
        let repo = Repository::init_opts(dir, &options).unwrap();
        repo.remote("origin", "https://git.iam.bot/ada/tools.git")
            .unwrap();
        {
            let mut config = repo.config().unwrap();
            config
                .set_str(&format!("branch.{initial}.remote"), "origin")
                .unwrap();
            config
                .set_str(
                    &format!("branch.{initial}.merge"),
                    &format!("refs/heads/{initial}"),
                )
                .unwrap();
        }
        repo
    }

    /// What `HEAD` points at, read straight from the reference.
    fn head_target(repo: &Repository) -> Option<String> {
        let head = repo.find_reference("HEAD").unwrap();
        head.symbolic_target().unwrap().map(str::to_string)
    }

    fn local_setting(repo: &Repository, key: &str) -> Option<String> {
        let local = repo
            .config()
            .unwrap()
            .open_level(git2::ConfigLevel::Local)
            .unwrap();
        local.get_string(key).ok()
    }

    #[test]
    fn an_unborn_head_follows_the_servers_default_branch_and_tracks_it() {
        let dir = tempfile::tempdir().unwrap();
        let repo = empty_clone(dir.path(), "trunk");
        point_unborn_head_at(&repo, "main").unwrap();
        assert_eq!(head_target(&repo).as_deref(), Some("refs/heads/main"));
        assert_eq!(
            local_setting(&repo, "branch.main.remote").as_deref(),
            Some("origin")
        );
        assert_eq!(
            local_setting(&repo, "branch.main.merge").as_deref(),
            Some("refs/heads/main")
        );
        // The settings libgit2 wrote for the name it guessed are not left behind.
        assert_eq!(local_setting(&repo, "branch.trunk.remote"), None);
        assert_eq!(local_setting(&repo, "branch.trunk.merge"), None);
    }

    #[test]
    fn pointing_head_at_the_branch_it_already_names_changes_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        let repo = empty_clone(dir.path(), "main");
        point_unborn_head_at(&repo, "main").unwrap();
        assert_eq!(head_target(&repo).as_deref(), Some("refs/heads/main"));
        assert_eq!(
            local_setting(&repo, "branch.main.remote").as_deref(),
            Some("origin")
        );
        assert_eq!(
            local_setting(&repo, "branch.main.merge").as_deref(),
            Some("refs/heads/main")
        );
    }

    #[test]
    fn a_branch_name_with_dots_and_slashes_gets_its_tracking_settings() {
        let dir = tempfile::tempdir().unwrap();
        let repo = empty_clone(dir.path(), "main");
        point_unborn_head_at(&repo, "release/1.0").unwrap();
        assert_eq!(
            local_setting(&repo, "branch.release/1.0.remote").as_deref(),
            Some("origin")
        );
        assert_eq!(
            local_setting(&repo, "branch.release/1.0.merge").as_deref(),
            Some("refs/heads/release/1.0")
        );
    }

    #[test]
    fn a_head_with_commits_is_left_as_libgit2_made_it() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "a");
        let tip = repo.head().unwrap().target();
        assert_eq!(settle_head(&repo, "elsewhere").unwrap(), Head::CheckedOut);
        assert_eq!(repo.head().unwrap().target(), tip);
        assert_eq!(head_target(&repo).as_deref(), Some("refs/heads/main"));
        assert_eq!(local_setting(&repo, "branch.elsewhere.remote"), None);
    }

    #[test]
    fn nothing_on_the_server_is_an_empty_repository() {
        let dir = tempfile::tempdir().unwrap();
        let repo = empty_clone(dir.path(), "trunk");
        assert_eq!(settle_head(&repo, "main").unwrap(), Head::Empty);
        assert_eq!(head_target(&repo).as_deref(), Some("refs/heads/main"));
    }

    #[test]
    fn branches_on_the_server_but_not_the_default_one_leave_nothing_checked_out() {
        let dir = tempfile::tempdir().unwrap();
        let repo = empty_clone(dir.path(), "trunk");
        // A commit that no branch of this repository points at, standing in for
        // what the fetch brought from the server as `origin/dev`.
        let tree = repo
            .find_tree(repo.treebuilder(None).unwrap().write().unwrap())
            .unwrap();
        let who = git2::Signature::now("Test", "test@example.com").unwrap();
        let tip = repo.commit(None, &who, &who, "dev", &tree, &[]).unwrap();
        repo.reference("refs/remotes/origin/dev", tip, true, "test")
            .unwrap();
        assert_eq!(settle_head(&repo, "main").unwrap(), Head::Missing);
        assert_eq!(head_target(&repo).as_deref(), Some("refs/heads/main"));
    }

    // ---- a clone that fails ----------------------------------------------------------------

    fn sign_in_to(host: &str, account: &str, token: &str) {
        store_token(host, account, token).unwrap();
        let mut config = Config::load().unwrap();
        config.hosts.insert(
            host_key_for(host).unwrap(),
            host_entry_for(account, None, None),
        );
        config.save().unwrap();
    }

    #[test]
    fn a_failed_clone_goes_through_run_remote_and_leaves_nothing_behind() {
        let home = tempfile::tempdir().unwrap();
        let _env = isolated_env(home.path());
        // A server that does not accept the token.
        let server = StubServer::refusing();
        sign_in_to(&server.host(), "grace", "ins_stored_token");
        let target =
            parse_repo_ref("ada/rocket", "", &Url::parse(&server.host()).unwrap()).unwrap();
        let work = tempfile::tempdir().unwrap();
        let dest = Destination::check(work.path().join("a").join("b")).unwrap();

        let err = clone_repo(
            &target,
            &server.host(),
            "main",
            &out_with(false, false),
            &dest,
        )
        .unwrap_err();

        // The refusal is exit 3 with the sign-in hint, as for every network operation.
        assert!(matches!(err, NsitError::Auth(_)), "{err:?}");
        assert_eq!(err.exit_code(), 3);
        assert!(err.to_string().contains("nsit auth login"), "{err}");
        assert!(!err.to_string().contains("ins_stored_token"), "{err}");
        // On the wire: the login of the account and the token, once, as Basic auth.
        let seen = server.requests();
        assert_eq!(seen[0].authorization, None, "{seen:?}");
        assert_eq!(
            seen[1].authorization.as_deref(),
            Some(
                format!(
                    "Basic {}",
                    crate::test_support::base64("grace:ins_stored_token")
                )
                .as_str()
            ),
            "{seen:?}"
        );
        assert_eq!(seen.len(), 2, "the credentials were offered once: {seen:?}");
        // And nothing is left of what the clone began.
        assert!(!work.path().join("a").exists());
        assert_eq!(std::fs::read_dir(work.path()).unwrap().count(), 0);
    }

    #[test]
    fn signed_out_nothing_runs_and_nothing_is_made() {
        let home = tempfile::tempdir().unwrap();
        let _env = isolated_env(home.path());
        let server = StubServer::refusing();
        let target =
            parse_repo_ref("ada/rocket", "", &Url::parse(&server.host()).unwrap()).unwrap();
        let work = tempfile::tempdir().unwrap();
        let dest = Destination::check(work.path().join("rocket")).unwrap();
        let err = clone_repo(
            &target,
            &server.host(),
            "main",
            &out_with(false, false),
            &dest,
        )
        .unwrap_err();
        assert_eq!(err.exit_code(), 3, "{err}");
        assert!(!work.path().join("rocket").exists());
        assert_eq!(
            server.connections_after(std::time::Duration::from_millis(200)),
            0
        );
    }

    // ---- cleaning up after a failure -----------------------------------------------------

    fn git_failure(code: ErrorCode) -> NsitError {
        NsitError::Git(git2::Error::new(code, git2::ErrorClass::Invalid, "failed"))
    }

    #[test]
    fn nothing_is_removed_when_libgit2_found_the_directory_filled_in() {
        assert!(!should_clean_up(&git_failure(ErrorCode::Exists)));
        for other in [
            git_failure(ErrorCode::GenericError),
            git_failure(ErrorCode::NotFound),
            git_failure(ErrorCode::Auth),
            NsitError::Auth("a".into()),
            NsitError::Other("o".into()),
            NsitError::Usage("u".into()),
            NsitError::Io(io::Error::other("disk")),
        ] {
            assert!(should_clean_up(&other), "{other:?}");
        }
    }

    #[test]
    fn the_removal_runs_after_a_failure_except_when_the_directory_was_filled_in() {
        let base = tempfile::tempdir().unwrap();
        let dest = Destination::check(base.path().join("d")).unwrap();
        let mut removals = 0;
        clean_up_after(
            &git_failure(ErrorCode::Exists),
            &dest,
            |_| {
                removals += 1;
                Ok(())
            },
            |_| panic!("nothing to warn about"),
        );
        assert_eq!(removals, 0);
        clean_up_after(
            &git_failure(ErrorCode::GenericError),
            &dest,
            |_| {
                removals += 1;
                Ok(())
            },
            |_| panic!("nothing to warn about"),
        );
        assert_eq!(removals, 1);
    }

    #[test]
    fn a_removal_that_fails_is_a_warning_that_names_what_is_left() {
        let base = tempfile::tempdir().unwrap();
        let dest = Destination::check(base.path().join("a").join("b")).unwrap();
        let mut said = Vec::new();
        clean_up_after(
            &git_failure(ErrorCode::GenericError),
            &dest,
            |_| Err(io::Error::other("in use")),
            |warning| said.push(warning.to_string()),
        );
        assert_eq!(said.len(), 1, "{said:?}");
        let left = base.path().join("a").display().to_string();
        assert_eq!(said[0], format!("warning: could not remove {left}: in use"));
        assert!(!said[0].contains('\n'));
    }

    #[test]
    fn a_directory_filled_in_between_the_check_and_the_clone_is_left_exactly_as_it_is() {
        let home = tempfile::tempdir().unwrap();
        let _env = isolated_env(home.path());
        let server = StubServer::refusing();
        sign_in_to(&server.host(), "grace", "ins_stored_token");
        let target =
            parse_repo_ref("ada/rocket", "", &Url::parse(&server.host()).unwrap()).unwrap();
        let work = tempfile::tempdir().unwrap();
        // Free when it is checked, so nsit would call `a` its own...
        let dest = Destination::check(work.path().join("a").join("b")).unwrap();
        assert_eq!(dest.created, Some(work.path().join("a")));
        // ...and then another process gets there first.
        std::fs::create_dir_all(&dest.path).unwrap();
        std::fs::write(dest.path.join("theirs.txt"), "theirs\n").unwrap();

        let err = clone_repo(
            &target,
            &server.host(),
            "main",
            &out_with(false, true),
            &dest,
        )
        .unwrap_err();
        assert!(
            matches!(&err, NsitError::Git(e) if e.code() == ErrorCode::Exists),
            "{err:?}"
        );
        assert!(!err.to_string().contains("ins_stored_token"), "{err}");
        // Their directory, their file: not removed, and `a` above it is still there.
        assert_eq!(
            std::fs::read_to_string(dest.path.join("theirs.txt")).unwrap(),
            "theirs\n"
        );
        assert!(work.path().join("a").is_dir());
        // The server was not even asked.
        assert_eq!(
            server.connections_after(std::time::Duration::from_millis(200)),
            0
        );
    }

    // ---- what is printed -----------------------------------------------------------------

    fn sample() -> CloneJson {
        CloneJson {
            owner: "ada".into(),
            name: "tools".into(),
            dir: "/work/tools".into(),
            default_branch: "main".into(),
        }
    }

    #[test]
    fn the_text_says_what_was_cloned_and_where() {
        assert_eq!(
            describe(&sample(), false),
            "Cloned ada/tools into /work/tools"
        );
        let mut json = sample();
        json.dir = "/work/Vidéo Ink - OG Edition".into();
        assert_eq!(
            describe(&json, false),
            "Cloned ada/tools into /work/Vidéo Ink - OG Edition"
        );
    }

    #[test]
    fn a_path_is_cleaned_for_a_terminal_and_exact_when_piped() {
        let mut json = sample();
        json.dir = "/work/a\u{1b}[31mb".into();
        assert_eq!(describe(&json, true), "Cloned ada/tools into /work/a[31mb");
        assert_eq!(
            describe(&json, false),
            "Cloned ada/tools into /work/a\u{1b}[31mb"
        );
    }

    #[test]
    fn the_json_has_the_documented_fields() {
        let value = serde_json::to_value(sample()).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["default_branch", "dir", "name", "owner"]);
    }
}
