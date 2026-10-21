//! AI accounts and plan usage (Orca's "Manage Accounts" and footer usage meter).
//!
//! - `store`: which accounts exist and which one each provider's agents use; account folders.
//! - `secrets`: API keys in the Keychain.
//! - `creds`: the CLIs' own logins (OAuth tokens), read only here, never sent to the webview.
//! - `usage`: the providers' usage endpoints, polling, and a small local history.
//!
//! The webview polls `ai_usage_refresh` (Rust decides when a request is due) and gets numbers,
//! labels and states only.

pub mod creds;
pub mod antigravity;
pub mod managed;
pub mod secrets;
pub mod store;
pub mod usage;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::i18n::msg::AccountsMsg;
use crate::tr;

use serde::Serialize;
use tauri::{Manager, State};

use creds::{CredentialSource, Identity, Target, Token};
use secrets::SecretStore;
use store::{Account, AgentEnv, Kind, Provider, Store};
use usage::{Api, Endpoints, Failure, Fetched, History, Http, Poll, Sample, Usage};

pub const HISTORY_FILE: &str = "ai-usage-history.json";
/// Event when `kingu account` changed the OpenCode / Devin managed accounts (payload: provider).
pub const MANAGED_CHANGED: &str = "accounts://managed-changed";
const PROVIDERS: [Provider; 2] = [Provider::Claude, Provider::Codex];

fn now_ms() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Where things live. `claude_env_dir` / `codex_env_home`: `CLAUDE_CONFIG_DIR` / `CODEX_HOME` of
/// Kingu's own environment (the user's own login when no account is active).
#[derive(Debug, Clone)]
pub struct Paths {
  pub store_file: PathBuf,
  pub root: PathBuf,
  pub history_file: PathBuf,
  pub home: PathBuf,
  pub claude_env_dir: Option<PathBuf>,
  pub codex_env_home: Option<PathBuf>,
}

impl Paths {
  fn own_claude_dir(&self) -> PathBuf {
    self.claude_env_dir.clone().unwrap_or_else(|| self.home.join(".claude"))
  }

  fn own_codex_home(&self) -> PathBuf {
    self.codex_env_home.clone().unwrap_or_else(|| self.home.join(".codex"))
  }
}

struct Inner {
  store: Store,
  polls: BTreeMap<String, Poll>,
  history: History,
}

pub struct Accounts {
  paths: Paths,
  inner: Mutex<Inner>,
  /// One refresh at a time; the state lock is never held across a request.
  refreshing: Mutex<()>,
  secrets: Box<dyn SecretStore>,
  creds: Box<dyn CredentialSource>,
  http: Box<dyn Http>,
  endpoints: Endpoints,
  /// OpenCode and Devin managed data accounts (next to the account folders).
  pub managed: managed::Managed,
}

/// One usage subject: a provider's login that agents use or may use.
#[derive(Debug, Clone, PartialEq)]
struct Subject {
  key: String,
  provider: Provider,
  account: Option<Account>,
  active: bool,
  target: Option<Target>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountView {
  pub id: String,
  pub provider: Provider,
  pub kind: Kind,
  pub label: String,
  pub created_at: u64,
  pub active: bool,
  /// Subscription: the CLI login exists in the account folder. API key: a key is in the Keychain.
  pub signed_in: bool,
  pub email: Option<String>,
  pub org: Option<String>,
  pub plan: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountsView {
  pub accounts: Vec<AccountView>,
  /// The user's own logins (`~/.claude`, `~/.codex`), used when no account is active.
  pub own: BTreeMap<Provider, Identity>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageRow {
  /// `claude:own`, `claude:<account id>`, …
  pub key: String,
  pub provider: Provider,
  pub account_id: Option<String>,
  pub label: String,
  pub email: Option<String>,
  pub active: bool,
  /// `ok`, `stale`, `error`, `unavailable`, `api_key`, `idle`.
  pub status: &'static str,
  pub usage: Option<Usage>,
  pub updated_at: Option<u64>,
  pub failure: Option<Failure>,
  pub error: Option<String>,
}

impl Accounts {
  pub fn new(paths: Paths, secrets: Box<dyn SecretStore>, creds: Box<dyn CredentialSource>, http: Box<dyn Http>, endpoints: Endpoints) -> Self {
    let store = Store::load(paths.store_file.clone());
    let history = History::load(&paths.history_file);
    let managed = managed::Managed::new(paths.root.parent().unwrap_or(&paths.root).join(managed::DIR));
    Self { paths, inner: Mutex::new(Inner { store, polls: BTreeMap::new(), history }), refreshing: Mutex::new(()), secrets, creds, http, endpoints, managed }
  }

  fn account_dir(&self, a: &Account) -> PathBuf {
    store::account_dir(&self.paths.root, a.provider, &a.id)
  }

  fn own_claude_json(&self) -> PathBuf {
    creds::claude_global_file(self.paths.claude_env_dir.as_deref(), &self.paths.home)
  }

  fn own_identity(&self, provider: Provider) -> Identity {
    match provider {
      Provider::Claude => creds::claude_identity(&self.own_claude_json()),
      Provider::Codex => creds::codex_identity(&self.paths.own_codex_home()),
    }
  }

  fn identity(&self, a: &Account) -> Identity {
    match (a.kind, a.provider) {
      (Kind::ApiKey, _) => Identity { signed_in: self.secrets.get(&a.id).is_some_and(|k| !k.is_empty()), ..Identity::default() },
      (Kind::Subscription, Provider::Claude) => {
        creds::claude_identity(&creds::claude_global_file(Some(&self.account_dir(a)), &self.paths.home))
      }
      (Kind::Subscription, Provider::Codex) => creds::codex_identity(&self.account_dir(a)),
    }
  }

  fn view(&self, a: &Account, active: bool) -> AccountView {
    let id = self.identity(a);
    AccountView {
      id: a.id.clone(),
      provider: a.provider,
      kind: a.kind,
      label: a.label.clone(),
      created_at: a.created_at,
      active,
      signed_in: id.signed_in,
      email: id.email,
      org: id.org,
      plan: id.plan,
    }
  }

  pub fn list(&self) -> AccountsView {
    let (accounts, active) = {
      let inner = self.inner.lock().unwrap();
      (inner.store.data.accounts.clone(), inner.store.data.active.clone())
    };
    let accounts = accounts.iter().map(|a| self.view(a, active.get(&a.provider) == Some(&a.id))).collect();
    let own = PROVIDERS.iter().map(|&p| (p, self.own_identity(p))).collect();
    AccountsView { accounts, own }
  }

  pub fn add(&self, provider: Provider, kind: Kind, label: &str) -> Result<AccountView, String> {
    let account = {
      let mut inner = self.inner.lock().unwrap();
      let a = inner.store.add(provider, kind, label, now_ms())?;
      inner.store.save()?;
      a
    };
    if kind == Kind::Subscription {
      let personal = match provider {
        Provider::Claude => self.paths.own_claude_dir(),
        Provider::Codex => self.paths.own_codex_home(),
      };
      store::prepare_dir(provider, &self.account_dir(&account), Some(&personal), Some(&self.own_claude_json()))?;
    }
    Ok(self.view(&account, false))
  }

  pub fn set_key(&self, id: &str, key: &str) -> Result<(), String> {
    let a = self.inner.lock().unwrap().store.get(id)?.clone();
    if a.kind != Kind::ApiKey {
      return Err(tr!(AccountsMsg::UsesLogin));
    }
    let key = key.trim();
    store::validate_api_key(a.provider, key)?;
    self.secrets.set(id, key)
  }

  pub fn remove(&self, id: &str) -> Result<(), String> {
    let a = {
      let mut inner = self.inner.lock().unwrap();
      let a = inner.store.remove(id)?;
      inner.store.save()?;
      let key = format!("{}:{id}", a.provider.as_str());
      inner.polls.remove(&key);
      if inner.history.0.remove(&key).is_some() {
        let _ = self.save_history(&inner.history);
      }
      a
    };
    match a.kind {
      Kind::ApiKey => self.secrets.delete(id)?,
      Kind::Subscription => {
        let dir = self.account_dir(&a);
        if a.provider == Provider::Claude {
          self.creds.forget_claude(&dir);
        }
        store::remove_dir(&self.paths.root, a.provider, id)?;
      }
    }
    Ok(())
  }

  pub fn set_active(&self, provider: Provider, id: Option<&str>) -> Result<(), String> {
    if let Some(id) = id {
      let a = self.inner.lock().unwrap().store.get(id)?.clone();
      if !self.identity(&a).signed_in {
        return Err(match a.kind {
          Kind::ApiKey => tr!(AccountsMsg::SetKeyFirst, label = a.label),
          Kind::Subscription => tr!(AccountsMsg::LoginFirst, label = a.label),
        });
      }
    }
    let mut inner = self.inner.lock().unwrap();
    inner.store.set_active(provider, id)?;
    inner.store.save()
  }

  /// The terminal command that logs a subscription account in (its folder is re-prepared first).
  pub fn login_command(&self, id: &str) -> Result<Vec<String>, String> {
    let a = self.inner.lock().unwrap().store.get(id)?.clone();
    let argv = store::login_argv(&a, &self.paths.root)?;
    let personal = match a.provider {
      Provider::Claude => self.paths.own_claude_dir(),
      Provider::Codex => self.paths.own_codex_home(),
    };
    store::prepare_dir(a.provider, &self.account_dir(&a), Some(&personal), Some(&self.own_claude_json()))?;
    // A new login should be fetched at once.
    self.inner.lock().unwrap().polls.remove(&format!("{}:{id}", a.provider.as_str()));
    Ok(argv)
  }

  /// Env for an agent of `provider`: empty when no account is active (today's behaviour).
  pub fn agent_env(&self, provider: Provider) -> Result<AgentEnv, String> {
    let active = self.inner.lock().unwrap().store.active(provider).cloned();
    let key = active.as_ref().filter(|a| a.kind == Kind::ApiKey).and_then(|a| self.secrets.get(&a.id));
    store::agent_env(active.as_ref(), &self.paths.root, key)
  }

  fn subjects(&self) -> Vec<Subject> {
    let inner = self.inner.lock().unwrap();
    let mut out = Vec::new();
    for p in PROVIDERS {
      let active = inner.store.active(p).map(|a| a.id.clone());
      if active.is_none() {
        let target = match p {
          Provider::Claude => Target::Claude { config_dir: self.paths.claude_env_dir.clone(), home: self.paths.home.clone(), unsuffixed_fallback: true },
          Provider::Codex => Target::Codex { home: self.paths.own_codex_home() },
        };
        out.push(Subject { key: format!("{}:own", p.as_str()), provider: p, account: None, active: true, target: Some(target) });
      }
      for a in inner.store.data.accounts.iter().filter(|a| a.provider == p) {
        let target = (a.kind == Kind::Subscription).then(|| {
          let dir = self.account_dir(a);
          match p {
            Provider::Claude => Target::Claude { config_dir: Some(dir), home: self.paths.home.clone(), unsuffixed_fallback: false },
            Provider::Codex => Target::Codex { home: dir },
          }
        });
        let is_active = active.as_deref() == Some(a.id.as_str());
        out.push(Subject { key: format!("{}:{}", p.as_str(), a.id), provider: p, account: Some(a.clone()), active: is_active, target });
      }
    }
    out
  }

  /// Fetches every subject that is due (`force`: the manual refresh, spaced 30 s). Blocking.
  pub fn refresh(&self, force: bool) -> Vec<UsageRow> {
    let Ok(_one) = self.refreshing.try_lock() else { return self.snapshot() };
    let now = now_ms();
    let mut history_changed = false;
    for s in self.subjects() {
      let due = self.inner.lock().unwrap().polls.get(&s.key).is_none_or(|p| p.due(now, force));
      if !due {
        continue;
      }
      let token = match &s.target {
        Some(t) => self.creds.token(t),
        None => Token::ApiKey,
      };
      let to_send = {
        let mut inner = self.inner.lock().unwrap();
        inner.polls.entry(s.key.clone()).or_default().before_fetch(token, now)
      };
      let Some((token, account_id)) = to_send else { continue };
      let api = match s.provider {
        Provider::Claude => Api::Claude,
        Provider::Codex => Api::Codex,
      };
      let fetched = usage::fetch(self.http.as_ref(), &self.endpoints, api, &token, account_id.as_deref());
      let done = now_ms();
      let mut inner = self.inner.lock().unwrap();
      if let Fetched::Ok(u) = &fetched {
        history_changed |= inner.history.record(&s.key, u, done);
      }
      inner.polls.entry(s.key.clone()).or_default().apply(fetched, done);
    }
    if history_changed {
      let inner = self.inner.lock().unwrap();
      if let Err(e) = self.save_history(&inner.history) {
        log::warn!("usage history: {e}");
      }
    }
    self.snapshot()
  }

  fn save_history(&self, h: &History) -> Result<(), String> {
    let text = serde_json::to_string(h).map_err(|e| e.to_string())?;
    store::write_atomic(&self.paths.history_file, text.as_bytes()).map_err(|e| e.to_string())
  }

  /// What the footer shows, without any request.
  pub fn snapshot(&self) -> Vec<UsageRow> {
    let subjects = self.subjects();
    let views: BTreeMap<String, (Identity, String)> = subjects
      .iter()
      .map(|s| {
        let (id, label) = match &s.account {
          Some(a) => (self.identity(a), a.label.clone()),
          None => (self.own_identity(s.provider), tr!(AccountsMsg::OwnAccount)),
        };
        (s.key.clone(), (id, label))
      })
      .collect();
    let inner = self.inner.lock().unwrap();
    subjects
      .into_iter()
      .map(|s| {
        let poll = inner.polls.get(&s.key).cloned().unwrap_or_default();
        let (identity, label) = views[&s.key].clone();
        let status = match (&s.account, &s.target) {
          (Some(_), None) => "api_key",
          _ => poll.status(),
        };
        let mut usage = poll.last_good.as_ref().map(|(u, _)| u.clone());
        if let Some(u) = usage.as_mut()
          && u.plan.is_none()
        {
          u.plan = poll.plan.clone().or_else(|| identity.plan.clone());
        }
        UsageRow {
          key: s.key,
          provider: s.provider,
          account_id: s.account.as_ref().map(|a| a.id.clone()),
          label,
          email: identity.email,
          active: s.active,
          status,
          updated_at: poll.last_good.as_ref().map(|(_, t)| *t),
          error: poll.failure.as_ref().filter(|_| status != "ok").map(|f| f.message(s.provider.title())),
          failure: poll.failure,
          usage,
        }
      })
      .collect()
  }

  pub fn history(&self, key: &str) -> Vec<Sample> {
    self.inner.lock().unwrap().history.0.get(key).cloned().unwrap_or_default()
  }
}

/// Registers the accounts state (call from `setup`).
pub fn install(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
  let config = app.path().app_config_dir()?;
  let data = app.path().app_data_dir()?;
  let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"));
  let env_dir = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from).filter(|p| p.is_absolute());
  let paths = Paths {
    store_file: config.join(store::FILE),
    root: data.join(store::DIR),
    history_file: data.join(HISTORY_FILE),
    home,
    claude_env_dir: env_dir("CLAUDE_CONFIG_DIR"),
    codex_env_home: env_dir("CODEX_HOME"),
  };
  let http = usage::ReqwestHttp::new()?;
  app.manage(Accounts::new(paths, Box::new(secrets::Keychain), Box::new(creds::SystemCredentials), Box::new(http), Endpoints::default()));
  Ok(())
}

/// The env an agent CLI started in a terminal gets: by program name (`claude`, `codex`; the
/// managed accounts' `opencode`, `devin`).
pub fn env_for_program(accounts: &Accounts, program: &str) -> Result<BTreeMap<String, String>, String> {
  match Provider::of_program(program) {
    Some(p) => Ok(accounts.agent_env(p)?.for_shell()),
    None => Ok(accounts.managed.env_for_program(program)),
  }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_accounts_list(app: tauri::AppHandle) -> Result<AccountsView, String> {
  blocking(move || app.state::<Accounts>().list()).await
}

#[tauri::command]
pub async fn ai_account_add(app: tauri::AppHandle, provider: String, kind: String, label: String) -> Result<AccountView, String> {
  let (provider, kind) = (Provider::parse(&provider)?, Kind::parse(&kind)?);
  blocking(move || app.state::<Accounts>().add(provider, kind, &label)).await?
}

/// Stores an API key in the Keychain. The key is never returned or logged.
#[tauri::command]
pub async fn ai_account_set_key(app: tauri::AppHandle, id: String, key: String) -> Result<(), String> {
  blocking(move || app.state::<Accounts>().set_key(&id, &key)).await?
}

#[tauri::command]
pub async fn ai_account_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
  blocking(move || app.state::<Accounts>().remove(&id)).await?
}

#[tauri::command]
pub async fn ai_account_set_active(app: tauri::AppHandle, provider: String, id: Option<String>) -> Result<(), String> {
  let provider = Provider::parse(&provider)?;
  blocking(move || app.state::<Accounts>().set_active(provider, id.as_deref())).await?
}

#[tauri::command]
pub async fn ai_account_login_command(app: tauri::AppHandle, id: String) -> Result<Vec<String>, String> {
  blocking(move || app.state::<Accounts>().login_command(&id)).await?
}

#[tauri::command]
pub fn ai_usage_get(accounts: State<'_, Accounts>) -> Vec<UsageRow> {
  accounts.snapshot()
}

#[tauri::command]
pub async fn ai_usage_refresh(app: tauri::AppHandle, force: Option<bool>) -> Result<Vec<UsageRow>, String> {
  blocking(move || app.state::<Accounts>().refresh(force.unwrap_or(false))).await
}

#[tauri::command]
pub fn ai_usage_history(accounts: State<'_, Accounts>, key: String) -> Vec<Sample> {
  accounts.history(&key)
}

#[cfg(test)]
mod tests {
  use std::sync::Arc;
  use std::sync::atomic::{AtomicUsize, Ordering};

  use super::creds::Secret;
  use super::secrets::fake::FakeSecrets;
  use super::usage::Response;
  use super::*;

  struct FakeCreds(Mutex<BTreeMap<String, Token>>);
  impl CredentialSource for FakeCreds {
    fn token(&self, target: &Target) -> Token {
      let key = match target {
        Target::Claude { config_dir, .. } => format!("claude:{}", config_dir.as_ref().map_or("own".into(), |d| d.display().to_string())),
        Target::Codex { home } => format!("codex:{}", home.display()),
      };
      self.0.lock().unwrap().get(&key).cloned().unwrap_or(Token::None)
    }
    fn forget_claude(&self, _: &std::path::Path) {}
  }

  struct FakeHttp {
    calls: Arc<AtomicUsize>,
    status: u16,
  }
  impl Http for FakeHttp {
    fn get(&self, url: &str, headers: &[(&str, String)]) -> Result<Response, String> {
      self.calls.fetch_add(1, Ordering::SeqCst);
      assert!(headers.iter().any(|(k, v)| *k == "Authorization" && v.starts_with("Bearer ")));
      let body = if url.contains("claude") {
        r#"{"five_hour":{"utilization":10,"resets_at":"2026-10-18T15:00:00Z"},"seven_day":{"utilization":71,"resets_at":"2026-10-21T19:00:00Z"}}"#
      } else {
        r#"{"plan_type":"plus","rate_limit":{"primary_window":{"used_percent":3,"limit_window_seconds":18000,"reset_at":1792335600}}}"#
      };
      Ok(Response { status: self.status, body: body.into(), retry_after: None })
    }
  }

  fn setup(status: u16) -> (tempfile::TempDir, Accounts, Arc<AtomicUsize>) {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(home.join(".claude/projects")).unwrap();
    std::fs::write(home.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"own@example.com"}}"#).unwrap();
    let paths = Paths {
      store_file: tmp.path().join("config").join(store::FILE),
      root: tmp.path().join("data").join(store::DIR),
      history_file: tmp.path().join("data").join(HISTORY_FILE),
      home,
      claude_env_dir: None,
      codex_env_home: None,
    };
    let creds = FakeCreds(Mutex::new(BTreeMap::from([(
      "claude:own".to_owned(),
      Token::OAuth { token: Secret("own-token".into()), expires_at: None, plan: Some("max".into()), account_id: None },
    )])));
    let calls = Arc::new(AtomicUsize::new(0));
    let http = FakeHttp { calls: calls.clone(), status };
    let endpoints = Endpoints { claude: "https://claude.test/usage".into(), codex: "https://codex.test/usage".into() };
    let accounts = Accounts::new(paths, Box::new(FakeSecrets::default()), Box::new(creds), Box::new(http), endpoints);
    (tmp, accounts, calls)
  }

  #[test]
  fn own_login_is_the_default_and_polled_on_schedule() {
    let (_tmp, a, calls) = setup(200);
    assert!(a.agent_env(Provider::Claude).unwrap().is_empty());
    let view = a.list();
    assert!(view.accounts.is_empty());
    assert_eq!(view.own[&Provider::Claude].email.as_deref(), Some("own@example.com"));
    assert!(!view.own[&Provider::Codex].signed_in);

    let rows = a.refresh(false);
    assert_eq!(calls.load(Ordering::SeqCst), 1, "codex is not signed in: no request");
    let claude = rows.iter().find(|r| r.key == "claude:own").unwrap();
    assert_eq!((claude.status, claude.active), ("ok", true));
    assert_eq!(claude.usage.as_ref().unwrap().weekly.as_ref().unwrap().used_percent, 71.0);
    let codex = rows.iter().find(|r| r.key == "codex:own").unwrap();
    assert_eq!(codex.status, "unavailable");

    a.refresh(false);
    assert_eq!(calls.load(Ordering::SeqCst), 1, "not due yet");
    assert_eq!(a.history("claude:own").len(), 1);
  }

  #[test]
  fn stale_token_is_reported_not_retried() {
    let (_tmp, a, calls) = setup(401);
    let rows = a.refresh(true);
    let claude = rows.iter().find(|r| r.key == "claude:own").unwrap();
    assert_eq!(claude.status, "error");
    assert_eq!(claude.failure, Some(Failure::StaleToken));
    assert!(claude.error.as_deref().unwrap().contains("log in again"));
    // Even a manual refresh does not resend a refused token.
    {
      let mut inner = a.inner.lock().unwrap();
      inner.polls.get_mut("claude:own").unwrap().last_attempt = Some(0);
    }
    a.refresh(true);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
  }

  #[test]
  fn accounts_lifecycle() {
    let (tmp, a, _calls) = setup(200);
    let sub = a.add(Provider::Claude, Kind::Subscription, "งาน").unwrap();
    assert!(!sub.signed_in);
    let dir = tmp.path().join("data/ai-accounts/claude").join(&sub.id);
    assert!(std::fs::symlink_metadata(dir.join("projects")).unwrap().file_type().is_symlink());
    assert!(a.set_active(Provider::Claude, Some(&sub.id)).is_err(), "not logged in yet");

    // The CLI login writes .claude.json into the account folder.
    std::fs::write(dir.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"work@example.com"}}"#).unwrap();
    let argv = a.login_command(&sub.id).unwrap();
    assert_eq!(argv[1], format!("CLAUDE_CONFIG_DIR={}", dir.display()));
    a.set_active(Provider::Claude, Some(&sub.id)).unwrap();
    assert_eq!(a.agent_env(Provider::Claude).unwrap().set["CLAUDE_CONFIG_DIR"], dir.display().to_string());
    let rows = a.snapshot();
    assert!(rows.iter().all(|r| r.key != "claude:own"), "own login is not polled while an account is active");
    let row = rows.iter().find(|r| r.account_id.as_deref() == Some(sub.id.as_str())).unwrap();
    assert_eq!((row.active, row.email.as_deref()), (true, Some("work@example.com")));

    let key = a.add(Provider::Claude, Kind::ApiKey, "API").unwrap();
    assert!(a.set_key(&key.id, "nope").is_err());
    assert!(a.set_key(&sub.id, &format!("sk-ant-{}", "a".repeat(30))).is_err(), "not an API-key account");
    a.set_key(&key.id, &format!("sk-ant-{}", "a".repeat(30))).unwrap();
    a.set_active(Provider::Claude, Some(&key.id)).unwrap();
    let env = a.agent_env(Provider::Claude).unwrap();
    assert!(env.set["ANTHROPIC_API_KEY"].starts_with("sk-ant-"));
    let shell = env_for_program(&a, "/usr/local/bin/claude").unwrap();
    assert!(shell.contains_key("ANTHROPIC_API_KEY"));
    assert!(env_for_program(&a, "codex").unwrap().is_empty(), "codex has no active account");
    assert!(env_for_program(&a, "bash").unwrap().is_empty());
    let snapshot = a.snapshot();
    let row = snapshot.iter().find(|r| r.account_id.as_deref() == Some(key.id.as_str())).unwrap();
    assert_eq!(row.status, "api_key");
    assert!(!serde_json::to_string(&snapshot).unwrap().contains("sk-ant-"), "the key never reaches the webview");

    a.remove(&key.id).unwrap();
    assert!(a.agent_env(Provider::Claude).unwrap().is_empty(), "back to the user's own login");
    a.remove(&sub.id).unwrap();
    assert!(!dir.exists());
    assert!(tmp.path().join("home/.claude/projects").is_dir(), "the user's own folder is untouched");
  }
}

// ---- OpenCode / Devin managed data accounts --------------------------------------------------

#[tauri::command]
pub async fn managed_accounts_list(app: tauri::AppHandle) -> Result<BTreeMap<String, managed::State>, String> {
  blocking(move || app.state::<Accounts>().managed.list()).await
}

#[tauri::command]
pub async fn managed_account_select(app: tauri::AppHandle, provider: String, id: Option<String>) -> Result<managed::State, String> {
  let p = managed::DataProvider::parse(&provider)?;
  blocking(move || app.state::<Accounts>().managed.select(p, id.as_deref())).await?
}

#[tauri::command]
pub async fn managed_account_remove(app: tauri::AppHandle, provider: String, id: String) -> Result<managed::State, String> {
  let p = managed::DataProvider::parse(&provider)?;
  blocking(move || app.state::<Accounts>().managed.remove(p, &id)).await?
}

// ---- Antigravity's saved accounts (accounts/antigravity) ---------------------------------------

/// Antigravity's saved accounts: `list`, `add-current`, `select` or `remove` (with `id`).
#[tauri::command]
pub async fn antigravity_accounts(app: tauri::AppHandle, action: String, id: Option<String>) -> Result<antigravity::AccountState, String> {
  blocking(move || {
    let accounts = app.state::<Accounts>();
    let (run, secrets, home) = (&antigravity::SystemRunner, accounts.secrets.as_ref(), accounts.paths.home.as_path());
    let id = id.unwrap_or_default();
    match action.as_str() {
      "add-current" => antigravity::add_current(run, secrets, home, now_ms()),
      "select" => antigravity::select(run, secrets, home, &id),
      "remove" => antigravity::remove(run, secrets, home, &id),
      _ => antigravity::list(run, secrets, home, now_ms()),
    }
  })
  .await?
}
