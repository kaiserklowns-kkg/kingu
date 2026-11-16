//! Agent Supervisor: the one registry of agent sessions, chat runs (the sidecar's events) and
//! terminal agents (hook files) alike, and the one event stream the webview subscribes to.
//! MECHANICS.md "Agent Supervisor" holds the design and its rules.
//!
//! - Sessions (`session_protocol::SessionState`) have a stable id (`chat:<root>:<id>`,
//!   `run:<root>:<slug>`, `tui:<pty key>`, `pane:<pty key>`), an owner, a worktree scope and a
//!   binding (run id / PTY key / hook token, with a generation bumped on each new binding).
//! - Every change is a `session_protocol::Action`, numbered by a process-wide `seq` and kept in
//!   a bounded log (`LOG_CAP`). A subscriber gets a snapshot, or, when it names the epoch and
//!   last `seq` it applied and the log still holds everything after it, only the missed frames
//!   (VS Code `ChannelRecoveryKind.Snapshot` / `Replay`,
//!   `src/vs/platform/agentHost/common/state/protocol/common/state.ts`). Then live frames.
//! - Mutations that must not run twice (start / resume / follow-up) go through the operation
//!   ledger (`op_ledger`), keyed by the session's owner.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::State;
use tauri::ipc::Channel;

use super::events::AgentEvent;
use super::op_ledger::{self, Begin, Ledger, Outcome};
use super::session_protocol::{self as proto, Action, Binding, HookCursor, SessionInfo, SessionKind, SessionState};

/// Frames kept for replay. A subscriber further behind gets a snapshot.
pub const LOG_CAP: usize = 4096;
const MAX_SUBSCRIBERS: usize = 64;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Frame {
  pub seq: u64,
  pub at: u64,
  pub action: Action,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Recovery {
  Snapshot,
  Replay,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Subscribed {
  pub subscription: u64,
  /// This process's start (ms): seqs of another epoch mean nothing here.
  pub epoch: u64,
  pub recovery: Recovery,
  /// The seq the snapshot was taken at (live frames follow with `seq > this`).
  pub seq: u64,
  /// The whole registry (`snapshot`), else empty.
  pub sessions: Vec<SessionState>,
  /// The missed frames (`replay`), else empty.
  pub frames: Vec<Frame>,
}

type Sink = Arc<dyn Fn(&Frame) -> bool + Send + Sync>;

#[derive(Default)]
struct Inner {
  seq: u64,
  sessions: BTreeMap<String, SessionState>,
  log: VecDeque<Frame>,
  subscribers: Vec<(u64, Sink)>,
  next_sub: u64,
  cursors: HashMap<String, HookCursor>,
  /// Live run id → session id.
  runs: HashMap<u32, String>,
}

pub struct Supervisor {
  inner: Mutex<Inner>,
  ledger: Mutex<(Ledger, Option<PathBuf>)>,
  epoch: u64,
}

impl Default for Supervisor {
  fn default() -> Self {
    Supervisor { inner: Mutex::default(), ledger: Mutex::default(), epoch: now() }
  }
}

fn now() -> u64 {
  crate::mobile::now_ms()
}

impl Inner {
  fn emit(&mut self, action: Action, at: u64) {
    match &action {
      Action::SessionAdded { session } => {
        self.sessions.insert(session.info.id.clone(), session.clone());
      }
      Action::SessionRemoved { session_id } => {
        self.sessions.remove(session_id);
        self.cursors.remove(session_id);
        self.runs.retain(|_, s| s != session_id);
      }
      a => match self.sessions.get_mut(a.session_id()) {
        Some(s) => proto::apply(s, a, at),
        None => return,
      },
    }
    self.seq += 1;
    let frame = Frame { seq: self.seq, at, action };
    self.subscribers.retain(|(_, sink)| sink(&frame));
    self.log.push_back(frame);
    while self.log.len() > LOG_CAP {
      self.log.pop_front();
    }
  }

  fn emit_all(&mut self, actions: Vec<Action>, at: u64) {
    for a in actions {
      self.emit(a, at);
    }
  }
}

impl Supervisor {
  pub fn epoch(&self) -> u64 {
    self.epoch
  }

  /// Registers `info` once; a known session keeps its state (its info is refreshed silently:
  /// the owner key and scope never change for a given id).
  pub fn ensure(&self, info: SessionInfo) {
    let mut g = self.inner.lock().unwrap();
    if let Some(s) = g.sessions.get_mut(&info.id) {
      s.info.agent = info.agent.or(s.info.agent.take());
      return;
    }
    let at = now();
    g.emit(Action::SessionAdded { session: SessionState::new(info, at) }, at);
  }

  /// A new binding (a new run, a new hook file): a new generation, phase `starting`.
  pub fn bind(&self, id: &str, binding: Binding) {
    let mut g = self.inner.lock().unwrap();
    let Some(generation) = g.sessions.get(id).map(|s| s.generation + 1) else { return };
    if let Some(run) = binding.run_id {
      g.runs.insert(run, id.to_owned());
    }
    g.cursors.remove(id);
    g.emit(Action::SessionBound { session_id: id.to_owned(), binding, generation }, now());
  }

  /// The run id of a session's live run, once `start` returned it.
  pub fn set_run(&self, id: &str, run: u32) {
    let mut g = self.inner.lock().unwrap();
    let Some(mut binding) = g.sessions.get(id).map(|s| s.binding.clone()) else { return };
    binding.run_id = Some(run);
    g.runs.insert(run, id.to_owned());
    g.emit(Action::SessionBindingChanged { session_id: id.to_owned(), binding }, now());
  }

  pub fn session_of_run(&self, run: u32) -> Option<String> {
    self.inner.lock().unwrap().runs.get(&run).cloned()
  }

  pub fn get(&self, id: &str) -> Option<SessionState> {
    self.inner.lock().unwrap().sessions.get(id).cloned()
  }

  /// The user's prompt starts a turn, unless one is open (a steered message joins it).
  /// Returns the turn it opened.
  pub fn prompt(&self, id: &str, text: &str) -> Option<String> {
    let mut g = self.inner.lock().unwrap();
    let s = g.sessions.get(id)?;
    if s.turn.is_some() || s.phase == proto::Phase::Ended {
      return None;
    }
    let turn = proto::next_turn(s);
    let prompt = text.lines().find(|l| !l.trim().is_empty()).map(|l| l.trim().chars().take(200).collect());
    g.emit(Action::TurnStarted { session_id: id.to_owned(), turn_id: turn.clone(), prompt }, now());
    Some(turn)
  }

  /// The turn `prompt` opened did not reach the agent.
  pub fn cancel_turn(&self, id: &str, turn: &str, reason: &str) {
    self.inner.lock().unwrap().emit(Action::TurnCancelled { session_id: id.to_owned(), turn_id: turn.to_owned(), reason: reason.to_owned() }, now());
  }

  /// One sidecar event of the session's run.
  pub fn on_agent_event(&self, id: &str, ev: &AgentEvent) {
    let mut g = self.inner.lock().unwrap();
    let Some(s) = g.sessions.get(id) else { return };
    let actions = proto::from_agent_event(s, ev);
    let at = now();
    g.emit_all(actions, at);
    if matches!(ev, AgentEvent::Exit { .. }) {
      g.runs.retain(|_, s| s != id);
    }
  }

  /// Hook lines of a terminal session; `end` is where they end in its hook file. Lines before
  /// what was already folded are skipped (a reloaded page reads its file again from 0).
  pub fn on_hook_lines(&self, id: &str, events: &[Value]) {
    let mut g = self.inner.lock().unwrap();
    let at = now();
    for ev in events {
      let Some(s) = g.sessions.get(id) else { return };
      let s = s.clone();
      let actions = g.cursors.entry(id.to_owned()).or_default().normalize(&s, ev);
      g.emit_all(actions, at);
    }
  }

  fn ingested(&self, id: &str) -> u64 {
    self.inner.lock().unwrap().cursors.get(id).map_or(0, |c| c.ingested)
  }

  fn set_ingested(&self, id: &str, offset: u64) {
    self.inner.lock().unwrap().cursors.entry(id.to_owned()).or_default().ingested = offset;
  }

  pub fn end(&self, id: &str, reason: &str) {
    let mut g = self.inner.lock().unwrap();
    if g.sessions.get(id).is_some_and(|s| s.phase != proto::Phase::Ended) {
      g.emit(Action::SessionEnded { session_id: id.to_owned(), reason: reason.to_owned() }, now());
    }
  }

  pub fn remove(&self, id: &str) {
    let mut g = self.inner.lock().unwrap();
    if g.sessions.contains_key(id) {
      g.emit(Action::SessionRemoved { session_id: id.to_owned() }, now());
    }
  }

  /// Snapshot or replay, then live frames to `sink` (until it returns false or unsubscribes).
  pub fn subscribe(&self, epoch: Option<u64>, after: Option<u64>, sink: Sink) -> Subscribed {
    let mut g = self.inner.lock().unwrap();
    g.next_sub += 1;
    let id = g.next_sub;
    // Replay needs this epoch, a seq not ahead of ours, and every frame after it still logged.
    let replay = match (epoch, after) {
      (Some(e), Some(n)) if e == self.epoch && n <= g.seq => n == g.seq || g.log.front().is_some_and(|f| f.seq <= n + 1),
      _ => false,
    };
    let out = if replay {
      let after = after.unwrap_or(0);
      Subscribed { subscription: id, epoch: self.epoch, recovery: Recovery::Replay, seq: g.seq, sessions: Vec::new(), frames: g.log.iter().filter(|f| f.seq > after).cloned().collect() }
    } else {
      Subscribed { subscription: id, epoch: self.epoch, recovery: Recovery::Snapshot, seq: g.seq, sessions: g.sessions.values().cloned().collect(), frames: Vec::new() }
    };
    g.subscribers.push((id, sink));
    if g.subscribers.len() > MAX_SUBSCRIBERS {
      g.subscribers.remove(0);
    }
    out
  }

  pub fn unsubscribe(&self, subscription: u64) {
    self.inner.lock().unwrap().subscribers.retain(|(id, _)| *id != subscription);
  }

  pub fn snapshot(&self) -> (u64, Vec<SessionState>) {
    let g = self.inner.lock().unwrap();
    (g.seq, g.sessions.values().cloned().collect())
  }

  // -------------------------------------------------------------------------------------------
  // Operation ledger

  /// Reads the persisted ledger (rows in flight when the app quit stay `unknown`).
  pub fn load_ledger(&self, file: PathBuf) {
    let ledger = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice::<Ledger>(&b).ok()).unwrap_or_default().reconciled(now());
    *self.ledger.lock().unwrap() = (ledger, Some(file));
  }

  fn save(l: &(Ledger, Option<PathBuf>)) {
    let Some(file) = &l.1 else { return };
    let write = || -> std::io::Result<()> {
      if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
      }
      let tmp = file.with_extension("json.tmp");
      std::fs::write(&tmp, serde_json::to_vec(&l.0).unwrap_or_default())?;
      std::fs::rename(&tmp, file)
    };
    if let Err(e) = write() {
      log::warn!("agent operation ledger: {e}");
    }
  }

  /// Claims operation `op` of `caller` for this payload. `Ok(Some(guard))`: run the effect and
  /// settle the guard (dropped unsettled, it records a failure). `Ok(None)`: no operation id,
  /// nothing recorded. `Err`: replayed or refused, run nothing.
  pub fn begin_op(self: &Arc<Self>, op: Option<&str>, caller: &str, scope: &str, payload: &Value) -> Result<Option<OpGuard>, OpRefusal> {
    let Some(op) = op else { return Ok(None) };
    let fp = op_ledger::fingerprint(payload);
    let mut l = self.ledger.lock().unwrap();
    let begun = l.0.begin(caller, op, &fp, scope, now());
    match begun {
      Begin::Run => {
        Self::save(&l);
        Ok(Some(OpGuard { sup: self.clone(), caller: caller.to_owned(), op: op.to_owned(), settled: false }))
      }
      Begin::Replay(outcome) => Err(OpRefusal::Replayed(outcome)),
      Begin::Refused(code) => Err(OpRefusal::Refused(code)),
    }
  }

  fn settle_op(&self, caller: &str, op: &str, outcome: Outcome) {
    let mut l = self.ledger.lock().unwrap();
    l.0.settle(caller, op, outcome);
    Self::save(&l);
  }
}

#[derive(Debug, Clone, PartialEq)]
pub enum OpRefusal {
  Replayed(Outcome),
  Refused(&'static str),
}

impl OpRefusal {
  /// The error a command returns: a code first (the webview matches it), then the reason.
  pub fn message(&self) -> String {
    use crate::i18n::msg::AgentMsg;
    match self {
      OpRefusal::Replayed(Outcome::Failed { message, .. }) => message.clone(),
      OpRefusal::Replayed(_) => format!("agent_session_operation_replayed: {}", crate::tr!(AgentMsg::OperationReplayed)),
      OpRefusal::Refused(code) if *code == op_ledger::CODE_IN_FLIGHT => format!("{code}: {}", crate::tr!(AgentMsg::OperationInFlight)),
      OpRefusal::Refused(code) => format!("{code}: {}", crate::tr!(AgentMsg::OperationRefused)),
    }
  }
}

/// The right to run one operation's effect; settles the ledger row.
pub struct OpGuard {
  sup: Arc<Supervisor>,
  caller: String,
  op: String,
  settled: bool,
}

impl OpGuard {
  pub fn succeed(mut self, value: Value) {
    self.settled = true;
    self.sup.settle_op(&self.caller, &self.op, Outcome::Succeeded { value });
  }

  pub fn fail(mut self, message: &str) {
    self.settled = true;
    self.sup.settle_op(&self.caller, &self.op, Outcome::Failed { code: "failed".into(), message: message.to_owned() });
  }
}

impl Drop for OpGuard {
  fn drop(&mut self) {
    if !self.settled {
      self.sup.settle_op(&self.caller, &self.op, Outcome::Failed { code: "aborted".into(), message: "agent_session_operation_aborted".into() });
    }
  }
}

/// Settles `guard` by `result`.
pub fn settle<T: serde::Serialize>(guard: Option<OpGuard>, result: &Result<T, String>) {
  if let Some(g) = guard {
    match result {
      Ok(v) => g.succeed(serde_json::to_value(v).unwrap_or(Value::Null)),
      Err(e) => g.fail(e),
    }
  }
}

/// Opens a sidecar run's session (registered, bound to a new generation, its prompt's turn
/// started) exactly once: at the run's first event or when `start` returned, whichever is first.
/// Never before the owner check passed, so a refused start leaves a live run's session alone.
pub struct RunOpener {
  sup: Arc<Supervisor>,
  info: SessionInfo,
  prompt: String,
  opened: std::sync::Once,
}

impl RunOpener {
  pub fn new(sup: Arc<Supervisor>, info: SessionInfo, prompt: String) -> Self {
    RunOpener { sup, info, prompt, opened: std::sync::Once::new() }
  }

  fn open(&self) {
    self.opened.call_once(|| {
      self.sup.ensure(self.info.clone());
      self.sup.bind(&self.info.id, Binding::default());
      self.sup.prompt(&self.info.id, &self.prompt);
    });
  }

  pub fn on_event(&self, ev: &AgentEvent) {
    self.open();
    self.sup.on_agent_event(&self.info.id, ev);
  }

  /// `start` returned: the run id, or an error after which no event comes.
  pub fn started(&self, result: &Result<u32, String>) {
    match result {
      Ok(id) => {
        self.open();
        self.sup.set_run(&self.info.id, *id);
      }
      // Events came, so the session opened, but the run is gone: end it like the webview does.
      Err(e) if self.opened.is_completed() => {
        self.sup.on_agent_event(&self.info.id, &AgentEvent::Error { message: e.clone() });
        self.sup.on_agent_event(&self.info.id, &AgentEvent::Exit { code: None, signal: None, stopped: false });
      }
      Err(_) => {}
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Session ids and infos

pub fn chat_session_id(root: &Path, chat: &str) -> String {
  format!("chat:{}:{chat}", root.display())
}

pub fn task_owner(root: &str, slug: &str) -> String {
  format!("task:{root}:{slug}")
}

/// The session of a sidecar run: a chat, an ADE task, or a folder run (`run:<cwd>`).
pub fn run_info(root: &Path, chat: Option<&str>, slug: Option<&str>, cwd: &str, runtime: &str) -> SessionInfo {
  let root_s = root.display().to_string();
  let (id, kind, owner) = match (chat, slug) {
    (Some(c), _) => (chat_session_id(root, c), SessionKind::Chat, chat_session_id(root, c)),
    (None, Some(s)) => (format!("run:{root_s}:{s}"), SessionKind::Run, task_owner(&root_s, s)),
    (None, None) => (format!("run:{cwd}"), SessionKind::Run, format!("folder:{cwd}")),
  };
  SessionInfo {
    id,
    kind,
    owner,
    root: Some(root_s),
    slug: slug.map(str::to_owned),
    worktree: Some(cwd.to_owned()),
    scope: op_ledger::scope_digest(cwd),
    agent: Some(runtime.to_owned()),
  }
}

/// A terminal session the webview reads hooks for.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TuiSession {
  /// `tui` (the CLI Kingu launched) or `pane` (any task pane).
  pub kind: String,
  /// The PTY key.
  pub key: String,
  /// The launched CLI's hook token (`tui` only; a pane's comes from its key).
  #[serde(default)]
  pub token: Option<String>,
  #[serde(default)]
  pub root: Option<String>,
  #[serde(default)]
  pub slug: Option<String>,
  #[serde(default)]
  pub agent: Option<String>,
}

impl TuiSession {
  fn validate(&self) -> Result<SessionKind, String> {
    crate::pty::validate_key(&self.key)?;
    if let Some(t) = &self.token
      && !super::hooks::valid_token(t)
    {
      return Err("invalid hook token".into());
    }
    match self.kind.as_str() {
      "tui" if self.token.is_some() => Ok(SessionKind::Tui),
      "pane" => Ok(SessionKind::Pane),
      _ => Err("invalid agent session kind".into()),
    }
  }

  pub fn id(&self) -> String {
    format!("{}:{}", self.kind, self.key)
  }

  fn info(&self, kind: SessionKind) -> SessionInfo {
    let slug = self.slug.clone().filter(|s| super::worktree::validate_slug(s).is_ok());
    let worktree = match (&self.root, &slug) {
      (Some(r), Some(s)) => Some(super::worktree::worktree_path(Path::new(r), s).display().to_string()),
      _ => None,
    };
    let owner = match (&self.root, &slug) {
      (Some(r), Some(s)) => task_owner(r, s),
      _ => self.id(),
    };
    SessionInfo {
      id: self.id(),
      kind,
      owner,
      root: self.root.clone(),
      slug,
      scope: op_ledger::scope_digest(worktree.as_deref().unwrap_or(&self.key)),
      worktree,
      agent: self.agent.clone(),
    }
  }

  fn hook_token(&self) -> String {
    self.token.clone().unwrap_or_else(|| super::hooks::pane_token(&self.key))
  }
}

/// Reads a terminal session's hook file from `offset` exactly as `agent_hook_read` /
/// `agent_pane_hook_read` do (the webview's own fold, agentHooks.ts, is unchanged), and folds
/// the lines the supervisor has not seen yet into the session.
pub fn read_hooks(sup: &Supervisor, file: &Path, bind: &TuiSession, kind: SessionKind, offset: u64) -> Result<super::hooks::HookRead, String> {
  let id = bind.id();
  let token = bind.hook_token();
  let known = sup.get(&id);
  if known.is_none() {
    sup.ensure(bind.info(kind));
  }
  if known.as_ref().is_none_or(|s| s.binding.hook_token.as_deref() != Some(&token)) {
    sup.bind(&id, Binding { run_id: None, pty_key: Some(bind.key.clone()), hook_token: Some(token) });
  }
  let out = super::hooks::read_from(file, offset)?;
  let mut start = sup.ingested(&id);
  // The file was replaced (a new CLI with the same token): fold it from the start.
  if std::fs::metadata(file).map_or(0, |m| m.len()) < start {
    start = 0;
    sup.set_ingested(&id, 0);
  }
  if out.offset > start {
    let (events, end) = if start == offset {
      (out.events.clone(), out.offset)
    } else {
      let rest = super::hooks::read_from(file, start)?;
      (rest.events, rest.offset)
    };
    sup.on_hook_lines(&id, &events);
    sup.set_ingested(&id, end.max(start));
  }
  Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Commands

/// Subscribes the webview: snapshot or replay now (see `Subscribed`), live frames on `on_frame`.
#[tauri::command]
pub fn agent_supervisor_subscribe(sup: State<'_, Arc<Supervisor>>, epoch: Option<u64>, after: Option<u64>, on_frame: Channel<Frame>) -> Subscribed {
  sup.subscribe(epoch, after, Arc::new(move |f: &Frame| on_frame.send(f.clone()).is_ok()))
}

#[tauri::command]
pub fn agent_supervisor_unsubscribe(sup: State<'_, Arc<Supervisor>>, subscription: u64) {
  sup.unsubscribe(subscription);
}

/// New hook events of a terminal session (in place of `agent_hook_read` / `agent_pane_hook_read`).
#[tauri::command]
pub fn agent_session_hooks(app: tauri::AppHandle, sup: State<'_, Arc<Supervisor>>, session: TuiSession, offset: u64) -> Result<super::hooks::HookRead, String> {
  let kind = session.validate()?;
  let file = super::hooks::file_of(&app, &session.hook_token())?;
  read_hooks(&sup, &file, &session, kind, offset)
}

/// A terminal session's CLI is gone (`process_exit`, `session_end`) or, with `remove`, the
/// session itself (its terminal closed).
#[tauri::command]
pub fn agent_session_end(sup: State<'_, Arc<Supervisor>>, session: String, reason: String, remove: Option<bool>) -> Result<(), String> {
  if !(session.starts_with("tui:") || session.starts_with("pane:")) || session.len() > 4096 {
    return Err("invalid agent session".into());
  }
  if remove == Some(true) {
    sup.remove(&session);
  } else {
    sup.end(&session, &reason.chars().take(64).collect::<String>());
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn info(id: &str) -> SessionInfo {
    SessionInfo { id: id.into(), kind: SessionKind::Chat, owner: id.into(), root: None, slug: None, worktree: Some("/w".into()), scope: op_ledger::scope_digest("/w"), agent: None }
  }

  fn collect() -> (Sink, Arc<Mutex<Vec<Frame>>>) {
    let got: Arc<Mutex<Vec<Frame>>> = Arc::default();
    let g = got.clone();
    (Arc::new(move |f: &Frame| {
      g.lock().unwrap().push(f.clone());
      true
    }), got)
  }

  #[test]
  fn a_run_streams_and_subscribers_replay_or_snapshot() {
    let sup = Supervisor::default();
    let first = sup.subscribe(None, None, Arc::new(|_: &Frame| true));
    assert_eq!((first.recovery, first.seq), (Recovery::Snapshot, 0));
    let (sink, live) = collect();
    sup.subscribe(Some(sup.epoch()), Some(0), sink);
    sup.ensure(info("chat:/r:c1"));
    sup.bind("chat:/r:c1", Binding::default());
    let turn = sup.prompt("chat:/r:c1", "hello\nworld").unwrap();
    sup.set_run("chat:/r:c1", 4);
    assert_eq!(sup.session_of_run(4).as_deref(), Some("chat:/r:c1"));
    for ev in [json!({"kind": "permission_request", "request_id": "r1", "tool": "Bash", "input_summary": "ls"})] {
      sup.on_agent_event("chat:/r:c1", &AgentEvent::from_host(ev));
    }
    let s = sup.get("chat:/r:c1").unwrap();
    assert_eq!((s.phase, s.turn.as_deref(), s.binding.run_id), (proto::Phase::Waiting, Some(turn.as_str()), Some(4)));
    let frames = live.lock().unwrap().clone();
    assert_eq!(frames.iter().map(|f| f.seq).collect::<Vec<_>>(), (1..=frames.len() as u64).collect::<Vec<_>>());
    // Resubscribing from seq 2 replays exactly what came after it.
    let again = sup.subscribe(Some(sup.epoch()), Some(2), Arc::new(|_: &Frame| true));
    assert_eq!(again.recovery, Recovery::Replay);
    assert_eq!(again.frames, frames[2..].to_vec());
    // Another epoch (an app restart) or a seq from the future: a snapshot.
    for (e, n) in [(Some(sup.epoch() + 1), Some(1)), (Some(sup.epoch()), Some(999))] {
      let s = sup.subscribe(e, n, Arc::new(|_: &Frame| true));
      assert_eq!((s.recovery, s.sessions.len()), (Recovery::Snapshot, 1));
    }
    sup.on_agent_event("chat:/r:c1", &AgentEvent::Exit { code: Some(0), signal: None, stopped: false });
    assert_eq!(sup.session_of_run(4), None);
    assert!(sup.get("chat:/r:c1").unwrap().pending.is_empty());
  }

  #[test]
  fn a_subscriber_too_far_behind_gets_a_snapshot() {
    let sup = Supervisor::default();
    sup.ensure(info("s"));
    for _ in 0..(LOG_CAP + 5) {
      sup.on_agent_event("s", &AgentEvent::ContextUsage { used_tokens: 1, max_tokens: 2 });
    }
    let s = sup.subscribe(Some(sup.epoch()), Some(1), Arc::new(|_: &Frame| true));
    assert_eq!(s.recovery, Recovery::Snapshot);
    let s = sup.subscribe(Some(sup.epoch()), Some(s.seq - 3), Arc::new(|_: &Frame| true));
    assert_eq!((s.recovery, s.frames.len()), (Recovery::Replay, 3));
  }

  #[test]
  fn dead_subscribers_are_dropped() {
    let sup = Supervisor::default();
    let sub = sup.subscribe(None, None, Arc::new(|_: &Frame| false));
    sup.ensure(info("s"));
    assert!(sup.inner.lock().unwrap().subscribers.is_empty());
    sup.unsubscribe(sub.subscription);
  }

  #[test]
  fn hook_files_are_folded_once_even_when_read_again() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("t.jsonl");
    let sup = Supervisor::default();
    let bind = TuiSession { kind: "tui".into(), key: "cli-x".into(), token: Some("tok".into()), root: Some("/r".into()), slug: Some("a".into()), agent: Some("claude".into()) };
    std::fs::write(&file, "{\"hook_event_name\":\"UserPromptSubmit\",\"prompt\":\"go\"}\n").unwrap();
    let r = read_hooks(&sup, &file, &bind, SessionKind::Tui, 0).unwrap();
    assert_eq!(r.events.len(), 1);
    let id = bind.id();
    let s = sup.get(&id).unwrap();
    assert_eq!((s.phase, s.turns, s.info.owner.as_str(), s.generation), (proto::Phase::Working, 1, "task:/r:a", 1));
    // A reloaded page reads from 0 again: the webview gets every line, the session folds none twice.
    let r = read_hooks(&sup, &file, &bind, SessionKind::Tui, 0).unwrap();
    assert_eq!(r.events.len(), 1);
    assert_eq!(sup.get(&id).unwrap().turns, 1);
    let mut f = std::fs::OpenOptions::new().append(true).open(&file).unwrap();
    std::io::Write::write_all(&mut f, b"{\"hook_event_name\":\"Stop\"}\n").unwrap();
    // The page (still at 0) and the supervisor (past line 1) each get what they lack.
    let r = read_hooks(&sup, &file, &bind, SessionKind::Tui, 0).unwrap();
    assert_eq!(r.events.len(), 2);
    assert_eq!(sup.get(&id).unwrap().phase, proto::Phase::Idle);
    // Replaced by a shorter file: folded from the start again.
    std::fs::write(&file, "{\"hook_event_name\":\"SessionEnd\"}\n").unwrap();
    read_hooks(&sup, &file, &bind, SessionKind::Tui, r.offset).unwrap();
    read_hooks(&sup, &file, &bind, SessionKind::Tui, 0).unwrap();
    assert_eq!(sup.get(&id).unwrap().phase, proto::Phase::Ended);
    sup.remove(&id);
    assert!(sup.get(&id).is_none());
  }

  #[test]
  fn operations_run_once() {
    let sup = Arc::new(Supervisor::default());
    let dir = tempfile::tempdir().unwrap();
    sup.load_ledger(dir.path().join("ledger.json"));
    let op = op_ledger::new_operation_id(now());
    let payload = json!({"method": "agent_start", "prompt": "hi"});
    assert!(sup.begin_op(None, "chat:x", "s", &payload).unwrap().is_none());
    let guard = sup.begin_op(Some(&op), "chat:x", "s", &payload).unwrap().unwrap();
    // A duplicate while the first runs: refused, nothing runs.
    assert_eq!(sup.begin_op(Some(&op), "chat:x", "s", &payload).err(), Some(OpRefusal::Refused(op_ledger::CODE_IN_FLIGHT)));
    settle(Some(guard), &Ok::<u32, String>(9));
    assert_eq!(sup.begin_op(Some(&op), "chat:x", "s", &payload).err(), Some(OpRefusal::Replayed(Outcome::Succeeded { value: json!(9) })));
    // The same id with another payload is a conflict.
    assert_eq!(sup.begin_op(Some(&op), "chat:x", "s", &json!({"prompt": "other"})).err(), Some(OpRefusal::Refused(op_ledger::CODE_CONFLICT)));
    // Persisted: a restarted app still knows it ran.
    let again = Arc::new(Supervisor::default());
    again.load_ledger(dir.path().join("ledger.json"));
    assert!(matches!(again.begin_op(Some(&op), "chat:x", "s", &payload), Err(OpRefusal::Replayed(_))));
    // Dropped without settling (an early `?`): recorded as failed, not left in flight.
    let op2 = op_ledger::new_operation_id(now());
    drop(sup.begin_op(Some(&op2), "chat:x", "s", &payload).unwrap());
    assert!(matches!(sup.begin_op(Some(&op2), "chat:x", "s", &payload), Err(OpRefusal::Replayed(Outcome::Failed { .. }))));
  }
}
