//! The runtime file: where the running app listens and the token it expects. The app writes it
//! (owner-only, in an owner-only folder) when it starts listening; the command reads it and
//! refuses one another user could have written or read. `KINGU_CLI_RUNTIME` names the file
//! (Kingu's terminals set it); otherwise it is in the app's data folder.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Tauri's app identifier: the data folder's name.
pub const APP_IDENTIFIER: &str = "ai.anthov.kingu.studio";
/// The folder inside the app data folder holding the socket and the runtime file.
pub const DIR: &str = "cli";
pub const FILE: &str = "runtime.json";
pub const SOCKET: &str = "kingu.sock";
pub const ENV_RUNTIME: &str = "KINGU_CLI_RUNTIME";
/// The current runtime file layout.
pub const VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Runtime {
  pub version: u32,
  pub pid: u32,
  pub socket: String,
  pub token: String,
  pub app_version: String,
}

/// The app data folder as Tauri resolves it (`dirs::data_dir()/<identifier>`).
pub fn default_app_data(home: Option<&Path>, xdg_data: Option<&Path>, appdata: Option<&Path>) -> Option<PathBuf> {
  let base = if cfg!(target_os = "macos") {
    home.map(|h| h.join("Library/Application Support"))
  } else if cfg!(windows) {
    appdata.map(Path::to_path_buf)
  } else {
    xdg_data.filter(|d| d.is_absolute()).map(Path::to_path_buf).or_else(|| home.map(|h| h.join(".local/share")))
  };
  base.map(|b| b.join(APP_IDENTIFIER))
}

/// The runtime file: `KINGU_CLI_RUNTIME`, else `<app data>/cli/runtime.json`.
pub fn runtime_path() -> Option<PathBuf> {
  if let Some(p) = std::env::var_os(ENV_RUNTIME).filter(|p| !p.is_empty()) {
    return Some(PathBuf::from(p));
  }
  let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
  let xdg = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from);
  let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
  default_app_data(home.as_deref(), xdg.as_deref(), appdata.as_deref()).map(|d| d.join(DIR).join(FILE))
}

/// Reads and checks the runtime file. On Unix it must be a regular file of this user that
/// nobody else can read or write.
pub fn read(path: &Path) -> Result<Runtime, String> {
  #[cfg(unix)]
  check_private(path)?;
  let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
  let rt: Runtime = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
  if rt.version != VERSION {
    return Err(format!("{}: runtime file version {} (this kingu understands {VERSION}); update the kingu command", path.display(), rt.version));
  }
  if !crate::protocol::valid_token(&rt.token) || rt.socket.is_empty() {
    return Err(format!("{}: incomplete runtime file", path.display()));
  }
  Ok(rt)
}

#[cfg(unix)]
pub fn check_private(path: &Path) -> Result<(), String> {
  use std::os::unix::fs::MetadataExt;
  let meta = std::fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
  if !meta.file_type().is_file() {
    return Err(format!("{} is not a regular file", path.display()));
  }
  let uid = unsafe { libc::getuid() };
  if meta.uid() != uid {
    return Err(format!("{} belongs to uid {}, not this user; refusing it", path.display(), meta.uid()));
  }
  if meta.mode() & 0o077 != 0 {
    return Err(format!("{} is readable or writable by other users (mode {:o}); refusing it", path.display(), meta.mode() & 0o777));
  }
  Ok(())
}

/// Writes the runtime file owner-only, replacing the old one in one step.
pub fn write(path: &Path, rt: &Runtime) -> Result<(), String> {
  let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
  let mut opts = std::fs::OpenOptions::new();
  opts.write(true).create(true).truncate(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    opts.mode(0o600);
  }
  let text = serde_json::to_string_pretty(rt).map_err(|e| e.to_string())?;
  let written = opts.open(&tmp).and_then(|mut f| {
    use std::io::Write;
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      // An older temp file keeps its mode through `open`.
      f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    f.write_all(text.as_bytes())?;
    f.sync_all()
  });
  let done = written.and_then(|()| std::fs::rename(&tmp, path));
  if done.is_err() {
    let _ = std::fs::remove_file(&tmp);
  }
  done.map_err(|e| format!("{}: {e}", path.display()))
}

/// Removes the runtime file if it is still this process's (another app instance may own it now).
pub fn remove_if_ours(path: &Path, pid: u32) {
  let ours = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Runtime>(&t).ok()).is_some_and(|rt| rt.pid == pid);
  if ours {
    let _ = std::fs::remove_file(path);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn sample(dir: &Path) -> Runtime {
    Runtime { version: VERSION, pid: 42, socket: dir.join(SOCKET).display().to_string(), token: crate::protocol::new_token().unwrap(), app_version: "0.1.0".into() }
  }

  #[test]
  fn writes_owner_only_and_reads_back() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join(FILE);
    let rt = sample(tmp.path());
    write(&path, &rt).unwrap();
    assert_eq!(read(&path).unwrap(), rt);
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    // Rewriting replaces it; only the owning pid removes it.
    write(&path, &Runtime { pid: 43, ..rt.clone() }).unwrap();
    remove_if_ours(&path, 42);
    assert!(path.exists());
    remove_if_ours(&path, 43);
    assert!(!path.exists());
  }

  #[cfg(unix)]
  #[test]
  fn refuses_a_runtime_file_others_can_read_or_a_symlink() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join(FILE);
    write(&path, &sample(tmp.path())).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(read(&path).unwrap_err().contains("other users"));
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let link = tmp.path().join("link.json");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert!(read(&link).unwrap_err().contains("not a regular file"));
  }

  #[test]
  fn refuses_incomplete_or_newer_files() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join(FILE);
    write(&path, &Runtime { token: "short".into(), ..sample(tmp.path()) }).unwrap();
    assert!(read(&path).unwrap_err().contains("incomplete"));
    write(&path, &Runtime { version: VERSION + 1, ..sample(tmp.path()) }).unwrap();
    assert!(read(&path).unwrap_err().contains("update the kingu command"));
    assert!(read(&tmp.path().join("missing.json")).is_err());
  }

  #[test]
  fn finds_the_app_data_folder_like_tauri() {
    let home = Path::new("/Users/k");
    let got = default_app_data(Some(home), None, Some(Path::new("C:/AppData"))).unwrap();
    if cfg!(target_os = "macos") {
      assert_eq!(got, Path::new("/Users/k/Library/Application Support/ai.anthov.kingu.studio"));
    } else if cfg!(windows) {
      assert_eq!(got, Path::new("C:/AppData/ai.anthov.kingu.studio"));
    } else {
      assert_eq!(got, Path::new("/Users/k/.local/share/ai.anthov.kingu.studio"));
      assert_eq!(default_app_data(Some(home), Some(Path::new("/x/data")), None).unwrap(), Path::new("/x/data/ai.anthov.kingu.studio"));
    }
  }
}
