//! Runs the real `nsit` binary: version string, usage errors, the network
//! commands that are still stubs, signed-out behavior, and the rule that a bad
//! `--jq` fails before any command runs. The local commands are in `tests/local.rs`.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

fn nsit(args: &[&str]) -> Output {
    let config = tempfile::tempdir().unwrap();
    Command::new(env!("CARGO_BIN_EXE_nsit"))
        .args(args)
        .env("NSIT_CONFIG_DIR", config.path())
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

#[test]
fn every_command_not_built_yet_is_a_stub_that_exits_1_with_a_plain_message() {
    // `auth`, `repo`, `clone` and the local commands are implemented (tests/nsit.e2e.test.ts
    // and tests/local.rs); the two that still talk to a git server are stubs.
    let invocations: &[&[&str]] = &[
        &["pull"],
        &["pull", "--abort"],
        &["push", "-u", "main", "--force-with-lease"],
        // Global flags after the subcommand.
        &[
            "pull",
            "--json",
            "--jq",
            ".[].name",
            "--host",
            "h.example",
            "-q",
            "--no-color",
            "-C",
            "somewhere",
        ],
    ];
    for args in invocations {
        let o = nsit(args);
        let label = args.join(" ");
        assert_eq!(o.status.code(), Some(1), "nsit {label}: {}", stderr(&o));
        assert_eq!(stderr(&o), "nsit: not implemented\n", "nsit {label}");
        assert_eq!(stdout(&o), "", "nsit {label}");
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

const SIGN_IN_HINT: &str = "nsit: not signed in to 127.0.0.1:9; run nsit auth login
";

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
    // `pull` is a stub that would exit 1; reaching exit 2 proves the
    // expression was checked first.
    let o = nsit(&["pull", "--jq", ".["]);
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
fn valid_jq_reaches_the_stub() {
    let o = nsit(&["pull", "--jq", ".name"]);
    assert_eq!(o.status.code(), Some(1));
    assert_eq!(stderr(&o), "nsit: not implemented\n");
}
