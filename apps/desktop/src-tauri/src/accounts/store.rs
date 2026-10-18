//! AI provider accounts (Orca's "Manage Accounts"): metadata in `<config>/ai-accounts.json`, one
//! config folder per subscription account under `<data>/ai-accounts/<provider>/<id>` (the agent's
//! `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, where the CLI keeps its own login), and API keys only in
//! the Keychain (`secrets.rs`). No account, or none active, means today's behaviour: the agent
//! uses the user's own `~/.claude` / `~/.codex`.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const FILE: &str = "ai-accounts.json";
pub const DIR: &str = "ai-accounts";
const MAX_LABEL: usize = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
  Claude,
  Codex,
}

impl Provider {
  pub fn parse(s: &str) -> Result<Self, String> {
    match s {
      "claude" => Ok(Self::Claude),
      "codex" => Ok(Self::Codex),
      _ => Err(format!("ไม่รู้จักผู้ให้บริการ {s}")),
    }
  }

  pub fn as_str(self) -> &'static str {
    match self {
      Self::Claude => "claude",
      Self::Codex => "codex",
    }
  }

  pub fn title(self) -> &'static str {
    match self {
      Self::Claude => "Claude",
      Self::Codex => "Codex",
    }
  }

  /// The provider whose account an agent CLI uses, by program name (`claude`, `/opt/bin/codex`).
  pub fn of_program(program: &str) -> Option<Self> {
    match program.rsplit('/').next().unwrap_or(program) {
      "claude" => Some(Self::Claude),
      "codex" => Some(Self::Codex),
      _ => None,
    }
  }
}

/// `subscription`: the CLI's own login (Claude Pro/Max via claude.ai, ChatGPT for Codex), kept in
/// the account's folder. `api_key`: a key in the Keychain, given to the agent as an env var.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
  Subscription,
  ApiKey,
}

impl Kind {
  pub fn parse(s: &str) -> Result<Self, String> {
    match s {
      "subscription" => Ok(Self::Subscription),
      "api_key" => Ok(Self::ApiKey),
      _ => Err(format!("ไม่รู้จักชนิดบัญชี {s}")),
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
  pub id: String,
  pub provider: Provider,
  pub kind: Kind,
  pub label: String,
  pub created_at: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Data {
  #[serde(default)]
  pub accounts: Vec<Account>,
  /// The account agents use, per provider. Missing: the user's own login (`~/.claude`, `~/.codex`).
  #[serde(default)]
  pub active: BTreeMap<Provider, String>,
}

/// 12 lowercase hex characters: path- and keychain-safe.
pub fn valid_id(id: &str) -> bool {
  id.len() == 12 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn new_id(seed: u64) -> String {
  use std::sync::atomic::{AtomicU64, Ordering};
  static COUNTER: AtomicU64 = AtomicU64::new(0);
  let mut h = Sha256::new();
  h.update(seed.to_le_bytes());
  h.update(std::process::id().to_le_bytes());
  h.update(COUNTER.fetch_add(1, Ordering::Relaxed).to_le_bytes());
  let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
  h.update(nanos.to_le_bytes());
  h.finalize().iter().take(6).map(|b| format!("{b:02x}")).collect()
}

pub fn clean_label(label: &str) -> Result<String, String> {
  let label: String = label.trim().chars().filter(|c| !c.is_control()).collect();
  if label.is_empty() {
    return Err("ตั้งชื่อบัญชีก่อน".into());
  }
  if label.chars().count() > MAX_LABEL {
    return Err(format!("ชื่อบัญชียาวเกิน {MAX_LABEL} ตัวอักษร"));
  }
  Ok(label)
}

/// The account folder (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) under `root` (`<data>/ai-accounts`).
pub fn account_dir(root: &Path, provider: Provider, id: &str) -> PathBuf {
  root.join(provider.as_str()).join(id)
}

pub struct Store {
  path: PathBuf,
  pub data: Data,
}

impl Store {
  /// A missing or unreadable file is an empty store (the agents keep using the user's own login).
  pub fn load(path: PathBuf) -> Self {
    let data = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str::<Data>(&s).ok()).unwrap_or_default();
    let mut store = Self { path, data };
    store.prune();
    store
  }

  /// Drops entries with a bad id and active pointers to accounts that are gone.
  fn prune(&mut self) {
    self.data.accounts.retain(|a| valid_id(&a.id));
    let data = &mut self.data;
    let ids: Vec<(Provider, String)> = data.accounts.iter().map(|a| (a.provider, a.id.clone())).collect();
    data.active.retain(|p, id| ids.iter().any(|(q, i)| q == p && i == id));
  }

  pub fn save(&self) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&self.data).map_err(|e| e.to_string())?;
    write_atomic(&self.path, text.as_bytes()).map_err(|e| format!("บันทึกรายการบัญชีไม่สำเร็จ: {e}"))
  }

  pub fn get(&self, id: &str) -> Result<&Account, String> {
    self.data.accounts.iter().find(|a| a.id == id).ok_or_else(|| "ไม่พบบัญชีนี้แล้ว".to_owned())
  }

  pub fn add(&mut self, provider: Provider, kind: Kind, label: &str, now: u64) -> Result<Account, String> {
    let label = clean_label(label)?;
    let account = Account { id: new_id(now), provider, kind, label, created_at: now };
    self.data.accounts.push(account.clone());
    Ok(account)
  }

  pub fn remove(&mut self, id: &str) -> Result<Account, String> {
    let i = self.data.accounts.iter().position(|a| a.id == id).ok_or("ไม่พบบัญชีนี้แล้ว")?;
    let account = self.data.accounts.remove(i);
    self.prune();
    Ok(account)
  }

  /// `None`: back to the user's own login for that provider.
  pub fn set_active(&mut self, provider: Provider, id: Option<&str>) -> Result<(), String> {
    match id {
      None => {
        self.data.active.remove(&provider);
      }
      Some(id) => {
        let a = self.get(id)?;
        if a.provider != provider {
          return Err("บัญชีนี้เป็นของผู้ให้บริการอื่น".into());
        }
        self.data.active.insert(provider, id.to_owned());
      }
    }
    Ok(())
  }

  pub fn active(&self, provider: Provider) -> Option<&Account> {
    self.data.active.get(&provider).and_then(|id| self.get(id).ok())
  }
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
  if let Some(dir) = path.parent() {
    std::fs::create_dir_all(dir)?;
  }
  let tmp = path.with_extension("tmp");
  {
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
  }
  std::fs::rename(&tmp, path)
}

// ---- what an agent process gets ------------------------------------------------------------

/// Env for an agent of `provider`: variables to set, and auth variables to clear so a key in the
/// user's shell does not override the chosen account. Empty for "no active account".
#[derive(Clone, Default, PartialEq, Eq)]
pub struct AgentEnv {
  pub set: BTreeMap<String, String>,
  pub unset: Vec<String>,
}

/// Never prints values: an API key may be in there.
impl std::fmt::Debug for AgentEnv {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("AgentEnv").field("set", &self.set.keys().collect::<Vec<_>>()).field("unset", &self.unset).finish()
  }
}

impl AgentEnv {
  #[cfg(test)]
  pub fn is_empty(&self) -> bool {
    self.set.is_empty() && self.unset.is_empty()
  }

  /// For a PTY, whose env can only be set: cleared variables become empty strings (an empty key
  /// counts as unset for both CLIs).
  pub fn for_shell(&self) -> BTreeMap<String, String> {
    let mut out: BTreeMap<String, String> = self.unset.iter().map(|k| (k.clone(), String::new())).collect();
    out.extend(self.set.clone());
    out
  }
}

/// Auth variables that would override a subscription login (Orca strips the same for Claude).
pub const CLAUDE_AUTH_VARS: &[&str] = &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
pub const CODEX_AUTH_VARS: &[&str] = &["OPENAI_API_KEY"];

/// The env for `account` (`None` = no active account, nothing changes). `api_key` is the
/// Keychain secret of an API-key account; without it the account cannot run.
pub fn agent_env(account: Option<&Account>, root: &Path, api_key: Option<String>) -> Result<AgentEnv, String> {
  let Some(a) = account else { return Ok(AgentEnv::default()) };
  let mut env = AgentEnv::default();
  let auth_vars = match a.provider {
    Provider::Claude => CLAUDE_AUTH_VARS,
    Provider::Codex => CODEX_AUTH_VARS,
  };
  match a.kind {
    Kind::Subscription => {
      let dir = account_dir(root, a.provider, &a.id);
      let var = match a.provider {
        Provider::Claude => "CLAUDE_CONFIG_DIR",
        Provider::Codex => "CODEX_HOME",
      };
      env.set.insert(var.into(), dir.to_str().ok_or("path ของบัญชีไม่ใช่ UTF-8")?.to_owned());
      env.unset = auth_vars.iter().map(|s| (*s).to_owned()).collect();
    }
    Kind::ApiKey => {
      let key = api_key.filter(|k| !k.is_empty()).ok_or_else(|| format!("บัญชี {} ยังไม่มี API key ใน Keychain", a.label))?;
      env.set.insert(auth_vars[0].into(), key);
      if a.provider == Provider::Claude {
        // An auth token would win over the key.
        env.unset = vec!["ANTHROPIC_AUTH_TOKEN".into()];
      }
    }
  }
  Ok(env)
}

/// The login command for a subscription account, typed into a Kingu terminal (Orca runs the same
/// CLI login with the account's folder). `env` because a quoted `VAR=value` is not an assignment.
pub fn login_argv(a: &Account, root: &Path) -> Result<Vec<String>, String> {
  if a.kind != Kind::Subscription {
    return Err("บัญชี API key ไม่ต้อง login ใช้ \"ตั้ง API key\" แทน".into());
  }
  let dir = account_dir(root, a.provider, &a.id);
  let dir = dir.to_str().ok_or("path ของบัญชีไม่ใช่ UTF-8")?;
  Ok(match a.provider {
    Provider::Claude => vec!["env".into(), format!("CLAUDE_CONFIG_DIR={dir}"), "claude".into(), "auth".into(), "login".into(), "--claudeai".into()],
    Provider::Codex => vec!["env".into(), format!("CODEX_HOME={dir}"), "codex".into(), "login".into()],
  })
}

/// API keys: `sk-ant-…` for Anthropic, `sk-…` for OpenAI; printable ASCII, no spaces.
pub fn validate_api_key(provider: Provider, key: &str) -> Result<(), String> {
  let ok_chars = key.len() >= 20 && key.len() <= 512 && key.bytes().all(|b| b.is_ascii_graphic());
  let prefix = match provider {
    Provider::Claude => "sk-ant-",
    Provider::Codex => "sk-",
  };
  if ok_chars && key.starts_with(prefix) { Ok(()) } else { Err(format!("API key ของ {} ต้องขึ้นต้นด้วย {prefix}", provider.title())) }
}

// ---- account folder setup ------------------------------------------------------------------

/// Shared with the user's own Claude folder so history, `--resume` and personal settings follow
/// whichever account runs (Orca links the same session folders into each account).
const CLAUDE_SHARED: &[&str] = &[
  "settings.json",
  "CLAUDE.md",
  "agents",
  "commands",
  "skills",
  "plugins",
  "projects",
  "todos",
  "plans",
  "shell-snapshots",
  "file-history",
  "session-env",
  "paste-cache",
  "tasks",
  "transcripts",
];

/// Keys of `.claude.json` that belong to one login (Orca leaves the same out when it seeds an
/// account): the account, its API key choice, and per-account caches.
const CLAUDE_ACCOUNT_KEYS: &[&str] = &[
  "oauthAccount",
  "primaryApiKey",
  "customApiKeyResponses",
  "userID",
  "additionalModelOptionsCache",
  "additionalModelOptionsAnsweredAt",
  "additionalModelCostsCache",
  "modelAccessCache",
  "orgModelDefaultCache",
  "cachedArtifactRoster",
  "artifactRosterDenied",
  "lastSeenOrgDefaultUpdatedAt",
  "clientDataCache",
  "clientDataCacheSlots",
  "autoCompactWindowsCache",
  "cachedUsageUtilization",
  "metricsStatusCache",
  "metricsStatusCacheByPrincipal",
  "githubWebConnectionStatusCache",
  "startupPrefetchedAt",
  "subscriptionNoticeCount",
  "hasAvailableSubscription",
];

/// The user's `.claude.json` without login-specific keys, so a new account starts with their
/// onboarding, trusted folders and MCP servers instead of a first-run setup.
pub fn seed_claude_json(personal: &str) -> Option<String> {
  let mut v: serde_json::Value = serde_json::from_str(personal).ok()?;
  let obj = v.as_object_mut()?;
  for k in CLAUDE_ACCOUNT_KEYS {
    obj.remove(*k);
  }
  serde_json::to_string_pretty(&v).ok()
}

/// Creates the account folder (0700) and, for Claude, links what is shared from `personal`
/// (the user's `~/.claude`) and seeds `.claude.json` once from `personal_json` (the user's
/// `~/.claude.json`). Only creates entries inside `dir`; never writes into `personal`.
/// Codex: copies `config.toml` once so models/profiles carry over (auth stays per account).
pub fn prepare_dir(provider: Provider, dir: &Path, personal: Option<&Path>, personal_json: Option<&Path>) -> Result<(), String> {
  std::fs::create_dir_all(dir).map_err(|e| format!("สร้างโฟลเดอร์บัญชีไม่ได้: {e}"))?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
  }
  if provider == Provider::Claude
    && let Some(src) = personal_json
    && !dir.join(".claude.json").exists()
    && let Some(seed) = std::fs::read_to_string(src).ok().as_deref().and_then(seed_claude_json)
  {
    write_private(&dir.join(".claude.json"), seed.as_bytes()).map_err(|e| format!("สร้าง .claude.json ของบัญชีไม่ได้: {e}"))?;
  }
  let Some(personal) = personal.filter(|p| p.is_dir() && *p != dir) else { return Ok(()) };
  match provider {
    Provider::Claude => {
      for name in CLAUDE_SHARED {
        let (src, dst) = (personal.join(name), dir.join(name));
        if src.exists() && std::fs::symlink_metadata(&dst).is_err() {
          #[cfg(unix)]
          std::os::unix::fs::symlink(&src, &dst).map_err(|e| format!("ลิงก์ {name} ไม่ได้: {e}"))?;
        }
      }
    }
    Provider::Codex => {
      let (src, dst) = (personal.join("config.toml"), dir.join("config.toml"));
      if src.is_file() && !dst.exists() {
        std::fs::copy(&src, &dst).map_err(|e| format!("คัดลอก config.toml ไม่ได้: {e}"))?;
      }
    }
  }
  Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
  let mut opts = std::fs::OpenOptions::new();
  opts.write(true).create_new(true);
  #[cfg(unix)]
  std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
  opts.open(path)?.write_all(bytes)
}

/// Deletes an account folder, only when it really is one of ours (`root/<provider>/<id>`).
/// Symlinks inside are removed as links, never followed.
pub fn remove_dir(root: &Path, provider: Provider, id: &str) -> Result<(), String> {
  if !valid_id(id) {
    return Err("id ของบัญชีไม่ถูกต้อง".into());
  }
  let dir = account_dir(root, provider, id);
  match std::fs::symlink_metadata(&dir) {
    Err(_) => Ok(()),
    Ok(m) if m.file_type().is_symlink() || !m.is_dir() => Err("โฟลเดอร์บัญชีไม่ใช่โฟลเดอร์ปกติ ไม่ลบ".into()),
    // remove_dir_all does not follow symlinks inside the tree.
    Ok(_) => std::fs::remove_dir_all(&dir).map_err(|e| format!("ลบโฟลเดอร์บัญชีไม่ได้: {e}")),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn store(dir: &Path) -> Store {
    Store::load(dir.join(FILE))
  }

  #[test]
  fn add_activate_remove_and_reload() {
    let tmp = tempfile::tempdir().unwrap();
    let mut s = store(tmp.path());
    let a = s.add(Provider::Claude, Kind::Subscription, "  งาน  ", 1).unwrap();
    let b = s.add(Provider::Codex, Kind::ApiKey, "ส่วนตัว", 2).unwrap();
    assert!(valid_id(&a.id) && valid_id(&b.id) && a.id != b.id);
    assert_eq!(a.label, "งาน");
    s.set_active(Provider::Claude, Some(&a.id)).unwrap();
    assert!(s.set_active(Provider::Claude, Some(&b.id)).is_err(), "codex account cannot be Claude's");
    s.save().unwrap();

    let mut s = store(tmp.path());
    assert_eq!(s.data.accounts.len(), 2);
    assert_eq!(s.active(Provider::Claude).unwrap().id, a.id);
    assert!(s.active(Provider::Codex).is_none());
    s.remove(&a.id).unwrap();
    assert!(s.active(Provider::Claude).is_none(), "active pointer dropped with the account");
    assert!(s.remove(&a.id).is_err());
  }

  #[test]
  fn bad_file_and_bad_entries_are_dropped() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join(FILE), "{not json").unwrap();
    assert_eq!(store(tmp.path()).data, Data::default());
    std::fs::write(
      tmp.path().join(FILE),
      r#"{"accounts":[{"id":"../../etc","provider":"claude","kind":"subscription","label":"x","created_at":0}],"active":{"claude":"../../etc"}}"#,
    )
    .unwrap();
    assert_eq!(store(tmp.path()).data, Data::default());
  }

  #[test]
  fn labels() {
    assert!(clean_label("   ").is_err());
    assert!(clean_label(&"ก".repeat(61)).is_err());
    assert_eq!(clean_label("a\u{7}b").unwrap(), "ab");
  }

  #[test]
  fn env_for_each_kind() {
    let root = Path::new("/data/ai-accounts");
    assert!(agent_env(None, root, None).unwrap().is_empty(), "no account: today's behaviour");

    let sub = Account { id: "0123456789ab".into(), provider: Provider::Claude, kind: Kind::Subscription, label: "w".into(), created_at: 0 };
    let env = agent_env(Some(&sub), root, None).unwrap();
    assert_eq!(env.set["CLAUDE_CONFIG_DIR"], "/data/ai-accounts/claude/0123456789ab");
    assert_eq!(env.unset, ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
    assert_eq!(env.for_shell()["ANTHROPIC_API_KEY"], "");

    let codex = Account { provider: Provider::Codex, ..sub.clone() };
    assert_eq!(agent_env(Some(&codex), root, None).unwrap().set["CODEX_HOME"], "/data/ai-accounts/codex/0123456789ab");

    let key = Account { kind: Kind::ApiKey, ..sub.clone() };
    assert!(agent_env(Some(&key), root, None).is_err(), "no key in the Keychain");
    let env = agent_env(Some(&key), root, Some("sk-ant-secret".into())).unwrap();
    assert_eq!(env.set["ANTHROPIC_API_KEY"], "sk-ant-secret");
    assert!(!format!("{env:?}").contains("secret"), "Debug never shows the key");

    let okey = Account { provider: Provider::Codex, kind: Kind::ApiKey, ..sub };
    assert_eq!(agent_env(Some(&okey), root, Some("sk-x".into())).unwrap().set["OPENAI_API_KEY"], "sk-x");
  }

  #[test]
  fn login_commands() {
    let root = Path::new("/Users/me/Library/Application Support/dev.kingu/ai-accounts");
    let a = Account { id: "0123456789ab".into(), provider: Provider::Claude, kind: Kind::Subscription, label: "w".into(), created_at: 0 };
    assert_eq!(
      login_argv(&a, root).unwrap(),
      ["env", "CLAUDE_CONFIG_DIR=/Users/me/Library/Application Support/dev.kingu/ai-accounts/claude/0123456789ab", "claude", "auth", "login", "--claudeai"]
    );
    let c = Account { provider: Provider::Codex, ..a.clone() };
    assert_eq!(login_argv(&c, root).unwrap()[2..], ["codex", "login"]);
    assert!(login_argv(&Account { kind: Kind::ApiKey, ..a }, root).is_err());
  }

  #[test]
  fn api_keys() {
    assert!(validate_api_key(Provider::Claude, &format!("sk-ant-api03-{}", "a".repeat(20))).is_ok());
    assert!(validate_api_key(Provider::Claude, &format!("sk-proj-{}", "a".repeat(20))).is_err());
    assert!(validate_api_key(Provider::Codex, &format!("sk-proj-{}", "a".repeat(20))).is_ok());
    assert!(validate_api_key(Provider::Codex, "sk-short").is_err());
    assert!(validate_api_key(Provider::Codex, &format!("sk-{} x", "a".repeat(20))).is_err());
  }

  #[test]
  fn programs() {
    assert_eq!(Provider::of_program("claude"), Some(Provider::Claude));
    assert_eq!(Provider::of_program("/opt/homebrew/bin/codex"), Some(Provider::Codex));
    assert_eq!(Provider::of_program("aider"), None);
  }

  #[cfg(unix)]
  #[test]
  fn prepare_links_shared_state_and_remove_keeps_the_personal_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let personal = tmp.path().join("personal");
    std::fs::create_dir_all(personal.join("projects")).unwrap();
    std::fs::write(personal.join("settings.json"), "{}").unwrap();
    std::fs::write(personal.join(".credentials.json"), "secret").unwrap();
    let root = tmp.path().join("ai-accounts");
    let dir = account_dir(&root, Provider::Claude, "0123456789ab");
    let personal_json = tmp.path().join(".claude.json");
    std::fs::write(&personal_json, r#"{"hasCompletedOnboarding":true,"oauthAccount":{"emailAddress":"me@x"},"userID":"u","projects":{"/w":{}}}"#).unwrap();
    prepare_dir(Provider::Claude, &dir, Some(&personal), Some(&personal_json)).unwrap();
    prepare_dir(Provider::Claude, &dir, Some(&personal), Some(&personal_json)).unwrap();
    let seeded: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join(".claude.json")).unwrap()).unwrap();
    assert_eq!(seeded["hasCompletedOnboarding"], true);
    assert!(seeded["projects"]["/w"].is_object());
    assert!(seeded.get("oauthAccount").is_none() && seeded.get("userID").is_none(), "the user's login is not copied");
    assert!(std::fs::symlink_metadata(dir.join("projects")).unwrap().file_type().is_symlink());
    assert!(std::fs::symlink_metadata(dir.join("settings.json")).unwrap().file_type().is_symlink());
    assert!(!dir.join(".credentials.json").exists(), "the login is never shared");
    assert!(!dir.join("todos").exists(), "only what exists is linked");

    remove_dir(&root, Provider::Claude, "0123456789ab").unwrap();
    assert!(!dir.exists());
    assert!(personal.join("projects").is_dir() && personal.join("settings.json").is_file());
    assert!(remove_dir(&root, Provider::Claude, "../personal").is_err());

    let cdir = account_dir(&root, Provider::Codex, "0123456789ab");
    std::fs::write(personal.join("config.toml"), "model = \"x\"").unwrap();
    prepare_dir(Provider::Codex, &cdir, Some(&personal), None).unwrap();
    assert_eq!(std::fs::read_to_string(cdir.join("config.toml")).unwrap(), "model = \"x\"");
  }
}
