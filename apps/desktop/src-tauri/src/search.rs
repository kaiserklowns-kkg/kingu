//! Find in Files: runs ripgrep (`rg --json`) in the workspace root, like VS Code's
//! `ripgrepTextSearchEngine`, and streams matches per file over a Tauri channel.
//! Starting a search cancels the previous one (its `rg` child is killed).

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::Value;

/// VS Code's `search.maxResults` default.
pub const DEFAULT_MAX_RESULTS: usize = 20_000;
/// Characters kept before a match in its preview (leading text is elided with `…`).
const PREVIEW_BEFORE: usize = 26;
/// Characters kept from the match start to the end of the preview.
const PREVIEW_AFTER: usize = 250;

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct SearchOptions {
  pub query: String,
  pub is_regex: bool,
  pub match_case: bool,
  pub whole_word: bool,
  /// "files to include", comma-separated globs as typed (`src, *.ts`).
  pub include: String,
  /// "files to exclude", comma-separated globs as typed.
  pub exclude: String,
  /// Respect `.gitignore` and friends (VS Code's "Use Exclude Settings and Ignore Files"). Default on.
  pub use_ignore_files: Option<bool>,
  pub max_results: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct TextMatch {
  /// 1-based line number.
  pub line: u32,
  /// 1-based UTF-16 column of the match start (Monaco's column).
  pub column: u32,
  /// 1-based UTF-16 column just past the match.
  pub end_column: u32,
  /// The line trimmed for display.
  pub preview: String,
  /// UTF-16 range of the match inside `preview`.
  pub preview_start: u32,
  pub preview_end: u32,
  /// The whole matched text (the preview may elide it); Replace checks it is still there.
  pub text: String,
}

/// Sent to the webview over a channel, tagged by `kind`.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SearchEvent {
  /// All matches of one file (ripgrep's `begin` … `end`).
  /// `version` fingerprints the file's content when its matches were sent (see
  /// `replace::file_version`), so Replace can refuse a file that changed since.
  File { path: String, matches: Vec<TextMatch>, version: String },
  Done { files: usize, matches: usize, limit_hit: bool, elapsed_ms: u64 },
  Error { message: String },
}

/// Turns one typed include/exclude pattern into ripgrep globs, following VS Code's
/// `patternListToIExpression`: a bare name (`src`, `lib.rs`) matches that file or folder
/// anywhere; `./src` is anchored at the workspace root.
fn expand_pattern(raw: &str) -> Vec<String> {
  let p = raw.trim().trim_end_matches('/');
  if p.is_empty() {
    return Vec::new();
  }
  let (anchored, p) = match p.strip_prefix("./") {
    Some(rest) => (true, rest),
    None => (p.starts_with('/'), p.trim_start_matches('/')),
  };
  let base = if anchored || p.starts_with("**/") { p.to_string() } else { format!("**/{p}") };
  if p.ends_with("**") {
    vec![base]
  } else {
    // The pattern can name a file or a folder (whose contents then match too).
    vec![base.clone(), format!("{base}/**")]
  }
}

fn split_patterns(list: &str) -> impl Iterator<Item = String> + '_ {
  list.split(',').flat_map(expand_pattern)
}

/// ripgrep arguments for `opts`; the query is passed with `--regexp` so a leading `-` is safe.
pub fn build_args(opts: &SearchOptions) -> Vec<OsString> {
  let mut args: Vec<String> = vec![
    "--json".into(),
    "--no-config".into(),
    "--hidden".into(),
    "--crlf".into(),
    "--no-messages".into(),
  ];
  args.push(if opts.match_case { "--case-sensitive" } else { "--ignore-case" }.into());
  if !opts.is_regex {
    args.push("--fixed-strings".into());
  }
  if opts.whole_word {
    args.push("--word-regexp".into());
  }
  if !opts.use_ignore_files.unwrap_or(true) {
    args.push("--no-ignore".into());
  }
  // VS Code's default `files.exclude`/`search.exclude` that ignore files do not cover.
  for g in ["**/.git", "**/.git/**", "**/.DS_Store"] {
    args.push("--glob".into());
    args.push(format!("!{g}"));
  }
  for g in split_patterns(&opts.include) {
    args.push("--glob".into());
    args.push(g);
  }
  for g in split_patterns(&opts.exclude) {
    args.push("--glob".into());
    args.push(format!("!{g}"));
  }
  args.push("--regexp".into());
  args.push(opts.query.clone());
  args.push("--".into());
  args.push("./".into());
  args.into_iter().map(OsString::from).collect()
}

/// `KINGU_RG`, else `rg` on `PATH`, else the usual install locations (a macOS app launched
/// from Finder gets a minimal PATH without Homebrew).
pub fn find_rg(env_rg: Option<OsString>, path_var: Option<OsString>) -> Result<PathBuf, String> {
  if let Some(rg) = env_rg.filter(|v| !v.is_empty()) {
    let rg = PathBuf::from(rg);
    return if rg.is_file() { Ok(rg) } else { Err(format!("KINGU_RG={} ไม่พบไฟล์ ripgrep", rg.display())) };
  }
  let exe = if cfg!(windows) { "rg.exe" } else { "rg" };
  let from_path = path_var.iter().flat_map(std::env::split_paths).map(|d| d.join(exe));
  let fallbacks = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].into_iter().map(|d| Path::new(d).join(exe));
  from_path
    .chain(fallbacks)
    .find(|p| p.is_file())
    .ok_or_else(|| "ไม่พบ ripgrep (rg): ติดตั้งด้วย `brew install ripgrep` หรือตั้ง KINGU_RG เป็น path ของ rg".to_string())
}

fn utf16_len(s: &str) -> u32 {
  s.encode_utf16().count() as u32
}

/// Largest char boundary `<= i`, so byte offsets from rg can never split a character.
fn floor_boundary(s: &str, mut i: usize) -> usize {
  i = i.min(s.len());
  while !s.is_char_boundary(i) {
    i -= 1;
  }
  i
}

/// Builds a match from rg's line text and byte range: columns in UTF-16 for Monaco, and a
/// preview with leading whitespace trimmed and long prefixes/suffixes elided.
pub fn make_match(line_number: u32, line: &str, start: usize, end: usize) -> TextMatch {
  let line = line.trim_end_matches(['\n', '\r']);
  let start = floor_boundary(line, start);
  let end = floor_boundary(line, end).max(start);
  let column = utf16_len(&line[..start]) + 1;
  let end_column = column + utf16_len(&line[start..end]);

  let before = line[..start].trim_start();
  let before_chars = before.chars().count();
  let (prefix, before) = if before_chars > PREVIEW_BEFORE {
    let skip = before.char_indices().nth(before_chars - PREVIEW_BEFORE).map_or(0, |(i, _)| i);
    ("…", &before[skip..])
  } else {
    ("", before)
  };
  let mut rest = &line[start..];
  let mut suffix = "";
  if let Some((i, _)) = rest.char_indices().nth(PREVIEW_AFTER) {
    rest = &rest[..i];
    suffix = "…";
  }
  let preview = format!("{prefix}{before}{rest}{suffix}");
  let preview_start = utf16_len(prefix) + utf16_len(before);
  let match_len = utf16_len(&line[start..end]).min(utf16_len(rest));
  TextMatch {
    line: line_number,
    column,
    end_column,
    preview,
    preview_start,
    preview_end: preview_start + match_len,
    text: line[start..end].to_string(),
  }
}

/// rg reports text as `{"text": …}`, or `{"bytes": base64}` when it is not valid UTF-8.
fn text_of(v: &Value) -> Option<&str> {
  v.get("text").and_then(Value::as_str)
}

fn rel_path(raw: &str) -> String {
  let p = raw.strip_prefix("./").unwrap_or(raw);
  if cfg!(windows) { p.replace('\\', "/") } else { p.to_string() }
}

/// Folds rg's JSON lines into per-file results.
#[derive(Default)]
pub struct RgParser {
  current: Option<(String, Vec<TextMatch>)>,
  pub files: usize,
  pub matches: usize,
}

impl RgParser {
  /// Feeds one stdout line; returns a finished file on its `end` event. Matches beyond
  /// `budget` (results still allowed) are dropped.
  pub fn feed(&mut self, line: &str, budget: usize) -> Option<SearchEvent> {
    let v: Value = serde_json::from_str(line).ok()?;
    let data = v.get("data")?;
    match v.get("type")?.as_str()? {
      "begin" => {
        let path = data.get("path").and_then(text_of).map(rel_path);
        self.current = path.map(|p| (p, Vec::new()));
        None
      }
      "match" => {
        let (_, matches) = self.current.as_mut()?;
        let text = data.get("lines").and_then(text_of)?;
        let line_number = data.get("line_number").and_then(Value::as_u64).unwrap_or(0) as u32;
        for sub in data.get("submatches").and_then(Value::as_array).into_iter().flatten() {
          if self.matches >= budget {
            break;
          }
          let start = sub.get("start").and_then(Value::as_u64).unwrap_or(0) as usize;
          let end = sub.get("end").and_then(Value::as_u64).unwrap_or(0) as usize;
          matches.push(make_match(line_number, text, start, end));
          self.matches += 1;
        }
        None
      }
      "end" => self.finish(),
      _ => None,
    }
  }

  /// Emits the file in progress (also used when the search stops early).
  pub fn finish(&mut self) -> Option<SearchEvent> {
    let (path, matches) = self.current.take()?;
    if matches.is_empty() {
      return None;
    }
    self.files += 1;
    Some(SearchEvent::File { path, matches, version: String::new() })
  }
}

struct Running {
  id: u32,
  child: Arc<Mutex<Child>>,
  cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Searches {
  next_id: AtomicU32,
  current: Mutex<Option<Running>>,
}

impl Searches {
  /// Cancels the running search, if any; its channel gets no further events.
  pub fn cancel(&self) {
    if let Some(run) = self.current.lock().unwrap().take() {
      run.cancelled.store(true, Ordering::SeqCst);
      let _ = run.child.lock().unwrap().kill();
      log::info!("search {} cancelled", run.id);
    }
  }

  /// Spawns `rg` in `root` and streams events to `sink` from a reader thread.
  pub fn start(
    self: &Arc<Self>,
    rg: &Path,
    root: &Path,
    opts: &SearchOptions,
    sink: impl Fn(SearchEvent) -> bool + Send + 'static,
  ) -> Result<u32, String> {
    self.cancel();
    let max = opts.max_results.unwrap_or(DEFAULT_MAX_RESULTS).max(1);
    let mut child = Command::new(rg)
      .args(build_args(opts))
      .current_dir(root)
      .stdin(Stdio::null())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .spawn()
      .map_err(|e| format!("{}: {e}", rg.display()))?;
    let stdout = child.stdout.take().ok_or("rg: no stdout")?;
    let mut stderr = child.stderr.take().ok_or("rg: no stderr")?;
    let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let child = Arc::new(Mutex::new(child));
    let cancelled = Arc::new(AtomicBool::new(false));
    *self.current.lock().unwrap() = Some(Running { id, child: child.clone(), cancelled: cancelled.clone() });

    let err_reader = std::thread::spawn(move || {
      let mut s = String::new();
      let _ = stderr.read_to_string(&mut s);
      s
    });
    let searches = Arc::clone(self);
    let root = root.to_path_buf();
    let sink = move |mut ev: SearchEvent| {
      if let SearchEvent::File { path, version, .. } = &mut ev {
        *version = crate::replace::file_version(&root.join(path.as_str())).unwrap_or_default();
      }
      sink(ev)
    };
    std::thread::spawn(move || {
      let started = Instant::now();
      let mut parser = RgParser::default();
      let mut limit_hit = false;
      for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if cancelled.load(Ordering::SeqCst) {
          break;
        }
        if let Some(ev) = parser.feed(&line, max)
          && !sink(ev)
        {
          cancelled.store(true, Ordering::SeqCst);
          break;
        }
        if parser.matches >= max {
          limit_hit = true;
          if let Some(ev) = parser.finish() {
            sink(ev);
          }
          break;
        }
      }
      let _ = child.lock().unwrap().kill();
      let status = child.lock().unwrap().wait();
      let stderr = err_reader.join().unwrap_or_default();
      {
        let mut current = searches.current.lock().unwrap();
        if current.as_ref().is_some_and(|r| r.id == id) {
          *current = None;
        }
      }
      if cancelled.load(Ordering::SeqCst) {
        return;
      }
      // Exit 2 is an error (bad regex, …) unless we killed rg ourselves at the limit.
      let failed = !limit_hit && status.is_ok_and(|s| s.code() == Some(2)) && parser.matches == 0;
      if failed {
        let message = stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or("ripgrep failed").to_string();
        let message = if stderr.contains("regex parse error") { stderr.trim().to_string() } else { message };
        sink(SearchEvent::Error { message });
        return;
      }
      let elapsed_ms = started.elapsed().as_millis() as u64;
      log::info!("search {id}: {} matches in {} files ({elapsed_ms} ms{})", parser.matches, parser.files, if limit_hit { ", limit hit" } else { "" });
      sink(SearchEvent::Done { files: parser.files, matches: parser.matches, limit_hit, elapsed_ms });
    });
    Ok(id)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn args_of(opts: &SearchOptions) -> Vec<String> {
    build_args(opts).into_iter().map(|a| a.into_string().unwrap()).collect()
  }

  fn has_pair(args: &[String], a: &str, b: &str) -> bool {
    args.windows(2).any(|w| w[0] == a && w[1] == b)
  }

  #[test]
  fn builds_literal_case_insensitive_args_by_default() {
    let args = args_of(&SearchOptions { query: "-foo".into(), ..Default::default() });
    assert!(args.contains(&"--json".into()));
    assert!(args.contains(&"--fixed-strings".into()));
    assert!(args.contains(&"--ignore-case".into()));
    assert!(!args.contains(&"--no-ignore".into()));
    assert!(has_pair(&args, "--regexp", "-foo"));
    assert_eq!(args.last().unwrap(), "./");
  }

  #[test]
  fn builds_regex_case_word_and_ignore_args() {
    let opts = SearchOptions {
      query: r"fn \w+".into(),
      is_regex: true,
      match_case: true,
      whole_word: true,
      use_ignore_files: Some(false),
      ..Default::default()
    };
    let args = args_of(&opts);
    assert!(!args.contains(&"--fixed-strings".into()));
    assert!(args.contains(&"--case-sensitive".into()));
    assert!(args.contains(&"--word-regexp".into()));
    assert!(args.contains(&"--no-ignore".into()));
  }

  #[test]
  fn expands_include_and_exclude_patterns() {
    assert_eq!(expand_pattern("src"), ["**/src", "**/src/**"]);
    assert_eq!(expand_pattern("./apps/desktop/"), ["apps/desktop", "apps/desktop/**"]);
    assert_eq!(expand_pattern("*.ts"), ["**/*.ts", "**/*.ts/**"]);
    assert_eq!(expand_pattern("**/node_modules/**"), ["**/node_modules/**"]);
    assert!(expand_pattern("  ").is_empty());
    let args = args_of(&SearchOptions { query: "x".into(), include: "*.rs, src".into(), exclude: "target".into(), ..Default::default() });
    assert!(has_pair(&args, "--glob", "**/*.rs"));
    assert!(has_pair(&args, "--glob", "**/src/**"));
    assert!(has_pair(&args, "--glob", "!**/target/**"));
  }

  #[test]
  fn computes_utf16_columns_and_preview() {
    // "é" is 2 bytes, 1 UTF-16 unit; "𝄞" is 4 bytes, 2 UTF-16 units.
    let line = "  é𝄞 hello\n";
    let start = line.find("hello").unwrap();
    let m = make_match(3, line, start, start + 5);
    assert_eq!((m.line, m.column, m.end_column), (3, 7, 12));
    assert_eq!(m.preview, "é𝄞 hello");
    assert_eq!(m.text, "hello");
    assert_eq!((m.preview_start, m.preview_end), (4, 9));
  }

  #[test]
  fn elides_long_prefix_and_suffix() {
    let line = format!("{}needle{}", "a".repeat(100), "b".repeat(400));
    let m = make_match(1, &line, 100, 106);
    assert!(m.preview.starts_with('…'));
    assert!(m.preview.ends_with('…'));
    let start = m.preview_start as usize;
    let chars: Vec<u16> = m.preview.encode_utf16().collect();
    assert_eq!(String::from_utf16(&chars[start..m.preview_end as usize]).unwrap(), "needle");
    assert_eq!(m.column, 101);
  }

  #[test]
  fn parses_rg_json_events() {
    let lines = [
      r#"{"type":"begin","data":{"path":{"text":"./src/a.txt"}}}"#,
      r#"{"type":"match","data":{"path":{"text":"./src/a.txt"},"lines":{"text":"foo hello hello\n"},"line_number":2,"absolute_offset":13,"submatches":[{"match":{"text":"hello"},"start":4,"end":9},{"match":{"text":"hello"},"start":10,"end":15}]}}"#,
      r#"{"type":"end","data":{"path":{"text":"./src/a.txt"},"binary_offset":null,"stats":{}}}"#,
      r#"{"type":"begin","data":{"path":{"bytes":"/w=="}}}"#,
      r#"{"type":"end","data":{"path":{"bytes":"/w=="}}}"#,
      r#"{"data":{"elapsed_total":{}},"type":"summary"}"#,
      "not json",
    ];
    let mut p = RgParser::default();
    let events: Vec<_> = lines.iter().filter_map(|l| p.feed(l, 100)).collect();
    assert_eq!(events.len(), 1);
    let SearchEvent::File { path, matches, .. } = &events[0] else { panic!("expected a file") };
    assert_eq!(path, "src/a.txt");
    assert_eq!(matches.iter().map(|m| (m.line, m.column)).collect::<Vec<_>>(), [(2, 5), (2, 11)]);
    assert_eq!((p.files, p.matches), (1, 2));
  }

  #[test]
  fn parser_respects_budget() {
    let mut p = RgParser::default();
    p.feed(r#"{"type":"begin","data":{"path":{"text":"a"}}}"#, 1);
    p.feed(r#"{"type":"match","data":{"lines":{"text":"x x"},"line_number":1,"submatches":[{"start":0,"end":1},{"start":2,"end":3}]}}"#, 1);
    assert_eq!(p.matches, 1);
    assert!(matches!(p.finish(), Some(SearchEvent::File { matches, .. }) if matches.len() == 1));
  }

  #[test]
  fn reports_a_clear_error_when_rg_is_missing() {
    let tmp = tempfile::tempdir().unwrap();
    let err = find_rg(Some(tmp.path().join("nope").into()), None).unwrap_err();
    assert!(err.contains("KINGU_RG"));
    let fake = tmp.path().join(if cfg!(windows) { "rg.exe" } else { "rg" });
    std::fs::write(&fake, "").unwrap();
    assert_eq!(find_rg(None, Some(tmp.path().into())).unwrap(), fake);
  }

  /// Runs the real `rg` when it is installed; skipped otherwise.
  #[test]
  fn searches_a_tempdir_with_real_rg() {
    let Ok(rg) = find_rg(std::env::var_os("KINGU_RG"), std::env::var_os("PATH")) else {
      eprintln!("rg not found, skipping");
      return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::create_dir_all(root.join(".git")).unwrap();
    std::fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
    std::fs::write(root.join("src/a.rs"), "fn main() {\n  let héllo = 1; // Hello\n}\n").unwrap();
    std::fs::write(root.join("b.md"), "hello world\n").unwrap();
    std::fs::write(root.join("ignored.txt"), "hello\n").unwrap();
    std::fs::write(root.join(".git/config"), "hello\n").unwrap();

    let run = |opts: SearchOptions| {
      let searches = Arc::new(Searches::default());
      let (tx, rx) = std::sync::mpsc::channel();
      searches.start(&rg, root, &opts, move |ev| tx.send(ev).is_ok()).unwrap();
      let mut files = Vec::new();
      for ev in rx {
        match ev {
          SearchEvent::File { path, matches, version } => {
            assert!(!version.is_empty());
            files.push((path, matches.len()))
          }
          SearchEvent::Done { .. } => break,
          SearchEvent::Error { message } => panic!("{message}"),
        }
      }
      files.sort();
      files
    };
    let q = |query: &str| SearchOptions { query: query.into(), ..Default::default() };

    assert_eq!(run(q("hello")), [("b.md".to_string(), 1), ("src/a.rs".to_string(), 1)]);
    assert_eq!(run(SearchOptions { use_ignore_files: Some(false), ..q("hello") }).len(), 3);
    assert_eq!(run(SearchOptions { include: "src".into(), ..q("o") }), [("src/a.rs".to_string(), 2)]);
    assert_eq!(run(SearchOptions { exclude: "*.md".into(), ..q("hello") }), [("src/a.rs".to_string(), 1)]);
    assert_eq!(run(SearchOptions { match_case: true, ..q("Hello") }), [("src/a.rs".to_string(), 1)]);
    assert_eq!(run(SearchOptions { is_regex: true, ..q(r"h.llo\b") }).len(), 2);
    assert_eq!(run(SearchOptions { max_results: Some(1), ..q("hello") }).len(), 1);

    // A bad regex surfaces rg's message.
    let searches = Arc::new(Searches::default());
    let (tx, rx) = std::sync::mpsc::channel();
    searches.start(&rg, root, &SearchOptions { is_regex: true, ..q("(") }, move |ev| tx.send(ev).is_ok()).unwrap();
    assert!(matches!(rx.recv().unwrap(), SearchEvent::Error { message } if message.contains("regex")));
  }
}
