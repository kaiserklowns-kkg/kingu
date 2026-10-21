//! HTTP to the team server and the token store. HTTPS only, except plain HTTP to a loopback
//! host for local development. Redirects are not followed (they could downgrade to HTTP or
//! carry the bearer token elsewhere).

use std::time::Duration;

use super::outbox::Item;
use crate::i18n::msg::TeamMsg;
use crate::tr;

/// Keychain service name for team tokens; the account is the normalized server URL.
pub const KEYCHAIN_SERVICE: &str = "dev.kingu.team";

/// Validates and normalizes a server URL to `scheme://host[:port][/path]` without a trailing
/// slash. HTTPS is required unless the host is loopback.
pub fn normalize_server_url(raw: &str) -> Result<String, String> {
  let raw = raw.trim();
  let url = url::Url::parse(raw).map_err(|e| tr!(TeamMsg::BadServerUrl, detail = e))?;
  let host = url.host_str().ok_or_else(|| tr!(TeamMsg::UrlNeedsHost))?;
  let loopback = matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1");
  match url.scheme() {
    "https" => {}
    "http" if loopback => {}
    "http" => return Err(tr!(TeamMsg::HttpsRequired)),
    s => return Err(tr!(TeamMsg::UnsupportedScheme, scheme = s)),
  }
  if !url.username().is_empty() || url.password().is_some() {
    return Err(tr!(TeamMsg::UrlHasCredentials));
  }
  if url.query().is_some() || url.fragment().is_some() {
    return Err(tr!(TeamMsg::UrlHasQuery));
  }
  let mut out = format!("{}://{}", url.scheme(), host);
  if let Some(port) = url.port() {
    out.push_str(&format!(":{port}"));
  }
  out.push_str(url.path().trim_end_matches('/'));
  Ok(out)
}

/// `kgu_` followed by 43 base64url characters.
pub fn valid_token(token: &str) -> bool {
  token.len() == 47
    && token.starts_with("kgu_")
    && token[4..].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendError {
  /// Network error, timeout, 408, 429 or 5xx: keep and retry later.
  Retryable(String),
  /// 401/403: the token is missing, revoked or lacks rights. Keep, wait for sign-in.
  Unauthorized(String),
  /// Any other 4xx: this state will never be accepted. Drop it.
  Permanent(String),
}

pub fn classify(status: u16, body: &str) -> Result<(), SendError> {
  let code = || {
    serde_json::from_str::<serde_json::Value>(body)
      .ok()
      .and_then(|v| v["error"]["code"].as_str().map(str::to_owned))
      .unwrap_or_default()
  };
  let detail = || format!("HTTP {status} {}", code()).trim().to_owned();
  match status {
    200..=299 => Ok(()),
    401 | 403 => Err(SendError::Unauthorized(detail())),
    408 | 429 | 500..=599 => Err(SendError::Retryable(detail())),
    // A run whose task has not reached the server yet: the task is sent first, so retry.
    409 if code() == "task_not_synced" => Err(SendError::Retryable(detail())),
    _ => Err(SendError::Permanent(detail())),
  }
}

pub trait Transport: Send + Sync {
  /// Delivers one task or run state.
  fn put(&self, server: &str, token: &str, project: &str, item: &Item) -> Result<(), SendError>;
}

pub trait TokenStore: Send + Sync {
  fn get(&self, server: &str) -> Option<String>;
}

pub struct HttpTransport {
  client: reqwest::blocking::Client,
}

impl HttpTransport {
  pub fn new() -> Result<Self, String> {
    let client = crate::net_proxy::client_builder()?
      .timeout(Duration::from_secs(15))
      .connect_timeout(Duration::from_secs(5))
      .redirect(reqwest::redirect::Policy::none())
      .user_agent(concat!("kingu-desktop/", env!("CARGO_PKG_VERSION")))
      .build()
      .map_err(|e| e.to_string())?;
    Ok(Self { client })
  }

  /// `GET /v1/me`: verifies a token before it is stored.
  pub fn me(&self, server: &str, token: &str) -> Result<serde_json::Value, SendError> {
    let res = self
      .client
      .get(format!("{server}/v1/me"))
      .bearer_auth(token)
      .send()
      .map_err(|e| SendError::Retryable(e.without_url().to_string()))?;
    let status = res.status().as_u16();
    let body = res.text().unwrap_or_default();
    classify(status, &body)?;
    serde_json::from_str(&body).map_err(|e| SendError::Permanent(e.to_string()))
  }
}

impl HttpTransport {
  /// `GET /v1/snaps`: the raw body of the team Snap catalog (parsed by `snaps::parse_list`).
  pub fn list_snaps(&self, server: &str, token: &str) -> Result<String, SendError> {
    let res = self
      .client
      .get(format!("{server}/v1/snaps"))
      .bearer_auth(token)
      .send()
      .map_err(|e| SendError::Retryable(e.without_url().to_string()))?;
    let status = res.status().as_u16();
    let body = res.text().unwrap_or_default();
    classify(status, &body).map(|()| body)
  }

  /// `PUT /v1/snaps/{id}` (owner/lead): approves and pins a snap; returns the stored entry's body.
  /// A rejection carries the server's message, since it says which field is wrong.
  pub fn put_snap(&self, server: &str, token: &str, id: &str, body: &impl serde::Serialize) -> Result<String, SendError> {
    // `id` is a snap id (a-z0-9-), which is path-safe.
    let res = self
      .client
      .put(format!("{server}/v1/snaps/{id}"))
      .bearer_auth(token)
      .json(body)
      .send()
      .map_err(|e| SendError::Retryable(e.without_url().to_string()))?;
    let status = res.status().as_u16();
    let text = res.text().unwrap_or_default();
    classify(status, &text).map_err(|e| match e {
      SendError::Permanent(m) => SendError::Permanent(server_message(&text).map_or(m.clone(), |msg| format!("{m}: {msg}"))),
      other => other,
    })?;
    Ok(text)
  }
}

impl HttpTransport {
  /// `method` on `{server}{path}` with an optional JSON body (team skills, `/v1/skills`); returns
  /// the body. A rejection carries the server's message.
  pub fn request(&self, method: reqwest::Method, server: &str, token: &str, path: &str, body: Option<&serde_json::Value>) -> Result<String, SendError> {
    let mut req = self.client.request(method, format!("{server}{path}")).bearer_auth(token);
    if let Some(b) = body {
      req = req.json(b);
    }
    let res = req.send().map_err(|e| SendError::Retryable(e.without_url().to_string()))?;
    let status = res.status().as_u16();
    let text = res.text().unwrap_or_default();
    classify(status, &text).map_err(|e| match e {
      SendError::Permanent(m) => SendError::Permanent(server_message(&text).map_or(m.clone(), |msg| format!("{m}: {msg}"))),
      other => other,
    })?;
    Ok(text)
  }
}

/// `error.message` of a server error body.
pub fn server_message(body: &str) -> Option<String> {
  serde_json::from_str::<serde_json::Value>(body).ok()?["error"]["message"].as_str().map(str::to_owned)
}

impl Transport for HttpTransport {
  fn put(&self, server: &str, token: &str, project: &str, item: &Item) -> Result<(), SendError> {
    // Client task and run ids match [A-Za-z0-9._:-], which is path-safe.
    let (url, body) = match item {
      Item::Task(t) => (format!("{server}/v1/tasks/{}/sync", t.client_task_id), t.wire_body(project)),
      Item::Run(r) => (format!("{server}/v1/tasks/{}/runs/{}/sync", r.client_task_id, r.client_run_id), r.wire_body(project)),
    };
    let res = self
      .client
      .put(url)
      .bearer_auth(token)
      .json(&body)
      .send()
      .map_err(|e| SendError::Retryable(e.without_url().to_string()))?;
    let status = res.status().as_u16();
    let body = res.text().unwrap_or_default();
    classify(status, &body)
  }
}

/// macOS Keychain (Windows Credential Manager / Secret Service elsewhere) via `keyring`.
pub struct Keychain;

impl Keychain {
  fn entry(server: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, server).map_err(|e| e.to_string())
  }

  pub fn set(server: &str, token: &str) -> Result<(), String> {
    Self::entry(server)?.set_password(token).map_err(|e| e.to_string())
  }

  pub fn delete(server: &str) -> Result<(), String> {
    match Self::entry(server)?.delete_credential() {
      Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
      Err(e) => Err(e.to_string()),
    }
  }
}

impl TokenStore for Keychain {
  fn get(&self, server: &str) -> Option<String> {
    Self::entry(server).ok()?.get_password().ok()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn server_urls() {
    assert_eq!(normalize_server_url("https://team.example.com/").unwrap(), "https://team.example.com");
    assert_eq!(normalize_server_url(" https://example.com:8443/kingu/ ").unwrap(), "https://example.com:8443/kingu");
    assert_eq!(normalize_server_url("http://localhost:8787").unwrap(), "http://localhost:8787");
    assert_eq!(normalize_server_url("http://127.0.0.1:8787").unwrap(), "http://127.0.0.1:8787");
    assert_eq!(normalize_server_url("http://[::1]:8787").unwrap(), "http://[::1]:8787");
    for bad in [
      "http://team.example.com",
      "http://localhost.evil.com",
      "ftp://example.com",
      "https://user:pw@example.com",
      "https://example.com/?x=1",
      "not a url",
    ] {
      assert!(normalize_server_url(bad).is_err(), "{bad}");
    }
  }

  #[test]
  fn tokens() {
    assert!(valid_token(&format!("kgu_{}", "a".repeat(43))));
    assert!(!valid_token(&format!("kgu_{}", "a".repeat(42))));
    assert!(!valid_token(&format!("kgu_{}!", "a".repeat(42))));
    assert!(!valid_token(&format!("ghp_{}", "a".repeat(43))));
  }

  #[test]
  fn status_classes() {
    assert_eq!(classify(200, ""), Ok(()));
    assert_eq!(classify(201, ""), Ok(()));
    assert!(matches!(classify(401, r#"{"error":{"code":"invalid_token"}}"#), Err(SendError::Unauthorized(m)) if m == "HTTP 401 invalid_token"));
    assert!(matches!(classify(429, ""), Err(SendError::Retryable(_))));
    assert!(matches!(classify(503, ""), Err(SendError::Retryable(_))));
    assert!(matches!(classify(422, ""), Err(SendError::Permanent(_))));
    assert!(matches!(classify(409, r#"{"error":{"code":"task_not_synced"}}"#), Err(SendError::Retryable(m)) if m == "HTTP 409 task_not_synced"));
    assert!(matches!(classify(409, r#"{"error":{"code":"conflict"}}"#), Err(SendError::Permanent(_))));
    assert!(matches!(classify(404, ""), Err(SendError::Permanent(_))));
  }
}
