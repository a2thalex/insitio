//! Runs the real `nsit` binary on local repositories: init, status, add, commit
//! with the secret guard, log, branch, switch and readme.
//!
//! **Review Focus 1.** Most of these run in a directory called
//! `Vidéo Ink - OG Edition` (spaces, an accent, a hyphen) and reach it with
//! `-C "<dir>"` from a different working directory, the way a person with such a
//! project folder, or an agent told to work in it, would. They look at what
//! really ended up in the repository (blob contents, the index file on disk),
//! not just at exit codes.
//!
//! Isolation: every run gets a throwaway home directory with the only git
//! configuration it may see (an identity, and no line-ending conversion), a
//! throwaway nsit config directory and no credential store. The developer's own
//! git configuration is never read, and nothing here writes outside the
//! temporary directories.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use git2::{ObjectType, Repository, TreeWalkMode};
use serde_json::Value;
use tempfile::TempDir;

const UNICODE_DIR: &str = "Vidéo Ink - OG Edition";

struct Sandbox {
    /// `HOME` and `USERPROFILE`, with the `.gitconfig` the runs may see.
    home: TempDir,
    config: TempDir,
    /// A working directory that is not the repository.
    elsewhere: TempDir,
    /// Where the repositories under test live.
    root: TempDir,
}

impl Sandbox {
    fn new() -> Sandbox {
        let sandbox = Sandbox {
            home: tempfile::tempdir().unwrap(),
            config: tempfile::tempdir().unwrap(),
            elsewhere: tempfile::tempdir().unwrap(),
            root: tempfile::tempdir().unwrap(),
        };
        sandbox.set_autocrlf("false");
        sandbox
    }

    /// Rewrite the one git configuration the runs see: an identity and `core.autocrlf`.
    fn set_autocrlf(&self, value: &str) {
        std::fs::write(
            self.home.path().join(".gitconfig"),
            format!(
                "[user]\n\tname = Local Tester\n\temail = tester@example.com\n[core]\n\tautocrlf = {value}\n"
            ),
        )
        .unwrap();
    }

    /// The directory the unicode tests work in, created empty.
    fn unicode_dir(&self) -> PathBuf {
        let dir = self.root.path().join(UNICODE_DIR);
        std::fs::create_dir(&dir).unwrap();
        dir
    }

    /// `nsit <args>` run from `cwd`, with no input and no credentials.
    fn nsit_in(&self, cwd: &Path, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_nsit"))
            .args(args)
            .current_dir(cwd)
            .env("HOME", self.home.path())
            .env("USERPROFILE", self.home.path())
            .env("APPDATA", self.home.path())
            .env("LOCALAPPDATA", self.home.path())
            .env_remove("XDG_CONFIG_HOME")
            .env("NSIT_CONFIG_DIR", self.config.path())
            .env("NSIT_NO_KEYCHAIN", "1")
            .env_remove("NSIT_HOST")
            .env_remove("NSIT_TOKEN")
            .env("NO_COLOR", "1")
            .stdin(Stdio::null())
            .output()
            .expect("run nsit")
    }

    /// `nsit -C <dir> <args>` run from a different directory.
    fn nsit(&self, dir: &Path, args: &[&str]) -> Output {
        let dir = dir.to_str().unwrap();
        let mut all = vec!["-C", dir];
        all.extend_from_slice(args);
        self.nsit_in(self.elsewhere.path(), &all)
    }

    /// Like `nsit`, and the command has to succeed.
    fn ok(&self, dir: &Path, args: &[&str]) -> Output {
        let out = self.nsit(dir, args);
        assert_eq!(code(&out), 0, "nsit {}: {}", args.join(" "), stderr(&out));
        out
    }

    /// `nsit -C <dir> <args> --json` as parsed JSON.
    fn json(&self, dir: &Path, args: &[&str]) -> Value {
        let mut all = args.to_vec();
        all.push("--json");
        let out = self.ok(dir, &all);
        serde_json::from_str(&stdout(&out)).unwrap_or_else(|e| {
            panic!(
                "nsit {} --json is not JSON ({e}): {}",
                args.join(" "),
                stdout(&out)
            )
        })
    }

    /// A repository in the unicode directory with `a.txt` committed.
    fn unicode_repo(&self) -> PathBuf {
        let dir = self.unicode_dir();
        self.ok(&dir, &["init"]);
        write(&dir, "a.txt", "one\n");
        self.ok(&dir, &["commit", "-m", "first"]);
        dir
    }
}

fn code(out: &Output) -> i32 {
    out.status.code().expect("exited by signal")
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

fn write(dir: &Path, rel: &str, text: &str) {
    let path = dir.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn read(dir: &Path, rel: &str) -> String {
    std::fs::read_to_string(dir.join(rel)).unwrap()
}

/// Every file in HEAD's tree with its content, read straight from the repository.
fn committed(dir: &Path) -> BTreeMap<String, String> {
    let repo = Repository::open(dir).unwrap();
    let tree = repo.head().unwrap().peel_to_tree().unwrap();
    let mut files = BTreeMap::new();
    tree.walk(TreeWalkMode::PreOrder, |root, entry| {
        if entry.kind() == Some(ObjectType::Blob) {
            let blob = repo.find_blob(entry.id()).unwrap();
            files.insert(
                format!("{root}{}", entry.name().unwrap()),
                String::from_utf8_lossy(blob.content()).into_owned(),
            );
        }
        0
    })
    .unwrap();
    files
}

/// The paths in the index file on disk, read through a new handle.
fn staged(dir: &Path) -> Vec<String> {
    let repo = Repository::open(dir).unwrap();
    let mut index = repo.index().unwrap();
    index.read(true).unwrap();
    index
        .iter()
        .map(|e| String::from_utf8_lossy(&e.path).into_owned())
        .collect()
}

fn head_sha(dir: &Path) -> String {
    let repo = Repository::open(dir).unwrap();
    let id = repo.head().unwrap().target().unwrap();
    id.to_string()
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("not an array: {value}"))
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect()
}

// ---- Review Focus 1: a directory with spaces and an accent, reached with -C ------------

#[test]
fn dash_c_init_commit_status_and_log_work_in_a_directory_with_spaces_and_accents() {
    let sandbox = Sandbox::new();
    let dir = sandbox.unicode_dir();

    let init = sandbox.ok(&dir, &["init"]);
    assert!(
        stdout(&init).contains("Created a repository"),
        "{}",
        stdout(&init)
    );
    assert!(
        dir.join(".git").is_dir(),
        "the repository is in the -C directory"
    );
    assert_eq!(
        std::fs::read_dir(sandbox.elsewhere.path()).unwrap().count(),
        0,
        "nothing may be written to the working directory"
    );

    write(&dir, "a.txt", "one\n");
    write(&dir, ".gitignore", "dist/\n");
    write(&dir, "dist/out.js", "ignored\n");
    write(&dir, "src/ünï côdé.txt", "accented\n");
    write(&dir, "notes - OG.md", "spaces\n");
    let first = sandbox.json(&dir, &["commit", "-m", "first commit"]);
    assert_eq!(first["sha"].as_str().unwrap().len(), 40, "{first}");
    assert_eq!(
        strings(&first["files"]),
        [".gitignore", "a.txt", "notes - OG.md", "src/ünï côdé.txt"],
        "new files are staged, ignored ones are not"
    );
    assert_eq!(first["sha"].as_str().unwrap(), head_sha(&dir));
    let files = committed(&dir);
    assert_eq!(files["a.txt"], "one\n");
    assert_eq!(files["src/ünï côdé.txt"], "accented\n");
    assert_eq!(files["notes - OG.md"], "spaces\n");
    assert!(!files.contains_key("dist/out.js"));

    // A modified file and a new one; -C may follow the subcommand.
    write(&dir, "a.txt", "one, edited\n");
    write(&dir, "b.txt", "two\n");
    write(&dir, "dist/more.js", "ignored\n");
    let dir_arg = dir.to_str().unwrap();
    let second = sandbox.nsit_in(
        sandbox.elsewhere.path(),
        &["commit", "-m", "second commit", "--json", "-C", dir_arg],
    );
    assert_eq!(code(&second), 0, "{}", stderr(&second));
    let second: Value = serde_json::from_str(&stdout(&second)).unwrap();
    assert_eq!(strings(&second["files"]), ["a.txt", "b.txt"]);
    let files = committed(&dir);
    assert_eq!(files["a.txt"], "one, edited\n");
    assert_eq!(files["b.txt"], "two\n");
    assert_eq!(files["src/ünï côdé.txt"], "accented\n");

    // Nothing left to do: the status is clean and a commit says so.
    let status = sandbox.json(&dir, &["status"]);
    assert_eq!(
        status,
        serde_json::json!({
            "branch": "main", "upstream": null, "ahead": 0, "behind": 0,
            "staged": [], "unstaged": [], "untracked": [], "conflicted": []
        })
    );
    let again = sandbox.ok(&dir, &["commit", "-m", "nothing"]);
    assert_eq!(stdout(&again).trim_end(), "nothing to commit");
    assert_eq!(second["sha"].as_str().unwrap(), head_sha(&dir));

    let log = sandbox.json(&dir, &["log"]);
    let subjects: Vec<&str> = log
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["subject"].as_str().unwrap())
        .collect();
    assert_eq!(subjects, ["second commit", "first commit"]);
    assert_eq!(log[0]["author"], "Local Tester");
    assert_eq!(log[0]["email"], "tester@example.com");
    let oneline = stdout(&sandbox.ok(&dir, &["log", "--oneline", "-n", "1"]));
    assert_eq!(oneline, format!("{} second commit\n", &head_sha(&dir)[..7]));
}

#[test]
fn the_secret_guard_refuses_env_files_and_private_keys_in_that_directory() {
    let sandbox = Sandbox::new();
    let dir = sandbox.unicode_repo();
    let before = head_sha(&dir);

    write(&dir, ".env", "TOKEN=hunter2-super-secret\n");
    write(&dir, ".env.example", "TOKEN=\n");
    write(
        &dir,
        "notes/deploy.txt",
        "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAhidden-key-body\n",
    );
    write(&dir, "fine.txt", "fine\n");
    let refused = sandbox.nsit(&dir, &["commit", "-m", "x"]);
    assert_eq!(code(&refused), 5, "{}", stderr(&refused));
    assert_eq!(stdout(&refused), "");
    let message = stderr(&refused);
    assert!(message.contains(".env (name matches .env)"), "{message}");
    assert!(
        message.contains("notes/deploy.txt (contains a private key)"),
        "{message}"
    );
    assert!(
        !message.contains(".env.example"),
        "the example file passes: {message}"
    );
    assert!(
        message.contains("--allow-secret"),
        "it says how to override: {message}"
    );
    assert!(
        !message.contains("hunter2") && !message.contains("hidden-key-body"),
        "the secret must not be printed: {message}"
    );
    assert_eq!(head_sha(&dir), before, "no commit was made");

    // Without the two secrets the rest commits, the example file included.
    std::fs::remove_file(dir.join(".env")).unwrap();
    std::fs::remove_file(dir.join("notes/deploy.txt")).unwrap();
    let done = sandbox.json(&dir, &["commit", "-m", "the safe files"]);
    assert_eq!(strings(&done["files"]), [".env.example", "fine.txt"]);
}

#[test]
fn a_refused_commit_leaves_the_index_exactly_as_it_was() {
    let sandbox = Sandbox::new();
    let dir = sandbox.unicode_repo();
    let committed_before = staged(&dir);
    let head_before = head_sha(&dir);

    // Stage one new file, then add a secret and another new file.
    write(&dir, "staged.txt", "staged on purpose\n");
    sandbox.ok(&dir, &["add", "staged.txt"]);
    write(&dir, ".env", "TOKEN=abc\n");
    write(&dir, "never.txt", "never staged\n");
    let mut expected = committed_before.clone();
    expected.push("staged.txt".to_string());
    expected.sort();
    let on_disk_before = std::fs::read(dir.join(".git").join("index")).unwrap();
    assert_eq!(staged(&dir), expected);

    let refused = sandbox.nsit(&dir, &["commit", "-m", "x"]);
    assert_eq!(code(&refused), 5, "{}", stderr(&refused));

    // Byte for byte the same index file, so only staged.txt is staged.
    let on_disk_after = std::fs::read(dir.join(".git").join("index")).unwrap();
    assert_eq!(on_disk_after, on_disk_before, "the index file changed");
    assert_eq!(staged(&dir), expected);
    assert_eq!(head_sha(&dir), head_before);
    let status = sandbox.json(&dir, &["status"]);
    assert_eq!(strings(&status["staged"]), ["staged.txt"]);
    assert_eq!(strings(&status["untracked"]), [".env", "never.txt"]);
}

#[test]
fn a_private_key_in_a_file_that_looks_binary_is_refused() {
    let sandbox = Sandbox::new();
    let dir = sandbox.unicode_repo();
    let before = head_sha(&dir);
    // One stray NUL byte in front is all it takes to look binary.
    let mut key = vec![0u8];
    key.extend_from_slice(b"-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAhidden-key-body\n");
    std::fs::write(dir.join("deploy.dat"), &key).unwrap();
    let refused = sandbox.nsit(&dir, &["commit", "-m", "x"]);
    assert_eq!(code(&refused), 5, "{}", stderr(&refused));
    let message = stderr(&refused);
    assert!(
        message.contains("deploy.dat (contains a private key)"),
        "{message}"
    );
    assert!(!message.contains("hidden-key-body"), "{message}");
    assert_eq!(head_sha(&dir), before);
    assert_eq!(staged(&dir), ["a.txt"]);
}

#[test]
fn the_guard_applies_to_staged_commits_and_never_to_a_file_that_was_not_staged() {
    let sandbox = Sandbox::new();
    let dir = sandbox.unicode_repo();
    write(&dir, "id_rsa", "key\n");
    write(&dir, "ok.txt", "ok\n");
    sandbox.ok(&dir, &["add", "id_rsa"]);
    let refused = sandbox.nsit(&dir, &["commit", "-m", "x", "--staged"]);
    assert_eq!(code(&refused), 5, "{}", stderr(&refused));
    assert!(stderr(&refused).contains("id_rsa"), "{}", stderr(&refused));

    // Unstage nothing, but commit only what is staged after removing the key from it.
    let repo = Repository::open(&dir).unwrap();
    let mut index = repo.index().unwrap();
    index.remove_path(Path::new("id_rsa")).unwrap();
    index.write().unwrap();
    sandbox.ok(&dir, &["add", "ok.txt"]);
    let done = sandbox.json(&dir, &["commit", "-m", "just ok", "--staged"]);
    assert_eq!(strings(&done["files"]), ["ok.txt"]);
    assert!(
        dir.join("id_rsa").exists(),
        "the key file itself is untouched"
    );
}

#[test]
fn allow_secret_records_the_path_and_later_changes_to_it_commit_without_the_flag() {
    let sandbox = Sandbox::new();
    let dir = sandbox.unicode_repo();
    write(&dir, ".env", "TOKEN=abc\n");

    let done = sandbox.json(
        &dir,
        &["commit", "-m", "with env", "--allow-secret", ".env"],
    );
    assert_eq!(strings(&done["files"]), [".env", ".nsit-allow-secrets"]);
    let recorded = read(&dir, ".nsit-allow-secrets");
    assert!(recorded.lines().any(|line| line == ".env"), "{recorded:?}");
    let files = committed(&dir);
    assert_eq!(files[".env"], "TOKEN=abc\n");
    assert_eq!(
        files[".nsit-allow-secrets"], recorded,
        "the allowance is in the commit"
    );

    // The exception is in history, so it holds for the next commit too.
    write(&dir, ".env", "TOKEN=changed\n");
    let later = sandbox.json(&dir, &["commit", "-m", "update env"]);
    assert_eq!(strings(&later["files"]), [".env"]);
    assert_eq!(committed(&dir)[".env"], "TOKEN=changed\n");

    // It was for that path only.
    write(&dir, "other.pem", "x\n");
    let refused = sandbox.nsit(&dir, &["commit", "-m", "x"]);
    assert_eq!(code(&refused), 5, "{}", stderr(&refused));
    assert!(
        stderr(&refused).contains("other.pem"),
        "{}",
        stderr(&refused)
    );
}

#[test]
fn a_bad_second_allow_secret_path_records_nothing_for_the_first() {
    let sandbox = Sandbox::new();
    let dir = sandbox.unicode_repo();
    let before = head_sha(&dir);
    write(&dir, ".env", "TOKEN=abc\n");
    // In the commit, but a name the allow file cannot hold (it would read as a comment).
    write(&dir, "#notes.env", "x\n");
    let out = sandbox.nsit(
        &dir,
        &[
            "commit",
            "-m",
            "x",
            "--allow-secret",
            ".env",
            "--allow-secret",
            "#notes.env",
        ],
    );
    assert_eq!(code(&out), 2, "{}", stderr(&out));
    assert!(stderr(&out).contains("#notes.env"), "{}", stderr(&out));
    assert!(
        !dir.join(".nsit-allow-secrets").exists(),
        "the first path was recorded"
    );
    assert_eq!(staged(&dir), ["a.txt"]);
    assert_eq!(head_sha(&dir), before);
}

#[test]
fn allow_secret_for_a_file_that_is_not_in_the_commit_is_a_usage_error() {
    let sandbox = Sandbox::new();
    let dir = sandbox.unicode_repo();
    write(&dir, "a.txt", "changed\n");
    let bad = sandbox.nsit(&dir, &["commit", "-m", "x", "--allow-secret", "typo.env"]);
    assert_eq!(code(&bad), 2, "{}", stderr(&bad));
    assert!(stderr(&bad).contains("typo.env"), "{}", stderr(&bad));
    assert!(!dir.join(".nsit-allow-secrets").exists());
}

#[test]
fn switch_restores_files_and_refuses_to_overwrite_changes_in_that_directory() {
    let sandbox = Sandbox::new();
    let dir = sandbox.unicode_repo();

    let made = sandbox.json(&dir, &["switch", "-c", "feature"]);
    assert_eq!(made["branch"], "feature");
    assert_eq!(made["created"], true);
    write(&dir, "a.txt", "feature version\n");
    write(&dir, "only-on-feature.txt", "x\n");
    sandbox.ok(&dir, &["commit", "-m", "feature work"]);

    sandbox.ok(&dir, &["switch", "main"]);
    assert_eq!(read(&dir, "a.txt"), "one\n", "main's file is back");
    assert!(!dir.join("only-on-feature.txt").exists());
    assert_eq!(sandbox.json(&dir, &["status"])["branch"], "main");

    // An uncommitted edit of a file that is different on the target.
    write(&dir, "a.txt", "my unsaved work\n");
    let refused = sandbox.nsit(&dir, &["switch", "feature"]);
    assert_eq!(code(&refused), 1, "{}", stderr(&refused));
    assert!(stderr(&refused).contains("a.txt"), "{}", stderr(&refused));
    assert_eq!(
        read(&dir, "a.txt"),
        "my unsaved work\n",
        "the file is untouched"
    );
    assert!(!dir.join("only-on-feature.txt").exists());
    assert_eq!(sandbox.json(&dir, &["status"])["branch"], "main");

    // Committed, the move works and brings the other side's files.
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    sandbox.ok(&dir, &["switch", "feature"]);
    assert_eq!(read(&dir, "a.txt"), "feature version\n");
    assert_eq!(read(&dir, "only-on-feature.txt"), "x\n");
}

#[test]
fn switch_never_overwrites_an_ignored_file_and_refuses_in_the_middle_of_a_merge_with_exit_2() {
    let sandbox = Sandbox::new();
    let dir = sandbox.unicode_repo();
    sandbox.ok(&dir, &["switch", "-c", "feature"]);
    write(&dir, "settings.local", "from the feature branch\n");
    sandbox.ok(&dir, &["commit", "-m", "feature settings"]);
    sandbox.ok(&dir, &["switch", "main"]);
    assert!(!dir.join("settings.local").exists());

    // On main the same name is the person's own file, which they keep out of git's sight
    // (locally, in .git/info/exclude), as people do with local settings and build output.
    let info = dir.join(".git").join("info");
    std::fs::create_dir_all(&info).unwrap();
    std::fs::write(info.join("exclude"), "settings.local\n").unwrap();
    write(&dir, "settings.local", "my own settings\n");
    assert!(
        !stdout(&sandbox.ok(&dir, &["status"])).contains("settings.local"),
        "ignored, so status does not show it"
    );
    let refused = sandbox.nsit(&dir, &["switch", "feature"]);
    assert_eq!(code(&refused), 1, "{}", stderr(&refused));
    assert!(
        stderr(&refused).contains("settings.local"),
        "{}",
        stderr(&refused)
    );
    assert_eq!(read(&dir, "settings.local"), "my own settings\n");
    assert_eq!(sandbox.json(&dir, &["status"])["branch"], "main");

    // In the middle of a merge nothing is switched: a usage error, as `nsit pull` says too.
    std::fs::remove_file(dir.join("settings.local")).unwrap();
    std::fs::write(
        dir.join(".git").join("MERGE_HEAD"),
        format!("{}\n", head_sha(&dir)),
    )
    .unwrap();
    let during = sandbox.nsit(&dir, &["switch", "feature"]);
    assert_eq!(code(&during), 2, "{}", stderr(&during));
    assert!(
        stderr(&during).contains("merge is in progress"),
        "{}",
        stderr(&during)
    );
    assert_eq!(sandbox.json(&dir, &["status"])["branch"], "main");
}

#[test]
fn switching_to_a_branch_that_is_not_there_is_exit_2_with_a_hint() {
    let sandbox = Sandbox::new();
    let dir = sandbox.unicode_repo();
    let out = sandbox.nsit(&dir, &["switch", "nope"]);
    assert_eq!(code(&out), 2, "{}", stderr(&out));
    assert!(
        stderr(&out).contains("nsit switch -c nope"),
        "{}",
        stderr(&out)
    );
}

#[test]
fn add_branch_and_status_work_in_that_directory() {
    let sandbox = Sandbox::new();
    let dir = sandbox.unicode_repo();
    write(&dir, "src/ünï côdé.txt", "accented\n");
    write(&dir, "plain.txt", "plain\n");
    write(&dir, ".gitignore", "dist/\n");
    write(&dir, "dist/out.js", "x\n");

    let added = sandbox.json(&dir, &["add", "src"]);
    assert_eq!(strings(&added["staged"]), ["src/ünï côdé.txt"]);
    let status = sandbox.json(&dir, &["status"]);
    assert_eq!(strings(&status["staged"]), ["src/ünï côdé.txt"]);
    assert_eq!(strings(&status["untracked"]), [".gitignore", "plain.txt"]);
    let text = stdout(&sandbox.ok(&dir, &["status"]));
    assert!(text.contains("Staged:\n  A  src/ünï côdé.txt"), "{text}");

    // An ignored path that is named is refused; one that is not there as well.
    let ignored = sandbox.nsit(&dir, &["add", "dist"]);
    assert_eq!(code(&ignored), 2, "{}", stderr(&ignored));
    assert!(
        stderr(&ignored).contains("dist is ignored by .gitignore"),
        "{}",
        stderr(&ignored)
    );
    let missing = sandbox.nsit(&dir, &["add", "nowhere.txt"]);
    assert_eq!(code(&missing), 2, "{}", stderr(&missing));
    assert_eq!(
        staged(&dir),
        ["a.txt", "src/ünï côdé.txt"],
        "a refused add stages nothing"
    );

    sandbox.ok(&dir, &["branch", "topic"]);
    let list = stdout(&sandbox.ok(&dir, &["branch"]));
    assert_eq!(list, "* main\n  topic\n");
    let json = sandbox.json(&dir, &["branch"]);
    assert_eq!(json[0]["name"], "main");
    assert_eq!(json[0]["current"], true);
    let deleted = sandbox.json(&dir, &["branch", "-d", "topic"]);
    assert_eq!(deleted["action"], "deleted");
    assert_eq!(stdout(&sandbox.ok(&dir, &["branch"])), "* main\n");
    let current = sandbox.nsit(&dir, &["branch", "-d", "main"]);
    assert_eq!(code(&current), 1, "{}", stderr(&current));
}

#[test]
fn init_readme_in_that_directory_writes_and_commits_only_the_readme() {
    let sandbox = Sandbox::new();
    let dir = sandbox.unicode_dir();
    write(&dir, "other.txt", "not in the first commit\n");
    let done = sandbox.json(&dir, &["init", "--readme"]);
    assert_eq!(done["created"], true);
    assert_eq!(done["readme"], true);
    assert_eq!(done["remote"], Value::Null);
    assert_eq!(done["pushed"], false);
    assert_eq!(done["commit"].as_str().unwrap(), head_sha(&dir));

    let files = committed(&dir);
    let names: Vec<&str> = files.keys().map(String::as_str).collect();
    assert_eq!(names, ["README.md"]);
    assert!(
        files["README.md"].starts_with("# Vidéo Ink - OG Edition\n"),
        "{}",
        files["README.md"]
    );
    assert!(files["README.md"].contains("nsit clone <owner>/<name>"));
    let log = sandbox.json(&dir, &["log"]);
    assert_eq!(log[0]["subject"], "Initial commit");

    // Again: nothing is made twice and nothing is overwritten.
    let readme = read(&dir, "README.md");
    let again = sandbox.json(&dir, &["init", "--readme"]);
    assert_eq!(again["created"], false);
    assert_eq!(again["readme"], false);
    assert_eq!(again["commit"], Value::Null);
    assert_eq!(read(&dir, "README.md"), readme);
}

#[test]
fn init_readme_in_an_existing_repository_commits_only_the_readme_and_leaves_staged_work_staged() {
    let sandbox = Sandbox::new();
    let dir = sandbox.unicode_repo();
    write(&dir, "a.txt", "changed and staged\n");
    write(&dir, "new.txt", "new and staged\n");
    sandbox.ok(&dir, &["add", "a.txt", "new.txt"]);
    let before = head_sha(&dir);

    let done = sandbox.json(&dir, &["init", "--readme"]);
    assert_eq!(done["created"], false);
    assert_eq!(done["readme"], true);
    assert_eq!(done["commit"].as_str().unwrap(), head_sha(&dir));
    assert_ne!(head_sha(&dir), before);

    // The commit has the README on top of what was committed: none of the staged work.
    let files = committed(&dir);
    let names: Vec<&str> = files.keys().map(String::as_str).collect();
    assert_eq!(names, ["README.md", "a.txt"]);
    assert_eq!(files["a.txt"], "one\n", "the staged change did not go in");
    let log = sandbox.json(&dir, &["log"]);
    assert_eq!(log[0]["subject"], "Add README");

    // It is all still staged, and the README is not shown as changed.
    let status = sandbox.json(&dir, &["status"]);
    let staged_now = strings(&status["staged"]);
    assert!(
        staged_now.iter().any(|path| path.contains("new.txt")),
        "{status}"
    );
    assert!(
        staged_now.iter().any(|path| path.contains("a.txt")),
        "{status}"
    );
    assert!(
        !staged_now.iter().any(|path| path.contains("README.md")),
        "{status}"
    );
    assert_eq!(
        strings(&status["unstaged"]),
        Vec::<String>::new(),
        "{status}"
    );
    assert!(staged(&dir).contains(&"new.txt".to_string()));
}

#[test]
fn the_readme_command_never_overwrites_a_readme() {
    let sandbox = Sandbox::new();
    let dir = sandbox.unicode_dir();
    sandbox.ok(&dir, &["init"]);
    let wrote = sandbox.ok(&dir, &["readme"]);
    assert_eq!(stdout(&wrote).trim_end(), "wrote README.md");
    let first = read(&dir, "README.md");
    assert!(first.starts_with("# Vidéo Ink - OG Edition\n"), "{first}");

    write(&dir, "README.md", "# mine\n");
    let refused = sandbox.nsit(&dir, &["readme"]);
    assert_eq!(code(&refused), 1, "{}", stderr(&refused));
    assert!(
        stderr(&refused).contains("README.md already exists"),
        "{}",
        stderr(&refused)
    );
    assert_eq!(read(&dir, "README.md"), "# mine\n");
}

/// Review Focus 3 as far as nsit's own commands go (`nsit clone` has its own test): with
/// `core.autocrlf=true` a checkout writes CRLF into the working files, and the status must
/// still be clean and a commit must have nothing to commit.
#[test]
fn with_autocrlf_true_a_checkout_that_writes_crlf_leaves_status_clean() {
    let sandbox = Sandbox::new();
    let dir = sandbox.unicode_dir();
    sandbox.ok(&dir, &["init"]);
    write(&dir, "text.txt", "one\ntwo\n");
    sandbox.ok(&dir, &["commit", "-m", "base"]);
    sandbox.ok(&dir, &["switch", "-c", "other"]);
    write(&dir, "text.txt", "one\ntwo\nthree\n");
    sandbox.ok(&dir, &["commit", "-m", "other"]);

    // From here on every run converts line endings, as git does for this setting.
    sandbox.set_autocrlf("true");
    sandbox.ok(&dir, &["switch", "main"]);
    let on_disk = std::fs::read(dir.join("text.txt")).unwrap();
    assert_eq!(
        on_disk, b"one\r\ntwo\r\n",
        "the checkout must have converted to CRLF"
    );

    let status = sandbox.json(&dir, &["status"]);
    assert_eq!(
        strings(&status["unstaged"]),
        Vec::<String>::new(),
        "{status}"
    );
    assert_eq!(strings(&status["staged"]), Vec::<String>::new(), "{status}");
    let again = sandbox.ok(&dir, &["commit", "-m", "nothing"]);
    assert_eq!(stdout(&again).trim_end(), "nothing to commit");
    // The repository still holds LF, whatever the working file looks like.
    assert_eq!(committed(&dir)["text.txt"], "one\ntwo\n");

    // A real edit is still seen, and committed as LF.
    std::fs::write(dir.join("text.txt"), b"one\r\ntwo\r\nfour\r\n").unwrap();
    let edited = sandbox.json(&dir, &["commit", "-m", "edit"]);
    assert_eq!(strings(&edited["files"]), ["text.txt"]);
    assert_eq!(committed(&dir)["text.txt"], "one\ntwo\nfour\n");
}

// ---- -C and the working directory -------------------------------------------------------

#[test]
fn a_relative_dash_c_is_taken_from_the_working_directory() {
    let sandbox = Sandbox::new();
    sandbox.unicode_repo();
    let out = sandbox.nsit_in(
        sandbox.root.path(),
        &["-C", UNICODE_DIR, "status", "--json"],
    );
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    let status: Value = serde_json::from_str(&stdout(&out)).unwrap();
    assert_eq!(status["branch"], "main");
    // And from inside a subdirectory of the repository, no -C needed.
    let sub = sandbox.root.path().join(UNICODE_DIR).join("deeper dir");
    std::fs::create_dir(&sub).unwrap();
    let inside = sandbox.nsit_in(&sub, &["status", "--json"]);
    assert_eq!(code(&inside), 0, "{}", stderr(&inside));
    write(&sub, "here.txt", "x\n");
    let added = sandbox.nsit_in(&sub, &["add", "here.txt", "--json"]);
    assert_eq!(code(&added), 0, "{}", stderr(&added));
    let added: Value = serde_json::from_str(&stdout(&added)).unwrap();
    assert_eq!(strings(&added["staged"]), ["deeper dir/here.txt"]);
}

#[test]
fn dash_c_that_is_not_a_directory_or_not_a_repository_is_exit_2() {
    let sandbox = Sandbox::new();
    let missing = sandbox.root.path().join("no such dir");
    let out = sandbox.nsit(&missing, &["status"]);
    assert_eq!(code(&out), 2, "{}", stderr(&out));
    assert!(stderr(&out).contains("not a directory"), "{}", stderr(&out));

    let empty = sandbox.unicode_dir();
    if empty.ancestors().any(|p| p.join(".git").exists()) {
        eprintln!("skipped the not-a-repository check: the temp dir is inside a repository");
        return;
    }
    let out = sandbox.nsit(&empty, &["status"]);
    assert_eq!(code(&out), 2, "{}", stderr(&out));
    assert_eq!(stderr(&out), "nsit: not a git repository (run nsit init)\n");
    assert_eq!(stdout(&out), "");
}

#[test]
fn commit_needs_a_message_and_says_so_with_exit_2() {
    let sandbox = Sandbox::new();
    let dir = sandbox.unicode_repo();
    write(&dir, "a.txt", "changed\n");
    let out = sandbox.nsit(&dir, &["commit"]);
    assert_eq!(code(&out), 2, "{}", stderr(&out));
    assert!(stderr(&out).contains("nsit commit -m"), "{}", stderr(&out));
    assert_eq!(staged(&dir), ["a.txt"]);
    assert_eq!(committed(&dir)["a.txt"], "one\n", "nothing was committed");
}

// ---- init with a name ------------------------------------------------------------------

#[test]
fn init_with_a_name_signed_out_is_exit_3_and_creates_nothing() {
    let sandbox = Sandbox::new();
    let cwd = sandbox.root.path();
    let out = sandbox.nsit_in(cwd, &["init", "demo", "--host", "http://127.0.0.1:9"]);
    assert_eq!(code(&out), 3, "{}", stderr(&out));
    assert_eq!(
        stderr(&out),
        "nsit: not signed in to 127.0.0.1:9; run nsit auth login\n"
    );
    assert!(
        !cwd.join("demo").exists(),
        "no directory may be left behind"
    );

    let out = sandbox.nsit_in(cwd, &["init", "--remote", "--host", "http://127.0.0.1:9"]);
    assert_eq!(code(&out), 3, "{}", stderr(&out));
    assert!(!cwd.join(".git").exists());
}

#[test]
fn init_with_a_name_the_server_would_refuse_is_exit_2_and_creates_nothing() {
    let sandbox = Sandbox::new();
    let cwd = sandbox.root.path();
    for bad in ["Vidéo Ink", "a b", "x.git", ".."] {
        let out = sandbox.nsit_in(cwd, &["init", bad, "--host", "http://127.0.0.1:9"]);
        assert_eq!(code(&out), 2, "{bad}: {}", stderr(&out));
    }
    assert_eq!(std::fs::read_dir(cwd).unwrap().count(), 0);
    // A directory with such a name cannot name the repository either.
    let dir = sandbox.unicode_dir();
    let out = sandbox.nsit(&dir, &["init", "--remote", "--host", "http://127.0.0.1:9"]);
    assert_eq!(code(&out), 2, "{}", stderr(&out));
    assert!(
        stderr(&out).contains("nsit init <name>"),
        "{}",
        stderr(&out)
    );
    assert!(!dir.join(".git").exists());
}

#[test]
fn plain_init_makes_a_repository_on_main_and_a_second_init_leaves_it_alone() {
    let sandbox = Sandbox::new();
    let dir = sandbox.root.path().join("plain");
    std::fs::create_dir(&dir).unwrap();
    let first = sandbox.json(&dir, &["init"]);
    assert_eq!(first["created"], true);
    assert_eq!(first["branch"], "main");
    assert_eq!(first["remote"], Value::Null);
    let head = std::fs::read_to_string(dir.join(".git").join("HEAD")).unwrap();
    assert_eq!(head.trim_end(), "ref: refs/heads/main");
    let config_before = std::fs::read(dir.join(".git").join("config")).unwrap();
    let second = sandbox.json(&dir, &["init"]);
    assert_eq!(second["created"], false);
    assert_eq!(
        std::fs::read(dir.join(".git").join("config")).unwrap(),
        config_before
    );
    let text = stdout(&sandbox.ok(&dir, &["init"]));
    assert!(text.contains("already exists"), "{text}");
}

// ---- output --------------------------------------------------------------------------------

#[test]
fn jq_works_on_the_local_commands() {
    let sandbox = Sandbox::new();
    let dir = sandbox.unicode_repo();
    let branch = sandbox.ok(&dir, &["status", "--jq", ".branch"]);
    assert_eq!(stdout(&branch), "main\n");
    let subject = sandbox.ok(&dir, &["log", "--jq", ".[0].subject"]);
    assert_eq!(stdout(&subject), "first\n");
    let ahead = sandbox.ok(&dir, &["status", "--jq", ".ahead"]);
    assert_eq!(stdout(&ahead), "0\n");
}

#[test]
fn log_and_branch_on_a_repository_with_no_commits_are_empty_not_errors() {
    let sandbox = Sandbox::new();
    let dir = sandbox.unicode_dir();
    sandbox.ok(&dir, &["init"]);
    assert_eq!(sandbox.json(&dir, &["log"]), serde_json::json!([]));
    assert_eq!(sandbox.json(&dir, &["branch"]), serde_json::json!([]));
    let status = sandbox.json(&dir, &["status"]);
    assert_eq!(status["branch"], "main");
    let text = stdout(&sandbox.ok(&dir, &["status"]));
    assert!(text.contains("No commits yet."), "{text}");
    let nothing = sandbox.ok(&dir, &["commit", "-m", "x"]);
    assert_eq!(stdout(&nothing).trim_end(), "nothing to commit");
}
