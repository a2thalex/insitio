//! Progress for libgit2's network operations: what to show while a pack is
//! downloaded or uploaded, and when to show it.
//!
//! Progress is for people at a terminal. It goes to stderr only (never
//! stdout, which carries data), only when stdout and stderr are terminals,
//! and never with `-q`. Text the remote sends is stripped of control
//! characters first, so a server cannot write terminal escapes to the screen.

use std::io::{self, Write};
use std::rc::Rc;

use git2::RemoteCallbacks;
/// Where progress text is written (stderr; a test collects it in memory).
pub(super) type Sink<'a> = Rc<dyn Fn(&str) + 'a>;

/// Progress is for people at a terminal, and `-q` turns it off.
pub(super) fn progress_wanted(tty: bool, quiet: bool) -> bool {
    tty && !quiet
}

/// Show the three kinds of progress libgit2 reports: the download, what the
/// remote says while it prepares one, and the upload. They only ever write
/// through `sink`; none of them can stop the operation.
pub(super) fn install_progress<'a>(callbacks: &mut RemoteCallbacks<'a>, sink: Sink<'a>) {
    let mut download = LineProgress::new();
    let download_sink = Rc::clone(&sink);
    callbacks.transfer_progress(move |p| {
        let stats = TransferStats {
            total_objects: p.total_objects(),
            received_objects: p.received_objects(),
            total_deltas: p.total_deltas(),
            indexed_deltas: p.indexed_deltas(),
            received_bytes: p.received_bytes(),
        };
        if let Some((line, done)) = transfer_line(&stats) {
            if let Some(text) = download.show(&line, done) {
                download_sink(&text);
            }
        }
        true
    });

    let remote_sink = Rc::clone(&sink);
    callbacks.sideband_progress(move |data| {
        let text = clean_sideband(data);
        if !text.is_empty() {
            remote_sink(&text);
        }
        true
    });

    let mut upload = LineProgress::new();
    callbacks.push_transfer_progress(move |current, total, bytes| {
        if let Some((line, done)) = push_line(current, total, bytes) {
            if let Some(text) = upload.show(&line, done) {
                sink(&text);
            }
        }
    });
}

/// Progress goes to stderr, never stdout, and a closed stderr is not an error.
pub(super) fn write_to_stderr(text: &str) {
    let mut stderr = io::stderr().lock();
    let _ = stderr.write_all(text.as_bytes());
    let _ = stderr.flush();
}

/// A status line that is rewritten in place (`\r`), shown again only when it
/// changes, and ended with a newline once it is done.
struct LineProgress {
    last: String,
    /// How wide the row on the screen is, so a shorter line can cover it.
    width: usize,
}

impl LineProgress {
    fn new() -> LineProgress {
        LineProgress {
            last: String::new(),
            width: 0,
        }
    }

    /// The text to write for `line`, or `None` when it is the one on screen.
    fn show(&mut self, line: &str, done: bool) -> Option<String> {
        if line == self.last {
            return None;
        }
        let mut text = format!("\r{line:<width$}", width = self.width);
        self.width = self.width.max(line.chars().count());
        if done {
            text.push('\n');
        }
        self.last = line.to_string();
        Some(text)
    }
}

/// What libgit2 reports while it downloads a pack.
struct TransferStats {
    total_objects: usize,
    received_objects: usize,
    total_deltas: usize,
    indexed_deltas: usize,
    received_bytes: usize,
}

/// The status line for a download, and whether it is the last one.
fn transfer_line(s: &TransferStats) -> Option<(String, bool)> {
    if s.total_objects == 0 {
        return None;
    }
    if s.received_objects < s.total_objects {
        return Some((
            format!(
                "Receiving objects: {}% ({}/{}), {}",
                percent(s.received_objects, s.total_objects),
                s.received_objects,
                s.total_objects,
                human_bytes(s.received_bytes)
            ),
            false,
        ));
    }
    if s.total_deltas > 0 {
        let done = s.indexed_deltas >= s.total_deltas;
        let end = if done { ", done." } else { "" };
        return Some((
            format!(
                "Resolving deltas: {}% ({}/{}){end}",
                percent(s.indexed_deltas, s.total_deltas),
                s.indexed_deltas.min(s.total_deltas),
                s.total_deltas
            ),
            done,
        ));
    }
    Some((
        format!(
            "Receiving objects: 100% ({n}/{n}), {}, done.",
            human_bytes(s.received_bytes),
            n = s.total_objects
        ),
        true,
    ))
}

/// The status line for an upload, and whether it is the last one.
fn push_line(current: usize, total: usize, bytes: usize) -> Option<(String, bool)> {
    if total == 0 {
        return None;
    }
    let done = current >= total;
    let end = if done { ", done." } else { "" };
    Some((
        format!(
            "Writing objects: {}% ({}/{}), {}{end}",
            percent(current, total),
            current.min(total),
            total,
            human_bytes(bytes)
        ),
        done,
    ))
}

fn percent(part: usize, whole: usize) -> u64 {
    (part.min(whole) as u64 * 100 / whole as u64).min(100)
}

/// `1.5 KiB`, `20.0 MiB`; plain bytes below 1 KiB.
fn human_bytes(n: usize) -> String {
    const UNITS: [&str; 4] = ["KiB", "MiB", "GiB", "TiB"];
    if n < 1024 {
        return format!("{n} bytes");
    }
    let mut value = n as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

/// Text the remote sent along with the pack ("Counting objects..."), made safe
/// for a terminal: `\r` and `\n` stay (that is how it redraws its lines) and
/// every other control character, escape sequences included, is dropped.
fn clean_sideband(data: &[u8]) -> String {
    String::from_utf8_lossy(data)
        .chars()
        .filter(|c| matches!(c, '\n' | '\r') || !c.is_control())
        .collect()
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::test_support::{fetch_with, source_repo};

    #[test]
    fn progress_is_for_terminals_and_never_with_quiet() {
        assert!(progress_wanted(true, false));
        assert!(!progress_wanted(true, true), "-q silences it");
        assert!(!progress_wanted(false, false), "not a terminal");
        assert!(!progress_wanted(false, true));
    }

    #[test]
    fn progress_text_reaches_the_sink_during_a_fetch() {
        let dir = tempfile::tempdir().unwrap();
        let source = source_repo(dir.path());
        let shown = Rc::new(RefCell::new(String::new()));
        let sink: Sink<'static> = {
            let shown = Rc::clone(&shown);
            Rc::new(move |text: &str| shown.borrow_mut().push_str(text))
        };
        let mut callbacks = RemoteCallbacks::new();
        install_progress(&mut callbacks, sink);
        fetch_with(&source, &dir.path().join("dest"), callbacks);
        let text = shown.borrow().clone();
        assert!(text.contains("Receiving objects"), "{text:?}");
        assert!(text.contains("done.\n"), "{text:?}");
    }
    #[test]
    fn transfer_lines_follow_receiving_then_resolving() {
        let stats = |recv, total, ideltas, tdeltas, bytes| TransferStats {
            total_objects: total,
            received_objects: recv,
            total_deltas: tdeltas,
            indexed_deltas: ideltas,
            received_bytes: bytes,
        };
        assert_eq!(transfer_line(&stats(0, 0, 0, 0, 0)), None);
        assert_eq!(
            transfer_line(&stats(42, 100, 0, 0, 1536)),
            Some((
                "Receiving objects: 42% (42/100), 1.5 KiB".to_string(),
                false
            ))
        );
        assert_eq!(
            transfer_line(&stats(100, 100, 3, 10, 2048)),
            Some(("Resolving deltas: 30% (3/10)".to_string(), false))
        );
        assert_eq!(
            transfer_line(&stats(100, 100, 10, 10, 2048)),
            Some(("Resolving deltas: 100% (10/10), done.".to_string(), true))
        );
        assert_eq!(
            transfer_line(&stats(7, 7, 0, 0, 700)),
            Some((
                "Receiving objects: 100% (7/7), 700 bytes, done.".to_string(),
                true
            ))
        );
        // Never past 100%.
        let (line, _) = transfer_line(&stats(5, 3, 0, 0, 1)).unwrap();
        assert!(
            line.starts_with("Resolving") || line.contains("100%"),
            "{line}"
        );
    }

    #[test]
    fn push_lines_count_objects_written() {
        assert_eq!(push_line(0, 0, 0), None);
        assert_eq!(
            push_line(1, 4, 100),
            Some(("Writing objects: 25% (1/4), 100 bytes".to_string(), false))
        );
        assert_eq!(
            push_line(4, 4, 3 * 1024 * 1024),
            Some((
                "Writing objects: 100% (4/4), 3.0 MiB, done.".to_string(),
                true
            ))
        );
    }

    #[test]
    fn sizes_read_naturally() {
        assert_eq!(human_bytes(0), "0 bytes");
        assert_eq!(human_bytes(1023), "1023 bytes");
        assert_eq!(human_bytes(1024), "1.0 KiB");
        assert_eq!(human_bytes(1536), "1.5 KiB");
        assert_eq!(human_bytes(20 * 1024 * 1024), "20.0 MiB");
        assert_eq!(human_bytes(5 * 1024 * 1024 * 1024), "5.0 GiB");
    }

    #[test]
    fn a_progress_line_rewrites_itself_and_skips_repeats() {
        let mut p = LineProgress::new();
        assert_eq!(
            p.show("Receiving objects: 10%", false).unwrap(),
            "\rReceiving objects: 10%"
        );
        assert_eq!(
            p.show("Receiving objects: 10%", false),
            None,
            "same line, no output"
        );
        // A shorter line is padded so nothing of the old one is left behind.
        let next = p.show("Done", false).unwrap();
        assert!(next.starts_with("\rDone"), "{next:?}");
        assert_eq!(
            next.chars().count(),
            1 + "Receiving objects: 10%".chars().count()
        );
        // The last line ends the row.
        assert!(p.show("Done, really.", true).unwrap().ends_with('\n'));
    }

    #[test]
    fn text_from_the_remote_cannot_carry_terminal_escapes() {
        assert_eq!(
            clean_sideband(b"Counting objects: 50%\rCounting objects: 100%, done.\n"),
            "Counting objects: 50%\rCounting objects: 100%, done.\n"
        );
        let cleaned = clean_sideband(b"\x1b[2J\x1b]0;title\x07hello\x00 \x08world\n");
        assert!(
            !cleaned
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\r'),
            "{cleaned:?}"
        );
        assert!(cleaned.contains("hello") && cleaned.contains("world"));
        // Bytes that are not text do not panic.
        assert!(!clean_sideband(&[0xff, 0xfe, b'o', b'k']).is_empty());
    }
}
