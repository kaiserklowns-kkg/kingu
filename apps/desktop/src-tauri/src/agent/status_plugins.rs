//! Status integrations for agent CLIs whose hooks are not a `hooks` object in a JSON config
//! (status_hooks.rs has those): Orca's per-agent installers under `src/main/<agent>/`, ported.
//!
//! - Kiro: a hooks file of Kingu's own, `$KIRO_HOME|~/.kiro/hooks/kingu-agent-status.json`
//!   (Orca kiro/standalone-hooks.ts, the kiro-cli 2.31+ form).
//! - Kimi Code: a marker-wrapped block of `[[hooks]]` tables at the end of
//!   `$KIMI_CODE_HOME|~/.kimi-code/config.toml` (Orca kimi/kimi-hook-config-toml.ts).
//! - Muse: a hooks file of Kingu's own that `~/.config/muse/settings.json` names in
//!   `managed_hooks_path`, with `KINGU_AGENT_HOOK_FILE` allowed through (Orca muse/hook-config-json.ts).
//! - Amp: a plugin, `~/.config/amp/plugins/kingu-agent-status.ts` (Orca amp/agent-status-plugin-source.ts).
//! - Hermes: a plugin folder `$HERMES_HOME|~/.hermes/plugins/kingu-status/`, enabled in its
//!   `config.yaml` (Orca hermes/hook-service.ts, hermes-managed-plugin-source.ts).
//!
//! - ZCode: `hooks.events` (and `hooks.enabled`, off by default) in `~/.zcode/cli/config.json`
//!   (Orca zcode/hook-config-json.ts).
//! - jcode: `[hooks]` keys in `$JCODE_HOME|~/.jcode/config.toml` naming `jcode-hook.sh` alone;
//!   jcode hands the event over in env (`JCODE_HOOK_EVENT`, `JCODE_HOOK_PAYLOAD`; Orca jcode/hook-config.ts).
//! - Pi / OMP: an extension, `$PI_CODING_AGENT_DIR|~/.pi/agent/extensions/kingu-agent-status.ts`
//!   (Pi loads it by itself) and `~/.omp/agent/extensions/…` (OMP gets `--extension <file>` at
//!   launch; Orca main/pi/managed-extensions/agent-status).
//!
//! Same rules as status_hooks.rs: Kingu's entries are found by a marker, the user's are kept,
//! a file that does not parse (or that Kingu did not write, for a file of its own name) is left
//! alone with an error, writes are atomic with a `.kingu.bak` copy, and every hook or plugin does
//! nothing outside a Kingu terminal (no `KINGU_AGENT_HOOK_FILE` naming an `agent-hooks/*.jsonl`).
// Not called by the app yet (only by its own tests): the wiring lands with the supervisor work.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::status_hooks::{EnvDirs, MARKER, hook_command_for, merge_at, sh_quote};
use super::trust;

/// What Kingu writes into the files it owns, so it never takes over a user's file of the same name.
pub const OWN_MARK: &str = "Managed by Kingu (agent status hooks)";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plugin {
  Kiro,
  Kimi,
  Muse,
  Amp,
  Hermes,
  Zcode,
  Jcode,
  Pi,
  Omp,
}

impl Plugin {
  pub const ALL: [Plugin; 9] = [Plugin::Kiro, Plugin::Kimi, Plugin::Muse, Plugin::Amp, Plugin::Hermes, Plugin::Zcode, Plugin::Jcode, Plugin::Pi, Plugin::Omp];

  pub fn of_id(id: &str) -> Option<Self> {
    match id {
      "kiro" => Some(Self::Kiro),
      "kimi" => Some(Self::Kimi),
      "muse" => Some(Self::Muse),
      "amp" => Some(Self::Amp),
      "hermes" => Some(Self::Hermes),
      "zcode" => Some(Self::Zcode),
      "jcode" => Some(Self::Jcode),
      "pi" => Some(Self::Pi),
      "omp" => Some(Self::Omp),
      _ => None,
    }
  }

  pub fn id(self) -> &'static str {
    match self {
      Self::Kiro => "kiro",
      Self::Kimi => "kimi",
      Self::Muse => "muse",
      Self::Amp => "amp",
      Self::Hermes => "hermes",
      Self::Zcode => "zcode",
      Self::Jcode => "jcode",
      Self::Pi => "pi",
      Self::Omp => "omp",
    }
  }

  /// The file (or, for Hermes, the home folder) Kingu writes.
  pub fn path(self, home: &Path, env: EnvDirs) -> PathBuf {
    match self {
      Self::Kiro => env("KIRO_HOME").unwrap_or_else(|| home.join(".kiro")).join("hooks").join(KIRO_FILE),
      Self::Kimi => env("KIMI_CODE_HOME").unwrap_or_else(|| home.join(".kimi-code")).join("config.toml"),
      Self::Muse => env("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config")).join("muse").join("settings.json"),
      Self::Amp => home.join(".config/amp/plugins").join(AMP_FILE),
      Self::Hermes => env("HERMES_HOME").unwrap_or_else(|| home.join(".hermes")),
      Self::Zcode => home.join(".zcode/cli/config.json"),
      Self::Jcode => env("JCODE_HOME").unwrap_or_else(|| home.join(".jcode")).join("config.toml"),
      Self::Pi => env("PI_CODING_AGENT_DIR").unwrap_or_else(|| home.join(".pi/agent")).join("extensions").join(PI_FILE),
      Self::Omp => home.join(".omp/agent/extensions").join(PI_FILE),
    }
  }
}

/// Installs (`on`) or removes Kingu's status integration for `p` at `path` (from [`Plugin::path`]).
/// `script` is agent-hook.sh; `data` is Kingu's agent-status folder (Muse's hooks file goes there).
/// Ok(false): nothing changed.
pub fn apply(p: Plugin, path: &Path, script: &Path, data: &Path, on: bool) -> Result<bool, String> {
  match p {
    Plugin::Kiro => own_json(path, on.then(|| kiro_file(script)), is_kiro_ours),
    Plugin::Kimi => kimi(path, script, on),
    Plugin::Muse => muse(path, &data.join(MUSE_HOOKS_FILE), script, on),
    Plugin::Amp => own_text(path, on.then_some(AMP_PLUGIN_SOURCE), AMP_MARK),
    Plugin::Hermes => hermes(path, on),
    Plugin::Zcode => zcode(path, script, on),
    Plugin::Jcode => jcode(path, &script.with_file_name(JCODE_SCRIPT_FILE), on),
    Plugin::Pi => own_text(path, on.then(|| pi_extension("pi")).as_deref(), OWN_MARK),
    Plugin::Omp => own_text(path, on.then(|| pi_extension("omp")).as_deref(), OWN_MARK),
  }
}

// ---- files of Kingu's own ----------------------------------------------------------------------

fn read_opt(file: &Path) -> Result<Option<String>, String> {
  match fs::read_to_string(file) {
    Ok(t) => Ok(Some(t)),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!("{}: {e}", file.display())),
  }
}

fn not_ours(file: &Path) -> String {
  format!("{} exists and was not written by Kingu; left alone", file.display())
}

/// A text file Kingu owns, recognised by `mark`: written when `content` is Some, else removed.
/// A file of that name without the mark is never touched.
fn own_text(file: &Path, content: Option<&str>, mark: &str) -> Result<bool, String> {
  let target = trust::write_target(file)?;
  let cur = read_opt(&target)?;
  if cur.as_deref().is_some_and(|c| !c.contains(mark)) {
    return Err(not_ours(file));
  }
  match content {
    Some(c) if cur.as_deref() == Some(c) => Ok(false),
    Some(c) => trust::replace_file(&target, c.as_bytes(), Some(0o644)).map(|()| true),
    None if cur.is_some() => fs::remove_file(&target).map(|()| true).map_err(|e| e.to_string()),
    None => Ok(false),
  }
}

/// A JSON file Kingu owns (`ours` says whether a found one is), written or removed.
fn own_json(file: &Path, content: Option<Value>, ours: fn(&Value) -> bool) -> Result<bool, String> {
  let target = trust::write_target(file)?;
  let cur = read_opt(&target)?;
  if let Some(c) = &cur {
    let ok = serde_json::from_str::<Value>(c).ok().is_some_and(|v| ours(&v));
    if !ok {
      return Err(not_ours(file));
    }
  }
  match content {
    Some(v) => {
      let text = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())? + "\n";
      if cur.as_deref() == Some(text.as_str()) {
        return Ok(false);
      }
      trust::replace_file(&target, text.as_bytes(), Some(0o644)).map(|()| true)
    }
    None if cur.is_some() => fs::remove_file(&target).map(|()| true).map_err(|e| e.to_string()),
    None => Ok(false),
  }
}

// ---- Kiro --------------------------------------------------------------------------------------

const KIRO_FILE: &str = "kingu-agent-status.json";
/// kiro-cli's standalone hook triggers (Orca kiro/standalone-hook-settings.ts; 2.27+ spellings).
pub const KIRO_EVENTS: [&str; 6] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"];

/// `{"version":"v1","hooks":[…]}`, one list entry per trigger; tool triggers match every tool.
/// Kiro adds a hook's stdout to the model's context, so the hooks print nothing.
pub fn kiro_file(script: &Path) -> Value {
  let hooks: Vec<Value> = KIRO_EVENTS
    .iter()
    .map(|t| {
      let mut h = json!({
        "name": format!("kingu-agent-status-{t}"),
        "trigger": t,
        "action": { "type": "command", "command": hook_command_for(script, "kiro", t, None) },
        "timeout": 10
      });
      if matches!(*t, "PreToolUse" | "PostToolUse") {
        h["matcher"] = json!("*");
      }
      h
    })
    .collect();
  json!({ "version": "v1", "hooks": hooks })
}

/// Only `version` and `hooks`, every hook Kingu's (Orca's "wholly managed" rule).
fn is_kiro_ours(v: &Value) -> bool {
  let Some(o) = v.as_object() else { return false };
  o.keys().all(|k| k == "version" || k == "hooks")
    && o.get("hooks").and_then(Value::as_array).is_some_and(|hs| {
      hs.iter().all(|h| h.pointer("/action/command").and_then(Value::as_str).is_some_and(|c| c.contains(MARKER)))
    })
}

// ---- Kimi Code ---------------------------------------------------------------------------------

const KIMI_START: &str = "# >>> kingu-managed-kimi-hooks (managed by Kingu; do not edit) >>>";
const KIMI_END: &str = "# <<< kingu-managed-kimi-hooks <<<";
/// Orca kimi/hook-service.ts. Kimi waits on SessionStart while a new session's first prompt runs,
/// so it only fires for a resume (its matchers are regexes).
pub const KIMI_EVENTS: [&str; 8] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Stop", "StopFailure"];

fn kimi_block(script: &Path, eol: &str) -> String {
  let mut out = vec![KIMI_START.to_owned()];
  for e in KIMI_EVENTS {
    out.push("[[hooks]]".into());
    out.push(format!("event = {}", json!(e)));
    if e == "SessionStart" {
      out.push(r#"matcher = "^resume$""#.into());
    }
    // A JSON string is a TOML basic string (same escapes).
    out.push(format!("command = {}", json!(hook_command_for(script, "kimi", e, None))));
    out.push("timeout = 10".into());
  }
  out.push(KIMI_END.into());
  out.join(eol) + eol
}

/// `text` without Kingu's block (the start marker up to and including the end marker; an orphan
/// start marker owns nothing). Trailing blank lines before it go too.
pub fn kimi_strip(text: &str) -> String {
  let Some(start) = text.find(KIMI_START) else { return text.to_owned() };
  let Some(end_rel) = text[start..].find(KIMI_END) else { return text.to_owned() };
  let mut end = start + end_rel + KIMI_END.len();
  if text[end..].starts_with("\r\n") {
    end += 2;
  } else if text[end..].starts_with('\n') {
    end += 1;
  }
  let head = text[..start].trim_end_matches(['\n', '\r', ' ', '\t']);
  let tail = &text[end..];
  let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
  match (head.is_empty(), tail.trim().is_empty()) {
    (true, true) => String::new(),
    (true, false) => tail.to_owned(),
    (false, true) => format!("{head}{eol}"),
    (false, false) => format!("{head}{eol}{eol}{tail}"),
  }
}

/// Kimi's config with (or without) Kingu's block, appended after the user's tables.
pub fn kimi_edit(text: &str, script: &Path, on: bool) -> String {
  let base = kimi_strip(text);
  if !on {
    return base;
  }
  let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
  let sep = if base.trim().is_empty() { String::new() } else { format!("{}{eol}{eol}", base.trim_end_matches(['\n', '\r'])) };
  format!("{sep}{}", kimi_block(script, eol))
}

fn kimi(file: &Path, script: &Path, on: bool) -> Result<bool, String> {
  let target = trust::write_target(file)?;
  let Some(text) = read_opt(&target)? else {
    if !on {
      return Ok(false);
    }
    let next = kimi_edit("", script, true);
    return trust::replace_file(&target, next.as_bytes(), Some(0o600)).map(|()| true);
  };
  let parse = |t: &str| toml::from_str::<toml::Table>(t.trim_start_matches('\u{feff}'));
  if parse(&text).is_err() {
    return Err(format!("{} is not valid TOML; left alone", file.display()));
  }
  let next = kimi_edit(&text, script, on);
  if next == text {
    return Ok(false);
  }
  // E.g. a `hooks = [...]` of the user's own makes `[[hooks]]` invalid: leave the file as it is.
  parse(&next).map_err(|e| format!("{}: Kingu's hooks would not fit ({e}); left alone", file.display()))?;
  trust::replace_file(&target, next.as_bytes(), Some(0o600)).map(|()| true)
}

// ---- Muse --------------------------------------------------------------------------------------

pub const MUSE_HOOKS_FILE: &str = "muse-hooks.json";
/// Orca muse/hook-settings.ts ("Muse 1.3 uses Claude-shaped events").
pub const MUSE_EVENTS: [&str; 13] = [
  "SessionStart",
  "SubagentStart",
  "SubagentStop",
  "SessionEnd",
  "Notification",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Stop",
  "StopFailure",
  "Interrupt",
];

/// Muse's managed hooks file: no matcher; Muse refuses a synchronous Interrupt hook.
pub fn muse_hooks(script: &Path) -> Value {
  let mut hooks = Map::new();
  for e in MUSE_EVENTS {
    let mut h = json!({ "type": "command", "command": hook_command_for(script, "muse", e, None), "timeout": 10 });
    if e == "Interrupt" {
      h["async"] = json!(true);
    }
    hooks.insert(e.into(), json!([{ "hooks": [h] }]));
  }
  json!({ "_kingu": OWN_MARK, "hooks": hooks })
}

fn muse(settings: &Path, hooks_file: &Path, script: &Path, on: bool) -> Result<bool, String> {
  let ours = hooks_file.to_string_lossy().into_owned();
  let target = trust::write_target(settings)?;
  let mut config = match trust::read_json_object(&target) {
    Ok(Some(c)) => c,
    Ok(None) if !on => Map::new(),
    Ok(None) => Map::new(),
    // JSONC with comments, or not JSON: left alone (Orca edits JSONC in place; Kingu does not).
    Err(_) => return Err(format!("{} is not plain JSON; left alone", settings.display())),
  };
  let before = config.clone();
  let current = config.get("managed_hooks_path").and_then(Value::as_str).map(str::to_owned);
  let mut changed = false;
  if on {
    // Another tool's managed hooks file: Muse takes one, so Kingu stays out (as Orca does).
    if current.as_deref().is_some_and(|c| c != ours) {
      return Err(format!("{} already names another managed hooks file; left alone", settings.display()));
    }
    let text = serde_json::to_string_pretty(&muse_hooks(script)).map_err(|e| e.to_string())? + "\n";
    if read_opt(hooks_file)?.as_deref() != Some(text.as_str()) {
      trust::replace_file(hooks_file, text.as_bytes(), Some(0o644))?;
      changed = true;
    }
    // Muse rejects new settings without a schema version.
    config.entry("schema_version").or_insert(json!(1));
    config.insert("managed_hooks_path".into(), json!(ours));
    // Muse drops env vars that are not allowed through.
    let vars = config.entry("managed_hooks_env_vars").or_insert_with(|| json!([]));
    if let Some(a) = vars.as_array_mut() {
      if !a.iter().any(|v| v == "KINGU_AGENT_HOOK_FILE") {
        a.push(json!("KINGU_AGENT_HOOK_FILE"));
      }
    } else {
      return Err(format!("{}: managed_hooks_env_vars is not a list; left alone", settings.display()));
    }
  } else {
    if current.as_deref() == Some(ours.as_str()) {
      config.remove("managed_hooks_path");
    }
    if hooks_file.exists() {
      fs::remove_file(hooks_file).map_err(|e| e.to_string())?;
      changed = true;
    }
  }
  if config != before {
    let text = serde_json::to_string_pretty(&Value::Object(config)).map_err(|e| e.to_string())? + "\n";
    trust::replace_file(&target, text.as_bytes(), Some(0o600))?;
    changed = true;
  }
  Ok(changed)
}

// ---- Amp ---------------------------------------------------------------------------------------

const AMP_FILE: &str = "kingu-agent-status.ts";
const AMP_MARK: &str = "Managed by Kingu (agent status hooks)";

/// Orca's Amp plugin, writing Kingu's tagged lines instead of posting to a server. `tool.call`
/// answers `allow` as Orca's does (the plugin's own decision; Amp's permission settings still apply).
pub const AMP_PLUGIN_SOURCE: &str = r#"// Managed by Kingu (agent status hooks); Kingu rewrites this file, edits are lost.
// Reports the Amp thread's state to the Kingu terminal it runs in (KINGU_AGENT_HOOK_FILE).
import { appendFileSync } from 'fs'
import type { PluginAPI } from '@ampcode/plugin'

function preview(value: unknown, max = 4000): string | undefined {
  if (typeof value === 'string') return value.slice(0, max)
  if (value === null || value === undefined) return undefined
  try {
    return JSON.stringify(value).slice(0, max)
  } catch {
    return String(value).slice(0, max)
  }
}

function safe(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value !== 'object') return String(value)
  if (depth >= 4) return preview(value)
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => safe(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value).slice(0, 20)) out[k] = safe(v, depth + 1)
  return out
}

function post(event: string, payload: Record<string, unknown>): void {
  const file = process.env.KINGU_AGENT_HOOK_FILE
  if (!file || !/\/agent-hooks\/[^/]+\.jsonl$/.test(file)) return
  try {
    appendFileSync(file, JSON.stringify({ kingu_hook: 'amp', event, payload: { hook_event_name: event, ...payload } }) + '\n')
  } catch {
    // Status reporting never affects the Amp run.
  }
}

export default function (amp: PluginAPI) {
  amp.on('session.start', (event) => {
    post('session.start', { threadId: event.thread.id })
  })
  amp.on('agent.start', (event) => {
    post('agent.start', { threadId: event.thread.id, id: event.id, message: event.message })
  })
  amp.on('tool.call', (event) => {
    post('tool.call', { threadId: event.thread.id, toolUseId: event.toolUseID, tool: event.tool, input: safe(event.input) })
    return { action: 'allow' }
  })
  amp.on('tool.result', (event) => {
    post('tool.result', {
      threadId: event.thread.id,
      toolUseId: event.toolUseID,
      tool: event.tool,
      input: safe(event.input),
      status: event.status,
      error: event.error,
      output: preview(event.output)
    })
  })
  amp.on('agent.end', (event) => {
    post('agent.end', { threadId: event.thread.id, id: event.id, message: event.message, status: event.status })
  })
}
"#;

// ---- Hermes ------------------------------------------------------------------------------------

pub const HERMES_PLUGIN: &str = "kingu-status";
/// The plugin hooks Orca registers (hermes-managed-plugin-source.ts).
pub const HERMES_EVENTS: [&str; 10] = [
  "on_session_start",
  "pre_llm_call",
  "post_llm_call",
  "pre_tool_call",
  "post_tool_call",
  "pre_approval_request",
  "post_approval_response",
  "on_session_end",
  "on_session_finalize",
  "on_session_reset",
];

pub fn hermes_plugin_yaml() -> String {
  let mut s = format!(
    "# {OWN_MARK}; Kingu rewrites this file, edits are lost.\nname: {HERMES_PLUGIN}\nversion: 1.0.0\ndescription: \"Reports Hermes Agent lifecycle events to Kingu.\"\nauthor: \"Kingu\"\nkind: standalone\nprovides_hooks:\n"
  );
  for e in HERMES_EVENTS {
    s.push_str(&format!("  - {e}\n"));
  }
  s
}

pub const HERMES_PLUGIN_PY: &str = r#"# Managed by Kingu (agent status hooks); Kingu rewrites this file, edits are lost.
# Reports Hermes' lifecycle to the Kingu terminal it runs in (KINGU_AGENT_HOOK_FILE).
import json
import os
import re

SELECTED_KEYS = {
    "on_session_start": ("session_id", "model", "platform"),
    "pre_llm_call": ("session_id", "user_message", "is_first_turn", "model", "platform", "sender_id"),
    "post_llm_call": ("session_id", "user_message", "assistant_response", "model", "platform"),
    "pre_tool_call": ("session_id", "task_id", "tool_call_id", "tool_name", "args"),
    "post_tool_call": ("session_id", "task_id", "tool_call_id", "tool_name", "args", "result", "duration_ms"),
    "pre_approval_request": ("command", "description", "pattern_key", "pattern_keys", "session_key", "surface"),
    "post_approval_response": ("command", "description", "pattern_key", "pattern_keys", "session_key", "surface", "choice"),
    "on_session_end": ("session_id",),
    "on_session_finalize": ("session_id", "platform"),
    "on_session_reset": ("session_id", "platform"),
}


def _env():
    try:
        from agent.session_client_env import bound_client_env
        env = bound_client_env()
        if env:
            return env
    except Exception:
        pass
    return os.environ


def _safe(value, depth=0):
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value if len(value) <= 8192 else value[:8192] + "...[truncated]"
    if depth >= 5:
        return _safe(repr(value), depth)
    if isinstance(value, dict):
        return {str(k): _safe(v, depth + 1) for k, v in list(value.items())[:50]}
    if isinstance(value, (list, tuple)):
        return [_safe(v, depth + 1) for v in list(value)[:50]]
    return _safe(str(value), depth)


def _post(event, kwargs):
    path = _env().get("KINGU_AGENT_HOOK_FILE") or ""
    if not re.search(r"/agent-hooks/[^/]+\.jsonl$", path):
        return
    payload = {"hook_event_name": event, "cwd": os.getcwd()}
    for key in SELECTED_KEYS.get(event, ()):
        if key in kwargs:
            payload[key] = _safe(kwargs[key])
    if "user_message" in payload:
        payload["prompt"] = payload["user_message"]
    if "assistant_response" in payload:
        payload["last_assistant_message"] = payload["assistant_response"]
    if "args" in payload:
        payload["tool_input"] = payload["args"]
    if event in ("pre_approval_request", "post_approval_response"):
        payload["tool_name"] = "approval"
        payload["tool_input"] = {"command": payload.get("command"), "description": payload.get("description")}
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"kingu_hook": "hermes", "event": event, "payload": payload}) + "\n")
    except Exception:
        pass


def _hook(event):
    def fn(*_args, **kwargs):
        _post(event, kwargs)
        return None
    return fn


def register(ctx):
    for event in SELECTED_KEYS:
        ctx.register_hook(event, _hook(event))
"#;

/// The top-level `key:` line of a block mapping, and the indent of its children; None when the
/// key is not there. Err when it is there in a form Kingu does not edit (flow style, a scalar).
fn yaml_block(lines: &[&str], key: &str, from: usize, indent: usize) -> Result<Option<(usize, usize, usize)>, ()> {
  // (line of `key:`, end line (exclusive) of its block, child indent)
  let mut i = from;
  while i < lines.len() {
    let l = lines[i];
    let ind = l.len() - l.trim_start().len();
    let t = l.trim();
    if !t.is_empty() && !t.starts_with('#') && ind < indent {
      return Ok(None);
    }
    if ind == indent && (t == format!("{key}:") || t.starts_with(&format!("{key}: #")) || t.starts_with(&format!("{key}:"))) {
      let rest = t[key.len() + 1..].trim();
      if !(rest.is_empty() || rest.starts_with('#')) {
        return Err(());
      }
      let mut end = i + 1;
      let mut child = None;
      while end < lines.len() {
        let l2 = lines[end];
        let t2 = l2.trim();
        let ind2 = l2.len() - l2.trim_start().len();
        if !t2.is_empty() && !t2.starts_with('#') {
          if ind2 <= indent && !(ind2 == indent && t2.starts_with("- ") && child.is_none()) {
            break;
          }
          child.get_or_insert(ind2);
        }
        end += 1;
      }
      return Ok(Some((i, end, child.unwrap_or(indent + 2))));
    }
    i += 1;
  }
  Ok(None)
}

/// `text` with `item` added to (`on`) or taken out of the block list at `parent.key`, editing
/// only those lines (comments and everything else stay). None: a shape Kingu does not edit.
pub fn yaml_list_edit(text: &str, parent: &str, key: &str, item: &str, on: bool) -> Option<String> {
  let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
  let mut lines: Vec<&str> = text.lines().collect();
  let owned: Vec<String>;
  let entry = |ind: usize| format!("{}- {item}", " ".repeat(ind));
  let Some((p_line, p_end, cind)) = yaml_block(&lines, parent, 0, 0).ok()? else {
    if !on {
      return Some(text.to_owned());
    }
    let mut out = text.trim_end_matches(['\n', '\r']).to_owned();
    if !out.is_empty() {
      out.push_str(eol);
    }
    out.push_str(&format!("{parent}:{eol}  {key}:{eol}    - {item}{eol}"));
    return Some(out);
  };
  let is_item = |l: &str| {
    let t = l.trim();
    t == format!("- {item}") || t == format!("- \"{item}\"") || t == format!("- '{item}'")
  };
  // `key: []` (Orca's own default) becomes a block list.
  let inline_empty = (p_line + 1..p_end).find(|&j| {
    let t = lines[j].trim();
    lines[j].len() - lines[j].trim_start().len() == cind && (t == format!("{key}: []") || t == format!("{key}: [ ]"))
  });
  if let Some(j) = inline_empty {
    if !on {
      return Some(text.to_owned());
    }
    owned = lines.iter().enumerate().flat_map(|(k, l)| if k == j { vec![format!("{}{key}:", " ".repeat(cind)), entry(cind + 2)] } else { vec![(*l).to_owned()] }).collect();
    return Some(owned.join(eol) + eol);
  }
  match yaml_block(&lines[..p_end], key, p_line + 1, cind).ok()? {
    None => {
      if !on {
        return Some(text.to_owned());
      }
      owned = lines.iter().enumerate().flat_map(|(k, l)| if k == p_line { vec![(*l).to_owned(), format!("{}{key}:", " ".repeat(cind)), entry(cind + 2)] } else { vec![(*l).to_owned()] }).collect();
      Some(owned.join(eol) + eol)
    }
    Some((k_line, k_end, iind)) => {
      // Only a list of `- scalar` items.
      let body: Vec<usize> = (k_line + 1..k_end).filter(|&j| !lines[j].trim().is_empty() && !lines[j].trim_start().starts_with('#')).collect();
      if body.iter().any(|&j| !lines[j].trim_start().starts_with("- ")) {
        return None;
      }
      let has = body.iter().any(|&j| is_item(lines[j]));
      if on {
        if has {
          return Some(text.to_owned());
        }
        let at = body.last().map_or(k_line + 1, |j| j + 1);
        let ind = if body.is_empty() { cind + 2 } else { iind };
        lines.insert(at, "");
        owned = lines.iter().enumerate().map(|(k, l)| if k == at { entry(ind) } else { (*l).to_owned() }).collect();
        Some(owned.join(eol) + eol)
      } else {
        if !has {
          return Some(text.to_owned());
        }
        let left = body.iter().filter(|&&j| !is_item(lines[j])).count();
        owned = lines
          .iter()
          .enumerate()
          .filter(|(k, l)| !(body.contains(k) && is_item(l)))
          .map(|(k, l)| if k == k_line && left == 0 { format!("{}{key}: []", " ".repeat(cind)) } else { (*l).to_owned() })
          .collect();
        Some(owned.join(eol) + eol)
      }
    }
  }
}

fn yaml_has(text: &str, parent: &str, key: &str, item: &str) -> Option<bool> {
  let docs = yaml_rust2::YamlLoader::load_from_str(text).ok()?;
  let Some(doc) = docs.into_iter().next() else { return Some(false) };
  let list = &doc[parent][key];
  Some(list.as_vec().is_some_and(|v| v.iter().any(|y| y.as_str() == Some(item))))
}

fn hermes(home: &Path, on: bool) -> Result<bool, String> {
  let dir = home.join("plugins").join(HERMES_PLUGIN);
  let config = home.join("config.yaml");
  let mut changed = false;
  if on {
    changed |= own_text(&dir.join("plugin.yaml"), Some(&hermes_plugin_yaml()), OWN_MARK)?;
    changed |= own_text(&dir.join("__init__.py"), Some(HERMES_PLUGIN_PY), OWN_MARK)?;
  }
  let target = trust::write_target(&config)?;
  let text = read_opt(&target)?.unwrap_or_default();
  if !text.is_empty() && yaml_rust2::YamlLoader::load_from_str(&text).is_err() {
    return Err(format!("{} is not valid YAML; left alone", config.display()));
  }
  let mut next = text.clone();
  // The plugin is enabled; a gateway-hosted session passes the hook file through to it.
  for (parent, key, item) in [("plugins", "enabled", HERMES_PLUGIN), ("terminal", "client_env_passthrough", "KINGU_AGENT_HOOK_FILE")] {
    if !on && text.is_empty() {
      break;
    }
    let edited = yaml_list_edit(&next, parent, key, item, on).ok_or_else(|| format!("{}: {parent}.{key} has a form Kingu does not edit; left alone", config.display()))?;
    if yaml_has(&edited, parent, key, item) != Some(on) {
      return Err(format!("{}: could not edit {parent}.{key}; left alone", config.display()));
    }
    next = edited;
  }
  if next != text {
    trust::replace_file(&target, next.as_bytes(), Some(0o600))?;
    changed = true;
  }
  if !on {
    for f in ["plugin.yaml", "__init__.py"] {
      changed |= own_text(&dir.join(f), None, OWN_MARK)?;
    }
    let _ = fs::remove_dir(&dir);
  }
  Ok(changed)
}

// ---- ZCode -------------------------------------------------------------------------------------

/// Orca zcode/hook-settings.ts; no matcher (`*` is not ZCode syntax).
pub const ZCODE_EVENTS: [&str; 7] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Stop"];

fn zcode(file: &Path, script: &Path, on: bool) -> Result<bool, String> {
  let target = trust::write_target(file)?;
  let mut config = match trust::read_json_object(&target) {
    Ok(Some(c)) => c,
    Ok(None) if !on => return Ok(false),
    Ok(None) => Map::new(),
    Err(_) => return Err(format!("{} is not plain JSON; left alone", file.display())),
  };
  let before = config.clone();
  let hooks = config.entry("hooks").or_insert_with(|| json!({}));
  let hooks = hooks.as_object_mut().ok_or_else(|| format!("{}: hooks is not an object; left alone", file.display()))?;
  let defs = if on {
    ZCODE_EVENTS.iter().map(|e| (e.to_string(), json!({ "hooks": [{ "type": "command", "command": hook_command_for(script, "zcode", e, None), "timeout": 10 }] }))).collect()
  } else {
    Vec::new()
  };
  merge_at(hooks, "events", defs)?;
  if on {
    // ZCode's hooks are off until this is set; removing Kingu's entries leaves it as it is (Orca).
    hooks.insert("enabled".into(), json!(true));
  }
  if config == before {
    return Ok(false);
  }
  let text = serde_json::to_string_pretty(&Value::Object(config)).map_err(|e| e.to_string())? + "\n";
  trust::replace_file(&target, text.as_bytes(), Some(0o600)).map(|()| true)
}

// ---- jcode -------------------------------------------------------------------------------------

pub const JCODE_SCRIPT_FILE: &str = "jcode-hook.sh";
const JCODE_MARKER: &str = "agent-status/jcode-hook.sh";
const JCODE_TABLE_MARK: &str = "# Managed by Kingu (agent status hooks): the keys naming jcode-hook.sh";
/// Orca jcode/hook-settings.ts (jcode 0.99).
pub const JCODE_EVENTS: [&str; 6] = ["session_start", "turn_start", "pre_tool", "post_tool", "turn_end", "session_end"];

/// jcode runs the hook without a shell and hands the event over in env; stdin carries the gate
/// input on pre_tool only, which must be drained (jcode blocks writing it otherwise). Prints
/// nothing: a gate's output is its answer.
pub const JCODE_SCRIPT: &str = r#"#!/bin/sh
# Managed by Kingu (agent status hooks); Kingu rewrites this file, edits are lost.
[ "${JCODE_HOOK_EVENT-}" = pre_tool ] && cat >/dev/null 2>&1
f="${KINGU_AGENT_HOOK_FILE-}"
case "$f" in
  */agent-hooks/*.jsonl) ;;
  *) exit 0 ;;
esac
p="${JCODE_HOOK_PAYLOAD-}"
[ -n "$p" ] || p='{}'
e=$(printf '%s' "${JCODE_HOOK_EVENT-}" | tr -cd 'a-z_')
one=$(printf '%s' "$p" | tr '
' '  ')
printf '{"kingu_hook":"jcode","event":"%s","payload":%s}
' "$e" "$one" >> "$f" 2>/dev/null
exit 0
"#;

/// The TOML string of the hook: the quoted script path (jcode splits the command into argv).
fn jcode_value(script: &Path) -> String {
  json!(sh_quote(&script.to_string_lossy())).to_string()
}

/// `config.toml` with Kingu's `[hooks]` keys (or without them). A key the user set is left as it
/// is. None: a shape Kingu does not edit.
pub fn jcode_edit(text: &str, script: &Path, on: bool) -> Option<String> {
  let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
  let mut lines: Vec<String> = text.lines().map(str::to_owned).collect();
  let header = |l: &str| l.trim_start().starts_with('[');
  let start = lines.iter().position(|l| l.trim() == "[hooks]" || l.trim().starts_with("[hooks] #"));
  let key_of = |l: &str| l.split_once('=').map(|(k, _)| k.trim().to_owned());
  // Kingu's lines out first.
  if let Some(h) = start {
    let end = (h + 1..lines.len()).find(|&j| header(&lines[j])).unwrap_or(lines.len());
    let keep: Vec<String> = lines[h + 1..end].iter().filter(|l| !(l.contains(JCODE_MARKER) && key_of(l).is_some_and(|k| JCODE_EVENTS.contains(&k.as_str())))).cloned().collect();
    lines.splice(h + 1..end, keep);
  }
  let mut start = lines.iter().position(|l| l.trim() == "[hooks]" || l.trim().starts_with("[hooks] #"));
  if !on {
    // A `[hooks]` table Kingu added, now empty, goes too.
    if let Some(h) = start {
      let end = (h + 1..lines.len()).find(|&j| header(&lines[j])).unwrap_or(lines.len());
      if lines[h + 1..end].iter().all(|l| l.trim().is_empty() || l.trim() == JCODE_TABLE_MARK) && lines[h + 1..end].iter().any(|l| l.trim() == JCODE_TABLE_MARK) {
        lines.drain(h..end);
        while lines.last().is_some_and(|l| l.trim().is_empty()) {
          lines.pop();
        }
      }
    }
    let out = lines.join(eol);
    return Some(if out.is_empty() { out } else { out + eol });
  }
  let h = match start {
    Some(h) => h,
    None => {
      while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
      }
      if !lines.is_empty() {
        lines.push(String::new());
      }
      lines.push("[hooks]".into());
      lines.push(JCODE_TABLE_MARK.into());
      start = Some(lines.len() - 2);
      start.unwrap()
    }
  };
  let end = (h + 1..lines.len()).find(|&j| header(&lines[j])).unwrap_or(lines.len());
  let taken: Vec<String> = lines[h + 1..end].iter().filter_map(|l| key_of(l)).collect();
  let mut at = h + 1;
  if lines.get(at).is_some_and(|l| l.trim() == JCODE_TABLE_MARK) {
    at += 1;
  }
  let add: Vec<String> = JCODE_EVENTS.iter().filter(|e| !taken.iter().any(|k| k == *e)).map(|e| format!("{e} = {}", jcode_value(script))).collect();
  lines.splice(at..at, add);
  Some(lines.join(eol) + eol)
}

fn jcode(file: &Path, script: &Path, on: bool) -> Result<bool, String> {
  let target = trust::write_target(file)?;
  let text = match read_opt(&target)? {
    Some(t) => t,
    None if !on => return Ok(false),
    None => String::new(),
  };
  let parse = |t: &str| toml::from_str::<toml::Table>(t.trim_start_matches('\u{feff}'));
  if parse(&text).is_err() {
    return Err(format!("{} is not valid TOML; left alone", file.display()));
  }
  let next = jcode_edit(&text, script, on).ok_or_else(|| format!("{}: [hooks] has a form Kingu does not edit; left alone", file.display()))?;
  if next == text {
    return Ok(false);
  }
  parse(&next).map_err(|e| format!("{}: Kingu's hooks would not fit ({e}); left alone", file.display()))?;
  trust::replace_file(&target, next.as_bytes(), Some(0o600)).map(|()| true)
}

// ---- Pi / OMP ----------------------------------------------------------------------------------

const PI_FILE: &str = "kingu-agent-status.ts";

/// Orca's Pi-family status extension, cut to the events its listener maps (pi-family-events.ts),
/// writing Kingu's tagged lines. One reporter per process tree (a nested pi stays quiet); OMP
/// subagents never report.
pub fn pi_extension(tag: &str) -> String {
  PI_EXTENSION_SOURCE.replace("__TAG__", tag)
}

const PI_EXTENSION_SOURCE: &str = r#"// Managed by Kingu (agent status hooks); Kingu rewrites this file, edits are lost.
// Reports the session's state to the Kingu terminal it runs in (KINGU_AGENT_HOOK_FILE).
import { appendFileSync } from 'node:fs'

const OWNER = 'KINGU_PI_STATUS_OWNED'

function ownerAlive(): boolean {
  const pid = Number(process.env[OWNER])
  if (!pid || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as { code?: string })?.code === 'EPERM'
  }
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return value.length > 4000 ? value.slice(0, 4000) : value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value !== 'object' || depth >= 4) return String(value).slice(0, 4000)
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value).slice(0, 30)) out[k] = sanitize(v, depth + 1)
  return out
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((p) => (p && (p as { type?: unknown }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : '')).filter(Boolean).join('
')
}

export default function (pi: { on: (name: string, fn: (event: any, ctx: any) => void) => void }) {
  const file = process.env.KINGU_AGENT_HOOK_FILE
  if (!file || !/\/agent-hooks\/[^/]+\.jsonl$/.test(file) || ownerAlive()) return
  process.env[OWNER] = String(process.pid)
  let session: Record<string, unknown> = {}
  const meta = (ctx: any) => {
    if (ctx?.agentKind === 'sub') return false
    const sm = ctx?.sessionManager
    const id = sm?.getSessionId?.()
    const f = sm?.getSessionFile?.()
    if (typeof id === 'string' && id) session = { session_id: id, ...(typeof f === 'string' && f ? { session_file: f } : {}) }
    return true
  }
  const post = (event: string, extra: Record<string, unknown> = {}) => {
    try {
      appendFileSync(file, JSON.stringify({ kingu_hook: '__TAG__', event, payload: { hook_event_name: event, ...session, ...extra } }) + '
')
    } catch {
      // Status reporting never affects the run.
    }
  }
  const on = (name: string, fn: (event: any, ctx: any) => void) => {
    try {
      pi.on(name, (event, ctx) => {
        try {
          if (meta(ctx)) fn(event, ctx)
        } catch {}
      })
    } catch {}
  }
  on('session_start', (e) => {
    if (e?.reason !== 'reload') post('session_start')
  })
  on('before_agent_start', (e) => post('before_agent_start', { prompt: e?.prompt ?? '' }))
  on('agent_start', () => post('agent_start'))
  on('tool_call', (e) => post('tool_call', { tool_name: e?.toolName, tool_input: sanitize(e?.input) }))
  on('tool_execution_end', (e) => post('tool_execution_end', { tool_name: e?.toolName }))
  on('tool_approval_requested', (e) => post('tool_approval_requested', { tool_name: e?.toolName, reason: e?.reason }))
  on('tool_approval_resolved', (e) => post('tool_approval_resolved', { tool_name: e?.toolName, approved: e?.approved }))
  on('message_end', (e) => {
    if (e?.message?.role !== 'assistant') return
    const text = textOf(e.message)
    if (text) post('message_end', { role: 'assistant', text: text.slice(0, 4000) })
  })
  on('agent_end', (e) => {
    if (e?.willContinue === true) return
    const m = Array.isArray(e?.messages) ? e.messages[e.messages.length - 1] : undefined
    const stop = m?.stopReason
    const interrupted = stop === 'aborted' || (stop === 'error' && /abort/i.test(String(m?.errorMessage ?? '')))
    post('agent_end', interrupted ? { interrupted: true } : {})
  })
}
"#;

#[cfg(test)]
mod tests {
  use super::*;

  fn script(dir: &Path) -> PathBuf {
    dir.join("data/agent-status/agent-hook.sh")
  }

  #[test]
  fn kiro_own_file_written_then_removed_and_a_users_file_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let f = Plugin::Kiro.path(dir.path(), &|_| None);
    assert!(f.ends_with(".kiro/hooks/kingu-agent-status.json"));
    let data = dir.path().join("data/agent-status");
    assert!(apply(Plugin::Kiro, &f, &script(dir.path()), &data, true).unwrap());
    let v: Value = serde_json::from_str(&fs::read_to_string(&f).unwrap()).unwrap();
    assert_eq!(v["version"], "v1");
    let hooks = v["hooks"].as_array().unwrap();
    assert_eq!(hooks.iter().map(|h| h["trigger"].as_str().unwrap()).collect::<Vec<_>>(), KIRO_EVENTS);
    assert_eq!(hooks[2]["matcher"], "*");
    assert!(hooks[0].get("matcher").is_none());
    assert!(hooks[4]["action"]["command"].as_str().unwrap().contains("agent-hook.sh' kiro Stop; else cat"));
    assert!(!apply(Plugin::Kiro, &f, &script(dir.path()), &data, true).unwrap(), "idempotent");
    assert!(apply(Plugin::Kiro, &f, &script(dir.path()), &data, false).unwrap());
    assert!(!f.exists());
    fs::write(&f, r#"{"version":"v1","hooks":[{"trigger":"Stop","action":{"type":"command","command":"say hi"}}]}"#).unwrap();
    assert!(apply(Plugin::Kiro, &f, &script(dir.path()), &data, true).is_err());
    assert!(apply(Plugin::Kiro, &f, &script(dir.path()), &data, false).is_err());
    assert!(fs::read_to_string(&f).unwrap().contains("say hi"));
  }

  #[test]
  fn kimi_block_goes_after_the_users_tables_and_comes_out_again() {
    let dir = tempfile::tempdir().unwrap();
    let f = Plugin::Kimi.path(dir.path(), &|_| None);
    assert!(f.ends_with(".kimi-code/config.toml"));
    fs::create_dir_all(f.parent().unwrap()).unwrap();
    let user = "default_model = \"k2\"\n\n[[hooks]]\nevent = \"Stop\"\ncommand = \"say done\"\n";
    fs::write(&f, user).unwrap();
    let data = dir.path().join("data/agent-status");
    assert!(apply(Plugin::Kimi, &f, &script(dir.path()), &data, true).unwrap());
    let text = fs::read_to_string(&f).unwrap();
    assert!(text.starts_with(user));
    let t: toml::Table = toml::from_str(&text).unwrap();
    let hooks = t["hooks"].as_array().unwrap();
    assert_eq!(hooks.len(), 1 + KIMI_EVENTS.len());
    assert_eq!(hooks[1]["matcher"].as_str(), Some("^resume$"));
    assert!(hooks[2]["command"].as_str().unwrap().contains("kimi UserPromptSubmit"));
    assert!(!apply(Plugin::Kimi, &f, &script(dir.path()), &data, true).unwrap(), "idempotent");
    assert!(apply(Plugin::Kimi, &f, &script(dir.path()), &data, false).unwrap());
    assert_eq!(fs::read_to_string(&f).unwrap(), user);
    // An inline `hooks` array of the user's own cannot take `[[hooks]]`: left alone.
    fs::write(&f, "hooks = []\n").unwrap();
    assert!(apply(Plugin::Kimi, &f, &script(dir.path()), &data, true).is_err());
    assert_eq!(fs::read_to_string(&f).unwrap(), "hooks = []\n");
    // An orphan start marker owns nothing.
    assert_eq!(kimi_strip(&format!("a = 1\n{KIMI_START}\nb = 2\n")), format!("a = 1\n{KIMI_START}\nb = 2\n"));
  }

  #[test]
  fn muse_settings_name_kingus_hooks_file() {
    let dir = tempfile::tempdir().unwrap();
    let f = Plugin::Muse.path(dir.path(), &|_| None);
    fs::create_dir_all(f.parent().unwrap()).unwrap();
    fs::write(&f, r#"{"theme":"dark","managed_hooks_env_vars":["MY_VAR"]}"#).unwrap();
    let data = dir.path().join("data/agent-status");
    assert!(apply(Plugin::Muse, &f, &script(dir.path()), &data, true).unwrap());
    let v: Value = serde_json::from_str(&fs::read_to_string(&f).unwrap()).unwrap();
    assert_eq!(v["theme"], "dark");
    assert_eq!(v["schema_version"], 1);
    assert_eq!(v["managed_hooks_env_vars"], json!(["MY_VAR", "KINGU_AGENT_HOOK_FILE"]));
    let hooks_file = data.join(MUSE_HOOKS_FILE);
    assert_eq!(v["managed_hooks_path"], hooks_file.to_string_lossy().as_ref());
    let h: Value = serde_json::from_str(&fs::read_to_string(&hooks_file).unwrap()).unwrap();
    assert_eq!(h["hooks"]["Interrupt"][0]["hooks"][0]["async"], true);
    assert!(h["hooks"]["Stop"][0]["hooks"][0].get("async").is_none());
    assert!(!apply(Plugin::Muse, &f, &script(dir.path()), &data, true).unwrap(), "idempotent");
    assert!(apply(Plugin::Muse, &f, &script(dir.path()), &data, false).unwrap());
    let v: Value = serde_json::from_str(&fs::read_to_string(&f).unwrap()).unwrap();
    assert!(v.get("managed_hooks_path").is_none());
    assert!(!hooks_file.exists());
    // Another tool's managed hooks file: Kingu stays out.
    fs::write(&f, r#"{"managed_hooks_path":"/other/hooks.json"}"#).unwrap();
    assert!(apply(Plugin::Muse, &f, &script(dir.path()), &data, true).is_err());
    assert!(!apply(Plugin::Muse, &f, &script(dir.path()), &data, false).unwrap());
  }

  #[test]
  fn amp_plugin_is_only_kingus_own_file() {
    let dir = tempfile::tempdir().unwrap();
    let f = Plugin::Amp.path(dir.path(), &|_| None);
    let data = dir.path().join("data");
    assert!(apply(Plugin::Amp, &f, &script(dir.path()), &data, true).unwrap());
    let src = fs::read_to_string(&f).unwrap();
    for e in ["session.start", "agent.start", "tool.call", "tool.result", "agent.end"] {
      assert!(src.contains(&format!("amp.on('{e}'")));
    }
    assert!(src.contains("KINGU_AGENT_HOOK_FILE"));
    assert!(!apply(Plugin::Amp, &f, &script(dir.path()), &data, true).unwrap());
    assert!(apply(Plugin::Amp, &f, &script(dir.path()), &data, false).unwrap());
    assert!(!f.exists());
    fs::write(&f, "export default function () {}").unwrap();
    assert!(apply(Plugin::Amp, &f, &script(dir.path()), &data, true).is_err());
    assert!(apply(Plugin::Amp, &f, &script(dir.path()), &data, false).is_err());
  }

  #[test]
  fn yaml_list_edits_keep_everything_else() {
    let t = "# my hermes\nmodel: x\nplugins:\n  enabled:\n    - mine # keep\n  disabled: []\nterminal:\n  shell: zsh\n";
    let on = yaml_list_edit(t, "plugins", "enabled", "kingu-status", true).unwrap();
    assert_eq!(on, "# my hermes\nmodel: x\nplugins:\n  enabled:\n    - mine # keep\n    - kingu-status\n  disabled: []\nterminal:\n  shell: zsh\n");
    assert_eq!(yaml_list_edit(&on, "plugins", "enabled", "kingu-status", true).unwrap(), on);
    assert_eq!(yaml_list_edit(&on, "plugins", "enabled", "kingu-status", false).unwrap(), t);
    let p = yaml_list_edit(t, "terminal", "client_env_passthrough", "KINGU_AGENT_HOOK_FILE", true).unwrap();
    assert!(p.ends_with("terminal:\n  client_env_passthrough:\n    - KINGU_AGENT_HOOK_FILE\n  shell: zsh\n"));
    assert_eq!(yaml_has(&p, "terminal", "client_env_passthrough", "KINGU_AGENT_HOOK_FILE"), Some(true));
    // No section: appended; the only item taken out leaves an empty list.
    let a = yaml_list_edit("model: x\n", "plugins", "enabled", "kingu-status", true).unwrap();
    assert_eq!(a, "model: x\nplugins:\n  enabled:\n    - kingu-status\n");
    assert_eq!(yaml_list_edit(&a, "plugins", "enabled", "kingu-status", false).unwrap(), "model: x\nplugins:\n  enabled: []\n");
    assert_eq!(yaml_list_edit("plugins:\n  enabled: []\n", "plugins", "enabled", "k", true).unwrap(), "plugins:\n  enabled:\n    - k\n");
    // Flow style is not edited.
    assert!(yaml_list_edit("plugins: {enabled: [a]}\n", "plugins", "enabled", "k", true).is_none());
  }

  #[test]
  fn zcode_events_and_switch() {
    let dir = tempfile::tempdir().unwrap();
    let f = Plugin::Zcode.path(dir.path(), &|_| None);
    fs::create_dir_all(f.parent().unwrap()).unwrap();
    fs::write(&f, r#"{"model":"glm","hooks":{"events":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]}}}"#).unwrap();
    let data = dir.path().join("data");
    assert!(apply(Plugin::Zcode, &f, &script(dir.path()), &data, true).unwrap());
    let v: Value = serde_json::from_str(&fs::read_to_string(&f).unwrap()).unwrap();
    assert_eq!(v["hooks"]["enabled"], true);
    assert_eq!(v["hooks"]["events"]["Stop"][0]["hooks"][0]["command"], "say done");
    assert!(v["hooks"]["events"]["Stop"][1]["hooks"][0]["command"].as_str().unwrap().contains("zcode Stop"));
    assert!(v["hooks"]["events"]["PreToolUse"][0].get("matcher").is_none());
    assert!(!apply(Plugin::Zcode, &f, &script(dir.path()), &data, true).unwrap());
    assert!(apply(Plugin::Zcode, &f, &script(dir.path()), &data, false).unwrap());
    let v: Value = serde_json::from_str(&fs::read_to_string(&f).unwrap()).unwrap();
    assert_eq!(v["hooks"]["events"], json!({ "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }] }));
  }

  #[test]
  fn jcode_keys_name_the_script_and_leave_the_users() {
    let dir = tempfile::tempdir().unwrap();
    let f = Plugin::Jcode.path(dir.path(), &|_| None);
    fs::create_dir_all(f.parent().unwrap()).unwrap();
    let user = "model = \"x\"\n\n[hooks]\nturn_end = \"notify-me\"\n\n[ui]\ntheme = \"dark\"\n";
    fs::write(&f, user).unwrap();
    let data = dir.path().join("data");
    assert!(apply(Plugin::Jcode, &f, &script(dir.path()), &data, true).unwrap());
    let text = fs::read_to_string(&f).unwrap();
    let t: toml::Table = toml::from_str(&text).unwrap();
    assert_eq!(t["hooks"]["turn_end"].as_str(), Some("notify-me"), "the user's key stays");
    let pre = t["hooks"]["pre_tool"].as_str().unwrap();
    assert!(pre.starts_with('\'') && pre.ends_with("agent-status/jcode-hook.sh'"));
    assert_eq!(t["ui"]["theme"].as_str(), Some("dark"));
    assert!(!apply(Plugin::Jcode, &f, &script(dir.path()), &data, true).unwrap());
    assert!(apply(Plugin::Jcode, &f, &script(dir.path()), &data, false).unwrap());
    assert_eq!(fs::read_to_string(&f).unwrap(), user);
    // A table Kingu added goes with its keys.
    fs::write(&f, "model = \"x\"\n").unwrap();
    apply(Plugin::Jcode, &f, &script(dir.path()), &data, true).unwrap();
    assert!(fs::read_to_string(&f).unwrap().contains("[hooks]\n# Managed by Kingu"));
    apply(Plugin::Jcode, &f, &script(dir.path()), &data, false).unwrap();
    assert_eq!(fs::read_to_string(&f).unwrap(), "model = \"x\"\n");
  }

  #[cfg(unix)]
  #[test]
  fn jcode_script_reads_the_event_from_env() {
    let dir = tempfile::tempdir().unwrap();
    let s = dir.path().join(JCODE_SCRIPT_FILE);
    fs::write(&s, JCODE_SCRIPT).unwrap();
    let hooks = dir.path().join("agent-hooks");
    fs::create_dir_all(&hooks).unwrap();
    let file = hooks.join("t.jsonl");
    let out = std::process::Command::new("/bin/sh")
      .arg(&s)
      .env("KINGU_AGENT_HOOK_FILE", &file)
      .env("JCODE_HOOK_EVENT", "pre_tool")
      .env("JCODE_HOOK_PAYLOAD", r#"{"event":"pre_tool","tool_name":"bash","tool_input":"{\"command\":\"ls\"}"}"#)
      .stdin(std::process::Stdio::null())
      .output()
      .unwrap();
    assert!(out.stdout.is_empty() && out.stderr.is_empty());
    let line: Value = serde_json::from_str(fs::read_to_string(&file).unwrap().trim()).unwrap();
    assert_eq!(line["kingu_hook"], "jcode");
    assert_eq!(line["event"], "pre_tool");
    assert_eq!(line["payload"]["tool_name"], "bash");
  }

  #[test]
  fn pi_and_omp_extensions() {
    let dir = tempfile::tempdir().unwrap();
    let pi = Plugin::Pi.path(dir.path(), &|_| None);
    assert!(pi.ends_with(".pi/agent/extensions/kingu-agent-status.ts"));
    let omp = Plugin::Omp.path(dir.path(), &|_| None);
    let data = dir.path().join("data");
    assert!(apply(Plugin::Pi, &pi, &script(dir.path()), &data, true).unwrap());
    assert!(apply(Plugin::Omp, &omp, &script(dir.path()), &data, true).unwrap());
    assert!(fs::read_to_string(&pi).unwrap().contains("kingu_hook: 'pi'"));
    assert!(fs::read_to_string(&omp).unwrap().contains("kingu_hook: 'omp'"));
    assert!(apply(Plugin::Pi, &pi, &script(dir.path()), &data, false).unwrap());
    assert!(!pi.exists());
  }

  #[test]
  fn hermes_plugin_and_config() {
    let dir = tempfile::tempdir().unwrap();
    let home = Plugin::Hermes.path(dir.path(), &|_| None);
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join("config.yaml"), "model: x\n").unwrap();
    let data = dir.path().join("data");
    assert!(apply(Plugin::Hermes, &home, &script(dir.path()), &data, true).unwrap());
    let plug = home.join("plugins/kingu-status");
    assert!(fs::read_to_string(plug.join("__init__.py")).unwrap().contains("def register(ctx)"));
    assert!(fs::read_to_string(plug.join("plugin.yaml")).unwrap().contains("  - pre_approval_request\n"));
    let cfg = fs::read_to_string(home.join("config.yaml")).unwrap();
    assert_eq!(yaml_has(&cfg, "plugins", "enabled", HERMES_PLUGIN), Some(true));
    assert!(!apply(Plugin::Hermes, &home, &script(dir.path()), &data, true).unwrap(), "idempotent");
    assert!(apply(Plugin::Hermes, &home, &script(dir.path()), &data, false).unwrap());
    assert!(!plug.exists());
    let cfg = fs::read_to_string(home.join("config.yaml")).unwrap();
    assert_eq!(yaml_has(&cfg, "plugins", "enabled", HERMES_PLUGIN), Some(false));
    assert!(cfg.starts_with("model: x\n"));
  }
}
