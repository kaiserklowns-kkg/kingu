//! Workspace file system for the Explorer and quick open. Callers pass paths already
//! resolved inside the workspace; this module never accepts a path from the webview directly.

use std::path::Path;

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct DirEntry {
  pub name: String,
  /// Path relative to the workspace root, `/`-separated.
  pub rel: String,
  pub is_dir: bool,
  /// Matched by `.gitignore` (shown dimmed, like Orca and VS Code). Filled in by `git::mark_ignored`.
  pub ignored: bool,
  /// A folder git does not track at all (Orca shows it with `U`). Filled in by `git::mark_ignored`.
  pub untracked: bool,
}

/// Directories the Explorer hides and quick open never walks (VS Code's `files.exclude` defaults
/// plus build outputs that would drown the file list).
const HIDDEN: &[&str] = &[".git", ".DS_Store"];
const NOT_WALKED: &[&str] = &[".git", "node_modules", "target", ".svelte-kit", "build", ".kingu", ".claude"];

fn rel_of(root: &Path, path: &Path) -> String {
  path
    .strip_prefix(root)
    .unwrap_or(path)
    .components()
    .map(|c| c.as_os_str().to_string_lossy())
    .collect::<Vec<_>>()
    .join("/")
}

/// One directory level, folders first, then case-insensitive by name (Explorer's default order).
pub fn list_dir(root: &Path, dir: &Path) -> Result<Vec<DirEntry>, String> {
  let mut entries = Vec::new();
  for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
    let entry = entry.map_err(|e| e.to_string())?;
    let name = entry.file_name().to_string_lossy().into_owned();
    if HIDDEN.contains(&name.as_str()) {
      continue;
    }
    // Follows symlinks for the kind, but a dangling link still lists as a file.
    let is_dir = entry.path().is_dir();
    entries.push(DirEntry { rel: rel_of(root, &entry.path()), name, is_dir, ignored: false, untracked: false });
  }
  entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
  Ok(entries)
}

/// Every file under `root` for quick open, skipping `NOT_WALKED` and symlinked directories,
/// capped at `limit` paths.
pub fn list_files(root: &Path, limit: usize) -> Vec<String> {
  let mut out = Vec::new();
  let mut stack = vec![root.to_path_buf()];
  while let Some(dir) = stack.pop() {
    let Ok(read) = std::fs::read_dir(&dir) else { continue };
    for entry in read.flatten() {
      let name = entry.file_name();
      let name = name.to_string_lossy();
      let Ok(kind) = entry.file_type() else { continue };
      if kind.is_dir() {
        if !NOT_WALKED.contains(&name.as_ref()) {
          stack.push(entry.path());
        }
      } else if kind.is_file() {
        out.push(rel_of(root, &entry.path()));
        if out.len() >= limit {
          return out;
        }
      }
    }
  }
  out.sort();
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn lists_folders_first_and_hides_git() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::create_dir(root.join(".git")).unwrap();
    std::fs::create_dir(root.join("src")).unwrap();
    std::fs::write(root.join("b.txt"), "").unwrap();
    std::fs::write(root.join("A.md"), "").unwrap();
    let names: Vec<_> = list_dir(root, root).unwrap().into_iter().map(|e| e.name).collect();
    assert_eq!(names, ["src", "A.md", "b.txt"]);
  }

  #[test]
  fn walks_files_but_skips_build_dirs() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::create_dir_all(root.join("src/lib")).unwrap();
    std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
    std::fs::write(root.join("src/lib/a.ts"), "").unwrap();
    std::fs::write(root.join("node_modules/x/i.js"), "").unwrap();
    assert_eq!(list_files(root, 100), ["src/lib/a.ts"]);
    assert_eq!(list_files(root, 1).len(), 1);
  }
}
