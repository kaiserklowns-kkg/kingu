//! What the provider CLIs leave behind after a login, read the way Orca reads it:
//! - Claude Code: the OAuth token in the macOS Keychain item `Claude Code-credentials` (with
//!   `-<first 8 hex of sha256(CLAUDE_CONFIG_DIR)>` when a config dir is set; account `$USER`),
//!   read through `/usr/bin/security` (Claude Code creates the item with it, so no prompt), else
//!   `<config dir>/.credentials.json`. Identity from `.claude.json` → `oauthAccount`.
//! - Codex: `$CODEX_HOME/auth.json` (`tokens.access_token`, `tokens.account_id`, `id_token`).
//!
//! Tokens stay in Rust: they go only into the usage request to the provider.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;
use sha2::{Digest, Sha256};

pub const CLAUDE_SERVICE: &str = "Claude Code-credentials";
const SECURITY_TIMEOUT: Duration = Duration::from_secs(3);

/// A bearer token. Debug never prints it.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(pub String);

impl std::fmt::Debug for Secret {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str("Secret(…)")
  }
}

impl Secret {
  /// A short hash, to notice that the CLI refreshed or replaced the token without keeping it.
  pub fn fingerprint(&self) -> String {
    Sha256::digest(self.0.as_bytes()).iter().take(6).map(|b| format!("{b:02x}")).collect()
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Token {
  /// Signed in with a subscription: the OAuth access token.
  OAuth { token: Secret, expires_at: Option<u64>, plan: Option<String>, account_id: Option<String> },
  /// Signed in, but billed by API key: there are no plan limits to show.
  ApiKey,
  None,
  /// The keychain could not be read (locked, timed out).
  Unavailable,
}

/// Where a provider's login lives for one usage subject.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
  /// `config_dir`: `CLAUDE_CONFIG_DIR` (None: the default `~/.claude`). `unsuffixed_fallback`:
  /// also try the plain keychain item (the user's own login when Kingu itself runs with a config dir).
  Claude { config_dir: Option<PathBuf>, home: PathBuf, unsuffixed_fallback: bool },
  Codex { home: PathBuf },
}

/// `Claude Code-credentials[-xxxxxxxx]`.
pub fn claude_service(config_dir: Option<&str>) -> String {
  match config_dir {
    None => CLAUDE_SERVICE.to_owned(),
    Some(d) => {
      let h: String = Sha256::digest(d.as_bytes()).iter().take(4).map(|b| format!("{b:02x}")).collect();
      format!("{CLAUDE_SERVICE}-{h}")
    }
  }
}

/// The keychain account Claude Code uses: `$USER`, or `claude-code-user` when it has odd characters.
pub fn claude_keychain_account(user: Option<&str>) -> String {
  match user {
    Some(u) if !u.is_empty() && u.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) => u.to_owned(),
    _ => "claude-code-user".to_owned(),
  }
}

/// The config dir as given and its real path, when different (Claude may have hashed either).
fn dir_candidates(dir: &Path) -> Vec<String> {
  let mut out = vec![dir.to_string_lossy().into_owned()];
  if let Ok(real) = std::fs::canonicalize(dir) {
    let real = real.to_string_lossy().into_owned();
    if !out.contains(&real) {
      out.push(real);
    }
  }
  out
}

/// `{"claudeAiOauth":{"accessToken","refreshToken","expiresAt","subscriptionType"}}`.
pub fn parse_claude_credentials(text: &str) -> Token {
  let Ok(v) = serde_json::from_str::<Value>(text) else { return Token::Unavailable };
  let o = &v["claudeAiOauth"];
  match o["accessToken"].as_str().filter(|t| !t.is_empty()) {
    Some(t) => Token::OAuth {
      token: Secret(t.to_owned()),
      expires_at: o["expiresAt"].as_u64(),
      plan: o["subscriptionType"].as_str().map(str::to_owned),
      account_id: None,
    },
    None => Token::None,
  }
}

/// `auth.json`: ChatGPT login (`tokens`) or an API key (`OPENAI_API_KEY`).
pub fn parse_codex_auth(text: &str) -> Token {
  let Ok(v) = serde_json::from_str::<Value>(text) else { return Token::Unavailable };
  if let Some(t) = v["tokens"]["access_token"].as_str().filter(|t| !t.is_empty()) {
    let id_token = v["tokens"]["id_token"].as_str().and_then(jwt_payload);
    return Token::OAuth {
      token: Secret(t.to_owned()),
      expires_at: None,
      plan: id_token.as_ref().and_then(|p| p["https://api.openai.com/auth"]["chatgpt_plan_type"].as_str().map(str::to_owned)),
      account_id: v["tokens"]["account_id"].as_str().map(str::to_owned),
    };
  }
  if v["OPENAI_API_KEY"].as_str().is_some_and(|k| !k.is_empty()) {
    return Token::ApiKey;
  }
  Token::None
}

/// The JSON payload of a JWT, unverified (display only: email, plan).
pub fn jwt_payload(jwt: &str) -> Option<Value> {
  let part = jwt.split('.').nth(1)?;
  serde_json::from_slice(&base64url(part)?).ok()
}

fn base64url(s: &str) -> Option<Vec<u8>> {
  let mut out = Vec::with_capacity(s.len() * 3 / 4);
  let (mut acc, mut bits) = (0u32, 0u32);
  for c in s.bytes().filter(|&c| c != b'=') {
    let v = match c {
      b'A'..=b'Z' => c - b'A',
      b'a'..=b'z' => c - b'a' + 26,
      b'0'..=b'9' => c - b'0' + 52,
      b'-' | b'+' => 62,
      b'_' | b'/' => 63,
      _ => return None,
    } as u32;
    acc = (acc << 6) | v;
    bits += 6;
    if bits >= 8 {
      bits -= 8;
      out.push((acc >> bits) as u8);
      acc &= (1 << bits) - 1;
    }
  }
  Some(out)
}

/// Who is signed in (shown in the accounts list), from files only — never the token.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct Identity {
  pub signed_in: bool,
  pub email: Option<String>,
  pub org: Option<String>,
  pub plan: Option<String>,
}

/// `.claude.json` of a config dir (or `~/.claude.json` for the default one).
pub fn claude_global_file(config_dir: Option<&Path>, home: &Path) -> PathBuf {
  match config_dir {
    Some(d) => d.join(".claude.json"),
    None => home.join(".claude.json"),
  }
}

pub fn claude_identity(global_file: &Path) -> Identity {
  let Ok(text) = std::fs::read_to_string(global_file) else { return Identity::default() };
  let Ok(v) = serde_json::from_str::<Value>(&text) else { return Identity::default() };
  let a = &v["oauthAccount"];
  let s = |k: &str| a[k].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);
  let email = s("emailAddress");
  Identity { signed_in: email.is_some(), email, org: s("organizationName"), plan: None }
}

pub fn codex_identity(home: &Path) -> Identity {
  let Ok(text) = std::fs::read_to_string(home.join("auth.json")) else { return Identity::default() };
  let Ok(v) = serde_json::from_str::<Value>(&text) else { return Identity::default() };
  let claims = v["tokens"]["id_token"].as_str().and_then(jwt_payload);
  let email = claims.as_ref().and_then(|c| c["email"].as_str().map(str::to_owned));
  let plan = claims.as_ref().and_then(|c| c["https://api.openai.com/auth"]["chatgpt_plan_type"].as_str().map(str::to_owned));
  let signed_in = !matches!(parse_codex_auth(&text), Token::None | Token::Unavailable);
  Identity { signed_in, email, org: None, plan }
}

/// Reads the login for a target. A trait so tests never touch the real keychain.
pub trait CredentialSource: Send + Sync {
  fn token(&self, target: &Target) -> Token;
  /// Drops what Claude Code stored for an account's config dir (on account removal).
  fn forget_claude(&self, config_dir: &Path);
}

pub struct SystemCredentials;

impl CredentialSource for SystemCredentials {
  fn token(&self, target: &Target) -> Token {
    match target {
      Target::Claude { config_dir, home, unsuffixed_fallback } => {
        let mut services: Vec<String> = match config_dir {
          Some(d) => dir_candidates(d).iter().map(|c| claude_service(Some(c))).collect(),
          None => vec![claude_service(None)],
        };
        if *unsuffixed_fallback && config_dir.is_some() {
          services.push(claude_service(None));
        }
        let mut unavailable = false;
        if cfg!(target_os = "macos") {
          let account = claude_keychain_account(std::env::var("USER").ok().as_deref());
          for service in &services {
            match security_find(service, &account) {
              Ok(Some(text)) => match parse_claude_credentials(&text) {
                Token::None | Token::Unavailable => {}
                t => return t,
              },
              Ok(None) => {}
              Err(()) => unavailable = true,
            }
          }
        }
        let dir = config_dir.clone().unwrap_or_else(|| home.join(".claude"));
        match std::fs::read_to_string(dir.join(".credentials.json")) {
          Ok(text) => parse_claude_credentials(&text),
          Err(_) if unavailable => Token::Unavailable,
          Err(_) => Token::None,
        }
      }
      Target::Codex { home } => match std::fs::read_to_string(home.join("auth.json")) {
        Ok(text) => parse_codex_auth(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Token::None,
        Err(_) => Token::Unavailable,
      },
    }
  }

  fn forget_claude(&self, config_dir: &Path) {
    delete_claude_login(config_dir);
  }
}

/// `security find-generic-password -s <service> -a <account> -w`: Ok(None) when there is no
/// such item (exit 44), Err when the keychain did not answer in time or refused.
fn security_find(service: &str, account: &str) -> Result<Option<String>, ()> {
  let out = run_with_timeout(Command::new("/usr/bin/security").args(["find-generic-password", "-s", service, "-a", account, "-w"]), SECURITY_TIMEOUT)?;
  match out.0 {
    Some(0) => Ok(Some(out.1.trim().to_owned()).filter(|s| !s.is_empty())),
    Some(44) => Ok(None),
    _ => Err(()),
  }
}

/// Deletes Claude Code's keychain item of an account's config dir (Orca does this on removal), so
/// the login does not linger. Only ever the suffixed item of that dir, never the user's own.
fn delete_claude_login(config_dir: &Path) {
  if !cfg!(target_os = "macos") {
    return;
  }
  for c in dir_candidates(config_dir) {
    let service = claude_service(Some(&c));
    for _ in 0..4 {
      let r = run_with_timeout(Command::new("/usr/bin/security").args(["delete-generic-password", "-s", &service]), SECURITY_TIMEOUT);
      if !matches!(r, Ok((Some(0), _))) {
        break;
      }
    }
  }
}

/// Exit code (None when killed) and stdout. stderr is dropped.
fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Result<(Option<i32>, String), ()> {
  let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_| ())?;
  let mut stdout = child.stdout.take().ok_or(())?;
  let reader = std::thread::spawn(move || {
    let mut s = String::new();
    let _ = stdout.read_to_string(&mut s);
    s
  });
  let start = Instant::now();
  loop {
    match child.try_wait() {
      Ok(Some(status)) => return Ok((status.code(), reader.join().unwrap_or_default())),
      Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(20)),
      _ => {
        let _ = child.kill();
        let _ = child.wait();
        return Err(());
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn b64(s: &str) -> String {
    // Test-only encoder (base64url, no padding).
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let b = s.as_bytes();
    let mut out = String::new();
    for chunk in b.chunks(3) {
      let n = chunk.iter().enumerate().fold(0u32, |acc, (i, &x)| acc | (x as u32) << (16 - 8 * i));
      for i in 0..=chunk.len() {
        out.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
      }
    }
    out
  }

  #[test]
  fn keychain_names_match_claude_code() {
    assert_eq!(claude_service(None), "Claude Code-credentials");
    let s = claude_service(Some("/tmp/x"));
    let want: String = Sha256::digest(b"/tmp/x").iter().take(4).map(|b| format!("{b:02x}")).collect();
    assert_eq!(s, format!("Claude Code-credentials-{want}"));
    assert_eq!(s.len(), CLAUDE_SERVICE.len() + 9);
    assert_eq!(claude_keychain_account(Some("bright")), "bright");
    assert_eq!(claude_keychain_account(Some("a b")), "claude-code-user");
    assert_eq!(claude_keychain_account(None), "claude-code-user");
  }

  #[test]
  fn claude_credentials() {
    let t = parse_claude_credentials(r#"{"claudeAiOauth":{"accessToken":"sk-ant-oat01-x","refreshToken":"r","expiresAt":1760000000000,"subscriptionType":"max"}}"#);
    let Token::OAuth { token, expires_at, plan, .. } = t else { panic!() };
    assert_eq!(token.0, "sk-ant-oat01-x");
    assert_eq!(expires_at, Some(1_760_000_000_000));
    assert_eq!(plan.as_deref(), Some("max"));
    assert!(!format!("{token:?}").contains("sk-ant"));
    assert_eq!(parse_claude_credentials(r#"{"claudeAiOauth":{}}"#), Token::None);
    assert_eq!(parse_claude_credentials("nope"), Token::Unavailable);
  }

  #[test]
  fn codex_auth_and_identity() {
    let claims = format!(
      "h.{}.s",
      b64(r#"{"email":"me@example.com","https://api.openai.com/auth":{"chatgpt_plan_type":"plus"}}"#)
    );
    let auth = format!(r#"{{"OPENAI_API_KEY":null,"tokens":{{"id_token":"{claims}","access_token":"at","account_id":"acc-1"}}}}"#);
    let Token::OAuth { token, plan, account_id, .. } = parse_codex_auth(&auth) else { panic!() };
    assert_eq!((token.0.as_str(), plan.as_deref(), account_id.as_deref()), ("at", Some("plus"), Some("acc-1")));
    assert_eq!(parse_codex_auth(r#"{"OPENAI_API_KEY":"sk-x"}"#), Token::ApiKey);
    assert_eq!(parse_codex_auth(r#"{}"#), Token::None);

    let tmp = tempfile::tempdir().unwrap();
    assert_eq!(codex_identity(tmp.path()), Identity::default());
    std::fs::write(tmp.path().join("auth.json"), &auth).unwrap();
    let id = codex_identity(tmp.path());
    assert!(id.signed_in);
    assert_eq!(id.email.as_deref(), Some("me@example.com"));
    assert_eq!(id.plan.as_deref(), Some("plus"));
  }

  #[test]
  fn claude_identity_from_global_file() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("cfg");
    std::fs::create_dir_all(&dir).unwrap();
    let file = claude_global_file(Some(&dir), tmp.path());
    assert_eq!(file, dir.join(".claude.json"));
    assert_eq!(claude_global_file(None, tmp.path()), tmp.path().join(".claude.json"));
    assert!(!claude_identity(&file).signed_in);
    std::fs::write(&file, r#"{"oauthAccount":{"emailAddress":" me@example.com ","organizationName":"Org"}}"#).unwrap();
    let id = claude_identity(&file);
    assert_eq!((id.signed_in, id.email.as_deref(), id.org.as_deref()), (true, Some("me@example.com"), Some("Org")));
  }

  #[test]
  fn credentials_file_fallback_without_keychain() {
    // A config dir whose keychain item cannot exist (fresh temp path): the file is used.
    let tmp = tempfile::tempdir().unwrap();
    let codex = SystemCredentials.token(&Target::Codex { home: tmp.path().into() });
    assert_eq!(codex, Token::None);
    std::fs::write(tmp.path().join("auth.json"), r#"{"tokens":{"access_token":"at"}}"#).unwrap();
    assert!(matches!(SystemCredentials.token(&Target::Codex { home: tmp.path().into() }), Token::OAuth { .. }));
  }

  #[test]
  fn jwt_and_base64() {
    assert_eq!(base64url(&b64("hello?")).unwrap(), b"hello?");
    assert_eq!(base64url("aGk").unwrap(), b"hi");
    assert!(base64url("a b").is_none());
    assert!(jwt_payload("only-one-part").is_none());
  }
}
