//! The app log: a size-limited, rotating `Kingu.log` in the app log dir (macOS:
//! `~/Library/Logs/<identifier>/`) in every build, plus stdout in debug builds. Info level.
//!
//! Call sites log ids, paths and outcomes, never credentials. As a safety net for messages that
//! carry text from elsewhere (webview errors, agent host stderr, git and network errors), every
//! line goes through `redact`, which masks well-known token formats, bearer/basic credentials and
//! the password in `scheme://user:password@host` URLs.

use std::borrow::Cow;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

const TIME_FORMAT: &[time::format_description::FormatItem<'static>] =
  time::macros::format_description!("[year]-[month]-[day] [hour]:[minute]:[second].[subsecond digits:3] [offset_hour sign:mandatory]:[offset_minute]");

/// One log file is at most this big before it rotates.
pub const MAX_FILE_BYTES: u128 = 5 * 1024 * 1024;
/// Rotated files kept next to the current one (so at most ~30 MB of logs).
pub const KEEP_FILES: usize = 5;
pub const FILE_NAME: &str = "Kingu";
/// A single line longer than this is cut (a stray dump must not flood the file).
const MAX_LINE_CHARS: usize = 8 * 1024;

static SECRET: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new(concat!(
    r"gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}",
    r"|xox[abprs]-[A-Za-z0-9-]{10,}|kgu_[A-Za-z0-9_-]{20,}|lin_(?:api|oauth)_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}",
    r"|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*",
  ))
  .unwrap()
});
/// `token=x`, `"password": "x"`, `Proxy-Authorization: Basic x` ...
static CREDENTIAL: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new(
    r#"(?i)\b(token|password|passwd|secret|client[_-]?secret|api[_-]?key|access[_-]?key|authorization)("?\s*[:=]\s*"?)((?:bearer|basic|digest)\s+)?[^\s"',;&\[]+"#,
  )
  .unwrap()
});
/// A bare `Bearer x` / `Basic x` credential.
static AUTH_SCHEME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(Bearer|Basic|Digest|bearer)\s+[A-Za-z0-9._~+/=-]{8,}").unwrap());
/// The userinfo of `scheme://user:password@host` (and `scheme://token@host`).
static URL_USERINFO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([A-Za-z][A-Za-z0-9+.-]*://)[^/\s@]+@").unwrap());

/// `message` with anything that looks like a credential masked.
pub fn redact(message: &str) -> Cow<'_, str> {
  let mut out = Cow::Borrowed(message);
  if SECRET.is_match(&out) {
    out = Cow::Owned(SECRET.replace_all(&out, "[redacted]").into_owned());
  }
  if URL_USERINFO.is_match(&out) {
    out = Cow::Owned(URL_USERINFO.replace_all(&out, "${1}***@").into_owned());
  }
  if CREDENTIAL.is_match(&out) {
    out = Cow::Owned(CREDENTIAL.replace_all(&out, "${1}${2}${3}[redacted]").into_owned());
  }
  if AUTH_SCHEME.is_match(&out) {
    out = Cow::Owned(AUTH_SCHEME.replace_all(&out, "${1} [redacted]").into_owned());
  }
  if out.chars().count() > MAX_LINE_CHARS {
    let cut: String = out.chars().take(MAX_LINE_CHARS).collect();
    out = Cow::Owned(format!("{cut}… (cut)"));
  }
  out
}

/// The local time as the log file writes it (the Output panel's Git channel uses it too).
pub fn now_text() -> String {
  TimezoneStrategy::UseLocal.get_now().format(TIME_FORMAT).unwrap_or_default()
}

/// The log plugin: the rotating file always, stdout in debug builds.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
  let mut targets = vec![Target::new(TargetKind::LogDir { file_name: Some(FILE_NAME.into()) })];
  if cfg!(debug_assertions) {
    targets.push(Target::new(TargetKind::Stdout));
  }
  tauri_plugin_log::Builder::new()
    .clear_targets()
    .targets(targets)
    .level(log::LevelFilter::Info)
    // Dependencies log request details at info/debug; only their warnings are worth keeping.
    .level_for("reqwest", log::LevelFilter::Warn)
    .level_for("hyper", log::LevelFilter::Warn)
    .level_for("hyper_util", log::LevelFilter::Warn)
    .level_for("rustls", log::LevelFilter::Warn)
    .max_file_size(MAX_FILE_BYTES)
    .rotation_strategy(RotationStrategy::KeepSome(KEEP_FILES))
    .timezone_strategy(TimezoneStrategy::UseLocal)
    .format(|out, message, record| {
      let when = now_text();
      let text = message.to_string();
      out.finish(format_args!("{when} [{}] [{}] {}", record.level(), record.target(), redact(&text)))
    })
    .build()
}

/// Opens `dir` in Finder (Explorer / the file manager elsewhere).
fn open_dir(dir: &Path) -> Result<(), String> {
  let program = if cfg!(target_os = "macos") {
    "open"
  } else if cfg!(target_os = "windows") {
    "explorer"
  } else {
    "xdg-open"
  };
  std::process::Command::new(program).arg(dir).spawn().map(|_| ()).map_err(|e| format!("{program}: {e}"))
}

/// "Developer: Open Logs Folder": shows the app log dir (created if missing). Returns its path.
#[tauri::command]
pub fn open_logs_folder(app: AppHandle) -> Result<String, String> {
  let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
  std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
  open_dir(&dir)?;
  Ok(dir.display().to_string())
}

/// The last `max_bytes` of `file` (from its first whole line), `""` when it does not exist yet.
pub fn tail(file: &Path, max_bytes: u64) -> Result<String, String> {
  use std::io::{Read, Seek, SeekFrom};
  let mut f = match std::fs::File::open(file) {
    Ok(f) => f,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
    Err(e) => return Err(format!("{}: {e}", file.display())),
  };
  let len = f.metadata().map_err(|e| e.to_string())?.len();
  let start = len.saturating_sub(max_bytes);
  f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
  let mut buf = Vec::new();
  f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
  let text = String::from_utf8_lossy(&buf).into_owned();
  // A cut start drops the partial first line.
  Ok(if start > 0 { text.split_once('\n').map_or(String::new(), |(_, rest)| rest.to_string()) } else { text })
}

/// The Output panel's "Kingu" channel: the end of the current `Kingu.log`.
#[tauri::command]
pub async fn app_log_tail(app: AppHandle, max_bytes: Option<u64>) -> Result<String, String> {
  let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
  let file = dir.join(format!("{FILE_NAME}.log"));
  let max = max_bytes.unwrap_or(256 * 1024).min(4 * 1024 * 1024);
  tauri::async_runtime::spawn_blocking(move || tail(&file, max)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn tail_keeps_whole_lines() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("Kingu.log");
    assert_eq!(tail(&file, 100).unwrap(), "");
    std::fs::write(&file, "first line\nsecond\nthird\n").unwrap();
    assert_eq!(tail(&file, 1000).unwrap(), "first line\nsecond\nthird\n");
    assert_eq!(tail(&file, 10).unwrap(), "third\n");
  }

  #[test]
  fn masks_tokens() {
    for secret in [
      format!("ghp_{}", "a".repeat(36)),
      format!("github_pat_{}", "A1_".repeat(10)),
      format!("sk-ant-api03-{}", "x".repeat(40)),
      format!("kgu_{}", "Z".repeat(43)),
      format!("AKIA{}", "B".repeat(16)),
      format!("xoxb-{}", "1".repeat(20)),
      format!("lin_api_{}", "c".repeat(40)),
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U".to_owned(),
    ] {
      let line = format!("gh failed: bad credentials {secret} (401)");
      let out = redact(&line);
      assert!(!out.contains(&secret), "{secret:.12} leaked: {out}");
      assert!(out.contains("[redacted]") && out.starts_with("gh failed"), "{out}");
    }
  }

  #[test]
  fn masks_url_userinfo_and_headers() {
    assert_eq!(redact("proxy http://alice:s3cret@proxy:3128 failed"), "proxy http://***@proxy:3128 failed");
    assert_eq!(redact("fatal: unable to access 'https://x-access-token:abc123@github.com/a/b.git/'"), "fatal: unable to access 'https://***@github.com/a/b.git/'");
    assert_eq!(redact("Proxy-Authorization: Basic dTpw"), "Proxy-Authorization: Basic [redacted]");
    assert_eq!(redact("Authorization: Bearer abc.def"), "Authorization: Bearer [redacted]");
    assert_eq!(redact(r#"{"password":"hunter2"}"#), r#"{"password":"[redacted]"}"#);
    assert_eq!(redact("api_key=12345&x=1"), "api_key=[redacted]&x=1");
    assert_eq!(redact("curl -H 'Bearer abcdefgh12345'"), "curl -H 'Bearer [redacted]'");
    // Words after "token" are not values.
    assert_eq!(redact("team events: token rejected (HTTP 401 invalid_token)"), "team events: token rejected (HTTP 401 invalid_token)");
  }

  #[test]
  fn leaves_ordinary_lines_alone() {
    for line in [
      "agent run 3 started for task fix-login",
      "worktree fix-login created at /Users/a/kingu/.kingu/worktrees/fix-login from main (abc123)",
      "http.proxy http://proxy.corp:3128",
      "search 4: 12 matches in 3 files (20 ms)",
      "team events: reconnecting in 2000 ms",
      "ssh://git@github.com:22/acme/app.git",
    ] {
      let out = redact(line);
      assert!(matches!(out, Cow::Borrowed(_)) || line.starts_with("ssh://"), "{line} -> {out}");
    }
    // An ssh user is not a secret, but userinfo is masked uniformly.
    assert_eq!(redact("ssh://git@github.com:22/acme/app.git"), "ssh://***@github.com:22/acme/app.git");
  }

  #[test]
  fn cuts_huge_lines() {
    let line = "x".repeat(MAX_LINE_CHARS * 2);
    let out = redact(&line);
    assert!(out.chars().count() < MAX_LINE_CHARS + 20 && out.ends_with("(cut)"));
  }
}
