//! Jupyter kernels for notebooks (VS Code gets these from the Jupyter extension).
//!
//! Kingu does not speak ZeroMQ itself. A kernel runs under a small Python bridge
//! (`kernel_bridge.py`, compiled into the app and passed with `python -c`) that uses
//! `jupyter_client` — the library that comes with every Jupyter install — for the connection file,
//! message signing, interrupts and restarts. The bridge and Kingu exchange one JSON object per line
//! over stdin/stdout, so this side is only process plumbing and the protocol stays testable without
//! Python (a shell script plays the bridge in the tests below).
//!
//! The Python is the first of: the folder's `.venv` / `venv` (trusted workspaces only, since it is
//! the folder's own program), the interpreter of `jupyter` on the login PATH, then `python3` /
//! `python`. Kernelspecs are whatever `jupyter_client` finds from there (`jupyter kernelspec list`).

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use tauri::ipc::Channel;

use crate::i18n::msg::NotebookMsg;
use crate::tr;
use crate::workspace::Workspace;

/// The bridge's source, run as `python -c BRIDGE <args>`.
pub const BRIDGE: &str = include_str!("kernel_bridge.py");

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KernelSpec {
  pub name: String,
  pub display_name: String,
  pub language: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelDiscovery {
  /// The interpreter that found the specs and runs the bridge.
  pub python: String,
  pub specs: Vec<KernelSpec>,
}

// ---------------------------------------------------------------------------------------------
// Finding Python

/// The interpreter a script's `#!` line names: a path, or the program after `/usr/bin/env`.
pub fn shebang_program(first_line: &str) -> Option<String> {
  let line = first_line.strip_prefix("#!")?.trim();
  let mut words = line.split_whitespace();
  let program = words.next()?;
  if program.ends_with("/env") {
    // `env -S python3 -u` and `env python3`.
    return words.find(|w| !w.starts_with('-')).map(str::to_string);
  }
  Some(program.to_string())
}

fn venv_python(dir: &Path) -> PathBuf {
  if cfg!(windows) { dir.join("Scripts").join("python.exe") } else { dir.join("bin").join("python") }
}

/// The Pythons to try, best first (see the module doc). `path` is the PATH to search.
pub fn python_candidates(roots: &[PathBuf], trusted: bool, path: Option<OsString>) -> Vec<PathBuf> {
  let find = |name: &str| crate::agent::review::find_on_path(name, path.clone());
  let mut out: Vec<PathBuf> = Vec::new();
  if trusted {
    for root in roots {
      for venv in [".venv", "venv"] {
        let p = venv_python(&root.join(venv));
        if p.is_file() {
          out.push(p);
        }
      }
    }
  }
  if let Some(jupyter) = find(if cfg!(windows) { "jupyter.exe" } else { "jupyter" }) {
    let first = std::fs::read(&jupyter).ok().and_then(|bytes| bytes.split(|&b| b == b'\n').next().map(|l| String::from_utf8_lossy(l).into_owned()));
    if let Some(program) = first.as_deref().and_then(shebang_program) {
      let p = if program.contains('/') { Some(PathBuf::from(program)) } else { find(&program) };
      out.extend(p.filter(|p| p.is_file()));
    }
  }
  for name in ["python3", "python"] {
    out.extend(find(if cfg!(windows) { "python.exe" } else { name }));
  }
  let mut seen = Vec::new();
  out.retain(|p| {
    let fresh = !seen.contains(p);
    seen.push(p.clone());
    fresh
  });
  out
}

fn bridge_command(python: &Path, args: &[&str]) -> Command {
  let mut cmd = crate::shell_env::command(python);
  cmd.arg("-u").arg("-c").arg(BRIDGE).args(args);
  cmd
}

/// The last JSON object line of the bridge's output.
fn last_event(stdout: &str) -> Option<Value> {
  stdout.lines().rev().find_map(|l| serde_json::from_str::<Value>(l.trim()).ok().filter(Value::is_object))
}

/// The bridge's answer to `list`: the specs, or an error message.
pub fn parse_specs(stdout: &str) -> Result<KernelDiscovery, String> {
  let v = last_event(stdout).ok_or_else(|| tr!(NotebookMsg::BadReply, detail = stdout.trim().chars().take(200).collect::<String>()))?;
  match v["ev"].as_str() {
    Some("specs") => {
      let specs = v["specs"]
        .as_array()
        .map(|a| {
          a.iter()
            .filter_map(|s| {
              let name = s["name"].as_str()?.to_string();
              let display_name = s["display_name"].as_str().unwrap_or(&name).to_string();
              Some(KernelSpec { name, display_name, language: s["language"].as_str().unwrap_or("").to_string() })
            })
            .collect()
        })
        .unwrap_or_default();
      Ok(KernelDiscovery { python: v["python"].as_str().unwrap_or("").to_string(), specs })
    }
    _ => Err(v["message"].as_str().unwrap_or("").to_string()),
  }
}

/// Asks each candidate for its kernelspecs; the first Python with `jupyter_client` answers.
pub fn discover(candidates: &[PathBuf]) -> Result<KernelDiscovery, String> {
  for python in candidates {
    let Ok(out) = bridge_command(python, &["list"]).stdin(Stdio::null()).output() else { continue };
    match parse_specs(&String::from_utf8_lossy(&out.stdout)) {
      Ok(mut found) => {
        if found.python.is_empty() {
          found.python = python.display().to_string();
        }
        log::info!("notebook kernels: {} from {}", found.specs.len(), python.display());
        return Ok(found);
      }
      Err(e) => log::info!("notebook kernels: {} has no jupyter_client ({e})", python.display()),
    }
  }
  Err(tr!(NotebookMsg::NoJupyter))
}

// ---------------------------------------------------------------------------------------------
// Running sessions

pub type Sink = Arc<dyn Fn(Value) + Send + Sync>;

struct Session {
  child: Child,
  stdin: ChildStdin,
}

fn sessions() -> &'static Mutex<HashMap<u32, Session>> {
  static S: OnceLock<Mutex<HashMap<u32, Session>>> = OnceLock::new();
  S.get_or_init(Default::default)
}

static NEXT: AtomicU32 = AtomicU32::new(1);

/// Starts a bridge (`cmd`, with stdio set here); its events go to `sink`, ending with
/// `{"ev": "exit", "code": n}` once it is gone.
pub fn spawn_session(mut cmd: Command, sink: Sink) -> Result<u32, String> {
  let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
  let stdin = child.stdin.take().ok_or("no stdin")?;
  let stdout = child.stdout.take().ok_or("no stdout")?;
  let stderr = child.stderr.take();
  let id = NEXT.fetch_add(1, Ordering::Relaxed);
  sessions().lock().unwrap_or_else(|e| e.into_inner()).insert(id, Session { child, stdin });
  if let Some(err) = stderr {
    let sink = sink.clone();
    std::thread::spawn(move || {
      for line in BufReader::new(err).lines().map_while(Result::ok) {
        sink(json!({ "ev": "stderr", "line": line }));
      }
    });
  }
  std::thread::spawn(move || {
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
      let line = line.trim();
      if line.is_empty() {
        continue;
      }
      match serde_json::from_str::<Value>(line) {
        Ok(v) if v.get("ev").and_then(Value::as_str).is_some() => sink(v),
        _ => sink(json!({ "ev": "stderr", "line": line })),
      }
    }
    let session = sessions().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    let code = session.and_then(|mut s| s.child.wait().ok()).and_then(|s| s.code());
    log::info!("notebook kernel {id} exited ({code:?})");
    sink(json!({ "ev": "exit", "code": code }));
  });
  Ok(id)
}

/// What the webview may send to a bridge.
pub fn check_request(req: &Value) -> Result<(), String> {
  match req["op"].as_str() {
    Some("execute") if req["run"].is_string() && req["code"].is_string() => Ok(()),
    Some("interrupt" | "restart" | "shutdown") => Ok(()),
    _ => Err(tr!(NotebookMsg::BadReply, detail = req.to_string())),
  }
}

pub fn send(id: u32, req: &Value) -> Result<(), String> {
  check_request(req)?;
  let mut all = sessions().lock().unwrap_or_else(|e| e.into_inner());
  let s = all.get_mut(&id).ok_or_else(|| tr!(NotebookMsg::NoSession))?;
  writeln!(s.stdin, "{req}").and_then(|_| s.stdin.flush()).map_err(|e| e.to_string())
}

/// Asks the bridge to shut its kernel down, and kills it if it is still there after `grace`.
pub fn stop(id: u32, grace: Duration) {
  if send(id, &json!({ "op": "shutdown" })).is_err() {
    return;
  }
  std::thread::spawn(move || {
    std::thread::sleep(grace);
    if let Some(mut s) = sessions().lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
      let _ = s.child.kill();
      let _ = s.child.wait();
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Commands

fn trusted(ws: &Workspace) -> bool {
  crate::workspace_trust::ws_trusted(crate::system::config_dir(), ws)
}

/// The kernels the notebook's kernel picker lists.
#[tauri::command]
pub async fn notebook_kernels(ws: Workspace) -> Result<KernelDiscovery, String> {
  let candidates = python_candidates(&ws.roots(), trusted(&ws), crate::shell_env::path());
  crate::blocking(move || discover(&candidates)).await
}

/// Starts kernel `kernel` with `python` for the notebook `rel`, in the notebook's folder (as
/// Jupyter does). Restricted Mode runs nothing.
#[tauri::command]
pub fn notebook_kernel_start(ws: Workspace, rel: String, python: String, kernel: String, on_event: Channel<Value>) -> Result<u32, String> {
  if !trusted(&ws) {
    return Err(tr!(NotebookMsg::Untrusted));
  }
  let file = ws.resolve(&rel)?;
  let dir = file.parent().map(Path::to_path_buf).unwrap_or(ws.root()?);
  let mut cmd = bridge_command(Path::new(&python), &["run", &kernel]);
  cmd.current_dir(&dir);
  let id = spawn_session(
    cmd,
    Arc::new(move |v| {
      let _ = on_event.send(v);
    }),
  )?;
  log::info!("notebook kernel {id}: {kernel} for {rel}");
  Ok(id)
}

/// Execute / interrupt / restart (see the bridge's protocol).
#[tauri::command]
pub fn notebook_kernel_send(id: u32, request: Value) -> Result<(), String> {
  send(id, &request)
}

#[tauri::command]
pub fn notebook_kernel_stop(id: u32) {
  stop(id, Duration::from_secs(5));
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::mpsc;

  #[test]
  fn shebangs() {
    assert_eq!(shebang_program("#!/opt/homebrew/opt/python@3.12/bin/python3.12").as_deref(), Some("/opt/homebrew/opt/python@3.12/bin/python3.12"));
    assert_eq!(shebang_program("#!/usr/bin/env python3").as_deref(), Some("python3"));
    assert_eq!(shebang_program("#!/usr/bin/env -S python3 -u").as_deref(), Some("python3"));
    assert_eq!(shebang_program("import sys"), None);
  }

  #[test]
  fn venvs_only_when_trusted() {
    let dir = tempfile::tempdir().unwrap();
    let py = venv_python(&dir.path().join(".venv"));
    std::fs::create_dir_all(py.parent().unwrap()).unwrap();
    std::fs::write(&py, "").unwrap();
    let roots = vec![dir.path().to_path_buf()];
    let empty = Some(OsString::from(dir.path().join("nothing")));
    assert_eq!(python_candidates(&roots, true, empty.clone()), vec![py]);
    assert!(python_candidates(&roots, false, empty).is_empty());
  }

  #[test]
  fn jupyter_shebang_then_path() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let interp = dir.path().join("py3");
    std::fs::write(&interp, "").unwrap();
    std::fs::write(bin.join("jupyter"), format!("#!{}\nimport sys\n", interp.display())).unwrap();
    std::fs::write(bin.join("python3"), "").unwrap();
    let got = python_candidates(&[], true, Some(bin.clone().into_os_string()));
    assert_eq!(got, vec![interp, bin.join("python3")]);
  }

  #[test]
  fn spec_replies() {
    let ok = parse_specs("noise\n{\"ev\":\"specs\",\"python\":\"/p\",\"specs\":[{\"name\":\"python3\",\"display_name\":\"Python 3\",\"language\":\"python\"}]}\n").unwrap();
    assert_eq!(ok.python, "/p");
    assert_eq!(ok.specs, vec![KernelSpec { name: "python3".into(), display_name: "Python 3".into(), language: "python".into() }]);
    assert_eq!(parse_specs("{\"ev\":\"fatal\",\"message\":\"no jupyter_client\"}").unwrap_err(), "no jupyter_client");
    assert!(parse_specs("").is_err());
  }

  #[test]
  fn requests_are_checked() {
    assert!(check_request(&json!({ "op": "execute", "run": "1", "code": "1+1" })).is_ok());
    assert!(check_request(&json!({ "op": "interrupt" })).is_ok());
    assert!(check_request(&json!({ "op": "execute" })).is_err());
    assert!(check_request(&json!({ "op": "rm -rf" })).is_err());
  }

  fn collect() -> (Sink, mpsc::Receiver<Value>) {
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    (Arc::new(move |v| drop(tx.lock().unwrap().send(v))), rx)
  }

  fn next_ev(rx: &mpsc::Receiver<Value>, ev: &str) -> Value {
    loop {
      let v = rx.recv_timeout(Duration::from_secs(20)).unwrap_or_else(|_| panic!("no {ev} event"));
      if v["ev"] == ev {
        return v;
      }
    }
  }

  /// A fake kernel: a shell script that answers each request line with a `done` line.
  #[cfg(unix)]
  #[test]
  fn fake_bridge_session() {
    let script = r#"echo '{"ev":"ready","info":{}}'; while read -r line; do case "$line" in *shutdown*) exit 0;; esac; echo 'not json'; echo '{"ev":"done","run":"r1","count":1,"status":"ok"}'; done"#;
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c").arg(script);
    let (sink, rx) = collect();
    let id = spawn_session(cmd, sink).unwrap();
    next_ev(&rx, "ready");
    send(id, &json!({ "op": "execute", "run": "r1", "code": "x" })).unwrap();
    assert_eq!(next_ev(&rx, "stderr")["line"], "not json");
    assert_eq!(next_ev(&rx, "done")["count"], 1);
    stop(id, Duration::from_secs(5));
    assert_eq!(next_ev(&rx, "exit")["code"], 0);
    assert!(send(id, &json!({ "op": "interrupt" })).is_err());
  }

  /// The real bridge with its built-in fake kernel (KINGU_KERNEL_FAKE): skipped without python3.
  #[test]
  fn bridge_with_fake_kernel() {
    let Some(python) = crate::agent::review::find_on_path(if cfg!(windows) { "python.exe" } else { "python3" }, std::env::var_os("PATH")) else {
      eprintln!("python3 not found: skipped");
      return;
    };
    let mut cmd = Command::new(&python);
    cmd.arg("-u").arg("-c").arg(BRIDGE).args(["run", "python3"]).env("KINGU_KERNEL_FAKE", "1");
    let (sink, rx) = collect();
    let id = spawn_session(cmd, sink).unwrap();
    assert_eq!(next_ev(&rx, "ready")["info"]["language_info"]["name"], "python");

    send(id, &json!({ "op": "execute", "run": "a", "code": "print(1)" })).unwrap();
    assert_eq!(next_ev(&rx, "input")["count"], 1);
    let out = next_ev(&rx, "output");
    assert_eq!(out["output"], json!({ "output_type": "stream", "name": "stdout", "text": "print(1)\n" }));
    assert_eq!(next_ev(&rx, "output")["output"]["data"]["text/plain"], "8");
    let done = next_ev(&rx, "done");
    assert_eq!((done["run"].as_str(), done["count"].as_i64(), done["status"].as_str()), (Some("a"), Some(1), Some("ok")));

    send(id, &json!({ "op": "execute", "run": "b", "code": "raise" })).unwrap();
    assert_eq!(next_ev(&rx, "output")["output"]["ename"], "ValueError");
    assert_eq!(next_ev(&rx, "done")["status"], "error");

    // A long cell, one waiting behind it, then an interrupt: the waiting one is dropped.
    send(id, &json!({ "op": "execute", "run": "c", "code": "sleep 30" })).unwrap();
    send(id, &json!({ "op": "execute", "run": "d", "code": "never" })).unwrap();
    next_ev(&rx, "input");
    send(id, &json!({ "op": "interrupt" })).unwrap();
    let mut done = std::collections::HashMap::new();
    while done.len() < 2 {
      let v = next_ev(&rx, "done");
      done.insert(v["run"].as_str().unwrap().to_string(), v["status"].as_str().unwrap().to_string());
    }
    assert_eq!(done["c"], "error");
    assert_eq!(done["d"], "aborted");

    send(id, &json!({ "op": "restart" })).unwrap();
    while next_ev(&rx, "status")["state"] != "restarting" {}
    next_ev(&rx, "ready");
    send(id, &json!({ "op": "execute", "run": "e", "code": "x" })).unwrap();
    assert_eq!(next_ev(&rx, "done")["count"], 1);

    stop(id, Duration::from_secs(5));
    assert_eq!(next_ev(&rx, "exit")["code"], 0);
  }
}
