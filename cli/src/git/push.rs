//! Sending a branch to `origin` with libgit2, and what that means for local state.
//!
//! One refspec, `refs/heads/<b>:refs/heads/<b>` (with a `+` for `--force-with-lease`), goes
//! through `Remote::push`, inside `run_remote`: the token for the repository's own server,
//! no redirect to another host and a refused login as exit 3 are not this module's to get
//! right. What is this module's:
//!
//! * **The non-fast-forward check is libgit2's.** The server takes any push
//!   (`receive.denyNonFastForwards` is off), so before the upload libgit2 compares the
//!   server's branch with ours and fails with `GIT_ENONFASTFORWARD` ("cannot push
//!   non-fastforwardable reference", or "... contains commits that are not present
//!   locally" when the server has commits this repository never fetched). That is
//!   `NeedsPull` (exit 6) with `non-fast-forward; run nsit pull`.
//! * **`--force-with-lease` is checked inside the push**, in libgit2's `push_negotiation`
//!   callback: it runs after the server has advertised its refs and before anything is
//!   uploaded, and its `src` is the server's current value of the branch. The server's
//!   value must equal our `refs/remotes/origin/<b>` (or the branch must be absent on both
//!   sides); otherwise the push is cancelled as `stale info`. It is one connection and one
//!   login, there is no gap between looking and pushing, and the redirect policy of
//!   `push_options` covers it. (The server also compares the old value libgit2 sends with
//!   the branch as it is when the update is applied.)
//! * **Already there is not an upload.** If the server's branch is our tip, the same
//!   callback cancels the push, and the answer is "Everything up to date".
//! * **Nothing local moves unless the push is known to have worked.** The push goes to an
//!   anonymous remote, for which libgit2 writes no remote-tracking refs of its own, and a
//!   server refusal also makes the per-ref callback fail, which keeps libgit2 from
//!   updating anything. `refs/remotes/origin/<b>` is written here, after every ref was
//!   accepted (or the server already had it), and `refs/heads/<b>` is never written.
//!   Setting the upstream (`branch.<b>.remote` and `.merge`) happens after that too.
//! * **Which address the push goes to is not what keeps the token safe.** The push is made
//!   from an anonymous remote built from the URL nsit checked (`origin`'s URL, read as a
//!   repository on an Insitio server), so nothing configured for a remote in `.git/config`
//!   (`pushurl`, refspecs) applies. But libgit2 still applies `url.<base>.insteadOf` and
//!   `url.<base>.pushInsteadOf` rewrites from the git configuration to any URL it is given,
//!   so the request can go to an address other than the one nsit checked. What protects
//!   the token is the credential provider in `auth`: it answers a credentials request only
//!   for the one host the token was chosen for, and a request for any other host gets
//!   nothing (redirects to other hosts are refused as well).
//! * **Errors are said in one line**, with the server named, and never carry more than
//!   libgit2's own words (a token is never part of those).

use std::cell::RefCell;
use std::rc::Rc;

use git2::{ErrorClass, ErrorCode, Oid, PushUpdate, Repository};

use super::auth::run_remote;
use super::upstream::{has_upstream, set_upstream};
use super::RemoteAccess;
use crate::error::{one_line, NsitError};
use crate::output::{strip_controls, Out};
use crate::repo_ref::RepoRef;

/// The longest piece of text from a server or libgit2 that goes into an error line.
const MAX_REASON: usize = 200;

/// How a branch is sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Only if the server's branch is an ancestor of ours.
    FastForward,
    /// `--force-with-lease`: replace the server's branch, but only if it is where nsit last
    /// saw it.
    ForceWithLease,
}

/// What a push did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pushed {
    pub branch: String,
    /// The server's branch before the push; `None` when it did not have one.
    pub old: Option<Oid>,
    /// The server's branch now: the local tip.
    pub new: Oid,
    /// Did the server's branch change? `false`: it already was at `new`.
    pub updated: bool,
}

/// Push the local branch `branch` to the same name on `origin`, which is `target`.
///
/// Afterwards `refs/remotes/origin/<branch>` is the pushed tip, and the branch's upstream is
/// set if it had none (or `set_upstream_now`). On any failure no ref and no setting changes.
pub fn push_branch(
    repo: &Repository,
    target: &RepoRef,
    selected_host: &str,
    out: &Out,
    branch: &str,
    mode: Mode,
    set_upstream_now: bool,
) -> Result<Pushed, NsitError> {
    let pushed = push_via(repo, target, branch, mode, |hooks, refspec| {
        run_remote(target, selected_host, out, |access| {
            upload(repo, target.clone_url.as_str(), access, hooks, refspec)
        })
    })?;
    if set_upstream_now || !has_upstream(repo, branch)? {
        set_upstream(repo, branch, "origin")?;
    }
    Ok(pushed)
}

/// Everything about a push except how the bytes travel: `transport` runs the libgit2 push
/// for the refspec, with the hooks that watch it. The local refs are written (or not) after.
fn push_via(
    repo: &Repository,
    target: &RepoRef,
    branch: &str,
    mode: Mode,
    transport: impl FnOnce(&Hooks, &str) -> Result<(), NsitError>,
) -> Result<Pushed, NsitError> {
    let refname = format!("refs/heads/{branch}");
    let tip = repo.refname_to_id(&refname).map_err(|e| match e.code() {
        ErrorCode::NotFound | ErrorCode::InvalidSpec => NsitError::Usage(format!(
            "there is no branch named {}",
            strip_controls(branch)
        )),
        _ => NsitError::Git(e),
    })?;
    let tracking = tracking_ref(branch);
    let lease = match mode {
        Mode::FastForward => None,
        Mode::ForceWithLease => Some(tracking_tip(repo, &tracking)?),
    };

    let hooks = Hooks::new(&refname, tip, lease);
    let result = transport(&hooks, &refspec(&refname, mode == Mode::ForceWithLease));
    let done = outcome(&hooks.report.borrow(), result, &refname, target)?;

    // Only now, with the server's branch known to be the tip, does a local ref move.
    repo.reference(&tracking, tip, true, &format!("nsit push: {branch}"))?;
    let old = hooks.report.borrow().before.flatten();
    Ok(Pushed {
        branch: branch.to_string(),
        old,
        new: tip,
        updated: done == Outcome::Sent,
    })
}

/// The libgit2 push itself, to an anonymous remote made from `url` (the URL nsit checked;
/// `.git/config`'s own settings for `origin` are not used), with the hooks added to the options
/// that `run_remote` hands out. libgit2 may still rewrite `url` by `insteadOf` settings, so
/// this is not what keeps the token from another host: the credential provider is (see the
/// module documentation).
fn upload(
    repo: &Repository,
    url: &str,
    access: RemoteAccess<'_>,
    hooks: &Hooks,
    refspec: &str,
) -> Result<(), git2::Error> {
    let mut remote = repo.remote_anonymous(url)?;
    let (negotiation, status) = (hooks.clone(), hooks.clone());
    let mut options = access.push_options(
        move |updates| negotiation.on_negotiation(updates),
        move |name, state| status.on_status(name, state),
    );
    remote.push(&[refspec], Some(&mut options))
}

/// `refs/heads/<b>:refs/heads/<b>`, with a `+` in front when the server's branch may be
/// replaced.
fn refspec(refname: &str, force: bool) -> String {
    format!("{}{refname}:{refname}", if force { "+" } else { "" })
}

fn tracking_ref(branch: &str) -> String {
    format!("refs/remotes/origin/{branch}")
}

/// What `refs/remotes/origin/<b>` points at, `None` when there is no such ref.
fn tracking_tip(repo: &Repository, tracking: &str) -> Result<Option<Oid>, NsitError> {
    match repo.refname_to_id(tracking) {
        Ok(id) => Ok(Some(id)),
        Err(e) if e.code() == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

// ---- watching the push -------------------------------------------------------------------

/// What the hooks saw while libgit2 pushed.
#[derive(Debug, Default)]
struct Report {
    /// The server's branch as it advertised it before the push: `None` while the push has
    /// not got that far, `Some(None)` when the server has no such branch.
    before: Option<Option<Oid>>,
    /// The lease did not hold, and the push was cancelled.
    stale: bool,
    /// The server's branch is our tip, and the push was cancelled as there is nothing to send.
    up_to_date: bool,
    /// Refs the server refused to update, with its reason.
    rejected: Vec<(String, String)>,
}

/// What to do about the server's branch, once it has said where it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    Send,
    UpToDate,
    Stale,
}

/// `before` is the server's value of the branch (`None`: it has none), `tip` ours, and
/// `lease` what the lease expects (`None`: no lease; `Some(None)`: no branch on the server).
fn verdict(before: Option<Oid>, tip: Oid, lease: Option<Option<Oid>>) -> Verdict {
    if before == Some(tip) {
        return Verdict::UpToDate;
    }
    if lease.is_some_and(|expected| expected != before) {
        return Verdict::Stale;
    }
    Verdict::Send
}

/// The two callbacks of one push, and what they saw. Cloning shares the report.
#[derive(Clone)]
struct Hooks {
    report: Rc<RefCell<Report>>,
    refname: String,
    tip: Oid,
    lease: Option<Option<Oid>>,
}

impl Hooks {
    fn new(refname: &str, tip: Oid, lease: Option<Option<Oid>>) -> Hooks {
        Hooks {
            report: Rc::new(RefCell::new(Report::default())),
            refname: refname.to_string(),
            tip,
            lease,
        }
    }

    /// libgit2's `push_negotiation`: the server has advertised its refs and nothing is
    /// uploaded yet. An error cancels the push.
    fn on_negotiation(&self, updates: &[PushUpdate<'_>]) -> Result<(), git2::Error> {
        let Some(update) = updates
            .iter()
            .find(|u| u.dst_refname_bytes() == self.refname.as_bytes())
        else {
            return Ok(());
        };
        // An all-zero id is how libgit2 says the server has no such branch.
        let before = Some(update.src()).filter(|id| !id.is_zero());
        let mut report = self.report.borrow_mut();
        report.before = Some(before);
        match verdict(before, self.tip, self.lease) {
            Verdict::Send => Ok(()),
            Verdict::Stale => {
                report.stale = true;
                Err(cancelled(
                    "the branch on the server is not where it was last fetched",
                ))
            }
            Verdict::UpToDate => {
                report.up_to_date = true;
                Err(cancelled("the server already has this commit"))
            }
        }
    }

    /// libgit2's `push_update_reference`, once per ref after the upload: `status` is `Some`
    /// when the server refused it. Failing here is what keeps libgit2 from updating the
    /// remote-tracking refs after a refusal.
    fn on_status(&self, name: &str, status: Option<&str>) -> Result<(), git2::Error> {
        let Some(reason) = status else {
            return Ok(());
        };
        self.report
            .borrow_mut()
            .rejected
            .push((name.to_string(), reason.to_string()));
        Err(cancelled("the server refused the update"))
    }
}

/// An error from one of our own callbacks that stops libgit2. What it says is not shown:
/// `outcome` tells what happened from the report.
fn cancelled(why: &str) -> git2::Error {
    git2::Error::new(ErrorCode::User, ErrorClass::None, why)
}

// ---- judging what happened ---------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    /// The server took the branch.
    Sent,
    /// The server already had it; nothing was sent.
    UpToDate,
}

/// Success, or the error to report. What the hooks saw comes first: it is what stopped
/// libgit2, and says more than the error does.
fn outcome(
    report: &Report,
    result: Result<(), NsitError>,
    refname: &str,
    target: &RepoRef,
) -> Result<Outcome, NsitError> {
    if report.stale {
        return Err(NsitError::NeedsPull(format!(
            "{refname}: stale info; the branch on the server is not where nsit last fetched it \
             (run nsit pull)"
        )));
    }
    if let Some((name, reason)) = report.rejected.first() {
        // The server's own refusal of a non-fast-forward is the one refusal that reads (and is
        // typed) like ours: the way on is a pull. Its words are classified here, once, so that
        // nothing downstream has to read the message to know.
        let text = one_line(reason, MAX_REASON);
        let behind = text.to_ascii_lowercase().contains("non-fast-forward");
        let line = format!(
            "{}: {}",
            one_line(name, MAX_REASON),
            if behind {
                "non-fast-forward; run nsit pull"
            } else {
                &text
            }
        );
        return Err(if behind {
            NsitError::NeedsPull(line)
        } else {
            NsitError::Rejected(line)
        });
    }
    if report.up_to_date {
        return Ok(Outcome::UpToDate);
    }
    match result {
        Ok(()) => Ok(Outcome::Sent),
        Err(err) => Err(push_error(err, target, refname)),
    }
}

/// What a failed push should say. A refused login is already exit 3 (`run_remote`); the
/// rest of libgit2's errors become one of:
///
/// * `GIT_ENONFASTFORWARD`: `NeedsPull` (exit 6), `non-fast-forward; run nsit pull`;
/// * HTTP 403, which Insitio answers to a signed-in account without write access:
///   `Rejected` (exit 6), `permission denied`. libgit2 does not hand on the server's text,
///   only the status, so the repository is named from what nsit pushed to;
/// * HTTP 404: no such repository, or none this account may see;
/// * anything else: exit 1, one line (`plain_failure`): "cannot reach <server>" for the network,
///   "<server> reported a problem" when the server said it failed (a pack it could not unpack).
fn push_error(err: NsitError, target: &RepoRef, refname: &str) -> NsitError {
    let NsitError::Git(git) = err else {
        return err;
    };
    if git.code() == ErrorCode::NotFastForward {
        return NsitError::NeedsPull(format!("{refname}: non-fast-forward; run nsit pull"));
    }
    match http_status(&git) {
        Some(403) => NsitError::Rejected(format!(
            "permission denied: you do not have write access to {}/{}",
            target.owner, target.name
        )),
        Some(404) => NsitError::Other("repository not found or no access".into()),
        Some(code) => NsitError::Other(format!(
            "{} answered the push with HTTP {code}",
            target.host_key()
        )),
        None => plain_failure(&git, target),
    }
}

/// One line for a libgit2 failure that is neither a refusal nor an HTTP status. Always exit 1;
/// what the line says depends on who failed:
///
/// * nsit itself, which libgit2 hands back as `ErrorCode::User` (the credential provider's
///   "refusing to send your token to a host other than ..."): its own words. It is class `Http`,
///   but nothing was sent and nobody was asked, so it must not read as a connection problem.
/// * the server, which answered and said it failed (`reported_by_server`):
///   `<server> reported a problem: <libgit2's words>`. A push the server could not unpack is
///   the main case.
/// * the network (`Net`, `Os`, `Http`, `Ssl`): `cannot reach <server>: <why>`.
/// * anything else: libgit2's own words.
///
/// Used by `pull` too.
pub(super) fn plain_failure(git: &git2::Error, target: &RepoRef) -> NsitError {
    let text = one_line(git.message(), MAX_REASON);
    if git.code() == ErrorCode::User {
        return NsitError::Other(text);
    }
    if reported_by_server(git) {
        return NsitError::Other(format!("{} reported a problem: {text}", target.host_key()));
    }
    let network = matches!(
        git.class(),
        ErrorClass::Net | ErrorClass::Os | ErrorClass::Http | ErrorClass::Ssl
    );
    if network {
        NsitError::Other(format!("cannot reach {}: {text}", target.host_key()))
    } else {
        NsitError::Other(text)
    }
}

/// Did the server answer and say that it failed, as opposed to not answering? libgit2 gives all
/// of these class `Net`, like a dropped connection, and has no code that tells them apart, so
/// this reads the message, like `http_status` does.
///
/// Pinned to libgit2 1.9.7 (libgit2-sys 0.18.8, git2 0.21). A libgit2 update has to re-check the
/// markers against its sources (`src/libgit2/` in libgit2-sys); the push test in
/// `tests/nsit.e2e.test.ts` that makes a real server refuse a pack (`receive.maxInputSize`) fails
/// if the first one stops matching.
///
/// * `push.c`, `git_push_finish` (line 539): "unpacking the sent packfile failed on the remote".
///   The server's report-status said that `unpack` did not work: it could not store the pack (a
///   size limit, a full disk, a broken repository). libgit2 stops there, so no per-ref status
///   reaches `Hooks::on_status`.
/// * `transports/smart_protocol.c`: "remote error: <text>" (line 72), an `ERR` packet the server
///   sent instead of what was asked; "report-status: Error reported: <text>" (line 1004) and
///   "report-status: protocol error" (lines 897, 1081, 1096), the server's reply to a push.
fn reported_by_server(git: &git2::Error) -> bool {
    const MARKERS: [&str; 3] = [
        "unpacking the sent packfile failed on the remote",
        "remote error:",
        "report-status:",
    ];
    git.class() == ErrorClass::Net && MARKERS.iter().any(|m| git.message().contains(m))
}

/// The HTTP status libgit2 names in an error, when it refused to go on because of one:
/// "unexpected http status code: 403" from its own HTTP client, "request failed with status
/// code: 403" from WinHTTP.
///
/// Pinned to libgit2 1.9.7 (libgit2-sys 0.18.8, git2 0.21), and read from the message because
/// libgit2 gives the status no field of its own. A libgit2 update has to re-check both sources:
///
/// * `src/libgit2/transports/http.c`, `handle_response` (line 282):
///   `git_error_set(GIT_ERROR_HTTP, "unexpected http status code: %d", ...)`;
/// * `src/libgit2/transports/winhttp.c` (line 1274), the transport used on Windows:
///   `git_error_set(GIT_ERROR_HTTP, "request failed with status code: %lu", ...)`.
///
/// Both are class `Http` and both put the number straight after "status code: ". (A 401 is not
/// read here: in http.c it is "unexpected authentication failure", `GIT_EAUTH`, which
/// `remote_error` turns into exit 3.) The 403 and 404 tests in this file pin the two wordings, and
/// the read-only collaborator test in `tests/nsit.e2e.test.ts` gets a real 403 through each
/// platform's own transport, so a change of wording fails CI on the platform it affects.
pub(super) fn http_status(err: &git2::Error) -> Option<u16> {
    if err.class() != ErrorClass::Http {
        return None;
    }
    let (_, rest) = err.message().split_once("status code: ")?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use git2::{PushOptions, RemoteCallbacks, Signature};
    use url::Url;

    use super::*;
    use crate::config::Config;
    use crate::credentials::{host_key_for, store_token};
    use crate::repo_ref::parse_repo_ref;
    use crate::test_support::{
        commit_file, host_entry_for, isolated_env, local_repo, out_with, StubServer,
    };

    fn target() -> RepoRef {
        parse_repo_ref("ada/demo", "", &Url::parse("https://git.iam.bot/").unwrap()).unwrap()
    }

    // ---- fixtures: a bare repository for the server, local ones that push to it --------------

    /// An empty bare repository: the server, as libgit2's local transport sees it. Everything
    /// below `push_branch`'s network step (the hooks, the judging of the outcome, the writing of
    /// the tracking ref) is the real code; only HTTP is replaced.
    fn server_at(dir: &Path) -> (PathBuf, Repository) {
        let path = dir.join("server.git");
        let repo = Repository::init_bare(&path).unwrap();
        (path, repo)
    }

    /// A repository on `main` whose `origin` is the server at `server`.
    fn work_repo(dir: &Path, name: &str, server: &Path) -> Repository {
        let path = dir.join(name);
        std::fs::create_dir(&path).unwrap();
        let repo = local_repo(&path);
        repo.remote("origin", server.to_str().unwrap()).unwrap();
        repo
    }

    fn tip(repo: &Repository) -> Oid {
        repo.refname_to_id("refs/heads/main").unwrap()
    }

    fn tracking(repo: &Repository) -> Option<Oid> {
        repo.refname_to_id("refs/remotes/origin/main").ok()
    }

    fn server_tip(server: &Repository) -> Option<Oid> {
        server.refname_to_id("refs/heads/main").ok()
    }

    /// The upload `push_branch` makes over HTTP, over libgit2's local transport instead: the
    /// same hooks on the same libgit2 push.
    fn local_upload(
        repo: &Repository,
        server: &Path,
        hooks: &Hooks,
        refspec: &str,
    ) -> Result<(), git2::Error> {
        let mut remote = repo.remote_anonymous(server.to_str().unwrap())?;
        let (negotiation, status) = (hooks.clone(), hooks.clone());
        let mut callbacks = RemoteCallbacks::new();
        callbacks.push_negotiation(move |updates| negotiation.on_negotiation(updates));
        callbacks.push_update_reference(move |name, state| status.on_status(name, state));
        let mut options = PushOptions::new();
        options.remote_callbacks(callbacks);
        remote.push(&[refspec], Some(&mut options))
    }

    fn push_local(
        repo: &Repository,
        server: &Path,
        branch: &str,
        mode: Mode,
    ) -> Result<Pushed, NsitError> {
        push_via(repo, &target(), branch, mode, |hooks, refspec| {
            local_upload(repo, server, hooks, refspec).map_err(NsitError::Git)
        })
    }

    /// Fetch the server's `main` into `refs/remotes/origin/main`, the way `nsit pull` will.
    fn fetch_main(repo: &Repository) {
        repo.find_remote("origin")
            .unwrap()
            .fetch(&["+refs/heads/main:refs/remotes/origin/main"], None, None)
            .unwrap();
    }

    /// Replace `main` by a commit with no parent: history that does not contain whatever the
    /// server has of this branch.
    fn rewrite_main(repo: &Repository) -> Oid {
        let tree = repo
            .find_tree(repo.treebuilder(None).unwrap().write().unwrap())
            .unwrap();
        let who = Signature::now("Test", "test@example.com").unwrap();
        let id = repo
            .commit(None, &who, &who, "rewritten", &tree, &[])
            .unwrap();
        repo.reference("refs/heads/main", id, true, "rewrite")
            .unwrap();
        id
    }

    /// Every ref of `repo` with its target: what a failed push must leave exactly as it was.
    fn all_refs(repo: &Repository) -> Vec<(String, String)> {
        let mut refs: Vec<(String, String)> = repo
            .references()
            .unwrap()
            .map(|r| {
                let r = r.unwrap();
                let target = r
                    .target()
                    .map(|id| id.to_string())
                    .or_else(|| r.symbolic_target().ok().flatten().map(str::to_string))
                    .unwrap_or_default();
                (r.name().unwrap().to_string(), target)
            })
            .collect();
        refs.sort();
        refs
    }

    // ---- a push that goes through -------------------------------------------------------------

    #[test]
    fn a_fast_forward_push_sends_the_branch_and_only_then_moves_the_tracking_ref() {
        let dir = tempfile::tempdir().unwrap();
        let (server_path, server) = server_at(dir.path());
        let repo = work_repo(dir.path(), "work", &server_path);
        commit_file(&repo, "a.txt", "a");
        let first = tip(&repo);
        assert_eq!(tracking(&repo), None);

        let pushed = push_local(&repo, &server_path, "main", Mode::FastForward).unwrap();
        assert_eq!(
            pushed,
            Pushed {
                branch: "main".into(),
                old: None,
                new: first,
                updated: true
            }
        );
        assert_eq!(server_tip(&server), Some(first));
        assert_eq!(tracking(&repo), Some(first));
        assert_eq!(tip(&repo), first, "the branch itself is not touched");

        commit_file(&repo, "b.txt", "b");
        let second = tip(&repo);
        let pushed = push_local(&repo, &server_path, "main", Mode::FastForward).unwrap();
        assert_eq!(
            (pushed.old, pushed.new, pushed.updated),
            (Some(first), second, true)
        );
        assert_eq!(server_tip(&server), Some(second));
        assert_eq!(tracking(&repo), Some(second));
    }

    #[test]
    fn a_branch_the_server_already_has_in_full_is_up_to_date_and_sends_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (server_path, server) = server_at(dir.path());
        let repo = work_repo(dir.path(), "work", &server_path);
        commit_file(&repo, "a.txt", "a");
        let first = tip(&repo);
        push_local(&repo, &server_path, "main", Mode::FastForward).unwrap();

        let again = push_local(&repo, &server_path, "main", Mode::FastForward).unwrap();
        assert_eq!(
            again,
            Pushed {
                branch: "main".into(),
                old: Some(first),
                new: first,
                updated: false
            }
        );
        assert_eq!(server_tip(&server), Some(first));
        // It says so even with a lease, and a tracking ref that was missing is put back: the
        // server's branch is known to be there.
        repo.find_reference("refs/remotes/origin/main")
            .unwrap()
            .delete()
            .unwrap();
        assert_eq!(tracking(&repo), None);
        let leased = push_local(&repo, &server_path, "main", Mode::ForceWithLease).unwrap();
        assert!(!leased.updated);
        assert_eq!(tracking(&repo), Some(first));
    }

    #[test]
    fn a_branch_the_server_does_not_have_is_created_and_has_no_old_value() {
        let dir = tempfile::tempdir().unwrap();
        let (server_path, server) = server_at(dir.path());
        let repo = work_repo(dir.path(), "work", &server_path);
        commit_file(&repo, "a.txt", "a");
        let first = tip(&repo);
        repo.branch("feature", &repo.find_commit(first).unwrap(), false)
            .unwrap();
        let pushed = push_local(&repo, &server_path, "feature", Mode::FastForward).unwrap();
        assert_eq!(pushed.old, None);
        assert!(pushed.updated);
        assert_eq!(server.refname_to_id("refs/heads/feature").unwrap(), first);
        assert_eq!(
            repo.refname_to_id("refs/remotes/origin/feature").unwrap(),
            first
        );
        // Only the branch that was named went.
        assert_eq!(server_tip(&server), None);
        assert_eq!(tracking(&repo), None);
    }

    // ---- libgit2's own refusal of a push that is not a fast-forward ----------------------------

    /// What libgit2 says when the server's branch has commits this repository has never seen:
    /// `GIT_ENONFASTFORWARD`, class reference. This is the check that has to stand in for the
    /// server's, which takes any push (`receive.denyNonFastForwards` is off).
    #[test]
    fn libgit2_calls_a_server_branch_with_unseen_commits_a_non_fast_forward() {
        let dir = tempfile::tempdir().unwrap();
        let (server_path, _server) = server_at(dir.path());
        let one = work_repo(dir.path(), "one", &server_path);
        commit_file(&one, "a.txt", "a");
        push_local(&one, &server_path, "main", Mode::FastForward).unwrap();
        // Another clone that has its own history and never fetched the server's.
        let two = work_repo(dir.path(), "two", &server_path);
        commit_file(&two, "b.txt", "b");

        let hooks = Hooks::new("refs/heads/main", tip(&two), None);
        let err = local_upload(
            &two,
            &server_path,
            &hooks,
            "refs/heads/main:refs/heads/main",
        )
        .unwrap_err();
        assert_eq!(err.code(), ErrorCode::NotFastForward, "{err}");
        assert_eq!(err.class(), ErrorClass::Reference, "{err}");
        assert!(
            err.message().contains("not present locally"),
            "{}",
            err.message()
        );
    }

    /// And when the commits are known here but the branches have diverged.
    #[test]
    fn libgit2_calls_diverged_branches_a_non_fast_forward_too() {
        let dir = tempfile::tempdir().unwrap();
        let (server_path, _server) = server_at(dir.path());
        let one = work_repo(dir.path(), "one", &server_path);
        commit_file(&one, "a.txt", "a");
        push_local(&one, &server_path, "main", Mode::FastForward).unwrap();
        let two = work_repo(dir.path(), "two", &server_path);
        fetch_main(&two);
        two.reference("refs/heads/main", tracking(&two).unwrap(), true, "x")
            .unwrap();
        // The server moves on, and so does `two`; `two` then learns the server's objects.
        commit_file(&one, "c.txt", "c");
        push_local(&one, &server_path, "main", Mode::FastForward).unwrap();
        commit_file(&two, "b.txt", "b");
        fetch_main(&two);

        let hooks = Hooks::new("refs/heads/main", tip(&two), None);
        let err = local_upload(
            &two,
            &server_path,
            &hooks,
            "refs/heads/main:refs/heads/main",
        )
        .unwrap_err();
        assert_eq!(err.code(), ErrorCode::NotFastForward, "{err}");
        assert_eq!(err.class(), ErrorClass::Reference, "{err}");
        assert!(
            err.message().contains("non-fastforwardable"),
            "{}",
            err.message()
        );
    }

    #[test]
    fn a_non_fast_forward_is_exit_6_and_no_local_ref_and_nothing_on_the_server_moves() {
        let dir = tempfile::tempdir().unwrap();
        let (server_path, server) = server_at(dir.path());
        let one = work_repo(dir.path(), "one", &server_path);
        commit_file(&one, "a.txt", "a");
        push_local(&one, &server_path, "main", Mode::FastForward).unwrap();
        let theirs = tip(&one);

        let two = work_repo(dir.path(), "two", &server_path);
        commit_file(&two, "b.txt", "b");
        let before = all_refs(&two);

        let err = push_local(&two, &server_path, "main", Mode::FastForward).unwrap_err();
        assert!(matches!(err, NsitError::NeedsPull(_)), "{err:?}");
        assert_eq!(err.exit_code(), 6);
        assert_eq!(
            err.to_string(),
            "refs/heads/main: non-fast-forward; run nsit pull"
        );
        assert_eq!(
            all_refs(&two),
            before,
            "refs/heads/main and the tracking ref are as they were"
        );
        assert_eq!(tracking(&two), None);
        assert_eq!(server_tip(&server), Some(theirs));

        // The same when two has fetched (so it has the server's commit) and then fell behind it.
        fetch_main(&two);
        let before = all_refs(&two);
        let err = push_local(&two, &server_path, "main", Mode::FastForward).unwrap_err();
        assert_eq!(err.exit_code(), 6, "{err}");
        assert_eq!(all_refs(&two), before);
        assert_eq!(server_tip(&server), Some(theirs));
    }

    #[test]
    fn a_branch_that_is_behind_the_server_is_refused_the_same_way() {
        let dir = tempfile::tempdir().unwrap();
        let (server_path, server) = server_at(dir.path());
        let one = work_repo(dir.path(), "one", &server_path);
        commit_file(&one, "a.txt", "a");
        push_local(&one, &server_path, "main", Mode::FastForward).unwrap();
        let two = work_repo(dir.path(), "two", &server_path);
        fetch_main(&two);
        two.reference("refs/heads/main", tracking(&two).unwrap(), true, "x")
            .unwrap();
        commit_file(&one, "b.txt", "b");
        push_local(&one, &server_path, "main", Mode::FastForward).unwrap();
        fetch_main(&two);
        let behind = server_tip(&server);

        // two's main is an ancestor of the server's: nothing of its own to send, and it is not
        // "up to date" either.
        let err = push_local(&two, &server_path, "main", Mode::FastForward).unwrap_err();
        assert_eq!(err.exit_code(), 6, "{err}");
        assert_eq!(server_tip(&server), behind);
    }

    // ---- --force-with-lease -------------------------------------------------------------------

    #[test]
    fn a_lease_lets_a_rewritten_branch_replace_the_servers_when_the_server_is_where_we_saw_it() {
        let dir = tempfile::tempdir().unwrap();
        let (server_path, server) = server_at(dir.path());
        let repo = work_repo(dir.path(), "work", &server_path);
        commit_file(&repo, "a.txt", "a");
        let seen = tip(&repo);
        push_local(&repo, &server_path, "main", Mode::FastForward).unwrap();
        let rewritten = rewrite_main(&repo);

        // Without the lease it is refused...
        let err = push_local(&repo, &server_path, "main", Mode::FastForward).unwrap_err();
        assert_eq!(err.exit_code(), 6, "{err}");
        assert_eq!(server_tip(&server), Some(seen));
        // ...and the lease holds, so it goes.
        let pushed = push_local(&repo, &server_path, "main", Mode::ForceWithLease).unwrap();
        assert_eq!(
            pushed,
            Pushed {
                branch: "main".into(),
                old: Some(seen),
                new: rewritten,
                updated: true
            }
        );
        assert_eq!(server_tip(&server), Some(rewritten));
        assert_eq!(tracking(&repo), Some(rewritten));
    }

    #[test]
    fn a_lease_is_refused_as_stale_info_when_the_server_moved_and_nothing_moves() {
        let dir = tempfile::tempdir().unwrap();
        let (server_path, server) = server_at(dir.path());
        let one = work_repo(dir.path(), "one", &server_path);
        commit_file(&one, "a.txt", "a");
        push_local(&one, &server_path, "main", Mode::FastForward).unwrap();
        let two = work_repo(dir.path(), "two", &server_path);
        fetch_main(&two);
        two.reference("refs/heads/main", tracking(&two).unwrap(), true, "x")
            .unwrap();
        // Somebody else pushes after two last looked.
        commit_file(&one, "b.txt", "b");
        push_local(&one, &server_path, "main", Mode::FastForward).unwrap();
        let theirs = tip(&one);
        rewrite_main(&two);
        let before = all_refs(&two);

        let err = push_local(&two, &server_path, "main", Mode::ForceWithLease).unwrap_err();
        assert!(matches!(err, NsitError::NeedsPull(_)), "{err:?}");
        assert_eq!(err.exit_code(), 6);
        assert!(
            err.to_string().starts_with("refs/heads/main: stale info"),
            "{err}"
        );
        assert!(!err.to_string().contains('\n'), "{err}");
        assert_eq!(all_refs(&two), before);
        assert_eq!(
            server_tip(&server),
            Some(theirs),
            "the server was not written to"
        );
    }

    #[test]
    fn with_no_tracking_ref_a_lease_expects_the_server_not_to_have_the_branch() {
        let dir = tempfile::tempdir().unwrap();
        let (server_path, server) = server_at(dir.path());
        let one = work_repo(dir.path(), "one", &server_path);
        commit_file(&one, "a.txt", "a");
        let two = work_repo(dir.path(), "two", &server_path);
        commit_file(&two, "b.txt", "b");
        // Nothing on the server yet: the lease holds.
        push_local(&one, &server_path, "main", Mode::ForceWithLease).unwrap();
        assert_eq!(server_tip(&server), Some(tip(&one)));
        // Now the server has a branch two never saw: stale.
        assert_eq!(tracking(&two), None);
        let err = push_local(&two, &server_path, "main", Mode::ForceWithLease).unwrap_err();
        assert!(err.to_string().contains("stale info"), "{err}");
        assert_eq!(server_tip(&server), Some(tip(&one)));
    }

    // ---- what libgit2 does by itself (the reason nsit writes the tracking ref) ------------------

    #[test]
    fn libgit2_writes_no_tracking_refs_for_an_anonymous_remote_so_nsit_does_it_after_the_check() {
        let dir = tempfile::tempdir().unwrap();
        let (server_path, _server) = server_at(dir.path());
        let repo = work_repo(dir.path(), "work", &server_path);
        commit_file(&repo, "a.txt", "a");
        let hooks = Hooks::new("refs/heads/main", tip(&repo), None);
        local_upload(
            &repo,
            &server_path,
            &hooks,
            "refs/heads/main:refs/heads/main",
        )
        .unwrap();
        assert_eq!(tracking(&repo), None, "libgit2 did not move origin/main");
    }

    // ---- what the server says about each ref ---------------------------------------------------

    #[test]
    fn a_refusal_from_the_server_stops_libgit2_and_is_a_rejection_with_the_servers_reason() {
        let tip = Oid::from_str("0123456789abcdef0123456789abcdef01234567").unwrap();
        let hooks = Hooks::new("refs/heads/main", tip, None);
        assert!(hooks.on_status("refs/heads/main", None).is_ok());
        assert!(hooks.report.borrow().rejected.is_empty());

        // An error from the callback is what keeps libgit2 from updating any tracking ref.
        let stop = hooks
            .on_status("refs/heads/main", Some("pre-receive hook declined"))
            .unwrap_err();
        assert_eq!(stop.code(), ErrorCode::User);
        let report = hooks.report.borrow();
        assert_eq!(
            report.rejected,
            vec![(
                "refs/heads/main".to_string(),
                "pre-receive hook declined".to_string()
            )]
        );
        let err = outcome(
            &report,
            Err(NsitError::Git(stop)),
            "refs/heads/main",
            &target(),
        )
        .unwrap_err();
        assert!(matches!(err, NsitError::Rejected(_)), "{err:?}");
        assert_eq!(
            err.to_string(),
            "refs/heads/main: pre-receive hook declined"
        );
        assert_eq!(err.exit_code(), 6);
    }

    #[test]
    fn the_servers_words_are_one_line_without_control_characters() {
        let report = Report {
            rejected: vec![(
                "refs/heads/main".into(),
                "declined\n  by \u{1b}[31mpolicy\u{7}\r\n".into(),
            )],
            ..Report::default()
        };
        let err = outcome(&report, Ok(()), "refs/heads/main", &target()).unwrap_err();
        assert_eq!(err.to_string(), "refs/heads/main: declined by [31mpolicy");
        // A server-side refusal of a non-fast-forward reads like the client's own.
        let report = Report {
            rejected: vec![(
                "refs/heads/main".into(),
                "denying non-fast-forward refs/heads/main (you should pull first)".into(),
            )],
            ..Report::default()
        };
        let err = outcome(&report, Ok(()), "refs/heads/main", &target()).unwrap_err();
        assert!(matches!(err, NsitError::NeedsPull(_)), "{err:?}");
        assert_eq!(
            err.to_string(),
            "refs/heads/main: non-fast-forward; run nsit pull"
        );
    }

    // ---- judging what happened -----------------------------------------------------------------

    fn oid(n: u8) -> Oid {
        Oid::from_bytes(&[n; 20]).unwrap()
    }

    #[test]
    fn the_verdict_before_anything_is_uploaded() {
        let (a, b) = (oid(1), oid(2));
        // No lease: send unless the server has it already.
        assert_eq!(verdict(None, a, None), Verdict::Send);
        assert_eq!(verdict(Some(b), a, None), Verdict::Send);
        assert_eq!(verdict(Some(a), a, None), Verdict::UpToDate);
        // A lease: the server must be where it was seen (or have no branch, if none was seen).
        assert_eq!(verdict(Some(b), a, Some(Some(b))), Verdict::Send);
        assert_eq!(verdict(None, a, Some(None)), Verdict::Send);
        assert_eq!(verdict(Some(b), a, Some(Some(oid(3)))), Verdict::Stale);
        assert_eq!(verdict(Some(b), a, Some(None)), Verdict::Stale);
        assert_eq!(verdict(None, a, Some(Some(b))), Verdict::Stale);
        // Already there is up to date whatever the lease says: there is nothing to replace.
        assert_eq!(verdict(Some(a), a, Some(Some(b))), Verdict::UpToDate);
    }

    #[test]
    fn what_the_hooks_saw_decides_the_outcome_before_the_error_that_stopped_libgit2() {
        let stopped = || Err(NsitError::Git(cancelled("stopped by nsit")));
        let stale = Report {
            stale: true,
            ..Report::default()
        };
        let err = outcome(&stale, stopped(), "refs/heads/main", &target()).unwrap_err();
        assert!(matches!(err, NsitError::NeedsPull(_)), "{err:?}");
        assert!(err.to_string().contains("stale info"), "{err}");

        let up_to_date = Report {
            up_to_date: true,
            ..Report::default()
        };
        assert_eq!(
            outcome(&up_to_date, stopped(), "refs/heads/main", &target()).unwrap(),
            Outcome::UpToDate
        );
        assert_eq!(
            outcome(&Report::default(), Ok(()), "refs/heads/main", &target()).unwrap(),
            Outcome::Sent
        );
        // Anything else that went wrong is mapped as a push error.
        let net = Err(NsitError::Git(git2::Error::new(
            ErrorCode::GenericError,
            ErrorClass::Net,
            "connection refused",
        )));
        let err = outcome(&Report::default(), net, "refs/heads/main", &target()).unwrap_err();
        assert_eq!(err.exit_code(), 1);
        let auth = Err(NsitError::Auth("authentication failed".into()));
        let err = outcome(&Report::default(), auth, "refs/heads/main", &target()).unwrap_err();
        assert_eq!(err.exit_code(), 3);
    }

    // ---- turning errors into what nsit says ----------------------------------------------------

    fn http(message: &str) -> NsitError {
        NsitError::Git(git2::Error::new(
            ErrorCode::GenericError,
            ErrorClass::Http,
            message,
        ))
    }

    #[test]
    fn a_non_fast_forward_error_from_libgit2_is_a_rejection() {
        for message in [
            "cannot push non-fastforwardable reference",
            "cannot push because a reference that you are trying to update on the remote contains commits that are not present locally.",
        ] {
            let err = push_error(
                NsitError::Git(git2::Error::new(
                    ErrorCode::NotFastForward,
                    ErrorClass::Reference,
                    message,
                )),
                &target(),
                "refs/heads/main",
            );
            assert!(matches!(err, NsitError::NeedsPull(_)), "{err:?}");
            assert_eq!(
                err.to_string(),
                "refs/heads/main: non-fast-forward; run nsit pull"
            );
            assert_eq!(err.exit_code(), 6);
        }
    }

    #[test]
    fn http_403_is_a_permission_rejection_with_the_repository_named() {
        // libgit2 does not pass the server's text on; its own wording differs by transport
        // (its HTTP client, and WinHTTP on Windows).
        for message in [
            "unexpected http status code: 403",
            "request failed with status code: 403",
        ] {
            let err = push_error(http(message), &target(), "refs/heads/main");
            assert!(matches!(err, NsitError::Rejected(_)), "{message}: {err:?}");
            assert_eq!(err.exit_code(), 6);
            assert_eq!(
                err.to_string(),
                "permission denied: you do not have write access to ada/demo"
            );
            assert!(!err.to_string().contains('\n'));
        }
    }

    #[test]
    fn http_404_and_other_statuses_are_general_errors_in_one_line() {
        for message in [
            "unexpected http status code: 404",
            "request failed with status code: 404",
        ] {
            let err = push_error(http(message), &target(), "refs/heads/main");
            assert!(matches!(err, NsitError::Other(_)), "{err:?}");
            assert_eq!(err.exit_code(), 1);
            assert_eq!(err.to_string(), "repository not found or no access");
        }
        let err = push_error(
            http("unexpected http status code: 500"),
            &target(),
            "refs/heads/main",
        );
        assert_eq!(err.exit_code(), 1);
        assert_eq!(
            err.to_string(),
            "git.iam.bot answered the push with HTTP 500"
        );
    }

    #[test]
    fn network_failures_are_one_line_with_the_server_named_and_never_a_token() {
        for (class, message) in [
            (
                ErrorClass::Os,
                "failed to send request: connection refused\r\n",
            ),
            (
                ErrorClass::Net,
                "failed to connect to 127.0.0.1: Connection refused",
            ),
            (
                ErrorClass::Http,
                "an error\noccurred \u{1b}[31mduring the send",
            ),
            (ErrorClass::Ssl, "the SSL certificate is invalid"),
        ] {
            let err = push_error(
                NsitError::Git(git2::Error::new(ErrorCode::GenericError, class, message)),
                &target(),
                "refs/heads/main",
            );
            assert!(matches!(err, NsitError::Other(_)), "{err:?}");
            assert_eq!(err.exit_code(), 1);
            let text = err.to_string();
            assert!(text.starts_with("cannot reach git.iam.bot: "), "{text}");
            assert!(!text.contains('\n') && !text.contains('\u{1b}'), "{text:?}");
        }
        // A long message is cut.
        let long = "x".repeat(1000);
        let err = push_error(
            NsitError::Git(git2::Error::new(
                ErrorCode::GenericError,
                ErrorClass::Net,
                long.as_str(),
            )),
            &target(),
            "refs/heads/main",
        );
        assert!(err.to_string().chars().count() < 260, "{err}");
    }

    #[test]
    fn a_failure_the_server_reported_says_so_instead_of_cannot_reach() {
        // What libgit2 1.9.7 says when the server answered and said it failed: all class `Net`,
        // like a dropped connection (see `reported_by_server`).
        for message in [
            "unpacking the sent packfile failed on the remote",
            "remote error: access denied or repository not exported",
            "report-status: Error reported: out of space\n",
            "report-status: protocol error",
        ] {
            let err = push_error(
                NsitError::Git(git2::Error::new(
                    ErrorCode::GenericError,
                    ErrorClass::Net,
                    message,
                )),
                &target(),
                "refs/heads/main",
            );
            assert!(matches!(err, NsitError::Other(_)), "{err:?}");
            assert_eq!(err.exit_code(), 1, "still a general error");
            let text = err.to_string();
            assert_eq!(
                text,
                format!("git.iam.bot reported a problem: {}", message.trim_end()),
                "{message}"
            );
            assert!(!text.contains("cannot reach"), "{text}");
            assert!(!text.contains('\n'), "{text:?}");
        }
        // The same words from another class are not the server's report.
        let err = push_error(
            NsitError::Git(git2::Error::new(
                ErrorCode::GenericError,
                ErrorClass::Odb,
                "remote error: x",
            )),
            &target(),
            "refs/heads/main",
        );
        assert_eq!(err.to_string(), "remote error: x");
        // And a connection that broke is still the network's.
        let err = push_error(
            NsitError::Git(git2::Error::new(
                ErrorCode::GenericError,
                ErrorClass::Net,
                "could not read from remote repository",
            )),
            &target(),
            "refs/heads/main",
        );
        assert_eq!(
            err.to_string(),
            "cannot reach git.iam.bot: could not read from remote repository"
        );
    }

    // ---- libgit2's own words for a push the server could not unpack ---------------------------

    /// One pkt-line: four hex digits of its length (counting them), then the text.
    fn pkt(text: &str) -> String {
        format!("{:04x}{text}", text.len() + 4)
    }

    /// A server with no branches that takes any pack and answers the push with `report`, the
    /// report-status as pkt-lines. It does not offer side-band, so the report is not wrapped. It
    /// asks for no sign-in: the first request goes through.
    fn server_answering_a_push_with(report: String) -> StubServer {
        StubServer::start(move |seen| {
            let (kind, body) = if seen.request_line.starts_with("POST ") {
                ("result", report.clone())
            } else {
                let capabilities = "report-status delete-refs ofs-delta agent=stub";
                let head = format!("{} capabilities^{{}}\0{capabilities}\n", "0".repeat(40));
                (
                    "advertisement",
                    format!(
                        "{}0000{}0000",
                        pkt("# service=git-receive-pack\n"),
                        pkt(&head)
                    ),
                )
            };
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/x-git-receive-pack-{kind}\r\nCache-Control: no-cache\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
        })
    }

    /// A push of `main` (one commit) to `server`, through the real `push_branch` and libgit2's
    /// HTTP transport, with a stored token for it. A failed push moves no ref, which is checked here.
    fn push_to(server: &StubServer, dir: &Path) -> Result<Pushed, NsitError> {
        let host = server.host();
        store_token(&host, "ada", "ins_stored_token").unwrap();
        let mut config = Config::load().unwrap();
        config.hosts.insert(
            host_key_for(&host).unwrap(),
            host_entry_for("ada", None, None),
        );
        config.save().unwrap();

        let work = dir.join("work");
        std::fs::create_dir(&work).unwrap();
        let repo = local_repo(&work);
        commit_file(&repo, "a.txt", "a");
        let before = all_refs(&repo);
        let target = parse_repo_ref("ada/demo", "ada", &Url::parse(&host).unwrap()).unwrap();
        let result = push_branch(
            &repo,
            &target,
            &host,
            &out_with(false, false),
            "main",
            Mode::FastForward,
            false,
        );
        assert_eq!(all_refs(&repo), before, "a failed push moves no ref");
        result
    }

    /// The failure `reported_by_server` is for, from a real libgit2 push: the server's report says
    /// the pack could not be unpacked and gives no per-ref refusal (which would be a rejection
    /// instead), so libgit2 stops with its own words. If a libgit2 update rewords them, this is
    /// where it shows.
    #[test]
    fn a_pack_the_server_could_not_unpack_is_its_failure_and_not_a_connection_problem() {
        let dir = tempfile::tempdir().unwrap();
        let _env = isolated_env(dir.path());
        let report = format!(
            "{}{}0000",
            pkt("unpack index-pack abnormal exit\n"),
            pkt("ok refs/heads/main\n")
        );
        let server = server_answering_a_push_with(report);

        let err = push_to(&server, dir.path()).unwrap_err();
        assert!(matches!(err, NsitError::Other(_)), "{err:?}");
        assert_eq!(err.exit_code(), 1);
        assert_eq!(
            err.to_string(),
            format!(
                "{} reported a problem: unpacking the sent packfile failed on the remote",
                server.host_key()
            )
        );
        assert!(
            server
                .requests()
                .iter()
                .any(|r| r.request_line.starts_with("POST ")),
            "the pack was sent: {:?}",
            server.requests()
        );
    }

    /// The other side of it: the same server saying `ng` for the ref is a rejection (exit 6) with
    /// the server's reason, as before.
    #[test]
    fn the_same_failure_with_a_per_ref_refusal_stays_a_rejection() {
        let dir = tempfile::tempdir().unwrap();
        let _env = isolated_env(dir.path());
        let report = format!(
            "{}{}0000",
            pkt("unpack index-pack abnormal exit\n"),
            pkt("ng refs/heads/main unpacker error\n")
        );
        let server = server_answering_a_push_with(report);

        let err = push_to(&server, dir.path()).unwrap_err();
        assert!(matches!(err, NsitError::Rejected(_)), "{err:?}");
        assert_eq!(err.exit_code(), 6);
        assert_eq!(err.to_string(), "refs/heads/main: unpacker error");
    }

    #[test]
    fn nsits_own_refusal_to_send_the_token_is_not_called_a_network_failure() {
        // The credential provider's refusals are class `Http` with code `User`.
        for message in [
            "refusing to send your token to a host other than git.iam.bot",
            "the server asked for a kind of sign-in that nsit does not support",
        ] {
            let err = push_error(
                NsitError::Git(git2::Error::new(ErrorCode::User, ErrorClass::Http, message)),
                &target(),
                "refs/heads/main",
            );
            assert!(matches!(err, NsitError::Other(_)), "{err:?}");
            assert_eq!(err.exit_code(), 1);
            assert_eq!(err.to_string(), message);
        }
    }

    #[test]
    fn other_errors_keep_their_meaning() {
        // A local failure is not a network one.
        let err = push_error(
            NsitError::Git(git2::Error::new(
                ErrorCode::GenericError,
                ErrorClass::Odb,
                "object not found\n(abc)",
            )),
            &target(),
            "refs/heads/main",
        );
        assert_eq!(err.exit_code(), 1);
        assert_eq!(err.to_string(), "object not found (abc)");
        // A refused login, and errors that are not libgit2's, pass through.
        let auth = push_error(
            NsitError::Auth("authentication failed".into()),
            &target(),
            "refs/heads/main",
        );
        assert_eq!(auth.exit_code(), 3);
        let usage = push_error(NsitError::Usage("bad".into()), &target(), "refs/heads/main");
        assert_eq!(usage.exit_code(), 2);
    }

    #[test]
    fn the_http_status_is_read_from_both_wordings_and_only_from_http_errors() {
        let with = |class, message: &str| {
            http_status(&git2::Error::new(ErrorCode::GenericError, class, message))
        };
        assert_eq!(
            with(ErrorClass::Http, "unexpected http status code: 403"),
            Some(403)
        );
        assert_eq!(
            with(ErrorClass::Http, "request failed with status code: 404"),
            Some(404)
        );
        assert_eq!(
            with(
                ErrorClass::Http,
                "request failed with status code: 502 (bad)"
            ),
            Some(502)
        );
        assert_eq!(with(ErrorClass::Http, "unexpected redirect"), None);
        assert_eq!(with(ErrorClass::Http, "status code: abc"), None);
        assert_eq!(with(ErrorClass::Http, "status code: "), None);
        // Another class that happens to say it is not an HTTP answer.
        assert_eq!(with(ErrorClass::Net, "status code: 403"), None);
    }

    // ---- the refspec ---------------------------------------------------------------------------

    #[test]
    fn the_refspec_names_the_same_branch_on_both_sides_and_forces_only_on_request() {
        assert_eq!(
            refspec("refs/heads/main", false),
            "refs/heads/main:refs/heads/main"
        );
        assert_eq!(
            refspec("refs/heads/release/1.0", true),
            "+refs/heads/release/1.0:refs/heads/release/1.0"
        );
    }

    #[test]
    fn a_branch_that_is_not_there_is_a_usage_error_not_a_git_error() {
        let dir = tempfile::tempdir().unwrap();
        let (server_path, _server) = server_at(dir.path());
        let repo = work_repo(dir.path(), "work", &server_path);
        commit_file(&repo, "a.txt", "a");
        let err = push_local(&repo, &server_path, "nope", Mode::FastForward).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert_eq!(err.to_string(), "there is no branch named nope");
    }
}
