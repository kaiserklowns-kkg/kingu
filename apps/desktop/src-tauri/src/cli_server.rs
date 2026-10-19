//! The app's end of the `kingu` command (crates/kingu-cli; old Kingu's / Orca's CLI runtime).
//! At startup Kingu listens on a Unix socket in `<app data>/cli` (a 0700 folder; the socket is
//! 0600 and each peer's uid is checked) and writes `runtime.json` (0600) with the socket path and
//! a fresh random token that every request must carry. Requests are JSON lines
//! (`kingu_cli::protocol`): `status` and `task.list` are answered here; `task.create`,
//! `task.open` and `open` go to the window as a `kingu-cli:request` event, which answers through
//! `cli_reply` (cliBridge.svelte.ts); `notify` posts a notification.
//!
//! The bundled `kingu-cli` binary is linked as `<app data>/cli/bin/kingu`; that folder goes first
//! on the PATH of Kingu's terminals and the agent host, so agents can run `kingu`. "Shell Command:
//! Install 'kingu' command in PATH" links it into /usr/local/bin (else ~/.local/bin), like VS
//! Code's `code`. Agents also get a `kingu` skill (skills/kingu/SKILL.md) as a Claude plugin.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock, mpsc};
use std::time::Duration;

use kingu_cli::protocol::{self, ERR_BAD_REQUEST, ERR_FAILED, ERR_UNAVAILABLE, ERR_UNKNOWN_METHOD, RpcError};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::i18n::msg::CliMsg;
use crate::tr;

/// Sent to the window: `{ id, method, params }`; answered with `cli_reply`.
pub const REQUEST_EVENT: &str = "kingu-cli:request";
const WINDOW_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_TITLE: usize = 200;
const MAX_PROMPT: usize = 64 * 1024;
const MAX_MESSAGE: usize = 1000;
/// The name agents and people type; the bundled binary is `kingu-cli` (see crates/kingu-cli/Cargo.toml).
pub const COMMAND: &str = "kingu";
const BUNDLED: &str = if cfg!(windows) { "kingu-cli.exe" } else { "kingu-cli" };
pub(crate) const SKILL_MD: &str = include_str!("../skills/kingu/SKILL.md");
/// `<app cache>/kingu-plugin/<hash>` holds the skill as a Claude plugin.
pub const PLUGIN_DIR: &str = "kingu-plugin";

/// `<app data>/cli/bin`, holding the `kingu` link, once the server runs.
static BIN_DIR: OnceLock<PathBuf> = OnceLock::new();
/// `<app data>/cli/runtime.json`, once written.
static RUNTIME: OnceLock<PathBuf> = OnceLock::new();

#[derive(Default)]
pub struct CliServer {
  pending: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
  next: AtomicU64,
}

pub fn bin_dir() -> Option<&'static Path> {
  BIN_DIR.get().map(PathBuf::as_path)
}

/// The bundled command: `KINGU_CLI_BIN`, else `kingu-cli` next to the app executable (release:
/// `Contents/MacOS`; dev: `target/debug`, built with the app's workspace).
pub fn find_bundled(override_var: Option<std::ffi::OsString>, exe_dir: Option<&Path>) -> Option<PathBuf> {
  if let Some(p) = override_var.filter(|o| !o.is_empty()).map(PathBuf::from) {
    return p.is_file().then_some(p);
  }
  exe_dir.map(|d| d.join(BUNDLED)).filter(|p| p.is_file())
}

fn bundled() -> Option<PathBuf> {
  let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf));
  find_bundled(std::env::var_os("KINGU_CLI_BIN"), exe_dir.as_deref())
}

/// `dir` first, then the entries of `base` (without repeats).
pub fn prepend_path(dir: &Path, base: Option<&std::ffi::OsStr>) -> Option<String> {
  crate::shell_env::merge(Some(dir.as_os_str()), base).and_then(|p| p.into_string().ok())
}

/// Terminal env: `kingu` on PATH and `KINGU_CLI_RUNTIME`, unless `terminal.integrated.env` unsets them.
pub fn terminal_env(env: &mut BTreeMap<String, String>, unset: &[String]) {
  let (Some(bin), Some(runtime)) = (BIN_DIR.get(), RUNTIME.get()) else { return };
  if !unset.iter().any(|k| k == "PATH") {
    let base = env.get("PATH").map(std::ffi::OsString::from).or_else(crate::shell_env::path);
    if let Some(p) = prepend_path(bin, base.as_deref()) {
      env.insert("PATH".into(), p);
    }
  }
  if !unset.iter().any(|k| k == kingu_cli::runtime::ENV_RUNTIME) {
    env.entry(kingu_cli::runtime::ENV_RUNTIME.into()).or_insert_with(|| runtime.display().to_string());
  }
}

// ---------------------------------------------------------------------------------------------
// Requests

fn rpc(code: &str, message: String) -> RpcError {
  RpcError::new(code, message)
}

fn str_param<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
  params.get(key).and_then(Value::as_str)
}

/// What `task.create` sends to the window, checked here first.
pub fn check_create(params: &Value) -> Result<Value, RpcError> {
  let title = str_param(params, "title").unwrap_or_default().trim();
  if title.is_empty() {
    return Err(rpc(ERR_BAD_REQUEST, tr!(CliMsg::TitleRequired)));
  }
  if title.chars().count() > MAX_TITLE {
    return Err(rpc(ERR_BAD_REQUEST, tr!(CliMsg::TitleTooLong, max = MAX_TITLE)));
  }
  let prompt = str_param(params, "prompt").unwrap_or_default();
  if prompt.len() > MAX_PROMPT {
    return Err(rpc(ERR_BAD_REQUEST, tr!(CliMsg::PromptTooLarge, max = MAX_PROMPT / 1024)));
  }
  let base = str_param(params, "base").map(str::trim).filter(|b| !b.is_empty());
  if let Some(b) = base {
    crate::git::check_rev(b).map_err(|e| rpc(ERR_BAD_REQUEST, e))?;
  }
  let mode = str_param(params, "mode").filter(|m| !m.is_empty());
  if let Some(m) = mode.filter(|m| !matches!(*m, "terminal" | "timeline")) {
    return Err(rpc(ERR_BAD_REQUEST, tr!(CliMsg::BadMode, mode = m)));
  }
  let open = params.get("open").and_then(Value::as_bool).unwrap_or(true);
  Ok(json!({ "title": title, "prompt": prompt, "base": base, "mode": mode, "open": open }))
}

/// What `open` sends to the window: the real path, file or folder, and the position.
pub fn check_open(params: &Value) -> Result<Value, RpcError> {
  let raw = str_param(params, "path").unwrap_or_default();
  let path = Path::new(raw);
  if !path.is_absolute() {
    return Err(rpc(ERR_BAD_REQUEST, tr!(CliMsg::PathNotAbsolute)));
  }
  let real = std::fs::canonicalize(path).map_err(|_| rpc(ERR_FAILED, tr!(CliMsg::PathNotFound, path = raw)))?;
  let kind = if real.is_dir() { "folder" } else { "file" };
  let pos = |k: &str| params.get(k).and_then(Value::as_u64).filter(|n| (1..=u32::MAX as u64).contains(n));
  Ok(json!({ "path": real.display().to_string(), "kind": kind, "line": pos("line"), "column": pos("column") }))
}

/// `notify`'s title and message.
pub fn check_notify(params: &Value) -> Result<(String, String), RpcError> {
  let message = str_param(params, "message").unwrap_or_default().trim();
  if message.is_empty() {
    return Err(rpc(ERR_BAD_REQUEST, tr!(CliMsg::MessageRequired)));
  }
  let title = str_param(params, "title").map(str::trim).filter(|t| !t.is_empty()).unwrap_or("Kingu");
  if message.chars().count() > MAX_MESSAGE || title.chars().count() > MAX_TITLE {
    return Err(rpc(ERR_BAD_REQUEST, tr!(CliMsg::MessageTooLong, max = MAX_MESSAGE)));
  }
  Ok((title.to_owned(), message.to_owned()))
}

/// A task as `kingu task list` shows it.
pub fn task_row(t: &crate::agent::tasks::TaskMeta) -> Value {
  json!({
    "slug": t.slug,
    "title": t.title,
    "status": t.status,
    "base": t.base,
    "agent": t.agent,
    "pr_url": t.pr_url,
    "issue": t.issue.as_ref().map(|i| i.key.clone().unwrap_or_else(|| format!("#{}", i.number))),
    "created_at": t.created_at,
    "updated_at": t.updated_at,
  })
}

fn folder(app: &AppHandle) -> Result<PathBuf, RpcError> {
  app.state::<crate::workspace::Workspace>().current().ok_or_else(|| rpc(ERR_FAILED, tr!(CliMsg::NoFolder)))
}

fn tasks(root: &Path) -> Result<Vec<crate::agent::tasks::TaskMeta>, RpcError> {
  crate::agent::tasks::load(root).map_err(|e| rpc(ERR_FAILED, e))
}

/// Hands a request to the window (brought to the front with `focus`) and waits for its `cli_reply`.
fn ask_window(app: &AppHandle, method: &str, params: Value, focus: bool) -> Result<Value, RpcError> {
  let server = app.state::<CliServer>();
  let id = server.next.fetch_add(1, Ordering::Relaxed) + 1;
  let (tx, rx) = mpsc::channel();
  server.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
  if focus {
    crate::notify::focus_main(app);
  }
  let sent = app.emit(REQUEST_EVENT, json!({ "id": id, "method": method, "params": params }));
  let answer = match sent {
    Ok(()) => rx.recv_timeout(WINDOW_TIMEOUT).ok(),
    Err(e) => Some(Err(e.to_string())),
  };
  server.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
  match answer {
    Some(Ok(v)) => Ok(v),
    Some(Err(e)) => Err(rpc(ERR_FAILED, e)),
    None => Err(rpc(ERR_UNAVAILABLE, tr!(CliMsg::WindowNoAnswer))),
  }
}

fn dispatch(app: &AppHandle, method: &str, params: &Value) -> Result<Value, RpcError> {
  match method {
    protocol::METHOD_STATUS => {
      let root = app.state::<crate::workspace::Workspace>().current();
      let count = root.as_deref().and_then(|r| crate::agent::tasks::load(r).ok()).map(|t| t.len());
      Ok(json!({ "app_version": env!("CARGO_PKG_VERSION"), "pid": std::process::id(), "workspace": root.map(|r| r.display().to_string()), "tasks": count }))
    }
    protocol::METHOD_TASK_LIST => {
      let list = tasks(&folder(app)?)?;
      Ok(json!({ "tasks": list.iter().map(task_row).collect::<Vec<_>>() }))
    }
    protocol::METHOD_TASK_CREATE => {
      folder(app)?;
      let checked = check_create(params)?;
      let focus = checked["open"] == json!(true);
      ask_window(app, method, checked, focus)
    }
    protocol::METHOD_TASK_OPEN => {
      let slug = str_param(params, "slug").unwrap_or_default();
      crate::agent::worktree::validate_slug(slug).map_err(|e| rpc(ERR_BAD_REQUEST, e))?;
      if !tasks(&folder(app)?)?.iter().any(|t| t.slug == slug) {
        return Err(rpc(ERR_FAILED, tr!(CliMsg::UnknownTask, slug)));
      }
      ask_window(app, method, json!({ "slug": slug }), true)
    }
    protocol::METHOD_OPEN => {
      let checked = check_open(params)?;
      ask_window(app, method, checked, true)
    }
    protocol::METHOD_NOTIFY => {
      let (title, body) = check_notify(params)?;
      crate::notify::show(app, title, body).map_err(|e| rpc(ERR_FAILED, e))?;
      Ok(Value::Null)
    }
    other => Err(rpc(ERR_UNKNOWN_METHOD, tr!(CliMsg::UnknownMethod, method = other))),
  }
}

// ---------------------------------------------------------------------------------------------
// Socket

#[cfg(unix)]
mod socket {
  use std::io::{BufRead, BufReader, Read, Write};
  use std::os::unix::fs::PermissionsExt;
  use std::os::unix::net::{UnixListener, UnixStream};
  use std::path::{Path, PathBuf};

  use kingu_cli::protocol;
  use tauri::AppHandle;

  /// `<dir>/kingu.sock`, or a private folder in the temp dir when that path is too long for a
  /// Unix socket (macOS allows 104 bytes).
  pub fn socket_path(dir: &Path, temp: &Path, uid: u32) -> PathBuf {
    let preferred = dir.join(kingu_cli::runtime::SOCKET);
    if preferred.as_os_str().len() < 100 { preferred } else { temp.join(format!("kingu-cli-{uid}")).join(kingu_cli::runtime::SOCKET) }
  }

  /// Binds readable and writable by this user only (the umask covers the moment before chmod).
  pub fn bind_private(path: &Path) -> Result<UnixListener, String> {
    match std::fs::remove_file(path) {
      Ok(()) => {}
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
      Err(e) => return Err(format!("{}: {e}", path.display())),
    }
    // SAFETY: umask only swaps the process file-creation mask; restored right after bind.
    let old = unsafe { libc::umask(0o177) };
    let bound = UnixListener::bind(path);
    unsafe { libc::umask(old) };
    let listener = bound.map_err(|e| format!("bind {}: {e}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(listener)
  }

  /// Answers request lines until the peer closes; `handle` maps a line to its answer.
  pub fn serve(stream: UnixStream, handle: impl Fn(&str) -> protocol::Response) {
    if let Err(e) = kingu_ptyd::peer::check_stream(&stream) {
      log::warn!("kingu command: {e}");
      return;
    }
    let Ok(read) = stream.try_clone() else { return };
    let mut reader = BufReader::new(read);
    let mut writer = stream;
    loop {
      let mut line = String::new();
      match (&mut reader).take(protocol::MAX_LINE as u64 + 1).read_line(&mut line) {
        Ok(0) | Err(_) => return,
        Ok(_) => {}
      }
      let answer = handle(&line);
      if writer.write_all(protocol::encode(&answer).as_bytes()).is_err() || line.len() > protocol::MAX_LINE {
        return;
      }
    }
  }

  pub fn start(app: AppHandle, listener: UnixListener, token: String) {
    let spawned = std::thread::Builder::new().name("kingu-cli".into()).spawn(move || {
      for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let (app, token) = (app.clone(), token.clone());
        let _ = std::thread::Builder::new().name("kingu-cli-conn".into()).spawn(move || {
          serve(stream, |line| protocol::handle_line(line, &token, |req| super::dispatch(&app, &req.method, &req.params)));
        });
      }
    });
    if let Err(e) = spawned {
      log::warn!("kingu command: {e}");
    }
  }
}

/// Links `<dir>/kingu` to `target`, replacing only an older link to a Kingu command.
pub fn link_into(dir: &Path, target: &Path) -> Result<PathBuf, String> {
  let link = dir.join(if cfg!(windows) { "kingu.exe" } else { COMMAND });
  match std::fs::symlink_metadata(&link) {
    Ok(m) if m.file_type().is_symlink() => {
      let to = std::fs::read_link(&link).unwrap_or_default();
      if to == target {
        return Ok(link);
      }
      if !is_kingu_link(&to) {
        return Err(tr!(CliMsg::LinkTaken, path = link.display()));
      }
      std::fs::remove_file(&link).map_err(|e| tr!(CliMsg::InstallFailed, dir = dir.display(), detail = e))?;
    }
    Ok(_) => return Err(tr!(CliMsg::LinkTaken, path = link.display())),
    Err(_) => {}
  }
  symlink(target, &link).map_err(|e| tr!(CliMsg::InstallFailed, dir = dir.display(), detail = e))?;
  Ok(link)
}

/// Removes `<dir>/kingu` when it is a link to a Kingu command; whether it did.
pub fn unlink_from(dir: &Path) -> Result<bool, String> {
  let link = dir.join(COMMAND);
  let ours = std::fs::symlink_metadata(&link).is_ok_and(|m| m.file_type().is_symlink()) && std::fs::read_link(&link).is_ok_and(|t| is_kingu_link(&t));
  if !ours {
    return Ok(false);
  }
  std::fs::remove_file(&link).map_err(|e| tr!(CliMsg::UninstallFailed, path = link.display(), detail = e))?;
  Ok(true)
}

fn is_kingu_link(target: &Path) -> bool {
  target.file_name().is_some_and(|n| n == BUNDLED || n == "kingu-cli")
}

#[cfg(unix)]
fn symlink(target: &Path, link: &Path) -> std::io::Result<()> {
  std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
fn symlink(_target: &Path, _link: &Path) -> std::io::Result<()> {
  Err(std::io::Error::new(std::io::ErrorKind::Unsupported, tr!(CliMsg::Unsupported)))
}

/// Starts the server (Unix). Never fails the app's start: problems are logged.
pub fn install(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
  app.manage(CliServer::default());
  #[cfg(unix)]
  if let Err(e) = start(app.handle()) {
    log::warn!("kingu command unavailable: {e}");
  }
  Ok(())
}

#[cfg(unix)]
fn start(app: &AppHandle) -> Result<(), String> {
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join(kingu_cli::runtime::DIR);
  kingu_ptyd::peer::prepare_dir(&dir)?;
  let uid = kingu_ptyd::peer::own_uid();
  let socket = socket::socket_path(&dir, &std::env::temp_dir(), uid);
  if let Some(parent) = socket.parent().filter(|p| *p != dir) {
    kingu_ptyd::peer::prepare_dir(parent)?;
  }
  let listener = socket::bind_private(&socket)?;
  let token = protocol::new_token()?;
  let runtime = dir.join(kingu_cli::runtime::FILE);
  let rt = kingu_cli::runtime::Runtime {
    version: kingu_cli::runtime::VERSION,
    pid: std::process::id(),
    socket: socket.display().to_string(),
    token: token.clone(),
    app_version: env!("CARGO_PKG_VERSION").into(),
  };
  kingu_cli::runtime::write(&runtime, &rt)?;
  socket::start(app.clone(), listener, token);
  let _ = RUNTIME.set(runtime);
  match bundled() {
    Some(exe) => {
      let bin = dir.join("bin");
      std::fs::create_dir_all(&bin).map_err(|e| format!("{}: {e}", bin.display()))?;
      link_into(&bin, &exe)?;
      let _ = BIN_DIR.set(bin);
    }
    None => log::info!("kingu command: no bundled {BUNDLED}; terminals get no kingu on PATH"),
  }
  log::info!("kingu command: listening on {}", socket.display());
  Ok(())
}

// ---------------------------------------------------------------------------------------------
// Commands

/// The window's answer to a `kingu-cli:request`.
#[tauri::command]
pub fn cli_reply(server: tauri::State<'_, CliServer>, id: u64, result: Option<Value>, error: Option<String>) {
  if let Some(tx) = server.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
    let _ = tx.send(match error {
      Some(e) => Err(e),
      None => Ok(result.unwrap_or(Value::Null)),
    });
  }
}

#[derive(Debug, serde::Serialize)]
pub struct Installed {
  pub path: String,
  /// The folder is on the login shell's PATH already.
  pub on_path: bool,
}

/// Where "Install 'kingu' command in PATH" links: /usr/local/bin, else ~/.local/bin.
pub fn install_dirs(home: Option<&Path>) -> Vec<PathBuf> {
  let mut dirs = vec![PathBuf::from("/usr/local/bin")];
  dirs.extend(home.map(|h| h.join(".local/bin")));
  dirs
}

#[tauri::command]
pub async fn cli_install() -> Result<Installed, String> {
  tauri::async_runtime::spawn_blocking(|| {
    if cfg!(windows) {
      return Err(tr!(CliMsg::Unsupported));
    }
    let exe = bundled().ok_or_else(|| tr!(CliMsg::NotBundled))?;
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let dirs = install_dirs(home.as_deref());
    let mut last = String::new();
    for (i, dir) in dirs.iter().enumerate() {
      // Someone else's `kingu`: never replaced, and not shadowed by ours either.
      let link = dir.join(COMMAND);
      if std::fs::symlink_metadata(&link).is_ok() && !std::fs::read_link(&link).is_ok_and(|t| is_kingu_link(&t)) {
        return Err(tr!(CliMsg::LinkTaken, path = link.display()));
      }
      // ~/.local/bin may not exist yet; /usr/local/bin is never created here.
      if i > 0 {
        let _ = std::fs::create_dir_all(dir);
      }
      match link_into(dir, &exe) {
        Ok(link) => {
          let on_path = crate::shell_env::path().is_some_and(|p| std::env::split_paths(&p).any(|d| d == *dir));
          log::info!("installed the kingu command at {}", link.display());
          return Ok(Installed { path: link.display().to_string(), on_path });
        }
        Err(e) => last = e,
      }
    }
    Err(last)
  })
  .await
  .map_err(|e| e.to_string())?
}

/// Removes the links "Install" made; the paths removed.
#[tauri::command]
pub fn cli_uninstall() -> Result<Vec<String>, String> {
  let home = std::env::var_os("HOME").map(PathBuf::from);
  let mut removed = Vec::new();
  for dir in install_dirs(home.as_deref()) {
    if unlink_from(&dir)? {
      removed.push(dir.join(COMMAND).display().to_string());
    }
  }
  log::info!("uninstalled the kingu command ({} links)", removed.len());
  Ok(removed)
}

/// Writes the plugin folder holding the `kingu` skill under `cache` (named by its content, so a
/// running agent's folder never changes) and returns it.
pub fn write_skill_plugin(cache: &Path) -> Result<PathBuf, String> {
  use sha2::{Digest, Sha256};
  let manifest = serde_json::to_string_pretty(&json!({ "name": COMMAND, "version": env!("CARGO_PKG_VERSION"), "description": "The kingu command: control the Kingu app from an agent" }))
    .map_err(|e| e.to_string())?;
  let hash: String = Sha256::digest(format!("{manifest}\0{SKILL_MD}")).iter().take(8).map(|b| format!("{b:02x}")).collect();
  let dir = cache.join(PLUGIN_DIR).join(&hash);
  let skill = dir.join("skills").join(COMMAND).join("SKILL.md");
  if skill.is_file() {
    return Ok(dir);
  }
  let write = |path: &Path, text: &str| -> Result<(), String> {
    std::fs::create_dir_all(path.parent().unwrap_or(&dir)).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
  };
  write(&dir.join(".claude-plugin").join("plugin.json"), &manifest)?;
  write(&skill, SKILL_MD)?;
  Ok(dir)
}

/// Whether the `kingu` command is set up (its skill is listed as inactive otherwise).
pub fn available() -> bool {
  BIN_DIR.get().is_some()
}

/// The `kingu` skill's plugin folder for agent runs; none when the command is not available or
/// the skill is turned off in the Skills view.
#[tauri::command]
pub fn cli_skill_plugin(app: AppHandle) -> Result<Option<String>, String> {
  if BIN_DIR.get().is_none() || crate::skill_hub::builtin_disabled(&app) {
    return Ok(None);
  }
  let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
  write_skill_plugin(&cache).map(|d| Some(d.display().to_string()))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn checks_task_create_params() {
    let ok = check_create(&json!({ "title": "  Fix login ", "prompt": "p", "base": "main", "mode": "timeline", "open": false })).unwrap();
    assert_eq!(ok, json!({ "title": "Fix login", "prompt": "p", "base": "main", "mode": "timeline", "open": false }));
    let defaults = check_create(&json!({ "title": "x", "base": " ", "mode": null })).unwrap();
    assert_eq!((defaults["base"].clone(), defaults["mode"].clone(), defaults["open"].clone()), (Value::Null, Value::Null, json!(true)));
    assert_eq!(check_create(&json!({ "title": " " })).unwrap_err().code, ERR_BAD_REQUEST);
    assert!(check_create(&json!({ "title": "ก".repeat(MAX_TITLE + 1) })).is_err());
    assert!(check_create(&json!({ "title": "x", "prompt": "a".repeat(MAX_PROMPT + 1) })).is_err());
    assert!(check_create(&json!({ "title": "x", "mode": "cloud" })).is_err());
    assert!(check_create(&json!({ "title": "x", "base": "--upload-pack=evil" })).is_err());
  }

  #[test]
  fn checks_open_and_notify_params() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("a.ts");
    std::fs::write(&file, "x").unwrap();
    let got = check_open(&json!({ "path": file.display().to_string(), "line": 3, "column": 0 })).unwrap();
    assert_eq!((got["kind"].as_str(), got["line"].as_u64(), got["column"].as_u64()), (Some("file"), Some(3), None));
    assert_eq!(got["path"].as_str().unwrap(), std::fs::canonicalize(&file).unwrap().display().to_string());
    assert_eq!(check_open(&json!({ "path": tmp.path().display().to_string() })).unwrap()["kind"], "folder");
    assert!(check_open(&json!({ "path": "relative/a.ts" })).is_err());
    assert!(check_open(&json!({ "path": tmp.path().join("missing").display().to_string() })).is_err());
    assert_eq!(check_notify(&json!({ "message": " done " })).unwrap(), ("Kingu".into(), "done".into()));
    assert_eq!(check_notify(&json!({ "message": "m", "title": "CI" })).unwrap().0, "CI");
    assert!(check_notify(&json!({ "message": "" })).is_err());
    assert!(check_notify(&json!({ "message": "a".repeat(MAX_MESSAGE + 1) })).is_err());
  }

  #[test]
  fn puts_the_command_first_on_path() {
    let p = prepend_path(Path::new("/k/bin"), Some(std::ffi::OsStr::new("/usr/bin:/k/bin:/bin"))).unwrap();
    assert_eq!(p, "/k/bin:/usr/bin:/bin");
    assert_eq!(prepend_path(Path::new("/k/bin"), None).unwrap(), "/k/bin");
  }

  #[test]
  fn finds_the_bundled_command() {
    let tmp = tempfile::tempdir().unwrap();
    assert_eq!(find_bundled(None, Some(tmp.path())), None);
    std::fs::write(tmp.path().join(BUNDLED), "").unwrap();
    assert_eq!(find_bundled(None, Some(tmp.path())), Some(tmp.path().join(BUNDLED)));
    assert_eq!(find_bundled(Some(tmp.path().join("nope").into()), Some(tmp.path())), None);
  }

  #[cfg(unix)]
  #[test]
  fn links_and_unlinks_only_its_own_command() {
    let tmp = tempfile::tempdir().unwrap();
    let (bin, app) = (tmp.path().join("bin"), tmp.path().join("app"));
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&app).unwrap();
    let exe = app.join("kingu-cli");
    std::fs::write(&exe, "").unwrap();
    let link = link_into(&bin, &exe).unwrap();
    assert_eq!(std::fs::read_link(&link).unwrap(), exe);
    // Again: unchanged. A link to another Kingu build is replaced.
    link_into(&bin, &exe).unwrap();
    let other = tmp.path().join("old/kingu-cli");
    std::fs::remove_file(&link).unwrap();
    symlink(&other, &link).unwrap();
    link_into(&bin, &exe).unwrap();
    assert_eq!(std::fs::read_link(&link).unwrap(), exe);
    assert!(unlink_from(&bin).unwrap());
    assert!(!link.exists() && !unlink_from(&bin).unwrap());
    // Someone else's `kingu` is never replaced or removed.
    std::fs::write(&link, "#!/bin/sh").unwrap();
    assert!(link_into(&bin, &exe).unwrap_err().contains(&link.display().to_string()));
    assert!(!unlink_from(&bin).unwrap() && link.is_file());
    std::fs::remove_file(&link).unwrap();
    symlink(Path::new("/usr/bin/true"), &link).unwrap();
    assert!(link_into(&bin, &exe).is_err() && !unlink_from(&bin).unwrap());
  }

  #[cfg(unix)]
  #[test]
  fn serves_owner_only_and_refuses_wrong_tokens() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixStream;
    let tmp = tempfile::tempdir().unwrap();
    let path = socket::socket_path(tmp.path(), tmp.path(), 1);
    let listener = socket::bind_private(&path).unwrap();
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    let token = protocol::new_token().unwrap();
    let t = token.clone();
    let server = std::thread::spawn(move || {
      let (stream, _) = listener.accept().unwrap();
      socket::serve(stream, |line| protocol::handle_line(line, &t, |req| Ok(json!(req.method))));
    });
    let mut c = UnixStream::connect(&path).unwrap();
    let mut reader = BufReader::new(c.try_clone().unwrap());
    let mut ask = |tok: &str| {
      let req = protocol::Request { id: 5, auth_token: tok.into(), method: "status".into(), params: Value::Null };
      c.write_all(protocol::encode(&req).as_bytes()).unwrap();
      let mut line = String::new();
      reader.read_line(&mut line).unwrap();
      protocol::decode_response(&line).unwrap()
    };
    assert_eq!(ask("bad").error.unwrap().code, protocol::ERR_UNAUTHORIZED);
    assert_eq!(ask(&token).result, Some(json!("status")));
    drop((c, reader));
    server.join().unwrap();
    // A path too long for a socket moves to a private temp folder.
    let long = tmp.path().join("x".repeat(120));
    assert_eq!(socket::socket_path(&long, Path::new("/tmp"), 501), Path::new("/tmp/kingu-cli-501/kingu.sock"));
  }

  #[test]
  fn writes_the_skill_plugin_once() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = write_skill_plugin(tmp.path()).unwrap();
    assert!(std::fs::read_to_string(dir.join("skills/kingu/SKILL.md")).unwrap().starts_with("---\nname: kingu"));
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(".claude-plugin/plugin.json")).unwrap()).unwrap();
    assert_eq!(manifest["name"], "kingu");
    assert_eq!(write_skill_plugin(tmp.path()).unwrap(), dir);
  }
}
