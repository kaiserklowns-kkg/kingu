//! PTY sessions for the integrated terminal, keyed by a name the webview picks (`panel:<root>:3`,
//! `cli:<root>:<slug>:…`), streamed to the webview over a Tauri channel.
//!
//! Backends (`kingu_ptyd`): on macOS and Linux the sessions live in `kingu-ptyd`, a per-user
//! daemon the app starts and talks to over a Unix socket, so terminals and agent CLIs keep
//! running after Kingu quits and the next launch re-attaches to them. On Windows, or when the
//! daemon cannot start, they live in this process (they then end with the app).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
#[cfg(unix)]
use std::sync::{Arc, Mutex};

use kingu_ptyd::{Attached, Host, SessionInfo, ShellSpec, Sink};
use tauri::State;
use crate::i18n::msg::CoreMsg;
use crate::tr;
use tauri::ipc::Channel;

pub use kingu_ptyd::validate_key;

/// One live terminal for the status bar's Resource Manager.
#[derive(serde::Serialize, Clone, Debug)]
pub struct PtyInfo {
  /// The session key.
  pub id: String,
  pub pid: Option<u32>,
  pub cwd: String,
}

#[cfg(unix)]
const DAEMON_NAME: &str = "kingu-ptyd";

/// What the webview hears as `pty-daemon` after the app's daemon connection came back: the
/// generation it is connected to now and the one before. `restarted` (a different daemon: the
/// earlier sessions are gone) makes terminals that showed the old generation start over;
/// otherwise they re-attach (their output stopped when the connection dropped).
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonEvent {
  pub epoch: u64,
  pub previous: Option<u64>,
  pub restarted: bool,
}

pub const DAEMON_EVENT: &str = "pty-daemon";

/// `kingu terminal-daemon status` and the UI's Terminal Daemon Status (Orca's
/// `terminalDaemon.severedStatus`, reduced to what Kingu's daemon has).
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatusReport {
  /// `"daemon"` (sessions outlive the app) or `"local"` (in-process: nothing to restart).
  pub backend: &'static str,
  pub connected: bool,
  pub daemon: Option<kingu_ptyd::protocol::DaemonStatus>,
  /// Live agent CLI terminals (`cli:` keys): a restart ends them, those that support resume can
  /// be resumed from their task afterwards.
  pub agents: usize,
  /// Every live terminal, agents included.
  pub terminals: usize,
}

/// What `restart` did.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RestartReport {
  /// Sessions that ended with the old daemon.
  pub ended: usize,
  pub epoch: u64,
  pub pid: u32,
}

#[cfg(unix)]
struct Daemon {
  launch: kingu_ptyd::client::Launch,
  /// The current connection; only ever locked briefly.
  client: Mutex<Option<Arc<kingu_ptyd::client::Client>>>,
  /// Held while (re)connecting, which can take seconds when the daemon has to start.
  connecting: Mutex<()>,
  /// The generation of the last connection (to tell a reconnect from a restarted daemon).
  epoch: Mutex<Option<u64>>,
}

#[cfg(unix)]
impl Daemon {
  fn new(launch: kingu_ptyd::client::Launch) -> Self {
    Self { launch, client: Mutex::new(None), connecting: Mutex::new(()), epoch: Mutex::new(None) }
  }

  /// The connection, made again (starting the daemon if it has exited) when it dropped. A
  /// reconnect is announced through `notify` (not the first connection).
  fn client_with(&self, notify: &dyn Fn(DaemonEvent)) -> Result<Arc<kingu_ptyd::client::Client>, String> {
    let _one = self.connecting.lock().unwrap();
    if let Some(c) = self.client.lock().unwrap().as_ref().filter(|c| c.is_connected()) {
      return Ok(c.clone());
    }
    let c = Arc::new(kingu_ptyd::client::connect_or_start(&self.launch)?);
    log::info!("terminal daemon: connected (pid {}, version {}, generation {})", c.daemon().pid, c.daemon().app_version, c.daemon().epoch);
    self.adopt(c.clone(), notify);
    Ok(c)
  }

  fn adopt(&self, c: Arc<kingu_ptyd::client::Client>, notify: &dyn Fn(DaemonEvent)) {
    let epoch = c.daemon().epoch;
    let previous = self.epoch.lock().unwrap().replace(epoch);
    *self.client.lock().unwrap() = Some(c);
    if let Some(prev) = previous {
      let restarted = prev != epoch || epoch == 0;
      if restarted {
        log::warn!("terminal daemon: now generation {epoch} (was {prev}); sessions of the old one are gone");
      }
      notify(DaemonEvent { epoch, previous: Some(prev), restarted });
    }
  }

  fn client(&self) -> Result<Arc<kingu_ptyd::client::Client>, String> {
    self.client_with(&|_| {})
  }

  /// Whether the connection dropped since it was made.
  fn dropped(&self) -> bool {
    self.client.lock().unwrap().as_ref().is_some_and(|c| !c.is_connected())
  }

  fn restart(&self, epoch: u64, notify: &dyn Fn(DaemonEvent)) -> Result<RestartReport, String> {
    let current = self.client()?;
    let _one = self.connecting.lock().unwrap();
    let (ended, fresh) = kingu_ptyd::client::restart(&current, &self.launch, epoch).map_err(|e| {
      if kingu_ptyd::client::is_stale(&e) { tr!(CoreMsg::DaemonRestartStale) } else { e }
    })?;
    let fresh = Arc::new(fresh);
    log::warn!("terminal daemon: restarted on request; {ended} sessions ended (generation {epoch} -> {})", fresh.daemon().epoch);
    let report = RestartReport { ended, epoch: fresh.daemon().epoch, pid: fresh.daemon().pid };
    self.adopt(fresh, notify);
    Ok(report)
  }

  /// The connection as it is, without reconnecting: keystrokes and resizes run on the main
  /// thread (in order) and must never wait for a daemon to start.
  fn connected(&self) -> Result<Arc<kingu_ptyd::client::Client>, String> {
    self.client.lock().unwrap().clone().ok_or_else(|| tr!(CoreMsg::DaemonDisconnected))
  }
}

enum Backend {
  Local(Host),
  #[cfg(unix)]
  Daemon(Daemon),
}

#[derive(Default)]
pub struct Ptys {
  /// Private per-user directory for the daemon's socket, lock and log (set at startup).
  dir: OnceLock<PathBuf>,
  /// Emits [`DAEMON_EVENT`] (set at startup).
  app: OnceLock<tauri::AppHandle>,
  backend: OnceLock<Backend>,
  /// The window showing each session (the last one to start or attach to it), so one window's
  /// "Kill All Background Sessions" and orphan cleanup leave another window's terminals alone.
  owners: std::sync::Mutex<BTreeMap<String, String>>,
}

impl Ptys {
  /// Records that window `window` shows session `key`.
  pub fn own(&self, key: &str, window: &str) {
    self.owners.lock().unwrap_or_else(|e| e.into_inner()).insert(key.into(), window.into());
  }

  /// The window showing `key`, if it still is.
  pub fn owner(&self, key: &str) -> Option<String> {
    self.owners.lock().unwrap_or_else(|e| e.into_inner()).get(key).cloned()
  }

  /// A window closed: its sessions keep running (the daemon re-attaches them later) but nobody shows them.
  pub fn forget_window(&self, window: &str) {
    self.owners.lock().unwrap_or_else(|e| e.into_inner()).retain(|_, w| w != window);
  }
}

/// A live session as `pty_list` reports it to a window.
#[derive(serde::Serialize)]
pub struct ListedSession {
  #[serde(flatten)]
  pub info: SessionInfo,
  /// Another open window shows it: not this window's to kill or adopt.
  pub elsewhere: bool,
}

/// Where the daemon's socket lives: `$XDG_RUNTIME_DIR/kingu` on Linux, else `<app data>/ptyd`,
/// unless that path is too long for a Unix socket (macOS allows 104 bytes).
pub fn daemon_dir(app_data: &Path, runtime_dir: Option<PathBuf>, temp: &Path, uid: u32) -> PathBuf {
  let preferred = runtime_dir.filter(|d| d.is_absolute()).map(|d| d.join("kingu")).unwrap_or_else(|| app_data.join("ptyd"));
  // Room for the longer fallback name (`kingu-ptyd-1-v<version>.sock`).
  let socket_len = preferred.join(kingu_ptyd::protocol::socket_name()).as_os_str().len() + 12;
  if socket_len < 104 { preferred } else { temp.join(format!("kingu-ptyd-{uid}")) }
}

/// The daemon executable: `KINGU_PTYD`, else `kingu-ptyd` next to the app executable (release:
/// Tauri's `externalBin` puts it in `Contents/MacOS`; dev: `cargo build` puts it in `target/debug`).
pub fn find_daemon(override_var: Option<std::ffi::OsString>, exe_dir: Option<&Path>) -> Result<PathBuf, String> {
  if let Some(p) = override_var.filter(|o| !o.is_empty()).map(PathBuf::from) {
    return if p.is_file() { Ok(p) } else { Err(tr!(CoreMsg::PtydOverrideMissing, path = p.display())) };
  }
  let name = if cfg!(windows) { "kingu-ptyd.exe" } else { "kingu-ptyd" };
  exe_dir.map(|d| d.join(name)).filter(|p| p.is_file()).ok_or_else(|| tr!(CoreMsg::PtydMissing, name))
}

impl Ptys {
  /// Records the daemon directory and connects in the background, so the first terminal rarely waits.
  pub fn init(app: &tauri::AppHandle, dir: PathBuf) {
    use tauri::Manager;
    let ptys = app.state::<Ptys>();
    let _ = ptys.dir.set(dir);
    let _ = ptys.app.set(app.clone());
    let handle = app.clone();
    std::thread::spawn(move || {
      let ptys = handle.state::<Ptys>();
      let _ = ptys.backend();
      // A dropped daemon connection (the daemon crashed or was killed) is made again here, not
      // only on the next terminal call, so terminals re-attach (or learn their session ended)
      // while nobody types. **Estimated** interval.
      #[cfg(unix)]
      if let Backend::Daemon(d) = ptys.backend() {
        loop {
          std::thread::sleep(std::time::Duration::from_secs(2));
          if d.dropped()
            && let Err(e) = d.client_with(&|e| ptys.emit(e))
          {
            log::warn!("terminal daemon: reconnect failed: {e}");
          }
        }
      }
    });
  }

  fn emit(&self, event: DaemonEvent) {
    use tauri::Emitter;
    if event.restarted {
      // The sessions those windows showed are gone.
      self.owners.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
    if let Some(app) = self.app.get() {
      let _ = app.emit(DAEMON_EVENT, event);
    }
  }

  fn backend(&self) -> &Backend {
    self.backend.get_or_init(|| self.choose())
  }

  fn choose(&self) -> Backend {
    #[cfg(unix)]
    {
      if std::env::var("KINGU_PTY_BACKEND").is_ok_and(|v| v == "local") {
        log::info!("terminals: in-process (KINGU_PTY_BACKEND=local)");
        return Backend::Local(Host::default());
      }
      let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf));
      let launch = find_daemon(std::env::var_os("KINGU_PTYD"), exe_dir.as_deref()).and_then(|bin| {
        let dir = self.dir.get().cloned().ok_or_else(|| tr!(CoreMsg::DaemonDirUnknown))?;
        Ok(kingu_ptyd::client::Launch { bin, dir, app_version: env!("CARGO_PKG_VERSION").into(), args: Vec::new(), env: Vec::new() })
      });
      let connected = launch.and_then(|launch| {
        let daemon = Daemon::new(launch);
        daemon.client().map(|_| daemon)
      });
      match connected {
        Ok(daemon) => return Backend::Daemon(daemon),
        Err(e) => log::warn!("terminals: {DAEMON_NAME} unavailable ({e}); running in-process, they end when Kingu quits"),
      }
    }
    Backend::Local(Host::default())
  }

  /// Attaches to `key`, else starts `shell` (default: a login `$SHELL`) for it in `cwd` with `env` (typing `run` once).
  /// `unset` and `clean_env`: `terminal.integrated.env.*` nulls and `inheritEnv: false` (ShellSpec).
  #[allow(clippy::too_many_arguments)]
  pub fn open(&self, key: &str, cwd: &Path, cols: u16, rows: u16, run: Option<&[String]>, env: &BTreeMap<String, String>, shell: Option<&str>, args: Option<&[String]>, unset: &[String], clean_env: bool, sink: Sink) -> Result<Attached, String> {
    let spec = ShellSpec { cwd, cols, rows, run, env, shell, args, unset, clean_env };
    match self.backend() {
      Backend::Local(host) => host.open(key, &spec, sink),
      #[cfg(unix)]
      Backend::Daemon(d) => d.client()?.spawn(key, &spec, sink),
    }
  }

  /// `epoch`: the daemon generation the caller last showed `key` in; a different daemon refuses
  /// with an error starting with `kingu_ptyd::protocol::STALE_ATTACH`.
  pub fn attach(&self, key: &str, size: Option<(u16, u16)>, sink: Sink, epoch: Option<u64>) -> Result<Option<Attached>, String> {
    match self.backend() {
      Backend::Local(host) => Ok(host.attach(key, size, sink)),
      #[cfg(unix)]
      Backend::Daemon(d) => d.client_with(&|e| self.emit(e))?.attach_in(key, size, sink, epoch),
    }
  }

  /// The daemon's status (Orca's `terminal-daemon status`).
  pub fn daemon_status(&self) -> DaemonStatusReport {
    let live: Vec<SessionInfo> = self.list().unwrap_or_default().into_iter().filter(|s| s.alive).collect();
    let agents = live.iter().filter(|s| s.key.starts_with("cli:")).count();
    let (connected, daemon) = match self.backend() {
      Backend::Local(_) => (false, None),
      #[cfg(unix)]
      Backend::Daemon(d) => match d.client_with(&|e| self.emit(e)).and_then(|c| c.status()) {
        Ok(st) => (true, Some(st)),
        Err(e) => {
          log::warn!("terminal daemon status: {e}");
          (false, None)
        }
      },
    };
    DaemonStatusReport { backend: self.kind(), connected, daemon, agents, terminals: live.len() }
  }

  /// Stops the daemon (ending every terminal in it) and starts a new one, if it is still
  /// generation `epoch` (the one the user saw in the status they confirmed).
  pub fn restart_daemon(&self, epoch: u64) -> Result<RestartReport, String> {
    match self.backend() {
      Backend::Local(_) => {
        let _ = epoch;
        Err(tr!(CoreMsg::DaemonRestartLocal))
      }
      #[cfg(unix)]
      Backend::Daemon(d) => d.restart(epoch, &|e| self.emit(e)),
    }
  }

  pub fn write(&self, key: &str, data: &str) -> Result<(), String> {
    match self.backend() {
      Backend::Local(host) => host.write(key, data.as_bytes()),
      #[cfg(unix)]
      Backend::Daemon(d) => d.connected()?.write(key, data),
    }
  }

  pub fn resize(&self, key: &str, cols: u16, rows: u16) -> Result<(), String> {
    match self.backend() {
      Backend::Local(host) => host.resize(key, cols, rows),
      #[cfg(unix)]
      Backend::Daemon(d) => d.connected()?.resize(key, cols, rows),
    }
  }

  pub fn kill(&self, key: &str) -> Result<bool, String> {
    match self.backend() {
      Backend::Local(host) => Ok(host.kill(key)),
      #[cfg(unix)]
      Backend::Daemon(d) => d.client()?.kill(key),
    }
  }

  pub fn list(&self) -> Result<Vec<SessionInfo>, String> {
    match self.backend() {
      Backend::Local(host) => Ok(host.list()),
      #[cfg(unix)]
      Backend::Daemon(d) => d.client()?.list(),
    }
  }

  /// The directory `key`'s shell started in (VS Code's splitCwd `initial`).
  pub fn initial_cwd(&self, key: &str) -> Option<PathBuf> {
    self.list().ok()?.into_iter().find(|s| s.key == key).map(|s| PathBuf::from(s.cwd)).filter(|d| d.is_dir())
  }

  /// The current directory of `key`'s shell (after its `cd`s), when it can be read.
  pub fn live_cwd(&self, key: &str) -> Option<PathBuf> {
    let pid = self.list().ok()?.into_iter().find(|s| s.key == key && s.alive)?.pid?;
    kingu_ptyd::procinfo::process_cwd(pid).filter(|d| d.is_dir())
  }

  /// The job in front of `key`'s shell (`pty_job_info`); `None` at the prompt or when unknown.
  pub fn job_info(&self, key: &str) -> Option<JobInfo> {
    let session = self.list().ok()?.into_iter().find(|s| s.key == key && s.alive)?;
    let job = session.foreground?;
    let cwd = kingu_ptyd::procinfo::process_cwd(job.pid).filter(|d| d.is_dir());
    let shell = session.pid.and_then(kingu_ptyd::procinfo::process_cwd);
    Some(JobInfo {
      pid: job.pid,
      here: same_dir(cwd.clone(), shell),
      cwd: cwd.map(|d| d.to_string_lossy().into_owned()),
      args: kingu_ptyd::procinfo::process_args(job.pid),
    })
  }

  /// The pid of the job in front of `key`'s shell, if any.
  fn job_pid(&self, key: &str) -> Option<u32> {
    self.list().ok()?.into_iter().find(|s| s.key == key && s.alive)?.foreground.map(|f| f.pid)
  }

  /// Live terminals for the status bar's Resource Manager (its shells run under the daemon when
  /// there is one, so their pids are not Kingu's children).
  pub fn terminals(&self) -> Vec<PtyInfo> {
    self.list().unwrap_or_default().into_iter().filter(|s| s.alive).map(|s| PtyInfo { id: s.key, pid: s.pid, cwd: s.cwd }).collect()
  }

  /// The daemon's pid while connected: its process tree counts as Kingu's.
  pub fn daemon_pid(&self) -> Option<u32> {
    match self.backend() {
      Backend::Local(_) => None,
      #[cfg(unix)]
      Backend::Daemon(d) => d.client.lock().unwrap().as_ref().filter(|c| c.is_connected()).map(|c| c.daemon().pid),
    }
  }

  /// `"daemon"` when sessions outlive the app, else `"local"`.
  pub fn kind(&self) -> &'static str {
    match self.backend() {
      Backend::Local(_) => "local",
      #[cfg(unix)]
      Backend::Daemon(_) => "daemon",
    }
  }
}

/// A webview channel as a session viewer; a reloaded page leaves a dead channel, which ends it.
pub fn channel_sink(on_data: Channel<String>) -> Sink {
  Box::new(move |text| on_data.send(text).is_ok())
}

/// Re-attaches to a live session without starting one (a terminal mounted hidden after a reload
/// or restart, so an agent CLI's output keeps reaching the page). Null when `key` has no live shell.
#[tauri::command(async)]
/// `epoch`: the daemon generation this page last showed `key` in (after a `pty-daemon` event); an
/// error starting with `stale-attach:` means that session ended with its daemon.
pub fn pty_attach(window: tauri::WebviewWindow, ptys: State<'_, Ptys>, key: String, cols: Option<u16>, rows: Option<u16>, on_data: Channel<String>, epoch: Option<u64>) -> Result<Option<Attached>, String> {
  validate_key(&key)?;
  let attached = ptys.attach(&key, cols.zip(rows), channel_sink(on_data), epoch)?;
  if attached.is_some() {
    ptys.own(&key, window.label());
  }
  Ok(attached)
}

/// Sync, so keystrokes reach the shell in the order they were typed (async commands run concurrently).
#[tauri::command]
pub fn pty_write(ptys: State<'_, Ptys>, key: String, data: String) -> Result<(), String> {
  ptys.write(&key, &data)
}

#[tauri::command]
pub fn pty_resize(ptys: State<'_, Ptys>, key: String, cols: u16, rows: u16) -> Result<(), String> {
  ptys.resize(&key, cols, rows)
}

#[tauri::command(async)]
pub fn pty_kill(ptys: State<'_, Ptys>, key: String) -> Result<(), String> {
  if ptys.kill(&key)? {
    log::info!("terminal {key} killed");
  }
  Ok(())
}

/// Live sessions (key, cwd, alive), so the page can re-attach after a restart and kill the ones it
/// no longer shows.
#[tauri::command(async)]
pub fn pty_list(window: tauri::WebviewWindow, ptys: State<'_, Ptys>) -> Result<Vec<ListedSession>, String> {
  use tauri::Manager;
  let open = window.app_handle().state::<crate::workspace::Workspaces>().labels();
  Ok(
    ptys
      .list()?
      .into_iter()
      .map(|info| {
        let elsewhere = ptys.owner(&info.key).is_some_and(|w| w != window.label() && open.contains(&w));
        ListedSession { info, elsewhere }
      })
      .collect(),
  )
}

/// The jobs running in front of the shells of `keys` (a close asks first while one runs), by key;
/// a terminal at its prompt, or one that is gone, is left out.
#[tauri::command(async)]
pub fn pty_foreground(ptys: State<'_, Ptys>, keys: Vec<String>) -> Result<BTreeMap<String, kingu_ptyd::Foreground>, String> {
  let wanted: std::collections::BTreeSet<String> = keys.into_iter().collect();
  Ok(ptys.list()?.into_iter().filter(|s| s.alive && wanted.contains(&s.key)).filter_map(|s| s.foreground.map(|f| (s.key, f))).collect())
}

/// The job in front of a terminal's shell (an agent CLI pane hibernation may close).
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct JobInfo {
  /// Its process group (the job's leader).
  pub pid: u32,
  /// The folder it runs in; `None` when it cannot be read.
  pub cwd: Option<String>,
  /// Whether that folder is the shell's own (`None` when either is unknown).
  pub here: Option<bool>,
  /// Its command line (first arguments; procinfo bounds them), empty when it cannot be read.
  pub args: Vec<String>,
}

/// Pane hibernation: ends the job `pid` in front of `key`'s shell and leaves the shell, its screen
/// and its scrollback (Orca kills the pane's PTY and keeps its history; here the session itself
/// keeps it, also across a restart of Kingu while the daemon runs). The job's group gets SIGHUP,
/// as a closed terminal would send, then SIGKILL if it is still in front after a few seconds.
/// False when `pid` is no longer in front (nothing is signalled); an error where the platform has
/// no job control (Windows).
#[tauri::command(async)]
pub fn pty_stop_job(ptys: State<'_, Ptys>, key: String, pid: u32) -> Result<bool, String> {
  validate_key(&key)?;
  stop_job(&ptys, &key, pid)
}

#[cfg(unix)]
fn stop_job(ptys: &Ptys, key: &str, pid: u32) -> Result<bool, String> {
  use std::time::{Duration, Instant};
  let group = libc::pid_t::try_from(pid).map_err(|e| e.to_string())?;
  if group <= 1 || ptys.job_pid(key) != Some(pid) {
    return Ok(false);
  }
  let gone = |within: Duration| {
    let until = Instant::now() + within;
    while Instant::now() < until {
      if ptys.job_pid(key) != Some(pid) {
        return true;
      }
      std::thread::sleep(Duration::from_millis(50));
    }
    false
  };
  for (signal, wait) in [(libc::SIGHUP, Duration::from_secs(3)), (libc::SIGKILL, Duration::from_secs(2))] {
    // SAFETY: killpg only sends a signal to the process group the terminal reported in front.
    if unsafe { libc::killpg(group, signal) } != 0 {
      let e = std::io::Error::last_os_error();
      if e.raw_os_error() == Some(libc::ESRCH) {
        return Ok(true);
      }
      return Err(e.to_string());
    }
    if gone(wait) {
      log::info!("terminal {key}: job {pid} ended for hibernation");
      return Ok(true);
    }
  }
  Err(format!("terminal {key}: job {pid} is still running"))
}

#[cfg(not(unix))]
fn stop_job(_ptys: &Ptys, _key: &str, _pid: u32) -> Result<bool, String> {
  Err("agent hibernation of terminal panes needs job control (macOS, Linux)".into())
}

/// Whether two directories name the same folder (symlinks resolved); `None` when either is unknown.
pub fn same_dir(a: Option<PathBuf>, b: Option<PathBuf>) -> Option<bool> {
  let (a, b) = (a?, b?);
  let real = |d: &Path| std::fs::canonicalize(d).unwrap_or_else(|_| d.to_path_buf());
  Some(real(&a) == real(&b))
}

/// Terminal: Show Terminal Daemon Status / Restart Terminal Daemon (the UI asks first).
#[tauri::command(async)]
pub fn pty_daemon_status(ptys: State<'_, Ptys>) -> DaemonStatusReport {
  ptys.daemon_status()
}

#[tauri::command(async)]
pub fn pty_daemon_restart(ptys: State<'_, Ptys>, epoch: u64) -> Result<RestartReport, String> {
  ptys.restart_daemon(epoch)
}

/// Where sessions live: `"daemon"` (they survive quitting Kingu) or `"local"`.
#[tauri::command(async)]
pub fn pty_backend(ptys: State<'_, Ptys>) -> Result<&'static str, String> {
  Ok(ptys.kind())
}

/// `terminal.integrated.cwd` for a panel terminal: absolute, or relative to the open folder. A
/// folder that does not exist falls back to the default (the open folder, else home).
pub fn terminal_cwd(setting: Option<&str>, folder: Option<&Path>, fallback: PathBuf) -> PathBuf {
  let Some(raw) = setting.map(str::trim).filter(|s| !s.is_empty()) else { return fallback };
  let path = Path::new(raw);
  let dir = if path.is_absolute() { path.to_path_buf() } else if let Some(f) = folder { f.join(path) } else { return fallback };
  if dir.is_dir() {
    dir
  } else {
    log::warn!("terminal.integrated.cwd {}: not a folder, using {}", dir.display(), fallback.display());
    fallback
  }
}

/// The root folder a panel terminal starts in: `requested` (a multi-root window's pick, or a split
/// keeping its source's folder) when it is a folder inside one of `roots`, else the first folder.
/// A requested folder that is gone falls back too; one outside every root is refused.
pub fn terminal_folder(roots: &[PathBuf], requested: Option<&str>) -> Result<Option<PathBuf>, String> {
  let Some(raw) = requested.map(str::trim).filter(|s| !s.is_empty()) else { return Ok(roots.first().cloned()) };
  let path = Path::new(raw);
  if !path.is_absolute() {
    return Err(tr!(crate::i18n::msg::FilesMsg::OutsideWorkspace, path = raw));
  }
  let Ok(dir) = path.canonicalize() else {
    log::warn!("terminal folder {raw}: gone, using the first folder");
    return Ok(roots.first().cloned());
  };
  if !dir.is_dir() || !roots.iter().any(|r| dir.starts_with(r)) {
    return Err(tr!(crate::i18n::msg::FilesMsg::OutsideWorkspace, path = raw));
  }
  Ok(Some(dir))
}

/// Orca's terminalScopeHistoryByWorktree: the env that gives a new shell its own history for the
/// worktree `scope` (a path): `HISTFILE` under `<history_root>/<hash>/` for bash and zsh, a
/// `fish_history` session name for fish. Other shells get nothing. The folder is created.
pub fn scoped_history_env(shell: &str, history_root: &Path, scope: &Path) -> Result<Vec<(String, String)>, String> {
  let name = Path::new(shell).file_name().and_then(|n| n.to_str()).unwrap_or("").trim_start_matches('-');
  let id = &crate::snap::sha256_hex(scope.to_string_lossy().as_bytes())[..16];
  let file = match name {
    "zsh" => "zsh_history",
    "bash" => "bash_history",
    // fish keeps every session in its own data dir; the name may only hold [A-Za-z0-9_].
    "fish" => return Ok(vec![("fish_history".into(), format!("kingu_{id}"))]),
    _ => return Ok(vec![]),
  };
  let dir = history_root.join(id);
  std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
  Ok(vec![("HISTFILE".into(), dir.join(file).display().to_string())])
}

/// `terminal.integrated.env.*` values: strings to set, and the `null`s, which remove a variable.
pub fn split_env(env: BTreeMap<String, Option<String>>) -> (BTreeMap<String, String>, Vec<String>) {
  let mut set = BTreeMap::new();
  let mut unset = Vec::new();
  for (k, v) in env {
    match v {
      Some(v) => {
        set.insert(k, v);
      }
      None => unset.push(k),
    }
  }
  (set, unset)
}

/// A terminal profile's `path` candidates (`terminal.integrated.profiles.*`; VS Code tries each in
/// turn): an absolute path is used as is, a bare name is looked up on `search_path` (the login-shell
/// PATH). `None` when none is an executable file.
pub fn resolve_shell(candidates: &[String], search_path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
  candidates.iter().map(|c| c.trim()).filter(|c| !c.is_empty()).find_map(|c| {
    let path = Path::new(c);
    if path.is_absolute() {
      return is_executable(path).then(|| path.to_path_buf());
    }
    if c.contains('/') {
      return None;
    }
    search_path.into_iter().flat_map(std::env::split_paths).map(|d| d.join(c)).find(|p| is_executable(p))
  })
}

fn is_executable(path: &Path) -> bool {
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
  }
  #[cfg(not(unix))]
  path.is_file()
}

/// `terminal.integrated.splitCwd`: where a split terminal starts — the workspace root, the
/// directory its source terminal started in, or the one that terminal is in now (the default).
pub fn split_cwd(mode: &str, live: impl FnOnce() -> Option<PathBuf>, initial: impl FnOnce() -> Option<PathBuf>, root: Option<PathBuf>) -> Option<PathBuf> {
  match mode {
    "workspaceRoot" => root,
    "initial" => initial().or_else(live),
    _ => live(),
  }
}

/// `terminal.integrated.detectLocale`: the `LANG` to give a new shell, if any. `auto` sets it only
/// when the shell's `LANG` is missing or not a UTF-8 (or EUC) locale; the value comes from the UI
/// locale (`th-TH` → `th_TH.UTF-8`, a bare language gets its main region), like VS Code.
pub fn lang_env(mode: &str, current: Option<&str>, locale: Option<&str>) -> Option<String> {
  let set = match mode {
    "on" => true,
    "auto" => current.is_none_or(|l| l.is_empty() || !(l.ends_with(".UTF-8") || l.ends_with(".utf8") || l.contains(".euc"))),
    _ => false,
  };
  if !set {
    return None;
  }
  let mut parts: Vec<String> = locale.filter(|l| !l.is_empty()).map(|l| l.split('-').map(str::to_string).collect()).unwrap_or_default();
  match parts.len() {
    0 => return Some("en_US.UTF-8".into()),
    1 => {
      const REGIONS: &[(&str, &str)] = &[
        ("af", "ZA"), ("am", "ET"), ("be", "BY"), ("bg", "BG"), ("ca", "ES"), ("cs", "CZ"), ("da", "DK"), ("de", "DE"), ("el", "GR"), ("en", "US"),
        ("es", "ES"), ("et", "EE"), ("eu", "ES"), ("fi", "FI"), ("fr", "FR"), ("he", "IL"), ("hr", "HR"), ("hu", "HU"), ("hy", "AM"), ("is", "IS"),
        ("it", "IT"), ("ja", "JP"), ("kk", "KZ"), ("ko", "KR"), ("lt", "LT"), ("nl", "NL"), ("no", "NO"), ("pl", "PL"), ("pt", "BR"), ("ro", "RO"),
        ("ru", "RU"), ("sk", "SK"), ("sl", "SI"), ("sr", "YU"), ("sv", "SE"), ("th", "TH"), ("tr", "TR"), ("uk", "UA"), ("zh", "CN"),
      ];
      if let Some((_, region)) = REGIONS.iter().find(|(l, _)| *l == parts[0]) {
        parts.push((*region).to_string());
      }
    }
    _ => parts[1] = parts[1].to_uppercase(),
  }
  Some(format!("{}.UTF-8", parts.join("_")))
}

/// The variable a typed command's script travels in ([`run_through_env`]).
pub const RUN_ENV: &str = "KINGU_TERMINAL_RUN";

/// A terminal's `run` whose words hold line breaks (an SSH project's agent: `sh -c` with its
/// reconnect loop, ssh options and hook settings, ssh_projects.rs `terminal_run`) would be typed
/// into the shell as a line per script line, each echoed as a continuation prompt (zsh's
/// `quote>`) before the command starts. Instead the script goes in the shell's environment
/// ([`RUN_ENV`]) and the typed line is a short `sh -c 'eval "$KINGU_TERMINAL_RUN"'`: the same
/// commands, exit code and `exit`s (eval runs them in that `sh`). Orca hands a startup command over
/// the same way, in `ORCA_POSIX_SHELL_STARTUP_COMMAND` (src/main/pty/shell-startup/
/// posix-shell-startup-command.ts), though its shell then runs it from a prompt hook; Kingu keeps
/// typing the short line so every shell runs it (kingu-ptyd session.rs `spawn_shell`).
/// Only a `sh -c <script>` (already run by `sh`, so `eval` there changes nothing): an agent CLI
/// typed with a multi-line prompt stays as it is, run by the user's own shell. `None`: typed as it is.
pub fn run_through_env(run: &[String]) -> Option<(Vec<String>, String)> {
  match run {
    [sh, c, script] if sh == "sh" && c == "-c" && (script.contains('\n') || script.contains('\r')) => Some((vec!["sh".into(), "-c".into(), format!("eval \"${RUN_ENV}\"")], script.clone())),
    _ => None,
  }
}

#[cfg(test)]
mod tests {
  use std::path::{Path, PathBuf};

  use super::{daemon_dir, find_daemon, lang_env, resolve_shell, same_dir, scoped_history_env, split_cwd, terminal_cwd, terminal_folder};

  #[cfg(unix)]
  #[test]
  fn resolves_profile_paths_absolute_or_on_path() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let sh = bin.join("myshell");
    std::fs::write(&sh, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&sh, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(bin.join("plain"), "x").unwrap();
    let path = std::env::join_paths([tmp.path().join("none"), bin.clone()]).unwrap();
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    assert_eq!(resolve_shell(&s(&["myshell"]), Some(&path)), Some(sh.clone()));
    assert_eq!(resolve_shell(&s(&["/nope/zsh", sh.to_str().unwrap()]), None), Some(sh.clone()));
    assert_eq!(resolve_shell(&s(&["missing", "myshell"]), Some(&path)), Some(sh));
    assert_eq!(resolve_shell(&s(&["plain"]), Some(&path)), None);
    assert_eq!(resolve_shell(&s(&["bin/myshell"]), Some(&path)), None);
    assert_eq!(resolve_shell(&[], Some(&path)), None);
  }

  #[test]
  fn scoped_history_is_per_worktree_and_per_shell() {
    let tmp = tempfile::tempdir().unwrap();
    let (a, b) = (Path::new("/repo/.kingu/worktrees/a"), Path::new("/repo/.kingu/worktrees/b"));
    let za = scoped_history_env("/bin/zsh", tmp.path(), a).unwrap();
    let zb = scoped_history_env("zsh", tmp.path(), b).unwrap();
    assert_eq!(za.len(), 1);
    assert_eq!(za[0].0, "HISTFILE");
    assert!(za[0].1.ends_with("zsh_history") && za[0].1.starts_with(&tmp.path().display().to_string()));
    assert_ne!(za, zb);
    assert!(Path::new(&za[0].1).parent().unwrap().is_dir());
    assert!(scoped_history_env("/usr/local/bin/bash", tmp.path(), a).unwrap()[0].1.ends_with("bash_history"));
    let fish = scoped_history_env("/opt/homebrew/bin/fish", tmp.path(), a).unwrap();
    assert_eq!(fish[0].0, "fish_history");
    assert!(fish[0].1.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    assert_eq!(scoped_history_env("nu", tmp.path(), a).unwrap(), vec![]);
  }

  /// Pane hibernation: the job in front is read (pid, folder, command line) and ended, the shell stays.
  #[cfg(any(target_os = "macos", target_os = "linux"))]
  #[test]
  fn stop_job_ends_the_job_and_keeps_the_shell() {
    use super::{Backend, Ptys, stop_job};
    use std::time::{Duration, Instant};
    let ptys = Ptys::default();
    assert!(ptys.backend.set(Backend::Local(kingu_ptyd::Host::default())).is_ok());
    let key = "ade:0a1b2c3d:hibernate-test:t1";
    let dir = tempfile::tempdir().unwrap();
    let run = vec!["sleep".to_string(), "47".to_string()];
    let env = std::collections::BTreeMap::new();
    let args = vec!["-i".to_string()];
    ptys.open(key, dir.path(), 80, 24, Some(&run), &env, Some("/bin/sh"), Some(&args), &[], false, Box::new(|_| true)).unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    let job = loop {
      if let Some(job) = ptys.job_info(key) {
        break job;
      }
      assert!(Instant::now() < until, "no job in front of the shell");
      std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(job.args, run);
    assert_eq!(job.here, Some(true));
    assert!(same_dir(job.cwd.as_ref().map(PathBuf::from), Some(dir.path().to_path_buf())).unwrap());
    // Another pid in front is never signalled.
    assert_eq!(stop_job(&ptys, key, job.pid + 100_000).unwrap(), false);
    assert!(stop_job(&ptys, key, job.pid).unwrap());
    assert_eq!(ptys.job_info(key), None);
    assert!(ptys.list().unwrap().iter().any(|s| s.key == key && s.alive), "the shell stays");
    assert_eq!(stop_job(&ptys, key, job.pid).unwrap(), false);
    ptys.kill(key).unwrap();
  }

  #[test]
  fn same_dir_needs_both_directories() {
    let dir = std::env::temp_dir();
    assert_eq!(same_dir(Some(dir.clone()), Some(dir.clone())), Some(true));
    assert_eq!(same_dir(Some(dir.clone()), Some(dir.join("kingu-no-such-dir"))), Some(false));
    assert_eq!(same_dir(None, Some(dir.clone())), None);
    assert_eq!(same_dir(Some(dir), None), None);
  }

  #[test]
  fn split_cwd_modes() {
    let (live, first, root) = (PathBuf::from("/a/now"), PathBuf::from("/a"), PathBuf::from("/root"));
    assert_eq!(split_cwd("inherited", || Some(live.clone()), || Some(first.clone()), Some(root.clone())), Some(live.clone()));
    assert_eq!(split_cwd("initial", || Some(live.clone()), || Some(first.clone()), Some(root.clone())), Some(first.clone()));
    assert_eq!(split_cwd("initial", || Some(live.clone()), || None, None), Some(live.clone()));
    assert_eq!(split_cwd("workspaceRoot", || Some(live.clone()), || Some(first.clone()), Some(root.clone())), Some(root));
    assert_eq!(split_cwd("workspaceRoot", || Some(live), || Some(first), None), None);
  }

  #[test]
  fn detect_locale_like_vscode() {
    assert_eq!(lang_env("auto", None, Some("en-US")).as_deref(), Some("en_US.UTF-8"));
    assert_eq!(lang_env("auto", Some("en_US.UTF-8"), Some("th-TH")), None);
    assert_eq!(lang_env("auto", Some("C"), Some("th")).as_deref(), Some("th_TH.UTF-8"));
    assert_eq!(lang_env("on", Some("en_US.UTF-8"), Some("de-ch")).as_deref(), Some("de_CH.UTF-8"));
    assert_eq!(lang_env("on", None, None).as_deref(), Some("en_US.UTF-8"));
    assert_eq!(lang_env("on", None, Some("xx")).as_deref(), Some("xx.UTF-8"));
    assert_eq!(lang_env("off", None, Some("en-US")), None);
  }

  #[test]
  fn terminal_cwd_resolves_against_the_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::create_dir(root.join("apps")).unwrap();
    let fallback = root.to_path_buf();
    assert_eq!(terminal_cwd(None, Some(root), fallback.clone()), fallback);
    assert_eq!(terminal_cwd(Some("  "), Some(root), fallback.clone()), fallback);
    assert_eq!(terminal_cwd(Some("apps"), Some(root), fallback.clone()), root.join("apps"));
    assert_eq!(terminal_cwd(Some(root.join("apps").to_str().unwrap()), None, fallback.clone()), root.join("apps"));
    assert_eq!(terminal_cwd(Some("missing"), Some(root), fallback.clone()), fallback);
    assert_eq!(terminal_cwd(Some("apps"), None, fallback.clone()), fallback);
  }

  #[test]
  fn terminal_folder_is_one_of_the_roots() {
    let (a, b, out) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (ra, rb) = (a.path().canonicalize().unwrap(), b.path().canonicalize().unwrap());
    std::fs::create_dir(rb.join("pkg")).unwrap();
    let roots = vec![ra.clone(), rb.clone()];
    assert_eq!(terminal_folder(&roots, None).unwrap(), Some(ra.clone()));
    assert_eq!(terminal_folder(&roots, Some(" ")).unwrap(), Some(ra.clone()));
    assert_eq!(terminal_folder(&roots, Some(rb.to_str().unwrap())).unwrap(), Some(rb.clone()));
    assert_eq!(terminal_folder(&roots, Some(rb.join("pkg").to_str().unwrap())).unwrap(), Some(rb.join("pkg")));
    // A folder gone from disk falls back to the first one; one outside the roots is refused.
    assert_eq!(terminal_folder(&roots, Some(rb.join("gone").to_str().unwrap())).unwrap(), Some(ra.clone()));
    assert!(terminal_folder(&roots, Some(out.path().to_str().unwrap())).is_err());
    assert!(terminal_folder(&roots, Some(rb.join("..").to_str().unwrap())).is_err());
    assert!(terminal_folder(&roots, Some("pkg")).is_err());
    assert_eq!(terminal_folder(&[], None).unwrap(), None);
    assert!(terminal_folder(&[], Some(rb.to_str().unwrap())).is_err());
  }

  #[test]
  fn daemon_dir_prefers_the_runtime_dir_and_stays_short() {
    let data = Path::new("/Users/u/Library/Application Support/ai.anthov.kingu.studio");
    assert_eq!(daemon_dir(data, None, Path::new("/tmp"), 501), data.join("ptyd"));
    assert_eq!(daemon_dir(data, Some("/run/user/501".into()), Path::new("/tmp"), 501), PathBuf::from("/run/user/501/kingu"));
    assert_eq!(daemon_dir(data, Some("relative".into()), Path::new("/tmp"), 501), data.join("ptyd"));
    let long = PathBuf::from(format!("/Users/{}/Library/Application Support/ai.anthov.kingu.studio", "x".repeat(60)));
    assert_eq!(daemon_dir(&long, None, Path::new("/tmp"), 501), PathBuf::from("/tmp/kingu-ptyd-501"));
  }

  #[test]
  fn finds_the_daemon_next_to_the_app_or_from_the_env() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(find_daemon(None, Some(tmp.path())).is_err());
    let bin = tmp.path().join(if cfg!(windows) { "kingu-ptyd.exe" } else { "kingu-ptyd" });
    std::fs::write(&bin, "").unwrap();
    assert_eq!(find_daemon(None, Some(tmp.path())).unwrap(), bin);
    assert_eq!(find_daemon(Some(bin.clone().into()), None).unwrap(), bin);
    assert!(find_daemon(Some(tmp.path().join("nope").into()), Some(tmp.path())).is_err());
  }

  /// A multi-line script is not typed: a short line runs it from the environment, with the same
  /// output and exit code as `sh -c <script>`.
  #[cfg(unix)]
  #[test]
  fn a_multi_line_run_goes_through_the_environment() {
    use super::{RUN_ENV, run_through_env};
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    assert_eq!(run_through_env(&s(&["claude", "--settings", "{\"a\":1}"])), None);
    assert_eq!(run_through_env(&s(&["sh", "-c", "exec ssh -t box 'sh -c x'"])), None);
    // An agent typed with a multi-line prompt is run by the user's shell as before.
    assert_eq!(run_through_env(&s(&["claude", "line one\nline two"])), None);
    let script = "n=0\nprintf '%s\\n' \"it's\"\nc=7\nwhile [ \"$n\" -lt 2 ]; do n=$((n + 1)); done\necho \"$n\"\nexit \"$c\"";
    let (argv, env) = run_through_env(&s(&["sh", "-c", script])).unwrap();
    assert_eq!(env, script);
    assert_eq!(argv, s(&["sh", "-c", "eval \"$KINGU_TERMINAL_RUN\""]));
    assert!(argv.iter().all(|w| !w.contains('\n')));
    let typed = kingu_ptyd::session::command_line(&argv).unwrap();
    assert!(typed.len() < 40, "{typed}");
    let run = |argv: &[String], env: Option<&str>| {
      let mut c = std::process::Command::new(&argv[0]);
      c.args(&argv[1..]);
      if let Some(v) = env {
        c.env(RUN_ENV, v);
      }
      c.output().unwrap()
    };
    let direct = run(&s(&["sh", "-c", script]), None);
    let via = run(&argv, Some(&env));
    assert_eq!(via.status.code(), Some(7));
    assert_eq!((via.status.code(), via.stdout.clone()), (direct.status.code(), direct.stdout));
    assert_eq!(String::from_utf8_lossy(&via.stdout), "it's\n2\n");
  }
}
