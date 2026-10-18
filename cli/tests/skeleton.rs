//! Runs the real `nsit` binary: version string, usage errors, the stubs, and
//! the rule that a bad `--jq` fails before any command runs.

use std::process::{Command, Output};

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
    // `auth` is implemented (see tests/nsit.e2e.test.ts); the rest are still stubs.
    let invocations: &[&[&str]] = &[
        &["init", "demo", "--remote", "--readme"],
        &["clone", "ada/demo", "target"],
        &["status"],
        &["add", "a.txt"],
        &["commit", "-m", "msg", "--staged", "--allow-secret", ".env"],
        &["log", "-n", "3", "--oneline"],
        &["branch"],
        &["branch", "-d", "old"],
        &["switch", "-c", "feature"],
        &["pull", "--abort"],
        &["push", "-u", "main", "--force-with-lease"],
        &["readme"],
        &["repo", "create", "tools", "--description", "d", "--public"],
        &["repo", "list", "--owner", "ada"],
        &["repo", "view", "ada/tools"],
        // Global flags after the subcommand.
        &[
            "repo",
            "list",
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
    // `status` is a stub that would exit 1; reaching exit 2 proves the
    // expression was checked first.
    let o = nsit(&["status", "--jq", ".["]);
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
    let o = nsit(&["status", "--jq", ".name"]);
    assert_eq!(o.status.code(), Some(1));
    assert_eq!(stderr(&o), "nsit: not implemented\n");
}
