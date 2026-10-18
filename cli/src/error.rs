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
    /// The server rejected a push (exit 6).
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
            NsitError::Conflict(_) => 4,
            NsitError::SecretGuard(_) => 5,
            NsitError::Rejected(_) => 6,
            NsitError::Git(_) | NsitError::Api { .. } | NsitError::Io(_) | NsitError::Other(_) => 1,
        }
    }
}

fn conflict_summary(paths: &[String]) -> String {
    if paths.is_empty() {
        "merge conflict".to_string()
    } else {
        format!("merge conflict in {}", paths.join(", "))
    }
}

fn secret_summary(hits: &[SecretHit]) -> String {
    let list: Vec<String> = hits
        .iter()
        .map(|h| format!("{} ({})", h.path, h.reason))
        .collect();
    format!("blocked by the secret guard: {}", list.join(", "))
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
