//! `nsit add`: stage files and directories for the next commit.
//!
//! Ignored files inside a directory that is named are skipped quietly, as
//! git does. A file that is named and ignored is a usage error: staging it is
//! almost certainly a mistake, and saying nothing would hide that. (A tracked
//! file stays stageable after it starts matching an ignore rule.)

use std::path::Path;

use serde::Serialize;

use crate::cli::{AddArgs, GlobalArgs};
use crate::error::NsitError;
use crate::git::open_repo;
use crate::git::paths::repo_relative;
use crate::git::stage::stage_paths;
use crate::output::{clean_for_terminal, Out};

/// How many staged paths the text lists before it counts the rest.
const LISTED: usize = 20;

/// `--json` for `nsit add`: the paths whose staged state changed.
#[derive(Debug, Serialize)]
struct AddJson {
    staged: Vec<String>,
}

pub fn run(args: &AddArgs, _global: &GlobalArgs, out: &Out, base: &Path) -> Result<(), NsitError> {
    let repo = open_repo(base)?;
    let rels = args
        .paths
        .iter()
        .map(|typed| repo_relative(&repo, base, typed))
        .collect::<Result<Vec<_>, _>>()?;
    let mut index = repo.index()?;
    let staged = stage_paths(&repo, &mut index, &rels)?;
    index.write()?;
    out.data(&AddJson { staged }, |json| describe(&json.staged, out.tty))
}

fn describe(staged: &[String], tty: bool) -> String {
    if staged.is_empty() {
        return "nothing new to stage".to_string();
    }
    let show = |path: &str| {
        let path = if tty {
            clean_for_terminal(path)
        } else {
            path.to_string()
        };
        format!("staged {path}")
    };
    let mut lines: Vec<String> = staged.iter().take(LISTED).map(|p| show(p)).collect();
    if staged.len() > LISTED {
        lines.push(format!("... and {} more", staged.len() - LISTED));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_staged_says_so() {
        assert_eq!(describe(&[], false), "nothing new to stage");
    }

    #[test]
    fn each_staged_path_is_listed_and_a_long_list_is_counted() {
        let few: Vec<String> = vec!["a.txt".into(), "d/b.txt".into()];
        assert_eq!(describe(&few, false), "staged a.txt\nstaged d/b.txt");

        let many: Vec<String> = (0..25).map(|i| format!("f{i}.txt")).collect();
        let text = describe(&many, false);
        assert_eq!(text.lines().count(), LISTED + 1);
        assert!(text.ends_with("... and 5 more"), "{text}");
    }

    #[test]
    fn names_are_cleaned_for_a_terminal() {
        let names = vec!["a\u{1b}[31m.txt".to_string()];
        assert_eq!(describe(&names, true), "staged a[31m.txt");
        assert!(describe(&names, false).contains('\u{1b}'));
    }
}
