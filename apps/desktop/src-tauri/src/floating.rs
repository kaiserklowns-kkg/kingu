//! The floating workspace (Orca's): where its terminals start and where its markdown notes live.
//! Terminals start in the configured directory (`~` by default); a missing or unreadable one falls
//! back to the app-owned `<app data>/floating-workspace`, which also holds new notes. Notes are
//! read and written only when they are markdown files.

use std::path::{Path, PathBuf};

use crate::i18n::msg::FilesMsg;
use crate::tr;

fn home() -> Option<PathBuf> {
  std::env::var_os("HOME").map(PathBuf::from)
}

/// The app-owned folder, created on demand.
pub fn app_dir(app_data: &Path) -> Result<PathBuf, String> {
  let dir = app_data.join("floating-workspace");
  std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
  Ok(dir)
}

/// The directory a floating terminal starts in, from the setting (`""`/`~` mean home).
pub fn terminal_cwd(setting: &str, app_data: &Path) -> Result<PathBuf, String> {
  let s = setting.trim();
  let wanted = if s.is_empty() || s == "~" {
    home()
  } else if let Some(rest) = s.strip_prefix("~/") {
    home().map(|h| h.join(rest))
  } else {
    Some(PathBuf::from(s))
  };
  match wanted.and_then(|p| p.canonicalize().ok()).filter(|p| p.is_dir() && std::fs::read_dir(p).is_ok()) {
    Some(dir) => Ok(dir),
    None => app_dir(app_data),
  }
}

fn is_markdown(p: &Path) -> bool {
  matches!(p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref(), Some("md" | "mdx" | "markdown"))
}

fn checked(path: &str) -> Result<PathBuf, String> {
  let p = PathBuf::from(path);
  if !p.is_absolute() || !is_markdown(&p) {
    return Err(tr!(FilesMsg::NotMarkdown));
  }
  Ok(p)
}

/// A new empty `Untitled.md` (`Untitled 2.md`, …) in the app-owned folder.
pub fn new_note(app_data: &Path) -> Result<PathBuf, String> {
  let dir = app_dir(app_data)?;
  for n in 1..10_000 {
    let name = if n == 1 { "Untitled.md".to_owned() } else { format!("Untitled {n}.md") };
    let p = dir.join(name);
    if std::fs::OpenOptions::new().write(true).create_new(true).open(&p).is_ok() {
      return Ok(p);
    }
  }
  Err(tr!(FilesMsg::UntitledFailed))
}

pub fn read_note(path: &str) -> Result<String, String> {
  std::fs::read_to_string(checked(path)?).map_err(|e| e.to_string())
}

pub fn write_note(path: &str, text: &str) -> Result<(), String> {
  std::fs::write(checked(path)?, text).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn cwd_falls_back_to_the_app_folder() {
    let tmp = std::env::temp_dir().join(format!("kingu-floating-{}", std::process::id()));
    let dir = terminal_cwd("/definitely/not/here", &tmp).unwrap();
    assert!(dir.ends_with("floating-workspace") && dir.is_dir());
    assert_eq!(terminal_cwd(tmp.to_str().unwrap(), &tmp).unwrap(), tmp.canonicalize().unwrap());
    let note = new_note(&tmp).unwrap();
    assert!(note.ends_with("Untitled.md"));
    assert!(new_note(&tmp).unwrap().ends_with("Untitled 2.md"));
    write_note(note.to_str().unwrap(), "# hi").unwrap();
    assert_eq!(read_note(note.to_str().unwrap()).unwrap(), "# hi");
    assert!(read_note("/etc/hosts").is_err());
    std::fs::remove_dir_all(&tmp).unwrap();
  }
}
