//! Profiles (VS Code's user data profiles, the settings and keybindings part): each profile is a
//! folder `<config>/profiles/<id>/` with its own `settings.json` and `keybindings.json`; the
//! Default profile is the config dir itself. `<config>/profiles/profiles.json` lists them and
//! names the active one. Application-scoped settings stay in the Default profile's file for every
//! profile, as in VS Code (the webview reads that file as the `defaultUser` scope), so the Rust
//! side's own settings reads (`settings::user_value`) keep using it.
//!
//! Each window has its profile (VS Code): the one it was opened with (New Window with Profile, a
//! temporary profile), else the one its folder or workspace is associated with (Switch Profile in
//! a window with a folder associates them), else the profile used last (`active`), which new and
//! empty windows start with. Temporary profiles are deleted once no window uses them.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::i18n::msg::ProfilesMsg;
use crate::tr;
use crate::workspace::Workspace;

pub const PROFILES_DIR: &str = "profiles";
const LIST_FILE: &str = "profiles.json";
/// The files a profile holds (copied by New Profile from another profile).
const PROFILE_FILES: [&str; 2] = ["settings.json", "keybindings.json"];

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Profile {
  pub id: String,
  pub name: String,
  /// A temporary profile (VS Code's transient profile): gone when its last window closes.
  #[serde(default, skip_serializing_if = "std::ops::Not::not")]
  pub transient: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProfileList {
  /// `None`: the Default profile.
  #[serde(default)]
  pub active: Option<String>,
  #[serde(default)]
  pub profiles: Vec<Profile>,
  /// Workspace identity (folder, workspace file) → the profile it opens with (`""`: Default).
  #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
  pub associations: BTreeMap<String, String>,
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
  let ids: Vec<String> = list.profiles.iter().map(|p| p.id.clone()).collect();
  list.associations.retain(|_, id| id.is_empty() || ids.contains(id));
  list
}

/// The profile a window uses (see the module doc): `own` is the window's (`Some("")`: Default),
/// `identity` its workspace's. `None`: Default.
pub fn window_profile(list: &ProfileList, own: Option<&str>, identity: Option<&str>) -> Option<String> {
  let known = |id: &str| list.profiles.iter().any(|p| p.id == id);
  let pick = |id: &str| if id.is_empty() { Some(None) } else if known(id) { Some(Some(id.to_string())) } else { None };
  if let Some(p) = own.and_then(pick) {
    return p;
  }
  if let Some(p) = identity.and_then(|i| list.associations.get(i)).and_then(|id| pick(id)) {
    return p;
  }
  list.active.clone()
}

/// The list as window `ws` sees it: `active` is its own profile.
pub fn for_window(config: &Path, ws: &Workspace) -> ProfileList {
  let mut list = load(config);
  let session = ws.session();
  list.active = window_profile(&list, session.profile.as_deref(), session.identity().as_deref());
  list
}

/// The folder of window `ws`'s settings.json / keybindings.json / snippets.
pub fn window_dir(config: &Path, ws: &Workspace) -> PathBuf {
  dir_of(config, for_window(config, ws).active.as_deref())
}

/// The profile folder a path in the config dir belongs to (the config dir itself for Default).
pub fn profile_dir_of(config: &Path, path: &Path) -> PathBuf {
  let base = config.join(PROFILES_DIR);
  path
    .strip_prefix(&base)
    .ok()
    .and_then(|rest| rest.components().next())
    .and_then(|c| c.as_os_str().to_str())
    .filter(|id| valid_id(id))
    .map_or_else(|| config.to_path_buf(), |id| base.join(id))
}

/// Deletes the temporary profiles no window in `in_use` uses any more.
pub fn remove_unused_transient(config: &Path, in_use: &[String]) {
  let list = load(config);
  for p in list.profiles.iter().filter(|p| p.transient && !in_use.contains(&p.id)) {
    match delete(config, &p.id) {
      Ok(_) => log::info!("temporary profile {} removed", p.id),
      Err(e) => log::warn!("temporary profile {}: {e}", p.id),
    }
  }
}

fn save(config: &Path, list: &ProfileList) -> Result<(), String> {
  let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
  crate::settings::write_atomic(&list_path(config), &text)
}

/// The folder of the profile new windows start with.
#[cfg(test)]
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
  create_with(config, name, copy_from, None, false)
}

/// [`create`], with a template's `settings` (settings.json text) and as a temporary profile.
pub fn create_with(config: &Path, name: &str, copy_from: Option<Option<&str>>, settings: Option<&str>, transient: bool) -> Result<Profile, String> {
  let mut list = load(config);
  let name = clean_name(name, &list, None)?;
  if let Some(Some(from)) = copy_from {
    known(&list, from)?;
  }
  let profile = Profile { id: new_id(&list, &name), name, transient };
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
  if let Some(text) = settings {
    crate::settings::write_atomic(&dir.join("settings.json"), text)?;
  }
  list.profiles.push(profile.clone());
  save(config, &list)?;
  Ok(profile)
}

/// Switch Profile (`None`: Default): it becomes the profile new windows start with.
#[cfg(test)]
pub fn switch(config: &Path, id: Option<&str>) -> Result<ProfileList, String> {
  switch_for(config, id, None)
}

/// Switch Profile in a window whose workspace is `identity`: the workspace is associated with the
/// profile too (VS Code), so it opens with it from now on.
pub fn switch_for(config: &Path, id: Option<&str>, identity: Option<&str>) -> Result<ProfileList, String> {
  let mut list = load(config);
  if let Some(id) = id {
    known(&list, id)?;
  }
  // A temporary profile stays its window's own; it is never remembered.
  let transient = id.is_some_and(|id| list.profiles.iter().any(|p| p.id == id && p.transient));
  if !transient {
    list.active = id.map(str::to_string);
    if let Some(identity) = identity {
      list.associations.insert(identity.to_string(), id.unwrap_or("").to_string());
    }
  }
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
  list.associations.retain(|_, p| p != id);
  save(config, &list)?;
  let dir = dir_of(config, Some(id));
  if dir.is_dir() {
    std::fs::remove_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
  }
  Ok(list)
}

// --- Export / Import Profile (VS Code's `.code-profile`, IUserDataProfileTemplate)
//
// The template is a JSON object; each resource is itself a JSON string, as VS Code writes it:
// `settings` is `{"settings": "<settings.json text>"}`, `keybindings` is
// `{"platform": n, "keybindings": "<keybindings.json text>"}`, `snippets` is
// `{"snippets": {"<file name>": "<text>"}}`. Kingu's profiles hold only these three; a VS Code
// template's other resources (extensions, tasks, UI state) are ignored on import.

/// Largest `.code-profile` file read on import.
const MAX_TEMPLATE_BYTES: u64 = 16 * 1024 * 1024;

/// VS Code's `Platform` enum value of this OS in a keybindings resource.
fn platform_number() -> u8 {
  if cfg!(target_os = "macos") {
    1
  } else if cfg!(target_os = "windows") {
    3
  } else {
    2
  }
}

/// What an imported template holds, for the confirmation before it is created.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSummary {
  pub name: String,
  pub settings: bool,
  pub keybindings: bool,
  pub snippets: usize,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct Template {
  name: String,
  settings: Option<String>,
  keybindings: Option<String>,
  snippets: Vec<(String, String)>,
}

/// The `.code-profile` text of a profile (`None`: Default).
pub fn export_template(config: &Path, id: Option<&str>) -> Result<String, String> {
  let list = load(config);
  let name = match id {
    Some(id) => {
      known(&list, id)?;
      list.profiles.iter().find(|p| p.id == id).map(|p| p.name.clone()).unwrap_or_default()
    }
    None => "Default".to_string(),
  };
  let dir = dir_of(config, id);
  let mut out = serde_json::Map::new();
  out.insert("name".into(), name.into());
  if let Ok(text) = std::fs::read_to_string(dir.join("settings.json")) {
    out.insert("settings".into(), serde_json::json!({ "settings": text }).to_string().into());
  }
  if let Ok(text) = std::fs::read_to_string(dir.join("keybindings.json")) {
    out.insert("keybindings".into(), serde_json::json!({ "platform": platform_number(), "keybindings": text }).to_string().into());
  }
  let snippets = crate::snippets::list(&crate::snippets::dir_in(&dir));
  if !snippets.is_empty() {
    let files: serde_json::Map<String, serde_json::Value> = snippets.into_iter().map(|s| (s.name, s.content.into())).collect();
    out.insert("snippets".into(), serde_json::json!({ "snippets": files }).to_string().into());
  }
  serde_json::to_string_pretty(&serde_json::Value::Object(out)).map_err(|e| e.to_string())
}

/// A resource string of a template parsed as an object (a missing or broken one is `None`).
fn resource(template: &serde_json::Value, key: &str) -> Option<serde_json::Map<String, serde_json::Value>> {
  match template.get(key)? {
    serde_json::Value::String(text) => serde_json::from_str::<serde_json::Value>(text).ok()?.as_object().cloned(),
    // Lenient: an object written by hand instead of a string.
    serde_json::Value::Object(o) => Some(o.clone()),
    _ => None,
  }
}

fn parse_template(text: &str) -> Result<Template, String> {
  let value: serde_json::Value = serde_json::from_str(text).map_err(|_| tr!(ProfilesMsg::NotATemplate))?;
  if !value.is_object() {
    return Err(tr!(ProfilesMsg::NotATemplate));
  }
  let name = value.get("name").and_then(|n| n.as_str()).unwrap_or_default().trim().to_string();
  let string_of = |o: Option<serde_json::Map<String, serde_json::Value>>, key: &str| o.and_then(|o| o.get(key).and_then(|v| v.as_str()).map(str::to_string));
  let settings = string_of(resource(&value, "settings"), "settings");
  let keybindings = string_of(resource(&value, "keybindings"), "keybindings");
  let snippets = resource(&value, "snippets")
    .and_then(|o| o.get("snippets").and_then(|s| s.as_object()).cloned())
    .map(|files| files.into_iter().filter_map(|(name, v)| Some((name, v.as_str()?.to_string()))).filter(|(name, _)| crate::snippets::valid_name(name)).collect())
    .unwrap_or_default();
  Ok(Template { name, settings, keybindings, snippets })
}

fn read_template(path: &Path) -> Result<Template, String> {
  let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
  if meta.len() > MAX_TEMPLATE_BYTES {
    return Err(tr!(ProfilesMsg::TemplateTooLarge));
  }
  let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
  parse_template(&text)
}

pub fn template_summary(path: &Path) -> Result<TemplateSummary, String> {
  let t = read_template(path)?;
  Ok(TemplateSummary { name: t.name, settings: t.settings.is_some(), keybindings: t.keybindings.is_some(), snippets: t.snippets.len() })
}

/// Import Profile: a new profile named `name` with the template's settings, keybindings and
/// snippets. It does not become active.
pub fn import_template(config: &Path, path: &Path, name: &str) -> Result<Profile, String> {
  let t = read_template(path)?;
  let profile = create(config, name, None)?;
  let dir = dir_of(config, Some(&profile.id));
  let written = (|| {
    if let Some(text) = &t.settings {
      crate::settings::write_atomic(&dir.join("settings.json"), text)?;
    }
    if let Some(text) = &t.keybindings {
      crate::settings::write_atomic(&dir.join("keybindings.json"), text)?;
    }
    for (name, content) in &t.snippets {
      crate::snippets::write(&crate::snippets::dir_in(&dir), name, content)?;
    }
    Ok::<(), String>(())
  })();
  if let Err(e) = written {
    // No half-imported profile is left behind.
    let _ = delete(config, &profile.id);
    return Err(e);
  }
  Ok(profile)
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
  app.path().app_config_dir().map_err(|e| e.to_string())
}

/// The profiles, with `active` the calling window's.
#[tauri::command]
pub fn profiles_list(app: AppHandle, ws: Workspace) -> Result<ProfileList, String> {
  Ok(for_window(&config_dir(&app)?, &ws))
}

/// `copy_from`: absent for an empty profile, `""` for the Default profile, else a profile id.
/// `settings`: a template's settings.json. `transient`: a temporary profile.
#[tauri::command]
pub fn profile_create(app: AppHandle, name: String, copy_from: Option<String>, settings: Option<String>, transient: Option<bool>) -> Result<Profile, String> {
  let from = copy_from.as_deref().map(|f| if f.is_empty() { None } else { Some(f) });
  let profile = create_with(&config_dir(&app)?, &name, from, settings.as_deref(), transient.unwrap_or(false))?;
  log::info!("profile created: {}{}", profile.id, if profile.transient { " (temporary)" } else { "" });
  Ok(profile)
}

/// Switch Profile in the calling window (its workspace remembers it).
#[tauri::command]
pub fn profile_switch(app: AppHandle, ws: Workspace, id: Option<String>) -> Result<ProfileList, String> {
  let config = config_dir(&app)?;
  let mut session = ws.session();
  switch_for(&config, id.as_deref(), session.identity().as_deref())?;
  // The window takes the profile as its own (a temporary one is only ever its own).
  session.profile = Some(id.clone().unwrap_or_default());
  ws.set_session(session);
  crate::windows::save_windows(&app);
  let list = for_window(&config, &ws);
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
pub fn profile_delete(app: AppHandle, ws: Workspace, id: String) -> Result<ProfileList, String> {
  if id.is_empty() {
    return Err(tr!(ProfilesMsg::DefaultIsFixed));
  }
  let config = config_dir(&app)?;
  delete(&config, &id)?;
  Ok(for_window(&config, &ws))
}

/// Export Profile…: writes the `.code-profile` of `id` (absent: Default) to `path`, a file the user
/// picked in the save dialog.
#[tauri::command]
pub fn profile_export(app: AppHandle, id: Option<String>, path: String) -> Result<(), String> {
  let text = export_template(&config_dir(&app)?, id.as_deref().filter(|i| !i.is_empty()))?;
  crate::settings::write_atomic(Path::new(&path), &text)?;
  log::info!("profile exported: {}", id.as_deref().unwrap_or("default"));
  Ok(())
}

/// What the `.code-profile` at `path` holds (Import Profile… shows it before creating the profile).
#[tauri::command]
pub fn profile_import_preview(path: String) -> Result<TemplateSummary, String> {
  template_summary(Path::new(&path))
}

#[tauri::command]
pub fn profile_import(app: AppHandle, path: String, name: String) -> Result<Profile, String> {
  let profile = import_template(&config_dir(&app)?, Path::new(&path), &name)?;
  log::info!("profile imported: {}", profile.id);
  Ok(profile)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn export_and_import_round_trip() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path();
    let work = create(config, "Work", None).unwrap();
    let dir = config.join("profiles").join(&work.id);
    std::fs::write(dir.join("settings.json"), "// mine\n{\"editor.tabSize\": 2}").unwrap();
    std::fs::write(dir.join("keybindings.json"), "[{\"key\": \"cmd+i\", \"command\": \"x\"}]").unwrap();
    crate::snippets::write(&dir.join("snippets"), "rust.json", "{\"a\": {}}").unwrap();

    let text = export_template(config, Some(&work.id)).unwrap();
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["name"], "Work");
    // VS Code's shape: each resource is a JSON string.
    let settings: serde_json::Value = serde_json::from_str(value["settings"].as_str().unwrap()).unwrap();
    assert_eq!(settings["settings"], "// mine\n{\"editor.tabSize\": 2}");
    let keys: serde_json::Value = serde_json::from_str(value["keybindings"].as_str().unwrap()).unwrap();
    assert_eq!(keys["platform"], platform_number());

    let file = tmp.path().join("work.code-profile");
    std::fs::write(&file, &text).unwrap();
    assert_eq!(template_summary(&file).unwrap(), TemplateSummary { name: "Work".into(), settings: true, keybindings: true, snippets: 1 });
    assert!(import_template(config, &file, "work").is_err());
    let copy = import_template(config, &file, "Work 2").unwrap();
    let copy_dir = config.join("profiles").join(&copy.id);
    assert_eq!(std::fs::read_to_string(copy_dir.join("settings.json")).unwrap(), "// mine\n{\"editor.tabSize\": 2}");
    assert_eq!(std::fs::read_to_string(copy_dir.join("keybindings.json")).unwrap(), "[{\"key\": \"cmd+i\", \"command\": \"x\"}]");
    assert_eq!(std::fs::read_to_string(copy_dir.join("snippets").join("rust.json")).unwrap(), "{\"a\": {}}");
    assert_eq!(load(config).active, None);
  }

  #[test]
  fn templates_from_vs_code_and_bad_files() {
    // A VS Code export: extensions and UI state are ignored, bad snippet names are dropped.
    let text = r#"{"name":"Py","settings":"{\"settings\":\"{}\"}","extensions":"[]","snippets":"{\"snippets\":{\"py.json\":\"{}\",\"../x.json\":\"{}\"}}"}"#;
    let t = parse_template(text).unwrap();
    assert_eq!(t, Template { name: "Py".into(), settings: Some("{}".into()), keybindings: None, snippets: vec![("py.json".into(), "{}".into())] });
    assert!(parse_template("[1]").is_err());
    assert!(parse_template("nope").is_err());
    assert_eq!(parse_template("{}").unwrap(), Template::default());
    let tmp = tempfile::tempdir().unwrap();
    assert!(export_template(tmp.path(), Some("ffffffff")).is_err());
    assert_eq!(serde_json::from_str::<serde_json::Value>(&export_template(tmp.path(), None).unwrap()).unwrap(), serde_json::json!({ "name": "Default" }));
  }

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
  fn windows_folders_and_temporary_profiles() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path();
    let work = create(config, "Work", None).unwrap();
    let docs = create_with(config, "Docs", None, Some("{\"editor.wordWrap\": \"on\"}"), false).unwrap();
    assert_eq!(std::fs::read_to_string(config.join("profiles").join(&docs.id).join("settings.json")).unwrap(), "{\"editor.wordWrap\": \"on\"}");

    // Switching in a folder's window associates the folder; new windows start with it too.
    switch_for(config, Some(&work.id), Some("/a")).unwrap();
    let list = load(config);
    assert_eq!(window_profile(&list, None, Some("/a")).as_deref(), Some(work.id.as_str()));
    assert_eq!(window_profile(&list, None, None).as_deref(), Some(work.id.as_str()));
    // Another folder switched back to Default keeps Default, whatever new windows use.
    switch_for(config, None, Some("/b")).unwrap();
    switch_for(config, Some(&docs.id), None).unwrap();
    let list = load(config);
    assert_eq!(window_profile(&list, None, Some("/b")), None);
    assert_eq!(window_profile(&list, None, Some("/a")).as_deref(), Some(work.id.as_str()));
    assert_eq!(window_profile(&list, None, Some("/c")).as_deref(), Some(docs.id.as_str()));
    // A window's own profile (New Window with Profile) wins; an unknown one is ignored.
    assert_eq!(window_profile(&list, Some(""), Some("/a")), None);
    assert_eq!(window_profile(&list, Some(&work.id), Some("/b")).as_deref(), Some(work.id.as_str()));
    assert_eq!(window_profile(&list, Some("ffffffff"), Some("/b")), None);

    // A temporary profile is never remembered and goes when no window uses it.
    let temp = create_with(config, "Temp 1", None, None, true).unwrap();
    assert!(temp.transient);
    switch_for(config, Some(&temp.id), Some("/a")).unwrap();
    let list = load(config);
    assert_eq!(list.associations.get("/a"), Some(&work.id));
    assert_eq!(list.active.as_deref(), Some(docs.id.as_str()));
    remove_unused_transient(config, std::slice::from_ref(&temp.id));
    assert!(load(config).profiles.iter().any(|p| p.id == temp.id));
    remove_unused_transient(config, &[]);
    assert!(!load(config).profiles.iter().any(|p| p.id == temp.id));

    // Deleting a profile drops its associations.
    delete(config, &work.id).unwrap();
    assert!(!load(config).associations.contains_key("/a"));
    assert_eq!(load(config).associations.get("/b").map(String::as_str), Some(""));
  }

  #[test]
  fn changed_paths_belong_to_their_profile() {
    let config = Path::new("/c");
    assert_eq!(profile_dir_of(config, Path::new("/c/profiles/0a1b/settings.json")), Path::new("/c/profiles/0a1b"));
    assert_eq!(profile_dir_of(config, Path::new("/c/settings.json")), config);
    assert_eq!(profile_dir_of(config, Path::new("/c/profiles/profiles.json")), config);
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
