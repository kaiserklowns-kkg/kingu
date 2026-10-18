//! AI Vault (old Kingu's `kinguVault*`): the sessions other coding agents left on this machine —
//! Claude Code, Codex, Gemini CLI, OpenCode and Cursor CLI — listed by project, agent and date,
//! searched as full text, opened read-only, and priced (`stats`). Read only: nothing is written
//! to another tool's folder, and nothing is sent anywhere.
//!
//! Where each agent keeps them (`Roots`): `~/.claude/projects/<encoded cwd>/<id>.jsonl`
//! (`CLAUDE_CONFIG_DIR`), `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`CODEX_HOME`),
//! `~/.gemini/tmp/<project>/chats/session-*.json`, `~/.local/share/opencode/storage/session/<project>/<id>.json`
//! (`XDG_DATA_HOME`) and `~/.cursor/projects/<project>/agent-transcripts/<id>.jsonl`. OpenCode's
//! newer SQLite database and Cursor's chat stores are not read.
//!
//! Every read is bounded: a list row reads a file's first and last `EDGE_BYTES`; usage, search
//! and the transcript stream the file a line at a time (`read::each_line`), and JSON documents
//! over `read::MAX_DOCUMENT` are skipped. Results are cached per file by size and mtime.

pub mod pricing;
pub mod read;
mod stats;

use std::collections::HashMap;
use std::ops::ControlFlow;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::workspace::Workspace;
use read::{Item, Role};
pub use stats::Stats;

/// A list row reads this much of the start and of the end of a JSON Lines transcript.
const EDGE_BYTES: u64 = 256 * 1024;
/// The newest this many sessions per agent are listed.
const MAX_PER_AGENT: usize = 3000;
/// Directory entries one discovery walk looks at, at most.
const MAX_WALK: usize = 200_000;
/// A transcript shows its last this many turns.
const MAX_TURNS: usize = 2000;
/// A search reads at most this much in all, and this much of one file.
const SEARCH_BUDGET: u64 = 2 * 1024 * 1024 * 1024;
const SEARCH_FILE_BUDGET: u64 = 256 * 1024 * 1024;
const MAX_HITS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
  Claude,
  Codex,
  Gemini,
  OpenCode,
  Cursor,
}

impl Agent {
  pub const ALL: [Agent; 5] = [Agent::Claude, Agent::Codex, Agent::Gemini, Agent::OpenCode, Agent::Cursor];

  /// The agent's own command to continue session `id` (`None` for an id that is not one).
  pub fn resume(self, id: &str) -> Option<Vec<String>> {
    if id.is_empty() || id.len() > 128 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
      return None;
    }
    let argv: &[&str] = match self {
      Agent::Claude => &["claude", "--resume"],
      Agent::Codex => &["codex", "resume"],
      Agent::Gemini => &["gemini", "--resume"],
      Agent::OpenCode => &["opencode", "--session"],
      Agent::Cursor => &["cursor-agent", "--resume"],
    };
    Some(argv.iter().map(|s| s.to_string()).chain([id.to_owned()]).collect())
  }

  /// One JSON document per session rather than JSON Lines.
  fn document(self, path: &Path) -> bool {
    match self {
      Agent::OpenCode => true,
      Agent::Gemini => path.extension().and_then(|e| e.to_str()) == Some("json"),
      _ => false,
    }
  }
}

/// Each agent's session folder.
#[derive(Debug, Clone)]
pub struct Roots {
  claude: PathBuf,
  codex: PathBuf,
  gemini: PathBuf,
  opencode: PathBuf,
  cursor: PathBuf,
}

impl Roots {
  /// The defaults under `home`, moved by the variables the agents themselves honour.
  pub fn new(home: &Path, env: impl Fn(&str) -> Option<String>) -> Self {
    let var = |k: &str| env(k).filter(|v| !v.trim().is_empty()).map(PathBuf::from);
    Self {
      claude: var("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude")).join("projects"),
      codex: var("CODEX_HOME").unwrap_or_else(|| home.join(".codex")).join("sessions"),
      gemini: home.join(".gemini").join("tmp"),
      opencode: var("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local").join("share")).join("opencode").join("storage").join("session"),
      cursor: home.join(".cursor").join("projects"),
    }
  }

  pub fn from_env() -> Result<Self, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("no home folder")?;
    Ok(Self::new(&home, |k| std::env::var(k).ok()))
  }

  fn of(&self, a: Agent) -> &Path {
    match a {
      Agent::Claude => &self.claude,
      Agent::Codex => &self.codex,
      Agent::Gemini => &self.gemini,
      Agent::OpenCode => &self.opencode,
      Agent::Cursor => &self.cursor,
    }
  }
}

/// How deep below its root an agent's session files sit, at most.
fn max_depth(a: Agent) -> usize {
  match a {
    Agent::Claude | Agent::OpenCode => 1,
    Agent::Gemini => 2,
    Agent::Codex | Agent::Cursor => 3,
  }
}

/// Whether a directory at `depth` (0: a child of the root) can hold sessions.
fn enter(a: Agent, name: &str, depth: usize) -> bool {
  match a {
    // Claude Code keeps task sub-agents' transcripts in `<session>/subagents/`: not resumable.
    Agent::Claude => depth == 0,
    Agent::Gemini => depth == 0 || (depth == 1 && name == "chats"),
    Agent::Cursor => depth == 0 || (depth == 1 && name == "agent-transcripts") || depth == 2,
    Agent::Codex => name.bytes().all(|b| b.is_ascii_digit()),
    Agent::OpenCode => depth == 0,
  }
}

/// Whether a file at `segs` (relative to the agent's root) is one of its sessions. Discovery and
/// every command that takes a path ask the same question, so no other file can be read.
pub fn discoverable(a: Agent, segs: &[&str]) -> bool {
  let Some((name, dirs)) = segs.split_last() else { return false };
  if dirs.len() > max_depth(a) || dirs.iter().any(|d| d.is_empty() || *d == "." || *d == "..") || !dirs.iter().enumerate().all(|(i, d)| enter(a, d, i)) {
    return false;
  }
  match a {
    Agent::Claude => dirs.len() == 1 && name.ends_with(".jsonl") && !name.starts_with("agent-"),
    Agent::Codex => name.starts_with("rollout-") && name.ends_with(".jsonl"),
    Agent::Gemini => dirs.len() == 2 && name.starts_with("session-") && (name.ends_with(".json") || name.ends_with(".jsonl")),
    Agent::OpenCode => dirs.len() == 1 && name.ends_with(".json"),
    Agent::Cursor => dirs.len() >= 2 && name.ends_with(".jsonl"),
  }
}

/// A file found by discovery: path, size, mtime (Unix ms).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Found {
  path: PathBuf,
  len: u64,
  mtime: i64,
}

fn mtime_ms(m: &std::fs::Metadata) -> i64 {
  m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64)
}

/// The sessions of `a` under its root, newest first (symlinks are not followed).
fn discover(roots: &Roots, a: Agent) -> Vec<Found> {
  let root = roots.of(a);
  let mut out = Vec::new();
  let mut stack: Vec<(PathBuf, Vec<String>)> = vec![(root.to_path_buf(), Vec::new())];
  let mut seen = 0usize;
  while let Some((dir, segs)) = stack.pop() {
    for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
      seen += 1;
      if seen > MAX_WALK {
        break;
      }
      let Ok(ft) = e.file_type() else { continue };
      let name = e.file_name().to_string_lossy().into_owned();
      if ft.is_dir() {
        if segs.len() < max_depth(a) && enter(a, &name, segs.len()) {
          let mut next = segs.clone();
          next.push(name);
          stack.push((e.path(), next));
        }
      } else if ft.is_file() {
        let rel: Vec<&str> = segs.iter().map(String::as_str).chain([name.as_str()]).collect();
        if discoverable(a, &rel)
          && let Ok(m) = e.metadata()
        {
          out.push(Found { path: e.path(), len: m.len(), mtime: mtime_ms(&m) });
        }
      }
    }
  }
  out.sort_by_key(|f| std::cmp::Reverse(f.mtime));
  out.truncate(MAX_PER_AGENT);
  out
}

/// `path` if it is a session file of `a` (inside its root, discoverable, a plain file).
pub fn locate(roots: &Roots, a: Agent, path: &str) -> Result<PathBuf, String> {
  let p = PathBuf::from(path);
  let plain = p.is_absolute() && p.components().all(|c| matches!(c, Component::RootDir | Component::Prefix(_) | Component::Normal(_)));
  let refused = || crate::tr!(crate::i18n::msg::CoreMsg::VaultNotASession);
  if !plain || std::fs::symlink_metadata(&p).map_or(true, |m| !m.is_file()) {
    return Err(refused());
  }
  let root = roots.of(a).canonicalize().map_err(|_| refused())?;
  let real = p.canonicalize().map_err(|_| refused())?;
  let rel = real.strip_prefix(&root).map_err(|_| refused())?;
  let segs: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
  let segs: Vec<&str> = segs.iter().map(String::as_str).collect();
  if !discoverable(a, &segs) {
    return Err(refused());
  }
  Ok(real)
}

/// One past session, as a list row.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSession {
  pub agent: Agent,
  /// The agent's session id (what its resume command takes), else the file name.
  pub id: String,
  pub path: String,
  pub title: String,
  /// The latest message, shortened.
  pub preview: Option<String>,
  pub cwd: Option<String>,
  pub cwd_exists: bool,
  pub branch: Option<String>,
  pub model: Option<String>,
  /// Unix ms.
  pub created: i64,
  pub updated: i64,
  pub size: u64,
  /// The agent's command to continue it, when the session has an id it takes.
  pub resume: Option<Vec<String>>,
}

fn short(s: &str, n: usize) -> String {
  read::cut(&s.split_whitespace().collect::<Vec<_>>().join(" "), n)
}

/// Folds items into a list row.
#[derive(Default)]
struct Summary {
  id: Option<String>,
  title: Option<String>,
  prompt: Option<String>,
  injected: Option<String>,
  last: Option<(Role, String)>,
  cwd: Option<String>,
  branch: Option<String>,
  model: Option<String>,
  first: Option<i64>,
  latest: Option<i64>,
}

impl Summary {
  fn seen(&mut self, t: Option<i64>) {
    if let Some(t) = t.filter(|t| *t > 0) {
      self.first = Some(self.first.map_or(t, |f| f.min(t)));
      self.latest = Some(self.latest.map_or(t, |l| l.max(t)));
    }
  }

  fn take(&mut self, item: Item) {
    match item {
      Item::At(t) => self.seen(Some(t)),
      Item::Usage { at, .. } => self.seen(at),
      Item::Meta(m) => {
        self.id = self.id.take().or(m.id);
        self.cwd = self.cwd.take().or(m.cwd);
        self.branch = self.branch.take().or(m.branch);
        // The last title and model win: a renamed session, a model switched mid-session.
        self.title = m.title.or(self.title.take());
        self.model = m.model.or(self.model.take());
      }
      Item::Turn { role, text, at, typed } => {
        self.seen(at);
        if role == Role::User && !typed {
          self.injected.get_or_insert(text);
          return;
        }
        if role == Role::User && self.prompt.is_none() {
          self.prompt = Some(text.clone());
        }
        if role != Role::Tool {
          self.last = Some((role, text));
        }
      }
    }
  }

  fn session(self, a: Agent, f: &Found) -> VaultSession {
    let stem = f.path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    // Codex names its files `rollout-<time>-<uuid>`: the uuid is the session id.
    let from_name = match a {
      Agent::Codex => stem.get(stem.len().saturating_sub(36)..).filter(|t| t.len() == 36 && t.matches('-').count() == 4).map(str::to_owned),
      Agent::Gemini => None,
      _ => Some(stem.clone()),
    };
    let id = self.id.or(from_name);
    let title = self.title.or(self.prompt).or(self.injected).map(|t| short(&t, 120)).unwrap_or_else(|| stem.clone());
    let preview = self.last.map(|(r, t)| short(&format!("{}{t}", if r == Role::Assistant { "› " } else { "" }), 240));
    let cwd_exists = self.cwd.as_deref().is_some_and(|c| Path::new(c).is_absolute() && Path::new(c).is_dir());
    let updated = self.latest.unwrap_or(f.mtime).max(self.first.unwrap_or(0));
    VaultSession {
      agent: a,
      resume: id.as_deref().and_then(|i| a.resume(i)),
      id: id.unwrap_or(stem),
      path: f.path.display().to_string(),
      title,
      preview,
      cwd: self.cwd,
      cwd_exists,
      branch: self.branch,
      model: self.model,
      created: self.first.unwrap_or(f.mtime),
      updated,
      size: f.len,
    }
  }
}

/// Calls `f` with every item of a JSON Lines file, from `from` for at most `max` bytes; lines
/// that `keep` rejects (raw text) are not parsed.
fn jsonl_items(a: Agent, path: &Path, from: u64, max: u64, keep: &dyn Fn(&str) -> bool, f: &mut dyn FnMut(Item) -> ControlFlow<()>) -> u64 {
  let mut st = read::LineState::default();
  let mut buf = Vec::new();
  read::each_line(path, from, max, |line| {
    if !line.trim_start().starts_with('{') || !keep(line) {
      return ControlFlow::Continue(());
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else { return ControlFlow::Continue(()) };
    read::line_items(a, &v, &mut st, &mut buf);
    for item in buf.drain(..) {
      f(item)?;
    }
    ControlFlow::Continue(())
  })
  .unwrap_or(0)
}

/// Every item of a session, whatever its format (`with_text`: OpenCode also reads message text).
fn all_items(a: Agent, path: &Path, keep: &dyn Fn(&str) -> bool, with_text: bool, f: &mut dyn FnMut(Item) -> ControlFlow<()>) -> u64 {
  if a.document(path) {
    let items = if a == Agent::OpenCode { read::opencode_items(path, with_text) } else { read::gemini_document(path) };
    for item in items.unwrap_or_default() {
      if f(item).is_break() {
        break;
      }
    }
    return std::fs::metadata(path).map_or(0, |m| m.len());
  }
  jsonl_items(a, path, 0, u64::MAX, keep, f)
}

fn any_line(_: &str) -> bool {
  true
}
const ANY: &dyn Fn(&str) -> bool = &any_line;

/// The lines that can carry usage (or a Codex model switch): only these are parsed for stats.
fn claude_usage_line(l: &str) -> bool {
  l.contains("\"usage\"")
}
fn codex_usage_line(l: &str) -> bool {
  l.contains("token_count") || l.contains("turn_context")
}

fn summarize(a: Agent, f: &Found) -> VaultSession {
  let mut s = Summary::default();
  let mut take = |item| {
    s.take(item);
    ControlFlow::Continue(())
  };
  if a.document(&f.path) {
    all_items(a, &f.path, ANY, true, &mut take);
  } else {
    jsonl_items(a, &f.path, 0, EDGE_BYTES, ANY, &mut take);
    if f.len > EDGE_BYTES {
      jsonl_items(a, &f.path, f.len.saturating_sub(EDGE_BYTES).max(EDGE_BYTES), EDGE_BYTES, ANY, &mut take);
    }
  }
  let mut session = s.session(a, f);
  if a == Agent::Gemini && session.cwd.is_none() {
    // Newer Gemini CLIs leave the project's path next to its chats.
    let marker = f.path.parent().and_then(Path::parent).map(|d| d.join(".project_root"));
    if let Some(text) = marker.filter(|m| m.metadata().is_ok_and(|x| x.len() < 4096)).and_then(|m| std::fs::read_to_string(m).ok()) {
      let cwd = text.trim().to_owned();
      session.cwd_exists = Path::new(&cwd).is_dir();
      session.cwd = Some(cwd).filter(|c| !c.is_empty());
    }
  }
  session
}

/// Gemini names a project's folder after the SHA-256 of its path: sessions with no recorded
/// cwd get the known folder (the open one, another agent's session's) whose hash it is.
fn attribute_gemini(sessions: &mut [VaultSession], extra: Option<&Path>) {
  let mut known: HashMap<String, String> = HashMap::new();
  for cwd in sessions.iter().filter_map(|s| s.cwd.clone()).chain(extra.map(|p| p.display().to_string())) {
    known.entry(format!("{:x}", Sha256::digest(cwd.as_bytes()))).or_insert(cwd);
  }
  for s in sessions.iter_mut().filter(|s| s.agent == Agent::Gemini && s.cwd.is_none()) {
    let hash = Path::new(&s.path).parent().and_then(Path::parent).and_then(Path::file_name).map(|n| n.to_string_lossy().into_owned());
    if let Some(cwd) = hash.and_then(|h| known.get(&h)) {
      s.cwd_exists = Path::new(cwd).is_dir();
      s.cwd = Some(cwd.clone());
    }
  }
}

/// A file's identity for the cache (OpenCode: its messages folder changes too).
fn stamp(a: Agent, f: &Found) -> (u64, i64, i64) {
  let extra = match a {
    Agent::OpenCode => read::opencode_storage(&f.path)
      .and_then(|s| f.path.file_stem().map(|id| s.join("message").join(id)))
      .and_then(|d| std::fs::metadata(d).ok())
      .map_or(0, |m| mtime_ms(&m)),
    _ => 0,
  };
  (f.len, f.mtime, extra)
}

struct Cached {
  stamp: (u64, i64, i64),
  session: VaultSession,
  usage: Option<Arc<Vec<stats::Bucket>>>,
}

/// The cache of list rows and usage, and the search in progress.
#[derive(Default)]
pub struct Vault {
  cache: Mutex<HashMap<PathBuf, Cached>>,
  search: AtomicU64,
}

impl Vault {
  /// Every session of `agents` (all with `None`), newest first.
  pub fn list(&self, roots: &Roots, agents: Option<&[Agent]>, open: Option<&Path>) -> Vec<VaultSession> {
    let mut rows = Vec::new();
    let mut live = std::collections::HashSet::new();
    for a in Agent::ALL.into_iter().filter(|a| agents.is_none_or(|x| x.contains(a))) {
      for f in discover(roots, a) {
        let st = stamp(a, &f);
        live.insert(f.path.clone());
        let hit = self.cache.lock().unwrap().get(&f.path).filter(|c| c.stamp == st).map(|c| c.session.clone());
        let session = hit.unwrap_or_else(|| {
          let s = summarize(a, &f);
          self.cache.lock().unwrap().insert(f.path.clone(), Cached { stamp: st, session: s.clone(), usage: None });
          s
        });
        rows.push(session);
      }
    }
    if agents.is_none() {
      self.cache.lock().unwrap().retain(|p, _| live.contains(p));
    }
    attribute_gemini(&mut rows, open);
    rows.sort_by_key(|s| std::cmp::Reverse(s.updated));
    rows
  }

  /// What a session spent, in 15-minute buckets per model (cached with its row).
  fn usage(&self, s: &VaultSession) -> Arc<Vec<stats::Bucket>> {
    let path = PathBuf::from(&s.path);
    if let Some(u) = self.cache.lock().unwrap().get(&path).and_then(|c| c.usage.clone()) {
      return u;
    }
    let mut acc = stats::Buckets::default();
    let keep: &dyn Fn(&str) -> bool = match s.agent {
      Agent::Claude => &claude_usage_line,
      Agent::Codex => &codex_usage_line,
      _ => ANY,
    };
    all_items(s.agent, &path, keep, false, &mut |item| {
      if let Item::Usage { at, model, tokens } = item {
        acc.add(at.unwrap_or(s.updated), model.or_else(|| s.model.clone()), &tokens);
      }
      ControlFlow::Continue(())
    });
    let usage = Arc::new(acc.into_vec());
    if let Some(c) = self.cache.lock().unwrap().get_mut(&path) {
      c.usage = Some(usage.clone());
    }
    usage
  }

  /// Full-text search of the sessions in `rows`, newest first, within the read budget. A newer
  /// search stops this one.
  pub fn search(&self, rows: &[VaultSession], query: &str, limit: usize) -> SearchOutcome {
    let mine = self.search.fetch_add(1, Ordering::SeqCst) + 1;
    let needle = query.trim().to_lowercase();
    let mut out = SearchOutcome { hits: Vec::new(), searched: 0, total: rows.len(), stopped: Stop::Complete };
    if needle.is_empty() {
      return out;
    }
    let mut spent = 0u64;
    for s in rows {
      if self.search.load(Ordering::SeqCst) != mine {
        out.stopped = Stop::Cancelled;
        break;
      }
      if out.hits.len() >= limit {
        out.stopped = Stop::Limit;
        break;
      }
      if spent >= SEARCH_BUDGET {
        out.stopped = Stop::Budget;
        break;
      }
      out.searched += 1;
      if let Some(e) = read::excerpt(&s.title, &needle).or_else(|| s.cwd.as_deref().and_then(|c| read::excerpt(c, &needle))) {
        out.hits.push(Hit { path: s.path.clone(), excerpt: e });
        continue;
      }
      let path = Path::new(&s.path);
      let mut found = None;
      let mut take = |item: Item| {
        if let Some(e) = read::item_text(&item).and_then(|t| read::excerpt(t, &needle)) {
          found = Some(e);
          return ControlFlow::Break(());
        }
        ControlFlow::Continue(())
      };
      let keep = |l: &str| l.to_lowercase().contains(&needle);
      spent += if s.agent.document(path) { all_items(s.agent, path, ANY, true, &mut take) } else { jsonl_items(s.agent, path, 0, SEARCH_FILE_BUDGET.min(SEARCH_BUDGET - spent), &keep, &mut take) };
      if let Some(excerpt) = found {
        out.hits.push(Hit { path: s.path.clone(), excerpt });
      }
    }
    out
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stop {
  Complete,
  Limit,
  Budget,
  Cancelled,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Hit {
  pub path: String,
  pub excerpt: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SearchOutcome {
  pub hits: Vec<Hit>,
  /// Sessions read before it stopped, out of `total`.
  pub searched: usize,
  pub total: usize,
  pub stopped: Stop,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Turn {
  pub role: Role,
  pub text: String,
  pub at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Transcript {
  pub turns: Vec<Turn>,
  /// Earlier turns were left out (`MAX_TURNS`).
  pub truncated: bool,
}

/// The conversation of one session, read-only: its last `MAX_TURNS` turns (injected context left
/// out, each turn cut to `read::MAX_TURN_CHARS`).
pub fn transcript(a: Agent, path: &Path) -> Transcript {
  let mut turns = std::collections::VecDeque::new();
  let mut truncated = false;
  all_items(a, path, ANY, true, &mut |item| {
    if let Item::Turn { role, text, at, typed: true } = item {
      if turns.len() == MAX_TURNS {
        turns.pop_front();
        truncated = true;
      }
      turns.push_back(Turn { role, text: read::cut(&text, read::MAX_TURN_CHARS), at });
    }
    ControlFlow::Continue(())
  });
  Transcript { turns: turns.into(), truncated }
}

// ---------------------------------------------------------------------------------------------
// Commands

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Every agent's sessions on this machine, newest first.
#[tauri::command]
pub async fn vault_list(ws: State<'_, Workspace>, vault: State<'_, Arc<Vault>>, agents: Option<Vec<Agent>>) -> Result<Vec<VaultSession>, String> {
  let (vault, open) = (vault.inner().clone(), ws.current());
  blocking(move || Ok(vault.list(&Roots::from_env()?, agents.as_deref(), open.as_deref()))).await
}

/// Sessions whose conversation contains `query` (case-insensitive), newest first.
#[tauri::command]
pub async fn vault_search(ws: State<'_, Workspace>, vault: State<'_, Arc<Vault>>, query: String, agents: Option<Vec<Agent>>, limit: Option<usize>) -> Result<SearchOutcome, String> {
  let (vault, open) = (vault.inner().clone(), ws.current());
  blocking(move || {
    let rows = vault.list(&Roots::from_env()?, agents.as_deref(), open.as_deref());
    Ok(vault.search(&rows, &query, limit.unwrap_or(MAX_HITS).min(MAX_HITS)))
  })
  .await
}

/// One session's conversation, read-only.
#[tauri::command]
pub async fn vault_transcript(agent: Agent, path: String) -> Result<Transcript, String> {
  blocking(move || {
    let real = locate(&Roots::from_env()?, agent, &path)?;
    Ok(transcript(agent, &real))
  })
  .await
}

/// Tokens and estimated cost per day, agent and model, from every session's transcript.
/// `tz_offset_min`: the webview's `-Date.getTimezoneOffset()`, so days are local days; `days`:
/// only the last that many (all with none).
#[tauri::command]
pub async fn vault_stats(ws: State<'_, Workspace>, vault: State<'_, Arc<Vault>>, tz_offset_min: i32, days: Option<u32>) -> Result<Stats, String> {
  let (vault, open) = (vault.inner().clone(), ws.current());
  blocking(move || {
    let rows = vault.list(&Roots::from_env()?, None, open.as_deref());
    Ok(stats::stats(&rows, |s| vault.usage(s), tz_offset_min, days))
  })
  .await
}

#[cfg(test)]
mod tests;
