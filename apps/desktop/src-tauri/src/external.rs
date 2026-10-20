//! Files outside the open folder (VS Code's File: Open File… opens any file). Every other file
//! command resolves webview paths inside the workspace root; these take an absolute path, but
//! only one the user picked in the native Open File dialog shown here (so the webview cannot
//! name an arbitrary file). The picked paths are remembered in the app data dir, so external
//! tabs restore after a restart and File: Open Recent can list them.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

use crate::i18n::msg::WorkspaceMsg;
use crate::textfile;
use crate::tr;

/// External files remembered (most recent first); older ones need Open File again.
pub const MAX_REMEMBERED: usize = 100;
/// A `.code-workspace` file is JSON with a folder list and settings; anything larger is not one.
const MAX_WORKSPACE_FILE: u64 = 1024 * 1024;

#[derive(Default)]
struct Inner {
  file: Option<PathBuf>,
  paths: Vec<PathBuf>,
}

#[derive(Default)]
pub struct ExternalFiles(Mutex<Inner>);

impl ExternalFiles {
  /// Reads the remembered paths from `file` (missing or unreadable: none).
  pub fn load(file: PathBuf) -> Self {
    let paths = std::fs::read_to_string(&file)
      .ok()
      .and_then(|t| serde_json::from_str::<Vec<PathBuf>>(&t).ok())
      .unwrap_or_default()
      .into_iter()
      .filter(|p| p.is_absolute())
      .take(MAX_REMEMBERED)
      .collect();
    Self(Mutex::new(Inner { file: Some(file), paths }))
  }

  fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
    self.0.lock().unwrap_or_else(|e| e.into_inner())
  }

  /// Remembers a path the user picked (canonical when it exists), most recent first.
  pub fn allow(&self, path: &Path) -> PathBuf {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut inner = self.inner();
    inner.paths.retain(|p| p != &path);
    inner.paths.insert(0, path.clone());
    inner.paths.truncate(MAX_REMEMBERED);
    save(&inner);
    path
  }

  /// `path` if the user picked it (a file deleted since keeps its picked path, so saving recreates it).
  pub fn check(&self, path: &str) -> Result<PathBuf, String> {
    let given = Path::new(path);
    let real = given.canonicalize().unwrap_or_else(|_| given.to_path_buf());
    let inner = self.inner();
    if given.is_absolute() && inner.paths.iter().any(|p| p == &real || p == given) {
      Ok(real)
    } else {
      Err(tr!(WorkspaceMsg::ExternalNotOpened, path))
    }
  }

  pub fn list(&self) -> Vec<String> {
    self.inner().paths.iter().map(|p| p.display().to_string()).collect()
  }

  pub fn forget(&self, path: &str) {
    let mut inner = self.inner();
    inner.paths.retain(|p| p != Path::new(path));
    save(&inner);
  }

  pub fn clear(&self) {
    let mut inner = self.inner();
    inner.paths.clear();
    save(&inner);
  }
}

fn save(inner: &Inner) {
  let Some(file) = &inner.file else { return };
  if let Some(dir) = file.parent() {
    let _ = std::fs::create_dir_all(dir);
  }
  if let Ok(text) = serde_json::to_string(&inner.paths)
    && let Err(e) = std::fs::write(file, text)
  {
    log::warn!("external files: {}: {e}", file.display());
  }
}


/// File: Open File… — the native picker, starting in `dir` (else the open folder or home).
/// `workspace`: only `.code-workspace` files (File: Open Workspace from File…). Returns the picked
/// paths, now allowed for the other commands here.
#[tauri::command]
pub async fn external_pick_files(
  app: AppHandle,
  ws: crate::workspace::Workspace,
  workspace: Option<bool>,
  title: Option<String>,
) -> Result<Vec<String>, String> {
  use tauri_plugin_dialog::DialogExt;
  let start = match ws.current() {
    Some(root) => root,
    None => app.path().home_dir().map_err(|e| e.to_string())?,
  };
  let workspace = workspace.unwrap_or(false);
  let handle = app.clone();
  let picked = tauri::async_runtime::spawn_blocking(move || {
    let mut dialog = handle.dialog().file().set_directory(start);
    if let Some(title) = title {
      dialog = dialog.set_title(title);
    }
    if workspace {
      dialog.add_filter("Code Workspace", &["code-workspace"]).blocking_pick_file().map(|p| vec![p])
    } else {
      dialog.blocking_pick_files()
    }
  })
  .await
  .map_err(|e| e.to_string())?;
  let files = app.state::<ExternalFiles>();
  Ok(picked.unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).map(|p| files.allow(&p).display().to_string()).collect())
}

/// External files remembered, most recent first (File: Open Recent).
#[tauri::command]
pub fn external_recent(files: State<'_, ExternalFiles>) -> Vec<String> {
  files.list()
}

#[tauri::command]
pub fn external_forget(files: State<'_, ExternalFiles>, path: String) {
  files.forget(&path);
}

#[tauri::command]
pub fn external_clear(files: State<'_, ExternalFiles>) {
  files.clear();
}

/// `textfile_read` for a picked file.
#[tauri::command]
pub async fn external_textfile_read(files: State<'_, ExternalFiles>, path: String, options: textfile::ReadOptions) -> Result<textfile::ReadResult, String> {
  let file = files.check(&path)?;
  crate::blocking(move || textfile::read(&file, &options).map_err(|e| format!("{path}: {e}"))).await
}

/// `textfile_write` for a picked file (refuses a folder; a deleted file is created again).
#[tauri::command]
pub async fn external_textfile_write(
  files: State<'_, ExternalFiles>,
  path: String,
  content: String,
  encoding: String,
  expected: Option<textfile::Expected>,
) -> Result<textfile::WriteResult, String> {
  let file = files.check(&path)?;
  crate::blocking(move || {
    if file.is_dir() {
      return Err(tr!(crate::i18n::msg::FilesMsg::IsADirectory, path));
    }
    let result = textfile::write(&file, &content, &encoding, expected.as_ref()).map_err(|e| format!("{path}: {e}"))?;
    if matches!(result, textfile::WriteResult::Saved { .. }) {
      log::info!("saved external file {} ({encoding})", file.display());
    }
    Ok(result)
  })
  .await
}

/// The text of a picked `.code-workspace` file (File: Open Workspace from File…).
#[tauri::command]
pub fn workspace_file_read(files: State<'_, ExternalFiles>, path: String) -> Result<String, String> {
  let file = files.check(&path)?;
  read_workspace_file(&file)
}

pub fn read_workspace_file(file: &Path) -> Result<String, String> {
  let size = std::fs::metadata(file).map_err(|e| format!("{}: {e}", file.display()))?.len();
  if size > MAX_WORKSPACE_FILE {
    return Err(tr!(WorkspaceMsg::WorkspaceFileTooLarge, path = file.display()));
  }
  std::fs::read_to_string(file).map_err(|e| format!("{}: {e}", file.display()))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_picked_files_pass_and_the_list_persists() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("data/external-files.json");
    let a = dir.path().join("a.txt");
    let b = dir.path().join("b.txt");
    std::fs::write(&a, "a").unwrap();
    std::fs::write(&b, "b").unwrap();
    let files = ExternalFiles::load(state.clone());
    assert!(files.check(a.to_str().unwrap()).is_err());
    let real = files.allow(&a);
    assert_eq!(files.check(a.to_str().unwrap()).unwrap(), real);
    assert!(files.check(b.to_str().unwrap()).is_err());
    // A relative path or `..` tricks never name an allowed file.
    assert!(files.check("a.txt").is_err());
    let again = ExternalFiles::load(state);
    assert_eq!(again.list(), vec![real.display().to_string()]);
    again.forget(&real.display().to_string());
    assert!(again.check(a.to_str().unwrap()).is_err());
  }

  #[test]
  fn most_recent_first_and_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let files = ExternalFiles::load(dir.path().join("x.json"));
    for i in 0..(MAX_REMEMBERED + 5) {
      files.allow(&dir.path().join(format!("f{i}")));
    }
    let list = files.list();
    assert_eq!(list.len(), MAX_REMEMBERED);
    assert!(list[0].ends_with(&format!("f{}", MAX_REMEMBERED + 4)));
    files.allow(&dir.path().join("f10"));
    assert!(files.list()[0].ends_with("f10"));
    assert_eq!(files.list().len(), MAX_REMEMBERED);
  }

  #[test]
  fn a_deleted_picked_file_can_be_saved_again() {
    let dir = tempfile::tempdir().unwrap();
    let files = ExternalFiles::load(dir.path().join("x.json"));
    let a = dir.path().canonicalize().unwrap().join("gone.txt");
    std::fs::write(&a, "x").unwrap();
    files.allow(&a);
    std::fs::remove_file(&a).unwrap();
    assert_eq!(files.check(a.to_str().unwrap()).unwrap(), a);
  }

  #[test]
  fn workspace_files_have_a_size_limit() {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("w.code-workspace");
    std::fs::write(&f, "{\"folders\":[{\"path\":\".\"}]}").unwrap();
    assert!(read_workspace_file(&f).unwrap().contains("folders"));
    std::fs::write(&f, vec![b' '; (MAX_WORKSPACE_FILE + 1) as usize]).unwrap();
    assert!(read_workspace_file(&f).is_err());
  }
}
