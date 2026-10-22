//! Chat observability and history search, both read from the chats' transcripts (`chats.rs`):
//!
//! - `chat_debug_events`: a chat's Agent Debug Log (VS Code's chat debug view): every kept event
//!   as a row with its time, kind and one-line summary. Tool calls are paired with their results
//!   (duration, error), permission prompts with their answers, turns carry their usage and cost,
//!   and the run's own `RunInfo` (runtime, model, rules and instructions, tools taken away) and the
//!   session's `HookRun`s show what the transcript keeps for Rust only.
//! - `chat_search`: the folder's chats whose title or transcript has the query (case-insensitive),
//!   newest first, with a few snippets each. Capped: query length, hits, snippets and bytes read.
//! - `chats_with_edits`: the chats that recorded edits (`chat_edits`), for the history's filter.

use std::collections::HashMap;
use std::path::Path;

use serde_json::{Value, json};

use crate::workspace::Workspace;

use super::chats::{self, ChatMeta};
use super::events::AgentEvent;

/// Transcript lines the debug view reads, newest kept.
pub const MAX_DEBUG_LINES: usize = 10_000;
const MAX_DETAIL: usize = 200;
pub const MAX_QUERY: usize = 200;
pub const MAX_HITS: usize = 50;
pub const MAX_SNIPPETS: usize = 3;
/// Transcript bytes one search reads at most (newest chats first).
pub const MAX_SCAN_BYTES: u64 = 64 * 1024 * 1024;
const SNIPPET_BEFORE: usize = 40;
const SNIPPET_LEN: usize = 160;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct DebugEvent {
  pub seq: usize,
  /// Unix ms.
  pub t: u64,
  /// `run`, `session`, `user`, `assistant`, `thinking`, `tool`, `permission`, `guard`, `hook`,
  /// `turn`, `context`, `mcp`, `artifact`, `feedback`, `error` or `exit`.
  pub kind: &'static str,
  pub name: String,
  pub detail: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub duration_ms: Option<u64>,
  pub is_error: bool,
  /// The chat request (checkpoint) it belongs to.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub request: Option<u32>,
  /// A subagent's event: the id of the Task call that started it.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub subagent: Option<String>,
  /// The event as kept (a tool call also gets its `result`).
  pub data: Value,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct Totals {
  pub requests: u32,
  pub turns: u32,
  pub tool_calls: u32,
  pub tool_errors: u32,
  pub hooks: u32,
  pub errors: u32,
  pub input_tokens: u64,
  pub output_tokens: u64,
  pub cache_read_tokens: u64,
  pub cache_creation_tokens: u64,
  pub cost_usd: f64,
  pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct DebugLog {
  pub chat_id: String,
  pub title: String,
  pub runtime: String,
  pub model: Option<String>,
  pub events: Vec<DebugEvent>,
  pub totals: Totals,
}

fn one_line(s: &str, max: usize) -> String {
  let line: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
  if line.chars().count() > max { format!("{}…", line.chars().take(max).collect::<String>()) } else { line }
}

/// `● Tool(arg)`'s argument: the input's path, command, pattern, URL or query, else its first string.
fn tool_arg(input: &Value) -> String {
  let Some(obj) = input.as_object() else { return String::new() };
  let key = ["file_path", "path", "command", "pattern", "url", "query", "description"].iter().find_map(|k| obj.get(*k).and_then(|v| v.as_str()));
  one_line(key.or_else(|| obj.values().find_map(|v| v.as_str())).unwrap_or(""), MAX_DETAIL)
}

fn secs(ms: u64) -> String {
  if ms < 1000 { format!("{ms} ms") } else { format!("{:.1} s", ms as f64 / 1000.0) }
}

/// The debug rows of transcript `lines` (time, event), oldest first.
pub fn debug_events(lines: &[(u64, AgentEvent)]) -> (Vec<DebugEvent>, Totals) {
  let mut out: Vec<DebugEvent> = Vec::new();
  let mut totals = Totals::default();
  let mut tools: HashMap<String, usize> = HashMap::new();
  let mut asks: HashMap<String, usize> = HashMap::new();
  let mut request: Option<u32> = None;
  for (t, ev) in lines {
    let t = *t;
    let row = |kind: &'static str, name: String, detail: String, sub: Option<&String>| DebugEvent {
      seq: 0,
      t,
      kind,
      name,
      detail,
      duration_ms: None,
      is_error: false,
      request,
      subagent: sub.cloned(),
      data: serde_json::to_value(ev).unwrap_or(Value::Null),
    };
    let next = match ev {
      AgentEvent::RunInfo { runtime, model, effort, agent, rules, disallowed_tools, mcp_servers, resumed, .. } => {
        let mut parts = vec![runtime.clone()];
        parts.extend(model.clone());
        parts.extend(effort.as_ref().map(|e| format!("effort {e}")));
        parts.extend(agent.clone());
        parts.push(format!("{} rules", rules.len()));
        if !disallowed_tools.is_empty() {
          parts.push(format!("{} tools off", disallowed_tools.len()));
        }
        if !mcp_servers.is_empty() {
          parts.push(format!("{} MCP", mcp_servers.len()));
        }
        Some(row("run", if *resumed { "Run resumed".into() } else { "Run started".into() }, parts.join(" · "), None))
      }
      AgentEvent::System { subtype, model, .. } => Some(row("session", format!("Session {subtype}"), model.clone().unwrap_or_default(), None)),
      AgentEvent::SessionInfo { tools, mcp_servers, slash_commands } => {
        Some(row("session", "Session tools".into(), format!("{} tools · {} MCP servers · {} commands", tools.len(), mcp_servers.len(), slash_commands.len()), None))
      }
      AgentEvent::McpStatus { servers } => {
        let detail = servers.iter().map(|s| format!("{} ({})", s.name, s.status)).collect::<Vec<_>>().join(", ");
        let mut r = row("mcp", "MCP servers".into(), one_line(&detail, MAX_DETAIL), None);
        r.is_error = servers.iter().any(|s| s.status == "failed");
        Some(r)
      }
      AgentEvent::ContextUsage { used_tokens, max_tokens } => {
        let pct = if *max_tokens > 0 { used_tokens * 100 / max_tokens } else { 0 };
        Some(row("context", "Context window".into(), format!("{used_tokens} / {max_tokens} tokens ({pct}%)"), None))
      }
      AgentEvent::Message { role, text, parent_tool_use_id } => {
        let kind = if role == "user" { "user" } else { "assistant" };
        if kind == "user" && parent_tool_use_id.is_none() {
          totals.requests += 1;
        }
        Some(row(kind, if kind == "user" { "User message".into() } else { "Agent response".into() }, one_line(text, MAX_DETAIL), parent_tool_use_id.as_ref()))
      }
      AgentEvent::Thinking { text, parent_tool_use_id } => Some(row("thinking", "Thinking".into(), one_line(text, MAX_DETAIL), parent_tool_use_id.as_ref())),
      AgentEvent::ToolUse { id, name, input, parent_tool_use_id } => {
        totals.tool_calls += 1;
        tools.insert(id.clone(), out.len());
        Some(row("tool", name.clone(), tool_arg(input), parent_tool_use_id.as_ref()))
      }
      AgentEvent::ToolResult { tool_use_id, content, is_error, parent_tool_use_id } => {
        if *is_error {
          totals.tool_errors += 1;
        }
        match tools.remove(tool_use_id).and_then(|i| out.get_mut(i).map(|r| (i, r))) {
          Some((_, r)) => {
            r.duration_ms = Some(t.saturating_sub(r.t));
            r.is_error = *is_error;
            if let Value::Object(map) = &mut r.data {
              map.insert("result".into(), json!({ "content": content, "is_error": is_error }));
            }
            None
          }
          None => {
            let mut r = row("tool", "Tool result".into(), one_line(content, MAX_DETAIL), parent_tool_use_id.as_ref());
            r.is_error = *is_error;
            Some(r)
          }
        }
      }
      AgentEvent::PermissionRequest { request_id, tool, input_summary, .. } => {
        asks.insert(request_id.clone(), out.len());
        Some(row("permission", format!("Permission: {tool}"), one_line(input_summary, MAX_DETAIL), None))
      }
      AgentEvent::PermissionResolved { request_id, decision } => {
        if let Some(r) = asks.remove(request_id).and_then(|i| out.get_mut(i)) {
          r.duration_ms = Some(t.saturating_sub(r.t));
          r.is_error = decision == "deny";
          r.detail = one_line(&format!("{} → {decision}", r.detail), MAX_DETAIL);
          if let Value::Object(map) = &mut r.data {
            map.insert("decision".into(), json!(decision));
          }
        }
        None
      }
      AgentEvent::ToolAutoApproved { tool, rules, .. } => {
        Some(row("permission", format!("Auto approved: {tool}"), one_line(&rules.join(", "), MAX_DETAIL), None))
      }
      AgentEvent::McpRequest { request_id, ask, server, message, .. } => {
        asks.insert(request_id.clone(), out.len());
        Some(row("mcp", format!("MCP {ask}: {server}"), one_line(message, MAX_DETAIL), None))
      }
      AgentEvent::McpRequestResolved { request_id, action } => {
        if let Some(r) = asks.remove(request_id).and_then(|i| out.get_mut(i)) {
          r.duration_ms = Some(t.saturating_sub(r.t));
          r.detail = one_line(&format!("{} → {action}", r.detail), MAX_DETAIL);
          if let Value::Object(map) = &mut r.data {
            map.insert("action".into(), json!(action));
          }
        }
        None
      }
      AgentEvent::GuardBlocked { tool, check, detail, .. } => {
        let mut r = row("guard", format!("Safety check: {check}"), one_line(&format!("{tool}: {detail}"), MAX_DETAIL), None);
        r.is_error = true;
        Some(r)
      }
      AgentEvent::GuardAsked { tool, check, paths, .. } => Some(row("guard", format!("Always ask: {check}"), one_line(&format!("{tool} {}", paths.join(", ")), MAX_DETAIL), None)),
      AgentEvent::HookRun { name, event, outcome, exit_code, output, .. } => {
        totals.hooks += 1;
        let code = exit_code.map(|c| format!(" (exit {c})")).unwrap_or_default();
        let mut r = row("hook", if name.is_empty() { event.clone() } else { format!("{event}: {name}") }, one_line(&format!("{outcome}{code} {output}"), MAX_DETAIL), None);
        r.is_error = outcome == "error";
        Some(r)
      }
      AgentEvent::Result { subtype, is_error, num_turns, duration_ms, total_cost_usd, usage, .. } => {
        totals.turns += num_turns.unwrap_or(1) as u32;
        let mut parts = Vec::new();
        if let Some(n) = num_turns {
          parts.push(format!("{n} turns"));
        }
        if let Some(d) = duration_ms {
          totals.duration_ms += d;
          parts.push(secs(*d));
        }
        if let Some(u) = usage {
          totals.input_tokens += u.input_tokens;
          totals.output_tokens += u.output_tokens;
          totals.cache_read_tokens += u.cache_read_input_tokens;
          totals.cache_creation_tokens += u.cache_creation_input_tokens;
          parts.push(format!("{} in / {} out tokens", u.input_tokens, u.output_tokens));
          if u.cache_read_input_tokens > 0 {
            parts.push(format!("{} cached", u.cache_read_input_tokens));
          }
        }
        if let Some(c) = total_cost_usd {
          totals.cost_usd += c;
          parts.push(format!("${c:.4}"));
        }
        let mut r = row("turn", format!("Turn {subtype}"), parts.join(" · "), None);
        r.duration_ms = *duration_ms;
        r.is_error = *is_error;
        Some(r)
      }
      AgentEvent::Checkpoint { request: n, .. } => {
        request = Some(*n);
        // The request's user message came just before.
        if let Some(r) = out.iter_mut().rev().find(|r| r.kind == "user" && r.subagent.is_none()) {
          r.request.get_or_insert(*n);
        }
        None
      }
      AgentEvent::Artifact { title, version, format, .. } => Some(row("artifact", "Artifact".into(), one_line(&format!("{title} v{version} ({format})"), MAX_DETAIL), None)),
      AgentEvent::Feedback { request: n, vote } => Some(row("feedback", "Feedback".into(), format!("request {n}: {}", vote.as_deref().unwrap_or("none")), None)),
      AgentEvent::Error { message } => {
        totals.errors += 1;
        let mut r = row("error", "Error".into(), one_line(message, MAX_DETAIL), None);
        r.is_error = true;
        Some(r)
      }
      AgentEvent::Exit { code, signal, stopped } => {
        let what = if *stopped { "stopped".to_owned() } else if let Some(s) = signal { format!("signal {s}") } else { format!("exit {}", code.unwrap_or(0)) };
        let mut r = row("exit", "Run ended".into(), what, None);
        r.is_error = !*stopped && (signal.is_some() || code.is_some_and(|c| c != 0));
        Some(r)
      }
      AgentEvent::Anchor { .. }
      | AgentEvent::Commands { .. }
      | AgentEvent::Models { .. }
      | AgentEvent::EffortOptions { .. }
      | AgentEvent::Delta { .. }
      | AgentEvent::FileSnapshot { .. }
      | AgentEvent::EditsChanged { .. }
      | AgentEvent::Raw { .. }
      | AgentEvent::Stderr { .. } => None,
    };
    if let Some(mut r) = next {
      r.seq = out.len();
      out.push(r);
    }
  }
  (out, totals)
}

pub fn debug_log(root: &Path, id: &str) -> Result<DebugLog, String> {
  chats::check_id(id)?;
  let meta = chats::load(root)?.into_iter().find(|c| c.id == id).ok_or_else(|| crate::tr!(crate::i18n::msg::AgentMsg::BadChatId))?;
  let (events, totals) = debug_events(&chats::load_lines(root, id, MAX_DEBUG_LINES)?);
  Ok(DebugLog { chat_id: meta.id, title: meta.title, runtime: meta.runtime, model: meta.model, events, totals })
}

// ---- search --------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Snippet {
  /// `user`, `assistant`, `tool` or `result`.
  pub kind: &'static str,
  pub text: String,
  /// Where the match is in `text`, in characters.
  pub start: usize,
  pub len: usize,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SearchHit {
  pub id: String,
  pub title: String,
  pub title_match: bool,
  /// Matching transcript events (at least one per snippet).
  pub matches: usize,
  pub snippets: Vec<Snippet>,
}

/// Each character's first lowercase character: as many characters as `s`, so offsets carry over.
fn fold(s: &str) -> Vec<char> {
  s.chars().map(|c| c.to_lowercase().next().unwrap_or(c)).collect()
}

fn find(hay: &[char], needle: &[char]) -> Option<usize> {
  if needle.is_empty() || needle.len() > hay.len() {
    return None;
  }
  (0..=hay.len() - needle.len()).find(|&i| hay[i..i + needle.len()] == *needle)
}

/// A window of `text` around the match at `at`, on one line.
fn snippet(kind: &'static str, text: &str, at: usize, len: usize) -> Snippet {
  let chars: Vec<char> = text.chars().collect();
  let from = at.saturating_sub(SNIPPET_BEFORE);
  let to = (from + SNIPPET_LEN).min(chars.len()).max(at + len);
  let mut s: String = chars[from..to].iter().map(|&c| if c.is_whitespace() { ' ' } else { c }).collect();
  let mut start = at - from;
  if from > 0 {
    s.insert(0, '…');
    start += 1;
  }
  if to < chars.len() {
    s.push('…');
  }
  Snippet { kind, text: s, start, len }
}

/// The searchable texts of an event: messages, a tool call's name and string inputs, its result.
fn texts(ev: &AgentEvent) -> Vec<(&'static str, String)> {
  match ev {
    AgentEvent::Message { role, text, .. } => vec![(if role == "user" { "user" } else { "assistant" }, text.clone())],
    AgentEvent::ToolUse { name, input, .. } => {
      let args: Vec<&str> = input.as_object().map(|o| o.values().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
      vec![("tool", format!("{name} {}", args.join(" ")))]
    }
    AgentEvent::ToolResult { content, .. } => vec![("result", content.clone())],
    _ => Vec::new(),
  }
}

/// The chats of `list` (any order) whose title or transcript has `query`, newest first.
pub fn search(root: &Path, list: &[ChatMeta], query: &str) -> Vec<SearchHit> {
  let q: String = query.trim().chars().take(MAX_QUERY).collect();
  let needle = fold(&q);
  if needle.is_empty() {
    return Vec::new();
  }
  let mut chats: Vec<&ChatMeta> = list.iter().collect();
  chats.sort_by_key(|c| std::cmp::Reverse(c.updated_at.max(c.created_at)));
  let mut budget = MAX_SCAN_BYTES;
  let mut hits = Vec::new();
  for c in chats {
    if hits.len() >= MAX_HITS {
      break;
    }
    let title_match = find(&fold(&c.title), &needle).is_some();
    let mut hit = SearchHit { id: c.id.clone(), title: c.title.clone(), title_match, matches: 0, snippets: Vec::new() };
    let size = chats::transcript_path(root, &c.id).ok().and_then(|p| std::fs::metadata(p).ok()).map_or(0, |m| m.len());
    if size > 0 && size <= budget {
      budget -= size;
      for (_, ev) in chats::load_lines(root, &c.id, usize::MAX).unwrap_or_default() {
        for (kind, text) in texts(&ev) {
          if let Some(at) = find(&fold(&text), &needle) {
            hit.matches += 1;
            if hit.snippets.len() < MAX_SNIPPETS {
              hit.snippets.push(snippet(kind, &text, at, needle.len()));
            }
          }
        }
      }
    }
    if hit.title_match || hit.matches > 0 {
      hits.push(hit);
    }
  }
  hits
}

/// The chats of `list` that recorded edits (`.kingu/chats/<id>/edits.json`).
pub fn with_edits(root: &Path, list: &[ChatMeta]) -> Vec<String> {
  list.iter().filter(|c| super::chat_edits::chat_dir(root, &c.id).is_ok_and(|d| std::fs::symlink_metadata(d.join("edits.json")).is_ok_and(|m| m.is_file()))).map(|c| c.id.clone()).collect()
}

// ---- commands ------------------------------------------------------------------------------------

/// Chat `id`'s Agent Debug Log.
#[tauri::command]
pub async fn chat_debug_events(ws: Workspace, chat_id: String) -> Result<DebugLog, String> {
  let root = ws.root()?;
  tauri::async_runtime::spawn_blocking(move || debug_log(&root, &chat_id)).await.map_err(|e| e.to_string())?
}

/// Export Agent Debug Log: chat `id`'s log as JSON at `path` (the user picked it), only the rows
/// of `kinds` when given.
#[tauri::command]
pub async fn chat_debug_export(ws: Workspace, chat_id: String, path: String, kinds: Option<Vec<String>>) -> Result<(), String> {
  let root = ws.root()?;
  tauri::async_runtime::spawn_blocking(move || {
    let mut log = debug_log(&root, &chat_id)?;
    if let Some(k) = kinds {
      log.events.retain(|e| k.iter().any(|x| x == e.kind));
    }
    let text = serde_json::to_string_pretty(&json!({ "version": 1, "log": log })).map_err(|e| e.to_string())?;
    std::fs::write(&path, text + "\n").map_err(|e| format!("{path}: {e}"))
  })
  .await
  .map_err(|e| e.to_string())?
}

/// The open folder's chats matching `query` in their title or transcript (empty with no folder).
#[tauri::command]
pub async fn chat_search(ws: Workspace, query: String) -> Result<Vec<SearchHit>, String> {
  let Some(root) = ws.current() else { return Ok(Vec::new()) };
  tauri::async_runtime::spawn_blocking(move || Ok(search(&root, &chats::load(&root)?, &query))).await.map_err(|e| e.to_string())?
}

/// The open folder's chats with recorded edits.
#[tauri::command]
pub async fn chats_with_edits(ws: Workspace) -> Result<Vec<String>, String> {
  let Some(root) = ws.current() else { return Ok(Vec::new()) };
  tauri::async_runtime::spawn_blocking(move || Ok(with_edits(&root, &chats::load(&root)?))).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::agent::events::McpServerLive;

  fn line(t: u64, v: Value) -> (u64, AgentEvent) {
    (t, AgentEvent::from_host(v))
  }

  /// A recorded chat: one request with a run start, a tool call, a permission prompt, a hook, a
  /// failed tool call, the turn's result and the run's end.
  fn fixture() -> Vec<(u64, AgentEvent)> {
    vec![
      (
        1000,
        AgentEvent::RunInfo {
          runtime: "claude".into(),
          model: Some("opus".into()),
          permission_mode: Some("default".into()),
          effort: Some("high".into()),
          agent: Some("Planner".into()),
          resumed: false,
          rules: vec!["AGENTS.md".into(), ".github/instructions/py.instructions.md".into()],
          instructions_chars: 420,
          disallowed_tools: vec!["Bash".into()],
          mcp_servers: vec!["github".into()],
          plugins: 1,
        },
      ),
      line(1001, json!({"kind": "message", "role": "user", "text": "Fix the\nlogin bug"})),
      line(1002, json!({"kind": "checkpoint", "request": 0})),
      line(1010, json!({"kind": "system", "subtype": "init", "session_id": "s1", "model": "claude-opus"})),
      line(1020, json!({"kind": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "src/login.rs"}})),
      line(1270, json!({"kind": "tool_result", "tool_use_id": "t1", "content": "fn login() {}", "is_error": false})),
      line(1300, json!({"kind": "permission_request", "request_id": "r1", "tool": "Edit", "input_summary": "src/login.rs", "can_always": true})),
      line(3300, json!({"kind": "permission_resolved", "request_id": "r1", "decision": "allow"})),
      line(3310, json!({"kind": "hook_run", "hook_id": "h", "name": "fmt", "event": "PostToolUse", "outcome": "error", "exit_code": 2, "output": "rustfmt failed"})),
      line(3400, json!({"kind": "tool_use", "id": "t2", "name": "Grep", "input": {"pattern": "TODO"}, "parent_tool_use_id": "task-1"})),
      line(3405, json!({"kind": "tool_result", "tool_use_id": "t2", "content": "no matches", "is_error": true, "parent_tool_use_id": "task-1"})),
      line(3500, json!({"kind": "message", "role": "assistant", "text": "Fixed the login bug."})),
      line(
        3600,
        json!({"kind": "result", "subtype": "success", "is_error": false, "result": "Fixed", "session_id": "s1", "num_turns": 3, "duration_ms": 2600, "total_cost_usd": 0.0123,
          "usage": {"input_tokens": 100, "output_tokens": 20, "cache_read_input_tokens": 50, "cache_creation_input_tokens": 5}}),
      ),
      (3601, AgentEvent::McpStatus { servers: vec![McpServerLive { name: "github".into(), status: "failed".into(), error: None, source: None, tools: vec![] }] }),
      (3602, AgentEvent::Anchor { uuid: "u".into() }),
      line(3700, json!({"kind": "exit", "code": 0, "signal": null, "stopped": false})),
    ]
  }

  #[test]
  fn builds_rows_with_durations_and_totals() {
    let (rows, totals) = debug_events(&fixture());
    let kinds: Vec<_> = rows.iter().map(|r| r.kind).collect();
    assert_eq!(kinds, ["run", "user", "session", "tool", "permission", "hook", "tool", "assistant", "turn", "mcp", "exit"]);
    assert_eq!(rows.iter().map(|r| r.seq).collect::<Vec<_>>(), (0..rows.len()).collect::<Vec<_>>());
    assert_eq!(rows[0].detail, "claude · opus · effort high · Planner · 2 rules · 1 tools off · 1 MCP");
    assert_eq!((rows[1].detail.as_str(), rows[1].request), ("Fix the login bug", Some(0)), "one line, and its request");
    let read = &rows[3];
    assert_eq!((read.name.as_str(), read.detail.as_str(), read.duration_ms, read.is_error, read.request), ("Read", "src/login.rs", Some(250), false, Some(0)));
    assert_eq!(read.data["result"]["content"], "fn login() {}");
    assert_eq!((rows[4].duration_ms, rows[4].detail.as_str()), (Some(2000), "src/login.rs → allow"));
    assert_eq!((rows[5].name.as_str(), rows[5].is_error), ("PostToolUse: fmt", true));
    assert_eq!((rows[6].is_error, rows[6].subagent.as_deref(), rows[6].duration_ms), (true, Some("task-1"), Some(5)));
    assert_eq!(rows[8].detail, "3 turns · 2.6 s · 100 in / 20 out tokens · 50 cached · $0.0123");
    assert!(rows[9].is_error, "a failed MCP server");
    let want = Totals {
      requests: 1,
      turns: 3,
      tool_calls: 2,
      tool_errors: 1,
      hooks: 1,
      errors: 0,
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 50,
      cache_creation_tokens: 5,
      cost_usd: 0.0123,
      duration_ms: 2600,
    };
    assert_eq!(totals, want);
  }

  #[test]
  fn reads_the_log_from_the_transcript() {
    let tmp = tempfile::tempdir().unwrap();
    let meta: ChatMeta = serde_json::from_value(json!({"id": "c-1", "title": "Login", "cwd": {"kind": "folder"}, "created_at": 1, "model": "opus"})).unwrap();
    chats::save(tmp.path(), &[meta]).unwrap();
    let path = chats::transcript_path(tmp.path(), "c-1").unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let text: String = fixture().iter().map(|(t, ev)| format!("{}\n", json!({"t": t, "event": ev}))).collect();
    std::fs::write(&path, text + "{\"t\":1,\"ev").unwrap();
    let log = debug_log(tmp.path(), "c-1").unwrap();
    assert_eq!((log.title.as_str(), log.runtime.as_str(), log.model.as_deref(), log.events.len()), ("Login", "claude", Some("opus"), 11));
    assert!(debug_log(tmp.path(), "c-2").is_err());
    assert!(debug_log(tmp.path(), "../x").is_err());
    // The chat's timeline never gets the Rust-only events.
    let shown = chats::load_transcript(tmp.path(), "c-1").unwrap();
    assert!(!shown.iter().any(chats::rust_only));
  }

  fn write_chat(root: &Path, id: &str, title: &str, at: u64, events: &[Value]) -> ChatMeta {
    let path = chats::transcript_path(root, id).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let text: String = events.iter().map(|ev| format!("{}\n", json!({"t": 1, "event": ev}))).collect();
    std::fs::write(&path, text).unwrap();
    serde_json::from_value(json!({"id": id, "title": title, "cwd": {"kind": "folder"}, "created_at": at, "updated_at": at})).unwrap()
  }

  #[test]
  fn searches_titles_and_transcripts_case_insensitively() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let long = format!("{} the LOGIN form {}", "x".repeat(100), "y".repeat(300));
    let list = vec![
      write_chat(root, "a", "Old chat", 1, &[json!({"kind": "message", "role": "user", "text": "Fix the Login\nbug"}), json!({"kind": "message", "role": "assistant", "text": long})]),
      write_chat(root, "b", "Login page", 5, &[json!({"kind": "message", "role": "user", "text": "hello"})]),
      write_chat(
        root,
        "c",
        "Tools",
        3,
        &[json!({"kind": "tool_use", "id": "t", "name": "Grep", "input": {"pattern": "login"}}), json!({"kind": "tool_result", "tool_use_id": "t", "content": "src/login.rs:1", "is_error": false})],
      ),
      write_chat(root, "d", "Unrelated", 4, &[json!({"kind": "message", "role": "user", "text": "ล็อกอิน"})]),
    ];
    let hits = search(root, &list, "  LoGiN ");
    assert_eq!(hits.iter().map(|h| (h.id.as_str(), h.title_match, h.matches)).collect::<Vec<_>>(), [("b", true, 0), ("c", false, 2), ("a", false, 2)], "newest first");
    let a = &hits[2];
    assert_eq!(a.snippets[0], Snippet { kind: "user", text: "Fix the Login bug".into(), start: 8, len: 5 });
    let s = &a.snippets[1];
    assert!(s.text.starts_with('…') && s.text.ends_with('…'), "{}", s.text);
    assert_eq!(s.text.chars().skip(s.start).take(s.len).collect::<String>(), "LOGIN");
    assert_eq!(hits[1].snippets.iter().map(|s| s.kind).collect::<Vec<_>>(), ["tool", "result"]);
    assert_eq!(search(root, &list, "ล็อก").iter().map(|h| h.id.as_str()).collect::<Vec<_>>(), ["d"]);
    assert!(search(root, &list, "   ").is_empty());
    assert!(search(root, &list, "nothing like it").is_empty());
  }

  #[test]
  fn search_is_capped() {
    let tmp = tempfile::tempdir().unwrap();
    let many: Vec<Value> = (0..10).map(|i| json!({"kind": "message", "role": "user", "text": format!("needle {i}")})).collect();
    let list: Vec<ChatMeta> = (0..MAX_HITS + 5).map(|i| write_chat(tmp.path(), &format!("c-{i}"), "t", i as u64, &many)).collect();
    let hits = search(tmp.path(), &list, "NEEDLE");
    assert_eq!(hits.len(), MAX_HITS);
    assert!(hits.iter().all(|h| h.snippets.len() == MAX_SNIPPETS && h.matches == 10));
    assert_eq!(hits[0].id, format!("c-{}", MAX_HITS + 4));
  }

  #[test]
  fn lists_chats_with_edits() {
    let tmp = tempfile::tempdir().unwrap();
    let list = vec![write_chat(tmp.path(), "a", "A", 1, &[]), write_chat(tmp.path(), "b", "B", 1, &[])];
    std::fs::create_dir_all(tmp.path().join(".kingu/chats/b")).unwrap();
    std::fs::write(tmp.path().join(".kingu/chats/b/edits.json"), "{}").unwrap();
    assert_eq!(with_edits(tmp.path(), &list), ["b"]);
  }
}
