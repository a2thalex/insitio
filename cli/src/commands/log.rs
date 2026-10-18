//! `nsit log`: the history of the current branch, newest first.
//!
//! `--json` is an array of `{sha, author, email, date, subject}`; `date` is the
//! author date in ISO-8601 with the author's own UTC offset. `--oneline` is
//! `<short sha> <subject>`. A branch with no commits has an empty history.

use std::path::Path;

use git2::{Commit, Repository, Sort};
use serde::Serialize;

use crate::cli::{GlobalArgs, LogArgs};
use crate::error::NsitError;
use crate::git::open_repo;
use crate::git::stage::head_commit;
use crate::output::{clean_for_terminal, Out};

/// How many commits `nsit log` shows without `-n`.
const DEFAULT_COUNT: usize = 20;

/// One commit, as `--json` shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Entry {
    pub sha: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub subject: String,
    /// The rest of the message after the subject and the blank line, for the
    /// full text. Not part of the JSON.
    #[serde(skip)]
    pub body: String,
}

pub fn run(args: &LogArgs, _global: &GlobalArgs, out: &Out, base: &Path) -> Result<(), NsitError> {
    let repo = open_repo(base)?;
    let entries = history(&repo, args.max_count.unwrap_or(DEFAULT_COUNT))?;
    if entries.is_empty() && !out.json {
        out.info("No commits yet.");
    }
    out.data(&entries, |entries| {
        if args.oneline {
            oneline(entries, out.tty)
        } else {
            full(entries, out.tty)
        }
    })
}

/// Up to `limit` commits reachable from `HEAD`, newest first.
pub fn history(repo: &Repository, limit: usize) -> Result<Vec<Entry>, NsitError> {
    if head_commit(repo)?.is_none() || limit == 0 {
        return Ok(Vec::new());
    }
    let mut walk = repo.revwalk()?;
    walk.push_head()?;
    walk.set_sorting(Sort::TIME)?;
    let mut entries = Vec::new();
    for oid in walk.take(limit) {
        entries.push(entry_for(&repo.find_commit(oid?)?));
    }
    Ok(entries)
}

fn entry_for(commit: &Commit<'_>) -> Entry {
    let author = commit.author();
    let when = author.when();
    let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).into_owned();
    Entry {
        sha: commit.id().to_string(),
        author: text(author.name_bytes()),
        email: text(author.email_bytes()),
        date: iso8601(when.seconds(), when.offset_minutes()),
        subject: text(commit.summary_bytes().unwrap_or_default()),
        body: commit.body_bytes().map(text).unwrap_or_default(),
    }
}

/// `1a2b3c4 subject`, one line per commit.
fn oneline(entries: &[Entry], tty: bool) -> String {
    entries
        .iter()
        .map(|e| format!("{} {}", &e.sha[..7], terminal_safe(&e.subject, tty)))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Each commit as git shows it: id, author, date, then the message indented.
fn full(entries: &[Entry], tty: bool) -> String {
    let blocks: Vec<String> = entries
        .iter()
        .map(|e| {
            let mut lines = vec![
                format!("commit {}", e.sha),
                format!(
                    "Author: {} <{}>",
                    terminal_safe(&e.author, tty),
                    terminal_safe(&e.email, tty)
                ),
                format!("Date:   {}", e.date),
                String::new(),
                format!("    {}", terminal_safe(&e.subject, tty)),
            ];
            if !e.body.trim().is_empty() {
                lines.push(String::new());
                lines.extend(
                    terminal_safe(e.body.trim_end(), tty)
                        .lines()
                        .map(|line| format!("    {line}")),
                );
            }
            lines.join("\n")
        })
        .collect();
    blocks.join("\n\n")
}

/// Commit text is written by whoever made the commit: on a terminal it must not
/// carry escape sequences.
fn terminal_safe(text: &str, tty: bool) -> String {
    if tty {
        clean_for_terminal(text)
    } else {
        text.to_string()
    }
}

/// A time as ISO-8601 with its UTC offset: `2026-10-18T14:30:00+02:00`.
/// `seconds` is Unix time, `offset_minutes` the offset east of UTC.
pub fn iso8601(seconds: i64, offset_minutes: i32) -> String {
    let local = seconds + i64::from(offset_minutes) * 60;
    let (year, month, day) = civil_from_days(local.div_euclid(86_400));
    let in_day = local.rem_euclid(86_400);
    let sign = if offset_minutes < 0 { '-' } else { '+' };
    let offset = offset_minutes.unsigned_abs();
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}{sign}{:02}:{:02}",
        in_day / 3_600,
        in_day % 3_600 / 60,
        in_day % 60,
        offset / 60,
        offset % 60
    )
}

/// The calendar date of a day count since 1970-01-01 (proleptic Gregorian;
/// Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use git2::Signature;

    use super::*;
    use crate::test_support::{commit_file, local_repo};

    #[test]
    fn iso8601_known_instants() {
        assert_eq!(iso8601(0, 0), "1970-01-01T00:00:00+00:00");
        assert_eq!(iso8601(-1, 0), "1969-12-31T23:59:59+00:00");
        assert_eq!(iso8601(1_700_000_000, 0), "2023-11-14T22:13:20+00:00");
        // A leap day, and the day after it.
        assert_eq!(iso8601(1_709_164_800, 0), "2024-02-29T00:00:00+00:00");
        assert_eq!(iso8601(1_709_251_200, 0), "2024-03-01T00:00:00+00:00");
        // 2000 was a leap year, 2100 will not be.
        assert_eq!(iso8601(951_782_400, 0), "2000-02-29T00:00:00+00:00");
        assert_eq!(iso8601(4_107_542_400, 0), "2100-03-01T00:00:00+00:00");
        assert_eq!(iso8601(2_147_483_648, 0), "2038-01-19T03:14:08+00:00");
    }

    #[test]
    fn iso8601_shows_the_local_time_and_the_offset() {
        assert_eq!(iso8601(1_700_000_000, 120), "2023-11-15T00:13:20+02:00");
        assert_eq!(iso8601(1_700_000_000, -210), "2023-11-14T18:43:20-03:30");
        assert_eq!(iso8601(1_700_000_000, 345), "2023-11-15T03:58:20+05:45");
        // The offset can move the date across midnight in either direction.
        assert_eq!(iso8601(0, -60), "1969-12-31T23:00:00-01:00");
    }

    fn commit_as(repo: &Repository, name: &str, message: &str, when: i64, offset: i32) {
        let sig = Signature::new(name, "who@example.com", &git2::Time::new(when, offset)).unwrap();
        std::fs::write(repo.workdir().unwrap().join("f.txt"), message).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("f.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&Commit<'_>> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
            .unwrap();
    }

    #[test]
    fn history_is_newest_first_with_the_documented_fields() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_as(&repo, "Ada", "first", 1_700_000_000, 0);
        commit_as(
            &repo,
            "Grace",
            "second\n\nwith a body\nof two lines",
            1_700_003_600,
            120,
        );
        let entries = history(&repo, 20).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].subject, "second");
        assert_eq!(entries[0].author, "Grace");
        assert_eq!(entries[0].email, "who@example.com");
        assert_eq!(entries[0].date, "2023-11-15T01:13:20+02:00");
        assert_eq!(entries[0].body, "with a body\nof two lines");
        assert_eq!(entries[1].subject, "first");
        assert_eq!(entries[1].date, "2023-11-14T22:13:20+00:00");
        assert_eq!(entries[0].sha.len(), 40);
    }

    #[test]
    fn the_json_has_exactly_sha_author_email_date_subject() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_as(&repo, "Ada", "first\n\nbody", 0, 0);
        let entries = history(&repo, 20).unwrap();
        let value = serde_json::to_value(&entries).unwrap();
        let object = value[0].as_object().unwrap();
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["author", "date", "email", "sha", "subject"]);
        assert_eq!(object["subject"], "first");
    }

    #[test]
    fn the_count_limits_the_history_and_an_empty_branch_has_none() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        assert!(history(&repo, 20).unwrap().is_empty());
        for i in 0..5 {
            commit_file(&repo, &format!("f{i}.txt"), "x");
        }
        assert_eq!(history(&repo, 20).unwrap().len(), 5);
        assert_eq!(history(&repo, 3).unwrap().len(), 3);
        assert_eq!(history(&repo, 1).unwrap()[0].subject, "f4.txt");
        assert!(history(&repo, 0).unwrap().is_empty());
        assert_eq!(history(&repo, usize::MAX).unwrap().len(), 5);
    }

    #[test]
    fn the_default_is_twenty_commits() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        for i in 0..22 {
            commit_file(&repo, "same.txt", &format!("{i}"));
        }
        assert_eq!(history(&repo, DEFAULT_COUNT).unwrap().len(), 20);
    }

    #[test]
    fn oneline_is_a_short_id_and_the_subject() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_as(&repo, "Ada", "first", 0, 0);
        commit_as(&repo, "Ada", "second\n\nbody", 60, 0);
        let entries = history(&repo, 20).unwrap();
        let text = oneline(&entries, false);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], format!("{} second", &entries[0].sha[..7]));
        assert_eq!(lines[1], format!("{} first", &entries[1].sha[..7]));
    }

    #[test]
    fn the_full_text_indents_the_message_and_separates_commits() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_as(&repo, "Ada", "first", 0, 0);
        commit_as(&repo, "Grace", "second\n\nbody line", 3600, 0);
        let entries = history(&repo, 20).unwrap();
        let text = full(&entries, false);
        let want = format!(
            "commit {}\nAuthor: Grace <who@example.com>\nDate:   1970-01-01T01:00:00+00:00\n\n    second\n\n    body line\n\n\
             commit {}\nAuthor: Ada <who@example.com>\nDate:   1970-01-01T00:00:00+00:00\n\n    first",
            entries[0].sha, entries[1].sha
        );
        assert_eq!(text, want);
    }

    #[test]
    fn commit_text_cannot_carry_escape_sequences_to_a_terminal() {
        let dir = tempfile::tempdir().unwrap();
        let repo = local_repo(dir.path());
        commit_as(
            &repo,
            "Ev\u{1b}[31mil",
            "sub\u{1b}[2Jject\n\nbody\u{7}",
            0,
            0,
        );
        let entries = history(&repo, 20).unwrap();
        for text in [oneline(&entries, true), full(&entries, true)] {
            assert!(
                !text.contains('\u{1b}') && !text.contains('\u{7}'),
                "{text:?}"
            );
        }
        assert!(full(&entries, false).contains('\u{1b}'));
    }
}
