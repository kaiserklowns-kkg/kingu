//! The command's side: a parsed command → one request, sent over the app's socket; the answer
//! printed for a person (or as JSON with `--json`).

use std::path::Path;

use serde_json::{Value, json};

use crate::args::Command;
use crate::i18n::{Msg, tr};
use crate::protocol::{self, Request, Response};

/// Exit codes: the app refused or failed; bad usage; the app is not running or unreachable.
pub const EXIT_FAILED: i32 = 1;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_UNAVAILABLE: i32 = 3;

/// Bigger prompts are refused here (the app keeps prompts under 64 KB).
pub const MAX_PROMPT: usize = 64 * 1024;

/// The method and params for `cmd`; `prompt` is the text read from stdin for `--prompt -`.
/// Relative paths are made absolute against `cwd`. None for commands handled locally.
pub fn request_of(cmd: &Command, cwd: &Path, stdin_prompt: Option<String>) -> Result<Option<(&'static str, Value)>, String> {
  Ok(Some(match cmd {
    Command::Help | Command::Version => return Ok(None),
    Command::Status => (protocol::METHOD_STATUS, json!({})),
    Command::TaskList => (protocol::METHOD_TASK_LIST, json!({})),
    Command::TaskCreate { title, prompt, base, mode, background } => {
      let prompt = match prompt.as_deref() {
        Some("-") => stdin_prompt.unwrap_or_default(),
        Some(p) => p.to_owned(),
        None => String::new(),
      };
      if prompt.len() > MAX_PROMPT {
        return Err(tr(Msg::PromptTooLarge, &[("kb", &(MAX_PROMPT / 1024))]));
      }
      (protocol::METHOD_TASK_CREATE, json!({ "title": title, "prompt": prompt, "base": base, "mode": mode, "open": !background }))
    }
    Command::TaskOpen { slug } => (protocol::METHOD_TASK_OPEN, json!({ "slug": slug })),
    Command::Open { path, line, column } => {
      let p = Path::new(path);
      let abs = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
      (protocol::METHOD_OPEN, json!({ "path": abs.display().to_string(), "line": line, "column": column }))
    }
    Command::Notify { message, title } => (protocol::METHOD_NOTIFY, json!({ "message": message, "title": title })),
  }))
}

/// What a person sees for a successful answer.
pub fn render(method: &str, result: &Value) -> String {
  match method {
    protocol::METHOD_STATUS => {
      let mut out = format!("Kingu {} (pid {})", result["app_version"].as_str().unwrap_or("?"), result["pid"].as_u64().unwrap_or(0));
      match result["workspace"].as_str() {
        Some(w) => out.push_str(&format!("\n{}", tr(Msg::StatusFolder, &[("folder", &w), ("tasks", &result["tasks"].as_u64().unwrap_or(0))]))),
        None => out.push_str(&format!("\n{}", tr(Msg::NoFolder, &[]))),
      }
      out
    }
    protocol::METHOD_TASK_LIST => {
      let rows: Vec<String> = result["tasks"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|t| format!("{}\t{}\t{}", t["slug"].as_str().unwrap_or(""), t["status"].as_str().unwrap_or(""), t["title"].as_str().unwrap_or("")))
        .collect();
      if rows.is_empty() { tr(Msg::NoTasks, &[]) } else { rows.join("\n") }
    }
    protocol::METHOD_TASK_CREATE => result["slug"].as_str().unwrap_or("").to_owned(),
    _ => String::new(),
  }
}

/// Sends one request over the app's socket and reads its answer.
#[cfg(unix)]
pub fn call(socket: &Path, token: &str, method: &str, params: Value) -> Result<Response, (i32, String)> {
  use std::io::{BufRead, BufReader, Read, Write};
  use std::os::unix::net::UnixStream;
  use std::time::Duration;
  let mut stream = UnixStream::connect(socket).map_err(|e| (EXIT_UNAVAILABLE, tr(Msg::NotReachable, &[("socket", &socket.display()), ("detail", &e)])))?;
  // Starting a task waits for the window (the app gives it 30 s).
  let _ = stream.set_read_timeout(Some(Duration::from_secs(90)));
  let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
  let req = Request { id: 1, auth_token: token.to_owned(), method: method.to_owned(), params };
  stream.write_all(protocol::encode(&req).as_bytes()).map_err(|e| (EXIT_UNAVAILABLE, tr(Msg::SendFailed, &[("detail", &e)])))?;
  let mut line = String::new();
  BufReader::new(stream.take(protocol::MAX_LINE as u64 + 1)).read_line(&mut line).map_err(|e| (EXIT_UNAVAILABLE, tr(Msg::NoAnswer, &[("detail", &e)])))?;
  if line.is_empty() {
    return Err((EXIT_UNAVAILABLE, tr(Msg::ClosedWithoutAnswer, &[])));
  }
  protocol::decode_response(&line).map_err(|e| (EXIT_FAILED, e))
}

#[cfg(not(unix))]
pub fn call(_socket: &Path, _token: &str, _method: &str, _params: Value) -> Result<Response, (i32, String)> {
  Err((EXIT_UNAVAILABLE, tr(Msg::Unsupported, &[])))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn builds_requests_with_absolute_paths_and_stdin_prompts() {
    let cwd = Path::new("/repo");
    let open = Command::Open { path: "src/a.ts".into(), line: Some(3), column: None };
    let (m, p) = request_of(&open, cwd, None).unwrap().unwrap();
    assert_eq!((m, p), (protocol::METHOD_OPEN, json!({ "path": "/repo/src/a.ts", "line": 3, "column": null })));
    let (_, p) = request_of(&Command::Open { path: "/etc/x".into(), line: None, column: None }, cwd, None).unwrap().unwrap();
    assert_eq!(p["path"], "/etc/x");
    let create = Command::TaskCreate { title: "Fix".into(), prompt: Some("-".into()), base: None, mode: Some("terminal".into()), background: true };
    let (m, p) = request_of(&create, cwd, Some("from stdin".into())).unwrap().unwrap();
    assert_eq!((m, p), (protocol::METHOD_TASK_CREATE, json!({ "title": "Fix", "prompt": "from stdin", "base": null, "mode": "terminal", "open": false })));
    let big = Command::TaskCreate { title: "x".into(), prompt: Some("a".repeat(MAX_PROMPT + 1)), base: None, mode: None, background: false };
    assert!(request_of(&big, cwd, None).is_err());
    assert!(request_of(&Command::Help, cwd, None).unwrap().is_none());
    let (m, p) = request_of(&Command::Notify { message: "done".into(), title: None }, cwd, None).unwrap().unwrap();
    assert_eq!((m, p), (protocol::METHOD_NOTIFY, json!({ "message": "done", "title": null })));
  }

  #[test]
  fn renders_answers_for_people() {
    let status = json!({ "app_version": "0.1.0", "pid": 9, "workspace": "/repo", "tasks": 2 });
    assert_eq!(render(protocol::METHOD_STATUS, &status), "Kingu 0.1.0 (pid 9)\nfolder: /repo\ntasks: 2");
    assert!(render(protocol::METHOD_STATUS, &json!({ "app_version": "0.1.0", "pid": 9, "workspace": null })).ends_with("no folder open"));
    let list = json!({ "tasks": [{ "slug": "fix-login", "status": "running", "title": "Fix login" }] });
    assert_eq!(render(protocol::METHOD_TASK_LIST, &list), "fix-login\trunning\tFix login");
    assert_eq!(render(protocol::METHOD_TASK_LIST, &json!({ "tasks": [] })), "no tasks");
    assert_eq!(render(protocol::METHOD_TASK_CREATE, &json!({ "slug": "fix" })), "fix");
    assert_eq!(render(protocol::METHOD_NOTIFY, &json!(null)), "");
  }

  #[cfg(unix)]
  #[test]
  fn talks_to_a_server_over_a_unix_socket() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;
    let tmp = tempfile::tempdir().unwrap();
    let sock = tmp.path().join("s.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let token = protocol::new_token().unwrap();
    let server_token = token.clone();
    let server = std::thread::spawn(move || {
      for _ in 0..2 {
        let (stream, _) = listener.accept().unwrap();
        let mut line = String::new();
        BufReader::new(stream.try_clone().unwrap()).read_line(&mut line).unwrap();
        let res = protocol::handle_line(&line, &server_token, |r| Ok(json!({ "echo": r.params })));
        (&stream).write_all(protocol::encode(&res).as_bytes()).unwrap();
      }
    });
    let ok = call(&sock, &token, "status", json!({ "a": 1 })).unwrap();
    assert_eq!((ok.ok, ok.result), (true, Some(json!({ "echo": { "a": 1 } }))));
    let refused = call(&sock, "nope", "status", json!({})).unwrap();
    assert_eq!(refused.error.unwrap().code, protocol::ERR_UNAUTHORIZED);
    server.join().unwrap();
    let (code, _) = call(&tmp.path().join("missing.sock"), &token, "status", json!({})).unwrap_err();
    assert_eq!(code, EXIT_UNAVAILABLE);
  }
}
