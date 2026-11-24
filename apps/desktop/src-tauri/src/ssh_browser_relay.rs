//! Browser tools for an agent on an SSH host: its calls come back over the SSH connection and run
//! in Kingu's browser on this computer (floating_browser/agent.rs), as a local chat agent's do.
//!
//! Orca 1.4.272 (source at e691a02c9, "browser tools work across SSH"): the host server forwards
//! an allowlisted `browser.*` call to the desktop attached over SSH
//! (`src/main/runtime/desktop-browser-bridge/desktop-browser-bridge-registry.ts`), which checks
//! the method again and runs it on its own tab
//! (`src/main/browser/desktop-browser-bridge/desktop-browser-bridge-executor.ts`); when no desktop
//! is attached, or it detaches before answering, the host refuses with
//! `desktop_browser_bridge_unavailable`. Kingu has no server on the host, so the relay is a
//! dedicated `ssh -N -R` per agent run (the wire protocol and the host's MCP server are in
//! `kingu_ptyd::browser_relay`):
//!
//! - **Who gets it.** A claude started in a held terminal on the host (ssh_projects.rs
//!   `ssh_project_terminal`) while `kingu.browser.agentTools` is on: its argv gets
//!   `--mcp-config` naming `kingu-ptyd browser-mcp --run <run>` from the holder's folder
//!   ([`mcp_argv`]). The run id is the session's hook token.
//! - **Authentication, per run** (Orca: a 0600 socket plus a random per-process token read from a
//!   0600 file, `runtime-rpc-request-admission.ts`). The host socket is in `~/.kingu/host/browser`
//!   (0700) and sshd binds it 0600; the run's token (32 random bytes) goes to `<run>.token` (0600)
//!   over ssh's stdin ([`prepare_script`]); every request carries it and is compared in constant
//!   time. This side's socket is 0600 in a 0700 folder and checks the peer's uid. Another user on
//!   the host can't reach the socket; another run of the same user doesn't have this run's token.
//! - **What it may do.** Only the six browser tools (agent.rs `METHODS`); the host can't choose
//!   the session (the run's own, registered here) and pages it opens use storage of their own.
//! - **Grants** (VS Code's, as the chat agent gets them from agent-host `browser.ts`): opening a
//!   page and navigating to an address ask the user here first: Allow Once, Allow for This Run,
//!   or Deny ([`GRANT_METHOD`], the window's cliBridge.svelte.ts). While a step runs, the tab shows
//!   which run drives it, with Stop (agent.rs). Stop on a page of the run also takes back "Allow for
//!   This Run": the next open or address asks again ([`Grant`]).
//! - **When the connection drops** the `ssh -R` exits (keepalives: within 45 s); the host's tools
//!   answer "can't be reached" and nothing runs, and Kingu dials the relay again with backoff while
//!   the run lasts. Closing the run's terminal ends the relay and removes its token from the host.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
#[cfg(test)]
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use kingu_ptyd::browser_relay::{self as wire, RelayReply, RelayRequest};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};

use crate::floating_browser::agent;
use crate::ssh_hosts::{self, Target};

/// The window event about a relay's state.
pub const EVENT: &str = "ssh-browser-relay";
/// What the window is asked before a host's agent opens a page or loads an address.
pub const GRANT_METHOD: &str = "browser.relayGrant";
/// The user has this long to answer a grant.
const GRANT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Relays at once (an older stopped one is forgotten first).
const MAX_RELAYS: usize = 32;
/// Calls of one run at once (Orca `MAX_PENDING_PER_ATTACHMENT` is 16).
const MAX_CALLS: usize = 8;
/// `ssh -R` that is still up after this has its forward (`ExitOnForwardFailure`).
const UP_AFTER: Duration = Duration::from_millis(1500);
/// Redials after a drop (seconds), the last repeated.
const BACKOFF_S: [u64; 5] = [2, 5, 10, 30, 60];
const HOME_MARK: &str = "@@kingu-home ";

// ---- Pure parts ----------------------------------------------------------------------------------

/// Opening a page, and navigating to an address (not back, forward or reload), ask first.
pub fn needs_grant(method: &str, params: &Value) -> bool {
  match method {
    "browser.open" => true,
    "browser.navigate" => matches!(params.get("type").and_then(Value::as_str), None | Some("url")),
    _ => false,
  }
}

/// A run's standing grant: "Allow for This Run" lasts until the user stops a page of the run.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Grant {
  for_run: bool,
  /// Pages of the run the user had stopped when the grant was given.
  stopped_then: usize,
}

impl Grant {
  pub fn allowed(&self, stopped_now: usize) -> bool {
    self.for_run && stopped_now <= self.stopped_then
  }

  /// The user's answer (`once`, `run`, anything else declines).
  pub fn answer(&mut self, answer: &str, stopped_now: usize) -> Result<(), String> {
    match answer {
      "once" => Ok(()),
      "run" => {
        self.for_run = true;
        self.stopped_then = stopped_now;
        Ok(())
      }
      _ => {
        self.for_run = false;
        Err("The user declined. Do not try this page again unless the user asks you to.".into())
      }
    }
  }
}

/// The request line, checked: size, token (constant time) and method; the host's own `session`
/// and `cwd` are dropped (the run's are used).
pub fn check_request(line: &str, token: &str) -> Result<RelayRequest, String> {
  if line.len() > wire::MAX_REQUEST {
    return Err("The request is too large.".into());
  }
  let req: RelayRequest = serde_json::from_str(line.trim_end()).map_err(|_| "Not a browser request.".to_string())?;
  if !wire::token_eq(&req.token, token) {
    return Err("unauthorized: this run's browser token does not match".into());
  }
  if !agent::METHODS.contains(&req.method.as_str()) {
    return Err(format!("{} is not available from an SSH host.", req.method));
  }
  Ok(req)
}

pub fn host_params(params: &Value) -> serde_json::Map<String, Value> {
  let mut p = params.as_object().cloned().unwrap_or_default();
  p.remove("session");
  p.remove("cwd");
  p
}

/// The MCP config that gives a claude on the host the tools: `kingu-ptyd browser-mcp` from the
/// holder's folder (`$HOME` is the host's, expanded by `sh` when claude starts the server).
pub fn mcp_config(holder: &str, run: &str) -> String {
  let cmd = format!("exec \"$HOME/{}/{holder}/kingu-ptyd\" {} --run {run}", crate::ssh_holder::ROOT, wire::SUBCOMMAND);
  json!({ "mcpServers": { wire::SERVER_NAME: { "type": "stdio", "command": "sh", "args": ["-c", cmd] } } }).to_string()
}

/// `agent` with the browser tools, or None (not a claude, or a bad holder or run id). The flag goes
/// last (before a `--`): `--mcp-config` takes several values and would swallow a prompt after it.
pub fn mcp_argv(agent: &[String], holder: &str, run: &str) -> Option<Vec<String>> {
  if !crate::ssh_holder::valid_id(holder) || !wire::valid_run(run) {
    return None;
  }
  let program = crate::agent::cli::program_of(agent)?;
  if program.rsplit('/').next() != Some("claude") {
    return None;
  }
  let at = agent.iter().position(|w| std::ptr::eq(w, program))?;
  let mut out = agent.to_vec();
  let end = out.iter().skip(at + 1).position(|w| w == "--").map_or(out.len(), |i| at + 1 + i);
  out.splice(end..end, ["--mcp-config".to_string(), mcp_config(holder, run)]);
  Some(out)
}

/// Makes the host's relay folder (0700), writes the token from stdin (0600) and prints `$HOME`.
/// It runs before every dial and removes the run's socket left by the last one: for `-R` the
/// client's `StreamLocalBindUnlink` does nothing (sshd's own setting, off by default), so a stale
/// socket would fail the forward.
pub fn prepare_script(run: &str) -> String {
  format!(
    "umask 077; d=\"$HOME/{dir}\"; mkdir -p \"$d\" && chmod 700 \"$d\" && rm -f \"$d/{run}.sock\" && cat > \"$d/{run}.token\" && chmod 600 \"$d/{run}.token\" && printf '{HOME_MARK}%s\\n' \"$HOME\"",
    dir = wire::DIR
  )
}

pub fn parse_home(out: &str) -> Option<String> {
  out.lines().rev().find_map(|l| l.strip_prefix(HOME_MARK)).map(str::trim_end).filter(|h| h.starts_with('/')).map(str::to_owned)
}

/// Removes the run's token and socket from the host.
pub fn cleanup_script(run: &str) -> String {
  format!("d=\"$HOME/{}\"; rm -f \"$d/{run}.token\" \"$d/{run}.sock\"", wire::DIR)
}

/// `ssh -N -R <host socket>:<local socket>`, a connection of its own with the shared connection's
/// keepalives (ssh_hosts.rs `forward_args`): a dead host ends it within 45 s.
pub fn forward_args(t: &Target, remote: &str, local: &Path) -> Result<Vec<String>, String> {
  let local = local.to_str().ok_or("the relay socket path is not UTF-8")?;
  for p in [remote, local] {
    if !p.starts_with('/') || p.contains(':') || p.chars().any(char::is_control) {
      return Err(format!("{p}: not a path ssh can forward"));
    }
  }
  let mut a: Vec<String> = Vec::new();
  if let Some(cfg) = std::env::var_os("KINGU_SSH_CONFIG").filter(|c| !c.is_empty()).and_then(|c| c.into_string().ok()) {
    a.extend(["-F".into(), cfg]);
  }
  a.extend(
    ["-N", "-T", "-o", "ExitOnForwardFailure=yes", "-o", "BatchMode=yes", "-o", "StreamLocalBindUnlink=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-R"]
      .map(String::from),
  );
  a.push(format!("{remote}:{local}"));
  a.extend(ssh_hosts::destination_args(t));
  Ok(a)
}

/// This side's socket: a private folder in the temp dir (a Unix socket path has 104 bytes on macOS).
pub fn local_socket(temp: &Path, uid: u32, run: &str) -> PathBuf {
  let p = temp.join(format!("kingu-br-{uid}")).join(format!("{run}.sock"));
  if p.as_os_str().len() < 100 { p } else { PathBuf::from(format!("/tmp/kingu-br-{uid}/{run}.sock")) }
}

// ---- Relays --------------------------------------------------------------------------------------

/// What the window is told about a relay.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RelayInfo {
  pub run: String,
  pub host: String,
  pub label: String,
  /// `starting`, `ready`, `lost` (the connection dropped; calls are refused) or `stopped`.
  pub state: &'static str,
  pub error: Option<String>,
  pub allowed_for_run: bool,
}

struct Relay {
  info: RelayInfo,
  app: Option<AppHandle>,
  target: Target,
  token: String,
  /// The agent.rs session of the run.
  session: String,
  key: String,
  grant: Grant,
  calls: usize,
  stop: bool,
  child: Option<Child>,
  local: Option<PathBuf>,
  /// The host has the run's token (so stopping removes it there).
  prepared: bool,
}

static RELAYS: Mutex<Option<HashMap<String, Relay>>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut HashMap<String, Relay>) -> T) -> T {
  let mut g = RELAYS.lock().unwrap_or_else(|e| e.into_inner());
  f(g.get_or_insert_with(HashMap::new))
}

fn emit(run: &str) {
  if let Some((app, info)) = with(|m| m.get(run).map(|r| (r.app.clone(), r.info.clone()))) {
    if let Some(app) = app {
      let _ = app.emit(EVENT, info);
    }
  }
}

fn set_state(run: &str, state: &'static str, error: Option<String>) {
  with(|m| {
    if let Some(r) = m.get_mut(run).filter(|r| !r.stop) {
      r.info.state = state;
      r.info.error = error;
    }
  });
  emit(run);
}

fn stopping(run: &str) -> bool {
  with(|m| m.get(run).is_none_or(|r| r.stop))
}

/// Keeps a stopped relay out of the way of new ones.
fn make_room(m: &mut HashMap<String, Relay>) {
  while m.len() >= MAX_RELAYS {
    let Some(old) = m.iter().find(|(_, r)| r.stop).or_else(|| m.iter().next()).map(|(k, _)| k.clone()) else { return };
    if let Some(mut r) = m.remove(&old) {
      kill(&mut r);
    }
  }
}

fn kill(r: &mut Relay) {
  r.stop = true;
  if let Some(mut c) = r.child.take() {
    let _ = c.kill();
    let _ = c.wait();
  }
  if let Some(l) = r.local.take() {
    let _ = std::fs::remove_file(l);
  }
}

/// Gives a claude started in a held terminal on host `t` the browser tools when they are on:
/// registers the run, starts its relay in the background and returns the argv to start instead.
pub fn offer(app: &AppHandle, t: &Target, holder: &str, run: &str, path: &str, agent_argv: &[String]) -> Option<Vec<String>> {
  if !agent::enabled(app) {
    return None;
  }
  let argv = mcp_argv(agent_argv, holder, run)?;
  let token = kingu_cli::protocol::new_token().ok()?;
  let key = format!("ssh:{}:{run}", t.label);
  let session = agent::register_run(Some(&key), Path::new(path))?;
  with(|m| {
    make_room(m);
    let info = RelayInfo { run: run.into(), host: t.id.clone(), label: t.label.clone(), state: "starting", error: None, allowed_for_run: false };
    m.insert(run.into(), Relay { info, app: Some(app.clone()), target: t.clone(), token, session, key, grant: Grant::default(), calls: 0, stop: false, child: None, local: None, prepared: false });
  });
  emit(run);
  let r = run.to_string();
  if let Err(e) = std::thread::Builder::new().name("ssh-browser-relay".into()).spawn(move || supervise(&r)) {
    log::warn!("ssh browser relay: {e}");
    return None;
  }
  Some(argv)
}

/// Ends run `run`'s relay (its terminal closed, or the user stopped it): calls from the host are
/// refused from now on, and its token and socket are removed from the host.
pub fn stop_run(run: &str) {
  let Some((target, app, prepared)) = with(|m| {
    m.get_mut(run).map(|r| {
      kill(r);
      r.info.state = "stopped";
      r.info.error = None;
      (r.target.clone(), r.app.clone(), r.prepared)
    })
  }) else {
    return;
  };
  if let Some(app) = &app {
    let info = with(|m| m.get(run).map(|r| r.info.clone()));
    let _ = app.emit(EVENT, info);
  }
  if prepared && wire::valid_run(run) {
    let script = cleanup_script(run);
    std::thread::spawn(move || {
      if let Err(e) = ssh_hosts::remote(&target, &script) {
        log::info!("ssh browser relay cleanup: {e}");
      }
    });
  }
}

/// Dials the relay, and again after each drop, until the run stops.
fn supervise(run: &str) {
  #[cfg(unix)]
  {
    let uid = kingu_ptyd::peer::own_uid();
    let local = local_socket(&std::env::temp_dir(), uid, run);
    let listener = match bind(&local) {
      Ok(l) => l,
      Err(e) => return set_state(run, "lost", Some(e)),
    };
    with(|m| m.get_mut(run).map(|r| r.local = Some(local.clone())));
    let r = run.to_string();
    let _ = std::thread::Builder::new().name("ssh-browser-relay-accept".into()).spawn(move || accept(&r, listener));
    let mut failures = 0usize;
    while !stopping(run) {
      match dial(run, &local) {
        Ok(()) => failures = 0,
        Err(e) => {
          log::info!("ssh browser relay {run}: {e}");
          set_state(run, "lost", Some(e));
        }
      }
      if stopping(run) {
        break;
      }
      let wait = Duration::from_secs(BACKOFF_S[failures.min(BACKOFF_S.len() - 1)]);
      failures += 1;
      let until = Instant::now() + wait;
      while Instant::now() < until && !stopping(run) {
        std::thread::sleep(Duration::from_millis(200));
      }
    }
  }
  #[cfg(not(unix))]
  set_state(run, "lost", Some("Browser tools on SSH hosts need macOS or Linux.".into()));
}

/// One connection: prepare the host, run `ssh -R` until it ends.
#[cfg(unix)]
fn dial(run: &str, local: &Path) -> Result<(), String> {
  let Some((target, token)) = with(|m| m.get(run).map(|r| (r.target.clone(), r.token.clone()))) else { return Ok(()) };
  let out = ssh_hosts::remote_input(&target, &prepare_script(run), Some(format!("{token}\n").into_bytes()), Duration::from_millis(ssh_hosts::REMOTE_TIMEOUT_MS))?;
  let home = parse_home(&out).ok_or("the host did not say where its home folder is")?;
  with(|m| m.get_mut(run).map(|r| r.prepared = true));
  let remote = wire::socket_path(Path::new(&home), run);
  let args = forward_args(&target, remote.to_str().ok_or("bad host path")?, local)?;
  let mut child = crate::shell_env::command(Path::new("ssh")).args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| format!("ssh: {e}"))?;
  let started = Instant::now();
  while started.elapsed() < UP_AFTER {
    if let Ok(Some(_)) = child.try_wait() {
      return Err(last_line(&mut child));
    }
    std::thread::sleep(Duration::from_millis(50));
  }
  let id = child.id();
  let kept = with(|m| match m.get_mut(run).filter(|r| !r.stop) {
    Some(r) => {
      r.child = Some(child);
      None
    }
    None => Some(child),
  });
  if let Some(mut c) = kept {
    let _ = c.kill();
    let _ = c.wait();
    return Ok(());
  }
  set_state(run, "ready", None);
  // Until ssh ends (the connection dropped) or the run stops (the child is killed then).
  loop {
    std::thread::sleep(Duration::from_millis(250));
    let ended = with(|m| match m.get_mut(run) {
      Some(r) if !r.stop => match r.child.as_mut().filter(|c| c.id() == id).map(Child::try_wait) {
        Some(Ok(None)) => None,
        Some(_) => r.child.take().map(|mut c| last_line(&mut c)).or(Some(String::new())),
        None => Some(String::new()),
      },
      _ => Some(String::new()),
    });
    if let Some(e) = ended {
      if stopping(run) {
        return Ok(());
      }
      return Err(if e.is_empty() { "The SSH connection for the browser relay ended.".into() } else { e });
    }
  }
}

#[cfg(unix)]
fn last_line(child: &mut Child) -> String {
  let mut err = String::new();
  if let Some(mut e) = child.stderr.take() {
    let _ = e.read_to_string(&mut err);
  }
  err.lines().rfind(|l| !l.trim().is_empty()).unwrap_or("ssh exited").trim().to_string()
}

#[cfg(unix)]
fn bind(path: &Path) -> Result<std::os::unix::net::UnixListener, String> {
  use std::os::unix::fs::PermissionsExt;
  if let Some(dir) = path.parent() {
    kingu_ptyd::peer::prepare_dir(dir)?;
  }
  let _ = std::fs::remove_file(path);
  let l = std::os::unix::net::UnixListener::bind(path).map_err(|e| format!("bind {}: {e}", path.display()))?;
  std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|e| format!("{}: {e}", path.display()))?;
  l.set_nonblocking(true).map_err(|e| e.to_string())?;
  Ok(l)
}

#[cfg(unix)]
fn accept(run: &str, listener: std::os::unix::net::UnixListener) {
  while !stopping(run) {
    match listener.accept() {
      Ok((stream, _)) => {
        let r = run.to_string();
        let _ = std::thread::Builder::new().name("ssh-browser-relay-call".into()).spawn(move || serve(&r, stream));
      }
      Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
      Err(_) => std::thread::sleep(Duration::from_millis(100)),
    }
  }
}

/// One call: a request line, a reply line.
#[cfg(unix)]
fn serve(run: &str, stream: std::os::unix::net::UnixStream) {
  // The forwarding ssh is this user's process; nobody else's may talk here.
  if let Err(e) = kingu_ptyd::peer::check_stream(&stream) {
    log::warn!("ssh browser relay: {e}");
    return;
  }
  let _ = stream.set_nonblocking(false);
  let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
  let Ok(read) = stream.try_clone() else { return };
  let mut line = String::new();
  if BufReader::new(read).take(wire::MAX_REQUEST as u64 + 1).read_line(&mut line).unwrap_or(0) == 0 {
    return;
  }
  let reply = handle(run, &line);
  let mut w = stream;
  let _ = w.write_all(format!("{}\n", serde_json::to_string(&reply).unwrap_or_else(|_| "{\"ok\":false}".into())).as_bytes());
}

/// The run's pages the user stopped.
fn stopped_pages(key: &str) -> usize {
  agent::agent_browser_pages().iter().filter(|p| p.stopped && p.opener.as_deref() == Some(key)).count()
}

fn handle(run: &str, line: &str) -> RelayReply {
  let Some((app, token, session, key, label)) = with(|m| m.get(run).filter(|r| !r.stop).map(|r| (r.app.clone(), r.token.clone(), r.session.clone(), r.key.clone(), r.info.label.clone()))) else {
    return RelayReply::err(wire::UNREACHABLE);
  };
  let req = match check_request(line, &token) {
    Ok(r) => r,
    Err(e) => return RelayReply::err(e),
  };
  let Some(app) = app else { return RelayReply::err(wire::UNREACHABLE) };
  if !agent::enabled(&app) {
    return RelayReply::err(format!("Browser tools are turned off in Kingu ({}). Ask the user to turn them on.", agent::SETTING));
  }
  let busy = with(|m| match m.get_mut(run) {
    Some(r) if r.calls < MAX_CALLS => {
      r.calls += 1;
      false
    }
    _ => true,
  });
  if busy {
    return RelayReply::err("Too many browser steps are waiting. Wait for one to finish.");
  }
  let out = run_call(&app, run, &req, &session, &key, &label);
  with(|m| m.get_mut(run).map(|r| r.calls = r.calls.saturating_sub(1)));
  match out {
    Ok(v) => RelayReply::ok(v),
    Err(e) => RelayReply::err(e),
  }
}

fn run_call(app: &AppHandle, run: &str, req: &RelayRequest, session: &str, key: &str, label: &str) -> Result<Value, String> {
  let mut params = host_params(&req.params);
  if needs_grant(&req.method, &Value::Object(params.clone())) {
    let stopped = stopped_pages(key);
    let allowed = with(|m| m.get(run).is_some_and(|r| r.grant.allowed(stopped)));
    if !allowed {
      let url = params.get("url").and_then(Value::as_str).unwrap_or("").to_string();
      let kind = if req.method == "browser.open" { "open" } else { "navigate" };
      let ask = json!({ "host": label, "url": url, "kind": kind, "run": &run[..run.len().min(8)] });
      let answer = crate::cli_server::ask_window_for(app, None, GRANT_METHOD, ask, GRANT_TIMEOUT).map_err(|e| format!("Kingu could not ask the user: {}", e.message))?;
      let answer = answer.get("answer").and_then(Value::as_str).unwrap_or("deny").to_string();
      // The run may have ended while the user was asked.
      let res = with(|m| match m.get_mut(run).filter(|r| !r.stop) {
        Some(r) => {
          let res = r.grant.answer(&answer, stopped);
          r.info.allowed_for_run = r.grant.allowed(stopped);
          Some(res)
        }
        None => None,
      });
      emit(run);
      res.ok_or_else(|| wire::UNREACHABLE.to_string())??;
    }
  }
  params.insert("session".into(), Value::String(session.to_string()));
  agent::dispatch(app, &req.method, &Value::Object(params))
}

// ---- Commands ------------------------------------------------------------------------------------

/// The runs whose agent may use the browser from an SSH host.
#[tauri::command]
pub fn ssh_browser_relays() -> Vec<RelayInfo> {
  let mut v: Vec<RelayInfo> = with(|m| m.values().map(|r| r.info.clone()).collect());
  v.sort_by(|a, b| a.run.cmp(&b.run));
  v
}

/// Stop: the run's agent may no longer use the browser.
#[tauri::command]
pub fn ssh_browser_relay_stop(run: String) {
  stop_run(&run);
}

/// Ends every relay when the app quits (the `ssh -R` children would outlive it).
pub struct Guard;

impl Drop for Guard {
  fn drop(&mut self) {
    with(|m| m.values_mut().for_each(kill));
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn target() -> Target {
    serde_json::from_value(json!({ "id": "box", "label": "box", "host": "box.example", "port": 22, "username": "u" })).unwrap()
  }

  #[test]
  fn open_and_addresses_ask_the_rest_does_not() {
    assert!(needs_grant("browser.open", &json!({ "url": "https://a.dev" })));
    assert!(needs_grant("browser.navigate", &json!({ "url": "https://a.dev" })));
    assert!(needs_grant("browser.navigate", &json!({ "type": "url", "url": "https://a.dev" })));
    for t in ["back", "forward", "reload"] {
      assert!(!needs_grant("browser.navigate", &json!({ "type": t })));
    }
    for m in ["browser.read", "browser.click", "browser.type", "browser.screenshot"] {
      assert!(!needs_grant(m, &json!({})));
    }
  }

  #[test]
  fn a_run_grant_lasts_until_a_page_of_the_run_is_stopped() {
    let mut g = Grant::default();
    assert!(!g.allowed(0));
    assert!(g.answer("once", 0).is_ok());
    assert!(!g.allowed(0), "once is once");
    assert!(g.answer("run", 0).is_ok());
    assert!(g.allowed(0));
    assert!(!g.allowed(1), "Stop on a page takes it back");
    assert!(g.answer("run", 1).is_ok());
    assert!(g.allowed(1));
    assert!(g.answer("deny", 1).unwrap_err().contains("declined"));
    assert!(!g.allowed(1));
    assert!(g.answer("", 1).is_err());
  }

  #[test]
  fn requests_need_the_runs_token_and_a_browser_tool() {
    let tok = "a".repeat(64);
    let line = |token: &str, method: &str| json!({ "token": token, "method": method, "params": { "pageId": "p", "session": "stolen", "cwd": "/etc" } }).to_string();
    let req = check_request(&line(&tok, "browser.read"), &tok).unwrap();
    assert_eq!(req.method, "browser.read");
    let p = host_params(&req.params);
    assert!(p.get("session").is_none() && p.get("cwd").is_none() && p["pageId"] == "p");
    assert!(check_request(&line(&"b".repeat(64), "browser.read"), &tok).unwrap_err().contains("unauthorized"));
    assert!(check_request(&line("", "browser.read"), &tok).unwrap_err().contains("unauthorized"));
    assert!(check_request(&line(&tok, "browser.eval"), &tok).unwrap_err().contains("not available"));
    assert!(check_request(&line(&tok, "task.create"), &tok).is_err());
    assert!(check_request("garbage", &tok).is_err());
    assert!(check_request(&"x".repeat(wire::MAX_REQUEST + 1), &tok).unwrap_err().contains("too large"));
  }

  #[test]
  fn a_claude_on_the_host_gets_the_mcp_server_last() {
    let holder = "kingu-ptyd-0.1.0-0123456789abcdef";
    let run = "abcdef123456abcdef123456";
    let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let out = mcp_argv(&a(&["claude", "--resume"]), holder, run).unwrap();
    assert_eq!(&out[..2], &a(&["claude", "--resume"])[..]);
    assert_eq!(out[2], "--mcp-config");
    let cfg: Value = serde_json::from_str(&out[3]).unwrap();
    let server = &cfg["mcpServers"]["kingu-browser"];
    assert_eq!(server["command"], "sh");
    assert_eq!(server["args"][1], format!("exec \"$HOME/.kingu/host/{holder}/kingu-ptyd\" browser-mcp --run {run}"));
    assert!(!out[3].contains("token"), "no secret on the command line");
    // Before a `--`, and through `env`.
    let out = mcp_argv(&a(&["env", "A=1", "/opt/bin/claude", "--", "fix it"]), holder, run).unwrap();
    assert_eq!(out[3], "--mcp-config");
    assert_eq!(&out[5..], &a(&["--", "fix it"])[..]);
    // Not claude, or ids that could reach a shell: nothing.
    assert!(mcp_argv(&a(&["codex"]), holder, run).is_none());
    assert!(mcp_argv(&a(&["claude"]), "kingu-ptyd-$(id)", run).is_none());
    assert!(mcp_argv(&a(&["claude"]), holder, "x; rm -rf ~").is_none());
  }

  #[test]
  fn forward_arguments_are_a_private_connection_of_their_own() {
    let a = forward_args(&target(), "/home/u/.kingu/host/browser/abcdef12.sock", Path::new("/tmp/kingu-br-501/abcdef12.sock")).unwrap();
    let j = a.join(" ");
    for want in ["-N", "ExitOnForwardFailure=yes", "BatchMode=yes", "StreamLocalBindUnlink=yes", "ControlPath=none", "ServerAliveInterval=15", "-R /home/u/.kingu/host/browser/abcdef12.sock:/tmp/kingu-br-501/abcdef12.sock"] {
      assert!(j.contains(want), "{want} in {j}");
    }
    assert_eq!(a.last().unwrap(), "u@box.example");
    assert!(forward_args(&target(), "relative.sock", Path::new("/tmp/x.sock")).is_err());
    assert!(forward_args(&target(), "/home/u:x/s.sock", Path::new("/tmp/x.sock")).is_err());
    assert!(local_socket(Path::new("/var/folders/ab/T"), 501, "abcdef12").ends_with("kingu-br-501/abcdef12.sock"));
    assert_eq!(local_socket(&PathBuf::from("/x".repeat(60)), 501, "abcdef12"), PathBuf::from("/tmp/kingu-br-501/abcdef12.sock"));
  }

  /// The host scripts, run with `sh` and a temporary `$HOME` (never on a host): the token arrives on
  /// stdin into a 0600 file in a 0700 folder, and the cleanup removes it.
  #[cfg(unix)]
  #[test]
  fn the_host_scripts_keep_the_token_private() {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    let run = "abcdef123456";
    let mut c = Command::new("sh").arg("-c").arg(prepare_script(run)).env("HOME", home.path()).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    c.stdin.take().unwrap().write_all(b"secret-token\n").unwrap();
    let out = c.wait_with_output().unwrap();
    assert!(out.status.success());
    let printed = parse_home(&String::from_utf8_lossy(&out.stdout)).unwrap();
    assert_eq!(Path::new(&printed), home.path());
    let dir = home.path().join(wire::DIR);
    assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    let tok = wire::token_path(home.path(), run);
    assert_eq!(std::fs::metadata(&tok).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(wire::read_token(home.path(), run).unwrap(), "secret-token");
    assert!(!prepare_script(run).contains("secret"), "the token is never in the script");
    let ok = Command::new("sh").arg("-c").arg(cleanup_script(run)).env("HOME", home.path()).status().unwrap();
    assert!(ok.success() && !tok.exists());
    assert_eq!(parse_home("noise\n@@kingu-home relative\n"), None);
  }

  /// Against a real sshd: `KINGU_SSH_CONFIG` is an ssh config whose host `relaytest` reaches it
  /// with a key (no prompt). The run's token goes to the host, `ssh -R` binds the host socket 0600,
  /// a call from the host reaches this side's token check, a dropped connection is refused cleanly
  /// and redialed, and stopping removes the token from the host.
  /// `cargo test -p kingu-desktop --lib ssh_browser_relay::tests::e2e -- --ignored`.
  #[cfg(unix)]
  #[test]
  #[ignore]
  fn e2e_over_a_real_ssh() {
    use std::os::unix::fs::PermissionsExt;
    if std::env::var_os("KINGU_SSH_CONFIG").is_none() {
      return;
    }
    let run = "e2e0e2e0e2e0e2e0";
    let mut t = target();
    t.config_host = Some("relaytest".into());
    with(|m| {
      let info = RelayInfo { run: run.into(), host: "box".into(), label: "box".into(), state: "starting", error: None, allowed_for_run: false };
      m.insert(run.into(), Relay { info, app: None, target: t.clone(), token: "t".repeat(64), session: "s".into(), key: format!("ssh:box:{run}"), grant: Grant::default(), calls: 0, stop: false, child: None, local: None, prepared: false });
    });
    let state = || ssh_browser_relays().into_iter().find(|r| r.run == run).unwrap();
    let wait_for = |want: &str| {
      let start = Instant::now();
      while state().state != want {
        assert!(start.elapsed() < Duration::from_secs(30), "{:?}", state());
        std::thread::sleep(Duration::from_millis(100));
      }
    };
    let supervisor = std::thread::spawn(move || supervise(run));
    wait_for("ready");
    let home = PathBuf::from(ssh_hosts::remote(&t, "printf %s \"$HOME\"").unwrap());
    let socket = wire::socket_path(&home, run);
    assert_eq!(std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777, 0o600, "sshd binds the host socket 0600");
    let token = wire::read_token(&home, run).unwrap();
    let call = |tok: &str| wire::call(&socket, tok, "browser.read", &json!({ "pageId": "p" }), Duration::ZERO, Duration::from_secs(10));
    assert!(call("wrong").unwrap_err().contains("unauthorized"), "the call crossed the connection to the token check");
    assert_eq!(call(&token).unwrap_err(), wire::UNREACHABLE, "no window behind the test relay");
    // The connection drops: refused cleanly, then dialed again.
    with(|m| m.get_mut(run).and_then(|r| r.child.as_mut()).map(Child::kill));
    wait_for("lost");
    assert_eq!(call("wrong").unwrap_err(), wire::UNREACHABLE);
    wait_for("ready");
    assert!(call("wrong").unwrap_err().contains("unauthorized"));
    stop_run(run);
    supervisor.join().unwrap();
    let start = Instant::now();
    while wire::token_path(&home, run).exists() {
      assert!(start.elapsed() < Duration::from_secs(20), "the token is removed from the host");
      std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(call(&token).unwrap_err(), wire::UNREACHABLE);
  }

  /// A request through the relay socket with no window behind it: the token is checked before
  /// anything else, and a stopped run refuses like a dropped connection.
  #[test]
  fn a_stopped_or_unknown_run_is_unreachable() {
    assert_eq!(handle("0000000000000000", "{}").error.as_deref(), Some(wire::UNREACHABLE));
    with(|m| {
      let info = RelayInfo { run: "1111111111111111".into(), host: "box".into(), label: "box".into(), state: "ready", error: None, allowed_for_run: false };
      m.insert("1111111111111111".into(), Relay { info, app: None, target: target(), token: "t".repeat(64), session: "s".into(), key: "ssh:box:1111111111111111".into(), grant: Grant::default(), calls: 0, stop: false, child: None, local: None, prepared: false });
    });
    // Through the sockets, as the host's MCP server calls: the peer and the token are checked.
    #[cfg(unix)]
    {
      let dir = tempfile::tempdir().unwrap();
      let local = dir.path().join("r.sock");
      let listener = bind(&local).unwrap();
      let accepting = std::thread::spawn(|| accept("1111111111111111", listener));
      let call = |token: &str| wire::call(&local, token, "browser.read", &json!({ "pageId": "p" }), Duration::ZERO, Duration::from_secs(5));
      assert!(call(&"x".repeat(64)).unwrap_err().contains("unauthorized"));
      // The right token, but no window behind this test relay: refused as unreachable, nothing ran.
      assert_eq!(call(&"t".repeat(64)).unwrap_err(), wire::UNREACHABLE);
      stop_run("1111111111111111");
      accepting.join().unwrap();
    }
    stop_run("1111111111111111");
    assert_eq!(ssh_browser_relays().iter().find(|r| r.run == "1111111111111111").unwrap().state, "stopped");
    let line = json!({ "token": "t".repeat(64), "method": "browser.read", "params": {} }).to_string();
    assert_eq!(handle("1111111111111111", &line).error.as_deref(), Some(wire::UNREACHABLE));
  }
}
