//! `nsit pull [--abort]`: bring the current branch up to date with its upstream.
//!
//! * The upstream is `branch.<b>.remote` and `.merge`, which `nsit push` (the first push of a
//!   branch, or `-u`) and `nsit clone` set. A branch without one is exit 2 with the hint to
//!   run `nsit push`; so is a detached `HEAD`, an upstream whose remote the repository does not
//!   have, and one that is not a branch.
//! * The remote's URL is read as a repository (`https://<server>/<owner>/<name>.git`, with no
//!   user name or password in it) on whatever server it names: the token for that server, and no
//!   other, is what the fetch signs in with, and an `NSIT_TOKEN` only when that server is the
//!   selected one (`--host`, `NSIT_HOST`, the default). Everything on the network goes through
//!   `git::run_remote`; a refused login is exit 3, an unreachable server exit 1 with one line.
//! * It fast-forwards when it can, and otherwise merges. A merge that stops on conflicts is
//!   **left in progress for real git to see** (`MERGE_HEAD` and the rest, conflict markers in the
//!   files), the files are listed and the exit code is 4: resolve them and run `nsit commit` to
//!   finish, or run `nsit pull --abort` to undo it. See `git::pull` for what each outcome leaves
//!   behind, why a pull that has to merge needs the tracked files committed, and why the secret
//!   guard does not run on the merge commit a pull makes.
//! * `--abort` **throws away your conflict resolutions and restores the files as they were before
//!   the pull** (`reset --hard` to where the merge started, `ORIG_HEAD`, and the merge state is
//!   cleared); untracked files are not touched. It says so in its help, in the hint a conflict
//!   prints, and in its own output. It refuses (exit 2, naming the files, nothing changed) when a
//!   tracked file the merge did not touch was changed after the pull stopped, or when a file of
//!   yours (untracked or ignored) is where a file the merge deleted has to be put back; without a
//!   merge in progress it is exit 2 and changes nothing: see `git::abort`.
//! * A merge commit is made by the person pulling: `user.name` and `user.email` from the git
//!   configuration, then the name and email nsit saved at sign-in (as for `nsit commit`).
//! * Progress goes to stderr, and only on a terminal.
//!
//! `--json`: `{result, head, conflicts}`. `result` is `up_to_date`, `fast_forward`, `merged`,
//! `conflict` or (for `--abort`) `aborted`; `head` is the commit `HEAD` is at afterwards (for a
//! conflict, the commit the merge started from); `conflicts` lists the repository-relative paths
//! that stopped a merge and is empty otherwise. A conflict prints this to stdout and *also* exits
//! 4 with the usual error line on stderr. The text is `Already up to date`, `Fast-forwarded
//! <branch> to <short id>`, `Merged <remote>/<branch>`, the list of conflicted files, or `Merge
//! aborted; <branch> is back at <short id>, with the files as they were before the pull (...)`.

use std::path::Path;

use git2::{ErrorCode, Repository, RepositoryState};
use serde::Serialize;

use super::commit_signature;
use crate::cli::{GlobalArgs, PullArgs};
use crate::config::{base_url, resolve_host};
use crate::error::NsitError;
use crate::git::abort::{abort, operation_name};
use crate::git::open_repo;
use crate::git::origin::repo_ref_from_url;
use crate::git::paths::workdir;
use crate::git::pull::{pull_branch, Pulled};
use crate::git::stage::current_branch;
use crate::git::upstream::{upstream, Upstream};
use crate::output::{for_display, strip_controls, Out};
use crate::repo_ref::RepoRef;

/// Said (unless `-q`) when a merge stopped on conflicts.
const CONFLICT_HINT: &str = "Fix the conflicts, then run nsit commit to finish the merge (or \
                             nsit commit -m \"message\"). Or run nsit pull --abort to undo it: \
                             that throws away your conflict resolutions and restores the files \
                             as they were before the pull.";

/// `--json` for `nsit pull`.
#[derive(Debug, Serialize, PartialEq, Eq)]
struct PullJson {
    result: &'static str,
    head: String,
    conflicts: Vec<String>,
}

/// What the text says, with the pieces the JSON does not have.
#[derive(Debug, PartialEq, Eq)]
enum Summary {
    UpToDate,
    FastForward { branch: String },
    Merged { label: String },
    Conflict,
    Aborted { branch: Option<String> },
}

#[derive(Debug, PartialEq, Eq)]
struct Report {
    json: PullJson,
    summary: Summary,
}

impl Report {
    fn of(pulled: &Pulled) -> Report {
        let (result, summary, conflicts) = match pulled {
            Pulled::UpToDate { .. } => ("up_to_date", Summary::UpToDate, Vec::new()),
            Pulled::FastForward { branch, .. } => (
                "fast_forward",
                Summary::FastForward {
                    branch: branch.clone(),
                },
                Vec::new(),
            ),
            Pulled::Merged { label, .. } => (
                "merged",
                Summary::Merged {
                    label: label.clone(),
                },
                Vec::new(),
            ),
            Pulled::Conflict { paths, .. } => ("conflict", Summary::Conflict, paths.clone()),
        };
        Report {
            json: PullJson {
                result,
                head: pulled.head().to_string(),
                conflicts,
            },
            summary,
        }
    }
}

pub fn run(args: &PullArgs, global: &GlobalArgs, out: &Out, base: &Path) -> Result<(), NsitError> {
    let repo = open_repo(base)?;
    // A bare repository has no files to bring anything into (or to undo).
    workdir(&repo)?;
    if args.abort {
        return run_abort(&repo, out);
    }

    let host = resolve_host(global.host.as_deref());
    let branch = branch_to_pull(&repo)?;
    let up = upstream_of(&repo, &branch)?;
    let target = upstream_target(&repo, &up, &host)?;
    let pulled = pull_branch(&repo, &target, &host, out, &branch, &up, || {
        commit_signature(&repo, global)
    })?;

    let report = Report::of(&pulled);
    out.data(&report.json, |json| describe(&report, json, out.tty))?;
    match pulled {
        Pulled::Conflict { paths, .. } => {
            out.info(CONFLICT_HINT);
            Err(NsitError::Conflict(paths))
        }
        _ => Ok(()),
    }
}

fn run_abort(repo: &Repository, out: &Out) -> Result<(), NsitError> {
    let head = abort(repo)?;
    let report = Report {
        json: PullJson {
            result: "aborted",
            head: head.to_string(),
            conflicts: Vec::new(),
        },
        summary: Summary::Aborted {
            branch: current_branch(repo),
        },
    };
    out.data(&report.json, |json| describe(&report, json, out.tty))
}

/// The branch to bring up to date: the one `HEAD` is on (also before its first commit). Not while
/// another operation is waiting to be finished, and not on a detached `HEAD`.
fn branch_to_pull(repo: &Repository) -> Result<String, NsitError> {
    match repo.state() {
        RepositoryState::Clean => {}
        RepositoryState::Merge => {
            return Err(NsitError::Usage(
                "a merge is in progress: finish with nsit commit or nsit pull --abort".into(),
            ));
        }
        other => {
            return Err(NsitError::Usage(format!(
                "the repository is in the middle of {}: finish or abort that before pulling",
                operation_name(other)
            )));
        }
    }
    current_branch(repo).ok_or_else(|| {
        NsitError::Usage(
            "HEAD is detached: switch to a branch before pulling (nsit switch <branch>)".into(),
        )
    })
}

/// `branch`'s upstream, or the way to get one.
fn upstream_of(repo: &Repository, branch: &str) -> Result<Upstream, NsitError> {
    upstream(repo, branch)?.ok_or_else(|| {
        NsitError::Usage(format!(
            "{} has no upstream branch: run nsit push to send it to Insitio and track it",
            strip_controls(branch)
        ))
    })
}

/// The upstream's remote as the repository on Insitio it is. Only a full URL counts (see
/// `repo_ref_from_url`); the server may be any server, and `run_remote` picks the token for it.
fn upstream_target(
    repo: &Repository,
    up: &Upstream,
    selected_host: &str,
) -> Result<RepoRef, NsitError> {
    let name = strip_controls(&up.remote);
    let remote = repo.find_remote(&up.remote).map_err(|e| match e.code() {
        ErrorCode::NotFound | ErrorCode::InvalidSpec => NsitError::Usage(format!(
            "the upstream names the remote {name}, which this repository does not have"
        )),
        _ => NsitError::Git(e),
    })?;
    let url = remote.url().map_err(|_| {
        NsitError::Usage(format!(
            "the upstream remote {name} has no URL nsit can read"
        ))
    })?;
    repo_ref_from_url(url, &base_url(selected_host)?).map_err(|why| {
        NsitError::Usage(format!(
            "the upstream remote {name} is not a repository URL nsit can pull from ({why}); it \
             should look like https://<server>/<owner>/<name>.git"
        ))
    })
}

/// The text for people.
fn describe(report: &Report, json: &PullJson, tty: bool) -> String {
    let clean = |text: &str| for_display(text, tty);
    let short = &json.head[..json.head.len().min(7)];
    match &report.summary {
        Summary::UpToDate => "Already up to date".to_string(),
        Summary::FastForward { branch } => {
            format!("Fast-forwarded {} to {short}", clean(branch))
        }
        Summary::Merged { label } => format!("Merged {}", clean(label)),
        Summary::Conflict => {
            let count = json.conflicts.len();
            let mut lines = vec![format!(
                "Merge conflict in {count} file{}:",
                if count == 1 { "" } else { "s" }
            )];
            lines.extend(
                json.conflicts
                    .iter()
                    .map(|path| format!("  {}", clean(path))),
            );
            lines.join("\n")
        }
        Summary::Aborted { branch } => format!(
            "Merge aborted; {} is back at {short}, with the files as they were before the pull \
             (changes made while resolving the conflicts were thrown away)",
            clean(branch.as_deref().unwrap_or("HEAD"))
        ),
    }
}

#[cfg(test)]
mod tests {
    use git2::Oid;

    use super::*;
    use crate::test_support::{
        checkout_branch as checkout, commit_file, diverged_repo as diverged, local_repo,
        merge_branch as merge_in,
    };

    fn id(n: u8) -> Oid {
        Oid::from_bytes(&[n; 20]).unwrap()
    }

    fn text(pulled: &Pulled, tty: bool) -> String {
        let report = Report::of(pulled);
        describe(&report, &report.json, tty)
    }

    // ---- what is printed -----------------------------------------------------------------------

    #[test]
    fn the_text_says_what_happened() {
        assert_eq!(
            text(&Pulled::UpToDate { head: id(1) }, false),
            "Already up to date"
        );
        assert_eq!(
            text(
                &Pulled::FastForward {
                    branch: "main".into(),
                    head: id(0xab)
                },
                false
            ),
            "Fast-forwarded main to abababa"
        );
        assert_eq!(
            text(
                &Pulled::Merged {
                    label: "origin/main".into(),
                    head: id(2)
                },
                false
            ),
            "Merged origin/main"
        );
        let one = Pulled::Conflict {
            head: id(3),
            paths: vec!["a.txt".into()],
        };
        assert_eq!(text(&one, false), "Merge conflict in 1 file:\n  a.txt");
        let two = Pulled::Conflict {
            head: id(3),
            paths: vec!["a.txt".into(), "dir/b.txt".into()],
        };
        assert_eq!(
            text(&two, false),
            "Merge conflict in 2 files:\n  a.txt\n  dir/b.txt"
        );
    }

    #[test]
    fn the_abort_text_names_the_branch_and_where_it_is_back() {
        let json = PullJson {
            result: "aborted",
            head: id(0xcd).to_string(),
            conflicts: vec![],
        };
        let report = Report {
            json,
            summary: Summary::Aborted {
                branch: Some("main".into()),
            },
        };
        assert_eq!(
            describe(&report, &report.json, false),
            "Merge aborted; main is back at cdcdcdc, with the files as they were before the pull \
             (changes made while resolving the conflicts were thrown away)"
        );
        let detached = Report {
            summary: Summary::Aborted { branch: None },
            ..report
        };
        assert!(
            describe(&detached, &detached.json, false)
                .starts_with("Merge aborted; HEAD is back at cdcdcdc, with the files"),
            "{}",
            describe(&detached, &detached.json, false)
        );
    }

    /// What `--abort` does is said where a person decides to use it: in its help, in the hint a
    /// conflict prints, and in its output.
    #[test]
    fn what_abort_throws_away_is_said_in_the_help_the_hint_and_the_output() {
        use clap::CommandFactory;
        let plain = "throws away your conflict resolutions and restores the files as they were \
                     before the pull";
        assert!(CONFLICT_HINT.contains(plain), "{CONFLICT_HINT}");
        assert!(
            CONFLICT_HINT.contains("nsit pull --abort"),
            "{CONFLICT_HINT}"
        );
        let pull = crate::cli::Cli::command()
            .find_subcommand("pull")
            .unwrap()
            .clone();
        let abort = pull
            .get_arguments()
            .find(|arg| arg.get_id() == "abort")
            .unwrap();
        let help = abort.get_help().unwrap().to_string();
        assert!(help.contains(plain), "{help}");
    }

    #[test]
    fn names_from_the_repository_are_cleaned_for_a_terminal_and_exact_when_piped() {
        let pulled = Pulled::Conflict {
            head: id(3),
            paths: vec!["a\u{1b}[31m.txt".into()],
        };
        assert!(text(&pulled, false).contains('\u{1b}'));
        assert!(!text(&pulled, true).contains('\u{1b}'));
        let merged = Pulled::Merged {
            label: "origin/\u{1b}[31mmain".into(),
            head: id(2),
        };
        assert!(!text(&merged, true).contains('\u{1b}'));
    }

    #[test]
    fn the_json_has_exactly_the_documented_fields_in_order() {
        for (pulled, want) in [
            (
                Pulled::UpToDate { head: id(1) },
                r#"{"result":"up_to_date","head":"0101010101010101010101010101010101010101","conflicts":[]}"#,
            ),
            (
                Pulled::FastForward {
                    branch: "main".into(),
                    head: id(2),
                },
                r#"{"result":"fast_forward","head":"0202020202020202020202020202020202020202","conflicts":[]}"#,
            ),
            (
                Pulled::Merged {
                    label: "origin/main".into(),
                    head: id(3),
                },
                r#"{"result":"merged","head":"0303030303030303030303030303030303030303","conflicts":[]}"#,
            ),
            (
                Pulled::Conflict {
                    head: id(4),
                    paths: vec!["a.txt".into(), "b/c.txt".into()],
                },
                r#"{"result":"conflict","head":"0404040404040404040404040404040404040404","conflicts":["a.txt","b/c.txt"]}"#,
            ),
        ] {
            assert_eq!(
                serde_json::to_string(&Report::of(&pulled).json).unwrap(),
                want
            );
        }
    }

    // ---- which branch -----------------------------------------------------------------------------

    #[test]
    fn the_current_branch_is_pulled_also_before_its_first_commit() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        assert_eq!(branch_to_pull(&repo).unwrap(), "main");
        commit_file(&repo, "a.txt", "a");
        assert_eq!(branch_to_pull(&repo).unwrap(), "main");
    }

    #[test]
    fn a_detached_head_has_no_branch_to_bring_up_to_date() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "a");
        let tip = repo.head().unwrap().target().unwrap();
        repo.set_head_detached(tip).unwrap();
        let err = branch_to_pull(&repo).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert_eq!(err.exit_code(), 2);
        assert!(err.to_string().contains("detached"), "{err}");
        assert!(err.to_string().contains("nsit switch"), "{err}");
    }

    #[test]
    fn a_merge_that_is_waiting_comes_first_and_says_how_to_go_on() {
        let dir = tempfile::tempdir().unwrap();
        let repo = diverged(dir.path());
        checkout(&repo, "theirs");
        commit_file(&repo, "b.txt", "theirs\n");
        checkout(&repo, "main");
        commit_file(&repo, "c.txt", "ours\n");
        merge_in(&repo, "theirs");
        let err = branch_to_pull(&repo).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert_eq!(err.exit_code(), 2);
        assert_eq!(
            err.to_string(),
            "a merge is in progress: finish with nsit commit or nsit pull --abort"
        );
    }

    #[test]
    fn another_operation_in_progress_is_named() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "a");
        let tip = repo.head().unwrap().target().unwrap();
        std::fs::write(repo.path().join("CHERRY_PICK_HEAD"), format!("{tip}\n")).unwrap();
        let err = branch_to_pull(&repo).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert!(err.to_string().contains("a cherry-pick"), "{err}");
        assert!(!err.to_string().contains('\n'));
    }

    // ---- the upstream -------------------------------------------------------------------------------

    fn set(repo: &Repository, key: &str, value: &str) {
        repo.config().unwrap().set_str(key, value).unwrap();
    }

    #[test]
    fn without_an_upstream_the_hint_is_nsit_push() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let err = upstream_of(&repo, "main").unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert_eq!(err.exit_code(), 2);
        assert_eq!(
            err.to_string(),
            "main has no upstream branch: run nsit push to send it to Insitio and track it"
        );
        set(&repo, "branch.main.remote", "origin");
        set(&repo, "branch.main.merge", "refs/heads/main");
        assert_eq!(upstream_of(&repo, "main").unwrap().remote, "origin");
    }

    fn up(remote: &str) -> Upstream {
        Upstream {
            remote: remote.into(),
            merge: "refs/heads/main".into(),
        }
    }

    #[test]
    fn the_upstream_remote_is_read_as_the_repository_it_names() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        repo.remote("origin", "https://git.iam.bot/ada/demo.git")
            .unwrap();
        let target = upstream_target(&repo, &up("origin"), "git.iam.bot").unwrap();
        assert_eq!(
            (target.owner.as_str(), target.name.as_str()),
            ("ada", "demo")
        );
        assert_eq!(
            target.clone_url.as_str(),
            "https://git.iam.bot/ada/demo.git"
        );

        // Another remote, and a test server on this machine.
        repo.remote("insitio", "http://127.0.0.1:3000/grace/tools")
            .unwrap();
        let target = upstream_target(&repo, &up("insitio"), "http://127.0.0.1:3000").unwrap();
        assert_eq!(
            target.clone_url.as_str(),
            "http://127.0.0.1:3000/grace/tools.git"
        );
    }

    #[test]
    fn a_remote_on_another_server_is_that_server_so_the_selected_hosts_token_stays_home() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        repo.remote("origin", "https://other.example/ada/demo.git")
            .unwrap();
        let target = upstream_target(&repo, &up("origin"), "git.iam.bot").unwrap();
        assert_eq!(target.host_key(), "other.example");
    }

    #[test]
    fn a_remote_that_is_not_there_is_a_usage_error_that_names_it() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        for name in ["nowhere", ".", "bad name"] {
            let err = upstream_target(&repo, &up(name), "git.iam.bot").unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{name}: {err:?}");
            assert_eq!(err.exit_code(), 2);
            assert!(err.to_string().contains(name), "{err}");
            assert!(!err.to_string().contains('\n'));
        }
    }

    #[test]
    fn a_remote_that_is_not_an_insitio_url_is_refused_without_echoing_it() {
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
            "file:///srv/git/demo.git",
        ] {
            repo.remote_delete("origin").ok();
            repo.remote("origin", url).unwrap();
            let err = upstream_target(&repo, &up("origin"), "git.iam.bot").unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{url}: {err:?}");
            assert_eq!(err.exit_code(), 2);
            let text = err.to_string();
            assert!(!text.contains("ins_secret_value"), "{url}: {text}");
            assert!(!text.contains('\n'), "{text:?}");
            assert!(
                text.starts_with("the upstream remote origin is not a repository URL"),
                "{text}"
            );
        }
    }
}
