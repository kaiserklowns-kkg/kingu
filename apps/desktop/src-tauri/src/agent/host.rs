//! The agent host sidecar (apps/agent-host): one process per app, started on first use, that
//! runs Claude Agent SDK sessions and multiplexes them by run id over newline-delimited JSON-RPC
//! on stdio. Requests go out with an id and wait for the matching response; `event`
//! notifications are routed to the run's sink. If the sidecar dies, every live run gets an
//! `Error` and a final `Exit`, and the next `start` spawns a fresh one.
//!
//! Prompts and tool inputs pass through but are never logged.

use crate::i18n::msg::AgentMsg;
use crate::tr;
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
    let bun = bun().ok_or_else(|| tr!(AgentMsg::NoBun))?;
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
  // The `kingu` command first, so timeline agents can run it too (cli_server.rs).
  let path = crate::shell_env::merge(crate::cli_server::bin_dir().map(Path::as_os_str), crate::shell_env::path().as_deref());
  let home = std::env::var_os("HOME").map(PathBuf::from);
  let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf));
  let dev_script = dev_script();
  let (program, args) = resolve_sidecar(std::env::var_os("KINGU_AGENT_HOST"), exe_dir.as_deref(), dev_script.as_deref(), || {
    find_bun(std::env::var_os("KINGU_BUN"), path.as_deref(), home.as_deref())
  })?;
  let mut env = agent_env(std::env::vars_os(), path);
  // The `kingu` command's runtime file: the host's `artifact_publish` tool publishes through it.
  if let Some(rt) = crate::cli_server::runtime_file() {
    env.push((kingu_cli::runtime::ENV_RUNTIME.into(), rt.as_os_str().to_owned()));
  }
  Ok(HostLaunch { program, args, env })
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
  /// With `resume`: continue only up to this message, in a fork of the session (`rewind`).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub resume_at: Option<String>,
  /// MCP servers for the run (trusted Snaps, the user's mcp.json, trusted .vscode / .cursor
  /// configs); omitted when there are none.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub mcp_servers: Option<std::collections::BTreeMap<String, McpServer>>,
  /// Which of the project's `.mcp.json` servers may run (`mcp::run_plan`); omitted when it has none.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub project_mcp: Option<super::mcp::ProjectMcp>,
  /// `mcp__<server>` of each MCP server the user turned off (`mcp::run_plan`).
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub disallowed_tools: Vec<String>,
  /// Skill plugin folders of active Snaps (`snap::validate_plugin_dirs`); omitted when none.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub plugins: Option<Vec<String>>,
  /// The active Claude account (`CLAUDE_CONFIG_DIR` or `ANTHROPIC_API_KEY`); omitted when none.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub env: Option<SecretEnv>,
  /// Auth variables to drop from the run's env so they do not override that account.
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub unset_env: Vec<String>,
  /// Image files sent with the first prompt (checked: attachments.rs).
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub images: Vec<String>,
  /// Snapshot files before the edit tools change them (chats: `chat_edits`); omitted when off.
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  pub snapshots: bool,
  /// Kingu's safety checks (`kingu.agent.safetyChecks`); omitted (on) unless turned off.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub safety_checks: Option<bool>,
  /// Kingu's always-ask checks (`safety_asks::from_settings`); omitted when none.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub guard_asks: Option<super::safety_asks::GuardAsks>,
  /// Project rules (`rules::system_append`) after Claude Code's system prompt; omitted when none.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub system_prompt_append: Option<String>,
  /// The agent behind the run when it is not the Claude SDK (`runtimes::resolve`); omitted for Claude.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub runtime: Option<super::runtimes::Spec>,
  /// What else this run owns while it is live besides its session (e.g. `chat:<root>:<id>`);
  /// not sent to the sidecar.
  #[serde(skip)]
  pub owner: Option<String>,
}

/// Single owner per agent session: while a run is live it holds its session id (the one it
/// resumes, and the ones the sidecar reports) and its owner key; starting another run that
/// would hold any of them is refused. Released with the run's `Exit`.
#[derive(Debug, Default)]
pub struct Owners {
  by_key: HashMap<String, u32>,
}

fn session_key(id: &str) -> String {
  format!("session:{id}")
}

impl Owners {
  /// Claims every key for `run`, or none: a key held by another run is refused.
  pub fn claim(&mut self, run: u32, session: Option<&str>, owner: Option<&str>) -> Result<(), String> {
    if let Some(id) = session
      && self.by_key.get(&session_key(id)).is_some_and(|&r| r != run)
    {
      return Err(tr!(AgentMsg::SessionBusy));
    }
    if let Some(o) = owner
      && self.by_key.get(o).is_some_and(|&r| r != run)
    {
      return Err(tr!(AgentMsg::ChatBusy));
    }
    if let Some(id) = session {
      self.by_key.insert(session_key(id), run);
    }
    if let Some(o) = owner {
      self.by_key.insert(o.to_owned(), run);
    }
    Ok(())
  }

  /// A session id the run reported (`system` / `result`); kept by the first run that holds it.
  pub fn observe(&mut self, run: u32, ev: &AgentEvent) {
    let id = match ev {
      AgentEvent::System { session_id: Some(id), .. } | AgentEvent::Result { session_id: Some(id), .. } => id,
      _ => return,
    };
    self.by_key.entry(session_key(id)).or_insert(run);
  }

  pub fn release(&mut self, run: u32) {
    self.by_key.retain(|_, r| *r != run);
  }

  pub fn holds_session(&self, id: &str) -> bool {
    self.by_key.contains_key(&session_key(id))
  }

  pub fn holds(&self, owner: &str) -> bool {
    self.by_key.contains_key(owner)
  }
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

/// An MCP server handed to an agent run, as the SDK's `mcpServers` entry: a program over stdio
/// (`type` absent or `stdio`: `command`, `args`, `env`) or a remote server (`type` `http` or
/// `sse`: `url`, `headers`).
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct McpServer {
  #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
  pub kind: Option<String>,
  #[serde(default, skip_serializing_if = "String::is_empty")]
  pub command: String,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub args: Vec<String>,
  #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
  pub env: std::collections::BTreeMap<String, String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub url: Option<String>,
  #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
  pub headers: std::collections::BTreeMap<String, String>,
}

pub const MAX_MCP_SERVERS: usize = 64;

/// A server name as it appears in tool names (`mcp__<name>__<tool>`): letters, digits, `-`, `_`.
pub fn valid_mcp_name(name: &str) -> bool {
  !name.is_empty() && name.len() <= 81 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// One server: a stdio one needs a command; a remote one an http(s) URL and plain header lines.
pub fn validate_mcp_server(name: &str, s: &McpServer) -> Result<(), String> {
  use crate::i18n::msg::McpMsg;
  if !valid_mcp_name(name) {
    return Err(crate::tr!(McpMsg::InvalidName, name));
  }
  let bad = |v: &str| v.chars().any(|c| c == '\0' || c == '\r' || c == '\n');
  match s.kind.as_deref() {
    None | Some("stdio") => {
      if s.command.trim().is_empty() || s.command.contains('\0') || s.args.iter().any(|a| a.contains('\0')) || s.url.is_some() {
        return Err(crate::tr!(McpMsg::InvalidCommand, name));
      }
    }
    Some("http" | "sse") => {
      let url = s.url.as_deref().unwrap_or_default();
      let scheme = url.starts_with("https://") || url.starts_with("http://");
      if !scheme || url.len() > 4096 || url.chars().any(|c| c.is_whitespace() || c.is_control()) || !s.command.is_empty() {
        return Err(crate::tr!(McpMsg::InvalidUrl, name));
      }
      for (header, value) in &s.headers {
        let token = !header.is_empty() && header.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        if !token || bad(value) {
          return Err(crate::tr!(McpMsg::InvalidHeader, name, header));
        }
      }
    }
    Some(kind) => return Err(crate::tr!(McpMsg::UnsupportedType, name, kind)),
  }
  if s.env.iter().any(|(k, v)| k.is_empty() || k.contains(['=', '\0']) || v.contains('\0')) {
    return Err(crate::tr!(McpMsg::InvalidCommand, name));
  }
  Ok(())
}

/// Every server of a run (names as in tool names; see `validate_mcp_server`).
pub fn validate_mcp_servers(servers: &std::collections::BTreeMap<String, McpServer>) -> Result<(), String> {
  if servers.len() > MAX_MCP_SERVERS {
    return Err(crate::tr!(crate::i18n::msg::McpMsg::TooMany, max = MAX_MCP_SERVERS));
  }
  servers.iter().try_for_each(|(name, s)| validate_mcp_server(name, s))
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
      sink(AgentEvent::Error { message: tr!(AgentMsg::HostExited) });
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
  owners: Arc<Mutex<Owners>>,
}

impl Default for AgentHost {
  fn default() -> Self {
    Self::new(Box::new(default_launch))
  }
}

impl AgentHost {
  pub fn new(launch: Launcher) -> Self {
    Self { launch, next_run: AtomicU32::new(0), proc: Arc::default(), owners: Arc::default() }
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
  /// Refused while another live run holds the session it resumes or its `owner` (`Owners`).
  pub fn start(&self, req: StartRequest, sink: Sink) -> Result<u32, String> {
    let id = self.next_run.fetch_add(1, Ordering::Relaxed) + 1;
    self.owners.lock().unwrap().claim(id, req.resume.as_deref(), req.owner.as_deref())?;
    let owners = self.owners.clone();
    let sink: Sink = Arc::new(move |ev: AgentEvent| {
      {
        let mut o = owners.lock().unwrap();
        if matches!(ev, AgentEvent::Exit { .. }) { o.release(id) } else { o.observe(id, &ev) }
      }
      sink(ev);
    });
    let started = (|| {
      let proc = self.ensure()?;
      // Registered first: the sidecar may emit events before it answers.
      proc.runs.lock().unwrap().insert(id, sink);
      let mut params = serde_json::to_value(&req).map_err(|e| e.to_string())?;
      params["runId"] = json!(id);
      proc.request("start", params, REQUEST_TIMEOUT).inspect_err(|_| {
        proc.runs.lock().unwrap().remove(&id);
      })
    })();
    match started {
      Ok(_) => Ok(id),
      Err(e) => {
        self.owners.lock().unwrap().release(id);
        Err(e)
      }
    }
  }

  /// Whether a live run holds `owner` (a `StartRequest::owner` key, e.g. `chat:<root>:<id>`).
  pub fn owner_live(&self, owner: &str) -> bool {
    self.owners.lock().unwrap().holds(owner)
  }

  /// Whether a live run of this app holds the agent session `id`.
  pub fn session_live(&self, id: &str) -> bool {
    self.owners.lock().unwrap().holds_session(id)
  }

  /// Changes the live run's model and/or permission mode from its next response on (the SDK's
  /// `setModel` / `setPermissionMode`). `provider`: an Arkai model's provider (`arkai.rs`), with its key.
  pub fn set_options(&self, run_id: u32, model: Option<&str>, permission_mode: Option<&str>, provider: Option<&super::arkai::WireProvider>) -> Result<(), String> {
    if model.is_none() && permission_mode.is_none() {
      return Ok(());
    }
    let mut params = json!({});
    if let Some(m) = model {
      params["model"] = json!(m);
    }
    if let Some(p) = provider {
      params["provider"] = serde_json::to_value(p).map_err(|e| e.to_string())?;
    }
    if let Some(m) = permission_mode {
      params["permissionMode"] = json!(m);
    }
    self.run_request(run_id, "set_options", params)
  }

  fn run_request(&self, run_id: u32, method: &str, mut params: Value) -> Result<(), String> {
    let proc = self.proc.lock().unwrap().clone().ok_or("no such agent run")?;
    if !proc.runs.lock().unwrap().contains_key(&run_id) {
      return Err("no such agent run".into());
    }
    params["runId"] = json!(run_id);
    proc.request(method, params, REQUEST_TIMEOUT).map(|_| ())
  }

  /// A follow-up message in the run's session, with image files (checked: attachments.rs).
  pub fn send(&self, run_id: u32, text: &str, images: &[String]) -> Result<(), String> {
    let mut params = json!({ "text": text });
    if !images.is_empty() {
      params["images"] = json!(images);
    }
    self.run_request(run_id, "send", params)
  }

  /// `decision`: `allow`, `allow_always` (this session), `allow_workspace` (the folder's
  /// `.claude/settings.local.json`), `allow_user` (the user's settings) or `deny` (with an
  /// optional message).
  /// `answers`: an AskUserQuestion's answers (question text → answer), sent with `allow`; the
  /// sidecar checks them against the questions it holds.
  pub fn answer_permission(
    &self,
    run_id: u32,
    request_id: &str,
    decision: &str,
    message: Option<&str>,
    answers: Option<&HashMap<String, String>>,
  ) -> Result<(), String> {
    self.run_request(run_id, "answer", answer_params(request_id, decision, message, answers)?)
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

/// How a permission request can be answered (the sidecar's `Decision`).
pub const DECISIONS: &[&str] = &["allow", "allow_always", "allow_workspace", "allow_user", "deny"];

/// The `answer` request's params; `answers` only with an allow.
fn answer_params(request_id: &str, decision: &str, message: Option<&str>, answers: Option<&HashMap<String, String>>) -> Result<Value, String> {
  if !DECISIONS.contains(&decision) {
    return Err(format!("{decision}: unknown decision"));
  }
  let mut params = json!({ "requestId": request_id, "decision": decision, "message": message });
  if let Some(answers) = answers {
    if decision == "deny" {
      return Err("answers go with allow, not deny".into());
    }
    params["answers"] = json!(answers);
  }
  Ok(params)
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
  fn answers_ride_along_with_an_allow() {
    let answers = HashMap::from([("Which library?".to_string(), "luxon".to_string())]);
    assert_eq!(
      answer_params("r1", "allow", None, Some(&answers)).unwrap(),
      json!({"requestId": "r1", "decision": "allow", "message": null, "answers": {"Which library?": "luxon"}})
    );
    assert_eq!(answer_params("r1", "deny", Some("no"), None).unwrap(), json!({"requestId": "r1", "decision": "deny", "message": "no"}));
    assert!(answer_params("r1", "deny", None, Some(&answers)).is_err());
    assert!(answer_params("r1", "maybe", None, None).is_err());
  }

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
    assert!(host.answer_permission(run, "r1", "maybe", None, None).is_err());
    let answers = HashMap::from([("Which?".to_string(), "this".to_string())]);
    assert!(host.answer_permission(run, "r1", "deny", None, Some(&answers)).is_err());
    host.answer_permission(run, "r1", "allow_always", None, None).unwrap();
    assert_eq!(next(&rx), AgentEvent::PermissionResolved { request_id: "r1".into(), decision: "allow_always".into() });
    let AgentEvent::Result { total_cost_usd, usage, .. } = next(&rx) else { panic!("expected a result") };
    assert_eq!(total_cost_usd, Some(0.5));
    assert_eq!(usage.map(|u| (u.input_tokens, u.output_tokens)), Some((1, 2)));
    assert!(matches!(next(&rx), AgentEvent::Raw { line } if line.contains("surprise")));

    host.stop(run).unwrap();
    assert_eq!(next(&rx), AgentEvent::Exit { code: None, signal: None, stopped: true });
    assert!(!host.is_running(run));
    assert!(host.send(run, "again", &[]).unwrap_err().contains("no such agent run"));

    let requests = std::fs::read_to_string(&log).unwrap();
    let lines: Vec<Value> = requests.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(lines[0]["method"], "start");
    assert_eq!(lines[0]["params"], json!({"runId": run, "cwd": "/w", "prompt": "แก้บั๊ก", "model": null, "permissionMode": "default", "resume": null}));
    assert_eq!(lines[1]["params"], json!({"runId": run, "requestId": "r1", "decision": "allow_always", "message": null}));
    assert_eq!(lines[2]["method"], "stop");
    host.shutdown();
  }

  #[test]
  fn owners_hold_sessions_and_chats_until_released() {
    let mut o = Owners::default();
    o.claim(1, Some("s-1"), Some("chat:/r:c-1")).unwrap();
    assert!(o.claim(2, Some("s-1"), None).unwrap_err().contains("already running"));
    assert!(o.claim(2, None, Some("chat:/r:c-1")).unwrap_err().contains("already has a running agent"));
    // All or nothing: a refused claim takes no key.
    assert!(o.claim(2, Some("s-2"), Some("chat:/r:c-1")).is_err());
    assert!(!o.holds_session("s-2"));
    o.claim(1, Some("s-1"), None).unwrap();
    o.observe(2, &AgentEvent::System { subtype: "init".into(), session_id: Some("s-9".into()), model: None });
    o.observe(3, &AgentEvent::System { subtype: "init".into(), session_id: Some("s-9".into()), model: None });
    assert!(o.claim(3, Some("s-9"), None).is_err(), "s-9 belongs to run 2");
    o.release(1);
    assert!(!o.holds_session("s-1"));
    o.claim(4, Some("s-1"), Some("chat:/r:c-1")).unwrap();
    o.release(2);
    o.claim(3, Some("s-9"), None).unwrap();
  }

  #[test]
  fn a_live_session_cannot_be_started_twice_and_options_reach_the_sidecar() {
    let tmp = tempfile::tempdir().unwrap();
    let log = tmp.path().join("requests.log");
    let body = format!(
      r#"{SH_LIB}
while read -r line; do
  echo "$line" >> '{log}'
  id=$(field "$line" id); run=$(field "$line" runId)
  reply $id
  case "$line" in
    *'"method":"start"'*) event $run '{{"kind":"system","subtype":"init","session_id":"s-new","model":"m"}}' ;;
    *'"method":"stop"'*) event $run '{{"kind":"exit","code":null,"signal":null,"stopped":true}}' ;;
  esac
done"#,
      log = log.display()
    );
    let host = host_for(script(tmp.path(), "fake-host", &body), vec![]);
    let (sink, rx) = collect();
    let first = host.start(StartRequest { resume: Some("s-old".into()), owner: Some("chat:/r:c-1".into()), ..req("/w") }, sink.clone()).unwrap();
    assert!(matches!(next(&rx), AgentEvent::System { .. }));
    assert!(host.session_live("s-old") && host.session_live("s-new"));
    assert!(host.owner_live("chat:/r:c-1") && !host.owner_live("chat:/r:c-2"));
    let err = host.start(StartRequest { resume: Some("s-old".into()), ..req("/w") }, sink.clone()).unwrap_err();
    assert!(err.contains("already running"), "{err}");
    assert!(host.start(StartRequest { resume: Some("s-new".into()), ..req("/w") }, sink.clone()).is_err(), "the session it reported is held too");
    assert!(host.start(StartRequest { owner: Some("chat:/r:c-1".into()), ..req("/w") }, sink.clone()).unwrap_err().contains("already has a running agent"));

    host.set_options(first, Some("claude-sonnet-5"), Some("plan"), None).unwrap();
    host.stop(first).unwrap();
    assert!(matches!(next(&rx), AgentEvent::Exit { stopped: true, .. }));
    assert!(!host.session_live("s-old") && !host.session_live("s-new") && !host.owner_live("chat:/r:c-1"));
    let second = host.start(StartRequest { resume: Some("s-old".into()), owner: Some("chat:/r:c-1".into()), ..req("/w") }, sink).unwrap();
    assert_ne!(first, second);

    let requests = std::fs::read_to_string(&log).unwrap();
    let lines: Vec<Value> = requests.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    let methods: Vec<_> = lines.iter().map(|l| l["method"].as_str().unwrap()).collect();
    assert_eq!(methods, ["start", "set_options", "stop", "start"], "refused starts never reach the sidecar");
    assert_eq!(lines[1]["params"], json!({"runId": first, "model": "claude-sonnet-5", "permissionMode": "plan"}));
    assert!(lines[0]["params"].get("owner").is_none(), "the owner key stays in the app");
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
    servers.insert("go-gopls".to_string(), McpServer { command: "gopls".into(), args: vec!["mcp".into()], ..Default::default() });
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
  fn remote_mcp_servers_need_an_http_url_and_plain_headers() {
    let http = |url: &str| McpServer { kind: Some("http".into()), url: Some(url.into()), ..Default::default() };
    assert!(validate_mcp_server("docs", &http("https://mcp.example.com/mcp")).is_ok());
    assert!(validate_mcp_server("docs", &McpServer { kind: Some("sse".into()), url: Some("http://localhost:9000/sse".into()), ..Default::default() }).is_ok());
    for url in ["file:///etc/passwd", "https://a b", "ftp://x", ""] {
      assert!(validate_mcp_server("docs", &http(url)).is_err(), "{url}");
    }
    let mut h = http("https://x.dev");
    h.headers.insert("Authorization".into(), "Bearer t".into());
    assert!(validate_mcp_server("docs", &h).is_ok());
    h.headers.insert("X-Evil".into(), "a\r\nHost: b".into());
    assert!(validate_mcp_server("docs", &h).is_err());
    assert!(validate_mcp_server("docs", &McpServer { kind: Some("ws".into()), url: Some("https://x".into()), ..Default::default() }).is_err());
    // A remote entry never names a program, and a stdio one never a URL.
    assert!(validate_mcp_server("docs", &McpServer { command: "sh".into(), ..http("https://x") }).is_err());
    assert!(validate_mcp_server("docs", &McpServer { command: "sh".into(), url: Some("https://x".into()), ..Default::default() }).is_err());
    let wire = serde_json::to_value(&h).unwrap();
    assert_eq!(wire["type"], "http");
    assert!(wire.get("command").is_none());
  }

  #[test]
  fn images_are_sent_only_when_attached() {
    let wire = serde_json::to_value(StartRequest { cwd: "/w".into(), prompt: "x".into(), images: vec!["/c/a.png".into()], ..Default::default() }).unwrap();
    assert_eq!(wire["images"], json!(["/c/a.png"]));
    let wire = serde_json::to_value(StartRequest { cwd: "/w".into(), prompt: "x".into(), ..Default::default() }).unwrap();
    assert!(wire.get("images").is_none());
  }

  #[test]
  fn safety_checks_and_rules_are_sent_only_when_set() {
    let wire = serde_json::to_value(StartRequest { cwd: "/w".into(), prompt: "x".into(), ..Default::default() }).unwrap();
    assert!(wire.get("safetyChecks").is_none() && wire.get("systemPromptAppend").is_none());
    let req = StartRequest { cwd: "/w".into(), prompt: "x".into(), safety_checks: Some(false), system_prompt_append: Some("# Project rules".into()), ..Default::default() };
    let wire = serde_json::to_value(req).unwrap();
    assert_eq!((wire["safetyChecks"].clone(), wire["systemPromptAppend"].clone()), (json!(false), json!("# Project rules")));
  }

  #[test]
  fn resume_at_is_sent_as_resume_at_only_when_set() {
    let req = StartRequest { cwd: "/w".into(), prompt: "x".into(), resume: Some("s".into()), resume_at: Some("0b5e9a1c-4c1d-4e2f-9a3b-000000000001".into()), ..Default::default() };
    assert_eq!(serde_json::to_value(req).unwrap()["resumeAt"], "0b5e9a1c-4c1d-4e2f-9a3b-000000000001");
    assert!(serde_json::to_value(StartRequest::default()).unwrap().get("resumeAt").is_none());
  }

  #[test]
  fn runtime_is_sent_only_for_another_agent() {
    assert!(serde_json::to_value(StartRequest::default()).unwrap().get("runtime").is_none(), "the Claude SDK: no runtime");
    let spec = super::super::runtimes::Spec { kind: "acp", command: "/opt/bin/gemini".into(), args: vec!["--experimental-acp".into()], arkai: None };
    let wire = serde_json::to_value(StartRequest { runtime: Some(spec), ..Default::default() }).unwrap();
    assert_eq!(wire["runtime"], json!({"kind": "acp", "command": "/opt/bin/gemini", "args": ["--experimental-acp"]}));
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
    let err = host.start(StartRequest { permission_mode: Some("dontAsk".into()), ..req("/w") }, sink).unwrap_err();
    assert!(err.contains("permission mode"), "{err}");
    host.shutdown();
  }
}
