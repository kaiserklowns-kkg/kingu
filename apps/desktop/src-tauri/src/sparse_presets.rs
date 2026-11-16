//! Sparse checkout presets (Orca's `sparsePresets:list` / `:save` / `:remove`): named lists of
//! folders a project's new tasks can check out instead of the whole repository. Kept per project in
//! `<project>/.kingu/sparse-presets.json` (`.kingu/` is already kept out of git status).
//!
//! Orca's rules (`rSe`, `aSe`, `oSe` in out/main/index.js): the name is trimmed, required and at most
//! `NAME_MAX` characters; folders follow `worktree::normalize_sparse_dirs` and at least one must be
//! left; saving with an existing id replaces that preset and keeps its creation time.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::agent::worktree::normalize_sparse_dirs;
use crate::projects;
use crate::workspace::Workspace;

/// Orca `aSe`: "Preset name is too long." past 80 characters.
pub const NAME_MAX: usize = 80;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
  pub id: String,
  pub name: String,
  pub directories: Vec<String>,
  pub created_at: u64,
  pub updated_at: u64,
}

fn file(root: &Path) -> PathBuf {
  root.join(".kingu").join("sparse-presets.json")
}

pub fn load(root: &Path) -> Vec<Preset> {
  std::fs::read(file(root)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn store(root: &Path, presets: &[Preset]) -> Result<(), String> {
  let path = file(root);
  if let Some(dir) = path.parent() {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  }
  let tmp = path.with_extension("json.tmp");
  let text = serde_json::to_vec_pretty(presets).map_err(|e| e.to_string())?;
  std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
  std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn validate_name(name: &str) -> Result<String, String> {
  let name = name.trim();
  if name.is_empty() {
    return Err("A preset needs a name.".into());
  }
  if name.chars().count() > NAME_MAX {
    return Err(format!("A preset name can be at most {NAME_MAX} characters."));
  }
  Ok(name.to_string())
}

pub fn validate_dirs(dirs: &[String]) -> Result<Vec<String>, String> {
  let dirs = normalize_sparse_dirs(dirs)?;
  if dirs.is_empty() {
    return Err("A preset needs at least one folder.".into());
  }
  Ok(dirs)
}

/// Adds or replaces (same `id`) a preset; returns it.
pub fn save(root: &Path, id: Option<&str>, name: &str, dirs: &[String], now: u64) -> Result<Preset, String> {
  let name = validate_name(name)?;
  let directories = validate_dirs(dirs)?;
  let mut presets = load(root);
  let old = id.and_then(|id| presets.iter().position(|p| p.id == id));
  let preset = Preset {
    id: old.map(|i| presets[i].id.clone()).unwrap_or_else(|| format!("sp-{now:x}-{:x}", presets.len())),
    name,
    directories,
    created_at: old.map_or(now, |i| presets[i].created_at),
    updated_at: now,
  };
  match old {
    Some(i) => presets[i] = preset.clone(),
    None => presets.push(preset.clone()),
  }
  store(root, &presets)?;
  Ok(preset)
}

pub fn remove(root: &Path, id: &str) -> Result<(), String> {
  let mut presets = load(root);
  presets.retain(|p| p.id != id);
  store(root, &presets)
}

fn now_ms() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn root_of(ws: &Workspace, projects: &projects::Projects, root: Option<String>) -> Result<PathBuf, String> {
  projects::root_arg(ws, projects, root)?.ok_or_else(|| "Open a folder first.".to_string())
}

#[tauri::command]
pub fn sparse_presets_list(ws: Workspace, projects: State<'_, projects::Projects>, root: Option<String>) -> Result<Vec<Preset>, String> {
  Ok(projects::root_arg(&ws, &projects, root)?.map(|r| load(&r)).unwrap_or_default())
}

#[tauri::command]
pub fn sparse_presets_save(
  ws: Workspace,
  projects: State<'_, projects::Projects>,
  root: Option<String>,
  id: Option<String>,
  name: String,
  directories: Vec<String>,
) -> Result<Preset, String> {
  save(&root_of(&ws, &projects, root)?, id.as_deref(), &name, &directories, now_ms())
}

#[tauri::command]
pub fn sparse_presets_remove(ws: Workspace, projects: State<'_, projects::Projects>, root: Option<String>, id: String) -> Result<(), String> {
  remove(&root_of(&ws, &projects, root)?, &id)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
  }

  #[test]
  fn folders_follow_orcas_rule() {
    assert_eq!(normalize_sparse_dirs(&s(&[" apps/web/ ", "apps\\api", ".", "", "apps/web", "/docs/"])).ok(), None);
    assert_eq!(normalize_sparse_dirs(&s(&[" apps/web/ ", "apps\\api", ".", "", "apps/web"])).unwrap(), s(&["apps/web", "apps/api"]));
    assert!(normalize_sparse_dirs(&s(&["a/../b"])).is_err());
    assert!(normalize_sparse_dirs(&s(&["C:/x"])).is_err());
    assert!(normalize_sparse_dirs(&s(&["\\x"])).is_err());
  }

  #[test]
  fn names_are_checked() {
    assert!(validate_name("  ").is_err());
    assert_eq!(validate_name(" Web only ").unwrap(), "Web only");
    assert!(validate_name(&"x".repeat(NAME_MAX)).is_ok());
    assert!(validate_name(&"x".repeat(NAME_MAX + 1)).is_err());
    assert!(validate_dirs(&s(&[".", " "])).is_err());
  }

  #[test]
  fn save_replace_and_remove() {
    let dir = tempfile::tempdir().unwrap();
    let a = save(dir.path(), None, "Web", &s(&["apps/web"]), 10).unwrap();
    let b = save(dir.path(), None, "Api", &s(&["apps/api"]), 20).unwrap();
    assert_ne!(a.id, b.id);
    let a2 = save(dir.path(), Some(&a.id), "Web+docs", &s(&["apps/web", "docs"]), 30).unwrap();
    assert_eq!((a2.id.as_str(), a2.created_at, a2.updated_at), (a.id.as_str(), 10, 30));
    assert_eq!(load(dir.path()).len(), 2);
    remove(dir.path(), &b.id).unwrap();
    assert_eq!(load(dir.path()), vec![a2]);
  }

  #[test]
  fn sparse_worktree_checks_out_only_the_folders() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    let git = |args: &[&str]| assert!(std::process::Command::new("git").arg("-C").arg(repo).args(args).output().unwrap().status.success(), "{args:?}");
    git(&["init", "-q", "-b", "main"]);
    for f in ["apps/web/a.txt", "apps/api/b.txt", "docs/c.txt"] {
      let p = repo.join(f);
      std::fs::create_dir_all(p.parent().unwrap()).unwrap();
      std::fs::write(p, "x").unwrap();
    }
    std::fs::write(repo.join("README.md"), "r").unwrap();
    git(&["add", "."]);
    git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
    let w = crate::agent::worktree::create_named_sparse(repo, "web-only", None, None, None, &s(&["apps/web"])).unwrap();
    let wt = Path::new(&w.path);
    assert!(wt.join("apps/web/a.txt").exists());
    assert!(wt.join("README.md").exists(), "cone mode keeps top-level files");
    assert!(!wt.join("apps/api/b.txt").exists());
    assert!(!wt.join("docs/c.txt").exists());
    // A bad folder list is refused before anything is made.
    assert!(crate::agent::worktree::create_named_sparse(repo, "bad", None, None, None, &s(&["../x"])).is_err());
    assert!(!crate::agent::worktree::worktree_path(repo, "bad").exists());
  }
}
