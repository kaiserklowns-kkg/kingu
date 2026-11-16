//! Add Folder of Projects (Orca's `projectGroups:scanNested` / `:importNested`): find the git
//! repositories inside a folder and add them as projects in one group named after that folder.
//!
//! Orca's rules (`_l`, `gxe`, `_xe`, `Cxe`, `Txe` in out/main/index.js; MECHANICS.md):
//! - a picked folder that is itself a repository isn't scanned (`git_repo`);
//! - breadth first, children sorted by name, symlinks not followed;
//! - a folder holding `.git` (folder or file) is a repository and isn't looked into further;
//! - skipped: `node_modules .next dist build .cache vendor __pycache__ .turbo .parcel-cache`, VCS
//!   folders `.git .svn .hg .jj .sl .repo CVS`, dot folders below the first level, and folders a
//!   `.gitignore` on the way names (simple names only here: no wildcard patterns);
//! - limits: depth 3 (1–8), 100 repositories (1–500), time 15 s on import (500 ms–30 s).

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tauri::State;

use crate::projects::Projects;

/// Orca `fxe`, `pxe`: defaults; `gxe` clamps.
pub const DEFAULT_MAX_DEPTH: usize = 3;
pub const MAX_DEPTH_LIMIT: usize = 8;
pub const DEFAULT_MAX_REPOS: usize = 100;
pub const MAX_REPOS_LIMIT: usize = 500;
/// Orca's import uses `timeoutMs: 15e3`; `gxe` keeps any timeout within 500–30000 ms.
pub const IMPORT_TIMEOUT_MS: u64 = 15000;
pub const MIN_TIMEOUT_MS: u64 = 500;
pub const MAX_TIMEOUT_MS: u64 = 30000;

/// Orca `mxe`: build and dependency folders.
const HEAVY: [&str; 9] = ["node_modules", ".next", "dist", "build", ".cache", "vendor", "__pycache__", ".turbo", ".parcel-cache"];
/// Orca `hxe`: version-control folders.
const VCS: [&str; 7] = [".git", ".svn", ".hg", ".jj", ".sl", ".repo", "CVS"];

#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct FoundRepo {
  pub path: PathBuf,
  pub name: String,
  pub depth: usize,
}

#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct Scan {
  pub path: PathBuf,
  /// `git_repo` (the picked folder is a repository: nothing scanned) or `non_git_folder`.
  pub kind: &'static str,
  pub repos: Vec<FoundRepo>,
  pub truncated: bool,
  pub timed_out: bool,
  pub max_depth: usize,
  pub max_repos: usize,
}

/// Orca `_xe(name, depthIndex)`: VCS and heavy folders always, dot folders below the first level.
pub fn skipped(name: &str, depth_index: usize) -> bool {
  VCS.contains(&name) || HEAVY.contains(&name) || (depth_index > 0 && name.starts_with('.'))
}

fn has_git_marker(dir: &Path) -> bool {
  let git = dir.join(".git");
  git.is_dir() || git.is_file()
}

/// Plain names a `.gitignore` lists (`name`, `name/`, `/name`), skipping comments, negations and
/// patterns with wildcards or inner slashes.
fn ignored_names(dir: &Path) -> Vec<String> {
  let Ok(text) = std::fs::read_to_string(dir.join(".gitignore")) else { return Vec::new() };
  text
    .lines()
    .map(str::trim)
    .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with('!'))
    .map(|l| l.trim_start_matches('/').trim_end_matches('/'))
    .filter(|l| !l.is_empty() && !l.contains(['*', '?', '[', '/']))
    .map(str::to_string)
    .collect()
}

pub fn scan(root: &Path, max_depth: Option<usize>, max_repos: Option<usize>, timeout_ms: Option<u64>) -> Scan {
  let max_depth = max_depth.unwrap_or(DEFAULT_MAX_DEPTH).clamp(1, MAX_DEPTH_LIMIT);
  let max_repos = max_repos.unwrap_or(DEFAULT_MAX_REPOS).clamp(1, MAX_REPOS_LIMIT);
  let deadline = timeout_ms.map(|t| Instant::now() + Duration::from_millis(t.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)));
  let mut out = Scan { path: root.to_path_buf(), kind: "non_git_folder", repos: Vec::new(), truncated: false, timed_out: false, max_depth, max_repos };
  if has_git_marker(root) {
    out.kind = "git_repo";
    return out;
  }
  // (folder, depth, names its .gitignore files on the way rule out)
  let mut queue = VecDeque::from([(root.to_path_buf(), 0usize, Vec::<String>::new())]);
  'outer: while let Some((dir, depth, inherited)) = queue.pop_front() {
    if depth > max_depth {
      continue;
    }
    let Ok(entries) = std::fs::read_dir(&dir) else { continue };
    let mut ignore = inherited.clone();
    ignore.extend(ignored_names(&dir));
    let mut children: Vec<(String, PathBuf)> = entries
      .flatten()
      .filter(|e| e.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink()))
      .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
      .collect();
    children.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, path) in children {
      if out.repos.len() >= max_repos {
        out.truncated = true;
        break 'outer;
      }
      if deadline.is_some_and(|d| Instant::now() > d) {
        out.timed_out = true;
        break 'outer;
      }
      if skipped(&name, depth) || ignore.contains(&name) {
        continue;
      }
      if has_git_marker(&path) {
        out.repos.push(FoundRepo { path, name, depth: depth + 1 });
      } else if depth < max_depth {
        queue.push_back((path, depth + 1, ignore.clone()));
      }
    }
  }
  out
}

#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct Imported {
  pub group: Option<crate::projects::ProjectGroup>,
  pub imported: usize,
  pub already_known: usize,
  pub failed: Vec<(PathBuf, String)>,
}

/// Orca's `importNested` in `group` mode: one group (named `name`, else the folder's name), each
/// picked repository added in scan order (already added ones just move into it); the group is
/// taken away again when nothing landed in it. Only repositories the scan found are accepted.
pub fn import(projects: &Projects, parent: &Path, name: &str, picked: &[PathBuf]) -> Result<Imported, String> {
  let found = scan(parent, None, None, Some(IMPORT_TIMEOUT_MS));
  let label = if name.trim().is_empty() { parent.file_name().map_or_else(|| parent.display().to_string(), |n| n.to_string_lossy().into_owned()) } else { name.to_string() };
  let group = projects.create_group(&label, Some(parent.to_path_buf()), None, "folder-scan")?;
  let known: Vec<PathBuf> = projects.list().into_iter().map(|p| p.path).collect();
  let mut out = Imported { group: None, imported: 0, already_known: 0, failed: Vec::new() };
  for (order, path) in picked.iter().enumerate() {
    if !found.repos.iter().any(|r| r.path == *path) {
      out.failed.push((path.clone(), "Not found in the scan of this folder".into()));
      continue;
    }
    match projects.add(path) {
      Ok(added) => {
        if added.existed || known.contains(&added.project.path) {
          out.already_known += 1;
        } else {
          out.imported += 1;
        }
        projects.set_group(&added.project.path, Some(&group.id), Some(order as f64))?;
      }
      Err(e) => out.failed.push((path.clone(), e)),
    }
  }
  if out.imported + out.already_known == 0 {
    projects.delete_group(&group.id)?;
  } else {
    out.group = projects.groups().into_iter().find(|g| g.id == group.id);
  }
  Ok(out)
}

#[tauri::command]
pub async fn project_groups_scan_nested(path: String, max_depth: Option<usize>, max_repos: Option<usize>) -> Result<Scan, String> {
  let root = Path::new(&path).canonicalize().map_err(|e| format!("{path}: {e}"))?;
  tauri::async_runtime::spawn_blocking(move || scan(&root, max_depth, max_repos, Some(MAX_TIMEOUT_MS))).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn project_groups_import_nested(projects: State<'_, Projects>, parent: String, name: String, paths: Vec<String>) -> Result<Imported, String> {
  let parent = Path::new(&parent).canonicalize().map_err(|e| format!("{parent}: {e}"))?;
  let picked: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
  let out = import(&projects, &parent, &name, &picked)?;
  log::info!("project group from {}: {} added, {} already there, {} failed", parent.display(), out.imported, out.already_known, out.failed.len());
  Ok(out)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn repo(p: &Path) {
    std::fs::create_dir_all(p.join(".git")).unwrap();
  }

  #[test]
  fn skip_rule() {
    assert!(skipped("node_modules", 0));
    assert!(skipped(".git", 0));
    assert!(!skipped(".config", 0));
    assert!(skipped(".config", 1));
    assert!(!skipped("apps", 3));
  }

  #[test]
  fn finds_repositories_with_orcas_limits() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().canonicalize().unwrap();
    repo(&root.join("b-api"));
    repo(&root.join("a-web"));
    repo(&root.join("a-web/nested")); // inside a repository: not looked into
    repo(&root.join("group/one"));
    repo(&root.join("node_modules/pkg"));
    repo(&root.join("ignored/x"));
    repo(&root.join(".hidden"));
    repo(&root.join("deep/l2/.dot/r"));
    repo(&root.join("l1/l2/l3/l4/too-deep"));
    std::fs::write(root.join(".gitignore"), "# comment\n/ignored/\n*.log\n").unwrap();
    let s = scan(&root, None, None, None);
    assert_eq!(s.kind, "non_git_folder");
    let names: Vec<_> = s.repos.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, vec![".hidden", "a-web", "b-api", "one"]);
    assert_eq!(s.repos[3].depth, 2);
    assert!(!s.truncated);
    let s = scan(&root, Some(1), Some(2), None);
    assert_eq!(s.repos.len(), 2);
    assert!(s.truncated);
    assert_eq!(scan(&root.join("a-web"), None, None, None).kind, "git_repo");
    // Depth 0 means "at least 1", depth 99 means 8.
    assert_eq!(scan(&root, Some(0), None, None).max_depth, 1);
    assert_eq!(scan(&root, Some(99), Some(9999), None).max_repos, MAX_REPOS_LIMIT);
  }

  #[test]
  fn imports_into_one_group_and_drops_an_empty_one() {
    let (data, d) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let root = d.path().canonicalize().unwrap();
    repo(&root.join("web"));
    repo(&root.join("api"));
    let projects = Projects::load(data.path().join("projects.json"));
    projects.add(&root.join("api")).unwrap();
    let r = import(&projects, &root, "", &[root.join("api"), root.join("web"), root.join("nope")]).unwrap();
    assert_eq!((r.imported, r.already_known, r.failed.len()), (1, 1, 1));
    let g = r.group.unwrap();
    assert_eq!(g.name, root.file_name().unwrap().to_string_lossy());
    assert_eq!(g.created_from, "folder-scan");
    assert!(projects.list().iter().all(|p| p.group.as_deref() == Some(g.id.as_str())));
    let none = import(&projects, &root, "Empty", &[root.join("nope")]).unwrap();
    assert!(none.group.is_none());
    assert_eq!(projects.groups().len(), 1);
  }
}
