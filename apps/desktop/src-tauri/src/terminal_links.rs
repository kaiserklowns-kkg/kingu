//! Terminal file links: a path printed in a terminal (`src/main.rs`, `./a.ts`, `/abs/b.go`,
//! `~/x`) becomes a link only when it names a file of the open folder. Relative paths resolve
//! against the shell's current directory (after a `cd`), then the directory it started in, like
//! VS Code's local link detector resolving against the terminal's cwd.

use std::path::{Component, Path, PathBuf};

use tauri::State;

use crate::pty::Ptys;
use crate::workspace::Workspace;

/// A link's file, as the editors key it: relative to the open folder with `/` separators.
#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
pub struct LinkTarget {
  pub rel: String,
}

/// Longest text tried as a path: anything longer is not a file name someone printed.
const MAX_LINK: usize = 1024;

/// Resolves `text` to a file inside `root` (canonical), trying each of `bases` for a relative path.
pub fn link_target(text: &str, bases: &[PathBuf], home: Option<&Path>, root: &Path) -> Option<LinkTarget> {
  let text = text.trim();
  if text.is_empty() || text.len() > MAX_LINK || text.contains('\0') {
    return None;
  }
  let candidates: Vec<PathBuf> = if let Some(rest) = text.strip_prefix("~/") {
    vec![home?.join(rest)]
  } else if Path::new(text).is_absolute() {
    vec![PathBuf::from(text)]
  } else {
    bases.iter().filter(|b| b.is_absolute()).map(|b| b.join(text)).collect()
  };
  candidates.into_iter().find_map(|p| inside(&p, root))
}

/// `path` as a workspace-relative file key when it is an existing file under `root`.
fn inside(path: &Path, root: &Path) -> Option<LinkTarget> {
  let real = path.canonicalize().ok()?;
  if !real.is_file() {
    return None;
  }
  let rel = real.strip_prefix(root).ok()?;
  let parts: Option<Vec<&str>> = rel.components().map(|c| if let Component::Normal(s) = c { s.to_str() } else { None }).collect();
  let parts = parts.filter(|p| !p.is_empty())?;
  Some(LinkTarget { rel: parts.join("/") })
}

/// The file a terminal link names, or null when there is none (no link is drawn then).
/// `key`: the terminal's session, whose shell's current and starting directories are the bases.
#[tauri::command(async)]
pub fn terminal_link_target(ws: State<'_, Workspace>, ptys: State<'_, Ptys>, key: String, text: String) -> Result<Option<LinkTarget>, String> {
  let Some(root) = ws.current() else { return Ok(None) };
  let session = ptys.list().unwrap_or_default().into_iter().find(|s| s.key == key);
  let mut bases = Vec::new();
  if let Some(s) = &session {
    if let Some(cwd) = s.pid.and_then(kingu_ptyd::procinfo::process_cwd) {
      bases.push(cwd);
    }
    bases.push(PathBuf::from(&s.cwd));
  }
  bases.push(root.clone());
  let home = std::env::var_os("HOME").map(PathBuf::from);
  Ok(link_target(&text, &bases, home.as_deref(), &root))
}

/// A web link clicked in a terminal: the default browser opens it.
#[tauri::command]
pub fn terminal_open_url(url: String) -> Result<(), String> {
  crate::system::open_web_url(&url)
}

#[cfg(test)]
mod tests {
  use std::fs;

  use super::{LinkTarget, link_target};

  #[test]
  fn resolves_relative_absolute_and_home_paths_inside_the_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let wt = root.join(".kingu/worktrees/fix");
    fs::create_dir_all(wt.join("src")).unwrap();
    fs::write(wt.join("src/main.rs"), "fn main() {}").unwrap();
    fs::create_dir_all(root.join("เอกสาร")).unwrap();
    fs::write(root.join("เอกสาร/บันทึก.md"), "x").unwrap();
    let rel = |s: &str| Some(LinkTarget { rel: s.into() });

    // Relative to the worktree terminal's directory, then the folder root.
    let bases = [wt.clone(), root.clone()];
    assert_eq!(link_target("src/main.rs", &bases, None, &root), rel(".kingu/worktrees/fix/src/main.rs"));
    assert_eq!(link_target("./src/main.rs", &bases, None, &root), rel(".kingu/worktrees/fix/src/main.rs"));
    assert_eq!(link_target("เอกสาร/บันทึก.md", &bases, None, &root), rel("เอกสาร/บันทึก.md"));
    // Absolute and `~/`.
    assert_eq!(link_target(wt.join("src/main.rs").to_str().unwrap(), &[], None, &root), rel(".kingu/worktrees/fix/src/main.rs"));
    assert_eq!(link_target("~/src/main.rs", &[], Some(&wt), &root), rel(".kingu/worktrees/fix/src/main.rs"));
  }

  #[test]
  fn refuses_missing_files_folders_and_paths_outside_the_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let root = base.join("repo");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(base.join("outside.txt"), "x").unwrap();
    let bases = [root.clone()];
    assert_eq!(link_target("src/missing.rs", &bases, None, &root), None);
    assert_eq!(link_target("src", &bases, None, &root), None);
    assert_eq!(link_target("../outside.txt", &bases, None, &root), None);
    assert_eq!(link_target(base.join("outside.txt").to_str().unwrap(), &bases, None, &root), None);
    assert_eq!(link_target("~/x", &bases, None, &root), None);
    assert_eq!(link_target("", &bases, None, &root), None);
    assert_eq!(link_target(&"a/".repeat(600), &bases, None, &root), None);
  }
}
