//! User snippets (VS Code: `<user data>/User/snippets/`): `<languageId>.json` and
//! `<name>.code-snippets` files in the active profile's `snippets/` folder, which is the app
//! config dir's `snippets/` for the Default profile. The webview parses them (editor/snippets);
//! Rust only lists, reads and writes the files, by name, never by path.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::i18n::msg::SnippetsMsg;
use crate::tr;

pub const SNIPPETS_DIR: &str = "snippets";
const MAX_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SnippetFile {
  pub name: String,
  pub content: String,
}

/// A snippets file name: one path component ending in `.json` or `.code-snippets`, not hidden.
pub fn valid_name(name: &str) -> bool {
  let stem = name.strip_suffix(".code-snippets").or_else(|| name.strip_suffix(".json"));
  (1..=128).contains(&name.chars().count())
    && stem.is_some_and(|s| !s.is_empty())
    && !name.starts_with('.')
    && !name.chars().any(|c| matches!(c, '/' | '\\' | ':' | '\0') || c.is_control())
}

/// The snippets folder of a profile folder (the config dir for Default).
pub fn dir_in(profile_dir: &Path) -> PathBuf {
  profile_dir.join(SNIPPETS_DIR)
}

fn active_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
  Ok(dir_in(&crate::user_profiles::active_dir(&config)))
}

fn checked(name: &str) -> Result<(), String> {
  if valid_name(name) { Ok(()) } else { Err(tr!(SnippetsMsg::InvalidName, name)) }
}

/// Every snippets file of `dir`, by name; unreadable, oversized or oddly named files are left out.
pub fn list(dir: &Path) -> Vec<SnippetFile> {
  let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
  let mut out: Vec<SnippetFile> = entries
    .flatten()
    .filter_map(|e| {
      let name = e.file_name().to_str()?.to_string();
      let meta = e.metadata().ok()?;
      if !meta.is_file() || !valid_name(&name) || meta.len() as usize > MAX_BYTES {
        return None;
      }
      let content = std::fs::read_to_string(e.path()).ok()?;
      Some(SnippetFile { name, content })
    })
    .collect();
  out.sort_by(|a, b| a.name.cmp(&b.name));
  out
}

pub fn read(dir: &Path, name: &str) -> Result<Option<String>, String> {
  checked(name)?;
  match std::fs::read_to_string(dir.join(name)) {
    Ok(text) => Ok(Some(text)),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!("{}: {e}", dir.join(name).display())),
  }
}

pub fn write(dir: &Path, name: &str, content: &str) -> Result<(), String> {
  checked(name)?;
  if content.len() > MAX_BYTES {
    return Err(tr!(SnippetsMsg::TooLarge, name, max = MAX_BYTES));
  }
  crate::settings::write_atomic(&dir.join(name), content)
}

#[tauri::command]
pub fn snippets_user_list(app: AppHandle) -> Result<Vec<SnippetFile>, String> {
  Ok(list(&active_dir(&app)?))
}

#[tauri::command]
pub fn snippets_user_read(app: AppHandle, name: String) -> Result<Option<String>, String> {
  read(&active_dir(&app)?, &name)
}

#[tauri::command]
pub fn snippets_user_write(app: AppHandle, name: String, content: String) -> Result<(), String> {
  write(&active_dir(&app)?, &name, &content)?;
  log::info!("saved user snippets {name}");
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn names_are_single_snippet_files() {
    for ok in ["typescript.json", "my snippets.code-snippets", "c++.json", "ภาษาไทย.code-snippets"] {
      assert!(valid_name(ok), "{ok}");
    }
    for bad in ["", ".json", ".hidden.json", "a/b.json", "..\\x.json", "a.txt", "settings", "x.code-snippets/", "a:b.json", ".code-snippets"] {
      assert!(!valid_name(bad), "{bad}");
    }
  }

  #[test]
  fn list_read_write_round_trip() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = dir_in(tmp.path());
    assert!(list(&dir).is_empty());
    assert_eq!(read(&dir, "rust.json").unwrap(), None);
    write(&dir, "rust.json", "{}").unwrap();
    write(&dir, "all.code-snippets", "{ \"a\": {} }").unwrap();
    std::fs::write(dir.join("notes.txt"), "x").unwrap();
    std::fs::create_dir(dir.join("sub.json")).unwrap();
    let names: Vec<_> = list(&dir).into_iter().map(|f| f.name).collect();
    assert_eq!(names, ["all.code-snippets", "rust.json"]);
    assert_eq!(read(&dir, "rust.json").unwrap().as_deref(), Some("{}"));
    assert!(write(&dir, "../escape.json", "{}").is_err());
    assert!(read(&dir, "../settings.json").is_err());
    assert!(write(&dir, "big.json", &" ".repeat(MAX_BYTES + 1)).is_err());
  }
}
