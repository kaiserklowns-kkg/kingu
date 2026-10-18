//! Orca's worktree "Open in" apps (`kingu.worktree.openIn`): label → command, or `app:<Name>`
//! for macOS `open -a`. The command comes only from the user's settings.json (read here, never
//! from the webview), the folder must be the open folder or one of its git worktrees, and the
//! folder is passed as the last argument without a shell.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tauri::{AppHandle, Manager, State};

use crate::workspace::Workspace;

pub const SETTING: &str = "kingu.worktree.openIn";
pub const MAX_APPS: usize = 8;

/// The default when the user set nothing (Orca: VS Code is always offered first).
fn default_apps() -> serde_json::Value {
  serde_json::json!({ "VS Code": "app:Visual Studio Code" })
}

/// The argv that opens `path` with `command`.
pub fn argv(command: &str, path: &str) -> Result<Vec<String>, String> {
  let command = command.trim();
  if let Some(app) = command.strip_prefix("app:") {
    let app = app.trim();
    if app.is_empty() || app.starts_with('-') {
      return Err("app: ต้องตามด้วยชื่อแอป".into());
    }
    if !cfg!(target_os = "macos") {
      return Err("app:<ชื่อแอป> ใช้ได้เฉพาะ macOS".into());
    }
    return Ok(vec!["open".into(), "-a".into(), app.into(), "--".into(), path.into()]);
  }
  let mut words = super::ai_text::split_command(command)?;
  if words.is_empty() {
    return Err("ไม่มีคำสั่ง".into());
  }
  words.push(path.into());
  Ok(words)
}

/// The command for `label` in the user's setting (the first MAX_APPS entries).
pub fn command_for(setting: Option<serde_json::Value>, label: &str) -> Result<String, String> {
  let apps = setting.filter(|v| v.is_object()).unwrap_or_else(default_apps);
  let map = apps.as_object().ok_or("kingu.worktree.openIn ต้องเป็น object")?;
  map
    .iter()
    .filter(|(k, v)| !k.trim().is_empty() && v.as_str().is_some_and(|s| !s.trim().is_empty()))
    .take(MAX_APPS)
    .find(|(k, _)| *k == label)
    .and_then(|(_, v)| v.as_str().map(str::to_owned))
    .ok_or_else(|| format!("ไม่มี \"{label}\" ใน {SETTING}"))
}

/// `path` when it is `root` or one of its git worktrees (canonical paths compared).
pub fn checked_folder(root: &Path, path: &str) -> Result<PathBuf, String> {
  let want = Path::new(path).canonicalize().map_err(|e| format!("{path}: {e}"))?;
  let mut known = vec![root.to_path_buf()];
  known.extend(super::worktree::list(root)?.into_iter().filter(|w| !w.bare).map(|w| PathBuf::from(w.path)));
  if known.iter().filter_map(|k| k.canonicalize().ok()).any(|k| k == want) {
    Ok(want)
  } else {
    Err(format!("{path} ไม่ใช่ worktree ของโฟลเดอร์ที่เปิดอยู่"))
  }
}

#[tauri::command]
pub fn worktree_open_in(app: AppHandle, ws: State<'_, Workspace>, label: String, path: String) -> Result<(), String> {
  let root = ws.root()?;
  let folder = checked_folder(&root, &path)?;
  let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
  let command = command_for(crate::settings::user_value(&config, SETTING), &label)?;
  let argv = argv(&command, &folder.display().to_string())?;
  let (program, args) = argv.split_first().ok_or("ไม่มีคำสั่ง")?;
  let mut child = crate::shell_env::command(program)
    .args(args)
    .current_dir(&folder)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|e| format!("{program}: {e}"))?;
  log::info!("open in {label}: {program} for {}", folder.display());
  // Reaped in the background so a long-running editor does not leave a zombie.
  std::thread::spawn(move || {
    let _ = child.wait();
  });
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn builds_the_argv_without_a_shell() {
    assert_eq!(argv("cursor", "/w/a").unwrap(), ["cursor", "/w/a"]);
    assert_eq!(argv("code --new-window", "/w/a b").unwrap(), ["code", "--new-window", "/w/a b"]);
    assert_eq!(argv("echo $HOME; rm", "/w").unwrap(), ["echo", "$HOME;", "rm", "/w"]);
    assert!(argv("  ", "/w").is_err());
    assert!(argv("app:", "/w").is_err());
    assert!(argv("app:-x", "/w").is_err());
    if cfg!(target_os = "macos") {
      assert_eq!(argv("app:Visual Studio Code", "/w").unwrap(), ["open", "-a", "Visual Studio Code", "--", "/w"]);
    }
  }

  #[test]
  fn the_command_comes_from_the_setting_or_the_default() {
    assert_eq!(command_for(None, "VS Code").unwrap(), "app:Visual Studio Code");
    let s = serde_json::json!({ "Cursor": "cursor", "Empty": " ", "Zed": "zed" });
    assert_eq!(command_for(Some(s.clone()), "Zed").unwrap(), "zed");
    assert!(command_for(Some(s), "Empty").is_err());
    let many: serde_json::Map<String, serde_json::Value> = (0..10).map(|i| (format!("a{i}"), serde_json::json!("x"))).collect();
    let many = serde_json::Value::Object(many);
    assert!(command_for(Some(many.clone()), "a7").is_ok());
    assert!(command_for(Some(many), "a8").is_err());
  }

  #[test]
  fn only_the_folder_and_its_worktrees_open() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir(&root).unwrap();
    let git = |args: &[&str]| assert!(std::process::Command::new("git").arg("-C").arg(&root).args(args).output().unwrap().status.success());
    git(&["init", "-q", "-b", "main"]);
    git(&["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i"]);
    let wt = tmp.path().join("wt");
    git(&["worktree", "add", "-q", "-b", "x", wt.to_str().unwrap()]);
    assert!(checked_folder(&root, root.to_str().unwrap()).is_ok());
    assert!(checked_folder(&root, wt.to_str().unwrap()).is_ok());
    assert!(checked_folder(&root, tmp.path().to_str().unwrap()).is_err());
    assert!(checked_folder(&root, "/nonexistent/x").is_err());
  }
}
