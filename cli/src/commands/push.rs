//! `nsit push [-u] [branch] [--force-with-lease]`: send a branch to Insitio.
//!
//! * Without `[branch]` the current branch goes, to the branch of the same name on
//!   `origin`; a detached `HEAD` is exit 2 (name the branch), and so is a branch with
//!   no commits yet or one that is not there.
//! * `origin` must be a repository URL (`https://<server>/<owner>/<name>.git`, with no
//!   user name or password in it): the token for that server, and no other, is what
//!   the push signs in with, and an `NSIT_TOKEN` only when that server is the selected
//!   one (`--host`, `NSIT_HOST`, the default). No `origin` is exit 2.
//! * Everything on the network goes through `git::run_remote`; see `git::push` for what
//!   a push does, and does not do, to the local repository. A refused push is exit 6
//!   (`non-fast-forward; run nsit pull`, `permission denied`, `stale info`, or the
//!   server's own reason), a login the server did not take is exit 3, and a server that
//!   cannot be reached is exit 1 with one line and no token.
//! * Only a fast-forward goes. `--force-with-lease` replaces the server's branch, but
//!   only if it is where `refs/remotes/origin/<branch>` says it was.
//! * A branch with no upstream gets `origin/<branch>` as its upstream by the first push,
//!   so nobody has to know `-u`; `-u` sets it again even when there is one.
//! * Progress goes to stderr, and only on a terminal.
//!
//! `--json`: `{branch, remote, updated, old, new}`: `remote` is `owner/name`, `updated`
//! is whether the server's branch changed (`false`: it already had `new`), `old` is what
//! the server's branch was (null when it had none) and `new` is the pushed commit. The
//! text is `Pushed <branch> to <owner>/<name>` or `Everything up to date`.

use std::path::Path;

use git2::{Branch, ErrorCode, Repository};
use serde::Serialize;

use crate::cli::{GlobalArgs, PushArgs};
use crate::config::{base_url, resolve_host};
use crate::error::NsitError;
use crate::git::open_repo;
use crate::git::origin::repo_ref_from_url;
use crate::git::push::{push_branch, Mode, Pushed};
use crate::git::stage::{current_branch, head_commit};
use crate::output::{for_display, Out};
use crate::repo_ref::RepoRef;

/// `--json` for `nsit push`.
#[derive(Debug, Serialize)]
struct PushJson {
    branch: String,
    remote: String,
    updated: bool,
    old: Option<String>,
    new: String,
}

impl PushJson {
    fn new(target: &RepoRef, pushed: &Pushed) -> PushJson {
        PushJson {
            branch: pushed.branch.clone(),
            remote: format!("{}/{}", target.owner, target.name),
            updated: pushed.updated,
            old: pushed.old.map(|id| id.to_string()),
            new: pushed.new.to_string(),
        }
    }
}

pub fn run(args: &PushArgs, global: &GlobalArgs, out: &Out, base: &Path) -> Result<(), NsitError> {
    let host = resolve_host(global.host.as_deref());
    let repo = open_repo(base)?;
    let branch = branch_to_push(&repo, args.branch.as_deref())?;
    let target = origin_target(&repo, &host)?;
    let mode = if args.force_with_lease {
        Mode::ForceWithLease
    } else {
        Mode::FastForward
    };
    let pushed = push_branch(&repo, &target, &host, out, &branch, mode, args.set_upstream)?;
    out.data(&PushJson::new(&target, &pushed), |json| {
        describe(json, out.tty)
    })
}

/// The local branch to push: the one that was named, or the current one.
fn branch_to_push(repo: &Repository, named: Option<&str>) -> Result<String, NsitError> {
    let branch = match named {
        Some(name) => {
            if !Branch::name_is_valid(name)? {
                return Err(NsitError::Usage(format!(
                    "{name:?} is not a valid branch name"
                )));
            }
            name.to_string()
        }
        None => current_branch(repo).ok_or_else(|| {
            NsitError::Usage(
                "HEAD is detached: say which branch to push, as in nsit push <branch>".into(),
            )
        })?,
    };
    // The branch `HEAD` is on, before its first commit, is not a branch yet.
    if current_branch(repo).as_deref() == Some(branch.as_str()) && head_commit(repo)?.is_none() {
        return Err(NsitError::Usage(format!(
            "{branch} has no commits yet: make one with nsit commit"
        )));
    }
    Ok(branch)
}

/// `origin` as the repository it names. It is read as a full URL, whichever server it is
/// on: `run_remote` then picks that server's token (never the selected host's by default).
fn origin_target(repo: &Repository, selected_host: &str) -> Result<RepoRef, NsitError> {
    let remote = repo.find_remote("origin").map_err(|e| match e.code() {
        ErrorCode::NotFound => NsitError::Usage(
            "this repository has no origin to push to (nsit init --remote creates one on Insitio)"
                .into(),
        ),
        _ => NsitError::Git(e),
    })?;
    // Only a full URL counts (see `repo_ref_from_url`): `owner/name` alone would be read as
    // being on the selected server, and git would take it for a path.
    repo_ref_from_url(remote.url()?, &base_url(selected_host)?).map_err(|why| {
        NsitError::Usage(format!(
            "origin is not a repository URL nsit can push to ({why}); it should look like \
             https://<server>/<owner>/<name>.git"
        ))
    })
}

fn describe(json: &PushJson, tty: bool) -> String {
    if json.updated {
        format!(
            "Pushed {} to {}",
            for_display(&json.branch, tty),
            json.remote
        )
    } else {
        "Everything up to date".to_string()
    }
}

#[cfg(test)]
mod tests {
    use git2::Oid;

    use super::*;
    use crate::repo_ref::parse_repo_ref;
    use crate::test_support::{commit_file, local_repo};

    // ---- which branch --------------------------------------------------------------------

    #[test]
    fn the_current_branch_is_the_default() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "a");
        assert_eq!(branch_to_push(&repo, None).unwrap(), "main");
    }

    #[test]
    fn a_named_branch_is_pushed_whichever_one_is_current() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "a");
        assert_eq!(branch_to_push(&repo, Some("feature")).unwrap(), "feature");
        assert_eq!(
            branch_to_push(&repo, Some("release/1.0")).unwrap(),
            "release/1.0"
        );
    }

    #[test]
    fn a_name_that_cannot_be_a_branch_is_a_usage_error_that_does_not_echo_controls_raw() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "a");
        for bad in ["a..b", "", "a b", "-x", "x.lock", "x\u{1b}[31m"] {
            let err = branch_to_push(&repo, Some(bad)).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{bad:?}: {err:?}");
            assert_eq!(err.exit_code(), 2);
            let text = err.to_string();
            assert!(text.contains("not a valid branch name"), "{text}");
            assert!(!text.contains('\u{1b}') && !text.contains('\n'), "{text:?}");
        }
    }

    #[test]
    fn a_detached_head_wants_the_branch_named() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "a");
        let tip = repo.head().unwrap().target().unwrap();
        repo.set_head_detached(tip).unwrap();
        let err = branch_to_push(&repo, None).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert_eq!(err.exit_code(), 2);
        assert!(err.to_string().contains("detached"), "{err}");
        assert!(err.to_string().contains("nsit push <branch>"), "{err}");
        // Naming a branch works from a detached HEAD.
        assert_eq!(branch_to_push(&repo, Some("main")).unwrap(), "main");
    }

    #[test]
    fn a_branch_before_its_first_commit_is_not_pushable_and_the_error_says_what_to_do() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        for named in [None, Some("main")] {
            let err = branch_to_push(&repo, named).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
            assert_eq!(err.exit_code(), 2);
            assert_eq!(
                err.to_string(),
                "main has no commits yet: make one with nsit commit"
            );
        }
        // Another name is for the push to find out about: there is no such branch.
        assert_eq!(branch_to_push(&repo, Some("other")).unwrap(), "other");
    }

    // ---- origin --------------------------------------------------------------------------

    #[test]
    fn origin_is_read_as_the_repository_it_names() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        repo.remote("origin", "https://git.iam.bot/ada/demo.git")
            .unwrap();
        let target = origin_target(&repo, "git.iam.bot").unwrap();
        assert_eq!(
            (target.owner.as_str(), target.name.as_str()),
            ("ada", "demo")
        );
        assert_eq!(
            target.clone_url.as_str(),
            "https://git.iam.bot/ada/demo.git"
        );

        // A test server on this machine, with or without `.git`.
        repo.remote_set_url("origin", "http://127.0.0.1:3000/ada/demo")
            .unwrap();
        let target = origin_target(&repo, "http://127.0.0.1:3000").unwrap();
        assert_eq!(
            target.clone_url.as_str(),
            "http://127.0.0.1:3000/ada/demo.git"
        );
    }

    #[test]
    fn an_origin_on_another_server_is_that_server_so_the_selected_hosts_token_stays_home() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        repo.remote("origin", "https://other.example/ada/demo.git")
            .unwrap();
        let target = origin_target(&repo, "git.iam.bot").unwrap();
        assert_eq!(target.host_key(), "other.example");
        assert_eq!(target.host, "https://other.example/");
    }

    #[test]
    fn no_origin_is_a_usage_error_that_says_how_to_get_one() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let err = origin_target(&repo, "git.iam.bot").unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert_eq!(err.exit_code(), 2);
        assert!(err.to_string().contains("no origin"), "{err}");
        assert!(err.to_string().contains("nsit init --remote"), "{err}");
        assert!(!err.to_string().contains('\n'));
    }

    #[test]
    fn an_origin_that_is_not_an_insitio_https_url_is_refused_without_echoing_it() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        for url in [
            "https://ada:ins_secret_value@git.iam.bot/ada/demo.git",
            "https://ins_secret_value@git.iam.bot/ada/demo.git",
            "git@git.iam.bot:ada/demo.git",
            "ssh://git@git.iam.bot/ada/demo.git",
            "ada/demo",
            "../demo.git",
            "/srv/git/demo.git",
            "http://git.iam.bot/ada/demo.git",
            "https://git.iam.bot/ada/demo/extra.git",
            "https://git.iam.bot/ada",
            "file:///srv/git/demo.git",
        ] {
            repo.remote_delete("origin").ok();
            repo.remote("origin", url).unwrap();
            let err = origin_target(&repo, "git.iam.bot").unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{url}: {err:?}");
            assert_eq!(err.exit_code(), 2);
            let text = err.to_string();
            assert!(!text.contains("ins_secret_value"), "{url}: {text}");
            assert!(!text.contains('\n'), "{text:?}");
            assert!(text.starts_with("origin is not a repository URL"), "{text}");
        }
    }

    // ---- what is printed -----------------------------------------------------------------

    fn target() -> RepoRef {
        parse_repo_ref("ada/demo", "", &base_url("git.iam.bot").unwrap()).unwrap()
    }

    fn pushed(old: Option<Oid>, new: Oid, updated: bool) -> Pushed {
        Pushed {
            branch: "main".into(),
            old,
            new,
            updated,
        }
    }

    #[test]
    fn the_text_says_what_was_pushed_or_that_there_was_nothing_to_push() {
        let new = Oid::from_str("0123456789abcdef0123456789abcdef01234567").unwrap();
        let json = PushJson::new(&target(), &pushed(None, new, true));
        assert_eq!(describe(&json, false), "Pushed main to ada/demo");
        let json = PushJson::new(&target(), &pushed(Some(new), new, false));
        assert_eq!(describe(&json, false), "Everything up to date");
    }

    #[test]
    fn the_json_has_the_documented_fields() {
        let old = Oid::from_str("1111111111111111111111111111111111111111").unwrap();
        let new = Oid::from_str("2222222222222222222222222222222222222222").unwrap();
        let value =
            serde_json::to_value(PushJson::new(&target(), &pushed(Some(old), new, true))).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "branch": "main",
                "remote": "ada/demo",
                "updated": true,
                "old": "1111111111111111111111111111111111111111",
                "new": "2222222222222222222222222222222222222222",
            })
        );
        let created =
            serde_json::to_value(PushJson::new(&target(), &pushed(None, new, true))).unwrap();
        assert_eq!(created["old"], serde_json::Value::Null);
    }
}
