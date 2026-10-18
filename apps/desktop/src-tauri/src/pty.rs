//! PTY sessions for the integrated terminal, keyed by a name the webview picks (`panel:<root>:3`,
//! `cli:<root>:<slug>:…`), streamed to the webview over a Tauri channel.
//!
//! Backends (`kingu_ptyd`): on macOS and Linux the sessions live in `kingu-ptyd`, a per-user
//! daemon the app starts and talks to over a Unix socket, so terminals and agent CLIs keep
//! running after Kingu quits and the next launch re-attaches to them. On Windows, or when the
//! daemon cannot start, they live in this process (they then end with the app).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
#[cfg(unix)]
use std::sync::{Arc, Mutex};

use kingu_ptyd::{Attached, Host, SessionInfo, ShellSpec, Sink};
use tauri::State;
use tauri::ipc::Channel;

pub use kingu_ptyd::validate_key;

#[cfg(unix)]
const DAEMON_NAME: &str = "kingu-ptyd";

#[cfg(unix)]
struct Daemon {
  launch: kingu_ptyd::client::Launch,
  /// The current connection; only ever locked briefly.
  client: Mutex<Option<Arc<kingu_ptyd::client::Client>>>,
  /// Held while (re)connecting, which can take seconds when the daemon has to start.
  connecting: Mutex<()>,
}

#[cfg(unix)]
impl Daemon {
  fn new(launch: kingu_ptyd::client::Launch) -> Self {
    Self { launch, client: Mutex::new(None), connecting: Mutex::new(()) }
  }

  /// The connection, made again (starting the daemon if it has exited) when it dropped.
  fn client(&self) -> Result<Arc<kingu_ptyd::client::Client>, String> {
    let _one = self.connecting.lock().unwrap();
    if let Some(c) = self.client.lock().unwrap().as_ref().filter(|c| c.is_connected()) {
      return Ok(c.clone());
    }
    let c = Arc::new(kingu_ptyd::client::connect_or_start(&self.launch)?);
    log::info!("terminal daemon: connected (pid {}, version {})", c.daemon().pid, c.daemon().app_version);
    *self.client.lock().unwrap() = Some(c.clone());
    Ok(c)
  }

  /// The connection as it is, without reconnecting: keystrokes and resizes run on the main
  /// thread (in order) and must never wait for a daemon to start.
  fn connected(&self) -> Result<Arc<kingu_ptyd::client::Client>, String> {
    self.client.lock().unwrap().clone().ok_or_else(|| "terminal daemon หลุดการเชื่อมต่อ".to_string())
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
  backend: OnceLock<Backend>,
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
    return if p.is_file() { Ok(p) } else { Err(format!("KINGU_PTYD={}: ไม่พบไฟล์", p.display())) };
  }
  let name = if cfg!(windows) { "kingu-ptyd.exe" } else { "kingu-ptyd" };
  exe_dir.map(|d| d.join(name)).filter(|p| p.is_file()).ok_or_else(|| format!("ไม่พบ {name} ข้างตัวแอป (ตั้ง KINGU_PTYD หรือ cargo build -p kingu-ptyd)"))
}

impl Ptys {
  /// Records the daemon directory and connects in the background, so the first terminal rarely waits.
  pub fn init(app: &tauri::AppHandle, dir: PathBuf) {
    use tauri::Manager;
    let _ = app.state::<Ptys>().dir.set(dir);
    let handle = app.clone();
    std::thread::spawn(move || {
      let _ = handle.state::<Ptys>().backend();
    });
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
        let dir = self.dir.get().cloned().ok_or("ยังไม่รู้โฟลเดอร์ของ daemon")?;
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

  /// Attaches to `key`, else starts a login shell for it in `cwd` (typing `run` once).
  pub fn open(&self, key: &str, cwd: &Path, cols: u16, rows: u16, run: Option<&[String]>, sink: Sink) -> Result<Attached, String> {
    let spec = ShellSpec { cwd, cols, rows, run, env: &Default::default() };
    match self.backend() {
      Backend::Local(host) => host.open(key, &spec, sink),
      #[cfg(unix)]
      Backend::Daemon(d) => d.client()?.spawn(key, &spec, sink),
    }
  }

  pub fn attach(&self, key: &str, size: Option<(u16, u16)>, sink: Sink) -> Result<Option<Attached>, String> {
    match self.backend() {
      Backend::Local(host) => Ok(host.attach(key, size, sink)),
      #[cfg(unix)]
      Backend::Daemon(d) => d.client()?.attach(key, size, sink),
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
pub fn pty_attach(ptys: State<'_, Ptys>, key: String, cols: Option<u16>, rows: Option<u16>, on_data: Channel<String>) -> Result<Option<Attached>, String> {
  validate_key(&key)?;
  ptys.attach(&key, cols.zip(rows), channel_sink(on_data))
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
pub fn pty_list(ptys: State<'_, Ptys>) -> Result<Vec<SessionInfo>, String> {
  ptys.list()
}

/// Where sessions live: `"daemon"` (they survive quitting Kingu) or `"local"`.
#[tauri::command(async)]
pub fn pty_backend(ptys: State<'_, Ptys>) -> Result<&'static str, String> {
  Ok(ptys.kind())
}

#[cfg(test)]
mod tests {
  use std::path::{Path, PathBuf};

  use super::{daemon_dir, find_daemon};

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
}
