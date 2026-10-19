//! Which agent runs a chat (`ChatMeta::runtime`), like old Kingu's structured chat: `claude` (the
//! Claude Agent SDK, built into the agent host), Codex over `codex app-server`, or an ACP agent
//! (Agent Client Protocol over stdio: Gemini CLI, Qwen Code, OpenCode, goose, …). The user can add
//! ACP agents by command in `kingu.agent.acpAgents` (user settings only: a folder never names a
//! program to run). Only runtimes whose program is on the login-shell PATH (`shell_env`) are
//! offered; Rust resolves the program to its absolute path, and the agent host runs only that.
//!
//! What a runtime cannot do is in its `Features`, so the chat hides it: only the Claude SDK can
//! rewind or fork a session at a message and switch the model mid-session.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::i18n::msg::RuntimeMsg;
use crate::tr;

pub const CLAUDE: &str = "claude";
/// User setting: ACP agents by id → command line (`{"my-agent": "my-agent --acp"}`).
pub const SETTING: &str = "kingu.agent.acpAgents";
const MAX_ID: usize = 40;
const MAX_CUSTOM: usize = 32;
const MAX_COMMAND: usize = 1024;

pub fn default_id() -> String {
  CLAUDE.into()
}

/// Runtime ids: lowercase letters, digits and `-`, 1-40 characters.
pub fn valid_id(id: &str) -> bool {
  !id.is_empty() && id.len() <= MAX_ID && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !id.starts_with('-')
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
  Claude,
  Acp,
  Codex,
}

/// What the chat may offer for a runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Features {
  /// Restore checkpoint, Edit request, Retry and Fork (a session resumed at a message).
  pub rewind: bool,
  /// The model picker (a model per chat, switched mid-session).
  pub models: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RuntimeInfo {
  pub id: String,
  pub name: String,
  pub protocol: Protocol,
  pub features: Features,
  /// User-configured (`kingu.agent.acpAgents`).
  pub custom: bool,
}

/// What the agent host starts for a runtime other than the Claude SDK (`StartRequest::runtime`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Spec {
  pub kind: &'static str,
  pub command: String,
  pub args: Vec<String>,
}

struct Known {
  id: &'static str,
  name: &'static str,
  program: &'static str,
  args: &'static [&'static str],
  protocol: Protocol,
}

/// The agents Kingu knows how to start (old Kingu's launch specs, plus Gemini CLI and Qwen Code).
const KNOWN: &[Known] = &[
  Known { id: "codex", name: "Codex", program: "codex", args: &["app-server"], protocol: Protocol::Codex },
  Known { id: "gemini", name: "Gemini CLI", program: "gemini", args: &["--experimental-acp"], protocol: Protocol::Acp },
  Known { id: "qwen", name: "Qwen Code", program: "qwen", args: &["--experimental-acp"], protocol: Protocol::Acp },
  Known { id: "opencode", name: "OpenCode", program: "opencode", args: &["acp"], protocol: Protocol::Acp },
  Known { id: "goose", name: "goose", program: "goose", args: &["acp"], protocol: Protocol::Acp },
  Known { id: "grok", name: "Grok", program: "grok", args: &["agent", "stdio"], protocol: Protocol::Acp },
  Known { id: "omp", name: "oh-my-pi", program: "omp", args: &["acp"], protocol: Protocol::Acp },
];

fn features(p: Protocol) -> Features {
  let claude = p == Protocol::Claude;
  Features { rewind: claude, models: claude }
}

/// A user-configured ACP agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Custom {
  pub id: String,
  pub argv: Vec<String>,
}

/// Splits a command line into words: whitespace separates, `'…'` and `"…"` group (no escapes).
/// None for an unclosed quote.
pub fn split_command(line: &str) -> Option<Vec<String>> {
  let mut words = Vec::new();
  let mut cur = String::new();
  let mut in_word = false;
  let mut quote: Option<char> = None;
  for c in line.chars() {
    match quote {
      Some(q) if c == q => quote = None,
      Some(_) => cur.push(c),
      None if c == '\'' || c == '"' => {
        quote = Some(c);
        in_word = true;
      }
      None if c.is_whitespace() => {
        if in_word {
          words.push(std::mem::take(&mut cur));
          in_word = false;
        }
      }
      None => {
        cur.push(c);
        in_word = true;
      }
    }
  }
  if quote.is_some() {
    return None;
  }
  if in_word {
    words.push(cur);
  }
  Some(words)
}

/// The user's ACP agents out of the setting's value; bad entries (and ids of Kingu's own runtimes) are skipped.
pub fn custom_agents(value: Option<&serde_json::Value>) -> Vec<Custom> {
  let Some(map) = value.and_then(|v| v.as_object()) else { return Vec::new() };
  let mut out = Vec::new();
  for (id, v) in map.iter().take(MAX_CUSTOM) {
    let taken = id == CLAUDE || KNOWN.iter().any(|k| k.id == id);
    let Some(line) = v.as_str().filter(|l| l.len() <= MAX_COMMAND && !l.contains('\0')) else { continue };
    match split_command(line) {
      Some(argv) if valid_id(id) && !taken && !argv.is_empty() => out.push(Custom { id: id.clone(), argv }),
      _ => log::warn!("{SETTING}: {id}: skipped (needs a lowercase id and a command)"),
    }
  }
  out
}

/// `program` as an executable: an absolute path as is, a bare name in a folder of `path`.
fn locate(program: &str, path: Option<&OsStr>) -> Option<PathBuf> {
  let p = Path::new(program);
  if p.is_absolute() {
    return super::cli::is_executable(p).then(|| p.to_path_buf());
  }
  if program.contains('/') || program.is_empty() {
    return None;
  }
  std::env::split_paths(path?).map(|d| d.join(program)).find(|f| super::cli::is_executable(f))
}

/// The runtimes that can run here: the Claude SDK first (always), then each known agent and
/// configured ACP agent whose program is on `path`.
pub fn available(path: Option<&OsStr>, custom: &[Custom]) -> Vec<RuntimeInfo> {
  let mut out = vec![RuntimeInfo { id: CLAUDE.into(), name: "Claude Code".into(), protocol: Protocol::Claude, features: features(Protocol::Claude), custom: false }];
  for k in KNOWN.iter().filter(|k| locate(k.program, path).is_some()) {
    out.push(RuntimeInfo { id: k.id.into(), name: k.name.into(), protocol: k.protocol, features: features(k.protocol), custom: false });
  }
  for c in custom.iter().filter(|c| locate(&c.argv[0], path).is_some()) {
    out.push(RuntimeInfo { id: c.id.clone(), name: c.id.clone(), protocol: Protocol::Acp, features: features(Protocol::Acp), custom: true });
  }
  out
}

/// What the agent host runs for runtime `id`: None for the Claude SDK, else the program found on `path`.
pub fn resolve(id: &str, path: Option<&OsStr>, custom: &[Custom]) -> Result<Option<Spec>, String> {
  if id == CLAUDE {
    return Ok(None);
  }
  let (name, program, args, kind) = if let Some(k) = KNOWN.iter().find(|k| k.id == id) {
    (k.name.to_owned(), k.program.to_owned(), k.args.iter().map(|a| (*a).to_owned()).collect::<Vec<_>>(), if k.protocol == Protocol::Codex { "codex" } else { "acp" })
  } else if let Some(c) = custom.iter().find(|c| c.id == id) {
    (c.id.clone(), c.argv[0].clone(), c.argv[1..].to_vec(), "acp")
  } else {
    return Err(tr!(RuntimeMsg::Unknown, id));
  };
  let found = locate(&program, path).ok_or_else(|| tr!(RuntimeMsg::NotFound, name, program))?;
  let command = found.to_str().ok_or_else(|| tr!(RuntimeMsg::NotFound, name, program))?.to_owned();
  Ok(Some(Spec { kind, command, args }))
}

/// Whether runtime `id` can rewind (`Features::rewind`); unknown ids cannot.
pub fn can_rewind(id: &str) -> bool {
  id == CLAUDE
}

/// The configured ACP agents (user settings).
pub fn configured(config_dir: &Path) -> Vec<Custom> {
  custom_agents(crate::settings::user_value(config_dir, SETTING).as_ref())
}

/// The chat's runtime picker: the runtimes found on the login-shell PATH.
#[tauri::command]
pub async fn agent_runtimes(app: tauri::AppHandle) -> Result<Vec<RuntimeInfo>, String> {
  use tauri::Manager;
  let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
  tauri::async_runtime::spawn_blocking(move || available(crate::shell_env::path().as_deref(), &configured(&config))).await.map_err(|e| e.to_string())
}

#[cfg(all(test, unix))]
mod tests {
  use super::*;
  use serde_json::json;
  use std::os::unix::fs::PermissionsExt;

  fn exe(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
  }

  #[test]
  fn only_runtimes_on_path_are_offered() {
    let bin = tempfile::tempdir().unwrap();
    exe(bin.path(), "gemini");
    exe(bin.path(), "codex");
    exe(bin.path(), "my-acp");
    std::fs::write(bin.path().join("qwen"), "not executable").unwrap();
    let custom = custom_agents(Some(&json!({"mine": "my-acp --stdio 'two words'", "gone": "missing-agent", "codex": "evil", "Bad Id": "x"})));
    assert_eq!(custom, [Custom { id: "mine".into(), argv: vec!["my-acp".into(), "--stdio".into(), "two words".into()] }, Custom { id: "gone".into(), argv: vec!["missing-agent".into()] }]);
    let path = bin.path().as_os_str();
    let ids: Vec<_> = available(Some(path), &custom).into_iter().map(|r| (r.id, r.protocol, r.features.rewind)).collect();
    assert_eq!(
      ids,
      [("claude".into(), Protocol::Claude, true), ("codex".into(), Protocol::Codex, false), ("gemini".into(), Protocol::Acp, false), ("mine".into(), Protocol::Acp, false)]
    );
    assert_eq!(available(None, &[]).len(), 1, "Claude Code is built in");
  }

  #[test]
  fn resolves_to_the_absolute_program() {
    let bin = tempfile::tempdir().unwrap();
    let gemini = exe(bin.path(), "gemini");
    let codex = exe(bin.path(), "codex");
    let path = Some(bin.path().as_os_str());
    assert_eq!(resolve("claude", path, &[]), Ok(None));
    assert_eq!(resolve("gemini", path, &[]).unwrap(), Some(Spec { kind: "acp", command: gemini.display().to_string(), args: vec!["--experimental-acp".into()] }));
    assert_eq!(resolve("codex", path, &[]).unwrap().unwrap().args, ["app-server"]);
    assert_eq!(resolve("codex", path, &[]).unwrap().unwrap().command, codex.display().to_string());
    assert!(resolve("qwen", path, &[]).unwrap_err().contains("qwen"));
    assert!(resolve("nope", path, &[]).is_err());
    let abs = Custom { id: "abs".into(), argv: vec![gemini.display().to_string(), "acp".into()] };
    assert_eq!(resolve("abs", None, &[abs]).unwrap().unwrap().args, ["acp"]);
    let rel = Custom { id: "rel".into(), argv: vec!["./gemini".into()] };
    assert!(resolve("rel", path, &[rel]).is_err(), "a relative path is not looked up");
  }

  #[test]
  fn command_lines_and_ids() {
    assert_eq!(split_command(r#"a  "b c" d'e f'"#), Some(vec!["a".into(), "b c".into(), "de f".into()]));
    assert_eq!(split_command("''"), Some(vec![String::new()]));
    assert_eq!(split_command("a 'b"), None);
    assert!(valid_id("gemini") && valid_id("my-agent-2"));
    assert!(!valid_id("") && !valid_id("-x") && !valid_id("Gemini") && !valid_id(&"a".repeat(41)));
    assert!(can_rewind("claude") && !can_rewind("gemini"));
  }
}
