//! The command's side: a parsed command → one request, sent over the app's socket; the answer
//! printed for a person (or as JSON with `--json`).

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::args::{Command, Editor};
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
    Command::Editor(e) => (protocol::METHOD_EDITOR_OPEN, editor_params(e, cwd)),
  }))
}

/// `editor.open`'s params: every path absolute (`main` has put the stdin file in its place).
pub fn editor_params(e: &Editor, cwd: &Path) -> Value {
  let paths: Vec<Value> = e.paths.iter().map(|t| json!({ "path": absolute(cwd, &t.path).display().to_string(), "line": t.line, "column": t.column })).collect();
  json!({
    "cwd": cwd.display().to_string(),
    "paths": paths,
    "diff": e.diff,
    "merge": e.merge,
    "add": e.add,
    "remove": e.remove,
    "newWindow": e.new_window,
    "reuseWindow": e.reuse_window,
    "wait": e.wait,
    "profile": e.profile,
  })
}

/// The launch arguments for a Kingu that is not running: the absolute paths.
pub fn launch_paths(e: &Editor, cwd: &Path) -> Vec<PathBuf> {
  e.paths.iter().map(|t| absolute(cwd, &t.path)).collect()
}

/// Bigger stdin is refused (VS Code reads it into a temporary file too).
pub const MAX_STDIN: usize = 64 * 1024 * 1024;

/// Writes what was read from stdin to a new owner-only `kingu-stdin-<n>.txt` in `dir`.
pub fn write_stdin_file(dir: &Path, text: &[u8]) -> Result<PathBuf, String> {
  use std::io::Write;
  for attempt in 0..16u32 {
    let n = protocol::new_token()?;
    let path = dir.join(format!("kingu-stdin-{}.txt", &n[..if attempt < 8 { 6 } else { 12 }]));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
      use std::os::unix::fs::OpenOptionsExt;
      opts.mode(0o600);
    }
    match opts.open(&path) {
      Ok(mut f) => return f.write_all(text).map(|()| path.clone()).map_err(|e| format!("{}: {e}", path.display())),
      Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
      Err(e) => return Err(format!("{}: {e}", path.display())),
    }
  }
  Err(format!("{}: no free name", dir.display()))
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
    _ => String::new(),
  }
}

/// How long an answer may take: starting a task waits for the window (the app gives it 30 s).
pub const ANSWER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

/// Sends one request over the app's socket and reads its answer.
pub fn call(socket: &Path, token: &str, method: &str, params: Value) -> Result<Response, (i32, String)> {
  call_with(socket, token, method, params, Some(ANSWER_TIMEOUT))
}

/// [`call`] waiting `timeout` for the answer (`None`: as long as it takes, for `editor.wait`).
#[cfg(unix)]
pub fn call_with(socket: &Path, token: &str, method: &str, params: Value, timeout: Option<std::time::Duration>) -> Result<Response, (i32, String)> {
  use std::io::{BufRead, BufReader, Read, Write};
  use std::os::unix::net::UnixStream;
  use std::time::Duration;
  let mut stream = UnixStream::connect(socket).map_err(|e| (EXIT_UNAVAILABLE, tr(Msg::NotReachable, &[("socket", &socket.display()), ("detail", &e)])))?;
  let _ = stream.set_read_timeout(timeout);
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
pub fn call_with(_socket: &Path, _token: &str, _method: &str, _params: Value, _timeout: Option<std::time::Duration>) -> Result<Response, (i32, String)> {
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
  fn builds_editor_requests_with_absolute_paths() {
    use crate::args::Target;
    let cwd = Path::new("/repo");
    let e = Editor {
      paths: vec![Target { path: "src/a.rs".into(), line: Some(3), column: Some(2) }, Target::plain("/etc/hosts"), Target::plain(".")],
      goto: true,
      wait: true,
      profile: Some("Work".into()),
      ..Default::default()
    };
    let (m, p) = request_of(&Command::Editor(e.clone()), cwd, None).unwrap().unwrap();
    assert_eq!(m, protocol::METHOD_EDITOR_OPEN);
    assert_eq!(
      p,
      json!({
        "cwd": "/repo",
        "paths": [{ "path": "/repo/src/a.rs", "line": 3, "column": 2 }, { "path": "/etc/hosts", "line": null, "column": null }, { "path": "/repo/.", "line": null, "column": null }],
        "diff": false, "merge": false, "add": false, "remove": false, "newWindow": false, "reuseWindow": false, "wait": true, "profile": "Work",
      })
    );
    assert_eq!(launch_paths(&e, cwd), [PathBuf::from("/repo/src/a.rs"), PathBuf::from("/etc/hosts"), PathBuf::from("/repo/.")]);
  }

  #[test]
  fn writes_stdin_to_a_private_temporary_file() {
    let tmp = tempfile::tempdir().unwrap();
    let a = write_stdin_file(tmp.path(), "สวัสดี\n".as_bytes()).unwrap();
    let b = write_stdin_file(tmp.path(), b"").unwrap();
    assert_ne!(a, b);
    assert!(a.file_name().unwrap().to_str().unwrap().starts_with("kingu-stdin-"));
    assert_eq!(std::fs::read_to_string(&a).unwrap(), "สวัสดี\n");
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(std::fs::metadata(&a).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert!(write_stdin_file(&tmp.path().join("missing"), b"x").is_err());
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
