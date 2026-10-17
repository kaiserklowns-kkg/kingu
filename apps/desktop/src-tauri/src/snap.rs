//! Snaps: packs of tasks, settings and MCP servers that plug into both the IDE and the ADE
//! (Kingu has no extensions). A snap is a folder holding a `snap.toml`, either the user's
//! (`<config dir>/snaps/<id>`) or the open folder's (`<root>/.kingu/snaps/<id>`, shared through
//! git). This module only reads manifests; it never runs anything.
//!
//! Trust: opening or cloning a repo must never run anything from `.kingu/snaps`, so a repo snap
//! is untrusted until the user trusts it. Trust lives outside the repo in
//! `<config dir>/snap-trust.json`, keyed by folder + snap id + SHA-256 of the manifest bytes, so
//! any change to the manifest (a pull, a branch switch) revokes it. User snaps are trusted (the
//! user put them there). The webview only lists untrusted snaps; it contributes their tasks and
//! MCP servers only when `trusted` is true and `error` is none.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::settings::write_atomic;
use crate::workspace::Workspace;

const MANIFEST: &str = "snap.toml";
const USER_DIR: &str = "snaps";
const REPO_DIR: [&str; 2] = [".kingu", "snaps"];
const TRUST_FILE: &str = "snap-trust.json";
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;

// ---------------------------------------------------------------------------------------------
// Manifest

/// `snap.toml`. Unknown fields are errors at every level so typos surface instead of silently
/// doing nothing.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
  id: String,
  name: String,
  version: String,
  #[serde(default)]
  description: String,
  #[serde(default)]
  permissions: Permissions,
  #[serde(default)]
  tasks: Vec<Task>,
  #[serde(default)]
  settings: Vec<RawSetting>,
  #[serde(default)]
  mcp: BTreeMap<String, RawMcp>,
}

/// Declared and shown to the user before trust; enforcement is phase 2.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct Permissions {
  #[serde(default)]
  pub network: bool,
  #[serde(default)]
  pub fs: FsAccess,
  /// Names only; values will live in the Keychain.
  #[serde(default)]
  pub secrets: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum FsAccess {
  #[default]
  Worktree,
  Home,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Task {
  pub id: String,
  pub title: String,
  /// argv; `${setting:<key>}` is expanded by the webview from the snap's settings.
  pub command: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSetting {
  key: String,
  #[serde(rename = "type")]
  kind: SettingType,
  default: Option<toml::Value>,
  #[serde(default)]
  description: String,
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SettingType {
  String,
  Boolean,
  Number,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Setting {
  pub key: String,
  #[serde(rename = "type")]
  pub kind: SettingType,
  pub default: serde_json::Value,
  pub description: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawMcp {
  command: Vec<String>,
  #[serde(default)]
  env: BTreeMap<String, String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct McpServer {
  pub name: String,
  pub command: Vec<String>,
  pub env: BTreeMap<String, String>,
}

/// A parsed and validated manifest.
#[derive(Debug, PartialEq)]
pub struct Parsed {
  pub id: String,
  pub name: String,
  pub version: String,
  pub description: String,
  pub permissions: Permissions,
  pub tasks: Vec<Task>,
  pub settings: Vec<Setting>,
  pub mcp: Vec<McpServer>,
}

/// `^[a-z0-9][a-z0-9-]{0,max-1}$` (task ids pass `usize::MAX`).
fn is_slug(s: &str, max: usize) -> bool {
  let b = s.as_bytes();
  !b.is_empty() && b.len() <= max && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

pub fn is_snap_id(s: &str) -> bool {
  is_slug(s, 40)
}

/// `^[a-zA-Z][a-zA-Z0-9]*$`
fn is_setting_key(s: &str) -> bool {
  let b = s.as_bytes();
  !b.is_empty() && b[0].is_ascii_alphabetic() && b.iter().all(u8::is_ascii_alphanumeric)
}

/// `^[A-Za-z0-9][A-Za-z0-9_-]*$` (MCP server names).
fn is_name(s: &str) -> bool {
  let b = s.as_bytes();
  !b.is_empty() && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-')
}

/// `^[A-Za-z_][A-Za-z0-9_]*$` (env and secret names).
fn is_env_name(s: &str) -> bool {
  let b = s.as_bytes();
  !b.is_empty() && (b[0].is_ascii_alphabetic() || b[0] == b'_') && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

/// The setting keys referenced by `${setting:<key>}` in one argument (mirrors `snapModel.ts`).
pub fn placeholders(arg: &str) -> Result<Vec<&str>, String> {
  const OPEN: &str = "${setting:";
  let mut out = Vec::new();
  let mut rest = arg;
  while let Some(i) = rest.find(OPEN) {
    let after = &rest[i + OPEN.len()..];
    let end = after.find('}').ok_or_else(|| format!("\"{arg}\": ${{setting:…}} ไม่มี }} ปิด"))?;
    out.push(&after[..end]);
    rest = &after[end + 1..];
  }
  Ok(out)
}

fn setting_default(key: &str, kind: SettingType, value: Option<toml::Value>) -> Result<serde_json::Value, String> {
  use serde_json::Value as J;
  use toml::Value as T;
  let bad = || format!("ค่า default ของการตั้งค่า \"{key}\" ไม่ตรงกับ type = \"{}\"", serde_json::to_value(kind).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default());
  Ok(match (kind, value) {
    (SettingType::String, None) => J::from(""),
    (SettingType::Boolean, None) => J::from(false),
    (SettingType::Number, None) => J::from(0),
    (SettingType::String, Some(T::String(s))) => J::from(s),
    (SettingType::Boolean, Some(T::Boolean(b))) => J::from(b),
    (SettingType::Number, Some(T::Integer(n))) => J::from(n),
    (SettingType::Number, Some(T::Float(f))) if f.is_finite() => J::from(f),
    _ => return Err(bad()),
  })
}

/// Parses and validates `snap.toml` found in the folder named `folder`. Errors are Thai, one line.
pub fn parse_manifest(text: &str, folder: &str) -> Result<Parsed, String> {
  let m: Manifest = toml::from_str(text).map_err(|e| format!("อ่าน {MANIFEST} ไม่ได้: {}", e.to_string().trim().replace('\n', " ")))?;
  if !is_snap_id(&m.id) {
    return Err(format!("id \"{}\" ไม่ถูกต้อง (ใช้ a-z, 0-9, - ขึ้นต้นด้วยตัวอักษรหรือตัวเลข ยาวไม่เกิน 40 ตัว)", m.id));
  }
  if m.id != folder {
    return Err(format!("id \"{}\" ต้องตรงกับชื่อโฟลเดอร์ \"{folder}\"", m.id));
  }
  if m.name.trim().is_empty() {
    return Err("ต้องระบุ name".into());
  }
  if m.version.trim().is_empty() {
    return Err("ต้องระบุ version".into());
  }
  for s in &m.permissions.secrets {
    if !is_env_name(s) {
      return Err(format!("ชื่อ secret \"{s}\" ไม่ถูกต้อง (ใช้ A-Z, a-z, 0-9, _)"));
    }
  }

  let mut settings = Vec::new();
  let mut keys = BTreeSet::new();
  for s in m.settings {
    if !is_setting_key(&s.key) {
      return Err(format!("key ของการตั้งค่า \"{}\" ไม่ถูกต้อง (ขึ้นต้นด้วยตัวอักษร ตามด้วยตัวอักษรหรือตัวเลข)", s.key));
    }
    if !keys.insert(s.key.clone()) {
      return Err(format!("การตั้งค่า \"{}\" ซ้ำ", s.key));
    }
    let default = setting_default(&s.key, s.kind, s.default)?;
    settings.push(Setting { key: s.key, kind: s.kind, default, description: s.description });
  }

  let mut ids = BTreeSet::new();
  for t in &m.tasks {
    if !is_slug(&t.id, usize::MAX) {
      return Err(format!("id ของงาน \"{}\" ไม่ถูกต้อง (ใช้ a-z, 0-9, -)", t.id));
    }
    if !ids.insert(t.id.as_str()) {
      return Err(format!("งาน \"{}\" ซ้ำ", t.id));
    }
    if t.title.trim().is_empty() {
      return Err(format!("งาน \"{}\" ต้องมี title", t.id));
    }
    if t.command.first().is_none_or(|c| c.trim().is_empty()) {
      return Err(format!("งาน \"{}\" ต้องมี command (argv อย่างน้อยหนึ่งตัว)", t.id));
    }
    for arg in &t.command {
      for key in placeholders(arg).map_err(|e| format!("งาน \"{}\": {e}", t.id))? {
        if !keys.contains(key) {
          return Err(format!("งาน \"{}\" อ้างถึงการตั้งค่า \"{key}\" ที่ไม่ได้ประกาศใน [[settings]]", t.id));
        }
      }
    }
  }

  let mut mcp = Vec::new();
  for (name, server) in m.mcp {
    if !is_name(&name) {
      return Err(format!("ชื่อ MCP server \"{name}\" ไม่ถูกต้อง (ใช้ A-Z, a-z, 0-9, _, -)"));
    }
    if server.command.first().is_none_or(|c| c.trim().is_empty()) {
      return Err(format!("MCP server \"{name}\" ต้องมี command"));
    }
    if let Some(k) = server.env.keys().find(|k| !is_env_name(k)) {
      return Err(format!("MCP server \"{name}\": ชื่อตัวแปร env \"{k}\" ไม่ถูกต้อง"));
    }
    mcp.push(McpServer { name, command: server.command, env: server.env });
  }

  Ok(Parsed { id: m.id, name: m.name, version: m.version, description: m.description, permissions: m.permissions, tasks: m.tasks, settings, mcp })
}

pub fn sha256_hex(bytes: &[u8]) -> String {
  Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------------------------
// Discovery

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
  User,
  Repo,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapInfo {
  pub id: String,
  pub name: String,
  pub version: String,
  pub description: String,
  pub source: Source,
  pub dir: String,
  /// User snaps always; repo snaps when the trust store has this folder + id + manifest hash.
  pub trusted: bool,
  /// A broken snap is listed with its error and contributes nothing.
  pub error: Option<String>,
  /// A user snap whose id a repo snap of the open folder also uses (the repo snap wins).
  pub overridden: bool,
  /// SHA-256 of `snap.toml` (empty when it could not be read), passed back when trusting.
  pub hash: String,
  pub permissions: Permissions,
  pub tasks: Vec<Task>,
  pub settings: Vec<Setting>,
  pub mcp: Vec<McpServer>,
}

impl SnapInfo {
  fn broken(folder: &str, source: Source, dir: &Path, hash: String, error: String) -> Self {
    Self {
      id: folder.to_string(),
      name: folder.to_string(),
      version: String::new(),
      description: String::new(),
      source,
      dir: dir.display().to_string(),
      trusted: false,
      error: Some(error),
      overridden: false,
      hash,
      permissions: Permissions::default(),
      tasks: Vec::new(),
      settings: Vec::new(),
      mcp: Vec::new(),
    }
  }
}

/// `<root>/.kingu/snaps`, or `None` when `.kingu` or `snaps` is a symlink or not a folder (it
/// could point outside the repo).
pub fn repo_snaps_dir(root: &Path) -> Option<PathBuf> {
  let mut dir = root.to_path_buf();
  for part in REPO_DIR {
    dir.push(part);
    let meta = std::fs::symlink_metadata(&dir).ok()?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
      log::warn!("snaps: ignoring {} (symlink or not a folder)", dir.display());
      return None;
    }
  }
  Some(dir)
}

/// Reads one snap folder. Never follows a symlink: a symlinked folder or manifest is listed as broken.
fn read_snap(dir: &Path, folder: &str, source: Source, root: Option<&Path>, trust: &TrustData) -> SnapInfo {
  let broken = |hash: String, e: String| SnapInfo::broken(folder, source, dir, hash, e);
  if !is_snap_id(folder) {
    return broken(String::new(), format!("ชื่อโฟลเดอร์ \"{folder}\" ใช้เป็น id ของ snap ไม่ได้ (ใช้ a-z, 0-9, - ยาวไม่เกิน 40 ตัว)"));
  }
  let file = dir.join(MANIFEST);
  let meta = match std::fs::symlink_metadata(&file) {
    Ok(m) => m,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return broken(String::new(), format!("ไม่มี {MANIFEST} ในโฟลเดอร์นี้")),
    Err(e) => return broken(String::new(), format!("อ่าน {MANIFEST} ไม่ได้: {e}")),
  };
  if !meta.is_file() {
    return broken(String::new(), format!("{MANIFEST} ต้องเป็นไฟล์ธรรมดา (ไม่ใช่ symlink หรือโฟลเดอร์)"));
  }
  if meta.len() > MAX_MANIFEST_BYTES {
    return broken(String::new(), format!("{MANIFEST} ใหญ่เกิน {} KB", MAX_MANIFEST_BYTES / 1024));
  }
  let bytes = match std::fs::read(&file) {
    Ok(b) => b,
    Err(e) => return broken(String::new(), format!("อ่าน {MANIFEST} ไม่ได้: {e}")),
  };
  let hash = sha256_hex(&bytes);
  let Ok(text) = std::str::from_utf8(&bytes) else {
    return broken(hash, format!("{MANIFEST} ไม่ใช่ UTF-8"));
  };
  match parse_manifest(text, folder) {
    Err(e) => broken(hash, e),
    Ok(p) => SnapInfo {
      trusted: match (source, root) {
        (Source::User, _) => true,
        (Source::Repo, Some(root)) => trust.is_trusted(root, &p.id, &hash),
        (Source::Repo, None) => false,
      },
      id: p.id,
      name: p.name,
      version: p.version,
      description: p.description,
      source,
      dir: dir.display().to_string(),
      error: None,
      overridden: false,
      hash,
      permissions: p.permissions,
      tasks: p.tasks,
      settings: p.settings,
      mcp: p.mcp,
    },
  }
}

/// Every snap folder directly in `snaps_dir`, by name. Hidden entries and plain files are skipped.
fn scan(snaps_dir: &Path, source: Source, root: Option<&Path>, trust: &TrustData) -> Vec<SnapInfo> {
  let Ok(read) = std::fs::read_dir(snaps_dir) else { return Vec::new() };
  let mut entries: Vec<_> = read.flatten().collect();
  entries.sort_by_key(|e| e.file_name());
  let mut out = Vec::new();
  for entry in entries {
    let name = entry.file_name().to_string_lossy().into_owned();
    if name.starts_with('.') {
      continue;
    }
    let dir = entry.path();
    let Ok(meta) = std::fs::symlink_metadata(&dir) else { continue };
    if meta.file_type().is_symlink() {
      out.push(SnapInfo::broken(&name, source, &dir, String::new(), "โฟลเดอร์ snap เป็น symlink — ไม่รองรับ (Kingu ไม่ตามลิงก์ออกนอกโฟลเดอร์ snaps)".into()));
    } else if meta.is_dir() {
      out.push(read_snap(&dir, &name, source, root, trust));
    }
  }
  out
}

/// User snaps then the open folder's repo snaps. A repo snap overrides a user snap with the same id.
pub fn discover(user_dir: &Path, root: Option<&Path>, trust: &TrustData) -> Vec<SnapInfo> {
  let mut user = scan(user_dir, Source::User, None, trust);
  let repo = root.and_then(|r| repo_snaps_dir(r).map(|d| scan(&d, Source::Repo, Some(r), trust))).unwrap_or_default();
  for u in &mut user {
    u.overridden = repo.iter().any(|r| r.id == u.id);
  }
  user.extend(repo);
  user
}

// ---------------------------------------------------------------------------------------------
// Trust store

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TrustEntry {
  pub root: PathBuf,
  pub id: String,
  pub sha256: String,
}

#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
pub struct TrustData {
  #[serde(default)]
  pub trusted: Vec<TrustEntry>,
}

impl TrustData {
  /// A missing or corrupt file trusts nothing.
  pub fn load(file: &Path) -> Self {
    std::fs::read(file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
  }

  pub fn save(&self, file: &Path) -> Result<(), String> {
    let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
    write_atomic(file, &text).map_err(|e| format!("บันทึกการเชื่อถือ snap ไม่สำเร็จ: {e}"))
  }

  pub fn is_trusted(&self, root: &Path, id: &str, sha256: &str) -> bool {
    self.trusted.iter().any(|t| t.root == root && t.id == id && t.sha256 == sha256)
  }

  /// Trusts exactly this manifest (`Some(hash)`), or revokes trust (`None`).
  pub fn set(&mut self, root: &Path, id: &str, sha256: Option<&str>) {
    self.trusted.retain(|t| !(t.root == root && t.id == id));
    if let Some(sha256) = sha256 {
      self.trusted.push(TrustEntry { root: root.to_path_buf(), id: id.to_string(), sha256: sha256.to_string() });
    }
  }
}

/// Serializes read-modify-write of the trust file.
static TRUST_LOCK: Mutex<()> = Mutex::new(());

/// Trusts (or untrusts) the repo snap `id` of `root`. `expected` is the hash the user was shown:
/// if the manifest changed since, nothing is trusted.
pub fn set_trust(config_dir: &Path, root: &Path, id: &str, trusted: bool, expected: Option<&str>) -> Result<(), String> {
  if !is_snap_id(id) {
    return Err(format!("id \"{id}\" ไม่ถูกต้อง"));
  }
  let file = config_dir.join(TRUST_FILE);
  let _guard = TRUST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  let mut data = TrustData::load(&file);
  if trusted {
    let dir = repo_snaps_dir(root).ok_or("โฟลเดอร์นี้ไม่มี .kingu/snaps")?;
    let snap = scan(&dir, Source::Repo, Some(root), &data).into_iter().find(|s| s.id == id).ok_or_else(|| format!("ไม่พบ snap \"{id}\" ในโฟลเดอร์นี้"))?;
    if let Some(e) = &snap.error {
      return Err(format!("snap \"{id}\" มีข้อผิดพลาด เชื่อถือไม่ได้: {e}"));
    }
    if expected.is_some_and(|h| h != snap.hash) {
      return Err(format!("{MANIFEST} ของ snap \"{id}\" เปลี่ยนไปแล้ว — โหลด Snaps ใหม่แล้วตรวจอีกครั้งก่อนเชื่อถือ"));
    }
    data.set(root, id, Some(&snap.hash));
  } else {
    data.set(root, id, None);
  }
  data.save(&file)
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
  app.path().app_config_dir().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn snap_list(app: AppHandle, ws: State<'_, Workspace>) -> Result<Vec<SnapInfo>, String> {
  let config = config_dir(&app)?;
  let trust = TrustData::load(&config.join(TRUST_FILE));
  Ok(discover(&config.join(USER_DIR), ws.current().as_deref(), &trust))
}

#[tauri::command]
pub fn snap_trust(app: AppHandle, ws: State<'_, Workspace>, id: String, trusted: bool, hash: Option<String>) -> Result<(), String> {
  let root = ws.root().map_err(|_| "ยังไม่ได้เปิดโฟลเดอร์".to_string())?;
  set_trust(&config_dir(&app)?, &root, &id, trusted, hash.as_deref())?;
  log::info!("snap {id}: trusted = {trusted} in {}", root.display());
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  const FULL: &str = r#"
id = "go"
name = "Go"
version = "0.1.0"
description = "Go tasks and agent tools"

[permissions]
network = false
fs = "worktree"
secrets = ["GITHUB_TOKEN"]

[[tasks]]
id = "test"
title = "Run tests"
command = ["go", "test", "${setting:testFlags}", "./..."]

[[tasks]]
id = "vet"
title = "Vet"
command = ["go", "vet", "./..."]

[[settings]]
key = "testFlags"
type = "string"
default = "-race"
description = "flags for go test"

[[settings]]
key = "verbose"
type = "boolean"

[[settings]]
key = "count"
type = "number"
default = 3

[mcp.gopls]
command = ["gopls", "mcp"]
env = { GOFLAGS = "-mod=mod" }
"#;

  fn write_snap(dir: &Path, folder: &str, text: &str) -> PathBuf {
    let d = dir.join(folder);
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join(MANIFEST), text).unwrap();
    d
  }

  fn minimal(id: &str) -> String {
    format!("id = \"{id}\"\nname = \"N\"\nversion = \"1\"\n[[tasks]]\nid = \"t\"\ntitle = \"T\"\ncommand = [\"echo\", \"{id}\"]\n")
  }

  #[test]
  fn parses_a_full_manifest() {
    let p = parse_manifest(FULL, "go").unwrap();
    assert_eq!((p.id.as_str(), p.name.as_str(), p.version.as_str()), ("go", "Go", "0.1.0"));
    assert_eq!(p.permissions, Permissions { network: false, fs: FsAccess::Worktree, secrets: vec!["GITHUB_TOKEN".into()] });
    assert_eq!(p.tasks.len(), 2);
    assert_eq!(p.tasks[0].command, ["go", "test", "${setting:testFlags}", "./..."]);
    assert_eq!(p.settings[0].default, serde_json::json!("-race"));
    assert_eq!(p.settings[1].default, serde_json::json!(false));
    assert_eq!(p.settings[2].default, serde_json::json!(3));
    assert_eq!(p.mcp, [McpServer { name: "gopls".into(), command: vec!["gopls".into(), "mcp".into()], env: BTreeMap::from([("GOFLAGS".into(), "-mod=mod".into())]) }]);
    // Serialized for the webview the way snapModel.ts reads it.
    let json = serde_json::to_value(&p.settings[0]).unwrap();
    assert_eq!(json, serde_json::json!({ "key": "testFlags", "type": "string", "default": "-race", "description": "flags for go test" }));
  }

  #[test]
  fn minimal_manifest_defaults() {
    let p = parse_manifest("id = \"x\"\nname = \"X\"\nversion = \"0\"\n", "x").unwrap();
    assert_eq!(p.permissions, Permissions::default());
    assert!(p.tasks.is_empty() && p.settings.is_empty() && p.mcp.is_empty());
  }

  #[test]
  fn id_must_match_folder_and_be_a_slug() {
    assert!(parse_manifest(FULL, "golang").unwrap_err().contains("ต้องตรงกับชื่อโฟลเดอร์"));
    let bad = FULL.replace("id = \"go\"", "id = \"Go\"");
    assert!(parse_manifest(&bad, "Go").unwrap_err().contains("ไม่ถูกต้อง"));
    let long = "a".repeat(41);
    assert!(parse_manifest(&FULL.replace("id = \"go\"", &format!("id = \"{long}\"")), &long).is_err());
    assert!(is_snap_id(&"a".repeat(40)) && is_snap_id("go-1") && !is_snap_id("-go") && !is_snap_id("") && !is_snap_id("../x"));
  }

  #[test]
  fn unknown_fields_are_errors() {
    let e = parse_manifest(&format!("{FULL}\nnmae = \"typo\"\n"), "go").unwrap_err();
    assert!(e.contains("nmae"), "{e}");
    let e = parse_manifest(&FULL.replace("title = \"Vet\"", "title = \"Vet\"\ncmd = [\"x\"]"), "go").unwrap_err();
    assert!(e.contains("cmd"), "{e}");
    assert!(parse_manifest(&FULL.replace("fs = \"worktree\"", "fs = \"everything\""), "go").is_err());
  }

  #[test]
  fn validates_tasks() {
    assert!(parse_manifest(&FULL.replace("id = \"vet\"", "id = \"Vet!\""), "go").unwrap_err().contains("id ของงาน"));
    assert!(parse_manifest(&FULL.replace("id = \"vet\"", "id = \"test\""), "go").unwrap_err().contains("ซ้ำ"));
    assert!(parse_manifest(&FULL.replace("command = [\"go\", \"vet\", \"./...\"]", "command = []"), "go").unwrap_err().contains("command"));
    let e = parse_manifest(&FULL.replace("${setting:testFlags}", "${setting:nope}"), "go").unwrap_err();
    assert!(e.contains("\"nope\""), "{e}");
    assert!(parse_manifest(&FULL.replace("${setting:testFlags}", "${setting:testFlags"), "go").is_err());
  }

  #[test]
  fn validates_settings_and_mcp() {
    assert!(parse_manifest(&FULL.replace("key = \"testFlags\"", "key = \"test-flags\""), "go").unwrap_err().contains("key"));
    assert!(parse_manifest(&FULL.replace("key = \"verbose\"", "key = \"count\""), "go").unwrap_err().contains("ซ้ำ"));
    assert!(parse_manifest(&FULL.replace("default = \"-race\"", "default = 1"), "go").unwrap_err().contains("default"));
    assert!(parse_manifest(&FULL.replace("type = \"boolean\"", "type = \"list\""), "go").is_err());
    assert!(parse_manifest(&FULL.replace("command = [\"gopls\", \"mcp\"]", "command = []"), "go").is_err());
    assert!(parse_manifest(&FULL.replace("[mcp.gopls]", "[mcp.\"go pls\"]"), "go").is_err());
  }

  #[test]
  fn placeholder_parsing() {
    assert_eq!(placeholders("${setting:a}").unwrap(), ["a"]);
    assert_eq!(placeholders("--x=${setting:a},${setting:b}").unwrap(), ["a", "b"]);
    assert!(placeholders("plain $HOME ${other}").unwrap().is_empty());
    assert!(placeholders("${setting:a").is_err());
  }

  #[test]
  fn discovers_user_and_repo_snaps_with_override_and_errors() {
    let config = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let user_dir = config.path().join(USER_DIR);
    write_snap(&user_dir, "go", FULL);
    write_snap(&user_dir, "mine", &minimal("mine"));
    write_snap(&user_dir, "Bad_Name", &minimal("bad"));
    std::fs::create_dir_all(user_dir.join(".hidden")).unwrap();
    std::fs::write(user_dir.join("README.md"), "not a snap").unwrap();
    let repo_dir = root.path().join(".kingu/snaps");
    write_snap(&repo_dir, "go", &minimal("go"));
    write_snap(&repo_dir, "broken", "id = \"broken\"\n");

    let list = discover(&user_dir, Some(root.path()), &TrustData::default());
    let ids: Vec<_> = list.iter().map(|s| (s.id.as_str(), s.source)).collect();
    assert_eq!(ids, [("Bad_Name", Source::User), ("go", Source::User), ("mine", Source::User), ("broken", Source::Repo), ("go", Source::Repo)]);
    assert!(list[0].error.as_deref().unwrap().contains("ชื่อโฟลเดอร์"));
    assert!(list[1].overridden && list[1].trusted);
    assert!(!list[2].overridden && list[2].trusted && list[2].error.is_none());
    assert!(list[3].error.is_some() && list[3].tasks.is_empty() && !list[3].trusted);
    assert!(!list[4].trusted && list[4].error.is_none() && list[4].tasks.len() == 1);
    assert_eq!(list[4].hash.len(), 64);

    // No folder open: user snaps only, nothing overridden.
    let list = discover(&user_dir, None, &TrustData::default());
    assert_eq!(list.len(), 3);
    assert!(list.iter().all(|s| !s.overridden && s.source == Source::User));
  }

  #[test]
  fn trust_is_revoked_when_the_manifest_changes() {
    let config = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let user_dir = config.path().join(USER_DIR);
    let repo_dir = root.path().join(".kingu/snaps");
    let snap = write_snap(&repo_dir, "lint", &minimal("lint"));
    let load = || TrustData::load(&config.path().join(TRUST_FILE));
    let find = |t: &TrustData| discover(&user_dir, Some(root.path()), t).into_iter().find(|s| s.id == "lint").unwrap();

    let shown = find(&load());
    assert!(!shown.trusted);
    // A stale hash (the manifest changed after the user looked at it) trusts nothing.
    assert!(set_trust(config.path(), root.path(), "lint", true, Some("0".repeat(64).as_str())).unwrap_err().contains("เปลี่ยน"));
    assert!(!find(&load()).trusted);
    set_trust(config.path(), root.path(), "lint", true, Some(&shown.hash)).unwrap();
    assert!(find(&load()).trusted);
    // Trust is per folder.
    let other = tempfile::tempdir().unwrap();
    write_snap(&other.path().join(".kingu/snaps"), "lint", &minimal("lint"));
    assert!(!discover(&user_dir, Some(other.path()), &load())[0].trusted);

    std::fs::write(snap.join(MANIFEST), minimal("lint").replace("echo", "rm")).unwrap();
    assert!(!find(&load()).trusted);
    // Re-trusting the new manifest, then untrusting.
    let shown = find(&load());
    set_trust(config.path(), root.path(), "lint", true, Some(&shown.hash)).unwrap();
    assert!(find(&load()).trusted);
    assert_eq!(load().trusted.len(), 1);
    set_trust(config.path(), root.path(), "lint", false, None).unwrap();
    assert!(!find(&load()).trusted);
    assert!(load().trusted.is_empty());
  }

  #[test]
  fn refuses_to_trust_broken_or_missing_snaps() {
    let config = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    assert!(set_trust(config.path(), root.path(), "x", true, None).is_err());
    write_snap(&root.path().join(".kingu/snaps"), "x", "id = \"x\"\n");
    assert!(set_trust(config.path(), root.path(), "x", true, None).unwrap_err().contains("ข้อผิดพลาด"));
    assert!(set_trust(config.path(), root.path(), "../x", true, None).is_err());
  }

  #[test]
  fn corrupt_trust_file_trusts_nothing() {
    let config = tempfile::tempdir().unwrap();
    std::fs::write(config.path().join(TRUST_FILE), "{ not json").unwrap();
    assert_eq!(TrustData::load(&config.path().join(TRUST_FILE)), TrustData::default());
  }

  #[cfg(unix)]
  #[test]
  fn never_follows_symlinks_out_of_the_snaps_dirs() {
    use std::os::unix::fs::symlink;
    let outside = tempfile::tempdir().unwrap();
    let evil = write_snap(outside.path(), "evil", &minimal("evil"));

    // A symlinked snap folder is listed as broken.
    let root = tempfile::tempdir().unwrap();
    let repo_dir = root.path().join(".kingu/snaps");
    std::fs::create_dir_all(&repo_dir).unwrap();
    symlink(&evil, repo_dir.join("evil")).unwrap();
    // A symlinked manifest too.
    std::fs::create_dir_all(repo_dir.join("link")).unwrap();
    symlink(evil.join(MANIFEST), repo_dir.join("link").join(MANIFEST)).unwrap();
    let list = discover(&outside.path().join("none"), Some(root.path()), &TrustData::default());
    assert_eq!(list.len(), 2);
    assert!(list.iter().all(|s| s.error.is_some() && s.tasks.is_empty()));
    assert!(set_trust(outside.path(), root.path(), "evil", true, None).is_err());

    // A symlinked `.kingu/snaps` (or `.kingu`) is ignored entirely.
    let root2 = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root2.path().join(".kingu")).unwrap();
    symlink(outside.path(), root2.path().join(".kingu/snaps")).unwrap();
    assert!(discover(&outside.path().join("none"), Some(root2.path()), &TrustData::default()).is_empty());
    let root3 = tempfile::tempdir().unwrap();
    symlink(root.path().join(".kingu"), root3.path().join(".kingu")).unwrap();
    assert!(repo_snaps_dir(root3.path()).is_none());
  }
}
