//! MCP client features of the chat, through the agent host (apps/agent-host mcpAsks.ts,
//! mcpQuery.ts):
//!
//! - `agent_answer_mcp`: the user's answer to an MCP server's form (elicitation) or sampling
//!   request (`AgentEvent::McpRequest`).
//! - `agent_mcp_query`: a server's resources, resource templates and prompts, one resource's
//!   content, or a rendered prompt (Add Context's MCP resources, `/mcp.<server>.<prompt>`).
//! - [`sampling_policy`]: VS Code's `chat.mcp.serverSampling` from the user's settings, sent with
//!   every run as the host's `mcpSampling`: a server allowed (or refused) during chat is not asked.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use serde_json::{Value, json};
use tauri::State;

use super::host::{AgentHost, McpServer, valid_mcp_name};

/// VS Code's per-server sampling setting: `{ "<server>": { "allowedDuringChat": bool, … } }`.
pub const SAMPLING_SETTING: &str = "chat.mcp.serverSampling";
const MAX_URI: usize = 8192;
const MAX_ARGS: usize = 50;
const MAX_ARG: usize = 64 * 1024;

/// Server name → whether it may make model calls during a chat, from the user's settings.
/// VS Code keys the setting `"<collection>: <server>"`; the server part is used (Kingu's names
/// are unique per run). Entries without a boolean `allowedDuringChat` are left out (asked).
pub fn sampling_policy(config: &Path) -> BTreeMap<String, bool> {
  policy_of(crate::settings::user_value(config, SAMPLING_SETTING))
}

fn policy_of(v: Option<Value>) -> BTreeMap<String, bool> {
  let Some(Value::Object(map)) = v else { return BTreeMap::new() };
  map
    .into_iter()
    .filter_map(|(key, entry)| {
      let name = key.rsplit(": ").next().unwrap_or(&key).trim().to_owned();
      let allowed = entry.get("allowedDuringChat")?.as_bool()?;
      valid_mcp_name(&name).then_some((name, allowed))
    })
    .collect()
}

/// Answers an `mcp_request` (see `AgentHost::answer_mcp`).
#[tauri::command]
pub async fn agent_answer_mcp(
  agents: State<'_, Arc<AgentHost>>,
  run_id: u32,
  request_id: String,
  action: String,
  content: Option<Value>,
  remember: Option<String>,
) -> Result<(), String> {
  let agents = agents.inner().clone();
  tauri::async_runtime::spawn_blocking(move || agents.answer_mcp(run_id, &request_id, &action, content.as_ref(), remember.as_deref())).await.map_err(|e| e.to_string())?
}

/// The query's own params: `op` and what it needs.
fn query_params(cwd: &str, op: &str, uri: Option<&str>, prompt: Option<&str>, arguments: Option<&BTreeMap<String, String>>) -> Result<Value, String> {
  if !Path::new(cwd).is_absolute() {
    return Err("cwd must be an absolute path".into());
  }
  let mut params = json!({ "cwd": cwd, "op": op });
  match op {
    "list" => {}
    "read" => {
      let uri = uri.filter(|u| !u.is_empty() && u.len() <= MAX_URI && !u.contains(['\0', '\n'])).ok_or("uri is empty")?;
      params["uri"] = json!(uri);
    }
    "prompt" => {
      params["prompt"] = json!(prompt.filter(|p| !p.is_empty()).ok_or("prompt is empty")?);
      let args = arguments.cloned().unwrap_or_default();
      if args.len() > MAX_ARGS || args.values().any(|v| v.len() > MAX_ARG) {
        return Err("too many or too long prompt arguments".into());
      }
      params["arguments"] = json!(args);
    }
    _ => return Err(format!("{op}: unknown query")),
  }
  Ok(params)
}

/// `op`: `list` (resources, templates, prompts), `read` (`uri`) or `prompt` (`prompt` with
/// `arguments`). `server` is the configuration runs get (checked like theirs); `run_id`: the
/// chat's live run, whose connection to the server is used when it has one (Arkai).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_mcp_query(
  agents: State<'_, Arc<AgentHost>>,
  run_id: Option<u32>,
  cwd: String,
  name: String,
  server: McpServer,
  op: String,
  uri: Option<String>,
  prompt: Option<String>,
  arguments: Option<BTreeMap<String, String>>,
) -> Result<Value, String> {
  let params = query_params(&cwd, &op, uri.as_deref(), prompt.as_deref(), arguments.as_ref())?;
  let agents = agents.inner().clone();
  tauri::async_runtime::spawn_blocking(move || agents.mcp_query(run_id, &name, &server, params)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn sampling_policy_from_vscode_shaped_settings() {
    let v = json!({
      "User: github": { "allowedDuringChat": true, "allowedModels": ["x"] },
      "notes": { "allowedDuringChat": false },
      "Workspace: undecided": { "allowedOutsideChat": true },
      "bad name!": { "allowedDuringChat": true },
      "odd": "yes"
    });
    assert_eq!(policy_of(Some(v)), BTreeMap::from([("github".to_owned(), true), ("notes".to_owned(), false)]));
    assert!(policy_of(Some(json!([1]))).is_empty());
    assert!(policy_of(None).is_empty());

    let config = tempfile::tempdir().unwrap();
    std::fs::write(crate::settings::user_path(config.path()), r#"{ "chat.mcp.serverSampling": { "db": { "allowedDuringChat": true } } }"#).unwrap();
    assert_eq!(sampling_policy(config.path()), BTreeMap::from([("db".to_owned(), true)]));
  }

  #[test]
  fn query_params_per_op() {
    assert_eq!(query_params("/w", "list", None, None, None).unwrap(), json!({"cwd": "/w", "op": "list"}));
    assert_eq!(query_params("/w", "read", Some("memo://a"), None, None).unwrap()["uri"], "memo://a");
    assert!(query_params("/w", "read", None, None, None).is_err());
    let args = BTreeMap::from([("file".to_owned(), "a.ts".to_owned())]);
    assert_eq!(query_params("/w", "prompt", None, Some("review"), Some(&args)).unwrap()["arguments"], json!({"file": "a.ts"}));
    assert!(query_params("/w", "prompt", None, None, None).is_err());
    assert!(query_params("w", "list", None, None, None).is_err());
    assert!(query_params("/w", "call", None, None, None).is_err());
  }
}
