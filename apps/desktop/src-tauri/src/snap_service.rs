//! Snap services (`[[services]]`): long-running processes Kingu starts for an active snap (a
//! local server its MCP bridge and hooks talk to, say) and stops with the app, so a snap works
//! without the user keeping a terminal open. The webview resolves the command (settings expanded,
//! wrapped in `kingu-ptyd snap-exec` like tasks) and starts or stops services as snaps become
//! active; Rust accepts only services the snap declares while it is active, owns the processes,
//! writes their output to `<app cache>/snap-services/<snap>-<service>.log` and reports each exit
//! as a `snap-service` event. A `<snap>-<service>.pid` file next to the log lives as long as the
//! process, so one left behind by a Kingu that was killed (no exit hook ran) is stopped at the
//! next start (`stop_orphans`).
//!
//! Also here: `snap_find_programs`, the `[[requires]]` check (is the program a snap runs
//! installed), and the commands that store a snap's declared secrets in the keychain through
//! `kingu-ptyd snap-secret` (kingu_ptyd::secrets), which also reads them when the snap runs: the
//! app passes values through but never reads one back.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::snap::{SnapInfo, TRUST_FILE, TrustData, USER_DIR, config_dir, discover, is_snap_id};
use crate::workspace::Workspace;

const LOG_DIR: &str = "snap-services";
/// What `snap_service_log` returns at most: the end of the log.
const MAX_LOG_READ: u64 = 64 * 1024;
/// How long a stopped service gets to exit after SIGTERM before it is killed.
const STOP_GRACE: Duration = Duration::from_secs(3);

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
  pub snap_id: String,
  pub service_id: String,
  pub running: bool,
  pub pid: Option<u32>,
  /// Unix seconds.
  pub started_at: u64,
  pub ended_at: Option<u64>,
  /// The exit code once it ended (None: killed by a signal, or still running).
  pub exit_code: Option<i32>,
  /// Kingu stopped it (not a crash).
  pub stopped: bool,
  pub log: String,
}

struct Running {
  child: Mutex<Child>,
  status: Mutex<ServiceStatus>,
}

#[derive(Default)]
pub struct Services {
  all: Arc<Mutex<HashMap<String, Arc<Running>>>>,
}

fn key(snap: &str, service: &str) -> String {
  format!("{snap}/{service}")
}

fn now() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default()
}

#[cfg(unix)]
fn signal_group(pid: u32, sig: i32) {
  // The service leads its own process group (so does whatever it starts).
  unsafe {
    libc::kill(-(pid as i32), sig);
  }
}

/// The service `service` declared by the active snap `snap` in `list`.
fn declared<'a>(list: &'a [SnapInfo], snap: &str, service: &str) -> Result<&'a SnapInfo, String> {
  let s = list
    .iter()
    .find(|s| s.id == snap && s.error.is_none() && s.trusted && !s.overridden)
    .ok_or_else(|| format!("snap \"{snap}\" ไม่ได้ใช้งานอยู่"))?;
  s.services.iter().any(|sv| sv.id == service).then_some(s).ok_or_else(|| format!("snap \"{snap}\" ไม่ได้ประกาศ service \"{service}\""))
}

/// How to run a service: its argv and extra env, in `cwd`, output to `log`, with `path` as PATH.
pub struct Launch {
  pub argv: Vec<String>,
  pub env: Vec<(String, String)>,
  pub cwd: PathBuf,
  pub log: PathBuf,
  pub path: Option<OsString>,
}

impl Services {
  /// Starts `launch` as service `service` of `snap` (or returns the running one's status).
  pub fn start(&self, snap: &str, service: &str, launch: Launch, on_exit: impl Fn(ServiceStatus) + Send + 'static) -> Result<ServiceStatus, String> {
    let Launch { argv, env, cwd, log, path } = launch;
    let k = key(snap, service);
    let mut all = self.all.lock().unwrap();
    if let Some(r) = all.get(&k) {
      let st = r.status.lock().unwrap().clone();
      if st.running {
        return Ok(st);
      }
    }
    let (program, args) = argv.split_first().ok_or("service ไม่มีคำสั่ง")?;
    if let Some(dir) = log.parent() {
      std::fs::create_dir_all(dir).map_err(|e| format!("สร้าง {} ไม่ได้: {e}", dir.display()))?;
    }
    let out = std::fs::File::create(&log).map_err(|e| format!("เปิด log {} ไม่ได้: {e}", log.display()))?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(program);
    cmd.args(args).current_dir(&cwd).stdin(Stdio::null()).stdout(out).stderr(err);
    if let Some(path) = path {
      cmd.env("PATH", path);
    }
    cmd.envs(env.iter().map(|(k, v)| (k, v)));
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let child = cmd.spawn().map_err(|e| format!("เริ่ม service \"{service}\" ไม่ได้: {program}: {e}"))?;
    let status = ServiceStatus {
      snap_id: snap.to_string(),
      service_id: service.to_string(),
      running: true,
      pid: Some(child.id()),
      started_at: now(),
      ended_at: None,
      exit_code: None,
      stopped: false,
      log: log.display().to_string(),
    };
    let running = Arc::new(Running { child: Mutex::new(child), status: Mutex::new(status.clone()) });
    all.insert(k, running.clone());
    drop(all);
    let pid_file = log.with_extension("pid");
    let _ = std::fs::write(&pid_file, format!("{} {}\n", status.pid.unwrap_or_default(), status.started_at));
    log::info!("snap {snap}: service {service} started (pid {:?})", status.pid);
    std::thread::spawn(move || {
      let code = loop {
        match running.child.lock().unwrap().try_wait() {
          Ok(Some(s)) => break s.code(),
          Ok(None) => {}
          Err(_) => break None,
        }
        std::thread::sleep(Duration::from_millis(200));
      };
      let st = {
        let mut st = running.status.lock().unwrap();
        st.running = false;
        st.ended_at = Some(now());
        st.exit_code = code;
        st.clone()
      };
      let _ = std::fs::remove_file(&pid_file);
      log::info!("snap {}: service {} exited (code {code:?}, stopped = {})", st.snap_id, st.service_id, st.stopped);
      on_exit(st);
    });
    Ok(status)
  }

  /// SIGTERM to the service's group, SIGKILL after `grace` if it is still there.
  pub fn stop(&self, snap: &str, service: &str, grace: Duration) {
    let Some(r) = self.all.lock().unwrap().get(&key(snap, service)).cloned() else { return };
    let pid = {
      let mut st = r.status.lock().unwrap();
      if !st.running {
        return;
      }
      st.stopped = true;
      st.pid
    };
    let Some(pid) = pid else { return };
    #[cfg(unix)]
    signal_group(pid, libc::SIGTERM);
    std::thread::spawn(move || {
      let deadline = std::time::Instant::now() + grace;
      while std::time::Instant::now() < deadline {
        if !r.status.lock().unwrap().running {
          return;
        }
        std::thread::sleep(Duration::from_millis(50));
      }
      #[cfg(unix)]
      signal_group(pid, libc::SIGKILL);
      let _ = r.child.lock().unwrap().kill();
    });
  }

  pub fn list(&self) -> Vec<ServiceStatus> {
    let mut out: Vec<_> = self.all.lock().unwrap().values().map(|r| r.status.lock().unwrap().clone()).collect();
    out.sort_by(|a, b| (&a.snap_id, &a.service_id).cmp(&(&b.snap_id, &b.service_id)));
    out
  }

  /// On app exit: SIGTERM every service, then SIGKILL what is left after a moment.
  pub fn stop_all(&self) {
    let all: Vec<_> = self.all.lock().unwrap().values().cloned().collect();
    let pids: Vec<u32> = all
      .iter()
      .filter_map(|r| {
        let mut st = r.status.lock().unwrap();
        st.stopped = true;
        st.running.then_some(st.pid).flatten()
      })
      .collect();
    if pids.is_empty() {
      return;
    }
    #[cfg(unix)]
    for &pid in &pids {
      signal_group(pid, libc::SIGTERM);
    }
    let deadline = std::time::Instant::now() + Duration::from_millis(800);
    while std::time::Instant::now() < deadline && all.iter().any(|r| r.status.lock().unwrap().running) {
      std::thread::sleep(Duration::from_millis(50));
    }
    #[cfg(unix)]
    for &pid in &pids {
      signal_group(pid, libc::SIGKILL);
    }
    log::info!("stopped {} snap service(s)", pids.len());
  }
}

/// Seconds since `pid` started (`ps -o etime=`: `[[dd-]hh:]mm:ss`), or None when it is gone.
fn elapsed(pid: u32) -> Option<u64> {
  let out = Command::new("ps").args(["-o", "etime=", "-p", &pid.to_string()]).output().ok()?;
  parse_etime(String::from_utf8_lossy(&out.stdout).trim())
}

fn parse_etime(s: &str) -> Option<u64> {
  if s.is_empty() {
    return None;
  }
  let (days, rest) = match s.split_once('-') {
    Some((d, r)) => (d.parse::<u64>().ok()?, r),
    None => (0, s),
  };
  let parts: Vec<u64> = rest.split(':').map(|p| p.parse().ok()).collect::<Option<_>>()?;
  let secs = match parts.as_slice() {
    [m, s] => m * 60 + s,
    [h, m, s] => h * 3600 + m * 60 + s,
    _ => return None,
  };
  Some(days * 86400 + secs)
}

/// Stops the services a previous Kingu left running (their `.pid` files are still in `dir`): only
/// a process that leads its own group and started when the file says, so a reused pid is never hit.
pub fn stop_orphans(dir: &Path) -> usize {
  let Ok(read) = std::fs::read_dir(dir) else { return 0 };
  let mut stopped = 0;
  for entry in read.flatten() {
    let path = entry.path();
    if path.extension().and_then(|e| e.to_str()) != Some("pid") {
      continue;
    }
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let _ = std::fs::remove_file(&path);
    let mut it = text.split_whitespace().map(|w| w.parse::<u64>().ok());
    let (Some(Some(pid)), Some(Some(started))) = (it.next(), it.next()) else { continue };
    let Ok(pid) = u32::try_from(pid) else { continue };
    let same = elapsed(pid).is_some_and(|e| now().saturating_sub(e).abs_diff(started) <= 5);
    if pid > 1 && same {
      #[cfg(unix)]
      signal_group(pid, libc::SIGTERM);
      log::info!("stopped snap service left running by a previous Kingu (pid {pid}, {})", path.display());
      stopped += 1;
    }
  }
  stopped
}

/// At startup: stops services a killed Kingu left behind.
pub fn startup(app: &AppHandle) {
  if let Ok(dir) = app.path().app_cache_dir().map(|d| d.join(LOG_DIR)) {
    std::thread::spawn(move || stop_orphans(&dir));
  }
}

/// `text` without ANSI escape sequences (CSI `ESC [ … final` and OSC `ESC ] … BEL/ST`): services
/// colour their logs even into a file, and the log view shows plain text.
pub fn strip_ansi(text: &str) -> String {
  let mut out = String::with_capacity(text.len());
  let mut it = text.chars().peekable();
  while let Some(c) = it.next() {
    if c != '\x1b' {
      out.push(c);
      continue;
    }
    match it.next() {
      Some('[') => {
        for c in it.by_ref() {
          if ('@'..='~').contains(&c) {
            break;
          }
        }
      }
      Some(']') => {
        while let Some(c) = it.next() {
          if c == '\x07' || (c == '\x1b' && it.next_if_eq(&'\\').is_some()) {
            break;
          }
        }
      }
      _ => {}
    }
  }
  out
}

/// The end of `file` (at most `max` bytes, from a line start), lossy UTF-8.
pub fn tail(file: &Path, max: u64) -> String {
  use std::io::{Read, Seek, SeekFrom};
  let Ok(mut f) = std::fs::File::open(file) else { return String::new() };
  let len = f.metadata().map(|m| m.len()).unwrap_or_default();
  let start = len.saturating_sub(max);
  if f.seek(SeekFrom::Start(start)).is_err() {
    return String::new();
  }
  let mut bytes = Vec::new();
  let _ = f.read_to_end(&mut bytes);
  let text = String::from_utf8_lossy(&bytes).into_owned();
  if start > 0 { text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or(text) } else { text }
}

/// Where a program is: itself when absolute (and a file), else the first folder of `path` (then
/// the usual install folders a GUI app's PATH may lack) that has it.
pub fn find_program(program: &str, path: Option<&OsString>, home: Option<&Path>) -> Option<PathBuf> {
  let p = Path::new(program);
  if p.is_absolute() {
    return p.is_file().then(|| p.to_path_buf());
  }
  if program.is_empty() || program.contains('/') {
    return None;
  }
  let mut dirs: Vec<PathBuf> = path.map(|p| std::env::split_paths(p).collect()).unwrap_or_default();
  if let Some(home) = home {
    dirs.extend([home.join(".local/bin"), home.join(".cargo/bin"), home.join("bin")]);
  }
  dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
  dirs.into_iter().map(|d| d.join(program)).find(|f| f.is_file())
}

/// Where each program is, for `[[requires]]` (None: not found). Also tells whether that folder is
/// on the login-shell PATH, since agents and services resolve bare program names through it.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Found {
  pub path: Option<String>,
  pub on_path: bool,
}

#[tauri::command]
pub fn snap_find_programs(programs: Vec<String>) -> Vec<Found> {
  let path = crate::shell_env::path();
  let home = std::env::var_os("HOME").map(PathBuf::from);
  programs
    .iter()
    .take(64)
    .map(|p| {
      let on = find_program(p, path.as_ref(), None);
      let any = on.clone().or_else(|| find_program(p, None, home.as_deref()));
      Found { path: any.map(|f| f.display().to_string()), on_path: on.is_some() }
    })
    .collect()
}

fn log_file(app: &AppHandle, snap: &str, service: &str) -> Result<PathBuf, String> {
  Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join(LOG_DIR).join(format!("{snap}-{service}.log")))
}

fn check_ids(snap: &str, service: &str) -> Result<(), String> {
  if !is_snap_id(snap) || !is_snap_id(service) {
    return Err("id ของ snap หรือ service ไม่ถูกต้อง".into());
  }
  Ok(())
}

#[tauri::command]
pub fn snap_service_start(app: AppHandle, ws: State<'_, Workspace>, services: State<'_, Services>, snap: String, service: String, argv: Vec<String>, env: Vec<(String, String)>) -> Result<ServiceStatus, String> {
  check_ids(&snap, &service)?;
  let config = config_dir(&app)?;
  let list = discover(&config.join(USER_DIR), ws.current().as_deref(), &TrustData::load(&config.join(TRUST_FILE)));
  declared(&list, &snap, &service)?;
  let cwd = std::env::var_os("HOME").map(PathBuf::from).filter(|h| h.is_dir()).unwrap_or_else(std::env::temp_dir);
  let emitter = app.clone();
  let launch = Launch { argv, env, cwd, log: log_file(&app, &snap, &service)?, path: crate::shell_env::path() };
  services.start(&snap, &service, launch, move |st| {
    let _ = emitter.emit("snap-service", st);
  })
}

#[tauri::command]
pub fn snap_service_stop(services: State<'_, Services>, snap: String, service: String) -> Result<(), String> {
  check_ids(&snap, &service)?;
  services.stop(&snap, &service, STOP_GRACE);
  Ok(())
}

#[tauri::command]
pub fn snap_service_list(services: State<'_, Services>) -> Vec<ServiceStatus> {
  services.list()
}

#[tauri::command]
pub fn snap_service_log(app: AppHandle, snap: String, service: String) -> Result<String, String> {
  check_ids(&snap, &service)?;
  Ok(strip_ansi(&tail(&log_file(&app, &snap, &service)?, MAX_LOG_READ)))
}

/// Whether `url` is one a listed or shipped snap declares (`[[requires]].url`).
fn declared_link(lists: &[&[SnapInfo]], id: &str, url: &str) -> bool {
  url.starts_with("https://") && lists.iter().flat_map(|l| l.iter()).any(|s| s.id == id && s.requires.iter().any(|r| r.url.as_deref() == Some(url)))
}

/// Opens the install guide a snap's `[[requires]]` names in the browser; nothing else (the app
/// has no general way for page content to open links).
#[tauri::command]
pub async fn snap_open_link(app: AppHandle, id: String, url: String) -> Result<(), String> {
  crate::snap_install::blocking(move || {
    let config = config_dir(&app)?;
    let root = app.state::<Workspace>().current();
    let list = discover(&config.join(USER_DIR), root.as_deref(), &TrustData::load(&config.join(TRUST_FILE)));
    let catalog = crate::snap_install::catalog_dir(&app).map(|d| crate::snap::scan(&d, crate::snap::Source::User, None, &TrustData::default())).unwrap_or_default();
    if !declared_link(&[&list, &catalog], &id, &url) {
      return Err("ลิงก์นี้ไม่ได้ประกาศไว้ใน [[requires]] ของ snap".into());
    }
    let program = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    Command::new(program).arg(&url).spawn().map(|_| ()).map_err(|e| format!("{program}: {e}"))
  })
  .await
}

// ---------------------------------------------------------------------------------------------
// Secrets

/// Whether each declared secret of a snap has a value stored for it.
#[derive(Serialize, Debug, PartialEq)]
pub struct SecretState {
  pub name: String,
  pub stored: bool,
}

/// The listed snap `id` (valid) and that it declares `name`.
fn declared_secret(list: &[SnapInfo], id: &str, name: &str) -> Result<(), String> {
  let s = list.iter().find(|s| s.id == id && s.error.is_none()).ok_or_else(|| format!("ไม่พบ snap \"{id}\""))?;
  if s.permissions.secrets.iter().any(|n| n == name) { Ok(()) } else { Err(format!("snap \"{id}\" ไม่ได้ประกาศ secret \"{name}\"")) }
}

fn listed(app: &AppHandle) -> Result<Vec<SnapInfo>, String> {
  let config = config_dir(app)?;
  let root = app.state::<Workspace>().current();
  Ok(discover(&config.join(USER_DIR), root.as_deref(), &TrustData::load(&config.join(TRUST_FILE))))
}

fn launcher() -> Result<PathBuf, String> {
  let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(PathBuf::from));
  crate::pty::find_daemon(std::env::var_os("KINGU_PTYD"), exe_dir.as_deref())
}

/// Runs `kingu-ptyd snap-secret <args>` with `input` on stdin; its stdout, or its error line.
fn secret_tool(launcher: &Path, args: &[&str], input: Option<&str>) -> Result<String, String> {
  use std::io::Write;
  let mut child = Command::new(launcher)
    .arg(kingu_ptyd::secrets::SUBCOMMAND)
    .args(args)
    .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|e| format!("{}: {e}", launcher.display()))?;
  if let (Some(value), Some(mut stdin)) = (input, child.stdin.take()) {
    stdin.write_all(value.as_bytes()).map_err(|e| e.to_string())?;
  }
  let out = child.wait_with_output().map_err(|e| e.to_string())?;
  if out.status.success() {
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
  } else {
    let err = String::from_utf8_lossy(&out.stderr);
    Err(err.trim().trim_start_matches("kingu: ").to_string())
  }
}

#[tauri::command]
pub async fn snap_secret_status(app: AppHandle, id: String) -> Result<Vec<SecretState>, String> {
  crate::snap_install::blocking(move || {
    let list = listed(&app)?;
    let snap = list.iter().find(|s| s.id == id && s.error.is_none()).ok_or_else(|| format!("ไม่พบ snap \"{id}\""))?;
    let names = snap.permissions.secrets.clone();
    if names.is_empty() {
      return Ok(Vec::new());
    }
    let mut args = vec!["has", id.as_str()];
    args.extend(names.iter().map(String::as_str));
    let has: Vec<bool> = serde_json::from_str(&secret_tool(&launcher()?, &args, None)?).map_err(|e| e.to_string())?;
    Ok(names.into_iter().zip(has).map(|(name, stored)| SecretState { name, stored }).collect())
  })
  .await
}

#[tauri::command]
pub async fn snap_secret_set(app: AppHandle, id: String, name: String, value: String) -> Result<(), String> {
  crate::snap_install::blocking(move || {
    declared_secret(&listed(&app)?, &id, &name)?;
    secret_tool(&launcher()?, &["set", &id, &name], Some(&value))?;
    log::info!("snap {id}: stored secret {name}");
    Ok(())
  })
  .await
}

#[tauri::command]
pub async fn snap_secret_delete(app: AppHandle, id: String, name: String) -> Result<(), String> {
  crate::snap_install::blocking(move || {
    declared_secret(&listed(&app)?, &id, &name)?;
    secret_tool(&launcher()?, &["delete", &id, &name], None)?;
    log::info!("snap {id}: removed secret {name}");
    Ok(())
  })
  .await
}

#[cfg(all(test, unix))]
mod tests {
  use super::*;

  fn wait_until(f: impl Fn() -> bool) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
      if f() {
        return true;
      }
      std::thread::sleep(Duration::from_millis(20));
    }
    false
  }

  fn sh(script: &str) -> Vec<String> {
    vec!["/bin/sh".into(), "-c".into(), script.into()]
  }

  fn launch(argv: Vec<String>, env: Vec<(String, String)>, cwd: &Path, log: PathBuf) -> Launch {
    Launch { argv, env, cwd: cwd.to_path_buf(), log, path: None }
  }

  #[test]
  fn runs_logs_stops_and_reports_exit() {
    let dir = tempfile::tempdir().unwrap();
    let services = Services::default();
    let (tx, rx) = std::sync::mpsc::channel();
    let log = dir.path().join("logs/mem-server.log");
    let st = services.start("mem", "server", launch(sh("echo up $GREETING; exec sleep 30"), vec![("GREETING".into(), "hi".into())], dir.path(), log.clone()), move |s| tx.send(s).unwrap()).unwrap();
    assert!(st.running && st.pid.is_some());
    assert!(wait_until(|| tail(&log, 1024).contains("up hi")));
    // Starting again while it runs returns it, without a second process.
    assert_eq!(services.start("mem", "server", launch(sh("exit 9"), vec![], dir.path(), log.clone()), |_| {}).unwrap().pid, st.pid);
    assert_eq!(services.list().len(), 1);

    services.stop("mem", "server", Duration::from_secs(2));
    let ended = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(!ended.running && ended.stopped && ended.ended_at.is_some());
    assert!(!services.list()[0].running);

    // A crash is reported with its code and can be started again.
    let (tx, rx) = std::sync::mpsc::channel();
    services.start("mem", "server", launch(sh("exit 3"), vec![], dir.path(), log), move |s| tx.send(s).unwrap()).unwrap();
    let crashed = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!((crashed.exit_code, crashed.stopped), (Some(3), false));
  }

  #[test]
  fn stop_kills_what_ignores_sigterm_and_stop_all_ends_everything() {
    let dir = tempfile::tempdir().unwrap();
    let services = Services::default();
    let (tx, rx) = std::sync::mpsc::channel();
    services.start("a", "stubborn", launch(sh("trap '' TERM; while :; do sleep 0.05; done"), vec![], dir.path(), dir.path().join("a.log")), move |s| tx.send(s).unwrap()).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    services.stop("a", "stubborn", Duration::from_millis(200));
    assert!(!rx.recv_timeout(Duration::from_secs(5)).unwrap().running);

    services.start("b", "x", launch(sh("exec sleep 30"), vec![], dir.path(), dir.path().join("b.log")), |_| {}).unwrap();
    services.stop_all();
    assert!(wait_until(|| services.list().iter().all(|s| !s.running)));
  }

  #[test]
  fn only_declared_services_of_active_snaps() {
    let dir = tempfile::tempdir().unwrap();
    let snap = dir.path().join("mem");
    std::fs::create_dir_all(&snap).unwrap();
    std::fs::write(snap.join(crate::snap::MANIFEST), "id = \"mem\"\nname = \"M\"\nversion = \"1\"\n[[services]]\nid = \"server\"\ntitle = \"Server\"\ncommand = [\"mem\", \"serve\"]\n").unwrap();
    let list = discover(dir.path(), None, &TrustData::default());
    assert!(declared(&list, "mem", "server").is_ok());
    assert!(declared(&list, "mem", "other").is_err());
    assert!(declared(&list, "nope", "server").is_err());
  }

  #[test]
  fn opens_only_declared_https_links() {
    let dir = tempfile::tempdir().unwrap();
    let snap = dir.path().join("mem");
    std::fs::create_dir_all(&snap).unwrap();
    std::fs::write(snap.join(crate::snap::MANIFEST), "id = \"mem\"\nname = \"M\"\nversion = \"1\"\n[[requires]]\nprogram = \"mem\"\nurl = \"https://example.com/install\"\n").unwrap();
    let list = discover(dir.path(), None, &TrustData::default());
    assert!(declared_link(&[&list], "mem", "https://example.com/install"));
    assert!(!declared_link(&[&list], "mem", "https://evil.example"));
    assert!(!declared_link(&[&list], "other", "https://example.com/install"));
    assert!(!declared_link(&[&[]], "mem", "https://example.com/install"));
  }

  #[test]
  fn finds_programs_on_the_path_then_in_install_folders() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    let local = dir.path().join("home/.local/bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&local).unwrap();
    std::fs::write(bin.join("tool"), "").unwrap();
    std::fs::write(local.join("mem"), "").unwrap();
    let path = std::env::join_paths([&bin]).unwrap();
    assert_eq!(find_program("tool", Some(&path), None), Some(bin.join("tool")));
    assert_eq!(find_program("mem", Some(&path), None), None);
    assert_eq!(find_program("mem", None, Some(&dir.path().join("home"))), Some(local.join("mem")));
    assert_eq!(find_program(&bin.join("tool").display().to_string(), None, None), Some(bin.join("tool")));
    assert_eq!(find_program("../bin/tool", Some(&path), None), None);
  }

  #[test]
  fn secrets_only_for_names_the_snap_declares() {
    let dir = tempfile::tempdir().unwrap();
    let snap = dir.path().join("pg");
    std::fs::create_dir_all(&snap).unwrap();
    std::fs::write(snap.join(crate::snap::MANIFEST), "id = \"pg\"\nname = \"P\"\nversion = \"1\"\n[permissions]\nsecrets = [\"PGPASSWORD\"]\n").unwrap();
    let list = discover(dir.path(), None, &TrustData::default());
    assert!(declared_secret(&list, "pg", "PGPASSWORD").is_ok());
    assert!(declared_secret(&list, "pg", "AWS_SECRET_ACCESS_KEY").is_err());
    assert!(declared_secret(&list, "nope", "PGPASSWORD").is_err());
  }

  #[test]
  fn the_secret_tool_gets_the_value_on_stdin_and_reports_errors() {
    // A stand-in for kingu-ptyd: echoes its arguments and stdin, fails on "bad".
    let dir = tempfile::tempdir().unwrap();
    let tool = dir.path().join("tool");
    std::fs::write(&tool, "#!/bin/sh\nif [ \"$2\" = bad ]; then echo 'kingu: nope' >&2; exit 1; fi\nprintf '%s ' \"$@\"; cat\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(secret_tool(&tool, &["set", "pg", "PGPASSWORD"], Some("pw")).unwrap(), "snap-secret set pg PGPASSWORD pw");
    assert_eq!(secret_tool(&tool, &["bad"], None).unwrap_err(), "nope");
  }

  #[test]
  fn stops_services_a_killed_kingu_left_behind() {
    let dir = tempfile::tempdir().unwrap();
    let services = Services::default();
    let log = dir.path().join("mem-server.log");
    let st = services.start("mem", "server", launch(sh("exec sleep 30"), vec![], dir.path(), log.clone()), |_| {}).unwrap();
    let pid_file = log.with_extension("pid");
    assert!(pid_file.is_file());
    // Kingu "dies": the record stays, the process keeps running.
    let pid = st.pid.unwrap();
    // A stale record of a process that is gone, and one whose pid now belongs to another process.
    std::fs::write(dir.path().join("gone-x.pid"), "999999 1\n").unwrap();
    std::fs::write(dir.path().join("reused-x.pid"), format!("{} 1\n", std::process::id())).unwrap();
    assert_eq!(stop_orphans(dir.path()), 1);
    assert!(wait_until(|| elapsed(pid).is_none() || !services.list()[0].running));
    assert!(std::fs::read_dir(dir.path()).unwrap().flatten().all(|e| e.path().extension().and_then(|x| x.to_str()) != Some("pid")));
  }

  #[test]
  fn parses_ps_elapsed_times() {
    assert_eq!(parse_etime("00:05"), Some(5));
    assert_eq!(parse_etime("01:02:03"), Some(3723));
    assert_eq!(parse_etime("2-01:00:00"), Some(2 * 86400 + 3600));
    assert_eq!(parse_etime(""), None);
    assert_eq!(parse_etime("x"), None);
  }

  #[test]
  fn strips_ansi_colours_and_titles() {
    assert_eq!(strip_ansi("\x1b[2m2026\x1b[0m \x1b[32m INFO\x1b[0m ready \x1b[3mx\x1b[0m=1"), "2026  INFO ready x=1");
    assert_eq!(strip_ansi("a\x1b]0;title\x07b\x1b]8;;http://x\x1b\\c"), "abc");
    assert_eq!(strip_ansi("plain ไทย\n"), "plain ไทย\n");
  }

  #[test]
  fn tail_starts_at_a_line() {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("l");
    std::fs::write(&f, "first line\nsecond\nthird\n").unwrap();
    assert_eq!(tail(&f, 1024), "first line\nsecond\nthird\n");
    assert_eq!(tail(&f, 10), "third\n");
    assert_eq!(tail(&dir.path().join("none"), 10), "");
  }
}
