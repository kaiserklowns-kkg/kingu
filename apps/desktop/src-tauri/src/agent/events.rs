//! Normalized agent events sent to the webview, tagged by `kind`.
//!
//! The agent host sidecar (apps/agent-host, `src/protocol.ts`) produces them already normalized;
//! Rust deserializes each one (so only known shapes reach the webview) and adds its own
//! `error`/`exit` events when the sidecar itself dies. Unknown kinds become `Raw`.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Usage {
  pub input_tokens: u64,
  pub output_tokens: u64,
  #[serde(default)]
  pub cache_read_input_tokens: u64,
  #[serde(default)]
  pub cache_creation_input_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DiffStats {
  pub added: u64,
  pub removed: u64,
}

fn yes() -> bool {
  true
}

/// An MCP server of the session and how it is (`connected`, `failed`, `needs-auth`, `pending`).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct McpServerState {
  pub name: String,
  #[serde(default)]
  pub status: String,
}

/// A slash command the session knows (built in, a skill, or `.claude/commands`).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SlashCommand {
  pub name: String,
  #[serde(default)]
  pub description: String,
  #[serde(default)]
  pub argument_hint: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentEvent {
  /// Session start (`system`/`init`).
  System { subtype: String, session_id: Option<String>, model: Option<String> },
  /// What the session started with: its slash command names, tools and MCP servers.
  SessionInfo {
    #[serde(default)]
    slash_commands: Vec<String>,
    #[serde(default)]
    tools: Vec<String>,
    #[serde(default)]
    mcp_servers: Vec<McpServerState>,
  },
  /// The session's slash commands with descriptions; replaces the last list.
  Commands { commands: Vec<SlashCommand> },
  /// How full the context window is after a turn.
  ContextUsage { used_tokens: u64, max_tokens: u64 },
  Message { role: String, text: String },
  /// Streaming chunk of assistant text or thinking (`block`); the full `Message`/`Thinking` follows.
  Delta { block: String, text: String },
  Thinking { text: String },
  ToolUse {
    id: String,
    name: String,
    #[serde(default)]
    input: Value,
  },
  ToolResult {
    tool_use_id: String,
    content: String,
    #[serde(default)]
    is_error: bool,
  },
  Result {
    subtype: String,
    is_error: bool,
    result: Option<String>,
    session_id: Option<String>,
    num_turns: Option<u64>,
    duration_ms: Option<u64>,
    total_cost_usd: Option<f64>,
    #[serde(default)]
    usage: Option<Usage>,
  },
  /// The agent wants to run a tool that needs the user's approval; answer with
  /// `agent_answer_permission`.
  PermissionRequest {
    request_id: String,
    tool: String,
    tool_use_id: Option<String>,
    title: Option<String>,
    input_summary: String,
    detail: Option<String>,
    diff: Option<DiffStats>,
    #[serde(default)]
    input: Value,
    #[serde(default = "yes")]
    can_always: bool,
    /// The rules an "always" answer adds (`Bash(npm test:*)`); empty: the whole tool.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    rules: Vec<String>,
  },
  /// A permission request was answered (`allow`, `allow_always`, `allow_workspace`, `allow_user`,
  /// `deny`) or `cancelled`.
  PermissionResolved { request_id: String, decision: String },
  /// A file's content just before an edit tool changed it (the host's PreToolUse hook). Rust
  /// stores it in the chat's snapshot store (`chat_edits`) and never passes it on.
  FileSnapshot {
    tool_use_id: String,
    tool: String,
    path: String,
    existed: bool,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    content_b64: Option<String>,
    #[serde(default)]
    skipped: Option<String>,
  },
  /// Added by Rust after a chat's user message: that message is request `request` of the chat,
  /// the checkpoint "Restore checkpoint" goes back to. Kept in the transcript.
  Checkpoint { request: u32 },
  /// Added by Rust: the chat's working set changed (an edit was recorded, a turn ended). Live only.
  EditsChanged { request: Option<u32> },
  Error { message: String },
  /// Output the host did not understand, passed through untouched.
  Raw { line: String },
  Stderr { line: String },
  /// The run is over (stopped, failed, or its host exited). Always the last event of a run.
  Exit { code: Option<i32>, signal: Option<i32>, stopped: bool },
}

impl AgentEvent {
  /// An event from the sidecar; anything that does not fit a known shape becomes `Raw`.
  pub fn from_host(v: Value) -> Self {
    serde_json::from_value(v.clone()).unwrap_or_else(|_| AgentEvent::Raw { line: v.to_string() })
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn round_trips_host_events() {
    let req = json!({
      "kind": "permission_request", "request_id": "r1", "tool": "Bash", "tool_use_id": "tu1", "title": null,
      "input_summary": "rm -rf build", "detail": "Clean", "diff": null, "input": {"command": "rm -rf build"}, "can_always": true
    });
    let ev = AgentEvent::from_host(req.clone());
    assert!(matches!(&ev, AgentEvent::PermissionRequest { request_id, tool, .. } if request_id == "r1" && tool == "Bash"));
    assert_eq!(serde_json::to_value(&ev).unwrap(), req);

    let result = json!({
      "kind": "result", "subtype": "success", "is_error": false, "result": "เสร็จแล้ว", "session_id": "s-1",
      "num_turns": 2, "duration_ms": 4210, "total_cost_usd": 0.0123,
      "usage": {"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 2, "cache_creation_input_tokens": 1}
    });
    assert_eq!(serde_json::to_value(AgentEvent::from_host(result.clone())).unwrap(), result);
  }

  #[test]
  fn round_trips_session_commands_and_context() {
    for v in [
      json!({"kind": "session_info", "slash_commands": ["compact"], "tools": ["Bash"], "mcp_servers": [{"name": "gh", "status": "connected"}]}),
      json!({"kind": "commands", "commands": [{"name": "review", "description": "Review a PR", "argument_hint": "<pr>"}]}),
      json!({"kind": "context_usage", "used_tokens": 1200, "max_tokens": 200000}),
    ] {
      assert_eq!(serde_json::to_value(AgentEvent::from_host(v.clone())).unwrap(), v);
    }
    let req = json!({
      "kind": "permission_request", "request_id": "r1", "tool": "Bash", "tool_use_id": null, "title": null,
      "input_summary": "npm test", "detail": null, "diff": null, "input": {}, "can_always": true, "rules": ["Bash(npm test:*)"]
    });
    assert_eq!(serde_json::to_value(AgentEvent::from_host(req.clone())).unwrap(), req);
    assert!(matches!(AgentEvent::from_host(json!({"kind": "session_info"})), AgentEvent::SessionInfo { .. }));
  }

  #[test]
  fn tolerates_missing_optional_fields() {
    let ev = AgentEvent::from_host(json!({"kind": "system", "subtype": "init"}));
    assert_eq!(ev, AgentEvent::System { subtype: "init".into(), session_id: None, model: None });
    let ev = AgentEvent::from_host(json!({"kind": "result", "subtype": "success", "is_error": false}));
    assert!(matches!(ev, AgentEvent::Result { usage: None, total_cost_usd: None, .. }));
    let ev = AgentEvent::from_host(json!({"kind": "permission_request", "request_id": "r", "tool": "X", "input_summary": ""}));
    assert!(matches!(ev, AgentEvent::PermissionRequest { can_always: true, diff: None, .. }));
  }

  #[test]
  fn unknown_or_malformed_events_become_raw() {
    for v in [json!({"kind": "nope"}), json!({"kind": "message"}), json!("x"), json!({"no": "kind"})] {
      assert_eq!(AgentEvent::from_host(v.clone()), AgentEvent::Raw { line: v.to_string() });
    }
  }

  #[test]
  fn serializes_with_a_kind_tag() {
    let v = serde_json::to_value(AgentEvent::ToolUse { id: "1".into(), name: "Bash".into(), input: json!({}) }).unwrap();
    assert_eq!(v, json!({"kind":"tool_use","id":"1","name":"Bash","input":{}}));
    let v = serde_json::to_value(AgentEvent::Exit { code: Some(0), signal: None, stopped: false }).unwrap();
    assert_eq!(v, json!({"kind":"exit","code":0,"signal":null,"stopped":false}));
  }
}
