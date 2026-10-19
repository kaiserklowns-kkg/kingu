//! The open folder (VS Code: IWorkspaceContextService) and the recently opened folders
//! (VS Code: IWorkspacesHistoryMainService). The root can change at runtime ("Open Folder"),
//! so commands read it once with [`Workspace::root`] and resolve every webview path against
//! that copy with [`resolve_in`].

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

use crate::i18n::msg::FilesMsg;
use crate::tr;

#[derive(Default)]
pub struct Workspace {
  root: RwLock<Option<PathBuf>>,
}

impl Workspace {
  #[cfg(test)]
  pub fn new(root: Option<PathBuf>) -> Self {
    Self { root: RwLock::new(root) }
  }

  /// The current root, `None` when no folder is open (the Explorer shows its welcome view).
  pub fn current(&self) -> Option<PathBuf> {
    self.root.read().unwrap_or_else(|e| e.into_inner()).clone()
  }

  /// The current root, or an error for commands that need a folder.
  pub fn root(&self) -> Result<PathBuf, String> {
    self.current().ok_or_else(|| tr!(FilesMsg::NoFolder))
  }

  /// Makes `dir` (canonicalized, must be a directory) the root and returns it.
  pub fn open(&self, dir: &Path) -> Result<PathBuf, String> {
    let root = canonical_dir(dir)?;
    *self.root.write().unwrap_or_else(|e| e.into_inner()) = Some(root.clone());
    Ok(root)
  }

  pub fn close(&self) {
    *self.root.write().unwrap_or_else(|e| e.into_inner()) = None;
  }

  /// Resolves `rel` inside the current root (see [`resolve_in`]).
  #[cfg(test)]
  pub fn resolve(&self, rel: &str) -> Result<PathBuf, String> {
    resolve_in(&self.root()?, rel)
  }
}

pub fn canonical_dir(dir: &Path) -> Result<PathBuf, String> {
  let root = dir.canonicalize().map_err(|e| format!("{}: {e}", dir.display()))?;
  if !root.is_dir() {
    return Err(tr!(FilesMsg::NotAFolder, path = dir.display()));
  }
  Ok(root)
}

/// Resolves `rel` inside `root`, rejecting anything that escapes it (`..`, symlinks out).
/// The path must exist.
pub fn resolve_in(root: &Path, rel: &str) -> Result<PathBuf, String> {
  let path = root.join(rel).canonicalize().map_err(|e| format!("{rel}: {e}"))?;
  if !path.starts_with(root) {
    return Err(tr!(FilesMsg::OutsideWorkspace, path = rel));
  }
  Ok(path)
}

/// The folder to open at startup: the last one if it still exists, else `KINGU_WORKSPACE`,
/// else none (welcome view).
pub fn startup_root(last: Option<&Path>, env: Option<OsString>) -> Option<PathBuf> {
  last
    .map(Path::to_path_buf)
    .into_iter()
    .chain(env.map(PathBuf::from))
    .find_map(|p| canonical_dir(&p).ok())
}

// ---------------------------------------------------------------------------------------------
// Recently opened folders

/// VS Code keeps more, but the quick pick only needs a screenful.
pub const MAX_RECENT: usize = 20;

#[derive(serde::Serialize, serde::Deserialize, Default, Debug, Clone, PartialEq)]
pub struct RecentData {
  /// Most recent first.
  #[serde(default)]
  pub folders: Vec<PathBuf>,
  /// The folder open when the app last ran; `None` after "Close Folder".
  #[serde(default)]
  pub last: Option<PathBuf>,
}

/// `recent.json` in the app data directory. A missing or corrupt file reads as empty;
/// writes go through a temporary file so a crash never leaves half a file.
pub struct Recent {
  file: PathBuf,
  data: Mutex<RecentData>,
}

impl Recent {
  pub fn load(file: PathBuf) -> Self {
    let data = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    Self { file, data: Mutex::new(data) }
  }

  pub fn data(&self) -> RecentData {
    self.data.lock().unwrap_or_else(|e| e.into_inner()).clone()
  }

  /// Moves `dir` to the front and remembers it as the folder to reopen.
  pub fn opened(&self, dir: &Path) -> Result<(), String> {
    self.update(|d| {
      d.folders.retain(|f| f != dir);
      d.folders.insert(0, dir.to_path_buf());
      d.folders.truncate(MAX_RECENT);
      d.last = Some(dir.to_path_buf());
    })
  }

  pub fn closed(&self) -> Result<(), String> {
    self.update(|d| d.last = None)
  }

  pub fn remove(&self, dir: &Path) -> Result<(), String> {
    self.update(|d| d.folders.retain(|f| f != dir))
  }

  pub fn clear(&self) -> Result<(), String> {
    self.update(|d| d.folders.clear())
  }

  fn update(&self, f: impl FnOnce(&mut RecentData)) -> Result<(), String> {
    let mut data = self.data.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut data);
    let json = serde_json::to_vec_pretty(&*data).map_err(|e| e.to_string())?;
    if let Some(dir) = self.file.parent() {
      std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let tmp = self.file.with_extension("json.tmp");
    std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, &self.file)).map_err(|e| format!("{}: {e}", self.file.display()))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn rejects_paths_outside_the_workspace() {
    let ws = Workspace::new(Some(std::env::current_dir().unwrap().canonicalize().unwrap()));
    assert!(ws.resolve("Cargo.toml").is_ok());
    // Enough `..` to reach `/` however deep the checkout is (e.g. inside a git worktree).
    let escape = format!("{}etc/hosts", "../".repeat(64));
    assert!(ws.resolve(&escape).unwrap_err().contains("outside"));
  }

  #[test]
  fn switching_the_root_moves_every_resolve() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    std::fs::write(a.path().join("only-a.txt"), "").unwrap();
    std::fs::write(b.path().join("only-b.txt"), "").unwrap();
    let ws = Workspace::default();
    assert_eq!(ws.root().unwrap_err(), tr!(FilesMsg::NoFolder));
    assert!(ws.resolve("only-a.txt").is_err());

    let root_a = ws.open(a.path()).unwrap();
    assert_eq!(root_a, a.path().canonicalize().unwrap());
    assert!(ws.resolve("only-a.txt").is_ok());

    ws.open(b.path()).unwrap();
    assert!(ws.resolve("only-a.txt").is_err());
    assert!(ws.resolve("only-b.txt").unwrap().starts_with(b.path().canonicalize().unwrap()));
    // The old root is now outside the workspace.
    assert!(resolve_in(&ws.root().unwrap(), root_a.join("only-a.txt").to_str().unwrap()).is_err());

    ws.close();
    assert!(ws.current().is_none());
    assert!(ws.resolve("only-b.txt").is_err());
  }

  #[test]
  fn opening_a_file_or_missing_folder_keeps_the_root() {
    let a = tempfile::tempdir().unwrap();
    std::fs::write(a.path().join("f.txt"), "").unwrap();
    let ws = Workspace::default();
    ws.open(a.path()).unwrap();
    assert!(ws.open(&a.path().join("f.txt")).unwrap_err().contains("not a folder"));
    assert!(ws.open(&a.path().join("missing")).is_err());
    assert_eq!(ws.current().unwrap(), a.path().canonicalize().unwrap());
  }

  #[test]
  fn startup_prefers_last_then_env() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let gone = a.path().join("gone");
    let canon = |p: &Path| p.canonicalize().unwrap();
    assert_eq!(startup_root(Some(a.path()), Some(b.path().into())), Some(canon(a.path())));
    assert_eq!(startup_root(Some(&gone), Some(b.path().into())), Some(canon(b.path())));
    assert_eq!(startup_root(None, Some(gone.clone().into())), None);
    assert_eq!(startup_root(None, None), None);
  }

  #[test]
  fn recent_folders_are_most_recent_first_deduped_and_capped() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("data/recent.json");
    let recent = Recent::load(file.clone());
    assert_eq!(recent.data(), RecentData::default());

    for i in 0..MAX_RECENT + 5 {
      recent.opened(Path::new(&format!("/p/{i}"))).unwrap();
    }
    recent.opened(Path::new("/p/10")).unwrap();
    let d = recent.data();
    assert_eq!(d.folders.len(), MAX_RECENT);
    assert_eq!(d.folders[0], Path::new("/p/10"));
    assert_eq!(d.folders.iter().filter(|f| *f == Path::new("/p/10")).count(), 1);
    assert_eq!(d.last.as_deref(), Some(Path::new("/p/10")));

    recent.remove(Path::new("/p/10")).unwrap();
    recent.closed().unwrap();
    // Survives a restart.
    let again = Recent::load(file.clone()).data();
    assert_eq!(again, recent.data());
    assert!(!again.folders.contains(&PathBuf::from("/p/10")));
    assert_eq!(again.last, None);

    recent.clear().unwrap();
    assert!(Recent::load(file).data().folders.is_empty());
  }

  #[test]
  fn corrupt_recent_file_reads_as_empty() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("recent.json");
    std::fs::write(&file, "{not json").unwrap();
    let recent = Recent::load(file.clone());
    assert_eq!(recent.data(), RecentData::default());
    recent.opened(Path::new("/x")).unwrap();
    assert_eq!(Recent::load(file).data().folders, [PathBuf::from("/x")]);
  }
}
