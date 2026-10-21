//! Managed data accounts for OpenCode and Devin (Orca's ManagedDataAccountsSection).
//!
//! An account is a private XDG data/state home: `kingu account add --agent opencode|devin` runs
//! the CLI's own login with a temporary XDG home, then hands that home to the app, which keeps
//! only the login (OpenCode's `credential` rows, Devin's `credentials.toml`) in a new profile
//! folder. Agents started from Kingu get the selected profile's XDG home, so their login and
//! conversations stay in it; "System default" (no selection) leaves the user's own login alone.
//!
//! Layout: `<app data>/managed-data-accounts/<provider>/accounts.json` and
//! `<provider>/<uuid>/{data,state}`. Secrets stay in the CLIs' own files (mode 0600); Kingu never
//! reads their values, it only checks their shape.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::i18n::msg::ProvidersMsg;
use crate::tr;

pub const DIR: &str = "managed-data-accounts";
pub const MAX_ACCOUNTS: usize = 64;
const MAX_DEVIN_FILE: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataProvider {
  Opencode,
  Devin,
}

impl DataProvider {
  pub const ALL: [Self; 2] = [Self::Opencode, Self::Devin];

  pub fn parse(s: &str) -> Result<Self, String> {
    match s {
      "opencode" => Ok(Self::Opencode),
      "devin" => Ok(Self::Devin),
      _ => Err(tr!(ProvidersMsg::UnknownDataProvider)),
    }
  }

  pub fn name(self) -> &'static str {
    match self {
      Self::Opencode => "opencode",
      Self::Devin => "devin",
    }
  }

  /// The provider of an agent program (`opencode`, `opencode2`, `devin`); anything else is none.
  pub fn of_program(program: &str) -> Option<Self> {
    match program.rsplit('/').next().unwrap_or(program) {
      "opencode" | "opencode2" => Some(Self::Opencode),
      "devin" => Some(Self::Devin),
      _ => None,
    }
  }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
  pub id: String,
  pub label: String,
  #[serde(default)]
  pub integrations: Vec<String>,
  pub created_at: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
  pub accounts: Vec<Summary>,
  /// None: System default (the user's own login).
  pub active_account_id: Option<String>,
}

pub struct Managed {
  root: PathBuf,
  /// Mutations one at a time (the CLI and the window may both write).
  lock: Mutex<()>,
}

impl Managed {
  pub fn new(root: PathBuf) -> Self {
    Self { root, lock: Mutex::new(()) }
  }

  fn dir(&self, p: DataProvider) -> PathBuf {
    self.root.join(p.name())
  }

  fn state_file(&self, p: DataProvider) -> PathBuf {
    self.dir(p).join("accounts.json")
  }

  /// A profile folder; the id is checked so it can never leave the provider folder.
  fn profile(&self, p: DataProvider, id: &str) -> Result<PathBuf, String> {
    if !is_uuid(id) {
      return Err(tr!(ProvidersMsg::AccountNotFound));
    }
    Ok(self.dir(p).join(id.to_ascii_lowercase()))
  }

  pub fn load(&self, p: DataProvider) -> Result<State, String> {
    let file = self.state_file(p);
    let text = match std::fs::read_to_string(&file) {
      Ok(t) => t,
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(State::default()),
      Err(e) => return Err(tr!(ProvidersMsg::BadState, provider = p.name(), detail = e)),
    };
    let mut state: State = serde_json::from_str(&text).map_err(|e| tr!(ProvidersMsg::BadState, provider = p.name(), detail = e))?;
    state.accounts.retain(|a| is_uuid(&a.id));
    if state.active_account_id.as_deref().is_some_and(|id| !state.accounts.iter().any(|a| a.id.eq_ignore_ascii_case(id))) {
      state.active_account_id = None;
    }
    Ok(state)
  }

  fn save(&self, p: DataProvider, state: &State) -> Result<(), String> {
    let dir = self.dir(p);
    private_dir(&dir).map_err(|e| tr!(ProvidersMsg::SaveFailed, detail = e))?;
    let text = serde_json::to_string_pretty(state).map_err(|e| tr!(ProvidersMsg::SaveFailed, detail = e))?;
    let tmp = dir.join(format!("accounts.json.{}.tmp", std::process::id()));
    write_private(&tmp, text.as_bytes()).map_err(|e| tr!(ProvidersMsg::SaveFailed, detail = e))?;
    std::fs::rename(&tmp, self.state_file(p)).map_err(|e| tr!(ProvidersMsg::SaveFailed, detail = e))
  }

  /// Both providers' accounts (`accounts.listData`).
  pub fn list(&self) -> BTreeMap<String, State> {
    DataProvider::ALL.iter().map(|&p| (p.name().to_owned(), self.load(p).unwrap_or_default())).collect()
  }

  /// Picks the account new agent launches use; None is System default.
  pub fn select(&self, p: DataProvider, id: Option<&str>) -> Result<State, String> {
    let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut state = self.load(p)?;
    state.active_account_id = match id {
      None => None,
      Some(id) => Some(state.accounts.iter().find(|a| a.id.eq_ignore_ascii_case(id)).ok_or_else(|| tr!(ProvidersMsg::AccountNotFound))?.id.clone()),
    };
    self.save(p, &state)?;
    Ok(state)
  }

  /// Forgets an account and deletes its folder (its login and conversations); the selection falls
  /// back to System default when it was the one in use.
  pub fn remove(&self, p: DataProvider, id: &str) -> Result<State, String> {
    let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
    let dir = self.profile(p, id)?;
    let mut state = self.load(p)?;
    let before = state.accounts.len();
    state.accounts.retain(|a| !a.id.eq_ignore_ascii_case(id));
    if state.accounts.len() == before {
      return Err(tr!(ProvidersMsg::AccountNotFound));
    }
    if state.active_account_id.as_deref().is_some_and(|a| a.eq_ignore_ascii_case(id)) {
      state.active_account_id = None;
    }
    self.save(p, &state)?;
    // Out of the way first (a rename cannot half-fail), then deleted.
    if std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
      let pending = self.dir(p).join(".pending-delete");
      let _ = std::fs::create_dir_all(&pending);
      let gone = pending.join(id.to_ascii_lowercase());
      std::fs::rename(&dir, &gone).map_err(|e| tr!(ProvidersMsg::RemoveFailed, detail = e))?;
      if let Err(e) = std::fs::remove_dir_all(&gone) {
        log::warn!("managed account folder left in .pending-delete: {e}");
      }
    }
    Ok(state)
  }

  /// Registers the login a CLI saved under `source_data_home` (an XDG data home) as a new account,
  /// which becomes the selected one (`accounts.addDataFromHome`).
  pub fn add_from_home(&self, p: DataProvider, source_data_home: &Path, label: &str, now: u64) -> Result<State, String> {
    let label = label.trim();
    if label.is_empty() || label.chars().count() > 120 {
      return Err(tr!(ProvidersMsg::BadLabel));
    }
    let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut state = self.load(p)?;
    if state.accounts.len() >= MAX_ACCOUNTS {
      return Err(tr!(ProvidersMsg::AccountLimit));
    }
    let id = new_uuid();
    let dir = self.profile(p, &id)?;
    private_dir(&dir).map_err(|e| tr!(ProvidersMsg::CopyFailed, detail = e))?;
    let captured = match p {
      DataProvider::Devin => capture_devin(source_data_home, &dir),
      DataProvider::Opencode => capture_opencode(source_data_home, &dir),
    };
    let integrations = match captured {
      Ok(i) => i,
      Err(e) => {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
      }
    };
    state.accounts.push(Summary { id: id.clone(), label: label.to_owned(), integrations, created_at: now });
    state.active_account_id = Some(id);
    if let Err(e) = self.save(p, &state) {
      let _ = std::fs::remove_dir_all(&dir);
      return Err(e);
    }
    Ok(state)
  }

  /// The env an agent program gets: the selected profile's XDG homes (and, for OpenCode, its own
  /// database with inline auth turned off, so neither can bypass the profile). Empty for System
  /// default and for other programs.
  pub fn env_for_program(&self, program: &str) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    let Some(p) = DataProvider::of_program(program) else { return env };
    let Some(id) = self.load(p).ok().and_then(|s| s.active_account_id) else { return env };
    let Ok(dir) = self.profile(p, &id) else { return env };
    env.insert("XDG_DATA_HOME".into(), dir.join("data").display().to_string());
    env.insert("XDG_STATE_HOME".into(), dir.join("state").display().to_string());
    if p == DataProvider::Opencode {
      env.insert("OPENCODE_DB".into(), "opencode.db".into());
      env.insert("OPENCODE_AUTH_CONTENT".into(), String::new());
    }
    env
  }
}

// ---- capturing a login -----------------------------------------------------------------------

fn capture_devin(source: &Path, dir: &Path) -> Result<Vec<String>, String> {
  let src = source.join("devin/credentials.toml");
  let meta = std::fs::symlink_metadata(&src).map_err(|_| tr!(ProvidersMsg::DevinNoCredentials))?;
  if !meta.is_file() || meta.len() > MAX_DEVIN_FILE {
    return Err(tr!(ProvidersMsg::DevinNoCredentials));
  }
  let text = std::fs::read_to_string(&src).map_err(|_| tr!(ProvidersMsg::DevinNoCredentials))?;
  let table: toml::Table = toml::from_str(&text).map_err(|_| tr!(ProvidersMsg::DevinBadFormat))?;
  if !table.get("windsurf_api_key").and_then(|v| v.as_str()).is_some_and(|k| !k.trim().is_empty()) {
    return Err(tr!(ProvidersMsg::DevinNoCredentials));
  }
  let dest_dir = dir.join("data/devin");
  private_dir(&dest_dir).map_err(|e| tr!(ProvidersMsg::CopyFailed, detail = e))?;
  write_private(&dest_dir.join("credentials.toml"), text.as_bytes()).map_err(|e| tr!(ProvidersMsg::CopyFailed, detail = e))?;
  Ok(vec!["devin".into()])
}

/// Tables a fresh login leaves empty; rows in them mean a conversation database was handed in.
const CONVERSATION_TABLES: &[&str] = &[
  "session",
  "session_v2",
  "message",
  "part",
  "todo",
  "session_message",
  "session_pending",
  "session_inbox",
  "session_input",
  "session_context_epoch",
  "instruction_blob",
  "instruction_entry",
  "instruction_state",
  "event",
];

fn capture_opencode(source: &Path, dir: &Path) -> Result<Vec<String>, String> {
  let src = source.join("opencode/opencode.db");
  if !std::fs::symlink_metadata(&src).is_ok_and(|m| m.is_file()) {
    return Err(tr!(ProvidersMsg::OpencodeNoCredential));
  }
  audit_opencode(&src)?;
  let dest_dir = dir.join("data/opencode");
  private_dir(&dest_dir).map_err(|e| tr!(ProvidersMsg::CopyFailed, detail = e))?;
  let dest = dest_dir.join("opencode.db");
  write_private(&dest, b"").map_err(|e| tr!(ProvidersMsg::CopyFailed, detail = e))?;
  // SQLite's own backup: a consistent copy even if the CLI still has the file open.
  let backup = format!(".backup '{}'", dest.display().to_string().replace('\'', "''"));
  let out = Command::new(SQLITE).arg(&src).arg(&backup).output().map_err(|e| tr!(ProvidersMsg::Sqlite, detail = e))?;
  if !out.status.success() {
    remove_db(&dest);
    return Err(tr!(ProvidersMsg::Sqlite, detail = String::from_utf8_lossy(&out.stderr).trim()));
  }
  match audit_opencode(&dest) {
    Ok(integrations) => Ok(integrations),
    Err(e) => {
      remove_db(&dest);
      Err(e)
    }
  }
}

fn remove_db(db: &Path) {
  for suffix in ["", "-wal", "-shm"] {
    let _ = std::fs::remove_file(format!("{}{suffix}", db.display()));
  }
}

/// Checks an OpenCode database holds only a login: a known schema, no conversations, and 1–64
/// credentials of a known shape. Returns the integrations it signs in to.
fn audit_opencode(db: &Path) -> Result<Vec<String>, String> {
  let tables: Vec<String> = sqlite_rows(db, "SELECT name FROM sqlite_master WHERE type='table'")?
    .iter()
    .filter_map(|r| r.get("name").and_then(Value::as_str).map(str::to_owned))
    .collect();
  if !tables.iter().any(|t| t == "session" || t == "session_v2") || !tables.iter().any(|t| t == "credential") {
    return Err(tr!(ProvidersMsg::OpencodeBadDb));
  }
  for table in CONVERSATION_TABLES.iter().filter(|t| tables.iter().any(|x| x == *t)) {
    let rows = sqlite_rows(db, &format!("SELECT count(*) AS n FROM \"{table}\""))?;
    if rows.first().and_then(|r| r.get("n")).and_then(Value::as_u64).unwrap_or(1) > 0 {
      return Err(tr!(ProvidersMsg::OpencodeHasSessions));
    }
  }
  let creds = sqlite_rows(db, "SELECT integration_id, value FROM credential LIMIT 65")?;
  if creds.is_empty() || creds.len() > 64 {
    return Err(tr!(ProvidersMsg::OpencodeNoCredential));
  }
  let mut integrations = Vec::new();
  for row in &creds {
    let value = row.get("value").and_then(Value::as_str).and_then(|v| serde_json::from_str::<Value>(v).ok()).ok_or_else(|| tr!(ProvidersMsg::OpencodeBadCredential))?;
    if !opencode_credential_ok(&value) {
      return Err(tr!(ProvidersMsg::OpencodeBadCredential));
    }
    if let Some(id) = row.get("integration_id").and_then(Value::as_str) {
      integrations.push(id.to_owned());
    }
  }
  Ok(integrations)
}

/// `{type:"key"|"api", key}`, `{type:"oauth", access, refresh, expires>=0}` or `{type:"wellknown", key, token}`.
pub fn opencode_credential_ok(v: &Value) -> bool {
  let s = |k: &str| v.get(k).and_then(Value::as_str).is_some_and(|x| !x.is_empty());
  match v.get("type").and_then(Value::as_str) {
    Some("key" | "api") => s("key"),
    Some("oauth") => s("access") && s("refresh") && v.get("expires").and_then(Value::as_f64).is_some_and(|e| e >= 0.0),
    Some("wellknown") => s("key") && s("token"),
    _ => false,
  }
}

const SQLITE: &str = "/usr/bin/sqlite3";

/// Rows of a read-only query through the system `sqlite3` (JSON output).
fn sqlite_rows(db: &Path, sql: &str) -> Result<Vec<serde_json::Map<String, Value>>, String> {
  let out = Command::new(SQLITE)
    .args(["-readonly", "-json", "-cmd", ".timeout 1500"])
    .arg(db)
    .arg(sql)
    .output()
    .map_err(|e| tr!(ProvidersMsg::Sqlite, detail = e))?;
  if !out.status.success() {
    return Err(tr!(ProvidersMsg::Sqlite, detail = String::from_utf8_lossy(&out.stderr).trim()));
  }
  let text = String::from_utf8_lossy(&out.stdout);
  if text.trim().is_empty() {
    return Ok(Vec::new());
  }
  serde_json::from_str(&text).map_err(|e| tr!(ProvidersMsg::Sqlite, detail = e))
}

// ---- small helpers ---------------------------------------------------------------------------

pub fn is_uuid(s: &str) -> bool {
  let b = s.as_bytes();
  b.len() == 36 && b.iter().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { *c == b'-' } else { c.is_ascii_hexdigit() })
}

/// A random (v4) UUID.
pub fn new_uuid() -> String {
  let mut b = [0u8; 16];
  if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_err() {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    b = n.to_le_bytes();
  }
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
  format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn private_dir(dir: &Path) -> std::io::Result<()> {
  std::fs::create_dir_all(dir)?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
  }
  Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
  use std::io::Write;
  let mut opts = std::fs::OpenOptions::new();
  opts.write(true).create(true).truncate(true);
  #[cfg(unix)]
  std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
  let mut f = opts.open(path)?;
  f.write_all(bytes)?;
  f.sync_all()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn managed() -> (tempfile::TempDir, Managed) {
    let dir = tempfile::tempdir().unwrap();
    let m = Managed::new(dir.path().join(DIR));
    (dir, m)
  }

  fn devin_home(dir: &Path, key: &str) -> PathBuf {
    let home = dir.join("login/data");
    std::fs::create_dir_all(home.join("devin")).unwrap();
    std::fs::write(home.join("devin/credentials.toml"), format!("windsurf_api_key = \"{key}\"\n")).unwrap();
    home
  }

  #[test]
  fn adds_selects_and_removes_a_devin_account() {
    let (tmp, m) = managed();
    let home = devin_home(tmp.path(), "sk-1");
    let state = m.add_from_home(DataProvider::Devin, &home, " work ", 5).unwrap();
    assert_eq!(state.accounts.len(), 1);
    let id = state.accounts[0].id.clone();
    assert_eq!(state.accounts[0].label, "work");
    assert_eq!(state.accounts[0].integrations, vec!["devin".to_string()]);
    assert_eq!(state.active_account_id.as_deref(), Some(id.as_str()));
    let saved = m.profile(DataProvider::Devin, &id).unwrap().join("data/devin/credentials.toml");
    assert!(saved.is_file());

    let env = m.env_for_program("/usr/local/bin/devin");
    assert!(env["XDG_DATA_HOME"].ends_with(&format!("{id}/data")));
    assert!(!env.contains_key("OPENCODE_DB"));
    assert!(m.env_for_program("claude").is_empty());

    assert_eq!(m.select(DataProvider::Devin, None).unwrap().active_account_id, None);
    assert!(m.env_for_program("devin").is_empty());
    assert!(m.select(DataProvider::Devin, Some("00000000-0000-4000-8000-000000000000")).is_err());

    let state = m.remove(DataProvider::Devin, &id).unwrap();
    assert!(state.accounts.is_empty());
    assert!(!saved.exists());
  }

  #[test]
  fn refuses_bad_devin_logins_and_labels() {
    let (tmp, m) = managed();
    let home = devin_home(tmp.path(), "");
    assert_eq!(m.add_from_home(DataProvider::Devin, &home, "x", 0).unwrap_err(), tr!(ProvidersMsg::DevinNoCredentials));
    std::fs::write(home.join("devin/credentials.toml"), "not = [toml").unwrap();
    assert_eq!(m.add_from_home(DataProvider::Devin, &home, "x", 0).unwrap_err(), tr!(ProvidersMsg::DevinBadFormat));
    assert_eq!(m.add_from_home(DataProvider::Devin, &home, "  ", 0).unwrap_err(), tr!(ProvidersMsg::BadLabel));
    // A failed add leaves no profile folder behind.
    let dir = m.dir(DataProvider::Devin);
    let left: Vec<_> = std::fs::read_dir(&dir).map(|d| d.filter_map(Result::ok).filter(|e| e.path().is_dir()).collect()).unwrap_or_default();
    assert!(left.is_empty());
  }

  #[test]
  fn validates_opencode_credentials() {
    assert!(opencode_credential_ok(&serde_json::json!({"type": "api", "key": "k"})));
    assert!(opencode_credential_ok(&serde_json::json!({"type": "oauth", "access": "a", "refresh": "r", "expires": 0})));
    assert!(opencode_credential_ok(&serde_json::json!({"type": "wellknown", "key": "k", "token": "t"})));
    assert!(!opencode_credential_ok(&serde_json::json!({"type": "oauth", "access": "a"})));
    assert!(!opencode_credential_ok(&serde_json::json!({"type": "magic", "key": "k"})));
  }

  #[test]
  fn imports_an_opencode_login_and_refuses_conversations() {
    if !Path::new(SQLITE).exists() {
      return;
    }
    let (tmp, m) = managed();
    let home = tmp.path().join("login/data");
    std::fs::create_dir_all(home.join("opencode")).unwrap();
    let db = home.join("opencode/opencode.db");
    let sql = "CREATE TABLE session(id TEXT); CREATE TABLE message(id TEXT); CREATE TABLE credential(integration_id TEXT, value TEXT); \
               INSERT INTO credential VALUES('opencode-go', '{\"type\":\"api\",\"key\":\"k\"}');";
    assert!(Command::new(SQLITE).arg(&db).arg(sql).status().unwrap().success());
    let state = m.add_from_home(DataProvider::Opencode, &home, "go", 1).unwrap();
    assert_eq!(state.accounts[0].integrations, vec!["opencode-go".to_string()]);
    let env = m.env_for_program("opencode");
    assert_eq!(env["OPENCODE_DB"], "opencode.db");
    assert_eq!(env["OPENCODE_AUTH_CONTENT"], "");

    assert!(Command::new(SQLITE).arg(&db).arg("INSERT INTO message VALUES('m1');").status().unwrap().success());
    assert_eq!(m.add_from_home(DataProvider::Opencode, &home, "go", 1).unwrap_err(), tr!(ProvidersMsg::OpencodeHasSessions));
  }

  #[test]
  fn uuids() {
    let id = new_uuid();
    assert!(is_uuid(&id), "{id}");
    assert_eq!(&id[14..15], "4");
    assert!(!is_uuid("../../etc/passwd/../../../x-y"));
  }
}
