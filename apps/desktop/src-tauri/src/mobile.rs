//! Mobile pairing (Orca's `mobile:*` IPC, `src/main/ipc/mobile.ts`): a phone on the same network
//! (or tailnet) pairs by scanning a QR code or typing a short code, then sees every project's tasks
//! with their agent status and can send a message to a task's agent.
//!
//! Security: off by default; the server only listens while "Mobile access" is on. Every data
//! endpoint needs a device token (`Authorization: Bearer`), a pairing code is single-use, expires
//! after 10 minutes and dies after a few wrong tries, tokens are stored only as SHA-256 hashes, a
//! device can be revoked at any time, and a burst of failed attempts is reported to the user. The
//! only thing served without a token is the page itself, which holds no data.
//!
//! Orca speaks an end-to-end encrypted WebSocket RPC to its native app (or a relay); Kingu has no
//! phone app, so it serves a small web page over plain HTTP instead (MECHANICS.md › Mobile pairing).

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::agent::tasks::TaskMeta;
use crate::i18n::Message;
use crate::i18n::msg::{MobileMsg, MobileWebMsg};
use crate::tr;

/// Orca `DEFAULT_WS_PORT` (runtime-rpc-pairing-types.ts); a taken port falls back to any free one.
pub const DEFAULT_PORT: u16 = 6768;
/// Orca `MOBILE_PAIRING_OFFER_TTL_MS` (pairing/pairing-offer-expiry.ts).
pub const OFFER_TTL_MS: u64 = 10 * 60_000;
/// Orca `PAIRING_OFFER_REUSE_MARGIN_MS`: an offer is reused only with more than this left.
pub const OFFER_REUSE_MARGIN_MS: u64 = 60_000;
/// Orca `device-credential.ts`: `randomBytes(24).toString('hex')`.
pub const TOKEN_BYTES: usize = 24;
/// Orca `unpaired-device-auth-throttle.ts`: 3 failures in 60 s, reported once.
pub const AUTH_FAILURE_THRESHOLD: usize = 3;
pub const AUTH_FAILURE_WINDOW_MS: u64 = 60_000;
/// Orca `DELEGATED_PHONE_NAME_MAX_CHARS` (shared/delegated-mobile-device-contract.ts).
pub const MAX_NAME: usize = 128;
/// Kingu: the typed code (10 characters of 32 = 50 bits) and how many wrong tries kill it.
pub const CODE_LEN: usize = 10;
pub const CODE_ATTEMPTS: u32 = 5;
const CODE_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/// Kingu: request limits.
const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 64 * 1024;
pub const MAX_MESSAGE: usize = 16_000;
const MAX_CONNECTIONS: usize = 16;
const READ_TIMEOUT: Duration = Duration::from_secs(10);
const SEND_TIMEOUT: Duration = Duration::from_secs(20);
/// `last_seen_at` is written to disk at most this often per device.
const SEEN_SAVE_MS: u64 = 60_000;
const MAX_PROMPT_SHOWN: usize = 1000;
const MAX_SUMMARY_SHOWN: usize = 2000;
/// Kingu: a window's live agent states count while it pushed them this recently (it re-sends
/// every 10 s while mobile access is on); after that the phone falls back to tasks.json.
pub const LIVE_TTL_MS: u64 = 30_000;
/// Kingu: most live rows one window may push, and the longest line kept per row.
const MAX_LIVE_TASKS: usize = 500;
const MAX_LIVE_MESSAGE: usize = 300;

pub const CHANGED_EVENT: &str = "mobile:changed";
pub const AUTH_FAILURES_EVENT: &str = "mobile:auth-failures";
pub const REQUEST_EVENT: &str = "mobile:request";

const PAGE: &str = include_str!("mobile_web.html");

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Stored {
  #[serde(default)]
  enabled: bool,
  /// The port last listened on, tried first so a paired phone's page keeps its address.
  #[serde(default)]
  port: Option<u16>,
  #[serde(default)]
  devices: Vec<Device>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Device {
  id: String,
  name: String,
  token_sha256: String,
  paired_at: u64,
  #[serde(default)]
  last_seen_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DeviceView {
  pub id: String,
  pub name: String,
  pub paired_at: u64,
  pub last_seen_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NetAddress {
  pub name: String,
  pub address: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
  pub enabled: bool,
  pub running: bool,
  pub port: Option<u16>,
  pub addresses: Vec<NetAddress>,
  /// The address a new code advertises unless another is picked.
  pub default_address: Option<String>,
  pub devices: Vec<DeviceView>,
  pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Pairing {
  /// `ABCDE-FGHJK`, what the user types.
  pub code: String,
  pub url: String,
  /// `data:image/svg+xml;base64,…`
  pub qr: String,
  pub expires_at: u64,
  pub address: String,
  pub port: u16,
}

struct Offer {
  code: String,
  expires_at: u64,
  wrong: u32,
}

struct Server {
  port: u16,
  stop: Arc<AtomicBool>,
}

#[derive(Default)]
struct Inner {
  stored: Stored,
  offer: Option<Offer>,
  server: Option<Server>,
  error: Option<String>,
  failures: VecDeque<u64>,
  alerted: bool,
}

/// What the server needs from the rest of Kingu (a fake one in tests).
pub trait Backend: Send + Sync {
  /// Every project with its tasks; `open`: a window has it as its folder (messages can be sent).
  fn projects(&self) -> Vec<ProjectTasks>;
  fn send(&self, root: &str, slug: &str, text: &str) -> Result<(), String>;
  /// Answers the open permission prompt or question of a task's agent (`/api/answer`).
  fn answer(&self, root: &str, slug: &str, answer: &Value) -> Result<(), String>;
  fn changed(&self);
  fn alert(&self, failures: usize);
}

pub struct ProjectTasks {
  pub root: String,
  pub name: String,
  pub open: bool,
  pub tasks: Vec<TaskMeta>,
}

/// A task's live agent state as the window that has its project open sees it (the agent CLI's
/// hooks, cliSessions.svelte.ts), pushed with `mobile_live` — what Orca's phone gets from its
/// agent status store instead of the saved task list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiveTask {
  pub slug: String,
  /// `working`, `permission` (a permission prompt is open), `question` (the agent asked one),
  /// `idle` (turn over) or `ended` (the CLI exited).
  pub phase: String,
  #[serde(default)]
  pub message: Option<String>,
  /// The question's options (ask.ts `AskPrompt`) while `phase` is `question`.
  #[serde(default)]
  pub ask: Option<Value>,
  /// Unix ms of the agent's latest event.
  #[serde(default)]
  pub at: u64,
}

/// Live rows of each project root, as last pushed: (when, rows by slug).
type LiveMap = HashMap<String, (u64, HashMap<String, LiveTask>)>;

pub struct Mobile {
  file: PathBuf,
  inner: Mutex<Inner>,
  pending: Mutex<HashMap<u64, mpsc::Sender<Result<(), String>>>>,
  next: AtomicU64,
  connections: AtomicUsize,
  live: Mutex<LiveMap>,
}

pub fn now_ms() -> u64 {
  std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

pub fn random_bytes(n: usize) -> Result<Vec<u8>, String> {
  let mut b = vec![0u8; n];
  #[cfg(unix)]
  {
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).map_err(|e| tr!(MobileMsg::NoRandom, detail = e))?;
    Ok(b)
  }
  #[cfg(not(unix))]
  {
    let _ = &mut b;
    Err(tr!(MobileMsg::NoRandom, detail = "no /dev/urandom"))
  }
}

fn hex(bytes: &[u8]) -> String {
  bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_hex(s: &str) -> String {
  hex(&Sha256::digest(s.as_bytes()))
}

/// Same-length comparison that doesn't stop at the first difference.
fn same(a: &[u8], b: &[u8]) -> bool {
  a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A new code: `CODE_LEN` characters of `CODE_ALPHABET` (256 is a multiple of 32: unbiased).
fn new_code() -> Result<String, String> {
  Ok(random_bytes(CODE_LEN)?.iter().map(|b| CODE_ALPHABET[(b & 31) as usize] as char).collect())
}

/// What the user typed → the code: upper case, no dashes or spaces, O → 0, I/L → 1 (Crockford).
pub fn normalize_code(input: &str) -> String {
  input
    .chars()
    .filter(|c| !matches!(c, '-' | ' ' | '\t'))
    .map(|c| match c.to_ascii_uppercase() {
      'O' => '0',
      'I' | 'L' => '1',
      c => c,
    })
    .collect()
}

pub fn format_code(code: &str) -> String {
  if code.len() == CODE_LEN { format!("{}-{}", &code[..5], &code[5..]) } else { code.to_string() }
}

/// Orca `isTailnetIPv4Address` (shared/tailnet-address.ts): 100.64.0.0/10.
pub fn is_tailnet(ip: Ipv4Addr) -> bool {
  let o = ip.octets();
  o[0] == 100 && (64..=127).contains(&o[1])
}

/// Orca `isVirtualBridgeInterface` (shared/pairing-address-auto-selection.ts), without the
/// Windows Hyper-V route check (a `vEthernet` adapter counts as a bridge).
pub fn is_virtual_bridge(name: &str) -> bool {
  static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
  RE.get_or_init(|| {
    regex::Regex::new(r"(?i)^(?:docker|br-|virbr|vmnet|vboxnet|veth|lxcbr|cni|flannel|cali|bridge)|VMware Network Adapter|VirtualBox Host-Only|^vEthernet ").unwrap()
  })
  .is_match(name)
}

/// Orca `getPairingNetworkInterfaces` + `rankInterface` (pairing/network/pairing-network-interfaces.ts)
/// for IPv4 only: no loopback, no proxy fake-IP range 198.18/15; tailnet first, then the rest,
/// bridges after (stable order otherwise). Kingu also leaves out link-local 169.254/16.
pub fn rank_addresses(list: Vec<(String, Ipv4Addr)>) -> Vec<NetAddress> {
  let mut out: Vec<(u8, NetAddress)> = list
    .into_iter()
    .filter(|(_, ip)| !ip.is_loopback() && !ip.is_unspecified() && !ip.is_link_local() && !(ip.octets()[0] == 198 && matches!(ip.octets()[1], 18 | 19)))
    .map(|(name, ip)| {
      let rank = if is_tailnet(ip) { 0 } else { 1 + if is_virtual_bridge(&name) { 2 } else { 0 } };
      (rank, NetAddress { name, address: ip.to_string() })
    })
    .collect();
  out.sort_by_key(|(r, _)| *r);
  out.dedup_by(|a, b| a.1.address == b.1.address);
  out.into_iter().map(|(_, a)| a).collect()
}

/// Orca `selectAutoAdvertisedPairingAddress`: bridges are never picked on their own; a tailnet
/// address first, else the first remaining one.
pub fn default_address(list: &[NetAddress]) -> Option<String> {
  let ok: Vec<&NetAddress> = list.iter().filter(|a| !is_virtual_bridge(&a.name)).collect();
  ok.iter().find(|a| a.address.parse().is_ok_and(is_tailnet)).or(ok.first()).map(|a| a.address.clone())
}

#[cfg(unix)]
fn interfaces() -> Vec<(String, Ipv4Addr)> {
  let mut out = Vec::new();
  // SAFETY: getifaddrs fills a list we only read and then free with freeifaddrs.
  unsafe {
    let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
    if libc::getifaddrs(&mut head) != 0 {
      return out;
    }
    let mut p = head;
    while !p.is_null() {
      let ifa = &*p;
      let up = ifa.ifa_flags & (libc::IFF_UP as libc::c_uint) != 0;
      if up && !ifa.ifa_addr.is_null() && i32::from((*ifa.ifa_addr).sa_family) == libc::AF_INET {
        let sin = &*(ifa.ifa_addr as *const libc::sockaddr_in);
        let ip = Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
        let name = std::ffi::CStr::from_ptr(ifa.ifa_name).to_string_lossy().into_owned();
        out.push((name, ip));
      }
      p = ifa.ifa_next;
    }
    libc::freeifaddrs(head);
  }
  out
}

#[cfg(not(unix))]
fn interfaces() -> Vec<(String, Ipv4Addr)> {
  Vec::new()
}

/// The QR image of `url` as a data URL. Orca `encodeMobilePairingQr` (pairing/mobile-pairing-qr.ts):
/// error correction M, a 4-module quiet zone.
pub fn qr_data_url(url: &str) -> Result<String, String> {
  use base64::Engine;
  use qrcode::render::svg;
  let code = qrcode::QrCode::with_error_correction_level(url.as_bytes(), qrcode::EcLevel::M).map_err(|e| tr!(MobileMsg::QrFailed, detail = e))?;
  let svg = code.render::<svg::Color>().quiet_zone(true).module_dimensions(4, 4).build();
  Ok(format!("data:image/svg+xml;base64,{}", base64::engine::general_purpose::STANDARD.encode(svg)))
}

/// A device name: what the phone says (control characters dropped, at most `MAX_NAME`), else
/// Orca's `Mobile <date>`; the date is added to a bare `iPhone`/`Android`.
pub fn device_name(given: &str, now: u64) -> String {
  let clean: String = given.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(MAX_NAME - 11).collect();
  let date = time::OffsetDateTime::from_unix_timestamp((now / 1000) as i64).map(|t| t.date().to_string()).unwrap_or_default();
  if clean.is_empty() { format!("Mobile {date}") } else { format!("{clean} {date}") }
}

/// Who may be named in `Host`: an IP address (with a port) or `localhost`; a DNS name pointing at
/// this machine (DNS rebinding) is refused.
pub fn host_allowed(host: Option<&str>) -> bool {
  let Some(h) = host.map(str::trim).filter(|h| !h.is_empty()) else { return false };
  let name = if let Some(rest) = h.strip_prefix('[') {
    rest.split(']').next().unwrap_or("")
  } else {
    h.rsplit_once(':').filter(|(_, p)| p.chars().all(|c| c.is_ascii_digit())).map_or(h, |(n, _)| n)
  };
  name.eq_ignore_ascii_case("localhost") || name.parse::<IpAddr>().is_ok()
}

#[derive(Debug, Default, Clone)]
pub struct HttpRequest {
  pub method: String,
  pub path: String,
  pub host: Option<String>,
  pub authorization: Option<String>,
  pub content_type: Option<String>,
  pub body: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
  pub status: u16,
  pub content_type: &'static str,
  pub body: Vec<u8>,
  pub csp: Option<String>,
}

fn json_response(status: u16, v: Value) -> HttpResponse {
  HttpResponse { status, content_type: "application/json; charset=utf-8", body: v.to_string().into_bytes(), csp: None }
}

fn error(status: u16, message: String) -> HttpResponse {
  json_response(status, json!({ "error": message }))
}

fn reason(status: u16) -> &'static str {
  match status {
    200 => "OK",
    400 => "Bad Request",
    401 => "Unauthorized",
    403 => "Forbidden",
    404 => "Not Found",
    405 => "Method Not Allowed",
    409 => "Conflict",
    413 => "Payload Too Large",
    415 => "Unsupported Media Type",
    502 => "Bad Gateway",
    503 => "Service Unavailable",
    _ => "Error",
  }
}

fn clip(s: &str, max: usize) -> String {
  if s.chars().count() <= max { s.to_string() } else { s.chars().take(max).collect::<String>() + "…" }
}

/// The agent's program for the phone: `claude-code`, or `codex` for `cli:codex --yolo`.
fn agent_label(agent: &str) -> String {
  match agent.strip_prefix("cli:") {
    Some(cmd) => cmd.split_whitespace().next().map(|p| p.rsplit('/').next().unwrap_or(p)).unwrap_or(cmd).to_string(),
    None => agent.to_string(),
  }
}

/// Orca mobile `AGENT_ATTENTION_STATUS_ORDER` (mobile/src/worktree/workspace-list-ordering.ts):
/// needs you, then working, then finished, then the rest; newest first within each.
fn attention(status: &str) -> u8 {
  match status {
    "waiting" => 0,
    "running" => 1,
    "review" | "done" | "failed" => 2,
    _ => 3,
  }
}

/// The status the phone shows: the live phase when the window pushed one, else tasks.json's.
pub fn live_status<'a>(stored: &'a str, live: Option<&LiveTask>) -> &'a str {
  match live.map(|l| l.phase.as_str()) {
    Some("permission" | "question") => "waiting",
    Some("working") => "running",
    Some("idle" | "ended") if stored == "running" || stored == "waiting" => "review",
    _ => stored,
  }
}

fn updated(t: &TaskMeta, live: Option<&LiveTask>) -> u64 {
  let saved = if t.updated_at > 0 { t.updated_at } else { t.created_at };
  live.map_or(saved, |l| saved.max(l.at))
}

fn task_json(t: &TaskMeta, live: Option<&LiveTask>) -> Value {
  let updated = updated(t, live);
  json!({
    "slug": t.slug,
    "title": t.title,
    "status": live_status(&t.status, live),
    "live": live.map(|l| json!({ "phase": l.phase, "message": l.message, "ask": l.ask })),
    "agent": agent_label(&t.agent),
    "prompt": clip(&t.prompt, MAX_PROMPT_SHOWN),
    "createdAt": t.created_at,
    "updatedAt": updated,
    "hibernated": t.hibernated_at.is_some(),
    "prUrl": t.pr_url,
    "lastRun": t.last_run.as_ref().map(|r| json!({
      "status": r.status,
      "at": r.at,
      "summary": r.summary.as_deref().map(|s| clip(s, MAX_SUMMARY_SHOWN)),
      "error": r.error.as_deref().map(|s| clip(s, 500)),
    })),
  })
}

/// Every project's tasks for the phone, with the live rows (`root` → `slug` → row) laid over.
pub fn projects_json(projects: Vec<ProjectTasks>, live: &HashMap<String, HashMap<String, LiveTask>>) -> Value {
  let list: Vec<Value> = projects
    .into_iter()
    .map(|mut p| {
      let rows = live.get(&p.root);
      let row = |t: &TaskMeta| rows.and_then(|r| r.get(&t.slug));
      p.tasks.sort_by(|a, b| {
        attention(live_status(&a.status, row(a))).cmp(&attention(live_status(&b.status, row(b)))).then(updated(b, row(b)).cmp(&updated(a, row(a))))
      });
      json!({ "root": p.root, "name": p.name, "open": p.open, "tasks": p.tasks.iter().map(|t| task_json(t, row(t))).collect::<Vec<_>>() })
    })
    .collect();
  json!({ "projects": list, "maxMessage": MAX_MESSAGE })
}

/// The page with its nonce, language and words.
fn page(nonce: &str) -> HttpResponse {
  use MobileWebMsg as W;
  let locale = crate::i18n::current();
  let words: [(&str, W); 31] = [
    ("pairTitle", W::PairTitle),
    ("pairHint", W::PairHint),
    ("pair", W::Pair),
    ("pairing", W::Pairing),
    ("tasks", W::Tasks),
    ("refresh", W::Refresh),
    ("noTasks", W::NoTasks),
    ("back", W::Back),
    ("send", W::Send),
    ("sending", W::Sending),
    ("sent", W::Sent),
    ("messagePlaceholder", W::MessagePlaceholder),
    ("notOpen", W::NotOpen),
    ("offline", W::Offline),
    ("forget", W::Forget),
    ("prompt", W::Prompt),
    ("lastRun", W::LastRun),
    ("sleeping", W::Sleeping),
    ("statusRunning", W::StatusRunning),
    ("statusWaiting", W::StatusWaiting),
    ("statusReview", W::StatusReview),
    ("statusDone", W::StatusDone),
    ("statusFailed", W::StatusFailed),
    ("permissionTitle", W::PermissionTitle),
    ("permissionHint", W::PermissionHint),
    ("allow", W::Allow),
    ("deny", W::Deny),
    ("questionTitle", W::QuestionTitle),
    ("otherAnswer", W::OtherAnswer),
    ("sendAnswer", W::SendAnswer),
    ("answered", W::Answered),
  ];
  let map: serde_json::Map<String, Value> = words.iter().map(|(k, m)| (k.to_string(), Value::String(m.text(locale).to_string()))).collect();
  // Inside <script>: no `</script>` can come out of the JSON.
  let strings = Value::Object(map).to_string().replace('<', "\\u003c");
  let lang = if locale == crate::i18n::Locale::Th { "th" } else { "en" };
  let html = PAGE.replace("__NONCE__", nonce).replace("__LANG__", lang).replace("__STRINGS__", &strings);
  let csp = format!(
    "default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
  HttpResponse { status: 200, content_type: "text/html; charset=utf-8", body: html.into_bytes(), csp: Some(csp) }
}

#[derive(Deserialize)]
struct PairBody {
  #[serde(default)]
  code: String,
  #[serde(default)]
  name: String,
}

#[derive(Deserialize)]
struct SendBody {
  root: String,
  slug: String,
  text: String,
}

#[derive(Deserialize)]
struct AnswerBody {
  root: String,
  slug: String,
  /// `allow` / `deny` a permission prompt, or `question` with `selections`.
  answer: String,
  #[serde(default)]
  selections: Option<Value>,
}

impl Mobile {
  pub fn load(file: PathBuf) -> Self {
    let stored = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    Self { file, inner: Mutex::new(Inner { stored, ..Default::default() }), pending: Mutex::default(), next: AtomicU64::new(0), connections: AtomicUsize::new(0), live: Mutex::default() }
  }

  fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
    self.inner.lock().unwrap_or_else(|e| e.into_inner())
  }

  fn save(&self, stored: &Stored) -> Result<(), String> {
    let text = serde_json::to_string_pretty(stored).map_err(|e| e.to_string())?;
    crate::settings::write_atomic(&self.file, &text).map_err(|e| tr!(MobileMsg::SaveFailed, detail = e))?;
    // It holds token hashes: readable by the user only.
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      let _ = std::fs::set_permissions(&self.file, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
  }

  pub fn status(&self) -> Status {
    let addresses = rank_addresses(interfaces());
    let default_address = default_address(&addresses);
    let inner = self.lock();
    Status {
      enabled: inner.stored.enabled,
      running: inner.server.is_some(),
      port: inner.server.as_ref().map(|s| s.port),
      addresses,
      default_address,
      devices: inner.stored.devices.iter().map(|d| DeviceView { id: d.id.clone(), name: d.name.clone(), paired_at: d.paired_at, last_seen_at: d.last_seen_at }).collect(),
      error: inner.error.clone(),
    }
  }

  /// Binds and starts serving: the remembered port, else `DEFAULT_PORT`, else any free port.
  pub fn start(self: &Arc<Self>, backend: Arc<dyn Backend>, bind: Ipv4Addr) -> Result<u16, String> {
    let mut inner = self.lock();
    if let Some(s) = &inner.server {
      return Ok(s.port);
    }
    let mut tries: Vec<u16> = inner.stored.port.into_iter().collect();
    if !tries.contains(&DEFAULT_PORT) {
      tries.push(DEFAULT_PORT);
    }
    tries.push(0);
    let mut last = String::new();
    let listener = tries.iter().find_map(|&p| match TcpListener::bind((bind, p)) {
      Ok(l) => Some(l),
      Err(e) => {
        last = e.to_string();
        None
      }
    });
    let Some(listener) = listener else {
      let e = tr!(MobileMsg::BindFailed, port = DEFAULT_PORT, detail = last);
      inner.error = Some(e.clone());
      return Err(e);
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    inner.server = Some(Server { port, stop: stop.clone() });
    inner.error = None;
    inner.alerted = false;
    inner.failures.clear();
    if inner.stored.port != Some(port) {
      inner.stored.port = Some(port);
      let stored = inner.stored.clone();
      drop(inner);
      if let Err(e) = self.save(&stored) {
        log::warn!("mobile: {e}");
      }
    } else {
      drop(inner);
    }
    let me = self.clone();
    std::thread::spawn(move || me.accept_loop(listener, stop, backend));
    log::info!("mobile: listening on {bind}:{port}");
    Ok(port)
  }

  pub fn stop(&self) {
    let mut inner = self.lock();
    if let Some(s) = inner.server.take() {
      s.stop.store(true, Ordering::SeqCst);
      log::info!("mobile: stopped");
    }
    inner.offer = None;
  }

  pub fn set_enabled(self: &Arc<Self>, enabled: bool, backend: Arc<dyn Backend>) -> Result<(), String> {
    let stored = {
      let mut inner = self.lock();
      inner.stored.enabled = enabled;
      inner.stored.clone()
    };
    self.save(&stored)?;
    if enabled {
      self.start(backend, Ipv4Addr::UNSPECIFIED)?;
    } else {
      self.stop();
      self.lock().error = None;
    }
    Ok(())
  }

  /// Orca `requestMobilePairingOffer` + `reusablePairingOffer`: the current code while it has more
  /// than a minute left (unless `rotate`), else a new one.
  pub fn pairing(&self, address: Option<&str>, rotate: bool, now: u64) -> Result<Pairing, String> {
    let address = match address.map(str::trim).filter(|a| !a.is_empty()) {
      Some(a) => a.parse::<Ipv4Addr>().map_err(|_| tr!(MobileMsg::BadAddress, address = a))?.to_string(),
      None => default_address(&rank_addresses(interfaces())).ok_or_else(|| tr!(MobileMsg::NoNetwork))?,
    };
    let mut inner = self.lock();
    let port = inner.server.as_ref().map(|s| s.port).ok_or_else(|| tr!(MobileMsg::NotEnabled))?;
    let reuse = !rotate && inner.offer.as_ref().is_some_and(|o| o.expires_at > now + OFFER_REUSE_MARGIN_MS);
    if !reuse {
      inner.offer = Some(Offer { code: new_code()?, expires_at: now + OFFER_TTL_MS, wrong: 0 });
    }
    let offer = inner.offer.as_ref().expect("offer just set");
    let url = format!("http://{address}:{port}/#pairing={}", offer.code);
    Ok(Pairing { code: format_code(&offer.code), qr: qr_data_url(&url)?, url, expires_at: offer.expires_at, address, port })
  }

  pub fn revoke(&self, id: &str) -> Result<bool, String> {
    let stored = {
      let mut inner = self.lock();
      let before = inner.stored.devices.len();
      inner.stored.devices.retain(|d| d.id != id);
      if inner.stored.devices.len() == before {
        return Ok(false);
      }
      inner.stored.clone()
    };
    self.save(&stored)?;
    Ok(true)
  }

  /// Orca `UnpairedDeviceAuthThrottle.recordFailure`.
  fn failure(&self, backend: &dyn Backend, now: u64) {
    let mut inner = self.lock();
    if inner.alerted {
      return;
    }
    inner.failures.push_back(now);
    while inner.failures.front().is_some_and(|&t| now.saturating_sub(t) > AUTH_FAILURE_WINDOW_MS) {
      inner.failures.pop_front();
    }
    if inner.failures.len() >= AUTH_FAILURE_THRESHOLD {
      let n = inner.failures.len();
      inner.alerted = true;
      inner.failures.clear();
      drop(inner);
      log::warn!("mobile: {n} failed attempts within a minute");
      backend.alert(n);
    }
  }

  /// The device a bearer token belongs to (its id), with its last-seen time updated.
  fn authenticate(&self, req: &HttpRequest, now: u64) -> Option<String> {
    let token = req.authorization.as_deref()?.strip_prefix("Bearer ")?.trim();
    if token.len() != TOKEN_BYTES * 2 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
      return None;
    }
    let hash = sha256_hex(token);
    let mut inner = self.lock();
    let d = inner.stored.devices.iter_mut().find(|d| same(d.token_sha256.as_bytes(), hash.as_bytes()))?;
    let save = now.saturating_sub(d.last_seen_at) >= SEEN_SAVE_MS;
    d.last_seen_at = now;
    let id = d.id.clone();
    let stored = save.then(|| inner.stored.clone());
    drop(inner);
    if let Some(s) = stored {
      let _ = self.save(&s);
    }
    Some(id)
  }

  pub fn handle(&self, backend: &dyn Backend, req: &HttpRequest, now: u64) -> HttpResponse {
    if !host_allowed(req.host.as_deref()) {
      return error(403, tr!(MobileMsg::BadRequest));
    }
    let path = req.path.split(['?', '#']).next().unwrap_or("");
    let method = req.method.as_str();
    match (method, path) {
      ("GET" | "HEAD", "/" | "/index.html") => return page(&random_bytes(16).map(|b| hex(&b)).unwrap_or_else(|_| "0".repeat(32))),
      (_, "/" | "/index.html") => return error(405, tr!(MobileMsg::BadRequest)),
      _ if !path.starts_with("/api/") => return error(404, tr!(MobileMsg::NotFound)),
      _ => {}
    }
    let post = method == "POST";
    if post && !req.content_type.as_deref().is_some_and(|c| c.trim_start().to_ascii_lowercase().starts_with("application/json")) {
      return error(415, tr!(MobileMsg::BadRequest));
    }
    match (method, path) {
      ("POST", "/api/pair") => self.pair(backend, &req.body, now),
      ("GET", "/api/tasks") | ("POST", "/api/send") | ("POST", "/api/answer") | ("POST", "/api/unpair") => {
        let Some(device) = self.authenticate(req, now) else {
          self.failure(backend, now);
          return error(401, tr!(MobileMsg::Unauthorized));
        };
        match path {
          "/api/tasks" => json_response(200, projects_json(backend.projects(), &self.live(now))),
          "/api/send" => send(backend, &req.body),
          "/api/answer" => self.answer(backend, &req.body, now),
          _ => match self.revoke(&device) {
            Ok(_) => {
              backend.changed();
              json_response(200, json!({ "ok": true }))
            }
            Err(e) => error(503, e),
          },
        }
      }
      (_, "/api/pair" | "/api/tasks" | "/api/send" | "/api/answer" | "/api/unpair") => error(405, tr!(MobileMsg::BadRequest)),
      _ => error(404, tr!(MobileMsg::NotFound)),
    }
  }

  /// Trades the single-use code for a device token (Orca: the ticket is exchanged once).
  fn pair(&self, backend: &dyn Backend, body: &[u8], now: u64) -> HttpResponse {
    let Ok(b) = serde_json::from_slice::<PairBody>(body) else { return error(400, tr!(MobileMsg::BadRequest)) };
    let code = normalize_code(&b.code);
    let mut inner = self.lock();
    let valid = inner.offer.as_ref().filter(|o| o.expires_at > now);
    let Some(offer) = valid else {
      inner.offer = None;
      drop(inner);
      self.failure(backend, now);
      return error(401, tr!(MobileMsg::BadCode));
    };
    if !same(offer.code.as_bytes(), code.as_bytes()) {
      let o = inner.offer.as_mut().expect("checked above");
      o.wrong += 1;
      let used_up = o.wrong >= CODE_ATTEMPTS;
      if used_up {
        inner.offer = None;
      }
      drop(inner);
      self.failure(backend, now);
      return error(401, if used_up { tr!(MobileMsg::CodeUsedUp) } else { tr!(MobileMsg::BadCode) });
    }
    let (token, id) = match (random_bytes(TOKEN_BYTES), random_bytes(16)) {
      (Ok(t), Ok(i)) => (hex(&t), hex(&i)),
      (Err(e), _) | (_, Err(e)) => return error(503, e),
    };
    inner.offer = None;
    let name = device_name(&b.name, now);
    inner.stored.devices.push(Device { id: id.clone(), name: name.clone(), token_sha256: sha256_hex(&token), paired_at: now, last_seen_at: now });
    let stored = inner.stored.clone();
    drop(inner);
    if let Err(e) = self.save(&stored) {
      self.lock().stored.devices.retain(|d| d.id != id);
      return error(503, e);
    }
    backend.changed();
    log::info!("mobile: paired a device");
    json_response(200, json!({ "token": token, "deviceId": id, "name": name }))
  }

  fn accept_loop(self: Arc<Self>, listener: TcpListener, stop: Arc<AtomicBool>, backend: Arc<dyn Backend>) {
    while !stop.load(Ordering::SeqCst) {
      match listener.accept() {
        Ok((stream, _)) => {
          if self.connections.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            self.connections.fetch_sub(1, Ordering::SeqCst);
            continue;
          }
          let (me, backend) = (self.clone(), backend.clone());
          std::thread::spawn(move || {
            me.serve(stream, &*backend);
            me.connections.fetch_sub(1, Ordering::SeqCst);
          });
        }
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
        Err(_) => std::thread::sleep(Duration::from_millis(100)),
      }
    }
  }

  fn serve(&self, mut stream: TcpStream, backend: &dyn Backend) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(READ_TIMEOUT));
    let res = match read_request(&mut stream) {
      Ok(req) => {
        let head_only = req.method == "HEAD";
        (self.handle(backend, &req, now_ms()), head_only)
      }
      Err(status) => (error(status, tr!(MobileMsg::BadRequest)), false),
    };
    let _ = write_response(&mut stream, &res.0, res.1);
  }

  /// A window's live agent rows for its project (replacing what it pushed before).
  pub fn set_live(&self, root: &str, tasks: Vec<LiveTask>, now: u64) {
    let rows = tasks
      .into_iter()
      .take(MAX_LIVE_TASKS)
      .map(|mut t| {
        t.message = t.message.map(|m| clip(&m, MAX_LIVE_MESSAGE));
        (t.slug.clone(), t)
      })
      .collect();
    let mut live = self.live.lock().unwrap_or_else(|e| e.into_inner());
    live.retain(|_, (at, _)| now.saturating_sub(*at) < LIVE_TTL_MS);
    live.insert(root.to_string(), (now, rows));
  }

  /// The live rows still fresh (pushed within `LIVE_TTL_MS`), by root.
  pub fn live(&self, now: u64) -> HashMap<String, HashMap<String, LiveTask>> {
    let live = self.live.lock().unwrap_or_else(|e| e.into_inner());
    live.iter().filter(|(_, (at, _))| now.saturating_sub(*at) < LIVE_TTL_MS).map(|(root, (_, rows))| (root.clone(), rows.clone())).collect()
  }

  /// `/api/answer`: only while the task's live row shows that prompt open, in an open window.
  fn answer(&self, backend: &dyn Backend, body: &[u8], now: u64) -> HttpResponse {
    let Ok(b) = serde_json::from_slice::<AnswerBody>(body) else { return error(400, tr!(MobileMsg::BadRequest)) };
    let want = match b.answer.as_str() {
      "allow" | "deny" => "permission",
      "question" => "question",
      _ => return error(400, tr!(MobileMsg::BadRequest)),
    };
    let selections = match (&b.selections, want) {
      (Some(Value::Array(a)), "question") if !a.is_empty() && a.len() <= 16 && serde_json::to_vec(a).map_or(0, |v| v.len()) <= MAX_MESSAGE => b.selections.clone(),
      (_, "question") => return error(400, tr!(MobileMsg::BadRequest)),
      _ => None,
    };
    let projects = backend.projects();
    let Some(p) = projects.iter().find(|p| p.root == b.root) else { return error(404, tr!(MobileMsg::UnknownProject)) };
    if !p.tasks.iter().any(|t| t.slug == b.slug) {
      return error(404, tr!(MobileMsg::UnknownTask, slug = b.slug));
    }
    if !p.open {
      return error(409, tr!(MobileMsg::NoWindow));
    }
    let open = self.live(now).get(&b.root).and_then(|r| r.get(&b.slug)).is_some_and(|t| t.phase == want);
    if !open {
      return error(409, tr!(MobileMsg::NothingToAnswer));
    }
    let answer = json!({ "kind": b.answer, "selections": selections });
    match backend.answer(&b.root, &b.slug, &answer) {
      Ok(()) => json_response(200, json!({ "ok": true })),
      Err(e) => error(502, e),
    }
  }

  /// The webview's answer to a `mobile:request`.
  pub fn reply(&self, id: u64, result: Result<(), String>) {
    if let Some(tx) = self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
      let _ = tx.send(result);
    }
  }
}

fn send(backend: &dyn Backend, body: &[u8]) -> HttpResponse {
  let Ok(b) = serde_json::from_slice::<SendBody>(body) else { return error(400, tr!(MobileMsg::BadRequest)) };
  let text = b.text.trim();
  if text.is_empty() {
    return error(400, tr!(MobileMsg::EmptyMessage));
  }
  if text.chars().count() > MAX_MESSAGE {
    return error(413, tr!(MobileMsg::MessageTooLong, max = MAX_MESSAGE));
  }
  let projects = backend.projects();
  let Some(p) = projects.iter().find(|p| p.root == b.root) else { return error(404, tr!(MobileMsg::UnknownProject)) };
  if !p.tasks.iter().any(|t| t.slug == b.slug) {
    return error(404, tr!(MobileMsg::UnknownTask, slug = b.slug));
  }
  if !p.open {
    return error(409, tr!(MobileMsg::NoWindow));
  }
  match backend.send(&b.root, &b.slug, text) {
    Ok(()) => json_response(200, json!({ "ok": true })),
    Err(e) => error(502, e),
  }
}

/// One HTTP/1.1 request: head up to `MAX_HEAD`, a `Content-Length` body up to `MAX_BODY`.
pub fn read_request(stream: &mut impl Read) -> Result<HttpRequest, u16> {
  let mut buf = Vec::new();
  let mut chunk = [0u8; 4096];
  let head_end = loop {
    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
      break i;
    }
    if buf.len() > MAX_HEAD {
      return Err(413);
    }
    let n = stream.read(&mut chunk).map_err(|_| 400u16)?;
    if n == 0 {
      return Err(400);
    }
    buf.extend_from_slice(&chunk[..n]);
  };
  let head = std::str::from_utf8(&buf[..head_end]).map_err(|_| 400u16)?;
  let mut lines = head.split("\r\n");
  let mut first = lines.next().unwrap_or_default().split(' ');
  let (method, path) = (first.next().unwrap_or_default().to_string(), first.next().unwrap_or_default().to_string());
  if method.is_empty() || !path.starts_with('/') {
    return Err(400);
  }
  let mut req = HttpRequest { method, path, ..Default::default() };
  let mut length = 0usize;
  for l in lines {
    let Some((k, v)) = l.split_once(':') else { continue };
    let v = v.trim().to_string();
    match k.trim().to_ascii_lowercase().as_str() {
      "host" => req.host = Some(v),
      "authorization" => req.authorization = Some(v),
      "content-type" => req.content_type = Some(v),
      "content-length" => length = v.parse().map_err(|_| 400u16)?,
      "transfer-encoding" => return Err(400),
      _ => {}
    }
  }
  if length > MAX_BODY {
    return Err(413);
  }
  let mut body = buf[head_end + 4..].to_vec();
  while body.len() < length {
    let n = stream.read(&mut chunk).map_err(|_| 400u16)?;
    if n == 0 {
      return Err(400);
    }
    body.extend_from_slice(&chunk[..n]);
  }
  body.truncate(length);
  req.body = body;
  Ok(req)
}

pub fn write_response(stream: &mut impl Write, res: &HttpResponse, head_only: bool) -> std::io::Result<()> {
  let mut head = format!(
    "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nX-Frame-Options: DENY\r\nConnection: close\r\n",
    res.status,
    reason(res.status),
    res.content_type,
    res.body.len()
  );
  if let Some(csp) = &res.csp {
    head.push_str(&format!("Content-Security-Policy: {csp}\r\n"));
  }
  head.push_str("\r\n");
  stream.write_all(head.as_bytes())?;
  if !head_only {
    stream.write_all(&res.body)?;
  }
  stream.flush()
}

/// Kingu's side: projects from the side bar and open windows, messages through the window that
/// has the project open (its `adeTasks.followUp`).
struct AppBackend(AppHandle);

impl AppBackend {
  fn open_window(&self, root: &Path) -> Option<String> {
    let ws = self.0.state::<crate::workspace::Workspaces>();
    ws.all().into_iter().find(|w| w.current().as_deref() == Some(root)).map(|w| w.label().to_string())
  }

  /// Hands a request to the window that has `root` open and waits for its `mobile_reply`.
  fn request(&self, root: &str, mut payload: Value) -> Result<(), String> {
    let label = self.open_window(Path::new(root)).ok_or_else(|| tr!(MobileMsg::NoWindow))?;
    let mobile = self.0.state::<Arc<Mobile>>();
    let id = mobile.next.fetch_add(1, Ordering::Relaxed) + 1;
    payload["id"] = json!(id);
    let (tx, rx) = mpsc::channel();
    mobile.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
    let answer = match self.0.emit_to(label.as_str(), REQUEST_EVENT, payload) {
      Ok(()) => rx.recv_timeout(SEND_TIMEOUT).unwrap_or_else(|_| Err(tr!(MobileMsg::WindowNoAnswer))),
      Err(e) => Err(e.to_string()),
    };
    mobile.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    answer
  }
}

impl Backend for AppBackend {
  fn projects(&self) -> Vec<ProjectTasks> {
    let mut roots: Vec<PathBuf> = self.0.state::<crate::projects::Projects>().list().into_iter().map(|p| p.path).collect();
    for w in self.0.state::<crate::workspace::Workspaces>().all() {
      if let Some(r) = w.current().filter(|r| !roots.contains(r)) {
        roots.push(r);
      }
    }
    roots
      .into_iter()
      .map(|root| ProjectTasks {
        name: root.file_name().map_or_else(|| root.display().to_string(), |n| n.to_string_lossy().into_owned()),
        open: self.open_window(&root).is_some(),
        tasks: crate::agent::tasks::load(&root).unwrap_or_default(),
        root: root.display().to_string(),
      })
      .collect()
  }

  fn send(&self, root: &str, slug: &str, text: &str) -> Result<(), String> {
    self.request(root, json!({ "root": root, "slug": slug, "text": text }))
  }

  fn answer(&self, root: &str, slug: &str, answer: &Value) -> Result<(), String> {
    self.request(root, json!({ "root": root, "slug": slug, "text": "", "answer": answer }))
  }

  fn changed(&self) {
    let _ = self.0.emit(CHANGED_EVENT, ());
  }

  fn alert(&self, failures: usize) {
    let _ = self.0.emit(AUTH_FAILURES_EVENT, failures);
  }
}

/// Loads the paired devices and, when mobile access was left on, starts listening.
pub fn install(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
  let mobile = Arc::new(Mobile::load(app.path().app_data_dir()?.join("mobile.json")));
  app.manage(mobile.clone());
  if mobile.lock().stored.enabled {
    if let Err(e) = mobile.start(Arc::new(AppBackend(app.handle().clone())), Ipv4Addr::UNSPECIFIED) {
      log::warn!("mobile: {e}");
    }
  }
  Ok(())
}

#[tauri::command]
pub async fn mobile_status(mobile: State<'_, Arc<Mobile>>) -> Result<Status, String> {
  let m = mobile.inner().clone();
  tauri::async_runtime::spawn_blocking(move || m.status()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mobile_set_enabled(app: AppHandle, mobile: State<'_, Arc<Mobile>>, enabled: bool) -> Result<Status, String> {
  let m = mobile.inner().clone();
  tauri::async_runtime::spawn_blocking(move || {
    let r = m.set_enabled(enabled, Arc::new(AppBackend(app.clone())));
    let _ = app.emit(CHANGED_EVENT, ());
    r.map(|()| m.status())
  })
  .await
  .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mobile_pairing(mobile: State<'_, Arc<Mobile>>, address: Option<String>, rotate: Option<bool>) -> Result<Pairing, String> {
  let m = mobile.inner().clone();
  tauri::async_runtime::spawn_blocking(move || m.pairing(address.as_deref(), rotate.unwrap_or(false), now_ms())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn mobile_revoke(app: AppHandle, mobile: State<'_, Arc<Mobile>>, id: String) -> Result<bool, String> {
  let r = mobile.revoke(&id)?;
  let _ = app.emit(CHANGED_EVENT, ());
  Ok(r)
}

/// The window's live agent rows for its project (sent only while mobile access is on).
#[tauri::command]
pub fn mobile_live(mobile: State<'_, Arc<Mobile>>, root: String, tasks: Vec<LiveTask>) {
  mobile.set_live(&root, tasks, now_ms());
}

#[tauri::command]
pub fn mobile_reply(mobile: State<'_, Arc<Mobile>>, id: u64, error: Option<String>) {
  mobile.reply(id, error.map_or(Ok(()), Err));
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::agent::tasks::TaskMeta;

  #[derive(Default)]
  struct Fake {
    sent: Mutex<Vec<(String, String, String)>>,
    alerts: Mutex<Vec<usize>>,
    open: bool,
  }

  fn task(slug: &str, status: &str, updated: u64) -> TaskMeta {
    serde_json::from_value(json!({ "slug": slug, "title": slug, "base": "main", "created_at": 1, "updated_at": updated, "status": status, "agent": "cli:codex --yolo" })).unwrap()
  }

  impl Backend for Fake {
    fn projects(&self) -> Vec<ProjectTasks> {
      vec![ProjectTasks { root: "/p".into(), name: "p".into(), open: self.open, tasks: vec![task("a", "done", 5), task("b", "waiting", 1), task("c", "running", 9)] }]
    }
    fn send(&self, root: &str, slug: &str, text: &str) -> Result<(), String> {
      self.sent.lock().unwrap().push((root.into(), slug.into(), text.into()));
      Ok(())
    }
    fn answer(&self, root: &str, slug: &str, answer: &Value) -> Result<(), String> {
      self.sent.lock().unwrap().push((root.into(), slug.into(), answer.to_string()));
      Ok(())
    }
    fn changed(&self) {}
    fn alert(&self, n: usize) {
      self.alerts.lock().unwrap().push(n);
    }
  }

  fn mobile() -> (tempfile::TempDir, Arc<Mobile>) {
    let dir = tempfile::tempdir().unwrap();
    let m = Arc::new(Mobile::load(dir.path().join("mobile.json")));
    (dir, m)
  }

  fn req(method: &str, path: &str, auth: Option<&str>, body: Value) -> HttpRequest {
    HttpRequest {
      method: method.into(),
      path: path.into(),
      host: Some("192.168.1.5:6768".into()),
      authorization: auth.map(|t| format!("Bearer {t}")),
      content_type: Some("application/json".into()),
      body: if body.is_null() { Vec::new() } else { body.to_string().into_bytes() },
    }
  }

  fn body(r: &HttpResponse) -> Value {
    serde_json::from_slice(&r.body).unwrap()
  }

  /// A running server's pairing code, without binding a real port.
  fn fake_running(m: &Mobile) {
    m.lock().server = Some(Server { port: 6768, stop: Arc::new(AtomicBool::new(false)) });
  }

  fn pair(m: &Mobile, b: &Fake, now: u64) -> String {
    let p = m.pairing(Some("192.168.1.5"), false, now).unwrap();
    let r = m.handle(b, &req("POST", "/api/pair", None, json!({ "code": p.code.to_lowercase(), "name": "iPhone" })), now);
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    body(&r)["token"].as_str().unwrap().to_string()
  }

  #[test]
  fn codes_and_names() {
    assert_eq!(normalize_code("abcde-fghjk"), "ABCDEFGHJK");
    assert_eq!(normalize_code("o0 il"), "0011");
    assert_eq!(format_code("ABCDEFGHJK"), "ABCDE-FGHJK");
    let c = new_code().unwrap();
    assert_eq!(c.len(), CODE_LEN);
    assert!(c.bytes().all(|b| CODE_ALPHABET.contains(&b)));
    assert_eq!(device_name("", 0), "Mobile 1970-01-01");
    assert_eq!(device_name("iPhone\u{7}", 86_400_000), "iPhone 1970-01-02");
    assert!(device_name(&"x".repeat(500), 0).chars().count() <= MAX_NAME);
  }

  #[test]
  fn addresses_follow_orca_ranking() {
    let list = vec![
      ("lo0".to_string(), Ipv4Addr::new(127, 0, 0, 1)),
      ("bridge100".to_string(), Ipv4Addr::new(192, 168, 64, 1)),
      ("en0".to_string(), Ipv4Addr::new(192, 168, 1, 5)),
      ("utun4".to_string(), Ipv4Addr::new(100, 101, 2, 3)),
      ("utun9".to_string(), Ipv4Addr::new(198, 18, 0, 1)),
      ("en5".to_string(), Ipv4Addr::new(169, 254, 1, 1)),
    ];
    let ranked = rank_addresses(list);
    let addrs: Vec<&str> = ranked.iter().map(|a| a.address.as_str()).collect();
    assert_eq!(addrs, ["100.101.2.3", "192.168.1.5", "192.168.64.1"]);
    assert_eq!(default_address(&ranked).as_deref(), Some("100.101.2.3"));
    let only_bridge = vec![NetAddress { name: "docker0".into(), address: "172.17.0.1".into() }];
    assert_eq!(default_address(&only_bridge), None);
    assert!(is_tailnet(Ipv4Addr::new(100, 127, 0, 1)) && !is_tailnet(Ipv4Addr::new(100, 128, 0, 1)));
  }

  #[test]
  fn hosts() {
    assert!(host_allowed(Some("192.168.1.5:6768")));
    assert!(host_allowed(Some("[::1]:6768")));
    assert!(host_allowed(Some("localhost:1")));
    assert!(!host_allowed(Some("evil.example:6768")));
    assert!(!host_allowed(None));
  }

  #[test]
  fn pairing_reuses_rotates_and_needs_the_server() {
    let (_d, m) = mobile();
    assert!(m.pairing(Some("192.168.1.5"), false, 0).is_err());
    fake_running(&m);
    assert!(m.pairing(Some("not-an-ip"), false, 0).is_err());
    let a = m.pairing(Some("192.168.1.5"), false, 0).unwrap();
    assert!(a.url.starts_with("http://192.168.1.5:6768/#pairing="));
    assert!(a.qr.starts_with("data:image/svg+xml;base64,"));
    assert_eq!(a.expires_at, OFFER_TTL_MS);
    // Reused with more than a minute left, new after that or when rotated.
    assert_eq!(m.pairing(Some("192.168.1.5"), false, OFFER_TTL_MS - OFFER_REUSE_MARGIN_MS - 1).unwrap().code, a.code);
    assert_ne!(m.pairing(Some("192.168.1.5"), false, OFFER_TTL_MS - OFFER_REUSE_MARGIN_MS).unwrap().code, a.code);
    let b = m.pairing(Some("192.168.1.5"), false, 0).unwrap();
    assert_ne!(m.pairing(Some("192.168.1.5"), true, 0).unwrap().code, b.code);
  }

  #[test]
  fn pairing_is_single_use_and_tokens_authenticate() {
    let (_d, m) = mobile();
    fake_running(&m);
    let b = Fake { open: true, ..Default::default() };
    let p = m.pairing(Some("192.168.1.5"), false, 0).unwrap();
    let token = pair_with(&m, &b, &p.code);
    // The code is gone once used.
    let again = m.handle(&b, &req("POST", "/api/pair", None, json!({ "code": p.code })), 2);
    assert_eq!(again.status, 401);
    // Stored as a hash only.
    let file = std::fs::read_to_string(&m.file).unwrap();
    assert!(!file.contains(&token) && file.contains(&sha256_hex(&token)));
    let st = m.status();
    assert_eq!(st.devices.len(), 1);
    assert!(st.devices[0].name.starts_with("iPhone "));
    // Tasks: attention order (waiting, running, then done).
    let r = m.handle(&b, &req("GET", "/api/tasks", Some(&token), Value::Null), 3);
    assert_eq!(r.status, 200);
    let slugs: Vec<String> = body(&r)["projects"][0]["tasks"].as_array().unwrap().iter().map(|t| t["slug"].as_str().unwrap().to_string()).collect();
    assert_eq!(slugs, ["b", "c", "a"]);
    assert_eq!(body(&r)["projects"][0]["tasks"][0]["agent"], "codex");
    // Send.
    let s = m.handle(&b, &req("POST", "/api/send", Some(&token), json!({ "root": "/p", "slug": "c", "text": " hi " })), 4);
    assert_eq!(s.status, 200);
    assert_eq!(b.sent.lock().unwrap()[0], ("/p".into(), "c".into(), "hi".into()));
    assert_eq!(m.handle(&b, &req("POST", "/api/send", Some(&token), json!({ "root": "/p", "slug": "zz", "text": "x" })), 4).status, 404);
    assert_eq!(m.handle(&b, &req("POST", "/api/send", Some(&token), json!({ "root": "/q", "slug": "c", "text": "x" })), 4).status, 404);
    assert_eq!(m.handle(&b, &req("POST", "/api/send", Some(&token), json!({ "root": "/p", "slug": "c", "text": "  " })), 4).status, 400);
    assert_eq!(m.handle(&b, &req("POST", "/api/send", Some(&token), json!({ "root": "/p", "slug": "c", "text": "x".repeat(MAX_MESSAGE + 1) })), 4).status, 413);
    // Revoked: refused.
    let id = st.devices[0].id.clone();
    assert!(m.revoke(&id).unwrap());
    assert_eq!(m.handle(&b, &req("GET", "/api/tasks", Some(&token), Value::Null), 5).status, 401);
  }

  fn pair_with(m: &Mobile, b: &Fake, code: &str) -> String {
    let r = m.handle(b, &req("POST", "/api/pair", None, json!({ "code": code, "name": "iPhone" })), 1);
    assert_eq!(r.status, 200);
    body(&r)["token"].as_str().unwrap().to_string()
  }

  fn live(slug: &str, phase: &str, at: u64) -> LiveTask {
    LiveTask { slug: slug.into(), phase: phase.into(), message: Some("m".repeat(400)), ask: None, at }
  }

  #[test]
  fn live_rows_override_the_saved_status_until_they_go_stale() {
    let (_d, m) = mobile();
    fake_running(&m);
    let b = Fake { open: true, ..Default::default() };
    let token = pair(&m, &b, 1);
    // "a" is done in tasks.json but its agent now waits on a permission prompt; "c" went idle.
    m.set_live("/p", vec![live("a", "permission", 50), live("c", "idle", 60)], 100);
    let j = body(&m.handle(&b, &req("GET", "/api/tasks", Some(&token), Value::Null), 200));
    let tasks = j["projects"][0]["tasks"].as_array().unwrap();
    let order: Vec<&str> = tasks.iter().map(|t| t["slug"].as_str().unwrap()).collect();
    assert_eq!(order, ["a", "b", "c"], "two waiting (live a newer than b), then c reviewed");
    assert_eq!(tasks[0]["status"], "waiting");
    assert_eq!(tasks[0]["live"]["phase"], "permission");
    assert_eq!(tasks[0]["live"]["message"].as_str().unwrap().chars().count(), MAX_LIVE_MESSAGE + 1);
    assert_eq!(tasks[2]["status"], "review");
    assert!(tasks[1]["live"].is_null());
    // Not refreshed for LIVE_TTL_MS: tasks.json again.
    let j = body(&m.handle(&b, &req("GET", "/api/tasks", Some(&token), Value::Null), 100 + LIVE_TTL_MS));
    assert_eq!(j["projects"][0]["tasks"][0]["slug"], "b");
    assert_eq!(j["projects"][0]["tasks"][2]["status"], "done");
    assert_eq!(live_status("running", Some(&live("x", "working", 0))), "running");
    assert_eq!(live_status("review", Some(&live("x", "working", 0))), "running");
    assert_eq!(live_status("done", Some(&live("x", "idle", 0))), "done");
  }

  #[test]
  fn answers_need_the_matching_open_prompt() {
    let (_d, m) = mobile();
    fake_running(&m);
    let b = Fake { open: true, ..Default::default() };
    let token = pair(&m, &b, 1);
    let ans = |body: Value, now: u64| m.handle(&b, &req("POST", "/api/answer", Some(&token), body), now).status;
    // No live row: nothing to answer.
    assert_eq!(ans(json!({ "root": "/p", "slug": "a", "answer": "allow" }), 2), 409);
    m.set_live("/p", vec![live("a", "permission", 1), live("c", "question", 1)], 2);
    assert_eq!(ans(json!({ "root": "/p", "slug": "a", "answer": "maybe" }), 3), 400);
    assert_eq!(ans(json!({ "root": "/p", "slug": "a", "answer": "question", "selections": [{ "indices": [0] }] }), 3), 409);
    assert_eq!(ans(json!({ "root": "/p", "slug": "c", "answer": "deny" }), 3), 409);
    assert_eq!(ans(json!({ "root": "/p", "slug": "c", "answer": "question" }), 3), 400);
    assert_eq!(ans(json!({ "root": "/p", "slug": "zz", "answer": "allow" }), 3), 404);
    assert_eq!(ans(json!({ "root": "/p", "slug": "a", "answer": "allow" }), 3), 200);
    assert_eq!(ans(json!({ "root": "/p", "slug": "c", "answer": "question", "selections": [{ "indices": [1] }] }), 3), 200);
    let sent = b.sent.lock().unwrap().clone();
    assert_eq!(sent[0].2, r#"{"kind":"allow","selections":null}"#);
    assert_eq!(sent[1].2, r#"{"kind":"question","selections":[{"indices":[1]}]}"#);
    // Without a token, nothing.
    assert_eq!(m.handle(&b, &req("POST", "/api/answer", None, json!({ "root": "/p", "slug": "a", "answer": "allow" })), 4).status, 401);
    // A stale row can't be answered.
    assert_eq!(ans(json!({ "root": "/p", "slug": "a", "answer": "allow" }), 2 + LIVE_TTL_MS), 409);
  }

  #[test]
  fn closed_project_cannot_take_messages() {
    let (_d, m) = mobile();
    fake_running(&m);
    let b = Fake::default();
    let token = pair(&m, &b, 0);
    assert_eq!(m.handle(&b, &req("POST", "/api/send", Some(&token), json!({ "root": "/p", "slug": "c", "text": "x" })), 1).status, 409);
    assert!(b.sent.lock().unwrap().is_empty());
  }

  #[test]
  fn wrong_codes_die_and_bursts_alert_once() {
    let (_d, m) = mobile();
    fake_running(&m);
    let b = Fake::default();
    let p = m.pairing(Some("192.168.1.5"), false, 0).unwrap();
    for i in 0..CODE_ATTEMPTS {
      let r = m.handle(&b, &req("POST", "/api/pair", None, json!({ "code": "00000-00000" })), u64::from(i));
      assert_eq!(r.status, 401);
    }
    // Used up: even the right code fails now.
    assert_eq!(m.handle(&b, &req("POST", "/api/pair", None, json!({ "code": p.code })), 10).status, 401);
    assert_eq!(*b.alerts.lock().unwrap(), vec![AUTH_FAILURE_THRESHOLD]);
    // An expired code fails too.
    let p = m.pairing(Some("192.168.1.5"), true, 0).unwrap();
    assert_eq!(m.handle(&b, &req("POST", "/api/pair", None, json!({ "code": p.code })), OFFER_TTL_MS).status, 401);
  }

  #[test]
  fn no_data_without_a_token() {
    let (_d, m) = mobile();
    let b = Fake::default();
    for (method, path) in [("GET", "/api/tasks"), ("POST", "/api/send"), ("POST", "/api/unpair")] {
      assert_eq!(m.handle(&b, &req(method, path, None, json!({})), 0).status, 401, "{path}");
      assert_eq!(m.handle(&b, &req(method, path, Some(&"ab".repeat(24)), json!({})), 0).status, 401, "{path}");
    }
    assert_eq!(m.handle(&b, &req("GET", "/etc/passwd", None, Value::Null), 0).status, 404);
    assert_eq!(m.handle(&b, &req("PUT", "/api/tasks", None, Value::Null), 0).status, 405);
    let mut no_json = req("POST", "/api/pair", None, json!({}));
    no_json.content_type = Some("text/plain".into());
    assert_eq!(m.handle(&b, &no_json, 0).status, 415);
    let mut rebinding = req("GET", "/", None, Value::Null);
    rebinding.host = Some("attacker.example".into());
    assert_eq!(m.handle(&b, &rebinding, 0).status, 403);
    // The page: no data, a nonce CSP and the words.
    let page = m.handle(&b, &req("GET", "/", None, Value::Null), 0);
    assert_eq!(page.status, 200);
    let html = String::from_utf8(page.body).unwrap();
    assert!(page.csp.unwrap().contains("script-src 'nonce-"));
    assert!(!html.contains("__NONCE__") && !html.contains("__STRINGS__") && html.contains("Pair with Kingu"));
  }

  #[test]
  fn http_round_trip_over_a_socket() {
    let (_d, m) = mobile();
    let b: Arc<dyn Backend> = Arc::new(Fake::default());
    let port = m.start(b, Ipv4Addr::LOCALHOST).unwrap();
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.write_all(b"GET /api/tasks HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    assert!(out.starts_with("HTTP/1.1 401"), "{out}");
    assert!(out.contains("Cache-Control: no-store"));
    m.stop();
    assert!(!m.status().running);
  }

  #[test]
  fn request_parsing_limits() {
    let big = format!("POST /api/pair HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\n\r\n", MAX_BODY + 1);
    assert_eq!(read_request(&mut big.as_bytes()).unwrap_err(), 413);
    let chunked = "POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n";
    assert_eq!(read_request(&mut chunked.as_bytes()).unwrap_err(), 400);
    let ok = "POST /api/pair HTTP/1.1\r\nHost: 1.2.3.4\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
    let r = read_request(&mut ok.as_bytes()).unwrap();
    assert_eq!((r.method.as_str(), r.path.as_str(), r.body.as_slice()), ("POST", "/api/pair", b"{}".as_slice()));
  }
}
