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
//! * `--readme` writes a starter README.md and commits just that file as the
//!   first commit: not whatever else the directory holds, and not what else is
//!   staged in a repository that was already there (that stays staged, as it
//!   was). The secret guard reads the README like any commit's files. A README
//!   that is there already is the user's: it is left exactly as it is, not
//!   committed (so not pushed either), and init says so.
//! * With a remote and at least one commit (`--readme` makes one) the current
//!   branch is pushed, as `nsit push` would, so the repository is complete on
//!   Insitio when init is done. With no commit yet there is nothing to push, and
//!   init says so. If the push fails, the repository on Insitio, `origin` and
//!   the commit stay, and the error says to run `nsit push` to try again.
//!
//! Running it again where the repository exists is safe: the local part is a
//! no-op (and says so), an `origin` that is set is left alone, and what is
//! already on the server is not sent again. The one exception is a failure after
//! the repository was created on Insitio but before `origin` was set (the
//! server's clone URL is refused, say): then it exists there, `nsit init` would
//! be told the name is taken, and the error says to set `origin` by hand.
//!
//! `--json`: `{path, branch, created, remote, readme, commit, pushed}`, where
//! `created` is whether this run made the local repository, `remote` is
//! `{owner, name, clone_url, private, created}` or null, `readme` is whether
//! this run wrote README.md, `commit` is the id of the commit it made or null,
//! and `pushed` is whether the branch is on the server (sent now, or already there).

use std::path::{Path, PathBuf};

use git2::{Repository, RepositoryInitOptions, Signature};
use serde::Serialize;

use super::commit_signature;
use super::repo::signed_in;
use crate::api::Api;
use crate::cli::{GlobalArgs, InitArgs};
use crate::config::resolve_host;
use crate::error::{one_line, NsitError};
use crate::git::commit::{commit_changes, Outcome, Request, Staging};
use crate::git::origin::origin_on;
use crate::git::paths::directory_name;
use crate::git::push::{push_branch, Mode};
use crate::git::readme::{description_of, write_readme, Written, README};
use crate::git::stage::{current_branch, head_commit};
use crate::output::{for_display, Out};
use crate::repo_ref::{server_named_repo, validate_repo_name, RepoRef};

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

/// Why the server step (`wire_remote`) failed, and how far it got.
#[derive(Debug)]
struct WireFailure {
    err: NsitError,
    /// `owner/name` of the repository this step had already created on Insitio when it failed,
    /// cleaned for printing; `None` when it failed before that (nothing was made on the server).
    made: Option<String>,
}

/// What became of the first commits of a repository that now has a remote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirstPush {
    /// There is no commit yet, so nothing was sent.
    NoCommits,
    /// The branch is on the server (sent now, or it already was).
    Pushed,
    /// There are commits, and no branch to send them as: `HEAD` is detached.
    NotPushed,
}

/// Added to the error of a first push that failed. By then the repository exists on
/// Insitio, `origin` is set and the commit is made, so `nsit push` is all that is left.
const PUSH_AGAIN: &str =
    "the repository exists on Insitio and the commits are saved here; run nsit push to try again";

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
        (Some(api), Some(name)) => {
            let wired = wire_remote(&repo, api, &host, name, args.public);
            Some(wired.map_err(|failure| after_failed_wire(failure, &plan.dir, args, created))?)
        }
        _ => None,
    };
    let target = wired.as_ref().and_then(|w| w.target.as_ref());

    let (wrote_readme, commit) = match &who {
        Some(who) => first_readme_commit(&repo, target, &host, who)?,
        None => (false, None),
    };

    let pushed = match target {
        Some(target) => {
            let first =
                push_first_commits(&repo, target, &host, out).map_err(after_failed_first_push)?;
            match first {
                FirstPush::NoCommits => out.info(
                    "There is no commit yet, so nothing was pushed: make one with nsit commit.",
                ),
                FirstPush::NotPushed => out.info(
                    "HEAD is detached, so nothing was pushed: switch to a branch, then run nsit push.",
                ),
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
    out.data(&json, |json| describe(json, args.readme, out.tty))
}

/// What a failed server step says, by how far it got.
///
/// * The repository was already created on Insitio (the server's answer was then refused, or
///   `origin` could not be set): it now exists whether or not this run made the local one, so a
///   rerun is not safe (it would be told the name is taken). Say that, and how to go on.
/// * It failed before anything was made there, and this run made the local repository: that
///   repository stays behind, and a rerun is safe.
/// * Otherwise (a local repository that was there already, nothing made on the server): the
///   error as it is.
fn after_failed_wire(
    failure: WireFailure,
    dir: &Path,
    args: &InitArgs,
    local_made_here: bool,
) -> NsitError {
    match (&failure.made, local_made_here) {
        (Some(made), _) => with_hint(failure.err, &exists_on_server_hint(dir, made)),
        (None, true) => with_hint(failure.err, &rerun_hint(dir, args)),
        (None, false) => failure.err,
    }
}

/// What to tell someone whose server step failed after this run had made the
/// local repository: where it is, that it has no origin, and how to go on.
fn rerun_hint(dir: &Path, args: &InitArgs) -> String {
    let again = match &args.name {
        Some(name) => format!("nsit init {name}"),
        None => "nsit init --remote".to_string(),
    };
    format!(
        "{} is now a local repository without an origin; running {again} again is safe",
        dir.display()
    )
}

/// What to tell someone whose server step failed after the repository `made` (`owner/name`) had
/// been created on Insitio. `nsit init` cannot be run again for it: with a name, or with `--remote`,
/// it would try to create the repository and be told the name is taken, and without either it
/// never touches the server. What works is setting `origin` by hand and pushing.
fn exists_on_server_hint(dir: &Path, made: &str) -> String {
    format!(
        "the repository {made} now exists on Insitio but {} has no origin, and nsit init cannot \
         make it again; set origin yourself with git remote add origin <the clone URL of {made}> \
         and run nsit push (with --host naming that URL's server)",
        dir.display()
    )
}

/// What a failed first push says: `err` and how to go on.
///
/// Not "run nsit push to try again" when the push was refused because the server has commits
/// this repository lacks (`NsitError::NeedsPull`): the error already says what to do, and
/// pushing again would only be refused the same way.
fn after_failed_first_push(err: NsitError) -> NsitError {
    match err {
        NsitError::NeedsPull(_) => err,
        other => with_hint(other, PUSH_AGAIN),
    }
}

/// err with hint added to its one-line message. The exit code is kept: a
/// server error stays exit 1, a refused login stays exit 3.
fn with_hint(err: NsitError, hint: &str) -> NsitError {
    let add = |message: String| format!("{message}; {hint}");
    match err {
        NsitError::Usage(message) => NsitError::Usage(add(message)),
        NsitError::Auth(message) => NsitError::Auth(add(message)),
        NsitError::Rejected(message) => NsitError::Rejected(add(message)),
        NsitError::Other(message) => NsitError::Other(add(message)),
        NsitError::Api {
            status,
            code,
            message,
        } => NsitError::Api {
            status,
            code,
            message: add(message),
        },
        NsitError::Git(e) if e.code() != git2::ErrorCode::Auth => {
            NsitError::Other(add(e.message().to_string()))
        }
        NsitError::Io(e) => NsitError::Other(add(e.to_string())),
        other => other,
    }
}

/// url without the user name and password, if it has any: they must never be
/// printed (they may be a token). The authority is what follows scheme://, or
/// the whole text for the user@host:path form, up to the first /.
fn without_userinfo(url: &str) -> String {
    let (prefix, rest) = match url.find("://") {
        Some(at) => url.split_at(at + 3),
        None => ("", url),
    };
    let (authority, tail) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    match authority.rfind('@') {
        Some(at) => format!("{prefix}{}{tail}", &authority[at + 1..]),
        None => url.to_string(),
    }
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
/// `origin` is set already, leave it be. A failure says whether the repository had
/// been created on the server by then (`WireFailure::made`).
fn wire_remote(
    repo: &Repository,
    api: &Api,
    host: &str,
    name: &str,
    public: bool,
) -> Result<Wired, WireFailure> {
    if let Ok(existing) = repo.find_remote("origin") {
        let target = origin_on(repo, host);
        return Ok(Wired {
            json: RemoteJson {
                owner: target.as_ref().map(|t| t.owner.clone()),
                name: target.as_ref().map(|t| t.name.clone()),
                clone_url: without_userinfo(existing.url().unwrap_or_default()),
                private: None,
                created: false,
            },
            target,
        });
    }
    let made = api
        .create_repo(name, None, !public)
        .map_err(|err| WireFailure { err, made: None })?;
    // From here on the repository exists on the server, whatever goes wrong. What the server
    // called it is cleaned before it can go into a message.
    let after_creation = |err: NsitError| WireFailure {
        err,
        made: Some(one_line(&format!("{}/{}", made.owner, made.name), 120)),
    };
    // The server's answer is checked like any repository URL: no user name or
    // token in it, https (or loopback), and on the server that was asked (as in
    // `nsit clone`). `origin` gets the cleaned form.
    let target = server_named_repo(&made.clone_url, host).map_err(&after_creation)?;
    repo.remote("origin", target.clone_url.as_str())
        .map_err(|e| after_creation(e.into()))?;
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
/// the file was written, and the commit if one was made.
///
/// Only a README that this call wrote is committed. One that was there already (in any
/// capitalization) is the user's: it is not rewritten, and it is not staged or committed
/// either, so it stays as it was (untracked, or tracked with whatever changes it has) and
/// is never pushed by this run.
fn first_readme_commit(
    repo: &Repository,
    target: Option<&RepoRef>,
    host: &str,
    who: &Signature<'_>,
) -> Result<(bool, Option<git2::Oid>), NsitError> {
    let description = target.and_then(|t| description_of(host, t));
    let wrote = write_readme(repo, target, description.as_deref())? == Written::Created;
    if !wrote {
        return Ok((false, None));
    }
    let first = head_commit(repo)?.is_none();
    // Just the README: whatever else is staged in an existing repository is not part of this
    // commit and stays staged, and the guard looks at what the commit holds.
    let request = Request {
        message: if first {
            "Initial commit\n"
        } else {
            "Add README\n"
        }
        .to_string(),
        staging: Staging::Only(&[README]),
        allow_secret: Vec::new(),
    };
    match commit_changes(repo, who, &request)? {
        Outcome::Committed(done) => Ok((true, Some(done.id))),
        Outcome::NothingToCommit => Ok((true, None)),
    }
}

/// Send the first commits of a repository that was just given a remote.
///
/// This is where `init` hands over to the push of `nsit push`: it runs once `origin`
/// is set and the first commit, if there is one, has been made. With no commit there
/// is nothing to send. Otherwise the current branch is pushed as `nsit push` does it
/// (a fast-forward, and the branch's upstream set), so a repository that `init` has
/// finished with is on Insitio, tracked, and shows nothing ahead.
///
/// Any error is the push's own (not signed in, a server that cannot be reached, a
/// refusal); the caller adds how to go on.
pub fn push_first_commits(
    repo: &Repository,
    target: &RepoRef,
    selected_host: &str,
    out: &Out,
) -> Result<FirstPush, NsitError> {
    if head_commit(repo)?.is_none() {
        return Ok(FirstPush::NoCommits);
    }
    // A detached `HEAD` has no branch to send the commits as.
    let Some(branch) = current_branch(repo) else {
        return Ok(FirstPush::NotPushed);
    };
    push_branch(
        repo,
        target,
        selected_host,
        out,
        &branch,
        Mode::FastForward,
        false,
    )?;
    Ok(FirstPush::Pushed)
}

fn describe(json: &InitJson, readme_asked: bool, tty: bool) -> String {
    let clean = |text: &str| for_display(text, tty);
    let mut lines = Vec::new();
    let branch = clean(json.branch.as_deref().unwrap_or(INITIAL_BRANCH));
    let path = clean(&json.path);
    lines.push(if json.created {
        format!("Created a repository in {path} (branch {branch}).")
    } else {
        format!("A repository already exists in {path}; left as it is.")
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
                    "Created {}/{} on Insitio ({visibility}); origin is {}.",
                    clean(owner),
                    clean(name),
                    clean(&remote.clone_url)
                )
            }
            _ => format!(
                "origin is already {}; left as it is.",
                clean(&remote.clone_url)
            ),
        });
    }
    if readme_asked {
        lines.push(if json.readme {
            format!("Wrote {README}.")
        } else {
            format!(
                "{README} already exists; left as it is, and not committed \
                 (nsit init commits only a README it wrote)."
            )
        });
    }
    if let Some(commit) = &json.commit {
        lines.push(format!("Committed {}.", &commit[..7]));
    }
    let named = json
        .remote
        .as_ref()
        .and_then(|r| Some((r.owner.as_ref()?, r.name.as_ref()?)));
    if let (true, Some((owner, name))) = (json.pushed, named) {
        lines.push(format!(
            "Pushed {branch} to {}/{}.",
            clean(owner),
            clean(name)
        ));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::InitArgs;
    use crate::config::base_url;
    use crate::repo_ref::parse_repo_ref;
    use crate::test_support::{isolated_env, local_repo, out_with, StubServer};

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

    /// A server that answers a create with a repository that is on itself (the way Insitio
    /// does: its own base URL, then `path`).
    fn answering_with_its_own_url(path: &'static str) -> StubServer {
        let own = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let asked = std::sync::Arc::clone(&own);
        let server = StubServer::start(move |_| {
            let body = created_json(&format!("{}{path}", asked.lock().unwrap()));
            format!(
                "HTTP/1.1 201 Created\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            )
        });
        *own.lock().unwrap() = server.host();
        server
    }

    #[test]
    fn creating_the_remote_sets_origin_to_the_plain_clone_url() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let server = answering_with_its_own_url("/ada/demo.git");
        let own_url = format!("{}/ada/demo.git", server.host());
        let api = Api::new(&server.host(), Some("ins_test_token_value".into())).unwrap();
        let wired = wire_remote(&repo, &api, &server.host(), "demo", false).unwrap();
        assert!(wired.json.created);
        assert_eq!(wired.json.private, Some(true));
        assert_eq!(wired.json.clone_url, own_url);
        let origin = repo.find_remote("origin").unwrap();
        assert_eq!(origin.url().unwrap(), own_url);
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
    fn an_origin_that_carries_a_token_is_never_echoed_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        repo.remote(
            "origin",
            "https://ada:ins_secret_token_value@elsewhere.example/ada/old.git",
        )
        .unwrap();
        let server = answering(created_json("https://git.example.invalid/ada/demo.git"));
        let api = Api::new(&server.host(), Some("ins_test_token_value".into())).unwrap();
        let wired = wire_remote(&repo, &api, &server.host(), "demo", false).unwrap();
        assert!(!wired.json.created);
        assert_eq!(
            wired.json.clone_url,
            "https://elsewhere.example/ada/old.git"
        );
        // Neither the JSON nor the text has it, and the config is not touched.
        let json = InitJson {
            path: "/work/demo".into(),
            branch: Some("main".into()),
            created: false,
            remote: Some(wired.json),
            readme: false,
            commit: None,
            pushed: false,
        };
        let shown = format!(
            "{}{}",
            serde_json::to_string(&json).unwrap(),
            describe(&json, false, false)
        );
        assert!(
            !shown.contains("ins_secret") && !shown.contains("ada:"),
            "{shown}"
        );
        let config = std::fs::read_to_string(repo.path().join("config")).unwrap();
        assert!(
            config.contains("ins_secret_token_value"),
            "origin was left as it was"
        );
    }

    #[test]
    fn user_info_is_taken_out_of_every_form_of_url() {
        for (url, want) in [
            (
                "https://ada:tok@git.iam.bot/ada/x.git",
                "https://git.iam.bot/ada/x.git",
            ),
            (
                "https://tok@git.iam.bot:3000/ada/x.git",
                "https://git.iam.bot:3000/ada/x.git",
            ),
            ("ssh://git@github.com/x/y.git", "ssh://github.com/x/y.git"),
            ("git@github.com:x/y.git", "github.com:x/y.git"),
            ("ada:tok@git.iam.bot/ada/x.git", "git.iam.bot/ada/x.git"),
            ("https://a@b@git.iam.bot/x.git", "https://git.iam.bot/x.git"),
            // Nothing to take out.
            (
                "https://git.iam.bot/ada/x.git",
                "https://git.iam.bot/ada/x.git",
            ),
            (
                "https://git.iam.bot/ada/a@b.git",
                "https://git.iam.bot/ada/a@b.git",
            ),
            ("/local/path/repo.git", "/local/path/repo.git"),
            ("", ""),
        ] {
            assert_eq!(without_userinfo(url), want, "{url}");
        }
    }

    // ---- when the server step fails -------------------------------------------------

    #[test]
    fn a_failed_server_step_says_where_the_local_repository_is_and_that_a_rerun_is_safe() {
        let dir = Path::new("/work/demo");
        let named = rerun_hint(dir, &args(Some("demo"), false, false, false));
        assert!(
            named.contains("/work/demo") && named.contains("without an origin"),
            "{named}"
        );
        assert!(
            named.contains("running nsit init demo again is safe"),
            "{named}"
        );
        let remote = rerun_hint(dir, &args(None, true, false, false));
        assert!(
            remote.contains("running nsit init --remote again is safe"),
            "{remote}"
        );
    }

    /// What the server step failed with, as `wire_remote` reports it.
    fn failure(made: Option<&str>) -> WireFailure {
        WireFailure {
            err: NsitError::Other(
                "the server says this repository is at a different address".into(),
            ),
            made: made.map(str::to_string),
        }
    }

    /// Once the repository exists on Insitio, running `nsit init` again is not safe: it would try
    /// to make the repository again and be told the name is taken. The hint must say that the
    /// repository exists and how to go on, whether or not this run made the local repository.
    #[test]
    fn a_failure_after_the_repository_was_made_says_it_exists_and_never_that_a_rerun_is_safe() {
        let dir = Path::new("/work/demo");
        for created_here in [true, false] {
            for named in [Some("demo"), None] {
                let err = after_failed_wire(
                    failure(Some("ada/demo")),
                    dir,
                    &args(named, named.is_none(), false, false),
                    created_here,
                );
                let text = err.to_string();
                assert!(
                    text.starts_with("the server says this repository is at a different address; "),
                    "the error itself comes first: {text}"
                );
                assert!(
                    text.contains("the repository ada/demo now exists on Insitio"),
                    "{text}"
                );
                assert!(text.contains("/work/demo has no origin"), "{text}");
                assert!(text.contains("git remote add origin"), "{text}");
                assert!(text.contains("nsit push"), "{text}");
                assert!(!text.contains("is safe"), "{text}");
                assert!(!text.contains("again is"), "{text}");
                assert!(!text.contains('\n'), "{text:?}");
                assert_eq!(err.exit_code(), 1);
            }
        }
    }

    #[test]
    fn a_failure_before_the_repository_was_made_keeps_the_rerun_hint_for_a_repository_this_run_made(
    ) {
        let dir = Path::new("/work/demo");
        let made_here = after_failed_wire(
            failure(None),
            dir,
            &args(Some("demo"), false, false, false),
            true,
        );
        let text = made_here.to_string();
        assert!(
            text.contains("without an origin; running nsit init demo again is safe"),
            "{text}"
        );
        assert!(!text.contains("now exists on Insitio"), "{text}");
        // A local repository that was there already is not mentioned: nothing was made to leave behind.
        let was_there = after_failed_wire(
            failure(None),
            dir,
            &args(Some("demo"), false, false, false),
            false,
        );
        assert_eq!(
            was_there.to_string(),
            "the server says this repository is at a different address"
        );
    }

    #[test]
    fn a_server_that_refuses_to_make_the_repository_leaves_nothing_behind_on_it() {
        let body =
            r#"{"error":{"code":"name_taken","message":"Repository ada/demo already exists"}}"#;
        let server = StubServer::start(move |_| {
            format!(
                "HTTP/1.1 422 Unprocessable Entity\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            )
        });
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let api = Api::new(&server.host(), Some("ins_test_token_value".into())).unwrap();
        let failure = match wire_remote(&repo, &api, &server.host(), "demo", false) {
            Err(failure) => failure,
            Ok(_) => panic!("the server said no"),
        };
        assert_eq!(failure.made, None, "nothing was made on the server");
        assert!(
            matches!(failure.err, NsitError::Api { status: 422, .. }),
            "{:?}",
            failure.err
        );
        assert!(repo.find_remote("origin").is_err());
    }

    #[test]
    fn the_server_repository_name_in_the_hint_has_no_control_characters_whatever_the_server_sent() {
        let body = created_json("https://elsewhere.example/ada/demo.git")
            .replace(r#""name":"demo""#, r#""name":"de\u001b[31mmo\nx""#);
        let server = answering(body);
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let api = Api::new(&server.host(), Some("ins_test_token_value".into())).unwrap();
        let failure = match wire_remote(&repo, &api, &server.host(), "demo", false) {
            Err(failure) => failure,
            Ok(_) => panic!("a repository on another server must not become origin"),
        };
        let made = failure.made.clone().expect("the repository was made");
        assert!(!made.chars().any(char::is_control), "{made:?}");
        let text = after_failed_wire(
            failure,
            dir.path(),
            &args(Some("demo"), false, false, false),
            true,
        )
        .to_string();
        assert!(!text.chars().any(char::is_control), "{text:?}");
    }

    #[test]
    fn the_hint_joins_the_error_line_and_keeps_its_exit_code() {
        let hint = "the hint";
        let api = NsitError::Api {
            status: 409,
            code: "conflict".into(),
            message: "Repository already exists".into(),
        };
        let hinted = with_hint(api, hint);
        assert_eq!(hinted.to_string(), "Repository already exists; the hint");
        assert_eq!(hinted.exit_code(), 1);
        assert!(matches!(hinted, NsitError::Api { status: 409, .. }));

        let auth = with_hint(NsitError::Auth("not signed in".into()), hint);
        assert_eq!(auth.exit_code(), 3);
        assert_eq!(auth.to_string(), "not signed in; the hint");
        let usage = with_hint(NsitError::Usage("bad name".into()), hint);
        assert_eq!(usage.exit_code(), 2);
        let io = with_hint(NsitError::Io(std::io::Error::other("disk")), hint);
        assert_eq!(
            (io.exit_code(), io.to_string().as_str()),
            (1, "disk; the hint")
        );
        let git = with_hint(NsitError::Git(git2::Error::from_str("no remote")), hint);
        assert_eq!(
            (git.exit_code(), git.to_string().as_str()),
            (1, "no remote; the hint")
        );
        // A refused login that arrived as a libgit2 error is still exit 3.
        let refused = git2::Error::new(git2::ErrorCode::Auth, git2::ErrorClass::Http, "nope");
        assert_eq!(with_hint(NsitError::Git(refused), hint).exit_code(), 3);
        // One line stays one line.
        assert!(!hinted_text(hint).contains('\n'));
    }

    fn hinted_text(hint: &str) -> String {
        with_hint(NsitError::Other("failed".into()), hint).to_string()
    }

    #[test]
    fn a_clone_url_with_credentials_is_refused_and_origin_is_not_set() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let server = answering(created_json(
            "https://ada:ins_stolen@git.example.invalid/ada/demo.git",
        ));
        let api = Api::new(&server.host(), Some("ins_test_token_value".into())).unwrap();
        let failure = match wire_remote(&repo, &api, &server.host(), "demo", false) {
            Err(failure) => failure,
            Ok(_) => panic!("a URL with a password must not become origin"),
        };
        assert_eq!(
            failure.made.as_deref(),
            Some("ada/demo"),
            "the repository was made before its URL was refused"
        );
        let err = failure.err;
        assert!(err.to_string().contains("will not use"), "{err}");
        assert!(!err.to_string().contains("ins_stolen"), "{err}");
        assert!(repo.find_remote("origin").is_err());
    }

    #[test]
    fn a_clone_url_on_another_server_is_refused_like_clone_does_and_origin_is_not_set() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        // The server that was asked answers with a repository that is somewhere else.
        let server = answering(created_json("https://elsewhere.example/ada/demo.git"));
        let api = Api::new(&server.host(), Some("ins_test_token_value".into())).unwrap();
        let failure = match wire_remote(&repo, &api, &server.host(), "demo", false) {
            Err(failure) => failure,
            Ok(_) => panic!("a repository on another server must not become origin"),
        };
        assert_eq!(
            failure.made.as_deref(),
            Some("ada/demo"),
            "the repository was made before its address was found to be another server's"
        );
        let err = failure.err;
        assert!(matches!(err, NsitError::Other(_)), "{err:?}");
        assert!(err.to_string().contains("different address"), "{err}");
        assert!(!err.to_string().contains("elsewhere.example"), "{err}");
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

    /// Stage `name` with `content` (writing the file), without committing.
    fn stage_file(repo: &Repository, name: &str, content: &str) {
        std::fs::write(repo.workdir().unwrap().join(name), content).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(name)).unwrap();
        index.write().unwrap();
    }

    #[test]
    fn only_the_readme_is_committed_and_what_else_is_staged_stays_staged() {
        // In a repository that has commits (a changed file, a new one) and in one that has none.
        for existing in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let repo = local_repo(dir.path());
            if existing {
                crate::test_support::commit_file(&repo, "a.txt", "committed\n");
                stage_file(&repo, "a.txt", "changed and staged\n");
            }
            stage_file(&repo, "staged.txt", "new and staged\n");
            let staged_before = crate::test_support::index_on_disk(&repo);

            let (wrote, commit) = first_readme_commit(&repo, None, "git.iam.bot", &me()).unwrap();
            assert!(wrote, "existing={existing}");
            let made = repo.find_commit(commit.expect("a commit")).unwrap();
            assert_eq!(made.parent_count(), usize::from(existing));

            // The commit has the README and what was committed before: nothing that was staged.
            let tree = made.tree().unwrap();
            assert!(tree.get_name(README).is_some(), "existing={existing}");
            assert!(
                tree.get_name("staged.txt").is_none(),
                "existing={existing}: a staged file went into the README commit"
            );
            if existing {
                let a = repo
                    .find_blob(tree.get_name("a.txt").unwrap().id())
                    .unwrap();
                assert_eq!(a.content(), b"committed\n", "a staged change went in");
            }

            // What was staged still is: the same entries, and the README is now committed.
            let mut index = repo.index().unwrap();
            index.read(true).unwrap();
            let staged_after = crate::test_support::index_on_disk(&repo);
            for entry in &staged_before {
                assert!(
                    staged_after.contains(entry),
                    "existing={existing}: {entry:?}"
                );
            }
            assert!(staged_after.iter().any(|(path, _, _)| path == README));
            let status = repo.statuses(None).unwrap();
            let state_of = |path: &str| {
                status
                    .iter()
                    .find(|entry| entry.path_bytes() == path.as_bytes())
                    .map(|entry| entry.status())
            };
            assert_eq!(
                state_of("staged.txt"),
                Some(git2::Status::INDEX_NEW),
                "existing={existing}"
            );
            if existing {
                assert_eq!(state_of("a.txt"), Some(git2::Status::INDEX_MODIFIED));
            }
            assert_eq!(state_of(README), None, "the README is committed and clean");
        }
    }

    #[test]
    fn the_secret_guard_still_reads_the_readme_nsit_wrote_and_a_refusal_changes_nothing() {
        // The starter README's title is the directory's name, so a directory that is named like
        // an Insitio token makes a README the guard refuses.
        let parent = tempfile::tempdir().unwrap();
        let dir = parent.path().join(format!("ins_{}", "a".repeat(40)));
        std::fs::create_dir(&dir).unwrap();
        let repo = local_repo(&dir);
        crate::test_support::commit_file(&repo, "a.txt", "committed\n");
        stage_file(&repo, "staged.txt", "new and staged\n");
        let (head, index) = (
            repo.head().unwrap().target(),
            crate::test_support::index_on_disk(&repo),
        );

        let err = first_readme_commit(&repo, None, "git.iam.bot", &me()).unwrap_err();
        assert!(matches!(err, NsitError::SecretGuard(_)), "{err:?}");
        assert_eq!(err.exit_code(), 5);
        assert!(err.to_string().contains(README), "{err}");
        assert_eq!(repo.head().unwrap().target(), head, "nothing was committed");
        assert_eq!(crate::test_support::index_on_disk(&repo), index);
    }

    #[test]
    fn a_merge_in_progress_is_not_finished_by_a_commit_of_the_readme() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        crate::test_support::commit_file(&repo, "a.txt", "committed\n");
        std::fs::write(
            repo.path().join("MERGE_HEAD"),
            format!("{}\n", repo.head().unwrap().target().unwrap()),
        )
        .unwrap();
        let tip = repo.head().unwrap().target();
        let err = first_readme_commit(&repo, None, "git.iam.bot", &me()).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert!(err.to_string().contains("merge"), "{err}");
        assert_eq!(repo.head().unwrap().target(), tip);
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

    /// The state of `path` in `repo`'s status, if it shows up there at all.
    fn state_of(repo: &Repository, path: &str) -> Option<git2::Status> {
        let status = repo.statuses(None).unwrap();
        let found = status
            .iter()
            .find(|entry| entry.path_bytes() == path.as_bytes())
            .map(|entry| entry.status());
        found
    }

    #[test]
    fn an_existing_readme_is_kept_as_it_is_and_not_committed() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        std::fs::write(dir.path().join(README), "# mine\n").unwrap();
        let (wrote, commit) = first_readme_commit(&repo, None, "git.iam.bot", &me()).unwrap();
        assert!(!wrote);
        assert_eq!(
            commit, None,
            "a README nsit did not write is not nsit's to commit"
        );
        assert!(
            head_commit(&repo).unwrap().is_none(),
            "no commit was made at all"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join(README)).unwrap(),
            "# mine\n"
        );
        assert_eq!(
            state_of(&repo, README),
            Some(git2::Status::WT_NEW),
            "still untracked, and not staged either"
        );
    }

    #[test]
    fn an_existing_readme_is_left_alone_in_a_repository_that_has_commits_and_staged_work() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        crate::test_support::commit_file(&repo, "a.txt", "committed\n");
        stage_file(&repo, "staged.txt", "new and staged\n");
        std::fs::write(dir.path().join(README), "# mine\n").unwrap();
        let (tip, index) = (
            repo.head().unwrap().target(),
            crate::test_support::index_on_disk(&repo),
        );

        let (wrote, commit) = first_readme_commit(&repo, None, "git.iam.bot", &me()).unwrap();
        assert!(!wrote);
        assert_eq!(commit, None);
        assert_eq!(repo.head().unwrap().target(), tip, "no commit was made");
        assert_eq!(
            crate::test_support::index_on_disk(&repo),
            index,
            "the index is as it was"
        );
        assert_eq!(state_of(&repo, README), Some(git2::Status::WT_NEW));
        assert_eq!(state_of(&repo, "staged.txt"), Some(git2::Status::INDEX_NEW));
    }

    #[test]
    fn a_tracked_readme_with_changes_is_not_committed_either() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        crate::test_support::commit_file(&repo, README, "# first\n");
        std::fs::write(dir.path().join(README), "# edited since\n").unwrap();
        let tip = repo.head().unwrap().target();

        let (wrote, commit) = first_readme_commit(&repo, None, "git.iam.bot", &me()).unwrap();
        assert!(!wrote);
        assert_eq!(commit, None);
        assert_eq!(repo.head().unwrap().target(), tip);
        assert_eq!(state_of(&repo, README), Some(git2::Status::WT_MODIFIED));
        assert_eq!(
            std::fs::read_to_string(dir.path().join(README)).unwrap(),
            "# edited since\n"
        );
    }

    #[test]
    fn a_readme_under_another_capitalization_is_left_alone_too() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        std::fs::write(dir.path().join("readme.md"), "# mine\n").unwrap();
        let (wrote, commit) = first_readme_commit(&repo, None, "git.iam.bot", &me()).unwrap();
        assert!(!wrote);
        assert_eq!(commit, None);
        assert!(head_commit(&repo).unwrap().is_none());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("readme.md")).unwrap(),
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
    fn the_push_seam_sends_nothing_without_a_commit_or_a_branch_and_otherwise_is_the_pushs_own_result(
    ) {
        // Nobody is signed in, so a push that is attempted ends at once in the login refusal,
        // before anything touches the network. (The pushes themselves are in git::push and
        // in the end-to-end tests.)
        let home = tempfile::tempdir().unwrap();
        let _env = isolated_env(home.path());
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let target = parse_repo_ref(
            "https://git.iam.bot/ada/demo.git",
            "",
            &base_url("git.iam.bot").unwrap(),
        )
        .unwrap();
        let out = out_with(false, true);
        assert_eq!(
            push_first_commits(&repo, &target, "git.iam.bot", &out).unwrap(),
            FirstPush::NoCommits
        );

        crate::test_support::commit_file(&repo, "a.txt", "a");
        let tip = repo.head().unwrap().target().unwrap();
        repo.set_head_detached(tip).unwrap();
        assert_eq!(
            push_first_commits(&repo, &target, "git.iam.bot", &out).unwrap(),
            FirstPush::NotPushed,
            "no branch to send the commits as"
        );

        repo.set_head("refs/heads/main").unwrap();
        let err = push_first_commits(&repo, &target, "git.iam.bot", &out).unwrap_err();
        assert!(matches!(err, NsitError::Auth(_)), "{err:?}");
        assert_eq!(err.exit_code(), 3);
        assert!(
            repo.find_reference("refs/remotes/origin/main").is_err(),
            "nothing was recorded as pushed"
        );
    }

    #[test]
    fn a_failed_first_push_keeps_its_exit_code_and_says_to_run_nsit_push() {
        for (err, code) in [
            (NsitError::Rejected("refs/heads/main: stale".into()), 6),
            (
                NsitError::Rejected(
                    "permission denied: you do not have write access to ada/x".into(),
                ),
                6,
            ),
            (
                NsitError::Other("cannot reach git.iam.bot: refused".into()),
                1,
            ),
            (NsitError::Auth("authentication failed".into()), 3),
        ] {
            let hinted = after_failed_first_push(err);
            assert_eq!(hinted.exit_code(), code, "{hinted}");
            let text = hinted.to_string();
            assert!(text.contains("run nsit push to try again"), "{text}");
            assert!(!text.contains('\n'), "{text:?}");
        }
    }

    /// Pushing again cannot fix a push that was refused because the server has commits this
    /// repository lacks: the error already says what to do (`run nsit pull`), and a second
    /// instruction to `run nsit push` would contradict it.
    #[test]
    fn a_first_push_that_needs_a_pull_is_not_told_to_push_again() {
        for message in [
            "refs/heads/main: non-fast-forward; run nsit pull",
            "refs/heads/main: stale info; the branch on the server is not where nsit last fetched it (run nsit pull)",
        ] {
            let kept = after_failed_first_push(NsitError::NeedsPull(message.into()));
            assert!(matches!(&kept, NsitError::NeedsPull(m) if m == message), "{kept:?}");
            assert_eq!(kept.exit_code(), 6);
            assert!(!kept.to_string().contains("nsit push"), "{kept}");
        }
    }

    /// The signal is the error's type, not its wording: a refusal that is not the "behind"
    /// kind still gets the hint, whatever its message happens to say.
    #[test]
    fn the_choice_is_made_by_the_type_of_the_error_and_not_by_reading_it() {
        let wordy = NsitError::Rejected("denied by a hook: please run nsit pull first".into());
        let hinted = after_failed_first_push(wordy);
        assert!(
            hinted.to_string().ends_with("run nsit push to try again"),
            "{hinted}"
        );
        assert_eq!(hinted.exit_code(), 6);
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
        let text = describe(&sample(), true, false);
        assert_eq!(
            text,
            "Created a repository in /work/demo (branch main).\n\
             Created ada/demo on Insitio (private); origin is https://git.iam.bot/ada/demo.git.\n\
             Wrote README.md.\n\
             Committed 0123456."
        );
    }

    #[test]
    fn the_text_says_where_the_commits_were_pushed() {
        let mut json = sample();
        json.pushed = true;
        let text = describe(&json, true, false);
        assert!(
            text.ends_with("Committed 0123456.\nPushed main to ada/demo."),
            "{text}"
        );
        // Not pushed, or no repository on Insitio to name: no such line.
        json.pushed = false;
        assert!(!describe(&json, true, false).contains("Pushed"));
        json.pushed = true;
        json.remote = None;
        assert!(!describe(&json, true, false).contains("Pushed"));
    }

    #[test]
    fn the_text_says_what_was_left_alone() {
        let mut json = sample();
        json.created = false;
        json.readme = false;
        json.commit = None;
        json.remote.as_mut().unwrap().created = false;
        let text = describe(&json, true, false);
        assert!(
            text.contains("already exists in /work/demo; left as it is"),
            "{text}"
        );
        assert!(
            text.contains("origin is already https://git.iam.bot/ada/demo.git"),
            "{text}"
        );
        assert!(
            text.contains("README.md already exists; left as it is, and not committed"),
            "{text}"
        );
        assert!(!text.contains("Committed"), "{text}");
        // Without --readme the README line is not there at all.
        assert!(!describe(&json, false, false).contains("README"));
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
