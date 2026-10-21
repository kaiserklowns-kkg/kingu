//! The command's side: a parsed command → one request, sent over the app's socket; the answer
//! printed for a person (or as JSON with `--json`).

use std::path::{Path, PathBuf};

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
      // `cwd`: the app picks the window, and a caller inside a task's worktree dispatches a sub-task.
      (protocol::METHOD_TASK_CREATE, json!({ "title": title, "prompt": prompt, "base": base, "mode": mode, "open": !background, "cwd": cwd.display().to_string() }))
    }
    Command::TaskOpen { slug } => (protocol::METHOD_TASK_OPEN, json!({ "slug": slug })),
    Command::Open { path, line, column } => {
      let p = Path::new(path);
      let abs = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
      (protocol::METHOD_OPEN, json!({ "path": abs.display().to_string(), "line": line, "column": column }))
    }
    Command::Notify { message, title } => (protocol::METHOD_NOTIFY, json!({ "message": message, "title": title })),
    Command::ArtifactPublish { file, title, description, assets, id } => {
      let entry = absolute(cwd, file);
      let folder = entry.parent().unwrap_or(cwd).to_path_buf();
      let assets: Vec<Value> = assets
        .iter()
        .map(|(path, name)| {
          let abs = absolute(cwd, path);
          let name = name.clone().unwrap_or_else(|| asset_name(&folder, &abs));
          json!({ "path": abs.display().to_string(), "name": name })
        })
        .collect();
      (
        protocol::METHOD_ARTIFACT_PUBLISH,
        json!({
          "cwd": cwd.display().to_string(),
          "file": entry.display().to_string(),
          "title": title,
          "description": description,
          "assets": assets,
          "id": id,
          "source": "cli",
        }),
      )
    }
    Command::ArtifactList => (protocol::METHOD_ARTIFACT_LIST, json!({ "cwd": cwd.display().to_string() })),
    // The login runs first (`main`), then `account_add_request` registers it.
    Command::AccountAdd { .. } => return Ok(None),
    Command::AccountList { agent } => (protocol::METHOD_ACCOUNT_LIST_DATA, json!({ "provider": agent })),
    Command::AccountSelect { agent, account } => (protocol::METHOD_ACCOUNT_SELECT_DATA, json!({ "provider": agent, "accountId": account })),
    Command::AccountRemove { agent, account } => (protocol::METHOD_ACCOUNT_REMOVE_DATA, json!({ "provider": agent, "accountId": account })),
  }))
}

fn absolute(cwd: &Path, path: &str) -> PathBuf {
  let p = Path::new(path);
  if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) }
}

/// An asset's name inside the artifact: its path below the entry file's folder (with `/`), else
/// its file name. Lexical only (`a/../b` stays as typed; the app checks names).
pub fn asset_name(folder: &Path, asset: &Path) -> String {
  match asset.strip_prefix(folder) {
    Ok(rel) if !rel.as_os_str().is_empty() => rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"),
    _ => asset.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
  }
}

/// Registers a login `kingu account add` saved under `source_data_home` (an XDG data home).
pub fn account_add_request(agent: &str, label: Option<&str>, source_data_home: &Path) -> (&'static str, Value) {
  let label = label.map(str::to_owned).unwrap_or_else(|| if agent == "devin" { "Devin".into() } else { "OpenCode".into() });
  (protocol::METHOD_ACCOUNT_ADD_DATA, json!({ "provider": agent, "sourceDataHome": source_data_home.display().to_string(), "label": label }))
}

/// A managed-accounts answer (`{opencode: State, devin: State}`, either may be missing) as text.
fn render_data_accounts(result: &Value) -> String {
  let mut blocks = Vec::new();
  for (key, title) in [("opencode", "OpenCode"), ("devin", "Devin")] {
    let Some(state) = result.get(key).filter(|v| v.is_object()) else { continue };
    let accounts = state["accounts"].as_array().map(Vec::as_slice).unwrap_or_default();
    let active = state["activeAccountId"].as_str();
    let mark = |on: bool| if on { format!(" {}", tr(Msg::ActiveMark, &[])) } else { String::new() };
    let mut lines = vec![if accounts.is_empty() { tr(Msg::NoManaged, &[("provider", &title)]) } else { tr(Msg::ManagedHeader, &[("provider", &title), ("count", &accounts.len())]) }];
    lines.push(format!("  system  {}{}", tr(Msg::SystemDefault, &[]), mark(active.is_none())));
    for a in accounts {
      let id = a["id"].as_str().unwrap_or("");
      lines.push(format!("  {id}  {}{}", a["label"].as_str().unwrap_or(""), mark(active == Some(id))));
    }
    blocks.push(lines.join("\n"));
  }
  blocks.join("\n\n")
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
    protocol::METHOD_ARTIFACT_PUBLISH => {
      let version = result["version"].as_u64().unwrap_or(0).to_string();
      let head = tr(Msg::ArtifactPublished, &[("title", &result["title"].as_str().unwrap_or("")), ("id", &result["id"].as_str().unwrap_or("")), ("version", &version)]);
      format!("{head}\n{}", result["path"].as_str().unwrap_or(""))
    }
    protocol::METHOD_ARTIFACT_LIST => {
      let rows: Vec<String> = result["artifacts"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|a| format!("{}  v{}  {}  {}", a["id"].as_str().unwrap_or(""), a["version"].as_u64().unwrap_or(0), a["format"].as_str().unwrap_or(""), a["title"].as_str().unwrap_or("")))
        .collect();
      if rows.is_empty() { tr(Msg::NoArtifacts, &[]) } else { rows.join("\n") }
    }
    protocol::METHOD_ACCOUNT_LIST_DATA | protocol::METHOD_ACCOUNT_ADD_DATA | protocol::METHOD_ACCOUNT_SELECT_DATA | protocol::METHOD_ACCOUNT_REMOVE_DATA => render_data_accounts(result),
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
    assert_eq!((m, p), (protocol::METHOD_TASK_CREATE, json!({ "title": "Fix", "prompt": "from stdin", "base": null, "mode": "terminal", "open": false, "cwd": "/repo" })));
    let big = Command::TaskCreate { title: "x".into(), prompt: Some("a".repeat(MAX_PROMPT + 1)), base: None, mode: None, background: false };
    assert!(request_of(&big, cwd, None).is_err());
    assert!(request_of(&Command::Help, cwd, None).unwrap().is_none());
    let (m, p) = request_of(&Command::Notify { message: "done".into(), title: None }, cwd, None).unwrap().unwrap();
    assert_eq!((m, p), (protocol::METHOD_NOTIFY, json!({ "message": "done", "title": null })));
  }

  #[test]
  fn builds_artifact_requests() {
    let cwd = Path::new("/repo");
    let cmd = Command::ArtifactPublish {
      file: "out/report.html".into(),
      title: Some("Report".into()),
      description: None,
      assets: vec![("out/img/a.png".into(), None), ("/tmp/logo.svg".into(), None), ("data.json".into(), Some("d/data.json".into()))],
      id: None,
    };
    let (m, p) = request_of(&cmd, cwd, None).unwrap().unwrap();
    assert_eq!(m, protocol::METHOD_ARTIFACT_PUBLISH);
    assert_eq!(
      p,
      json!({
        "cwd": "/repo", "file": "/repo/out/report.html", "title": "Report", "description": null, "id": null, "source": "cli",
        "assets": [
          { "path": "/repo/out/img/a.png", "name": "img/a.png" },
          { "path": "/tmp/logo.svg", "name": "logo.svg" },
          { "path": "/repo/data.json", "name": "d/data.json" },
        ],
      })
    );
    assert_eq!(request_of(&Command::ArtifactList, cwd, None).unwrap().unwrap(), (protocol::METHOD_ARTIFACT_LIST, json!({ "cwd": "/repo" })));
    assert_eq!(asset_name(Path::new("/a"), Path::new("/a/b/c.png")), "b/c.png");
    assert_eq!(asset_name(Path::new("/a"), Path::new("/x/c.png")), "c.png");
  }

  #[test]
  fn renders_artifact_answers() {
    let published = json!({ "id": "0123456789abcdef", "version": 2, "title": "Report", "format": "html", "root": "/repo", "path": "/repo/.kingu/artifacts/0123456789abcdef/v2/index.html" });
    assert_eq!(render(protocol::METHOD_ARTIFACT_PUBLISH, &published), "Published Report (artifact 0123456789abcdef, version 2)\n/repo/.kingu/artifacts/0123456789abcdef/v2/index.html");
    let list = json!({ "root": "/repo", "artifacts": [{ "id": "0123456789abcdef", "title": "Report", "format": "markdown", "version": 3, "updated_at": 1 }] });
    assert_eq!(render(protocol::METHOD_ARTIFACT_LIST, &list), "0123456789abcdef  v3  markdown  Report");
    assert_eq!(render(protocol::METHOD_ARTIFACT_LIST, &json!({ "artifacts": [] })), "no artifacts");
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
