//! SSH hosts (Orca's `ssh:*` settings and plain-SSH side): saved remote machines, imported from
//! `~/.ssh/config` or typed in, with a connection test, a terminal on the machine and port
//! forwards. Everything goes through the system `ssh` (Orca's `plainSsh` path), so the user's keys,
//! agent, `ProxyJump` and known hosts apply as they do in a terminal.
//!
//! Rules from Orca 1.4.253 (MECHANICS.md › SSH hosts): config hosts come from `~/.ssh/config` and
//! the files its `Include` lines name (at most `MAX_CONFIG_FILES`; patterns with `?` or `[` are not
//! followed), never from a `Host` pattern with a wildcard; a listing keeps at most `MAX_LISTED`
//! matches of a query on alias, host name or user (`J2e`, `t4e`); details come from
//! `ssh -G -- <alias>` within `RESOLVE_TIMEOUT_MS` (`Ro`, `qo`, `Jo`, `Xo`: `IdentityFile none`
//! skipped, `ProxyCommand none` / `ProxyJump none` mean none, port 22 by default).

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

/// Orca `Io`.
pub const RESOLVE_TIMEOUT_MS: u64 = 5000;
/// Orca `J2e` (`c.length<100`).
pub const MAX_LISTED: usize = 100;
/// Orca `Uo` (`e<32`).
pub const MAX_CONFIG_FILES: usize = 32;
/// Connection test: `ConnectTimeout` given to ssh, and the whole test's limit (Kingu's choice).
pub const TEST_CONNECT_TIMEOUT_S: u64 = 10;
pub const TEST_TIMEOUT_MS: u64 = 15000;
/// Orca `CONNECT_TIMEOUT_MS = 30_000` (`src/main/ssh/connection/ssh-connection-timing.ts`): what a
/// dial of the shared connection gets to connect; the whole dial has a little longer, so ssh's own
/// "timed out" line is what a slow host reports.
pub const DIAL_CONNECT_TIMEOUT_S: u64 = 30;
pub const DIAL_TIMEOUT_MS: u64 = 35_000;
/// The keepalive's question to a host that was connected (Orca's `keepaliveInterval`, 15 s): no
/// answer within one interval is a drop.
pub const KEEPALIVE_PROBE_TIMEOUT_MS: u64 = 15_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target {
  pub id: String,
  pub label: String,
  /// The `~/.ssh/config` alias it came from: ssh is then run with that alias, so every option of
  /// the config applies.
  #[serde(default)]
  pub config_host: Option<String>,
  pub host: String,
  #[serde(default = "default_port")]
  pub port: u16,
  #[serde(default)]
  pub username: String,
  #[serde(default)]
  pub identity_file: Option<String>,
  #[serde(default)]
  pub jump_host: Option<String>,
  #[serde(default)]
  pub proxy_command: Option<String>,
}

fn default_port() -> u16 {
  22
}

/// One `Host` of the config, as Orca's settings list it (`e4e`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConfigHost {
  pub alias: String,
  pub hostname: String,
  pub port: u16,
  pub username: String,
  pub identity_file: Option<String>,
  pub proxy_command: Option<String>,
  pub jump_host: Option<String>,
  /// Already a saved target.
  pub already_added: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConfigListing {
  pub hosts: Vec<ConfigHost>,
  pub total_host_count: usize,
  pub new_host_count: usize,
  pub match_count: usize,
  pub has_more: bool,
}

// ---------------------------------------------------------------------------------------------
// ~/.ssh/config

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Block {
  hosts: Vec<String>,
  values: HashMap<String, String>,
}

/// Orca `Wo`: a config line's words (quotes group, `\` escapes a space).
pub fn words(line: &str) -> Vec<String> {
  let mut out = Vec::new();
  let mut cur = String::new();
  let mut quote: Option<char> = None;
  let mut any = false;
  let mut chars = line.chars().peekable();
  while let Some(c) = chars.next() {
    if c == '\\' && chars.peek().is_some_and(|n| n.is_whitespace()) {
      cur.push(chars.next().unwrap_or(' '));
      any = true;
    } else if quote.is_some_and(|q| q == c) || (quote.is_none() && (c == '"' || c == '\'')) {
      quote = if quote.is_some() { None } else { Some(c) };
      any = true;
    } else if quote.is_none() && c.is_whitespace() {
      if any {
        out.push(std::mem::take(&mut cur));
      }
      any = false;
    } else {
      cur.push(c);
      any = true;
    }
  }
  if any {
    out.push(cur);
  }
  out
}

/// `Key value`, `Key=value` or `Key = value` → (lower-case key, value).
fn key_value(line: &str) -> Option<(String, String)> {
  let t = line.trim();
  if t.is_empty() || t.starts_with('#') {
    return None;
  }
  let i = t.find(|c: char| c.is_whitespace() || c == '=')?;
  let key = t[..i].to_ascii_lowercase();
  let value = t[i..].trim_start_matches(|c: char| c.is_whitespace() || c == '=').trim().to_string();
  Some((key, value))
}

/// Orca `Go`: the files an `Include` names, relative to `~/.ssh`; `*` expands within one folder,
/// `~`, `%`, `?` and `[` aren't followed.
fn include_files(spec: &str, base: &Path) -> Vec<PathBuf> {
  let mut out = Vec::new();
  for w in words(spec) {
    if w.starts_with('~') && !w.starts_with("~/") || w.contains('%') {
      continue;
    }
    let w = match w.strip_prefix("~/") {
      Some(rest) => dirs_home().join(rest).to_string_lossy().into_owned(),
      None => w,
    };
    let p = if Path::new(&w).is_absolute() { PathBuf::from(&w) } else { base.join(&w) };
    let s = p.to_string_lossy().into_owned();
    if s.contains(['?', '[', ']']) {
      continue;
    }
    match s.find('*') {
      None => out.push(p),
      Some(i) => {
        let dir = Path::new(&s[..=i]).parent().map(Path::to_path_buf).unwrap_or_default();
        if s[i + 1..].contains('/') {
          continue;
        }
        let prefix = Path::new(&s).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let (before, after) = prefix.split_once('*').unwrap_or((&prefix, ""));
        if let Ok(rd) = std::fs::read_dir(&dir) {
          let mut names: Vec<PathBuf> = rd
            .flatten()
            .filter(|e| {
              let n = e.file_name().to_string_lossy().into_owned();
              n.starts_with(before) && n.ends_with(after) && n.len() >= before.len() + after.len()
            })
            .map(|e| e.path())
            .collect();
          names.sort();
          out.extend(names);
        }
      }
    }
  }
  out
}

pub(crate) fn dirs_home() -> PathBuf {
  std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

/// The `Host` blocks of `config` and every file it includes (at most `MAX_CONFIG_FILES`), in the
/// order ssh reads them: an `Include` is read where it stands.
fn read_blocks(config: &Path) -> Vec<Block> {
  let base = config.parent().map(Path::to_path_buf).unwrap_or_default();
  let mut seen = std::collections::HashSet::new();
  let mut blocks = Vec::new();
  read_file(config, &base, &mut seen, &mut blocks);
  blocks
}

fn read_file(file: &Path, base: &Path, seen: &mut std::collections::HashSet<PathBuf>, blocks: &mut Vec<Block>) {
  if seen.len() >= MAX_CONFIG_FILES || !seen.insert(file.to_path_buf()) {
    return;
  }
  let Ok(text) = std::fs::read_to_string(file) else { return };
  let mut current: Option<Block> = None;
  for line in text.lines() {
    let Some((key, value)) = key_value(line) else { continue };
    match key.as_str() {
      "host" => {
        blocks.extend(current.take());
        current = Some(Block { hosts: words(&value), values: HashMap::new() });
      }
      "match" => {
        // Match blocks aren't host aliases.
        blocks.extend(current.take());
      }
      "include" => {
        blocks.extend(current.take());
        for f in include_files(&value, base) {
          read_file(&f, base, seen, blocks);
        }
      }
      _ => {
        if let Some(b) = current.as_mut() {
          b.values.entry(key).or_insert(value);
        }
      }
    }
  }
  blocks.extend(current);
}

/// A `Host` word that names one machine (no wildcard, no negation).
pub fn concrete_alias(word: &str) -> bool {
  !word.is_empty() && !word.contains(['*', '?', '!', '[', ']'])
}

fn none_to_none(v: Option<&String>) -> Option<String> {
  v.filter(|s| !s.eq_ignore_ascii_case("none") && !s.is_empty()).cloned()
}

/// Every concrete alias of the config, first definition wins (Orca `cn` + `J2e`'s dedupe).
pub fn config_hosts(config: &Path) -> Vec<ConfigHost> {
  let mut out: Vec<ConfigHost> = Vec::new();
  for b in read_blocks(config) {
    for alias in b.hosts.iter().filter(|h| concrete_alias(h)) {
      if out.iter().any(|h| h.alias.eq_ignore_ascii_case(alias)) {
        continue;
      }
      out.push(ConfigHost {
        alias: alias.clone(),
        hostname: b.values.get("hostname").cloned().unwrap_or_else(|| alias.clone()),
        port: b.values.get("port").and_then(|p| p.parse().ok()).unwrap_or(22),
        username: b.values.get("user").cloned().unwrap_or_default(),
        identity_file: none_to_none(b.values.get("identityfile")),
        proxy_command: none_to_none(b.values.get("proxycommand")),
        jump_host: none_to_none(b.values.get("proxyjump")),
        already_added: false,
      });
    }
  }
  out
}

/// Orca `J2e` + `t4e`: a query on alias, host name or user; at most `MAX_LISTED` rows.
pub fn listing(all: Vec<ConfigHost>, targets: &[Target], query: &str) -> ConfigListing {
  let q = query.trim().to_lowercase();
  let added: std::collections::HashSet<String> = targets.iter().flat_map(|t| [t.config_host.clone(), Some(t.label.clone())]).flatten().map(|s| s.to_lowercase()).collect();
  let total = all.len();
  let mut new_count = 0;
  let mut matches = 0;
  let mut hosts = Vec::new();
  for mut h in all {
    h.already_added = added.contains(&h.alias.to_lowercase());
    if !h.already_added {
      new_count += 1;
    }
    let hit = q.is_empty() || h.alias.to_lowercase().contains(&q) || h.hostname.to_lowercase().contains(&q) || h.username.to_lowercase().contains(&q);
    if hit {
      matches += 1;
      if hosts.len() < MAX_LISTED {
        hosts.push(h);
      }
    }
  }
  ConfigListing { has_more: matches > hosts.len(), hosts, total_host_count: total, new_host_count: new_count, match_count: matches }
}

/// Orca `Jo` + `Xo`: `ssh -G` output (`key value` per line) → the resolved host.
pub fn parse_ssh_g(alias: &str, out: &str) -> Option<ConfigHost> {
  let mut map: HashMap<String, String> = HashMap::new();
  let mut identity = Vec::new();
  for line in out.lines() {
    let Some((k, v)) = line.split_once(' ') else { continue };
    let k = k.to_ascii_lowercase();
    let v = v.trim().to_string();
    if k == "identityfile" {
      if !v.eq_ignore_ascii_case("none") {
        identity.push(v);
      }
    } else {
      map.insert(k, v);
    }
  }
  let hostname = map.get("hostname").cloned().filter(|h| !h.is_empty())?;
  Some(ConfigHost {
    alias: alias.to_string(),
    hostname,
    port: map.get("port").and_then(|p| p.parse().ok()).unwrap_or(22),
    username: map.get("user").cloned().unwrap_or_default(),
    identity_file: identity.into_iter().next(),
    proxy_command: none_to_none(map.get("proxycommand")),
    jump_host: none_to_none(map.get("proxyjump")),
    already_added: false,
  })
}

/// Runs `cmd`, killing it past `timeout`; stdout and stderr and whether it exited 0.
fn run_with_timeout(cmd: Command, timeout: Duration) -> Result<(bool, String, String), String> {
  run_with_input(cmd, timeout, None)
}

/// [`run_with_timeout`] writing `input` to the command's stdin (then closing it).
fn run_with_input(mut cmd: Command, timeout: Duration, input: Option<Vec<u8>>) -> Result<(bool, String, String), String> {
  let stdin = if input.is_some() { Stdio::piped() } else { Stdio::null() };
  let mut child = cmd.stdin(stdin).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("ssh: {e}"))?;
  let in_t = match (input, child.stdin.take()) {
    (Some(bytes), Some(mut w)) => Some(std::thread::spawn(move || {
      use std::io::Write;
      let _ = w.write_all(&bytes);
    })),
    _ => None,
  };
  let mut so = child.stdout.take();
  let mut se = child.stderr.take();
  let out_t = std::thread::spawn(move || {
    let mut s = String::new();
    if let Some(o) = so.as_mut() {
      let _ = o.read_to_string(&mut s);
    }
    s
  });
  let err_t = std::thread::spawn(move || {
    let mut s = String::new();
    if let Some(e) = se.as_mut() {
      let _ = e.read_to_string(&mut s);
    }
    s
  });
  let mut start = Instant::now();
  let status = loop {
    if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
      break Some(s);
    }
    // An open passphrase prompt (ssh_askpass.rs) is the user's time, not the command's.
    if crate::ssh_askpass::waiting() {
      start = Instant::now();
    }
    if start.elapsed() > timeout {
      let _ = child.kill();
      let _ = child.wait();
      break None;
    }
    std::thread::sleep(Duration::from_millis(25));
  };
  let (out, err) = (out_t.join().unwrap_or_default(), err_t.join().unwrap_or_default());
  if let Some(t) = in_t {
    let _ = t.join();
  }
  match status {
    Some(s) => Ok((s.success(), out, err)),
    None => Err(format!("ssh did not finish within {} s", timeout.as_secs())),
  }
}

/// The account's own home folder (Orca `Lo`: `os.userInfo().homedir`), which ssh uses for its
/// default config whatever `$HOME` says.
fn account_home() -> Option<PathBuf> {
  #[cfg(unix)]
  unsafe {
    let pw = libc::getpwuid(libc::getuid());
    if pw.is_null() || (*pw).pw_dir.is_null() {
      return None;
    }
    Some(PathBuf::from(std::ffi::CStr::from_ptr((*pw).pw_dir).to_string_lossy().into_owned()))
  }
  #[cfg(not(unix))]
  None
}

/// Orca `Ro` (ssh chunk): `-F $HOME/.ssh/config` only when that file exists and isn't the account's
/// own `~/.ssh/config` (ssh reads that one by itself), then `-G -- <alias>`.
pub fn resolve_args(alias: &str, env_home: &Path, account_home: Option<&Path>) -> Vec<String> {
  let cfg = env_home.join(".ssh").join("config");
  let own = account_home.map(|h| h.join(".ssh").join("config"));
  let mut args = Vec::new();
  if cfg.exists() && own.as_deref() != Some(cfg.as_path()) {
    args.extend(["-F".to_string(), cfg.to_string_lossy().into_owned()]);
  }
  args.extend(["-G".to_string(), "--".to_string(), alias.to_string()]);
  args
}

/// Orca `Ko`/`qo`: `ssh <resolve_args>` within `RESOLVE_TIMEOUT_MS`, parsed by `Jo`.
pub fn resolve(alias: &str) -> Option<ConfigHost> {
  if !concrete_alias(alias) || alias.starts_with('-') {
    return None;
  }
  let mut cmd = crate::shell_env::command(Path::new("ssh"));
  cmd.args(resolve_args(alias, &dirs_home(), account_home().as_deref()));
  let (ok, out, _) = run_with_timeout(cmd, Duration::from_millis(RESOLVE_TIMEOUT_MS)).ok()?;
  if !ok {
    return None;
  }
  parse_ssh_g(alias, &out)
}

// ---------------------------------------------------------------------------------------------
// Running ssh for a target

/// The arguments that reach `target`: its config alias when it has one, else host, port, user,
/// key, jump host and proxy command spelled out.
pub fn destination_args(t: &Target) -> Vec<String> {
  if let Some(alias) = t.config_host.as_ref().filter(|a| concrete_alias(a)) {
    return vec!["--".into(), alias.clone()];
  }
  let mut a = Vec::new();
  if t.port != 22 {
    a.extend(["-p".into(), t.port.to_string()]);
  }
  if let Some(i) = &t.identity_file {
    a.extend(["-i".into(), i.clone()]);
  }
  if let Some(j) = &t.jump_host {
    a.extend(["-J".into(), j.clone()]);
  }
  if let Some(p) = &t.proxy_command {
    a.extend(["-o".into(), format!("ProxyCommand={p}")]);
  }
  a.push("--".into());
  a.push(if t.username.is_empty() { t.host.clone() } else { format!("{}@{}", t.username, t.host) });
  a
}

/// A target is usable: a host without spaces or a leading `-`, a port above 0.
pub fn validate(t: &Target) -> Result<(), String> {
  let bad = |s: &str| s.is_empty() || s.starts_with('-') || s.chars().any(|c| c.is_whitespace() || c.is_control());
  if bad(&t.host) {
    return Err("Enter a host name (no spaces).".into());
  }
  if !t.username.is_empty() && (t.username.starts_with('-') || t.username.chars().any(|c| c.is_whitespace() || c == '@')) {
    return Err("The user name can't contain spaces or @.".into());
  }
  if t.port == 0 {
    return Err("The port must be 1–65535.".into());
  }
  if let Some(a) = &t.config_host
    && !concrete_alias(a)
  {
    return Err("That SSH config host is a pattern, not one machine.".into());
  }
  Ok(())
}

/// What a connection test found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TestResult {
  pub success: bool,
  pub error: Option<String>,
  pub millis: u64,
}

/// Orca's `ssh:testConnection` (a probe that connects, then disconnects): ssh runs `true` on the
/// machine; a passphrase or an unknown host key is asked in the app (ssh_askpass.rs), never in a
/// terminal, and a host declined before may ask again.
pub fn test(t: &Target) -> TestResult {
  let start = Instant::now();
  // Testing again lets a declined host prompt again (Orca `clearSshCredentialDeclined`).
  crate::ssh_askpass::clear_declined(&t.id);
  let mut cmd = background(t, false);
  cmd.arg("true");
  let result = run_with_timeout(cmd, Duration::from_millis(TEST_TIMEOUT_MS));
  let millis = start.elapsed().as_millis() as u64;
  match result {
    Ok((true, _, _)) => TestResult { success: true, error: None, millis },
    Ok((false, _, err)) => {
      let msg = err.lines().rfind(|l| !l.trim().is_empty()).unwrap_or("ssh failed").trim().to_string();
      TestResult { success: false, error: Some(msg), millis }
    }
    Err(e) => TestResult { success: false, error: Some(e), millis },
  }
}

// ---------------------------------------------------------------------------------------------
// Port forwards

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Forward {
  pub id: String,
  pub target_id: String,
  pub local_port: u16,
  pub remote_host: String,
  pub remote_port: u16,
  pub label: Option<String>,
  pub running: bool,
}

#[derive(Default)]
pub struct Forwards(Mutex<Vec<(Forward, Child)>>);

impl Drop for Forwards {
  fn drop(&mut self) {
    for (_, mut c) in self.0.lock().map(|mut g| std::mem::take(&mut *g)).unwrap_or_default() {
      let _ = c.kill();
    }
  }
}

/// `-L <local>:<remote host>:<remote port>` (Orca's `addForward(localPort, remoteHost, remotePort)`),
/// bound to 127.0.0.1 so the forwarded port isn't reachable from the network.
pub fn forward_args(t: &Target, local: u16, remote_host: &str, remote_port: u16) -> Result<Vec<String>, String> {
  if local == 0 || remote_port == 0 {
    return Err("Ports must be 1–65535.".into());
  }
  let rh = remote_host.trim();
  if rh.is_empty() || rh.starts_with('-') || rh.chars().any(|c| c.is_whitespace() || c == ':' && !rh.starts_with('[')) {
    return Err("Enter the remote host (for example localhost).".into());
  }
  // Keepalives as on the shared connection: a forward whose host is gone ends (within 45 s)
  // instead of holding its local port on a dead connection.
  let mut a: Vec<String> = ["-N", "-o", "ExitOnForwardFailure=yes", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-L"].map(String::from).to_vec();
  a.push(format!("127.0.0.1:{local}:{rh}:{remote_port}"));
  a.extend(destination_args(t));
  Ok(a)
}

// ---------------------------------------------------------------------------------------------
// Remote commands: folders and listening ports

/// Orca `CAt=15e3`: a remote browse gets 15 s (Kingu uses it for its port scan too).
pub const REMOTE_TIMEOUT_MS: u64 = 15000;
/// Folder listings are cut here.
pub const MAX_ENTRIES: usize = 500;

/// `'…'` for a POSIX shell.
pub fn sh_quote(s: &str) -> String {
  format!("'{}'", s.replace('\'', r"'\''"))
}

/// An ssh for a background command (`-T`, 10 s to connect, then the destination): passphrases
/// and passwords are asked in the app (ssh_askpass.rs), else (a declined host, no helper)
/// `BatchMode=yes` never prompts. `mux`: share one connection per host (below).
pub(crate) fn background(t: &Target, mux: bool) -> Command {
  background_asking(t, mux, true)
}

/// [`background`]; `ask: false` never prompts at all (a redial nobody is waiting on).
fn background_asking(t: &Target, mux: bool, ask: bool) -> Command {
  background_within(t, mux, ask, TEST_CONNECT_TIMEOUT_S)
}

/// [`background_asking`] with its own `ConnectTimeout` (seconds).
fn background_within(t: &Target, mux: bool, ask: bool, connect_s: u64) -> Command {
  let mut cmd = crate::shell_env::command(Path::new("ssh"));
  // `KINGU_SSH_CONFIG`: an ssh config file used instead of `~/.ssh/config` (tests against a
  // temporary sshd use it, so the user's own config, agent and keychain stay out of it).
  if let Some(cfg) = std::env::var_os("KINGU_SSH_CONFIG").filter(|c| !c.is_empty()) {
    cmd.arg("-F").arg(cfg);
  }
  let asks = ask && crate::ssh_askpass::apply(&mut cmd, &t.id);
  cmd.args(["-o", if asks { "BatchMode=no" } else { "BatchMode=yes" }, "-o", &format!("ConnectTimeout={connect_s}"), "-T"]);
  if mux {
    cmd.args(mux_args(&dirs_home()));
  }
  cmd.args(destination_args(t));
  cmd
}

/// Kingu's background ssh calls share one connection per host for 2 min (OpenSSH
/// `ControlMaster=auto`, socket `~/.ssh/kingu-%C`), so polling and saving stay cheap and a
/// passphrase is asked once (Kingu's choice, **estimated**; Orca keeps one ssh2 connection per
/// host). Only when `~/.ssh` exists (ssh won't make it) and on Unix (Windows' ssh has no sockets).
/// The shared connection sends keepalives as Orca's does
/// (`src/main/ssh/system-transport/system-ssh-args.ts`: `ServerAliveInterval=15`,
/// `ServerAliveCountMax=3` whenever a control path is used), so a dead peer ends it within 45 s
/// instead of holding every later command.
pub fn mux_args(home: &Path) -> Vec<String> {
  if cfg!(unix) && home.join(".ssh").is_dir() {
    ["-o", "ControlMaster=auto", "-o", "ControlPath=~/.ssh/kingu-%C", "-o", "ControlPersist=120", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"].map(String::from).to_vec()
  } else {
    Vec::new()
  }
}

/// Runs `script` on the target with `sh -c`, never prompting.
pub(crate) fn remote(t: &Target, script: &str) -> Result<String, String> {
  remote_within(t, script, Duration::from_millis(REMOTE_TIMEOUT_MS))
}

/// [`remote`] with its own time limit (a `git worktree add` can take longer than a listing).
pub(crate) fn remote_within(t: &Target, script: &str, limit: Duration) -> Result<String, String> {
  remote_input(t, script, None, limit)
}

/// [`remote_within`] with `input` on the script's stdin (a file being saved, a commit message):
/// never in the command line, which the host's shell limits in length.
pub(crate) fn remote_input(t: &Target, script: &str, input: Option<Vec<u8>>, limit: Duration) -> Result<String, String> {
  let mut cmd = background(t, true);
  cmd.arg(format!("sh -c {}", sh_quote(script)));
  match run_with_input(cmd, limit, input)? {
    (true, out, _) => Ok(out),
    (false, _, err) => Err(err.lines().rfind(|l| !l.trim().is_empty()).unwrap_or("ssh failed").trim().to_string()),
  }
}

// ---------------------------------------------------------------------------------------------
// Connecting (Orca's `ssh:connect` / `ssh:disconnect` on its system-ssh transport)

/// Orca `src/main/ssh/connection/ssh-system-ssh-probe.ts`: the host is reached when the probe
/// command exits 0 and its output carries the mark (Orca echoes `ORCA-SYSTEM-SSH-OK`).
pub const PROBE_MARK: &str = "KINGU-SSH-OK";

pub fn probe_ok(success: bool, stdout: &str) -> bool {
  success && stdout.contains(PROBE_MARK)
}

/// What a failed probe reports: ssh's last line (`Permission denied (publickey).`,
/// `ssh: connect to host … port 22: Connection refused`), which the window classifies
/// (sshConnection.ts, Orca's ssh-reconnect-error-classification.ts).
pub fn probe_error(stdout: &str, stderr: &str) -> String {
  let last = stderr.lines().rfind(|l| !l.trim().is_empty()).map(str::trim);
  match last {
    Some(l) => l.to_string(),
    None if stdout.trim().is_empty() => "ssh failed".into(),
    None => "The SSH host did not answer the connection probe.".into(),
  }
}

/// One dial of the shared connection (the one every background command of the host then uses):
/// `echo KINGU-SSH-OK` through it. `interactive`: the user asked, so a passphrase or host key may
/// be asked in the window and a declined host may ask again (Orca `clearSshCredentialDeclined`);
/// otherwise (a redial after a drop, the keepalive) it never prompts.
pub fn connect(t: &Target, interactive: bool) -> Result<(), String> {
  if interactive {
    crate::ssh_askpass::clear_declined(&t.id);
  }
  let mut cmd = background_within(t, true, interactive, DIAL_CONNECT_TIMEOUT_S);
  cmd.arg(format!("echo {PROBE_MARK}"));
  let (ok, out, err) = run_with_timeout(cmd, Duration::from_millis(DIAL_TIMEOUT_MS))?;
  if probe_ok(ok, &out) { Ok(()) } else { Err(probe_error(&out, &err)) }
}

/// The keepalive: the same probe over the shared connection, never prompting, with one keepalive
/// interval to answer (a dial has 30 s; a host that was just connected answers at once or is gone).
pub fn keepalive(t: &Target) -> Result<(), String> {
  let mut cmd = background_asking(t, true, false);
  cmd.arg(format!("echo {PROBE_MARK}"));
  let (ok, out, err) = run_with_timeout(cmd, Duration::from_millis(KEEPALIVE_PROBE_TIMEOUT_MS))?;
  if probe_ok(ok, &out) { Ok(()) } else { Err(probe_error(&out, &err)) }
}

/// `ssh -O exit` for the shared connection of `t` (Orca's Disconnect closes its transport): the
/// arguments, or `None` where connections aren't shared ([`mux_args`]).
pub fn disconnect_args(t: &Target, home: &Path) -> Option<Vec<String>> {
  let mux = mux_args(home);
  if mux.is_empty() {
    return None;
  }
  let mut a = vec!["-O".to_string(), "exit".to_string()];
  a.extend(mux);
  a.extend(destination_args(t));
  Some(a)
}

#[tauri::command]
pub async fn ssh_connect(targets: State<'_, Targets>, id: String, interactive: bool) -> Result<(), String> {
  let t = targets.get(&id)?;
  blocking(move || connect(&t, interactive)).await?
}

/// The keepalive probe of a connected host ([`keepalive`]).
#[tauri::command]
pub async fn ssh_keepalive(targets: State<'_, Targets>, id: String) -> Result<(), String> {
  let t = targets.get(&id)?;
  blocking(move || keepalive(&t)).await?
}

/// Closes the host's shared connection. Terminals and port forwards are their own ssh and stay.
#[tauri::command]
pub async fn ssh_disconnect(targets: State<'_, Targets>, id: String) -> Result<(), String> {
  let t = targets.get(&id)?;
  blocking(move || {
    let Some(args) = disconnect_args(&t, &dirs_home()) else { return };
    let mut cmd = crate::shell_env::command(Path::new("ssh"));
    cmd.args(args);
    // No shared connection to close is not an error.
    let _ = run_with_timeout(cmd, Duration::from_millis(RESOLVE_TIMEOUT_MS));
  })
  .await
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemoteDir {
  /// The folder listed (after `cd`, so `~` and `..` are resolved).
  pub path: String,
  /// Folders first, then files; each folder name ends in `/`.
  pub entries: Vec<String>,
  pub truncated: bool,
}

/// Orca `AAt`: `~` → `"$HOME"`, `~/x` → `"$HOME"/'x'`, anything else quoted.
pub fn posix_dir(path: &str) -> String {
  let p = path.trim();
  if p.is_empty() || p == "~" {
    "\"$HOME\"".into()
  } else if let Some(rest) = p.strip_prefix("~/") {
    format!("\"$HOME\"/{}", sh_quote(rest))
  } else {
    sh_quote(p)
  }
}

/// Orca `EAt`: every entry (`ls -1A`, so no `.`/`..`), a folder marked `/` when `[ -d ]` says so
/// (a link to a folder counts as one).
pub const LIST_SCRIPT: &str = r#"entries=$(command ls -1A) && printf '%s\n' "$entries" | while IFS= read -r f; do if [ -d "$f" ]; then printf '%s/\n' "$f"; else printf '%s\n' "$f"; fi; done"#;

/// Orca `DAt`: `cd <dir> && pwd && <list>` (empty path → the home folder). A folder that can't be
/// opened is an error, not the home folder.
pub fn browse_script(path: &str) -> String {
  format!("cd {} && pwd && {LIST_SCRIPT}", posix_dir(path))
}

/// Orca `OAt`: the PowerShell fallback for a Windows host (its default shell has no `cd &&
/// pwd`): the resolved folder with `/`, then each child, folders with a trailing `/`; `/` alone
/// lists the drives (`C:/` …).
pub fn powershell_browse(path: &str) -> String {
  let p = path.trim();
  if (p.is_empty() || p.chars().all(|c| c == '/' || c == '\\') && !p.is_empty() && p != "~")
    && !p.is_empty() {
      return [
        "$ErrorActionPreference = 'Stop'",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        "Write-Output '/'",
        "Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Name -match '^[A-Za-z]$' } | Sort-Object Name | ForEach-Object { Write-Output (($_.Name.ToUpperInvariant() + ':\\') + '/') }",
      ]
      .join("; ");
    }
  let ps_quote = |s: &str| format!("'{}'", s.replace('\'', "''"));
  // Orca `jAt` + `MAt`: `~` → $HOME, `/C:` → `C:/`.
  let dir = if p.is_empty() || p == "~" {
    "$HOME".to_string()
  } else if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
    format!("(Join-Path $HOME {})", ps_quote(rest))
  } else {
    let t = if p.len() >= 3 && p.starts_with('/') && p.as_bytes()[1].is_ascii_alphabetic() && p.as_bytes()[2] == b':' { &p[1..] } else { p };
    let t = if t.len() == 2 && t.as_bytes()[0].is_ascii_alphabetic() && t.as_bytes()[1] == b':' { format!("{t}/") } else { t.to_string() };
    ps_quote(&t)
  };
  [
    "$ErrorActionPreference = 'Stop'".to_string(),
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8".to_string(),
    format!("$dir = {dir}"),
    "Set-Location -LiteralPath $dir".to_string(),
    "$resolved = (Get-Location).ProviderPath".to_string(),
    "Write-Output ($resolved -replace '\\\\', '/')".to_string(),
    "Get-ChildItem -LiteralPath $resolved -Force | ForEach-Object {".to_string(),
    "  if ($_.PSIsContainer) { Write-Output ($_.Name + '/') } else { Write-Output $_.Name }".to_string(),
    "}".to_string(),
  ]
  .join("; ")
}

/// `powershell -NoProfile -EncodedCommand <UTF-16LE base64>` (no quoting can go wrong).
pub fn powershell_command(script: &str) -> String {
  use base64::Engine;
  let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
  format!("powershell -NoProfile -NonInteractive -EncodedCommand {}", base64::engine::general_purpose::STANDARD.encode(utf16))
}

pub fn parse_listing(out: &str) -> Option<RemoteDir> {
  let mut lines = out.lines();
  let path = lines.next()?.trim().to_string();
  // A POSIX path, or a Windows one Orca's PowerShell side prints with `/` (`C:/Users/me`, `/`).
  let windows = path.len() >= 2 && path.as_bytes()[0].is_ascii_alphabetic() && path.as_bytes()[1] == b':';
  if !path.starts_with('/') && !windows {
    return None;
  }
  let mut dirs: Vec<String> = Vec::new();
  let mut files: Vec<String> = Vec::new();
  for l in lines.map(str::trim_end).filter(|l| !l.is_empty() && *l != "./" && *l != "../") {
    if l.ends_with('/') { dirs.push(l.to_string()) } else { files.push(l.to_string()) }
  }
  let mut entries: Vec<String> = dirs.into_iter().chain(files).collect();
  let truncated = entries.len() > MAX_ENTRIES;
  entries.truncate(MAX_ENTRIES);
  Some(RemoteDir { path, entries, truncated })
}

/// Listening TCP ports on the target (Orca learns them from its remote server; Kingu asks the
/// machine): `ss -ltnH`, else `netstat -ltn` when it lists listening sockets, else `lsof` (macOS
/// hosts: their `netstat -ltn` succeeds but `-l` is not "listening" there, so it lists none).
pub const PORTS_SCRIPT: &str = "ss -ltnH 2>/dev/null || { o=$(netstat -ltn 2>/dev/null) && printf '%s\\n' \"$o\" | grep -q LISTEN && printf '%s\\n' \"$o\"; } || lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null";

/// Ports from any of those outputs: the port of each listening local address, without ssh's own
/// 22, sorted and once each.
pub fn parse_ports(out: &str) -> Vec<u16> {
  let mut ports = std::collections::BTreeSet::new();
  for line in out.lines() {
    let cols: Vec<&str> = line.split_whitespace().collect();
    if cols.is_empty() || cols[0] == "Proto" || cols[0] == "Active" || cols[0] == "COMMAND" || cols[0] == "State" {
      continue;
    }
    // ss: State Recv-Q Send-Q Local Peer…; netstat: Proto Recv-Q Send-Q Local Foreign State;
    // lsof: … NAME (LISTEN) with NAME `addr:port`.
    let local = if cols[0].starts_with("tcp") {
      if !line.contains("LISTEN") {
        continue;
      }
      cols.get(3)
    } else if cols[0] == "LISTEN" {
      cols.get(3)
    } else if line.ends_with("(LISTEN)") {
      cols.get(cols.len().saturating_sub(2))
    } else {
      None
    };
    let Some(local) = local else { continue };
    let port = local.rsplit([':', '.']).next().and_then(|p| p.parse::<u16>().ok());
    if let Some(p) = port.filter(|p| *p != 0 && *p != 22) {
      ports.insert(p);
    }
  }
  ports.into_iter().collect()
}

// ---------------------------------------------------------------------------------------------
// Saved forwards (Orca's `listUnrestoredPortForwards` / `removeSavedPortForward`)

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedForward {
  pub target_id: String,
  pub local_port: u16,
  pub remote_host: String,
  pub remote_port: u16,
  #[serde(default)]
  pub label: Option<String>,
}

pub struct SavedForwards {
  file: PathBuf,
  list: Mutex<Vec<SavedForward>>,
}

impl SavedForwards {
  pub fn load(file: PathBuf) -> Self {
    let list = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    Self { file, list: Mutex::new(list) }
  }

  fn update(&self, f: impl FnOnce(&mut Vec<SavedForward>)) -> Result<(), String> {
    let mut g = self.list.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut g);
    if let Some(d) = self.file.parent() {
      std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    std::fs::write(&self.file, serde_json::to_vec_pretty(&*g).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
  }

  /// The same local port forwarded again replaces its old record.
  pub fn remember(&self, s: SavedForward) -> Result<(), String> {
    self.update(|l| {
      l.retain(|x| x.local_port != s.local_port);
      l.push(s);
    })
  }

  pub fn forget(&self, target_id: &str, local_port: u16) -> Result<(), String> {
    self.update(|l| l.retain(|x| !(x.target_id == target_id && x.local_port == local_port)))
  }

  pub fn forget_target(&self, target_id: &str) -> Result<(), String> {
    self.update(|l| l.retain(|x| x.target_id != target_id))
  }

  pub fn list(&self) -> Vec<SavedForward> {
    self.list.lock().unwrap_or_else(|e| e.into_inner()).clone()
  }
}

/// Saved forwards that aren't running now (offered for Restore after a restart).
pub fn unrestored(saved: &[SavedForward], running: &[Forward]) -> Vec<SavedForward> {
  saved.iter().filter(|s| !running.iter().any(|f| f.running && f.target_id == s.target_id && f.local_port == s.local_port)).cloned().collect()
}

// ---------------------------------------------------------------------------------------------
// Store and commands

pub struct Targets {
  file: PathBuf,
  list: Mutex<Vec<Target>>,
}

impl Targets {
  pub fn load(file: PathBuf) -> Self {
    let list = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    Self { file, list: Mutex::new(list) }
  }

  fn save(&self, list: &[Target]) -> Result<(), String> {
    if let Some(d) = self.file.parent() {
      std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = self.file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &self.file).map_err(|e| e.to_string())
  }

  pub fn list(&self) -> Vec<Target> {
    self.list.lock().unwrap_or_else(|e| e.into_inner()).clone()
  }

  pub fn get(&self, id: &str) -> Result<Target, String> {
    self.list().into_iter().find(|t| t.id == id).ok_or_else(|| format!("SSH host \"{id}\" not found"))
  }

  /// Adds `t` (a fresh id; the label defaults to the alias or host).
  pub fn add(&self, mut t: Target) -> Result<Target, String> {
    validate(&t)?;
    let mut list = self.list.lock().unwrap_or_else(|e| e.into_inner());
    let n = list.len();
    t.id = format!("ssh-{:x}-{n:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis()));
    if t.label.trim().is_empty() {
      t.label = t.config_host.clone().unwrap_or_else(|| t.host.clone());
    }
    let mut next = list.clone();
    next.push(t.clone());
    self.save(&next)?;
    *list = next;
    Ok(t)
  }

  pub fn remove(&self, id: &str) -> Result<(), String> {
    let mut list = self.list.lock().unwrap_or_else(|e| e.into_inner());
    let next: Vec<Target> = list.iter().filter(|t| t.id != id).cloned().collect();
    self.save(&next)?;
    *list = next;
    Ok(())
  }
}

pub fn install(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
  app.manage(Targets::load(app.path().app_data_dir()?.join("ssh-targets.json")));
  app.manage(Forwards::default());
  app.manage(SavedForwards::load(app.path().app_data_dir()?.join("ssh-forwards.json")));
  crate::ssh_askpass::install(app.handle());
  Ok(())
}

/// Runs `command` as given on the target (no `sh -c`: for the PowerShell fallback).
fn remote_raw(t: &Target, command: &str) -> Result<String, String> {
  let mut cmd = background(t, true);
  cmd.arg(command);
  match run_with_timeout(cmd, Duration::from_millis(REMOTE_TIMEOUT_MS))? {
    (true, out, _) => Ok(out),
    (false, _, err) => Err(err.lines().rfind(|l| !l.trim().is_empty()).unwrap_or("ssh failed").trim().to_string()),
  }
}

/// Orca `TAt`: the POSIX listing first; when it fails, the PowerShell one (a Windows host); when
/// that fails too, the first error is the one reported.
#[tauri::command]
pub async fn ssh_browse_dir(targets: State<'_, Targets>, id: String, path: Option<String>) -> Result<RemoteDir, String> {
  let t = targets.get(&id)?;
  let path = path.unwrap_or_default();
  blocking(move || {
    let read = |out: String| parse_listing(&out).ok_or_else(|| "Couldn't read the folder on the host.".to_string());
    match remote(&t, &browse_script(&path)).and_then(read) {
      Ok(d) => Ok(d),
      Err(first) => remote_raw(&t, &powershell_command(&powershell_browse(&path))).and_then(read).map_err(|_| first),
    }
  })
  .await?
}

#[tauri::command]
pub async fn ssh_detected_ports(targets: State<'_, Targets>, id: String) -> Result<Vec<u16>, String> {
  let t = targets.get(&id)?;
  blocking(move || remote(&t, PORTS_SCRIPT).map(|out| parse_ports(&out))).await?
}

/// A terminal command that opens a shell on the target inside `path`.
#[tauri::command]
pub fn ssh_terminal_command_in(targets: State<'_, Targets>, id: String, path: String) -> Result<Vec<String>, String> {
  let t = targets.get(&id)?;
  let mut argv = vec!["ssh".to_string(), "-t".to_string()];
  argv.extend(destination_args(&t));
  argv.push(format!("cd -- {} && exec \"${{SHELL:-sh}}\" -l", sh_quote(&path)));
  Ok(argv)
}

#[tauri::command]
pub fn ssh_unrestored_forwards(saved: State<'_, SavedForwards>, forwards: State<'_, Forwards>) -> Vec<SavedForward> {
  let running = ssh_forwards_list(forwards);
  unrestored(&saved.list(), &running)
}

#[tauri::command]
pub fn ssh_forget_forward(saved: State<'_, SavedForwards>, target_id: String, local_port: u16) -> Result<(), String> {
  saved.forget(&target_id, local_port)
}

pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ssh_targets_list(targets: State<'_, Targets>) -> Vec<Target> {
  targets.list()
}

#[tauri::command]
pub fn ssh_target_add(targets: State<'_, Targets>, target: Target) -> Result<Target, String> {
  targets.add(target)
}

#[tauri::command]
pub fn ssh_target_remove(targets: State<'_, Targets>, forwards: State<'_, Forwards>, saved: State<'_, SavedForwards>, id: String) -> Result<(), String> {
  saved.forget_target(&id)?;
  let mut f = forwards.0.lock().unwrap_or_else(|e| e.into_inner());
  f.retain_mut(|(fw, c)| {
    if fw.target_id == id {
      let _ = c.kill();
      false
    } else {
      true
    }
  });
  targets.remove(&id)
}

#[tauri::command]
pub async fn ssh_config_hosts(targets: State<'_, Targets>, query: Option<String>) -> Result<ConfigListing, String> {
  let saved = targets.list();
  let q = query.unwrap_or_default();
  blocking(move || listing(config_hosts(&dirs_home().join(".ssh/config")), &saved, &q)).await
}

/// Imports config aliases as targets (resolved with `ssh -G` when possible, else as written).
#[tauri::command]
pub async fn ssh_import_config(targets: State<'_, Targets>, aliases: Vec<String>) -> Result<Vec<Target>, String> {
  let all = blocking(|| config_hosts(&dirs_home().join(".ssh/config"))).await?;
  let mut added = Vec::new();
  for alias in aliases {
    let Some(h) = all.iter().find(|h| h.alias == alias).cloned() else { continue };
    let resolved = blocking({
      let a = alias.clone();
      move || resolve(&a)
    })
    .await?
    .unwrap_or(h);
    let t = Target {
      id: String::new(),
      label: alias.clone(),
      config_host: Some(alias.clone()),
      host: resolved.hostname,
      port: resolved.port,
      username: resolved.username,
      identity_file: resolved.identity_file,
      jump_host: resolved.jump_host,
      proxy_command: resolved.proxy_command,
    };
    if targets.list().iter().any(|x| x.config_host.as_deref() == Some(alias.as_str())) {
      continue;
    }
    added.push(targets.add(t)?);
  }
  Ok(added)
}

#[tauri::command]
pub async fn ssh_test_connection(targets: State<'_, Targets>, id: String) -> Result<TestResult, String> {
  let t = targets.get(&id)?;
  blocking(move || test(&t)).await
}

/// The command line a terminal runs to open a shell on the target.
#[tauri::command]
pub fn ssh_terminal_command(targets: State<'_, Targets>, id: String) -> Result<Vec<String>, String> {
  let t = targets.get(&id)?;
  let mut argv = vec!["ssh".to_string()];
  argv.extend(destination_args(&t));
  Ok(argv)
}

#[tauri::command]
pub fn ssh_forwards_list(forwards: State<'_, Forwards>) -> Vec<Forward> {
  let mut g = forwards.0.lock().unwrap_or_else(|e| e.into_inner());
  for (f, c) in g.iter_mut() {
    f.running = matches!(c.try_wait(), Ok(None));
  }
  g.iter().map(|(f, _)| f.clone()).collect()
}

/// Starts `ssh -N -L …`; fails when ssh quits within the first second (port taken, refused).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_forward_add(
  targets: State<'_, Targets>,
  forwards: State<'_, Forwards>,
  saved: State<'_, SavedForwards>,
  target_id: String,
  local_port: u16,
  remote_host: String,
  remote_port: u16,
  label: Option<String>,
) -> Result<Forward, String> {
  let t = targets.get(&target_id)?;
  let f = start_forward(&t, &forwards, target_id, local_port, remote_host, remote_port, label).await?;
  // Kept for Restore after a restart (Orca's saved port forwards).
  if let Err(e) = saved.remember(SavedForward { target_id: f.target_id.clone(), local_port, remote_host: f.remote_host.clone(), remote_port, label: f.label.clone() }) {
    log::warn!("ssh forwards: {e}");
  }
  Ok(f)
}

/// Starts `ssh -L` and keeps it in `forwards` (it ends with Kingu).
async fn start_forward(t: &Target, forwards: &Forwards, target_id: String, local_port: u16, remote_host: String, remote_port: u16, label: Option<String>) -> Result<Forward, String> {
  let args = forward_args(t, local_port, &remote_host, remote_port)?;
  if forwards.0.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|(f, _)| f.local_port == local_port) {
    return Err(format!("Local port {local_port} is already forwarded."));
  }
  let mut child = crate::shell_env::command(Path::new("ssh")).args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| format!("ssh: {e}"))?;
  let (child, failed) = blocking(move || {
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(1000) {
      if let Ok(Some(_)) = child.try_wait() {
        let mut err = String::new();
        if let Some(mut e) = child.stderr.take() {
          let _ = e.read_to_string(&mut err);
        }
        return (child, Some(err.lines().rfind(|l| !l.trim().is_empty()).unwrap_or("ssh exited").trim().to_string()));
      }
      std::thread::sleep(Duration::from_millis(50));
    }
    (child, None)
  })
  .await?;
  if let Some(e) = failed {
    return Err(e);
  }
  let f = Forward { id: format!("fw-{target_id}-{local_port}"), target_id, local_port, remote_host: remote_host.trim().to_string(), remote_port, label, running: true };
  forwards.0.lock().unwrap_or_else(|e| e.into_inner()).retain(|(x, _)| x.local_port != local_port);
  forwards.0.lock().unwrap_or_else(|e| e.into_inner()).push((f.clone(), child));
  Ok(f)
}

/// What [`ssh_forwards_restart`] did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Restarted {
  pub restarted: Vec<Forward>,
  /// Forwards that couldn't be started again (`<local port>: <ssh's last line>`); their saved
  /// record stays, so Restore still offers them.
  pub failed: Vec<String>,
}

/// The forwards of `target_id`, taken out of `list` to be started again: each one's ssh is ended
/// first (it rode the connection that dropped, alive or not).
pub fn take_forwards(list: &mut Vec<(Forward, Child)>, target_id: &str) -> Vec<Forward> {
  let mut out = Vec::new();
  let mut i = 0;
  while i < list.len() {
    if list[i].0.target_id == target_id {
      let (f, mut c) = list.remove(i);
      let _ = c.kill();
      let _ = c.wait();
      out.push(f);
    } else {
      i += 1;
    }
  }
  out
}

/// After a host reconnected (Orca `restoreManagedHostPortForwards` on every transition to
/// `connected`, `src/main/ipc/ssh/ssh-connection-state-callbacks.ts`: stale forwards are closed
/// and the saved ones added again): every forward of the host is started again on its old ports.
#[tauri::command]
pub async fn ssh_forwards_restart(targets: State<'_, Targets>, forwards: State<'_, Forwards>, target_id: String) -> Result<Restarted, String> {
  let t = targets.get(&target_id)?;
  let old = take_forwards(&mut forwards.0.lock().unwrap_or_else(|e| e.into_inner()), &target_id);
  let mut done = Restarted { restarted: Vec::new(), failed: Vec::new() };
  for f in old {
    match start_forward(&t, &forwards, f.target_id.clone(), f.local_port, f.remote_host.clone(), f.remote_port, f.label.clone()).await {
      Ok(started) => done.restarted.push(started),
      Err(e) => {
        log::warn!("ssh forward {} of {target_id} not restarted: {e}", f.local_port);
        done.failed.push(format!("{}: {e}", f.local_port));
      }
    }
  }
  Ok(done)
}

/// The host's own `localhost` / `127.0.0.1` / `::1`, as a forward's remote host.
pub fn is_loopback_name(h: &str) -> bool {
  matches!(h.trim().trim_matches(['[', ']']), "localhost" | "127.0.0.1" | "::1")
}

/// A free local port for a browser forward: `want` when nothing on this computer listens on it
/// (the page keeps its port), else one the system picks.
pub fn free_local_port(want: u16, taken: &[u16]) -> Result<u16, String> {
  let bindable = |p: u16| std::net::TcpListener::bind(("127.0.0.1", p)).is_ok();
  if want != 0 && !taken.contains(&want) && bindable(want) {
    return Ok(want);
  }
  let l = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("no free local port: {e}"))?;
  l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

/// The local port that reaches `remote_port` on the host's loopback (VS Code 1.145's "browse over
/// remote agent host connections", Orca's "Browse through SSH workspace hosts", for the pages a dev
/// server on the host serves): a running forward is reused, else one is started on the same port
/// when it is free here, or on a free one. Not remembered for Restore: the browser asks again.
#[tauri::command]
pub async fn ssh_forward_for_browser(targets: State<'_, Targets>, forwards: State<'_, Forwards>, target_id: String, remote_port: u16) -> Result<u16, String> {
  let t = targets.get(&target_id)?;
  let (reuse, taken) = {
    let mut g = forwards.0.lock().unwrap_or_else(|e| e.into_inner());
    // Only a live ssh still forwards (one that ended, the host gone, is left for the Ports list to show).
    let reuse = g.iter_mut().find_map(|(f, c)| (f.target_id == target_id && f.remote_port == remote_port && is_loopback_name(&f.remote_host) && matches!(c.try_wait(), Ok(None))).then_some(f.local_port));
    (reuse, g.iter().map(|(f, _)| f.local_port).collect::<Vec<_>>())
  };
  if let Some(p) = reuse {
    return Ok(p);
  }
  let local = free_local_port(remote_port, &taken)?;
  let f = start_forward(&t, &forwards, target_id, local, "localhost".into(), remote_port, Some("Browser".into())).await?;
  Ok(f.local_port)
}

/// Stops a forward; the user stopping it also forgets it (no Restore offered for it later).
#[tauri::command]
pub fn ssh_forward_remove(forwards: State<'_, Forwards>, saved: State<'_, SavedForwards>, id: String) -> Result<(), String> {
  let mut g = forwards.0.lock().unwrap_or_else(|e| e.into_inner());
  if let Some(i) = g.iter().position(|(f, _)| f.id == id) {
    let (f, mut c) = g.remove(i);
    let _ = c.kill();
    let _ = c.wait();
    saved.forget(&f.target_id, f.local_port)?;
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  #[test]
  #[cfg(unix)]
  fn a_reconnect_takes_only_that_hosts_forwards_and_ends_their_ssh() {
    let fw = |target: &str, port: u16| {
      let f = super::Forward { id: format!("fw-{target}-{port}"), target_id: target.into(), local_port: port, remote_host: "localhost".into(), remote_port: port, label: None, running: true };
      (f, std::process::Command::new("sleep").arg("30").spawn().unwrap())
    };
    let mut list = vec![fw("a", 3000), fw("b", 4000), fw("a", 5000)];
    let taken = super::take_forwards(&mut list, "a");
    assert_eq!(taken.iter().map(|f| f.local_port).collect::<Vec<_>>(), [3000, 5000]);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].0.target_id, "b");
    assert!(matches!(list[0].1.try_wait(), Ok(None)), "another host's forward keeps running");
    let _ = list[0].1.kill();
    let _ = list[0].1.wait();
    let args = super::forward_args(&super::Target { id: "h".into(), label: "h".into(), config_host: Some("box".into()), host: "box".into(), port: 22, username: String::new(), identity_file: None, jump_host: None, proxy_command: None }, 3000, "localhost", 3000).unwrap();
    assert!(args.join(" ").contains("-o ServerAliveInterval=15 -o ServerAliveCountMax=3"), "a forward to a dead host ends");
  }

  #[test]
  fn a_connection_probe_needs_exit_0_and_its_mark_and_reports_sshs_last_line() {
    assert!(probe_ok(true, "motd\nKINGU-SSH-OK\n"));
    assert!(!probe_ok(false, "KINGU-SSH-OK\n"));
    assert!(!probe_ok(true, "This account is currently not available.\n"));
    assert_eq!(probe_error("", "Warning: Permanently added 'h' (ED25519)\nme@h: Permission denied (publickey).\n\n"), "me@h: Permission denied (publickey).");
    assert_eq!(probe_error("", ""), "ssh failed");
    assert_eq!(probe_error("nologin\n", ""), "The SSH host did not answer the connection probe.");
  }

  #[test]
  fn the_shared_connection_keeps_alive_and_disconnect_closes_that_same_socket() {
    let home = tempfile::tempdir().unwrap();
    assert!(mux_args(home.path()).is_empty(), "no ~/.ssh: connections aren't shared");
    assert_eq!(disconnect_args(&target(), home.path()), None);
    std::fs::create_dir(home.path().join(".ssh")).unwrap();
    let mux = mux_args(home.path());
    if cfg!(unix) {
      let joined = mux.join(" ");
      assert!(joined.contains("ControlPath=~/.ssh/kingu-%C"));
      assert!(joined.contains("-o ServerAliveInterval=15 -o ServerAliveCountMax=3"));
      let d = disconnect_args(&target(), home.path()).unwrap();
      assert_eq!(&d[..2], ["-O", "exit"]);
      assert_eq!(&d[2..2 + mux.len()], &mux[..]);
      assert_eq!(&d[2 + mux.len()..], &destination_args(&target())[..]);
    }
  }

  #[test]
  fn browser_forwards_keep_a_free_port_and_know_loopback_names() {
    assert!(super::is_loopback_name("localhost") && super::is_loopback_name("[::1]") && super::is_loopback_name("127.0.0.1"));
    assert!(!super::is_loopback_name("db.internal"));
    let busy = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = busy.local_addr().unwrap().port();
    let other = super::free_local_port(port, &[]).unwrap();
    assert_ne!(other, port, "a port in use here is not reused");
    drop(busy);
    let free = super::free_local_port(0, &[]).unwrap();
    assert_ne!(free, 0);
    assert_ne!(super::free_local_port(free, &[free]).unwrap(), free, "a port Kingu already forwards is skipped");
  }

  use super::*;

  fn target() -> Target {
    Target { id: "t".into(), label: "box".into(), config_host: None, host: "box.example".into(), port: 2222, username: "me".into(), identity_file: Some("~/.ssh/id_ed25519".into()), jump_host: Some("bastion".into()), proxy_command: None }
  }

  #[test]
  fn words_follow_orcas_quoting() {
    assert_eq!(words(r#"web "db main" one\ two"#), vec!["web", "db main", "one two"]);
    assert_eq!(words("  a   b "), vec!["a", "b"]);
  }

  #[test]
  fn reads_config_hosts_with_includes_and_skips_patterns() {
    let d = tempfile::tempdir().unwrap();
    let ssh = d.path();
    std::fs::create_dir(ssh.join("conf.d")).unwrap();
    std::fs::write(
      ssh.join("config"),
      "# comment\nHost web web-alias\n  HostName 10.0.0.5\n  User deploy\n  Port 2200\n  IdentityFile ~/.ssh/web\nHost *.internal !bad *\n  User x\nInclude conf.d/*.conf\nHost db\n  ProxyJump bastion\n  ProxyCommand none\nHost web\n  User ignored\n",
    )
    .unwrap();
    std::fs::write(ssh.join("conf.d/a.conf"), "Host gpu\n  Hostname=gpu.lab\n").unwrap();
    std::fs::write(ssh.join("conf.d/skip.txt"), "Host never\n").unwrap();
    let hosts = config_hosts(&ssh.join("config"));
    let aliases: Vec<_> = hosts.iter().map(|h| h.alias.as_str()).collect();
    assert_eq!(aliases, vec!["web", "web-alias", "gpu", "db"]);
    assert_eq!((hosts[0].hostname.as_str(), hosts[0].port, hosts[0].username.as_str()), ("10.0.0.5", 2200, "deploy"));
    assert_eq!(hosts[2].hostname, "gpu.lab");
    assert_eq!(hosts[3].jump_host.as_deref(), Some("bastion"));
    assert_eq!(hosts[3].proxy_command, None);
    assert_eq!(hosts[3].hostname, "db");
  }

  #[test]
  fn listing_filters_marks_added_and_caps() {
    let mk = |a: &str| ConfigHost { alias: a.into(), hostname: format!("{a}.lan"), port: 22, username: "u".into(), identity_file: None, proxy_command: None, jump_host: None, already_added: false };
    let mut saved = target();
    saved.config_host = Some("b".into());
    let l = listing(vec![mk("a"), mk("b"), mk("c")], &[saved], "");
    assert_eq!((l.total_host_count, l.new_host_count, l.match_count), (3, 2, 3));
    assert!(l.hosts[1].already_added);
    assert_eq!(listing(vec![mk("alpha"), mk("beta")], &[], "BET").hosts.len(), 1);
    let many: Vec<_> = (0..150).map(|i| mk(&format!("h{i}"))).collect();
    let l = listing(many, &[], "");
    assert_eq!((l.hosts.len(), l.has_more), (MAX_LISTED, true));
  }

  #[test]
  fn parses_ssh_g_like_orca() {
    let out = "host web\nhostname 10.0.0.5\nuser deploy\nport 2200\nidentityfile none\nidentityfile ~/.ssh/web\nproxycommand none\nproxyjump bastion\n";
    let h = parse_ssh_g("web", out).unwrap();
    assert_eq!((h.hostname.as_str(), h.port, h.username.as_str()), ("10.0.0.5", 2200, "deploy"));
    assert_eq!(h.identity_file.as_deref(), Some("~/.ssh/web"));
    assert_eq!((h.proxy_command, h.jump_host.as_deref()), (None, Some("bastion")));
    assert!(parse_ssh_g("x", "user a\n").is_none());
  }

  #[test]
  fn quotes_and_browse_script() {
    assert_eq!(sh_quote("it's"), r"'it'\''s'");
    assert_eq!(browse_script(""), format!("cd \"$HOME\" && pwd && {LIST_SCRIPT}"));
    assert_eq!(browse_script("~/src"), format!("cd \"$HOME\"/'src' && pwd && {LIST_SCRIPT}"));
    assert_eq!(browse_script("/srv/app's"), format!(r"cd '/srv/app'\''s' && pwd && {LIST_SCRIPT}"));
  }

  #[test]
  fn powershell_fallback_like_orca() {
    assert!(powershell_browse("/").contains("Get-PSDrive"));
    assert!(powershell_browse("~").contains("$dir = $HOME;"));
    assert!(powershell_browse("~/proj").contains("$dir = (Join-Path $HOME 'proj');"));
    assert!(powershell_browse("/C:").contains("$dir = 'C:/';"));
    assert!(powershell_browse("C:/it's").contains("$dir = 'C:/it''s';"));
    let cmd = powershell_command("Write-Output 'x'");
    assert!(cmd.starts_with("powershell -NoProfile -NonInteractive -EncodedCommand "));
    let d = parse_listing("C:/Users/me\nDocuments/\nnotes.txt\n").unwrap();
    assert_eq!((d.path.as_str(), d.entries.len()), ("C:/Users/me", 2));
  }

  #[test]
  fn list_script_runs_and_marks_folders_and_links_to_folders() {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir(d.path().join("src")).unwrap();
    std::fs::write(d.path().join("a.txt"), "").unwrap();
    std::fs::write(d.path().join(".env"), "").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(d.path().join("src"), d.path().join("link")).unwrap();
    let out = Command::new("sh").arg("-c").arg(browse_script(&d.path().to_string_lossy())).output().unwrap();
    let listing = parse_listing(&String::from_utf8_lossy(&out.stdout)).unwrap();
    assert!(listing.entries.contains(&"src/".to_string()));
    assert!(listing.entries.contains(&".env".to_string()));
    #[cfg(unix)]
    assert!(listing.entries.contains(&"link/".to_string()), "{:?}", listing.entries);
    let missing = Command::new("sh").arg("-c").arg(browse_script("/definitely/not/here")).output().unwrap();
    assert!(!missing.status.success(), "a missing folder is an error");
  }

  #[test]
  fn reads_a_remote_listing() {
    let d = parse_listing("/home/me\n./\n../\nREADME.md\nsrc/\n.git/\nnotes.txt\n").unwrap();
    assert_eq!(d.path, "/home/me");
    assert_eq!(d.entries, vec!["src/", ".git/", "README.md", "notes.txt"]);
    assert!(parse_listing("bash: cd: nope\n").is_none());
    let many = format!("/x\n{}", (0..MAX_ENTRIES + 3).map(|i| format!("f{i}\n")).collect::<String>());
    let d = parse_listing(&many).unwrap();
    assert!(d.truncated && d.entries.len() == MAX_ENTRIES);
  }

  #[test]
  fn reads_listening_ports_from_ss_netstat_and_lsof() {
    let ss = "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 511 127.0.0.1:5173 0.0.0.0:*\nLISTEN 0 128 [::]:3000 [::]:*\n";
    assert_eq!(parse_ports(ss), vec![3000, 5173]);
    let netstat = "Active Internet connections (only servers)\nProto Recv-Q Send-Q Local Address Foreign Address State\ntcp 0 0 0.0.0.0:8080 0.0.0.0:* LISTEN\ntcp6 0 0 :::9229 :::* LISTEN\ntcp 0 0 10.0.0.2:5000 10.0.0.9:51000 ESTABLISHED\n";
    assert_eq!(parse_ports(netstat), vec![8080, 9229]);
    let lsof = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 123 me 20u IPv4 0x1 0t0 TCP *:4200 (LISTEN)\nnode 123 me 21u IPv6 0x2 0t0 TCP [::1]:4200 (LISTEN)\n";
    assert_eq!(parse_ports(lsof), vec![4200]);
  }

  #[cfg(unix)]
  #[test]
  fn the_ports_script_falls_back_to_lsof_when_netstat_lists_no_listeners() {
    use std::os::unix::fs::PermissionsExt;
    let run = |netstat: &str| {
      let d = tempfile::tempdir().unwrap();
      for (name, body) in [("netstat", netstat), ("lsof", "echo 'node 1 me 20u IPv4 0x1 0t0 TCP *:4200 (LISTEN)'")] {
        let p = d.path().join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
      }
      let path = format!("{}:/bin:/usr/bin", d.path().display());
      let out = std::process::Command::new("/bin/sh").args(["-c", PORTS_SCRIPT]).env("PATH", path).output().unwrap();
      parse_ports(&String::from_utf8_lossy(&out.stdout))
    };
    // macOS: `netstat -ltn` succeeds with established connections only.
    assert_eq!(run("echo 'tcp4 0 0 127.0.0.1.22223 127.0.0.1.52264 ESTABLISHED'"), vec![4200]);
    // Linux net-tools: its listeners are used.
    assert_eq!(run("echo 'tcp 0 0 0.0.0.0:8080 0.0.0.0:* LISTEN'"), vec![8080]);
  }

  #[test]
  fn saved_forwards_and_what_needs_restoring() {
    let d = tempfile::tempdir().unwrap();
    let s = SavedForwards::load(d.path().join("f.json"));
    let sf = |t: &str, p: u16| SavedForward { target_id: t.into(), local_port: p, remote_host: "localhost".into(), remote_port: p, label: None };
    s.remember(sf("a", 3000)).unwrap();
    s.remember(sf("a", 4000)).unwrap();
    s.remember(sf("b", 3000)).unwrap(); // same local port: replaces a's 3000
    assert_eq!(SavedForwards::load(d.path().join("f.json")).list().len(), 2);
    let running = vec![Forward { id: "x".into(), target_id: "b".into(), local_port: 3000, remote_host: "localhost".into(), remote_port: 3000, label: None, running: true }];
    assert_eq!(unrestored(&s.list(), &running).iter().map(|x| x.local_port).collect::<Vec<_>>(), vec![4000]);
    s.forget("a", 4000).unwrap();
    s.forget_target("b").unwrap();
    assert!(s.list().is_empty());
  }

  #[test]
  fn resolve_passes_a_config_only_when_home_differs() {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir(d.path().join(".ssh")).unwrap();
    std::fs::write(d.path().join(".ssh/config"), "Host x\n").unwrap();
    let cfg = d.path().join(".ssh/config").to_string_lossy().into_owned();
    // $HOME is the account's own home: ssh reads its config by itself.
    assert_eq!(resolve_args("web", d.path(), Some(d.path())), vec!["-G", "--", "web"]);
    // $HOME points elsewhere: that config is named.
    assert_eq!(resolve_args("web", d.path(), Some(Path::new("/elsewhere"))), vec!["-F".to_string(), cfg, "-G".into(), "--".into(), "web".into()]);
    // No config there: nothing to name.
    assert_eq!(resolve_args("web", Path::new("/nonexistent-home"), None), vec!["-G", "--", "web"]);
  }

  #[test]
  fn builds_ssh_arguments() {
    assert_eq!(destination_args(&target()), vec!["-p", "2222", "-i", "~/.ssh/id_ed25519", "-J", "bastion", "--", "me@box.example"]);
    let mut t = target();
    t.config_host = Some("web".into());
    assert_eq!(destination_args(&t), vec!["--", "web"]);
    let f = forward_args(&t, 3000, "localhost", 5173).unwrap();
    assert!(f.contains(&"127.0.0.1:3000:localhost:5173".to_string()) && f.contains(&"ExitOnForwardFailure=yes".to_string()));
    assert!(forward_args(&t, 0, "localhost", 1).is_err());
    assert!(forward_args(&t, 1, "-oProxyCommand=x", 1).is_err());
  }

  #[test]
  fn validates_targets() {
    assert!(validate(&target()).is_ok());
    let mut t = target();
    t.host = "-oProxyCommand=evil".into();
    assert!(validate(&t).is_err());
    let mut t = target();
    t.username = "a b".into();
    assert!(validate(&t).is_err());
    let mut t = target();
    t.config_host = Some("*.lan".into());
    assert!(validate(&t).is_err());
  }

  #[test]
  fn store_adds_and_removes() {
    let d = tempfile::tempdir().unwrap();
    let s = Targets::load(d.path().join("ssh-targets.json"));
    let mut t = target();
    t.label = String::new();
    let added = s.add(t).unwrap();
    assert_eq!(added.label, "box.example");
    assert_eq!(Targets::load(d.path().join("ssh-targets.json")).list().len(), 1);
    s.remove(&added.id).unwrap();
    assert!(s.list().is_empty());
  }

  #[test]
  fn a_refused_connection_fails_fast_without_prompting() {
    let mut t = target();
    t.host = "127.0.0.1".into();
    t.port = 1;
    t.jump_host = None;
    t.identity_file = None;
    let r = test(&t);
    assert!(!r.success);
    assert!(r.millis < TEST_TIMEOUT_MS);
  }
}
