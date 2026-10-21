//! Snap secrets: values for the names a snap declares in `[permissions] secrets`, entered once by
//! the user and kept in the Keychain (service `dev.kingu.snap.<id>`, account = the name).
//!
//! They reach only that snap's processes: before a task or MCP server starts, the webview asks
//! for a secrets file (`snap_secrets_file`), a 0600 JSON object in `<app cache>/snap-secrets/`
//! (a 0700 folder every snap sandbox hides, `--hide`), and passes its path to the launcher
//! (`--secrets-file[-once]`), which reads it before confining the command and sets only the
//! declared names (`kingu_ptyd::sandbox::read_secrets`). A task's file is deleted as soon as it
//! is read; an MCP server's stays (an agent may restart the server) until it is 2 days old. So a
//! value is never in an argv, a terminal, a log, the agent's MCP config or the team server.
//! With the sandbox setting off there is nothing to hide the folder from other processes.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::i18n::msg::SnapMsg;
use crate::snap::{SnapInfo, TRUST_FILE, TrustData, USER_DIR, config_dir, discover, is_snap_id};
use crate::tr;
use crate::workspace::Workspace;

pub const SERVICE_PREFIX: &str = "dev.kingu.snap.";
pub const SECRETS_DIR: &str = "snap-secrets";
const MAX_VALUE_BYTES: usize = 64 * 1024;
const FILE_TTL: std::time::Duration = std::time::Duration::from_secs(2 * 24 * 60 * 60);

/// The Keychain service of a snap's secrets.
pub fn service(snap_id: &str) -> String {
  format!("{SERVICE_PREFIX}{snap_id}")
}

/// Where secret values live. The app uses the Keychain; tests use `MemSecrets`, never the real one.
pub trait SecretStore {
  fn get(&self, snap_id: &str, name: &str) -> Result<Option<String>, String>;
  fn set(&self, snap_id: &str, name: &str, value: &str) -> Result<(), String>;
  fn delete(&self, snap_id: &str, name: &str) -> Result<(), String>;
}

/// macOS Keychain (Credential Manager / Secret Service elsewhere) via `keyring`.
pub struct KeychainSecrets;

impl KeychainSecrets {
  fn entry(snap_id: &str, name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(&service(snap_id), name).map_err(|e| tr!(SnapMsg::KeychainFailed, detail = e))
  }
}

impl SecretStore for KeychainSecrets {
  fn get(&self, snap_id: &str, name: &str) -> Result<Option<String>, String> {
    match Self::entry(snap_id, name)?.get_password() {
      Ok(v) => Ok(Some(v)),
      Err(keyring::Error::NoEntry) => Ok(None),
      Err(e) => Err(tr!(SnapMsg::KeychainFailed, detail = e)),
    }
  }

  fn set(&self, snap_id: &str, name: &str, value: &str) -> Result<(), String> {
    Self::entry(snap_id, name)?.set_password(value).map_err(|e| tr!(SnapMsg::KeychainFailed, detail = e))
  }

  fn delete(&self, snap_id: &str, name: &str) -> Result<(), String> {
    match Self::entry(snap_id, name)?.delete_credential() {
      Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
      Err(e) => Err(tr!(SnapMsg::KeychainFailed, detail = e)),
    }
  }
}

/// A declared secret and whether a value is stored (never the value).
#[derive(Serialize, Debug, PartialEq)]
pub struct SecretState {
  pub name: String,
  pub stored: bool,
}

pub fn states(store: &dyn SecretStore, snap: &SnapInfo) -> Result<Vec<SecretState>, String> {
  snap.permissions.secrets.iter().map(|name| Ok(SecretState { name: name.clone(), stored: store.get(&snap.id, name)?.is_some() })).collect()
}

fn declared<'a>(snap: &'a SnapInfo, name: &str) -> Result<&'a str, String> {
  snap.permissions.secrets.iter().find(|n| *n == name).map(String::as_str).ok_or_else(|| tr!(SnapMsg::SecretNotDeclared, id = snap.id, name))
}

/// Stores a value for a declared name: non-empty, at most 64 KB, no NUL (env cannot hold one).
pub fn set(store: &dyn SecretStore, snap: &SnapInfo, name: &str, value: &str) -> Result<(), String> {
  let name = declared(snap, name)?;
  if value.is_empty() || value.len() > MAX_VALUE_BYTES || value.contains('\0') {
    return Err(tr!(SnapMsg::SecretValueInvalid, name));
  }
  store.set(&snap.id, name, value)
}

pub fn delete(store: &dyn SecretStore, snap: &SnapInfo, name: &str) -> Result<(), String> {
  store.delete(&snap.id, declared(snap, name)?)
}

/// The private folder for secrets files (created 0700); files older than `FILE_TTL` go.
pub fn ensure_dir(dir: &Path) -> Result<(), String> {
  std::fs::create_dir_all(dir).map_err(|e| tr!(SnapMsg::CreateFailed, path = dir.display(), detail = e))?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| tr!(SnapMsg::CreateFailed, path = dir.display(), detail = e))?;
  }
  if let Ok(read) = std::fs::read_dir(dir) {
    for entry in read.flatten() {
      let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > FILE_TTL);
      if old {
        let _ = std::fs::remove_file(entry.path());
      }
    }
  }
  Ok(())
}

/// Writes the stored values of `snap`'s declared secrets to a new 0600 file in `dir`; None when
/// none is stored (names without a value pass through from the environment as before).
pub fn write_file(store: &dyn SecretStore, dir: &Path, snap: &SnapInfo) -> Result<Option<PathBuf>, String> {
  let mut values = BTreeMap::new();
  for name in &snap.permissions.secrets {
    if let Some(v) = store.get(&snap.id, name)? {
      values.insert(name.clone(), v);
    }
  }
  if values.is_empty() {
    return Ok(None);
  }
  ensure_dir(dir)?;
  // An unguessable name; with create_new below, nobody can have prepared the path.
  let mut random = [0u8; 16];
  {
    use std::io::Read;
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut random)).map_err(|e| e.to_string())?;
  }
  let file = dir.join(format!("{}-{}.json", snap.id, random.iter().map(|b| format!("{b:02x}")).collect::<String>()));
  let text = serde_json::to_string(&values).map_err(|e| e.to_string())?;
  let mut options = std::fs::OpenOptions::new();
  options.write(true).create_new(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  use std::io::Write;
  // The error names the file, never what was being written.
  options.open(&file).and_then(|mut f| f.write_all(text.as_bytes())).map_err(|e| tr!(SnapMsg::WriteFailed, path = file.display(), detail = e))?;
  Ok(Some(file))
}

// ---- commands -------------------------------------------------------------------

pub fn secrets_dir(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join(SECRETS_DIR))
}

/// A valid snap of this window's listing with this id that declares secrets: the active one
/// (a trusted repo snap over the user's) or, for entering values, any valid one.
fn find(app: &AppHandle, ws: &Workspace, id: &str, active_only: bool) -> Result<SnapInfo, String> {
  if !is_snap_id(id) {
    return Err(tr!(SnapMsg::InvalidId, id));
  }
  let config = config_dir(app)?;
  let trust = TrustData::load(&config.join(TRUST_FILE));
  let list = discover(&config.join(USER_DIR), ws.current().as_deref(), &trust);
  let mut matching = list.into_iter().filter(|s| s.id == id && s.error.is_none() && !s.overridden);
  let pick = if active_only { matching.find(|s| s.trusted) } else { matching.max_by_key(|s| s.trusted) };
  pick.ok_or_else(|| tr!(SnapMsg::NotFound, id))
}

#[tauri::command]
pub async fn snap_secrets_list(app: AppHandle, ws: Workspace, id: String) -> Result<Vec<SecretState>, String> {
  crate::snap_install::blocking(move || states(&KeychainSecrets, &find(&app, &ws, &id, false)?)).await
}

#[tauri::command]
pub async fn snap_secret_set(app: AppHandle, ws: Workspace, id: String, name: String, value: String) -> Result<(), String> {
  crate::snap_install::blocking(move || {
    set(&KeychainSecrets, &find(&app, &ws, &id, false)?, &name, &value)?;
    log::info!("snap {id}: secret {name} saved in the Keychain");
    Ok(())
  })
  .await
}

#[tauri::command]
pub async fn snap_secret_delete(app: AppHandle, ws: Workspace, id: String, name: String) -> Result<(), String> {
  crate::snap_install::blocking(move || {
    delete(&KeychainSecrets, &find(&app, &ws, &id, false)?, &name)?;
    log::info!("snap {id}: secret {name} removed from the Keychain");
    Ok(())
  })
  .await
}

/// A secrets file for one launch of active snap `id`, or null when it has no stored values.
#[tauri::command]
pub async fn snap_secrets_file(app: AppHandle, ws: Workspace, id: String) -> Result<Option<String>, String> {
  crate::snap_install::blocking(move || {
    let snap = find(&app, &ws, &id, true)?;
    Ok(write_file(&KeychainSecrets, &secrets_dir(&app)?, &snap)?.map(|p| p.display().to_string()))
  })
  .await
}

#[cfg(test)]
pub(crate) mod tests {
  use super::*;
  use std::sync::Mutex;

  /// In-memory stand-in for the Keychain.
  #[derive(Default)]
  pub struct MemSecrets(pub Mutex<BTreeMap<(String, String), String>>);

  impl SecretStore for MemSecrets {
    fn get(&self, snap_id: &str, name: &str) -> Result<Option<String>, String> {
      Ok(self.0.lock().unwrap().get(&(service(snap_id), name.to_string())).cloned())
    }
    fn set(&self, snap_id: &str, name: &str, value: &str) -> Result<(), String> {
      self.0.lock().unwrap().insert((service(snap_id), name.to_string()), value.to_string());
      Ok(())
    }
    fn delete(&self, snap_id: &str, name: &str) -> Result<(), String> {
      self.0.lock().unwrap().remove(&(service(snap_id), name.to_string()));
      Ok(())
    }
  }

  fn snap(secrets: &[&str]) -> SnapInfo {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path().join("pg");
    std::fs::create_dir_all(&d).unwrap();
    let list = secrets.iter().map(|s| format!("\"{s}\"")).collect::<Vec<_>>().join(", ");
    std::fs::write(d.join("snap.toml"), format!("id = \"pg\"\nname = \"Postgres\"\nversion = \"1\"\n[permissions]\nsecrets = [{list}]\n")).unwrap();
    crate::snap::discover(dir.path(), None, &TrustData::default()).remove(0)
  }

  #[test]
  fn values_are_kept_per_snap_service_and_declared_names_only() {
    let store = MemSecrets::default();
    let s = snap(&["PGPASSWORD", "API_KEY"]);
    assert_eq!(states(&store, &s).unwrap(), vec![SecretState { name: "PGPASSWORD".into(), stored: false }, SecretState { name: "API_KEY".into(), stored: false }]);
    set(&store, &s, "PGPASSWORD", "hunter2").unwrap();
    assert!(store.0.lock().unwrap().contains_key(&("dev.kingu.snap.pg".to_string(), "PGPASSWORD".to_string())));
    assert!(states(&store, &s).unwrap()[0].stored);
    assert!(set(&store, &s, "OTHER", "x").unwrap_err().contains("does not declare"));
    assert!(set(&store, &s, "API_KEY", "").is_err());
    assert!(set(&store, &s, "API_KEY", "a\0b").is_err());
    delete(&store, &s, "PGPASSWORD").unwrap();
    assert!(!states(&store, &s).unwrap()[0].stored);
  }

  #[test]
  fn the_secrets_file_is_private_and_holds_only_this_snaps_values() {
    let store = MemSecrets::default();
    let s = snap(&["PGPASSWORD", "API_KEY"]);
    let dir = tempfile::tempdir().unwrap();
    let secrets = dir.path().join(SECRETS_DIR);
    assert_eq!(write_file(&store, &secrets, &s).unwrap(), None, "nothing stored, no file");
    store.set("pg", "PGPASSWORD", "hunter2").unwrap();
    store.set("other", "API_KEY", "not this snap's").unwrap();
    let f = write_file(&store, &secrets, &s).unwrap().unwrap();
    assert_eq!(f.parent(), Some(secrets.as_path()));
    let map: BTreeMap<String, String> = serde_json::from_slice(&std::fs::read(&f).unwrap()).unwrap();
    assert_eq!(map, BTreeMap::from([("PGPASSWORD".to_string(), "hunter2".to_string())]));
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
      assert_eq!(std::fs::metadata(&secrets).unwrap().permissions().mode() & 0o777, 0o700);
    }
    // The launcher reads it the same way (and only the declared names).
    let got = kingu_ptyd::sandbox::read_secrets(&f, &s.permissions.secrets, true).unwrap();
    assert_eq!(got, vec![("PGPASSWORD".to_string(), "hunter2".to_string())]);
    assert!(!f.exists());
    // Each launch gets its own file.
    let a = write_file(&store, &secrets, &s).unwrap().unwrap();
    let b = write_file(&store, &secrets, &s).unwrap().unwrap();
    assert_ne!(a, b);
  }
}
