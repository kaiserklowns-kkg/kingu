//! Profiles (VS Code's user data profiles, the settings and keybindings part): each profile is a
//! folder `<config>/profiles/<id>/` with its own `settings.json` and `keybindings.json`; the
//! Default profile is the config dir itself. `<config>/profiles/profiles.json` lists them and
//! names the active one. Application-scoped settings stay in the Default profile's file for every
//! profile, as in VS Code (the webview reads that file as the `defaultUser` scope), so the Rust
//! side's own settings reads (`settings::user_value`) keep using it.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::i18n::msg::ProfilesMsg;
use crate::tr;

pub const PROFILES_DIR: &str = "profiles";
const LIST_FILE: &str = "profiles.json";
/// The files a profile holds (copied by New Profile from another profile).
const PROFILE_FILES: [&str; 2] = ["settings.json", "keybindings.json"];

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Profile {
  pub id: String,
  pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProfileList {
  /// `None`: the Default profile.
  #[serde(default)]
  pub active: Option<String>,
  #[serde(default)]
  pub profiles: Vec<Profile>,
}

/// A profile id names a folder: short lowercase hex, never a path.
pub fn valid_id(id: &str) -> bool {
  (1..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn list_path(config: &Path) -> PathBuf {
  config.join(PROFILES_DIR).join(LIST_FILE)
}

/// The profiles file (missing or broken: only the Default profile; unknown ids are dropped).
pub fn load(config: &Path) -> ProfileList {
  let mut list: ProfileList = std::fs::read_to_string(list_path(config)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
  list.profiles.retain(|p| valid_id(&p.id));
  if list.active.as_ref().is_some_and(|a| !list.profiles.iter().any(|p| &p.id == a)) {
    list.active = None;
  }
  list
}

fn save(config: &Path, list: &ProfileList) -> Result<(), String> {
  let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
  crate::settings::write_atomic(&list_path(config), &text)
}

/// The folder of the active profile's settings.json / keybindings.json.
pub fn active_dir(config: &Path) -> PathBuf {
  match load(config).active {
    Some(id) => config.join(PROFILES_DIR).join(id),
    None => config.to_path_buf(),
  }
}

fn dir_of(config: &Path, id: Option<&str>) -> PathBuf {
  id.map_or_else(|| config.to_path_buf(), |id| config.join(PROFILES_DIR).join(id))
}

fn new_id(list: &ProfileList, name: &str) -> String {
  use std::hash::{Hash, Hasher};
  let mut salt = 0u64;
  loop {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (name, salt, std::time::SystemTime::now()).hash(&mut h);
    let id = format!("{:08x}", h.finish() as u32);
    if !list.profiles.iter().any(|p| p.id == id) {
      return id;
    }
    salt += 1;
  }
}

fn clean_name(name: &str, list: &ProfileList, except: Option<&str>) -> Result<String, String> {
  let name = name.trim();
  if name.is_empty() {
    return Err(tr!(ProfilesMsg::NameRequired));
  }
  if name.eq_ignore_ascii_case("default") || list.profiles.iter().any(|p| Some(p.id.as_str()) != except && p.name.eq_ignore_ascii_case(name)) {
    return Err(tr!(ProfilesMsg::NameTaken, name));
  }
  Ok(name.to_string())
}

fn known(list: &ProfileList, id: &str) -> Result<(), String> {
  if list.profiles.iter().any(|p| p.id == id) { Ok(()) } else { Err(tr!(ProfilesMsg::NotFound, id)) }
}

/// New Profile: an empty one, or a copy of `copy_from`'s settings and keybindings (`Some(None)`:
/// the Default profile's). It does not become active.
pub fn create(config: &Path, name: &str, copy_from: Option<Option<&str>>) -> Result<Profile, String> {
  let mut list = load(config);
  let name = clean_name(name, &list, None)?;
  if let Some(Some(from)) = copy_from {
    known(&list, from)?;
  }
  let profile = Profile { id: new_id(&list, &name), name };
  let dir = dir_of(config, Some(&profile.id));
  std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
  if let Some(from) = copy_from {
    let source = dir_of(config, from);
    for file in PROFILE_FILES {
      if let Ok(text) = std::fs::read_to_string(source.join(file)) {
        crate::settings::write_atomic(&dir.join(file), &text)?;
      }
    }
    // The user snippets go with the copy too (VS Code's profile resources).
    for snippets in crate::snippets::list(&crate::snippets::dir_in(&source)) {
      crate::snippets::write(&crate::snippets::dir_in(&dir), &snippets.name, &snippets.content)?;
    }
  }
  list.profiles.push(profile.clone());
  save(config, &list)?;
  Ok(profile)
}

/// Switch Profile (`None`: Default).
pub fn switch(config: &Path, id: Option<&str>) -> Result<ProfileList, String> {
  let mut list = load(config);
  if let Some(id) = id {
    known(&list, id)?;
  }
  list.active = id.map(str::to_string);
  save(config, &list)?;
  Ok(list)
}

pub fn rename(config: &Path, id: &str, name: &str) -> Result<ProfileList, String> {
  let mut list = load(config);
  known(&list, id)?;
  let name = clean_name(name, &list, Some(id))?;
  if let Some(p) = list.profiles.iter_mut().find(|p| p.id == id) {
    p.name = name;
  }
  save(config, &list)?;
  Ok(list)
}

/// Delete Profile: its folder goes; deleting the active one switches to Default (VS Code).
pub fn delete(config: &Path, id: &str) -> Result<ProfileList, String> {
  let mut list = load(config);
  known(&list, id)?;
  list.profiles.retain(|p| p.id != id);
  if list.active.as_deref() == Some(id) {
    list.active = None;
  }
  save(config, &list)?;
  let dir = dir_of(config, Some(id));
  if dir.is_dir() {
    std::fs::remove_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
  }
  Ok(list)
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
  app.path().app_config_dir().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn profiles_list(app: AppHandle) -> Result<ProfileList, String> {
  Ok(load(&config_dir(&app)?))
}

/// `copy_from`: absent for an empty profile, `""` for the Default profile, else a profile id.
#[tauri::command]
pub fn profile_create(app: AppHandle, name: String, copy_from: Option<String>) -> Result<Profile, String> {
  let from = copy_from.as_deref().map(|f| if f.is_empty() { None } else { Some(f) });
  let profile = create(&config_dir(&app)?, &name, from)?;
  log::info!("profile created: {}", profile.id);
  Ok(profile)
}

#[tauri::command]
pub fn profile_switch(app: AppHandle, id: Option<String>) -> Result<ProfileList, String> {
  let list = switch(&config_dir(&app)?, id.as_deref())?;
  log::info!("profile: {}", list.active.as_deref().unwrap_or("default"));
  Ok(list)
}

#[tauri::command]
pub fn profile_rename(app: AppHandle, id: String, name: String) -> Result<ProfileList, String> {
  if id.is_empty() {
    return Err(tr!(ProfilesMsg::DefaultIsFixed));
  }
  rename(&config_dir(&app)?, &id, &name)
}

#[tauri::command]
pub fn profile_delete(app: AppHandle, id: String) -> Result<ProfileList, String> {
  if id.is_empty() {
    return Err(tr!(ProfilesMsg::DefaultIsFixed));
  }
  delete(&config_dir(&app)?, &id)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn ids_are_plain_hex_names() {
    assert!(valid_id("0a1b2c3d"));
    assert!(!valid_id(""));
    assert!(!valid_id("../x"));
    assert!(!valid_id("ABCD"));
    assert!(!valid_id(&"a".repeat(33)));
  }

  #[test]
  fn create_switch_rename_delete() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path();
    assert_eq!(active_dir(config), config);
    std::fs::write(config.join("settings.json"), "{\"editor.fontSize\": 20}").unwrap();
    crate::snippets::write(&config.join("snippets"), "rust.json", "{}").unwrap();
    let work = create(config, " Work ", Some(None)).unwrap();
    assert_eq!(std::fs::read_to_string(config.join("profiles").join(&work.id).join("snippets").join("rust.json")).unwrap(), "{}");
    assert_eq!(work.name, "Work");
    // A copy of the Default profile's settings; nothing becomes active yet.
    assert_eq!(std::fs::read_to_string(config.join("profiles").join(&work.id).join("settings.json")).unwrap(), "{\"editor.fontSize\": 20}");
    assert_eq!(active_dir(config), config);
    let empty = create(config, "Demo", None).unwrap();
    assert!(!config.join("profiles").join(&empty.id).join("settings.json").exists());
    assert!(create(config, "work", None).is_err());
    assert!(create(config, "Default", None).is_err());
    assert!(create(config, "  ", None).is_err());

    switch(config, Some(&work.id)).unwrap();
    assert_eq!(active_dir(config), config.join("profiles").join(&work.id));
    assert!(switch(config, Some("ffffffff")).is_err());

    let list = rename(config, &work.id, "Office").unwrap();
    assert_eq!(list.profiles.iter().find(|p| p.id == work.id).unwrap().name, "Office");
    assert!(rename(config, &empty.id, "office").is_err());

    // Deleting the active profile goes back to Default and removes its folder.
    let list = delete(config, &work.id).unwrap();
    assert_eq!(list.active, None);
    assert!(!config.join("profiles").join(&work.id).exists());
    assert_eq!(load(config).profiles, vec![empty]);
  }

  #[test]
  fn a_broken_or_stale_list_falls_back_to_default() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path();
    std::fs::create_dir_all(config.join("profiles")).unwrap();
    std::fs::write(list_path(config), "{\"active\": \"abc\", \"profiles\": [{\"id\": \"../evil\", \"name\": \"x\"}]}").unwrap();
    assert_eq!(load(config), ProfileList::default());
    assert_eq!(active_dir(config), config);
    std::fs::write(list_path(config), "not json").unwrap();
    assert_eq!(load(config), ProfileList::default());
  }
}
