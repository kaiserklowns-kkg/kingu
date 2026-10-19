//! The HTTPS side shared by the REST task sources (GitLab issues in `gitlab.rs`, Jira in
//! `jira.rs`): one client per call built with `net_proxy::client_builder` (the user's proxy
//! settings), no redirects (one could carry the credential to another host), a bounded timeout,
//! and HTTP failures turned into messages the user can act on. The credential is a header the
//! caller passes in; it never reaches logs or error messages. Tests swap [`Transport`] for a fake.

use std::time::Duration;

use serde_json::Value;

use crate::i18n::msg::TrackerMsg;
use crate::tr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
  Get,
  Post,
}

/// One request: `path` (with its query) is appended to the client's base URL.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
  pub method: Method,
  pub path: String,
  pub body: Option<Value>,
}

impl Request {
  pub fn get(path: impl Into<String>) -> Self {
    Self { method: Method::Get, path: path.into(), body: None }
  }

  pub fn post(path: impl Into<String>, body: Value) -> Self {
    Self { method: Method::Post, path: path.into(), body: Some(body) }
  }
}

/// Sends one request with the credential; the HTTP status and body.
pub trait Transport: Send + Sync {
  fn send(&self, req: &Request) -> Result<(u16, String), String>;
}

pub struct Http {
  client: reqwest::blocking::Client,
  base: String,
  auth: (&'static str, String),
  /// `GitLab`, `Jira`: names the service in errors.
  service: &'static str,
}

impl Http {
  /// `base`: `https://gitlab.com/api/v4`, `https://acme.atlassian.net` (no trailing `/`).
  pub fn new(service: &'static str, base: &str, auth_header: &'static str, auth_value: String) -> Result<Self, String> {
    let client = crate::net_proxy::client_builder()?
      .timeout(Duration::from_secs(25))
      .connect_timeout(Duration::from_secs(5))
      .redirect(reqwest::redirect::Policy::none())
      // Atlassian's XSRF check refuses POSTs carrying a browser user agent.
      .user_agent(concat!("kingu-desktop/", env!("CARGO_PKG_VERSION")))
      .build()
      .map_err(|e| e.to_string())?;
    Ok(Self { client, base: base.trim_end_matches('/').to_owned(), auth: (auth_header, auth_value), service })
  }
}

impl Transport for Http {
  fn send(&self, req: &Request) -> Result<(u16, String), String> {
    let url = format!("{}{}", self.base, req.path);
    let builder = match req.method {
      Method::Get => self.client.get(&url),
      Method::Post => self.client.post(&url),
    };
    let mut builder = builder.header(self.auth.0, &self.auth.1).header("Accept", "application/json");
    if let Some(body) = &req.body {
      builder = builder.json(body);
    }
    let service = self.service;
    let res = builder.send().map_err(|e| {
      let e = e.without_url();
      if e.is_timeout() { tr!(TrackerMsg::Timeout, service) } else { tr!(TrackerMsg::Connect, service, detail = e) }
    })?;
    let status = res.status().as_u16();
    Ok((status, res.text().unwrap_or_default()))
  }
}

/// The message for a status every service answers alike (rate limit, server trouble), if it is one.
pub fn common_error(service: &str, status: u16) -> Option<String> {
  match status {
    429 => Some(tr!(TrackerMsg::RateLimited, service)),
    500.. => Some(tr!(TrackerMsg::ServerError, service, status)),
    _ => None,
  }
}

/// The body as JSON, or "could not read the response".
pub fn json(service: &str, status: u16, body: &str) -> Result<Value, String> {
  serde_json::from_str(body).map_err(|_| tr!(TrackerMsg::BadResponse, service, status))
}

/// A personal token or API key: printable ASCII, bounded.
pub fn valid_token(token: &str, max: usize) -> bool {
  !token.is_empty() && token.len() <= max && token.bytes().all(|b| b.is_ascii_graphic())
}

pub fn text(v: &Value, k: &str) -> String {
  v[k].as_str().unwrap_or_default().to_owned()
}

#[cfg(test)]
pub mod fake {
  use super::*;
  use std::sync::Mutex;

  /// Answers each request with the next canned response and records them.
  pub struct Fake {
    replies: Mutex<Vec<(u16, String)>>,
    pub seen: Mutex<Vec<Request>>,
  }

  impl Fake {
    pub fn new(replies: &[(u16, Value)]) -> Self {
      Self { replies: Mutex::new(replies.iter().rev().map(|(s, v)| (*s, v.to_string())).collect()), seen: Mutex::default() }
    }

    pub fn requests(&self) -> Vec<Request> {
      self.seen.lock().unwrap().clone()
    }
  }

  impl Transport for Fake {
    fn send(&self, req: &Request) -> Result<(u16, String), String> {
      self.seen.lock().unwrap().push(req.clone());
      Ok(self.replies.lock().unwrap().pop().expect("unexpected request"))
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::{BufRead, BufReader, Read, Write};
  use std::net::TcpListener;

  #[test]
  fn sends_the_auth_header_and_json_body_without_following_redirects() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/api/v4", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
      let (stream, _) = listener.accept().unwrap();
      let mut reader = BufReader::new(stream.try_clone().unwrap());
      let (mut len, mut auth, mut line) = (0usize, String::new(), String::new());
      reader.read_line(&mut line).unwrap();
      let request_line = line.trim_end().to_owned();
      loop {
        line.clear();
        reader.read_line(&mut line).unwrap();
        let Some((k, v)) = line.trim_end().split_once(':') else { break };
        match k.to_ascii_lowercase().as_str() {
          "content-length" => len = v.trim().parse().unwrap(),
          "private-token" => auth = v.trim().to_owned(),
          _ => {}
        }
      }
      let mut body = vec![0; len];
      reader.read_exact(&mut body).unwrap();
      let mut stream = stream;
      write!(stream, "HTTP/1.1 302 Found\r\nLocation: http://evil.example/\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}").unwrap();
      (request_line, auth, String::from_utf8(body).unwrap())
    });
    let http = Http::new("GitLab", &format!("{base}/"), "PRIVATE-TOKEN", "glpat-secret".into()).unwrap();
    let (status, body) = http.send(&Request::post("/projects/1/issues/2/notes", serde_json::json!({ "body": "hi" }))).unwrap();
    assert_eq!((status, body.as_str()), (302, "{}"));
    let (request_line, auth, sent) = server.join().unwrap();
    assert_eq!((request_line.as_str(), auth.as_str()), ("POST /api/v4/projects/1/issues/2/notes HTTP/1.1", "glpat-secret"));
    assert_eq!(sent, r#"{"body":"hi"}"#);
  }

  #[test]
  fn maps_common_statuses() {
    assert!(common_error("Jira", 429).unwrap().contains("Jira"));
    assert!(common_error("Jira", 503).unwrap().contains("503"));
    assert!(common_error("Jira", 404).is_none());
    assert!(json("GitLab", 200, "<html>").is_err());
    assert!(valid_token("glpat-abc", 64) && !valid_token("a b", 64) && !valid_token("", 64) && !valid_token("abc", 2));
  }
}
