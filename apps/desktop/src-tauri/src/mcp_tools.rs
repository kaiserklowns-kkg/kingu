//! MCP tools from the IDE: lists the tools of a stdio MCP server and calls one (the palette's
//! "MCP: Run Tool…", snaps/mcpTools.ts). Each operation starts the server with exactly the
//! command agents get (a Snap server through the sandbox launcher, with its secrets file),
//! speaks newline-delimited JSON-RPC 2.0 (`initialize`, `notifications/initialized`, then
//! `tools/list` or `tools/call`) and stops it again. Requests the server makes of the client are
//! answered (`ping`) or refused as unsupported; notifications (logs, progress) are ignored.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};

pub const PROTOCOL_VERSION: &str = "2025-06-18";
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const CALL_TIMEOUT: Duration = Duration::from_secs(300);
/// A single message line at most this long (tool results can be big, not unbounded).
const MAX_LINE: usize = 16 * 1024 * 1024;

/// One JSON-RPC exchange over any line transport: `send` writes a line, `recv` waits for one.
pub struct Session<S: FnMut(&str) -> Result<(), String>, R: FnMut(Duration) -> Result<Option<String>, String>> {
  send: S,
  recv: R,
  next: u64,
}

impl<S: FnMut(&str) -> Result<(), String>, R: FnMut(Duration) -> Result<Option<String>, String>> Session<S, R> {
  pub fn new(send: S, recv: R) -> Self {
    Self { send, recv, next: 1 }
  }

  fn write(&mut self, v: &Value) -> Result<(), String> {
    (self.send)(&v.to_string())
  }

  /// Sends `method` and waits (until `deadline`) for its response, answering what the server asks meanwhile.
  pub fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    let id = self.next;
    self.next += 1;
    self.write(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
    let deadline = Instant::now() + timeout;
    loop {
      let left = deadline.checked_duration_since(Instant::now()).ok_or_else(|| format!("{method}: no answer within {}s", timeout.as_secs()))?;
      let Some(line) = (self.recv)(left)? else { return Err(format!("{method}: the server exited")) };
      let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else { continue };
      // A request from the server (it has a method and an id).
      if let (Some(m), Some(rid)) = (msg.get("method").and_then(Value::as_str), msg.get("id")) {
        let reply = if m == "ping" { json!({ "jsonrpc": "2.0", "id": rid, "result": {} }) } else { json!({ "jsonrpc": "2.0", "id": rid, "error": { "code": -32601, "message": "not supported by Kingu's tool runner" } }) };
        self.write(&reply)?;
        continue;
      }
      if msg.get("id").and_then(Value::as_u64) != Some(id) {
        continue;
      }
      if let Some(err) = msg.get("error") {
        let text = err.get("message").and_then(Value::as_str).unwrap_or("error");
        return Err(format!("{method}: {text}"));
      }
      return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
    }
  }

  pub fn notify(&mut self, method: &str) -> Result<(), String> {
    self.write(&json!({ "jsonrpc": "2.0", "method": method }))
  }

  /// `initialize` + `notifications/initialized`; returns the server's info.
  pub fn initialize(&mut self) -> Result<Value, String> {
    let info = self.request(
      "initialize",
      json!({ "protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": { "name": "kingu", "version": env!("CARGO_PKG_VERSION") } }),
      LIST_TIMEOUT,
    )?;
    self.notify("notifications/initialized")?;
    Ok(info)
  }

  /// Every tool, following `nextCursor` pages (at most 50 of them).
  pub fn list_tools(&mut self) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..50 {
      let params = match &cursor {
        Some(c) => json!({ "cursor": c }),
        None => json!({}),
      };
      let page = self.request("tools/list", params, LIST_TIMEOUT)?;
      out.extend(page.get("tools").and_then(Value::as_array).cloned().unwrap_or_default());
      cursor = page.get("nextCursor").and_then(Value::as_str).map(String::from);
      if cursor.is_none() {
        break;
      }
    }
    Ok(out)
  }

  pub fn call_tool(&mut self, name: &str, arguments: Value) -> Result<Value, String> {
    self.request("tools/call", json!({ "name": name, "arguments": arguments }), CALL_TIMEOUT)
  }
}

/// A stdio server as agents get it (`McpServerSpec` of snapModel / mcp.ts).
#[derive(Deserialize, Debug, Clone)]
pub struct Spec {
  pub command: String,
  #[serde(default)]
  pub args: Vec<String>,
  #[serde(default)]
  pub env: BTreeMap<String, String>,
  /// The folder it runs in (the workspace root or task worktree).
  pub cwd: Option<String>,
}

/// Starts `spec`, runs `f` on an initialized session, then stops the server. The last stderr
/// lines go into an error (a server that fails to start usually says why there).
fn with_server<T>(spec: &Spec, f: impl FnOnce(&mut dyn FnMut(&str, Value, bool) -> Result<Value, String>) -> Result<T, String>) -> Result<T, String> {
  let mut cmd = Command::new(&spec.command);
  cmd.args(&spec.args).envs(&spec.env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
  if let Some(cwd) = spec.cwd.as_deref().filter(|c| !c.is_empty()) {
    cmd.current_dir(cwd);
  }
  let mut child = cmd.spawn().map_err(|e| format!("{}: {e}", spec.command))?;
  let mut stdin = child.stdin.take().ok_or("no stdin")?;
  let stdout = child.stdout.take().ok_or("no stdout")?;
  let stderr = child.stderr.take().ok_or("no stderr")?;
  let (tx, rx) = mpsc::channel::<String>();
  std::thread::spawn(move || {
    let mut reader = BufReader::new(stdout);
    loop {
      let mut line = String::new();
      match std::io::Read::take(&mut reader, MAX_LINE as u64).read_line(&mut line) {
        Ok(0) | Err(_) => break,
        Ok(_) => {
          if tx.send(line).is_err() {
            break;
          }
        }
      }
    }
  });
  let tail = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
  let tail_w = tail.clone();
  std::thread::spawn(move || {
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
      let mut t = tail_w.lock().unwrap_or_else(|e| e.into_inner());
      t.push(line);
      if t.len() > 20 {
        t.remove(0);
      }
    }
  });
  let send = |line: &str| -> Result<(), String> { writeln!(stdin, "{line}").and_then(|()| stdin.flush()).map_err(|e| format!("server input: {e}")) };
  let recv = |left: Duration| -> Result<Option<String>, String> {
    match rx.recv_timeout(left) {
      Ok(l) => Ok(Some(l)),
      Err(mpsc::RecvTimeoutError::Timeout) => Ok(Some(String::new())),
      Err(mpsc::RecvTimeoutError::Disconnected) => Ok(None),
    }
  };
  let mut session = Session::new(send, recv);
  let result = session.initialize().and_then(|_| {
    let mut op = |method: &str, params: Value, call: bool| -> Result<Value, String> {
      if call {
        session.call_tool(method, params)
      } else {
        session.list_tools().map(Value::from)
      }
    };
    f(&mut op)
  });
  drop(session);
  let _ = child.kill();
  let _ = child.wait();
  result.map_err(|e| {
    let t = tail.lock().map(|t| t.join("\n")).unwrap_or_default();
    if t.trim().is_empty() { e } else { format!("{e}\n{t}") }
  })
}

#[tauri::command]
pub async fn mcp_tools_list(spec: Spec) -> Result<Vec<Value>, String> {
  crate::snap_install::blocking(move || with_server(&spec, |op| op("", Value::Null, false).map(|v| v.as_array().cloned().unwrap_or_default()))).await
}

#[tauri::command]
pub async fn mcp_tool_call(spec: Spec, tool: String, arguments: Value) -> Result<Value, String> {
  if !arguments.is_object() {
    return Err("tool arguments must be a JSON object".into());
  }
  crate::snap_install::blocking(move || with_server(&spec, |op| op(&tool, arguments, true))).await
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::VecDeque;
  use std::sync::{Arc, Mutex};

  /// A scripted server: replies to each request by method; can interleave its own messages.
  fn scripted(extra_before: Vec<Value>) -> (Arc<Mutex<Vec<Value>>>, impl FnMut(&str) -> Result<(), String>, impl FnMut(Duration) -> Result<Option<String>, String>) {
    let sent = Arc::new(Mutex::new(Vec::<Value>::new()));
    let queue = Arc::new(Mutex::new(VecDeque::<String>::new()));
    let (s2, q2) = (sent.clone(), queue.clone());
    let mut extra = Some(extra_before);
    let send = move |line: &str| {
      let msg: Value = serde_json::from_str(line).unwrap();
      s2.lock().unwrap().push(msg.clone());
      let mut q = q2.lock().unwrap();
      let Some(id) = msg.get("id").cloned() else { return Ok(()) };
      let result = match msg["method"].as_str() {
        Some("initialize") => json!({ "protocolVersion": PROTOCOL_VERSION, "serverInfo": { "name": "t" } }),
        Some("tools/list") if msg["params"]["cursor"].is_null() => json!({ "tools": [{ "name": "query" }], "nextCursor": "p2" }),
        Some("tools/list") => json!({ "tools": [{ "name": "explain" }] }),
        Some("tools/call") if msg["params"]["name"] == "boom" => {
          q.push_back(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -1, "message": "bad sql" } }).to_string());
          return Ok(());
        }
        Some("tools/call") => {
          for e in extra.take().unwrap_or_default() {
            q.push_back(e.to_string());
          }
          json!({ "content": [{ "type": "text", "text": format!("ran {}", msg["params"]["arguments"]) }] })
        }
        _ => return Ok(()), // replies to our answers
      };
      q.push_back(json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string());
      Ok(())
    };
    let recv = move |_: Duration| Ok(queue.lock().unwrap().pop_front());
    (sent, send, recv)
  }

  #[test]
  fn lists_every_page_and_calls_a_tool() {
    let (sent, send, recv) = scripted(vec![json!({ "jsonrpc": "2.0", "method": "notifications/message", "params": {} }), json!({ "jsonrpc": "2.0", "id": 99, "method": "ping" }), json!({ "jsonrpc": "2.0", "id": "x", "method": "roots/list" })]);
    let mut s = Session::new(send, recv);
    s.initialize().unwrap();
    let tools = s.list_tools().unwrap();
    assert_eq!(tools.iter().map(|t| t["name"].as_str().unwrap()).collect::<Vec<_>>(), ["query", "explain"]);
    let r = s.call_tool("query", json!({ "sql": "select 1" })).unwrap();
    assert_eq!(r["content"][0]["text"], "ran {\"sql\":\"select 1\"}");
    assert!(s.call_tool("boom", json!({})).unwrap_err().contains("bad sql"));
    let sent = sent.lock().unwrap();
    assert_eq!(sent[0]["method"], "initialize");
    assert_eq!(sent[0]["params"]["protocolVersion"], PROTOCOL_VERSION);
    assert_eq!(sent[1], json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
    // The server's ping got an answer, roots/list a refusal.
    assert!(sent.iter().any(|m| m["id"] == 99 && m["result"] == json!({})));
    assert!(sent.iter().any(|m| m["id"] == "x" && m["error"]["code"] == -32601));
  }

  #[test]
  fn a_server_that_exits_or_stalls_is_an_error() {
    let mut s = Session::new(|_: &str| Ok(()), |_: Duration| Ok(None));
    assert!(s.initialize().unwrap_err().contains("exited"));
    let mut s = Session::new(|_: &str| Ok(()), |_: Duration| Ok(Some(String::new())));
    assert!(s.request("tools/list", json!({}), Duration::from_millis(20)).unwrap_err().contains("no answer"));
  }

  /// A real process speaking the protocol: a shell script that answers by request number.
  #[cfg(unix)]
  #[test]
  fn talks_to_a_stdio_process() {
    let script = r#"read a; echo '{"jsonrpc":"2.0","id":1,"result":{}}'; read b; read c; echo "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"$KINGU_T\"}]}}"; sleep 5"#;
    let spec = Spec { command: "/bin/sh".into(), args: vec!["-c".into(), script.into()], env: BTreeMap::from([("KINGU_T".to_string(), "echo".to_string())]), cwd: None };
    let tools = with_server(&spec, |op| op("", Value::Null, false)).unwrap();
    assert_eq!(tools[0]["name"], "echo");
    let missing = Spec { command: "/nonexistent/mcp".into(), args: vec![], env: BTreeMap::new(), cwd: None };
    assert!(with_server(&missing, |op| op("", Value::Null, false)).is_err());
  }
}
