//! The network side of a managed install: release lookups (small JSON / text bodies) and the
//! download itself, hashed while it is written (Orca `main/node-runtime/runtime-archive-download.ts`
//! `downloadVerifiedArchive`, `runtime-download-size.ts`). HTTPS only, redirects included; the file
//! lands unexecutable (0600) in the staging folder and is removed again unless its digest matches.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use sha2::Digest as _;

/// Orca's `DEADLINE_MS`: an install never runs longer.
pub const DEADLINE: Duration = Duration::from_secs(45 * 60);
/// No bytes for this long ends the attempt (Orca's stall timer).
const STALL: Duration = Duration::from_secs(120);
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(30);
/// Orca's `RUNTIME_ARCHIVE_RETRY_DELAYS_MS`.
const RETRY_DELAYS: [Duration; 3] = [Duration::from_secs(1), Duration::from_secs(3), Duration::from_secs(9)];

/// Hex digest a download must have; npm publishes only a sha512.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Digest {
  Sha256(String),
  Sha512(String),
}

impl Digest {
  /// Names the release (Orca `runtimeReleaseId`): a republished build is never mistaken for it.
  pub fn hex(&self) -> &str {
    match self {
      Digest::Sha256(h) | Digest::Sha512(h) => h,
    }
  }
}

pub fn is_hex(s: &str, len: usize) -> bool {
  s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `url` when it is an absolute `https://` URL with a host and no credentials.
pub fn require_https(url: &str) -> Result<url::Url, String> {
  let parsed = url::Url::parse(url).map_err(|_| format!("not a URL: {url}"))?;
  if parsed.scheme() != "https" || parsed.host_str().is_none_or(str::is_empty) || !parsed.username().is_empty() || parsed.password().is_some() {
    return Err(format!("not an https URL: {url}"));
  }
  Ok(parsed)
}

pub struct Response {
  pub status: u16,
  /// The body's size when the server names it for an unencoded body.
  pub length: Option<u64>,
  pub body: Box<dyn Body>,
}

/// What one wait on a body brought.
#[derive(Debug, PartialEq, Eq)]
pub enum Chunk {
  Bytes(Vec<u8>),
  /// Nothing arrived within the wait; the body is still open.
  Waiting,
  End,
}

/// A response body read in bounded waits, so a stalled connection or a Cancel never blocks the
/// reader. Dropping it closes the connection.
pub trait Body: Send {
  fn next(&mut self, wait: Duration) -> Result<Chunk, String>;
}

/// A body over a blocking reader (lookups, whose client bounds each read itself; test fixtures).
pub struct ReadBody<R>(pub R);

impl<R: Read + Send> Body for ReadBody<R> {
  fn next(&mut self, _wait: Duration) -> Result<Chunk, String> {
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
      return match self.0.read(&mut chunk) {
        Ok(0) => Ok(Chunk::End),
        Ok(n) => {
          chunk.truncate(n);
          Ok(Chunk::Bytes(chunk))
        }
        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
        Err(e) => Err(e.to_string()),
      };
    }
  }
}

/// What a lookup or download asks of the network. Tests give their own.
pub trait Http: Send + Sync {
  /// GET a small, time-limited lookup body.
  fn get(&self, url: &str, accept: Option<&str>) -> Result<Response, String>;
  /// GET a download: answers once the headers are in, or with an error once `cancel` is set.
  fn download(&self, url: &str, cancel: &AtomicBool) -> Result<Response, String>;
  /// The size a download will be, without downloading it.
  fn size(&self, url: &str) -> Result<u64, String>;
}

/// GETs a small text body: `Ok(None)` for a 404 / 410, an error for another failure or more than `max` bytes.
pub fn text(http: &dyn Http, url: &str, accept: Option<&str>, max: usize) -> Result<Option<String>, String> {
  require_https(url)?;
  let mut res = http.get(url, accept)?;
  if res.status == 404 || res.status == 410 {
    return Ok(None);
  }
  if !(200..300).contains(&res.status) {
    return Err(format!("{url} answered {}", res.status));
  }
  let mut buf = Vec::new();
  let started = Instant::now();
  loop {
    match res.body.next(Duration::from_millis(200)).map_err(|e| format!("{url}: {e}"))? {
      Chunk::Bytes(b) => buf.extend_from_slice(&b),
      Chunk::End => break,
      Chunk::Waiting if started.elapsed() < LOOKUP_TIMEOUT => {}
      Chunk::Waiting => return Err(format!("{url}: timed out")),
    }
    if buf.len() > max {
      return Err(format!("{url} answered more than {max} bytes"));
    }
  }
  String::from_utf8(buf).map(Some).map_err(|_| format!("{url} did not answer text"))
}

pub struct Reqwest;

/// Redirects are followed only to https, at most ten.
fn redirect_policy() -> reqwest::redirect::Policy {
  reqwest::redirect::Policy::custom(|attempt| {
    if attempt.url().scheme() != "https" {
      attempt.error("redirected off https")
    } else if attempt.previous().len() > 10 {
      attempt.error("too many redirects")
    } else {
      attempt.follow()
    }
  })
}

/// GitHub's API refuses a request without one.
const USER_AGENT: &str = concat!("kingu-desktop/", env!("CARGO_PKG_VERSION"));

fn lookup_client() -> Result<reqwest::blocking::Client, String> {
  crate::net_proxy::client_builder()?
    .https_only(true)
    .redirect(redirect_policy())
    .connect_timeout(Duration::from_secs(30))
    .timeout(LOOKUP_TIMEOUT)
    .user_agent(USER_AGENT)
    .build()
    .map_err(|e| e.to_string())
}

/// The download client: async, so the read can be dropped mid-wait (blocking reqwest waits out its
/// whole timeout on a silent connection). The user's proxy settings as `net_proxy::apply` applies
/// them to the blocking clients.
fn download_client() -> Result<reqwest::Client, String> {
  let p = crate::net_proxy::current();
  let mut builder = reqwest::Client::builder()
    .https_only(true)
    .redirect(redirect_policy())
    .connect_timeout(Duration::from_secs(30))
    // A connection that sends nothing for this long ends even when nobody is reading it.
    .read_timeout(STALL)
    .user_agent(USER_AGENT);
  if !p.url.is_empty() {
    let mut proxy = reqwest::Proxy::all(&p.url).map_err(|e| format!("http.proxy {}: {e}", crate::net_proxy::redacted(&p.url)))?;
    let bypass: Vec<&str> = ["localhost", "127.0.0.1", "::1"].into_iter().chain(p.no_proxy.iter().map(String::as_str)).collect();
    proxy = proxy.no_proxy(reqwest::NoProxy::from_string(&bypass.join(",")));
    if let Some(auth) = &p.authorization {
      proxy = proxy.custom_http_auth(reqwest::header::HeaderValue::from_str(auth).map_err(|_| "http.proxyAuthorization is not a valid header value".to_owned())?);
    }
    builder = builder.proxy(proxy).danger_accept_invalid_certs(!p.strict_ssl);
  }
  builder.build().map_err(|e| e.to_string())
}

fn identity_length(headers: &reqwest::header::HeaderMap) -> Option<u64> {
  let encoded = headers.get(reqwest::header::CONTENT_ENCODING).and_then(|v| v.to_str().ok()).is_some_and(|v| !v.trim().eq_ignore_ascii_case("identity"));
  let length = headers.get(reqwest::header::CONTENT_LENGTH)?.to_str().ok()?.parse::<u64>().ok()?;
  (!encoded && length > 0).then_some(length)
}

enum Streamed {
  Head { status: u16, length: Option<u64> },
  Bytes(Vec<u8>),
  Failed(String),
  End,
}

/// A download read by a task on the app's async runtime. Dropping it aborts the task, which drops
/// the response and so closes the connection (a stalled or cancelled download leaves no reader
/// behind).
struct StreamBody {
  rx: tauri::async_runtime::Receiver<Streamed>,
  task: tauri::async_runtime::JoinHandle<()>,
}

impl Drop for StreamBody {
  fn drop(&mut self) {
    self.task.abort();
  }
}

impl StreamBody {
  fn start(client: reqwest::Client, url: String) -> StreamBody {
    let (tx, rx) = tauri::async_runtime::channel(8);
    let task = tauri::async_runtime::spawn(async move {
      let mut res = match client.get(&url).send().await {
        Ok(res) => res,
        Err(e) => {
          let _ = tx.send(Streamed::Failed(e.to_string())).await;
          return;
        }
      };
      let head = Streamed::Head { status: res.status().as_u16(), length: identity_length(res.headers()) };
      if tx.send(head).await.is_err() {
        return;
      }
      loop {
        let next = match res.chunk().await {
          Ok(Some(bytes)) => Streamed::Bytes(bytes.to_vec()),
          Ok(None) => Streamed::End,
          Err(e) => Streamed::Failed(e.to_string()),
        };
        let last = !matches!(next, Streamed::Bytes(_));
        if tx.send(next).await.is_err() || last {
          return;
        }
      }
    });
    StreamBody { rx, task }
  }

  /// The next message, waiting at most `wait`; None when nothing came.
  fn recv(&mut self, wait: Duration) -> Result<Option<Streamed>, String> {
    let until = Instant::now() + wait;
    loop {
      if let Ok(message) = self.rx.try_recv() {
        return Ok(Some(message));
      }
      // Every message is sent before the task returns, so a finished task with none left ended early.
      if self.task.inner().is_finished() {
        return self.rx.try_recv().map(Some).map_err(|_| "the connection closed".to_owned());
      }
      let now = Instant::now();
      if now >= until {
        return Ok(None);
      }
      std::thread::sleep((until - now).min(Duration::from_millis(10)));
    }
  }
}

impl Body for StreamBody {
  fn next(&mut self, wait: Duration) -> Result<Chunk, String> {
    match self.recv(wait)? {
      None => Ok(Chunk::Waiting),
      Some(Streamed::Bytes(b)) => Ok(Chunk::Bytes(b)),
      Some(Streamed::End) => Ok(Chunk::End),
      Some(Streamed::Failed(e)) => Err(e),
      Some(Streamed::Head { .. }) => Err("unexpected response head".into()),
    }
  }
}

/// Starts `url` on `client` and waits for its headers, giving up once `cancel` is set (the request
/// is then dropped and its connection closed).
fn stream(client: reqwest::Client, url: &str, cancel: &AtomicBool) -> Result<Response, String> {
  let mut body = StreamBody::start(client, url.to_owned());
  loop {
    if cancel.load(Ordering::SeqCst) {
      return Err("cancelled".into());
    }
    match body.recv(Duration::from_millis(200))? {
      None => {}
      Some(Streamed::Head { status, length }) => return Ok(Response { status, length, body: Box::new(body) }),
      Some(Streamed::Failed(e)) => return Err(e),
      Some(_) => return Err("the response had no head".into()),
    }
  }
}

impl Http for Reqwest {
  fn get(&self, url: &str, accept: Option<&str>) -> Result<Response, String> {
    require_https(url)?;
    let mut req = lookup_client()?.get(url);
    if let Some(a) = accept {
      req = req.header(reqwest::header::ACCEPT, a);
    }
    let res = req.send().map_err(|e| e.to_string())?;
    Ok(Response { status: res.status().as_u16(), length: identity_length(res.headers()), body: Box::new(ReadBody(res)) })
  }

  fn download(&self, url: &str, cancel: &AtomicBool) -> Result<Response, String> {
    require_https(url)?;
    stream(download_client()?, url, cancel)
  }

  fn size(&self, url: &str) -> Result<u64, String> {
    require_https(url)?;
    let c = lookup_client()?;
    let head = c.head(url).send().map_err(|e| e.to_string())?;
    if !head.status().is_success() {
      return Err(format!("{url} answered {}", head.status().as_u16()));
    }
    if let Some(n) = identity_length(head.headers()) {
      return Ok(n);
    }
    // Some CDNs (npm's) answer HEAD without a length but report the total for one byte.
    let ranged = c.get(url).header(reqwest::header::RANGE, "bytes=0-0").header(reqwest::header::ACCEPT_ENCODING, "identity").send().map_err(|e| e.to_string())?;
    let total = ranged.headers().get(reqwest::header::CONTENT_RANGE).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("bytes 0-0/")).and_then(|v| v.parse::<u64>().ok());
    match total {
      Some(n) if ranged.status().as_u16() == 206 && n > 0 => Ok(n),
      _ => Err(format!("{url}: the download size is unknown")),
    }
  }
}

#[derive(Debug, PartialEq, Eq)]
pub enum DownloadError {
  /// The bytes are not the release: wrong digest, too large, or gone (404). Retrying cannot help.
  Mismatch(String),
  Network(String),
  Io(String),
  Cancelled,
}

enum Hasher {
  Sha256(sha2::Sha256),
  Sha512(sha2::Sha512),
}

impl Hasher {
  fn update(&mut self, bytes: &[u8]) {
    match self {
      Hasher::Sha256(h) => h.update(bytes),
      Hasher::Sha512(h) => h.update(bytes),
    }
  }
  fn hex(self) -> String {
    let bytes = match self {
      Hasher::Sha256(h) => h.finalize().to_vec(),
      Hasher::Sha512(h) => h.finalize().to_vec(),
    };
    bytes.iter().map(|b| format!("{b:02x}")).collect()
  }
}

fn create_private(dest: &Path) -> std::io::Result<std::fs::File> {
  let mut options = std::fs::OpenOptions::new();
  options.write(true).create_new(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  options.open(dest)
}

/// One attempt: the body streamed into `dest` (created new, 0600), at most `max_bytes`, its digest
/// compared at the end. `dest` does not exist after any error. A Cancel or `stall` without bytes
/// ends it within a fraction of a second, and the connection is closed when it returns.
fn download_once(http: &dyn Http, url: &str, digest: &Digest, max_bytes: u64, dest: &Path, cancel: &AtomicBool, stall: Duration, on_bytes: &mut dyn FnMut(u64)) -> Result<(), DownloadError> {
  let res = match http.download(url, cancel) {
    Err(_) if cancel.load(Ordering::SeqCst) => return Err(DownloadError::Cancelled),
    other => other.map_err(DownloadError::Network)?,
  };
  if res.status == 404 || res.status == 410 {
    return Err(DownloadError::Mismatch(format!("{url} answered {}", res.status)));
  }
  if !(200..300).contains(&res.status) {
    return Err(DownloadError::Network(format!("{url} answered {}", res.status)));
  }
  if res.length.is_some_and(|n| n > max_bytes) {
    return Err(DownloadError::Mismatch("the download is larger than the release".into()));
  }
  let mut body = res.body;
  let mut file = create_private(dest).map_err(|e| DownloadError::Io(e.to_string()))?;
  let mut hasher = match digest {
    Digest::Sha256(_) => Hasher::Sha256(sha2::Sha256::new()),
    Digest::Sha512(_) => Hasher::Sha512(sha2::Sha512::new()),
  };
  let mut total: u64 = 0;
  let mut last = Instant::now();
  let outcome = loop {
    if cancel.load(Ordering::SeqCst) {
      break Err(DownloadError::Cancelled);
    }
    match body.next(Duration::from_millis(200)) {
      Ok(Chunk::Bytes(chunk)) => {
        last = Instant::now();
        total += chunk.len() as u64;
        if total > max_bytes {
          break Err(DownloadError::Mismatch("the download is larger than the release".into()));
        }
        hasher.update(&chunk);
        if let Err(e) = file.write_all(&chunk) {
          break Err(DownloadError::Io(e.to_string()));
        }
        on_bytes(total);
      }
      Ok(Chunk::Waiting) if last.elapsed() < stall => {}
      Ok(Chunk::Waiting) => break Err(DownloadError::Network("the download stalled".into())),
      Ok(Chunk::End) => break Ok(()),
      Err(e) => break Err(DownloadError::Network(e)),
    }
  };
  // Closes the connection now, whatever the outcome.
  drop(body);
  let outcome = outcome.and_then(|()| file.flush().map_err(|e| DownloadError::Io(e.to_string()))).and_then(|()| {
    let actual = hasher.hex();
    if actual == digest.hex() { Ok(()) } else { Err(DownloadError::Mismatch(format!("checksum mismatch: expected {}, got {actual}", digest.hex()))) }
  });
  drop(file);
  if outcome.is_err() {
    let _ = std::fs::remove_file(dest);
  }
  outcome
}

/// Downloads `url` into `dest`, retrying network failures (never a mismatch). The file exists only
/// when its digest matched.
pub fn download_verified(http: &dyn Http, url: &str, digest: &Digest, max_bytes: u64, dest: &Path, cancel: &AtomicBool, retry: bool, on_bytes: &mut dyn FnMut(u64)) -> Result<(), DownloadError> {
  require_https(url).map_err(DownloadError::Mismatch)?;
  let mut attempt = 0;
  loop {
    match download_once(http, url, digest, max_bytes, dest, cancel, STALL, on_bytes) {
      Err(DownloadError::Network(e)) if retry && attempt < RETRY_DELAYS.len() => {
        log::warn!("managed install: download failed, retrying ({e})");
        let until = Instant::now() + RETRY_DELAYS[attempt];
        while Instant::now() < until {
          if cancel.load(Ordering::SeqCst) {
            return Err(DownloadError::Cancelled);
          }
          std::thread::sleep(Duration::from_millis(100));
        }
        attempt += 1;
      }
      other => return other,
    }
  }
}

#[cfg(test)]
pub(crate) mod tests {
  use super::*;
  use std::collections::HashMap;
  use std::sync::Mutex;

  /// A network of fixed answers: url → (status, body). Every request is recorded.
  #[derive(Default)]
  pub struct Fake {
    pub pages: Mutex<HashMap<String, (u16, Vec<u8>)>>,
    pub asked: Mutex<Vec<String>>,
  }

  impl Fake {
    pub fn with(pages: &[(&str, u16, &[u8])]) -> Self {
      let f = Fake::default();
      for (url, status, body) in pages {
        f.put(url, *status, body);
      }
      f
    }
    pub fn put(&self, url: &str, status: u16, body: &[u8]) {
      self.pages.lock().unwrap().insert(url.to_owned(), (status, body.to_vec()));
    }
    pub fn asked(&self) -> Vec<String> {
      self.asked.lock().unwrap().clone()
    }
  }

  impl Http for Fake {
    fn get(&self, url: &str, _accept: Option<&str>) -> Result<Response, String> {
      self.asked.lock().unwrap().push(url.to_owned());
      let (status, body) = self.pages.lock().unwrap().get(url).cloned().ok_or_else(|| format!("no route to {url}"))?;
      Ok(Response { status, length: Some(body.len() as u64), body: Box::new(ReadBody(std::io::Cursor::new(body))) })
    }
    fn download(&self, url: &str, _cancel: &AtomicBool) -> Result<Response, String> {
      self.get(url, None)
    }
    fn size(&self, url: &str) -> Result<u64, String> {
      self.pages.lock().unwrap().get(url).filter(|(s, _)| *s == 200).map(|(_, b)| b.len() as u64).ok_or_else(|| format!("no route to {url}"))
    }
  }

  pub fn sha256_hex(bytes: &[u8]) -> String {
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
  }
  pub fn sha512_hex(bytes: &[u8]) -> String {
    sha2::Sha512::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
  }

  const URL: &str = "https://example.test/tool.tar.gz";

  fn get(http: &Fake, digest: Digest, max: u64, dest: &Path) -> Result<(), DownloadError> {
    download_verified(http, URL, &digest, max, dest, &AtomicBool::new(false), false, &mut |_| {})
  }

  #[test]
  fn a_download_is_kept_only_when_its_digest_matches() {
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("tool.tar.gz");
    let body = b"release bytes".as_slice();
    let http = Fake::with(&[(URL, 200, body)]);

    let mut seen = 0;
    download_verified(&http, URL, &Digest::Sha256(sha256_hex(body)), body.len() as u64, &dest, &AtomicBool::new(false), false, &mut |n| seen = n).unwrap();
    assert_eq!((std::fs::read(&dest).unwrap().as_slice(), seen), (body, body.len() as u64));
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777, 0o600, "a download is never executable");
    }
    std::fs::remove_file(&dest).unwrap();
    get(&http, Digest::Sha512(sha512_hex(body)), 1 << 20, &dest).unwrap();
    std::fs::remove_file(&dest).unwrap();

    for wrong in [Digest::Sha256(sha256_hex(b"other")), Digest::Sha512(sha512_hex(b"other")), Digest::Sha256(sha512_hex(body))] {
      let err = get(&http, wrong, 1 << 20, &dest).unwrap_err();
      assert!(matches!(&err, DownloadError::Mismatch(m) if m.contains("checksum mismatch")), "{err:?}");
      assert!(!dest.exists(), "a mismatched download is removed");
    }
    assert!(matches!(get(&http, Digest::Sha256(sha256_hex(body)), body.len() as u64 - 1, &dest), Err(DownloadError::Mismatch(_))), "larger than the release");
    assert!(!dest.exists());
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
  }

  #[test]
  fn only_https_and_a_gone_release_is_a_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("f");
    let http = Fake::with(&[(URL, 404, b""), ("https://example.test/busy", 503, b"")]);
    let digest = Digest::Sha256(sha256_hex(b""));
    assert!(matches!(get(&http, digest.clone(), 10, &dest), Err(DownloadError::Mismatch(_))));
    let run = |url: &str| download_verified(&http, url, &digest, 10, &dest, &AtomicBool::new(false), false, &mut |_| {});
    assert!(matches!(run("https://example.test/busy"), Err(DownloadError::Network(_))));
    let before = http.asked().len();
    for url in ["http://example.test/tool", "file:///etc/passwd", "ftp://example.test/x", "https://user:pw@example.test/x", "example.test/x", "//example.test/x"] {
      assert!(matches!(run(url), Err(DownloadError::Mismatch(_))), "{url}");
      assert!(text(&http, url, None, 10).is_err(), "{url}");
    }
    assert_eq!(http.asked().len(), before, "nothing but https is ever requested");
    assert!(download_verified(&http, URL, &digest, 10, &dest, &AtomicBool::new(true), true, &mut |_| {}).is_err());
    assert!(!dest.exists());
  }

  /// Plain-http downloads from a local test server, through the same streamed body as `Reqwest`.
  struct Plain;

  impl Http for Plain {
    fn get(&self, url: &str, _accept: Option<&str>) -> Result<Response, String> {
      Err(format!("no lookups here: {url}"))
    }
    fn download(&self, url: &str, cancel: &AtomicBool) -> Result<Response, String> {
      stream(reqwest::Client::builder().no_proxy().read_timeout(Duration::from_secs(60)).build().unwrap(), url, cancel)
    }
    fn size(&self, url: &str) -> Result<u64, String> {
      Err(format!("no sizes here: {url}"))
    }
  }

  /// A local server that answers one request with a `length`-byte body but sends only `sent` bytes
  /// of it (none of the response at all with `head` false), then nothing. Its receiver says whether
  /// the client closed the connection within 10 s.
  fn stalling_server(head: bool, length: usize, sent: usize) -> (String, std::sync::mpsc::Receiver<bool>) {
    use std::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/tool.tar.gz", listener.local_addr().unwrap());
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
      let (mut sock, _) = listener.accept().unwrap();
      let mut buf = [0u8; 4096];
      let mut request = Vec::new();
      while !request.windows(4).any(|w| w == b"\r\n\r\n") {
        match sock.read(&mut buf) {
          Ok(0) | Err(_) => return,
          Ok(n) => request.extend_from_slice(&buf[..n]),
        }
      }
      if head {
        sock.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {length}\r\n\r\n").as_bytes()).unwrap();
        sock.write_all(&vec![b'x'; sent]).unwrap();
      }
      sock.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
      // End of stream or a reset: the client hung up. A timeout: it is still holding the connection.
      let closed = match sock.read(&mut buf) {
        Ok(0) => true,
        Err(e) => !matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut),
        Ok(_) => false,
      };
      let _ = tx.send(closed);
    });
    (url, rx)
  }

  #[test]
  fn a_stalled_download_ends_and_closes_its_connection() {
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("tool.tar.gz");
    let (url, closed) = stalling_server(true, 1 << 20, 1000);
    let started = Instant::now();
    let mut seen = 0;
    let err = download_once(&Plain, &url, &Digest::Sha256(sha256_hex(b"")), 1 << 20, &dest, &AtomicBool::new(false), Duration::from_secs(1), &mut |n| seen = n).unwrap_err();
    assert_eq!((err, seen), (DownloadError::Network("the download stalled".into()), 1000));
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    assert!(closed.recv().unwrap(), "the connection is closed, not left to its 45 min limit");
    assert!(!dest.exists());
  }

  #[test]
  fn a_cancel_ends_the_download_and_closes_its_connection() {
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("tool.tar.gz");
    // Mid-body: Cancel once the first bytes are in.
    let (url, closed) = stalling_server(true, 1 << 20, 1000);
    let cancel = AtomicBool::new(false);
    let started = Instant::now();
    let err = download_once(&Plain, &url, &Digest::Sha256(sha256_hex(b"")), 1 << 20, &dest, &cancel, STALL, &mut |_| cancel.store(true, Ordering::SeqCst)).unwrap_err();
    assert_eq!(err, DownloadError::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
    assert!(closed.recv().unwrap());
    assert!(!dest.exists());

    // Before the server answers at all.
    let (url, closed) = stalling_server(false, 0, 0);
    let cancel = AtomicBool::new(false);
    std::thread::scope(|scope| {
      scope.spawn(|| {
        std::thread::sleep(Duration::from_millis(300));
        cancel.store(true, Ordering::SeqCst);
      });
      let started = Instant::now();
      let err = download_once(&Plain, &url, &Digest::Sha256(sha256_hex(b"")), 10, &dest, &cancel, STALL, &mut |_| {}).unwrap_err();
      assert_eq!(err, DownloadError::Cancelled);
      assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
    });
    assert!(closed.recv().unwrap());
    assert!(!dest.exists());
  }

  #[test]
  fn lookups_are_bounded_text() {
    let http = Fake::with(&[("https://example.test/latest", 200, b"1.2.3\n"), ("https://example.test/gone", 404, b""), ("https://example.test/bin", 200, &[0xff, 0xfe])]);
    assert_eq!(text(&http, "https://example.test/latest", None, 64).unwrap().as_deref(), Some("1.2.3\n"));
    assert_eq!(text(&http, "https://example.test/gone", None, 64).unwrap(), None);
    assert!(text(&http, "https://example.test/latest", None, 3).is_err());
    assert!(text(&http, "https://example.test/bin", None, 64).is_err());
    assert!(text(&http, "https://example.test/unreachable", None, 64).is_err());
    assert!(is_hex(&sha256_hex(b"x"), 64) && !is_hex("ABCDEF", 6) && !is_hex("abc", 4));
  }
}
