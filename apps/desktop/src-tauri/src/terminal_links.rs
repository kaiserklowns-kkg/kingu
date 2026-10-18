//! Terminal file links: a path printed in a terminal (`src/main.rs`, `./a.ts`, `/abs/b.go`,
//! `~/x`) becomes a link only when it names a file of the open folder. Relative paths resolve
//! against the shell's current directory (after a `cd`), then the directory it started in, like
//! VS Code's local link detector resolving against the terminal's cwd.

use std::path::{Component, Path, PathBuf};

use tauri::State;

use crate::pty::Ptys;
use crate::workspace::Workspace;
use crate::i18n::msg::CoreMsg;
use crate::tr;

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

/// The scheme of a terminal link, when `terminal.integrated.allowedLinkSchemes` lets it open.
/// Web links go to the browser; other allowed schemes (`mailto:`…) to the system handler. `file`
/// links are opened in the editor by the page, and script-like schemes never open.
pub fn openable_scheme(url: &str, allowed: Option<&[String]>) -> Result<String, String> {
  let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
  let scheme = parsed.scheme().to_ascii_lowercase();
  if let Some(allowed) = allowed
    && !allowed.iter().any(|s| s.eq_ignore_ascii_case(&scheme))
  {
    return Err(tr!(CoreMsg::SchemeNotAllowed, scheme));
  }
  if matches!(scheme.as_str(), "file" | "javascript" | "data" | "vbscript") {
    return Err(tr!(CoreMsg::SchemeBlocked, scheme));
  }
  if allowed.is_none() && !matches!(scheme.as_str(), "http" | "https") {
    return Err(tr!(CoreMsg::HttpOnly, scheme));
  }
  Ok(scheme)
}

/// A link clicked in a terminal: web links open in the default browser, other schemes the user
/// allowed (`allowed`: terminal.integrated.allowedLinkSchemes) in their system handler.
#[tauri::command]
pub fn terminal_open_url(url: String, allowed: Option<Vec<String>>) -> Result<(), String> {
  let scheme = openable_scheme(&url, allowed.as_deref())?;
  if scheme == "http" || scheme == "https" {
    return crate::system::open_web_url(&url);
  }
  let program = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
  std::process::Command::new(program).arg(&url).spawn().map(|_| ()).map_err(|e| format!("{program}: {e}"))
}

#[cfg(test)]
mod tests {
  use std::fs;

  use super::{LinkTarget, link_target, openable_scheme};

  #[test]
  fn allowed_link_schemes() {
    let allowed: Vec<String> = ["file", "http", "https", "mailto"].iter().map(|s| s.to_string()).collect();
    assert_eq!(openable_scheme("https://example.com", Some(&allowed)).unwrap(), "https");
    assert_eq!(openable_scheme("mailto:a@b.c", Some(&allowed)).unwrap(), "mailto");
    assert!(openable_scheme("ftp://x", Some(&allowed)).is_err());
    assert!(openable_scheme("file:///etc/passwd", Some(&allowed)).is_err());
    let js = vec!["javascript".to_string()];
    assert!(openable_scheme("javascript:alert(1)", Some(&js)).is_err());
    assert!(openable_scheme("http://x", Some(&[])).is_err());
    assert!(openable_scheme("mailto:a@b.c", None).is_err());
    assert_eq!(openable_scheme("http://x", None).unwrap(), "http");
  }

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
