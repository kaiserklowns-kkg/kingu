//! VS Code's tool sets for agent chats: `*.toolsets.jsonc` files naming groups of tools, from the
//! folder's `.vscode/` and the user's `<config>/prompts/` (VS Code's user prompts folder). Each
//! file maps a set name to `{ "tools": [...], "description": "...", "icon": "..." }`.
//!
//! A set's `tools` are written the way VS Code references tools in prompts (`edit`, `search/codebase`,
//! `web/fetch`, `<mcp server>/<tool>`, another set's name) or as Claude tool names (`Read`,
//! `mcp__github__search_issues`). `resolve` turns them into the Claude tool names a run can leave
//! out (`disallowedTools`), which is all Kingu does with them: the Configure Tools picker turns a
//! whole set on or off, `#set` in a prompt turns its tools back on (chatTools.ts), and a custom
//! agent's `tools:` may name a set (`expand`, customizations.rs). Files are read only when they are
//! regular files (no symlinks) in a real folder, size-capped like the other customization files.

use std::path::{Path, PathBuf};

use super::customizations::read_regular;

pub const SUFFIX: &str = ".toolsets.jsonc";
const MAX_FILES: usize = 20;
const MAX_SETS: usize = 100;
const MAX_TOOLS: usize = 200;
const MAX_DESCRIPTION: usize = 300;
/// How deep sets naming sets are followed.
const MAX_DEPTH: usize = 4;

/// Claude Code's own tools (the SDK's names), as the picker lists them before a session reports its own.
pub const CLAUDE_TOOLS: &[&str] = &[
  "Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "Task", "Skill", "ExitPlanMode",
];
const EDIT: &[&str] = &["Edit", "Write", "MultiEdit", "NotebookEdit"];
const SHELL: &[&str] = &["Bash"];
const SEARCH: &[&str] = &["Glob", "Grep"];
const WEB: &[&str] = &["WebFetch", "WebSearch"];

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ToolSet {
  pub name: String,
  pub description: String,
  pub icon: Option<String>,
  /// As written in the file.
  pub tools: Vec<String>,
  /// The Claude tool names they stand for (sorted, no repeats).
  pub resolved: Vec<String>,
  /// Entries Kingu does not know (shown in the picker, left alone).
  pub unknown: Vec<String>,
  /// Absolute, to open it.
  pub path: String,
  /// `.vscode/<file>` or `~config/prompts/<file>`.
  pub rel: String,
  /// The user's (not the folder's).
  pub user: bool,
}

/// A set name `#name` can carry.
pub fn valid_name(s: &str) -> bool {
  let mut chars = s.chars();
  chars.next().is_some_and(|c| c.is_ascii_alphanumeric()) && s.len() <= 64 && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

fn cut(s: &str, max: usize) -> String {
  if s.chars().count() > max { format!("{}…", s.chars().take(max).collect::<String>()) } else { s.to_owned() }
}

/// The sets of one file's text (unresolved); a file that does not parse has none.
pub fn parse(text: &str, path: &Path, rel: &str, user: bool) -> Vec<ToolSet> {
  let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(&crate::settings::strip_jsonc(text)) else { return Vec::new() };
  let mut out = Vec::new();
  for (name, v) in map {
    if !valid_name(&name) || out.len() >= MAX_SETS {
      continue;
    }
    let Some(list) = v.get("tools").and_then(|t| t.as_array()) else { continue };
    let tools: Vec<String> = list.iter().filter_map(|t| t.as_str()).map(str::trim).filter(|t| !t.is_empty() && t.len() <= 200).take(MAX_TOOLS).map(str::to_owned).collect();
    if tools.is_empty() {
      continue;
    }
    out.push(ToolSet {
      name,
      description: cut(v.get("description").and_then(|d| d.as_str()).unwrap_or(""), MAX_DESCRIPTION),
      icon: v.get("icon").and_then(|i| i.as_str()).filter(|i| valid_name(i)).map(str::to_owned),
      tools,
      resolved: Vec::new(),
      unknown: Vec::new(),
      path: path.to_string_lossy().into_owned(),
      rel: rel.to_owned(),
      user,
    });
  }
  out
}

/// What a VS Code tool reference stands for in Claude's tools; `None`: not one Kingu knows.
fn builtin(name: &str) -> Option<Vec<String>> {
  let own = |l: &[&str]| Some(l.iter().map(|s| (*s).to_owned()).collect());
  if CLAUDE_TOOLS.contains(&name) {
    return own(&[name]);
  }
  if name.starts_with("mcp__") {
    return super::chats::valid_tool_name(name).then(|| vec![name.to_owned()]);
  }
  let n = name.to_ascii_lowercase();
  match n.as_str() {
    "edit/editnotebook" | "editnotebook" => own(&["NotebookEdit"]),
    "read" | "read/readfile" | "readfile" => own(&["Read"]),
    "search" | "search/codebase" | "codebase" => own(SEARCH),
    "search/filesearch" | "filesearch" | "search/listdirectory" | "listdirectory" => own(&["Glob"]),
    "search/textsearch" | "textsearch" => own(&["Grep"]),
    "web" => own(WEB),
    "web/fetch" | "fetch" => own(&["WebFetch"]),
    "web/search" | "websearch" => own(&["WebSearch"]),
    "todo" | "todos" | "todowrite" => own(&["TodoWrite"]),
    "agent" | "agent/runsubagent" | "runsubagent" => own(&["Task"]),
    _ if n == "edit" || n.starts_with("edit/") || matches!(n.as_str(), "editfiles" | "createfile" | "createdirectory" | "applypatch") => own(EDIT),
    _ if n == "execute" || n.starts_with("execute/") || matches!(n.as_str(), "runcommands" | "runinterminal" | "runtasks" | "terminal") => own(SHELL),
    // Read and search tools Claude has no counterpart for (problems, usages, …): nothing to leave out.
    _ if n.starts_with("read/") || n.starts_with("search/") || n.starts_with("vscode/") => Some(Vec::new()),
    _ => None,
  }
}

/// `<server>/<tool>` and `<server>/*` of an MCP server, as Claude names them.
fn mcp_ref(name: &str) -> Option<String> {
  let (server, tool) = name.split_once('/')?;
  let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'));
  if !ok(server) {
    return None;
  }
  if tool == "*" {
    return Some(format!("mcp__{server}"));
  }
  ok(tool).then(|| format!("mcp__{server}__{tool}"))
}

fn set_named<'a>(sets: &'a [ToolSet], name: &str) -> Option<&'a ToolSet> {
  sets.iter().find(|s| s.name.eq_ignore_ascii_case(name))
}

/// `stack`: the sets being followed, so a set naming itself (or a loop of sets) stops quietly.
fn resolve_into(tool: &str, sets: &[ToolSet], stack: &mut Vec<String>, out: &mut Vec<String>, unknown: &mut Vec<String>) {
  if let Some(names) = builtin(tool) {
    out.extend(names);
  } else if let Some(set) = set_named(sets, tool) {
    let key = set.name.to_lowercase();
    if stack.contains(&key) || stack.len() >= MAX_DEPTH {
      return;
    }
    stack.push(key);
    for t in &set.tools {
      resolve_into(t, sets, stack, out, unknown);
    }
    stack.pop();
  } else if let Some(name) = mcp_ref(tool) {
    out.push(name);
  } else if !unknown.iter().any(|u| u == tool) {
    unknown.push(tool.to_owned());
  }
}

/// The Claude tool names `tools` stand for (sets followed), and the entries left unknown.
pub fn resolve(tools: &[String], sets: &[ToolSet]) -> (Vec<String>, Vec<String>) {
  let (mut out, mut unknown) = (Vec::new(), Vec::new());
  for t in tools {
    resolve_into(t, sets, &mut Vec::new(), &mut out, &mut unknown);
  }
  out.sort();
  out.dedup();
  (out, unknown)
}

/// `tools` with each set name replaced by the set's own entries (followed `MAX_DEPTH` deep), for a
/// custom agent's `tools:` list; other entries stay as they are.
pub fn expand(tools: &[String], sets: &[ToolSet]) -> Vec<String> {
  fn go(t: &str, sets: &[ToolSet], stack: &mut Vec<String>, out: &mut Vec<String>) {
    match set_named(sets, t).filter(|_| builtin(t).is_none()) {
      Some(set) => {
        let key = set.name.to_lowercase();
        if stack.contains(&key) || stack.len() >= MAX_DEPTH {
          return;
        }
        stack.push(key);
        set.tools.iter().for_each(|x| go(x, sets, stack, out));
        stack.pop();
      }
      None if !out.iter().any(|o| o == t) => out.push(t.to_owned()),
      None => {}
    }
  }
  let mut out = Vec::new();
  for t in tools {
    go(t, sets, &mut Vec::new(), &mut out);
  }
  out
}

/// `*.toolsets.jsonc` files directly in `dir` (a real folder), sorted by name.
fn files_in(dir: &Path) -> Vec<PathBuf> {
  if !std::fs::symlink_metadata(dir).is_ok_and(|m| m.is_dir()) {
    return Vec::new();
  }
  let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
  let mut files: Vec<PathBuf> = entries.flatten().filter(|e| e.file_name().to_str().is_some_and(|n| n.ends_with(SUFFIX) && !n.starts_with('.'))).map(|e| e.path()).collect();
  files.sort();
  files.truncate(MAX_FILES);
  files
}

/// The tool sets of chat folder `cwd` (`.vscode/`) then the user's (`<config>/prompts/`), resolved;
/// a name found earlier hides a later one (names compare without case).
pub fn discover(cwd: &Path, config: Option<&Path>) -> Vec<ToolSet> {
  let mut dirs = vec![(cwd.join(".vscode"), false)];
  if let Some(c) = config {
    dirs.push((c.join("prompts"), true));
  }
  let mut sets: Vec<ToolSet> = Vec::new();
  for (dir, user) in dirs {
    for path in files_in(&dir) {
      let Some(text) = read_regular(&path) else { continue };
      let file = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
      let rel = if user { format!("~config/prompts/{file}") } else { format!(".vscode/{file}") };
      for set in parse(&text, &path, &rel, user) {
        if sets.len() < MAX_SETS && set_named(&sets, &set.name).is_none() {
          sets.push(set);
        }
      }
    }
  }
  let all = sets.clone();
  for set in &mut sets {
    (set.resolved, set.unknown) = resolve(&set.tools, &all);
  }
  sets.sort_by_key(|s| s.name.to_lowercase());
  sets
}

/// The tool sets of where a chat runs (the open folder or one of its task worktrees; the open
/// folder when `cwd` is omitted) and the user's. Empty with no folder open.
#[tauri::command]
pub async fn chat_tool_sets(app: tauri::AppHandle, ws: crate::workspace::Workspace, cwd: Option<String>) -> Result<Vec<ToolSet>, String> {
  let Some(root) = ws.current() else { return Ok(Vec::new()) };
  let dir = match cwd {
    Some(d) => super::chats::resolve_cwd(&root, Path::new(&d))?,
    None => root,
  };
  let config = crate::snap::config_dir(&app)?;
  tauri::async_runtime::spawn_blocking(move || discover(&dir, Some(&config))).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn write(dir: &Path, rel: &str, text: &str) {
    let p = dir.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
  }

  fn names(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_owned()).collect()
  }

  #[test]
  fn parses_jsonc_files() {
    let text = r#"{
      // VS Code's example
      "reader": { "tools": ["search/changes", "search/codebase", "read/problems", "search/usages"], "description": "Tools for reading", "icon": "book", },
      "bad name": { "tools": ["Read"] },
      "empty": { "tools": [] },
      "noTools": { "description": "x" },
    }"#;
    let sets = parse(text, Path::new("/w/.vscode/a.toolsets.jsonc"), ".vscode/a.toolsets.jsonc", false);
    assert_eq!(sets.len(), 1);
    assert_eq!((sets[0].name.as_str(), sets[0].description.as_str(), sets[0].icon.as_deref()), ("reader", "Tools for reading", Some("book")));
    assert_eq!(sets[0].tools.len(), 4);
    assert!(parse("not json", Path::new("/x"), "x", true).is_empty());
  }

  #[test]
  fn resolves_vscode_names_mcp_and_nested_sets() {
    let set = |name: &str, tools: &[&str]| ToolSet { name: name.into(), description: String::new(), icon: None, tools: names(tools), resolved: vec![], unknown: vec![], path: String::new(), rel: String::new(), user: false };
    let sets = vec![set("reader", &["read", "search/codebase", "read/problems"]), set("dev", &["reader", "edit", "github/*", "github/create_issue", "Bash"]), set("loop", &["loop", "fetch"])];
    let (r, u) = resolve(&names(&["dev"]), &sets);
    assert_eq!(r, ["Bash", "Edit", "Glob", "Grep", "MultiEdit", "NotebookEdit", "Read", "Write", "mcp__github", "mcp__github__create_issue"]);
    assert!(u.is_empty());
    let (r, u) = resolve(&names(&["loop", "nope", "web", "mcp__x__y"]), &sets);
    assert_eq!(r, ["WebFetch", "WebSearch", "mcp__x__y"], "a set naming itself stops");
    assert_eq!(u, ["nope"]);
    assert_eq!(expand(&names(&["reader", "edit", "Read"]), &sets), ["read", "search/codebase", "read/problems", "edit", "Read"]);
  }

  #[test]
  fn discovers_folder_sets_before_the_users() {
    let tmp = tempfile::tempdir().unwrap();
    let (cwd, config) = (tmp.path().join("repo"), tmp.path().join("config"));
    write(&cwd, ".vscode/team.toolsets.jsonc", r#"{"reader": {"tools": ["read"]}, "web": {"tools": ["web/fetch"]}}"#);
    write(&cwd, ".vscode/notes.json", r#"{"x": {"tools": ["read"]}}"#);
    write(&config, "prompts/mine.toolsets.jsonc", r#"{"Reader": {"tools": ["Bash"]}, "writer": {"tools": ["edit", "reader"]}}"#);
    let sets = discover(&cwd, Some(&config));
    let rows: Vec<_> = sets.iter().map(|s| (s.name.as_str(), s.user, s.resolved.clone())).collect();
    assert_eq!(
      rows,
      [
        ("reader", false, names(&["Read"])),
        ("web", false, names(&["WebFetch"])),
        ("writer", true, names(&["Edit", "MultiEdit", "NotebookEdit", "Read", "Write"])),
      ]
    );
    assert_eq!(sets[2].rel, "~config/prompts/mine.toolsets.jsonc");
  }

  #[cfg(unix)]
  #[test]
  fn skips_symlinked_files_and_folders() {
    let tmp = tempfile::tempdir().unwrap();
    let (cwd, outside) = (tmp.path().join("repo"), tmp.path().join("outside"));
    write(&outside, "x.toolsets.jsonc", r#"{"s": {"tools": ["read"]}}"#);
    std::fs::create_dir_all(&cwd).unwrap();
    std::os::unix::fs::symlink(&outside, cwd.join(".vscode")).unwrap();
    assert!(discover(&cwd, None).is_empty());
    std::fs::remove_file(cwd.join(".vscode")).unwrap();
    std::fs::create_dir(cwd.join(".vscode")).unwrap();
    std::os::unix::fs::symlink(outside.join("x.toolsets.jsonc"), cwd.join(".vscode/x.toolsets.jsonc")).unwrap();
    assert!(discover(&cwd, None).is_empty());
  }
}
