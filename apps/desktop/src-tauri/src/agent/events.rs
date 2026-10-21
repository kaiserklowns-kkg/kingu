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

/// An MCP server of the live session now: its status, error line, where it came from and its tools.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct McpServerLive {
  pub name: String,
  #[serde(default)]
  pub status: String,
  #[serde(default)]
  pub error: Option<String>,
  #[serde(default)]
  pub source: Option<String>,
  #[serde(default)]
  pub tools: Vec<String>,
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

/// A model the session can use (SDK `supportedModels()`), for the chat's model picker.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ModelOption {
  pub value: String,
  #[serde(default)]
  pub display_name: String,
  #[serde(default)]
  pub description: String,
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
  /// The session's MCP servers as they are now (after the start and each turn); replaces the last list.
  McpStatus {
    #[serde(default)]
    servers: Vec<McpServerLive>,
  },
  /// The session's slash commands with descriptions; replaces the last list.
  Commands { commands: Vec<SlashCommand> },
  /// The models the session can switch to; replaces the last list.
  Models { models: Vec<ModelOption> },
  /// How full the context window is after a turn.
  ContextUsage { used_tokens: u64, max_tokens: u64 },
  /// `parent_tool_use_id` (also on `Thinking`, `ToolUse`, `ToolResult`): set on a subagent's own
  /// events, the id of the Task/Agent call that started it (the chat nests them under that call).
  Message {
    role: String,
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_tool_use_id: Option<String>,
  },
  /// Streaming chunk of the main agent's text or thinking (`block`); the full `Message`/`Thinking` follows.
  Delta { block: String, text: String },
  Thinking {
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_tool_use_id: Option<String>,
  },
  ToolUse {
    id: String,
    name: String,
    #[serde(default)]
    input: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_tool_use_id: Option<String>,
  },
  ToolResult {
    tool_use_id: String,
    content: String,
    #[serde(default)]
    is_error: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_tool_use_id: Option<String>,
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
  /// Kingu's safety check refused a tool call (the host's guards, in every permission mode):
  /// `check` is `security` (a catastrophic shell command; `threats` are goose pattern names,
  /// `detail` their descriptions) or `repetition` (the third identical call in a row).
  GuardBlocked {
    tool: String,
    #[serde(default)]
    tool_use_id: Option<String>,
    check: String,
    #[serde(default)]
    threats: Vec<String>,
    #[serde(default)]
    detail: String,
  },
  /// Kingu's always-ask check stopped a tool call for the user (the host's guards, in every
  /// permission mode); the `PermissionRequest` with this `request_id` follows. `check`:
  /// `outside_cwd`, `delete`, `protected` or `mcp`; `paths`: what it is about.
  GuardAsked {
    request_id: String,
    tool: String,
    #[serde(default)]
    tool_use_id: Option<String>,
    check: String,
    #[serde(default)]
    paths: Vec<String>,
  },
  /// The agent published an artifact (the host's `artifact_publish` tool, through artifacts/):
  /// version `version` of artifact `id` in project `root`. The chat shows a card that opens it.
  Artifact { id: String, title: String, version: u32, format: String, root: String },
  /// An MCP server asks the user (the host's mcpAsks.ts): `type` `elicitation` (a form from
  /// `schema`, or in `url` mode a page to open) or `sampling` (leave to make a model call;
  /// `sampling` is what it would send). Answer with `agent_answer_mcp`; cancelled after `timeout_ms`.
  McpRequest {
    request_id: String,
    #[serde(rename = "type")]
    ask: String,
    server: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    schema: Option<Value>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    sampling: Option<Value>,
    #[serde(default)]
    timeout_ms: u64,
  },
  /// An `McpRequest` was answered or cancelled (`accept`, `decline`, `cancel`).
  McpRequestResolved { request_id: String, action: String },
  /// Added by the webview (`chat_feedback`): the user's thumbs up (`up`) or down (`down`) on the
  /// answer to chat request `request`, or none (`vote` null: taken back). Kept in the transcript.
  Feedback {
    request: u32,
    #[serde(default)]
    vote: Option<String>,
  },
  /// The agent session's uuid of the SDK message whose events came just before (the host's
  /// `anchor`). Kept in a chat's transcript (its rewind points: `rewind::Anchors`), never passed
  /// to the webview.
  Anchor { uuid: String },
  /// Added by Rust after a chat's user message: that message is request `request` of the chat,
  /// the checkpoint "Restore checkpoint" goes back to. Kept in the transcript. `session_id` and
  /// `resume_at`: where the conversation before this request ends (the last `Anchor` before it
  /// and its session); none for a chat's first request.
  Checkpoint {
    request: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resume_at: Option<String>,
  },
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
  fn artifacts_round_trip() {
    let ev = json!({"kind": "artifact", "id": "0123456789abcdef", "title": "รายงาน", "version": 2, "format": "html", "root": "/repo"});
    let parsed = AgentEvent::from_host(ev.clone());
    assert!(matches!(&parsed, AgentEvent::Artifact { id, version: 2, .. } if id == "0123456789abcdef"));
    assert_eq!(serde_json::to_value(&parsed).unwrap(), ev);
  }

  #[test]
  fn mcp_requests_round_trip() {
    for v in [
      json!({"kind": "mcp_request", "request_id": "r1", "type": "elicitation", "server": "tickets", "message": "New ticket", "mode": "form",
        "schema": {"type": "object", "properties": {"title": {"type": "string"}}}, "url": null, "sampling": null, "timeout_ms": 600000}),
      json!({"kind": "mcp_request", "request_id": "r2", "type": "sampling", "server": "web", "message": "", "mode": null, "schema": null, "url": null,
        "sampling": {"messages": [{"role": "user", "text": "hi"}], "system_prompt": null, "max_tokens": 50}, "timeout_ms": 600000}),
      json!({"kind": "mcp_request_resolved", "request_id": "r1", "action": "accept"}),
    ] {
      assert_eq!(serde_json::to_value(AgentEvent::from_host(v.clone())).unwrap(), v);
    }
    assert!(matches!(AgentEvent::from_host(json!({"kind": "mcp_request", "request_id": "r", "type": "elicitation", "server": "s"})), AgentEvent::McpRequest { timeout_ms: 0, .. }));
  }

  #[test]
  fn guard_blocks_round_trip() {
    let ev = json!({"kind": "guard_blocked", "tool": "Bash", "tool_use_id": "tu1", "check": "security", "threats": ["rm_rf_root_bare"], "detail": "Recursive deletion of root filesystem"});
    assert!(matches!(AgentEvent::from_host(ev.clone()), AgentEvent::GuardBlocked { ref check, .. } if check == "security"));
    assert_eq!(serde_json::to_value(AgentEvent::from_host(ev.clone())).unwrap(), ev);
  }

  #[test]
  fn guard_asks_and_feedback_round_trip() {
    for v in [
      json!({"kind": "guard_asked", "request_id": "r1", "tool": "Bash", "tool_use_id": "tu1", "check": "delete", "paths": ["a.txt"]}),
      json!({"kind": "feedback", "request": 2, "vote": "up"}),
      json!({"kind": "feedback", "request": 2, "vote": null}),
    ] {
      assert_eq!(serde_json::to_value(AgentEvent::from_host(v.clone())).unwrap(), v);
    }
  }

  #[test]
  fn round_trips_session_commands_and_context() {
    for v in [
      json!({"kind": "session_info", "slash_commands": ["compact"], "tools": ["Bash"], "mcp_servers": [{"name": "gh", "status": "connected"}]}),
      json!({"kind": "commands", "commands": [{"name": "review", "description": "Review a PR", "argument_hint": "<pr>"}]}),
      json!({"kind": "context_usage", "used_tokens": 1200, "max_tokens": 200000}),
      json!({"kind": "models", "models": [{"value": "opus", "display_name": "Opus", "description": "Most capable"}]}),
      json!({"kind": "mcp_status", "servers": [{"name": "gh", "status": "failed", "error": "spawn gh ENOENT", "source": "user", "tools": ["search"]}]}),
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
  fn keeps_a_subagents_parent_call() {
    for v in [
      json!({"kind": "tool_use", "id": "t2", "name": "Grep", "input": {"pattern": "x"}, "parent_tool_use_id": "task-1"}),
      json!({"kind": "tool_result", "tool_use_id": "t2", "content": "a.ts:1", "is_error": false, "parent_tool_use_id": "task-1"}),
      json!({"kind": "message", "role": "assistant", "text": "พบแล้ว", "parent_tool_use_id": "task-1"}),
      json!({"kind": "thinking", "text": "hm", "parent_tool_use_id": "task-1"}),
    ] {
      assert_eq!(serde_json::to_value(AgentEvent::from_host(v.clone())).unwrap(), v);
    }
    let ev = AgentEvent::from_host(json!({"kind": "message", "role": "assistant", "text": "hi"}));
    assert!(matches!(ev, AgentEvent::Message { parent_tool_use_id: None, .. }));
  }

  #[test]
  fn unknown_or_malformed_events_become_raw() {
    for v in [json!({"kind": "nope"}), json!({"kind": "message"}), json!("x"), json!({"no": "kind"})] {
      assert_eq!(AgentEvent::from_host(v.clone()), AgentEvent::Raw { line: v.to_string() });
    }
  }

  #[test]
  fn serializes_with_a_kind_tag() {
    let v = serde_json::to_value(AgentEvent::ToolUse { id: "1".into(), name: "Bash".into(), input: json!({}), parent_tool_use_id: None }).unwrap();
    assert_eq!(v, json!({"kind":"tool_use","id":"1","name":"Bash","input":{}}));
    let v = serde_json::to_value(AgentEvent::Exit { code: Some(0), signal: None, stopped: false }).unwrap();
    assert_eq!(v, json!({"kind":"exit","code":0,"signal":null,"stopped":false}));
  }
}
