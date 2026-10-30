//! Reading the log files the supervisor writes.
//!
//! Both services append their output through `Layout::log_file`, so the files
//! grow for as long as an installation lives. This only ever reads a tail: a
//! window that polls every couple of seconds should not pay for a multi-megabyte
//! file to scroll to the end of it.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::layout::Layout;

/// Read this much from the end before cutting to the requested line count. A
/// stack trace is a few kilobytes, so 192 KiB keeps the last few hundred lines
/// whole even when the file has been growing for weeks.
const TAIL_BYTES: u64 = 192 * 1024;

const DEFAULT_LINES: usize = 300;
const MAX_LINES: usize = 1000;

/// The two sources the Logs tab offers: the id the UI asks for, the name it
/// shows, and the file `Layout::log_file` writes.
const SOURCES: [(&str, &str, &str); 2] = [
    ("server", "Immich server", "server"),
    ("database", "Postgres", "postgres"),
];

#[derive(serde::Serialize)]
pub struct LogLine {
    pub source: &'static str,
    pub text: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSource {
    pub id: &'static str,
    pub name: &'static str,
    pub path: String,
    pub exists: bool,
    pub bytes: u64,
}

#[derive(serde::Serialize)]
pub struct LogView {
    /// Every source with the state of its file, so the UI can say which service
    /// has not run instead of showing an empty pane for both.
    pub sources: Vec<LogSource>,
    pub lines: Vec<LogLine>,
}

/// `source` is `all`, `server` or `database`. Lines come back grouped by source
/// in the order of `SOURCES`, which is what lets the pane label a section
/// boundary instead of inventing a chronological order between two files that
/// do not share a timestamp format.
pub fn read(layout: &Layout, source: &str, limit: Option<usize>) -> Result<LogView, String> {
    let asked: Vec<&(&str, &str, &str)> = match source {
        "all" => SOURCES.iter().collect(),
        id => SOURCES.iter().filter(|entry| entry.0 == id).collect(),
    };
    if asked.is_empty() {
        return Err(format!("Unknown log source “{source}”."));
    }

    let limit = limit.unwrap_or(DEFAULT_LINES).clamp(1, MAX_LINES);
    let mut sources = Vec::new();
    let mut lines = Vec::new();

    for (id, name, file) in asked {
        let path = layout.logs.join(format!("{file}.log"));
        let (exists, bytes) = match fs::metadata(&path) {
            Ok(meta) => (true, meta.len()),
            Err(_) => (false, 0),
        };
        if exists {
            if let Ok(tail) = tail(&path, limit) {
                for text in tail {
                    lines.push(LogLine {
                        source: id,
                        text: strip_ansi(&text),
                    });
                }
            }
        }
        sources.push(LogSource {
            id,
            name,
            path: plain(&path),
            exists,
            bytes,
        });
    }

    Ok(LogView { sources, lines })
}

/// The last `limit` complete lines of a file.
fn tail(path: &Path, limit: usize) -> std::io::Result<Vec<String>> {
    let mut file = fs::File::open(path)?;
    let length = file.metadata()?.len();
    let start = length.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();

    // Starting mid-file lands mid-line, and half a line reads as corruption.
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    // A trailing newline is the normal end of an append; it is not a line.
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    if lines.len() > limit {
        lines.drain(..lines.len() - limit);
    }
    Ok(lines)
}

/// Drops the colour escapes both services write. A raw `\x1b[32m` in a div
/// renders as a control glyph in the middle of the line.
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            // CSI: parameters and intermediates, then one final byte.
            Some('[') => {
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            // OSC: a title or hyperlink, ended by BEL or ESC \.
            Some(']') => {
                let mut previous = '\0';
                for next in chars.by_ref() {
                    if next == '\u{7}' || (previous == '\u{1b}' && next == '\\') {
                        break;
                    }
                    previous = next;
                }
            }
            _ => {}
        }
    }
    out
}

/// The path as the rest of the app shows it: no `\\?\` verbatim prefix.
fn plain(path: &Path) -> String {
    crate::layout::plain(path)
}

/// Kept for the tests, which need somewhere to write a fake log.
#[cfg(test)]
fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("immich-logs-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("immich").join("logs")).expect("scratch logs dir");
    dir
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout_for(dir: &Path) -> Layout {
        Layout::new(dir)
    }

    #[test]
    fn a_file_that_was_never_written_is_reported_missing() {
        let dir = scratch("missing");
        let view = read(&layout_for(&dir), "all", None).expect("read");

        assert!(view.lines.is_empty());
        assert_eq!(view.sources.len(), 2);
        assert!(view.sources.iter().all(|source| !source.exists));
        assert!(view.sources[0].path.ends_with("server.log"));
    }

    #[test]
    fn reads_the_last_lines_of_the_requested_source_only() {
        let dir = scratch("tail");
        let layout = layout_for(&dir);
        fs::write(layout.logs.join("server.log"), "one\ntwo\nthree\n").expect("write");
        fs::write(layout.logs.join("postgres.log"), "db line\n").expect("write");

        let view = read(&layout, "server", Some(2)).expect("read");
        assert_eq!(
            view.lines.iter().map(|line| line.text.as_str()).collect::<Vec<_>>(),
            ["two", "three"]
        );
        assert!(view.lines.iter().all(|line| line.source == "server"));

        let all = read(&layout, "all", None).expect("read");
        assert_eq!(all.lines.len(), 4);
        assert_eq!(all.lines[3].source, "database");
    }

    #[test]
    fn a_big_file_still_starts_on_a_whole_line() {
        let dir = scratch("big");
        let layout = layout_for(&dir);
        let mut body = String::new();
        for index in 0..20000 {
            body.push_str(&format!("2026-10-29 21:00:00.000 UTC [{index}] LOG: line {index}\n"));
        }
        fs::write(layout.logs.join("server.log"), body).expect("write");

        let view = read(&layout, "server", Some(5)).expect("read");
        assert_eq!(view.lines.len(), 5);
        assert_eq!(
            view.lines[4].text,
            "2026-10-29 21:00:00.000 UTC [19999] LOG: line 19999"
        );
        assert!(view.lines[0].text.starts_with("2026-10-29"));
    }

    #[test]
    fn colour_escapes_are_dropped_without_losing_the_text() {
        assert_eq!(
            strip_ansi("\u{1b}[32mINFO\u{1b}[39m [ApiService] ready"),
            "INFO [ApiService] ready"
        );
        assert_eq!(strip_ansi("\u{1b}]8;;https://example.com\u{7}link\u{1b}]8;;\u{7}"), "link");
        assert_eq!(strip_ansi("plain"), "plain");
    }

    #[test]
    fn an_unknown_source_is_an_error_rather_than_an_empty_pane() {
        let dir = scratch("unknown");
        assert!(read(&layout_for(&dir), "ml", None).is_err());
    }
}

