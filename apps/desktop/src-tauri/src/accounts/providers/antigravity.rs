//! Antigravity (the `agy` CLI): quota and native account switching (Orca's antigravity-usage-* and
//! native-* modules).
//!
//! Usage: agy keeps its own Google credential, so Kingu asks it (`agy -p /usage --output-format
//! json`, agy 1.1.11 or newer, only while its status-bar item is on). An agy that answers `/usage`
//! as a prompt (spending a turn) is not asked again until Kingu restarts.
//!
//! Switching: the native credential (macOS Keychain item `gemini`/`antigravity`, else agy's token
//! file) is saved per Google account in a vault — a Kingu Keychain item — and written back on
//! Select, with a compare-and-swap and a read-back check.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Bucket, Ctx, Runner, Status, Usage, jwt_payload, parse_iso, window};
use crate::accounts::secrets::SecretStore;
use crate::i18n::msg::ProvidersMsg;
use crate::tr;

const P: &str = "antigravity";
const MIN_VERSION: (u32, u32, u32) = (1, 1, 11);
const VAULT_ID: &str = "provider:antigravity:vault";
const MAX_TOKEN_FILE: u64 = 64 * 1024;

static TURN_SPENT: AtomicBool = AtomicBool::new(false);

// ---- usage ------------------------------------------------------------------------------------

pub fn version_of(text: &str) -> Option<(u32, u32, u32)> {
  let re = regex::Regex::new(r"(\d+)\.(\d+)\.(\d+)").expect("regex");
  let c = re.captures(text)?;
  Some((c[1].parse().ok()?, c[2].parse().ok()?, c[3].parse().ok()?))
}

pub fn fetch(ctx: &Ctx) -> Usage {
  if !ctx.config.antigravity {
    return Usage::new(P, Status::Idle);
  }
  if TURN_SPENT.load(Ordering::Relaxed) {
    return Usage::unavailable(P, tr!(ProvidersMsg::AgyTurnSpent), "usage-unavailable");
  }
  let Some(bin) = ctx.run.which("agy") else { return Usage::unavailable(P, tr!(ProvidersMsg::AgyMissing), "cli-unavailable") };
  let bin = bin.display().to_string();
  let version = ctx.run.run(&bin, &["--version"], None, Duration::from_secs(5)).ok().and_then(|o| version_of(&o.stdout).or_else(|| version_of(&o.stderr)));
  match version {
    None => return Usage::unavailable(P, tr!(ProvidersMsg::AgyNoVersion), "cli-unavailable"),
    Some(v) if v < MIN_VERSION => return Usage::unavailable(P, tr!(ProvidersMsg::AgyTooOld, version = format!("{}.{}.{}", v.0, v.1, v.2)), "cli-unavailable"),
    Some(_) => {}
  }
  let out = match ctx.run.run(&bin, &["-p", "/usage", "--output-format", "json", "--print-timeout", "20s"], None, Duration::from_secs(30)) {
    Ok(o) => o,
    Err(e) => return Usage::error(P, tr!(ProvidersMsg::AgyNotStarted, detail = e), "cli-unavailable"),
  };
  if out.timed_out {
    return Usage::error(P, tr!(ProvidersMsg::AgyTimeout), "server");
  }
  parse_output(&out.stdout, &out.stderr, out.code)
}

pub fn parse_output(stdout: &str, stderr: &str, code: Option<i32>) -> Usage {
  let lines: Vec<Value> = stdout.lines().filter(|l| l.trim_start().starts_with('{')).filter_map(|l| serde_json::from_str(l.trim()).ok()).collect();
  if let Some(u) = lines.iter().find_map(parse_usage_line) {
    return u;
  }
  if lines.iter().any(|v| v["num_turns"].as_u64().unwrap_or(0) > 0 || v["conversation_id"].as_str().is_some_and(|c| !c.is_empty())) {
    TURN_SPENT.store(true, Ordering::Relaxed);
    return Usage::unavailable(P, tr!(ProvidersMsg::AgyTurnSpent), "usage-unavailable");
  }
  let all = format!("{stdout}\n{stderr}");
  let structured = all.lines().find_map(|l| l.split_once("AGY_ERROR:").and_then(|(_, j)| serde_json::from_str::<Value>(j.trim()).ok()));
  if let Some(e) = structured {
    let status = e["status"].as_str().unwrap_or_default();
    let code = e["error_code"].as_i64().unwrap_or(0);
    if status == "UNAUTHENTICATED" || code == 401 {
      return Usage::unavailable(P, tr!(ProvidersMsg::AgySignedOut), "missing-credentials");
    }
    if status == "PERMISSION_DENIED" || code == 403 {
      return Usage::error(P, tr!(ProvidersMsg::AgyNotEntitled), "no-subscription");
    }
    if status == "RESOURCE_EXHAUSTED" || code == 429 {
      return Usage::error(P, tr!(ProvidersMsg::AgyRateLimited), "rate-limited");
    }
    if (500..600).contains(&code) {
      return Usage::error(P, tr!(ProvidersMsg::AgyServer), "server");
    }
  }
  let low = all.to_lowercase();
  if ["not logged in", "run agy login", "unauthenticated", "not signed in", "please sign in", "login required"].iter().any(|p| low.contains(p)) {
    return Usage::unavailable(P, tr!(ProvidersMsg::AgySignedOut), "missing-credentials");
  }
  Usage::error(P, tr!(ProvidersMsg::AgyNoQuota, code = code.map_or_else(|| "?".to_owned(), |c| c.to_string())), "parse")
}

fn parse_usage_line(v: &Value) -> Option<Usage> {
  if v["status"] != "SUCCESS" || v["command"]["name"] != "usage" {
    return None;
  }
  let groups = v["command"]["data"]["groups"].as_array()?;
  let mut buckets = Vec::new();
  for g in groups {
    let gname = g["name"].as_str().unwrap_or("Antigravity");
    let enabled: Vec<&Value> = g["buckets"].as_array().map(|b| b.iter().filter(|x| x["disabled"] != true).collect()).unwrap_or_default();
    for b in &enabled {
      let Some(frac) = b["remaining_fraction"].as_f64() else { continue };
      let minutes = match b["window"].as_str() {
        Some("weekly") => 10080,
        Some("5h") => 300,
        _ => 0,
      };
      let name = if enabled.len() > 1 { format!("{gname} · {}", b["name"].as_str().unwrap_or("")) } else { gname.to_owned() };
      buckets.push(Bucket { name, window: window((1.0 - frac) * 100.0, minutes, b["reset_time"].as_str().and_then(parse_iso)) });
    }
  }
  if buckets.is_empty() {
    return None;
  }
  let worst = |m: u32| buckets.iter().filter(|b| b.window.window_minutes == m).max_by(|a, b| a.window.used_percent.total_cmp(&b.window.used_percent)).map(|b| b.window.clone());
  Some(Usage { session: worst(300), weekly: worst(10080), ..Usage { buckets: buckets.clone(), ..Usage::new(P, Status::Ok) } })
}

// ---- native account switching -----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
  pub email: Option<String>,
  pub subject: Option<String>,
  pub auth_method: String,
  pub identity_known: bool,
}

/// The credential's auth method and Google identity (`id_token` from accounts.google.com).
pub fn identity_of(blob: &str) -> Option<Identity> {
  let v: Value = serde_json::from_str(blob).ok()?;
  let auth_method = v["auth_method"].as_str()?.to_owned();
  v["token"]["access_token"].as_str()?;
  let claims = v["id_token"].as_str().or(v["token"]["id_token"].as_str()).and_then(jwt_payload);
  let google = claims.as_ref().filter(|c| matches!(c["iss"].as_str(), Some("accounts.google.com" | "https://accounts.google.com")));
  let subject = google.and_then(|c| c["sub"].as_str().map(str::to_owned));
  let email = google.filter(|c| c["email_verified"] == true).and_then(|c| c["email"].as_str().map(str::to_owned));
  Some(Identity { identity_known: subject.is_some(), email, subject, auth_method })
}

/// The keychain value: `go-keyring-base64:<b64>`, `go-keyring-encoded:<hex>` or raw JSON.
pub fn decode_keyring(value: &str) -> Option<String> {
  use base64::Engine;
  let v = value.trim();
  if let Some(b) = v.strip_prefix("go-keyring-base64:") {
    return String::from_utf8(base64::engine::general_purpose::STANDARD.decode(b).ok()?).ok();
  }
  if let Some(h) = v.strip_prefix("go-keyring-encoded:") {
    let bytes: Option<Vec<u8>> = (0..h.len()).step_by(2).map(|i| h.get(i..i + 2).and_then(|x| u8::from_str_radix(x, 16).ok())).collect();
    return String::from_utf8(bytes?).ok();
  }
  Some(v.to_owned())
}

fn token_file(home: &Path) -> PathBuf {
  home.join(".gemini/antigravity-cli/antigravity-oauth-token")
}

fn use_file_backend() -> bool {
  !cfg!(target_os = "macos") || ["SSH_TTY", "SSH_CLIENT", "SSH_CONNECTION"].iter().any(|k| std::env::var_os(k).is_some())
}

/// The native credential agy uses now (None when signed out).
pub fn read_native(run: &dyn Runner, home: &Path) -> Result<Option<String>, String> {
  if home.join(".gemini/antigravity-cli/cache/antigravity-keyring-unavailable").exists() && !use_file_backend() {
    return Err(tr!(ProvidersMsg::AgyKeyringUnavailable));
  }
  if !use_file_backend() {
    let o = run.run("/usr/bin/security", &["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"], None, Duration::from_secs(5))?;
    match o.code {
      Some(0) => return Ok(decode_keyring(&o.stdout)),
      Some(44) => {}
      _ => return Err(tr!(ProvidersMsg::AgyKeychain)),
    }
  }
  let file = token_file(home);
  let Ok(meta) = std::fs::metadata(&file) else { return Ok(None) };
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    if meta.permissions().mode() & 0o077 != 0 || meta.len() > MAX_TOKEN_FILE {
      return Err(tr!(ProvidersMsg::AgyTokenFileUnsafe));
    }
  }
  std::fs::read_to_string(&file).map(Some).map_err(|e| e.to_string())
}

fn write_native(run: &dyn Runner, home: &Path, blob: &str) -> Result<(), String> {
  use base64::Engine;
  if use_file_backend() {
    let file = token_file(home);
    let tmp = file.with_extension("kingu-tmp");
    {
      use std::io::Write;
      let mut opts = std::fs::OpenOptions::new();
      opts.write(true).create(true).truncate(true);
      #[cfg(unix)]
      std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
      opts.open(&tmp).and_then(|mut f| f.write_all(blob.as_bytes())).map_err(|e| e.to_string())?;
    }
    return std::fs::rename(&tmp, &file).map_err(|e| e.to_string());
  }
  // Through stdin (`security -i`) so the secret never shows up in a process list.
  let line = format!("add-generic-password -U -s \"gemini\" -a \"antigravity\" -w go-keyring-base64:{}\n", base64::engine::general_purpose::STANDARD.encode(blob));
  if line.len() > 4096 {
    return Err(tr!(ProvidersMsg::AgyTooLarge));
  }
  let o = run.run("/usr/bin/security", &["-i"], Some(&line), Duration::from_secs(10))?;
  if o.code != Some(0) {
    return Err(tr!(ProvidersMsg::AgyKeychain));
  }
  Ok(())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vault {
  accounts: Vec<Saved>,
  selected_account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
  id: String,
  email: Option<String>,
  subject: Option<String>,
  auth_method: String,
  created_at: u64,
  updated_at: u64,
  credentials: String,
}

impl Saved {
  fn matches(&self, current: &str, id: &Option<Identity>) -> bool {
    match id {
      Some(i) if i.identity_known => self.subject == i.subject && self.auth_method == i.auth_method,
      _ => self.credentials == current,
    }
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRow {
  pub id: String,
  pub email: Option<String>,
  pub subject: Option<String>,
  pub auth_method: String,
  pub created_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountState {
  pub accounts: Vec<AccountRow>,
  pub active_account_id: Option<String>,
  pub selected_account_id: Option<String>,
  pub current_account: Option<Identity>,
}

fn load_vault(secrets: &dyn SecretStore) -> Vault {
  secrets.get(VAULT_ID).and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
}

fn save_vault(secrets: &dyn SecretStore, vault: &Vault) -> Result<(), String> {
  secrets.set(VAULT_ID, &serde_json::to_string(vault).map_err(|e| e.to_string())?)
}

fn state_of(vault: &Vault, current: Option<&str>) -> AccountState {
  let id = current.and_then(identity_of);
  let active = current.and_then(|c| vault.accounts.iter().find(|a| a.matches(c, &id))).map(|a| a.id.clone());
  AccountState {
    accounts: vault.accounts.iter().map(|a| AccountRow { id: a.id.clone(), email: a.email.clone(), subject: a.subject.clone(), auth_method: a.auth_method.clone(), created_at: a.created_at }).collect(),
    active_account_id: active,
    selected_account_id: vault.selected_account_id.clone(),
    current_account: id,
  }
}

/// The saved accounts and the current native one; a saved blob that agy refreshed since is updated.
pub fn list(run: &dyn Runner, secrets: &dyn SecretStore, home: &Path, now: u64) -> Result<AccountState, String> {
  let current = read_native(run, home)?;
  let mut vault = load_vault(secrets);
  if let Some(c) = &current {
    let id = identity_of(c);
    if let Some(a) = vault.accounts.iter_mut().find(|a| a.matches(c, &id))
      && a.credentials != *c
    {
      a.credentials = c.clone();
      a.updated_at = now;
      save_vault(secrets, &vault)?;
    }
  }
  Ok(state_of(&vault, current.as_deref()))
}

pub fn add_current(run: &dyn Runner, secrets: &dyn SecretStore, home: &Path, now: u64) -> Result<AccountState, String> {
  let current = read_native(run, home)?.ok_or_else(|| tr!(ProvidersMsg::AgyNoCurrent))?;
  let id = identity_of(&current).filter(|i| i.identity_known).ok_or_else(|| tr!(ProvidersMsg::AgyNoIdentity))?;
  let mut vault = load_vault(secrets);
  let some_id = Some(id.clone());
  match vault.accounts.iter_mut().find(|a| a.matches(&current, &some_id)) {
    Some(a) => {
      a.credentials = current.clone();
      a.email = id.email.clone();
      a.updated_at = now;
    }
    None => vault.accounts.push(Saved {
      id: crate::accounts::managed::new_uuid(),
      email: id.email.clone(),
      subject: id.subject.clone(),
      auth_method: id.auth_method.clone(),
      created_at: now,
      updated_at: now,
      credentials: current.clone(),
    }),
  }
  let saved = vault.accounts.iter().find(|a| a.matches(&current, &some_id)).map(|a| a.id.clone());
  vault.selected_account_id = saved;
  save_vault(secrets, &vault)?;
  Ok(state_of(&vault, Some(&current)))
}

pub fn select(run: &dyn Runner, secrets: &dyn SecretStore, home: &Path, id: &str) -> Result<AccountState, String> {
  let mut vault = load_vault(secrets);
  let blob = vault.accounts.iter().find(|a| a.id == id).map(|a| a.credentials.clone()).ok_or_else(|| tr!(ProvidersMsg::AccountNotFound))?;
  let before = read_native(run, home)?;
  // Compare-and-swap: refuse if the native credential changed since it was read.
  if read_native(run, home)? != before {
    return Err(tr!(ProvidersMsg::AgyChanged));
  }
  write_native(run, home, &blob)?;
  if read_native(run, home)?.as_deref() != Some(blob.as_str()) {
    return Err(tr!(ProvidersMsg::AgyNotVerified));
  }
  vault.selected_account_id = Some(id.to_owned());
  save_vault(secrets, &vault)?;
  Ok(state_of(&vault, Some(&blob)))
}

pub fn remove(run: &dyn Runner, secrets: &dyn SecretStore, home: &Path, id: &str) -> Result<AccountState, String> {
  let current = read_native(run, home)?;
  let mut vault = load_vault(secrets);
  let state = state_of(&vault, current.as_deref());
  if state.selected_account_id.as_deref() == Some(id) || state.active_account_id.as_deref() == Some(id) {
    return Err(tr!(ProvidersMsg::AgySelectOther));
  }
  vault.accounts.retain(|a| a.id != id);
  save_vault(secrets, &vault)?;
  Ok(state_of(&vault, current.as_deref()))
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn parses_usage_and_failures() {
    let ok = json!({ "status": "SUCCESS", "command": { "name": "usage", "data": { "groups": [
      { "name": "Gemini Models", "buckets": [
        { "id": "gemini-weekly", "name": "Weekly", "window": "weekly", "remaining_fraction": 0.4, "reset_time": "1970-01-01T00:00:01Z" },
        { "id": "gemini-5h", "name": "5h", "window": "5h", "remaining_fraction": 0.9 }
      ]},
      { "name": "Claude and GPT models", "buckets": [ { "window": "5h", "remaining_fraction": 0.5 }, { "window": "weekly", "disabled": true, "remaining_fraction": 0 } ] }
    ]}}});
    let u = parse_output(&format!("noise\n{ok}\n"), "", Some(0));
    assert_eq!(u.status, Status::Ok);
    assert_eq!(u.buckets[0].name, "Gemini Models · Weekly");
    assert_eq!(u.buckets[2].name, "Claude and GPT models");
    assert_eq!(u.session.unwrap().used_percent, 50.0);
    assert_eq!(u.weekly.unwrap().used_percent, 60.0);
    let out = parse_output("", "AGY_ERROR:{\"status\":\"UNAUTHENTICATED\"}", Some(1));
    assert_eq!(out.status, Status::Unavailable);
    assert_eq!(version_of("agy version 1.2.0 (abc)"), Some((1, 2, 0)));
    assert!(version_of("1.1.10").unwrap() < MIN_VERSION);
  }

  #[test]
  fn reads_identities_and_keyring_values() {
    use base64::Engine;
    let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"iss":"https://accounts.google.com","sub":"42","email":"a@b.c","email_verified":true}"#);
    let blob = format!(r#"{{"auth_method":"oauth","token":{{"access_token":"t","id_token":"h.{claims}.s"}}}}"#);
    let id = identity_of(&blob).unwrap();
    assert_eq!((id.subject.as_deref(), id.email.as_deref(), id.identity_known), (Some("42"), Some("a@b.c"), true));
    let b64 = base64::engine::general_purpose::STANDARD.encode(&blob);
    assert_eq!(decode_keyring(&format!("go-keyring-base64:{b64}")).as_deref(), Some(blob.as_str()));
    assert_eq!(decode_keyring("go-keyring-encoded:7b7d").as_deref(), Some("{}"));
    assert!(identity_of("{\"auth_method\":\"x\"}").is_none());
  }
}
