//! Normalized agent events, and the Claude Code `stream-json` adapter that produces them.

use serde_json::Value;

/// Sent to the webview over a channel, tagged by `kind`.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentEvent {
  /// Session start (`system`/`init`) or another system notice.
  System { subtype: String, session_id: Option<String>, model: Option<String> },
  Message { role: String, text: String },
  Thinking { text: String },
  ToolUse { id: String, name: String, input: Value },
  ToolResult { tool_use_id: String, content: String, is_error: bool },
  Result {
    subtype: String,
    is_error: bool,
    result: Option<String>,
    session_id: Option<String>,
    num_turns: Option<u64>,
    duration_ms: Option<u64>,
    total_cost_usd: Option<f64>,
  },
  /// A stdout line the adapter does not understand, passed through untouched.
  Raw { line: String },
  Stderr { line: String },
  Exit { code: Option<i32>, signal: Option<i32>, stopped: bool },
}

/// Tool results can be whole files; the timeline only needs a preview.
pub const MAX_TOOL_RESULT_CHARS: usize = 4000;

fn truncate(mut s: String, max: usize) -> String {
  if let Some((i, _)) = s.char_indices().nth(max) {
    s.truncate(i);
    s.push('…');
  }
  s
}

fn str_field(v: &Value, key: &str) -> Option<String> {
  v.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// `tool_result.content` is a string or a list of `{type:"text",text}` blocks.
fn content_text(v: &Value) -> String {
  match v {
    Value::String(s) => s.clone(),
    Value::Array(items) => items
      .iter()
      .map(|b| match b.get("text").and_then(Value::as_str) {
        Some(t) => t.to_owned(),
        None => b.to_string(),
      })
      .collect::<Vec<_>>()
      .join("\n"),
    Value::Null => String::new(),
    other => other.to_string(),
  }
}

fn content_blocks(v: &Value, role: &str, events: &mut Vec<AgentEvent>) -> bool {
  let Some(content) = v.pointer("/message/content") else {
    return false;
  };
  if let Some(text) = content.as_str() {
    events.push(AgentEvent::Message { role: role.to_owned(), text: text.to_owned() });
    return true;
  }
  let Some(blocks) = content.as_array() else {
    return false;
  };
  for b in blocks {
    let ev = match b.get("type").and_then(Value::as_str) {
      Some("text") => AgentEvent::Message { role: role.to_owned(), text: str_field(b, "text").unwrap_or_default() },
      Some("thinking") => AgentEvent::Thinking { text: str_field(b, "thinking").unwrap_or_default() },
      Some("tool_use") => AgentEvent::ToolUse {
        id: str_field(b, "id").unwrap_or_default(),
        name: str_field(b, "name").unwrap_or_default(),
        input: b.get("input").cloned().unwrap_or(Value::Null),
      },
      Some("tool_result") => AgentEvent::ToolResult {
        tool_use_id: str_field(b, "tool_use_id").unwrap_or_default(),
        content: truncate(content_text(b.get("content").unwrap_or(&Value::Null)), MAX_TOOL_RESULT_CHARS),
        is_error: b.get("is_error").and_then(Value::as_bool).unwrap_or(false),
      },
      _ => AgentEvent::Raw { line: b.to_string() },
    };
    events.push(ev);
  }
  true
}

/// Maps one line of `claude -p --output-format stream-json --verbose` to events.
/// Unknown or malformed lines become `Raw` rather than being dropped.
pub fn parse_claude_line(line: &str) -> Vec<AgentEvent> {
  let line = line.trim_end_matches(['\r', '\n']);
  if line.trim().is_empty() {
    return Vec::new();
  }
  let raw = || vec![AgentEvent::Raw { line: line.to_owned() }];
  let Ok(v) = serde_json::from_str::<Value>(line) else {
    return raw();
  };
  let mut events = Vec::new();
  let handled = match v.get("type").and_then(Value::as_str) {
    Some("system") => {
      events.push(AgentEvent::System {
        subtype: str_field(&v, "subtype").unwrap_or_default(),
        session_id: str_field(&v, "session_id"),
        model: str_field(&v, "model"),
      });
      true
    }
    Some("assistant") => content_blocks(&v, "assistant", &mut events),
    Some("user") => content_blocks(&v, "user", &mut events),
    Some("result") => {
      events.push(AgentEvent::Result {
        subtype: str_field(&v, "subtype").unwrap_or_default(),
        is_error: v.get("is_error").and_then(Value::as_bool).unwrap_or(false),
        result: str_field(&v, "result"),
        session_id: str_field(&v, "session_id"),
        num_turns: v.get("num_turns").and_then(Value::as_u64),
        duration_ms: v.get("duration_ms").and_then(Value::as_u64),
        total_cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
      });
      true
    }
    _ => false,
  };
  if handled { events } else { raw() }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  // Shapes as emitted by Claude Code's stream-json output (trimmed).
  const INIT: &str = r#"{"type":"system","subtype":"init","cwd":"/r/.kingu/worktrees/t","session_id":"s-1","tools":["Read","Bash"],"model":"claude-opus-5-5","permissionMode":"default"}"#;
  const ASSISTANT: &str = r#"{"type":"assistant","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5-5","content":[{"type":"text","text":"อ่านไฟล์ก่อนนะ"},{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"/r/README.md"}}],"stop_reason":null,"usage":{"input_tokens":3,"output_tokens":20}},"parent_tool_use_id":null,"session_id":"s-1"}"#;
  const TOOL_RESULT: &str = r##"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":[{"type":"text","text":"# Kingu"}]}]},"parent_tool_use_id":null,"session_id":"s-1"}"##;
  const RESULT: &str = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":4210,"duration_api_ms":3900,"num_turns":2,"result":"เสร็จแล้ว","session_id":"s-1","total_cost_usd":0.0123,"usage":{}}"#;

  #[test]
  fn maps_system_init() {
    assert_eq!(
      parse_claude_line(INIT),
      vec![AgentEvent::System {
        subtype: "init".into(),
        session_id: Some("s-1".into()),
        model: Some("claude-opus-5-5".into())
      }]
    );
  }

  #[test]
  fn maps_assistant_text_and_tool_use_blocks_in_order() {
    assert_eq!(
      parse_claude_line(ASSISTANT),
      vec![
        AgentEvent::Message { role: "assistant".into(), text: "อ่านไฟล์ก่อนนะ".into() },
        AgentEvent::ToolUse { id: "toolu_1".into(), name: "Read".into(), input: json!({"file_path": "/r/README.md"}) },
      ]
    );
  }

  #[test]
  fn maps_tool_results_with_string_or_block_content() {
    assert_eq!(
      parse_claude_line(TOOL_RESULT),
      vec![AgentEvent::ToolResult { tool_use_id: "toolu_1".into(), content: "# Kingu".into(), is_error: false }]
    );
    let err = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"denied","is_error":true}]}}"#;
    assert_eq!(
      parse_claude_line(err),
      vec![AgentEvent::ToolResult { tool_use_id: "t2".into(), content: "denied".into(), is_error: true }]
    );
  }

  #[test]
  fn truncates_huge_tool_results() {
    let big = "ก".repeat(MAX_TOOL_RESULT_CHARS + 10);
    let line = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":big}]}});
    let [AgentEvent::ToolResult { content, .. }] = &parse_claude_line(&line.to_string())[..] else { panic!() };
    assert_eq!(content.chars().count(), MAX_TOOL_RESULT_CHARS + 1);
  }

  #[test]
  fn maps_result() {
    let [AgentEvent::Result { subtype, is_error, result, num_turns, total_cost_usd, .. }] = &parse_claude_line(RESULT)[..]
    else {
      panic!()
    };
    assert_eq!((subtype.as_str(), *is_error, result.as_deref()), ("success", false, Some("เสร็จแล้ว")));
    assert_eq!((*num_turns, *total_cost_usd), (Some(2), Some(0.0123)));
  }

  #[test]
  fn passes_unknown_and_malformed_lines_through() {
    for line in [r#"{"type":"stream_event","event":{}}"#, "not json", r#"{"no":"type"}"#, r#"{"type":"assistant"}"#] {
      assert_eq!(parse_claude_line(line), vec![AgentEvent::Raw { line: line.into() }], "{line}");
    }
    let odd = r#"{"type":"assistant","message":{"content":[{"type":"server_tool_use","id":"x"}]}}"#;
    assert!(matches!(&parse_claude_line(odd)[..], [AgentEvent::Raw { line }] if line.contains("server_tool_use")));
    assert!(parse_claude_line("  \r\n").is_empty());
  }

  #[test]
  fn serializes_with_a_kind_tag() {
    let v = serde_json::to_value(AgentEvent::ToolUse { id: "1".into(), name: "Bash".into(), input: json!({}) }).unwrap();
    assert_eq!(v, json!({"kind":"tool_use","id":"1","name":"Bash","input":{}}));
    let v = serde_json::to_value(AgentEvent::Exit { code: Some(0), signal: None, stopped: false }).unwrap();
    assert_eq!(v["kind"], "exit");
  }
}
