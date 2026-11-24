//! The account type of Antigravity chats on Kingu's ACP server: a personal Google sign-in, a
//! Gemini API key, or Google Agent Platform with the computer's Application Default Credentials
//! (Orca `shared/agent-accounts/antigravity/antigravity-chat-auth-config.ts`,
//! `main/antigravity/antigravity-chat-api-key{,-store}.ts`, `antigravity-agent-platform-project.ts`,
//! `antigravity-chat-auth-environment.ts`, `antigravity-chat-credential.ts`).
//!
//! - The type is the user setting `kingu.agent.antigravityChatAuth` (Orca `antigravityChatAuth`):
//!   `{ method, gcpProject?, gcpLocation? }`. The server reads it from `settings.json` in its home
//!   (antigravity.rs `prepare_chat_home`) and the chat's Sign in sends it as ACP `authenticate`'s
//!   method (the agent host reads [`AUTH_METHOD_ENV`]).
//! - A pasted Gemini API key lives only in the macOS Keychain (service [`KEY_SERVICE`]), never in
//!   settings; it wins over `GEMINI_API_KEY` from the environment. Google checks it before it is
//!   saved (an unreachable Google still saves, as Orca). The webview can save, clear and ask
//!   whether one is saved; it never reads the key back.
//! - Agent Platform finds its project as Orca: the saved one, `GOOGLE_CLOUD_PROJECT`, ADC's quota
//!   project (or a service account key's own), `CLOUDSDK_CORE_PROJECT`, gcloud's active
//!   configuration; the location is the saved one, `GOOGLE_CLOUD_LOCATION`, else `global`.

use std::path::{Path, PathBuf};

use crate::accounts::secrets::SecretStore;

/// User setting (Orca `antigravityChatAuth`).
pub const SETTING: &str = "kingu.agent.antigravityChatAuth";
/// Set on the server's launch: the ACP auth method the chat's Sign in sends (agent-host acpDialects.ts).
pub const AUTH_METHOD_ENV: &str = "KINGU_ANTIGRAVITY_AUTH_METHOD";
/// Keychain service and account of the pasted Gemini API key.
pub const KEY_SERVICE: &str = "dev.kingu.antigravity";
pub const KEY_ACCOUNT: &str = "gemini-api-key";
/// Where a Gemini API key is made (Orca `GET_KEY_URL`).
pub const GET_KEY_URL: &str = "https://aistudio.google.com/apikey";
const MODELS_URL: &str = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1";
const DEFAULT_LOCATION: &str = "global";
const MAX_FIELD: usize = 255;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
pub enum Method {
  /// A personal Google sign-in the server runs (`oauth-personal`).
  #[default]
  #[serde(rename = "oauth-personal")]
  Personal,
  /// A Gemini API key (`gemini-api-key`).
  #[serde(rename = "gemini-api-key")]
  ApiKey,
  /// Google Agent Platform with ADC (`agent-platform`).
  #[serde(rename = "agent-platform")]
  AgentPlatform,
}

impl Method {
  pub fn id(self) -> &'static str {
    match self {
      Method::Personal => "oauth-personal",
      Method::ApiKey => "gemini-api-key",
      Method::AgentPlatform => "agent-platform",
    }
  }

  /// The launch variables this type reads, kept from the inherited environment (Orca `AUTH_ENVIRONMENT_KEYS`).
  pub fn kept_env(self) -> &'static [&'static str] {
    match self {
      Method::Personal => &[],
      Method::ApiKey => &["GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL"],
      Method::AgentPlatform => &["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_CLOUD_QUOTA_PROJECT", "CLOUDSDK_CORE_PROJECT"],
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ChatAuth {
  pub method: Method,
  pub gcp_project: Option<String>,
  pub gcp_location: Option<String>,
}

/// Orca `resolveAntigravityChatAuthConfig`: unset is a personal Google sign-in; anything else
/// must be a known method with short fields (Gemini Enterprise is not offered in Kingu).
pub fn parse(value: Option<&serde_json::Value>) -> Result<ChatAuth, String> {
  let Some(v) = value.filter(|v| !v.is_null()) else { return Ok(ChatAuth::default()) };
  let bad = || "Antigravity account settings are incomplete: choose Google account, Gemini API key or Google Agent Platform under Settings → Accounts → Antigravity.".to_owned();
  let obj = v.as_object().ok_or_else(bad)?;
  let method = match obj.get("method").and_then(|m| m.as_str()) {
    Some("oauth-personal") => Method::Personal,
    Some("gemini-api-key") => Method::ApiKey,
    Some("agent-platform") => Method::AgentPlatform,
    _ => return Err(bad()),
  };
  if obj.keys().any(|k| !["method", "gcpProject", "gcpLocation"].contains(&k.as_str())) {
    return Err(bad());
  }
  let field = |k: &str| -> Result<Option<String>, String> {
    match obj.get(k) {
      None | Some(serde_json::Value::Null) => Ok(None),
      Some(serde_json::Value::String(s)) if s.trim().len() <= MAX_FIELD => Ok(Some(s.trim().to_owned()).filter(|s| !s.is_empty())),
      _ => Err(bad()),
    }
  };
  Ok(ChatAuth { method, gcp_project: field("gcpProject")?, gcp_location: field("gcpLocation")? })
}

// ---- the Gemini API key ------------------------------------------------------------------------

/// The pasted key (trimmed), or None.
pub fn saved_key(store: &dyn SecretStore) -> Option<String> {
  store.get(KEY_ACCOUNT).map(|k| k.trim().to_owned()).filter(|k| !k.is_empty())
}

/// A single-line, non-empty key, else why not.
pub fn clean_key(key: &str) -> Result<String, String> {
  let k = key.trim();
  if k.is_empty() {
    return Err("Enter a Gemini API key.".into());
  }
  if k.contains(char::is_whitespace) || k.len() > 512 {
    return Err("That doesn't look like a Gemini API key: paste the key alone, on one line.".into());
  }
  Ok(k.to_owned())
}

/// Google's answer to the key (Orca `assertGoogleAcceptsKey`): 400/401/403 reject it; anything
/// else, an unreachable Google included, accepts it so an offline save still works.
pub fn google_rejects(status: Option<u16>) -> bool {
  matches!(status, Some(400 | 401 | 403))
}

fn ask_google(key: &str) -> Option<u16> {
  let client = crate::net_proxy::client_builder().ok()?.timeout(std::time::Duration::from_secs(10)).redirect(reqwest::redirect::Policy::none()).build().ok()?;
  client.get(MODELS_URL).header("x-goog-api-key", key).send().ok().map(|r| r.status().as_u16())
}

/// Checks `key` with Google (`check`), then saves it in `store`.
pub fn save_key(store: &dyn SecretStore, key: &str, check: &dyn Fn(&str) -> Option<u16>) -> Result<(), String> {
  let key = clean_key(key)?;
  if google_rejects(check(&key)) {
    return Err("Google rejected this Gemini API key. Check it and paste it again.".into());
  }
  store.set(KEY_ACCOUNT, &key)
}

// ---- Agent Platform's project ------------------------------------------------------------------

/// Where the resolved project came from, shown in Settings. Orca `04c88e0df`
/// (`antigravity-chat-auth-detect.ts`) names the project too; only naming its source is Kingu-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectSource {
  Saved,
  Environment,
  Adc,
  CloudsdkEnvironment,
  Gcloud,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPlatform {
  pub project: Option<String>,
  pub project_source: Option<ProjectSource>,
  pub location: String,
  /// The ADC file Google's libraries read, and whether it is there.
  pub credentials_file: PathBuf,
  pub credentials_found: bool,
}

type Env<'a> = &'a dyn Fn(&str) -> Option<String>;

fn env_value(env: Env, k: &str) -> Option<String> {
  env(k).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

fn gcloud_dir(env: Env, home: &Path) -> PathBuf {
  if let Some(d) = env_value(env, "CLOUDSDK_CONFIG") {
    return PathBuf::from(d);
  }
  if cfg!(windows)
    && let Some(app) = env_value(env, "APPDATA")
  {
    return Path::new(&app).join("gcloud");
  }
  home.join(".config/gcloud")
}

/// `GOOGLE_APPLICATION_CREDENTIALS`, else gcloud's default ADC file.
pub fn credentials_file(env: Env, home: &Path) -> PathBuf {
  env_value(env, "GOOGLE_APPLICATION_CREDENTIALS").map(PathBuf::from).unwrap_or_else(|| gcloud_dir(env, home).join("application_default_credentials.json"))
}

/// ADC's quota project, else a service account key's own project.
fn adc_project(file: &Path) -> Option<String> {
  let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
  let pick = |k: &str| v.get(k).and_then(|p| p.as_str()).map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned);
  pick("quota_project_id").or_else(|| pick("project_id"))
}

/// `project = …` under `[core]` of gcloud's active configuration.
fn gcloud_project(dir: &Path, env: Env) -> Option<String> {
  let active = env_value(env, "CLOUDSDK_ACTIVE_CONFIG_NAME")
    .or_else(|| std::fs::read_to_string(dir.join("active_config")).ok().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()))
    .unwrap_or_else(|| "default".into());
  // The name names a file: nothing that could leave the folder.
  if active.contains(['/', '\\']) || active.contains("..") {
    return None;
  }
  let ini = std::fs::read_to_string(dir.join("configurations").join(format!("config_{active}"))).ok()?;
  let mut core = false;
  for line in ini.lines() {
    let l = line.trim();
    if l.starts_with('[') && l.ends_with(']') {
      core = l[1..l.len() - 1].trim() == "core";
      continue;
    }
    if core && let Some((k, v)) = l.split_once('=') && k.trim() == "project" && !v.trim().is_empty() && !v.trim().contains(char::is_whitespace) {
      return Some(v.trim().to_owned());
    }
  }
  None
}

/// Orca `resolveAgentPlatformProject`, saying where the project came from.
pub fn agent_platform(auth: &ChatAuth, env: Env, home: &Path) -> AgentPlatform {
  let dir = gcloud_dir(env, home);
  let file = credentials_file(env, home);
  let found = [
    (auth.gcp_project.clone(), ProjectSource::Saved),
    (env_value(env, "GOOGLE_CLOUD_PROJECT"), ProjectSource::Environment),
    (adc_project(&file), ProjectSource::Adc),
    (env_value(env, "CLOUDSDK_CORE_PROJECT"), ProjectSource::CloudsdkEnvironment),
    (gcloud_project(&dir, env), ProjectSource::Gcloud),
  ]
  .into_iter()
  .find_map(|(p, s)| p.map(|p| (p, s)));
  AgentPlatform {
    project: found.as_ref().map(|(p, _)| p.clone()),
    project_source: found.map(|(_, s)| s),
    location: auth.gcp_location.clone().or_else(|| env_value(env, "GOOGLE_CLOUD_LOCATION")).unwrap_or_else(|| DEFAULT_LOCATION.into()),
    credentials_found: file.is_file(),
    credentials_file: file,
  }
}

/// The variables Agent Platform's server gets (Orca `agentPlatformEnvironment`): the resolved
/// project and location, which it prefers over its settings file, and the ADC file under
/// `CLOUDSDK_CONFIG` (its Google client only looks under HOME).
pub fn agent_platform_env(p: &AgentPlatform, env: Env) -> Vec<(String, String)> {
  let mut out = Vec::new();
  if let Some(project) = &p.project {
    out.push(("GOOGLE_CLOUD_PROJECT".to_owned(), project.clone()));
  }
  out.push(("GOOGLE_CLOUD_LOCATION".to_owned(), p.location.clone()));
  if env_value(env, "GOOGLE_APPLICATION_CREDENTIALS").is_none() && env_value(env, "CLOUDSDK_CONFIG").is_some() && p.credentials_found {
    out.push(("GOOGLE_APPLICATION_CREDENTIALS".to_owned(), p.credentials_file.to_string_lossy().into_owned()));
  }
  out
}

// ---- a chat's launch ---------------------------------------------------------------------------

/// What the server's launch adds for `auth`: variables to set (credentials Kingu supplies over the
/// environment's) and the `gcp` block of its settings file. Refuses what can't sign in:
/// a key chat with no key at all (Orca refuses it only when a Google login is saved in the chat
/// home, which the server would silently fall back to; Kingu refuses it always), Agent Platform
/// without a project.
pub fn launch(auth: &ChatAuth, env: Env, home: &Path, store: &dyn SecretStore) -> Result<(Vec<(String, String)>, Option<(String, String)>), String> {
  let mut set = vec![(AUTH_METHOD_ENV.to_owned(), auth.method.id().to_owned())];
  match auth.method {
    Method::Personal => Ok((set, None)),
    Method::ApiKey => {
      match saved_key(store) {
        Some(key) => set.push(("GEMINI_API_KEY".into(), key)),
        None if env_value(env, "GEMINI_API_KEY").is_some() => {}
        None => return Err("No Gemini API key is saved for Antigravity, and GEMINI_API_KEY isn't set. Add a key under Settings → Accounts → Antigravity.".into()),
      }
      Ok((set, None))
    }
    Method::AgentPlatform => {
      let p = agent_platform(auth, env, home);
      let Some(project) = p.project.clone() else {
        return Err("Google Agent Platform needs a Google Cloud project. Run `gcloud config set project <id>` or enter one under Settings → Accounts → Antigravity.".into());
      };
      set.extend(agent_platform_env(&p, env));
      Ok((set, Some((project, p.location))))
    }
  }
}

// ---- what the computer already has (Chat's chip and chooser) -----------------------------------

/// The server's saved Google sign-in, in its home's own folder (Orca `ANTIGRAVITY_OAUTH_TOKEN_FILES`
/// `oauth-personal`). A key or ADC saves none.
pub const GOOGLE_TOKEN_FILE: &str = "acp_token.json";

/// Whether the server saved a Google sign-in under `chat_home` (`<app data>/antigravity-chat`):
/// its token file holds a JSON object. Only that is checked; nothing of it leaves this function
/// (Orca `hasSavedAntigravityGoogleSignIn`).
pub fn saved_google_sign_in(chat_home: &Path) -> bool {
  std::fs::read_to_string(chat_home.join(super::antigravity::ACP_HOME).join(GOOGLE_TOKEN_FILE))
    .ok()
    .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    .is_some_and(|v| v.is_object())
}

/// Where a Gemini API key was found: Kingu's Keychain item, or `GEMINI_API_KEY`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeySource {
  Saved,
  Environment,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyFound {
  pub available: bool,
  pub source: Option<KeySource>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdcFound {
  /// The ADC file Google's libraries read is there.
  pub available: bool,
  /// The project a switch to Agent Platform would use; only with the file.
  pub project: Option<String>,
}

/// What an Antigravity chat could sign in with here (Orca `AntigravityChatAuthDetection`, without
/// Gemini Enterprise). Never a credential: only that one exists and where it came from.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
  /// The saved account type; None while the setting can't be read.
  pub method: Option<Method>,
  /// The server holds a Google sign-in from before.
  pub google_sign_in: bool,
  pub api_key: KeyFound,
  pub adc: AdcFound,
  /// Antigravity chats running now (a switch stops them).
  pub live_chats: usize,
}

/// Orca `detectAntigravityChatAuth`, read from files and the environment only (no server, no gcloud).
/// `config`: the saved setting (None: unreadable). The gcloud project is the one a switch keeps:
/// the saved project first, as Agent Platform's launch resolves it.
pub fn detect(config: Option<&ChatAuth>, env: Env, home: &Path, key_saved: bool, google_sign_in: bool, live_chats: usize) -> Detection {
  let in_env = env_value(env, "GEMINI_API_KEY").is_some();
  let saved = config.cloned().unwrap_or_default();
  let p = agent_platform(&saved, env, home);
  Detection {
    method: config.map(|c| c.method),
    google_sign_in,
    api_key: KeyFound {
      available: key_saved || in_env,
      source: if key_saved {
        Some(KeySource::Saved)
      } else if in_env {
        Some(KeySource::Environment)
      } else {
        None
      },
    },
    adc: AdcFound { available: p.credentials_found, project: p.project.filter(|_| p.credentials_found) },
    live_chats,
  }
}

// ---- this machine ------------------------------------------------------------------------------

pub struct KeyStore;

impl KeyStore {
  fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEY_SERVICE, id).map_err(|e| e.to_string())
  }
}

impl SecretStore for KeyStore {
  fn get(&self, id: &str) -> Option<String> {
    Self::entry(id).ok()?.get_password().ok()
  }
  fn set(&self, id: &str, secret: &str) -> Result<(), String> {
    Self::entry(id)?.set_password(secret).map_err(|e| format!("The key could not be saved in the Keychain: {e}"))
  }
  fn delete(&self, id: &str) -> Result<(), String> {
    match Self::entry(id)?.delete_credential() {
      Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
      Err(e) => Err(format!("The key could not be removed from the Keychain: {e}")),
    }
  }
}

/// The user's choice here (unreadable: an error at launch).
pub fn current() -> Result<ChatAuth, String> {
  parse(crate::system::config_dir().and_then(|d| crate::settings::user_value(d, SETTING)).as_ref())
}

pub fn process_env(k: &str) -> Option<String> {
  std::env::var(k).ok()
}

pub fn home() -> PathBuf {
  std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
  pub method: Option<Method>,
  /// The setting can't be read (shown as an error; the chat refuses to start).
  pub error: Option<String>,
  pub api_key_saved: bool,
  pub api_key_in_environment: bool,
  pub agent_platform: AgentPlatform,
  pub get_key_url: &'static str,
}

/// Settings › Accounts › Antigravity: what each account type would use here.
#[tauri::command]
pub async fn antigravity_chat_auth_status() -> Result<Status, String> {
  tauri::async_runtime::spawn_blocking(|| {
    let (auth, error) = match current() {
      Ok(a) => (a, None),
      Err(e) => (ChatAuth::default(), Some(e)),
    };
    Status {
      method: error.is_none().then_some(auth.method),
      error,
      api_key_saved: saved_key(&KeyStore).is_some(),
      api_key_in_environment: env_value(&process_env, "GEMINI_API_KEY").is_some(),
      agent_platform: agent_platform(&auth, &process_env, &home()),
      get_key_url: GET_KEY_URL,
    }
  })
  .await
  .map_err(|e| e.to_string())
}

/// Saves the pasted key in the Keychain once Google accepts it. The key is never logged or returned.
#[tauri::command]
pub async fn antigravity_api_key_save(key: String) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || save_key(&KeyStore, &key, &ask_google)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn antigravity_api_key_clear() -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(|| KeyStore.delete(KEY_ACCOUNT)).await.map_err(|e| e.to_string())?
}

/// Chat's chip and chooser: what Antigravity could sign in with here (Orca
/// `accounts.antigravityChatAuthDetect`). Says whether a key exists and where; never the key.
#[tauri::command]
pub async fn antigravity_chat_auth_detect(agents: tauri::State<'_, std::sync::Arc<super::AgentHost>>) -> Result<Detection, String> {
  let live = agents.live_runs_of(super::antigravity::RUNTIME_ID);
  tauri::async_runtime::spawn_blocking(move || {
    let config = current().ok();
    let google = super::managed_cli::data_dir().is_some_and(|d| saved_google_sign_in(&d.join(super::antigravity::CHAT_HOME_FOLDER)));
    detect(config.as_ref(), &process_env, &home(), saved_key(&KeyStore).is_some(), google, live)
  })
  .await
  .map_err(|e| e.to_string())
}

/// How long a switch waits for running Antigravity chats to end.
const CHATS_STOP_WAIT: std::time::Duration = std::time::Duration::from_secs(8);

/// After Chat switches the account type: running Antigravity chats hold the old sign-in, so they
/// stop and start again with the new one on their next message (Orca's apply, `stopLiveChats`).
#[tauri::command]
pub async fn antigravity_chat_stop_live(agents: tauri::State<'_, std::sync::Arc<super::AgentHost>>) -> Result<usize, String> {
  let host = agents.inner().clone();
  tauri::async_runtime::spawn_blocking(move || host.stop_agent(super::antigravity::RUNTIME_ID, CHATS_STOP_WAIT))
    .await
    .map_err(|e| e.to_string())?
    .map_err(|_| "Not every Antigravity chat could be stopped. Try again.".to_owned())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::accounts::secrets::fake::FakeSecrets;
  use serde_json::json;
  use std::collections::HashMap;

  fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + use<> {
    let m: HashMap<String, String> = pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
    move |k| m.get(k).cloned()
  }

  #[test]
  fn the_setting_reads_as_orcas() {
    assert_eq!(parse(None).unwrap(), ChatAuth::default());
    assert_eq!(parse(Some(&json!({ "method": "gemini-api-key" }))).unwrap().method, Method::ApiKey);
    let ap = parse(Some(&json!({ "method": "agent-platform", "gcpProject": " p1 ", "gcpLocation": "" }))).unwrap();
    assert_eq!((ap.method, ap.gcp_project.as_deref(), ap.gcp_location.as_deref()), (Method::AgentPlatform, Some("p1"), None));
    for bad in [json!("gemini-api-key"), json!({ "method": "oauth-business" }), json!({ "method": "agent-platform", "extra": 1 }), json!({ "method": "agent-platform", "gcpProject": "x".repeat(256) })] {
      assert!(parse(Some(&bad)).is_err(), "{bad}");
    }
    assert_eq!([Method::Personal.id(), Method::ApiKey.id(), Method::AgentPlatform.id()], ["oauth-personal", "gemini-api-key", "agent-platform"]);
  }

  #[test]
  fn a_key_is_checked_with_google_then_kept_in_the_keychain() {
    let store = FakeSecrets::default();
    assert!(save_key(&store, "  ", &|_| Some(200)).is_err());
    assert!(save_key(&store, "a b", &|_| Some(200)).is_err());
    assert!(save_key(&store, "AIza-bad", &|_| Some(400)).unwrap_err().contains("rejected"));
    assert_eq!(saved_key(&store), None);
    // Offline: kept, as Orca.
    save_key(&store, " AIza-offline ", &|_| None).unwrap();
    assert_eq!(saved_key(&store).as_deref(), Some("AIza-offline"));
    save_key(&store, "AIza-ok", &|k| (k == "AIza-ok").then_some(200)).unwrap();
    assert_eq!(saved_key(&store).as_deref(), Some("AIza-ok"));
    assert!(!google_rejects(Some(429)) && google_rejects(Some(403)));
  }

  #[test]
  fn a_launch_supplies_the_key_or_says_where_to_add_one() {
    let home = tempfile::tempdir().unwrap();
    let store = FakeSecrets::default();
    let key = ChatAuth { method: Method::ApiKey, ..Default::default() };
    let err = launch(&key, &env_of(&[]), home.path(), &store).unwrap_err();
    assert!(err.contains("GEMINI_API_KEY") && err.contains("Settings"));
    // The environment's key is used as it is: nothing set over it.
    let (set, gcp) = launch(&key, &env_of(&[("GEMINI_API_KEY", "env-key")]), home.path(), &store).unwrap();
    assert_eq!((set, gcp), (vec![(AUTH_METHOD_ENV.to_owned(), "gemini-api-key".to_owned())], None));
    // A saved key wins.
    store.set(KEY_ACCOUNT, "saved-key").unwrap();
    let (set, _) = launch(&key, &env_of(&[("GEMINI_API_KEY", "env-key")]), home.path(), &store).unwrap();
    assert!(set.contains(&("GEMINI_API_KEY".to_owned(), "saved-key".to_owned())));
    let (set, gcp) = launch(&ChatAuth::default(), &env_of(&[]), home.path(), &store).unwrap();
    assert_eq!((set.len(), gcp), (1, None));
  }

  #[test]
  fn agent_platform_finds_its_project_as_orca() {
    let home = tempfile::tempdir().unwrap();
    let gcloud = home.path().join(".config/gcloud");
    std::fs::create_dir_all(gcloud.join("configurations")).unwrap();
    let none = env_of(&[]);
    let auth = ChatAuth { method: Method::AgentPlatform, ..Default::default() };
    let p = agent_platform(&auth, &none, home.path());
    assert_eq!((p.project.as_deref(), p.location.as_str(), p.credentials_found), (None, "global", false));
    assert!(launch(&auth, &none, home.path(), &FakeSecrets::default()).unwrap_err().contains("gcloud config set project"));
    // gcloud's active configuration.
    std::fs::write(gcloud.join("active_config"), "work\n").unwrap();
    std::fs::write(gcloud.join("configurations/config_work"), "[auth]\nproject = nope\n[core]\naccount = a@b.c\nproject = from-gcloud\n").unwrap();
    assert_eq!(agent_platform(&auth, &none, home.path()).project_source, Some(ProjectSource::Gcloud));
    assert_eq!(agent_platform(&auth, &none, home.path()).project.as_deref(), Some("from-gcloud"));
    // ADC's quota project comes before it, the environment before that, the saved one first.
    std::fs::write(gcloud.join("application_default_credentials.json"), r#"{"type":"authorized_user","quota_project_id":"from-adc"}"#).unwrap();
    let p = agent_platform(&auth, &none, home.path());
    assert_eq!((p.project.as_deref(), p.credentials_found), (Some("from-adc"), true));
    assert_eq!(agent_platform(&auth, &env_of(&[("GOOGLE_CLOUD_PROJECT", "from-env"), ("GOOGLE_CLOUD_LOCATION", "us-central1")]), home.path()).location, "us-central1");
    let saved = ChatAuth { gcp_project: Some("saved".into()), gcp_location: Some("europe-west4".into()), ..auth.clone() };
    let (set, gcp) = launch(&saved, &env_of(&[("GOOGLE_CLOUD_PROJECT", "from-env")]), home.path(), &FakeSecrets::default()).unwrap();
    assert_eq!(gcp, Some(("saved".to_owned(), "europe-west4".to_owned())));
    assert!(set.contains(&("GOOGLE_CLOUD_PROJECT".to_owned(), "saved".to_owned())) && set.contains(&(AUTH_METHOD_ENV.to_owned(), "agent-platform".to_owned())));
    // ADC under CLOUDSDK_CONFIG is named for the server, whose client looks only under HOME.
    let other = tempfile::tempdir().unwrap();
    std::fs::write(other.path().join("application_default_credentials.json"), r#"{"project_id":"sa-project"}"#).unwrap();
    let cfg = other.path().to_string_lossy().into_owned();
    let env = env_of(&[("CLOUDSDK_CONFIG", &cfg)]);
    let p = agent_platform(&auth, &env, home.path());
    assert_eq!(p.project.as_deref(), Some("sa-project"));
    assert!(agent_platform_env(&p, &env).iter().any(|(k, v)| k == "GOOGLE_APPLICATION_CREDENTIALS" && v.ends_with("application_default_credentials.json")));
    // A configuration name can't leave gcloud's folder.
    assert_eq!(gcloud_project(&gcloud, &env_of(&[("CLOUDSDK_ACTIVE_CONFIG_NAME", "../x")])), None);
  }

  #[test]
  fn detection_says_what_is_here_never_the_key() {
    let home = tempfile::tempdir().unwrap();
    let none = env_of(&[]);
    let personal = ChatAuth::default();
    let d = detect(Some(&personal), &none, home.path(), false, false, 0);
    assert_eq!(d, Detection { method: Some(Method::Personal), google_sign_in: false, api_key: KeyFound { available: false, source: None }, adc: AdcFound { available: false, project: None }, live_chats: 0 });
    // GEMINI_API_KEY in the environment; a key saved in the Keychain is named first.
    let env = env_of(&[("GEMINI_API_KEY", "AIza-secret-env")]);
    let d = detect(Some(&personal), &env, home.path(), false, false, 2);
    assert_eq!((d.api_key.source, d.live_chats), (Some(KeySource::Environment), 2));
    assert_eq!(detect(Some(&personal), &env, home.path(), true, false, 0).api_key.source, Some(KeySource::Saved));
    let json = serde_json::to_string(&detect(Some(&personal), &env, home.path(), true, true, 0)).unwrap();
    assert!(!json.contains("AIza") && json.contains(r#""source":"saved""#) && json.contains(r#""googleSignIn":true"#), "{json}");
    // gcloud's project counts only with an ADC file, as Orca.
    let gcloud = home.path().join(".config/gcloud");
    std::fs::create_dir_all(gcloud.join("configurations")).unwrap();
    std::fs::write(gcloud.join("configurations/config_default"), "[core]\nproject = from-gcloud\n").unwrap();
    assert_eq!(detect(Some(&personal), &none, home.path(), false, false, 0).adc, AdcFound { available: false, project: None });
    std::fs::write(gcloud.join("application_default_credentials.json"), r#"{"type":"authorized_user"}"#).unwrap();
    assert_eq!(detect(Some(&personal), &none, home.path(), false, false, 0).adc, AdcFound { available: true, project: Some("from-gcloud".into()) });
    // A saved project is the one a switch keeps, so it is the one named.
    let saved = ChatAuth { gcp_project: Some("kept".into()), ..Default::default() };
    assert_eq!(detect(Some(&saved), &none, home.path(), false, false, 0).adc.project.as_deref(), Some("kept"));
    // An unreadable setting: no method.
    assert_eq!(detect(None, &none, home.path(), false, false, 0).method, None);
  }

  #[test]
  fn a_saved_google_sign_in_is_a_json_object_in_the_servers_folder() {
    let home = tempfile::tempdir().unwrap();
    assert!(!saved_google_sign_in(home.path()));
    let dir = home.path().join(crate::agent::antigravity::ACP_HOME);
    std::fs::create_dir_all(&dir).unwrap();
    for (text, want) in [("not json", false), ("[1]", false), ("null", false), (r#"{"access_token":"x"}"#, true)] {
      std::fs::write(dir.join(GOOGLE_TOKEN_FILE), text).unwrap();
      assert_eq!(saved_google_sign_in(home.path()), want, "{text}");
    }
  }
}
