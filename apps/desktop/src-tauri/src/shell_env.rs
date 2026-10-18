//! The user's login-shell PATH. A macOS app launched from Finder/Dock inherits launchd's minimal
//! PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so `claude`, `bun`, `rg` and language servers
//! installed via Homebrew, npm, cargo or mise would not be found. Resolved once, off the main
//! thread at startup, by asking `$SHELL -ilc` (with a timeout, since rc files can hang).

use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const MARKER: &str = "__KINGU_PATH__";
/// VS Code's `application.shellEnvironmentResolutionTimeout` default (seconds).
pub const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(10);

static LOGIN_PATH: OnceLock<Option<OsString>> = OnceLock::new();
static TIMEOUT: OnceLock<Duration> = OnceLock::new();

/// `application.shellEnvironmentResolutionTimeout`: whole seconds from 1 to 120 (VS Code's range),
/// else the default.
pub fn resolution_timeout(setting: Option<&serde_json::Value>) -> Duration {
  match setting.and_then(serde_json::Value::as_f64) {
    Some(secs) if (1.0..=120.0).contains(&secs) => Duration::from_secs_f64(secs),
    _ => LOGIN_SHELL_TIMEOUT,
  }
}

/// Starts resolving in the background so the first agent/LSP/search lookup rarely waits.
pub fn init(timeout: Duration) {
  let _ = TIMEOUT.set(timeout);
  std::thread::spawn(|| {
    let _ = login_path();
  });
}

fn login_path() -> Option<&'static OsString> {
  LOGIN_PATH
    .get_or_init(|| {
      if !cfg!(target_os = "macos") {
        return None;
      }
      let shell = std::env::var_os("SHELL").map(PathBuf::from).unwrap_or_else(|| "/bin/zsh".into());
      let started = Instant::now();
      let path = read_login_path(&shell, *TIMEOUT.get().unwrap_or(&LOGIN_SHELL_TIMEOUT));
      match &path {
        Some(_) => log::info!("login shell PATH resolved in {:?}", started.elapsed()),
        None => log::info!("login shell PATH unavailable from {}; using the process PATH", shell.display()),
      }
      path.map(OsString::from)
    })
    .as_ref()
}

/// Login-shell PATH entries first, then any process PATH entries it lacks.
pub fn path() -> Option<OsString> {
  merge(login_path().map(OsString::as_os_str), std::env::var_os("PATH").as_deref())
}

/// `Command::new(program)` with PATH set to [`path`], for tools that look up other tools (git
/// hooks and credential helpers, `gh` calling `git`), as the agent host gets it.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
  let mut cmd = Command::new(program);
  if let Some(p) = path() {
    cmd.env("PATH", p);
  }
  cmd
}

/// The process environment with PATH replaced by [`path`].
pub fn vars_os() -> Vec<(OsString, OsString)> {
  let mut vars: Vec<_> = std::env::vars_os().filter(|(k, _)| k != "PATH").collect();
  if let Some(p) = path() {
    vars.push(("PATH".into(), p));
  }
  vars
}

pub fn merge(first: Option<&std::ffi::OsStr>, second: Option<&std::ffi::OsStr>) -> Option<OsString> {
  let mut dirs: Vec<PathBuf> = Vec::new();
  for d in [first, second].into_iter().flatten().flat_map(std::env::split_paths) {
    if !d.as_os_str().is_empty() && !dirs.contains(&d) {
      dirs.push(d);
    }
  }
  if dirs.is_empty() { None } else { std::env::join_paths(dirs).ok() }
}

/// Runs `<shell> -ilc 'printf …"$PATH"…'` and extracts PATH between markers, so banners and
/// other rc-file output are ignored. `None` on failure or timeout (the shell is then killed).
pub fn read_login_path(shell: &Path, timeout: Duration) -> Option<String> {
  let script = format!("printf '\\n{MARKER}%s{MARKER}\\n' \"$PATH\"");
  let mut cmd = Command::new(shell);
  cmd.arg("-ilc").arg(script).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
  #[cfg(unix)]
  std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
  let mut child = cmd.spawn().ok()?;
  let mut stdout = child.stdout.take()?;
  let reader = std::thread::spawn(move || {
    let mut out = Vec::new();
    let _ = stdout.read_to_end(&mut out);
    out
  });
  let started = Instant::now();
  loop {
    match child.try_wait() {
      Ok(Some(_)) => break,
      Ok(None) if started.elapsed() < timeout => std::thread::sleep(Duration::from_millis(20)),
      _ => {
        #[cfg(unix)]
        unsafe {
          libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        let _ = child.kill();
        let _ = child.wait();
        return None;
      }
    }
  }
  let out = reader.join().ok()?;
  parse_marked(&String::from_utf8_lossy(&out))
}

pub fn parse_marked(out: &str) -> Option<String> {
  let start = out.find(MARKER)? + MARKER.len();
  let len = out[start..].find(MARKER)?;
  let path = out[start..start + len].trim();
  (!path.is_empty()).then(|| path.to_owned())
}

#[cfg(all(test, unix))]
mod tests {
  use super::*;
  use std::os::unix::fs::PermissionsExt;

  fn fake_shell(dir: &Path, body: &str) -> PathBuf {
    let p = dir.join("fake-shell");
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
  }

  #[test]
  fn reads_path_through_rc_noise() {
    let tmp = tempfile::tempdir().unwrap();
    // $1 is -ilc, $2 the script; rc files may print anything around it.
    let sh = fake_shell(tmp.path(), "echo 'Welcome to zsh!'\nPATH=/opt/homebrew/bin:/usr/bin\neval \"$2\"\necho bye");
    assert_eq!(read_login_path(&sh, Duration::from_secs(5)).as_deref(), Some("/opt/homebrew/bin:/usr/bin"));
  }

  #[test]
  fn resolution_timeout_follows_the_setting_within_vs_code_range() {
    use serde_json::json;
    assert_eq!(resolution_timeout(None), Duration::from_secs(10));
    assert_eq!(resolution_timeout(Some(&json!(30))), Duration::from_secs(30));
    assert_eq!(resolution_timeout(Some(&json!(1.5))), Duration::from_millis(1500));
    assert_eq!(resolution_timeout(Some(&json!(0))), Duration::from_secs(10));
    assert_eq!(resolution_timeout(Some(&json!(121))), Duration::from_secs(10));
    assert_eq!(resolution_timeout(Some(&json!("5"))), Duration::from_secs(10));
  }

  #[test]
  fn gives_up_on_a_hanging_shell() {
    let tmp = tempfile::tempdir().unwrap();
    let sh = fake_shell(tmp.path(), "sleep 30");
    let started = Instant::now();
    assert_eq!(read_login_path(&sh, Duration::from_millis(300)), None);
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(read_login_path(Path::new("/nonexistent/shell"), Duration::from_secs(1)), None);
  }

  #[test]
  fn parses_markers_and_merges_paths() {
    assert_eq!(parse_marked("x\n__KINGU_PATH__/a:/b__KINGU_PATH__\n"), Some("/a:/b".into()));
    assert_eq!(parse_marked("__KINGU_PATH____KINGU_PATH__"), None);
    assert_eq!(parse_marked("no markers"), None);
    let merged = merge(Some("/opt/homebrew/bin:/usr/bin".as_ref()), Some("/usr/bin:/bin".as_ref())).unwrap();
    assert_eq!(merged, "/opt/homebrew/bin:/usr/bin:/bin");
    assert_eq!(merge(None, None), None);
  }
}
