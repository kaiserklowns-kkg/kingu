//! Which agent runs a chat (`ChatMeta::runtime`), like old Kingu's structured chat: `claude` (the
//! Claude Agent SDK, built into the agent host), `arkai` (Kingu's own agent loop in the agent host,
//! on the user's model providers: `arkai.rs`), Codex over `codex app-server`, or an ACP agent
//! (Agent Client Protocol over stdio: Orca's chat agents — Gemini CLI, Qwen Code, OpenCode, goose,
//! Cursor, Hermes, Kiro, Auggie, Copilot, Kimi, Kilocode, MiMo Code, Droid, …). The user can add
//! ACP agents by command in `kingu.agent.acpAgents` (user settings only: a folder never names a
//! program to run). Only runtimes whose program is on the login-shell PATH (`shell_env`; or, for
//! a known agent, where its installer puts it) are offered; Rust resolves the program to
//! its absolute path, and the agent host runs only that.
//!
//! What a runtime cannot do is in its `Features`, so the chat hides it: the Claude SDK rewinds or
//! forks a session at a message, Arkai by its transcript (its conversation is the chat's
//! transcript, which a rewind cuts and a fork copies); both can switch the model mid-session.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::i18n::msg::RuntimeMsg;
use crate::tr;

pub const CLAUDE: &str = "claude";
/// User setting: ACP agents by id → command line (`{"my-agent": "my-agent --acp"}`).
pub const SETTING: &str = "kingu.agent.acpAgents";
const MAX_ID: usize = 40;
const MAX_CUSTOM: usize = 32;
const MAX_COMMAND: usize = 1024;

pub fn default_id() -> String {
  CLAUDE.into()
}

/// Runtime ids: lowercase letters, digits and `-`, 1-40 characters.
pub fn valid_id(id: &str) -> bool {
  !id.is_empty() && id.len() <= MAX_ID && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !id.starts_with('-')
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
  Claude,
  Acp,
  Codex,
  Arkai,
}

/// What the chat may offer for a runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Features {
  /// Restore checkpoint, Edit request, Retry and Fork (a session resumed at a message, or Arkai's
  /// conversation rebuilt from the cut transcript).
  pub rewind: bool,
  /// The model picker (a model per chat, switched mid-session).
  pub models: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RuntimeInfo {
  pub id: String,
  pub name: String,
  pub protocol: Protocol,
  pub features: Features,
  /// User-configured (`kingu.agent.acpAgents`).
  pub custom: bool,
}

/// What the agent host starts for a runtime other than the Claude SDK (`StartRequest::runtime`):
/// a program (`command`, `args`), or Arkai's provider and model (`arkai`, its fields next to `kind`).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Spec {
  pub kind: &'static str,
  #[serde(skip_serializing_if = "String::is_empty")]
  pub command: String,
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub args: Vec<String>,
  #[serde(flatten, skip_serializing_if = "Option::is_none")]
  pub arkai: Option<super::arkai::Wire>,
}

/// A folder an agent's own installer puts its program in, looked at after PATH (Orca's
/// `installDirectories`): `$var` when set, else `home` under the user's home (none: only when the
/// variable is set), then `sub` beneath it.
struct InstallDir {
  var: Option<&'static str>,
  home: Option<&'static str>,
  sub: &'static str,
}

const LOCAL_BIN: InstallDir = InstallDir { var: None, home: Some(".local/bin"), sub: "" };

struct Known {
  id: &'static str,
  name: &'static str,
  program: &'static str,
  args: &'static [&'static str],
  protocol: Protocol,
  /// Set for the agent's process, over the account's and the user's environment (Orca's spec `env`).
  env: &'static [(&'static str, &'static str)],
  /// Never inherited by the agent's process (Orca's `scrubEnvironment`).
  unset: &'static [&'static str],
  /// Ascending release-line floors (Orca's `minimumVersions`): an older program is refused.
  min_versions: &'static [&'static str],
  /// Arguments before `--version` (Orca's `versionArgs`).
  version_args: &'static [&'static str],
  install: &'static [InstallDir],
}

const fn known(id: &'static str, name: &'static str, program: &'static str, args: &'static [&'static str]) -> Known {
  Known { id, name, program, args, protocol: Protocol::Acp, env: &[], unset: &[], min_versions: &[], version_args: &[], install: &[] }
}

/// The agents Kingu knows how to start: Codex's app server, then Orca's ACP launch specs
/// (`main/acp/launch/acp-launch-registry.ts` and each agent's `*-acp-launch-spec.ts`, Orca 1.4.269):
/// the server command line, the environment it needs, the oldest release whose ACP server works and
/// where its installer puts the program. Antigravity is here on its host route only (`agy acp`).
/// `gemini`, `qwen`, `opencode`, `goose`, `grok` and `omp` keep the ids chats were saved with.
const KNOWN: &[Known] = &[
  Known { protocol: Protocol::Codex, ..known("codex", "Codex", "codex", &["app-server"]) },
  // `--approval-mode default` overrides a saved `defaultApprovalMode`; NO_BROWSER: signed out, Gemini
  // would open a browser and wait. 0.68.0 finishes replaying a loaded session before it answers.
  Known { env: &[("NO_BROWSER", "true")], min_versions: &["0.68.0"], ..known("gemini", "Gemini CLI", "gemini", &["--acp", "--approval-mode", "default"]) },
  Known { min_versions: &["0.16.0"], install: &[LOCAL_BIN], ..known("qwen", "Qwen Code", "qwen", &["--acp"]) },
  // 1.x cannot answer ACP questions.
  Known {
    env: &[("OPENCODE_CLIENT", "acp"), ("OPENCODE_ENABLE_QUESTION_TOOL", "false")],
    min_versions: &["1.18.31", "2.0.14"],
    install: &[InstallDir { var: None, home: Some(".opencode/bin"), sub: "" }],
    ..known("opencode", "OpenCode", "opencode", &["acp"])
  },
  Known {
    env: &[("OPENCODE_CLIENT", "acp"), ("OPENCODE_ENABLE_QUESTION_TOOL", "false")],
    min_versions: &["2.0.14"],
    install: &[InstallDir { var: None, home: Some(".opencode/bin"), sub: "" }],
    ..known("opencode2", "OpenCode 2", "opencode2", &["acp"])
  },
  // 1.42.0: the oldest release that reports its modes over ACP.
  Known { min_versions: &["1.42.0"], install: &[LOCAL_BIN], ..known("goose", "goose", "goose", &["acp"]) },
  Known { install: &[InstallDir { var: Some("GROK_HOME"), home: None, sub: "bin" }], ..known("grok", "Grok", "grok", &["agent", "stdio"]) },
  // PI_NO_PTY: a `pty: true` bash would open a TUI overlay ACP cannot draw.
  Known { env: &[("PI_NO_PTY", "1")], min_versions: &["17.0.5"], ..known("omp", "oh-my-pi", "omp", &["acp"]) },
  // An inherited allow-all would approve everything while the chat asks.
  Known { unset: &["COPILOT_ALLOW_ALL"], min_versions: &["1.0.88"], install: &[LOCAL_BIN], ..known("copilot", "GitHub Copilot", "copilot", &["--acp"]) },
  // A staged update would otherwise replace the binary when the chat starts.
  Known {
    env: &[("KIMI_CODE_NO_AUTO_UPDATE", "1")],
    min_versions: &["2.5.0"],
    install: &[InstallDir { var: None, home: Some(".kimi-code/bin"), sub: "" }],
    ..known("kimi", "Kimi", "kimi", &["acp"])
  },
  // The build hash parses as a prerelease: the day before the first ACP build Orca verified.
  Known { min_versions: &["2026.10.21"], install: &[LOCAL_BIN], ..known("cursor", "Cursor", "cursor-agent", &["--disable-auto-update", "acp"]) },
  // Bare `hermes --version` checks for updates over the network first.
  Known {
    min_versions: &["0.23.0"],
    version_args: &["acp"],
    install: &[LOCAL_BIN, InstallDir { var: Some("HERMES_HOME"), home: Some(".hermes"), sub: "bin" }],
    ..known("hermes", "Hermes", "hermes", &["acp"])
  },
  // The v2 engine speaks another protocol; `--auth-method cli` keeps tokens in `kiro-cli login`'s store.
  Known { min_versions: &["3.1.0"], install: &[LOCAL_BIN], ..known("kiro", "Kiro", "kiro-cli", &["acp", "--agent-engine", "v3", "--auth-method", "cli"]) },
  // 1.2.0 is the first release on the Pi rewrite; 0.x fails `session/new`.
  Known { min_versions: &["1.2.0"], ..known("aug", "Auggie", "auggie", &["--acp"]) },
  // OpenCode 1.x forks: their ACP cannot answer the question tool.
  Known { env: &[("KILO_ENABLE_QUESTION_TOOL", "false")], install: &[InstallDir { var: None, home: Some(".kilo/bin"), sub: "" }], ..known("kilo", "Kilocode", "kilo", &["acp"]) },
  Known {
    env: &[("MIMOCODE_ENABLE_QUESTION_TOOL", "false")],
    install: &[InstallDir { var: None, home: Some(".mimocode/bin"), sub: "" }],
    ..known("mimo-code", "MiMo Code", "mimo", &["acp"])
  },
  // An update never replaces the binary under a running chat. 0.236.0 first reports its autonomy level.
  Known {
    env: &[("DROID_DISABLE_AUTO_UPDATE", "true"), ("FACTORY_DROID_AUTO_UPDATE_ENABLED", "false")],
    min_versions: &["0.236.0"],
    install: &[LOCAL_BIN],
    ..known("droid", "Droid", "droid", &["exec", "--output-format", "acp"])
  },
  // Antigravity on `agy acp`, with agy's own sign-in (Orca's `ANTIGRAVITY_HOST_LAUNCH_SPEC`; its
  // other route, Kingu's managed ACP server, is antigravity.rs's and replaces this program and
  // environment when the route picks it, in `resolve` and `launch_env_for`). 1.5.2 is the first
  // release Orca verified. An inherited Gemini API key would switch agy to key auth, which its
  // models reject; a background update could replace agy under the chat.
  Known {
    env: &[("AGY_CLI_DISABLE_AUTO_UPDATE", "true")],
    unset: &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    min_versions: &["1.5.2"],
    install: &[LOCAL_BIN],
    ..known("antigravity", "Antigravity", "agy", &["acp"])
  },
];

/// What `<program> --version` said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
  Version(String),
  /// It ran but named no version (or failed, or took too long): the launch goes on, as in Orca.
  Unknown,
}

/// The machine a runtime is looked up on: the search PATH, the home folder, environment variables
/// and the `--version` reader. Tests give their own.
pub struct Host<'a> {
  pub path: Option<&'a OsStr>,
  pub home: Option<&'a Path>,
  pub env: &'a dyn Fn(&str) -> Option<String>,
  pub version: &'a dyn Fn(&Path, &[&str]) -> Probe,
  /// Kingu's own installed copy of an agent's program (managed_cli), by agent id.
  pub managed: &'a dyn Fn(&str) -> Option<PathBuf>,
}

fn install_dirs(k: &Known, host: &Host) -> Vec<PathBuf> {
  k.install
    .iter()
    .filter_map(|d| {
      let set = d.var.and_then(|v| (host.env)(v)).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()).map(PathBuf::from);
      let base = set.or_else(|| Some(host.home?.join(d.home?)))?;
      Some(if d.sub.is_empty() { base } else { base.join(d.sub) })
    })
    .collect()
}

/// The user's own install of a known agent: on PATH first, then in its installer's folders.
fn locate_own(k: &Known, host: &Host) -> Option<PathBuf> {
  locate(k.program, host.path).or_else(|| install_dirs(k, host).into_iter().map(|d| d.join(k.program)).find(|f| super::cli::is_executable(f)))
}

/// A known agent's program: the user's own install wins; Kingu's copy serves a machine that has
/// none (Orca `resolveStructuredAgentCommand`).
fn locate_known(k: &Known, host: &Host) -> Option<PathBuf> {
  locate_own(k, host).or_else(|| (host.managed)(k.id).filter(|f| super::cli::is_executable(f)))
}

// ---- versions (Orca shared/app-lifecycle/identity/app-version.ts) -------------------------------

type Version = ([u64; 3], Vec<String>);

/// `1.2.3`, `v1.2.3-rc.1+build`: the core numbers and the prerelease identifiers.
fn parse_version(v: &str) -> Option<Version> {
  let v = v.trim();
  let v = v.strip_prefix(['v', 'V']).unwrap_or(v);
  let v = v.split_once('+').map_or(v, |(a, _)| a);
  let (core, pre) = v.split_once('-').map_or((v, None), |(c, p)| (c, Some(p)));
  let mut n = core.split('.');
  let mut num = || n.next().filter(|x| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit())).and_then(|x| x.parse::<u64>().ok());
  let out = [num()?, num()?, num()?];
  if n.next().is_some() {
    return None;
  }
  Some((out, pre.map(|p| p.split('.').map(str::to_owned).collect()).unwrap_or_default()))
}

/// Whether `v` is a version Kingu can order (Orca `isValidAppVersion`).
pub(crate) fn is_version(v: &str) -> bool {
  parse_version(v).is_some()
}

/// Semver order; a prerelease sorts before its release. Unparsable versions compare equal (Orca).
pub(crate) fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
  use std::cmp::Ordering::*;
  let (Some((lc, lp)), Some((rc, rp))) = (parse_version(left), parse_version(right)) else { return Equal };
  if lc != rc {
    return lc.cmp(&rc);
  }
  match (lp.is_empty(), rp.is_empty()) {
    (true, true) => return Equal,
    (true, false) => return Greater,
    (false, true) => return Less,
    _ => {}
  }
  for i in 0..lp.len().max(rp.len()) {
    let (Some(l), Some(r)) = (lp.get(i), rp.get(i)) else { return if lp.len() < rp.len() { Less } else { Greater } };
    let num = |x: &str| (!x.is_empty() && x.bytes().all(|b| b.is_ascii_digit())).then(|| x.parse::<u64>().ok()).flatten();
    let c = match (num(l), num(r)) {
      (Some(a), Some(b)) => a.cmp(&b),
      (Some(_), None) => Less,
      (None, Some(_)) => Greater,
      (None, None) => l.cmp(r),
    };
    if c != Equal {
      return c;
    }
  }
  Equal
}

/// The first semver in `--version` output (Orca `parseCliVersion`): not inside a longer word or a
/// four-part number; a sentence may end on it ("GitHub Copilot CLI 1.0.109.").
pub fn parse_cli_version(output: &str) -> Option<String> {
  let b = output.as_bytes();
  let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
  let tail = |c: u8| c.is_ascii_alphanumeric() || c == b'.' || c == b'-';
  let digits = |mut i: usize| {
    let s = i;
    while i < b.len() && b[i].is_ascii_digit() {
      i += 1;
    }
    (i > s).then_some(i)
  };
  for at in 0..b.len() {
    if at > 0 && (word(b[at - 1]) || b[at - 1] == b'.' || b[at - 1] == b'-') {
      continue;
    }
    let start = if b[at] == b'v' { at + 1 } else { at };
    let Some(mut end) = digits(start).filter(|&i| b.get(i) == Some(&b'.')).and_then(|i| digits(i + 1)).filter(|&i| b.get(i) == Some(&b'.')).and_then(|i| digits(i + 1)) else { continue };
    for mark in [b'-', b'+'] {
      if b.get(end) == Some(&mark) && b.get(end + 1).is_some_and(|&c| tail(c)) {
        end += 1;
        while end < b.len() && tail(b[end]) {
          end += 1;
        }
      }
    }
    let after = b.get(end).copied();
    if after.is_some_and(|c| word(c) || c == b'+' || c == b'-') || (after == Some(b'.') && b.get(end + 1).is_some_and(|&c| word(c))) {
      continue;
    }
    let v = &output[start..end];
    if parse_version(v).is_some() {
      return Some(v.to_owned());
    }
  }
  None
}

/// The floor for `version`'s release line: the last one at or below its major, else the first
/// (Orca `agentCliMinimumVersion`).
pub(crate) fn minimum_for<'a>(version: &str, minimums: &[&'a str]) -> Option<&'a str> {
  let major = |v: &str| v.trim_start_matches(['v', 'V']).split('.').next().and_then(|m| m.parse::<u64>().ok()).unwrap_or(0);
  minimums.iter().rev().find(|m| major(m) <= major(version)).or(minimums.first()).copied()
}

/// At most this many `--version` probes run at once (Orca 5d34df718, `versionReads =
/// new PrioritySemaphore(3)` in `agent-cli-update-service.ts`): each starts a whole CLI runtime,
/// often Node, and chats restored or started together would otherwise spike memory and CPU.
const VERSION_PROBES: usize = 3;

/// A counting gate: [`Gate::enter`] waits while `limit` holders are inside.
pub(crate) struct Gate {
  inside: std::sync::Mutex<usize>,
  freed: std::sync::Condvar,
  limit: usize,
}

pub(crate) struct GatePass<'a>(&'a Gate);

impl Gate {
  pub(crate) const fn new(limit: usize) -> Gate {
    Gate { inside: std::sync::Mutex::new(0), freed: std::sync::Condvar::new(), limit }
  }

  pub(crate) fn enter(&self) -> GatePass<'_> {
    let mut n = self.inside.lock().unwrap_or_else(|e| e.into_inner());
    while *n >= self.limit {
      n = self.freed.wait(n).unwrap_or_else(|e| e.into_inner());
    }
    *n += 1;
    GatePass(self)
  }
}

impl Drop for GatePass<'_> {
  fn drop(&mut self) {
    let mut n = self.0.inside.lock().unwrap_or_else(|e| e.into_inner());
    *n = n.saturating_sub(1);
    self.0.freed.notify_one();
  }
}

static VERSION_GATE: Gate = Gate::new(VERSION_PROBES);

/// `<program> [args…] --version` with the login-shell PATH: at most 5 s and 4 KiB, exit 0 (Orca
/// `readAgentCliVersion`). Asked at every start: PATH may name another release since the last one.
/// At most [`VERSION_PROBES`] run at once; the rest wait their turn.
pub fn read_version(program: &Path, args: &[&str]) -> Probe {
  let _pass = VERSION_GATE.enter();
  probe_version(program, args)
}

fn probe_version(program: &Path, args: &[&str]) -> Probe {
  use std::io::Read;
  use std::process::Stdio;
  let Ok(mut child) = crate::shell_env::command(program).args(args).arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() else {
    return Probe::Unknown;
  };
  let start = std::time::Instant::now();
  let status = loop {
    match child.try_wait() {
      Ok(Some(s)) => break s,
      Ok(None) if start.elapsed() < std::time::Duration::from_secs(5) => std::thread::sleep(std::time::Duration::from_millis(25)),
      _ => {
        let _ = child.kill();
        let _ = child.wait();
        return Probe::Unknown;
      }
    }
  };
  let read = |pipe: Option<&mut dyn Read>| {
    let mut buf = Vec::new();
    if let Some(p) = pipe {
      let _ = p.take(4097).read_to_end(&mut buf);
    }
    buf
  };
  let out = read(child.stdout.as_mut().map(|p| p as &mut dyn Read));
  let err = read(child.stderr.as_mut().map(|p| p as &mut dyn Read));
  if !status.success() || out.len() + err.len() > 4096 {
    return Probe::Unknown;
  }
  let text = format!("{}\n{}", String::from_utf8_lossy(&out), String::from_utf8_lossy(&err));
  parse_cli_version(&text).map_or(Probe::Unknown, Probe::Version)
}

fn features(p: Protocol) -> Features {
  let own = matches!(p, Protocol::Claude | Protocol::Arkai);
  Features { rewind: own, models: true }
}

/// A user-configured ACP agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Custom {
  pub id: String,
  pub argv: Vec<String>,
}

/// Splits a command line into words: whitespace separates, `'…'` and `"…"` group (no escapes).
/// None for an unclosed quote.
pub fn split_command(line: &str) -> Option<Vec<String>> {
  let mut words = Vec::new();
  let mut cur = String::new();
  let mut in_word = false;
  let mut quote: Option<char> = None;
  for c in line.chars() {
    match quote {
      Some(q) if c == q => quote = None,
      Some(_) => cur.push(c),
      None if c == '\'' || c == '"' => {
        quote = Some(c);
        in_word = true;
      }
      None if c.is_whitespace() => {
        if in_word {
          words.push(std::mem::take(&mut cur));
          in_word = false;
        }
      }
      None => {
        cur.push(c);
        in_word = true;
      }
    }
  }
  if quote.is_some() {
    return None;
  }
  if in_word {
    words.push(cur);
  }
  Some(words)
}

/// The user's ACP agents out of the setting's value; bad entries (and ids of Kingu's own runtimes) are skipped.
pub fn custom_agents(value: Option<&serde_json::Value>) -> Vec<Custom> {
  let Some(map) = value.and_then(|v| v.as_object()) else { return Vec::new() };
  let mut out = Vec::new();
  for (id, v) in map.iter().take(MAX_CUSTOM) {
    let taken = id == CLAUDE || id == super::arkai::RUNTIME || KNOWN.iter().any(|k| k.id == id);
    let Some(line) = v.as_str().filter(|l| l.len() <= MAX_COMMAND && !l.contains('\0')) else { continue };
    match split_command(line) {
      Some(argv) if valid_id(id) && !taken && !argv.is_empty() => out.push(Custom { id: id.clone(), argv }),
      _ => log::warn!("{SETTING}: {id}: skipped (needs a lowercase id and a command)"),
    }
  }
  out
}

/// `program` as an executable: an absolute path as is, a bare name in a folder of `path`.
fn locate(program: &str, path: Option<&OsStr>) -> Option<PathBuf> {
  let p = Path::new(program);
  if p.is_absolute() {
    return super::cli::is_executable(p).then(|| p.to_path_buf());
  }
  if program.contains('/') || program.is_empty() {
    return None;
  }
  std::env::split_paths(path?).map(|d| d.join(program)).find(|f| super::cli::is_executable(f))
}

/// The runtimes that can run here: the Claude SDK and Arkai first (always: both live in the agent
/// host), then each known agent whose program is on PATH or where its installer puts it, and each
/// configured ACP agent whose program is on PATH. A release too old for chats is still listed:
/// starting it says which one is needed (`resolve`).
pub fn available_on(host: &Host, custom: &[Custom]) -> Vec<RuntimeInfo> {
  let mut out = vec![
    RuntimeInfo { id: CLAUDE.into(), name: "Claude Code".into(), protocol: Protocol::Claude, features: features(Protocol::Claude), custom: false },
    RuntimeInfo { id: super::arkai::RUNTIME.into(), name: "Arkai".into(), protocol: Protocol::Arkai, features: features(Protocol::Arkai), custom: false },
  ];
  for k in KNOWN.iter().filter(|k| locate_known(k, host).is_some()) {
    out.push(RuntimeInfo { id: k.id.into(), name: k.name.into(), protocol: k.protocol, features: features(k.protocol), custom: false });
  }
  for c in custom.iter().filter(|c| locate(&c.argv[0], host.path).is_some()) {
    out.push(RuntimeInfo { id: c.id.clone(), name: c.id.clone(), protocol: Protocol::Acp, features: features(Protocol::Acp), custom: true });
  }
  out
}

/// What the agent host runs for runtime `id`: None for the Claude SDK, else the program found.
/// A known agent older than its release line's floor is refused with both versions (Orca's
/// `AgentCliInstallationError.tooOld`); one whose version cannot be read starts.
pub fn resolve_on(id: &str, host: &Host, custom: &[Custom]) -> Result<Option<Spec>, String> {
  if id == CLAUDE {
    return Ok(None);
  }
  if let Some(k) = KNOWN.iter().find(|k| k.id == id) {
    let found = locate_known(k, host).ok_or_else(|| tr!(RuntimeMsg::NotFound, name = k.name, program = k.program))?;
    let command = found.to_str().ok_or_else(|| tr!(RuntimeMsg::NotFound, name = k.name, program = k.program))?.to_owned();
    if !k.min_versions.is_empty() {
      if let Probe::Version(installed) = (host.version)(&found, k.version_args) {
        if let Some(minimum) = minimum_for(&installed, k.min_versions).filter(|m| compare_versions(&installed, m).is_lt()) {
          return Err(tr!(RuntimeMsg::TooOld, name = k.name, installed, minimum));
        }
      }
    }
    let kind = if k.protocol == Protocol::Codex { "codex" } else { "acp" };
    return Ok(Some(Spec { kind, command, args: k.args.iter().map(|a| (*a).to_owned()).collect(), arkai: None }));
  }
  let c = custom.iter().find(|c| c.id == id).ok_or_else(|| tr!(RuntimeMsg::Unknown, id))?;
  let found = locate(&c.argv[0], host.path).ok_or_else(|| tr!(RuntimeMsg::NotFound, name = c.id, program = c.argv[0]))?;
  let command = found.to_str().ok_or_else(|| tr!(RuntimeMsg::NotFound, name = c.id, program = c.argv[0]))?.to_owned();
  Ok(Some(Spec { kind: "acp", command, args: c.argv[1..].to_vec(), arkai: None }))
}

fn with_host<T>(path: Option<&OsStr>, f: impl FnOnce(&Host) -> T) -> T {
  let home = std::env::var_os("HOME").map(PathBuf::from);
  f(&Host { path, home: home.as_deref(), env: &|k| std::env::var(k).ok(), version: &read_version, managed: &super::managed_cli::installed_command })
}

/// Release-line floors of known agent `id` (none for an agent without one).
pub(crate) fn min_versions(id: &str) -> &'static [&'static str] {
  KNOWN.iter().find(|k| k.id == id).map(|k| k.min_versions).unwrap_or(&[])
}

/// The program a known agent's launch looks for.
#[cfg(test)]
pub(crate) fn program_of(id: &str) -> Option<&'static str> {
  KNOWN.iter().find(|k| k.id == id).map(|k| k.program)
}

/// Whether this machine has the user's own install of known agent `id` (PATH, its installer's
/// folders). A copy of Kingu's reached through a PATH a Kingu terminal passed on is not one.
pub(crate) fn users_own(id: &str) -> bool {
  let Some(k) = KNOWN.iter().find(|k| k.id == id) else { return false };
  with_host(crate::shell_env::path().as_deref(), |h| locate_own(k, h)).is_some_and(|found| !super::managed_cli::is_managed_path(id, &found))
}

/// Whether known agent `id`'s own program is found here (the user's or Kingu's copy).
pub(crate) fn locates(id: &str) -> bool {
  let Some(k) = KNOWN.iter().find(|k| k.id == id) else { return false };
  with_host(crate::shell_env::path().as_deref(), |h| locate_known(k, h)).is_some()
}

/// [`available_on`] this machine; Antigravity also when only Kingu's server can run it.
pub fn available(path: Option<&OsStr>, custom: &[Custom]) -> Vec<RuntimeInfo> {
  let mut out = with_host(path, |h| available_on(h, custom));
  let id = super::antigravity::RUNTIME_ID;
  if !out.iter().any(|r| r.id == id) && super::antigravity::server_command().is_some() && super::antigravity::current_route(false) == super::antigravity::Route::Server {
    let at = out.iter().position(|r| r.custom).unwrap_or(out.len());
    out.insert(at, RuntimeInfo { id: id.into(), name: "Antigravity".into(), protocol: Protocol::Acp, features: features(Protocol::Acp), custom: false });
  }
  out
}

/// Antigravity's launch on Kingu's server (antigravity.rs `current_route`): its program, or why
/// it can't start (not installed: the chat offers Install). None: the route runs agy.
fn antigravity_server(agy_found: bool) -> Option<Result<Spec, String>> {
  use super::antigravity as ag;
  (ag::current_route(agy_found) == ag::Route::Server).then(|| {
    let command = ag::server_command().and_then(|p| p.to_str().map(str::to_owned)).ok_or_else(|| tr!(RuntimeMsg::NotFound, name = "Antigravity", program = "agy_acp_server"))?;
    // A key chat with no key, or Agent Platform with no project, can't sign in: said before it starts.
    {
      use super::antigravity_auth as auth;
      auth::current().and_then(|a| auth::launch(&a, &auth::process_env, &auth::home(), &auth::KeyStore))?;
    }
    Ok(Spec { kind: "acp", command, args: ag::server_args(), arkai: None })
  })
}

/// [`resolve_on`] this machine.
pub fn resolve(id: &str, path: Option<&OsStr>, custom: &[Custom]) -> Result<Option<Spec>, String> {
  if id == super::antigravity::RUNTIME_ID {
    let agy_found = KNOWN.iter().find(|k| k.id == id).is_some_and(|k| with_host(path, |h| locate_known(k, h)).is_some());
    if let Some(server) = antigravity_server(agy_found) {
      return server.map(Some);
    }
  }
  let spec = with_host(path, |h| resolve_on(id, h, custom))?;
  // A launch on Kingu's own copy is what keeps that copy updated (managed_cli).
  if let Some(spec) = &spec {
    super::managed_cli::note_use(id, Path::new(&spec.command));
  }
  Ok(spec)
}

/// The environment a known agent's process gets besides the user's: variables set over it and
/// variables it must not inherit (Orca's spec `env` and `scrubEnvironment`). Nothing for the
/// Claude SDK, Arkai, Codex and configured agents.
#[cfg(test)]
pub fn launch_env(id: &str) -> crate::accounts::store::AgentEnv {
  launch_env_for(id, None)
}

/// [`launch_env`] for the program `spec` resolved to: Kingu's Antigravity server gets its own
/// (antigravity.rs `server_env`: its home, sign-in capture, no inherited Google auth).
pub fn launch_env_for(id: &str, spec: Option<&Spec>) -> crate::accounts::store::AgentEnv {
  if spec.is_some_and(|s| super::managed_cli::is_managed_path(super::antigravity::SERVER_ID, Path::new(&s.command))) {
    match super::managed_cli::data_dir().map(|d| super::antigravity::server_env(&d, std::env::vars().map(|(k, _)| k))) {
      Some(Ok(env)) => return env,
      Some(Err(e)) => log::warn!("antigravity: server home not prepared: {e}"),
      None => {}
    }
  }
  let mut env = crate::accounts::store::AgentEnv::default();
  if let Some(k) = KNOWN.iter().find(|k| k.id == id) {
    env.set.extend(k.env.iter().map(|(n, v)| ((*n).to_owned(), (*v).to_owned())));
    env.unset.extend(k.unset.iter().map(|n| (*n).to_owned()));
  }
  env
}

/// Whether runtime `id` can rewind (`Features::rewind`); unknown ids cannot.
pub fn can_rewind(id: &str) -> bool {
  id == CLAUDE || id == super::arkai::RUNTIME
}

/// The configured ACP agents (user settings).
pub fn configured(config_dir: &Path) -> Vec<Custom> {
  custom_agents(crate::settings::user_value(config_dir, SETTING).as_ref())
}

/// The chat's runtime picker: the runtimes found on the login-shell PATH.
#[tauri::command]
pub async fn agent_runtimes(app: tauri::AppHandle) -> Result<Vec<RuntimeInfo>, String> {
  use tauri::Manager;
  let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
  tauri::async_runtime::spawn_blocking(move || available(crate::shell_env::path().as_deref(), &configured(&config))).await.map_err(|e| e.to_string())
}

#[cfg(all(test, unix))]
mod tests {
  use super::*;
  use serde_json::json;
  use std::os::unix::fs::PermissionsExt;

  fn exe(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
  }

  /// A machine with nothing but `path` (and `home`): no variables, versions as `version` says.
  fn host<'a>(path: Option<&'a OsStr>, home: Option<&'a Path>, version: &'a dyn Fn(&Path, &[&str]) -> Probe) -> Host<'a> {
    Host { path, home, env: &|_| None, version, managed: &|_| None }
  }
  const NO_VERSION: &dyn Fn(&Path, &[&str]) -> Probe = &|_, _| Probe::Unknown;

  #[test]
  fn only_runtimes_on_path_are_offered() {
    let bin = tempfile::tempdir().unwrap();
    exe(bin.path(), "gemini");
    exe(bin.path(), "codex");
    exe(bin.path(), "my-acp");
    std::fs::write(bin.path().join("qwen"), "not executable").unwrap();
    let custom = custom_agents(Some(&json!({"mine": "my-acp --stdio 'two words'", "gone": "missing-agent", "codex": "evil", "cursor": "evil", "Bad Id": "x"})));
    assert_eq!(custom, [Custom { id: "mine".into(), argv: vec!["my-acp".into(), "--stdio".into(), "two words".into()] }, Custom { id: "gone".into(), argv: vec!["missing-agent".into()] }]);
    let path = bin.path().as_os_str();
    let ids: Vec<_> = available_on(&host(Some(path), None, NO_VERSION), &custom).into_iter().map(|r| (r.id, r.protocol, r.features.rewind)).collect();
    assert_eq!(
      ids,
      [
        ("claude".into(), Protocol::Claude, true),
        ("arkai".into(), Protocol::Arkai, true),
        ("codex".into(), Protocol::Codex, false),
        ("gemini".into(), Protocol::Acp, false),
        ("mine".into(), Protocol::Acp, false)
      ]
    );
    let none = available_on(&host(None, None, NO_VERSION), &[]);
    assert_eq!(none.len(), 2, "Claude Code and Arkai are built in");
    assert!(none[1].features.models, "Arkai switches models");
  }

  #[test]
  fn at_most_three_version_probes_run_at_once() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    let gate = Arc::new(Gate::new(VERSION_PROBES));
    let (now, most) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let threads: Vec<_> = (0..9)
      .map(|_| {
        let (gate, now, most) = (gate.clone(), now.clone(), most.clone());
        std::thread::spawn(move || {
          let _pass = gate.enter();
          let n = now.fetch_add(1, Ordering::SeqCst) + 1;
          most.fetch_max(n, Ordering::SeqCst);
          std::thread::sleep(std::time::Duration::from_millis(20));
          now.fetch_sub(1, Ordering::SeqCst);
        })
      })
      .collect();
    for t in threads {
      t.join().unwrap();
    }
    assert_eq!(most.load(Ordering::SeqCst), VERSION_PROBES);
  }

  #[test]
  fn resolves_to_the_absolute_program() {
    let bin = tempfile::tempdir().unwrap();
    let gemini = exe(bin.path(), "gemini");
    let codex = exe(bin.path(), "codex");
    let h = host(Some(bin.path().as_os_str()), None, NO_VERSION);
    assert_eq!(resolve_on("claude", &h, &[]), Ok(None));
    assert_eq!(resolve_on("gemini", &h, &[]).unwrap(), Some(Spec { kind: "acp", command: gemini.display().to_string(), args: vec!["--acp".into(), "--approval-mode".into(), "default".into()], arkai: None }));
    assert_eq!(resolve_on("codex", &h, &[]).unwrap().unwrap().args, ["app-server"]);
    assert_eq!(resolve_on("codex", &h, &[]).unwrap().unwrap().command, codex.display().to_string());
    assert!(resolve_on("qwen", &h, &[]).unwrap_err().contains("qwen"));
    assert!(resolve_on("nope", &h, &[]).is_err());
    let abs = Custom { id: "abs".into(), argv: vec![gemini.display().to_string(), "acp".into()] };
    assert_eq!(resolve_on("abs", &host(None, None, NO_VERSION), &[abs]).unwrap().unwrap().args, ["acp"]);
    let rel = Custom { id: "rel".into(), argv: vec!["./gemini".into()] };
    assert!(resolve_on("rel", &h, &[rel]).is_err(), "a relative path is not looked up");
  }

  /// Orca's ACP launch specs (acp-launch-registry.ts, */*-acp-launch-spec.ts): command lines and environment.
  #[test]
  fn orcas_chat_agents_start_with_orcas_command_lines() {
    let bin = tempfile::tempdir().unwrap();
    let want: &[(&str, &str, &[&str])] = &[
      ("cursor", "cursor-agent", &["--disable-auto-update", "acp"]),
      ("hermes", "hermes", &["acp"]),
      ("kiro", "kiro-cli", &["acp", "--agent-engine", "v3", "--auth-method", "cli"]),
      ("aug", "auggie", &["--acp"]),
      ("goose", "goose", &["acp"]),
      ("kilo", "kilo", &["acp"]),
      ("mimo-code", "mimo", &["acp"]),
      ("droid", "droid", &["exec", "--output-format", "acp"]),
      ("kimi", "kimi", &["acp"]),
      ("copilot", "copilot", &["--acp"]),
      ("qwen", "qwen", &["--acp"]),
      ("opencode", "opencode", &["acp"]),
      ("opencode2", "opencode2", &["acp"]),
      ("omp", "omp", &["acp"]),
      ("grok", "grok", &["agent", "stdio"]),
      ("antigravity", "agy", &["acp"]),
    ];
    for (_, program, _) in want {
      exe(bin.path(), program);
    }
    let h = host(Some(bin.path().as_os_str()), None, NO_VERSION);
    for (id, program, args) in want {
      let spec = resolve_on(id, &h, &[]).unwrap().unwrap();
      assert_eq!((spec.kind, spec.command, spec.args), ("acp", bin.path().join(program).display().to_string(), args.iter().map(|a| a.to_string()).collect::<Vec<_>>()), "{id}");
    }
    let listed: Vec<_> = available_on(&h, &[]).into_iter().map(|r| r.id).collect();
    assert!(want.iter().all(|(id, ..)| listed.iter().any(|l| l == id)), "{listed:?}");
    assert!(KNOWN.iter().all(|k| valid_id(k.id)) && KNOWN.iter().all(|k| k.env.iter().all(|(n, _)| n.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'))));

    let env = |id: &str| launch_env(id);
    assert_eq!(env("gemini").set, [("NO_BROWSER".to_owned(), "true".to_owned())].into());
    assert_eq!(env("kilo").set, [("KILO_ENABLE_QUESTION_TOOL".to_owned(), "false".to_owned())].into());
    assert_eq!(env("mimo-code").set, [("MIMOCODE_ENABLE_QUESTION_TOOL".to_owned(), "false".to_owned())].into());
    assert_eq!(env("kimi").set, [("KIMI_CODE_NO_AUTO_UPDATE".to_owned(), "1".to_owned())].into());
    assert_eq!(env("droid").set, [("DROID_DISABLE_AUTO_UPDATE".to_owned(), "true".to_owned()), ("FACTORY_DROID_AUTO_UPDATE_ENABLED".to_owned(), "false".to_owned())].into());
    assert_eq!(env("opencode").set, env("opencode2").set);
    assert_eq!(env("opencode").set.get("OPENCODE_ENABLE_QUESTION_TOOL").map(String::as_str), Some("false"));
    assert_eq!(env("omp").set, [("PI_NO_PTY".to_owned(), "1".to_owned())].into());
    assert_eq!(env("copilot").unset, ["COPILOT_ALLOW_ALL"]);
    assert_eq!((env("antigravity").set, env("antigravity").unset), ([("AGY_CLI_DISABLE_AUTO_UPDATE".to_owned(), "true".to_owned())].into(), vec!["GEMINI_API_KEY".to_owned(), "GOOGLE_API_KEY".to_owned()]));
    for id in ["claude", "arkai", "codex", "cursor", "mine"] {
      assert!(env(id).set.is_empty() && env(id).unset.is_empty(), "{id}");
    }
  }

  #[test]
  fn a_program_off_path_is_found_where_its_installer_puts_it() {
    let home = tempfile::tempdir().unwrap();
    let bin = tempfile::tempdir().unwrap();
    for dir in [".local/bin", ".kilo/bin", ".mimocode/bin", ".kimi-code/bin", ".opencode/bin", ".hermes/bin", "grok-home/bin"] {
      std::fs::create_dir_all(home.path().join(dir)).unwrap();
    }
    let cursor = exe(&home.path().join(".local/bin"), "cursor-agent");
    exe(&home.path().join(".local/bin"), "auggie");
    exe(&home.path().join(".local/bin"), "gemini");
    exe(&home.path().join(".kilo/bin"), "kilo");
    exe(&home.path().join(".mimocode/bin"), "mimo");
    exe(&home.path().join(".kimi-code/bin"), "kimi");
    exe(&home.path().join(".opencode/bin"), "opencode");
    let hermes = exe(&home.path().join(".hermes/bin"), "hermes");
    let grok = exe(&home.path().join("grok-home/bin"), "grok");
    let h = host(Some(bin.path().as_os_str()), Some(home.path()), NO_VERSION);
    let ids: Vec<_> = available_on(&h, &[]).into_iter().skip(2).map(|r| r.id).collect();
    assert_eq!(ids, ["opencode", "kimi", "cursor", "hermes", "kilo", "mimo-code"], "auggie and gemini have no install folder; grok's needs GROK_HOME");
    assert_eq!(resolve_on("cursor", &h, &[]).unwrap().unwrap().command, cursor.display().to_string());
    assert_eq!(resolve_on("hermes", &h, &[]).unwrap().unwrap().command, hermes.display().to_string());

    // PATH wins over the install folder; a variable moves the folder.
    let on_path = exe(bin.path(), "cursor-agent");
    assert_eq!(resolve_on("cursor", &h, &[]).unwrap().unwrap().command, on_path.display().to_string());
    let grok_home = home.path().join("grok-home").display().to_string();
    let elsewhere = home.path().join("nowhere").display().to_string();
    let env = move |k: &str| match k {
      "GROK_HOME" => Some(format!(" {grok_home} ")),
      "HERMES_HOME" => Some(elsewhere.clone()),
      _ => None,
    };
    let moved = Host { path: Some(bin.path().as_os_str()), home: Some(home.path()), env: &env, version: NO_VERSION, managed: &|_| None };
    assert_eq!(resolve_on("grok", &moved, &[]).unwrap().unwrap().command, grok.display().to_string());
    assert!(resolve_on("hermes", &moved, &[]).is_err(), "HERMES_HOME replaces ~/.hermes");
  }

  /// Orca `resolveStructuredAgentCommand`: the user's own install wins; Kingu's copy serves a machine without one.
  #[test]
  fn kingus_own_copy_runs_only_where_the_user_has_none() {
    let home = tempfile::tempdir().unwrap();
    let bin = tempfile::tempdir().unwrap();
    let kingu = tempfile::tempdir().unwrap();
    let managed_cursor = exe(kingu.path(), "cursor-agent");
    let managed_opencode = exe(kingu.path(), "opencode");
    std::fs::write(kingu.path().join("copilot"), "not executable").unwrap();
    let managed = |id: &str| match id {
      "cursor" => Some(kingu.path().join("cursor-agent")),
      // OpenCode 2's release ships `opencode`; the launch still looks for the user's `opencode2` first.
      "opencode2" => Some(kingu.path().join("opencode")),
      "copilot" => Some(kingu.path().join("copilot")),
      "kimi" => Some(kingu.path().join("gone")),
      _ => None,
    };
    let h = Host { path: Some(bin.path().as_os_str()), home: Some(home.path()), env: &|_| None, version: NO_VERSION, managed: &managed };
    let ids: Vec<_> = available_on(&h, &[]).into_iter().skip(2).map(|r| r.id).collect();
    assert_eq!(ids, ["opencode2", "cursor"], "a copy that is not an executable file is no install");
    assert_eq!(resolve_on("cursor", &h, &[]).unwrap().unwrap().command, managed_cursor.display().to_string());
    assert_eq!(resolve_on("opencode2", &h, &[]).unwrap().unwrap(), Spec { kind: "acp", command: managed_opencode.display().to_string(), args: vec!["acp".into()], arkai: None });
    assert!(resolve_on("copilot", &h, &[]).is_err() && resolve_on("kimi", &h, &[]).is_err() && resolve_on("opencode", &h, &[]).is_err());
    // The installer's folder, then PATH, each outrank Kingu's copy.
    std::fs::create_dir_all(home.path().join(".local/bin")).unwrap();
    let installed = exe(&home.path().join(".local/bin"), "cursor-agent");
    assert_eq!(resolve_on("cursor", &h, &[]).unwrap().unwrap().command, installed.display().to_string());
    let on_path = exe(bin.path(), "cursor-agent");
    assert_eq!(resolve_on("cursor", &h, &[]).unwrap().unwrap().command, on_path.display().to_string());
    // Kingu's copy is held to the same release floor as any other.
    std::fs::remove_file(&on_path).unwrap();
    std::fs::remove_file(&installed).unwrap();
    let old = |_: &Path, _: &[&str]| Probe::Version("2026.10.01-abc".into());
    let h = Host { version: &old, ..h };
    assert!(resolve_on("cursor", &h, &[]).unwrap_err().contains("2026.10.21"));
    assert_eq!((min_versions("opencode"), min_versions("cursor"), min_versions("kilo"), min_versions("nope")), (&["1.18.31", "2.0.14"][..], &["2026.10.21"][..], &[][..], &[][..]));
    assert_eq!((program_of("cursor"), program_of("antigravity"), program_of("nope")), (Some("cursor-agent"), Some("agy"), None));
  }

  #[test]
  fn a_release_too_old_for_chats_is_refused_with_both_versions() {
    let bin = tempfile::tempdir().unwrap();
    for p in ["gemini", "opencode", "hermes", "kilo", "cursor-agent"] {
      exe(bin.path(), p);
    }
    let asked = std::cell::RefCell::new(Vec::<(String, Vec<String>)>::new());
    let said = std::cell::Cell::new("0.67.9");
    let version = |p: &Path, args: &[&str]| {
      asked.borrow_mut().push((p.file_name().unwrap().to_string_lossy().into_owned(), args.iter().map(|a| a.to_string()).collect()));
      if said.get().is_empty() { Probe::Unknown } else { Probe::Version(said.get().to_owned()) }
    };
    let h = host(Some(bin.path().as_os_str()), None, &version);
    let err = resolve_on("gemini", &h, &[]).unwrap_err();
    assert!(err.contains("Gemini CLI") && err.contains("0.67.9") && err.contains("0.68.0"), "{err}");
    said.set("0.68.0");
    assert!(resolve_on("gemini", &h, &[]).is_ok());
    // OpenCode: each release line has its own floor; an older major falls to the first.
    for (v, ok) in [("1.18.30", false), ("1.18.31", true), ("2.0.13", false), ("2.0.14", true), ("3.0.0", true), ("0.9.0", false)] {
      said.set(v);
      assert_eq!(resolve_on("opencode", &h, &[]).is_ok(), ok, "opencode {v}");
    }
    said.set("2.0.13");
    assert!(resolve_on("opencode", &h, &[]).unwrap_err().contains("2.0.14"));
    // Cursor's build hash is a prerelease of its day.
    for (v, ok) in [("2026.10.21-abc123", false), ("2026.10.22-abc123", true), ("2026.11.02-f00", true)] {
      said.set(v);
      assert_eq!(resolve_on("cursor", &h, &[]).is_ok(), ok, "cursor {v}");
    }
    // A version that cannot be read starts; an agent without a floor is not asked.
    said.set("");
    assert!(resolve_on("gemini", &h, &[]).is_ok());
    asked.borrow_mut().clear();
    assert!(resolve_on("kilo", &h, &[]).is_ok());
    assert!(asked.borrow().is_empty());
    assert!(resolve_on("hermes", &h, &[]).is_ok());
    assert_eq!(*asked.borrow(), [("hermes".to_owned(), vec!["acp".to_owned()])], "bare `hermes --version` goes to the network");
  }

  /// Orca app-version.ts `parseCliVersion` / `compareAppVersions`.
  #[test]
  fn versions_are_read_out_of_version_output() {
    for (out, v) in [
      ("2.1.80 (Claude Code)", Some("2.1.80")),
      ("GitHub Copilot CLI 1.0.109.", Some("1.0.109")),
      ("opencode v1.18.31\n", Some("1.18.31")),
      ("kiro-cli 3.1.0-beta.2+build.5", Some("3.1.0-beta.2+build.5")),
      ("2026.10.22-abc123", Some("2026.10.22-abc123")),
      ("Python 3.12.1.4", None),
      ("node18 x1.2.3 lib-1.2.3", None),
      ("warning: 10.0\nagent 0.68.0 (linux)", Some("0.68.0")),
      ("", None),
    ] {
      assert_eq!(parse_cli_version(out).as_deref(), v, "{out:?}");
    }
    use std::cmp::Ordering::*;
    for (l, r, want) in [("1.2.3", "1.2.3", Equal), ("1.2.10", "1.2.9", Greater), ("v1.2.3", "1.3.0", Less), ("1.0.0-rc.1", "1.0.0", Less), ("1.0.0-rc.2", "1.0.0-rc.10", Less), ("1.0.0-1", "1.0.0-alpha", Less), ("1.0.0-alpha", "1.0.0-alpha.1", Less), ("1.0.0+a", "1.0.0+b", Equal), ("junk", "1.0.0", Equal)] {
      assert_eq!(compare_versions(l, r), want, "{l} ? {r}");
    }
    assert_eq!(minimum_for("2.3.0", &["1.18.31", "2.0.14"]), Some("2.0.14"));
    assert_eq!(minimum_for("0.5.0", &["1.18.31", "2.0.14"]), Some("1.18.31"));
    assert_eq!(minimum_for("1.0.0", &[]), None);
  }

  #[test]
  fn the_version_reader_runs_the_program() {
    let bin = tempfile::tempdir().unwrap();
    let script = |name: &str, body: &str| {
      let p = bin.path().join(name);
      std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
      std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
      p
    };
    assert_eq!(read_version(&script("ok", r#"[ "$1" = acp ] && [ "$2" = --version ] && echo "Hermes Agent v0.23.1""#), &["acp"]), Probe::Version("0.23.1".into()));
    assert_eq!(read_version(&script("stderr", "echo 'tool 4.5.6' >&2"), &[]), Probe::Version("4.5.6".into()));
    assert_eq!(read_version(&script("fails", "echo 1.2.3; exit 3"), &[]), Probe::Unknown);
    assert_eq!(read_version(&script("silent", "true"), &[]), Probe::Unknown);
    assert_eq!(read_version(&bin.path().join("missing"), &[]), Probe::Unknown);
  }

  #[test]
  fn command_lines_and_ids() {
    assert_eq!(split_command(r#"a  "b c" d'e f'"#), Some(vec!["a".into(), "b c".into(), "de f".into()]));
    assert_eq!(split_command("''"), Some(vec![String::new()]));
    assert_eq!(split_command("a 'b"), None);
    assert!(valid_id("gemini") && valid_id("my-agent-2"));
    assert!(!valid_id("") && !valid_id("-x") && !valid_id("Gemini") && !valid_id(&"a".repeat(41)));
    assert!(can_rewind("claude") && can_rewind("arkai") && !can_rewind("gemini"));
  }
}
