//! The secret guard: what `nsit commit` refuses to commit.
//!
//! A path is refused when its **name** looks like a secret (`.env`, `*.pem`,
//! `id_rsa*`, ...) or its **content** holds an obvious one (a private key
//! header, an Insitio, GitHub or AWS token). Both are judged on the *staged*
//! blob, the bytes that would be committed, not on the working file.
//!
//! Limits, so a commit stays fast and cannot be made to read gigabytes: only
//! the first 1 MiB of a blob is scanned, and a blob with a NUL byte in its
//! first 8 KiB counts as binary and is not scanned (its name still is).
//!
//! **Overrides are recorded.** `.nsit-allow-secrets`, in the repository root and
//! committed like any file, lists one repository-relative path per line (forward
//! slashes, `#` starts a comment, blank lines are ignored, exact match, no
//! patterns). The copy that counts is the staged one, so an allowance takes
//! effect in the same commit that records it, and an uncommitted edit of the
//! working file does not count. `allow` appends a path and stages the file.
//!
//! A hit names the path and *why* ("name matches .env", "contains a private
//! key"). The matched text is never part of a hit, an error or any output.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use git2::{Index, Repository};
use regex::bytes::Regex;

use super::paths::{slash, workdir};
use super::stage::{entry, read_start};
use crate::error::{NsitError, SecretHit};

/// The file that lists the paths the guard lets through.
pub const ALLOW_FILE: &str = ".nsit-allow-secrets";

/// How much of a blob is scanned.
const SCAN_LIMIT: usize = 1024 * 1024;
/// How much of a blob decides whether it is binary.
const BINARY_PROBE: usize = 8 * 1024;
/// A longer allow file is not read past this (it lists paths; it is small).
const ALLOW_FILE_LIMIT: usize = 1024 * 1024;
/// Index mode of a submodule entry: its blob is a commit, not a file.
const GITLINK: u32 = 0o160_000;

// ---- what counts as a secret ---------------------------------------------------------

/// Why `path` is refused for its **name**, or `None`. Matched on the last
/// part of the path, at any depth, ignoring case (Windows and macOS file
/// systems do not tell `.ENV` from `.env`). `.npmrc` and `.pypirc` are judged
/// on their content (`content_hit`), not here.
pub fn name_hit(path: &str) -> Option<String> {
    let base = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    let pattern = if base == ".env" {
        ".env"
    } else if base.starts_with(".env.") && base != ".env.example" && base != ".env.sample" {
        ".env.*"
    } else if base.ends_with(".pem") {
        "*.pem"
    } else if base.ends_with(".key") {
        "*.key"
    } else if base.starts_with("id_rsa") {
        "id_rsa*"
    } else if base.starts_with("id_ed25519") {
        "id_ed25519*"
    } else if base.ends_with(".p12") {
        "*.p12"
    } else if base.ends_with(".pfx") {
        "*.pfx"
    } else if base == "credentials.json" {
        "credentials.json"
    } else {
        return None;
    };
    Some(format!("name matches {pattern}"))
}

struct ContentRule {
    pattern: Regex,
    reason: &'static str,
}

fn content_rules() -> &'static [ContentRule] {
    static RULES: OnceLock<Vec<ContentRule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let rule = |pattern: &str, reason| ContentRule {
            pattern: Regex::new(pattern).expect("a valid built-in pattern"),
            reason,
        };
        vec![
            rule(
                r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
                "contains a private key",
            ),
            rule(r"(gfk|ins)_[A-Za-z0-9_-]{30,}", "contains an Insitio token"),
            rule(r"gh[pousr]_[A-Za-z0-9]{36,}", "contains a GitHub token"),
            rule(r"AKIA[0-9A-Z]{16}", "contains an AWS access key"),
        ]
    })
}

/// `.npmrc` / `.pypirc` lines that carry a login.
fn auth_line() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)_authtoken|password").expect("a valid built-in pattern"))
}

/// Why `content` (the start of the staged file at `path`) is refused, or
/// `None`. Binary content is not looked at.
pub fn content_hit(path: &str, content: &[u8]) -> Option<&'static str> {
    let probe = &content[..content.len().min(BINARY_PROBE)];
    if probe.contains(&0) {
        return None;
    }
    if let Some(rule) = content_rules()
        .iter()
        .find(|rule| rule.pattern.is_match(content))
    {
        return Some(rule.reason);
    }
    let base = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    if matches!(base.as_str(), ".npmrc" | ".pypirc") && auth_line().is_match(content) {
        return Some("contains credentials");
    }
    None
}

// ---- the allow file ------------------------------------------------------------------

/// The paths a text of `.nsit-allow-secrets` allows: trimmed lines, without
/// blank lines and `#` comments.
pub fn parse_allow_list(text: &str) -> BTreeSet<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .collect()
}

/// The paths allowed by the staged copy of `.nsit-allow-secrets`.
pub fn allowed_paths(repo: &Repository, index: &Index) -> Result<BTreeSet<String>, NsitError> {
    let Some(file) = entry(index, ALLOW_FILE) else {
        return Ok(BTreeSet::new());
    };
    let bytes = read_start(repo, file.id, ALLOW_FILE_LIMIT)?;
    Ok(parse_allow_list(&String::from_utf8_lossy(&bytes)))
}

/// Let `path` (repository-relative, forward slashes) through the guard: append
/// it to `.nsit-allow-secrets` unless it is listed, and stage that file, so the
/// allowance is committed with the commit that needed it.
pub fn allow(repo: &Repository, path: &str) -> Result<(), NsitError> {
    if path.is_empty()
        || path.trim() != path
        || path.starts_with('#')
        || path.contains(['\n', '\r'])
    {
        return Err(NsitError::Usage(format!(
            "cannot record {path:?} in {ALLOW_FILE}: a path there is one line, \
             without surrounding spaces, and cannot start with #"
        )));
    }
    let file = workdir(repo)?.join(ALLOW_FILE);
    let mut bytes = match std::fs::read(&file) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e.into()),
    };
    if !parse_allow_list(&String::from_utf8_lossy(&bytes)).contains(path) {
        if !bytes.is_empty() && !bytes.ends_with(b"\n") {
            bytes.push(b'\n');
        }
        bytes.extend_from_slice(path.as_bytes());
        bytes.push(b'\n');
        std::fs::write(&file, bytes)?;
    }
    let mut index = repo.index()?;
    index.add_path(Path::new(ALLOW_FILE))?;
    index.write()?;
    Ok(())
}

// ---- scanning ------------------------------------------------------------------------

/// Check the staged files at `candidates` (repository-relative paths) against
/// the guard. "Staged" is the repository's index as it is in memory now, which
/// is what `commit` has just filled and not yet written: a refusal can leave the
/// index file untouched because nothing here needs it on disk. Paths allowed in
/// `.nsit-allow-secrets` are skipped. One hit per refused path, sorted.
pub fn scan(repo: &Repository, candidates: &[PathBuf]) -> Result<Vec<SecretHit>, NsitError> {
    let index = repo.index()?;
    scan_index(repo, &index, candidates)
}

fn scan_index(
    repo: &Repository,
    index: &Index,
    candidates: &[PathBuf],
) -> Result<Vec<SecretHit>, NsitError> {
    let allowed = allowed_paths(repo, index)?;
    let mut hits = Vec::new();
    for candidate in candidates {
        let path = slash(candidate);
        if allowed.contains(&path) {
            continue;
        }
        // Not staged (it was deleted): nothing would be committed.
        let Some(staged) = entry(index, &path) else {
            continue;
        };
        if staged.mode == GITLINK {
            continue;
        }
        let reason = match name_hit(&path) {
            Some(reason) => Some(reason),
            None => {
                let start = read_start(repo, staged.id, SCAN_LIMIT)?;
                content_hit(&path, &start).map(str::to_string)
            }
        };
        if let Some(reason) = reason {
            hits.push(SecretHit { path, reason });
        }
    }
    hits.sort_by(|a, b| a.path.cmp(&b.path));
    hits.dedup_by(|a, b| a.path == b.path);
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::stage::stage_all;
    use crate::test_support::local_repo;

    // ---- names ---------------------------------------------------------------------

    #[test]
    fn secret_looking_names_are_flagged_at_any_depth() {
        for path in [
            ".env",
            "src/.env",
            "deep/er/.env",
            ".env.local",
            ".env.production",
            ".env.example.bak",
            "app/.ENV",
            "server.pem",
            "tls/server.PEM",
            "x/y/tls.key",
            "id_rsa",
            "id_rsa.pub",
            "home/.ssh/id_rsa_work",
            "id_ed25519",
            "id_ed25519.pub",
            "cert.p12",
            "cert.pfx",
            "credentials.json",
            "gcp/credentials.json",
        ] {
            let reason = name_hit(path).unwrap_or_else(|| panic!("{path} should be flagged"));
            assert!(reason.starts_with("name matches "), "{reason}");
        }
    }

    #[test]
    fn ordinary_names_and_the_example_env_files_pass() {
        for path in [
            ".env.example",
            ".env.sample",
            "config/.env.example",
            "app/.Env.Sample",
            "environment.ts",
            "env.txt",
            "dotenv/readme.md",
            "key.txt",
            "keyboard.rs",
            "my-credentials.json",
            "credentials.json.md",
            "README.md",
            "src/main.rs",
            ".npmrc",
            ".pypirc",
        ] {
            assert_eq!(name_hit(path), None, "{path} should pass");
        }
    }

    #[test]
    fn a_name_hit_says_which_pattern_matched() {
        assert_eq!(name_hit(".env").unwrap(), "name matches .env");
        assert_eq!(name_hit(".env.dev").unwrap(), "name matches .env.*");
        assert_eq!(name_hit("a.pem").unwrap(), "name matches *.pem");
        assert_eq!(name_hit("id_rsa").unwrap(), "name matches id_rsa*");
    }

    // ---- content -------------------------------------------------------------------

    #[test]
    fn private_key_headers_are_flagged() {
        for header in [
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            "-----BEGIN RSA PRIVATE KEY-----",
            "-----BEGIN EC PRIVATE KEY-----",
            "-----BEGIN PRIVATE KEY-----",
            "-----BEGIN ENCRYPTED PRIVATE KEY-----",
        ] {
            let text = format!("notes\n{header}\nabc\n");
            assert_eq!(
                content_hit("notes.txt", text.as_bytes()),
                Some("contains a private key"),
                "{header}"
            );
        }
        for harmless in [
            "-----BEGIN PUBLIC KEY-----",
            "-----BEGIN CERTIFICATE-----",
            "BEGIN PRIVATE KEY",
        ] {
            assert_eq!(
                content_hit("a.txt", harmless.as_bytes()),
                None,
                "{harmless}"
            );
        }
    }

    #[test]
    fn insitio_github_and_aws_tokens_are_flagged() {
        let ins = format!("ins_{}", "a1B2-_".repeat(5));
        let gfk = format!("gfk_{}", "x".repeat(30));
        assert_eq!(
            content_hit("a.txt", format!("token={ins}").as_bytes()),
            Some("contains an Insitio token")
        );
        assert_eq!(
            content_hit("a.txt", gfk.as_bytes()),
            Some("contains an Insitio token")
        );
        // One character short: not a token.
        assert_eq!(
            content_hit("a.txt", format!("ins_{}", "a".repeat(29)).as_bytes()),
            None
        );

        for prefix in ["ghp", "gho", "ghu", "ghs", "ghr"] {
            let token = format!("{prefix}_{}", "Z9".repeat(18));
            assert_eq!(
                content_hit("a.txt", token.as_bytes()),
                Some("contains a GitHub token"),
                "{prefix}"
            );
        }
        assert_eq!(
            content_hit("a.txt", format!("ghp_{}", "a".repeat(35)).as_bytes()),
            None
        );
        assert_eq!(
            content_hit("a.txt", format!("ghx_{}", "a".repeat(40)).as_bytes()),
            None
        );

        assert_eq!(
            content_hit("a.txt", b"key = AKIAIOSFODNN7EXAMPLE"),
            Some("contains an AWS access key")
        );
        assert_eq!(content_hit("a.txt", b"AKIAIOSFODNN7EXAMPL"), None);
        assert_eq!(content_hit("a.txt", b"akiaiosfodnn7example1"), None);
    }

    #[test]
    fn npmrc_and_pypirc_are_flagged_only_with_an_auth_line() {
        let npm_token = b"//registry.npmjs.org/:_authToken=abc123\n";
        assert_eq!(
            content_hit(".npmrc", npm_token),
            Some("contains credentials")
        );
        assert_eq!(
            content_hit("web/.npmrc", b"//host/:_AUTHTOKEN=x"),
            Some("contains credentials")
        );
        assert_eq!(
            content_hit(".pypirc", b"[pypi]\nusername = me\npassword = hunter2\n"),
            Some("contains credentials")
        );
        assert_eq!(
            content_hit(".npmrc", b"registry=https://r.example/\n"),
            None
        );
        assert_eq!(
            content_hit(".pypirc", b"[distutils]\nindex-servers = pypi\n"),
            None
        );
        // The same words in an ordinary file are not a finding.
        assert_eq!(
            content_hit("notes.txt", b"the password is in the vault"),
            None
        );
    }

    #[test]
    fn a_reason_never_contains_the_secret() {
        let secret = format!("ins_{}", "q".repeat(40));
        let text = format!("-----BEGIN RSA PRIVATE KEY-----\n{secret}\nAKIAIOSFODNN7EXAMPLE");
        let reason = content_hit("a.txt", text.as_bytes()).unwrap();
        assert!(
            !reason.contains("qqqq") && !reason.contains("AKIA"),
            "{reason}"
        );
    }

    #[test]
    fn binary_content_is_not_scanned_but_a_late_nul_is_not_binary() {
        let mut binary = b"\x89PNG\r\n\x1a\n\0\0".to_vec();
        binary.extend_from_slice(b"-----BEGIN PRIVATE KEY-----");
        assert_eq!(content_hit("logo.png", &binary), None);

        let mut late = vec![b'a'; BINARY_PROBE];
        late.push(0);
        late.extend_from_slice(b"-----BEGIN PRIVATE KEY-----");
        assert_eq!(
            content_hit("odd.txt", &late),
            Some("contains a private key")
        );
    }

    // ---- the allow file ------------------------------------------------------------

    #[test]
    fn the_allow_file_ignores_comments_blanks_and_whitespace() {
        let list = parse_allow_list(
            "# why these are fine\n\n.env\r\n  config/.env.local  \n#.hidden\n\t\nsecrets/a b.pem\n",
        );
        let want: BTreeSet<String> = [".env", "config/.env.local", "secrets/a b.pem"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(list, want);
    }

    #[test]
    fn allow_entries_are_exact_paths_not_patterns() {
        let list = parse_allow_list("*.pem\n.env*\nsrc/\n");
        assert!(list.contains("*.pem") && !list.contains("a.pem"));
    }

    // ---- scanning staged files -----------------------------------------------------

    fn write(repo: &Repository, rel: &str, content: impl AsRef<[u8]>) {
        let path = repo.workdir().unwrap().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn staged(repo: &Repository) -> Index {
        let mut index = repo.index().unwrap();
        stage_all(&mut index).unwrap();
        index
    }

    fn paths(names: &[&str]) -> Vec<PathBuf> {
        names.iter().map(PathBuf::from).collect()
    }

    fn hit_paths(hits: &[SecretHit]) -> Vec<&str> {
        hits.iter().map(|h| h.path.as_str()).collect()
    }

    #[test]
    fn scan_flags_names_and_contents_of_staged_files_only() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, ".env", "KEY=1\n");
        write(&repo, ".env.example", "KEY=\n");
        write(
            &repo,
            "notes/deploy.txt",
            "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n",
        );
        write(&repo, "src/ok.rs", "fn main() {}\n");
        let index = staged(&repo);
        let candidates = paths(&[".env", ".env.example", "notes/deploy.txt", "src/ok.rs"]);
        let hits = scan_index(&repo, &index, &candidates).unwrap();
        assert_eq!(hit_paths(&hits), [".env", "notes/deploy.txt"]);
        assert_eq!(hits[0].reason, "name matches .env");
        assert_eq!(hits[1].reason, "contains a private key");
    }

    #[test]
    fn scan_judges_the_staged_blob_not_the_working_file() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, "config.txt", "harmless\n");
        let index = staged(&repo);
        // Edited after staging: what would be committed is still harmless.
        write(&repo, "config.txt", "-----BEGIN PRIVATE KEY-----\n");
        assert!(scan_index(&repo, &index, &paths(&["config.txt"]))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn scan_skips_paths_that_are_not_staged() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, ".env", "KEY=1\n");
        let index = repo.index().unwrap();
        // Only the candidate list names it; nothing is staged.
        assert!(scan_index(&repo, &index, &paths(&[".env", "gone.pem"]))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn the_staged_allow_file_lets_listed_paths_through() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, ".env", "KEY=1\n");
        write(&repo, "k.pem", "x");
        write(&repo, ALLOW_FILE, "# reviewed\n.env\n");
        let index = staged(&repo);
        let hits = scan_index(&repo, &index, &paths(&[".env", "k.pem"])).unwrap();
        assert_eq!(hit_paths(&hits), ["k.pem"]);
    }

    #[test]
    fn an_allow_file_that_is_not_staged_does_not_count() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, ".env", "KEY=1\n");
        let index = staged(&repo);
        // Written (or edited) after staging, so the index does not have it.
        write(&repo, ALLOW_FILE, ".env\n");
        let hits = scan_index(&repo, &index, &paths(&[".env"])).unwrap();
        assert_eq!(hit_paths(&hits), [".env"]);
    }

    #[test]
    fn scan_sees_what_is_staged_in_memory_before_the_index_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, "a.key", "x");
        {
            // A different handle, dropped: the repository's one index lives on.
            let mut index = repo.index().unwrap();
            stage_all(&mut index).unwrap();
        }
        assert!(
            !repo.path().join("index").exists(),
            "nothing is on disk yet"
        );
        let hits = scan(&repo, &paths(&["a.key"])).unwrap();
        assert_eq!(hit_paths(&hits), ["a.key"]);
    }

    #[test]
    fn only_the_first_mebibyte_of_a_file_is_scanned() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let key = b"-----BEGIN PRIVATE KEY-----\n";
        let padding = vec![b'a'; SCAN_LIMIT];
        let mut late = padding.clone();
        late.extend_from_slice(key);
        write(&repo, "late.txt", &late);
        let mut early = key.to_vec();
        early.extend_from_slice(&padding);
        write(&repo, "early.txt", &early);
        let index = staged(&repo);
        let hits = scan_index(&repo, &index, &paths(&["late.txt", "early.txt"])).unwrap();
        assert_eq!(hit_paths(&hits), ["early.txt"]);
    }

    #[test]
    fn a_binary_file_is_judged_by_name_only() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let mut bytes = vec![0u8, 1, 2, 3];
        bytes.extend_from_slice(b"-----BEGIN PRIVATE KEY-----");
        write(&repo, "image.bin", &bytes);
        write(&repo, "cert.p12", &bytes);
        let index = staged(&repo);
        let hits = scan_index(&repo, &index, &paths(&["image.bin", "cert.p12"])).unwrap();
        assert_eq!(hit_paths(&hits), ["cert.p12"]);
        assert_eq!(hits[0].reason, "name matches *.p12");
    }

    #[test]
    fn a_submodule_entry_is_not_read_as_a_blob() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let mut index = repo.index().unwrap();
        let entry = git2::IndexEntry {
            ctime: git2::IndexTime::new(0, 0),
            mtime: git2::IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: GITLINK,
            uid: 0,
            gid: 0,
            file_size: 0,
            id: git2::Oid::from_str("0123456789abcdef0123456789abcdef01234567").unwrap(),
            flags: 0,
            flags_extended: 0,
            path: b"vendor/lib".to_vec(),
        };
        index.add(&entry).unwrap();
        let hits = scan_index(&repo, &index, &paths(&["vendor/lib"])).unwrap();
        assert!(hits.is_empty());
    }

    // ---- recording an allowance ----------------------------------------------------

    #[test]
    fn allow_creates_the_file_appends_once_and_stages_it() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        allow(&repo, ".env").unwrap();
        let file = dir.path().join(ALLOW_FILE);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), ".env\n");
        allow(&repo, ".env").unwrap();
        allow(&repo, "k/server.pem").unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            ".env\nk/server.pem\n"
        );
        // Staged, and on disk: a new handle on the repository sees it.
        let reopened = Repository::open(dir.path()).unwrap();
        let index = reopened.index().unwrap();
        assert!(entry(&index, ALLOW_FILE).is_some());
        let allowed = allowed_paths(&reopened, &index).unwrap();
        assert!(allowed.contains(".env") && allowed.contains("k/server.pem"));
    }

    #[test]
    fn allow_keeps_what_the_file_already_says() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        // No newline at the end, a comment, and non-UTF-8 bytes must survive.
        let mut original = b"# why\nold.env".to_vec();
        original.extend_from_slice(b"\n# caf\xe9");
        std::fs::write(dir.path().join(ALLOW_FILE), &original).unwrap();
        allow(&repo, "new.env").unwrap();
        let mut want = original.clone();
        want.extend_from_slice(b"\nnew.env\n");
        assert_eq!(std::fs::read(dir.path().join(ALLOW_FILE)).unwrap(), want);
    }

    #[test]
    fn allow_refuses_paths_the_file_cannot_hold() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        for path in ["", " .env", ".env ", "#.env", "a\nb", "a\rb"] {
            let err = allow(&repo, path).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{path:?}: {err:?}");
        }
        assert!(!dir.path().join(ALLOW_FILE).exists());
    }

    #[test]
    fn scanning_never_writes_the_index_file() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, ".env", "KEY=1\n");
        let index = staged(&repo);
        let _ = scan_index(&repo, &index, &paths(&[".env"])).unwrap();
        assert!(
            !repo.path().join("index").exists(),
            "the guard touched the index file"
        );
    }
}
