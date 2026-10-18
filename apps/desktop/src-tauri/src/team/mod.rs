//! Team visibility: syncs task METADATA (title, status, branch, agent, model, diff stats, the
//! issue it came from, timestamps) and each agent run's timings, tokens and cost to the Kingu team
//! server. Never code, diffs, prompts, transcripts or secrets.
//!
//! The webview calls `team_sync_task` when a task changes and `team_sync_run` when a run (or a
//! turn) ends; the state goes into a durable outbox and a background thread delivers it with
//! retry and backoff. The personal access
//! token lives only in the OS keychain (macOS Keychain), never in settings or localStorage.

pub mod client;
pub mod events;
pub mod outbox;
pub mod payload;
pub mod snaps;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use events::{Signal, StreamState};
use client::{HttpTransport, Keychain, SendError, TokenStore, Transport, normalize_server_url, valid_token};
use outbox::{Entry, Outbox};
use payload::{RunSync, TaskSync, valid_project_id};

use crate::i18n::msg::TeamMsg;
use crate::tr;

pub const STATUS_EVENT: &str = "team://status";
const OUTBOX_FILE: &str = "team-outbox.json";
/// Re-check for a token this long after finding none.
const SIGNED_OUT_RECHECK_MS: u64 = 60_000;

fn now_ms() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// What the status bar shows for one server.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct TeamStatus {
  pub server: String,
  pub signed_in: bool,
  /// `None` until the first request to the server.
  pub online: Option<bool>,
  pub pending: usize,
  pub last_error: Option<String>,
  /// Live updates (`team://event`) from the server's event stream.
  pub stream: StreamState,
}

#[derive(Default)]
struct Shared {
  /// Never held across a network call (see `flush_once`), so commands never wait on the network.
  outbox: Mutex<Outbox>,
  /// Set by enqueue/sign-in so the worker does not sleep through new work.
  kick: Mutex<bool>,
  wake: Condvar,
  status: Mutex<HashMap<String, TeamStatus>>,
  stream: Mutex<Option<events::Handle>>,
}

#[derive(Default, Clone)]
pub struct Team {
  shared: Arc<Shared>,
}

/// Per-server result of one delivery pass.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ServerReport {
  pub sent: usize,
  pub signed_in: bool,
  pub online: Option<bool>,
  pub last_error: Option<String>,
}

/// Delivers every due entry once. The outbox lock is not held during network calls.
pub fn flush_once(
  inner: &Mutex<Outbox>,
  now: u64,
  store: &dyn TokenStore,
  transport: &dyn Transport,
) -> HashMap<String, ServerReport> {
  let due = inner.lock().unwrap().due(now);
  let mut tokens: HashMap<String, Option<String>> = HashMap::new();
  let mut reports: HashMap<String, ServerReport> = HashMap::new();
  for entry in due {
    let token = tokens.entry(entry.server.clone()).or_insert_with(|| store.get(&entry.server)).clone();
    let report = reports.entry(entry.server.clone()).or_default();
    let Some(token) = token else {
      report.signed_in = false;
      inner.lock().unwrap().defer_server(&entry.server, now + SIGNED_OUT_RECHECK_MS);
      continue;
    };
    report.signed_in = true;
    let result = transport.put(&entry.server, &token, &entry.project, &entry.item);
    let mut outbox = inner.lock().unwrap();
    match result {
      Ok(()) => {
        outbox.complete(&entry);
        report.sent += 1;
        report.online = Some(true);
      }
      Err(SendError::Retryable(e)) => {
        outbox.fail(&entry, now, &e, true);
        report.online.get_or_insert(false);
        report.last_error = Some(e);
      }
      Err(SendError::Unauthorized(e)) => {
        // Token revoked or expired: keep everything until the user signs in again.
        report.signed_in = false;
        report.online = Some(true);
        report.last_error = Some(e);
        outbox.defer_server(&entry.server, now + SIGNED_OUT_RECHECK_MS);
        tokens.insert(entry.server.clone(), None);
      }
      Err(SendError::Permanent(e)) => {
        outbox.fail(&entry, now, &e, false);
        report.online = Some(true);
        report.last_error = Some(e);
      }
    }
  }
  reports
}

impl Team {
  fn status_of(&self, server: &str) -> TeamStatus {
    let pending = self.shared.outbox.lock().unwrap().pending_for(server);
    let mut map = self.shared.status.lock().unwrap();
    let st = map.entry(server.to_owned()).or_insert_with(|| TeamStatus {
      server: server.to_owned(),
      signed_in: Keychain.get(server).is_some(),
      ..Default::default()
    });
    st.pending = pending;
    st.clone()
  }

  fn update_status(&self, app: Option<&AppHandle>, server: &str, f: impl FnOnce(&mut TeamStatus)) {
    let pending = self.shared.outbox.lock().unwrap().pending_for(server);
    let st = {
      let mut map = self.shared.status.lock().unwrap();
      let st = map.entry(server.to_owned()).or_insert_with(|| TeamStatus { server: server.to_owned(), ..Default::default() });
      f(st);
      st.pending = pending;
      st.clone()
    };
    if let Some(app) = app {
      let _ = app.emit(STATUS_EVENT, st);
    }
  }

  fn kick(&self) {
    *self.shared.kick.lock().unwrap() = true;
    self.shared.wake.notify_all();
  }

  fn save(&self) {
    if let Err(e) = self.shared.outbox.lock().unwrap().save() {
      log::error!("team outbox save: {e}");
    }
  }

  /// Starts the event stream for `server` unless it is already running; stops any other.
  fn start_stream(&self, app: &AppHandle, server: &str) {
    let mut slot = self.shared.stream.lock().unwrap();
    if slot.as_ref().is_some_and(|h| h.server == server && !h.stop.is_stopped()) {
      return;
    }
    let old = slot.take();
    let stop = Arc::new(events::Stop::default());
    *slot = Some(events::Handle { server: server.to_owned(), stop: stop.clone() });
    drop(slot);
    if let Some(old) = old {
      old.stop.stop();
      if old.server != server {
        self.update_status(Some(app), &old.server, |st| st.stream = StreamState::Off);
      }
    }
    let (team, app, server) = (self.clone(), app.clone(), server.to_owned());
    let spawned = std::thread::Builder::new().name("kingu-team-events".into()).spawn(move || team.stream_worker(&app, &server, &stop));
    if let Err(e) = spawned {
      log::error!("team events thread: {e}");
    }
  }

  /// Stops the event stream (any, or only `server`'s).
  fn stop_stream(&self, app: &AppHandle, server: Option<&str>) {
    let mut slot = self.shared.stream.lock().unwrap();
    if !slot.as_ref().is_some_and(|h| server.is_none_or(|s| s == h.server)) {
      return;
    }
    if let Some(h) = slot.take() {
      drop(slot);
      h.stop.stop();
      self.update_status(Some(app), &h.server, |st| st.stream = StreamState::Off);
    }
  }

  fn stream_worker(&self, app: &AppHandle, server: &str, stop: &events::Stop) {
    let Some(token) = Keychain.get(server) else {
      self.update_status(Some(app), server, |st| {
        st.signed_in = false;
        st.stream = StreamState::Off;
      });
      return self.release_stream(stop);
    };
    let cfg = events::StreamConfig::default();
    let client = match events::http_client(&cfg) {
      Ok(c) => c,
      Err(e) => {
        log::error!("team events disabled: {e}");
        return self.release_stream(stop);
      }
    };
    events::run(&client, &cfg, server, &token, stop, &mut |signal| {
      // A stopped stream's status belongs to whoever stopped it (or to its successor).
      if stop.is_stopped() {
        return;
      }
      match signal {
        Signal::Event(ev) => {
          let _ = app.emit(events::EVENT_NAME, ev);
        }
        Signal::State(state) => self.update_status(Some(app), server, |st| {
          st.stream = state;
          if state == StreamState::Connected {
            st.online = Some(true);
          }
        }),
        Signal::Retrying(ms) => log::info!("team events: reconnecting in {ms} ms"),
        Signal::Unauthorized(e) => {
          log::warn!("team events: token rejected ({e})");
          self.update_status(Some(app), server, |st| {
            st.signed_in = false;
            st.online = Some(true);
            st.last_error = Some(e);
          });
        }
      }
    });
    self.release_stream(stop);
  }

  /// Clears the slot when it still holds this (ended) stream, so a later start runs a new one.
  fn release_stream(&self, stop: &events::Stop) {
    let mut slot = self.shared.stream.lock().unwrap();
    if slot.as_ref().is_some_and(|h| std::ptr::eq(Arc::as_ptr(&h.stop), stop)) {
      *slot = None;
    }
  }

  /// Loads the outbox and starts the delivery thread.
  fn start(&self, app: AppHandle, path: PathBuf) {
    *self.shared.outbox.lock().unwrap() = Outbox::load(path);
    let team = self.clone();
    std::thread::Builder::new()
      .name("kingu-team-sync".into())
      .spawn(move || team.worker(app))
      .expect("spawn team sync thread");
  }

  fn worker(&self, app: AppHandle) {
    let transport = match HttpTransport::new() {
      Ok(t) => t,
      Err(e) => return log::error!("team sync disabled: {e}"),
    };
    loop {
      let now = now_ms();
      let reports = flush_once(&self.shared.outbox, now, &Keychain, &transport);
      if !reports.is_empty() {
        self.save();
      }
      for (server, r) in reports {
        self.update_status(Some(&app), &server, |st| {
          st.signed_in = r.signed_in;
          if r.online.is_some() {
            st.online = r.online;
          }
          st.last_error = if r.sent > 0 && r.last_error.is_none() { None } else { r.last_error.or(st.last_error.take()) };
        });
      }
      let wait = self
        .shared
        .outbox
        .lock()
        .unwrap()
        .next_due_ms()
        .map(|t| t.saturating_sub(now_ms()))
        .unwrap_or(60_000)
        .clamp(50, 60_000);
      let mut kick = self.shared.kick.lock().unwrap();
      if !*kick {
        kick = self.shared.wake.wait_timeout(kick, Duration::from_millis(wait)).unwrap().0;
      }
      *kick = false;
    }
  }
}

/// Registers the team state and starts the sync thread (call from `setup`).
pub fn install(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
  let team = Team::default();
  team.start(app.handle().clone(), app.path().app_data_dir()?.join(OUTBOX_FILE));
  app.manage(team);
  Ok(())
}

// ---- commands -------------------------------------------------------------------

#[derive(Serialize)]
pub struct SignedIn {
  pub server: String,
  pub org_id: String,
  pub org_name: String,
  pub user_id: String,
  pub role: String,
}

/// Verifies `token` against the server (`GET /v1/me`) and stores it in the keychain.
#[tauri::command]
pub async fn team_sign_in(app: AppHandle, team: State<'_, Team>, server_url: String, token: String) -> Result<SignedIn, String> {
  let server = normalize_server_url(&server_url)?;
  let token = token.trim().to_owned();
  if !valid_token(&token) {
    return Err(tr!(TeamMsg::BadTokenFormat));
  }
  let srv = server.clone();
  let me = tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
    let me = HttpTransport::new()?.me(&srv, &token).map_err(|e| match e {
      SendError::Unauthorized(_) => tr!(TeamMsg::TokenRejected),
      SendError::Retryable(m) => tr!(TeamMsg::Unreachable, detail = m),
      SendError::Permanent(m) => tr!(TeamMsg::BadResponse, detail = m),
    })?;
    Keychain::set(&srv, &token).map_err(|e| tr!(TeamMsg::SaveTokenFailed, detail = e))?;
    Ok(me)
  })
  .await
  .map_err(|e| e.to_string())??;
  team.shared.outbox.lock().unwrap().retry_all_now();
  team.kick();
  // A running stream still holds the old token.
  if team.shared.stream.lock().unwrap().as_ref().is_some_and(|h| h.server == server) {
    team.stop_stream(&app, Some(&server));
    team.start_stream(&app, &server);
  }
  team.update_status(Some(&app), &server, |st| {
    st.signed_in = true;
    st.online = Some(true);
    st.last_error = None;
  });
  let s = |k: &str| me[k].as_str().unwrap_or_default().to_owned();
  Ok(SignedIn { server, org_id: s("org_id"), org_name: s("org_name"), user_id: s("user_id"), role: s("role") })
}

#[tauri::command]
pub fn team_sign_out(app: AppHandle, team: State<'_, Team>, server_url: String) -> Result<(), String> {
  let server = normalize_server_url(&server_url)?;
  team.stop_stream(&app, Some(&server));
  Keychain::delete(&server)?;
  team.update_status(Some(&app), &server, |st| {
    st.signed_in = false;
    st.online = None;
  });
  Ok(())
}

#[tauri::command]
pub fn team_status(team: State<'_, Team>, server_url: String) -> Result<TeamStatus, String> {
  Ok(team.status_of(&normalize_server_url(&server_url)?))
}

/// Live updates for `server_url` (the selected team server) while signed in; replaces any other
/// stream. Without a token the status turns signed-out instead.
#[tauri::command]
pub fn team_events_start(app: AppHandle, team: State<'_, Team>, server_url: String) -> Result<(), String> {
  let server = normalize_server_url(&server_url)?;
  team.start_stream(&app, &server);
  Ok(())
}

#[tauri::command]
pub fn team_events_stop(app: AppHandle, team: State<'_, Team>) {
  team.stop_stream(&app, None);
}

impl Team {
  /// Validates and queues one state; returns the number pending for its server.
  fn enqueue(&self, server_url: &str, project: &str, item: outbox::Item) -> Result<usize, String> {
    let server = normalize_server_url(server_url)?;
    if !valid_project_id(project) {
      return Err(tr!(TeamMsg::BadProjectId));
    }
    item.validate()?;
    let pending = {
      let mut outbox = self.shared.outbox.lock().unwrap();
      outbox.enqueue(Entry::new(server.clone(), project.to_lowercase(), item));
      outbox.pending_for(&server)
    };
    self.save();
    self.kick();
    Ok(pending)
  }
}

/// Queues one task state for the team server. Returns the number of pending states.
#[tauri::command]
pub fn team_sync_task(team: State<'_, Team>, server_url: String, project: String, task: TaskSync) -> Result<usize, String> {
  team.enqueue(&server_url, &project, task.into())
}

/// Queues one run state (timings, tokens, cost) of a synced task. Returns the number pending.
#[tauri::command]
pub fn team_sync_run(team: State<'_, Team>, server_url: String, project: String, run: RunSync) -> Result<usize, String> {
  team.enqueue(&server_url, &project, run.into())
}

/// "Sync now": retries everything immediately.
#[tauri::command]
pub fn team_sync_now(team: State<'_, Team>) {
  team.shared.outbox.lock().unwrap().retry_all_now();
  team.kick();
}

#[cfg(test)]
mod tests {
  use std::io::{BufRead, BufReader, Read, Write};
  use std::net::TcpListener;
  use std::sync::atomic::{AtomicUsize, Ordering};

  use super::outbox::Item;
  use super::payload::{sample, sample_run};
  use super::*;

  const S: &str = "http://127.0.0.1:1";
  const P: &str = "11111111-1111-1111-1111-111111111111";

  struct FakeStore(Option<&'static str>);
  impl TokenStore for FakeStore {
    fn get(&self, _: &str) -> Option<String> {
      self.0.map(str::to_owned)
    }
  }

  struct FakeTransport {
    results: Mutex<Vec<Result<(), SendError>>>,
    calls: AtomicUsize,
  }
  impl FakeTransport {
    fn new(mut results: Vec<Result<(), SendError>>) -> Self {
      results.reverse();
      Self { results: Mutex::new(results), calls: AtomicUsize::new(0) }
    }
  }
  impl Transport for FakeTransport {
    fn put(&self, _: &str, token: &str, _: &str, _: &Item) -> Result<(), SendError> {
      assert_eq!(token, "kgu_tok");
      self.calls.fetch_add(1, Ordering::SeqCst);
      self.results.lock().unwrap().pop().unwrap_or(Ok(()))
    }
  }

  fn outbox_with(ids: &[&str]) -> Mutex<Outbox> {
    let mut o = Outbox::default();
    for id in ids {
      o.enqueue(Entry::new(S.into(), P.into(), sample(id, "running", "2026-10-17T10:00:00Z")));
    }
    Mutex::new(o)
  }

  #[test]
  fn delivers_and_retries() {
    let o = outbox_with(&["a", "b"]);
    let t = FakeTransport::new(vec![Ok(()), Err(SendError::Retryable("503".into()))]);
    let r = flush_once(&o, 1_000, &FakeStore(Some("kgu_tok")), &t);
    assert_eq!(r[S], ServerReport { sent: 1, signed_in: true, online: Some(true), last_error: Some("503".into()) });
    assert_eq!(o.lock().unwrap().len(), 1);
    // Not due yet: nothing sent.
    assert!(flush_once(&o, 1_500, &FakeStore(Some("kgu_tok")), &t).is_empty());
    let r = flush_once(&o, 2_000, &FakeStore(Some("kgu_tok")), &t);
    assert_eq!(r[S].sent, 1);
    assert_eq!(o.lock().unwrap().len(), 0);
    assert_eq!(t.calls.load(Ordering::SeqCst), 3);
  }

  #[test]
  fn offline_when_every_send_fails() {
    let o = outbox_with(&["a"]);
    let t = FakeTransport::new(vec![Err(SendError::Retryable("connection refused".into()))]);
    let r = flush_once(&o, 0, &FakeStore(Some("kgu_tok")), &t);
    assert_eq!(r[S].online, Some(false));
    assert_eq!(o.lock().unwrap().entries()[0].attempts, 1);
  }

  #[test]
  fn waits_for_sign_in_without_sending() {
    let o = outbox_with(&["a"]);
    let t = FakeTransport::new(vec![]);
    let r = flush_once(&o, 0, &FakeStore(None), &t);
    assert!(!r[S].signed_in);
    assert_eq!(t.calls.load(Ordering::SeqCst), 0);
    let o = o.into_inner().unwrap();
    assert_eq!(o.entries()[0].attempts, 0, "no attempt counted");
    assert_eq!(o.next_due_ms(), Some(SIGNED_OUT_RECHECK_MS));
  }

  #[test]
  fn unauthorized_keeps_entries_and_stops_sending() {
    let o = outbox_with(&["a", "b"]);
    let t = FakeTransport::new(vec![Err(SendError::Unauthorized("HTTP 401 invalid_token".into()))]);
    let r = flush_once(&o, 0, &FakeStore(Some("kgu_tok")), &t);
    assert!(!r[S].signed_in);
    assert_eq!(t.calls.load(Ordering::SeqCst), 1, "second entry not sent with a rejected token");
    assert_eq!(o.lock().unwrap().len(), 2);
  }

  #[test]
  fn permanent_rejection_drops_entry() {
    let o = outbox_with(&["a"]);
    let t = FakeTransport::new(vec![Err(SendError::Permanent("HTTP 422 content_not_allowed".into()))]);
    flush_once(&o, 0, &FakeStore(Some("kgu_tok")), &t);
    assert_eq!(o.lock().unwrap().len(), 0);
  }

  #[test]
  fn run_waits_for_its_task() {
    let o = Mutex::new({
      let mut o = Outbox::default();
      o.enqueue(Entry::new(S.into(), P.into(), sample_run("a", "r1", "2026-10-17T10:00:00Z")));
      o.enqueue(Entry::new(S.into(), P.into(), sample("a", "done", "2026-10-17T10:00:00Z")));
      o
    });
    // The task goes first; the run hits "task not synced" (as when the task's send failed) and is kept.
    let t = FakeTransport::new(vec![Ok(()), Err(super::client::classify(409, r#"{"error":{"code":"task_not_synced"}}"#).unwrap_err())]);
    let r = flush_once(&o, 0, &FakeStore(Some("kgu_tok")), &t);
    assert_eq!(r[S].sent, 1);
    let left = o.lock().unwrap().entries().to_vec();
    assert_eq!(left.len(), 1);
    assert!(left[0].item.is_run() && left[0].attempts == 1);
    let r = flush_once(&o, 60_000, &FakeStore(Some("kgu_tok")), &t);
    assert_eq!(r[S].sent, 1);
    assert_eq!(o.lock().unwrap().len(), 0);
  }

  /// Minimal HTTP/1.1 server on a loopback port: records requests, answers with `statuses`.
  type Seen = Vec<(String, String, String)>;

  fn serve(statuses: Vec<u16>) -> (String, std::thread::JoinHandle<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
      let mut seen = Vec::new();
      for status in statuses {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut request_line = String::new();
        reader.read_line(&mut request_line).unwrap();
        let (mut len, mut auth) = (0usize, String::new());
        loop {
          let mut line = String::new();
          reader.read_line(&mut line).unwrap();
          let line = line.trim_end();
          if line.is_empty() {
            break;
          }
          let (k, v) = line.split_once(':').unwrap();
          match k.to_ascii_lowercase().as_str() {
            "content-length" => len = v.trim().parse().unwrap(),
            "authorization" => auth = v.trim().to_owned(),
            _ => {}
          }
        }
        let mut body = vec![0; len];
        reader.read_exact(&mut body).unwrap();
        seen.push((request_line.trim_end().to_owned(), auth, String::from_utf8(body).unwrap()));
        let payload = if status < 300 { "{}" } else { r#"{"error":{"code":"unavailable","message":"x"}}"# };
        let mut stream = stream;
        write!(
          stream,
          "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
          payload.len()
        )
        .unwrap();
      }
      seen
    });
    (base, handle)
  }

  #[test]
  fn http_transport_against_local_server() {
    let (base, server) = serve(vec![503, 200]);
    let o = Mutex::new({
      let mut o = Outbox::default();
      o.enqueue(Entry::new(base.clone(), P.into(), sample("task-7", "review", "2026-10-17T10:00:00Z")));
      o
    });
    let token = format!("kgu_{}", "a".repeat(43));
    struct Store(String);
    impl TokenStore for Store {
      fn get(&self, _: &str) -> Option<String> {
        Some(self.0.clone())
      }
    }
    let transport = HttpTransport::new().unwrap();
    let r = flush_once(&o, 0, &Store(token.clone()), &transport);
    assert_eq!(r[&base].online, Some(false));
    assert_eq!(o.lock().unwrap().len(), 1);
    let r = flush_once(&o, 1_000, &Store(token.clone()), &transport);
    assert_eq!(r[&base].sent, 1);
    assert_eq!(o.lock().unwrap().len(), 0);

    let seen = server.join().unwrap();
    assert_eq!(seen.len(), 2);
    let (line, auth, body) = &seen[1];
    assert_eq!(line, "PUT /v1/tasks/task-7/sync HTTP/1.1");
    assert_eq!(auth, &format!("Bearer {token}"));
    let body: serde_json::Value = serde_json::from_str(body).unwrap();
    assert_eq!(body["project_id"], P);
    assert_eq!(body["status"], "review");
    assert!(body.get("client_task_id").is_none());
  }

  #[test]
  fn http_transport_sends_runs() {
    let (base, server) = serve(vec![200, 200]);
    let o = Mutex::new({
      let mut o = Outbox::default();
      let mut task = sample("task-7", "done", "2026-10-17T10:00:00Z");
      (task.source, task.external_ref) = (Some("github".into()), Some("acme/app#42".into()));
      o.enqueue(Entry::new(base.clone(), P.into(), sample_run("task-7", "1760691600000", "2026-10-17T10:00:00Z")));
      o.enqueue(Entry::new(base.clone(), P.into(), task));
      o
    });
    let token = format!("kgu_{}", "b".repeat(43));
    struct Store(String);
    impl TokenStore for Store {
      fn get(&self, _: &str) -> Option<String> {
        Some(self.0.clone())
      }
    }
    let r = flush_once(&o, 0, &Store(token), &HttpTransport::new().unwrap());
    assert_eq!(r[&base].sent, 2);
    let seen = server.join().unwrap();
    assert_eq!(seen[0].0, "PUT /v1/tasks/task-7/sync HTTP/1.1", "task before its run");
    let task: serde_json::Value = serde_json::from_str(&seen[0].2).unwrap();
    assert_eq!((task["source"].as_str(), task["external_ref"].as_str()), (Some("github"), Some("acme/app#42")));
    assert_eq!(seen[1].0, "PUT /v1/tasks/task-7/runs/1760691600000/sync HTTP/1.1");
    let run: serde_json::Value = serde_json::from_str(&seen[1].2).unwrap();
    assert_eq!(run["project_id"], P);
    assert_eq!(run["cost_usd"], 0.42);
    assert_eq!(run["output_tokens"], 300);
    assert_eq!(run["exit_reason"], "done");
    assert!(run.get("client_run_id").is_none());
  }
}
