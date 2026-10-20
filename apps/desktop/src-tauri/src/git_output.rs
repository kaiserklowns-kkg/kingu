//! The Output panel's "Git" channel (VS Code's Git output: `> git status -z -uall [12ms]`, then
//! the error text when the command fails). Every git run through `git::run` / `run_remote` is
//! recorded in a ring buffer; the webview polls [`git_output_since`] while the channel is shown.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Duration;

/// Lines kept (older ones drop off, like a channel's buffer).
const MAX_LINES: usize = 2000;
/// Error text longer than this is cut.
const MAX_ERROR_CHARS: usize = 2000;

struct Buffer {
  /// Sequence number of the next line.
  next: u64,
  lines: VecDeque<(u64, String)>,
}

static BUFFER: Mutex<Buffer> = Mutex::new(Buffer { next: 0, lines: VecDeque::new() });

fn push(line: String) {
  let mut b = BUFFER.lock().unwrap_or_else(|e| e.into_inner());
  let seq = b.next;
  b.next += 1;
  b.lines.push_back((seq, line));
  while b.lines.len() > MAX_LINES {
    b.lines.pop_front();
  }
}

/// `> git <args> [<ms>ms]`, credentials masked; a failure adds its message on the next lines.
pub fn format_run(args: &[&str], took: Duration, error: Option<&str>) -> Vec<String> {
  let when = crate::logging::now_text();
  let cmd = crate::logging::redact(&args.join(" ")).into_owned();
  let mut out = vec![format!("{when} [info] > git {cmd} [{}ms]", took.as_millis())];
  if let Some(err) = error.map(str::trim).filter(|e| !e.is_empty()) {
    let err: String = crate::logging::redact(err).chars().take(MAX_ERROR_CHARS).collect();
    out.extend(err.lines().map(|l| format!("{when} [info] {l}")));
  }
  out
}

/// Records one git run.
pub fn record(args: &[&str], took: Duration, error: Option<&str>) {
  for line in format_run(args, took, error) {
    push(line);
  }
}

#[derive(Debug, serde::Serialize, PartialEq)]
pub struct Lines {
  /// Pass this back as `since` for the next poll.
  pub next: u64,
  /// True when lines between `since` and the first one returned were dropped.
  pub truncated: bool,
  pub lines: Vec<String>,
}

fn since(seq: u64) -> Lines {
  let b = BUFFER.lock().unwrap_or_else(|e| e.into_inner());
  let first = b.lines.front().map_or(b.next, |(s, _)| *s);
  Lines { next: b.next, truncated: seq < first && seq != 0, lines: b.lines.iter().filter(|(s, _)| *s >= seq).map(|(_, l)| l.clone()).collect() }
}

/// Git lines recorded at or after sequence number `since` (0 = everything kept).
#[tauri::command]
pub fn git_output_since(since: u64) -> Lines {
  self::since(since)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn formats_command_timing_and_error() {
    let lines = format_run(&["status", "-z"], Duration::from_millis(12), None);
    assert_eq!(lines.len(), 1);
    assert!(lines[0].ends_with("[info] > git status -z [12ms]"), "{}", lines[0]);
    let lines = format_run(&["push", "https://u:secret@host/x"], Duration::from_millis(3), Some("fatal: no\nhint: x\n"));
    assert_eq!(lines.len(), 3);
    assert!(!lines[0].contains("secret"));
    assert!(lines[1].ends_with("[info] fatal: no"));
    assert!(lines[2].ends_with("[info] hint: x"));
  }

  #[test]
  fn polls_from_a_sequence_number() {
    let start = since(0).next;
    record(&["log"], Duration::ZERO, None);
    record(&["show"], Duration::ZERO, None);
    let got = since(start);
    assert!(got.next >= start + 2);
    assert!(got.lines.iter().any(|l| l.contains("> git log")));
    assert!(got.lines.iter().any(|l| l.contains("> git show")));
    assert!(since(u64::MAX).lines.is_empty());
  }
}
