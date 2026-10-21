//! Antigravity (`agy`) native account switching (Orca's antigravity native-* modules): the
//! credential agy uses (the macOS Keychain item `gemini`/`antigravity`, else agy's token file) is
//! saved per Google account in a vault — a Kingu Keychain item — and written back on Select, with
//! a compare-and-swap and a read-back check. agy's quota is read by `usage::antigravity`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::accounts::secrets::SecretStore;
use crate::i18n::msg::ProvidersMsg;
use crate::tr;

const VAULT_ID: &str = "provider:antigravity:vault";
const MAX_TOKEN_FILE: u64 = 64 * 1024;

/// Runs `security` (with stdin for writes) and returns its exit code and stdout.
pub trait Runner: Send + Sync {
  fn run(&self, program: &str, args: &[&str], stdin: Option<&str>, timeout: Duration) -> Result<(Option<i32>, String), String>;
}

pub struct SystemRunner;

impl Runner for SystemRunner {
  fn run(&self, program: &str, args: &[&str], stdin: Option<&str>, timeout: Duration) -> Result<(Option<i32>, String), String> {
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    let mut child = Command::new(program)
      .args(args)
      .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
      .stdout(Stdio::piped())
      .stderr(Stdio::null())
      .spawn()
      .map_err(|e| e.to_string())?;
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
      let _ = pipe.write_all(input.as_bytes());
    }
    let mut out = child.stdout.take();
    let reader = std::thread::spawn(move || {
      let mut s = Vec::new();
      if let Some(o) = out.as_mut() {
        let _ = o.take(256 * 1024).read_to_end(&mut s);
      }
      s
    });
    let deadline = std::time::Instant::now() + timeout;
    let code = loop {
      match child.try_wait().map_err(|e| e.to_string())? {
        Some(status) => break status.code(),
        None if std::time::Instant::now() >= deadline => {
          let _ = child.kill();
          let _ = child.wait();
          break None;
        }
        None => std::thread::sleep(Duration::from_millis(25)),
      }
    };
    Ok((code, String::from_utf8_lossy(&reader.join().unwrap_or_default()).into_owned()))
  }
}

/// The payload of a JWT (unverified: only to read the Google identity).
fn jwt_payload(token: &str) -> Option<Value> {
  use base64::Engine;
  let part = token.split('.').nth(1)?;
  let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(part.trim_end_matches('=')).ok()?;
  serde_json::from_slice(&bytes).ok()
}

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
    let (code, stdout) = run.run("/usr/bin/security", &["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"], None, Duration::from_secs(5))?;
    match code {
      Some(0) => return Ok(decode_keyring(&stdout)),
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
  let (code, _) = run.run("/usr/bin/security", &["-i"], Some(&line), Duration::from_secs(10))?;
  if code != Some(0) {
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
