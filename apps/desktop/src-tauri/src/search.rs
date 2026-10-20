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
use crate::i18n::msg::CoreMsg;
use crate::tr;

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
  /// `files.exclude` + `search.exclude` globs (VS Code glob syntax, which ripgrep's `--glob` reads).
  pub exclude_globs: Vec<String>,
  /// `search.followSymlinks`.
  pub follow_symlinks: Option<bool>,
  /// `search.smartCase`: case-insensitive unless the query has an uppercase letter.
  pub smart_case: Option<bool>,
  /// `search.useGlobalIgnoreFiles` / `search.useParentIgnoreFiles`; unset keeps ripgrep's default (on).
  pub use_global_ignore: Option<bool>,
  pub use_parent_ignore: Option<bool>,
  /// `search.ripgrep.maxThreads`; 0 or unset lets ripgrep decide.
  pub max_threads: Option<usize>,
  /// The sibling clauses of `files.exclude` / `search.exclude` (`"**/*.js": { "when": "$(basename).ts" }`):
  /// ripgrep cannot express them, so matching files are dropped from the results.
  pub sibling_clauses: Vec<crate::glob::SiblingClause>,
  /// `kingu.search.smart`: a plain query also finds its words in any case, order and spelling of
  /// a name (`smart_search.rs`).
  pub smart: Option<bool>,
  /// The Search Editor's context lines (`--context N`). Set (even to 0), each file also carries
  /// its result and context lines in full ([`FileLine`]), which the editor shows.
  pub context_lines: Option<u32>,
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

/// A whole line of a file in a Search Editor result: a line with matches, or a context line.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct FileLine {
  /// 1-based line number.
  pub line: u32,
  /// The line without its line break, cut at [`MAX_LINE_CHARS`] like VS Code's preview
  /// (`⟪ N characters skipped ⟫`).
  pub text: String,
  /// False for a context line.
  pub is_match: bool,
}

/// Characters of a Search Editor line kept before the rest is elided (VS Code's charsPerLine).
pub const MAX_LINE_CHARS: usize = 1000;

/// `line` for the Search Editor: no line break, long lines elided like VS Code's search results.
pub fn file_line(line_number: u32, raw: &str, is_match: bool) -> FileLine {
  let text = raw.trim_end_matches(['\n', '\r']);
  let count = text.chars().count();
  let text = if count > MAX_LINE_CHARS {
    let cut = text.char_indices().nth(MAX_LINE_CHARS).map_or(text.len(), |(i, _)| i);
    format!("{} \u{27ea} {} characters skipped \u{27eb}", &text[..cut], count - MAX_LINE_CHARS)
  } else {
    text.to_string()
  };
  FileLine { line: line_number, text, is_match }
}

/// Sent to the webview over a channel, tagged by `kind`.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SearchEvent {
  /// All matches of one file (ripgrep's `begin` … `end`).
  /// `version` fingerprints the file's content when its matches were sent (see
  /// `replace::file_version`), so Replace can refuse a file that changed since.
  /// `modified`: the file's mtime in ms since the epoch (`search.sortOrder: modified`).
  File {
    path: String,
    matches: Vec<TextMatch>,
    version: String,
    modified: u64,
    /// Result and context lines in line order, only for the Search Editor (`context_lines` set).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    lines: Vec<FileLine>,
  },
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
/// Task worktrees, anchored at the open folder: agents write there all the time and the ADE
/// searches each one on its own (`worktree_search`), so Find in Files of the folder leaves them out.
pub const TASK_WORKTREES_GLOB: &str = "/.kingu/worktrees/**";

/// `opts` for Find in Files over the open folder (not a task worktree).
pub fn for_workspace(mut opts: SearchOptions) -> SearchOptions {
  opts.exclude_globs.push(TASK_WORKTREES_GLOB.into());
  opts
}

pub fn build_args(opts: &SearchOptions) -> Vec<OsString> {
  let smart = crate::smart_search::apply(opts);
  let opts = smart.as_ref().unwrap_or(opts);
  let mut args: Vec<String> = vec![
    "--json".into(),
    "--no-config".into(),
    "--hidden".into(),
    "--crlf".into(),
    "--no-messages".into(),
  ];
  args.push(
    if opts.match_case {
      "--case-sensitive"
    } else if opts.smart_case == Some(true) {
      "--smart-case"
    } else {
      "--ignore-case"
    }
    .into(),
  );
  if !opts.is_regex {
    args.push("--fixed-strings".into());
  }
  if opts.whole_word {
    args.push("--word-regexp".into());
  }
  if !opts.use_ignore_files.unwrap_or(true) {
    args.push("--no-ignore".into());
  } else {
    if opts.use_global_ignore == Some(false) {
      args.push("--no-ignore-global".into());
    }
    if opts.use_parent_ignore == Some(false) {
      args.push("--no-ignore-parent".into());
    }
  }
  if opts.follow_symlinks == Some(true) {
    args.push("--follow".into());
  }
  if let Some(n) = opts.context_lines.filter(|n| *n > 0) {
    args.push("--context".into());
    args.push(n.to_string());
  }
  if let Some(n) = opts.max_threads.filter(|n| *n > 0) {
    args.push("--threads".into());
    args.push(n.to_string());
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
  for g in opts.exclude_globs.iter().map(|g| g.trim()).filter(|g| !g.is_empty() && !g.starts_with('!')) {
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
    return if rg.is_file() { Ok(rg) } else { Err(tr!(CoreMsg::RgOverrideMissing, path = rg.display())) };
  }
  let exe = if cfg!(windows) { "rg.exe" } else { "rg" };
  let from_path = path_var.iter().flat_map(std::env::split_paths).map(|d| d.join(exe));
  let fallbacks = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].into_iter().map(|d| Path::new(d).join(exe));
  from_path
    .chain(fallbacks)
    .find(|p| p.is_file())
    .ok_or_else(|| tr!(CoreMsg::RgMissing))
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
  current: Option<(String, Vec<TextMatch>, Vec<FileLine>)>,
  /// Keep whole result and context lines (the Search Editor).
  pub full_lines: bool,
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
        self.current = path.map(|p| (p, Vec::new(), Vec::new()));
        None
      }
      "context" => {
        let full = self.full_lines;
        let (_, _, lines) = self.current.as_mut()?;
        let text = data.get("lines").and_then(text_of)?;
        let line_number = data.get("line_number").and_then(Value::as_u64).unwrap_or(0) as u32;
        if full {
          // A context line spanning several lines is not possible without --multiline; keep the first.
          lines.push(file_line(line_number, text.split('\n').next().unwrap_or(""), false));
        }
        None
      }
      "match" => {
        let full = self.full_lines;
        let (_, matches, lines) = self.current.as_mut()?;
        let text = data.get("lines").and_then(text_of)?;
        let line_number = data.get("line_number").and_then(Value::as_u64).unwrap_or(0) as u32;
        let before = matches.len();
        for sub in data.get("submatches").and_then(Value::as_array).into_iter().flatten() {
          if self.matches >= budget {
            break;
          }
          let start = sub.get("start").and_then(Value::as_u64).unwrap_or(0) as usize;
          let end = sub.get("end").and_then(Value::as_u64).unwrap_or(0) as usize;
          matches.push(make_match(line_number, text, start, end));
          self.matches += 1;
        }
        if full && matches.len() > before {
          lines.push(file_line(line_number, text, true));
        }
        None
      }
      "end" => self.finish(),
      _ => None,
    }
  }

  /// Emits the file in progress (also used when the search stops early).
  pub fn finish(&mut self) -> Option<SearchEvent> {
    let (path, matches, mut lines) = self.current.take()?;
    if matches.is_empty() {
      return None;
    }
    self.files += 1;
    lines.sort_by_key(|l| l.line);
    lines.dedup_by_key(|l| l.line);
    Some(SearchEvent::File { path, matches, version: String::new(), modified: 0, lines })
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
    self.start_roots(rg, vec![Root { dir: root.to_path_buf(), prefix: String::new(), options: opts.clone() }], sink)
  }

  /// Searches each root folder in turn (a multi-root workspace) as one search: file paths get
  /// the root's `prefix`, `search.maxResults` counts across all of them, and one `Done` ends it.
  pub fn start_roots(
    self: &Arc<Self>,
    rg: &Path,
    roots: Vec<Root>,
    sink: impl Fn(SearchEvent) -> bool + Send + 'static,
  ) -> Result<u32, String> {
    self.cancel();
    let Some(first) = roots.first() else {
      sink(SearchEvent::Done { files: 0, matches: 0, limit_hit: false, elapsed_ms: 0 });
      return Ok(self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
    };
    let max = first.options.max_results.unwrap_or(DEFAULT_MAX_RESULTS).max(1);
    let full_lines = first.options.context_lines.is_some();
    // The first rg starts here, so a missing or broken ripgrep is an error of this call.
    let spawn = |r: &Root| {
      Command::new(rg)
        .args(build_args(&r.options))
        .current_dir(&r.dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{}: {e}", rg.display()))
    };
    let first_child = spawn(first)?;
    let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let child = Arc::new(Mutex::new(first_child));
    let cancelled = Arc::new(AtomicBool::new(false));
    *self.current.lock().unwrap() = Some(Running { id, child: child.clone(), cancelled: cancelled.clone() });

    let searches = Arc::clone(self);
    let rg = rg.to_path_buf();
    std::thread::spawn(move || {
      let started = Instant::now();
      let mut parser = RgParser { full_lines, ..RgParser::default() };
      let mut limit_hit = false;
      for (i, root) in roots.iter().enumerate() {
        if i > 0 {
          let next = Command::new(&rg)
            .args(build_args(&root.options))
            .current_dir(&root.dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
          let Ok(next) = next else { continue };
          *child.lock().unwrap() = next;
          // Cancelled while it started: it must not run on.
          if cancelled.load(Ordering::SeqCst) {
            let _ = child.lock().unwrap().kill();
          }
        }
        let (stdout, stderr) = {
          let mut c = child.lock().unwrap();
          (c.stdout.take(), c.stderr.take())
        };
        let (Some(stdout), Some(mut stderr)) = (stdout, stderr) else { continue };
        let err_reader = std::thread::spawn(move || {
          let mut s = String::new();
          let _ = stderr.read_to_string(&mut s);
          s
        });
        let siblings = crate::glob::SiblingClauses::new(&root.options.sibling_clauses);
        let dir = root.dir.clone();
        let prefix = root.prefix.clone();
        let emit = |mut ev: SearchEvent| -> bool {
          if let SearchEvent::File { path, version, modified, .. } = &mut ev {
            if !siblings.is_empty() && siblings.hides(path, |rel| dir.join(rel).exists()) {
              return true;
            }
            let file = dir.join(path.as_str());
            *version = crate::replace::file_version(&file).unwrap_or_default();
            *modified = std::fs::metadata(&file)
              .and_then(|m| m.modified())
              .ok()
              .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
              .map_or(0, |d| d.as_millis() as u64);
            if !prefix.is_empty() {
              *path = format!("{prefix}{path}");
            }
          }
          sink(ev)
        };
        let matches_before = parser.matches;
        for line in BufReader::new(stdout).lines() {
          let Ok(line) = line else { break };
          if cancelled.load(Ordering::SeqCst) {
            break;
          }
          if let Some(ev) = parser.feed(&line, max)
            && !emit(ev)
          {
            cancelled.store(true, Ordering::SeqCst);
            break;
          }
          if parser.matches >= max {
            limit_hit = true;
            if let Some(ev) = parser.finish() {
              emit(ev);
            }
            break;
          }
        }
        let _ = child.lock().unwrap().kill();
        let status = child.lock().unwrap().wait();
        let stderr = err_reader.join().unwrap_or_default();
        if cancelled.load(Ordering::SeqCst) {
          break;
        }
        // Exit 2 is an error (bad regex, …) unless we killed rg ourselves at the limit.
        let failed = !limit_hit && status.is_ok_and(|s| s.code() == Some(2)) && parser.matches == matches_before;
        if failed {
          let message = stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or("ripgrep failed").to_string();
          let message = if stderr.contains("regex parse error") { stderr.trim().to_string() } else { message };
          sink(SearchEvent::Error { message });
          cancelled.store(true, Ordering::SeqCst);
          break;
        }
        if limit_hit {
          break;
        }
      }
      {
        let mut current = searches.current.lock().unwrap();
        if current.as_ref().is_some_and(|r| r.id == id) {
          *current = None;
        }
      }
      if cancelled.load(Ordering::SeqCst) {
        return;
      }
      let elapsed_ms = started.elapsed().as_millis() as u64;
      log::info!("search {id}: {} matches in {} files ({elapsed_ms} ms{})", parser.matches, parser.files, if limit_hit { ", limit hit" } else { "" });
      sink(SearchEvent::Done { files: parser.files, matches: parser.matches, limit_hit, elapsed_ms });
    });
    Ok(id)
  }
}

/// One root folder of a search: where rg runs, what its result paths get in front (`""` for the
/// first root folder, `/abs/root/` for another), and its options (its own "files to include").
#[derive(Debug, Clone)]
pub struct Root {
  pub dir: PathBuf,
  pub prefix: String,
  pub options: SearchOptions,
}

/// Multi-root "files to include" (VS Code: `./name/` picks a root folder by its name). For each
/// of `names` (the root folders, in order): the include patterns to search it with, or `None`
/// to leave it out. Patterns without a folder prefix apply to every folder; a pattern naming a
/// folder applies to that folder only (as `./rest`); when every pattern names a folder, the
/// folders not named are left out.
pub fn split_include(include: &str, names: &[String]) -> Vec<Option<String>> {
  let mut common: Vec<String> = Vec::new();
  let mut scoped: Vec<Vec<String>> = vec![Vec::new(); names.len()];
  let mut any_scoped = false;
  for raw in include.split(',').map(str::trim).filter(|p| !p.is_empty()) {
    let target = raw.strip_prefix("./").and_then(|rest| {
      names.iter().enumerate().filter(|(_, n)| rest == n.as_str() || rest.strip_prefix(n.as_str()).is_some_and(|r| r.starts_with('/'))).max_by_key(|(_, n)| n.len()).map(|(i, n)| (i, rest[n.len()..].trim_start_matches('/').to_string()))
    });
    match target {
      Some((i, rest)) => {
        any_scoped = true;
        scoped[i].push(if rest.is_empty() { "./**".to_string() } else { format!("./{rest}") });
      }
      None => common.push(raw.to_string()),
    }
  }
  scoped
    .into_iter()
    .map(|own| {
      if any_scoped && common.is_empty() && own.is_empty() {
        return None;
      }
      // Folder-scoped patterns narrow that folder; the shared ones still apply to it too.
      let all: Vec<String> = if own.is_empty() { common.clone() } else { own.into_iter().chain(common.iter().cloned()).collect() };
      Some(all.join(", "))
    })
    .collect()
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
  fn ripgrep_threads_follow_search_ripgrep_max_threads() {
    assert!(!args_of(&SearchOptions { query: "x".into(), ..Default::default() }).contains(&"--threads".into()));
    assert!(!args_of(&SearchOptions { query: "x".into(), max_threads: Some(0), ..Default::default() }).contains(&"--threads".into()));
    assert!(has_pair(&args_of(&SearchOptions { query: "x".into(), max_threads: Some(4), ..Default::default() }), "--threads", "4"));
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
  fn smart_search_turns_a_plain_query_into_a_case_insensitive_regex() {
    let args = args_of(&SearchOptions { query: "stock ledger".into(), smart: Some(true), smart_case: Some(true), ..Default::default() });
    assert!(!args.contains(&"--fixed-strings".into()));
    assert!(args.contains(&"--ignore-case".into()));
    assert!(has_pair(&args, "--regexp", &crate::smart_search::pattern("stock ledger").unwrap()));
    // Off, or a single word: the query as typed.
    assert!(has_pair(&args_of(&SearchOptions { query: "stock ledger".into(), ..Default::default() }), "--regexp", "stock ledger"));
    assert!(args_of(&SearchOptions { query: "ledger".into(), smart: Some(true), ..Default::default() }).contains(&"--fixed-strings".into()));
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
  fn applies_search_settings() {
    let opts = SearchOptions {
      query: "x".into(),
      exclude_globs: vec!["**/node_modules".into(), " ".into(), "!sneaky".into(), "**/.DS_Store".into()],
      follow_symlinks: Some(true),
      smart_case: Some(true),
      use_global_ignore: Some(false),
      use_parent_ignore: Some(false),
      ..Default::default()
    };
    let args = args_of(&opts);
    assert!(has_pair(&args, "--glob", "!**/node_modules"));
    assert!(!args.iter().any(|a| a.contains("sneaky")));
    assert!(args.contains(&"--follow".into()));
    assert!(args.contains(&"--smart-case".into()));
    assert!(!args.contains(&"--ignore-case".into()));
    assert!(args.contains(&"--no-ignore-global".into()));
    assert!(args.contains(&"--no-ignore-parent".into()));
    // Match Case wins over smart case; no ignore files at all drops the finer flags.
    let args = args_of(&SearchOptions { match_case: true, use_ignore_files: Some(false), ..opts });
    assert!(args.contains(&"--case-sensitive".into()));
    assert!(args.contains(&"--no-ignore".into()));
    assert!(!args.contains(&"--no-ignore-parent".into()));
    // Unset settings keep ripgrep's own defaults (the ADE's worktree search sends none).
    let args = args_of(&SearchOptions { query: "x".into(), ..Default::default() });
    assert!(!args.iter().any(|a| a == "--follow" || a.starts_with("--no-ignore")));
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
  fn keeps_context_and_result_lines_for_the_search_editor() {
    let lines = [
      r#"{"type":"begin","data":{"path":{"text":"./a.txt"}}}"#,
      r#"{"type":"context","data":{"path":{"text":"./a.txt"},"lines":{"text":"before\n"},"line_number":1,"submatches":[]}}"#,
      r#"{"type":"match","data":{"path":{"text":"./a.txt"},"lines":{"text":"  foo here\r\n"},"line_number":2,"submatches":[{"start":2,"end":5}]}}"#,
      r#"{"type":"context","data":{"path":{"text":"./a.txt"},"lines":{"text":"after\n"},"line_number":3,"submatches":[]}}"#,
      r#"{"type":"end","data":{"path":{"text":"./a.txt"}}}"#,
    ];
    let mut full = RgParser { full_lines: true, ..RgParser::default() };
    let events: Vec<_> = lines.iter().filter_map(|l| full.feed(l, 100)).collect();
    let SearchEvent::File { lines: got, matches, .. } = &events[0] else { panic!("expected a file") };
    assert_eq!(matches[0].column, 3);
    assert_eq!(
      got.iter().map(|l| (l.line, l.text.as_str(), l.is_match)).collect::<Vec<_>>(),
      [(1, "before", false), (2, "  foo here", true), (3, "after", false)]
    );
    // The Search view never asks for lines, so its events stay as they were.
    let mut plain = RgParser::default();
    let events: Vec<_> = lines.iter().filter_map(|l| plain.feed(l, 100)).collect();
    let SearchEvent::File { lines: got, .. } = &events[0] else { panic!("expected a file") };
    assert!(got.is_empty());
    assert!(!serde_json::to_string(&events[0]).unwrap().contains("\"lines\""));
  }

  #[test]
  fn elides_long_search_editor_lines_and_passes_context() {
    let long = "x".repeat(MAX_LINE_CHARS + 5);
    assert_eq!(file_line(1, &long, true).text, format!("{} \u{27ea} 5 characters skipped \u{27eb}", "x".repeat(MAX_LINE_CHARS)));
    let args = args_of(&SearchOptions { query: "x".into(), context_lines: Some(2), ..Default::default() });
    assert!(has_pair(&args, "--context", "2"));
    assert!(!args_of(&SearchOptions { query: "x".into(), context_lines: Some(0), ..Default::default() }).contains(&"--context".into()));
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
          SearchEvent::File { path, matches, version, modified, .. } => {
            assert!(!version.is_empty());
            assert!(modified > 0);
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

    // The folder's Find in Files leaves task worktrees out, but not a nested `.kingu` elsewhere.
    std::fs::create_dir_all(root.join(".kingu/worktrees/t")).unwrap();
    std::fs::write(root.join(".kingu/worktrees/t/c.md"), "hello\n").unwrap();
    std::fs::create_dir_all(root.join("src/.kingu/worktrees")).unwrap();
    std::fs::write(root.join("src/.kingu/worktrees/d.md"), "hello\n").unwrap();
    assert!(run(q("hello")).iter().any(|(p, _)| p == ".kingu/worktrees/t/c.md"));
    let names: Vec<String> = run(for_workspace(q("hello"))).into_iter().map(|(p, _)| p).collect();
    assert_eq!(names, ["b.md", "src/.kingu/worktrees/d.md", "src/a.rs"]);

    // A bad regex surfaces rg's message.
    let searches = Arc::new(Searches::default());
    let (tx, rx) = std::sync::mpsc::channel();
    searches.start(&rg, root, &SearchOptions { is_regex: true, ..q("(") }, move |ev| tx.send(ev).is_ok()).unwrap();
    assert!(matches!(rx.recv().unwrap(), SearchEvent::Error { message } if message.contains("regex")));
  }

  #[test]
  fn multi_root_includes_pick_folders_by_name() {
    let names = vec!["app".to_string(), "lib".to_string(), "lib-extra".to_string()];
    let all = |s: &str| vec![Some(s.to_string()); 3];
    assert_eq!(split_include("", &names), all(""));
    assert_eq!(split_include("src, *.ts", &names), all("src, *.ts"));
    // ./name/ narrows to that folder; the others are left out.
    assert_eq!(split_include("./lib/**/*.txt", &names), [None, Some("./**/*.txt".into()), None]);
    assert_eq!(split_include("./lib-extra", &names), [None, None, Some("./**".into())]);
    // Shared patterns still apply everywhere, on top of a folder's own.
    assert_eq!(split_include("./app/src, *.md", &names), [Some("./src, *.md".into()), Some("*.md".into()), Some("*.md".into())]);
    // Not a folder name: an ordinary anchored pattern for every folder.
    assert_eq!(split_include("./src", &names), all("./src"));
  }

  #[test]
  fn searches_several_roots_as_one() {
    let Ok(rg) = find_rg(std::env::var_os("KINGU_RG"), std::env::var_os("PATH")) else {
      eprintln!("rg not found, skipping");
      return;
    };
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    std::fs::write(a.path().join("a.md"), "hello
").unwrap();
    std::fs::write(b.path().join("b.md"), "hello hello
").unwrap();
    let q = SearchOptions { query: "hello".into(), ..Default::default() };
    let prefix = format!("{}/", b.path().display());
    let roots = vec![
      Root { dir: a.path().to_path_buf(), prefix: String::new(), options: q.clone() },
      Root { dir: b.path().to_path_buf(), prefix: prefix.clone(), options: q.clone() },
    ];
    let searches = Arc::new(Searches::default());
    let (tx, rx) = std::sync::mpsc::channel();
    searches.start_roots(&rg, roots, move |ev| tx.send(ev).is_ok()).unwrap();
    let mut files = Vec::new();
    let mut done = None;
    for ev in rx {
      match ev {
        SearchEvent::File { path, matches, .. } => files.push((path, matches.len())),
        SearchEvent::Done { files, matches, .. } => {
          done = Some((files, matches));
          break;
        }
        SearchEvent::Error { message } => panic!("{message}"),
      }
    }
    files.sort();
    assert_eq!(files, [(format!("{prefix}b.md"), 2), ("a.md".to_string(), 1)]);
    assert_eq!(done, Some((2, 3)));
  }
}
