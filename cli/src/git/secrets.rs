//! The secret guard: what `nsit commit` refuses to commit.
//!
//! A path is refused when its **name** looks like a secret (`.env`, `*.pem`,
//! `id_rsa*`, ...) or its **content** holds an obvious one (a private key
//! header, an Insitio, GitHub or AWS token). Both are judged on the *staged*
//! blob, the bytes that would be committed, not on the working file.
//!
//! **Paths are raw bytes here.** A file name on Unix can be any bytes, and the
//! guard decides on those bytes: every candidate is looked up in the index by
//! its bytes (`stage::entries_at`), the base name is matched on bytes, and a
//! candidate the index does not have is an error, never a skip. Text made from a
//! path (`display`) is only ever for showing it.
//!
//! Limits, so a commit stays fast and cannot be made to read gigabytes: only
//! the first 1 MiB of a blob is scanned, and a blob with a NUL byte in its
//! first 8 KiB counts as binary: its name is still judged, and so is a private
//! key header (a key file can start with a stray byte), but the token and
//! `.npmrc` rules look at text only.
//!
//! **Overrides are recorded.** `.nsit-allow-secrets`, in the repository root and
//! committed like any file, lists one repository-relative path per line (forward
//! slashes, `#` starts a comment, blank lines are ignored, exact match, no
//! patterns). The copy that counts is the staged one, so an allowance takes
//! effect in the same commit that records it, and an uncommitted edit of the
//! working file does not count. `record_allowances` writes the new entries in one
//! go and stages the file in the index it is given; it never writes that index.
//!
//! A hit names the path and *why* ("name matches .env", "contains a private
//! key"). The matched text is never part of a hit, an error or any output.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use git2::{Index, Repository};
use regex::bytes::Regex;

use super::paths::{display, workdir, RawPath};
use super::stage::{entries_at, entry, read_start};
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

/// The last part of a path.
fn base_name(path: &[u8]) -> &[u8] {
    path.rsplit(|b| *b == b'/').next().unwrap_or(path)
}

/// Why `path` is refused for its **name**, or `None`. Matched on the last
/// part of the path, at any depth, ignoring ASCII case (Windows and macOS file
/// systems do not tell `.ENV` from `.env`). `.npmrc` and `.pypirc` are judged
/// on their content (`content_hit`), not here.
pub fn name_hit(path: &[u8]) -> Option<String> {
    let base = base_name(path).to_ascii_lowercase();
    let pattern = if base == b".env" {
        ".env"
    } else if base.starts_with(b".env.") && base != b".env.example" && base != b".env.sample" {
        ".env.*"
    } else if base.ends_with(b".pem") {
        "*.pem"
    } else if base.ends_with(b".key") {
        "*.key"
    } else if base.starts_with(b"id_rsa") {
        "id_rsa*"
    } else if base.starts_with(b"id_ed25519") {
        "id_ed25519*"
    } else if base.ends_with(b".p12") {
        "*.p12"
    } else if base.ends_with(b".pfx") {
        "*.pfx"
    } else if base == b"credentials.json" {
        "credentials.json"
    } else {
        return None;
    };
    Some(format!("name matches {pattern}"))
}

struct ContentRule {
    pattern: Regex,
    reason: &'static str,
    /// Also applied to a blob that looks binary.
    in_binary_too: bool,
}

fn content_rules() -> &'static [ContentRule] {
    static RULES: OnceLock<Vec<ContentRule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let rule = |pattern: &str, reason, in_binary_too| ContentRule {
            pattern: Regex::new(pattern).expect("a valid built-in pattern"),
            reason,
            in_binary_too,
        };
        vec![
            rule(
                r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
                "contains a private key",
                true,
            ),
            rule(
                r"(gfk|ins)_[A-Za-z0-9_-]{30,}",
                "contains an Insitio token",
                false,
            ),
            rule(
                r"gh[pousr]_[A-Za-z0-9]{36,}",
                "contains a GitHub token",
                false,
            ),
            rule(r"AKIA[0-9A-Z]{16}", "contains an AWS access key", false),
        ]
    })
}

/// `.npmrc` / `.pypirc` lines that carry a login.
fn auth_line() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)_authtoken|password").expect("a valid built-in pattern"))
}

/// Why `content` (the start of the staged file at `path`) is refused, or
/// `None`. A blob that looks binary is only checked for a private key header.
pub fn content_hit(path: &[u8], content: &[u8]) -> Option<&'static str> {
    let binary = content[..content.len().min(BINARY_PROBE)].contains(&0);
    let by_content = content_rules()
        .iter()
        .find(|rule| (!binary || rule.in_binary_too) && rule.pattern.is_match(content));
    if let Some(rule) = by_content {
        return Some(rule.reason);
    }
    let base = base_name(path).to_ascii_lowercase();
    let login_file = base == b".npmrc" || base == b".pypirc";
    if !binary && login_file && auth_line().is_match(content) {
        return Some("contains credentials");
    }
    None
}

// ---- the allow file ------------------------------------------------------------------

/// The paths a `.nsit-allow-secrets` allows, as bytes: trimmed lines, without
/// blank lines and `#` comments.
pub fn parse_allow_list(bytes: &[u8]) -> BTreeSet<RawPath> {
    bytes
        .split(|b| *b == b'\n')
        .map(<[u8]>::trim_ascii)
        .filter(|line| !line.is_empty() && line[0] != b'#')
        .map(<[u8]>::to_vec)
        .collect()
}

/// The paths allowed by the staged copy of `.nsit-allow-secrets`.
pub fn allowed_paths(repo: &Repository, index: &Index) -> Result<BTreeSet<RawPath>, NsitError> {
    let Some(file) = entry(index, ALLOW_FILE) else {
        return Ok(BTreeSet::new());
    };
    let bytes = read_start(repo, file.id, ALLOW_FILE_LIMIT)?;
    Ok(parse_allow_list(&bytes))
}

/// A usage error unless `.nsit-allow-secrets` can hold `path` (repository-relative,
/// forward slashes): one line, without surrounding spaces, not starting with `#`.
pub fn check_recordable(path: &str) -> Result<(), NsitError> {
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
    Ok(())
}

/// Let `paths` (repository-relative, forward slashes) through the guard: every
/// path is checked first, then the ones not listed yet are appended to
/// `.nsit-allow-secrets` in a single write, and the file is staged in `index`.
///
/// The index is only changed in memory: when it reaches the disk is the
/// caller's decision. That keeps the allowance in the commit that needed it
/// without touching the index file of a commit that then fails.
///
/// The allow file itself is written to the working directory, so a commit that fails after
/// this must put it back: the `AllowFileBackup` returned (when anything was written) does that.
pub fn record_allowances(
    repo: &Repository,
    index: &mut Index,
    paths: &[String],
) -> Result<Option<AllowFileBackup>, NsitError> {
    if paths.is_empty() {
        return Ok(None);
    }
    for path in paths {
        check_recordable(path)?;
    }
    let file = workdir(repo)?.join(ALLOW_FILE);
    let previous = match std::fs::read(&file) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    let mut bytes = previous.clone().unwrap_or_default();
    let listed = parse_allow_list(&bytes);
    let new: BTreeSet<&str> = paths
        .iter()
        .map(String::as_str)
        .filter(|path| !listed.contains(path.as_bytes()))
        .collect();
    let backup = if new.is_empty() {
        None
    } else {
        if !bytes.is_empty() && !bytes.ends_with(b"\n") {
            bytes.push(b'\n');
        }
        for path in new {
            bytes.extend_from_slice(path.as_bytes());
            bytes.push(b'\n');
        }
        std::fs::write(&file, bytes)?;
        Some(AllowFileBackup {
            file: file.clone(),
            previous,
        })
    };
    if let Err(e) = index.add_path(Path::new(ALLOW_FILE)) {
        // Written but not staged: this call fails as a whole, so it leaves no file behind.
        return Err(match backup {
            Some(backup) => backup.restore_after(e.into()),
            None => e.into(),
        });
    }
    Ok(backup)
}

/// What `.nsit-allow-secrets` held before `record_allowances` changed it.
#[derive(Debug)]
pub struct AllowFileBackup {
    file: PathBuf,
    /// The bytes it had; `None` when there was no such file.
    previous: Option<Vec<u8>>,
}

impl AllowFileBackup {
    /// Put the file back as it was: its old bytes, or gone if it was not there.
    pub fn restore(self) -> Result<(), NsitError> {
        match self.previous {
            Some(bytes) => std::fs::write(&self.file, bytes)?,
            None => match std::fs::remove_file(&self.file) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            },
        }
        Ok(())
    }

    /// Put the file back because `err` made the caller give up, and return `err`; when even
    /// that fails, `err` with a note that the allow file is not as it was.
    pub fn restore_after(self, err: NsitError) -> NsitError {
        match self.restore() {
            Ok(()) => err,
            Err(restore) => NsitError::Other(format!(
                "{err}; and {ALLOW_FILE} could not be put back as it was: {restore}"
            )),
        }
    }
}

/// Let `path` through the guard on its own: record it (see `record_allowances`),
/// stage `.nsit-allow-secrets` and write the repository's index.
#[allow(dead_code)] // the plan's entry point; `commit` uses `record_allowances`, which leaves the index file to it
pub fn allow(repo: &Repository, path: &str) -> Result<(), NsitError> {
    let mut index = repo.index()?;
    let backup = record_allowances(repo, &mut index, &[path.to_string()])?;
    if let Err(e) = index.write() {
        return Err(match backup {
            Some(backup) => backup.restore_after(e.into()),
            None => e.into(),
        });
    }
    Ok(())
}

// ---- scanning ------------------------------------------------------------------------

/// `scan_index` over the repository's own index (the one in memory, which is
/// what a command has filled and not yet written).
#[allow(dead_code)] // the plan's entry point; `commit` passes the index it holds to `scan_index`
pub fn scan(repo: &Repository, candidates: &[RawPath]) -> Result<Vec<SecretHit>, NsitError> {
    let index = repo.index()?;
    scan_index(repo, &index, candidates, &[])
}

/// Check the staged files at `candidates` (raw repository-relative paths) in
/// `index` against the guard. Paths allowed in the staged `.nsit-allow-secrets`,
/// or named in `also_allowed` (what `--allow-secret` asks for, before it is
/// recorded), are skipped. One hit per refused path, sorted.
///
/// Every candidate must be in the index: a path the guard cannot find is an
/// error, not a path it may skip. (A commit's candidates are what the index adds
/// or changes, deletions excluded, so this does not happen; if it ever does, the
/// guard must not let the file through unread.)
pub(crate) fn scan_index(
    repo: &Repository,
    index: &Index,
    candidates: &[RawPath],
    also_allowed: &[String],
) -> Result<Vec<SecretHit>, NsitError> {
    let mut allowed = allowed_paths(repo, index)?;
    allowed.extend(also_allowed.iter().map(|path| path.as_bytes().to_vec()));
    let staged = entries_at(index, candidates);
    let mut hits = Vec::new();
    for candidate in candidates {
        if allowed.contains(candidate.as_slice()) {
            continue;
        }
        let Some(file) = staged.get(candidate) else {
            return Err(NsitError::Other(format!(
                "cannot check {} for secrets: it is not in the index (this is a bug in nsit)",
                display(candidate)
            )));
        };
        if file.mode == GITLINK {
            continue;
        }
        let reason = match name_hit(candidate) {
            Some(reason) => Some(reason),
            None => {
                let start = read_start(repo, file.id, SCAN_LIMIT)?;
                content_hit(candidate, &start).map(str::to_string)
            }
        };
        if let Some(reason) = reason {
            hits.push(SecretHit {
                path: display(candidate),
                reason,
            });
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
    use crate::test_support::{commit_file, local_repo, stage_raw, write_file as write};

    fn hit(path: &str, content: &[u8]) -> Option<&'static str> {
        content_hit(path.as_bytes(), content)
    }

    fn name(path: &str) -> Option<String> {
        name_hit(path.as_bytes())
    }

    fn scan_it(
        repo: &Repository,
        index: &Index,
        candidates: &[RawPath],
    ) -> Result<Vec<SecretHit>, NsitError> {
        scan_index(repo, index, candidates, &[])
    }

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
            let reason = name(path).unwrap_or_else(|| panic!("{path} should be flagged"));
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
            assert_eq!(name(path), None, "{path} should pass");
        }
    }

    #[test]
    fn a_name_hit_says_which_pattern_matched() {
        assert_eq!(name(".env").unwrap(), "name matches .env");
        assert_eq!(name(".env.dev").unwrap(), "name matches .env.*");
        assert_eq!(name("a.pem").unwrap(), "name matches *.pem");
        assert_eq!(name("id_rsa").unwrap(), "name matches id_rsa*");
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
                hit("notes.txt", text.as_bytes()),
                Some("contains a private key"),
                "{header}"
            );
        }
        for harmless in [
            "-----BEGIN PUBLIC KEY-----",
            "-----BEGIN CERTIFICATE-----",
            "BEGIN PRIVATE KEY",
        ] {
            assert_eq!(hit("a.txt", harmless.as_bytes()), None, "{harmless}");
        }
    }

    #[test]
    fn insitio_github_and_aws_tokens_are_flagged() {
        let ins = format!("ins_{}", "a1B2-_".repeat(5));
        let gfk = format!("gfk_{}", "x".repeat(30));
        assert_eq!(
            hit("a.txt", format!("token={ins}").as_bytes()),
            Some("contains an Insitio token")
        );
        assert_eq!(
            hit("a.txt", gfk.as_bytes()),
            Some("contains an Insitio token")
        );
        // One character short: not a token.
        assert_eq!(
            hit("a.txt", format!("ins_{}", "a".repeat(29)).as_bytes()),
            None
        );

        for prefix in ["ghp", "gho", "ghu", "ghs", "ghr"] {
            let token = format!("{prefix}_{}", "Z9".repeat(18));
            assert_eq!(
                hit("a.txt", token.as_bytes()),
                Some("contains a GitHub token"),
                "{prefix}"
            );
        }
        assert_eq!(
            hit("a.txt", format!("ghp_{}", "a".repeat(35)).as_bytes()),
            None
        );
        assert_eq!(
            hit("a.txt", format!("ghx_{}", "a".repeat(40)).as_bytes()),
            None
        );

        assert_eq!(
            hit("a.txt", b"key = AKIAIOSFODNN7EXAMPLE"),
            Some("contains an AWS access key")
        );
        assert_eq!(hit("a.txt", b"AKIAIOSFODNN7EXAMPL"), None);
        assert_eq!(hit("a.txt", b"akiaiosfodnn7example1"), None);
    }

    #[test]
    fn npmrc_and_pypirc_are_flagged_only_with_an_auth_line() {
        let npm_token = b"//registry.npmjs.org/:_authToken=abc123\n";
        assert_eq!(hit(".npmrc", npm_token), Some("contains credentials"));
        assert_eq!(
            hit("web/.npmrc", b"//host/:_AUTHTOKEN=x"),
            Some("contains credentials")
        );
        assert_eq!(
            hit(".pypirc", b"[pypi]\nusername = me\npassword = hunter2\n"),
            Some("contains credentials")
        );
        assert_eq!(hit(".npmrc", b"registry=https://r.example/\n"), None);
        assert_eq!(hit(".pypirc", b"[distutils]\nindex-servers = pypi\n"), None);
        // The same words in an ordinary file are not a finding.
        assert_eq!(hit("notes.txt", b"the password is in the vault"), None);
    }

    #[test]
    fn a_reason_never_contains_the_secret() {
        let secret = format!("ins_{}", "q".repeat(40));
        let text = format!("-----BEGIN RSA PRIVATE KEY-----\n{secret}\nAKIAIOSFODNN7EXAMPLE");
        let reason = hit("a.txt", text.as_bytes()).unwrap();
        assert!(
            !reason.contains("qqqq") && !reason.contains("AKIA"),
            "{reason}"
        );
    }

    #[test]
    fn binary_content_gets_the_key_rule_only_and_a_late_nul_is_not_binary() {
        let mut binary = b"\x89PNG\r\n\x1a\n\0\0".to_vec();
        binary.extend_from_slice(b"-----BEGIN PRIVATE KEY-----");
        // A private key header is found even after a NUL: key files do start with stray bytes.
        assert_eq!(hit("logo.png", &binary), Some("contains a private key"));
        // The token and login rules read text only.
        let mut tokens = b"\0".to_vec();
        tokens.extend_from_slice(
            format!(
                "ghp_{} ins_{} AKIAIOSFODNN7EXAMPLE",
                "a".repeat(40),
                "b".repeat(40)
            )
            .as_bytes(),
        );
        assert_eq!(hit("blob.bin", &tokens), None);
        let mut npmrc = b"\0".to_vec();
        npmrc.extend_from_slice(b"//host/:_authToken=abc");
        assert_eq!(hit(".npmrc", &npmrc), None);

        let mut late = vec![b'a'; BINARY_PROBE];
        late.push(0);
        late.extend_from_slice(b"-----BEGIN PRIVATE KEY-----");
        assert_eq!(hit("odd.txt", &late), Some("contains a private key"));
    }

    // ---- the allow file ------------------------------------------------------------

    #[test]
    fn the_allow_file_ignores_comments_blanks_and_whitespace() {
        let list = parse_allow_list(
            b"# why these are fine\n\n.env\r\n  config/.env.local  \n#.hidden\n\t\nsecrets/a b.pem\n",
        );
        let want: BTreeSet<RawPath> = [".env", "config/.env.local", "secrets/a b.pem"]
            .iter()
            .map(|s| s.as_bytes().to_vec())
            .collect();
        assert_eq!(list, want);
    }

    #[test]
    fn the_allow_file_can_name_a_path_that_is_not_text() {
        let list = parse_allow_list(b"donn\xe9es/.env\n# note\n");
        assert_eq!(list.len(), 1);
        assert!(list.contains(&b"donn\xe9es/.env"[..]));
    }

    #[test]
    fn allow_entries_are_exact_paths_not_patterns() {
        let list = parse_allow_list(b"*.pem\n.env*\nsrc/\n");
        assert!(list.contains(&b"*.pem"[..]) && !list.contains(&b"a.pem"[..]));
    }

    // ---- scanning staged files -----------------------------------------------------

    fn staged(repo: &Repository) -> Index {
        let mut index = repo.index().unwrap();
        stage_all(&mut index).unwrap();
        index
    }

    fn paths(names: &[&str]) -> Vec<RawPath> {
        names.iter().map(|n| n.as_bytes().to_vec()).collect()
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
        let hits = scan_it(&repo, &index, &candidates).unwrap();
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
        assert!(scan_it(&repo, &index, &paths(&["config.txt"]))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_candidate_the_index_does_not_have_is_an_error_not_a_skip() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, ".env", "KEY=1\n");
        let index = repo.index().unwrap();
        // Only the candidate list names it; nothing is staged. The guard must not
        // treat what it cannot find as safe.
        for missing in [".env", "gone.pem", "deep/er/missing.txt"] {
            let err = scan_it(&repo, &index, &paths(&[missing])).unwrap_err();
            assert!(matches!(err, NsitError::Other(_)), "{missing}: {err:?}");
            assert!(err.to_string().contains(missing), "{err}");
            assert!(err.to_string().contains("not in the index"), "{err}");
        }
    }

    #[test]
    fn a_name_that_is_not_text_is_judged_by_its_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        // A Latin-1 é (0xE9) is not UTF-8. The base names are what the rules see.
        stage_raw(&repo, b"donn\xe9es/.env", b"KEY=1\n");
        stage_raw(&repo, b"donn\xe9es/.env.example", b"KEY=\n");
        stage_raw(&repo, b"d\xe9/server.PEM", b"x");
        stage_raw(&repo, b"d\xe9/notes.txt", b"fine");
        stage_raw(&repo, b"\xff\xfe/id_rsa", b"x");
        let index = repo.index().unwrap();
        let candidates = vec![
            b"donn\xe9es/.env".to_vec(),
            b"donn\xe9es/.env.example".to_vec(),
            b"d\xe9/server.PEM".to_vec(),
            b"d\xe9/notes.txt".to_vec(),
            b"\xff\xfe/id_rsa".to_vec(),
        ];
        let hits = scan_it(&repo, &index, &candidates).unwrap();
        let reasons: Vec<&str> = hits.iter().map(|h| h.reason.as_str()).collect();
        assert_eq!(hits.len(), 3, "{hits:?}");
        assert!(reasons.contains(&"name matches .env"), "{reasons:?}");
        assert!(reasons.contains(&"name matches *.pem"), "{reasons:?}");
        assert!(reasons.contains(&"name matches id_rsa*"), "{reasons:?}");
        // The path shown is the text form; the decision was made on the bytes.
        assert!(
            hits.iter().any(|h| h.path == "donn\u{fffd}es/.env"),
            "{hits:?}"
        );
    }

    #[test]
    fn a_secret_inside_a_file_whose_name_is_not_text_is_found() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let token = format!("ghp_{}", "Zy9".repeat(14));
        stage_raw(
            &repo,
            b"caf\xe9/notes.txt",
            format!("TOKEN={token}\n").as_bytes(),
        );
        stage_raw(
            &repo,
            b"caf\xe9/key.txt",
            b"-----BEGIN RSA PRIVATE KEY-----\nAA\n",
        );
        stage_raw(&repo, b"caf\xe9/ok.txt", b"nothing here");
        let index = repo.index().unwrap();
        let candidates = vec![
            b"caf\xe9/notes.txt".to_vec(),
            b"caf\xe9/key.txt".to_vec(),
            b"caf\xe9/ok.txt".to_vec(),
        ];
        let hits = scan_it(&repo, &index, &candidates).unwrap();
        let reasons: BTreeSet<&str> = hits.iter().map(|h| h.reason.as_str()).collect();
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert!(
            reasons.contains("contains a GitHub token")
                && reasons.contains("contains a private key")
        );
    }

    #[test]
    fn a_path_in_also_allowed_is_matched_on_bytes_so_a_look_alike_is_not_let_through() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        // d\u{fffd}/.env (valid UTF-8, a real U+FFFD) and d\xe9/.env look the same as text.
        stage_raw(&repo, "d\u{fffd}/.env".as_bytes(), b"A=1");
        stage_raw(&repo, b"d\xe9/.env", b"B=2");
        let index = repo.index().unwrap();
        let candidates = vec!["d\u{fffd}/.env".as_bytes().to_vec(), b"d\xe9/.env".to_vec()];
        let allowed = vec!["d\u{fffd}/.env".to_string()];
        let hits = scan_index(&repo, &index, &candidates, &allowed).unwrap();
        assert_eq!(
            hits.len(),
            1,
            "only the one that was named is allowed: {hits:?}"
        );
    }

    #[test]
    fn the_staged_allow_file_lets_listed_paths_through() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, ".env", "KEY=1\n");
        write(&repo, "k.pem", "x");
        write(&repo, ALLOW_FILE, "# reviewed\n.env\n");
        let index = staged(&repo);
        let hits = scan_it(&repo, &index, &paths(&[".env", "k.pem"])).unwrap();
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
        let hits = scan_it(&repo, &index, &paths(&[".env"])).unwrap();
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
        let hits = scan_it(&repo, &index, &paths(&["late.txt", "early.txt"])).unwrap();
        assert_eq!(hit_paths(&hits), ["early.txt"]);
    }

    #[test]
    fn a_binary_file_is_judged_by_name_and_key_header_but_not_by_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let mut with_key = vec![0u8, 1, 2, 3];
        with_key.extend_from_slice(b"-----BEGIN PRIVATE KEY-----");
        let mut with_token = vec![0u8, 1, 2, 3];
        with_token.extend_from_slice(format!("ghp_{}", "q".repeat(40)).as_bytes());
        write(&repo, "image.bin", &with_token);
        write(&repo, "cert.p12", &with_token);
        write(&repo, "key.dat", &with_key);
        let index = staged(&repo);
        let candidates = paths(&["image.bin", "cert.p12", "key.dat"]);
        let hits = scan_it(&repo, &index, &candidates).unwrap();
        assert_eq!(hit_paths(&hits), ["cert.p12", "key.dat"]);
        assert_eq!(hits[0].reason, "name matches *.p12");
        assert_eq!(hits[1].reason, "contains a private key");
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
        let hits = scan_it(&repo, &index, &paths(&["vendor/lib"])).unwrap();
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
        assert!(allowed.contains(&b".env"[..]) && allowed.contains(&b"k/server.pem"[..]));
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
    fn record_allowances_writes_all_new_paths_at_once_and_leaves_the_index_file_alone() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_file(&repo, "a.txt", "a");
        let index_file = repo.path().join("index");
        let before = std::fs::read(&index_file).unwrap();

        let mut index = repo.index().unwrap();
        let wanted: Vec<String> = [".env", "k.pem", ".env"].map(String::from).to_vec();
        record_allowances(&repo, &mut index, &wanted).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join(ALLOW_FILE)).unwrap(),
            ".env\nk.pem\n"
        );
        assert!(entry(&index, ALLOW_FILE).is_some(), "staged in memory");
        assert_eq!(
            std::fs::read(&index_file).unwrap(),
            before,
            "the index file was written"
        );

        // Paths already listed add nothing.
        record_allowances(&repo, &mut index, &[".env".to_string()]).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join(ALLOW_FILE)).unwrap(),
            ".env\nk.pem\n"
        );
    }

    #[test]
    fn a_recorded_allowance_can_be_taken_back_exactly() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let file = dir.path().join(ALLOW_FILE);
        let mut index = repo.index().unwrap();

        // There was no allow file: taking the allowance back removes the one that was made.
        let backup = record_allowances(&repo, &mut index, &[".env".to_string()])
            .unwrap()
            .expect("the file was written");
        assert!(file.exists());
        backup.restore().unwrap();
        assert!(!file.exists());

        // There was one, with a comment and a name that is not text: every byte comes back.
        let mut original = b"# why\nold.env\n# caf\xe9".to_vec();
        original.push(b'\n');
        std::fs::write(&file, &original).unwrap();
        let backup = record_allowances(&repo, &mut index, &["k.pem".to_string()])
            .unwrap()
            .expect("the file was changed");
        assert_ne!(std::fs::read(&file).unwrap(), original);
        backup.restore().unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), original);

        // Nothing new to record: nothing was written, so there is nothing to take back.
        assert!(
            record_allowances(&repo, &mut index, &["old.env".to_string()])
                .unwrap()
                .is_none()
        );
        assert_eq!(std::fs::read(&file).unwrap(), original);
        assert!(record_allowances(&repo, &mut index, &[]).unwrap().is_none());
    }

    #[test]
    fn record_allowances_checks_every_path_before_it_writes_anything() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let mut index = repo.index().unwrap();
        let wanted: Vec<String> = [".env", "#not-recordable.env"].map(String::from).to_vec();
        let err = record_allowances(&repo, &mut index, &wanted).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert!(
            !dir.path().join(ALLOW_FILE).exists(),
            "the good path was recorded anyway"
        );
        assert!(entry(&index, ALLOW_FILE).is_none());
    }

    #[test]
    fn scanning_never_writes_the_index_file() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        write(&repo, ".env", "KEY=1\n");
        let index = staged(&repo);
        let _ = scan_it(&repo, &index, &paths(&[".env"])).unwrap();
        assert!(
            !repo.path().join("index").exists(),
            "the guard touched the index file"
        );
    }
}
