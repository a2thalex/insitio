//! The starter `README.md`: its text and writing it.
//!
//! The title is the repository's name; the description comes from Insitio when
//! `origin` is a repository on the selected host and this machine is signed in
//! (no description otherwise: being offline or signed out is never an error).
//! A README that exists, in any capitalization, is never touched. `nsit readme`
//! and `nsit init --readme` both write it through here.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use git2::Repository;

use super::paths::workdir;
use crate::api::Api;
use crate::error::{one_line, NsitError};
use crate::repo_ref::{token_for_repo, RepoRef};

/// The file that is written.
pub const README: &str = "README.md";

/// What `write_readme` found to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Written {
    /// `README.md` was written.
    Created,
    /// A README was already there and was left as it is.
    AlreadyThere,
}
/// Write `README.md` into `repo`'s working directory unless a README is there
/// already. The check and the creation are one step (the file is created only if
/// it does not exist), so a README made in between is never overwritten.
pub fn write_readme(
    repo: &Repository,
    origin: Option<&RepoRef>,
    description: Option<&str>,
) -> Result<Written, NsitError> {
    let root = workdir(repo)?;
    if has_readme(root)? {
        return Ok(Written::AlreadyThere);
    }
    let title = match origin {
        Some(target) => target.name.clone(),
        None => directory_name(root),
    };
    let text = readme_text(&title, description, origin.map(|t| (&*t.owner, &*t.name)));
    let created = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root.join(README));
    match created {
        Ok(mut file) => {
            file.write_all(text.as_bytes())?;
            Ok(Written::Created)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(Written::AlreadyThere),
        Err(e) => Err(e.into()),
    }
}

/// Is there a `README.md` in `root`? Case does not matter: on a case-sensitive
/// file system a `readme.md` beside a new `README.md` would only confuse.
fn has_readme(root: &Path) -> Result<bool, NsitError> {
    for item in std::fs::read_dir(root)? {
        if item?
            .file_name()
            .to_string_lossy()
            .eq_ignore_ascii_case(README)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn directory_name(root: &Path) -> String {
    root.canonicalize()
        .ok()
        .as_deref()
        .unwrap_or(root)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "project".to_string())
}

/// The starter text. `repo` is `(owner, name)` when it is known; the clone
/// command has placeholders otherwise.
pub fn readme_text(title: &str, description: Option<&str>, repo: Option<(&str, &str)>) -> String {
    let mut text = format!("# {title}\n\n");
    if let Some(description) = description {
        text.push_str(description);
        text.push_str("\n\n");
    }
    let clone = match repo {
        Some((owner, name)) => format!("nsit clone {owner}/{name}"),
        None => "nsit clone <owner>/<name>".to_string(),
    };
    text.push_str(&format!(
        "## Get the code\n\n```sh\n{clone}\n```\n\n\
         ## Make a change\n\n```sh\nnsit commit -m \"What you changed\"\nnsit push\n```\n"
    ));
    text
}

/// The repository's description on the server, if this machine can ask: signed
/// in to that server, and the server answers. Any failure is "no description".
pub fn description_of(host: &str, target: &RepoRef) -> Option<String> {
    let (token, _) = token_for_repo(host, target).ok()?;
    let api = Api::new(&target.host, Some(token)).ok()?;
    let details = api.repo(&target.owner, &target.name).ok()?;
    let description = one_line(&details.description, 300);
    (!description.is_empty()).then_some(description)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::base_url;
    use crate::repo_ref::parse_repo_ref;
    use crate::test_support::local_repo;

    #[test]
    fn the_starter_text_has_a_title_a_clone_command_and_a_usage_stub() {
        let text = readme_text("demo", None, Some(("ada", "demo")));
        assert!(text.starts_with("# demo\n\n## Get the code\n"), "{text}");
        assert!(text.contains("```sh\nnsit clone ada/demo\n```"), "{text}");
        assert!(text.contains("nsit commit -m"), "{text}");
        assert!(text.ends_with('\n') && !text.ends_with("\n\n"), "{text:?}");
    }

    #[test]
    fn a_description_goes_under_the_title() {
        let text = readme_text(
            "demo",
            Some("Small tools for video."),
            Some(("ada", "demo")),
        );
        assert!(
            text.starts_with("# demo\n\nSmall tools for video.\n\n## Get the code"),
            "{text}"
        );
    }

    #[test]
    fn without_a_known_repository_the_clone_command_has_placeholders() {
        let text = readme_text("Vidéo Ink - OG Edition", None, None);
        assert!(text.starts_with("# Vidéo Ink - OG Edition\n"), "{text}");
        assert!(text.contains("nsit clone <owner>/<name>"), "{text}");
    }

    #[test]
    fn it_writes_the_file_named_after_the_directory_when_there_is_no_origin() {
        let parent = tempfile::tempdir().unwrap();
        let dir = parent.path().join("Vidéo Ink - OG Edition");
        std::fs::create_dir(&dir).unwrap();
        let repo = local_repo(&dir);
        assert_eq!(write_readme(&repo, None, None).unwrap(), Written::Created);
        let text = std::fs::read_to_string(dir.join(README)).unwrap();
        assert!(text.starts_with("# Vidéo Ink - OG Edition\n"), "{text}");
        assert!(text.contains("<owner>/<name>"), "{text}");
    }

    #[test]
    fn it_uses_the_repository_name_and_owner_from_origin() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        let target = parse_repo_ref(
            "https://git.iam.bot/ada/rocket.git",
            "",
            &base_url("git.iam.bot").unwrap(),
        )
        .unwrap();
        write_readme(&repo, Some(&target), Some("Fast and small.")).unwrap();
        let text = std::fs::read_to_string(dir.path().join(README)).unwrap();
        assert!(text.starts_with("# rocket\n\nFast and small.\n"), "{text}");
        assert!(text.contains("nsit clone ada/rocket"), "{text}");
    }

    #[test]
    fn an_existing_readme_is_never_overwritten_whatever_its_name_case() {
        for existing in ["README.md", "readme.md", "Readme.MD"] {
            let dir = tempfile::tempdir().unwrap();
            let repo = local_repo(dir.path());
            std::fs::write(dir.path().join(existing), "mine\n").unwrap();
            assert_eq!(
                write_readme(&repo, None, None).unwrap(),
                Written::AlreadyThere,
                "{existing}"
            );
            assert_eq!(
                std::fs::read_to_string(dir.path().join(existing)).unwrap(),
                "mine\n"
            );
            let files: Vec<_> = std::fs::read_dir(dir.path())
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .filter(|n| n.eq_ignore_ascii_case("readme.md"))
                .collect();
            assert_eq!(files.len(), 1, "{files:?}");
        }
    }

    #[test]
    fn no_token_or_no_server_means_no_description_and_no_error() {
        use crate::credentials::TOKEN_ENV;
        use crate::test_support::isolated_env;
        // Nothing listens on port 9 of this machine.
        let host = "http://127.0.0.1:9";
        let target = parse_repo_ref(
            "http://127.0.0.1:9/ada/rocket.git",
            "",
            &base_url(host).unwrap(),
        )
        .unwrap();
        let config = tempfile::tempdir().unwrap();
        {
            // Signed out: nothing is asked of any server.
            let _env = isolated_env(config.path());
            assert_eq!(description_of(host, &target), None);
        }
        // Signed in, but the server is not there: the failure is swallowed.
        let _env = isolated_env(config.path()).set(TOKEN_ENV, "ins_not_a_real_token");
        assert_eq!(description_of(host, &target), None);
    }
}
