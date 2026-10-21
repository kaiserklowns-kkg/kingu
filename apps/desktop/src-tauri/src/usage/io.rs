//! What the usage providers below touch outside Rust, behind two seams so the tests never reach
//! the network, the Keychain or this machine's credential files:
//! - [`Http`]: one request to a provider's own endpoint. The live client follows no redirects (a
//!   redirect could carry a token or cookie to another host) and its errors never quote the URL.
//! - [`Host`]: environment variables, the home folder, files other CLIs leave behind, a Keychain
//!   item another program owns, one value from an SQLite `ItemTable`, and a program run with a
//!   time limit. Read-only: Kingu never writes or refreshes another program's sign-in.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Answers larger than this are not usage payloads.
pub const MAX_BODY: usize = 1_000_000;
const TIMEOUT: Duration = Duration::from_secs(15);
const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(3);

pub struct Request<'a> {
  pub method: &'static str,
  pub url: &'a str,
  pub headers: Vec<(&'static str, String)>,
  pub body: Option<String>,
}

impl<'a> Request<'a> {
  pub fn get(url: &'a str) -> Self {
    Self { method: "GET", url, headers: Vec::new(), body: None }
  }

  pub fn header(mut self, name: &'static str, value: impl Into<String>) -> Self {
    self.headers.push((name, value.into()));
    self
  }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Response {
  pub status: u16,
  pub body: String,
  pub retry_after: Option<String>,
  pub content_type: Option<String>,
}

pub trait Http: Send + Sync {
  /// `Err` is a failure kind (`network`, `unknown`): the request got no answer.
  fn send(&self, req: &Request) -> Result<Response, &'static str>;
}

pub struct LiveHttp;

impl Http for LiveHttp {
  fn send(&self, req: &Request) -> Result<Response, &'static str> {
    let client = crate::net_proxy::client_builder()
      .map_err(|_| "unknown")?
      .timeout(TIMEOUT)
      .connect_timeout(Duration::from_secs(5))
      .redirect(reqwest::redirect::Policy::none())
      .build()
      .map_err(|_| "unknown")?;
    let mut b = match req.method {
      "POST" => client.post(req.url),
      _ => client.get(req.url),
    };
    for (k, v) in &req.headers {
      b = b.header(*k, v);
    }
    if let Some(body) = &req.body {
      b = b.body(body.clone());
    }
    let res = b.send().map_err(|e| if e.is_timeout() || e.is_connect() || e.is_request() { "network" } else { "unknown" })?;
    let header = |name: &str| res.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let (retry_after, content_type) = (header("retry-after"), header("content-type"));
    let status = res.status().as_u16();
    let mut body = String::new();
    res.take(MAX_BODY as u64 + 1).read_to_string(&mut body).map_err(|_| "network")?;
    Ok(Response { status, body, retry_after, content_type })
  }
}

/// What a program printed before it exited or was stopped.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Output {
  pub code: Option<i32>,
  pub stdout: String,
  pub stderr: String,
  pub timed_out: bool,
}

/// A read that found nothing (`Ok(None)`) is not a failure (`Err`).
pub type Found = Result<Option<String>, ()>;

pub trait Host: Send + Sync {
  fn env(&self, key: &str) -> Option<String>;
  fn home(&self) -> Option<PathBuf>;
  fn read(&self, path: &Path) -> Found;
  /// A generic-password item another program keeps in the macOS Keychain.
  fn keychain(&self, service: &str, account: &str) -> Found;
  /// `SELECT value FROM ItemTable WHERE key = ?` of a VS Code-style `state.vscdb`, read-only.
  fn item_table(&self, db: &Path, key: &str) -> Found;
  /// An installed program, by name, on the login PATH.
  fn which(&self, program: &str) -> Option<PathBuf>;
  fn run(&self, program: &Path, args: &[&str], timeout: Duration) -> Result<Output, String>;

  /// A non-empty, trimmed environment variable.
  fn var(&self, key: &str) -> Option<String> {
    self.env(key).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
  }
}

pub struct LiveHost;

impl Host for LiveHost {
  fn env(&self, key: &str) -> Option<String> {
    std::env::var(key).ok()
  }

  fn home(&self) -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
  }

  fn read(&self, path: &Path) -> Found {
    match std::fs::metadata(path) {
      Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => return Ok(None),
      Err(_) => return Err(()),
      Ok(m) if !m.is_file() || m.len() > MAX_BODY as u64 * 4 => return Err(()),
      Ok(_) => {}
    }
    std::fs::read_to_string(path).map(Some).map_err(|_| ())
  }

  fn keychain(&self, service: &str, account: &str) -> Found {
    if !cfg!(target_os = "macos") {
      return Ok(None);
    }
    let out = run_limited(Path::new("/usr/bin/security"), &["find-generic-password", "-s", service, "-a", account, "-w"], KEYCHAIN_TIMEOUT).map_err(|_| ())?;
    match out.code {
      Some(0) => Ok(Some(out.stdout.trim().to_owned()).filter(|s| !s.is_empty())),
      // 44: the item does not exist.
      Some(44) => Ok(None),
      _ => Err(()),
    }
  }

  fn item_table(&self, db: &Path, key: &str) -> Found {
    if !db.is_file() {
      return Ok(None);
    }
    // The key is ours (a constant), never user text; quoted for SQL anyway.
    let sql = format!("SELECT value FROM ItemTable WHERE key = '{}' LIMIT 1;", key.replace('\'', "''"));
    let out = run_limited(Path::new("/usr/bin/sqlite3"), &["-readonly", &db.to_string_lossy(), &sql], Duration::from_secs(5)).map_err(|_| ())?;
    if out.code != Some(0) {
      return Err(());
    }
    Ok(Some(out.stdout.trim().to_owned()).filter(|s| !s.is_empty()))
  }

  fn which(&self, program: &str) -> Option<PathBuf> {
    let path = crate::shell_env::path().or_else(|| std::env::var_os("PATH"))?;
    let home = self.home();
    let extra = home.iter().map(|h| h.join(".local/bin"));
    std::env::split_paths(&path).chain(extra).map(|d| d.join(program)).find(|p| p.is_file())
  }

  fn run(&self, program: &Path, args: &[&str], timeout: Duration) -> Result<Output, String> {
    run_limited(program, args, timeout)
  }
}

/// Runs `program` with the login PATH, stdin closed, output capped, killed after `timeout`.
fn run_limited(program: &Path, args: &[&str], timeout: Duration) -> Result<Output, String> {
  let mut cmd = if program.is_absolute() && program.starts_with("/usr/bin") { Command::new(program) } else { crate::shell_env::command(program) };
  let mut child = cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
  let pipe = |r: Option<Box<dyn Read + Send>>| {
    std::thread::spawn(move || {
      let mut buf = Vec::new();
      if let Some(r) = r {
        let _ = r.take(MAX_BODY as u64).read_to_end(&mut buf);
      }
      String::from_utf8_lossy(&buf).into_owned()
    })
  };
  let out = pipe(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
  let err = pipe(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
  let start = Instant::now();
  let (code, timed_out) = loop {
    match child.try_wait().map_err(|e| e.to_string())? {
      Some(status) => break (status.code(), false),
      None if start.elapsed() >= timeout => {
        let _ = child.kill();
        let _ = child.wait();
        break (None, true);
      }
      None => std::thread::sleep(Duration::from_millis(25)),
    }
  };
  Ok(Output { code, stdout: out.join().unwrap_or_default(), stderr: err.join().unwrap_or_default(), timed_out })
}

#[cfg(test)]
pub mod fake {
  //! In-memory [`Http`] and [`Host`]: scripted answers, recorded requests.
  use std::collections::HashMap;
  use std::sync::Mutex;

  use super::*;

  /// A recorded request: method, URL, headers, body.
  pub type Seen = (String, String, Vec<(String, String)>, Option<String>);

  #[derive(Default)]
  pub struct FakeHttp {
    pub replies: Mutex<Vec<Result<Response, &'static str>>>,
    pub seen: Mutex<Vec<Seen>>,
  }

  impl FakeHttp {
    pub fn new(replies: Vec<Result<Response, &'static str>>) -> Self {
      Self { replies: Mutex::new(replies.into_iter().rev().collect()), seen: Mutex::default() }
    }
    pub fn ok(body: &str) -> Result<Response, &'static str> {
      Ok(Response { status: 200, body: body.into(), ..Default::default() })
    }
    pub fn status(status: u16) -> Result<Response, &'static str> {
      Ok(Response { status, ..Default::default() })
    }
    pub fn urls(&self) -> Vec<String> {
      self.seen.lock().unwrap().iter().map(|s| s.1.clone()).collect()
    }
    pub fn header(&self, i: usize, name: &str) -> Option<String> {
      self.seen.lock().unwrap().get(i)?.2.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone())
    }
  }

  impl Http for FakeHttp {
    fn send(&self, req: &Request) -> Result<Response, &'static str> {
      let headers = req.headers.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect();
      self.seen.lock().unwrap().push((req.method.into(), req.url.into(), headers, req.body.clone()));
      self.replies.lock().unwrap().pop().unwrap_or(Err("network"))
    }
  }

  #[derive(Default)]
  pub struct FakeHost {
    pub env: HashMap<String, String>,
    pub files: HashMap<PathBuf, String>,
    pub unreadable: Vec<PathBuf>,
    pub keychain: HashMap<(String, String), String>,
    pub items: HashMap<(PathBuf, String), String>,
    pub programs: HashMap<String, PathBuf>,
    pub runs: Mutex<Vec<(PathBuf, Vec<String>)>>,
    pub outputs: Mutex<Vec<Result<Output, String>>>,
  }

  pub const HOME: &str = "/home/test";

  impl FakeHost {
    pub fn new() -> Self {
      Self::default()
    }
    pub fn file(mut self, path: &str, text: &str) -> Self {
      self.files.insert(PathBuf::from(path), text.into());
      self
    }
    pub fn var(mut self, k: &str, v: &str) -> Self {
      self.env.insert(k.into(), v.into());
      self
    }
  }

  impl Host for FakeHost {
    fn env(&self, key: &str) -> Option<String> {
      self.env.get(key).cloned()
    }
    fn home(&self) -> Option<PathBuf> {
      Some(PathBuf::from(HOME))
    }
    fn read(&self, path: &Path) -> Found {
      if self.unreadable.iter().any(|p| p == path) {
        return Err(());
      }
      Ok(self.files.get(path).cloned())
    }
    fn keychain(&self, service: &str, account: &str) -> Found {
      Ok(self.keychain.get(&(service.to_owned(), account.to_owned())).cloned())
    }
    fn item_table(&self, db: &Path, key: &str) -> Found {
      Ok(self.items.get(&(db.to_path_buf(), key.to_owned())).cloned())
    }
    fn which(&self, program: &str) -> Option<PathBuf> {
      self.programs.get(program).cloned()
    }
    fn run(&self, program: &Path, args: &[&str], _timeout: Duration) -> Result<Output, String> {
      self.runs.lock().unwrap().push((program.to_path_buf(), args.iter().map(|a| (*a).to_owned()).collect()));
      let mut outputs = self.outputs.lock().unwrap();
      if outputs.is_empty() { Err("no output scripted".into()) } else { outputs.remove(0) }
    }
  }
}
