//! Workspace file system for the Explorer and quick open. Callers pass paths already
//! resolved inside the workspace; this module never accepts a path from the webview directly.

use std::path::Path;

use crate::i18n::msg::FilesMsg;
use crate::tr;

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
  /// Last modification, ms since the Unix epoch (0 when unknown), for `explorer.sortOrder: modified`.
  pub modified: u64,
}

/// `path`'s modification time in ms since the epoch, following symlinks; 0 when unavailable.
pub fn modified_ms(path: &Path) -> u64 {
  std::fs::metadata(path)
    .and_then(|m| m.modified())
    .ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map_or(0, |d| d.as_millis() as u64)
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
    let path = entry.path();
    let is_dir = path.is_dir();
    entries.push(DirEntry { rel: rel_of(root, &path), name, is_dir, ignored: false, untracked: false, modified: modified_ms(&path) });
  }
  entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
  Ok(entries)
}

/// Image types the editor shows in its image viewer, by extension.
pub fn image_mime(path: &Path) -> Option<&'static str> {
  let ext = path.extension()?.to_str()?.to_ascii_lowercase();
  Some(match ext.as_str() {
    "png" => "image/png",
    "jpg" | "jpeg" => "image/jpeg",
    "gif" => "image/gif",
    "webp" => "image/webp",
    "svg" => "image/svg+xml",
    "ico" => "image/x-icon",
    "bmp" => "image/bmp",
    "avif" => "image/avif",
    _ => return None,
  })
}

/// An image as a `data:` URL for the image viewer (the CSP allows `img-src data:`).
pub fn image_data_url(path: &Path, max_bytes: u64) -> Result<String, String> {
  use base64::Engine;
  let mime = image_mime(path).ok_or_else(|| tr!(FilesMsg::NotAnImage))?;
  let len = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
  if len > max_bytes {
    return Err(tr!(FilesMsg::ImageTooLarge, mb = max_bytes / (1024 * 1024)));
  }
  let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
  Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
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
  fn lists_modification_times() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::write(root.join("old.txt"), "").unwrap();
    let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
    std::fs::File::options().write(true).open(root.join("old.txt")).unwrap().set_modified(old).unwrap();
    std::fs::write(root.join("new.txt"), "").unwrap();
    let entries = list_dir(root, root).unwrap();
    let by = |n: &str| entries.iter().find(|e| e.name == n).unwrap().modified;
    assert_eq!(by("old.txt"), 1_000_000_000);
    assert!(by("new.txt") > by("old.txt"));
    assert_eq!(modified_ms(&root.join("missing")), 0);
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

  #[test]
  fn images_become_data_urls() {
    let tmp = tempfile::tempdir().unwrap();
    let png = tmp.path().join("a.PNG");
    std::fs::write(&png, [0x89, b'P', b'N', b'G']).unwrap();
    assert_eq!(image_data_url(&png, 1024).unwrap(), "data:image/png;base64,iVBORw==");
    assert!(image_data_url(&png, 2).unwrap_err().contains("larger"));
    let txt = tmp.path().join("a.txt");
    std::fs::write(&txt, "x").unwrap();
    assert!(image_data_url(&txt, 1024).is_err());
  }
}
