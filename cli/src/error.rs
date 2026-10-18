//! The error type every nsit command returns, and its mapping to exit codes.

use serde::Serialize;

/// A file the secret guard refused to commit, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SecretHit {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, thiserror::Error)]
pub enum NsitError {
    /// Bad arguments or configuration (exit 2).
    #[error("{0}")]
    Usage(String),
    /// Not signed in, or the server refused the credentials (exit 3).
    #[error("{0}")]
    Auth(String),
    /// A merge stopped on conflicts in these paths (exit 4).
    #[error("{}", conflict_summary(.0))]
    Conflict(Vec<String>),
    /// The secret guard blocked a commit (exit 5).
    #[error("{}", secret_summary(.0))]
    SecretGuard(Vec<SecretHit>),
    /// The server rejected a push (exit 6). First built by `nsit push`.
    #[allow(dead_code)]
    #[error("{0}")]
    Rejected(String),
    /// libgit2 failed. Shown as its bare message, never the class/code dump.
    #[error("{}", .0.message())]
    Git(#[from] git2::Error),
    /// The Insitio API answered with an error.
    #[error("{message}")]
    Api {
        status: u16,
        code: String,
        message: String,
    },
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Other(String),
}

impl NsitError {
    /// The process exit code for this error:
    /// 1 general, 2 usage, 3 auth, 4 conflict, 5 secret guard, 6 rejected.
    pub fn exit_code(&self) -> i32 {
        match self {
            NsitError::Usage(_) => 2,
            // Task 5 maps 401 to `Auth`; this keeps a raw 401 from slipping
            // through as a general failure.
            NsitError::Auth(_) | NsitError::Api { status: 401, .. } => 3,
            // A refused login that reached us as a bare libgit2 error: `run_remote`
            // turns these into `Auth` with a hint, this keeps the exit code right
            // for any caller that did not go through it.
            NsitError::Git(e) if e.code() == git2::ErrorCode::Auth => 3,
            NsitError::Conflict(_) => 4,
            NsitError::SecretGuard(_) => 5,
            NsitError::Rejected(_) => 6,
            NsitError::Git(_) | NsitError::Api { .. } | NsitError::Io(_) | NsitError::Other(_) => 1,
        }
    }
}

/// Make text from outside nsit (a server message, an OS error) safe to put in
/// an error line: whitespace runs collapse to one space, control characters
/// (terminal escapes included) are dropped, and the result is cut to
/// `max_chars` with `...` when longer.
pub(crate) fn one_line(text: &str, max_chars: usize) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    let cleaned: String = words
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    if cleaned.chars().count() <= max_chars {
        return cleaned;
    }
    let mut cut: String = cleaned.chars().take(max_chars).collect();
    cut.push_str("...");
    cut
}

fn conflict_summary(paths: &[String]) -> String {
    if paths.is_empty() {
        "merge conflict".to_string()
    } else {
        let names: Vec<String> = paths
            .iter()
            .map(|p| p.chars().filter(|c| !c.is_control()).collect())
            .collect();
        format!("merge conflict in {}", names.join(", "))
    }
}

/// Every refused path with its reason, and the way past the guard. File names
/// come from the working directory, so control characters (terminal escapes
/// included) are dropped from them.
fn secret_summary(hits: &[SecretHit]) -> String {
    let list: Vec<String> = hits
        .iter()
        .map(|h| {
            let path: String = h.path.chars().filter(|c| !c.is_control()).collect();
            format!("{path} ({})", h.reason)
        })
        .collect();
    format!(
        "blocked by the secret guard: {}; to commit a file anyway, add --allow-secret <path> \
         for it (recorded in .nsit-allow-secrets)",
        list.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn api(status: u16) -> NsitError {
        NsitError::Api {
            status,
            code: "some_code".into(),
            message: "something happened".into(),
        }
    }

    #[test]
    fn exit_code_for_every_variant() {
        let cases: Vec<(NsitError, i32)> = vec![
            (NsitError::Usage("u".into()), 2),
            (NsitError::Auth("a".into()), 3),
            (NsitError::Conflict(vec!["a.txt".into()]), 4),
            (
                NsitError::SecretGuard(vec![SecretHit {
                    path: ".env".into(),
                    reason: "secret-looking file name".into(),
                }]),
                5,
            ),
            (NsitError::Rejected("non-fast-forward".into()), 6),
            (NsitError::Git(git2::Error::from_str("boom")), 1),
            (api(500), 1),
            (
                NsitError::Io(std::io::Error::new(std::io::ErrorKind::NotFound, "gone")),
                1,
            ),
            (NsitError::Other("o".into()), 1),
        ];
        for (err, want) in cases {
            assert_eq!(err.exit_code(), want, "wrong exit code for {err:?}");
        }
    }

    #[test]
    fn api_401_is_an_auth_failure() {
        assert_eq!(api(401).exit_code(), 3);
        assert_eq!(api(404).exit_code(), 1);
        assert_eq!(api(403).exit_code(), 1);
    }

    #[test]
    fn a_git_authentication_failure_is_exit_3_even_when_nobody_mapped_it() {
        // `run_remote` maps these to `Auth`; this is the net under a caller that
        // lets `?` convert a libgit2 error on its own.
        let auth = git2::Error::new(git2::ErrorCode::Auth, git2::ErrorClass::Http, "rejected");
        assert_eq!(NsitError::from(auth).exit_code(), 3);
        let other = git2::Error::new(
            git2::ErrorCode::GenericError,
            git2::ErrorClass::Net,
            "connection reset",
        );
        assert_eq!(NsitError::from(other).exit_code(), 1);
    }

    #[test]
    fn git_error_shows_only_its_message() {
        let err = NsitError::from(git2::Error::from_str("reference not found"));
        let text = err.to_string();
        assert_eq!(text, "reference not found");
        assert!(!text.contains("class="), "leaked libgit2 internals: {text}");
    }

    #[test]
    fn conflict_lists_the_files() {
        let text = NsitError::Conflict(vec!["a.txt".into(), "dir/b.txt".into()]).to_string();
        assert!(
            text.contains("a.txt") && text.contains("dir/b.txt"),
            "{text}"
        );
        assert!(!text.contains('\n'), "one line please: {text:?}");
    }

    #[test]
    fn secret_guard_lists_paths_and_reasons() {
        let text = NsitError::SecretGuard(vec![
            SecretHit {
                path: ".env".into(),
                reason: "secret-looking file name".into(),
            },
            SecretHit {
                path: "k.pem".into(),
                reason: "private key header".into(),
            },
        ])
        .to_string();
        assert!(text.contains(".env") && text.contains("secret-looking file name"));
        assert!(text.contains("k.pem") && text.contains("private key header"));
        assert!(text.contains("--allow-secret <path>"), "{text}");
        assert!(!text.contains('\n'), "one line please: {text:?}");
    }

    #[test]
    fn secret_guard_file_names_cannot_smuggle_terminal_escapes() {
        let text = NsitError::SecretGuard(vec![SecretHit {
            path: ".env\u{1b}[31m\nx".into(),
            reason: "name matches .env".into(),
        }])
        .to_string();
        assert!(!text.contains('\u{1b}') && !text.contains('\n'), "{text:?}");
    }

    #[test]
    fn messages_are_plain_text_not_debug_dumps() {
        assert_eq!(NsitError::Usage("bad flag".into()).to_string(), "bad flag");
        assert_eq!(
            NsitError::Other("not implemented".into()).to_string(),
            "not implemented"
        );
        assert_eq!(api(409).to_string(), "something happened");
        let io = NsitError::Io(std::io::Error::new(std::io::ErrorKind::NotFound, "gone"));
        assert_eq!(io.to_string(), "gone");
    }

    #[test]
    fn one_line_collapses_whitespace_and_drops_control_characters() {
        assert_eq!(one_line("  a\r\nb\t\tc  ", 50), "a b c");
        assert_eq!(one_line("red \u{1b}[31mtext\u{7}", 50), "red [31mtext");
        assert_eq!(one_line("", 5), "");
    }

    #[test]
    fn one_line_truncates_long_text_on_a_character_boundary() {
        assert_eq!(one_line("abcdef", 6), "abcdef");
        assert_eq!(one_line("abcdefg", 6), "abcdef...");
        assert_eq!(one_line("ééééé", 2), "éé...");
    }

    #[test]
    fn question_mark_converts_io_and_git_errors() {
        fn io() -> Result<(), NsitError> {
            Err(std::io::Error::other("disk"))?;
            Ok(())
        }
        fn git() -> Result<(), NsitError> {
            Err(git2::Error::from_str("nope"))?;
            Ok(())
        }
        assert!(matches!(io(), Err(NsitError::Io(_))));
        assert!(matches!(git(), Err(NsitError::Git(_))));
    }
}
