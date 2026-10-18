//! Naming a repository on an Insitio server, and which credentials may go to
//! the server it lives on.
//!
//! A repository is named `name` (yours), `owner/name`, or by a full URL, and a
//! full URL can name a server other than the one a command was aimed at. So a
//! `RepoRef` carries its own `host`, and `token_for_repo` is how a token is
//! chosen for it: never the selected host's token by default, and an
//! `NSIT_TOKEN` only when the repository is on the selected host.
//!
//! This module knows nothing about git or libgit2; both the API commands
//! (`nsit repo`) and the git commands use it.

use url::Url;

use crate::api::Api;
use crate::config::{base_url, Config};
use crate::credentials::{host_entry, host_key_for, token_for, TokenSource};
use crate::error::NsitError;

/// The longest repository name the server accepts.
const MAX_NAME_LEN: usize = 100;

/// A repository on an Insitio server, as the user named it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    pub owner: String,
    pub name: String,
    /// `<server>/<owner>/<name>.git`, never with a user name or token in it.
    pub clone_url: Url,
    /// The server this repository is on, as a base URL (`https://git.iam.bot/`,
    /// or `http://127.0.0.1:3000/` for a test server).
    ///
    /// **Credentials for this repository must come from this host and no
    /// other**, because a full URL can name any server: get the token with
    /// `token_for_repo(selected_host, &repo)`, and do every network operation
    /// through `git::run_remote` (git) or `Api::new(&repo.host, ..)` (API).
    /// Never pass the host a command was started with.
    pub host: String,
}

impl RepoRef {
    /// The canonical `host[:port]` of `host`, as used for stored tokens.
    pub fn host_key(&self) -> String {
        host_key_for(&self.host).unwrap_or_else(|_| self.host.clone())
    }
}

// ---- reading what the user typed ------------------------------------------------------

/// What kind of thing was typed. The one place that decides: `parse_repo_ref`
/// and `needs_default_owner` both read it.
enum Shape<'a> {
    /// `rocket`: whose repository is not said.
    Bare(&'a str),
    /// `ada/rocket`.
    Pair(&'a str, &'a str),
    /// `https://git.iam.bot/ada/rocket.git`.
    Url(&'a str),
    /// Anything with more than owner and name.
    Other,
}

/// Surrounding spaces and one trailing slash (a tab-completion leftover) are
/// ignored.
fn shape(input: &str) -> Shape<'_> {
    let input = input.trim();
    if input.contains("://") {
        return Shape::Url(input);
    }
    let path = input.strip_suffix('/').unwrap_or(input);
    match path.split('/').collect::<Vec<_>>().as_slice() {
        [name] => Shape::Bare(name),
        [owner, name] => Shape::Pair(owner, name),
        _ => Shape::Other,
    }
}

/// Does `input` name a repository without saying whose it is? Then the caller
/// has to find out who is signed in before `parse_repo_ref`.
pub fn needs_default_owner(input: &str) -> bool {
    matches!(shape(input), Shape::Bare(_))
}

/// Read `input` as a repository: `name` (owned by `default_owner`),
/// `owner/name`, or a full URL such as `https://git.iam.bot/ada/rocket.git`.
///
/// A trailing `.git` and one trailing slash are dropped. Empty parts, more
/// than owner and name, `.` and `..`, and anything outside what the server
/// allows in a name (letters, digits, `.`, `-`, `_`; at most 100 characters)
/// are usage errors, and so are query strings, fragments and user names or
/// passwords in a URL. Errors never repeat the input, which may hold a secret.
///
/// `base` is the server the command is aimed at: it is where a `name` or
/// `owner/name` lives. It need not end in a slash. A full URL on the same
/// server (scheme, host and port) must be under `base`'s path (a server hosted
/// below a path prefix); one outside it is refused. A URL on another server
/// must pass the same https-or-loopback rule as `base_url`, and the result's
/// `host` is that server, not `base`.
pub fn parse_repo_ref(input: &str, default_owner: &str, base: &Url) -> Result<RepoRef, NsitError> {
    let base = normalized(base);
    match shape(input) {
        Shape::Bare(_) if default_owner.is_empty() => Err(NsitError::Usage(
            "say which repository: owner/name (a bare name needs to know who you are)".into(),
        )),
        Shape::Bare(name) => build_ref(default_owner, name, &base),
        Shape::Pair(owner, name) => build_ref(owner, name, &base),
        Shape::Url(url) => parse_url(url, &base),
        Shape::Other => Err(not_a_repository()),
    }
}

/// `base` with a path that ends in `/` (so that `join` appends to it) and
/// nothing after the path.
fn normalized(base: &Url) -> Url {
    let mut base = base.clone();
    base.set_query(None);
    base.set_fragment(None);
    if !base.path().ends_with('/') {
        let path = format!("{}/", base.path());
        base.set_path(&path);
    }
    base
}

/// The name to create a repository with: the server's rule, and no `.git` at
/// the end (the server would refuse it).
pub fn validate_repo_name(name: &str) -> Result<(), NsitError> {
    check_segment("repository name", name)?;
    if strip_dot_git(name) != name {
        return Err(NsitError::Usage(
            "a repository name cannot end in .git".into(),
        ));
    }
    Ok(())
}

fn not_a_repository() -> NsitError {
    NsitError::Usage(
        "cannot read that as a repository: use name, owner/name, or a repository URL".into(),
    )
}

/// `base` is already normalized.
fn parse_url(input: &str, base: &Url) -> Result<RepoRef, NsitError> {
    // Nothing below repeats the input: it could be `https://ada:<token>@host/..`.
    let url = Url::parse(input).map_err(|_| not_a_repository())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(NsitError::Usage(
            "a repository URL must not contain a username or password; nsit keeps tokens out \
             of URLs"
                .into(),
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(not_a_repository());
    }

    let (server, rest) = if url.origin() == base.origin() {
        // The server we were told to use: the repository is below its path.
        let Some(rest) = url.path().strip_prefix(base.path()) else {
            return Err(NsitError::Usage(format!(
                "that URL is on the selected server but outside {}, where its repositories are",
                base.path()
            )));
        };
        (base.clone(), rest)
    } else {
        // Another server: it has to pass the same checks as the one we were told
        // to use (https, or loopback http). Its path prefix, if any, is unknown.
        let mut root = url.clone();
        root.set_path("/");
        let server = base_url(root.as_str())?;
        (server, url.path().strip_prefix('/').unwrap_or_default())
    };
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    match rest.split('/').collect::<Vec<_>>().as_slice() {
        [owner, name] => build_ref(owner, name, &server),
        _ => Err(not_a_repository()),
    }
}

/// Check the parts and make the reference. `name` may still end in `.git`.
fn build_ref(owner: &str, name: &str, server: &Url) -> Result<RepoRef, NsitError> {
    let name = strip_dot_git(name);
    check_segment("owner", owner)?;
    validate_repo_name(name)?;
    // Both parts are ASCII letters, digits, `.`, `-` and `_` now, so they cannot
    // add a path, a query, a scheme or a different host to the URL.
    let clone_url = server
        .join(&format!("{owner}/{name}.git"))
        .map_err(|_| not_a_repository())?;
    Ok(RepoRef {
        owner: owner.to_string(),
        name: name.to_string(),
        clone_url,
        host: server.as_str().to_string(),
    })
}

/// One part of a repository's name: the server's rule for names.
fn check_segment(what: &str, segment: &str) -> Result<(), NsitError> {
    let usage = |why: &str| Err(NsitError::Usage(format!("invalid {what}: {why}")));
    if segment.is_empty() {
        return usage("it is empty");
    }
    if segment == "." || segment == ".." {
        return usage("it cannot be . or ..");
    }
    if !segment
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return usage("use only letters, numbers, '.', '-' and '_'");
    }
    if segment.len() > MAX_NAME_LEN {
        return usage("it is longer than 100 characters");
    }
    Ok(())
}

/// `name` without a final `.git` (any case), as the server reads it too.
fn strip_dot_git(name: &str) -> &str {
    let bytes = name.as_bytes();
    match bytes.len().checked_sub(4) {
        // The last four bytes are ASCII, so `cut` is a character boundary.
        Some(cut) if bytes[cut..].eq_ignore_ascii_case(b".git") => &name[..cut],
        _ => name,
    }
}

// ---- which credentials go to which server -------------------------------------------

/// The login of the account `source`'s `token` belongs to: it is the user name
/// for git's Basic auth, and the owner for a bare repository name.
///
/// A token nsit stored belongs to the account the config remembers for the
/// host, so nothing is asked. `NSIT_TOKEN` can be anyone's (and the config may
/// name someone else), so the server is asked, once, with `GET /api/v1/user`,
/// and then `host` receives the token. **`host` must be a server this token
/// may go to**: use `token_for_repo` to get the token for it first.
pub fn signed_in_login(host: &str, source: TokenSource, token: &str) -> Result<String, NsitError> {
    login_for(source, configured_login(host)?, || {
        Ok(Api::new(host, Some(token.to_string()))?.user()?.login)
    })
}

/// The account the config remembers for `host`, if any.
fn configured_login(host: &str) -> Result<Option<String>, NsitError> {
    let key = host_key_for(host)?;
    let config = Config::load()?;
    Ok(host_entry(&config, &key)
        .map(|entry| entry.user.clone())
        .filter(|user| !user.is_empty()))
}

fn login_for(
    source: TokenSource,
    configured: Option<String>,
    ask: impl FnOnce() -> Result<String, NsitError>,
) -> Result<String, NsitError> {
    match (source, configured) {
        (TokenSource::Keychain | TokenSource::File, Some(user)) => Ok(user),
        _ => ask(),
    }
}

/// The token for the server `target` lives on, and where it came from. A
/// token nsit stored is looked up under that server's own name. `NSIT_TOKEN`
/// counts only when the repository is on the server selected with `--host` /
/// `NSIT_HOST` (or the default): a full URL for some other server must not get
/// a token meant for the one you chose, so an agent cannot be talked into
/// mailing it elsewhere. Reads local configuration only; no network.
pub fn token_for_repo(
    selected_host: &str,
    target: &RepoRef,
) -> Result<(String, TokenSource), NsitError> {
    let (token, source) = token_for(&target.host, None)?;
    if source == TokenSource::Env
        && base_url(selected_host)?.origin() != base_url(&target.host)?.origin()
    {
        return Err(NsitError::Auth(format!(
            "NSIT_TOKEN is sent only to the selected host, and {} is not it",
            target.host_key()
        )));
    }
    Ok((token, source))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::credentials::{store_token, TOKEN_ENV};
    use crate::test_support::{host_entry_for, isolated_env, serve_once};

    const BASE: &str = "https://git.iam.bot/";

    fn base() -> Url {
        Url::parse(BASE).unwrap()
    }

    // ---- parse_repo_ref -----------------------------------------------------------

    fn parse(input: &str) -> Result<RepoRef, NsitError> {
        parse_repo_ref(input, "gregory", &base())
    }

    #[test]
    fn a_bare_name_belongs_to_the_default_owner() {
        let r = parse("rocket").unwrap();
        assert_eq!((r.owner.as_str(), r.name.as_str()), ("gregory", "rocket"));
        assert_eq!(
            r.clone_url.as_str(),
            "https://git.iam.bot/gregory/rocket.git"
        );
        assert_eq!(r.host, "https://git.iam.bot/");
        assert_eq!(r.host_key(), "git.iam.bot");
    }

    #[test]
    fn owner_slash_name_names_the_owner() {
        let r = parse("ada/rocket").unwrap();
        assert_eq!((r.owner.as_str(), r.name.as_str()), ("ada", "rocket"));
        assert_eq!(r.clone_url.as_str(), "https://git.iam.bot/ada/rocket.git");
    }

    #[test]
    fn a_full_url_on_the_same_host_is_read_apart() {
        let r = parse("https://git.iam.bot/gregory/rocket.git").unwrap();
        assert_eq!((r.owner.as_str(), r.name.as_str()), ("gregory", "rocket"));
        assert_eq!(
            r.clone_url.as_str(),
            "https://git.iam.bot/gregory/rocket.git"
        );
        assert_eq!(r.host, "https://git.iam.bot/");
    }

    #[test]
    fn trailing_dot_git_and_slash_are_dropped_in_every_shape() {
        for input in [
            "rocket.git",
            "rocket/",
            "rocket.git/",
            "gregory/rocket.GIT",
            "https://git.iam.bot/gregory/rocket",
            "https://git.iam.bot/gregory/rocket/",
            "https://git.iam.bot/gregory/rocket.git/",
            "  rocket  ",
        ] {
            let r = parse(input).unwrap_or_else(|e| panic!("{input:?}: {e}"));
            assert_eq!(r.name, "rocket", "{input:?}");
            assert_eq!(r.owner, "gregory", "{input:?}");
            assert_eq!(
                r.clone_url.as_str(),
                "https://git.iam.bot/gregory/rocket.git",
                "{input:?}"
            );
        }
    }

    #[test]
    fn a_loopback_http_url_works_for_tests() {
        let base = Url::parse("http://127.0.0.1:3000/").unwrap();
        let r = parse_repo_ref("http://127.0.0.1:3000/ada/tools.git", "x", &base).unwrap();
        assert_eq!(r.clone_url.as_str(), "http://127.0.0.1:3000/ada/tools.git");
        assert_eq!(r.host, "http://127.0.0.1:3000/");
        assert_eq!(r.host_key(), "127.0.0.1:3000");
        // A bare name on that server gets that server's URL.
        let r = parse_repo_ref("tools", "ada", &base).unwrap();
        assert_eq!(r.clone_url.as_str(), "http://127.0.0.1:3000/ada/tools.git");
    }

    #[test]
    fn a_url_on_another_host_carries_that_hosts_credentials_key() {
        let r = parse("https://Other.Example/ada/rocket.git").unwrap();
        assert_eq!(r.clone_url.as_str(), "https://other.example/ada/rocket.git");
        // Credentials for this repository come from this host and no other.
        assert_eq!(r.host, "https://other.example/");
        assert_eq!(r.host_key(), "other.example");
        assert_eq!(
            crate::credentials::host_key_for(&r.host).unwrap(),
            "other.example"
        );
        // A different port is a different server too.
        let r = parse("https://git.iam.bot:8443/ada/rocket").unwrap();
        assert_eq!(r.host, "https://git.iam.bot:8443/");
        assert_eq!(r.host_key(), "git.iam.bot:8443");
    }

    #[test]
    fn a_url_on_another_host_must_pass_the_https_or_loopback_rule() {
        for url in [
            "http://other.example/ada/rocket.git",
            "http://10.0.0.5/ada/rocket",
            "http://localhost.evil.example/ada/rocket",
            "ssh://git.iam.bot/ada/rocket.git",
            "ftp://git.iam.bot/ada/rocket.git",
            "file:///ada/rocket",
        ] {
            let err = parse(url).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{url}: {err:?}");
        }
        // Loopback http is fine even when it is not the base host.
        let r = parse("http://localhost:3000/ada/rocket").unwrap();
        assert_eq!(r.host, "http://localhost:3000/");
    }

    #[test]
    fn credentials_in_a_url_are_refused_and_never_echoed() {
        for url in [
            "https://ada:hunter2@git.iam.bot/ada/rocket.git",
            "https://hunter2@git.iam.bot/ada/rocket.git",
            "http://ada:hunter2@127.0.0.1:3000/ada/rocket",
        ] {
            let err = parse(url).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{url}: {err:?}");
            assert!(!err.to_string().contains("hunter2"), "{err}");
        }
    }

    #[test]
    fn a_path_prefix_on_the_base_is_kept_for_that_host_only() {
        let base = Url::parse("https://example.com/insitio/").unwrap();
        let r = parse_repo_ref("ada/rocket", "x", &base).unwrap();
        assert_eq!(
            r.clone_url.as_str(),
            "https://example.com/insitio/ada/rocket.git"
        );
        let r = parse_repo_ref("https://example.com/insitio/ada/rocket.git", "x", &base).unwrap();
        assert_eq!((r.owner.as_str(), r.name.as_str()), ("ada", "rocket"));
        assert_eq!(
            r.clone_url.as_str(),
            "https://example.com/insitio/ada/rocket.git"
        );
        assert_eq!(r.host, "https://example.com/insitio/");
        // Another host has no known prefix: it is owner/name at its root.
        let r = parse_repo_ref("https://other.example/ada/rocket", "x", &base).unwrap();
        assert_eq!(r.clone_url.as_str(), "https://other.example/ada/rocket.git");
    }

    #[test]
    fn empty_extra_and_dot_segments_are_usage_errors() {
        for input in [
            "",
            "   ",
            "/",
            "/rocket",
            "ada//rocket",
            "a/b/c",
            "ada/rocket/extra",
            ".",
            "..",
            "ada/.",
            "../rocket",
            "ada/..",
            ".git",
            "ada/.git",
            "rocket.git.git",
            "https://git.iam.bot/",
            "https://git.iam.bot/ada",
            "https://git.iam.bot/ada/rocket/tree/main",
            "https://git.iam.bot/ada//rocket",
            "https://git.iam.bot/ada/..",
            "https://git.iam.bot/ada/rocket?tab=readme",
            "https://git.iam.bot/ada/rocket#readme",
        ] {
            let err = parse(input).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{input:?}: {err:?}");
            assert_eq!(err.exit_code(), 2);
        }
    }

    #[test]
    fn names_outside_the_servers_rule_are_usage_errors() {
        for input in [
            "ro cket",
            "ro$cket",
            "ro:cket",
            "ada/ro%20cket",
            "ada/rocket\\x",
            "ada@git.iam.bot:ada/rocket",
            "über",
            "C:\\Users\\ada\\rocket",
            "ro\u{1b}[31mcket",
        ] {
            let err = parse(input).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{input:?}: {err:?}");
        }
        // What the server accepts.
        for input in [
            "a", "A.b-c_d", "ada/a.b", "ada/1", "ada/_x", "ada/-x", "ada/...",
        ] {
            parse(input).unwrap_or_else(|e| panic!("{input:?} should be accepted: {e}"));
        }
        // 100 characters is the limit.
        let max = "a".repeat(100);
        assert_eq!(parse(&max).unwrap().name, max);
        assert!(parse(&"a".repeat(101)).is_err());
    }

    #[test]
    fn a_bare_name_without_a_default_owner_is_a_usage_error() {
        let err = parse_repo_ref("rocket", "", &base()).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        // The owner is not needed when the input has one.
        assert!(parse_repo_ref("ada/rocket", "", &base()).is_ok());
        assert!(parse_repo_ref("https://git.iam.bot/ada/rocket", "", &base()).is_ok());
    }

    #[test]
    fn a_default_owner_that_is_not_a_name_is_refused() {
        for owner in ["a/b", "..", "a b"] {
            let err = parse_repo_ref("rocket", owner, &base()).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{owner:?}: {err:?}");
        }
    }

    #[test]
    fn the_clone_url_is_built_from_validated_segments_only() {
        // Nothing a user types can steer the URL anywhere but owner/name.git.
        for input in ["ada/rocket", "rocket", "https://git.iam.bot/ada/rocket.git"] {
            let r = parse(input).unwrap();
            assert_eq!(r.clone_url.scheme(), "https");
            assert_eq!(r.clone_url.host_str(), Some("git.iam.bot"));
            assert!(r.clone_url.username().is_empty() && r.clone_url.password().is_none());
            assert!(r.clone_url.query().is_none() && r.clone_url.fragment().is_none());
            assert_eq!(
                r.clone_url.path(),
                format!("/{}/{}.git", r.owner, r.name),
                "{input}"
            );
        }
    }

    #[test]
    fn which_inputs_need_the_default_owner() {
        for bare in ["rocket", "rocket.git", "rocket/", " rocket "] {
            assert!(needs_default_owner(bare), "{bare:?}");
        }
        for full in [
            "ada/rocket",
            "ada/rocket/",
            "https://git.iam.bot/ada/rocket",
            "http://127.0.0.1:3000/ada/rocket.git",
        ] {
            assert!(!needs_default_owner(full), "{full:?}");
        }
    }

    #[test]
    fn creating_a_repository_follows_the_servers_name_rule() {
        for ok in ["tools", "a", "A.b-c_d", "..."] {
            validate_repo_name(ok).unwrap_or_else(|e| panic!("{ok:?}: {e}"));
        }
        for bad in [
            "",
            ".",
            "..",
            "bad name",
            "a/b",
            "tools.git",
            "tools.GIT",
            ".git",
            "über",
        ] {
            let err = validate_repo_name(bad).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{bad:?}: {err:?}");
        }
        assert!(validate_repo_name(&"a".repeat(100)).is_ok());
        assert!(validate_repo_name(&"a".repeat(101)).is_err());
    }

    #[test]
    fn a_base_without_a_trailing_slash_is_treated_as_a_directory() {
        let base = Url::parse("https://example.com/insitio").unwrap();
        let r = parse_repo_ref("ada/rocket", "x", &base).unwrap();
        assert_eq!(
            r.clone_url.as_str(),
            "https://example.com/insitio/ada/rocket.git"
        );
        assert_eq!(r.host, "https://example.com/insitio/");
        let r = parse_repo_ref("https://example.com/insitio/ada/rocket", "x", &base).unwrap();
        assert_eq!(
            r.clone_url.as_str(),
            "https://example.com/insitio/ada/rocket.git"
        );
        // A query or fragment on the base is not part of any repository URL.
        let base = Url::parse("https://example.com/insitio?x=1#y").unwrap();
        let r = parse_repo_ref("ada/rocket", "x", &base).unwrap();
        assert_eq!(
            r.clone_url.as_str(),
            "https://example.com/insitio/ada/rocket.git"
        );
        // And a server at the root works with or without its slash.
        for root in ["https://example.com", "https://example.com/"] {
            let r = parse_repo_ref("ada/rocket", "x", &Url::parse(root).unwrap()).unwrap();
            assert_eq!(r.clone_url.as_str(), "https://example.com/ada/rocket.git");
        }
    }

    #[test]
    fn a_url_on_the_same_server_but_outside_its_path_prefix_is_refused() {
        for base in [
            "https://example.com/insitio/",
            "https://example.com/insitio",
        ] {
            let base = Url::parse(base).unwrap();
            for url in [
                "https://example.com/ada/rocket",
                "https://example.com/other/ada/rocket.git",
                "https://example.com/insitio",
                "https://example.com/insitiox/ada/rocket",
            ] {
                let err = parse_repo_ref(url, "x", &base).unwrap_err();
                assert!(matches!(err, NsitError::Usage(_)), "{url}: {err:?}");
                assert!(err.to_string().contains("/insitio/"), "{err}");
                assert!(!err.to_string().contains(url), "{err}");
            }
            // Inside the prefix is fine.
            assert!(parse_repo_ref("https://example.com/insitio/ada/rocket", "x", &base).is_ok());
        }
    }

    #[test]
    fn the_shape_rules_exist_once() {
        // `needs_default_owner` and `parse_repo_ref` read the input the same way:
        // a bare name is refused without a default owner, for that reason only.
        for (input, bare) in [
            ("rocket", true),
            ("rocket/", true),
            ("rocket.git", true),
            (" rocket ", true),
            ("", true),
            ("/", true),
            ("ada/rocket", false),
            ("ada/rocket/", false),
            ("a/b/c", false),
            ("https://git.iam.bot/ada/rocket", false),
            ("http://127.0.0.1:3000/ada/rocket.git", false),
        ] {
            assert_eq!(needs_default_owner(input), bare, "{input:?}");
            let without_owner_said = matches!(
                parse_repo_ref(input, "", &base()),
                Err(NsitError::Usage(m)) if m.contains("say which repository")
            );
            assert_eq!(without_owner_said, bare, "{input:?}");
        }
    }

    // ---- who the token belongs to ------------------------------------------------

    #[test]
    fn tokens_nsit_stored_belong_to_the_account_in_the_config_without_asking() {
        for source in [TokenSource::Keychain, TokenSource::File] {
            let login = login_for(source, Some("grace".into()), || {
                panic!("must not ask the server")
            })
            .unwrap();
            assert_eq!(login, "grace");
        }
    }

    #[test]
    fn an_environment_token_belongs_to_whoever_the_server_says() {
        // Even with an account in the config: NSIT_TOKEN may be someone else's.
        let login = login_for(TokenSource::Env, Some("grace".into()), || Ok("ada".into())).unwrap();
        assert_eq!(login, "ada");
        let login = login_for(TokenSource::Env, None, || Ok("ada".into())).unwrap();
        assert_eq!(login, "ada");
        // With no config entry to read, a stored token also needs the server.
        let login = login_for(TokenSource::File, None, || Ok("ada".into())).unwrap();
        assert_eq!(login, "ada");
        let err = login_for(TokenSource::Env, None, || {
            Err(NsitError::Auth("rejected".into()))
        })
        .unwrap_err();
        assert_eq!(err.exit_code(), 3);
    }

    #[test]
    fn signed_in_login_reads_the_config_or_asks_the_server_as_the_source_requires() {
        let dir = tempfile::tempdir().unwrap();
        let _env = isolated_env(dir.path());
        let (server, seen) = serve_once(r#"{"login":"ada","name":"","email":"","is_admin":false}"#);
        let server_key = format!("127.0.0.1:{}", Url::parse(&server).unwrap().port().unwrap());
        let mut config = Config::default();
        for key in ["127.0.0.1:9", server_key.as_str()] {
            config
                .hosts
                .insert(key.into(), host_entry_for("grace", None, None));
        }
        config.save().unwrap();

        // Stored token: the config answers. Nothing listens on port 9, so a
        // request there would be an error.
        let login = signed_in_login("http://127.0.0.1:9", TokenSource::File, "ins_t").unwrap();
        assert_eq!(login, "grace");

        // NSIT_TOKEN: the server answers, and its answer beats the config.
        let login = signed_in_login(&server, TokenSource::Env, "ins_envtoken").unwrap();
        assert_eq!(login, "ada");
        let request = seen.join().unwrap();
        assert!(request.starts_with("GET /api/v1/user "), "{request}");
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer ins_envtoken"));
    }

    // ---- token_for_repo -------------------------------------------------------------

    fn other_host_ref() -> RepoRef {
        parse("https://other.example/ada/rocket").unwrap()
    }

    #[test]
    fn nsit_token_is_only_for_the_selected_host() {
        let dir = tempfile::tempdir().unwrap();
        let _env = isolated_env(dir.path()).set(TOKEN_ENV, "ins_agent_token");
        // A repository on the selected host: fine.
        let same = parse("ada/rocket").unwrap();
        let (token, source) = token_for_repo("git.iam.bot", &same).unwrap();
        assert_eq!(
            (token.as_str(), source),
            ("ins_agent_token", TokenSource::Env)
        );
        // The same server spelled as a URL is still the same server.
        let (_, source) = token_for_repo("https://GIT.iam.bot/", &same).unwrap();
        assert_eq!(source, TokenSource::Env);
        // A repository somewhere else must not get it.
        let err = token_for_repo("git.iam.bot", &other_host_ref()).unwrap_err();
        assert!(matches!(err, NsitError::Auth(_)), "{err:?}");
        assert_eq!(err.exit_code(), 3);
        assert_eq!(
            err.to_string(),
            "NSIT_TOKEN is sent only to the selected host, and other.example is not it"
        );
        assert!(!err.to_string().contains("ins_agent_token"), "{err}");
        // ...unless that host is the one selected.
        assert!(token_for_repo("https://other.example", &other_host_ref()).is_ok());
    }

    #[test]
    fn a_stored_token_is_found_by_the_repositorys_own_host() {
        let dir = tempfile::tempdir().unwrap();
        let _env = isolated_env(dir.path());
        store_token("other.example", "ada", "ins_other_token").unwrap();
        let mut config = Config::default();
        config
            .hosts
            .insert("other.example".into(), host_entry_for("ada", None, None));
        config.save().unwrap();
        let (token, source) = token_for_repo("git.iam.bot", &other_host_ref()).unwrap();
        assert_eq!(
            (token.as_str(), source),
            ("ins_other_token", TokenSource::File)
        );
        // Nothing stored for the selected host: still signed out there.
        let err = token_for_repo("git.iam.bot", &parse("ada/rocket").unwrap()).unwrap_err();
        assert_eq!(err.exit_code(), 3);
    }
}
