//! `nsit init [name] [--remote] [--readme] [--public]`: start a repository, and
//! optionally its twin on Insitio.
//!
//! * `nsit init` makes a repository here (or in `-C <dir>`) with branch `main`.
//! * `nsit init <name>` makes the directory `<name>` and the repository in it.
//!   `<name>` is also the repository's name on Insitio, so it must be one the
//!   server accepts. `--remote` without a name uses this directory's name.
//! * With a name or `--remote` the repository is created on Insitio (private
//!   unless `--public`) and `origin` is set to its plain clone URL: never a URL
//!   with a user name or token in it. Sign-in and the name are checked before
//!   anything is created, so a mistake there leaves nothing behind.
//! * `--readme` writes a starter README.md and commits just that file (not
//!   whatever else the directory holds) as the first commit.
//!
//! Running it again where the repository exists is safe: the local part is a
//! no-op (and says so), and an `origin` that is set is left alone.
//!
//! `--json`: `{path, branch, created, remote, readme, commit, pushed}`, where
//! `created` is whether this run made the local repository, `remote` is
//! `{owner, name, clone_url, private, created}` or null, `readme` is whether
//! this run wrote README.md, `commit` is the id of the commit it made or null,
//! and `pushed` is whether the commits reached the server.

use std::path::{Path, PathBuf};

use git2::{Repository, RepositoryInitOptions, Signature};
use serde::Serialize;

use super::commit::{commit_changes, Outcome, Request, Staging};
use super::commit_signature;
use super::readme::{description_of, origin_on, write_readme, Written, README};
use super::repo::signed_in;
use crate::api::Api;
use crate::cli::{GlobalArgs, InitArgs};
use crate::config::{base_url, resolve_host};
use crate::error::NsitError;
use crate::git::stage::{current_branch, head_commit, stage_paths};
use crate::output::Out;
use crate::repo_ref::{parse_repo_ref, validate_repo_name, RepoRef};

/// The branch a new repository starts on.
const INITIAL_BRANCH: &str = "main";

/// What a run is going to do, worked out from the arguments alone.
#[derive(Debug, PartialEq, Eq)]
struct Plan {
    /// Where the repository is (and is made, if it is not).
    dir: PathBuf,
    /// The repository's name on Insitio, when one is to be created.
    remote_name: Option<String>,
}

/// `remote` in `--json`.
#[derive(Debug, Serialize)]
struct RemoteJson {
    owner: Option<String>,
    name: Option<String>,
    clone_url: String,
    /// Not known for an `origin` that was already there.
    private: Option<bool>,
    created: bool,
}

/// `--json` for `nsit init`.
#[derive(Debug, Serialize)]
struct InitJson {
    path: String,
    branch: Option<String>,
    created: bool,
    remote: Option<RemoteJson>,
    readme: bool,
    commit: Option<String>,
    pushed: bool,
}

/// The remote side as `init` sets it up.
struct Wired {
    json: RemoteJson,
    /// `origin` as a repository on the selected host, when it is one.
    target: Option<RepoRef>,
}

/// What became of the first commits of a repository that now has a remote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirstPush {
    /// There is no commit yet, so nothing was sent.
    NoCommits,
    /// The branch is on the server.
    Pushed,
    /// There are commits, and they are not on the server.
    NotPushed,
}

pub fn run(args: &InitArgs, global: &GlobalArgs, out: &Out, base: &Path) -> Result<(), NsitError> {
    let host = resolve_host(global.host.as_deref());
    let plan = plan(args, base)?;
    // Signed out is settled before anything is created.
    let api = plan
        .remote_name
        .as_ref()
        .map(|_| signed_in(&host))
        .transpose()?;

    if plan.dir.exists() && !plan.dir.is_dir() {
        return Err(NsitError::Usage(format!(
            "{} exists and is not a directory",
            plan.dir.display()
        )));
    }
    std::fs::create_dir_all(&plan.dir)?;
    let (repo, created) = open_or_init(&plan.dir)?;
    // Who would make the first commit, found before the remote exists: a missing
    // name or email then costs nothing but a rerun.
    let who = args
        .readme
        .then(|| commit_signature(&repo, global))
        .transpose()?;

    let wired = match (&api, &plan.remote_name) {
        (Some(api), Some(name)) => Some(wire_remote(&repo, api, &host, name, args.public)?),
        _ => None,
    };
    let target = wired.as_ref().and_then(|w| w.target.as_ref());

    let (wrote_readme, commit) = match &who {
        Some(who) => first_readme_commit(&repo, target, &host, who)?,
        None => (false, None),
    };

    let pushed = match target {
        Some(target) => {
            let first = push_first_commits(&repo, target, &host, out)?;
            match first {
                FirstPush::NoCommits => out.info(
                    "There is no commit yet, so nothing was pushed: make one with nsit commit.",
                ),
                FirstPush::NotPushed => {
                    out.info("The commits are not on Insitio yet: run nsit push.");
                }
                FirstPush::Pushed => {}
            }
            first == FirstPush::Pushed
        }
        None => false,
    };

    let json = InitJson {
        path: plan.dir.display().to_string(),
        branch: current_branch(&repo),
        created,
        remote: wired.map(|w| w.json),
        readme: wrote_readme,
        commit: commit.map(|id| id.to_string()),
        pushed,
    };
    out.data(&json, |json| describe(json, args.readme))
}

/// Work out where the repository is and what to name it on the server, from
/// the arguments alone (nothing is created, nothing asked of the network).
fn plan(args: &InitArgs, base: &Path) -> Result<Plan, NsitError> {
    if args.public && args.name.is_none() && !args.remote {
        return Err(NsitError::Usage(
            "--public is about the repository on Insitio: give a name, or add --remote".into(),
        ));
    }
    match (&args.name, args.remote) {
        (Some(name), _) => {
            validate_repo_name(name)?;
            Ok(Plan {
                dir: base.join(name),
                remote_name: Some(name.clone()),
            })
        }
        (None, true) => {
            let name = directory_name(base).ok_or_else(|| {
                NsitError::Usage("cannot tell this directory's name: use nsit init <name>".into())
            })?;
            validate_repo_name(&name).map_err(|e| {
                NsitError::Usage(format!(
                    "this directory's name cannot be the repository's name ({e}); \
                     choose one with nsit init <name>"
                ))
            })?;
            Ok(Plan {
                dir: base.to_path_buf(),
                remote_name: Some(name),
            })
        }
        (None, false) => Ok(Plan {
            dir: base.to_path_buf(),
            remote_name: None,
        }),
    }
}

/// The last part of `dir`'s real path (`-C ..` and `.` resolved).
fn directory_name(dir: &Path) -> Option<String> {
    let real = dir.canonicalize().ok()?;
    Some(real.file_name()?.to_string_lossy().into_owned())
}

/// The repository that is exactly in `dir`, or a new one there with branch
/// `main`. The second value says whether it was made now. (This looks only at
/// `dir`, not at the directories above it: a project inside another
/// repository gets its own, as with git.)
fn open_or_init(dir: &Path) -> Result<(Repository, bool), NsitError> {
    match Repository::open(dir) {
        Ok(repo) => {
            if repo.workdir().is_none() {
                return Err(NsitError::Usage(format!(
                    "{} is a bare repository",
                    dir.display()
                )));
            }
            Ok((repo, false))
        }
        Err(e) if e.code() == git2::ErrorCode::NotFound => {
            let mut options = RepositoryInitOptions::new();
            options.initial_head(INITIAL_BRANCH);
            Ok((Repository::init_opts(dir, &options)?, true))
        }
        Err(e) => Err(e.into()),
    }
}

/// Create the repository `name` on the server and make it `origin`; or, when
/// `origin` is set already, leave it be.
fn wire_remote(
    repo: &Repository,
    api: &Api,
    host: &str,
    name: &str,
    public: bool,
) -> Result<Wired, NsitError> {
    if let Ok(existing) = repo.find_remote("origin") {
        let target = origin_on(repo, host);
        return Ok(Wired {
            json: RemoteJson {
                owner: target.as_ref().map(|t| t.owner.clone()),
                name: target.as_ref().map(|t| t.name.clone()),
                clone_url: existing.url().unwrap_or_default().to_string(),
                private: None,
                created: false,
            },
            target,
        });
    }
    let made = api.create_repo(name, None, !public)?;
    // The server's answer is checked like any repository URL: no user name or
    // token in it, https (or loopback). `origin` gets the cleaned form.
    let target = parse_repo_ref(&made.clone_url, "", &base_url(host)?).map_err(|_| {
        NsitError::Other("the server sent a repository URL that nsit will not use".into())
    })?;
    repo.remote("origin", target.clone_url.as_str())?;
    Ok(Wired {
        json: RemoteJson {
            owner: Some(made.owner),
            name: Some(made.name),
            clone_url: target.clone_url.to_string(),
            private: Some(made.private),
            created: true,
        },
        target: Some(target),
    })
}

/// Write README.md if there is none and commit that one file. Returns whether
/// the file was written, and the commit if one was made (not when README.md was
/// there already and committed).
fn first_readme_commit(
    repo: &Repository,
    target: Option<&RepoRef>,
    host: &str,
    who: &Signature<'_>,
) -> Result<(bool, Option<git2::Oid>), NsitError> {
    let description = target.and_then(|t| description_of(host, t));
    let wrote = write_readme(repo, target, description.as_deref())? == Written::Created;
    let root = repo.workdir().unwrap_or(Path::new("."));
    if !root.join(README).exists() {
        // A README under another capitalization: not ours to commit.
        return Ok((wrote, None));
    }
    let first = head_commit(repo)?.is_none();
    let mut index = repo.index()?;
    stage_paths(repo, &mut index, &[README.to_string()])?;
    let request = Request {
        message: if first {
            "Initial commit\n"
        } else {
            "Add README\n"
        }
        .to_string(),
        staging: Staging::AsStaged,
        allow_secret: Vec::new(),
    };
    match commit_changes(repo, who, &request)? {
        Outcome::Committed(done) => Ok((wrote, Some(done.id))),
        Outcome::NothingToCommit => Ok((wrote, None)),
    }
}

/// Send the first commits of a repository that was just given a remote.
///
/// This is the seam between `init` and `nsit push`: it runs once `origin` is
/// set and the first commit, if there is one, has been made. Until `nsit push`
/// exists a repository that has commits is reported as `NotPushed`, and
/// `init` tells the user so.
pub fn push_first_commits(
    repo: &Repository,
    _target: &RepoRef,
    _selected_host: &str,
    _out: &Out,
) -> Result<FirstPush, NsitError> {
    if head_commit(repo)?.is_none() {
        return Ok(FirstPush::NoCommits);
    }
    Ok(FirstPush::NotPushed)
}

fn describe(json: &InitJson, readme_asked: bool) -> String {
    let mut lines = Vec::new();
    let branch = json.branch.as_deref().unwrap_or(INITIAL_BRANCH);
    lines.push(if json.created {
        format!("Created a repository in {} (branch {branch}).", json.path)
    } else {
        format!(
            "A repository already exists in {}; left as it is.",
            json.path
        )
    });
    if let Some(remote) = &json.remote {
        lines.push(match (&remote.owner, &remote.name, remote.created) {
            (Some(owner), Some(name), true) => {
                let visibility = if remote.private == Some(false) {
                    "public"
                } else {
                    "private"
                };
                format!(
                    "Created {owner}/{name} on Insitio ({visibility}); origin is {}.",
                    remote.clone_url
                )
            }
            _ => format!("origin is already {}; left as it is.", remote.clone_url),
        });
    }
    if readme_asked {
        lines.push(if json.readme {
            format!("Wrote {README}.")
        } else {
            format!("{README} already exists; left as it is.")
        });
    }
    if let Some(commit) = &json.commit {
        lines.push(format!("Committed {}.", &commit[..7]));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::InitArgs;
    use crate::test_support::{local_repo, StubServer};

    fn args(name: Option<&str>, remote: bool, readme: bool, public: bool) -> InitArgs {
        InitArgs {
            name: name.map(str::to_string),
            remote,
            readme,
            public,
        }
    }

    fn me() -> Signature<'static> {
        Signature::now("Test", "test@example.com").unwrap()
    }

    // ---- the plan ------------------------------------------------------------------

    #[test]
    fn plain_init_acts_in_the_directory_it_is_given() {
        let base = Path::new("/somewhere");
        assert_eq!(
            plan(&args(None, false, false, false), base).unwrap(),
            Plan {
                dir: base.to_path_buf(),
                remote_name: None
            }
        );
    }

    #[test]
    fn a_name_makes_a_subdirectory_and_names_the_repository() {
        let base = Path::new("/somewhere");
        let planned = plan(&args(Some("demo"), false, false, false), base).unwrap();
        assert_eq!(planned.dir, base.join("demo"));
        assert_eq!(planned.remote_name.as_deref(), Some("demo"));
        // Also with --remote, which a name already implies.
        assert_eq!(
            plan(&args(Some("demo"), true, false, true), base).unwrap(),
            planned
        );
    }

    #[test]
    fn names_the_server_would_refuse_are_usage_errors() {
        for bad in ["", "a b", "a/b", "..", "x.git", "Vidéo", &"n".repeat(101)] {
            let err = plan(&args(Some(bad), false, false, false), Path::new("/x")).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{bad:?}: {err:?}");
            assert_eq!(err.exit_code(), 2);
        }
    }

    #[test]
    fn remote_alone_names_the_repository_after_the_directory() {
        let parent = tempfile::tempdir().unwrap();
        let dir = parent.path().join("my-project");
        std::fs::create_dir(&dir).unwrap();
        let planned = plan(&args(None, true, false, false), &dir).unwrap();
        assert_eq!(planned.dir, dir);
        assert_eq!(planned.remote_name.as_deref(), Some("my-project"));
        // `.` and `..` are resolved to real names first.
        let planned = plan(&args(None, true, false, false), &dir.join(".")).unwrap();
        assert_eq!(planned.remote_name.as_deref(), Some("my-project"));
    }

    #[test]
    fn a_directory_name_the_server_would_refuse_says_to_pick_a_name() {
        let parent = tempfile::tempdir().unwrap();
        let dir = parent.path().join("Vidéo Ink - OG Edition");
        std::fs::create_dir(&dir).unwrap();
        let err = plan(&args(None, true, false, false), &dir).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert!(err.to_string().contains("nsit init <name>"), "{err}");
    }

    #[test]
    fn public_without_a_remote_is_a_usage_error() {
        let err = plan(&args(None, false, false, true), Path::new("/x")).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert!(err.to_string().contains("--public"), "{err}");
    }

    // ---- the local repository ------------------------------------------------------

    #[test]
    fn a_new_repository_starts_on_main() {
        let dir = tempfile::tempdir().unwrap();
        let (repo, created) = open_or_init(dir.path()).unwrap();
        assert!(created);
        assert_eq!(current_branch(&repo).as_deref(), Some("main"));
        assert!(head_commit(&repo).unwrap().is_none());
        assert!(dir.path().join(".git").is_dir());
    }

    #[test]
    fn an_existing_repository_is_left_exactly_as_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        crate::test_support::commit_file(&repo, "a.txt", "a");
        let tip = repo.head().unwrap().target();
        let config_before = std::fs::read(repo.path().join("config")).unwrap();
        let (again, created) = open_or_init(dir.path()).unwrap();
        assert!(!created);
        assert_eq!(again.head().unwrap().target(), tip);
        assert_eq!(
            std::fs::read(repo.path().join("config")).unwrap(),
            config_before
        );
    }

    #[test]
    fn a_directory_inside_another_repository_gets_its_own() {
        let outer = tempfile::tempdir().unwrap();
        local_repo(outer.path());
        let inner = outer.path().join("project");
        std::fs::create_dir(&inner).unwrap();
        let (repo, created) = open_or_init(&inner).unwrap();
        assert!(created, "nested projects are their own repositories");
        assert!(inner.join(".git").exists());
        assert_eq!(
            repo.workdir().unwrap().canonicalize().unwrap(),
            inner.canonicalize().unwrap()
        );
    }

    // ---- the remote ----------------------------------------------------------------

    fn created_json(clone_url: &str) -> String {
        format!(
            r#"{{"owner":"ada","name":"demo","full_name":"ada/demo","description":"","private":true,"default_branch":"main","clone_url":"{clone_url}","html_url":"https://git.example.invalid/ada/demo","created_at":"2026-10-18T09:30:00.000Z"}}"#
        )
    }

    fn answering(body: String) -> StubServer {
        StubServer::start(move |_| {
            format!(
                "HTTP/1.1 201 Created\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            )
        })
    }

    #[test]
    fn creating_the_remote_sets_origin_to_the_plain_clone_url() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let server = answering(created_json("https://git.example.invalid/ada/demo.git"));
        let api = Api::new(&server.host(), Some("ins_test_token_value".into())).unwrap();
        let wired = wire_remote(&repo, &api, &server.host(), "demo", false).unwrap();
        assert!(wired.json.created);
        assert_eq!(wired.json.private, Some(true));
        assert_eq!(
            wired.json.clone_url,
            "https://git.example.invalid/ada/demo.git"
        );
        let origin = repo.find_remote("origin").unwrap();
        assert_eq!(
            origin.url().unwrap(),
            "https://git.example.invalid/ada/demo.git"
        );
        assert_eq!(
            origin.fetch_refspecs().unwrap().get(0).unwrap(),
            Some("+refs/heads/*:refs/remotes/origin/*")
        );
        let config = std::fs::read_to_string(repo.path().join("config")).unwrap();
        assert!(!config.contains("ins_test_token_value"), "{config}");
        let sent = server.requests();
        assert_eq!(sent.len(), 1);
        assert!(
            sent[0].request_line.starts_with("POST /api/v1/repos "),
            "{sent:?}"
        );
        assert_eq!(
            sent[0].authorization.as_deref(),
            Some("Bearer ins_test_token_value")
        );
    }

    #[test]
    fn an_origin_that_is_set_is_kept_and_the_server_is_not_asked() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        repo.remote("origin", "https://elsewhere.example/ada/old.git")
            .unwrap();
        let server = answering(created_json("https://git.example.invalid/ada/demo.git"));
        let api = Api::new(&server.host(), Some("ins_test_token_value".into())).unwrap();
        let wired = wire_remote(&repo, &api, &server.host(), "demo", false).unwrap();
        assert!(!wired.json.created);
        assert_eq!(
            wired.json.clone_url,
            "https://elsewhere.example/ada/old.git"
        );
        assert!(
            wired.target.is_none(),
            "not a repository on the selected host"
        );
        assert_eq!(
            repo.find_remote("origin").unwrap().url().unwrap(),
            "https://elsewhere.example/ada/old.git"
        );
        assert_eq!(
            server.connections_after(std::time::Duration::from_millis(100)),
            0
        );
    }

    #[test]
    fn a_clone_url_with_credentials_is_refused_and_origin_is_not_set() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let server = answering(created_json(
            "https://ada:ins_stolen@git.example.invalid/ada/demo.git",
        ));
        let api = Api::new(&server.host(), Some("ins_test_token_value".into())).unwrap();
        let err = match wire_remote(&repo, &api, &server.host(), "demo", false) {
            Err(err) => err,
            Ok(_) => panic!("a URL with a password must not become origin"),
        };
        assert!(err.to_string().contains("will not use"), "{err}");
        assert!(!err.to_string().contains("ins_stolen"), "{err}");
        assert!(repo.find_remote("origin").is_err());
    }

    // ---- the README commit ---------------------------------------------------------

    #[test]
    fn the_readme_is_written_and_committed_alone_as_the_first_commit() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        std::fs::write(dir.path().join("other.txt"), "not part of the first commit").unwrap();
        let (wrote, commit) = first_readme_commit(&repo, None, "git.iam.bot", &me()).unwrap();
        assert!(wrote);
        let id = commit.expect("a commit");
        let made = repo.find_commit(id).unwrap();
        assert_eq!(made.message().unwrap(), "Initial commit\n");
        let tree = made.tree().unwrap();
        assert!(tree.get_name(README).is_some());
        assert!(
            tree.get_name("other.txt").is_none(),
            "only README.md is committed"
        );
    }

    #[test]
    fn a_second_run_neither_rewrites_nor_recommits_the_readme() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        first_readme_commit(&repo, None, "git.iam.bot", &me()).unwrap();
        let before = std::fs::read(dir.path().join(README)).unwrap();
        let tip = repo.head().unwrap().target();
        let (wrote, commit) = first_readme_commit(&repo, None, "git.iam.bot", &me()).unwrap();
        assert!(!wrote);
        assert_eq!(commit, None);
        assert_eq!(repo.head().unwrap().target(), tip);
        assert_eq!(std::fs::read(dir.path().join(README)).unwrap(), before);
    }

    #[test]
    fn an_existing_readme_is_kept_as_it_is_and_committed() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        std::fs::write(dir.path().join(README), "# mine\n").unwrap();
        let (wrote, commit) = first_readme_commit(&repo, None, "git.iam.bot", &me()).unwrap();
        assert!(!wrote);
        assert!(commit.is_some());
        assert_eq!(
            std::fs::read_to_string(dir.path().join(README)).unwrap(),
            "# mine\n"
        );
    }

    #[test]
    fn a_later_readme_commit_says_add_readme() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        crate::test_support::commit_file(&repo, "a.txt", "a");
        let (_, commit) = first_readme_commit(&repo, None, "git.iam.bot", &me()).unwrap();
        let made = repo.find_commit(commit.unwrap()).unwrap();
        assert_eq!(made.message().unwrap(), "Add README\n");
        assert_eq!(made.parent_count(), 1);
    }

    // ---- the push seam -------------------------------------------------------------

    #[test]
    fn the_push_seam_reports_no_commits_and_not_pushed() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let target = parse_repo_ref(
            "https://git.iam.bot/ada/demo.git",
            "",
            &base_url("git.iam.bot").unwrap(),
        )
        .unwrap();
        let out = crate::test_support::out_with(false, true);
        assert_eq!(
            push_first_commits(&repo, &target, "git.iam.bot", &out).unwrap(),
            FirstPush::NoCommits
        );
        crate::test_support::commit_file(&repo, "a.txt", "a");
        assert_eq!(
            push_first_commits(&repo, &target, "git.iam.bot", &out).unwrap(),
            FirstPush::NotPushed
        );
    }

    // ---- what is printed -----------------------------------------------------------

    fn sample() -> InitJson {
        InitJson {
            path: "/work/demo".into(),
            branch: Some("main".into()),
            created: true,
            remote: Some(RemoteJson {
                owner: Some("ada".into()),
                name: Some("demo".into()),
                clone_url: "https://git.iam.bot/ada/demo.git".into(),
                private: Some(true),
                created: true,
            }),
            readme: true,
            commit: Some("0123456789abcdef0123456789abcdef01234567".into()),
            pushed: false,
        }
    }

    #[test]
    fn the_text_says_what_was_made() {
        let text = describe(&sample(), true);
        assert_eq!(
            text,
            "Created a repository in /work/demo (branch main).\n\
             Created ada/demo on Insitio (private); origin is https://git.iam.bot/ada/demo.git.\n\
             Wrote README.md.\n\
             Committed 0123456."
        );
    }

    #[test]
    fn the_text_says_what_was_left_alone() {
        let mut json = sample();
        json.created = false;
        json.readme = false;
        json.commit = None;
        json.remote.as_mut().unwrap().created = false;
        let text = describe(&json, true);
        assert!(
            text.contains("already exists in /work/demo; left as it is"),
            "{text}"
        );
        assert!(
            text.contains("origin is already https://git.iam.bot/ada/demo.git"),
            "{text}"
        );
        assert!(
            text.contains("README.md already exists; left as it is"),
            "{text}"
        );
        assert!(!text.contains("Committed"), "{text}");
        // Without --readme the README line is not there at all.
        assert!(!describe(&json, false).contains("README"));
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
        assert_eq!(
            keys,
            ["branch", "commit", "created", "path", "pushed", "readme", "remote"]
        );
        let mut remote_keys: Vec<&str> = value["remote"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        remote_keys.sort_unstable();
        assert_eq!(
            remote_keys,
            ["clone_url", "created", "name", "owner", "private"]
        );
    }
}
