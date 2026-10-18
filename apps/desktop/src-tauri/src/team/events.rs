//! Live updates from the team server: a Server-Sent Events client for `GET /v1/events`.
//!
//! One stream runs per signed-in server (the one the webview has selected). Each event is
//! forwarded to the webview as `team://event` with its kind and a few ids only; the webview
//! re-reads whatever it shows. Reconnects resume with `Last-Event-ID` (the server replays what
//! was missed or sends `reset`) after an exponential backoff with jitter, capped at 60 s.
//! A 401/403 stops the stream until the user signs in again. The token is never logged.

use std::io::Read;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;

use super::client::{SendError, classify};

pub const EVENT_NAME: &str = "team://event";

/// Live-update connection state shown in the team status.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamState {
  Connected,
  Reconnecting,
  #[default]
  Off,
}

// ---- parser -------------------------------------------------------------------

/// One dispatched SSE message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseMessage {
  pub event: String,
  pub data: String,
  /// The last event id at dispatch time (the stream's, not only this message's).
  pub id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseItem {
  Message(SseMessage),
  /// A `:` line; the server's `: ping` heartbeat and `: connected`.
  Comment(String),
}

/// Incremental `text/event-stream` parser (WHATWG HTML §9.2.6): bytes may be split anywhere,
/// lines end in LF, CRLF or CR.
#[derive(Debug, Default)]
pub struct SseParser {
  line: Vec<u8>,
  /// The previous chunk ended in CR, so a leading LF belongs to that line ending.
  after_cr: bool,
  started: bool,
  event: String,
  data: String,
  has_data: bool,
  last_id: Option<String>,
  /// The latest `retry:` value in milliseconds.
  pub retry_ms: Option<u64>,
}

/// Bounds one line so a misbehaving server cannot grow memory without limit.
const MAX_LINE: usize = 1 << 20;

impl SseParser {
  pub fn last_id(&self) -> Option<&str> {
    self.last_id.as_deref().filter(|s| !s.is_empty())
  }

  pub fn feed(&mut self, chunk: &[u8]) -> Vec<SseItem> {
    let mut out = Vec::new();
    for &b in chunk {
      if self.after_cr {
        self.after_cr = false;
        if b == b'\n' {
          continue;
        }
      }
      match b {
        b'\n' => self.end_line(&mut out),
        b'\r' => {
          self.after_cr = true;
          self.end_line(&mut out);
        }
        _ if self.line.len() < MAX_LINE => self.line.push(b),
        _ => {}
      }
    }
    out
  }

  fn end_line(&mut self, out: &mut Vec<SseItem>) {
    let raw = std::mem::take(&mut self.line);
    let mut line = String::from_utf8_lossy(&raw).into_owned();
    if !self.started {
      self.started = true;
      if let Some(rest) = line.strip_prefix('\u{feff}') {
        line = rest.to_owned();
      }
    }
    if line.is_empty() {
      if self.has_data {
        let mut data = std::mem::take(&mut self.data);
        if data.ends_with('\n') {
          data.pop();
        }
        let event = std::mem::take(&mut self.event);
        out.push(SseItem::Message(SseMessage {
          event: if event.is_empty() { "message".into() } else { event },
          data,
          id: self.last_id.clone(),
        }));
      }
      self.event.clear();
      self.data.clear();
      self.has_data = false;
      return;
    }
    if let Some(comment) = line.strip_prefix(':') {
      out.push(SseItem::Comment(comment.strip_prefix(' ').unwrap_or(comment).to_owned()));
      return;
    }
    let (field, value) = match line.split_once(':') {
      Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
      None => (line.as_str(), ""),
    };
    match field {
      "event" => self.event = value.to_owned(),
      "data" => {
        self.data.push_str(value);
        self.data.push('\n');
        self.has_data = true;
      }
      "id" if !value.contains('\0') => self.last_id = Some(value.to_owned()),
      "retry" if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => self.retry_ms = value.parse().ok(),
      _ => {}
    }
  }
}

// ---- events for the webview -------------------------------------------------------

/// `team://event` payload: the kind and the ids a view needs to decide what to re-read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TeamEvent {
  pub server: String,
  pub kind: String,
  pub id: Option<i64>,
  pub project_id: Option<String>,
  pub task_id: Option<String>,
  pub snap_id: Option<String>,
}

fn valid_kind(k: &str) -> bool {
  !k.is_empty() && k.len() <= 64 && k.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'_')
}

/// Maps a message to a webview event; `None` for kinds that are not ours (`message`, garbage).
pub fn to_team_event(server: &str, m: &SseMessage) -> Option<TeamEvent> {
  if m.event == "message" || !valid_kind(&m.event) {
    return None;
  }
  let v: serde_json::Value = serde_json::from_str(&m.data).unwrap_or_default();
  let s = |v: &serde_json::Value| v.as_str().filter(|s| s.len() <= 128).map(str::to_owned);
  Some(TeamEvent {
    server: server.to_owned(),
    kind: m.event.clone(),
    id: m.id.as_deref().and_then(|i| i.parse().ok()),
    project_id: s(&v["project_id"]),
    task_id: s(&v["task_id"]),
    snap_id: s(&v["data"]["snap_id"]),
  })
}

// ---- reconnect policy ---------------------------------------------------------------

pub const DEFAULT_BASE_MS: u64 = 1_000;
pub const MAX_BACKOFF_MS: u64 = 60_000;

/// `min(cap, base·2^attempt)`, then a random point in its upper half (`jitter` is any u64).
pub fn backoff_ms(attempt: u32, base_ms: u64, cap_ms: u64, jitter: u64) -> u64 {
  let full = base_ms.max(1).saturating_mul(1u64 << attempt.min(20)).min(cap_ms);
  let half = full / 2;
  half + jitter % (full - half + 1)
}

fn jitter() -> u64 {
  use std::hash::{BuildHasher, Hasher};
  let mut h = std::collections::hash_map::RandomState::new().build_hasher();
  h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
  h.finish()
}

// ---- stop signal ----------------------------------------------------------------------

/// Stops one stream: wakes its backoff sleep at once; a blocked read ends at the next byte or
/// at the read timeout, and nothing is emitted after `stop`.
#[derive(Default)]
pub struct Stop {
  stopped: Mutex<bool>,
  cv: Condvar,
}

impl Stop {
  pub fn stop(&self) {
    *self.stopped.lock().unwrap() = true;
    self.cv.notify_all();
  }

  pub fn is_stopped(&self) -> bool {
    *self.stopped.lock().unwrap()
  }

  /// Sleeps up to `d`; true when stopped.
  fn wait(&self, d: Duration) -> bool {
    let g = self.stopped.lock().unwrap();
    *self.cv.wait_timeout_while(g, d, |s| !*s).unwrap().0
  }
}

// ---- the stream loop ---------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Signal {
  State(StreamState),
  /// Waiting this long before the next attempt.
  Retrying(u64),
  Event(TeamEvent),
  /// 401/403: the token was rejected; the stream has stopped.
  Unauthorized(String),
}

pub struct StreamConfig {
  /// Backoff base until the server sends `retry:`.
  pub base_ms: u64,
  pub cap_ms: u64,
  /// Longest silence before the connection counts as dead (the server pings every 15 s).
  pub read_timeout: Duration,
}

impl Default for StreamConfig {
  fn default() -> Self {
    Self { base_ms: DEFAULT_BASE_MS, cap_ms: MAX_BACKOFF_MS, read_timeout: Duration::from_secs(45) }
  }
}

pub fn http_client(cfg: &StreamConfig) -> Result<reqwest::blocking::Client, String> {
  // In the blocking client `timeout` bounds each read of the body, not the whole stream.
  crate::net_proxy::client_builder()?
    .timeout(cfg.read_timeout)
    .connect_timeout(Duration::from_secs(5))
    .redirect(reqwest::redirect::Policy::none())
    .user_agent(concat!("kingu-desktop/", env!("CARGO_PKG_VERSION")))
    .build()
    .map_err(|e| e.to_string())
}

/// How one connection ended.
enum Ended {
  Stopped,
  /// The connection dropped; `progressed` when it delivered at least one message or comment.
  Dropped { progressed: bool },
  Failed(SendError),
}

fn connect_once(
  client: &reqwest::blocking::Client,
  server: &str,
  token: &str,
  parser: &mut SseParser,
  stop: &Stop,
  emit: &mut dyn FnMut(Signal),
) -> Ended {
  let mut req = client
    .get(format!("{server}/v1/events"))
    .bearer_auth(token)
    .header(reqwest::header::ACCEPT, "text/event-stream")
    .header(reqwest::header::CACHE_CONTROL, "no-cache");
  if let Some(id) = parser.last_id() {
    req = req.header("Last-Event-ID", id);
  }
  let mut res = match req.send() {
    Ok(r) => r,
    Err(e) => return Ended::Failed(SendError::Retryable(e.without_url().to_string())),
  };
  let status = res.status().as_u16();
  if !(200..300).contains(&status) {
    let body = res.text().unwrap_or_default();
    return Ended::Failed(classify(status, &body).err().unwrap_or(SendError::Retryable(format!("HTTP {status}"))));
  }
  let is_sse = res
    .headers()
    .get(reqwest::header::CONTENT_TYPE)
    .and_then(|v| v.to_str().ok())
    .is_some_and(|v| v.trim_start().to_ascii_lowercase().starts_with("text/event-stream"));
  if !is_sse {
    return Ended::Failed(SendError::Permanent("เซิร์ฟเวอร์ไม่ได้ตอบเป็น event stream".into()));
  }
  if stop.is_stopped() {
    return Ended::Stopped;
  }
  emit(Signal::State(StreamState::Connected));
  let mut progressed = false;
  let mut buf = [0u8; 8192];
  loop {
    let n = match res.read(&mut buf) {
      Ok(0) | Err(_) => return Ended::Dropped { progressed },
      Ok(n) => n,
    };
    if stop.is_stopped() {
      return Ended::Stopped;
    }
    for item in parser.feed(&buf[..n]) {
      progressed = true;
      if let SseItem::Message(m) = item
        && let Some(ev) = to_team_event(server, &m)
      {
        emit(Signal::Event(ev));
      }
    }
  }
}

/// Runs the stream until `stop` or a rejected token. Emits `State(Off)` last.
pub fn run(
  client: &reqwest::blocking::Client,
  cfg: &StreamConfig,
  server: &str,
  token: &str,
  stop: &Stop,
  emit: &mut dyn FnMut(Signal),
) {
  let mut parser = SseParser::default();
  let mut attempt: u32 = 0;
  while !stop.is_stopped() {
    let delay = match connect_once(client, server, token, &mut parser, stop, emit) {
      Ended::Stopped => break,
      Ended::Failed(SendError::Unauthorized(m)) => {
        if !stop.is_stopped() {
          emit(Signal::Unauthorized(m));
        }
        break;
      }
      ended => {
        if matches!(ended, Ended::Dropped { progressed: true }) {
          attempt = 0;
        }
        let base = parser.retry_ms.map_or(cfg.base_ms, |r| r.clamp(100, cfg.cap_ms));
        // A 404 (a server without /v1/events) or a non-stream answer will not fix itself soon.
        let a = if matches!(ended, Ended::Failed(SendError::Permanent(_))) { 31 } else { attempt };
        attempt = attempt.saturating_add(1);
        backoff_ms(a, base, cfg.cap_ms, jitter())
      }
    };
    if stop.is_stopped() {
      break;
    }
    emit(Signal::State(StreamState::Reconnecting));
    emit(Signal::Retrying(delay));
    if stop.wait(Duration::from_millis(delay)) {
      break;
    }
  }
  emit(Signal::State(StreamState::Off));
}

/// The active stream (at most one: the server selected in settings).
pub struct Handle {
  pub server: String,
  pub stop: Arc<Stop>,
}

#[cfg(test)]
mod tests {
  use std::io::{BufRead, BufReader, Write};
  use std::net::TcpListener;
  use std::time::Instant;

  use super::*;

  fn msgs(items: Vec<SseItem>) -> Vec<SseMessage> {
    items
      .into_iter()
      .filter_map(|i| match i {
        SseItem::Message(m) => Some(m),
        SseItem::Comment(_) => None,
      })
      .collect()
  }

  const STREAM: &str = "retry: 3000\n: connected\n\nid: 5\nevent: snap.updated\ndata: {\"id\":5}\n\n";

  #[test]
  fn parses_whole_stream() {
    let mut p = SseParser::default();
    let items = p.feed(STREAM.as_bytes());
    assert_eq!(items[0], SseItem::Comment("connected".into()));
    assert_eq!(items[1], SseItem::Message(SseMessage { event: "snap.updated".into(), data: "{\"id\":5}".into(), id: Some("5".into()) }));
    assert_eq!(p.retry_ms, Some(3000));
    assert_eq!(p.last_id(), Some("5"));
  }

  #[test]
  fn any_chunk_boundary_gives_the_same_result() {
    let whole = SseParser::default().feed(STREAM.as_bytes());
    let bytes = STREAM.replace('\n', "\r\n").into_bytes();
    for split in 0..=bytes.len() {
      let mut p = SseParser::default();
      let mut items = p.feed(&bytes[..split]);
      items.extend(p.feed(&bytes[split..]));
      assert_eq!(items, whole, "CRLF split at {split}");
    }
    // One byte at a time, bare CR line endings.
    let mut p = SseParser::default();
    let items: Vec<_> = STREAM.replace('\n', "\r").bytes().flat_map(|b| p.feed(&[b])).collect();
    assert_eq!(items, whole);
  }

  #[test]
  fn multi_line_data_and_fields() {
    let mut p = SseParser::default();
    let m = msgs(p.feed(b"data: a\ndata\ndata:  b\nevent:x\nunknown: 1\nid\n\n"));
    assert_eq!(m, vec![SseMessage { event: "x".into(), data: "a\n\n b".into(), id: Some(String::new()) }]);
    assert_eq!(p.last_id(), None, "empty id resets the resume point");
    // No data → nothing dispatched, but the id still sticks; event type does not.
    assert!(msgs(p.feed(b"id: 9\nevent: y\n\n")).is_empty());
    assert_eq!(p.last_id(), Some("9"));
    let m = msgs(p.feed(b"data: z\n\n"));
    assert_eq!(m[0].event, "message");
    assert_eq!(m[0].id.as_deref(), Some("9"));
    // An unterminated message is not dispatched.
    assert!(msgs(p.feed(b"event: q\ndata: half")).is_empty());
  }

  #[test]
  fn comments_bom_retry_and_bad_ids() {
    let mut p = SseParser::default();
    let items = p.feed("\u{feff}: ping\n:\n\n".as_bytes());
    assert_eq!(items, vec![SseItem::Comment("ping".into()), SseItem::Comment(String::new())]);
    p.feed(b"retry: 25\nretry: x1\nretry:\nid: a\0b\n\n");
    assert_eq!(p.retry_ms, Some(25));
    assert_eq!(p.last_id(), None);
  }

  #[test]
  fn team_events_carry_ids_only() {
    let m = SseMessage {
      event: "snap.removed".into(),
      data: r#"{"id":12,"kind":"snap.removed","project_id":null,"task_id":null,"data":{"snap_id":"go","name":"Go"}}"#.into(),
      id: Some("12".into()),
    };
    let e = to_team_event("https://t", &m).unwrap();
    assert_eq!(e, TeamEvent { server: "https://t".into(), kind: "snap.removed".into(), id: Some(12), project_id: None, task_id: None, snap_id: Some("go".into()) });
    let reset = SseMessage { event: "reset".into(), data: "{\"reason\":\"x\"}".into(), id: Some("40".into()) };
    assert_eq!(to_team_event("s", &reset).unwrap().kind, "reset");
    assert!(to_team_event("s", &SseMessage { event: "message".into(), data: String::new(), id: None }).is_none());
    assert!(to_team_event("s", &SseMessage { event: "<script>".into(), data: String::new(), id: None }).is_none());
  }

  #[test]
  fn backoff_grows_with_jitter_and_caps() {
    assert_eq!(backoff_ms(0, 1000, 60_000, 0), 500);
    for j in [0, 1, 7, 12345, u64::MAX] {
      for (a, lo, hi) in [(0, 500, 1000), (1, 1000, 2000), (3, 4000, 8000), (6, 30_000, 60_000), (40, 30_000, 60_000)] {
        let d = backoff_ms(a, 1000, 60_000, j);
        assert!((lo..=hi).contains(&d), "attempt {a} jitter {j}: {d}");
      }
    }
  }

  #[test]
  fn stop_wakes_the_backoff_sleep() {
    let stop = Arc::new(Stop::default());
    let s = stop.clone();
    let t = std::thread::spawn(move || s.wait(Duration::from_secs(30)));
    std::thread::sleep(Duration::from_millis(20));
    stop.stop();
    assert!(t.join().unwrap());
  }

  /// One HTTP request as the fake server saw it.
  #[derive(Debug)]
  struct Seen {
    line: String,
    auth: String,
    last_event_id: Option<String>,
    at: Instant,
  }

  fn read_request(stream: &std::net::TcpStream) -> Seen {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let (mut auth, mut last) = (String::new(), None);
    loop {
      let mut h = String::new();
      reader.read_line(&mut h).unwrap();
      let h = h.trim_end();
      if h.is_empty() {
        break;
      }
      let (k, v) = h.split_once(':').unwrap();
      match k.to_ascii_lowercase().as_str() {
        "authorization" => auth = v.trim().to_owned(),
        "last-event-id" => last = Some(v.trim().to_owned()),
        _ => {}
      }
    }
    Seen { line: line.trim_end().to_owned(), auth, last_event_id: last, at: Instant::now() }
  }

  const SSE_HEAD: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";

  #[test]
  fn reconnects_with_last_event_id_after_backoff_then_stops_on_401() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
      let mut seen = Vec::new();
      let mut dropped_at = Vec::new();
      // 1: a stream that delivers one event in two pieces, then drops.
      let (mut s, _) = listener.accept().unwrap();
      seen.push(read_request(&s));
      write!(s, "{SSE_HEAD}retry: 120\n: connected\n\nid: 7\nevent: snap.upd").unwrap();
      s.flush().unwrap();
      std::thread::sleep(Duration::from_millis(20));
      write!(s, "ated\r\ndata: {{\"id\":7,\"data\":{{\"snap_id\":\"go\"}}}}\r\n\r\n").unwrap();
      drop(s);
      dropped_at.push(Instant::now());
      // 2, 3: unavailable.
      for _ in 0..2 {
        let (mut s, _) = listener.accept().unwrap();
        seen.push(read_request(&s));
        write!(s, "HTTP/1.1 503 X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        drop(s);
        dropped_at.push(Instant::now());
      }
      // 4: back, but only a heartbeat before dropping again.
      let (mut s, _) = listener.accept().unwrap();
      seen.push(read_request(&s));
      write!(s, "{SSE_HEAD}: ping\n\n").unwrap();
      drop(s);
      dropped_at.push(Instant::now());
      // 5: the token was revoked.
      let (mut s, _) = listener.accept().unwrap();
      seen.push(read_request(&s));
      let body = r#"{"error":{"code":"invalid_token","message":"x"}}"#;
      write!(s, "HTTP/1.1 401 X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
      (seen, dropped_at)
    });

    let cfg = StreamConfig { base_ms: 5_000, cap_ms: 60_000, read_timeout: Duration::from_secs(5) };
    let client = http_client(&cfg).unwrap();
    let token = format!("kgu_{}", "a".repeat(43));
    let stop = Stop::default();
    let mut signals = Vec::new();
    run(&client, &cfg, &base, &token, &stop, &mut |s| signals.push(s));
    let (seen, dropped_at) = server.join().unwrap();

    assert_eq!(seen.len(), 5);
    for s in &seen {
      assert_eq!(s.line, "GET /v1/events HTTP/1.1");
      assert_eq!(s.auth, format!("Bearer {token}"));
    }
    assert_eq!(seen[0].last_event_id, None);
    for s in &seen[1..] {
      assert_eq!(s.last_event_id.as_deref(), Some("7"));
    }

    let delays: Vec<u64> = signals.iter().filter_map(|s| if let Signal::Retrying(d) = s { Some(*d) } else { None }).collect();
    // The server's `retry: 120` replaced the 5 s base (and is kept across reconnects); failures
    // double the delay, and a connection that delivered anything starts over.
    assert_eq!(delays.len(), 4);
    for (d, range) in delays.iter().zip([60..=120, 120..=240, 240..=480, 60..=120]) {
      assert!(range.contains(d), "{delays:?}");
    }
    for i in 0..4 {
      let waited = seen[i + 1].at.duration_since(dropped_at[i]).as_millis() as u64;
      assert!(waited + 5 >= delays[i], "reconnected after {waited} ms, backoff {}", delays[i]);
    }

    let ev = TeamEvent { server: base.clone(), kind: "snap.updated".into(), id: Some(7), project_id: None, task_id: None, snap_id: Some("go".into()) };
    assert_eq!(
      signals,
      vec![
        Signal::State(StreamState::Connected),
        Signal::Event(ev),
        Signal::State(StreamState::Reconnecting),
        Signal::Retrying(delays[0]),
        Signal::State(StreamState::Reconnecting),
        Signal::Retrying(delays[1]),
        Signal::State(StreamState::Reconnecting),
        Signal::Retrying(delays[2]),
        Signal::State(StreamState::Connected),
        Signal::State(StreamState::Reconnecting),
        Signal::Retrying(delays[3]),
        Signal::Unauthorized("HTTP 401 invalid_token".into()),
        Signal::State(StreamState::Off),
      ]
    );
  }

  #[test]
  fn stop_ends_a_live_stream_without_emitting_more() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
      let (mut s, _) = listener.accept().unwrap();
      read_request(&s);
      write!(s, "{SSE_HEAD}: connected\n\n").unwrap();
      s.flush().unwrap();
      std::thread::sleep(Duration::from_millis(150));
      // Arrives after stop: must not be forwarded.
      let _ = write!(s, "id: 1\nevent: snap.updated\ndata: {{}}\n\n: ping\n\n");
      std::thread::sleep(Duration::from_millis(100));
    });
    let cfg = StreamConfig { read_timeout: Duration::from_secs(5), ..Default::default() };
    let client = http_client(&cfg).unwrap();
    let stop = Arc::new(Stop::default());
    let s2 = stop.clone();
    std::thread::spawn(move || {
      std::thread::sleep(Duration::from_millis(60));
      s2.stop();
    });
    let mut signals = Vec::new();
    run(&client, &cfg, &base, "kgu_x", &stop, &mut |s| signals.push(s));
    server.join().unwrap();
    assert_eq!(signals, vec![Signal::State(StreamState::Connected), Signal::State(StreamState::Off)]);
  }
}
