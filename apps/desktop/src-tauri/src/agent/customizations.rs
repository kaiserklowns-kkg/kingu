//! VS Code's chat customization files, for agent chats:
//!
//! - prompt files (`*.prompt.md` in `chat.promptFilesLocations`, `.github/prompts` by default):
//!   run as `/name` from the chat input; the front matter can pick the agent and the model;
//! - custom agents (`*.agent.md` / `*.md` in `chat.agentFilesLocations`: `.github/agents`,
//!   `.claude/agents` and `~/.copilot/agents`, plus the legacy `.github/chatmodes/*.chatmode.md`
//!   and the user's `~/.claude/agents`): picked in the chat's mode picker next to Agent, Ask and
//!   Plan; their body goes after the system prompt and their `tools` limit what the run may use;
//! - instructions files (`*.instructions.md` in `chat.instructionsFilesLocations`): `applyTo`
//!   globs against the attached files, applied by `rules.rs` like Cursor's rules.
//!
//! The locations come from the user's own settings.json only (VS Code's defaults, merged key by
//! key), never from the repository's settings: a repository cannot point Kingu at other folders.
//! Files are read only when they are regular files (no symlinks) in a real folder, and each is
//! size-capped. The agent a chat names is looked up by name among the files found here, so a
//! chats.json from a repository cannot make Kingu read anything else.

use std::path::{Path, PathBuf};


use crate::workspace::Workspace;

/// One file's text is cut to this.
pub const MAX_FILE_BYTES: usize = 64 * 1024;
/// Files listed per kind, and how deep a location is walked.
const MAX_FILES: usize = 200;
const MAX_DEPTH: usize = 3;
const MAX_DESCRIPTION: usize = 300;

pub const PROMPT_LOCATIONS: &str = "chat.promptFilesLocations";
pub const AGENT_LOCATIONS: &str = "chat.agentFilesLocations";
pub const INSTRUCTIONS_LOCATIONS: &str = "chat.instructionsFilesLocations";

/// VS Code's defaults of the three location settings.
pub const DEFAULT_PROMPT_LOCATIONS: &[&str] = &[".github/prompts"];
pub const DEFAULT_AGENT_LOCATIONS: &[&str] = &[".github/agents", ".claude/agents", "~/.copilot/agents"];
pub const DEFAULT_INSTRUCTIONS_LOCATIONS: &[&str] = &[".github/instructions", ".claude/rules", "~/.copilot/instructions", "~/.claude/rules"];
/// Always looked in for agents as well: VS Code's legacy chat modes and Claude's user agents.
const EXTRA_AGENT_LOCATIONS: &[&str] = &[".github/chatmodes", "~/.claude/agents"];

/// The built-in Ask agent: answers without changing anything.
pub const ASK_AGENT: &str = "ask";

/// The tools an agent's `tools` list can leave out, by what VS Code calls them.
const EDIT_TOOLS: &[&str] = &["Edit", "Write", "MultiEdit", "NotebookEdit"];
const SHELL_TOOLS: &[&str] = &["Bash"];
const WEB_TOOLS: &[&str] = &["WebFetch", "WebSearch"];

// ---- front matter ------------------------------------------------------------------------------

/// A front matter value: one line of text, or a list (`[a, b]`, `- a` lines, or for Claude's
/// agents a comma-separated `tools` line).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
  Text(String),
  List(Vec<String>),
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Front(Vec<(String, Value)>);

impl Front {
  fn get(&self, key: &str) -> Option<&Value> {
    self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
  }

  /// A text value (the first item of a list), trimmed; None when empty.
  pub fn text(&self, key: &str) -> Option<String> {
    let v = match self.get(key)? {
      Value::Text(s) => s.clone(),
      Value::List(l) => l.first()?.clone(),
    };
    Some(v.trim().to_owned()).filter(|s| !s.is_empty())
  }

  /// A list value; a text value is split at commas.
  pub fn list(&self, key: &str) -> Vec<String> {
    match self.get(key) {
      Some(Value::List(l)) => l.clone(),
      Some(Value::Text(s)) => s.split(',').map(unquote).filter(|s| !s.is_empty()).map(str::to_owned).collect(),
      None => Vec::new(),
    }
  }

  pub fn flag(&self, key: &str) -> Option<bool> {
    self.text(key).map(|v| v.eq_ignore_ascii_case("true"))
  }
}

fn unquote(s: &str) -> &str {
  let s = s.trim();
  s.strip_prefix('"').and_then(|x| x.strip_suffix('"')).or_else(|| s.strip_prefix('\'').and_then(|x| x.strip_suffix('\''))).unwrap_or(s).trim()
}

/// Splits a Markdown file into its `---` front matter (`key: value` lines; a `[...]` list or
/// `- item` lines under an empty key; nested blocks such as `handoffs` are skipped) and its body.
/// Without a closed front matter all of it is the body.
pub fn parse_front(text: &str) -> (Front, String) {
  let text = text.replace("\r\n", "\n");
  let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
  let Some(rest) = text.strip_prefix("---\n") else { return (Front::default(), text.trim().to_owned()) };
  let Some(end) = rest.find("\n---").map(|i| i + 1).or_else(|| rest.starts_with("---").then_some(0)) else {
    return (Front::default(), text.trim().to_owned());
  };
  let body = rest[end..].strip_prefix("---").unwrap_or("");
  let body = body.split_once('\n').map_or("", |(_, b)| b);
  let mut front = Front::default();
  let mut list_key: Option<String> = None;
  for line in rest[..end].lines() {
    if line.trim().is_empty() || line.trim_start().starts_with('#') {
      continue;
    }
    let indented = line.starts_with(' ') || line.starts_with('\t');
    if indented || line.starts_with("- ") {
      if let (Some(key), Some(item)) = (&list_key, line.trim().strip_prefix("- ")) {
        let item = unquote(item);
        // An item of a nested block (`handoffs: - label: …`) is not a value.
        if !item.is_empty()
          && !item.contains(": ")
          && let Some((_, Value::List(l))) = front.0.iter_mut().find(|(k, _)| k == key)
        {
          l.push(item.to_owned());
        }
      }
      continue;
    }
    list_key = None;
    let Some((key, value)) = line.split_once(':') else { continue };
    let (key, value) = (key.trim().to_owned(), value.trim());
    if front.0.iter().any(|(k, _)| *k == key) {
      continue;
    }
    if value.is_empty() {
      list_key = Some(key.clone());
      front.0.push((key, Value::List(Vec::new())));
    } else if let Some(inner) = value.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
      front.0.push((key, Value::List(inner.split(',').map(unquote).filter(|s| !s.is_empty()).map(str::to_owned).collect())));
    } else if !matches!(value, ">" | "|" | ">-" | "|-") {
      front.0.push((key, Value::Text(unquote(value).to_owned())));
    }
  }
  (front, body.trim().to_owned())
}

// ---- locations ---------------------------------------------------------------------------------

/// The folders of a location setting: VS Code's `defaults` (on), then the user's object over them
/// key by key (`false` turns a default off). Globs and `\` paths are skipped, as VS Code refuses them.
pub fn locations(user: Option<&serde_json::Value>, defaults: &[&str]) -> Vec<String> {
  let mut out: Vec<(String, bool)> = defaults.iter().map(|d| ((*d).to_owned(), true)).collect();
  if let Some(map) = user.and_then(|v| v.as_object()) {
    for (k, v) in map {
      let Some(on) = v.as_bool() else { continue };
      let k = k.trim().trim_end_matches('/').to_owned();
      if k.is_empty() || k.contains('\\') || k.contains('*') {
        continue;
      }
      match out.iter_mut().find(|(d, _)| *d == k) {
        Some(entry) => entry.1 = on,
        None => out.push((k, on)),
      }
    }
  }
  out.into_iter().filter(|(_, on)| *on).map(|(k, _)| k).collect()
}

/// Where a location is: `~` / `~/…` under the home folder, an absolute path as is, anything else
/// relative to the chat's folder `cwd`. Second: whether it is the user's (not the folder's).
pub fn resolve_location(loc: &str, cwd: &Path, home: Option<&Path>) -> Option<(PathBuf, bool)> {
  if loc == "~" {
    return home.map(|h| (h.to_path_buf(), true));
  }
  if let Some(rest) = loc.strip_prefix("~/") {
    return home.map(|h| (h.join(rest), true));
  }
  let p = Path::new(loc);
  if p.is_absolute() { Some((p.to_path_buf(), true)) } else { Some((cwd.join(p), false)) }
}

/// A plain directory (not a symlink).
fn real_dir(p: &Path) -> bool {
  std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir())
}

/// The file's text when it is a regular file (not a symlink), cut to `MAX_FILE_BYTES` at a
/// character boundary.
pub fn read_regular(path: &Path) -> Option<String> {
  let meta = std::fs::symlink_metadata(path).ok()?;
  if !meta.is_file() {
    return None;
  }
  use std::io::Read;
  let mut buf = Vec::new();
  std::fs::File::open(path).ok()?.take(MAX_FILE_BYTES as u64).read_to_end(&mut buf).ok()?;
  let mut text = String::from_utf8_lossy(&buf).into_owned();
  if buf.len() == MAX_FILE_BYTES {
    while text.ends_with('\u{fffd}') {
      text.pop();
    }
  }
  Some(text)
}

/// Files under `dir` (not following symlinked folders) whose name `pick` accepts, sorted by path.
fn files_in(dir: &Path, pick: &dyn Fn(&str) -> bool, out: &mut Vec<PathBuf>) {
  fn walk(dir: &Path, depth: usize, pick: &dyn Fn(&str) -> bool, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
      if out.len() >= MAX_FILES {
        return;
      }
      let Ok(kind) = e.file_type() else { continue };
      let name = e.file_name();
      let Some(name) = name.to_str() else { continue };
      if kind.is_dir() && depth < MAX_DEPTH && !name.starts_with('.') {
        walk(&e.path(), depth + 1, pick, out);
      } else if kind.is_file() && pick(name) {
        out.push(e.path());
      }
    }
  }
  if real_dir(dir) {
    walk(dir, 0, pick, out);
  }
}

fn cut(s: Option<String>, max: usize) -> String {
  let s = s.unwrap_or_default();
  if s.chars().count() > max { format!("{}…", s.chars().take(max).collect::<String>()) } else { s }
}

/// A name `/name` can carry: no spaces or slashes.
fn valid_name(s: &str) -> bool {
  !s.is_empty() && s.chars().count() <= 100 && !s.starts_with('.') && s.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
}

/// The settings that pick the locations, read from the user's settings.json.
#[derive(Debug, Default, Clone)]
pub struct Settings {
  pub prompts: Option<serde_json::Value>,
  pub agents: Option<serde_json::Value>,
  pub instructions: Option<serde_json::Value>,
}

impl Settings {
  pub fn from_user(config: &Path) -> Self {
    let user = |key: &str| crate::settings::user_value(config, key);
    Self { prompts: user(PROMPT_LOCATIONS), agents: user(AGENT_LOCATIONS), instructions: user(INSTRUCTIONS_LOCATIONS) }
  }
}

/// `$HOME`.
pub fn home() -> Option<PathBuf> {
  std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from)
}

fn shown_path(path: &Path, cwd: &Path, home: Option<&Path>) -> String {
  if let Ok(rel) = path.strip_prefix(cwd) {
    return rel.to_string_lossy().replace('\\', "/");
  }
  if let Some(rel) = home.and_then(|h| path.strip_prefix(h).ok()) {
    return format!("~/{}", rel.to_string_lossy().replace('\\', "/"));
  }
  path.to_string_lossy().into_owned()
}

// ---- prompt files ------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PromptFile {
  /// `/name` (front matter `name`, else the file name without `.prompt.md`).
  pub name: String,
  pub description: String,
  pub argument_hint: String,
  /// `ask`, `agent`, `plan` or a custom agent's name.
  pub agent: Option<String>,
  pub model: Option<String>,
  pub tools: Vec<String>,
  /// Absolute, to open it.
  pub path: String,
  /// Relative to the chat's folder, or `~/…`.
  pub rel: String,
  /// The user's (a `~/` or absolute location), not the folder's.
  pub user: bool,
}

fn prompt_of(path: &Path, text: &str, cwd: &Path, home: Option<&Path>, user: bool) -> Option<PromptFile> {
  let file = path.file_name()?.to_str()?;
  let stem = file.strip_suffix(".prompt.md")?;
  let (front, body) = parse_front(text);
  let name = front.text("name").filter(|n| valid_name(n)).unwrap_or_else(|| stem.to_owned());
  if !valid_name(&name) {
    return None;
  }
  let description = front.text("description").or_else(|| body.lines().map(str::trim).find(|l| !l.is_empty()).map(|l| l.trim_start_matches('#').trim().to_owned()));
  // `mode` is the older name of `agent`.
  let agent = front.text("agent").or_else(|| front.text("mode"));
  Some(PromptFile {
    name,
    description: cut(description, MAX_DESCRIPTION),
    argument_hint: cut(front.text("argument-hint"), 100),
    agent,
    model: front.text("model"),
    tools: front.list("tools"),
    path: path.to_string_lossy().into_owned(),
    rel: shown_path(path, cwd, home),
    user,
  })
}

/// The prompt files of chat folder `cwd`, the folder's first; a name found earlier hides a later one.
pub fn prompt_files(cwd: &Path, home: Option<&Path>, settings: &Settings) -> Vec<PromptFile> {
  let mut out: Vec<PromptFile> = Vec::new();
  let mut locs: Vec<(PathBuf, bool)> = locations(settings.prompts.as_ref(), DEFAULT_PROMPT_LOCATIONS).iter().filter_map(|l| resolve_location(l, cwd, home)).collect();
  locs.sort_by_key(|(_, user)| *user);
  for (dir, user) in locs {
    let mut files = Vec::new();
    files_in(&dir, &|n| n.ends_with(".prompt.md"), &mut files);
    for path in files {
      let Some(text) = read_regular(&path) else { continue };
      if let Some(p) = prompt_of(&path, &text, cwd, home, user)
        && !out.iter().any(|o| o.name == p.name)
      {
        out.push(p);
      }
    }
  }
  out.sort_by(|a, b| a.name.cmp(&b.name));
  out
}

/// A prompt file to run: what it says and its body.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PromptRun {
  #[serde(flatten)]
  pub file: PromptFile,
  pub body: String,
}

// ---- custom agents -----------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CustomAgent {
  /// What the picker shows and the chat saves (front matter `name`, else the file name).
  pub name: String,
  pub description: String,
  pub argument_hint: String,
  pub model: Option<String>,
  /// VS Code tool names (or Claude's, for a `.claude/agents` file); empty: every tool.
  pub tools: Vec<String>,
  /// `user-invocable: false` keeps it out of the picker (it is still a subagent).
  pub user_invocable: bool,
  pub path: String,
  pub rel: String,
  pub user: bool,
}

fn agent_stem(file: &str) -> Option<&str> {
  file.strip_suffix(".agent.md").or_else(|| file.strip_suffix(".chatmode.md")).or_else(|| file.strip_suffix(".md"))
}

fn agent_of(path: &Path, text: &str, cwd: &Path, home: Option<&Path>, user: bool) -> Option<(CustomAgent, String)> {
  let stem = agent_stem(path.file_name()?.to_str()?)?;
  let (front, body) = parse_front(text);
  let name = front.text("name").unwrap_or_else(|| stem.to_owned());
  let name: String = name.chars().filter(|c| !c.is_control()).take(100).collect();
  if name.trim().is_empty() || name.eq_ignore_ascii_case(ASK_AGENT) || name.eq_ignore_ascii_case("agent") || name.eq_ignore_ascii_case("plan") || body.is_empty() {
    return None;
  }
  let agent = CustomAgent {
    name: name.trim().to_owned(),
    description: cut(front.text("description"), MAX_DESCRIPTION),
    argument_hint: cut(front.text("argument-hint"), 100),
    model: front.text("model"),
    tools: front.list("tools"),
    user_invocable: front.flag("user-invocable").or_else(|| front.flag("user-invokable")).unwrap_or(true),
    path: path.to_string_lossy().into_owned(),
    rel: shown_path(path, cwd, home),
    user,
  };
  Some((agent, body))
}

/// The custom agents of chat folder `cwd` with their bodies: the folder's first, a name found
/// earlier hides a later one (names compare without case).
pub fn agents_with_bodies(cwd: &Path, home: Option<&Path>, settings: &Settings) -> Vec<(CustomAgent, String)> {
  let mut names = locations(settings.agents.as_ref(), DEFAULT_AGENT_LOCATIONS);
  for extra in EXTRA_AGENT_LOCATIONS {
    if !names.iter().any(|n| n == extra) {
      names.push((*extra).to_owned());
    }
  }
  let mut locs: Vec<(PathBuf, bool)> = names.iter().filter_map(|l| resolve_location(l, cwd, home)).collect();
  locs.sort_by_key(|(_, user)| *user);
  let mut out: Vec<(CustomAgent, String)> = Vec::new();
  for (dir, user) in locs {
    let mut files = Vec::new();
    files_in(&dir, &|n| n.ends_with(".md") && !n.eq_ignore_ascii_case("README.md"), &mut files);
    for path in files {
      let Some(text) = read_regular(&path) else { continue };
      if let Some((a, body)) = agent_of(&path, &text, cwd, home, user)
        && !out.iter().any(|(o, _)| o.name.eq_ignore_ascii_case(&a.name))
      {
        out.push((a, body));
      }
    }
  }
  out.sort_by_key(|(a, _)| a.name.to_lowercase());
  out
}

/// The tools a run of an agent with VS Code tool list `tools` must not have: edits without an
/// edit tool, the shell without a terminal tool, the web without a fetch or search tool. An
/// empty list allows everything (VS Code: no `tools` means the default tools).
pub fn disallowed_for(tools: &[String]) -> Vec<String> {
  if tools.is_empty() {
    return Vec::new();
  }
  let names: Vec<String> = tools.iter().map(|t| t.trim().to_lowercase()).collect();
  let any = |test: &dyn Fn(&str) -> bool| names.iter().any(|n| test(n) || n.split_once('/').is_some_and(|(set, tool)| test(set) || test(tool)));
  let edit = any(&|n| n.starts_with("edit") || matches!(n, "write" | "multiedit" | "notebookedit" | "createfile" | "createdirectory" | "applypatch"));
  let shell = any(&|n| n.starts_with("execute") || n.starts_with("runcommand") || n.contains("terminal") || matches!(n, "bash" | "shell" | "runtasks" | "runtask"));
  let web = any(&|n| n.starts_with("web") || n.starts_with("fetch") || n == "githubrepo");
  let mut out = Vec::new();
  for (allowed, list) in [(edit, EDIT_TOOLS), (shell, SHELL_TOOLS), (web, WEB_TOOLS)] {
    if !allowed {
      out.extend(list.iter().map(|s| (*s).to_owned()));
    }
  }
  out
}

/// What a run of chat agent `name` gets: text after the system prompt and the tools it must not
/// have. `ask` is the built-in Ask agent; anything else must be a custom agent found in `cwd`'s
/// locations (else an error: the chat names an agent that is gone). A tool set named in the
/// agent's `tools` (`tool_sets`) stands for its own tools.
pub fn for_run(cwd: &Path, home: Option<&Path>, settings: &Settings, sets: &[super::tool_sets::ToolSet], name: &str) -> Result<(String, Vec<String>), String> {
  if name == ASK_AGENT {
    let text = "# Ask mode\n\nThe user picked Ask: they want answers, not changes. Read and search the code to answer questions, explain and suggest. Do not edit files or run commands; show any change as a code block the user can apply.".to_owned();
    let mut tools: Vec<String> = EDIT_TOOLS.iter().chain(SHELL_TOOLS).map(|s| (*s).to_owned()).collect();
    tools.sort();
    return Ok((text, tools));
  }
  let Some((agent, body)) = agents_with_bodies(cwd, home, settings).into_iter().find(|(a, _)| a.name.eq_ignore_ascii_case(name)) else {
    return Err(crate::tr!(crate::i18n::msg::AgentMsg::CustomAgentMissing, name = name));
  };
  let text = format!(
    "# Custom agent: {name}\n\nThe user picked the custom agent \"{name}\" ({rel}). Act as it describes below; where it conflicts with the project rules above, it wins.\n\n<agent-instructions>\n{body}\n</agent-instructions>",
    name = agent.name,
    rel = agent.rel
  );
  Ok((text, disallowed_for(&super::tool_sets::expand(&agent.tools, sets))))
}

// ---- instructions files ------------------------------------------------------------------------

/// An `*.instructions.md` file: `applyTo` globs (`**` applies always) and `description`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Instructions {
  pub path: PathBuf,
  pub apply_to: Vec<String>,
  pub description: Option<String>,
  pub body: String,
}

/// The instructions files of chat folder `cwd`. `.claude/rules` locations are left out: Claude
/// Code reads them itself.
pub fn instructions_files(cwd: &Path, home: Option<&Path>, settings: &Settings) -> Vec<Instructions> {
  let mut locs: Vec<(PathBuf, bool)> = locations(settings.instructions.as_ref(), DEFAULT_INSTRUCTIONS_LOCATIONS)
    .iter()
    .filter(|l| !l.trim_end_matches('/').ends_with(".claude/rules"))
    .filter_map(|l| resolve_location(l, cwd, home))
    .collect();
  locs.sort_by_key(|(_, user)| *user);
  let mut out = Vec::new();
  let mut seen = std::collections::HashSet::new();
  for (dir, _) in locs {
    let mut files = Vec::new();
    files_in(&dir, &|n| n.ends_with(".instructions.md"), &mut files);
    for path in files {
      if !seen.insert(std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone())) {
        continue;
      }
      let Some(text) = read_regular(&path) else { continue };
      let (front, body) = parse_front(&text);
      if body.is_empty() {
        continue;
      }
      out.push(Instructions { path, apply_to: front.list("applyTo"), description: front.text("description"), body });
    }
  }
  out
}

// ---- commands ----------------------------------------------------------------------------------

/// What the chat input lists: prompt files for `/` and custom agents for the mode picker.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Customizations {
  pub prompts: Vec<PromptFile>,
  pub agents: Vec<CustomAgent>,
}

fn chat_dir(ws: &Workspace, cwd: Option<&str>) -> Result<Option<PathBuf>, String> {
  match ws.current() {
    Some(root) => Ok(Some(match cwd {
      Some(dir) => super::chats::resolve_cwd(&root, Path::new(dir))?,
      None => root,
    })),
    None => Ok(None),
  }
}

/// The prompt files and custom agents of where a chat runs (the open folder or one of its task
/// worktrees; the open folder when `cwd` is omitted). Empty with no folder open.
#[tauri::command]
pub async fn chat_customizations(app: tauri::AppHandle, ws: Workspace, cwd: Option<String>) -> Result<Customizations, String> {
  let Some(dir) = chat_dir(&ws, cwd.as_deref())? else { return Ok(Customizations { prompts: Vec::new(), agents: Vec::new() }) };
  let settings = Settings::from_user(&crate::snap::config_dir(&app)?);
  tauri::async_runtime::spawn_blocking(move || {
    let home = home();
    Customizations {
      prompts: prompt_files(&dir, home.as_deref(), &settings),
      agents: agents_with_bodies(&dir, home.as_deref(), &settings).into_iter().map(|(a, _)| a).collect(),
    }
  })
  .await
  .map_err(|e| e.to_string())
}

/// Prompt file `/name` of where a chat runs, with its body, to run it.
#[tauri::command]
pub async fn chat_prompt_file(app: tauri::AppHandle, ws: Workspace, cwd: Option<String>, name: String) -> Result<PromptRun, String> {
  let Some(dir) = chat_dir(&ws, cwd.as_deref())? else { return Err(crate::tr!(crate::i18n::msg::AgentMsg::PromptFileMissing, name = name)) };
  let settings = Settings::from_user(&crate::snap::config_dir(&app)?);
  tauri::async_runtime::spawn_blocking(move || {
    let home = home();
    let file = prompt_files(&dir, home.as_deref(), &settings).into_iter().find(|p| p.name == name);
    let run = file.and_then(|file| {
      let (_, body) = parse_front(&read_regular(Path::new(&file.path))?);
      Some(PromptRun { file, body })
    });
    run.ok_or_else(|| crate::tr!(crate::i18n::msg::AgentMsg::PromptFileMissing, name = name))
  })
  .await
  .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn write(dir: &Path, rel: &str, text: &str) {
    let p = dir.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
  }

  #[test]
  fn parses_front_matter() {
    let (f, body) = parse_front("---\nname: Planner\ndescription: 'Plan only'\ntools: ['read', \"search\"]\nhandoffs:\n  - label: Go\n    agent: agent\nmodel: Claude Sonnet 4\n---\nResearch the task.\n");
    assert_eq!(f.text("name").as_deref(), Some("Planner"));
    assert_eq!(f.text("description").as_deref(), Some("Plan only"));
    assert_eq!(f.list("tools"), ["read", "search"]);
    assert_eq!(f.text("model").as_deref(), Some("Claude Sonnet 4"));
    assert_eq!(f.list("handoffs"), Vec::<String>::new(), "nested blocks are skipped");
    assert_eq!(body, "Research the task.");
    let (f, _) = parse_front("---\r\ntools: Read, Grep, Glob\r\napplyTo:\r\n  - '**/*.ts'\r\n  - src/**\r\nuser-invocable: false\r\n---\r\nx");
    assert_eq!(f.list("tools"), ["Read", "Grep", "Glob"]);
    assert_eq!(f.list("applyTo"), ["**/*.ts", "src/**"]);
    assert_eq!(f.flag("user-invocable"), Some(false));
    assert_eq!(parse_front("No front matter"), (Front::default(), "No front matter".into()));
    assert_eq!(parse_front("---\nnot closed").1, "---\nnot closed");
    assert_eq!(parse_front("---\n---\nBody").1, "Body");
  }

  #[test]
  fn locations_merge_the_users_object_over_the_defaults() {
    assert_eq!(locations(None, DEFAULT_AGENT_LOCATIONS), [".github/agents", ".claude/agents", "~/.copilot/agents"]);
    let user = json!({ ".claude/agents": false, "my-agents/": true, "src/**/agents": true, "a\\b": true, "x": "yes" });
    assert_eq!(locations(Some(&user), DEFAULT_AGENT_LOCATIONS), [".github/agents", "~/.copilot/agents", "my-agents"]);
    let (cwd, home) = (Path::new("/w"), Path::new("/h"));
    assert_eq!(resolve_location("~/.copilot/agents", cwd, Some(home)), Some((PathBuf::from("/h/.copilot/agents"), true)));
    assert_eq!(resolve_location("../shared", cwd, Some(home)), Some((PathBuf::from("/w/../shared"), false)));
    assert_eq!(resolve_location("/opt/agents", cwd, None), Some((PathBuf::from("/opt/agents"), true)));
    assert_eq!(resolve_location("~/x", cwd, None), None);
  }

  #[test]
  fn lists_prompt_files_folder_first() {
    let tmp = tempfile::tempdir().unwrap();
    let (cwd, home) = (tmp.path().join("repo"), tmp.path().join("home"));
    write(&cwd, ".github/prompts/new-component.prompt.md", "---\ndescription: Make a component\nagent: agent\nmodel: GPT-4o\nargument-hint: <name>\n---\nCreate ${input:name}.");
    write(&cwd, ".github/prompts/review/security.prompt.md", "---\nname: security-review\nmode: ask\n---\nReview it.");
    write(&cwd, ".github/prompts/notes.md", "not a prompt file");
    write(&cwd, ".github/prompts/bad name.prompt.md", "spaces");
    write(&home, "prompts/new-component.prompt.md", "Mine");
    write(&home, "prompts/standup.prompt.md", "# Write my standup\n\nToday…");
    let settings = Settings { prompts: Some(json!({ "~/prompts": true })), ..Default::default() };
    let all = prompt_files(&cwd, Some(&home), &settings);
    let rows: Vec<_> = all.iter().map(|p| (p.name.as_str(), p.description.as_str(), p.agent.as_deref(), p.user)).collect();
    assert_eq!(
      rows,
      [
        ("new-component", "Make a component", Some("agent"), false),
        ("security-review", "Review it.", Some("ask"), false),
        ("standup", "Write my standup", None, true),
      ]
    );
    assert_eq!((all[0].model.as_deref(), all[0].argument_hint.as_str(), all[0].rel.as_str()), (Some("GPT-4o"), "<name>", ".github/prompts/new-component.prompt.md"));
    assert_eq!(all[2].rel, "~/prompts/standup.prompt.md");
    // The user turned the default location off.
    let off = Settings { prompts: Some(json!({ ".github/prompts": false })), ..Default::default() };
    assert!(prompt_files(&cwd, Some(&home), &off).is_empty());
  }

  #[test]
  fn lists_custom_agents_and_their_tools() {
    let tmp = tempfile::tempdir().unwrap();
    let (cwd, home) = (tmp.path().join("repo"), tmp.path().join("home"));
    write(&cwd, ".github/agents/planner.agent.md", "---\nname: Planner\ndescription: Plan without changing code\ntools: ['read', 'search']\n---\nReturn a plan.");
    write(&cwd, ".github/agents/README.md", "About the agents");
    write(&cwd, ".github/agents/hidden.agent.md", "---\nuser-invocable: false\n---\nOnly as a subagent.");
    write(&cwd, ".github/agents/empty.agent.md", "---\nname: Empty\n---\n");
    write(&cwd, ".github/agents/ask.agent.md", "Shadowing a built-in is refused.");
    write(&cwd, ".github/chatmodes/legacy.chatmode.md", "---\ndescription: Old mode\n---\nBe brief.");
    write(&cwd, ".claude/agents/reviewer.md", "---\nname: reviewer\ndescription: Reviews\ntools: Read, Grep, Bash\nmodel: sonnet\n---\nReview the diff.");
    write(&home, ".claude/agents/planner.md", "---\nname: planner\n---\nThe user's planner loses to the folder's.");
    write(&home, ".copilot/agents/writer.agent.md", "Write docs.");
    let agents = agents_with_bodies(&cwd, Some(&home), &Settings::default());
    let rows: Vec<_> = agents.iter().map(|(a, _)| (a.name.as_str(), a.user_invocable, a.user)).collect();
    assert_eq!(rows, [("hidden", false, false), ("legacy", true, false), ("Planner", true, false), ("reviewer", true, false), ("writer", true, true)]);
    let reviewer = &agents[3].0;
    assert_eq!((reviewer.tools.clone(), reviewer.model.as_deref()), (vec!["Read".to_owned(), "Grep".to_owned(), "Bash".to_owned()], Some("sonnet")));

    let (text, disallowed) = for_run(&cwd, Some(&home), &Settings::default(), &[], "planner").unwrap();
    assert!(text.contains("custom agent \"Planner\" (.github/agents/planner.agent.md)") && text.contains("<agent-instructions>\nReturn a plan.\n</agent-instructions>"), "{text}");
    assert_eq!(disallowed, ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "WebFetch", "WebSearch"]);
    assert_eq!(for_run(&cwd, Some(&home), &Settings::default(), &[], "reviewer").unwrap().1, ["Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch"]);
    assert!(for_run(&cwd, Some(&home), &Settings::default(), &[], "writer").unwrap().1.is_empty());
    assert!(for_run(&cwd, Some(&home), &Settings::default(), &[], "gone").is_err());
    let (ask, tools) = for_run(&cwd, None, &Settings::default(), &[], ASK_AGENT).unwrap();
    assert!(ask.starts_with("# Ask mode"));
    assert_eq!(tools, ["Bash", "Edit", "MultiEdit", "NotebookEdit", "Write"]);
    // A tool set in the agent's tools: its tools count.
    write(&cwd, ".github/agents/editor.agent.md", "---\ntools: ['writer']\n---\nEdit things.");
    write(&cwd, ".vscode/x.toolsets.jsonc", r#"{"writer": {"tools": ["edit", "runCommands"]}}"#);
    let sets = super::super::tool_sets::discover(&cwd, None);
    assert_eq!(for_run(&cwd, None, &Settings::default(), &sets, "editor").unwrap().1, ["WebFetch", "WebSearch"]);
    assert_eq!(for_run(&cwd, None, &Settings::default(), &[], "editor").unwrap().1, ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "WebFetch", "WebSearch"]);
  }

  #[test]
  fn maps_vscode_tool_names() {
    let names = |v: &[&str]| v.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    assert!(disallowed_for(&[]).is_empty());
    assert_eq!(disallowed_for(&names(&["edit", "execute", "web"])), Vec::<String>::new());
    assert_eq!(disallowed_for(&names(&["search/codebase", "edit/editFiles", "runCommands"])), ["WebFetch", "WebSearch"]);
    assert_eq!(disallowed_for(&names(&["vscode/askQuestions", "fetch"])), ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);
    assert_eq!(disallowed_for(&names(&["Write", "Bash", "WebSearch"])), Vec::<String>::new());
  }

  #[test]
  fn finds_instructions_files() {
    let tmp = tempfile::tempdir().unwrap();
    let (cwd, home) = (tmp.path().join("repo"), tmp.path().join("home"));
    write(&cwd, ".github/instructions/python.instructions.md", "---\napplyTo: '**/*.py'\n---\nUse type hints.");
    write(&cwd, ".github/instructions/db.instructions.md", "---\ndescription: Database work\n---\nUse migrations.");
    write(&cwd, ".github/instructions/empty.instructions.md", "---\napplyTo: '**'\n---\n");
    write(&cwd, ".claude/rules/x.instructions.md", "Claude Code reads these itself.");
    write(&home, ".copilot/instructions/me.instructions.md", "---\napplyTo: '**'\n---\nAnswer in Thai.");
    let found = instructions_files(&cwd, Some(&home), &Settings::default());
    let rows: Vec<_> = found.iter().map(|i| (i.path.file_name().unwrap().to_str().unwrap(), i.apply_to.clone(), i.description.clone())).collect();
    assert_eq!(
      rows,
      [
        ("db.instructions.md", vec![], Some("Database work".to_owned())),
        ("python.instructions.md", vec!["**/*.py".to_owned()], None),
        ("me.instructions.md", vec!["**".to_owned()], None),
      ]
    );
  }

  #[cfg(unix)]
  #[test]
  fn skips_symlinks_and_caps_files() {
    let tmp = tempfile::tempdir().unwrap();
    let (cwd, outside) = (tmp.path().join("repo"), tmp.path().join("outside"));
    write(&outside, "secret.prompt.md", "secret");
    write(&outside, "dir/leak.prompt.md", "secret");
    std::fs::create_dir_all(cwd.join(".github/prompts")).unwrap();
    std::os::unix::fs::symlink(outside.join("secret.prompt.md"), cwd.join(".github/prompts/secret.prompt.md")).unwrap();
    std::os::unix::fs::symlink(outside.join("dir"), cwd.join(".github/prompts/dir")).unwrap();
    std::os::unix::fs::symlink(&outside, cwd.join(".github/agents")).unwrap();
    assert!(prompt_files(&cwd, None, &Settings::default()).is_empty());
    assert!(agents_with_bodies(&cwd, None, &Settings::default()).is_empty());
    write(&cwd, "big.md", &"ก".repeat(MAX_FILE_BYTES));
    let text = read_regular(&cwd.join("big.md")).unwrap();
    assert!(text.len() <= MAX_FILE_BYTES && text.chars().all(|c| c == 'ก'));
  }
}
