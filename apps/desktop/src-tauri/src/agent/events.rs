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

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentEvent {
  /// Session start (`system`/`init`).
  System { subtype: String, session_id: Option<String>, model: Option<String> },
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
  },
  /// A permission request was answered (`allow`/`allow_always`/`deny`) or `cancelled`.
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
  fn guard_blocks_round_trip() {
    let ev = json!({"kind": "guard_blocked", "tool": "Bash", "tool_use_id": "tu1", "check": "security", "threats": ["rm_rf_root_bare"], "detail": "Recursive deletion of root filesystem"});
    assert!(matches!(AgentEvent::from_host(ev.clone()), AgentEvent::GuardBlocked { ref check, .. } if check == "security"));
    assert_eq!(serde_json::to_value(AgentEvent::from_host(ev.clone())).unwrap(), ev);
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
