//! Runs the real `nsit` binary: version string, usage errors, `pull` without a server to
//! pull from, signed-out behavior, and the rule that a bad `--jq` fails before any command
//! runs. The local commands are in `tests/local.rs`; what talks to a server is in
//! `tests/nsit.e2e.test.ts`.
//!
//! **Every run happens in a directory of its own** (`nsit` here, `nsit_in`, `run_signed_out`):
//! the working directory of a test is the crate directory, which is inside this project's own
//! git repository, and a command that acts on "the repository here" (`pull`, `push`, `commit`)
//! must never be able to reach it.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

/// Run `nsit <args>` in an empty directory of its own, with a config directory of its own.
fn nsit(args: &[&str]) -> Output {
    let work = tempfile::tempdir().unwrap();
    nsit_in(work.path(), args)
}

/// Run `nsit <args>` in `work`, with a config directory of its own, no host, no token, and the OS
/// credential store switched off.
fn nsit_in(work: &Path, args: &[&str]) -> Output {
    let config = tempfile::tempdir().unwrap();
    Command::new(env!("CARGO_BIN_EXE_nsit"))
        .args(args)
        .current_dir(work)
        .env("NSIT_CONFIG_DIR", config.path())
        .env("NSIT_NO_KEYCHAIN", "1")
        .env_remove("NSIT_HOST")
        .env_remove("NSIT_TOKEN")
        .env("NO_COLOR", "1")
        .output()
        .expect("run nsit")
}

fn stdout(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn stderr(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

#[test]
fn version_prints_name_version_and_commit() {
    let o = nsit(&["--version"]);
    assert_eq!(o.status.code(), Some(0));
    let text = stdout(&o);
    let prefix = format!("nsit {} (", env!("CARGO_PKG_VERSION"));
    assert!(text.starts_with(&prefix), "{text:?}");
    let sha = text
        .trim_end()
        .strip_prefix(&prefix)
        .unwrap()
        .strip_suffix(')')
        .unwrap();
    // `unknown` for a local build, the first 7 characters of GITHUB_SHA in CI.
    assert!(
        sha == "unknown" || (sha.len() == 7 && sha.chars().all(|c| c.is_ascii_hexdigit())),
        "{sha}"
    );
}

#[test]
fn help_lists_every_v1_command_and_exits_zero() {
    let o = nsit(&["--help"]);
    assert_eq!(o.status.code(), Some(0));
    let text = stdout(&o);
    for word in [
        "auth",
        "init",
        "clone",
        "status",
        "add",
        "commit",
        "log",
        "branch",
        "switch",
        "pull",
        "push",
        "readme",
        "repo",
        "--host",
        "--json",
        "--jq",
        "--quiet",
        "--no-color",
        "-C",
    ] {
        assert!(text.contains(word), "--help is missing {word:?}:\n{text}");
    }
}

/// A throwaway repository on `main` with one commit and no remote: nothing to pull from, and
/// nothing a command could do to the project's own repository.
fn lonely_repo(dir: &Path) -> git2::Repository {
    let mut options = git2::RepositoryInitOptions::new();
    options.initial_head("main");
    let repo = git2::Repository::init_opts(dir, &options).unwrap();
    std::fs::write(dir.join("a.txt"), "a\n").unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new("a.txt")).unwrap();
    index.write().unwrap();
    {
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let who = git2::Signature::now("Test", "test@example.com").unwrap();
        repo.commit(Some("HEAD"), &who, &who, "one", &tree, &[])
            .unwrap();
    }
    repo
}

#[test]
fn pull_without_a_branch_to_pull_from_is_a_usage_error_that_says_what_to_do() {
    // Each of these runs in a repository of its own, never the project's.
    let work = tempfile::tempdir().unwrap();
    let repo = lonely_repo(work.path());
    let before = std::fs::read_to_string(work.path().join("a.txt")).unwrap();

    // No upstream: the hint is nsit push.
    let o = nsit_in(work.path(), &["pull"]);
    assert_eq!(o.status.code(), Some(2), "{}", stderr(&o));
    assert_eq!(
        stderr(&o),
        "nsit: main has no upstream branch: run nsit push to send it to Insitio and track it\n"
    );
    assert_eq!(stdout(&o), "");

    // Global flags after the subcommand are fine, and -C is honoured.
    let o = nsit(&[
        "pull",
        "--json",
        "--jq",
        ".[].name",
        "--host",
        "h.example",
        "-q",
        "--no-color",
        "-C",
        work.path().to_str().unwrap(),
    ]);
    assert_eq!(o.status.code(), Some(2), "{}", stderr(&o));
    assert!(stderr(&o).contains("no upstream branch"), "{}", stderr(&o));

    // Nothing to abort.
    let o = nsit_in(work.path(), &["pull", "--abort"]);
    assert_eq!(o.status.code(), Some(2), "{}", stderr(&o));
    assert_eq!(
        stderr(&o),
        "nsit: there is no merge in progress, so there is nothing to abort\n"
    );
    assert_eq!(stdout(&o), "");

    // Nothing was touched.
    assert_eq!(
        std::fs::read_to_string(work.path().join("a.txt")).unwrap(),
        before
    );
    assert!(repo.find_reference("refs/remotes/origin/main").is_err());
    assert_eq!(repo.state(), git2::RepositoryState::Clean);
}

#[test]
fn pull_outside_a_repository_says_to_run_nsit_init() {
    let work = tempfile::tempdir().unwrap();
    // Only meaningful when nothing above the temp dir is a repository.
    if work.path().ancestors().any(|p| p.join(".git").exists()) {
        eprintln!("skipped: the temp dir is inside a git repository");
        return;
    }
    for args in [&["pull"][..], &["pull", "--abort"]] {
        let o = nsit_in(work.path(), args);
        assert_eq!(o.status.code(), Some(2), "{}", stderr(&o));
        assert_eq!(stderr(&o), "nsit: not a git repository (run nsit init)\n");
        assert_eq!(stdout(&o), "");
    }
}

/// Run `nsit <args> --host http://127.0.0.1:9` the way an agent with nobody signed
/// in would: stdin is an open pipe that nobody writes to or closes (a read would
/// block), the host is a port nothing listens on (a request would fail), and the
/// working directory is `work`. It must exit within 5 s; returns what it
/// answered: the exit code, stdout and stderr.
fn run_signed_out(args: &[&str], work: &Path) -> (Option<i32>, String, String) {
    let config = tempfile::tempdir().unwrap();
    let started = Instant::now();
    let mut child = Command::new(env!("CARGO_BIN_EXE_nsit"))
        .args(args)
        .args(["--host", "http://127.0.0.1:9"])
        .current_dir(work)
        .env("NSIT_CONFIG_DIR", config.path())
        .env("NSIT_NO_KEYCHAIN", "1")
        .env_remove("NSIT_HOST")
        .env_remove("NSIT_TOKEN")
        .env("NO_COLOR", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("run nsit");
    // Keeping the pipe's write end open (`_stdin`) is what makes a read block.
    let _stdin = child.stdin.take();
    let label = format!("nsit {}", args.join(" "));
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > Duration::from_secs(5) {
            let _ = child.kill();
            panic!("{label} did not exit within 5 s: it is waiting for something");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let (mut out, mut err) = (String::new(), String::new());
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut out)
        .unwrap();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut err)
        .unwrap();
    (status.code(), out, err)
}

const SIGN_IN_HINT: &str = "nsit: not signed in to 127.0.0.1:9; run nsit auth login\n";

/// Review Focus 2: nobody is signed in and stdin is an open pipe that nobody
/// writes to or closes (an agent's). Each `nsit repo` command must exit 3 with
/// a sign-in hint at once, not wait for input, and not touch the network.
#[test]
fn repo_commands_signed_out_exit_3_at_once_and_never_read_stdin() {
    let invocations: &[&[&str]] = &[
        &["repo", "list"],
        &["repo", "list", "--json"],
        &["repo", "list", "--owner", "ada"],
        &["repo", "create", "tools"],
        &["repo", "view", "ada/tools"],
        &["repo", "view", "tools"],
    ];
    for args in invocations {
        let work = tempfile::tempdir().unwrap();
        let (code, out, err) = run_signed_out(args, work.path());
        let label = format!("nsit {}", args.join(" "));
        assert_eq!(code, Some(3), "{label}: {err}");
        assert_eq!(out, "", "{label}");
        assert_eq!(err, SIGN_IN_HINT, "{label}");
    }
}

/// Review Focus 2 for `nsit clone`: the same, and it makes no directory either,
/// not the one it would clone into nor the one a missing parent would need.
#[test]
fn clone_signed_out_exits_3_at_once_never_reads_stdin_and_makes_nothing() {
    let invocations: &[&[&str]] = &[
        &["clone", "ada/tools"],
        &["clone", "tools"],
        &["clone", "ada/tools", "target"],
        &["clone", "ada/tools", "deep/er/target"],
        &["clone", "http://127.0.0.1:9/ada/tools.git"],
        &["clone", "ada/tools", "--json"],
    ];
    for args in invocations {
        let work = tempfile::tempdir().unwrap();
        let (code, out, err) = run_signed_out(args, work.path());
        let label = format!("nsit {}", args.join(" "));
        assert_eq!(code, Some(3), "{label}: {err}");
        assert_eq!(out, "", "{label}");
        assert_eq!(err, SIGN_IN_HINT, "{label}");
        assert_eq!(
            std::fs::read_dir(work.path()).unwrap().count(),
            0,
            "{label} left something in the working directory"
        );
    }
}

/// A repository on `main` with one commit, whose `origin` is a server nothing listens on:
/// where an agent that never signed in would be.
fn repo_with_an_origin_nobody_answers(dir: &Path) -> git2::Repository {
    let repo = lonely_repo(dir);
    repo.remote("origin", "http://127.0.0.1:9/ada/tools.git")
        .unwrap();
    repo
}

/// Review Focus 2 for `nsit push`: signed out, stdin an open pipe nobody writes to, and an
/// origin that would not answer anyway. It exits 3 with the sign-in hint at once, without
/// reading stdin or touching the network, and nothing in the repository changes.
#[test]
fn push_signed_out_exits_3_at_once_never_reads_stdin_and_moves_nothing() {
    let invocations: &[&[&str]] = &[
        &["push"],
        &["push", "--json"],
        &["push", "main"],
        &["push", "-u", "main"],
        &["push", "--force-with-lease"],
    ];
    for args in invocations {
        let work = tempfile::tempdir().unwrap();
        let repo = repo_with_an_origin_nobody_answers(work.path());
        let config_before = std::fs::read_to_string(repo.path().join("config")).unwrap();
        let (code, out, err) = run_signed_out(args, work.path());
        let label = format!("nsit {}", args.join(" "));
        assert_eq!(code, Some(3), "{label}: {err}");
        assert_eq!(out, "", "{label}");
        assert_eq!(err, SIGN_IN_HINT, "{label}");
        assert!(
            repo.find_reference("refs/remotes/origin/main").is_err(),
            "{label} recorded a push that did not happen"
        );
        assert_eq!(
            std::fs::read_to_string(repo.path().join("config")).unwrap(),
            config_before,
            "{label} changed the repository's config (an upstream) without pushing"
        );
    }
}

/// Review Focus 2 for `nsit pull`: signed out, stdin an open pipe nobody writes to, and an
/// upstream whose server would not answer anyway. It exits 3 with the sign-in hint at once,
/// without reading stdin or touching the network, and nothing in the repository changes.
#[test]
fn pull_signed_out_exits_3_at_once_never_reads_stdin_and_moves_nothing() {
    let invocations: &[&[&str]] = &[&["pull"], &["pull", "--json"], &["pull", "--jq", ".result"]];
    for args in invocations {
        let work = tempfile::tempdir().unwrap();
        let repo = repo_with_an_origin_nobody_answers(work.path());
        {
            let mut config = repo.config().unwrap();
            config.set_str("branch.main.remote", "origin").unwrap();
            config
                .set_str("branch.main.merge", "refs/heads/main")
                .unwrap();
        }
        let config_before = std::fs::read_to_string(repo.path().join("config")).unwrap();
        let head_before = repo.head().unwrap().target().unwrap();
        let (code, out, err) = run_signed_out(args, work.path());
        let label = format!("nsit {}", args.join(" "));
        assert_eq!(code, Some(3), "{label}: {err}");
        assert_eq!(out, "", "{label}");
        assert_eq!(err, SIGN_IN_HINT, "{label}");
        assert!(
            repo.find_reference("refs/remotes/origin/main").is_err(),
            "{label} recorded a fetch that did not happen"
        );
        assert_eq!(
            repo.head().unwrap().target().unwrap(),
            head_before,
            "{label}"
        );
        assert_eq!(
            std::fs::read_to_string(repo.path().join("config")).unwrap(),
            config_before,
            "{label} changed the repository's config"
        );
        assert!(
            !repo.path().join("ORIG_HEAD").exists(),
            "{label} wrote ORIG_HEAD for a pull that never started"
        );
    }
}

#[test]
fn unknown_command_and_missing_arguments_exit_2() {
    for args in [
        &["frobnicate"][..],
        &[],
        &["add"],
        &["switch"],
        &["log", "-n", "many"],
    ] {
        let o = nsit(args);
        assert_eq!(
            o.status.code(),
            Some(2),
            "nsit {}: {}",
            args.join(" "),
            stderr(&o)
        );
        assert_eq!(stdout(&o), "");
        assert!(!stderr(&o).is_empty());
    }
}

#[test]
fn bad_jq_exits_2_before_the_command_runs() {
    // In a repository that `pull` itself would stop at, with exit 2 and its own message: the
    // message tells which of the two came first.
    let work = tempfile::tempdir().unwrap();
    lonely_repo(work.path());
    let o = nsit_in(work.path(), &["pull", "--jq", ".["]);
    assert_eq!(o.status.code(), Some(2), "{}", stderr(&o));
    let err = stderr(&o);
    assert!(
        err.starts_with("nsit: invalid --jq expression: "),
        "{err:?}"
    );
    assert_eq!(err.lines().count(), 1, "{err:?}");
    assert_eq!(stdout(&o), "");
}

#[test]
fn a_valid_jq_expression_reaches_the_command() {
    let work = tempfile::tempdir().unwrap();
    lonely_repo(work.path());
    let o = nsit_in(work.path(), &["pull", "--jq", ".result"]);
    assert_eq!(o.status.code(), Some(2), "{}", stderr(&o));
    assert!(stderr(&o).contains("no upstream branch"), "{}", stderr(&o));
    assert_eq!(stdout(&o), "");
}
