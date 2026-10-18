//! `nsit repo`: create, list and view repositories on Insitio.
//!
//! These are API commands; no git is involved. Not being signed in is an
//! `Auth` error (exit 3) decided before anything touches the network or could
//! wait for input, so an agent with no `NSIT_TOKEN` is told to sign in at once.
//!
//! Tables are plain aligned columns; color is used only when stdout is a
//! terminal and `NO_COLOR` is unset. With `--json` the server's repository
//! fields are printed unchanged. Text that came from the server (names,
//! descriptions) is cleaned of control characters before it reaches a terminal.

use crate::api::{Api, RepoJson};
use crate::cli::{GlobalArgs, RepoArgs, RepoCommand, RepoCreateArgs, RepoListArgs, RepoViewArgs};
use crate::config::{base_url, resolve_host};
use crate::credentials::token_for;
use crate::error::{one_line, NsitError};
use crate::output::Out;
use crate::repo_ref::{
    needs_default_owner, parse_repo_ref, signed_in_login, token_for_repo, validate_repo_name,
    RepoRef,
};

/// Longest description shown in a table row.
const TABLE_DESCRIPTION_CHARS: usize = 60;

pub fn run(args: &RepoArgs, global: &GlobalArgs, out: &Out) -> Result<(), NsitError> {
    let host = resolve_host(global.host.as_deref());
    match &args.command {
        RepoCommand::Create(create_args) => create(&host, create_args, out),
        RepoCommand::List(list_args) => list(&host, list_args, out),
        RepoCommand::View(view_args) => view(&host, view_args, out),
    }
}

/// A client with this host's token. Signed out is `Auth` right here.
pub(super) fn signed_in(host: &str) -> Result<Api, NsitError> {
    let (token, _) = token_for(host, None)?;
    Api::new(host, Some(token))
}

// ---- create ------------------------------------------------------------------------

fn create(host: &str, args: &RepoCreateArgs, out: &Out) -> Result<(), NsitError> {
    let api = signed_in(host)?;
    validate_repo_name(&args.name)?;
    // Private unless --public. A name that is taken comes back as the server's
    // own message (exit 1).
    let repo = api.create_repo(&args.name, args.description.as_deref(), !args.public)?;
    out.data(&repo, created_text)
}

fn created_text(repo: &RepoJson) -> String {
    format!(
        "Created {} ({}).\nurl:   {}\nclone: {}",
        one_line(&repo.full_name, 140),
        visibility(repo),
        one_line(&repo.html_url, 300),
        one_line(&repo.clone_url, 300)
    )
}

// ---- list --------------------------------------------------------------------------

fn list(host: &str, args: &RepoListArgs, out: &Out) -> Result<(), NsitError> {
    let api = signed_in(host)?;
    let repos = api.repos(args.owner.as_deref())?;
    if repos.is_empty() && !out.json {
        out.info("No repositories.");
    }
    out.data(&repos, |repos| repos_table(repos, out.color))
}

/// NAME, VISIBILITY and DESCRIPTION in aligned columns. Nothing at all for an
/// empty list. Color, when asked for, only makes the header line bold.
fn repos_table(repos: &[RepoJson], color: bool) -> String {
    if repos.is_empty() {
        return String::new();
    }
    let rows: Vec<[String; 3]> = repos
        .iter()
        .map(|repo| {
            [
                one_line(&repo.full_name, 140),
                visibility(repo).to_string(),
                one_line(&repo.description, TABLE_DESCRIPTION_CHARS),
            ]
        })
        .collect();
    let header = [
        "NAME".to_string(),
        "VISIBILITY".to_string(),
        "DESCRIPTION".to_string(),
    ];
    let width = |column: usize| {
        std::iter::once(&header)
            .chain(&rows)
            .map(|row| row[column].chars().count())
            .max()
            .unwrap_or(0)
    };
    let (name_width, visibility_width) = (width(0), width(1));
    let line = |row: &[String; 3]| {
        format!(
            "{:<name_width$}  {:<visibility_width$}  {}",
            row[0], row[1], row[2]
        )
        .trim_end()
        .to_string()
    };
    let mut lines = Vec::with_capacity(rows.len() + 1);
    let header_line = line(&header);
    lines.push(if color {
        format!("\u{1b}[1m{header_line}\u{1b}[0m")
    } else {
        header_line
    });
    lines.extend(rows.iter().map(line));
    lines.join("\n")
}

// ---- view --------------------------------------------------------------------------

fn view(host: &str, args: &RepoViewArgs, out: &Out) -> Result<(), NsitError> {
    let target = named_repo(host, &args.repo)?;
    // The token for the server the repository is on, not for the selected one.
    let (token, _) = token_for_repo(host, &target)?;
    let repo = Api::new(&target.host, Some(token))?
        .repo(&target.owner, &target.name)
        .map_err(not_found)?;
    out.data(&repo, view_text)
}

/// The repository `input` names (`name`, `owner/name` or a URL) on the server
/// selected with `host`. A bare name is yours, which needs to know who you are:
/// signed out is reported here, with no network traffic.
pub(super) fn named_repo(host: &str, input: &str) -> Result<RepoRef, NsitError> {
    let base = base_url(host)?;
    let default_owner = if needs_default_owner(input) {
        let (token, source) = token_for(host, None)?;
        signed_in_login(host, source, &token)?
    } else {
        String::new()
    };
    parse_repo_ref(input, &default_owner, &base)
}

/// A repository you may not see looks exactly like one that is not there.
pub(super) fn not_found(err: NsitError) -> NsitError {
    match err {
        NsitError::Api { status: 404, .. } => NsitError::Api {
            status: 404,
            code: "not_found".into(),
            message: "repository not found or no access".into(),
        },
        other => other,
    }
}

fn view_text(repo: &RepoJson) -> String {
    let mut lines = vec![format!(
        "{} ({})",
        one_line(&repo.full_name, 140),
        visibility(repo)
    )];
    let description = one_line(&repo.description, 400);
    if !description.is_empty() {
        lines.push(description);
    }
    // ISO-8601: the day is enough for people (`--json` has the whole time).
    let created = repo.created_at.split('T').next().unwrap_or_default();
    lines.push(format!(
        "default branch: {}",
        one_line(&repo.default_branch, 100)
    ));
    lines.push(format!("url:            {}", one_line(&repo.html_url, 300)));
    lines.push(format!(
        "clone:          {}",
        one_line(&repo.clone_url, 300)
    ));
    lines.push(format!("created:        {}", one_line(created, 40)));
    lines.join("\n")
}

fn visibility(repo: &RepoJson) -> &'static str {
    if repo.private {
        "private"
    } else {
        "public"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(owner: &str, name: &str, private: bool, description: &str) -> RepoJson {
        RepoJson {
            owner: owner.into(),
            name: name.into(),
            full_name: format!("{owner}/{name}"),
            description: description.into(),
            private,
            default_branch: "main".into(),
            clone_url: format!("https://git.iam.bot/{owner}/{name}.git"),
            html_url: format!("https://git.iam.bot/{owner}/{name}"),
            created_at: "2026-10-18T09:30:00.000Z".into(),
        }
    }

    #[test]
    fn the_table_has_aligned_columns_and_a_header() {
        let table = repos_table(
            &[
                repo("ada", "tools", true, "Small tools"),
                repo("grace", "compiler-experiments", false, ""),
            ],
            false,
        );
        let lines: Vec<&str> = table.lines().collect();
        assert_eq!(lines.len(), 3, "{table}");
        assert!(lines[0].starts_with("NAME"), "{table}");
        let column = |line: &str, word: &str| {
            line.find(word)
                .unwrap_or_else(|| panic!("{word} in {line:?}"))
        };
        // VISIBILITY and DESCRIPTION start at the same place on every row.
        let visibility = column(lines[0], "VISIBILITY");
        assert_eq!(column(lines[1], "private"), visibility, "{table}");
        assert_eq!(column(lines[2], "public"), visibility, "{table}");
        let description = column(lines[0], "DESCRIPTION");
        assert_eq!(column(lines[1], "Small tools"), description, "{table}");
        assert!(lines[1].starts_with("ada/tools "), "{table}");
        assert!(
            lines[2].starts_with("grace/compiler-experiments "),
            "{table}"
        );
    }

    #[test]
    fn the_table_has_no_trailing_spaces_and_no_escape_codes_without_color() {
        let table = repos_table(
            &[repo("ada", "tools", true, ""), repo("ada", "x", false, "d")],
            false,
        );
        for line in table.lines() {
            assert_eq!(line, line.trim_end(), "{line:?}");
        }
        assert!(!table.contains('\u{1b}'), "{table:?}");
    }

    #[test]
    fn color_only_touches_the_header_and_keeps_the_columns_aligned() {
        let plain = repos_table(&[repo("ada", "tools", true, "d")], false);
        let colored = repos_table(&[repo("ada", "tools", true, "d")], true);
        assert!(colored.contains('\u{1b}'), "{colored:?}");
        let strip = |s: &str| {
            let mut out = String::new();
            let mut chars = s.chars();
            while let Some(c) = chars.next() {
                if c == '\u{1b}' {
                    for c in chars.by_ref() {
                        if c == 'm' {
                            break;
                        }
                    }
                } else {
                    out.push(c);
                }
            }
            out
        };
        assert_eq!(strip(&colored), plain);
    }

    #[test]
    fn descriptions_from_the_server_are_one_clean_short_line() {
        let nasty = "line one\nline two \u{1b}[31mred\u{7}";
        let long = "x".repeat(200);
        let table = repos_table(
            &[repo("ada", "a", true, nasty), repo("ada", "b", true, &long)],
            false,
        );
        assert_eq!(table.lines().count(), 3, "{table:?}");
        assert!(
            !table.contains('\u{1b}') && !table.contains('\u{7}'),
            "{table:?}"
        );
        assert!(table.contains("line one line two"), "{table:?}");
        let longest = table.lines().map(|l| l.chars().count()).max().unwrap();
        assert!(longest < 120, "the description is cut: {longest}");
        assert!(table.contains("..."), "{table:?}");
    }

    #[test]
    fn an_empty_list_prints_no_table_at_all() {
        assert_eq!(repos_table(&[], false), "");
        assert_eq!(repos_table(&[], true), "");
    }

    #[test]
    fn creating_prints_the_repository_and_both_urls() {
        let text = created_text(&repo("ada", "tools", true, ""));
        assert!(text.contains("ada/tools"), "{text}");
        assert!(text.contains("private"), "{text}");
        assert!(
            text.contains("https://git.iam.bot/ada/tools\n")
                || text.ends_with("https://git.iam.bot/ada/tools"),
            "{text}"
        );
        assert!(text.contains("https://git.iam.bot/ada/tools.git"), "{text}");
        let public = created_text(&repo("ada", "tools", false, ""));
        assert!(
            public.contains("public") && !public.contains("private"),
            "{public}"
        );
    }

    #[test]
    fn viewing_shows_the_details_people_ask_for() {
        let text = view_text(&repo("ada", "tools", true, "Small tools"));
        for needle in [
            "ada/tools",
            "private",
            "Small tools",
            "main",
            "https://git.iam.bot/ada/tools",
            "https://git.iam.bot/ada/tools.git",
            "2026-10-18",
        ] {
            assert!(text.contains(needle), "{needle} missing from:\n{text}");
        }
        let bare = view_text(&repo("ada", "tools", false, ""));
        assert!(bare.contains("public"), "{bare}");
        assert!(
            !bare.contains("\n\n"),
            "no blank description line: {bare:?}"
        );
    }

    #[test]
    fn server_text_in_the_detail_view_is_cleaned_too() {
        let text = view_text(&repo("ada", "tools", true, "hi \u{1b}[31mthere\nfriend"));
        assert!(!text.contains('\u{1b}'), "{text:?}");
        assert!(text.contains("hi [31mthere friend"), "{text:?}");
    }

    #[test]
    fn a_404_is_the_same_message_whether_missing_or_hidden() {
        let hidden = not_found(NsitError::Api {
            status: 404,
            code: "not_found".into(),
            message: "Repository not found".into(),
        });
        assert_eq!(hidden.to_string(), "repository not found or no access");
        assert_eq!(hidden.exit_code(), 1);
        // Other failures keep their own words and exit codes.
        let other = not_found(NsitError::Api {
            status: 500,
            code: "internal".into(),
            message: "Something went wrong on our end.".into(),
        });
        assert_eq!(other.to_string(), "Something went wrong on our end.");
        let auth = not_found(NsitError::Auth("nope".into()));
        assert_eq!(auth.exit_code(), 3);
    }
}
