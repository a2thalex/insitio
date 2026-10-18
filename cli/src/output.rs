//! How nsit prints: data to stdout (human text, JSON, or `--jq` lines: strings raw, anything else as compact JSON),
//! progress and notes to stderr.

use std::io::{self, IsTerminal, Write};

use jaq_core::load::{self, lex, Arena, File, Loader};
use jaq_core::{compile, data, Compiler, Ctx, Vars};
use jaq_json::Val;
use serde::Serialize;

use crate::error::NsitError;

/// Output settings resolved once from the global flags and the terminal.
#[derive(Debug, Clone)]
pub struct Out {
    /// Print JSON instead of human text. Always true when `jq` is set.
    pub json: bool,
    /// jq expression applied to the JSON before printing.
    pub jq: Option<String>,
    /// stdout is a terminal.
    pub tty: bool,
    /// Color is allowed: stdout is a terminal, `NO_COLOR` is unset, and
    /// `--no-color` was not given.
    pub color: bool,
    /// `-q`: suppress `info` messages.
    pub quiet: bool,
}

impl Out {
    /// Build from the global flags and the real terminal and environment.
    /// A malformed `--jq` expression is rejected here, before any command
    /// has done anything.
    pub fn new(
        json: bool,
        jq: Option<String>,
        quiet: bool,
        no_color: bool,
    ) -> Result<Out, NsitError> {
        if let Some(expr) = &jq {
            compile_jq(expr)?;
        }
        let tty = io::stdout().is_terminal();
        let no_color_env = std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty());
        Ok(Out {
            json: json || jq.is_some(),
            tty,
            color: color_enabled(tty, no_color, no_color_env),
            jq,
            quiet,
        })
    }

    /// The lines `data` would print. Separate from `data` so it can be tested.
    pub fn render<T: Serialize>(
        &self,
        value: &T,
        human: impl FnOnce(&T) -> String,
    ) -> Result<Vec<String>, NsitError> {
        if let Some(expr) = &self.jq {
            let input = serde_json::to_vec(value).map_err(serialize_error)?;
            return run_jq(expr, &input, self.tty);
        }
        if self.json {
            let text = if self.tty {
                serde_json::to_string_pretty(value)
            } else {
                serde_json::to_string(value)
            };
            return Ok(vec![text.map_err(serialize_error)?]);
        }
        let text = human(value);
        let text = text.trim_end_matches('\n');
        Ok(if text.is_empty() {
            Vec::new()
        } else {
            vec![text.to_string()]
        })
    }

    /// Print a command's result to stdout.
    pub fn data<T: Serialize>(
        &self,
        value: &T,
        human: impl FnOnce(&T) -> String,
    ) -> Result<(), NsitError> {
        let lines = self.render(value, human)?;
        let stdout = io::stdout();
        write_lines(&mut stdout.lock(), &lines)
    }

    /// Print a progress note or hint to stderr unless `-q` was given.
    pub fn info(&self, msg: &str) {
        self.info_to(&mut io::stderr().lock(), msg);
    }

    fn info_to(&self, w: &mut impl Write, msg: &str) {
        if !self.quiet {
            // Notes are best effort: a closed stderr must not fail the command.
            let _ = writeln!(w, "{msg}");
        }
    }

    /// Whether it is reasonable to ask the user a question.
    pub fn is_interactive(&self) -> bool {
        self.tty && io::stdin().is_terminal()
    }
}

fn color_enabled(tty: bool, no_color_flag: bool, no_color_env_set: bool) -> bool {
    tty && !no_color_flag && !no_color_env_set
}

fn serialize_error(e: serde_json::Error) -> NsitError {
    NsitError::Other(format!("cannot serialize output: {e}"))
}

/// Write each line plus a newline. A reader that went away (`nsit log | head`)
/// ends the output quietly instead of failing the command.
fn write_lines(w: &mut impl Write, lines: &[String]) -> Result<(), NsitError> {
    let result = lines
        .iter()
        .try_for_each(|line| writeln!(w, "{line}"))
        .and_then(|()| w.flush());
    match result {
        Err(e) if e.kind() != io::ErrorKind::BrokenPipe => Err(e.into()),
        _ => Ok(()),
    }
}

/// A compiled jq program over jaq's JSON values.
type JqFilter = jaq_core::Filter<data::JustLut<Val>>;

fn bad_jq(reason: String) -> NsitError {
    NsitError::Usage(format!("invalid --jq expression: {reason}"))
}

/// Parse and compile a jq expression with the jq standard library.
fn compile_jq(expr: &str) -> Result<JqFilter, NsitError> {
    let defs = jaq_core::defs()
        .chain(jaq_std::defs())
        .chain(jaq_json::defs());
    let funs = jaq_core::funs()
        .chain(jaq_std::funs())
        .chain(jaq_json::funs());

    let arena = Arena::default();
    let modules = Loader::new(defs)
        .load(
            &arena,
            File {
                code: expr,
                path: (),
            },
        )
        .map_err(|errs| bad_jq(describe_load_errors(&errs)))?;
    Compiler::default()
        .with_funs(funs)
        .compile(modules)
        .map_err(|errs| bad_jq(describe_compile_errors(&errs)))
}

/// Run `expr` over one JSON document; each output becomes one line, by gh's
/// rule: a string prints as its text (no quotes, nothing escaped), anything
/// else (number, bool, null, array, object) as compact JSON. On a terminal
/// (`tty`) a raw string is cleaned of control characters first.
fn run_jq(expr: &str, input_json: &[u8], tty: bool) -> Result<Vec<String>, NsitError> {
    let filter = compile_jq(expr)?;
    let input = jaq_json::read::parse_single(input_json)
        .map_err(|e| NsitError::Other(format!("cannot read output as JSON: {e}")))?;
    let ctx = Ctx::<data::JustLut<Val>>::new(&filter.lut, Vars::new([]));

    let mut lines = Vec::new();
    for item in filter.id.run((ctx, input)) {
        match item {
            Ok(value) => lines.push(jq_line(&value, tty)),
            Err(exception) => match exception.get_err() {
                // A syntax or compile error was already rejected up front
                // (exit 2). This one depends on the data, and the command may
                // have acted by now, so it is a general failure (exit 1).
                Ok(e) => return Err(NsitError::Other(format!("jq: {e}"))),
                // `halt`: stop here. jaq's own `unwrap_valr` would exit the
                // whole process, which is not ours to give away.
                Err(_halt) => break,
            },
        }
    }
    Ok(lines)
}

/// One `--jq` result as printed: raw text for a string (a byte string, which
/// jq's `@base64d` produces, counts as text), compact JSON for the rest.
///
/// Raw text can hold anything the data held, a repository description with a
/// terminal escape sequence included. When stdout is a terminal those control
/// characters are removed (`clean_for_terminal`); piped output stays exactly
/// the bytes of the string, which is what a script wants. JSON text needs no
/// cleaning: it writes control characters as `\u001b` escapes.
fn jq_line(value: &Val, tty: bool) -> String {
    match value {
        Val::TStr(text) | Val::BStr(text) => {
            let raw = String::from_utf8_lossy(&text[..]).into_owned();
            if tty {
                clean_for_terminal(&raw)
            } else {
                raw
            }
        }
        other => other.to_string(),
    }
}

/// `text` without control characters other than newline and tab. A terminal
/// treats ESC (and the C1 range, one byte or two) as the start of a command, so
/// text that did not come from nsit must not carry them to one.
pub(crate) fn clean_for_terminal(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .collect()
}

fn describe_load_errors(errs: &[(File<&str, ()>, load::Error<&str>)]) -> String {
    let mut parts = Vec::new();
    for (_file, err) in errs {
        match err {
            load::Error::Lex(errors) => {
                parts.extend(errors.iter().map(|(expect, rest)| {
                    format!("expected {} {}", lex_expectation(expect), location(rest))
                }));
            }
            load::Error::Parse(errors) => {
                parts.extend(errors.iter().map(|(expect, rest)| {
                    format!("expected {} {}", expect.as_str(), location(rest))
                }));
            }
            load::Error::Io(errors) => {
                parts.extend(
                    errors
                        .iter()
                        .map(|(path, reason)| format!("{path}: {reason}")),
                );
            }
        }
    }
    join_reasons(parts, "syntax error")
}

fn describe_compile_errors(errs: &compile::Errors<&str, ()>) -> String {
    let parts = errs
        .iter()
        .flat_map(|(_file, errors)| errors)
        .map(|(name, undefined)| format!("undefined {} `{name}`", undefined.as_str()))
        .collect();
    join_reasons(parts, "cannot compile")
}

/// First reason only: one line per error, and the first one is the cause.
fn join_reasons(parts: Vec<String>, fallback: &str) -> String {
    parts
        .into_iter()
        .next()
        .unwrap_or_else(|| fallback.to_string())
}

/// What the lexer wanted. jaq's own `Expect::as_str` panics on a delimiter
/// it does not know, so unknown ones get a generic description here.
fn lex_expectation(expect: &lex::Expect<&str>) -> &'static str {
    match expect {
        lex::Expect::Delim(d) if !matches!(*d, "(" | "[" | "{" | "\"") => "a closing delimiter",
        other => other.as_str(),
    }
}

/// Where in the expression an error happened, from the unparsed remainder.
fn location(rest: &str) -> String {
    let rest = rest.trim();
    if rest.is_empty() {
        return "at the end of the expression".to_string();
    }
    let snippet: String = rest.chars().take(24).collect();
    let ellipsis = if rest.chars().count() > 24 { "..." } else { "" };
    format!("at `{snippet}{ellipsis}`")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn out(json: bool, jq: Option<&str>, tty: bool) -> Out {
        Out {
            json,
            jq: jq.map(str::to_string),
            tty,
            color: false,
            quiet: false,
        }
    }

    fn jq(expr: &str, value: serde_json::Value) -> Result<Vec<String>, NsitError> {
        out(true, Some(expr), false).render(&value, |_| unreachable!("human output with --jq"))
    }

    #[test]
    fn jq_string_results_print_raw_without_quotes() {
        // gh's rule: a string is printed as its text, not as a JSON string.
        assert_eq!(
            jq(".name", json!({"name": "tools"})).unwrap(),
            vec!["tools"]
        );
        // Quotes and newlines inside it are printed as they are.
        assert_eq!(
            jq(".", json!("say \"hi\"\nthen go")).unwrap(),
            vec!["say \"hi\"\nthen go"]
        );
        assert_eq!(jq(".", json!("")).unwrap(), vec![""]);
    }

    #[test]
    fn jq_strings_inside_arrays_and_objects_stay_json() {
        assert_eq!(
            jq(".", json!({"name": "tools", "tags": ["a", "b"]})).unwrap(),
            vec![r#"{"name":"tools","tags":["a","b"]}"#]
        );
        assert_eq!(
            jq("[.name, .n]", json!({"name": "tools", "n": 1})).unwrap(),
            vec![r#"["tools",1]"#]
        );
    }

    #[test]
    fn jq_mixed_results_are_raw_text_or_compact_json_one_per_line() {
        let lines = jq(
            ".[]",
            json!(["a", 1, true, null, 2.5, ["b"], {"c": "d"}, "line\nbreak"]),
        )
        .unwrap();
        assert_eq!(
            lines,
            vec![
                "a",
                "1",
                "true",
                "null",
                "2.5",
                r#"["b"]"#,
                r#"{"c":"d"}"#,
                "line\nbreak"
            ]
        );
    }

    #[test]
    fn jq_results_built_by_the_expression_follow_the_same_rule() {
        // A string made by the expression, and bytes decoded to text.
        assert_eq!(
            jq(r#""n=" + (.n | tostring)"#, json!({"n": 3})).unwrap(),
            vec!["n=3"]
        );
        assert_eq!(
            jq(".s | @base64d", json!({"s": "dG9vbHM="})).unwrap(),
            vec!["tools"]
        );
        assert_eq!(jq(".n | tostring", json!({"n": 3})).unwrap(), vec!["3"]);
    }

    #[test]
    fn each_jq_output_is_its_own_line() {
        let lines = jq(
            ".[].name",
            json!([{"name": "a"}, {"name": "b"}, {"name": "c"}]),
        )
        .unwrap();
        assert_eq!(lines, vec!["a", "b", "c"]);
    }

    #[test]
    fn jq_numbers_bools_null_and_objects_print_as_compact_json() {
        assert_eq!(jq(".n", json!({"n": 42})).unwrap(), vec!["42"]);
        assert_eq!(jq(".ok", json!({"ok": true})).unwrap(), vec!["true"]);
        assert_eq!(jq(".missing", json!({})).unwrap(), vec!["null"]);
        assert_eq!(
            jq(".", json!({"a": 1, "b": [1, 2], "c": {"d": null}})).unwrap(),
            vec![r#"{"a":1,"b":[1,2],"c":{"d":null}}"#]
        );
    }

    /// `--jq` on a terminal or piped, for one value.
    fn jq_on(tty: bool, expr: &str, value: serde_json::Value) -> Vec<String> {
        out(true, Some(expr), tty)
            .render(&value, |_| unreachable!("human output with --jq"))
            .unwrap()
    }

    #[test]
    fn on_a_terminal_raw_jq_strings_lose_control_characters() {
        let nasty = json!({"d": "hi \u{1b}[31mred\u{7}\r\nnext\tcol\u{9b}31m end"});
        // ESC, BEL, CR and the one-character CSI (U+009B) go; text, `[31m`,
        // newline and tab stay.
        assert_eq!(
            jq_on(true, ".d", nasty),
            vec!["hi [31mred\nnext\tcol31m end"]
        );
    }

    #[test]
    fn piped_raw_jq_strings_are_byte_exact() {
        let nasty = "hi \u{1b}[31mred\u{7}\r\nnext\tcol\u{9b}31m end";
        assert_eq!(jq_on(false, ".d", json!({ "d": nasty })), vec![nasty]);
    }

    #[test]
    fn jq_json_output_is_escaped_so_it_needs_no_cleaning_on_a_terminal() {
        let value = json!({"d": "a\u{1b}[31mb"});
        let tty = jq_on(true, ".", value.clone());
        assert_eq!(tty, vec![r#"{"d":"a\u001b[31mb"}"#]);
        assert_eq!(jq_on(false, ".", value), tty);
        // A string inside an array is JSON too.
        assert_eq!(
            jq_on(true, ".d", json!({"d": ["x\u{1b}"]})),
            vec![r#"["x\u001b"]"#]
        );
    }

    #[test]
    fn terminal_cleaning_keeps_plain_and_non_ascii_text() {
        assert_eq!(clean_for_terminal("café ☃\tgo\nnow"), "café ☃\tgo\nnow");
        assert_eq!(clean_for_terminal("\u{1b}]0;title\u{7}ok"), "]0;titleok");
        assert_eq!(clean_for_terminal("a\u{0}b\u{7f}c\u{85}d"), "abcd");
        assert_eq!(clean_for_terminal(""), "");
    }

    #[test]
    fn jq_keeps_non_ascii_text() {
        assert_eq!(
            jq(".name", json!({"name": "café ☃"})).unwrap(),
            vec!["café ☃"]
        );
    }

    #[test]
    fn jq_with_no_output_prints_nothing() {
        assert!(jq("empty", json!({"a": 1})).unwrap().is_empty());
        assert!(jq(".[]", json!([])).unwrap().is_empty());
    }

    #[test]
    fn jq_standard_library_is_available() {
        assert_eq!(
            jq("map(.n) | add", json!([{"n": 1}, {"n": 2}])).unwrap(),
            vec!["3"]
        );
        assert_eq!(
            jq(
                "[.[] | select(.private)] | length",
                json!([{"private": true}, {"private": false}])
            )
            .unwrap(),
            vec!["1"]
        );
    }

    #[test]
    fn jq_halt_stops_quietly_instead_of_exiting_the_process() {
        assert_eq!(jq("\"x\", halt, \"y\"", json!(null)).unwrap(), vec!["x"]);
    }

    #[test]
    fn bad_jq_syntax_is_a_readable_usage_error() {
        for expr in [".[", ".name |", "{", "foo(", "\"unterminated", ")"] {
            let err = jq(expr, json!({})).unwrap_err();
            assert!(matches!(err, NsitError::Usage(_)), "{expr}: {err:?}");
            let text = err.to_string();
            assert!(
                text.starts_with("invalid --jq expression"),
                "{expr}: {text}"
            );
            assert!(
                !text.contains("Lex(") && !text.contains("Parse("),
                "debug dump for {expr}: {text}"
            );
            assert!(!text.contains('\n'), "{expr}: {text:?}");
            assert_eq!(err.exit_code(), 2);
        }
    }

    #[test]
    fn undefined_jq_filter_names_the_filter() {
        let err = jq("nosuchfilter", json!({})).unwrap_err();
        assert!(matches!(err, NsitError::Usage(_)), "{err:?}");
        assert!(err.to_string().contains("nosuchfilter"), "{err}");
    }

    #[test]
    fn jq_runtime_error_is_a_general_failure_with_the_reason() {
        // The expression is fine; the data is not. By the time this happens
        // the command may already have acted, so it is not a usage error.
        assert!(Out::new(false, Some(".a.b".into()), false, false).is_ok());
        let err = jq(".a.b", json!({"a": 1})).unwrap_err();
        assert!(matches!(err, NsitError::Other(_)), "{err:?}");
        assert!(err.to_string().starts_with("jq: "), "{err}");
        assert!(!err.to_string().contains('\n'), "{err:?}");
        assert_eq!(err.exit_code(), 1);
    }

    #[test]
    fn jq_wins_over_human_output_and_implies_json() {
        let o = Out::new(false, Some(".name".into()), false, false).unwrap();
        assert!(o.json);
        let lines = o
            .render(&json!({"name": "tools"}), |_| unreachable!())
            .unwrap();
        assert_eq!(lines, vec!["tools"]);
    }

    #[test]
    fn new_rejects_a_bad_jq_expression_up_front() {
        let err = Out::new(false, Some(".[".into()), false, false).unwrap_err();
        assert_eq!(err.exit_code(), 2);
        assert!(Out::new(false, Some(".a | .b".into()), false, false).is_ok());
    }

    #[test]
    fn json_is_compact_when_piped_and_indented_on_a_terminal() {
        let v = json!({"name": "tools", "n": 1});
        let piped = out(true, None, false)
            .render(&v, |_| unreachable!())
            .unwrap();
        assert_eq!(piped, vec![r#"{"n":1,"name":"tools"}"#]);
        let tty = out(true, None, true)
            .render(&v, |_| unreachable!())
            .unwrap();
        assert_eq!(tty.len(), 1);
        assert!(tty[0].contains('\n'), "{tty:?}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&tty[0]).unwrap(),
            v
        );
    }

    #[test]
    fn human_output_is_used_without_json_and_never_called_with_it() {
        let v = json!({"name": "tools"});
        let human = out(false, None, false)
            .render(&v, |v| format!("repo {}", v["name"]))
            .unwrap();
        assert_eq!(human, vec!["repo \"tools\""]);

        let json_mode =
            out(true, None, false).render(&v, |_| panic!("human closure ran in --json mode"));
        assert!(json_mode.is_ok());
    }

    #[test]
    fn empty_human_output_prints_nothing_and_trailing_newlines_are_trimmed() {
        let v = json!({});
        assert!(out(false, None, false)
            .render(&v, |_| String::new())
            .unwrap()
            .is_empty());
        let trimmed = out(false, None, false)
            .render(&v, |_| "line one\nline two\n\n".to_string())
            .unwrap();
        assert_eq!(trimmed, vec!["line one\nline two"]);
    }

    #[test]
    fn color_needs_a_terminal_and_no_opt_out() {
        assert!(color_enabled(true, false, false));
        assert!(!color_enabled(false, false, false), "not a TTY");
        assert!(!color_enabled(true, true, false), "--no-color");
        assert!(!color_enabled(true, false, true), "NO_COLOR set");
    }

    #[test]
    fn info_goes_to_the_given_writer_unless_quiet() {
        let mut buf = Vec::new();
        out(false, None, false).info_to(&mut buf, "uploading");
        assert_eq!(String::from_utf8(buf).unwrap(), "uploading\n");

        let mut quiet = out(false, None, false);
        quiet.quiet = true;
        let mut buf = Vec::new();
        quiet.info_to(&mut buf, "uploading");
        assert!(buf.is_empty());
    }

    #[test]
    fn not_interactive_without_a_stdout_terminal() {
        assert!(!out(false, None, false).is_interactive());
    }

    struct BrokenPipe;
    impl Write for BrokenPipe {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> io::Result<()> {
            Err(io::ErrorKind::BrokenPipe.into())
        }
    }

    struct Full;
    impl Write for Full {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("disk full"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn writing_lines_adds_newlines() {
        let mut buf = Vec::new();
        write_lines(&mut buf, &["a".to_string(), "b".to_string()]).unwrap();
        assert_eq!(String::from_utf8(buf).unwrap(), "a\nb\n");
    }

    #[test]
    fn a_closed_pipe_is_not_an_error_but_other_write_failures_are() {
        assert!(write_lines(&mut BrokenPipe, &["a".to_string()]).is_ok());
        let err = write_lines(&mut Full, &["a".to_string()]).unwrap_err();
        assert!(matches!(err, NsitError::Io(_)), "{err:?}");
    }
}
