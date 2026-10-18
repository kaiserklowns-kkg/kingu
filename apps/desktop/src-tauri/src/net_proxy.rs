//! VS Code's proxy settings for what Kingu itself sends over the network and the programs it
//! starts: `http.proxy`, `http.noProxy`, `http.proxyStrictSSL` and `http.proxyAuthorization`.
//! They are user-only settings, so Rust reads them from the user settings.json itself (never from
//! the webview), again whenever that file changes. With `http.proxy` empty, everything behaves as
//! before: reqwest and the child programs use the `http_proxy`/`https_proxy` variables Kingu was
//! started with, like VS Code.
//!
//! - Kingu's own HTTP clients (team server, Linear, AI account usage) are built with
//!   [`client_builder`]: the proxy, its bypass list, `Proxy-Authorization`, and certificate checks
//!   turned off only when `http.proxyStrictSSL` is false and a proxy is set.
//! - Programs (git, gh, language servers, the agent host, ADE agent CLIs) get [`env`]:
//!   `HTTP(S)_PROXY`/`ALL_PROXY` in both cases and `NO_PROXY`. `http.proxyAuthorization` cannot be
//!   passed to them; credentials go in the proxy URL instead.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Proxy {
  /// Validated proxy URL, or empty for none.
  pub url: String,
  pub no_proxy: Vec<String>,
  pub strict_ssl: bool,
  pub authorization: Option<String>,
}

/// VS Code's `http.proxy` pattern: `scheme://[user[:password]@]host[:port][/]` with an http(s) or
/// socks scheme; empty means no proxy.
pub fn validate_url(raw: &str) -> Result<String, String> {
  let raw = raw.trim();
  if raw.is_empty() {
    return Ok(String::new());
  }
  let url = url::Url::parse(raw).map_err(|e| format!("http.proxy ไม่ถูกต้อง: {e}"))?;
  if !matches!(url.scheme(), "http" | "https" | "socks" | "socks4" | "socks4a" | "socks5" | "socks5h") {
    return Err(format!("http.proxy: ไม่รองรับ scheme {} (ใช้ http, https หรือ socks5)", url.scheme()));
  }
  if url.host_str().is_none_or(str::is_empty) {
    return Err("http.proxy ต้องมีชื่อโฮสต์".into());
  }
  if !matches!(url.path(), "" | "/") || url.query().is_some() || url.fragment().is_some() {
    return Err("http.proxy ต้องเป็น scheme://host:port ไม่มี path".into());
  }
  // reqwest and curl know `socks5`, not VS Code's bare `socks`.
  let text = raw.trim_end_matches('/');
  Ok(match text.strip_prefix("socks://") {
    Some(rest) => format!("socks5://{rest}"),
    None => text.to_owned(),
  })
}

/// The proxy settings out of a parsed user settings.json; an invalid proxy URL means none (logged).
pub fn from_settings(v: &serde_json::Value) -> Proxy {
  let url = match validate_url(v["http.proxy"].as_str().unwrap_or_default()) {
    Ok(u) => u,
    Err(e) => {
      log::warn!("{e}");
      String::new()
    }
  };
  let no_proxy = v["http.noProxy"]
    .as_array()
    .map(|a| a.iter().filter_map(|s| s.as_str()).map(str::trim).filter(|s| !s.is_empty() && !s.contains(',')).map(str::to_owned).collect())
    .unwrap_or_default();
  let authorization = v["http.proxyAuthorization"].as_str().map(str::trim).filter(|s| !s.is_empty() && !s.contains(['\r', '\n'])).map(str::to_owned);
  Proxy { url, no_proxy, strict_ssl: v["http.proxyStrictSSL"].as_bool().unwrap_or(true), authorization }
}

/// The URL with any password replaced, for logs and messages.
pub fn redacted(url: &str) -> String {
  match url::Url::parse(url) {
    Ok(mut u) if u.password().is_some() => {
      let _ = u.set_password(Some("***"));
      u.to_string().trim_end_matches('/').to_owned()
    }
    _ => url.to_owned(),
  }
}

/// Environment for a child program: nothing without a proxy, so the inherited variables stay.
pub fn env_of(p: &Proxy) -> Vec<(String, String)> {
  if p.url.is_empty() {
    return Vec::new();
  }
  let mut out: Vec<(String, String)> =
    ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].iter().map(|k| ((*k).to_owned(), p.url.clone())).collect();
  if !p.no_proxy.is_empty() {
    let list = p.no_proxy.join(",");
    out.push(("NO_PROXY".into(), list.clone()));
    out.push(("no_proxy".into(), list));
  }
  out
}

/// Applies `p` to a reqwest client builder.
pub fn apply(builder: reqwest::blocking::ClientBuilder, p: &Proxy) -> Result<reqwest::blocking::ClientBuilder, String> {
  if p.url.is_empty() {
    return Ok(builder);
  }
  let mut proxy = reqwest::Proxy::all(&p.url).map_err(|e| format!("http.proxy {}: {e}", redacted(&p.url)))?;
  // Loopback never goes through the proxy (a local team server, test servers).
  let bypass: Vec<&str> = ["localhost", "127.0.0.1", "::1"].into_iter().chain(p.no_proxy.iter().map(String::as_str)).collect();
  proxy = proxy.no_proxy(reqwest::NoProxy::from_string(&bypass.join(",")));
  if let Some(auth) = &p.authorization {
    let value = reqwest::header::HeaderValue::from_str(auth).map_err(|_| "http.proxyAuthorization มีอักขระที่ใช้ใน header ไม่ได้".to_owned())?;
    proxy = proxy.custom_http_auth(value);
  }
  Ok(builder.proxy(proxy).danger_accept_invalid_certs(!p.strict_ssl))
}

// ---------------------------------------------------------------------------------------------
// The current settings, re-read when the user settings file changes

struct Cache {
  path: PathBuf,
  stamp: Option<SystemTime>,
  proxy: Proxy,
}

static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();

/// Called once at startup with the app config dir.
pub fn init(config_dir: &Path) {
  let _ = CACHE.set(Mutex::new(Cache { path: crate::settings::user_path(config_dir), stamp: None, proxy: Proxy { strict_ssl: true, ..Proxy::default() } }));
  // Logs the proxy when one is set.
  let _ = current();
}

fn stamp(path: &Path) -> Option<SystemTime> {
  std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Re-parses the file when its modification time changed (or it is missing).
fn refresh(c: &mut Cache) {
  let now = stamp(&c.path);
  if now == c.stamp && now.is_some() {
    return;
  }
  let parsed = crate::settings::read(&c.path)
    .ok()
    .flatten()
    .and_then(|t| serde_json::from_str::<serde_json::Value>(&crate::settings::strip_jsonc(&t)).ok())
    .unwrap_or(serde_json::Value::Null);
  let next = from_settings(&parsed);
  if next.url != c.proxy.url {
    log::info!("http.proxy {}", if next.url.is_empty() { "off".into() } else { redacted(&next.url) });
  }
  c.proxy = next;
  c.stamp = now;
}

/// The proxy settings as the user settings file says now (a stat per call; parsed on change).
pub fn current() -> Proxy {
  let Some(cache) = CACHE.get() else { return Proxy { strict_ssl: true, ..Proxy::default() } };
  let mut c = cache.lock().unwrap_or_else(|e| e.into_inner());
  refresh(&mut c);
  c.proxy.clone()
}

pub fn env() -> Vec<(String, String)> {
  env_of(&current())
}

/// A reqwest client builder with the current proxy settings applied.
pub fn client_builder() -> Result<reqwest::blocking::ClientBuilder, String> {
  apply(reqwest::blocking::Client::builder(), &current())
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn validates_like_vscode() {
    assert_eq!(validate_url("").unwrap(), "");
    assert_eq!(validate_url(" http://proxy.example.com:8080/ ").unwrap(), "http://proxy.example.com:8080");
    assert_eq!(validate_url("http://u:p%40ss@10.0.0.1:3128").unwrap(), "http://u:p%40ss@10.0.0.1:3128");
    assert_eq!(validate_url("socks://127.0.0.1:1080").unwrap(), "socks5://127.0.0.1:1080");
    assert!(validate_url("socks5h://[::1]:1080").is_ok());
    assert!(validate_url("ftp://proxy:21").is_err());
    assert!(validate_url("proxy.example.com:8080").is_err());
    assert!(validate_url("http://proxy:8080/path").is_err());
    assert!(validate_url("http://proxy:8080?x=1").is_err());
  }

  #[test]
  fn reads_settings_and_ignores_bad_values() {
    let p = from_settings(&json!({
      "http.proxy": "http://proxy:3128", "http.noProxy": ["localhost", " .corp.example ", "", "a,b", 7],
      "http.proxyStrictSSL": false, "http.proxyAuthorization": "Basic dTpw"
    }));
    assert_eq!(p, Proxy { url: "http://proxy:3128".into(), no_proxy: vec!["localhost".into(), ".corp.example".into()], strict_ssl: false, authorization: Some("Basic dTpw".into()) });
    let bad = from_settings(&json!({ "http.proxy": "not a url", "http.proxyAuthorization": "x\r\nInjected: 1" }));
    assert_eq!((bad.url.as_str(), bad.strict_ssl, bad.authorization), ("", true, None));
    assert_eq!(from_settings(&serde_json::Value::Null), Proxy { strict_ssl: true, ..Proxy::default() });
  }

  #[test]
  fn child_env_only_with_a_proxy() {
    assert!(env_of(&Proxy::default()).is_empty());
    let env = env_of(&Proxy { url: "http://proxy:3128".into(), no_proxy: vec!["localhost".into(), ".corp".into()], ..Proxy::default() });
    let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    assert_eq!((get("HTTPS_PROXY"), get("http_proxy"), get("ALL_PROXY")), (Some("http://proxy:3128"), Some("http://proxy:3128"), Some("http://proxy:3128")));
    assert_eq!((get("NO_PROXY"), get("no_proxy")), (Some("localhost,.corp"), Some("localhost,.corp")));
  }

  #[test]
  fn redacts_passwords() {
    assert_eq!(redacted("http://user:secret@proxy:3128"), "http://user:***@proxy:3128");
    assert_eq!(redacted("http://proxy:3128"), "http://proxy:3128");
  }

  #[test]
  fn re_reads_the_settings_file_when_it_changes() {
    let tmp = tempfile::tempdir().unwrap();
    let path = crate::settings::user_path(tmp.path());
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    // A private cache, so tests running in parallel never share the global one.
    let cache = Mutex::new(Cache { path: path.clone(), stamp: None, proxy: Proxy::default() });
    let read = |c: &Mutex<Cache>| {
      let mut c = c.lock().unwrap();
      refresh(&mut c);
      c.proxy.url.clone()
    };
    assert_eq!(read(&cache), "");
    std::fs::write(&path, "{ // proxy\n \"http.proxy\": \"http://p:1\" }").unwrap();
    assert_eq!(read(&cache), "http://p:1");
  }

  #[test]
  fn proxied_clients_reach_the_proxy() {
    use std::io::{BufRead, BufReader, Write};
    // A fake proxy: answers any request; the request line shows it was sent through the proxy
    // (absolute-form URL) with the configured Proxy-Authorization.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let proxy_url = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
      let (stream, _) = listener.accept().unwrap();
      let mut reader = BufReader::new(stream.try_clone().unwrap());
      let (mut first, mut auth, mut line) = (String::new(), String::new(), String::new());
      reader.read_line(&mut first).unwrap();
      loop {
        line.clear();
        reader.read_line(&mut line).unwrap();
        let Some((k, v)) = line.trim_end().split_once(':') else { break };
        if k.eq_ignore_ascii_case("proxy-authorization") {
          auth = v.trim().to_owned();
        }
      }
      let mut stream = stream;
      write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").unwrap();
      (first.trim_end().to_owned(), auth)
    });
    let p = Proxy { url: proxy_url, authorization: Some("Basic dTpw".into()), strict_ssl: true, ..Proxy::default() };
    let client = apply(reqwest::blocking::Client::builder(), &p).unwrap().build().unwrap();
    let body = client.get("http://kingu.invalid/health").send().unwrap().text().unwrap();
    assert_eq!(body, "ok");
    let (first, auth) = server.join().unwrap();
    assert_eq!((first.as_str(), auth.as_str()), ("GET http://kingu.invalid/health HTTP/1.1", "Basic dTpw"));
  }
}
