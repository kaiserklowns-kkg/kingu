//! The Skills hub: every skill an agent can get, from every source, local-first.
//!
//! - **Kingu-managed** skills live in `<app config>/skills/<name>`, installed from a link (a git
//!   repo or GitHub folder, a `.skill`/`.zip` archive URL, a local archive or folder) after a
//!   review of their files ([`install`]). Their origin is recorded so they can be updated, and a
//!   share link that installs the same skill again is derived from it ([`source::share_link`]); a
//!   skill with no remote origin is shared as an exported `.skill` file instead.
//! - **Snap** skills come with snaps (snap.rs), **built-in** is the `kingu` command's skill
//!   (cli_server.rs). Both can be turned off here.
//! - **Project** (`<folder>/.claude/skills`) and **user** (`~/.claude/skills`) skills are listed
//!   read-only: Claude Code loads them itself, Kingu never writes there.
//!
//! What is turned off is `<app config>/skills.json` (`{"disabled": [ids]}`, ids as in
//! [`SkillInfo::id`]). Enabled Kingu-managed skills reach agent runs as one Claude plugin folder
//! (`<app cache>/skill-plugins/kingu-skills-<hash>`, written from the checked bytes and named by
//! them, so a running agent's folder never changes), next to the snap plugins: the SDK's
//! `plugins` option for chats and `--plugin-dir` for Claude Code terminals. Other runtimes (ACP
//! agents, Codex) have no skills mechanism Kingu can hand a folder to, so they get none.

pub mod install;
pub mod package;
pub mod source;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::i18n::msg::SkillMsg;
use crate::snap::SnapInfo;
use crate::tr;
use crate::workspace::Workspace;
use install::{FETCH_TIMEOUT, Origin, OriginKind, Prepared};
use package::{Flag, SKILL_FILE, is_skill_name};

const SKILLS_DIR: &str = "skills";
const STAGING_DIR: &str = "skill-staging";
const PLUGINS_DIR: &str = "skill-plugins";
const STATE_FILE: &str = "skills.json";
const PLUGIN_NAME: &str = "kingu-skills";
const PLUGIN_MANIFEST: [&str; 2] = [".claude-plugin", "plugin.json"];
/// Older plugin folders are removed after this long unused.
const PLUGIN_TTL: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 60 * 60);
/// Read-only listings stop here (a huge ~/.claude/skills is not ours to walk).
const MAX_LISTED: usize = 200;
const MAX_LISTED_SKILL_MD: u64 = 256 * 1024;
pub const BUILTIN_ID: &str = "builtin:kingu";

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SkillSource {
  Managed,
  Snap,
  Builtin,
  Project,
  User,
}

/// One row of the Skills view.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
  /// `managed:<name>`, `snap:<snap id>/<skill>`, `builtin:kingu`, `project:<folder>`, `user:<folder>`.
  pub id: String,
  pub source: SkillSource,
  pub name: String,
  pub description: String,
  /// The skill's folder; `None` for the built-in skill (it lives in the app).
  pub dir: Option<String>,
  /// Passed to agents (managed / snap / built-in, unless turned off); project and user skills are
  /// always on as far as Kingu knows (Claude Code reads them itself).
  pub enabled: bool,
  pub toggleable: bool,
  /// A snap skill whose snap is not active (not trusted, broken or overridden): it reaches no
  /// agent whatever its switch says.
  pub inactive: bool,
  pub error: Option<String>,
  /// The snap's name, for snap skills.
  pub snap: Option<String>,
  pub origin: Option<Origin>,
  pub flags: Vec<Flag>,
  /// A link that installs this skill elsewhere (managed skills from a remote origin).
  pub share_link: Option<String>,
}

// ---------------------------------------------------------------------------------------------
// On / off state

#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
pub struct HubState {
  #[serde(default)]
  pub disabled: Vec<String>,
}

impl HubState {
  pub fn load(config_dir: &Path) -> Self {
    let file = config_dir.join(STATE_FILE);
    std::fs::symlink_metadata(&file)
      .ok()
      .filter(|m| m.is_file() && m.len() <= 1024 * 1024)
      .and_then(|_| std::fs::read(&file).ok())
      .and_then(|b| serde_json::from_slice(&b).ok())
      .unwrap_or_default()
  }

  pub fn is_disabled(&self, id: &str) -> bool {
    self.disabled.iter().any(|d| d == id)
  }
}

/// Ids the switch applies to: managed, snap and built-in skills.
pub fn is_toggleable_id(id: &str) -> bool {
  if id == BUILTIN_ID {
    return true;
  }
  if let Some(name) = id.strip_prefix("managed:") {
    return is_skill_name(name);
  }
  if let Some(rest) = id.strip_prefix("snap:") {
    return rest.split_once('/').is_some_and(|(snap, skill)| crate::snap::is_snap_id(snap) && is_skill_name(skill));
  }
  false
}

pub fn set_enabled(config_dir: &Path, id: &str, enabled: bool) -> Result<(), String> {
  if !is_toggleable_id(id) {
    return Err(tr!(SkillMsg::CannotToggle, id));
  }
  let mut state = HubState::load(config_dir);
  state.disabled.retain(|d| d != id);
  if !enabled {
    state.disabled.push(id.to_string());
    state.disabled.sort();
  }
  std::fs::create_dir_all(config_dir).map_err(|e| tr!(SkillMsg::CreateFailed, path = config_dir.display(), detail = e))?;
  let text = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
  crate::settings::write_atomic(&config_dir.join(STATE_FILE), &(text + "\n")).map_err(|e| tr!(SkillMsg::WriteFailed, path = STATE_FILE, detail = e))
}

/// Drops turned-off skills from the snaps an agent run gets. A snap that lost skills gets a hash
/// over what is left, so its plugin folder (named by the hash) is never the full set's.
pub fn without_disabled(list: Vec<SnapInfo>, state: &HubState) -> Vec<SnapInfo> {
  list
    .into_iter()
    .map(|mut s| {
      let before = s.skills.len();
      s.skills.retain(|k| !state.is_disabled(&format!("snap:{}/{}", s.id, k.name)));
      if s.skills.len() != before {
        let mut h = Sha256::new();
        h.update(s.hash.as_bytes());
        for k in &s.skills {
          h.update(b"\0");
          h.update(k.name.as_bytes());
        }
        s.hash = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
      }
      s
    })
    .collect()
}

// ---------------------------------------------------------------------------------------------
// Listing

fn share_for(origin: Option<&Origin>) -> Option<String> {
  let o = origin?;
  let url = o.url.as_deref()?;
  match o.kind {
    OriginKind::Git if source::is_remote(url) => Some(source::share_link(url, o.git_ref.as_deref(), &o.path)),
    OriginKind::Archive => Some(url.to_string()),
    _ => None,
  }
}

fn managed(skills_dir: &Path, state: &HubState) -> Vec<SkillInfo> {
  let Ok(read) = std::fs::read_dir(skills_dir) else { return Vec::new() };
  let mut entries: Vec<_> = read.flatten().collect();
  entries.sort_by_key(|e| e.file_name());
  let mut out = Vec::new();
  for entry in entries {
    let folder = entry.file_name().to_string_lossy().into_owned();
    if folder.starts_with('.') || !std::fs::symlink_metadata(entry.path()).is_ok_and(|m| m.is_dir()) {
      continue;
    }
    let id = format!("managed:{folder}");
    let origin = install::read_origin(&entry.path());
    let mut info = SkillInfo {
      enabled: !state.is_disabled(&id),
      id,
      source: SkillSource::Managed,
      name: folder.clone(),
      description: String::new(),
      dir: Some(entry.path().display().to_string()),
      toggleable: is_skill_name(&folder),
      inactive: false,
      error: None,
      snap: None,
      share_link: share_for(origin.as_ref()),
      origin,
      flags: Vec::new(),
    };
    match package::read_skill_dir(&entry.path()) {
      Ok(s) if s.front.name == folder => {
        info.description = s.front.description;
        info.flags = s.flags.into_iter().filter(|f| !matches!(f, Flag::HiddenSkipped { .. })).collect();
      }
      Ok(s) => info.error = Some(tr!(SkillMsg::FolderNameMismatch, folder, name = s.front.name)),
      Err(e) => info.error = Some(e),
    }
    out.push(info);
  }
  out
}

fn snap_skills(list: &[SnapInfo], state: &HubState) -> Vec<SkillInfo> {
  let mut out = Vec::new();
  for s in list.iter().filter(|s| s.error.is_none()) {
    let inactive = !s.trusted || s.overridden;
    for k in &s.skills {
      let id = format!("snap:{}/{}", s.id, k.name);
      out.push(SkillInfo {
        enabled: !state.is_disabled(&id),
        id,
        source: SkillSource::Snap,
        name: k.name.clone(),
        description: k.description.clone(),
        dir: Some(Path::new(&s.dir).join(&k.path).display().to_string()),
        toggleable: true,
        inactive,
        error: None,
        snap: Some(s.name.clone()),
        origin: None,
        flags: Vec::new(),
        share_link: None,
      });
    }
  }
  out
}

fn builtin(state: &HubState) -> SkillInfo {
  let (name, description) = package::summary(crate::cli_server::SKILL_MD, "kingu");
  SkillInfo {
    id: BUILTIN_ID.into(),
    source: SkillSource::Builtin,
    name,
    description,
    dir: None,
    enabled: !state.is_disabled(BUILTIN_ID),
    toggleable: true,
    inactive: !crate::cli_server::available(),
    error: None,
    snap: None,
    origin: None,
    flags: Vec::new(),
    share_link: None,
  }
}

/// `<dir>/<folder>/SKILL.md` of another tool's skills folder, read-only. Symlinked skill folders
/// are listed (people link skills in), files are only read.
fn plain(dir: &Path, source: SkillSource, prefix: &str) -> Vec<SkillInfo> {
  let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
  let mut entries: Vec<_> = read.flatten().collect();
  entries.sort_by_key(|e| e.file_name());
  let mut out = Vec::new();
  for entry in entries.into_iter().take(MAX_LISTED) {
    let folder = entry.file_name().to_string_lossy().into_owned();
    let md = entry.path().join(SKILL_FILE);
    if folder.starts_with('.') || !std::fs::metadata(entry.path()).is_ok_and(|m| m.is_dir()) || !std::fs::metadata(&md).is_ok_and(|m| m.is_file()) {
      continue;
    }
    let text = std::fs::metadata(&md).ok().filter(|m| m.len() <= MAX_LISTED_SKILL_MD).and_then(|_| std::fs::read_to_string(&md).ok()).unwrap_or_default();
    let (name, description) = package::summary(&text, &folder);
    out.push(SkillInfo {
      id: format!("{prefix}:{folder}"),
      source,
      name,
      description,
      dir: Some(entry.path().display().to_string()),
      enabled: true,
      toggleable: false,
      inactive: false,
      error: package::parse_front_matter(&text).err(),
      snap: None,
      origin: None,
      flags: Vec::new(),
      share_link: None,
    });
  }
  out
}

/// Every skill of every source, Kingu's own first.
pub fn list_all(skills_dir: &Path, snaps: &[SnapInfo], root: Option<&Path>, home: Option<&Path>, state: &HubState) -> Vec<SkillInfo> {
  let mut out = managed(skills_dir, state);
  out.extend(snap_skills(snaps, state));
  out.push(builtin(state));
  if let Some(root) = root {
    out.extend(plain(&root.join(".claude").join("skills"), SkillSource::Project, "project"));
  }
  if let Some(home) = home {
    out.extend(plain(&home.join(".claude").join("skills"), SkillSource::User, "user"));
  }
  out
}

// ---------------------------------------------------------------------------------------------
// The agent plugin

/// Writes (or reuses) the plugin folder holding every enabled, valid managed skill; `None` when
/// there is none.
pub fn write_plugin(plugins_dir: &Path, skills_dir: &Path, state: &HubState) -> Result<Option<PathBuf>, String> {
  let mut skills = Vec::new();
  for info in managed(skills_dir, state) {
    if !info.enabled || info.error.is_some() || !is_skill_name(&info.name) {
      continue;
    }
    let dir = skills_dir.join(&info.name);
    match package::read_skill_dir(&dir) {
      Ok(s) => skills.push((info.name, dir, s)),
      Err(e) => log::warn!("skills: {} left out of agent runs: {e}", info.name),
    }
  }
  if skills.is_empty() {
    return Ok(None);
  }
  let mut h = Sha256::new();
  for (name, _, s) in &skills {
    h.update(name.as_bytes());
    h.update(b"\0");
    h.update(s.hash.as_bytes());
  }
  let hash: String = h.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect();
  let dir = plugins_dir.join(format!("{PLUGIN_NAME}-{hash}"));
  if !dir.join(PLUGIN_MANIFEST[0]).join(PLUGIN_MANIFEST[1]).is_file() {
    std::fs::create_dir_all(plugins_dir).map_err(|e| tr!(SkillMsg::CreateFailed, path = plugins_dir.display(), detail = e))?;
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
    let tmp = plugins_dir.join(format!(".tmp-{PLUGIN_NAME}-{}-{nanos}", std::process::id()));
    let build = || -> Result<(), String> {
      let manifest = serde_json::json!({ "name": PLUGIN_NAME, "version": "1.0.0", "description": "Skills installed through Kingu's Skills view" });
      let file = tmp.join(PLUGIN_MANIFEST[0]).join(PLUGIN_MANIFEST[1]);
      std::fs::create_dir_all(file.parent().unwrap_or(&tmp)).map_err(|e| tr!(SkillMsg::CreateFailed, path = tmp.display(), detail = e))?;
      std::fs::write(&file, serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?).map_err(|e| tr!(SkillMsg::WriteFailed, path = file.display(), detail = e))?;
      for (name, from, s) in &skills {
        package::copy_files(from, &tmp.join("skills").join(name), &s.files)?;
      }
      Ok(())
    };
    let built = build().and_then(|()| match std::fs::rename(&tmp, &dir) {
      Ok(()) => Ok(()),
      // Another run wrote the same content first.
      Err(_) if dir.join(PLUGIN_MANIFEST[0]).join(PLUGIN_MANIFEST[1]).is_file() => Ok(()),
      Err(e) => Err(tr!(SkillMsg::MoveFailed, detail = e)),
    });
    if tmp.exists() {
      let _ = std::fs::remove_dir_all(&tmp);
    }
    built?;
  }
  prune_plugins(plugins_dir, &dir);
  Ok(Some(dir))
}

fn prune_plugins(plugins_dir: &Path, keep: &Path) {
  let Ok(read) = std::fs::read_dir(plugins_dir) else { return };
  for entry in read.flatten() {
    let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > PLUGIN_TTL);
    if entry.path() != keep && old {
      let _ = std::fs::remove_dir_all(entry.path());
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Commands

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
  crate::snap::config_dir(app)
}

pub(crate) fn skills_dir(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(config_dir(app)?.join(SKILLS_DIR))
}

pub(crate) fn staging_dir(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join(STAGING_DIR))
}

fn plugins_dir(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join(PLUGINS_DIR))
}

/// Where plugin folders handed to an agent may live: the snap plugins, these skills and the
/// `kingu` command's skill (`snap::validate_plugin_dirs` checks each folder against them).
pub fn plugin_bases(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
  let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
  Ok(vec![crate::snap::plugins_dir(app)?, cache.join(PLUGINS_DIR), cache.join(crate::cli_server::PLUGIN_DIR)])
}

/// Whether the built-in `kingu` skill is turned off.
pub fn builtin_disabled(app: &AppHandle) -> bool {
  config_dir(app).is_ok_and(|c| HubState::load(&c).is_disabled(BUILTIN_ID))
}

fn snaps_now(app: &AppHandle, root: Option<&Path>) -> Result<Vec<SnapInfo>, String> {
  let config = config_dir(app)?;
  let trust = crate::snap::TrustData::load(&config.join(crate::snap::TRUST_FILE));
  Ok(crate::snap::discover(&config.join(crate::snap::USER_DIR), root, &trust))
}

/// The folder of listed skill `id` (not the built-in one).
fn locate(app: &AppHandle, root: Option<&Path>, id: &str) -> Result<PathBuf, String> {
  let plain_name = |s: &str| !s.is_empty() && !s.starts_with('.') && !s.contains(['/', '\\']) && s != "..";
  let not_found = || tr!(SkillMsg::NotFound, id);
  if let Some(name) = id.strip_prefix("managed:") {
    return install::installed_dir(&skills_dir(app)?, name);
  }
  if let Some(folder) = id.strip_prefix("project:").filter(|f| plain_name(f)) {
    return Ok(root.ok_or_else(not_found)?.join(".claude").join("skills").join(folder));
  }
  if let Some(folder) = id.strip_prefix("user:").filter(|f| plain_name(f)) {
    return Ok(app.path().home_dir().map_err(|e| e.to_string())?.join(".claude").join("skills").join(folder));
  }
  if let Some((snap, skill)) = id.strip_prefix("snap:").and_then(|r| r.split_once('/')) {
    let list = snaps_now(app, root)?;
    let s = list.iter().find(|s| s.id == snap && s.error.is_none()).ok_or_else(not_found)?;
    let k = s.skills.iter().find(|k| k.name == skill).ok_or_else(not_found)?;
    return Ok(Path::new(&s.dir).join(&k.path));
  }
  Err(not_found())
}

#[tauri::command]
pub async fn skill_hub_list(app: AppHandle, ws: State<'_, Workspace>) -> Result<Vec<SkillInfo>, String> {
  let root = ws.current();
  install_blocking(move || {
    let config = config_dir(&app)?;
    let state = HubState::load(&config);
    let snaps = snaps_now(&app, root.as_deref())?;
    let home = app.path().home_dir().ok();
    Ok(list_all(&config.join(SKILLS_DIR), &snaps, root.as_deref(), home.as_deref(), &state))
  })
  .await
}

#[tauri::command]
pub fn skill_hub_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
  set_enabled(&config_dir(&app)?, &id, enabled)?;
  log::info!("skills: {id} enabled = {enabled}");
  Ok(())
}

async fn install_blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  crate::snap_install::blocking(f).await
}

#[tauri::command]
pub async fn skill_hub_prepare(app: AppHandle, link: String) -> Result<Prepared, String> {
  install_blocking(move || install::prepare(&staging_dir(&app)?, &skills_dir(&app)?, &link, FETCH_TIMEOUT)).await
}

#[tauri::command]
pub async fn skill_hub_prepare_update(app: AppHandle, name: String) -> Result<Prepared, String> {
  install_blocking(move || install::prepare_update(&staging_dir(&app)?, &skills_dir(&app)?, &name, FETCH_TIMEOUT, &|url| install::download(url, FETCH_TIMEOUT))).await
}

#[tauri::command]
pub async fn skill_hub_commit(app: AppHandle, token: String, rel: String, hash: String, replace: bool) -> Result<String, String> {
  install_blocking(move || {
    let name = install::commit(&staging_dir(&app)?, &skills_dir(&app)?, &token, &rel, &hash, replace)?;
    log::info!("skills: {name} installed (replace = {replace})");
    Ok(name)
  })
  .await
}

#[tauri::command]
pub fn skill_hub_cancel(app: AppHandle, token: String) -> Result<(), String> {
  install::cancel(&staging_dir(&app)?, &token);
  Ok(())
}

#[tauri::command]
pub async fn skill_hub_remove(app: AppHandle, name: String) -> Result<(), String> {
  install_blocking(move || {
    install::remove(&skills_dir(&app)?, &name, |p| trash::delete(p).map_err(|e| tr!(SkillMsg::TrashFailed, detail = e)))?;
    // A removed skill comes back on, should it be installed again.
    let _ = set_enabled(&config_dir(&app)?, &format!("managed:{name}"), true);
    log::info!("skills: {name} removed");
    Ok(())
  })
  .await
}

#[tauri::command]
pub fn skill_hub_reveal(app: AppHandle, ws: State<'_, Workspace>, id: String) -> Result<(), String> {
  let dir = locate(&app, ws.current().as_deref(), &id)?;
  crate::fileops::reveal_path(&dir.join(SKILL_FILE))
}

/// SKILL.md of listed skill `id`, to show it.
#[tauri::command]
pub fn skill_hub_read(app: AppHandle, ws: State<'_, Workspace>, id: String) -> Result<String, String> {
  if id == BUILTIN_ID {
    return Ok(crate::cli_server::SKILL_MD.to_string());
  }
  let file = locate(&app, ws.current().as_deref(), &id)?.join(SKILL_FILE);
  match std::fs::metadata(&file) {
    Ok(m) if m.is_file() && m.len() <= MAX_LISTED_SKILL_MD => std::fs::read_to_string(&file).map_err(|e| tr!(SkillMsg::ReadFailed, path = file.display(), detail = e)),
    Ok(m) if m.is_file() => Err(tr!(SkillMsg::SkillMdTooBig, kb = MAX_LISTED_SKILL_MD / 1024)),
    _ => Err(tr!(SkillMsg::SkillMdMissing)),
  }
}

/// Writes listed skill `id` as a `.skill` archive to `dest` (from the native save dialog).
#[tauri::command]
pub async fn skill_hub_export(app: AppHandle, ws: State<'_, Workspace>, id: String, dest: String) -> Result<(), String> {
  let root = ws.current();
  install_blocking(move || {
    let dest = PathBuf::from(&dest);
    let ext = dest.extension().map(|e| e.to_string_lossy().to_ascii_lowercase());
    if !dest.is_absolute() || !matches!(ext.as_deref(), Some("skill" | "zip")) || !dest.parent().is_some_and(Path::is_dir) {
      return Err(tr!(SkillMsg::ExportPathInvalid));
    }
    let dir = locate(&app, root.as_deref(), &id)?;
    let skill = package::read_skill_dir(&dir)?;
    package::write_archive(&dir, &skill.front.name, &dest)?;
    log::info!("skills: exported {id} to {}", dest.display());
    Ok(())
  })
  .await
}

/// The plugin folder of the enabled Kingu-managed skills for an agent run (empty when none).
#[tauri::command]
pub async fn skill_hub_plugins(app: AppHandle) -> Result<Vec<String>, String> {
  install_blocking(move || {
    let config = config_dir(&app)?;
    let dir = write_plugin(&plugins_dir(&app)?, &config.join(SKILLS_DIR), &HubState::load(&config))?;
    Ok(dir.map(|d| d.display().to_string()).into_iter().collect())
  })
  .await
}

#[cfg(test)]
mod tests {
  use super::*;
  use package::tests::skill;

  #[test]
  fn toggle_ids() {
    for ok in ["managed:pdf", "snap:go/go-style", BUILTIN_ID] {
      assert!(is_toggleable_id(ok), "{ok}");
    }
    for bad in ["project:pdf", "user:pdf", "managed:../x", "snap:go", "snap:Go/x", "builtin:other", ""] {
      assert!(!is_toggleable_id(bad), "{bad}");
    }
  }

  #[test]
  fn state_round_trip() {
    let tmp = tempfile::tempdir().unwrap();
    set_enabled(tmp.path(), "managed:pdf", false).unwrap();
    set_enabled(tmp.path(), "builtin:kingu", false).unwrap();
    set_enabled(tmp.path(), "managed:pdf", true).unwrap();
    assert_eq!(HubState::load(tmp.path()).disabled, ["builtin:kingu"]);
    assert_eq!(set_enabled(tmp.path(), "user:x", false), Err(tr!(SkillMsg::CannotToggle, id = "user:x")));
    std::fs::write(tmp.path().join(STATE_FILE), "not json").unwrap();
    assert_eq!(HubState::load(tmp.path()), HubState::default());
  }

  #[test]
  fn lists_every_source() {
    let tmp = tempfile::tempdir().unwrap();
    let skills = tmp.path().join("skills");
    skill(&skills.join("pdf"), "pdf", "PDF help");
    skill(&skills.join("wrong"), "other", "mismatch");
    let root = tmp.path().join("repo");
    skill(&root.join(".claude/skills/review"), "review", "Review code");
    let home = tmp.path().join("home");
    skill(&home.join(".claude/skills/mine"), "mine", "Mine");
    std::fs::create_dir_all(home.join(".claude/skills/empty")).unwrap();
    let state = HubState { disabled: vec!["managed:pdf".into()] };
    let list = list_all(&skills, &[], Some(&root), Some(&home), &state);
    let rows: Vec<_> = list.iter().map(|s| (s.id.as_str(), s.enabled, s.toggleable, s.error.is_some())).collect();
    assert_eq!(rows, [("managed:pdf", false, true, false), ("managed:wrong", true, true, true), (BUILTIN_ID, true, true, false), ("project:review", true, false, false), ("user:mine", true, false, false)]);
    assert_eq!(list[2].name, "kingu");
    assert!(!list[2].description.is_empty());
  }

  #[test]
  fn plugin_holds_enabled_skills_only() {
    let tmp = tempfile::tempdir().unwrap();
    let (skills, plugins) = (tmp.path().join("skills"), tmp.path().join("plugins"));
    assert_eq!(write_plugin(&plugins, &skills, &HubState::default()).unwrap(), None);
    skill(&skills.join("pdf"), "pdf", "PDF help");
    skill(&skills.join("notes"), "notes", "Notes");
    std::fs::write(skills.join("pdf").join(install::ORIGIN_FILE), "{}").unwrap();
    let dir = write_plugin(&plugins, &skills, &HubState::default()).unwrap().unwrap();
    assert!(dir.file_name().unwrap().to_string_lossy().starts_with("kingu-skills-"));
    assert!(dir.join("skills/pdf/SKILL.md").is_file() && dir.join("skills/notes/SKILL.md").is_file());
    assert!(!dir.join("skills/pdf").join(install::ORIGIN_FILE).exists());
    let manifest: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join(".claude-plugin/plugin.json")).unwrap()).unwrap();
    assert_eq!(manifest["name"], PLUGIN_NAME);
    // Same content, same folder; one skill off, another folder without it.
    assert_eq!(write_plugin(&plugins, &skills, &HubState::default()).unwrap().unwrap(), dir);
    let off = HubState { disabled: vec!["managed:notes".into()] };
    let other = write_plugin(&plugins, &skills, &off).unwrap().unwrap();
    assert_ne!(other, dir);
    assert!(!other.join("skills/notes").exists());
    assert_eq!(write_plugin(&plugins, &skills, &HubState { disabled: vec!["managed:notes".into(), "managed:pdf".into()] }).unwrap(), None);
    // The folders pass the check agent runs make.
    crate::snap::validate_plugin_dirs(&[tmp.path().join("snaps-none"), plugins.clone()], &[dir.display().to_string(), other.display().to_string()]).unwrap();
  }

  #[test]
  fn share_links_from_origins() {
    let git = Origin { url: Some("https://github.com/o/r".into()), git_ref: Some("main".into()), path: "skills/pdf".into(), ..serde_json::from_str::<Origin>(r#"{"kind":"git"}"#).unwrap() };
    assert_eq!(share_for(Some(&git)).as_deref(), Some("https://github.com/o/r/tree/main/skills/pdf"));
    let local = Origin { url: Some("/srv/repo".into()), ..git.clone() };
    assert_eq!(share_for(Some(&local)), None);
    let file = Origin { kind: OriginKind::File, url: None, local: Some("/tmp/a.skill".into()), ..git.clone() };
    assert_eq!(share_for(Some(&file)), None);
    let archive = Origin { kind: OriginKind::Archive, url: Some("https://x.dev/a.skill".into()), ..git };
    assert_eq!(share_for(Some(&archive)).as_deref(), Some("https://x.dev/a.skill"));
  }
}
