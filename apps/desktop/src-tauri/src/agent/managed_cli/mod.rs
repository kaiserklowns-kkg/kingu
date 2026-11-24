//! Agent CLIs Kingu installs itself, for a machine without the user's own (Orca 1.4.269
//! `main/managed-agent-cli/managed-agent-cli-registry.ts`, `main/node-runtime/managed-runtime-installation.ts`,
//! `main/runtime/rpc/methods/host-management/managed-runtime-install.ts`): OpenCode, OpenCode 2,
//! Cursor, GitHub Copilot, Grok, Kimi Code, OMP and Antigravity's `agy`, plus Antigravity's ACP
//! server (`antigravity-server`, Orca's `ANTIGRAVITY_ACP_RUNTIME`): no terminal command, the
//! program of the chats Kingu signs in itself (agent/antigravity.rs).
//!
//! - **Asked first.** Nothing is downloaded until the user presses Install (chat pane or
//!   Settings › Agents); a copy Kingu installed is then kept on the publisher's latest release
//!   (checked two minutes after start and when a chat uses it, as Orca does).
//! - **What is downloaded.** The publisher's own build for this host, looked up at install time
//!   (pin.rs), over HTTPS, hashed against the digest the publisher lists before it is unpacked,
//!   made executable or run (fetch.rs, archive.rs). No installer script is ever fetched or run.
//! - **Where.** `<app data>/agent-runtimes/<agent>/<version>/`, published by one rename
//!   (release.rs); never the user's global prefix.
//! - **The user's own install always wins**: launches look on PATH and in the installer's folders
//!   first (runtimes.rs), terminals get Kingu's folders last on PATH.

pub mod acp_probe;
pub mod archive;
pub mod fetch;
pub mod pin;
pub mod release;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::i18n::msg::ManagedCliMsg;
use crate::tr;
use fetch::Http;
use pin::{Pin, Source, Target};
use release::{InstallError, Phase, StartFailure};

pub const EVENT: &str = "managed-cli:changed";

/// An agent CLI Kingu can install.
#[derive(Debug)]
pub struct Managed {
  /// The agent's id in the catalog (agentProfiles.ts) and among the chat runtimes (runtimes.rs).
  pub id: &'static str,
  pub label: &'static str,
  /// Its folder under `agent-runtimes`.
  pub folder: &'static str,
  pub source: Source,
  /// Added to the environment of its start check (a self-updating CLI must not update there).
  pub env: &'static [(&'static str, &'static str)],
}

const fn registry(id: &'static str, label: &'static str, registry_id: &'static str, command: &'static str, windows_command: &'static str, alias: Option<&'static str>) -> Managed {
  Managed { id, label, folder: id, source: Source::Registry { registry_id, command, windows_command, alias }, env: &[] }
}

/// Orca's `MANAGED_AGENT_CLIS`, without Claude and Codex (Kingu's chat runs those through its own
/// agent host). Hermes ships only as a git checkout its installer builds, so it stays the user's own.
pub const MANAGED: &[Managed] = &[
  registry("opencode", "OpenCode", "opencode", "opencode", "opencode.exe", None),
  // The 2.x listing ships the `opencode` binary; `opencode2` is the name its own installer adds.
  registry("opencode2", "OpenCode 2", "opencode-v2", "opencode", "opencode.exe", Some("opencode2")),
  registry("cursor", "Cursor", "cursor", "dist-package/cursor-agent", "dist-package/cursor-agent.cmd", None),
  Managed { id: "copilot", label: "GitHub Copilot", folder: "copilot", source: Source::Copilot, env: &[] },
  Managed { id: "grok", label: "Grok", folder: "grok", source: Source::Grok, env: &[] },
  Managed { id: "kimi", label: "Kimi Code", folder: "kimi", source: Source::Kimi, env: &[] },
  Managed { id: "omp", label: "OMP", folder: "omp", source: Source::Omp, env: &[] },
  // Kingu updates its copy itself; agy's own updater would replace it unverified.
  Managed { id: "antigravity", label: "Antigravity", folder: "agy", source: Source::Agy, env: &[("AGY_CLI_DISABLE_AUTO_UPDATE", "true")] },
  // Orca's own folder for it, apart from agy's.
  Managed { id: super::antigravity::SERVER_ID, label: "Antigravity", folder: "antigravity", source: Source::AgyAcpServer, env: &[] },
];

/// Orca's `antigravityManagedAgyEnabled` (absent means on): off, Kingu's copy of agy runs no chat,
/// counts as no install to the pickers, and is neither installed nor updated. Chats on Antigravity
/// then run the user's own agy, or refuse as not installed. Its folder stays on a terminal's PATH,
/// as Orca's does.
pub const AGY_SETTING: &str = "kingu.agent.antigravityManagedAgy";

pub fn managed(id: &str) -> Option<&'static Managed> {
  MANAGED.iter().find(|m| m.id == id)
}

impl Managed {
  /// The chat runtime it serves: its id, but Antigravity's server serves `antigravity` chats.
  pub fn serves(&self) -> &'static str {
    if self.source == Source::AgyAcpServer { super::antigravity::RUNTIME_ID } else { self.id }
  }

  /// A program for terminals too (on their PATH); the ACP server is not one.
  fn is_command(&self) -> bool {
    self.source != Source::AgyAcpServer
  }

  /// The names its command answers to in a terminal: the command itself and its alias.
  fn program_names(&self, t: &Target) -> Vec<String> {
    let command = self.source.command(t);
    let base = command.rsplit('/').next().unwrap_or(&command).to_owned();
    match self.source {
      Source::Registry { alias: Some(alias), .. } => vec![base, if t.os == "windows" { format!("{alias}.exe") } else { alias.to_owned() }],
      _ => vec![base],
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
  pub id: u64,
  /// `install` or `remove`.
  pub kind: &'static str,
  pub phase: Phase,
  pub downloaded_bytes: u64,
  pub total_bytes: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

impl Operation {
  fn running(&self) -> bool {
    matches!(self.phase, Phase::Downloading | Phase::Extracting | Phase::Verifying | Phase::Removing)
  }
}

/// Orca's `ManagedRuntimeInstallState`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
  pub agent: &'static str,
  pub label: &'static str,
  /// This host has a build to install (before a lookup: the publisher builds for it).
  pub available: bool,
  /// The latest release, once looked up.
  pub version: Option<String>,
  pub download_bytes: Option<u64>,
  /// Where the download comes from, shown before it starts.
  pub download_host: Option<String>,
  pub installed_version: Option<String>,
  /// False with an installed version: an update is available.
  pub installed_current: bool,
  /// The latest release's folder is there but not whole; Install repairs it.
  pub damaged: bool,
  pub can_remove: bool,
  /// What a launch runs now: Kingu's copy (`managed`), the user's own (`external`), or nothing.
  pub source: Option<&'static str>,
  /// The latest operation; an ended one stays readable until the next starts.
  pub operation: Option<Operation>,
}

#[derive(Default)]
struct Slot {
  operation: Option<Operation>,
  cancel: Arc<AtomicBool>,
  /// The last lookup's answer (`Some(None)`: the publisher has no build for this host).
  pin: Option<Option<Pin>>,
  looked_at: Option<Instant>,
  /// One attempt per release per hour, so a failing update isn't redownloaded on every use.
  last_auto: Option<(String, Instant)>,
  last_use_check: Option<Instant>,
}

pub struct Deps {
  pub http: Arc<dyn Http>,
  pub target: Target,
  /// Whether the unpacked program starts and answers the release's version.
  pub validate: Arc<dyn Fn(&Managed, &Path, &Pin) -> Result<(), StartFailure> + Send + Sync>,
  /// Whether the user has their own install of the agent (PATH, its installer's folders).
  pub external: Arc<dyn Fn(&Managed) -> bool + Send + Sync>,
  pub notify: Arc<dyn Fn(&Status) + Send + Sync>,
  /// Stops the agent's running chats and waits for them to end (before Remove deletes the program
  /// they run); Err when some are still running.
  pub stop_chats: Arc<dyn Fn(&Managed) -> Result<(), ()> + Send + Sync>,
  /// Whether Kingu's copy of the agent may run ([`AGY_SETTING`]).
  pub may_run: Arc<dyn Fn(&Managed) -> bool + Send + Sync>,
  pub free_bytes: Arc<dyn Fn(&Path) -> Option<u64> + Send + Sync>,
  /// How long a lookup's answer is reused (Orca: an hour).
  pub lookup_ttl: Duration,
}

pub struct Service {
  data: PathBuf,
  deps: Deps,
  slots: Mutex<HashMap<&'static str, Slot>>,
  next_id: AtomicU64,
}

const AUTO_UPDATE_RETRY: Duration = Duration::from_secs(60 * 60);
const AUTO_UPDATE_USE_THROTTLE: Duration = Duration::from_secs(10 * 60);
const AUTO_UPDATE_FIRST_CHECK: Duration = Duration::from_secs(2 * 60);
/// How long Remove waits for the agent's chats to end after asking them to stop.
const CHATS_STOP_WAIT: Duration = Duration::from_secs(10);

impl Service {
  pub fn new(data: PathBuf, deps: Deps) -> Arc<Self> {
    Arc::new(Service { data, deps, slots: Mutex::new(HashMap::new()), next_id: AtomicU64::new(1) })
  }

  pub fn root(&self, m: &Managed) -> PathBuf {
    self.data.join("agent-runtimes").join(m.folder)
  }

  fn slot<R>(&self, m: &Managed, f: impl FnOnce(&mut Slot) -> R) -> R {
    let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
    f(slots.entry(m.id).or_default())
  }

  fn cached_pin(&self, m: &Managed) -> Option<Option<Pin>> {
    self.slot(m, |s| s.pin.clone())
  }

  /// Looks the latest release up when the last answer is older than `lookup_ttl`; a failed
  /// lookup keeps the last known release.
  fn refresh_pin(&self, m: &Managed) -> Result<(), String> {
    if self.slot(m, |s| s.looked_at.is_some_and(|at| at.elapsed() < self.deps.lookup_ttl)) {
      return Ok(());
    }
    let answer = pin::lookup(self.deps.http.as_ref(), m.id, &m.source, &self.deps.target)?;
    self.slot(m, |s| {
      s.pin = Some(answer);
      s.looked_at = Some(Instant::now());
    });
    Ok(())
  }

  /// Kingu's installed copy of `m`'s command; None without a whole release.
  pub fn installed_command(&self, m: &Managed) -> Option<PathBuf> {
    let pin = self.cached_pin(m).flatten();
    let folder = release::resolve_installed(&self.root(m), pin.as_ref()).release?.folder;
    Some(m.source.command(&self.deps.target).split('/').fold(folder, |at, part| at.join(part)))
  }

  /// Kingu's installed copy of `m`'s command when it may run: what launches and the pickers see.
  pub fn runnable_command(&self, m: &Managed) -> Option<PathBuf> {
    if (self.deps.may_run)(m) { self.installed_command(m) } else { None }
  }

  /// What is installed and what a launch would run. `lookup`: ask the publisher for its latest
  /// release first (the chat pane and Settings do, so they can say what an install downloads).
  pub fn status(&self, m: &'static Managed, lookup: bool) -> Result<Status, String> {
    if lookup {
      if let Err(e) = self.refresh_pin(m) {
        log::warn!("managed install: {} latest release unknown: {e}", m.id);
      }
    }
    let (operation, known) = self.slot(m, |s| (s.operation.clone(), s.pin.clone()));
    let pin = known.clone().flatten();
    let found = release::resolve_installed(&self.root(m), pin.as_ref());
    // Unreadable is not absent: say so rather than offer an install over files that may be fine.
    if found.unreadable && !found.release.as_ref().is_some_and(|r| r.current) {
      return Err(tr!(ManagedCliMsg::Unreadable, label = m.label));
    }
    let may_run = (self.deps.may_run)(m);
    let source = if (self.deps.external)(m) { Some("external") } else { found.release.as_ref().filter(|_| may_run).map(|_| "managed") };
    Ok(Status {
      agent: m.id,
      label: m.label,
      available: may_run && known.map_or_else(|| m.source.has_build(&self.deps.target), |p| p.is_some()),
      version: pin.as_ref().map(|p| p.version.clone()),
      download_bytes: pin.as_ref().map(|p| p.bytes),
      download_host: pin.as_ref().and_then(|p| url::Url::parse(&p.url).ok()).and_then(|u| u.host_str().map(str::to_owned)),
      installed_version: found.release.as_ref().map(|r| r.version.clone()),
      installed_current: found.release.as_ref().is_some_and(|r| r.current),
      damaged: pin.as_ref().is_some_and(|p| !found.release.as_ref().is_some_and(|r| r.current) && found.broken.contains(&p.version)),
      can_remove: found.release.is_some() || !found.broken.is_empty(),
      source,
      operation,
    })
  }

  fn publish(&self, m: &'static Managed, id: u64, change: impl FnOnce(&mut Operation)) {
    let changed = self.slot(m, |s| match s.operation.as_mut().filter(|op| op.id == id) {
      Some(op) => {
        change(op);
        true
      }
      None => false,
    });
    if changed {
      match self.status(m, false) {
        Ok(status) => (self.deps.notify)(&status),
        Err(e) => log::warn!("managed install: {} status unreadable: {e}", m.id),
      }
    }
  }

  /// Starts an install (or joins the one running) and answers at once; progress arrives as events.
  pub fn install(self: &Arc<Self>, m: &'static Managed) -> Result<Status, String> {
    if !(self.deps.may_run)(m) {
      return Err(tr!(ManagedCliMsg::TurnedOff, label = m.label, setting = AGY_SETTING));
    }
    if !m.source.has_build(&self.deps.target) {
      return Err(tr!(ManagedCliMsg::Unavailable, label = m.label, os = self.deps.target.os, arch = self.deps.target.arch));
    }
    let id = self.next_id.fetch_add(1, Ordering::SeqCst);
    let started = self.slot(m, |s| match &s.operation {
      Some(op) if op.running() && op.kind == "remove" => Err(tr!(ManagedCliMsg::BeingRemoved, label = m.label)),
      Some(op) if op.running() => Ok(None),
      _ => {
        let cancel = Arc::new(AtomicBool::new(false));
        s.cancel = cancel.clone();
        s.operation = Some(Operation { id, kind: "install", phase: Phase::Downloading, downloaded_bytes: 0, total_bytes: s.pin.clone().flatten().map(|p| p.bytes), error: None });
        Ok(Some(cancel))
      }
    })?;
    if let Some(cancel) = started {
      let service = self.clone();
      std::thread::Builder::new().name(format!("managed-install-{}", m.id)).spawn(move || service.run_install(m, id, &cancel)).map_err(|e| e.to_string())?;
    }
    self.status(m, false)
  }

  fn run_install(&self, m: &'static Managed, id: u64, cancel: &AtomicBool) {
    let started = Instant::now();
    let timed_out = AtomicBool::new(false);
    let root = self.root(m);
    // The release chats ran before this install; they may still be running it.
    let previous = release::resolve_installed(&root, self.cached_pin(m).flatten().as_ref()).release.map(|r| r.version);
    let outcome: Result<Pin, InstallError> = (|| {
      let looked = self.refresh_pin(m);
      let pin = match (self.cached_pin(m), looked) {
        (Some(Some(pin)), _) => pin,
        (Some(None), _) => return Err(InstallError::Failed(tr!(ManagedCliMsg::Unavailable, label = m.label, os = self.deps.target.os, arch = self.deps.target.arch))),
        (None, Err(detail)) => return Err(InstallError::Failed(tr!(ManagedCliMsg::LookupFailed, label = m.label, detail))),
        (None, Ok(())) => return Err(InstallError::Failed(tr!(ManagedCliMsg::Unavailable, label = m.label, os = self.deps.target.os, arch = self.deps.target.arch))),
      };
      self.publish(m, id, |op| op.total_bytes = Some(pin.bytes));
      let mut progress = |phase: Phase, bytes: u64| {
        if started.elapsed() > fetch::DEADLINE {
          timed_out.store(true, Ordering::SeqCst);
          cancel.store(true, Ordering::SeqCst);
        }
        // Once cancelled, unwinding progress is stale; only the outcome may advance the state.
        if !cancel.load(Ordering::SeqCst) {
          self.publish(m, id, |op| {
            op.phase = phase;
            op.downloaded_bytes = bytes;
          });
        }
      };
      let validate = |program: &Path, pin: &Pin| (self.deps.validate)(m, program, pin);
      let free = |dir: &Path| (self.deps.free_bytes)(dir);
      let mut install =
        release::Install { label: m.label, source: &m.source, target: self.deps.target, root: &root, pin: &pin, http: self.deps.http.as_ref(), cancel, validate: &validate, free_bytes: &free, progress: &mut progress };
      release::install_release(&mut install)?;
      Ok(pin)
    })();
    match outcome {
      Ok(pin) => {
        release::reclaim(&root, &[pin.version.as_str(), previous.as_deref().unwrap_or(&pin.version)]);
        log::info!("managed install: {} {} installed", m.id, pin.version);
        self.publish(m, id, |op| op.phase = Phase::Succeeded);
      }
      Err(InstallError::Cancelled) if timed_out.load(Ordering::SeqCst) => self.publish(m, id, |op| {
        op.phase = Phase::Failed;
        op.error = Some(tr!(ManagedCliMsg::TookTooLong, label = m.label));
      }),
      Err(InstallError::Cancelled) => self.publish(m, id, |op| op.phase = Phase::Cancelled),
      Err(InstallError::Failed(text)) => {
        log::warn!("managed install: {} failed: {text}", m.id);
        self.publish(m, id, |op| {
          op.phase = Phase::Failed;
          op.error = Some(text);
        });
      }
    }
  }

  /// Cancels install `operation`; it ends `cancelled`, or `succeeded` when it had already committed.
  pub fn cancel(&self, m: &'static Managed, operation: u64) -> Result<Status, String> {
    self.slot(m, |s| match &s.operation {
      Some(op) if op.id == operation && op.kind == "remove" => Err(tr!(ManagedCliMsg::RemoveNoCancel, label = m.label)),
      Some(op) if op.id == operation && op.running() => {
        s.cancel.store(true, Ordering::SeqCst);
        Ok(())
      }
      _ => Err(tr!(ManagedCliMsg::NotRunning, label = m.label)),
    })?;
    self.status(m, false)
  }

  /// Deletes every release of `m` Kingu installed (never the user's own install), after stopping
  /// that agent's running chats (Orca's removal fence, `stopStructuredAgentChats`): when one will
  /// not stop, nothing is deleted.
  pub fn remove(&self, m: &'static Managed) -> Result<Status, String> {
    let id = self.next_id.fetch_add(1, Ordering::SeqCst);
    self.slot(m, |s| match &s.operation {
      Some(op) if op.running() && op.kind == "install" => Err(tr!(ManagedCliMsg::Installing, label = m.label)),
      Some(op) if op.running() => Err(tr!(ManagedCliMsg::BeingRemoved, label = m.label)),
      _ => {
        s.operation = Some(Operation { id, kind: "remove", phase: Phase::Removing, downloaded_bytes: 0, total_bytes: None, error: None });
        Ok(())
      }
    })?;
    // Removing… shows while the chats stop.
    self.publish(m, id, |_| {});
    if (self.deps.stop_chats)(m).is_err() {
      self.publish(m, id, |op| {
        op.phase = Phase::Failed;
        op.error = Some(tr!(ManagedCliMsg::ChatsNotStopped, label = m.label));
      });
      return self.status(m, false);
    }
    let root = self.root(m);
    let removed = match std::fs::symlink_metadata(&root) {
      Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(&root),
      Ok(_) => std::fs::remove_file(&root),
      Err(_) => Ok(()),
    };
    self.publish(m, id, |op| match removed {
      Ok(()) => op.phase = Phase::Succeeded,
      Err(e) => {
        op.phase = Phase::Failed;
        op.error = Some(e.to_string());
      }
    });
    self.status(m, false)
  }

  /// Brings Kingu's own copy to the latest release; never installs one nobody asked for, never
  /// touches the user's own (Orca `updateIfBehind`).
  pub fn update_if_behind(self: &Arc<Self>, m: &'static Managed) {
    // Nothing installed has nothing to update, so the latest release isn't looked up.
    if !(self.deps.may_run)(m) || self.slot(m, |s| s.operation.as_ref().is_some_and(Operation::running)) || !release::may_be_published(&self.root(m)) {
      return;
    }
    let Ok(status) = self.status(m, true) else { return };
    let (Some("managed"), Some(_), true, Some(version), false) = (status.source, &status.installed_version, status.available, &status.version, status.installed_current) else { return };
    let due = self.slot(m, |s| {
      let recent = s.last_auto.as_ref().is_some_and(|(v, at)| v == version && at.elapsed() < AUTO_UPDATE_RETRY);
      if !recent {
        s.last_auto = Some((version.clone(), Instant::now()));
      }
      !recent
    });
    if due {
      log::info!("managed install: updating {} to {version}", m.id);
      if let Err(e) = self.install(m) {
        log::warn!("managed install: {} update not started: {e}", m.id);
      }
    }
  }

  /// A launch resolved to Kingu's copy: updates follow real use instead of a timer.
  pub fn note_use(self: &Arc<Self>, m: &'static Managed) {
    let due = self.slot(m, |s| {
      let due = s.last_use_check.is_none_or(|at| at.elapsed() >= AUTO_UPDATE_USE_THROTTLE);
      if due {
        s.last_use_check = Some(Instant::now());
      }
      due
    });
    if due {
      let service = self.clone();
      let _ = std::thread::Builder::new().name("managed-update".into()).spawn(move || service.update_if_behind(m));
    }
  }

  /// At start: old releases and abandoned staging folders go; the release launches resolve to stays.
  fn reclaim_all(&self) {
    for m in MANAGED {
      let root = self.root(m);
      let found = release::resolve_installed(&root, None);
      if found.unreadable {
        log::warn!("managed install: {} releases unreadable; nothing reclaimed", m.id);
      } else if root.is_dir() {
        release::reclaim(&root, &found.release.iter().map(|r| r.version.as_str()).collect::<Vec<_>>());
      }
    }
  }

  /// The folders of the installed commands, for the end of a terminal's PATH.
  pub fn path_dirs(&self) -> Vec<PathBuf> {
    MANAGED.iter().filter(|m| m.is_command()).filter_map(|m| self.installed_command(m)?.parent().map(Path::to_path_buf)).collect()
  }

  /// The program names (of `names`) that an installed copy answers to.
  pub fn provides(&self, names: &[String]) -> Vec<String> {
    let installed: Vec<String> = MANAGED.iter().filter(|m| m.is_command() && self.runnable_command(m).is_some()).flat_map(|m| m.program_names(&self.deps.target)).collect();
    names.iter().filter(|n| installed.contains(n)).cloned().collect()
  }
}

// ---- this app's service -----------------------------------------------------------------------

static SERVICE: OnceLock<Arc<Service>> = OnceLock::new();

fn service() -> Result<&'static Arc<Service>, String> {
  SERVICE.get().ok_or_else(|| "managed installs are not ready".to_owned())
}

/// Called once at start: where releases live, and who hears about changes.
pub fn install(app: &tauri::AppHandle) -> Result<(), String> {
  use tauri::{Emitter, Manager};
  let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
  let (events, chats) = (app.clone(), app.clone());
  let deps = Deps {
    http: Arc::new(fetch::Reqwest),
    target: Target::here(),
    validate: Arc::new(|m, program, pin| match m.source {
      // The server has no `--version`: it must answer ACP `initialize` as the pinned release.
      Source::AgyAcpServer => acp_probe::probe_server(program, &super::antigravity::server_args().iter().map(String::as_str).collect::<Vec<_>>(), &pin.version, acp_probe::TIMEOUT),
      _ => release::answers_version(program, &pin.version, matches!(m.source, Source::Registry { .. }), m.env),
    }),
    external: Arc::new(|m| super::runtimes::users_own(m.id)),
    notify: Arc::new(move |status| {
      let _ = events.emit(EVENT, status);
    }),
    stop_chats: Arc::new(move |m| {
      // Every chat of the agent, as Orca stops them, whichever copy of the program it runs.
      match chats.try_state::<Arc<super::AgentHost>>() {
        Some(host) => host.stop_agent(m.serves(), CHATS_STOP_WAIT).map(|n| if n > 0 { log::info!("managed install: stopped {n} {} chat(s) before removing it", m.id) }).map_err(|left| log::warn!("managed install: {left} {} chat(s) did not stop", m.id)),
        None => Ok(()),
      }
    }),
    may_run: Arc::new(|m| m.id != "antigravity" || crate::system::config_dir().and_then(|d| crate::settings::user_value(d, AGY_SETTING)) != Some(serde_json::Value::Bool(false))),
    free_bytes: Arc::new(release::real_free_bytes),
    lookup_ttl: Duration::from_secs(60 * 60),
  };
  let service = Service::new(data, deps);
  let _ = SERVICE.set(service.clone());
  let _ = std::thread::Builder::new().name("managed-reclaim".into()).spawn(move || {
    service.reclaim_all();
    // Wait out startup so the first check never competes with launching the app.
    std::thread::sleep(AUTO_UPDATE_FIRST_CHECK);
    for m in MANAGED {
      service.update_if_behind(m);
    }
  });
  Ok(())
}

/// Kingu's copy of agent `id`'s command, when one is installed and may run (runtimes.rs looks here last).
pub fn installed_command(id: &str) -> Option<PathBuf> {
  SERVICE.get()?.runnable_command(managed(id)?)
}

/// Whether a release of `id` may be on disk (an unreadable folder may hold one): Orca's
/// `runtimeReleaseMayBePublished`, which keeps Antigravity chats on Kingu's server once installed.
pub fn server_in_use(id: &str) -> bool {
  matches!((SERVICE.get(), managed(id)), (Some(service), Some(m)) if release::may_be_published(&service.root(m)))
}

/// Kingu's app data folder (where releases and the server's chat home live).
pub fn data_dir() -> Option<PathBuf> {
  SERVICE.get().map(|s| s.data.clone())
}

/// A chat started on Kingu's copy of `id`.
pub fn note_use(id: &str, command: &Path) {
  if let (Some(service), Some(m)) = (SERVICE.get(), managed(id)) {
    if command.starts_with(service.root(m)) {
      service.note_use(m);
    }
  }
}

/// Whether `path` is inside Kingu's copies of agent `id` (never the user's own install).
pub fn is_managed_path(id: &str, path: &Path) -> bool {
  matches!((SERVICE.get(), managed(id)), (Some(service), Some(m)) if path.starts_with(service.root(m)))
}

/// The names of `names` that only Kingu's installed copies provide (`agent_cli_found`).
pub fn provides(names: &[String]) -> Vec<String> {
  SERVICE.get().map(|s| s.provides(names)).unwrap_or_default()
}

/// Terminal env: Kingu's copies last on PATH, so agent tabs reach them and they never shadow the
/// user's own (Orca `appendManagedAgentDirsToChildPath`).
pub fn terminal_env(env: &mut std::collections::BTreeMap<String, String>, unset: &[String]) {
  let Some(service) = SERVICE.get() else { return };
  if unset.iter().any(|k| k == "PATH") {
    return;
  }
  let dirs = service.path_dirs();
  if dirs.is_empty() {
    return;
  }
  let base = env.get("PATH").map(std::ffi::OsString::from).or_else(crate::shell_env::path);
  let last = std::env::join_paths(&dirs).ok();
  if let Some(path) = crate::shell_env::merge(base.as_deref(), last.as_deref()).and_then(|p| p.into_string().ok()) {
    env.insert("PATH".into(), path);
  }
}

fn known(agent: &str) -> Result<&'static Managed, String> {
  managed(agent).ok_or_else(|| tr!(ManagedCliMsg::UnknownAgent, agent))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Every agent Kingu can install, as the disk says now. No network.
#[tauri::command]
pub async fn managed_cli_list() -> Result<Vec<Status>, String> {
  blocking(|| {
    let service = service()?;
    Ok(MANAGED.iter().filter_map(|m| service.status(m, false).map_err(|e| log::warn!("managed install: {e}")).ok()).collect())
  })
  .await
}

/// One agent, with the publisher's latest release looked up (its version and download size).
#[tauri::command]
pub async fn managed_cli_status(agent: String) -> Result<Status, String> {
  blocking(move || service()?.status(known(&agent)?, true)).await
}

/// The user pressed Install.
#[tauri::command]
pub async fn managed_cli_install(agent: String) -> Result<Status, String> {
  blocking(move || service()?.install(known(&agent)?)).await
}

#[tauri::command]
pub async fn managed_cli_cancel(agent: String, operation: u64) -> Result<Status, String> {
  blocking(move || service()?.cancel(known(&agent)?, operation)).await
}

#[tauri::command]
pub async fn managed_cli_remove(agent: String) -> Result<Status, String> {
  blocking(move || service()?.remove(known(&agent)?)).await
}

#[cfg(all(test, unix))]
mod tests {
  use super::archive::tests::{gz, tar_entry, tar_of};
  use super::fetch::tests::{Fake, sha256_hex};
  use super::*;

  const MAC: Target = Target { os: "macos", arch: "aarch64", musl: false };
  const API: &str = "https://api.github.com/repos/github/copilot-cli/releases/latest";

  struct World {
    _dir: tempfile::TempDir,
    http: Arc<Fake>,
    service: Arc<Service>,
    external: Arc<AtomicBool>,
    seen: Arc<Mutex<Vec<Status>>>,
    /// The agent's chats will not stop.
    chats_stuck: Arc<AtomicBool>,
    /// The copy may not run (`AGY_SETTING` off).
    turned_off: Arc<AtomicBool>,
  }

  /// Publishes Copilot `version` as GitHub would: the release, its checksum list and the archive.
  fn publish(http: &Fake, version: &str, served: Option<&[u8]>) {
    let body = gz(&tar_of(&[tar_entry("copilot", b'0', 0o755, "", format!("#!/bin/sh\necho {version}\n").as_bytes())]));
    let base = format!("https://github.com/github/copilot-cli/releases/download/v{version}");
    let release = serde_json::json!({ "tag_name": format!("v{version}"), "assets": [
      { "name": "copilot-darwin-arm64.tar.gz", "size": served.map_or(body.len(), <[u8]>::len), "browser_download_url": format!("{base}/copilot-darwin-arm64.tar.gz") },
      { "name": "SHA256SUMS.txt", "size": 90, "browser_download_url": format!("{base}/SHA256SUMS.txt") }
    ] });
    http.put(API, 200, release.to_string().as_bytes());
    http.put(&format!("{base}/SHA256SUMS.txt"), 200, format!("{}  copilot-darwin-arm64.tar.gz\n", sha256_hex(&body)).as_bytes());
    http.put(&format!("{base}/copilot-darwin-arm64.tar.gz"), 200, served.unwrap_or(&body));
  }

  fn world() -> World {
    let dir = tempfile::tempdir().unwrap();
    let http = Arc::new(Fake::default());
    let external = Arc::new(AtomicBool::new(false));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (ext, log) = (external.clone(), seen.clone());
    let chats_stuck = Arc::new(AtomicBool::new(false));
    let stuck = chats_stuck.clone();
    let turned_off = Arc::new(AtomicBool::new(false));
    let off = turned_off.clone();
    let deps = Deps {
      http: http.clone(),
      target: MAC,
      validate: Arc::new(|_, program, pin| release::answers_version(program, &pin.version, false, &[])),
      external: Arc::new(move |_| ext.load(Ordering::SeqCst)),
      notify: Arc::new(move |s| log.lock().unwrap().push(s.clone())),
      stop_chats: Arc::new(move |_| if stuck.load(Ordering::SeqCst) { Err(()) } else { Ok(()) }),
      may_run: Arc::new(move |_| !off.load(Ordering::SeqCst)),
      free_bytes: Arc::new(|_| None),
      lookup_ttl: Duration::ZERO,
    };
    let service = Service::new(dir.path().to_path_buf(), deps);
    World { _dir: dir, http, service, external, seen, chats_stuck, turned_off }
  }

  fn settle(w: &World, m: &'static Managed) -> Status {
    for _ in 0..600 {
      let status = w.service.status(m, false).unwrap();
      if !status.operation.as_ref().is_some_and(Operation::running) {
        return status;
      }
      std::thread::sleep(Duration::from_millis(20));
    }
    panic!("the operation never settled");
  }

  #[test]
  fn the_catalog_is_orcas() {
    let ids: Vec<_> = MANAGED.iter().map(|m| (m.id, m.label, m.folder, m.source.command(&MAC))).collect();
    assert_eq!(
      ids,
      [
        ("opencode", "OpenCode", "opencode", "opencode".to_owned()),
        ("opencode2", "OpenCode 2", "opencode2", "opencode".to_owned()),
        ("cursor", "Cursor", "cursor", "dist-package/cursor-agent".to_owned()),
        ("copilot", "GitHub Copilot", "copilot", "copilot".to_owned()),
        ("grok", "Grok", "grok", "bin/grok".to_owned()),
        ("kimi", "Kimi Code", "kimi", "kimi".to_owned()),
        ("omp", "OMP", "omp", "bin/omp".to_owned()),
        ("antigravity", "Antigravity", "agy", "agy".to_owned()),
        ("antigravity-server", "Antigravity", "antigravity", "agy_acp_server.par".to_owned()),
      ]
    );
    let server = managed("antigravity-server").unwrap();
    assert_eq!((server.serves(), server.is_command()), ("antigravity", false));
    assert_eq!(managed("opencode2").unwrap().program_names(&MAC), ["opencode", "opencode2"]);
    assert_eq!(managed("cursor").unwrap().program_names(&MAC), ["cursor-agent"]);
    assert!(managed("claude").is_none() && managed("hermes").is_none());
    // Every id is an agent of the chat's runtimes, found by the name its launch looks for.
    for m in MANAGED.iter().filter(|m| m.is_command()) {
      assert!(crate::agent::runtimes::program_of(m.id).is_some_and(|p| m.program_names(&MAC).iter().any(|n| n == p)), "{}", m.id);
    }
  }

  #[test]
  fn nothing_is_downloaded_until_install_is_asked_for() {
    let w = world();
    let copilot = managed("copilot").unwrap();
    publish(&w.http, "1.0.110", None);
    // Listing reads the disk only; a status lookup asks the publisher but never fetches the build.
    let listed = w.service.status(copilot, false).unwrap();
    assert_eq!((listed.available, listed.version.as_deref(), listed.source, listed.can_remove), (true, None, None, false));
    assert!(w.http.asked().is_empty());
    let looked = w.service.status(copilot, true).unwrap();
    assert_eq!((looked.version.as_deref(), looked.download_host.as_deref(), looked.installed_version.as_deref()), (Some("1.0.110"), Some("github.com"), None));
    assert!(looked.download_bytes.is_some_and(|b| b > 0));
    assert!(!w.http.asked().iter().any(|u| u.ends_with(".tar.gz")));
    assert_eq!(w.service.installed_command(copilot), None);
    assert!(!w.service.root(copilot).exists());

    w.service.install(copilot).unwrap();
    let done = settle(&w, copilot);
    assert_eq!(done.operation.as_ref().map(|o| (o.kind, o.phase, o.error.clone())), Some(("install", Phase::Succeeded, None)));
    assert_eq!((done.installed_version.as_deref(), done.installed_current, done.source, done.can_remove), (Some("1.0.110"), true, Some("managed"), true));
    let command = w.service.installed_command(copilot).unwrap();
    assert_eq!(command, w.service.root(copilot).join("1.0.110/copilot"));
    assert!(command.starts_with(w._dir.path().join("agent-runtimes")), "only ever under Kingu's own folder");
    assert_eq!(w.service.path_dirs(), [w.service.root(copilot).join("1.0.110")]);
    assert_eq!(w.service.provides(&["claude".into(), "copilot".into(), "opencode".into()]), ["copilot"]);
    let phases: Vec<Phase> = w.seen.lock().unwrap().iter().filter_map(|s| s.operation.as_ref().map(|o| o.phase)).collect();
    assert_eq!(phases.last(), Some(&Phase::Succeeded));
    assert!(phases.contains(&Phase::Extracting) && phases.contains(&Phase::Verifying), "{phases:?}");

    // The user's own install wins: Kingu's copy stays but is not what runs, and is not updated.
    w.external.store(true, Ordering::SeqCst);
    assert_eq!(w.service.status(copilot, false).unwrap().source, Some("external"));
    publish(&w.http, "1.0.111", None);
    w.service.update_if_behind(copilot);
    assert_eq!(settle(&w, copilot).installed_version.as_deref(), Some("1.0.110"));

    // Without one, Kingu's copy follows the publisher's latest release, once per release.
    w.external.store(false, Ordering::SeqCst);
    let behind = w.service.status(copilot, true).unwrap();
    assert_eq!((behind.version.as_deref(), behind.installed_version.as_deref(), behind.installed_current), (Some("1.0.111"), Some("1.0.110"), false));
    w.service.update_if_behind(copilot);
    let updated = settle(&w, copilot);
    assert_eq!((updated.installed_version.as_deref(), updated.installed_current), (Some("1.0.111"), true));
    let kept: Vec<_> = std::fs::read_dir(w.service.root(copilot)).unwrap().flatten().map(|e| e.file_name().into_string().unwrap()).collect();
    assert_eq!(kept.len(), 2, "the release running chats may still use stays: {kept:?}");

    // Turned off (Orca's antigravityManagedAgyEnabled): the copy stays but runs nothing, counts as
    // no install, and is neither updated nor installed again.
    w.turned_off.store(true, Ordering::SeqCst);
    let off = w.service.status(copilot, true).unwrap();
    assert_eq!((off.source, off.available, off.installed_version.as_deref()), (None, false, Some("1.0.111")));
    assert!(w.service.runnable_command(copilot).is_none() && w.service.installed_command(copilot).is_some());
    assert!(w.service.provides(&["copilot".into()]).is_empty());
    assert_eq!(w.service.path_dirs().len(), 1, "a terminal's PATH keeps the folder, as Orca's does");
    assert!(w.service.install(copilot).unwrap_err().contains(AGY_SETTING));
    w.turned_off.store(false, Ordering::SeqCst);
    // A chat that will not stop keeps the copy it runs.
    w.chats_stuck.store(true, Ordering::SeqCst);
    let refused = w.service.remove(copilot).unwrap();
    let op = refused.operation.unwrap();
    assert_eq!((op.kind, op.phase, refused.installed_version.as_deref()), ("remove", Phase::Failed, Some("1.0.111")));
    assert!(op.error.is_some_and(|e| e.contains("GitHub Copilot chat")));
    assert!(w.service.root(copilot).exists());
    w.chats_stuck.store(false, Ordering::SeqCst);
    // Remove stops the agent's chats, then deletes Kingu's copies only.
    let removed = w.service.remove(copilot).unwrap();
    assert_eq!((removed.installed_version, removed.source, removed.operation.map(|o| (o.kind, o.phase))), (None, None, Some(("remove", Phase::Succeeded))));
    assert!(!w.service.root(copilot).exists());
    // Nothing installed: no update is ever started.
    w.service.update_if_behind(copilot);
    assert!(!w.service.root(copilot).exists());
  }

  #[test]
  fn a_failed_install_says_why_and_can_be_retried() {
    let w = world();
    let copilot = managed("copilot").unwrap();
    // The archive served is not the one the checksum list names.
    publish(&w.http, "1.0.110", Some(b"tampered bytes"));
    w.service.install(copilot).unwrap();
    let failed = settle(&w, copilot);
    let op = failed.operation.unwrap();
    assert_eq!((op.phase, failed.installed_version, failed.source), (Phase::Failed, None, None));
    assert!(op.error.as_deref().is_some_and(|e| e.contains("checksum") && e.contains("GitHub Copilot")), "{:?}", op.error);
    assert!(std::fs::read_dir(w.service.root(copilot)).unwrap().next().is_none(), "nothing is left in the install folder");
    // The publisher cannot be reached at all: the install fails with the lookup's reason.
    let offline = world();
    offline.service.install(copilot).unwrap();
    let op = settle(&offline, copilot).operation.unwrap();
    assert!(op.phase == Phase::Failed && op.error.is_some_and(|e| e.contains("latest GitHub Copilot release")));
    // A host the publisher has no build for is refused before anything runs.
    let kimi = managed("kimi").unwrap();
    let musl = Service::new(w._dir.path().join("musl"), Deps { target: Target { os: "linux", arch: "x86_64", musl: true }, http: w.http.clone(), validate: Arc::new(|_, _, _| Ok(())), external: Arc::new(|_| false), notify: Arc::new(|_| {}), stop_chats: Arc::new(|_| Ok(())), may_run: Arc::new(|_| true), free_bytes: Arc::new(|_| None), lookup_ttl: Duration::ZERO });
    assert!(musl.install(kimi).unwrap_err().contains("not available"));
    assert!(!musl.status(kimi, false).unwrap().available);
    // Retry with the real archive.
    publish(&w.http, "1.0.110", None);
    w.service.install(copilot).unwrap();
    assert_eq!(settle(&w, copilot).installed_version.as_deref(), Some("1.0.110"));
    assert!(w.service.cancel(copilot, 999).is_err(), "no such operation");
    assert!(known("nope").is_err());
  }

  #[test]
  fn kingus_folders_go_last_on_a_terminals_path() {
    // Without the app's service nothing changes.
    let mut env = std::collections::BTreeMap::from([("PATH".to_owned(), "/usr/bin".to_owned())]);
    terminal_env(&mut env, &[]);
    assert_eq!(env["PATH"], "/usr/bin");
    assert_eq!(installed_command("copilot"), None);
    assert!(provides(&["copilot".into()]).is_empty());
  }
}
