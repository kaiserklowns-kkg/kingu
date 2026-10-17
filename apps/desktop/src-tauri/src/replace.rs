//! Search: Replace (VS Code's `ReplaceService`). The webview sends back the exact matches of the
//! last search; each file is re-read, checked against the fingerprint taken when it was searched
//! and against the matched text at every location, then rewritten atomically. A file that changed
//! in between is refused rather than patched at guessed offsets.
//!
//! Files open in an editor are not written here: the webview sends their current text instead,
//! gets the computed edits back and applies them to the Monaco model (left dirty), so unsaved
//! changes are never clobbered.

use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use regex::{Captures, Regex, RegexBuilder};

/// The search that produced the matches (only what affects the replacement text).
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct ReplacePattern {
  pub query: String,
  pub is_regex: bool,
  pub match_case: bool,
}

/// One match as the search reported it: 1-based line, 1-based UTF-16 columns, matched text.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct MatchRef {
  pub line: u32,
  pub column: u32,
  pub end_column: u32,
  pub text: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct FileReplace {
  /// Workspace-relative path.
  pub path: String,
  /// `version` from the search's file event; a different fingerprint now means "changed since".
  #[serde(default)]
  pub version: Option<String>,
  pub matches: Vec<MatchRef>,
  /// The open editor's text: compute edits against it and write nothing.
  #[serde(default)]
  pub content: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ReplaceRequest {
  pub pattern: ReplacePattern,
  pub replace: String,
  #[serde(default)]
  pub preserve_case: bool,
  pub files: Vec<FileReplace>,
}

/// A replacement in Monaco coordinates (1-based line, UTF-16 columns of the original text).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ReplaceEdit {
  pub line: u32,
  pub column: u32,
  pub end_column: u32,
  pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
  /// Rewritten on disk.
  Written,
  /// Open in an editor: `edits` are for the webview to apply to the model.
  Edits,
  /// Changed since the search; nothing done.
  Stale,
  Failed,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct FileResult {
  pub path: String,
  pub outcome: Outcome,
  pub replaced: usize,
  /// The replacements made (`Written`) or to make (`Edits`), in original coordinates, so the
  /// webview can shift the remaining matches of the file.
  pub edits: Vec<ReplaceEdit>,
  /// The new fingerprint of a `Written` file, for further replaces in the same results.
  pub version: Option<String>,
  pub message: Option<String>,
}

/// Content fingerprint: length plus a SipHash of the bytes (stable within one app run).
pub fn file_version(path: &Path) -> Option<String> {
  let bytes = std::fs::read(path).ok()?;
  Some(version_of(&bytes))
}

pub fn version_of(bytes: &[u8]) -> String {
  let mut h = std::hash::DefaultHasher::new();
  bytes.hash(&mut h);
  format!("{}:{:016x}", bytes.len(), h.finish())
}

// --- Replacement text ----------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Piece {
  Text(String),
  Group(usize),
  Named(String),
}

/// Parses a regex replacement the way VS Code does (JavaScript `String.replace` rules):
/// `$&`/`$0` the whole match, `$1`…`$99` groups (two digits only when that group exists),
/// `$<name>`/`${name}` named groups, `$$` a dollar, and `\n`, `\t`, `\\` escapes.
fn parse_template(template: &str, groups: usize) -> Vec<Piece> {
  let mut out = Vec::new();
  let mut text = String::new();
  let chars: Vec<char> = template.chars().collect();
  let mut i = 0;
  let flush = |text: &mut String, out: &mut Vec<Piece>| {
    if !text.is_empty() {
      out.push(Piece::Text(std::mem::take(text)));
    }
  };
  while i < chars.len() {
    let c = chars[i];
    let next = chars.get(i + 1).copied();
    let escaped = match (c, next) {
      ('\\', Some('n')) => Some('\n'),
      ('\\', Some('t')) => Some('\t'),
      ('\\', Some('\\')) => Some('\\'),
      ('$', Some('$')) => Some('$'),
      _ => None,
    };
    if let Some(e) = escaped {
      text.push(e);
      i += 2;
      continue;
    }
    match (c, next) {
      ('$', Some('&')) => {
        flush(&mut text, &mut out);
        out.push(Piece::Group(0));
        i += 2;
      }
      ('$', Some(d)) if d.is_ascii_digit() => {
        let one = d.to_digit(10).unwrap() as usize;
        let two = chars.get(i + 2).and_then(|c| c.to_digit(10)).map(|d2| one * 10 + d2 as usize);
        flush(&mut text, &mut out);
        match two {
          Some(n) if n <= groups => {
            out.push(Piece::Group(n));
            i += 3;
          }
          _ => {
            out.push(Piece::Group(one));
            i += 2;
          }
        }
      }
      ('$', Some(open @ ('<' | '{'))) => {
        let close = if open == '<' { '>' } else { '}' };
        match chars[i + 2..].iter().position(|&c| c == close) {
          Some(len) if len > 0 => {
            flush(&mut text, &mut out);
            out.push(Piece::Named(chars[i + 2..i + 2 + len].iter().collect()));
            i += len + 3;
          }
          _ => {
            text.push('$');
            i += 1;
          }
        }
      }
      _ => {
        text.push(c);
        i += 1;
      }
    }
  }
  flush(&mut text, &mut out);
  out
}

/// VS Code's "Preserve Case": the replacement takes the matched text's casing.
pub fn preserve_case(matched: &str, replacement: &str) -> String {
  let has_letters = matched.chars().any(char::is_alphabetic);
  if !has_letters || replacement.is_empty() {
    return replacement.to_string();
  }
  if matched.chars().all(|c| !c.is_lowercase()) && matched.chars().filter(|c| c.is_alphabetic()).count() > 1 {
    return replacement.to_uppercase();
  }
  if matched.chars().all(|c| !c.is_uppercase()) {
    return replacement.to_lowercase();
  }
  let first_upper = matched.chars().find(|c| c.is_alphabetic()).is_some_and(char::is_uppercase);
  let mut cs = replacement.chars();
  let head = cs.next().unwrap();
  let head: String = if first_upper { head.to_uppercase().collect() } else { head.to_lowercase().collect() };
  head + cs.as_str()
}

/// Computes replacement strings for matches of one search.
pub struct Replacer {
  regex: Option<Regex>,
  /// The same pattern anchored to a whole string, for a match whose context no longer fits.
  anchored: Option<Regex>,
  template: Vec<Piece>,
  literal: String,
  preserve_case: bool,
}

impl Replacer {
  pub fn new(pattern: &ReplacePattern, replace: &str, preserve_case: bool) -> Result<Self, String> {
    let build = |src: String| RegexBuilder::new(&src).case_insensitive(!pattern.match_case).build().map_err(|e| e.to_string());
    let (regex, anchored, template) = if pattern.is_regex {
      let regex = build(format!("(?:{})", pattern.query))?;
      let anchored = build(format!("^(?:{})$", pattern.query))?;
      let template = parse_template(replace, regex.captures_len() - 1);
      (Some(regex), Some(anchored), template)
    } else {
      (None, None, Vec::new())
    };
    Ok(Self { regex, anchored, template, literal: replace.to_string(), preserve_case })
  }

  /// The replacement for `line[start..end]`. The regex runs on the whole line so anchors, `\b`
  /// and groups see the same context the search did.
  pub fn replacement(&self, line: &str, start: usize, end: usize) -> String {
    let matched = &line[start..end];
    let out = match &self.regex {
      None => self.literal.clone(),
      Some(re) => {
        let caps = re
          .captures_at(line, start)
          .filter(|c| c.get(0).is_some_and(|m| m.start() == start && m.end() == end))
          .or_else(|| self.anchored.as_ref().and_then(|a| a.captures(matched)));
        self.expand(caps.as_ref(), matched)
      }
    };
    if self.preserve_case { preserve_case(matched, &out) } else { out }
  }

  fn expand(&self, caps: Option<&Captures>, matched: &str) -> String {
    let mut out = String::new();
    for piece in &self.template {
      match piece {
        Piece::Text(t) => out.push_str(t),
        Piece::Group(0) => out.push_str(caps.and_then(|c| c.get(0)).map_or(matched, |m| m.as_str())),
        Piece::Group(n) => match caps {
          Some(c) if *n < c.len() => out.push_str(c.get(*n).map_or("", |m| m.as_str())),
          // JavaScript keeps `$7` literally when there is no group 7.
          _ => out.push_str(&format!("${n}")),
        },
        Piece::Named(name) => match caps.map(|c| c.name(name)) {
          Some(Some(m)) => out.push_str(m.as_str()),
          Some(None) if self.regex.as_ref().is_some_and(|r| r.capture_names().flatten().any(|n| n == name)) => {}
          _ => out.push_str(&format!("$<{name}>")),
        },
      }
    }
    out
  }
}

// --- Applying to text ----------------------------------------------------------------------------

/// Byte offset of the 1-based UTF-16 `column` in `line`; `None` past the end or inside a
/// surrogate pair.
fn byte_of_column(line: &str, column: u32) -> Option<usize> {
  let target = column.checked_sub(1)? as usize;
  let mut units = 0;
  for (i, c) in line.char_indices() {
    if units == target {
      return Some(i);
    }
    units += c.len_utf16();
    if units > target {
      return None;
    }
  }
  (units == target).then_some(line.len())
}

/// Byte ranges of each line's content (without its `\n` / `\r\n`).
fn line_spans(text: &str) -> Vec<(usize, usize)> {
  let mut spans = Vec::new();
  let mut start = 0;
  for (i, b) in text.bytes().enumerate() {
    if b == b'\n' {
      let end = if i > start && text.as_bytes()[i - 1] == b'\r' { i - 1 } else { i };
      spans.push((start, end));
      start = i + 1;
    }
  }
  spans.push((start, text.len()));
  spans
}

/// Checks every match against `text` and computes its replacement. `Err` means the text no
/// longer has the match where the search saw it (the file changed).
pub fn plan(text: &str, matches: &[MatchRef], replacer: &Replacer) -> Result<Vec<(usize, usize, ReplaceEdit)>, String> {
  let spans = line_spans(text);
  let mut out = Vec::with_capacity(matches.len());
  for m in matches {
    let stale = || format!("line {}: \"{}\" is no longer there", m.line, m.text);
    let &(ls, le) = spans.get((m.line as usize).wrapping_sub(1)).ok_or_else(stale)?;
    let line = &text[ls..le];
    let (Some(s), Some(e)) = (byte_of_column(line, m.column), byte_of_column(line, m.end_column)) else {
      return Err(stale());
    };
    if e < s || line[s..e] != m.text {
      return Err(stale());
    }
    let replacement = replacer.replacement(line, s, e);
    out.push((ls + s, ls + e, ReplaceEdit { line: m.line, column: m.column, end_column: m.end_column, text: replacement }));
  }
  out.sort_by_key(|(s, e, _)| (*s, *e));
  if out.windows(2).any(|w| w[1].0 < w[0].1) {
    return Err("overlapping matches".into());
  }
  Ok(out)
}

pub fn apply(text: &str, plan: &[(usize, usize, ReplaceEdit)]) -> String {
  let mut out = String::with_capacity(text.len());
  let mut at = 0;
  for (s, e, edit) in plan {
    out.push_str(&text[at..*s]);
    out.push_str(&edit.text);
    at = *e;
  }
  out.push_str(&text[at..]);
  out
}

/// `rel` inside `root` (both canonical), refusing anything that leaves it.
fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
  let path = root.join(rel).canonicalize().map_err(|e| format!("{rel}: {e}"))?;
  if !path.starts_with(root) {
    return Err(format!("{rel}: outside the workspace"));
  }
  if !path.is_file() {
    return Err(format!("{rel}: not a file"));
  }
  Ok(path)
}

/// Writes through a temporary file in the same directory, then renames over the original.
fn write_atomic(path: &Path, content: &str) -> std::io::Result<()> {
  let dir = path.parent().unwrap_or(Path::new("."));
  let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
  let tmp = dir.join(format!(".{name}.kingu-replace-{}", std::process::id()));
  let result = (|| {
    std::fs::write(&tmp, content)?;
    std::fs::set_permissions(&tmp, std::fs::metadata(path)?.permissions())?;
    std::fs::rename(&tmp, path)
  })();
  if result.is_err() {
    let _ = std::fs::remove_file(&tmp);
  }
  result
}

pub fn replace_file(root: &Path, file: &FileReplace, replacer: &Replacer) -> FileResult {
  let result = |outcome, replaced, edits, message: Option<String>| FileResult { path: file.path.clone(), outcome, replaced, edits, version: None, message };
  if let Some(content) = &file.content {
    return match plan(content, &file.matches, replacer) {
      Ok(p) => result(Outcome::Edits, p.len(), p.into_iter().map(|(_, _, e)| e).collect(), None),
      Err(e) => result(Outcome::Stale, 0, Vec::new(), Some(e)),
    };
  }
  let path = match resolve(root, &file.path) {
    Ok(p) => p,
    Err(e) => return result(Outcome::Failed, 0, Vec::new(), Some(e)),
  };
  let bytes = match std::fs::read(&path) {
    Ok(b) => b,
    Err(e) => return result(Outcome::Failed, 0, Vec::new(), Some(e.to_string())),
  };
  if file.version.as_ref().is_some_and(|v| !v.is_empty() && *v != version_of(&bytes)) {
    return result(Outcome::Stale, 0, Vec::new(), Some("changed since the search".into()));
  }
  let Ok(text) = String::from_utf8(bytes) else {
    return result(Outcome::Failed, 0, Vec::new(), Some("not UTF-8 text".into()));
  };
  let p = match plan(&text, &file.matches, replacer) {
    Ok(p) => p,
    Err(e) => return result(Outcome::Stale, 0, Vec::new(), Some(e)),
  };
  let new_text = apply(&text, &p);
  if let Err(e) = write_atomic(&path, &new_text) {
    return result(Outcome::Failed, 0, Vec::new(), Some(e.to_string()));
  }
  FileResult { version: Some(version_of(new_text.as_bytes())), ..result(Outcome::Written, p.len(), p.into_iter().map(|(_, _, e)| e).collect(), None) }
}

pub fn replace_all(root: &Path, req: &ReplaceRequest) -> Result<Vec<FileResult>, String> {
  let replacer = Replacer::new(&req.pattern, &req.replace, req.preserve_case)?;
  Ok(req.files.iter().map(|f| replace_file(root, f, &replacer)).collect())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn literal(query: &str) -> ReplacePattern {
    ReplacePattern { query: query.into(), ..Default::default() }
  }
  fn regex(query: &str) -> ReplacePattern {
    ReplacePattern { query: query.into(), is_regex: true, match_case: true }
  }
  fn utf16(s: &str) -> u32 {
    s.encode_utf16().count() as u32
  }
  /// The matches of `needle` in `text`, as the search reports them.
  fn find(text: &str, needle: &str) -> Vec<MatchRef> {
    let mut out = Vec::new();
    for (i, line) in text.split('\n').enumerate() {
      let line = line.trim_end_matches('\r');
      for (b, m) in line.match_indices(needle) {
        let column = utf16(&line[..b]) + 1;
        out.push(MatchRef { line: i as u32 + 1, column, end_column: column + utf16(m), text: m.into() });
      }
    }
    out
  }
  fn replace_text(text: &str, matches: &[MatchRef], r: &Replacer) -> String {
    apply(text, &plan(text, matches, r).unwrap())
  }

  #[test]
  fn replaces_several_matches_on_one_line() {
    let r = Replacer::new(&literal("foo"), "barbaz", false).unwrap();
    let text = "foo foo\nx foo\r\nfoo";
    assert_eq!(replace_text(text, &find(text, "foo"), &r), "barbaz barbaz\nx barbaz\r\nbarbaz");
  }

  #[test]
  fn handles_thai_and_emoji_columns() {
    // "🦀" is 2 UTF-16 units and 4 bytes; Thai letters are 1 unit and 3 bytes.
    let text = "ก🦀 สวัสดี 🦀สวัสดี\nสวัสดี";
    let matches = find(text, "สวัสดี");
    assert_eq!((matches[0].column, matches[1].column), (5, 14));
    let r = Replacer::new(&literal("สวัสดี"), "hi😀", false).unwrap();
    assert_eq!(replace_text(text, &matches, &r), "ก🦀 hi😀 🦀hi😀\nhi😀");
    let edits = plan(text, &matches, &r).unwrap();
    assert_eq!((edits[0].2.line, edits[0].2.column, edits[0].2.end_column), (1, 5, 11));
  }

  #[test]
  fn refuses_text_that_moved() {
    let r = Replacer::new(&literal("foo"), "x", false).unwrap();
    let matches = find("a foo", "foo");
    assert!(plan("a  foo", &matches, &r).unwrap_err().contains("no longer"));
    assert!(plan("", &matches, &r).is_err());
    // A column inside a surrogate pair cannot be a match boundary.
    let m = MatchRef { line: 1, column: 2, end_column: 3, text: "x".into() };
    assert!(plan("🦀x", &[m], &r).is_err());
  }

  #[test]
  fn regex_substitution_uses_groups() {
    let r = Replacer::new(&regex(r"(\w+)=(\d+)"), "$2=$1 [$&] $$ $3 $10", false).unwrap();
    assert_eq!(r.replacement("a=1", 0, 3), "1=a [a=1] $ $3 a0");
    let named = Replacer::new(&regex(r"(?P<k>\w+)\.(?<v>\w+)"), "${v}.$<k>\\n\\t", false).unwrap();
    assert_eq!(named.replacement("x foo.bar", 2, 9), "bar.foo\n\t");
    // Context outside the match still counts (`\b`, `^`).
    let ctx = Replacer::new(&regex(r"^(ab)"), "<$1>", false).unwrap();
    assert_eq!(ctx.replacement("ab ab", 0, 2), "<ab>");
    // Case-insensitive search: the group is the text as it is in the file.
    let ci = Replacer::new(&ReplacePattern { query: "(h)ello".into(), is_regex: true, match_case: false }, "$1i", false).unwrap();
    assert_eq!(ci.replacement("HELLO", 0, 5), "Hi");
    assert!(Replacer::new(&regex("("), "", false).is_err());
    // Literal mode keeps `$1` as typed.
    let lit = Replacer::new(&literal("a"), "$1", false).unwrap();
    assert_eq!(lit.replacement("a", 0, 1), "$1");
  }

  #[test]
  fn preserves_case() {
    assert_eq!(preserve_case("FOO", "bar"), "BAR");
    assert_eq!(preserve_case("foo", "Bar"), "bar");
    assert_eq!(preserve_case("Foo", "bar"), "Bar");
    assert_eq!(preserve_case("fOO", "Bar"), "bar");
    assert_eq!(preserve_case("123", "Bar"), "Bar");
    let r = Replacer::new(&literal("foo"), "bar", true).unwrap();
    assert_eq!(r.replacement("Foo", 0, 3), "Bar");
  }

  #[test]
  fn writes_files_atomically_and_refuses_stale_ones() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    std::fs::write(root.join("a.txt"), "foo foo\nไทย foo\n").unwrap();
    std::fs::write(root.join("b.txt"), "foo\n").unwrap();
    let a_version = file_version(&root.join("a.txt")).unwrap();
    let b_version = file_version(&root.join("b.txt")).unwrap();
    // b.txt changes after the search (same length, so only the hash notices).
    std::fs::write(root.join("b.txt"), "fox\n").unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("c.txt"), "foo").unwrap();

    let req = ReplaceRequest {
      pattern: literal("foo"),
      replace: "ฟู".into(),
      preserve_case: false,
      files: vec![
        FileReplace { path: "a.txt".into(), version: Some(a_version), matches: find("foo foo\nไทย foo\n", "foo"), content: None },
        FileReplace { path: "b.txt".into(), version: Some(b_version), matches: find("foo", "foo"), content: None },
        FileReplace {
          path: outside.path().join("c.txt").display().to_string(),
          version: None,
          matches: find("foo", "foo"),
          content: None,
        },
        FileReplace { path: "open.txt".into(), version: None, matches: find("foo", "foo"), content: Some("x\nfoo".into()) },
      ],
    };
    let results = replace_all(&root, &req).unwrap();
    assert_eq!(results.iter().map(|r| r.outcome).collect::<Vec<_>>(), [Outcome::Written, Outcome::Stale, Outcome::Failed, Outcome::Stale]);
    assert_eq!(results[0].replaced, 3);
    assert_eq!(results[0].edits.len(), 3);
    assert_eq!(results[0].version, file_version(&root.join("a.txt")));
    assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "ฟู ฟู\nไทย ฟู\n");
    assert_eq!(std::fs::read_to_string(root.join("b.txt")).unwrap(), "fox\n");
    assert_eq!(std::fs::read_to_string(outside.path().join("c.txt")).unwrap(), "foo");
    // No temporary files left behind.
    let names: Vec<_> = std::fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names.len(), 2);

    // An open editor's text: edits come back, nothing is written.
    let open = FileReplace { path: "a.txt".into(), version: None, matches: find("x foo", "foo"), content: Some("x foo".into()) };
    let r = replace_file(&root, &open, &Replacer::new(&literal("foo"), "bar", false).unwrap());
    assert_eq!(r.outcome, Outcome::Edits);
    assert_eq!(r.edits, [ReplaceEdit { line: 1, column: 3, end_column: 6, text: "bar".into() }]);
  }
}
