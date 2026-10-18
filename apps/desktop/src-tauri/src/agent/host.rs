//! The agent host sidecar (apps/agent-host): one process per app, started on first use, that
//! runs Claude Agent SDK sessions and multiplexes them by run id over newline-delimited JSON-RPC
//! on stdio. Requests go out with an id and wait for the matching response; `event`
//! notifications are routed to the run's sink. If the sidecar dies, every live run gets an
//! `Error` and a final `Exit`, and the next `start` spawns a fresh one.
//!
//! Prompts and tool inputs pass through but are never logged.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::events::AgentEvent;

pub type Sink = Arc<dyn Fn(AgentEvent) + Send + Sync>;

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);
/// The release sidecar's file name, next to the app executable (Tauri `externalBin`).
pub const SIDECAR_NAME: &str = "kingu-agent-host";

const ENV_ALLOWLIST: &[&str] = &[
  "HOME", "USER", "LOGNAME", "LANG", "TERM", "SHELL", "TMPDIR", "CLAUDE_CONFIG_DIR", "KINGU_CLAUDE_BIN",
  "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY", "https_proxy", "http_proxy",
  "no_proxy", "all_proxy",
];
const ENV_PREFIXES: &[&str] = &["LC_", "ANTHROPIC_", "CLAUDE_CODE_"];

/// Allowlisted variables only (so app secrets do not reach the agent), with PATH set to `path`
/// (the login-shell PATH, see `shell_env`).
pub fn agent_env(vars: impl IntoIterator<Item = (OsString, OsString)>, path: Option<OsString>) -> Vec<(OsString, OsString)> {
  let mut env: Vec<_> = vars
    .into_iter()
    .filter(|(k, _)| k.to_str().is_some_and(|k| ENV_ALLOWLIST.contains(&k) || ENV_PREFIXES.iter().any(|p| k.starts_with(p))))
    .collect();
  if let Some(p) = path {
    env.push(("PATH".into(), p));
  }
  env
}

/// How to run the sidecar.
#[derive(Debug, Clone, PartialEq)]
pub struct HostLaunch {
  pub program: PathBuf,
  pub args: Vec<OsString>,
  pub env: Vec<(OsString, OsString)>,
}

/// `bun` for running the TypeScript sidecar in dev: `KINGU_BUN`, PATH, then `~/.bun/bin`.
pub fn find_bun(override_var: Option<OsString>, path: Option<&OsStr>, home: Option<&Path>) -> Option<PathBuf> {
  if let Some(b) = override_var.filter(|b| !b.is_empty()) {
    return Some(b.into());
  }
  let path_dirs = path.map(|p| std::env::split_paths(p).collect::<Vec<_>>()).unwrap_or_default();
  let extra = home.map(|h| h.join(".bun/bin")).into_iter().chain(["/opt/homebrew/bin".into(), "/usr/local/bin".into()]);
  path_dirs.into_iter().chain(extra).map(|d| d.join("bun")).find(|p| p.is_file())
}

/// Where the sidecar is: `KINGU_AGENT_HOST` (a binary, or a `.ts`/`.js` entry run with bun),
/// else `kingu-agent-host` next to the app executable (release: Tauri `externalBin` strips the
/// `-<target-triple>` suffix and puts it in `Contents/MacOS`), else the repo's
/// `apps/agent-host/src/main.ts` run with bun (`dev_script`, debug builds only).
pub fn resolve_sidecar(
  override_var: Option<OsString>,
  exe_dir: Option<&Path>,
  dev_script: Option<&Path>,
  bun: impl FnOnce() -> Option<PathBuf>,
) -> Result<(PathBuf, Vec<OsString>), String> {
  let with_bun = |script: &Path| -> Result<(PathBuf, Vec<OsString>), String> {
    let bun = bun().ok_or("ไม่พบ bun สำหรับรัน agent host: ติดตั้ง bun หรือตั้ง KINGU_BUN / KINGU_AGENT_HOST")?;
    Ok((bun, vec!["run".into(), script.as_os_str().to_owned()]))
  };
  if let Some(o) = override_var.filter(|o| !o.is_empty()) {
    let p = PathBuf::from(o);
    if !p.is_file() {
      return Err(format!("KINGU_AGENT_HOST={}: not a file", p.display()));
    }
    return match p.extension().and_then(OsStr::to_str) {
      Some("ts" | "js" | "mjs") => with_bun(&p),
      _ => Ok((p, Vec::new())),
    };
  }
  if let Some(bin) = exe_dir.map(|d| d.join(SIDECAR_NAME)).filter(|p| p.is_file()) {
    return Ok((bin, Vec::new()));
  }
  match dev_script {
    Some(script) if script.is_file() => with_bun(script),
    Some(script) => Err(format!("agent host not found: build apps/agent-host or set KINGU_AGENT_HOST ({} missing)", script.display())),
    None => Err(format!("agent host not found: {SIDECAR_NAME} is missing next to the app executable (set KINGU_AGENT_HOST)")),
  }
}

/// The repo's TypeScript entry, for `tauri dev`. Release builds do not embed the build machine's
/// repo path (and never run sidecar code from outside the signed bundle unless KINGU_AGENT_HOST says so).
#[cfg(debug_assertions)]
fn dev_script() -> Option<PathBuf> {
  Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../agent-host/src/main.ts"))
}

#[cfg(not(debug_assertions))]
fn dev_script() -> Option<PathBuf> {
  None
}

/// The real launch: resolved per spawn so a fixed PATH or newly built sidecar is picked up.
pub fn default_launch() -> Result<HostLaunch, String> {
  let path = crate::shell_env::path();
  let home = std::env::var_os("HOME").map(PathBuf::from);
  let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf));
  let dev_script = dev_script();
  let (program, args) = resolve_sidecar(std::env::var_os("KINGU_AGENT_HOST"), exe_dir.as_deref(), dev_script.as_deref(), || {
    find_bun(std::env::var_os("KINGU_BUN"), path.as_deref(), home.as_deref())
  })?;
  Ok(HostLaunch { program, args, env: agent_env(std::env::vars_os(), path) })
}

/// Options for a new run (camelCase on the wire, like the sidecar's `StartParams`).
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
  pub cwd: String,
  pub prompt: String,
  pub model: Option<String>,
  pub permission_mode: Option<String>,
  pub resume: Option<String>,
  /// MCP servers for the run (from trusted Snaps); omitted when there are none.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub mcp_servers: Option<std::collections::BTreeMap<String, McpServer>>,
  /// Skill plugin folders of active Snaps (`snap::validate_plugin_dirs`); omitted when none.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub plugins: Option<Vec<String>>,
  /// The active Claude account (`CLAUDE_CONFIG_DIR` or `ANTHROPIC_API_KEY`); omitted when none.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub env: Option<SecretEnv>,
  /// Auth variables to drop from the run's env so they do not override that account.
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub unset_env: Vec<String>,
}

/// Env values that may hold an API key: serialized for the sidecar, never shown by Debug.
#[derive(Clone, Default, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct SecretEnv(pub std::collections::BTreeMap<String, String>);

impl std::fmt::Debug for SecretEnv {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_set().entries(self.0.keys()).finish()
  }
}

/// A stdio MCP server handed to an agent run (the SDK's `mcpServers` entry without `type`).
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct McpServer {
  pub command: String,
  #[serde(default)]
  pub args: Vec<String>,
  #[serde(default)]
  pub env: std::collections::BTreeMap<String, String>,
}

/// Server names are `<snap>-<server>` (letters, digits, `-`, `_`); commands must not be empty.
pub fn validate_mcp_servers(servers: &std::collections::BTreeMap<String, McpServer>) -> Result<(), String> {
  if servers.len() > 32 {
    return Err("too many MCP servers".into());
  }
  for (name, s) in servers {
    let ok_name = !name.is_empty() && name.len() <= 81 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !ok_name {
      return Err(format!("{name}: invalid MCP server name"));
    }
    if s.command.trim().is_empty() || s.command.contains('\0') || s.args.iter().any(|a| a.contains('\0')) {
      return Err(format!("{name}: invalid MCP server command"));
    }
  }
  Ok(())
}

struct Proc {
  pid: u32,
  child: Mutex<Child>,
  stdin: Mutex<Option<ChildStdin>>,
  next_req: AtomicU64,
  pending: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
  runs: Mutex<HashMap<u32, Sink>>,
}

impl Proc {
  fn write(&self, msg: &Value) -> Result<(), String> {
    let mut guard = self.stdin.lock().unwrap();
    let w = guard.as_mut().ok_or("agent host is shutting down")?;
    let mut line = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
    line.push(b'\n');
    w.write_all(&line).and_then(|_| w.flush()).map_err(|e| format!("agent host: {e}"))
  }

  fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    let id = self.next_req.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = mpsc::channel();
    self.pending.lock().unwrap().insert(id, tx);
    if let Err(e) = self.write(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})) {
      self.pending.lock().unwrap().remove(&id);
      return Err(e);
    }
    match rx.recv_timeout(timeout) {
      Ok(r) => r,
      Err(_) => {
        self.pending.lock().unwrap().remove(&id);
        Err(format!("agent host did not answer {method}"))
      }
    }
  }

  fn handle_line(&self, line: &str) {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
      log::error!("agent host: unparseable output line ({} bytes)", line.len());
      return;
    };
    if let Some(id) = v.get("id").and_then(Value::as_u64)
      && (v.get("result").is_some() || v.get("error").is_some())
    {
      let reply = match v.get("error") {
        Some(e) => Err(e.get("message").and_then(Value::as_str).unwrap_or("agent host error").to_owned()),
        None => Ok(v["result"].clone()),
      };
      if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(reply);
      }
      return;
    }
    match v.get("method").and_then(Value::as_str) {
      Some("event") => {
        let Some(run) = v.pointer("/params/runId").and_then(Value::as_u64).map(|r| r as u32) else { return };
        let ev = AgentEvent::from_host(v.pointer("/params/event").cloned().unwrap_or(Value::Null));
        let sink = {
          let mut runs = self.runs.lock().unwrap();
          if matches!(ev, AgentEvent::Exit { .. }) { runs.remove(&run) } else { runs.get(&run).cloned() }
        };
        if let Some(sink) = sink {
          sink(ev);
        }
      }
      Some("ready") => {
        let sdk = v.pointer("/params/sdkVersion").and_then(Value::as_str).unwrap_or("?");
        log::info!("agent host {} ready (agent sdk {sdk})", self.pid);
      }
      _ => {}
    }
  }

  /// Called once the sidecar's stdout closes: fail pending requests and end every run.
  fn died(&self) {
    for (_, tx) in self.pending.lock().unwrap().drain() {
      let _ = tx.send(Err("agent host exited".into()));
    }
    let status = wait_with_timeout(&self.child, SHUTDOWN_GRACE);
    if status.is_none() {
      kill_group(&self.child, self.pid);
    }
    #[cfg(unix)]
    let signal = status.and_then(|s| std::os::unix::process::ExitStatusExt::signal(&s));
    #[cfg(not(unix))]
    let signal = None;
    let code = status.and_then(|s| s.code());
    let runs: Vec<_> = self.runs.lock().unwrap().drain().collect();
    log::info!("agent host {} exited (code {code:?}, signal {signal:?}); ending {} run(s)", self.pid, runs.len());
    for (_, sink) in runs {
      sink(AgentEvent::Error { message: "agent host หยุดทำงานกะทันหัน (agent host exited unexpectedly)".into() });
      sink(AgentEvent::Exit { code, signal, stopped: false });
    }
  }
}

fn wait_with_timeout(child: &Mutex<Child>, timeout: Duration) -> Option<std::process::ExitStatus> {
  let started = Instant::now();
  loop {
    match child.lock().unwrap().try_wait() {
      Ok(Some(s)) => return Some(s),
      Ok(None) if started.elapsed() < timeout => {}
      _ => return None,
    }
    std::thread::sleep(Duration::from_millis(20));
  }
}

fn kill_group(child: &Mutex<Child>, pid: u32) {
  // The sidecar leads its own process group, so this also reaches Claude Code and its tools.
  #[cfg(unix)]
  unsafe {
    libc::kill(-(pid as i32), libc::SIGKILL);
  }
  #[cfg(not(unix))]
  let _ = pid;
  let mut c = child.lock().unwrap();
  let _ = c.kill();
  let _ = c.wait();
}

/// Reads `r` line by line (lossy UTF-8, so a bad byte never ends the stream).
fn for_each_line(r: impl Read, mut f: impl FnMut(&str)) {
  let mut r = BufReader::new(r);
  let mut buf = Vec::new();
  loop {
    buf.clear();
    match r.read_until(b'\n', &mut buf) {
      Ok(0) | Err(_) => break,
      Ok(_) => f(String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n'])),
    }
  }
}

type Launcher = Box<dyn Fn() -> Result<HostLaunch, String> + Send + Sync>;

pub struct AgentHost {
  launch: Launcher,
  next_run: AtomicU32,
  proc: Arc<Mutex<Option<Arc<Proc>>>>,
}

impl Default for AgentHost {
  fn default() -> Self {
    Self::new(Box::new(default_launch))
  }
}

impl AgentHost {
  pub fn new(launch: Launcher) -> Self {
    Self { launch, next_run: AtomicU32::new(0), proc: Arc::default() }
  }

  /// The running sidecar, spawning it if needed.
  fn ensure(&self) -> Result<Arc<Proc>, String> {
    let mut slot = self.proc.lock().unwrap();
    if let Some(p) = slot.as_ref() {
      return Ok(p.clone());
    }
    let launch = (self.launch)()?;
    let mut cmd = Command::new(&launch.program);
    cmd
      .args(&launch.args)
      .env_clear()
      .envs(launch.env)
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.spawn().map_err(|e| format!("agent host {}: {e}", launch.program.display()))?;
    let (stdin, stdout, stderr) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let (Some(stdin), Some(stdout), Some(stderr)) = (stdin, stdout, stderr) else {
      let _ = child.kill();
      return Err("agent host: no stdio".into());
    };
    let proc = Arc::new(Proc {
      pid: child.id(),
      child: Mutex::new(child),
      stdin: Mutex::new(Some(stdin)),
      next_req: AtomicU64::new(0),
      pending: Mutex::default(),
      runs: Mutex::default(),
    });
    log::info!("agent host {} started ({})", proc.pid, launch.program.display());
    std::thread::spawn(move || {
      for_each_line(stderr, |line| log::info!("[agent-host] {}", line.chars().take(500).collect::<String>()));
    });
    let reader = proc.clone();
    let slot_ref = self.proc.clone();
    std::thread::spawn(move || {
      for_each_line(stdout, |line| reader.handle_line(line));
      {
        let mut slot = slot_ref.lock().unwrap();
        if slot.as_ref().is_some_and(|p| Arc::ptr_eq(p, &reader)) {
          *slot = None;
        }
      }
      reader.died();
    });
    *slot = Some(proc.clone());
    Ok(proc)
  }

  /// Starts a run; its events go to `sink`, ending with exactly one `Exit`.
  pub fn start(&self, req: StartRequest, sink: Sink) -> Result<u32, String> {
    let proc = self.ensure()?;
    let id = self.next_run.fetch_add(1, Ordering::Relaxed) + 1;
    // Registered first: the sidecar may emit events before it answers.
    proc.runs.lock().unwrap().insert(id, sink);
    let mut params = serde_json::to_value(&req).map_err(|e| e.to_string())?;
    params["runId"] = json!(id);
    match proc.request("start", params, REQUEST_TIMEOUT) {
      Ok(_) => Ok(id),
      Err(e) => {
        proc.runs.lock().unwrap().remove(&id);
        Err(e)
      }
    }
  }

  fn run_request(&self, run_id: u32, method: &str, mut params: Value) -> Result<(), String> {
    let proc = self.proc.lock().unwrap().clone().ok_or("no such agent run")?;
    if !proc.runs.lock().unwrap().contains_key(&run_id) {
      return Err("no such agent run".into());
    }
    params["runId"] = json!(run_id);
    proc.request(method, params, REQUEST_TIMEOUT).map(|_| ())
  }

  /// A follow-up message in the run's session.
  pub fn send(&self, run_id: u32, text: &str) -> Result<(), String> {
    self.run_request(run_id, "send", json!({ "text": text }))
  }

  /// `decision`: `allow`, `allow_always` (this session) or `deny` (with an optional message).
  pub fn answer_permission(&self, run_id: u32, request_id: &str, decision: &str, message: Option<&str>) -> Result<(), String> {
    if !matches!(decision, "allow" | "allow_always" | "deny") {
      return Err(format!("{decision}: unknown decision"));
    }
    self.run_request(run_id, "answer", json!({ "requestId": request_id, "decision": decision, "message": message }))
  }

  /// Stops the current turn; the session stays open for follow-ups.
  pub fn interrupt(&self, run_id: u32) -> Result<(), String> {
    self.run_request(run_id, "interrupt", json!({}))
  }

  /// Ends the run (its `Exit` follows with `stopped: true`).
  pub fn stop(&self, run_id: u32) -> Result<(), String> {
    self.run_request(run_id, "stop", json!({}))
  }

  #[cfg(test)]
  fn is_running(&self, run_id: u32) -> bool {
    self.proc.lock().unwrap().as_ref().is_some_and(|p| p.runs.lock().unwrap().contains_key(&run_id))
  }

  /// On app exit: ask the sidecar to end every run, close its stdin, then kill what remains.
  pub fn shutdown(&self) {
    let Some(proc) = self.proc.lock().unwrap().take() else { return };
    let _ = proc.request("shutdown", json!({}), Duration::from_secs(2));
    proc.stdin.lock().unwrap().take();
    if wait_with_timeout(&proc.child, SHUTDOWN_GRACE).is_none() {
      log::info!("agent host {} did not exit, killing", proc.pid);
      kill_group(&proc.child, proc.pid);
    }
  }
}

#[cfg(all(test, unix))]
mod tests {
  use super::*;
  use std::os::unix::fs::PermissionsExt;

  fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
  }

  fn host_for(program: PathBuf, env: Vec<(OsString, OsString)>) -> AgentHost {
    AgentHost::new(Box::new(move || Ok(HostLaunch { program: program.clone(), args: vec![], env: env.clone() })))
  }

  fn collect() -> (Sink, mpsc::Receiver<AgentEvent>) {
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    (Arc::new(move |ev| tx.lock().unwrap().send(ev).unwrap()), rx)
  }

  fn next(rx: &mpsc::Receiver<AgentEvent>) -> AgentEvent {
    rx.recv_timeout(Duration::from_secs(10)).expect("no event in time")
  }

  fn req(cwd: &str) -> StartRequest {
    StartRequest { cwd: cwd.into(), prompt: "แก้บั๊ก".into(), permission_mode: Some("default".into()), ..Default::default() }
  }

  /// Shell helpers for the fake sidecar: pull `"id":N` / `"runId":N` / a string field out of a request line.
  const SH_LIB: &str = r#"
field() { printf '%s' "$1" | sed -n "s/.*\"$2\":\([0-9]*\).*/\1/p"; }
sfield() { printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"; }
event() { echo "{\"jsonrpc\":\"2.0\",\"method\":\"event\",\"params\":{\"runId\":$1,\"event\":$2}}"; }
reply() { echo "{\"jsonrpc\":\"2.0\",\"id\":$1,\"result\":null}"; }
"#;

  #[test]
  fn permission_round_trip_with_a_fake_sidecar() {
    let tmp = tempfile::tempdir().unwrap();
    let log = tmp.path().join("requests.log");
    let body = format!(
      r#"{SH_LIB}
echo '{{"jsonrpc":"2.0","method":"ready","params":{{"sdkVersion":"fake"}}}}'
read -r line; echo "$line" >> '{log}'
id=$(field "$line" id); run=$(field "$line" runId)
event $run '{{"kind":"system","subtype":"init","session_id":"s-1","model":"fake"}}'
event $run '{{"kind":"permission_request","request_id":"r1","tool":"Bash","tool_use_id":"tu1","title":null,"input_summary":"rm -rf build","detail":null,"diff":null,"input":{{"command":"rm -rf build"}},"can_always":true}}'
reply $id
read -r line; echo "$line" >> '{log}'
id=$(field "$line" id); decision=$(sfield "$line" decision)
reply $id
event $run "{{\"kind\":\"permission_resolved\",\"request_id\":\"r1\",\"decision\":\"$decision\"}}"
event $run '{{"kind":"result","subtype":"success","is_error":false,"result":"done","session_id":"s-1","num_turns":1,"duration_ms":5,"total_cost_usd":0.5,"usage":{{"input_tokens":1,"output_tokens":2}}}}'
event $run '{{"kind":"surprise"}}'
read -r line; echo "$line" >> '{log}'
reply $(field "$line" id)
event $run '{{"kind":"exit","code":null,"signal":null,"stopped":true}}'
read -r line
"#,
      log = log.display()
    );
    let bin = script(tmp.path(), "fake-host", &body);
    let env = agent_env(
      [("KINGU_SECRET".into(), "leak".into()), ("TMPDIR".into(), "/t".into()), ("LC_CTYPE".into(), "UTF-8".into())],
      Some("/usr/bin:/bin".into()),
    );
    let host = host_for(bin, env);
    let (sink, rx) = collect();
    let run = host.start(req("/w"), sink).unwrap();
    assert!(matches!(next(&rx), AgentEvent::System { session_id: Some(s), .. } if s == "s-1"));
    let AgentEvent::PermissionRequest { request_id, tool, input_summary, .. } = next(&rx) else { panic!("expected a permission request") };
    assert_eq!((request_id.as_str(), tool.as_str(), input_summary.as_str()), ("r1", "Bash", "rm -rf build"));
    assert!(host.is_running(run));

    // The sidecar is blocked on its next read until the user answers.
    assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
    assert!(host.answer_permission(run, "r1", "maybe", None).is_err());
    host.answer_permission(run, "r1", "allow_always", None).unwrap();
    assert_eq!(next(&rx), AgentEvent::PermissionResolved { request_id: "r1".into(), decision: "allow_always".into() });
    let AgentEvent::Result { total_cost_usd, usage, .. } = next(&rx) else { panic!("expected a result") };
    assert_eq!(total_cost_usd, Some(0.5));
    assert_eq!(usage.map(|u| (u.input_tokens, u.output_tokens)), Some((1, 2)));
    assert!(matches!(next(&rx), AgentEvent::Raw { line } if line.contains("surprise")));

    host.stop(run).unwrap();
    assert_eq!(next(&rx), AgentEvent::Exit { code: None, signal: None, stopped: true });
    assert!(!host.is_running(run));
    assert!(host.send(run, "again").unwrap_err().contains("no such agent run"));

    let requests = std::fs::read_to_string(&log).unwrap();
    let lines: Vec<Value> = requests.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(lines[0]["method"], "start");
    assert_eq!(lines[0]["params"], json!({"runId": run, "cwd": "/w", "prompt": "แก้บั๊ก", "model": null, "permissionMode": "default", "resume": null}));
    assert_eq!(lines[1]["params"], json!({"runId": run, "requestId": "r1", "decision": "allow_always", "message": null}));
    assert_eq!(lines[2]["method"], "stop");
    host.shutdown();
  }

  #[test]
  fn a_crashing_sidecar_ends_its_runs_and_is_respawned() {
    let tmp = tempfile::tempdir().unwrap();
    let body = format!(
      r#"{SH_LIB}
read -r line
run=$(field "$line" runId)
reply $(field "$line" id)
event $run '{{"kind":"message","role":"assistant","text":"hi"}}'
exit 3"#
    );
    let host = host_for(script(tmp.path(), "crashy", &body), vec![]);
    let (sink, rx) = collect();
    let first = host.start(req("/w"), sink).unwrap();
    assert!(matches!(next(&rx), AgentEvent::Message { text, .. } if text == "hi"));
    assert!(matches!(next(&rx), AgentEvent::Error { .. }));
    assert_eq!(next(&rx), AgentEvent::Exit { code: Some(3), signal: None, stopped: false });
    assert!(!host.is_running(first));

    let (sink, rx) = collect();
    let second = host.start(req("/w"), sink).unwrap();
    assert_ne!(first, second);
    assert!(matches!(next(&rx), AgentEvent::Message { .. }));
  }

  #[test]
  fn mcp_servers_are_validated_and_sent_as_camel_case() {
    use std::collections::BTreeMap;
    let mut servers = BTreeMap::new();
    servers.insert("go-gopls".to_string(), McpServer { command: "gopls".into(), args: vec!["mcp".into()], env: BTreeMap::new() });
    assert!(validate_mcp_servers(&servers).is_ok());
    let wire = serde_json::to_value(StartRequest { cwd: "/w".into(), prompt: "x".into(), mcp_servers: Some(servers.clone()), ..Default::default() }).unwrap();
    assert_eq!(wire["mcpServers"]["go-gopls"]["args"], json!(["mcp"]));
    let mut bad = servers.clone();
    bad.insert("Bad Name".into(), McpServer { command: "x".into(), ..Default::default() });
    assert!(validate_mcp_servers(&bad).is_err());
    let mut empty = BTreeMap::new();
    empty.insert("a".to_string(), McpServer { command: " ".into(), ..Default::default() });
    assert!(validate_mcp_servers(&empty).is_err());
  }

  #[test]
  fn plugins_are_sent_only_when_present() {
    let wire = serde_json::to_value(StartRequest { cwd: "/w".into(), prompt: "x".into(), plugins: Some(vec!["/c/snap-plugins/go-0123456789abcdef".into()]), ..Default::default() }).unwrap();
    assert_eq!(wire["plugins"], json!(["/c/snap-plugins/go-0123456789abcdef"]));
    let wire = serde_json::to_value(StartRequest { cwd: "/w".into(), prompt: "x".into(), ..Default::default() }).unwrap();
    assert!(wire.get("env").is_none() && wire.get("unsetEnv").is_none(), "no account: nothing changes");
    let env = SecretEnv([("ANTHROPIC_API_KEY".to_owned(), "sk-ant-secret".to_owned())].into());
    let req = StartRequest { cwd: "/w".into(), prompt: "x".into(), env: Some(env), unset_env: vec!["ANTHROPIC_AUTH_TOKEN".into()], ..Default::default() };
    assert!(!format!("{req:?}").contains("sk-ant-secret"));
    let with_env = serde_json::to_value(req).unwrap();
    assert_eq!(with_env["env"]["ANTHROPIC_API_KEY"], "sk-ant-secret");
    assert_eq!(with_env["unsetEnv"], json!(["ANTHROPIC_AUTH_TOKEN"]));
    assert!(wire.get("plugins").is_none() && wire.get("mcpServers").is_none());
  }

  #[test]
  fn start_errors_are_reported_and_the_run_is_dropped() {
    let tmp = tempfile::tempdir().unwrap();
    let body = r#"read -r line
id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"error\":{\"code\":-32602,\"message\":\"prompt is empty\"}}"
read -r line"#;
    let host = host_for(script(tmp.path(), "picky", body), vec![]);
    let (sink, _rx) = collect();
    assert_eq!(host.start(req("/w"), sink).unwrap_err(), "prompt is empty");
    assert!(!host.is_running(1));
    host.shutdown();
  }

  #[test]
  fn shutdown_kills_a_wedged_sidecar() {
    let tmp = tempfile::tempdir().unwrap();
    // Ignores requests and EOF alike; `sleep` stands in for a Claude Code child.
    let body = r#"read -r line
id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":null}"
trap '' TERM
sleep 60"#;
    let host = host_for(script(tmp.path(), "wedged", body), vec![]);
    let (sink, rx) = collect();
    let run = host.start(req("/w"), sink).unwrap();
    let started = Instant::now();
    host.shutdown();
    assert!(started.elapsed() < Duration::from_secs(10));
    assert!(matches!(next(&rx), AgentEvent::Error { .. }));
    assert!(matches!(next(&rx), AgentEvent::Exit { stopped: false, .. }));
    assert!(!host.is_running(run));
  }

  #[test]
  fn missing_sidecar_is_a_clear_error() {
    let host = host_for("/nonexistent/kingu-agent-host".into(), vec![]);
    let (sink, _rx) = collect();
    assert!(host.start(req("/w"), sink).unwrap_err().contains("/nonexistent/kingu-agent-host"));
  }

  #[test]
  fn filters_the_environment() {
    let env = agent_env(
      [
        ("PATH".into(), "/usr/bin".into()),
        ("HOME".into(), "/h".into()),
        ("AWS_SECRET_ACCESS_KEY".into(), "x".into()),
        ("ANTHROPIC_API_KEY".into(), "k".into()),
        ("GITHUB_TOKEN".into(), "t".into()),
        ("LANG".into(), "th_TH.UTF-8".into()),
        ("LC_ALL".into(), "th_TH.UTF-8".into()),
        ("TMPDIR".into(), "/var/t".into()),
        ("CLAUDE_CONFIG_DIR".into(), "/c".into()),
        ("HTTPS_PROXY".into(), "http://p".into()),
        ("no_proxy".into(), "localhost".into()),
        ("KINGU_SECRET".into(), "s".into()),
      ],
      Some("/opt/homebrew/bin:/usr/bin".into()),
    );
    let keys: Vec<_> = env.iter().map(|(k, _)| k.to_str().unwrap()).collect();
    assert_eq!(
      keys,
      ["HOME", "ANTHROPIC_API_KEY", "LANG", "LC_ALL", "TMPDIR", "CLAUDE_CONFIG_DIR", "HTTPS_PROXY", "no_proxy", "PATH"]
    );
    assert_eq!(env.last().unwrap().1, "/opt/homebrew/bin:/usr/bin");
  }

  #[test]
  fn resolves_the_sidecar() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let bun = || Some(PathBuf::from("/x/bun"));
    let no_bun = || None;
    let script_ts = script(dir, "main.ts", "");
    let bin = script(dir, SIDECAR_NAME, "");
    let missing = dir.join("nope.ts");

    // KINGU_AGENT_HOST: a .ts entry runs with bun, anything else directly.
    assert_eq!(resolve_sidecar(Some(script_ts.clone().into()), None, Some(&missing), bun).unwrap(), ("/x/bun".into(), vec!["run".into(), script_ts.clone().into()]));
    assert_eq!(resolve_sidecar(Some(bin.clone().into()), None, Some(&missing), bun).unwrap(), (bin.clone(), vec![]));
    assert!(resolve_sidecar(Some(missing.clone().into()), None, Some(&missing), bun).unwrap_err().contains("KINGU_AGENT_HOST"));
    // Release: next to the executable, before the dev script.
    assert_eq!(resolve_sidecar(None, Some(dir), Some(&script_ts), bun).unwrap(), (bin, vec![]));
    // Dev: the repo script with bun.
    let empty = tempfile::tempdir().unwrap();
    assert_eq!(resolve_sidecar(None, Some(empty.path()), Some(&script_ts), bun).unwrap().0, PathBuf::from("/x/bun"));
    assert!(resolve_sidecar(None, Some(empty.path()), Some(&script_ts), no_bun).unwrap_err().contains("bun"));
    assert!(resolve_sidecar(None, None, Some(&missing), bun).unwrap_err().contains("agent host not found"));
    // Release (no dev script): only next to the executable.
    assert!(resolve_sidecar(None, Some(empty.path()), None, bun).unwrap_err().contains(SIDECAR_NAME));
  }

  #[test]
  fn finds_bun() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path();
    std::fs::create_dir_all(home.join(".bun/bin")).unwrap();
    let bun = script(&home.join(".bun/bin"), "bun", "");
    assert_eq!(find_bun(Some("/custom/bun".into()), None, Some(home)), Some("/custom/bun".into()));
    assert_eq!(find_bun(None, Some(OsStr::new("/nonexistent")), Some(home)), Some(bun));
  }

  #[test]
  #[cfg(debug_assertions)]
  fn dev_sidecar_path_points_into_the_repo() {
    let dev = dev_script().unwrap();
    assert!(dev.is_file(), "{}", dev.display());
  }

  /// The real TypeScript sidecar, driven only with requests it rejects before reaching the SDK
  /// (no Claude Code process, no model call). Skipped when bun is not installed.
  #[test]
  fn real_sidecar_speaks_the_protocol() {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if find_bun(std::env::var_os("KINGU_BUN"), std::env::var_os("PATH").as_deref(), home.as_deref()).is_none() {
      eprintln!("bun not found; skipping");
      return;
    }
    let host = AgentHost::new(Box::new(|| {
      let mut l = default_launch()?;
      l.env.retain(|(k, _)| k != "ANTHROPIC_API_KEY");
      Ok(l)
    }));
    let (sink, _rx) = collect();
    let err = host.start(req("relative/path"), sink.clone()).unwrap_err();
    assert!(err.contains("absolute"), "{err}");
    let err = host.start(StartRequest { permission_mode: Some("bypassPermissions".into()), ..req("/w") }, sink).unwrap_err();
    assert!(err.contains("permission mode"), "{err}");
    host.shutdown();
  }
}
