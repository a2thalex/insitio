//! Bringing a branch up to date with its upstream with libgit2: `nsit pull`, and what it does to
//! the repository on every path. (`orig_head` is the `ORIG_HEAD` it writes and restores; `abort`
//! undoes a merge that stopped on conflicts.)
//!
//! The steps, in the order that makes a refusal leave nothing behind:
//!
//! 1. **Fetch** the upstream branch inside `run_remote` (the token for that repository's server,
//!    no redirect to another host, a refused login as exit 3). The refspec has **no destination
//!    ref**: the objects come and `FETCH_HEAD` names the commit, and no ref changes. The
//!    remote-tracking ref (`refs/remotes/origin/main`, whatever the remote's refspec says) is
//!    written only at the very end, by a pull that went through (up to date, fast-forward, merge
//!    commit, or a merge that stopped on a conflict). A pull that is refused leaves every ref as
//!    it was: the same rule `push` follows.
//! 2. **Analyse** (`merge_analysis`): up to date, fast-forward, or a real merge.
//! 3. **`ORIG_HEAD`** is written (the commit `HEAD` was at) before anything is moved, and put back
//!    if the pull fails (see `orig_head` for why nsit does not leave this to libgit2).
//! 4. **Fast-forward**: a *safe* checkout of their tree (an uncommitted change it would overwrite
//!    stops it, with nothing written, and the files are named), then the branch moves. Edits to
//!    files the pull does not touch are carried along, as git does.
//! 5. **Merge**: `Repository::merge` with a safe checkout that writes conflict markers
//!    (`<<<<<<< HEAD` ... `>>>>>>> origin/main`). If the index has conflicts the merge is **left in
//!    progress** (`MERGE_HEAD`, `MERGE_MSG`, `MERGE_MODE`, `ORIG_HEAD`, the unmerged index entries)
//!    exactly as real git leaves it, and the caller reports exit 4. Otherwise the merge commit is
//!    made and the merge state cleared.
//!
//! **A merge needs the tracked files committed.** A merge is the one pull that can be abandoned
//! (`--abort`), and abandoning is `reset --hard`, which discards uncommitted changes to tracked
//! files. So a pull that has to merge refuses to start while any tracked file has uncommitted
//! changes (staged or not), naming them: whatever a tracked file differs in from where the merge
//! started was therefore done after the pull stopped, which is what lets `abort` tell work it
//! must not discard from the merge it is undoing. A fast-forward has no abort, so it only refuses
//! to overwrite what it would really overwrite.
//!
//! **Untracked and ignored files that are in the way are never overwritten**, by either kind of
//! pull: the checkouts start from `checkout::safe_options` (which tells libgit2 not to overwrite
//! ignored files, as it otherwise would when one is in the way of an incoming one; `nsit switch`
//! shares the fast-forward's `checkout::checkout_safely`), a file that is in the way is refused by
//! name before anything changes, and files that are not in the way are not touched.
//!
//! **The secret guard does not run on the merge commit `pull` makes.** That commit is made here,
//! not through `commit::commit_changes`: everything in it comes from its two parents, which are
//! commits already, so there is no content of the user's own for the guard to judge; and judging
//! it anyway (against `HEAD` or against the merged-in branch) would refuse a pull because of a
//! file that was committed earlier, on either side. The guard still applies, with its
//! `MERGE_HEAD` rule, to what the user adds while finishing a merge that stopped on a conflict
//! (`nsit commit`). Nor can a secret slip in unchecked through a *staged* file: a new `.env` that
//! is staged is an uncommitted change, and a pull that has to merge refuses to start over it.

use std::path::Path;

use git2::build::CheckoutBuilder;
use git2::{
    AnnotatedCommit, AutotagOption, Commit, ErrorCode, FetchOptions, MergeAnalysis, MergeOptions,
    ObjectType, Oid, Repository, Signature, StatusOptions,
};

use super::auth::run_remote;
use super::checkout::{checkout_safely, safe_options};
use super::orig_head::OrigHead;
use super::paths::{display, listed};
use super::push::{http_status, plain_failure};
use super::stage::{conflicted_paths, head_commit};
use super::upstream::Upstream;
use crate::error::{one_line, NsitError};
use crate::output::Out;
use crate::repo_ref::RepoRef;

/// The commit being pulled in, and how to describe it.
pub struct Theirs<'a> {
    pub id: Oid,
    /// The branch on the remote (`main`): named in the merge commit's message.
    pub branch: &'a str,
    /// What to call it for people (`origin/main`): the label in conflict markers, and what the
    /// summary says was merged.
    pub label: &'a str,
    /// The repository's URL, as the merge commit's message says (never with credentials).
    pub url: &'a str,
}

/// What a pull did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pulled {
    /// Nothing to bring in. `head` is where the branch is.
    UpToDate { head: Oid },
    /// The branch moved to `head`.
    FastForward { branch: String, head: Oid },
    /// A merge commit was made: `head` is it.
    Merged { label: String, head: Oid },
    /// The merge stopped on `paths`, and is in progress. `head` is the branch, unmoved.
    Conflict { head: Oid, paths: Vec<String> },
}

impl Pulled {
    /// Where `HEAD` is after the pull.
    pub fn head(&self) -> Oid {
        match self {
            Pulled::UpToDate { head }
            | Pulled::FastForward { head, .. }
            | Pulled::Merged { head, .. }
            | Pulled::Conflict { head, .. } => *head,
        }
    }
}

/// Pull the upstream `up` of the current branch `branch` into it: fetch from `target` (the
/// repository `up`'s remote is), then bring the fetched commit in. `who` says who a merge commit
/// is by; it is asked only when a merge is going to be made, and before anything is changed.
pub fn pull_branch(
    repo: &Repository,
    target: &RepoRef,
    selected_host: &str,
    out: &Out,
    branch: &str,
    up: &Upstream,
    who: impl FnOnce() -> Result<Signature<'static>, NsitError>,
) -> Result<Pulled, NsitError> {
    let url = target.clone_url.as_str();
    pull_via(
        repo,
        branch,
        up,
        url,
        |remote_branch| {
            run_remote(target, selected_host, out, |access| {
                fetch_head_of(repo, url, remote_branch, access.fetch_options())
            })
            .map_err(|err| fetch_error(err, target))
        },
        who,
        |warning| out.warn(warning),
    )
}

/// Everything about a pull except how the bytes travel: `fetch` brings the remote's branch (given
/// as its name on the remote) and returns the commit it is at, `None` when the server has no such
/// branch. The tracking ref is written last, and only if the pull went through; if even that
/// cannot be written the pull has taken effect all the same, so it is a `warn`ing, not an error.
fn pull_via(
    repo: &Repository,
    branch: &str,
    up: &Upstream,
    url: &str,
    fetch: impl FnOnce(&str) -> Result<Option<Oid>, NsitError>,
    who: impl FnOnce() -> Result<Signature<'static>, NsitError>,
    warn: impl FnOnce(&str),
) -> Result<Pulled, NsitError> {
    let remote_branch = up.branch().ok_or_else(|| {
        NsitError::Usage(format!(
            "the upstream of {} is {}, which is not a branch: nsit pull follows branches only",
            one_line(branch, 100),
            one_line(&up.merge, 100)
        ))
    })?;
    let id = fetch(remote_branch)?.ok_or_else(|| {
        NsitError::Other(format!(
            "the branch {} is not on the server (it is the upstream of {})",
            one_line(remote_branch, 100),
            one_line(branch, 100)
        ))
    })?;

    let tracking = tracking_ref(repo, branch, up, remote_branch);
    let label = tracking.strip_prefix("refs/remotes/").unwrap_or(&tracking);
    let theirs = Theirs {
        id,
        branch: remote_branch,
        label,
        url,
    };
    let pulled = integrate(repo, branch, &theirs, who)?;
    // Only a pull that went through records what it fetched. The pull has taken effect by now (the
    // files, the branch, a merge in progress), so a failure here must not be reported as one of
    // the pull: it only means `nsit status` may count ahead and behind from an older fetch until
    // the next pull.
    if let Err(e) = repo.reference(&tracking, id, true, "nsit pull") {
        warn(&format!(
            "warning: the pull went through, but {} could not be updated ({}); nsit status may \
             show out-of-date counts until the next pull",
            one_line(label, 100),
            one_line(e.message(), 100)
        ));
    }
    Ok(pulled)
}

/// Fetch `remote_branch` of the repository at `url` into this repository's object database and
/// return the commit it is at (`None`: the server does not have that branch). **No ref is
/// written**: the refspec has no destination, and the answer is read from `FETCH_HEAD`. Tags are
/// not fetched. `options` carry the credentials (see `run_remote`); a test passes plain ones.
pub fn fetch_head_of(
    repo: &Repository,
    url: &str,
    remote_branch: &str,
    mut options: FetchOptions<'_>,
) -> Result<Option<Oid>, git2::Error> {
    options.download_tags(AutotagOption::None);
    let wanted = format!("refs/heads/{remote_branch}");
    let mut remote = repo.remote_anonymous(url)?;
    remote.fetch(&[wanted.as_str()], Some(&mut options), Some("nsit pull"))?;

    let mut found = None;
    let read = repo.fetchhead_foreach(|name, _, id, _| {
        if name == wanted {
            found = Some(*id);
        }
        true
    });
    match read {
        Ok(()) => Ok(found),
        Err(e) if e.code() == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// What a failed fetch should say: `push`'s wording for the failures they share. A refused login
/// is already exit 3 (`run_remote`).
fn fetch_error(err: NsitError, target: &RepoRef) -> NsitError {
    let NsitError::Git(git) = err else {
        return err;
    };
    match http_status(&git) {
        // Insitio answers 404 to an account that may not read a repository.
        Some(403 | 404) => NsitError::Other("repository not found or no access".into()),
        Some(code) => NsitError::Other(format!(
            "{} answered the fetch with HTTP {code}",
            target.host_key()
        )),
        None => plain_failure(&git, target),
    }
}

/// The remote-tracking ref for the upstream branch: the one the remote's fetch refspec maps it to
/// (which is what `nsit status` counts ahead and behind against), else `refs/remotes/<remote>/<b>`.
/// Never anything outside `refs/remotes/`: a pull must not be able to write to a local branch.
fn tracking_ref(repo: &Repository, branch: &str, up: &Upstream, remote_branch: &str) -> String {
    repo.branch_upstream_name(&format!("refs/heads/{branch}"))
        .ok()
        .and_then(|name| name.as_str().ok().map(str::to_string))
        .filter(|name| name.starts_with("refs/remotes/"))
        .unwrap_or_else(|| format!("refs/remotes/{}/{}", up.remote, remote_branch))
}

// ---- bringing the fetched commit in ---------------------------------------------------------------

/// Bring `theirs` into `branch` (the branch `HEAD` is on): do nothing, fast-forward, or merge. See
/// the module documentation for what each does and what a refusal leaves behind.
pub fn integrate(
    repo: &Repository,
    branch: &str,
    theirs: &Theirs<'_>,
    who: impl FnOnce() -> Result<Signature<'static>, NsitError>,
) -> Result<Pulled, NsitError> {
    let head = head_commit(repo)?;
    let their_commit = repo.find_commit(theirs.id)?;
    // Made as a fetch would make it, so that libgit2 words the merge message "Merge branch 'main'
    // of <url>" as git does.
    let annotated = repo.annotated_commit_from_fetchhead(
        &format!("refs/heads/{}", theirs.branch),
        theirs.url,
        &theirs.id,
    )?;
    let (analysis, _preference) = repo.merge_analysis(&[&annotated])?;

    if analysis.contains(MergeAnalysis::ANALYSIS_UP_TO_DATE) {
        let head = head.map(|commit| commit.id()).ok_or_else(|| {
            NsitError::Other(
                "a branch with no commits cannot be up to date (this is a bug in nsit)".into(),
            )
        })?;
        return Ok(Pulled::UpToDate { head });
    }
    if analysis.contains(MergeAnalysis::ANALYSIS_FASTFORWARD) {
        return fast_forward(repo, branch, head.as_ref(), &their_commit);
    }
    let Some(head) = head.filter(|_| analysis.contains(MergeAnalysis::ANALYSIS_NORMAL)) else {
        return Err(NsitError::Other(format!(
            "there is nothing to merge from {}",
            one_line(theirs.label, 100)
        )));
    };
    merge(repo, branch, &head, &their_commit, &annotated, theirs, who)
}

/// Move `branch` to `their_commit`, which has `HEAD` (when there is one) in its history.
fn fast_forward(
    repo: &Repository,
    branch: &str,
    head: Option<&Commit<'_>>,
    their_commit: &Commit<'_>,
) -> Result<Pulled, NsitError> {
    let orig = head
        .map(|commit| OrigHead::set(repo, commit.id()))
        .transpose()?;
    // The files first (the branch's own commit is the baseline, so what was edited since stays
    // unless the pull changes it too), then the branch. The order cannot be the other way round:
    // once the branch has moved, the checkout would take the new commit as its baseline and see
    // nothing to do.
    //
    // **This is not transactional, in one corner.** The checkout writes the files and then
    // refuses nothing; if updating the branch ref fails after that (a leftover
    // `refs/heads/<b>.lock`, say), the working files and the index are at their commit while
    // `HEAD` is still at ours, and the error says why. Nothing is lost, and running the pull
    // again once the cause is gone completes it: the checkout finds files that already match
    // and the branch then moves. Undoing the checkout instead would need a forced checkout of
    // our commit, which would also throw away the unrelated uncommitted edits a fast-forward
    // carries, so it is not done. (A merge has no such corner: it rolls itself back.)
    let moved = checkout_safely(repo, their_commit, |files| overwrite_error(branch, files))
        .and_then(|()| {
            repo.reference(
                &format!("refs/heads/{branch}"),
                their_commit.id(),
                true,
                "pull: Fast-forward",
            )
            .map(drop)
            .map_err(NsitError::from)
        });
    if let Err(err) = moved {
        if let Some(orig) = orig {
            orig.restore();
        }
        return Err(err);
    }
    Ok(Pulled::FastForward {
        branch: branch.to_string(),
        head: their_commit.id(),
    })
}

/// "Pulling would overwrite ...", with the files named (or without them, when nothing says which).
fn overwrite_error(branch: &str, files: &[String]) -> NsitError {
    let branch = one_line(branch, 100);
    NsitError::Other(if files.is_empty() {
        format!(
            "cannot pull into {branch}: it would overwrite local changes; commit or move them first"
        )
    } else {
        format!(
            "cannot pull into {branch}: it would overwrite local changes in {}; commit or move \
             them first",
            listed(files)
        )
    })
}

/// Merge `their_commit` into `head`: see the module documentation.
fn merge(
    repo: &Repository,
    branch: &str,
    head: &Commit<'_>,
    their_commit: &Commit<'_>,
    annotated: &AnnotatedCommit<'_>,
    theirs: &Theirs<'_>,
    who: impl FnOnce() -> Result<Signature<'static>, NsitError>,
) -> Result<Pulled, NsitError> {
    // Two histories with nothing in common are not merged by accident, as git does not either.
    match repo.merge_base(head.id(), their_commit.id()) {
        Ok(_) => {}
        Err(e) if e.code() == ErrorCode::NotFound => {
            return Err(NsitError::Other(format!(
                "refusing to merge unrelated histories: {} and {} have no commit in common",
                one_line(branch, 100),
                one_line(theirs.label, 100)
            )));
        }
        Err(e) => return Err(e.into()),
    }
    // Everything that can refuse comes before anything is changed.
    let who = who()?;
    let uncommitted = tracked_changes(repo)?;
    if !uncommitted.is_empty() {
        return Err(NsitError::Other(format!(
            "cannot merge {}: uncommitted changes in {}; commit them first, so that nothing of \
             yours is at risk if the merge has to be undone with nsit pull --abort",
            one_line(theirs.label, 100),
            listed(&uncommitted)
        )));
    }

    let orig = OrigHead::set(repo, head.id())?;
    // A safe checkout that writes `<<<<<<<` markers for what both sides changed. Deliberately not
    // `allow_conflicts`: that flag only changes what the checkout does with a file whose working
    // copy is in the way (libgit2's checkout.c skips it and carries on, instead of failing with
    // nothing written). Merge conflicts and their markers need no such permission, as the
    // conflict test shows, so a file in the way fails the whole merge before anything is written.
    // An ignored file in the way is not overwritten either (`overwrite_ignored(false)`; libgit2's
    // own pre-check of the merge looks at untracked files but not at ignored ones).
    let mut checkout = safe_options();
    checkout
        .conflict_style_merge(true)
        .their_label(theirs.label);
    let mut options = MergeOptions::new();
    if let Err(err) = repo.merge(&[annotated], Some(&mut options), Some(&mut checkout)) {
        // libgit2 removed the merge state it had made; ORIG_HEAD it rewrote anyway.
        orig.restore();
        return Err(merge_refusal(repo, their_commit, branch, err));
    }

    let mut index = repo.index()?;
    index.read(true)?;
    if index.has_conflicts() {
        let paths = conflicted_paths(&index)?
            .iter()
            .map(|path| display(path))
            .collect();
        return Ok(Pulled::Conflict {
            head: head.id(),
            paths,
        });
    }

    let committed = (|| -> Result<Oid, NsitError> {
        let tree = repo.find_tree(index.write_tree()?)?;
        let message = format!("Merge branch '{}' of {}\n", theirs.branch, theirs.url);
        Ok(repo.commit(
            Some("HEAD"),
            &who,
            &who,
            &message,
            &tree,
            &[head, their_commit],
        )?)
    })();
    let merged = match committed {
        Ok(id) => id,
        Err(err) => {
            // No commit: the merge is undone, so the pull leaves nothing behind.
            return Err(match roll_back(repo, head) {
                Ok(()) => {
                    orig.restore();
                    err
                }
                Err(e) => NsitError::Other(format!(
                    "{err}; and the merge could not be undone ({}): run nsit pull --abort",
                    one_line(e.message(), 100)
                )),
            });
        }
    };
    repo.cleanup_state()?;
    Ok(Pulled::Merged {
        label: theirs.label.to_string(),
        head: merged,
    })
}

/// Why libgit2 would not start the merge. The one expected reason is a local file in the way
/// (tracked changes are refused before this, so it is an untracked or an ignored file).
fn merge_refusal(
    repo: &Repository,
    their_commit: &Commit<'_>,
    branch: &str,
    err: git2::Error,
) -> NsitError {
    if err.code() != ErrorCode::Conflict {
        return NsitError::Git(err);
    }
    let files = untracked_in_the_way(repo, their_commit).unwrap_or_default();
    overwrite_error(branch, &files)
}

/// The untracked **and ignored** files that `their_commit` has a file at, or has a file where
/// the local file has a directory: what a merge of it would have to overwrite. Ignored
/// directories are looked into file by file (`recurse_ignored_dirs`), or a file in an ignored
/// directory would be reported as the directory and never match. (This runs only once a merge has
/// been refused, so listing a large ignored directory costs nothing on the way that works.)
fn untracked_in_the_way(
    repo: &Repository,
    their_commit: &Commit<'_>,
) -> Result<Vec<String>, NsitError> {
    let tree = their_commit.tree()?;
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(true)
        .recurse_ignored_dirs(true)
        .exclude_submodules(true);
    let statuses = repo.statuses(Some(&mut options))?;
    let mut found = Vec::new();
    for entry in statuses.iter() {
        if !entry
            .status()
            .intersects(git2::Status::WT_NEW | git2::Status::IGNORED)
        {
            continue;
        }
        let path = display(entry.path_bytes());
        let blocked = Path::new(&path)
            .ancestors()
            .filter(|ancestor| !ancestor.as_os_str().is_empty())
            .any(|ancestor| match tree.get_path(ancestor) {
                Ok(there) => ancestor == Path::new(&path) || there.kind() != Some(ObjectType::Tree),
                Err(_) => false,
            });
        if blocked {
            found.push(path);
        }
    }
    found.sort();
    Ok(found)
}

/// The tracked files with uncommitted changes (staged, new in the index, edited or deleted),
/// sorted. Untracked and ignored files are not listed: a hard reset spares them, and one that is
/// in the way of the merge is refused separately (`untracked_in_the_way`).
fn tracked_changes(repo: &Repository) -> Result<Vec<String>, NsitError> {
    let mut options = StatusOptions::new();
    options
        .include_untracked(false)
        .include_ignored(false)
        .exclude_submodules(true);
    let statuses = repo.statuses(Some(&mut options))?;
    let mut paths: Vec<String> = statuses
        .iter()
        .filter(|entry| !entry.status().is_empty())
        .map(|entry| display(entry.path_bytes()))
        .collect();
    paths.sort();
    paths.dedup();
    Ok(paths)
}

/// Undo a merge that has been started and has no commit: the files and the index go back to
/// `head`'s tree, and the merge state is cleared. Safe because a merge starts only with no
/// uncommitted change to a tracked file. **No ref is touched** (`HEAD` never moved): a lock on the
/// branch is exactly what can make the commit fail, and a rollback that needed the same lock
/// would fail with it.
fn roll_back(repo: &Repository, head: &Commit<'_>) -> Result<(), git2::Error> {
    let tree = head.tree()?;
    repo.checkout_tree(tree.as_object(), Some(CheckoutBuilder::new().force()))?;
    let mut index = repo.index()?;
    index.read_tree(&tree)?;
    index.write()?;
    repo.cleanup_state()
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::path::Path;

    use git2::{ErrorCode, FetchOptions, RepositoryState};

    use super::*;
    use crate::config::Config;
    use crate::credentials::{host_key_for, store_token};
    use crate::repo_ref::parse_repo_ref;
    use crate::test_support::{
        all_refs, commit_file, diverged_with_conflict, diverged_without_conflict, fetch_main,
        files, head, host_entry_for, index_on_disk, isolated_env, local_repo, me, merge_state,
        no_changes, nobody, orig_head_text as orig_head, out_with, push_main, server_at, theirs,
        two_clones, work_repo, write_file, StubServer, REMOTE_URL as URL,
    };

    // ---- fetching ---------------------------------------------------------------------------------

    #[test]
    fn fetching_a_branch_leaves_every_ref_alone_and_names_the_commit_in_fetch_head() {
        let dir = tempfile::tempdir().unwrap();
        let (server, one, two) = two_clones(dir.path());
        commit_file(&one, "new.txt", "new\n");
        push_main(&one, &server);
        let before = all_refs(&two);

        let fetched = fetch_main(&two, &server);
        assert_eq!(fetched, head(&one));
        assert!(two.find_commit(fetched).is_ok(), "the objects came with it");
        assert_eq!(all_refs(&two), before, "no ref was written");
    }

    #[test]
    fn a_branch_the_server_does_not_have_comes_back_as_none() {
        let dir = tempfile::tempdir().unwrap();
        let (server, _one, two) = two_clones(dir.path());
        let before = all_refs(&two);
        let none = fetch_head_of(&two, server.to_str().unwrap(), "nope", FetchOptions::new());
        assert_eq!(none.unwrap(), None);
        assert_eq!(all_refs(&two), before);
    }

    // ---- nothing to do ----------------------------------------------------------------------------

    #[test]
    fn nothing_is_pulled_when_theirs_is_ours_or_behind_us() {
        let dir = tempfile::tempdir().unwrap();
        let (server, _one, two) = two_clones(dir.path());
        let tip = fetch_main(&two, &server);

        // Theirs is what we have.
        let before = all_refs(&two);
        let pulled = integrate(&two, "main", &theirs(tip), nobody).unwrap();
        assert_eq!(pulled, Pulled::UpToDate { head: tip });
        // Theirs is behind us: we are ahead, and there is nothing to bring in.
        commit_file(&two, "mine.txt", "mine\n");
        let ahead = head(&two);
        let before_ahead = all_refs(&two);
        let pulled = integrate(&two, "main", &theirs(tip), nobody).unwrap();
        assert_eq!(pulled, Pulled::UpToDate { head: ahead });
        assert_eq!(pulled.head(), ahead);

        assert_eq!(all_refs(&two).len(), before.len());
        assert_eq!(all_refs(&two), before_ahead);
        assert_eq!(
            orig_head(&two),
            None,
            "an up to date pull does not write ORIG_HEAD"
        );
        assert!(merge_state(&two).is_empty());
    }

    // ---- fast-forward -----------------------------------------------------------------------------

    #[test]
    fn a_fast_forward_moves_the_branch_and_the_files_and_writes_orig_head() {
        let dir = tempfile::tempdir().unwrap();
        let (server, one, two) = two_clones(dir.path());
        let before = head(&two);
        commit_file(&one, "new.txt", "new\n");
        commit_file(&one, "a.txt", "edited\n");
        push_main(&one, &server);
        let tip = fetch_main(&two, &server);

        let pulled = integrate(&two, "main", &theirs(tip), nobody).unwrap();
        assert_eq!(
            pulled,
            Pulled::FastForward {
                branch: "main".into(),
                head: tip
            }
        );
        assert_eq!(head(&two), tip);
        assert_eq!(
            two.find_reference("HEAD")
                .unwrap()
                .symbolic_target()
                .unwrap(),
            Some("refs/heads/main"),
            "HEAD is still on the branch"
        );
        let files = files(&two);
        assert_eq!(files["new.txt"], "new\n");
        assert_eq!(files["a.txt"], "edited\n");
        assert_eq!(orig_head(&two), Some(format!("{before}\n")));
        assert!(no_changes(&two), "the index and files match the new HEAD");
        assert!(merge_state(&two).is_empty());
        assert_eq!(two.state(), RepositoryState::Clean);
    }

    #[test]
    fn a_fast_forward_creates_a_branch_that_has_no_commits_yet() {
        let dir = tempfile::tempdir().unwrap();
        let server = server_at(dir.path());
        let one = work_repo(dir.path(), "one", &server);
        commit_file(&one, "a.txt", "a\n");
        push_main(&one, &server);
        let two = work_repo(dir.path(), "two", &server);
        let tip = fetch_main(&two, &server);

        let pulled = integrate(&two, "main", &theirs(tip), nobody).unwrap();
        assert_eq!(
            pulled,
            Pulled::FastForward {
                branch: "main".into(),
                head: tip
            }
        );
        assert_eq!(head(&two), tip);
        assert_eq!(files(&two)["a.txt"], "a\n");
        assert_eq!(orig_head(&two), None, "there was no commit to remember");
        assert!(no_changes(&two));
    }

    #[test]
    fn a_fast_forward_carries_changes_it_does_not_touch() {
        let dir = tempfile::tempdir().unwrap();
        let (server, one, two) = two_clones(dir.path());
        commit_file(&one, "a.txt", "from one\n");
        push_main(&one, &server);
        let tip = fetch_main(&two, &server);
        // An edit that is not committed, in a file the pull does not change.
        write_file(&two, "keep.txt", "my edit\n");

        let pulled = integrate(&two, "main", &theirs(tip), nobody).unwrap();
        assert!(matches!(pulled, Pulled::FastForward { .. }), "{pulled:?}");
        let files = files(&two);
        assert_eq!(files["a.txt"], "from one\n");
        assert_eq!(files["keep.txt"], "my edit\n");
    }

    #[test]
    fn a_fast_forward_that_would_overwrite_uncommitted_work_changes_nothing_and_names_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let (server, one, two) = two_clones(dir.path());
        commit_file(&one, "a.txt", "from one\n");
        commit_file(&one, "new.txt", "from one\n");
        push_main(&one, &server);
        let tip = fetch_main(&two, &server);
        write_file(&two, "a.txt", "my work\n");
        write_file(&two, "new.txt", "mine, untracked\n");
        // An ORIG_HEAD from some earlier operation must survive a pull that did not happen.
        std::fs::write(two.path().join("ORIG_HEAD"), "an earlier value\n").unwrap();
        let (refs, files, index) = (all_refs(&two), files(&two), index_on_disk(&two));

        let err = integrate(&two, "main", &theirs(tip), nobody).unwrap_err();
        assert!(matches!(err, NsitError::Other(_)), "{err:?}");
        assert_eq!(err.exit_code(), 1);
        let text = err.to_string();
        assert!(text.contains("a.txt") && text.contains("new.txt"), "{text}");
        assert!(!text.contains('\n'), "{text:?}");
        assert_eq!(all_refs(&two), refs);
        assert_eq!(self::files(&two), files);
        assert_eq!(index_on_disk(&two), index);
        assert_eq!(orig_head(&two), Some("an earlier value\n".to_string()));
    }

    // ---- merge ------------------------------------------------------------------------------------

    #[test]
    fn a_merge_of_changes_to_different_files_makes_a_commit_with_two_parents() {
        let dir = tempfile::tempdir().unwrap();
        let (server, one, two) = diverged_without_conflict(dir.path());
        let their_tip = head(&one);
        let ours = head(&two);
        let tip = fetch_main(&two, &server);
        assert_eq!(tip, their_tip);
        let calls = Cell::new(0);

        let pulled = integrate(&two, "main", &theirs(tip), || {
            calls.set(calls.get() + 1);
            me()
        })
        .unwrap();
        assert_eq!(calls.get(), 1);
        let merged = head(&two);
        assert_eq!(
            pulled,
            Pulled::Merged {
                label: "origin/main".into(),
                head: merged
            }
        );
        let commit = two.find_commit(merged).unwrap();
        let parents: Vec<Oid> = commit.parent_ids().collect();
        assert_eq!(parents, [ours, tip]);
        assert_eq!(
            commit.message().unwrap(),
            "Merge branch 'main' of https://git.iam.bot/ada/demo.git\n"
        );
        assert_eq!(commit.author().name().unwrap(), "Puller");
        assert_eq!(commit.committer().email().unwrap(), "puller@example.com");
        let files = files(&two);
        assert_eq!(files["a.txt"], "from one\n");
        assert_eq!(files["keep.txt"], "from two\n");
        assert_eq!(orig_head(&two), Some(format!("{ours}\n")));
        assert!(merge_state(&two).is_empty());
        assert_eq!(two.state(), RepositoryState::Clean);
        assert!(
            no_changes(&two),
            "the index and files match the merge commit"
        );
    }

    #[test]
    fn the_merge_message_names_the_branch_on_the_remote() {
        let dir = tempfile::tempdir().unwrap();
        let (server, _one, two) = diverged_without_conflict(dir.path());
        let tip = fetch_main(&two, &server);
        let other = Theirs {
            branch: "release/1.0",
            ..theirs(tip)
        };
        integrate(&two, "main", &other, me).unwrap();
        assert_eq!(
            two.find_commit(head(&two)).unwrap().message().unwrap(),
            "Merge branch 'release/1.0' of https://git.iam.bot/ada/demo.git\n"
        );
    }

    #[test]
    fn a_conflict_leaves_the_merge_in_progress_for_real_git_to_see() {
        let dir = tempfile::tempdir().unwrap();
        let (server, _one, two) = diverged_with_conflict(dir.path());
        let ours = head(&two);
        let tip = fetch_main(&two, &server);

        let pulled = integrate(&two, "main", &theirs(tip), me).unwrap();
        assert_eq!(
            pulled,
            Pulled::Conflict {
                head: ours,
                paths: vec!["a.txt".to_string()]
            }
        );
        assert_eq!(head(&two), ours, "no commit was made");
        assert_eq!(two.state(), RepositoryState::Merge);
        assert_eq!(
            std::fs::read_to_string(two.path().join("MERGE_HEAD")).unwrap(),
            format!("{tip}\n")
        );
        assert_eq!(orig_head(&two), Some(format!("{ours}\n")));
        let message = std::fs::read_to_string(two.path().join("MERGE_MSG")).unwrap();
        assert!(
            message.starts_with("Merge branch 'main' of https://git.iam.bot/ada/demo.git\n"),
            "{message}"
        );
        assert_eq!(
            files(&two)["a.txt"],
            "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main\n"
        );
        // What merged cleanly is in, and staged; the conflicted file is unmerged in the index.
        assert_eq!(files(&two)["added.txt"], "added by them\n");
        let index = index_on_disk(&two);
        assert!(index
            .iter()
            .any(|(path, stage, _)| path == "added.txt" && *stage == 0));
        assert!(index
            .iter()
            .any(|(path, stage, _)| path == "a.txt" && *stage != 0));
        assert!(two.index().unwrap().has_conflicts());
    }

    #[test]
    fn without_a_name_to_commit_as_a_merge_does_not_start() {
        let dir = tempfile::tempdir().unwrap();
        let (server, _one, two) = diverged_with_conflict(dir.path());
        let tip = fetch_main(&two, &server);
        let (refs, files, index) = (all_refs(&two), files(&two), index_on_disk(&two));

        let err = integrate(&two, "main", &theirs(tip), || {
            Err(NsitError::Usage("set your name and email".into()))
        })
        .unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert_eq!(all_refs(&two), refs);
        assert_eq!(self::files(&two), files);
        assert_eq!(index_on_disk(&two), index);
        assert!(merge_state(&two).is_empty());
        assert_eq!(orig_head(&two), None);
    }

    #[test]
    fn a_merge_needs_the_tracked_files_committed_and_names_the_ones_that_are_not() {
        for case in ["edited", "staged", "deleted"] {
            let dir = tempfile::tempdir().unwrap();
            let (server, _one, two) = diverged_without_conflict(dir.path());
            let tip = fetch_main(&two, &server);
            // A tracked file that has nothing to do with what is being pulled.
            commit_file(&two, "other.txt", "other\n");
            match case {
                "edited" => write_file(&two, "other.txt", "changed\n"),
                "staged" => {
                    write_file(&two, "other.txt", "changed\n");
                    let mut index = two.index().unwrap();
                    index.add_path(Path::new("other.txt")).unwrap();
                    index.write().unwrap();
                }
                _ => std::fs::remove_file(two.workdir().unwrap().join("other.txt")).unwrap(),
            }
            // Untracked files are not in anyone's way.
            write_file(&two, "scratch.txt", "untracked\n");
            let (refs, files, index) = (all_refs(&two), files(&two), index_on_disk(&two));

            let err = integrate(&two, "main", &theirs(tip), me).unwrap_err();
            assert!(matches!(err, NsitError::Other(_)), "{case}: {err:?}");
            assert_eq!(err.exit_code(), 1);
            let text = err.to_string();
            assert!(text.contains("other.txt"), "{case}: {text}");
            assert!(!text.contains("scratch.txt"), "{case}: {text}");
            assert!(text.contains("commit"), "{case}: {text}");
            assert!(!text.contains('\n'), "{text:?}");
            assert_eq!(all_refs(&two), refs, "{case}");
            assert_eq!(self::files(&two), files, "{case}");
            assert_eq!(index_on_disk(&two), index, "{case}");
            assert!(merge_state(&two).is_empty(), "{case}");
            assert_eq!(orig_head(&two), None, "{case}");
        }
    }

    #[test]
    fn untracked_files_that_are_not_in_the_way_are_left_alone_by_a_merge() {
        let dir = tempfile::tempdir().unwrap();
        let (server, _one, two) = diverged_without_conflict(dir.path());
        let tip = fetch_main(&two, &server);
        write_file(&two, "scratch.txt", "untracked\n");
        write_file(&two, "deep/er/more.txt", "untracked too\n");
        integrate(&two, "main", &theirs(tip), me).unwrap();
        let files = files(&two);
        assert_eq!(files["scratch.txt"], "untracked\n");
        assert_eq!(files["deep/er/more.txt"], "untracked too\n");
    }

    #[test]
    fn an_untracked_file_where_the_merge_writes_one_is_refused_and_named() {
        let dir = tempfile::tempdir().unwrap();
        let (server, one, two) = two_clones(dir.path());
        commit_file(&one, "new.txt", "from one\n");
        push_main(&one, &server);
        commit_file(&two, "keep.txt", "from two\n");
        let tip = fetch_main(&two, &server);
        write_file(&two, "new.txt", "mine, untracked\n");
        let (refs, files, index) = (all_refs(&two), files(&two), index_on_disk(&two));

        let err = integrate(&two, "main", &theirs(tip), me).unwrap_err();
        assert!(matches!(err, NsitError::Other(_)), "{err:?}");
        assert!(err.to_string().contains("new.txt"), "{err}");
        assert!(!err.to_string().contains('\n'), "{err}");
        assert_eq!(all_refs(&two), refs);
        assert_eq!(self::files(&two), files);
        assert_eq!(index_on_disk(&two), index);
        assert!(
            merge_state(&two).is_empty(),
            "libgit2 cleans its own state up"
        );
        assert_eq!(orig_head(&two), None, "and ORIG_HEAD is as it was");
    }

    /// An ignored local file at the path of an incoming tracked one: libgit2 would overwrite it
    /// (its checkout does unless told not to, and its pre-check of a merge does not look at ignored
    /// files). Nothing of the user's is overwritten, ignored or not: refused by name, nothing moved.
    #[test]
    fn an_ignored_file_where_the_pull_writes_one_is_refused_and_named_for_both_kinds_of_pull() {
        // Fast-forward: the ignored file is a top-level one, and one inside an ignored directory.
        let dir = tempfile::tempdir().unwrap();
        let (server, one, two) = two_clones(dir.path());
        commit_file(&one, "new.txt", "from one\n");
        write_file(&one, "build/out.txt", "from one\n"); // makes the directory
        commit_file(&one, "build/out.txt", "from one\n");
        push_main(&one, &server);
        let tip = fetch_main(&two, &server);
        write_file(&two, ".gitignore", "new.txt\nbuild/\n");
        write_file(&two, "new.txt", "mine, ignored\n");
        write_file(&two, "build/out.txt", "mine, ignored too\n");
        write_file(&two, "build/unrelated.txt", "ignored and not in the way\n");
        std::fs::write(two.path().join("ORIG_HEAD"), "an earlier value\n").unwrap();
        let (refs, files, index) = (all_refs(&two), files(&two), index_on_disk(&two));

        let err = integrate(&two, "main", &theirs(tip), nobody).unwrap_err();
        assert!(matches!(err, NsitError::Other(_)), "fast-forward: {err:?}");
        assert_eq!(err.exit_code(), 1);
        let text = err.to_string();
        assert!(text.contains("new.txt"), "fast-forward: {text}");
        assert!(text.contains("build/out.txt"), "fast-forward: {text}");
        assert!(!text.contains("unrelated.txt"), "fast-forward: {text}");
        assert!(!text.contains('\n'), "{text:?}");
        assert_eq!(all_refs(&two), refs);
        assert_eq!(self::files(&two), files, "no ignored file was touched");
        assert_eq!(index_on_disk(&two), index);
        assert_eq!(orig_head(&two), Some("an earlier value\n".to_string()));

        // Merge: the same two files, with the histories diverged.
        let dir = tempfile::tempdir().unwrap();
        let (server, one, two) = two_clones(dir.path());
        commit_file(&one, "new.txt", "from one\n");
        write_file(&one, "build/out.txt", "from one\n"); // makes the directory
        commit_file(&one, "build/out.txt", "from one\n");
        push_main(&one, &server);
        commit_file(&two, "keep.txt", "from two\n");
        let tip = fetch_main(&two, &server);
        write_file(&two, ".gitignore", "new.txt\nbuild/\n");
        write_file(&two, "new.txt", "mine, ignored\n");
        write_file(&two, "build/out.txt", "mine, ignored too\n");
        let (refs, files, index) = (all_refs(&two), self::files(&two), index_on_disk(&two));

        let err = integrate(&two, "main", &theirs(tip), me).unwrap_err();
        assert!(matches!(err, NsitError::Other(_)), "merge: {err:?}");
        let text = err.to_string();
        assert!(text.contains("new.txt"), "merge: {text}");
        assert!(text.contains("build/out.txt"), "merge: {text}");
        assert!(!text.contains('\n'), "{text:?}");
        assert_eq!(all_refs(&two), refs);
        assert_eq!(self::files(&two), files, "no ignored file was touched");
        assert_eq!(index_on_disk(&two), index);
        assert!(merge_state(&two).is_empty());
        assert_eq!(orig_head(&two), None);

        // Out of the way, the same pull goes through, and the ignored file that was never in the
        // way is still there.
        std::fs::remove_file(two.workdir().unwrap().join("new.txt")).unwrap();
        std::fs::remove_file(two.workdir().unwrap().join("build/out.txt")).unwrap();
        write_file(&two, "build/unrelated.txt", "ignored and not in the way\n");
        let pulled = integrate(&two, "main", &theirs(tip), me).unwrap();
        assert!(matches!(pulled, Pulled::Merged { .. }), "{pulled:?}");
        assert_eq!(self::files(&two)["new.txt"], "from one\n");
        assert_eq!(
            self::files(&two)["build/unrelated.txt"],
            "ignored and not in the way\n"
        );
    }

    /// The merge commit `pull` makes is not run through the secret guard, because it adds nothing
    /// that is not in its parents. That holds only while nothing uncommitted can end up in it: a
    /// new, staged `.env` is an uncommitted change, so the merge is refused before anything is
    /// committed.
    #[test]
    fn a_staged_new_file_stops_a_merge_before_anything_is_committed() {
        let dir = tempfile::tempdir().unwrap();
        let (server, _one, two) = diverged_without_conflict(dir.path());
        let tip = fetch_main(&two, &server);
        write_file(&two, ".env", "TOKEN=abc\n");
        let mut index = two.index().unwrap();
        index.add_path(Path::new(".env")).unwrap();
        index.write().unwrap();
        let ours = head(&two);
        let (refs, files, index) = (all_refs(&two), files(&two), index_on_disk(&two));
        assert!(
            index.iter().any(|(path, _, _)| path == ".env"),
            "it is staged"
        );

        let err = integrate(&two, "main", &theirs(tip), me).unwrap_err();
        assert!(matches!(err, NsitError::Other(_)), "{err:?}");
        assert_eq!(err.exit_code(), 1);
        assert!(err.to_string().contains(".env"), "{err}");
        assert_eq!(head(&two), ours, "nothing was committed");
        assert!(
            two.head()
                .unwrap()
                .peel_to_tree()
                .unwrap()
                .get_name(".env")
                .is_none(),
            "the secret is in no commit"
        );
        assert_eq!(all_refs(&two), refs);
        assert_eq!(self::files(&two), files);
        assert_eq!(index_on_disk(&two), index, "and still staged, as it was");
        assert!(merge_state(&two).is_empty());
        assert_eq!(orig_head(&two), None);
    }

    #[test]
    fn a_merge_commit_that_cannot_be_made_is_rolled_back_completely() {
        let dir = tempfile::tempdir().unwrap();
        let (server, _one, two) = diverged_without_conflict(dir.path());
        let tip = fetch_main(&two, &server);
        std::fs::write(two.path().join("ORIG_HEAD"), "an earlier value\n").unwrap();
        let (refs, files, index) = (all_refs(&two), files(&two), index_on_disk(&two));
        // A leftover lock on the branch: the merge itself works, moving the branch does not.
        let lock = two.path().join("refs").join("heads").join("main.lock");
        std::fs::write(&lock, "").unwrap();

        let err = integrate(&two, "main", &theirs(tip), me).unwrap_err();
        assert!(matches!(err, NsitError::Git(_)), "{err:?}");
        assert_eq!(err.exit_code(), 1);
        std::fs::remove_file(&lock).unwrap();
        assert_eq!(all_refs(&two), refs);
        assert_eq!(
            self::files(&two),
            files,
            "what the merge wrote is gone again"
        );
        assert_eq!(index_on_disk(&two), index);
        assert!(merge_state(&two).is_empty());
        assert_eq!(two.state(), RepositoryState::Clean);
        assert_eq!(orig_head(&two), Some("an earlier value\n".to_string()));
    }

    #[test]
    fn histories_that_have_nothing_in_common_are_not_merged() {
        let dir = tempfile::tempdir().unwrap();
        let (_server, _one, two) = two_clones(dir.path());
        // A second server whose main starts from a different first commit.
        let elsewhere = dir.path().join("elsewhere.git");
        Repository::init_bare(&elsewhere).unwrap();
        let other = work_repo(dir.path(), "other", &elsewhere);
        commit_file(&other, "x.txt", "x\n");
        push_main(&other, &elsewhere);
        let tip = fetch_main(&two, &elsewhere);
        let (refs, files, index) = (all_refs(&two), files(&two), index_on_disk(&two));

        let err = integrate(&two, "main", &theirs(tip), me).unwrap_err();
        assert!(matches!(err, NsitError::Other(_)), "{err:?}");
        assert!(err.to_string().contains("unrelated"), "{err}");
        assert_eq!(all_refs(&two), refs);
        assert_eq!(self::files(&two), files);
        assert_eq!(index_on_disk(&two), index);
        assert!(merge_state(&two).is_empty());
        assert_eq!(orig_head(&two), None);
    }

    // ---- tracked changes --------------------------------------------------------------------------

    #[test]
    fn tracked_changes_are_staged_edited_and_deleted_files_not_untracked_or_ignored_ones() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write_file(&repo, ".gitignore", "*.log\n");
        commit_file(&repo, "edit.txt", "1\n");
        commit_file(&repo, "staged.txt", "1\n");
        commit_file(&repo, "gone.txt", "1\n");
        commit_file(&repo, "same.txt", "1\n");
        assert_eq!(tracked_changes(&repo).unwrap(), Vec::<String>::new());

        write_file(&repo, "edit.txt", "2\n");
        write_file(&repo, "staged.txt", "2\n");
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("staged.txt")).unwrap();
        index.write().unwrap();
        std::fs::remove_file(dir.path().join("gone.txt")).unwrap();
        write_file(&repo, "untracked.txt", "u\n");
        write_file(&repo, "ignored.log", "i\n");
        write_file(&repo, "new/deep/untracked.txt", "u\n");
        assert_eq!(
            tracked_changes(&repo).unwrap(),
            ["edit.txt", "gone.txt", "staged.txt"]
        );
    }

    // ---- which ref records the fetch ----------------------------------------------------------------

    fn up(remote: &str) -> Upstream {
        Upstream {
            remote: remote.into(),
            merge: "refs/heads/main".into(),
        }
    }

    #[test]
    fn the_tracking_ref_follows_the_remotes_refspec_and_is_never_a_branch() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        // Without a remote of that name: the usual place.
        assert_eq!(
            tracking_ref(&repo, "main", &up("origin"), "main"),
            "refs/remotes/origin/main"
        );
        // With one, what its fetch refspec says (this is what `nsit status` counts against).
        repo.remote_with_fetch(
            "mirror",
            "https://git.iam.bot/ada/demo.git",
            "+refs/heads/*:refs/remotes/elsewhere/*",
        )
        .unwrap();
        repo.config()
            .unwrap()
            .set_str("branch.main.remote", "mirror")
            .unwrap();
        repo.config()
            .unwrap()
            .set_str("branch.main.merge", "refs/heads/main")
            .unwrap();
        assert_eq!(
            tracking_ref(&repo, "main", &up("mirror"), "main"),
            "refs/remotes/elsewhere/main"
        );
        // A refspec that would land on a local branch must never be what a pull writes to.
        repo.remote_with_fetch(
            "odd",
            "https://git.iam.bot/ada/demo.git",
            "+refs/heads/*:refs/heads/*",
        )
        .unwrap();
        repo.config()
            .unwrap()
            .set_str("branch.main.remote", "odd")
            .unwrap();
        assert_eq!(
            tracking_ref(&repo, "main", &up("odd"), "main"),
            "refs/remotes/odd/main"
        );
    }

    // ---- pull_via: the order of things ----------------------------------------------------------------

    fn tracking(repo: &Repository) -> Option<Oid> {
        repo.refname_to_id("refs/remotes/origin/main").ok()
    }

    /// A pull from the server at `server`; any warning is a failure of the test.
    fn pull_local(
        repo: &Repository,
        server: &Path,
        who: impl FnOnce() -> Result<Signature<'static>, NsitError>,
    ) -> Result<Pulled, NsitError> {
        pull_local_warning(repo, server, who, |warning| {
            panic!("unexpected warning: {warning}")
        })
    }

    fn pull_local_warning(
        repo: &Repository,
        server: &Path,
        who: impl FnOnce() -> Result<Signature<'static>, NsitError>,
        warn: impl FnOnce(&str),
    ) -> Result<Pulled, NsitError> {
        pull_via(
            repo,
            "main",
            &up("origin"),
            URL,
            |branch| {
                fetch_head_of(repo, server.to_str().unwrap(), branch, FetchOptions::new())
                    .map_err(NsitError::Git)
            },
            who,
            warn,
        )
    }

    #[test]
    fn a_tracking_ref_that_cannot_be_written_is_a_warning_because_the_pull_took_effect() {
        let dir = tempfile::tempdir().unwrap();
        let (server, one, two) = two_clones(dir.path());
        commit_file(&one, "new.txt", "n\n");
        push_main(&one, &server);
        let before = head(&two);
        // A leftover lock on the tracking ref: the files and the branch move, the record cannot.
        let lock_dir = two.path().join("refs").join("remotes").join("origin");
        std::fs::create_dir_all(&lock_dir).unwrap();
        std::fs::write(lock_dir.join("main.lock"), "").unwrap();

        let warnings = std::cell::RefCell::new(Vec::<String>::new());
        let pulled = pull_local_warning(&two, &server, nobody, |warning| {
            warnings.borrow_mut().push(warning.to_string())
        })
        .unwrap();
        assert!(matches!(pulled, Pulled::FastForward { .. }), "{pulled:?}");
        assert_ne!(head(&two), before, "the pull took effect");
        assert_eq!(head(&two), head(&one));
        assert_eq!(files(&two)["new.txt"], "n\n");
        assert_eq!(tracking(&two), None, "and the record was not made");
        let warnings = warnings.into_inner();
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(
            warnings[0].starts_with("warning: the pull went through"),
            "{warnings:?}"
        );
        assert!(warnings[0].contains("origin/main"), "{warnings:?}");
        assert!(!warnings[0].contains('\n'), "{warnings:?}");
    }

    #[test]
    fn the_tracking_ref_records_the_fetch_after_every_pull_that_went_through() {
        // Up to date.
        let dir = tempfile::tempdir().unwrap();
        let (server, _one, two) = two_clones(dir.path());
        assert_eq!(tracking(&two), None);
        let pulled = pull_local(&two, &server, nobody).unwrap();
        assert!(matches!(pulled, Pulled::UpToDate { .. }), "{pulled:?}");
        assert_eq!(tracking(&two), Some(head(&two)));

        // Fast-forward.
        let dir = tempfile::tempdir().unwrap();
        let (server, one, two) = two_clones(dir.path());
        commit_file(&one, "new.txt", "n\n");
        push_main(&one, &server);
        let pulled = pull_local(&two, &server, nobody).unwrap();
        assert!(matches!(pulled, Pulled::FastForward { .. }), "{pulled:?}");
        assert_eq!(tracking(&two), Some(head(&one)));

        // Merge, and a merge that stopped on a conflict (the merge is in progress with it).
        let dir = tempfile::tempdir().unwrap();
        let (server, one, two) = diverged_without_conflict(dir.path());
        let pulled = pull_local(&two, &server, me).unwrap();
        assert!(matches!(pulled, Pulled::Merged { .. }), "{pulled:?}");
        assert_eq!(tracking(&two), Some(head(&one)));
        let dir = tempfile::tempdir().unwrap();
        let (server, one, two) = diverged_with_conflict(dir.path());
        let pulled = pull_local(&two, &server, me).unwrap();
        assert!(matches!(pulled, Pulled::Conflict { .. }), "{pulled:?}");
        assert_eq!(tracking(&two), Some(head(&one)));
    }

    #[test]
    fn a_pull_that_is_refused_moves_no_ref_not_even_the_tracking_ref() {
        let dir = tempfile::tempdir().unwrap();
        let (server, _one, two) = diverged_without_conflict(dir.path());
        commit_file(&two, "other.txt", "other\n");
        write_file(&two, "other.txt", "uncommitted\n");
        let refs = all_refs(&two);
        let err = pull_local(&two, &server, me).unwrap_err();
        assert!(matches!(err, NsitError::Other(_)), "{err:?}");
        assert_eq!(all_refs(&two), refs);
        assert_eq!(tracking(&two), None);
    }

    #[test]
    fn a_branch_the_server_does_not_have_is_an_error_that_names_it_and_moves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (server, _one, two) = two_clones(dir.path());
        let refs = all_refs(&two);
        let missing = Upstream {
            remote: "origin".into(),
            merge: "refs/heads/gone".into(),
        };
        let err = pull_via(
            &two,
            "main",
            &missing,
            URL,
            |branch| {
                fetch_head_of(&two, server.to_str().unwrap(), branch, FetchOptions::new())
                    .map_err(NsitError::Git)
            },
            nobody,
            |warning| panic!("unexpected warning: {warning}"),
        )
        .unwrap_err();
        assert!(matches!(err, NsitError::Other(_)), "{err:?}");
        assert_eq!(err.exit_code(), 1);
        assert!(err.to_string().contains("gone"), "{err}");
        assert!(!err.to_string().contains('\n'));
        assert_eq!(all_refs(&two), refs);
    }

    #[test]
    fn an_upstream_that_is_not_a_branch_is_a_usage_error_before_anything_is_fetched() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let tag = Upstream {
            remote: "origin".into(),
            merge: "refs/tags/v1".into(),
        };
        let err = pull_via(
            &repo,
            "main",
            &tag,
            URL,
            |_| panic!("nothing may be fetched for an upstream that is not a branch"),
            nobody,
            |warning| panic!("unexpected warning: {warning}"),
        )
        .unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert_eq!(err.exit_code(), 2);
        assert!(err.to_string().contains("refs/tags/v1"), "{err}");
    }

    // ---- what a failure says ------------------------------------------------------------------------

    fn failure(class: git2::ErrorClass, message: &str) -> NsitError {
        NsitError::Git(git2::Error::new(ErrorCode::GenericError, class, message))
    }

    #[test]
    fn a_failed_fetch_is_said_in_one_line_with_the_server_named() {
        let target = target_on("https://git.iam.bot/");
        for message in [
            "unexpected http status code: 404",
            "request failed with status code: 404",
            "request failed with status code: 403",
        ] {
            let err = fetch_error(failure(git2::ErrorClass::Http, message), &target);
            assert_eq!(
                err.to_string(),
                "repository not found or no access",
                "{message}"
            );
            assert_eq!(err.exit_code(), 1);
        }
        let err = fetch_error(
            failure(git2::ErrorClass::Http, "unexpected http status code: 500"),
            &target,
        );
        assert_eq!(
            err.to_string(),
            "git.iam.bot answered the fetch with HTTP 500"
        );
        let err = fetch_error(
            failure(
                git2::ErrorClass::Os,
                "failed to send request: connection refused\r\n",
            ),
            &target,
        );
        assert!(
            err.to_string().starts_with("cannot reach git.iam.bot: "),
            "{err}"
        );
        assert!(!err.to_string().contains('\n'), "{err:?}");
        assert_eq!(err.exit_code(), 1);
        // A refused login (and anything that is not libgit2's) passes through.
        let auth = fetch_error(NsitError::Auth("authentication failed".into()), &target);
        assert_eq!(auth.exit_code(), 3);
    }

    // ---- the network step -----------------------------------------------------------------------------

    fn sign_in_to(host: &str, account: &str, token: &str) {
        store_token(host, account, token).unwrap();
        let mut config = Config::load().unwrap();
        config.hosts.insert(
            host_key_for(host).unwrap(),
            host_entry_for(account, None, None),
        );
        config.save().unwrap();
    }

    fn target_on(host: &str) -> RepoRef {
        parse_repo_ref("ada/rocket", "ada", &url::Url::parse(host).unwrap()).unwrap()
    }

    #[test]
    fn a_refused_login_is_exit_3_with_the_sign_in_hint_and_moves_nothing() {
        let home = tempfile::tempdir().unwrap();
        let _env = isolated_env(home.path());
        let server = StubServer::refusing();
        sign_in_to(&server.host(), "grace", "ins_stored_token");
        let dir = tempfile::tempdir().unwrap();
        let (_s, _one, two) = two_clones(dir.path());
        let refs = all_refs(&two);

        let err = pull_branch(
            &two,
            &target_on(&server.host()),
            &server.host(),
            &out_with(false, false),
            "main",
            &up("origin"),
            nobody,
        )
        .unwrap_err();
        assert!(matches!(err, NsitError::Auth(_)), "{err:?}");
        assert_eq!(err.exit_code(), 3);
        assert!(err.to_string().contains("nsit auth login"), "{err}");
        assert!(!err.to_string().contains("ins_stored_token"), "{err}");
        assert_eq!(all_refs(&two), refs);
        // On the wire: the fetch asked for the refs, was challenged, and answered once.
        let seen = server.requests();
        assert!(
            seen[0]
                .request_line
                .contains("/ada/rocket.git/info/refs?service=git-upload-pack"),
            "{seen:?}"
        );
        assert_eq!(seen.len(), 2, "{seen:?}");
    }

    #[test]
    fn signed_out_nothing_is_fetched_and_nothing_is_asked_of_any_server() {
        let home = tempfile::tempdir().unwrap();
        let _env = isolated_env(home.path());
        let server = StubServer::refusing();
        let dir = tempfile::tempdir().unwrap();
        let (_s, _one, two) = two_clones(dir.path());
        let err = pull_branch(
            &two,
            &target_on(&server.host()),
            &server.host(),
            &out_with(false, false),
            "main",
            &up("origin"),
            nobody,
        )
        .unwrap_err();
        assert_eq!(err.exit_code(), 3, "{err}");
        assert_eq!(
            server.connections_after(std::time::Duration::from_millis(200)),
            0
        );
    }
}
