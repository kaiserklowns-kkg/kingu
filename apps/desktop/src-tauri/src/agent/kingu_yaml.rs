//! `kingu.yaml` at the repository root: the repo config file (Orca's `orca.yaml`; the schema of
//! the fork's `kingu.yaml` in kingu-intelligence `shared/kingu-yaml.ts`):
//!
//! ```yaml
//! scripts:
//!   setup: |            # runs in each new task worktree (needs your trust)
//!     bun install
//!   archive: docker compose down   # runs in a worktree before it is removed (needs your trust)
//! setupAgentStartupPolicy: wait-for-setup   # or start-immediately
//! issueCommand: gh issue view {{issue}}     # run for tasks started from a GitHub issue (needs your trust)
//! defaultTabs:                              # terminal tabs made once for a new worktree
//!   - title: Dev server
//!     color: "#22c55e"
//!     command: bun run dev                  # trusted together with scripts.setup
//! worktree:
//!   sharedDirectories: [node_modules]       # symlinked from the main checkout into each worktree
//! ```
//!
//! Parsed with yaml-rust2's event parser into a small tree. Anchors, aliases (no "billion laughs"),
//! tags, several documents, non-string keys, duplicate keys and nesting deeper than `MAX_DEPTH`
//! are errors naming the line, and then the whole file is ignored, as Orca ignores an orca.yaml
//! that does not parse. Field rules follow Orca's normalisation; what is dropped is reported in
//! `warnings`.

use std::path::Path;

use yaml_rust2::parser::{Event, Parser};
use yaml_rust2::scanner::TScalarStyle;

pub const FILE: &str = "kingu.yaml";
pub const MAX_BYTES: usize = 256 * 1024;
const MAX_FIELD_BYTES: usize = 64 * 1024;
const MAX_ENTRIES: usize = 256;
const MAX_SHARED_DIRECTORIES: usize = 100;
const MAX_DEPTH: usize = 32;
const MAX_NODES: usize = 20_000;

#[derive(Debug, Clone, PartialEq)]
pub enum Yaml {
  Null,
  Bool(bool),
  /// A plain scalar that reads as a number (kept as written).
  Num(String),
  Str(String),
  Seq(Vec<Yaml>),
  Map(Vec<(String, Yaml)>),
}

impl Yaml {
  fn get(&self, key: &str) -> Option<&Yaml> {
    match self {
      Yaml::Map(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v),
      _ => None,
    }
  }
}

type R<T> = Result<T, String>;

fn is_number(s: &str) -> bool {
  let t = s.strip_prefix(['-', '+']).unwrap_or(s);
  !t.is_empty() && (t.parse::<f64>().is_ok() || t.strip_prefix("0x").is_some_and(|h| !h.is_empty() && h.chars().all(|c| c.is_ascii_hexdigit()))) && !t.eq_ignore_ascii_case("inf") && !t.eq_ignore_ascii_case("nan")
}

/// A scalar's value: quoted and block scalars are strings; plain ones follow YAML 1.2's core schema.
fn scalar(value: String, style: TScalarStyle) -> Yaml {
  if style != TScalarStyle::Plain {
    return Yaml::Str(value);
  }
  match value.as_str() {
    "" | "~" | "null" | "Null" | "NULL" => Yaml::Null,
    "true" | "True" | "TRUE" => Yaml::Bool(true),
    "false" | "False" | "FALSE" => Yaml::Bool(false),
    v if is_number(v) => Yaml::Num(value),
    _ => Yaml::Str(value),
  }
}

enum Frame {
  Seq(Vec<Yaml>),
  /// Entries so far and the key waiting for its value.
  Map(Vec<(String, Yaml)>, Option<String>),
}

/// Parses YAML text into a `Yaml` tree (`Null` for an empty document).
pub fn parse_yaml(text: &str) -> R<Yaml> {
  if text.len() > MAX_BYTES {
    return Err(format!("larger than {} KB", MAX_BYTES / 1024));
  }
  let text = text.strip_prefix('\u{feff}').unwrap_or(text);
  let mut parser = Parser::new_from_str(text);
  let mut stack: Vec<Frame> = Vec::new();
  let mut root: Option<Yaml> = None;
  let (mut docs, mut nodes) = (0usize, 0usize);
  loop {
    let (event, mark) = parser.next_token().map_err(|e| format!("line {}: {}", e.marker().line(), e.info()))?;
    let at = |msg: &str| format!("line {}: {msg}", mark.line());
    // The value a finished scalar or collection adds to its parent (or the document).
    let mut done: Option<(Yaml, Option<String>)> = None;
    match event {
      Event::StreamEnd => break,
      Event::StreamStart | Event::Nothing | Event::DocumentEnd => {}
      Event::DocumentStart => {
        docs += 1;
        if docs > 1 {
          return Err(at("only one YAML document is allowed"));
        }
      }
      Event::Alias(_) => return Err(at("aliases are not supported")),
      Event::Scalar(value, style, anchor, tag) => {
        if anchor > 0 {
          return Err(at("anchors are not supported"));
        }
        if tag.is_some() {
          return Err(at("tags are not supported"));
        }
        let key = style == TScalarStyle::Plain || style == TScalarStyle::SingleQuoted || style == TScalarStyle::DoubleQuoted;
        let raw = key.then(|| value.clone());
        done = Some((scalar(value, style), raw));
      }
      Event::SequenceStart(anchor, ref tag) | Event::MappingStart(anchor, ref tag) => {
        if anchor > 0 {
          return Err(at("anchors are not supported"));
        }
        if tag.is_some() {
          return Err(at("tags are not supported"));
        }
        if stack.len() >= MAX_DEPTH {
          return Err(at("nested too deeply"));
        }
        if matches!(stack.last(), Some(Frame::Map(_, None))) {
          return Err(at("keys must be plain strings"));
        }
        stack.push(if matches!(event, Event::SequenceStart(..)) { Frame::Seq(Vec::new()) } else { Frame::Map(Vec::new(), None) });
      }
      Event::SequenceEnd | Event::MappingEnd => {
        done = match stack.pop() {
          Some(Frame::Seq(items)) => Some((Yaml::Seq(items), None)),
          Some(Frame::Map(entries, _)) => Some((Yaml::Map(entries), None)),
          None => return Err(at("unbalanced document")),
        };
      }
    }
    let Some((value, raw)) = done else { continue };
    nodes += 1;
    if nodes > MAX_NODES {
      return Err(at("too many values"));
    }
    match stack.last_mut() {
      None => root = Some(value),
      Some(Frame::Seq(items)) => items.push(value),
      Some(Frame::Map(entries, pending)) => match pending.take() {
        Some(key) => entries.push((key, value)),
        None => {
          let key = raw.ok_or_else(|| at("keys must be plain strings"))?;
          if entries.iter().any(|(k, _)| *k == key) {
            return Err(at(&format!("duplicate key `{key}`")));
          }
          *pending = Some(key);
        }
      },
    }
  }
  Ok(root.unwrap_or(Yaml::Null))
}

// ---------------------------------------------------------------------------------------------
// The schema (Orca's parseKinguYaml normalisation)

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct Scripts {
  pub setup: Option<String>,
  pub archive: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct DefaultTab {
  pub title: Option<String>,
  pub color: Option<String>,
  pub command: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KinguYaml {
  pub scripts: Scripts,
  pub setup_agent_startup_policy: Option<String>,
  pub issue_command: Option<String>,
  pub default_tabs: Vec<DefaultTab>,
  /// `worktree.sharedDirectories`, normalised to safe repo-relative paths.
  pub shared_directories: Vec<String>,
  /// What was ignored and why (unknown keys, wrong types, unsupported fields).
  pub warnings: Vec<String>,
}

const KNOWN_KEYS: [&str; 6] = ["scripts", "setupAgentStartupPolicy", "issueCommand", "defaultTabs", "environmentRecipes", "worktree"];

/// Orca's asTrimmedString: a non-empty trimmed string within the field limit, else `None`.
fn trimmed(v: Option<&Yaml>, field: &str, warnings: &mut Vec<String>) -> Option<String> {
  match v? {
    Yaml::Null => None,
    Yaml::Str(s) if s.len() > MAX_FIELD_BYTES => {
      warnings.push(format!("{field}: longer than {} KB, ignored", MAX_FIELD_BYTES / 1024));
      None
    }
    Yaml::Str(s) => Some(s.trim().to_owned()).filter(|t| !t.is_empty()),
    _ => {
      warnings.push(format!("{field}: expected a string, ignored"));
      None
    }
  }
}

fn valid_color(c: &str) -> bool {
  let Some(hex) = c.strip_prefix('#') else { return false };
  (hex.len() == 3 || hex.len() == 6) && hex.chars().all(|ch| ch.is_ascii_hexdigit())
}

/// Orca's normalizeSharedDirectories: repo-relative, no absolute paths, `..`, `.` or `.git`.
pub fn normalize_relative(raw: &str) -> Option<String> {
  let p = raw.trim().replace('\\', "/");
  let p = p.strip_prefix("./").unwrap_or(&p).trim_end_matches('/');
  let bytes = p.as_bytes();
  if p.is_empty() || p.starts_with('/') || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':') {
    return None;
  }
  if p.split('/').any(|s| s.is_empty() || s == "." || s == ".." || s == ".git") {
    return None;
  }
  Some(p.to_owned())
}

/// The schema from the YAML value (`Null` for an empty file).
pub fn from_yaml(root: &Yaml) -> R<KinguYaml> {
  let mut out = KinguYaml::default();
  let w = &mut out.warnings;
  let map = match root {
    Yaml::Null => return Ok(out),
    Yaml::Map(m) => m,
    _ => return Err("the top level must be a mapping".to_owned()),
  };
  for (k, _) in map {
    if !KNOWN_KEYS.contains(&k.as_str()) {
      w.push(format!("unknown key `{k}`, ignored"));
    }
  }
  match root.get("scripts") {
    None | Some(Yaml::Null) => {}
    Some(s @ Yaml::Map(m)) => {
      for (k, _) in m {
        if k != "setup" && k != "archive" {
          w.push(format!("unknown key `scripts.{k}`, ignored"));
        }
      }
      out.scripts.setup = trimmed(s.get("setup"), "scripts.setup", w);
      out.scripts.archive = trimmed(s.get("archive"), "scripts.archive", w);
    }
    Some(_) => w.push("scripts: expected a mapping, ignored".to_owned()),
  }
  match root.get("setupAgentStartupPolicy") {
    None | Some(Yaml::Null) => {}
    Some(Yaml::Str(s)) if s == "start-immediately" || s == "wait-for-setup" => out.setup_agent_startup_policy = Some(s.clone()),
    Some(_) => w.push("setupAgentStartupPolicy: expected start-immediately or wait-for-setup, ignored".to_owned()),
  }
  out.issue_command = trimmed(root.get("issueCommand"), "issueCommand", w);
  match root.get("defaultTabs") {
    None | Some(Yaml::Null) => {}
    Some(Yaml::Seq(tabs)) if tabs.len() > MAX_ENTRIES => w.push(format!("defaultTabs: more than {MAX_ENTRIES} entries, ignored")),
    Some(Yaml::Seq(tabs)) => {
      for (i, tab) in tabs.iter().enumerate() {
        let field = format!("defaultTabs[{}]", i + 1);
        if !matches!(tab, Yaml::Map(_)) {
          w.push(format!("{field}: expected a mapping, ignored"));
          continue;
        }
        let title = trimmed(tab.get("title"), &format!("{field}.title"), w);
        let command = trimmed(tab.get("command"), &format!("{field}.command"), w);
        let color = trimmed(tab.get("color"), &format!("{field}.color"), w).filter(|c| {
          let ok = valid_color(c);
          if !ok {
            w.push(format!("{field}.color: expected #rgb or #rrggbb, ignored"));
          }
          ok
        });
        if title.is_none() && command.is_none() && color.is_none() {
          continue;
        }
        out.default_tabs.push(DefaultTab { title, color, command });
      }
    }
    Some(_) => w.push("defaultTabs: expected a sequence, ignored".to_owned()),
  }
  if root.get("environmentRecipes").is_some_and(|v| *v != Yaml::Null) {
    w.push("environmentRecipes: needs on-demand environments, which Kingu does not have yet; ignored".to_owned());
  }
  match root.get("worktree") {
    None | Some(Yaml::Null) => {}
    Some(wt @ Yaml::Map(m)) => {
      for (k, _) in m {
        if k != "sharedDirectories" {
          w.push(format!("unknown key `worktree.{k}`, ignored"));
        }
      }
      match wt.get("sharedDirectories") {
        None | Some(Yaml::Null) => {}
        Some(Yaml::Seq(dirs)) => {
          for d in dirs.iter().take(MAX_SHARED_DIRECTORIES) {
            let Some(raw) = trimmed(Some(d), "worktree.sharedDirectories", w) else { continue };
            match normalize_relative(&raw) {
              Some(p) if !out.shared_directories.contains(&p) => out.shared_directories.push(p),
              Some(_) => {}
              None => w.push(format!("worktree.sharedDirectories: `{raw}` is not a safe repo-relative path, ignored")),
            }
          }
          if dirs.len() > MAX_SHARED_DIRECTORIES {
            w.push(format!("worktree.sharedDirectories: only the first {MAX_SHARED_DIRECTORIES} entries are used"));
          }
        }
        Some(_) => w.push("worktree.sharedDirectories: expected a sequence, ignored".to_owned()),
      }
    }
    Some(_) => w.push("worktree: expected a mapping, ignored".to_owned()),
  }
  Ok(out)
}

/// Parses `kingu.yaml` text into the schema; an error means the whole file is ignored.
pub fn parse(text: &str) -> R<KinguYaml> {
  from_yaml(&parse_yaml(text)?)
}

/// The repository's `kingu.yaml`: `Ok(None)` when there is none. Refuses a symlink (it could
/// point outside the repository) and anything but a regular file.
pub fn load(root: &Path) -> R<Option<KinguYaml>> {
  let file = root.join(FILE);
  let meta = match std::fs::symlink_metadata(&file) {
    Ok(m) => m,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => return Err(format!("{FILE}: {e}")),
  };
  if !meta.is_file() {
    return Err(format!("{FILE}: not a regular file"));
  }
  if meta.len() > MAX_BYTES as u64 {
    return Err(format!("{FILE}: larger than {} KB", MAX_BYTES / 1024));
  }
  let bytes = std::fs::read(&file).map_err(|e| format!("{FILE}: {e}"))?;
  let text = String::from_utf8(bytes).map_err(|_| format!("{FILE}: not UTF-8"))?;
  parse(&text).map(Some).map_err(|e| format!("{FILE}: {e}"))
}

/// What the Repository settings show about the file.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct KinguYamlStatus {
  pub found: bool,
  pub config: Option<KinguYaml>,
  pub error: Option<String>,
}

pub fn status(root: &Path) -> KinguYamlStatus {
  match load(root) {
    Ok(None) => KinguYamlStatus { found: root.join(FILE).exists(), config: None, error: None },
    Ok(Some(c)) => KinguYamlStatus { found: true, config: Some(c), error: None },
    Err(e) => KinguYamlStatus { found: true, config: None, error: Some(e) },
  }
}

/// The open folder's `kingu.yaml`, parsed (for the Repository settings and worktree creation).
#[tauri::command]
pub fn kingu_yaml(ws: tauri::State<'_, crate::workspace::Workspace>) -> Result<KinguYamlStatus, String> {
  let Some(root) = ws.current() else {
    return Ok(KinguYamlStatus { found: false, config: None, error: None });
  };
  Ok(status(&root))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn s(v: &str) -> Yaml {
    Yaml::Str(v.to_owned())
  }

  #[test]
  fn parses_mappings_sequences_and_scalars() {
    let y = parse_yaml("a: 1\nb:\n  - x\n  - 'y z'\n  - \"q\\n\"\nc:\n  d: true\n  e: ~\nf: [g, \"h, i\", 3]\ng: {h: 1}\n").unwrap();
    assert_eq!(
      y,
      Yaml::Map(vec![
        ("a".into(), Yaml::Num("1".into())),
        ("b".into(), Yaml::Seq(vec![s("x"), s("y z"), s("q\n")])),
        ("c".into(), Yaml::Map(vec![("d".into(), Yaml::Bool(true)), ("e".into(), Yaml::Null)])),
        ("f".into(), Yaml::Seq(vec![s("g"), s("h, i"), Yaml::Num("3".into())])),
        ("g".into(), Yaml::Map(vec![("h".into(), Yaml::Num("1".into()))])),
      ])
    );
    assert_eq!(parse_yaml("").unwrap(), Yaml::Null);
    assert_eq!(parse_yaml("# only a comment\n").unwrap(), Yaml::Null);
    assert_eq!(parse_yaml("'1': \"true\"\n").unwrap(), Yaml::Map(vec![("1".into(), s("true"))]));
  }

  #[test]
  fn block_scalars_and_comments() {
    let y = parse_yaml("# top\nscripts:\n  setup: |\n    bun install  # not a comment\n\n    cp .env.example .env\n  archive: >-\n    docker compose\n    down\n").unwrap();
    let scripts = y.get("scripts").unwrap();
    assert_eq!(scripts.get("setup"), Some(&s("bun install  # not a comment\n\ncp .env.example .env\n")));
    assert_eq!(scripts.get("archive"), Some(&s("docker compose down")));
  }

  #[test]
  fn errors_name_the_line() {
    for (text, want) in [
      ("a: 1\na: 2\n", "line 2: duplicate key `a`"),
      ("a: &x 1\nb: *x\n", "line 1: anchors are not supported"),
      ("a: *x\n", "line 1:"),
      ("a: !!str 1\n", "line 1: tags are not supported"),
      ("a: 1\n---\nb: 2\n", "line 2: only one YAML document"),
      ("a: \"open\n", "line"),
      ("a:\n\tb: 1\n", "line 2"),
      ("[1]: x\n", "line 1: keys must be plain strings"),
      ("? [a]\n: x\n", "line 1: keys must be plain strings"),
    ] {
      let e = parse_yaml(text).unwrap_err();
      assert!(e.starts_with(want), "{text:?}: {e}");
    }
    let deep = format!("{}1{}", "[".repeat(MAX_DEPTH + 1), "]".repeat(MAX_DEPTH + 1));
    assert!(parse_yaml(&deep).unwrap_err().contains("nested too deeply"));
    assert!(parse_yaml(&"a".repeat(MAX_BYTES + 1)).is_err());
    // A "billion laughs" file is refused at its first alias instead of expanding.
    let laughs = "a: &a [lol, lol]\nb: &b [*a, *a]\nc: [*b, *b]\n";
    assert!(parse_yaml(laughs).is_err());
  }

  #[test]
  fn normalises_like_orca() {
    let c = parse(
      "scripts:\n  setup: '  bun install  '\n  archive: 12\n  other: x\nsetupAgentStartupPolicy: later\nissueCommand: gh issue view {{issue}}\ndefaultTabs:\n  - title: Dev\n    color: '#22c55e'\n    command: bun run dev\n  - color: red\n  - {}\n  - plain\nworktree:\n  sharedDirectories: [node_modules, ./apps/web/node_modules/, ../up, /abs, .git, a/./b, node_modules]\nenvironmentRecipes: [x]\nextra: 1\n",
    )
    .unwrap();
    assert_eq!(c.scripts, Scripts { setup: Some("bun install".into()), archive: None });
    assert_eq!(c.setup_agent_startup_policy, None);
    assert_eq!(c.issue_command.as_deref(), Some("gh issue view {{issue}}"));
    assert_eq!(c.default_tabs, vec![DefaultTab { title: Some("Dev".into()), color: Some("#22c55e".into()), command: Some("bun run dev".into()) }]);
    assert_eq!(c.shared_directories, vec!["node_modules", "apps/web/node_modules"]);
    let w = c.warnings.join("\n");
    for part in ["unknown key `extra`", "scripts.archive: expected a string", "unknown key `scripts.other`", "setupAgentStartupPolicy", "defaultTabs[2].color", "defaultTabs[4]: expected a mapping", "environmentRecipes", "`../up`", "`/abs`", "`.git`", "`a/./b`"] {
      assert!(w.contains(part), "missing warning {part}: {w}");
    }
    assert_eq!(parse("").unwrap(), KinguYaml::default());
    assert!(parse("- a\n").unwrap_err().contains("mapping"));
    let ok = parse("setupAgentStartupPolicy: wait-for-setup\n").unwrap();
    assert_eq!(ok.setup_agent_startup_policy.as_deref(), Some("wait-for-setup"));
  }

  #[test]
  fn serialises_for_the_webview() {
    let c = parse("scripts:\n  setup: echo hi\ndefaultTabs:\n  - title: T\nworktree:\n  sharedDirectories: [x]\n").unwrap();
    let v = serde_json::to_value(&c).unwrap();
    assert_eq!(v["scripts"]["setup"], "echo hi");
    assert_eq!(v["defaultTabs"][0]["title"], "T");
    assert_eq!(v["sharedDirectories"][0], "x");
    assert!(v.get("setupAgentStartupPolicy").is_some());
  }

  #[cfg(unix)]
  #[test]
  fn load_refuses_symlinks_and_reports_errors() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    assert_eq!(load(root).unwrap(), None);
    assert!(!status(root).found);
    std::fs::write(root.join(FILE), "scripts:\n  setup: echo hi\n").unwrap();
    assert_eq!(load(root).unwrap().unwrap().scripts.setup.as_deref(), Some("echo hi"));
    std::fs::write(root.join(FILE), "a: [\n").unwrap();
    let st = status(root);
    assert!(st.found && st.config.is_none() && st.error.as_deref().unwrap_or("").starts_with("kingu.yaml: line"), "{st:?}");
    std::fs::remove_file(root.join(FILE)).unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("x.yaml"), "scripts:\n  setup: evil\n").unwrap();
    std::os::unix::fs::symlink(outside.path().join("x.yaml"), root.join(FILE)).unwrap();
    assert!(load(root).is_err());
    std::fs::remove_file(root.join(FILE)).unwrap();
    std::fs::create_dir(root.join(FILE)).unwrap();
    assert!(load(root).is_err());
  }
}
