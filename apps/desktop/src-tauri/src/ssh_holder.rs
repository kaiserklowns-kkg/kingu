//! The terminal holder on an SSH host: what keeps a remote terminal (and the agent CLI in it)
//! running when the connection drops, so it can be shown again after the reconnect.
//!
//! Orca (source at 3b2f28b30, 1.4.269) installs a server on the host, `orcad`, which drives a
//! terminal daemon there; a pane reattaches with a snapshot of its screen once the host is back
//! (`src/main/ssh/legacy-relay/README.md`, `src/main/daemon`, `src/shared/remote-runtime/
//! orcad-distribution/orcad-artifacts.ts`). Kingu's holder is `kingu-ptyd`, the same daemon that
//! keeps local terminals alive after the app quits, used on the host through its `attach`
//! subcommand (crates/kingu-ptyd/src/attach.rs): the terminal tab runs
//! `ssh -t <host> kingu-ptyd attach --key <session>`, the daemon is a session of its own on the
//! host, and after a drop the same command shows the session again, scrollback first.
//!
//! - **Delivery.** One static binary per platform (`uname -sm` → [`triple_for`]), shipped with the
//!   app as `host-bin/kingu-ptyd-<triple>` (tools/build-ptyd-host.ts). It is piped to the host over
//!   ssh's stdin into `~/.kingu/host/kingu-ptyd-<version>-<digest>/` (Orca:
//!   `~/.orca-remote/orcad-<version>+<digest>`, `remote-install-model.ts`), where the digest is the
//!   first 16 hex characters of the binary's SHA-256 (Orca's build hash, `orcad-build-identity.ts`).
//!   The host checks size and SHA-256 and runs `host-info` before the folder is put in place.
//! - **Handshake.** A host is ready when that folder holds a binary whose `host-info` names a
//!   protocol this app's daemon client still speaks ([`usable`]). Another app version installs its
//!   own folder next to it; nothing is replaced, and a daemon started by an older binary keeps its
//!   sessions (the socket name carries the protocol, as on this computer). Once this app's folder
//!   is in use, older folders no process runs from are removed ([`prune_script`]).
//! - **Consent.** The window installs only on a host the user allowed (asked the first time,
//!   sshHolder.ts); Orca installs `orcad` without asking.
//! - **When it can't be installed** (a platform without a binary, a binary missing from this
//!   build, a home mounted `noexec`): the host is used without a holder, as before. Orca marks
//!   such a host unserved and offers a plain SSH terminal without persistence
//!   (`ssh-host-unserved-status.ts`); Kingu's plain terminal additionally starts the agent again
//!   with its resume command after a reconnect, said in the terminal as a restart ([`loop_script`]).
//!
//! Everything here is a script or an argv, so the tests run them with `sh` and a stand-in `ssh`;
//! nothing in the tests reaches a host.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Manager, State};

use crate::agent::hooks;
use crate::agent::permission_rules::{self, Scope};
use crate::projects::Projects;
use crate::ssh_hosts::{self, Target, Targets, sh_quote};

/// Under the host's `$HOME`: the holder's folders, its socket folder (`run`) and Kingu's scripts.
pub const ROOT: &str = ".kingu/host";
/// Where a remote session's hook file lives (ssh_remote.rs reads it).
pub const HOOKS_DIR: &str = ".kingu/agent-hooks";
const HOLD_SCRIPT: &str = "permission-hold.sh";
/// The upload and its checks (a 1 MB binary; a slow link still gets two minutes, Kingu's limit).
pub const INSTALL_TIMEOUT_MS: u64 = 120_000;
/// Orca `ORCAD_IDLE_EXIT_TIMEOUT_MS`: a host server with no terminal left exits after 15 minutes.
pub const IDLE_SECONDS: u64 = 15 * 60;
/// Orca `CONNECT_TIMEOUT_MS` (`ssh-connection-timing.ts`), for a terminal's own ssh.
pub const TERMINAL_CONNECT_TIMEOUT_S: u64 = 30;
/// `kingu-ptyd attach` exit codes (crates/kingu-ptyd/src/attach.rs); ssh itself exits 255 when the
/// connection is lost.
pub const EXIT_NO_SESSION: i32 = 3;
pub const SSH_LOST: i32 = 255;
/// The start script's own code when the holder's folder is gone from the host.
pub const EXIT_NO_HOLDER: i32 = 127;

const UNAME_MARK: &str = "@@kingu-uname ";
const HOLDER_MARK: &str = "@@kingu-holder ";

// ---------------------------------------------------------------------------------------------
// Platforms and the binaries this build carries

/// Every host platform Kingu has a holder for. Linux binaries are static (musl), so one serves
/// glibc and musl hosts alike (Orca ships both because its Node runtime links libc).
pub const TRIPLES: [&str; 4] = ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl", "aarch64-apple-darwin", "x86_64-apple-darwin"];

/// `uname -sm` → the binary's target triple; `Err` carries the platform as the host named it.
pub fn triple_for(uname: &str) -> Result<&'static str, String> {
  let mut words = uname.split_whitespace();
  match (words.next().unwrap_or(""), words.next().unwrap_or("")) {
    ("Linux", "x86_64" | "amd64") => Ok(TRIPLES[0]),
    ("Linux", "aarch64" | "arm64") => Ok(TRIPLES[1]),
    ("Darwin", "arm64" | "aarch64") => Ok(TRIPLES[2]),
    ("Darwin", "x86_64") => Ok(TRIPLES[3]),
    _ => Err(uname.trim().to_string()),
  }
}

/// This app's own platform, whose daemon binary (next to the app) also serves a host of the same kind.
pub fn own_triple() -> Option<&'static str> {
  match (std::env::consts::OS, std::env::consts::ARCH) {
    ("macos", "aarch64") => Some(TRIPLES[2]),
    ("macos", "x86_64") => Some(TRIPLES[3]),
    _ => None,
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Artefact {
  pub triple: String,
  pub path: PathBuf,
  pub sha256: String,
  pub size: u64,
}

/// `kingu-ptyd-<triple>` in the first of `dirs` that has it; for this computer's own platform the
/// app's daemon (`own`) when no such file is shipped.
pub fn artefact_file(dirs: &[PathBuf], triple: &str, own: Option<&Path>) -> Option<PathBuf> {
  dirs.iter().map(|d| d.join(format!("kingu-ptyd-{triple}"))).find(|p| p.is_file()).or_else(|| own.filter(|_| own_triple() == Some(triple)).filter(|p| p.is_file()).map(Path::to_path_buf))
}

pub fn read_artefact(triple: &str, path: &Path) -> Result<(Artefact, Vec<u8>), String> {
  let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
  let sha256 = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
  Ok((Artefact { triple: triple.to_string(), path: path.to_path_buf(), sha256, size: bytes.len() as u64 }, bytes))
}

/// The holder's folder name on the host: this app's version and the binary's digest.
pub fn install_id(version: &str, sha256: &str) -> String {
  let v: String = version.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' { c } else { '_' }).take(32).collect();
  format!("kingu-ptyd-{v}-{}", &sha256[..sha256.len().min(16)])
}

/// A folder name [`install_id`] made (it goes into scripts unquoted).
pub fn valid_id(id: &str) -> bool {
  id.starts_with("kingu-ptyd-") && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

// ---------------------------------------------------------------------------------------------
// Probe, decision, install

/// What `kingu-ptyd host-info` prints.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
  pub name: String,
  pub version: String,
  pub protocol: u32,
  pub min_compatible: u32,
  #[serde(default)]
  pub os: String,
  #[serde(default)]
  pub arch: String,
}

/// The binary is Kingu's daemon and speaks a protocol this app's daemon code still speaks.
pub fn usable(info: &HostInfo) -> bool {
  use kingu_ptyd::protocol::{MIN_COMPATIBLE, PROTOCOL};
  info.name == "kingu-ptyd" && info.protocol >= MIN_COMPATIBLE && PROTOCOL >= info.min_compatible
}

/// The host's platform, then for each candidate folder that is complete what its binary reports.
pub fn probe_script(ids: &[String]) -> String {
  let ids = ids.iter().filter(|i| valid_id(i)).cloned().collect::<Vec<_>>().join(" ");
  format!(
    "printf '{UNAME_MARK}%s\\n' \"$(uname -sm)\"\nfor id in {ids}; do d=\"$HOME/{ROOT}/$id\"; if [ -f \"$d/.install-complete\" ] && [ -x \"$d/kingu-ptyd\" ]; then printf '{HOLDER_MARK}%s %s\\n' \"$id\" \"$(\"$d/kingu-ptyd\" host-info 2>/dev/null | head -n 1)\"; fi; done"
  )
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Probe {
  pub uname: String,
  /// Installed folders whose binary answered `host-info`.
  pub installed: Vec<(String, HostInfo)>,
}

pub fn parse_probe(out: &str) -> Probe {
  let mut p = Probe::default();
  for line in out.lines() {
    if let Some(u) = line.strip_prefix(UNAME_MARK) {
      p.uname = u.trim().to_string();
    } else if let Some((id, info)) = line.strip_prefix(HOLDER_MARK).and_then(|rest| rest.split_once(' '))
      && let Ok(info) = serde_json::from_str::<HostInfo>(info)
    {
      p.installed.push((id.to_string(), info));
    }
  }
  p
}

/// What the window is told about a host's holder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum Holder {
  /// Installed and answering: terminals are held on the host. `installed`: by this call.
  Ready { id: String, platform: String, installed: bool },
  /// This build has the platform's binary and the host doesn't yet.
  NeedsInstall { id: String, platform: String, size: u64 },
  /// No holder exists for this platform.
  Unsupported { platform: String },
  /// A supported platform whose binary isn't in this build (`bun run build:ptyd-host`).
  NoArtefact { platform: String, triple: String },
}

/// Ready, to install, or impossible, from the host's answer and the binaries this build carries.
pub fn decide(probe: &Probe, artefacts: &[Artefact], version: &str) -> Holder {
  let platform = probe.uname.clone();
  let triple = match triple_for(&probe.uname) {
    Ok(t) => t,
    Err(_) => return Holder::Unsupported { platform },
  };
  let Some(a) = artefacts.iter().find(|a| a.triple == triple) else {
    return Holder::NoArtefact { platform, triple: triple.to_string() };
  };
  let id = install_id(version, &a.sha256);
  if probe.installed.iter().any(|(i, info)| *i == id && usable(info)) { Holder::Ready { id, platform, installed: false } } else { Holder::NeedsInstall { id, platform, size: a.size } }
}

/// Receives the binary on stdin and puts it in place only when it is whole (size, then SHA-256
/// with whichever tool the host has) and runs (`host-info`: a `noexec` home or a wrong platform
/// fails here). Exit codes: 21 incomplete, 22 checksum, 23 can't run. Prints the handshake line.
pub fn install_script(id: &str, sha256: &str, size: u64) -> Result<String, String> {
  if !valid_id(id) || sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
    return Err("invalid holder id or checksum".into());
  }
  Ok(format!(
    r#"umask 077
root="$HOME/{ROOT}"; d="$root/{id}"; tmp="$root/.incoming-$$"
mkdir -p "$root" || exit 20
rm -rf "$tmp"; mkdir "$tmp" || exit 20
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/kingu-ptyd" || exit 20
n=$(wc -c < "$tmp/kingu-ptyd" | tr -d ' ')
[ "$n" = {size} ] || {{ printf 'kingu-install: incomplete upload (%s of {size} bytes)\n' "$n" >&2; exit 21; }}
h=
if command -v sha256sum >/dev/null 2>&1; then h=$(sha256sum "$tmp/kingu-ptyd" | cut -d' ' -f1)
elif command -v shasum >/dev/null 2>&1; then h=$(shasum -a 256 "$tmp/kingu-ptyd" | cut -d' ' -f1)
elif command -v openssl >/dev/null 2>&1; then h=$(openssl dgst -sha256 "$tmp/kingu-ptyd" | sed 's/.*= *//')
fi
[ -z "$h" ] || [ "$h" = {sha256} ] || {{ printf 'kingu-install: checksum mismatch\n' >&2; exit 22; }}
chmod 700 "$tmp/kingu-ptyd"
info=$("$tmp/kingu-ptyd" host-info 2>&1 | head -n 1) || info=
case "$info" in '{{'*) ;; *) printf 'kingu-install: the terminal host cannot run on this host (%s)\n' "$info" >&2; exit 23 ;; esac
rm -rf "$d"
mv "$tmp" "$d" || exit 20
trap - EXIT
: > "$d/.install-complete"
printf '{HOLDER_MARK}%s %s\n' {id} "$info""#
  ))
}

// ---------------------------------------------------------------------------------------------
// Old holder folders (Orca: `gcOldOrcadVersions`, src/main/managed-server/install/orcad-remote-gc.ts
// and remote-install-gc.ts, run after an activation by `pruneManagedOrcadVersions`)

const DIR_MARK: &str = "@@kingu-holder-dir ";
const PRUNE_MARK: &str = "@@kingu-prune ";

/// The holder folders on the host whose install finished.
pub fn folders_script() -> String {
  format!("for d in \"$HOME/{ROOT}\"/kingu-ptyd-*; do if [ -d \"$d\" ] && [ -f \"$d/.install-complete\" ]; then printf '{DIR_MARK}%s\\n' \"${{d##*/}}\"; fi; done")
}

pub fn parse_folders(out: &str) -> Vec<String> {
  out.lines().filter_map(|l| l.strip_prefix(DIR_MARK)).map(|s| s.trim().to_string()).filter(|s| valid_id(s)).collect()
}

/// The version an [`install_id`] carries, as numbers (`0.2.0_beta` → `[0, 2, 0]`); `None` when a
/// part has no number to compare.
fn folder_version(id: &str) -> Option<Vec<u64>> {
  let (v, digest) = id.strip_prefix("kingu-ptyd-")?.rsplit_once('-')?;
  if digest.is_empty() {
    return None;
  }
  v.split('.').map(|p| p.chars().take_while(char::is_ascii_digit).collect::<String>().parse().ok()).collect()
}

fn version_of(v: &str) -> Option<Vec<u64>> {
  folder_version(&install_id(v, "0"))
}

/// The folders that may go: never `current` (the one in use), never one of a newer Kingu (another
/// computer's newer app may still use it; Orca pins the active and rollback versions and those a
/// live daemon runs), never one whose version can't be read.
pub fn prune_candidates(folders: &[String], current: &str, version: &str) -> Vec<String> {
  let Some(mine) = version_of(version) else { return Vec::new() };
  let cmp = |a: &[u64]| {
    let n = a.len().max(mine.len());
    let pad = |x: &[u64]| (0..n).map(|i| x.get(i).copied().unwrap_or(0)).collect::<Vec<_>>();
    pad(a) <= pad(&mine)
  };
  folders.iter().filter(|f| *f != current && valid_id(f) && folder_version(f).is_some_and(|v| cmp(&v))).cloned().collect()
}

/// Removes each folder no process runs from (its daemon, holding sessions, or a terminal attached
/// through it: their command lines name `/<folder>/kingu-ptyd`). Without a process list nothing
/// goes (Orca: an inconclusive liveness check keeps the folder). A folder is renamed first, then
/// deleted, so an install of the same name never meets half a folder (Orca's tombstone).
pub fn prune_script(ids: &[String]) -> String {
  let ids = ids.iter().filter(|i| valid_id(i)).cloned().collect::<Vec<_>>().join(" ");
  format!(
    r#"root="$HOME/{ROOT}"
procs=$(ps -A -ww -o args= 2>/dev/null) || procs=$(ps -o args 2>/dev/null) || procs=
[ -n "$procs" ] || {{ printf '{PRUNE_MARK}unknown\n'; exit 0; }}
for id in {ids}; do
  d="$root/$id"; [ -d "$d" ] || continue
  case "$procs" in *"/$id/kingu-ptyd"*) printf '{PRUNE_MARK}kept %s\n' "$id"; continue ;; esac
  t="$root/.gc-$id-$$"
  if mv "$d" "$t" 2>/dev/null; then rm -rf "$t"; printf '{PRUNE_MARK}removed %s\n' "$id"; fi
done"#
  )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct Pruned {
  pub removed: Vec<String>,
  /// In use by a running process.
  pub kept: Vec<String>,
  /// The host listed no processes: nothing was removed.
  pub unknown: bool,
}

pub fn parse_prune(out: &str) -> Pruned {
  let mut p = Pruned::default();
  for l in out.lines().filter_map(|l| l.strip_prefix(PRUNE_MARK)) {
    match l.trim().split_once(' ') {
      Some(("removed", id)) => p.removed.push(id.to_string()),
      Some(("kept", id)) => p.kept.push(id.to_string()),
      _ if l.trim() == "unknown" => p.unknown = true,
      _ => {}
    }
  }
  p
}

/// Writes Kingu's permission-hold script (agent/hooks.rs) from stdin next to the holder; it needs
/// no binary, so a host without a holder gets it too.
pub fn hold_setup_script() -> String {
  format!("umask 077; d=\"$HOME/{ROOT}\"; mkdir -p \"$d\" \"$HOME/{HOOKS_DIR}\" && cat > \"$d/{HOLD_SCRIPT}.tmp\" && mv \"$d/{HOLD_SCRIPT}.tmp\" \"$d/{HOLD_SCRIPT}\"")
}

// ---------------------------------------------------------------------------------------------
// Terminal commands

/// What `sh -c` runs on the host to start (or show again) session `key` in `path`: `agent` is typed
/// into the session's login shell once, and stays out of a later attach to the same live key. The
/// session's `KINGU_AGENT_HOOK_FILE` is the hook file of `token`, for every CLI whose hooks know it.
pub fn start_script(id: &str, key: &str, path: &str, token: Option<&str>, agent: Option<&[String]>) -> Result<String, String> {
  check(id, key, token)?;
  if !path.starts_with('/') {
    return Err("the folder on the host must be an absolute path".into());
  }
  let mut s = format!("d=\"$HOME/{ROOT}\"; b=\"$d/{id}/kingu-ptyd\"; [ -x \"$b\" ] || exit {EXIT_NO_HOLDER}; ");
  let mut env = String::new();
  if let Some(t) = token {
    s.push_str(&format!("mkdir -p \"$HOME/{HOOKS_DIR}\"; "));
    env = format!(" --env \"KINGU_AGENT_HOOK_FILE=$HOME/{HOOKS_DIR}/{t}.jsonl\"");
  }
  s.push_str(&format!("exec \"$b\" attach --dir \"$d/run\" --key {key} --cwd {}{env} --idle-seconds {IDLE_SECONDS}", sh_quote(path)));
  if let Some(a) = agent.filter(|a| !a.is_empty()) {
    s.push_str(" --");
    for w in a {
      s.push(' ');
      s.push_str(&sh_quote(w));
    }
  }
  Ok(s)
}

/// Shows live session `key` again; exits [`EXIT_NO_SESSION`] when it ended meanwhile.
pub fn reattach_script(id: &str, key: &str) -> Result<String, String> {
  check(id, key, None)?;
  Ok(format!("d=\"$HOME/{ROOT}\"; b=\"$d/{id}/kingu-ptyd\"; [ -x \"$b\" ] || exit {EXIT_NO_SESSION}; exec \"$b\" attach --dir \"$d/run\" --key {key}"))
}

/// The sessions the host's daemon holds, as JSON (`[]` without a daemon; never starts one).
pub fn sessions_script(id: &str) -> Result<String, String> {
  check(id, "k", None)?;
  Ok(format!("d=\"$HOME/{ROOT}\"; b=\"$d/{id}/kingu-ptyd\"; if [ -x \"$b\" ]; then \"$b\" sessions --dir \"$d/run\"; else printf '[]\\n'; fi"))
}

/// Ends session `key` on the host (closing its tab; a session nobody shows would run on).
pub fn end_script(id: &str, key: &str) -> Result<String, String> {
  check(id, key, None)?;
  Ok(format!("d=\"$HOME/{ROOT}\"; b=\"$d/{id}/kingu-ptyd\"; [ -x \"$b\" ] && \"$b\" end --dir \"$d/run\" --key {key}"))
}

fn check(id: &str, key: &str, token: Option<&str>) -> Result<(), String> {
  if !valid_id(id) {
    return Err("invalid holder id".into());
  }
  kingu_ptyd::validate_key(key)?;
  if token.is_some_and(|t| !hooks::valid_token(t)) {
    return Err("invalid hook token".into());
  }
  Ok(())
}

/// A session key for a new remote terminal (`ssh:<random>`).
pub fn session_key(random: &str) -> String {
  format!("ssh:{random}")
}

/// The terminal's own ssh for `script` on the host: its own connection (it may ask for a
/// passphrase itself, as Orca's plain SSH terminal does), with the keepalives the shared
/// connection uses so a dead peer ends it within 45 s (exit 255) instead of leaving the tab
/// hanging, and Orca's 30 s to connect.
pub fn terminal_ssh(t: &Target, script: &str) -> Vec<String> {
  let mut argv: Vec<String> = ["ssh", "-t", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o"].map(String::from).to_vec();
  argv.push(format!("ConnectTimeout={TERMINAL_CONNECT_TIMEOUT_S}"));
  argv.extend(ssh_hosts::destination_args(t));
  argv.push(format!("sh -c {}", sh_quote(script)));
  argv
}

/// What the loop says in the terminal (the window passes them translated).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LoopText {
  /// The connection dropped; the session is held on the host.
  pub lost_held: String,
  /// The connection dropped and took the agent with it; it will be started again.
  pub lost_restart: String,
  /// The connection dropped and nothing can be brought back.
  pub lost_gone: String,
  /// The host answers again: reattaching.
  pub reattaching: String,
  /// The host answers again: starting the agent again with its resume command.
  pub restarting: String,
  /// The held session ended while the host was away.
  pub ended: String,
  /// ssh keeps failing right away: the loop stops.
  pub gave_up: String,
}

impl Default for LoopText {
  fn default() -> Self {
    Self {
      lost_held: "[Kingu] The connection to the host was lost. This terminal keeps running on the host and is shown again once the host is connected. Ctrl+C stops waiting.".into(),
      lost_restart: "[Kingu] The connection to the host was lost, and the agent ended with it. It is started again with its resume command once the host is connected. Ctrl+C stops waiting.".into(),
      lost_gone: "[Kingu] The connection to the host was lost, and this terminal ended with it.".into(),
      reattaching: "[Kingu] The host is connected again. Showing the terminal that kept running there.".into(),
      restarting: "[Kingu] The host is connected again. Starting the agent again (a new process that resumes its last session, not the terminal that was lost).".into(),
      ended: "[Kingu] This terminal ended on the host while it was disconnected.".into(),
      gave_up: "[Kingu] ssh keeps failing; not trying again. Start the terminal again from the side bar.".into(),
    }
  }
}

fn command_line(argv: &[String]) -> String {
  argv.iter().map(|w| sh_quote(w)).collect::<Vec<_>>().join(" ")
}

/// A run under this many seconds that ends as a lost connection never was one (a refused dial).
const SHORT_RUN_S: u32 = 5;
/// This many of those in a row stop the loop.
const MAX_SHORT_RUNS: u32 = 3;

/// What the terminal tab runs on this computer (`sh -c <this>`): `first`, and each time ssh ends
/// as a lost connection (exit 255) it waits for the host and runs `again` (a reattach, or the
/// agent's resume command), until the session ends some other way.
///
/// `wait`: a command that succeeds once the host's shared connection is up again (`ssh -O check`,
/// the connection Kingu's reconnect ladder redials); without one the loop pauses 5 s per try.
/// `again: None`: nothing can be brought back, the loss is only said. `held`: `again` reattaches
/// (else it restarts). Three losses in a row within 5 s each (the host refuses the terminal's ssh
/// while its shared connection answers) end the loop instead of spinning.
pub fn loop_script(first: &[String], again: Option<&[String]>, wait: Option<&[String]>, held: bool, text: &LoopText) -> String {
  let say = |msg: &str| format!("printf '\\r\\n\\033[33m%s\\033[0m\\r\\n' {}", sh_quote(msg));
  let Some(again) = again else {
    return format!("{}\nc=$?\nif [ \"$c\" -eq {SSH_LOST} ]; then {}; fi\nexit \"$c\"", command_line(first), say(&text.lost_gone));
  };
  let wait = match wait.filter(|w| !w.is_empty()) {
    Some(w) => format!("until {} >/dev/null 2>&1; do sleep 2; done", command_line(w)),
    None => "sleep 5".to_string(),
  };
  let (lost, back) = if held { (&text.lost_held, &text.reattaching) } else { (&text.lost_restart, &text.restarting) };
  format!(
    "n=0\nt=$(date +%s)\n{first}\nc=$?\nwhile [ \"$c\" -eq {SSH_LOST} ]; do\n  if [ $(( $(date +%s) - t )) -lt {SHORT_RUN_S} ]; then n=$((n + 1)); else n=0; fi\n  if [ \"$n\" -ge {MAX_SHORT_RUNS} ]; then {gave_up}; break; fi\n  {lost}\n  sleep 2\n  {wait}\n  {back}\n  t=$(date +%s)\n  {again}\n  c=$?\ndone\nif [ \"$c\" -eq {EXIT_NO_SESSION} ]; then {ended}; fi\nexit \"$c\"",
    first = command_line(first),
    again = command_line(again),
    gave_up = say(&text.gave_up),
    lost = say(lost),
    back = say(back),
    ended = if held { say(&text.ended) } else { ":".to_string() },
  )
}

/// `ssh -O check` on the host's shared connection (ssh_hosts.rs `mux_args`), or `None` where
/// connections aren't shared.
pub fn wait_argv(t: &Target, home: &Path) -> Option<Vec<String>> {
  let mux = ssh_hosts::mux_args(home);
  if mux.is_empty() {
    return None;
  }
  let mut a = vec!["ssh".to_string(), "-O".to_string(), "check".to_string()];
  a.extend(mux);
  a.extend(ssh_hosts::destination_args(t));
  Some(a)
}

// ---------------------------------------------------------------------------------------------
// Permission answers for a claude on the host (agent/hooks.rs does the same on this computer)

fn hold_base(token: &str, hold: &str) -> Result<String, String> {
  if !hooks::valid_token(token) {
    return Err("invalid hook token".into());
  }
  if !hooks::valid_hold(hold) {
    return Err("invalid hold id".into());
  }
  Ok(format!("\"$HOME/{HOOKS_DIR}/{token}.{hold}\""))
}

/// Prints the PermissionRequest line the hold script recorded for `hold` (its last one).
pub fn held_request_script(token: &str, hold: &str) -> Result<String, String> {
  hold_base(token, hold)?;
  Ok(format!("grep -F -- '{{\"kingu_hold\":\"{hold}\",' \"$HOME/{HOOKS_DIR}/{token}.jsonl\" 2>/dev/null | tail -n 1"))
}

/// Hands the reply on stdin to a hold that still waits (`answered`), else prints `none`. Written
/// whole, then renamed: the hold script prints the file as soon as it is not empty.
pub fn answer_script(token: &str, hold: &str) -> Result<String, String> {
  let b = hold_base(token, hold)?;
  Ok(format!("b={b}; if [ -e \"$b.wait\" ]; then cat > \"$b.answer.tmp\" && mv \"$b.answer.tmp\" \"$b.answer\" && printf 'answered\\n'; else cat >/dev/null; printf 'none\\n'; fi"))
}

/// Claude's decision for the request (agent/hooks.rs `answer_permission`, permission_rules.rs
/// `answer_scoped`): once, with grants (only when `request`, the line on record, still yields
/// exactly the grants `shown` for `scope`: the session by default, or Claude's suggested allow
/// rules saved by the claude on the host to its `localSettings` / `userSettings`), or a deny. A
/// scope without grants is refused, never sent as a silent "once".
pub fn permission_reply(request: Option<&serde_json::Value>, allow: bool, session: Option<&[String]>, message: Option<&str>, scope: Option<Scope>) -> Result<String, String> {
  Ok(match (allow, session, scope) {
    (true, Some(shown), scope) => {
      let request = request.ok_or("the permission request is no longer on record")?;
      let (keys, updates) = permission_rules::scoped_grants(request, scope.unwrap_or(Scope::Session));
      if keys.is_empty() || keys != shown {
        return Err("the session grant does not match the request".into());
      }
      hooks::permission_reply_session(updates)
    }
    (true, None, Some(_)) => return Err("a grant needs the grants shown".into()),
    (true, None, None) => hooks::permission_reply(true, ""),
    (false, _, _) => hooks::permission_reply(false, &hooks::deny_message(message)),
  })
}

/// The hook entry that makes a claude on the host wait for Kingu's answer (the script
/// [`hold_setup_script`] wrote), for `token`'s hook file.
pub fn hold_command(token: &str) -> String {
  format!("/bin/sh \"$HOME/{ROOT}/{HOLD_SCRIPT}\" \"$HOME/{HOOKS_DIR}/{token}.jsonl\"")
}

// ---------------------------------------------------------------------------------------------
// Commands

/// Where this build's host binaries are: `KINGU_HOST_BIN_DIR`, the app's resources, and in a
/// development build the folder tools/build-ptyd-host.ts fills.
fn artefact_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
  let mut dirs = Vec::new();
  if let Some(d) = std::env::var_os("KINGU_HOST_BIN_DIR").filter(|d| !d.is_empty()) {
    dirs.push(PathBuf::from(d));
  }
  if let Ok(r) = app.path().resource_dir() {
    dirs.push(r.join("host-bin"));
  }
  if cfg!(debug_assertions) {
    dirs.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("host-bin"));
  }
  dirs
}

fn own_daemon() -> Option<PathBuf> {
  let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf));
  crate::pty::find_daemon(std::env::var_os("KINGU_PTYD"), exe_dir.as_deref()).ok()
}

fn artefacts(app: &tauri::AppHandle) -> Vec<(Artefact, Vec<u8>)> {
  let dirs = artefact_dirs(app);
  let own = own_daemon();
  TRIPLES.iter().filter_map(|t| artefact_file(&dirs, t, own.as_deref()).and_then(|p| read_artefact(t, &p).map_err(|e| log::warn!("ssh holder: {e}")).ok())).collect()
}

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Reads the host's platform and whether this build's holder is installed there. Changes nothing.
#[tauri::command]
pub async fn ssh_holder_probe(app: tauri::AppHandle, targets: State<'_, Targets>, id: String) -> Result<Holder, String> {
  let t = targets.get(&id)?;
  ssh_hosts::blocking(move || {
    let found: Vec<Artefact> = artefacts(&app).into_iter().map(|(a, _)| a).collect();
    let ids: Vec<String> = found.iter().map(|a| install_id(VERSION, &a.sha256)).collect();
    let probe = parse_probe(&ssh_hosts::remote(&t, &probe_script(&ids))?);
    if probe.uname.is_empty() {
      return Err("the host did not name its platform".to_string());
    }
    Ok(decide(&probe, &found, VERSION))
  })
  .await?
}

/// Uploads and checks the holder for the host's platform ([`install_script`]).
#[tauri::command]
pub async fn ssh_holder_install(app: tauri::AppHandle, targets: State<'_, Targets>, id: String) -> Result<Holder, String> {
  let t = targets.get(&id)?;
  ssh_hosts::blocking(move || {
    let found = artefacts(&app);
    let ids: Vec<String> = found.iter().map(|(a, _)| install_id(VERSION, &a.sha256)).collect();
    let probe = parse_probe(&ssh_hosts::remote(&t, &probe_script(&ids))?);
    let list: Vec<Artefact> = found.iter().map(|(a, _)| a.clone()).collect();
    let (holder_id, platform) = match decide(&probe, &list, VERSION) {
      Holder::NeedsInstall { id, platform, .. } => (id, platform),
      other => return Ok(other),
    };
    let triple = triple_for(&platform)?;
    let (a, bytes) = found.into_iter().find(|(a, _)| a.triple == triple).ok_or("the host binary is missing")?;
    let out = ssh_hosts::remote_input(&t, &install_script(&holder_id, &a.sha256, a.size)?, Some(bytes), Duration::from_millis(INSTALL_TIMEOUT_MS))?;
    let installed = parse_probe(&out).installed;
    if !installed.iter().any(|(i, info)| *i == holder_id && usable(info)) {
      return Err("the terminal host was uploaded but did not answer".to_string());
    }
    log::info!("ssh holder {holder_id} installed on {} ({platform})", t.label);
    Ok(Holder::Ready { id: holder_id, platform, installed: true })
  })
  .await?
}

/// Removes the host's older holder folders that nothing runs from, once `holder` (this app's) is
/// in use there ([`prune_candidates`], [`prune_script`]). Orca prunes after an activation and
/// retries on later connects when something had to stay (`pruneManagedOrcadVersions`).
#[tauri::command]
pub async fn ssh_holder_prune(targets: State<'_, Targets>, id: String, holder: String) -> Result<Pruned, String> {
  let t = targets.get(&id)?;
  if !valid_id(&holder) {
    return Err("invalid holder id".into());
  }
  ssh_hosts::blocking(move || {
    let doomed = prune_candidates(&parse_folders(&ssh_hosts::remote(&t, &folders_script())?), &holder, VERSION);
    if doomed.is_empty() {
      return Ok(Pruned::default());
    }
    let p = parse_prune(&ssh_hosts::remote(&t, &prune_script(&doomed))?);
    if !p.removed.is_empty() {
      log::info!("ssh holder: removed {} on {} (kept: {})", p.removed.join(", "), t.label, p.kept.join(", "));
    }
    Ok(p)
  })
  .await?
}

/// Writes the permission-hold script on the host, so a claude there can wait for Kingu's answer.
#[tauri::command]
pub async fn ssh_remote_hold_setup(targets: State<'_, Targets>, id: String) -> Result<(), String> {
  let t = targets.get(&id)?;
  ssh_hosts::blocking(move || ssh_hosts::remote_input(&t, &hold_setup_script(), Some(hooks::PERMISSION_HOLD_SCRIPT.as_bytes().to_vec()), Duration::from_millis(ssh_hosts::REMOTE_TIMEOUT_MS)).map(drop)).await?
}

/// A session of the host's daemon, for reattaching after Kingu restarted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeldSession {
  pub key: String,
  pub cwd: String,
  pub alive: bool,
  /// The job in front of the session's shell (an agent CLI), when the daemon could tell.
  pub command: Option<String>,
}

pub fn parse_sessions(out: &str) -> Vec<HeldSession> {
  let line = out.lines().rev().find(|l| l.trim_start().starts_with('[')).unwrap_or("[]");
  let list: Vec<kingu_ptyd::SessionInfo> = serde_json::from_str(line).unwrap_or_default();
  list.into_iter().filter(|s| s.key.starts_with("ssh:")).map(|s| HeldSession { key: s.key, cwd: s.cwd, alive: s.alive, command: s.foreground.map(|f| if f.args.is_empty() { f.name } else { f.args.join(" ") }) }).collect()
}

#[tauri::command]
pub async fn ssh_holder_sessions(targets: State<'_, Targets>, id: String, holder: String) -> Result<Vec<HeldSession>, String> {
  let t = targets.get(&id)?;
  let script = sessions_script(&holder)?;
  ssh_hosts::blocking(move || ssh_hosts::remote(&t, &script).map(|o| parse_sessions(&o))).await?
}

/// Ends a held session (its tab was closed).
#[tauri::command]
pub async fn ssh_holder_end(targets: State<'_, Targets>, id: String, holder: String, key: String) -> Result<(), String> {
  let t = targets.get(&id)?;
  let script = end_script(&holder, &key)?;
  ssh_hosts::blocking(move || ssh_hosts::remote(&t, &script).map(drop)).await?
}

/// The terminal argv that shows live session `key` of the host again (a held session found after
/// Kingu restarted), in the reattach loop.
#[tauri::command]
pub fn ssh_holder_reattach(targets: State<'_, Targets>, id: String, holder: String, key: String, text: Option<LoopText>) -> Result<Vec<String>, String> {
  let t = targets.get(&id)?;
  let again = terminal_ssh(&t, &reattach_script(&holder, &key)?);
  let wait = wait_argv(&t, &ssh_hosts::dirs_home());
  Ok(vec!["sh".into(), "-c".into(), loop_script(&again, Some(&again), wait.as_deref(), true, &text.unwrap_or_default())])
}

/// Answers the PermissionRequest a claude on the host waits on (the side bar card's Allow, Allow
/// for this session, Always allow in this project / everywhere (`scope`), Deny with a reason),
/// over the host's shared ssh connection. False: that hook no longer waits (its 122 s ran out and
/// claude got `{}`, so it asks in its terminal; never an allow). An error (the host is gone):
/// nothing was answered, and the hold ends by itself with `{}`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_remote_permission_answer(
  targets: State<'_, Targets>,
  projects: State<'_, Projects>,
  host: String,
  root: String,
  token: String,
  hold: String,
  allow: bool,
  session: Option<Vec<String>>,
  message: Option<String>,
  scope: Option<String>,
) -> Result<bool, String> {
  projects.check_remote(&host, &root)?;
  let t = targets.get(&host)?;
  let scope = match scope.as_deref() {
    None => None,
    Some(s) => Some(Scope::parse(s).ok_or("unknown grant scope")?),
  };
  let read = held_request_script(&token, &hold)?;
  let write = answer_script(&token, &hold)?;
  ssh_hosts::blocking(move || {
    let request = match (allow, &session) {
      (true, Some(_)) => serde_json::from_str::<serde_json::Value>(ssh_hosts::remote(&t, &read)?.trim()).ok(),
      _ => None,
    };
    let reply = permission_reply(request.as_ref(), allow, session.as_deref(), message.as_deref(), scope)?;
    let out = ssh_hosts::remote_input(&t, &write, Some(format!("{reply}\n").into_bytes()), Duration::from_millis(ssh_hosts::REMOTE_TIMEOUT_MS))?;
    Ok(out.trim() == "answered")
  })
  .await?
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::process::{Command, Stdio};

  fn target() -> Target {
    Target { id: "h".into(), label: "h".into(), config_host: Some("box".into()), host: "box".into(), port: 22, username: String::new(), identity_file: None, jump_host: None, proxy_command: None }
  }

  /// Runs `script` with `sh` as the host would, `home` as its `$HOME`, `input` on stdin.
  fn sh(script: &str, home: &Path, input: &[u8]) -> (i32, String, String) {
    use std::io::Write;
    let mut c = Command::new("sh").arg("-c").arg(script).env("HOME", home).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut stdin = c.stdin.take().unwrap();
    let bytes = input.to_vec();
    let w = std::thread::spawn(move || {
      let _ = stdin.write_all(&bytes);
    });
    let o = c.wait_with_output().unwrap();
    let _ = w.join();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
  }

  fn info(protocol: u32, min: u32) -> HostInfo {
    HostInfo { name: "kingu-ptyd".into(), version: "0.1.0".into(), protocol, min_compatible: min, os: "linux".into(), arch: "x86_64".into() }
  }

  fn artefact(triple: &str, sha: &str) -> Artefact {
    Artefact { triple: triple.into(), path: PathBuf::from("/x"), sha256: sha.into(), size: 10 }
  }

  #[test]
  fn names_the_binary_for_each_platform_it_has_one_for() {
    assert_eq!(triple_for("Linux x86_64\n"), Ok("x86_64-unknown-linux-musl"));
    assert_eq!(triple_for("Linux aarch64"), Ok("aarch64-unknown-linux-musl"));
    assert_eq!(triple_for("Darwin arm64"), Ok("aarch64-apple-darwin"));
    assert_eq!(triple_for("Darwin x86_64"), Ok("x86_64-apple-darwin"));
    assert_eq!(triple_for("Linux armv7l"), Err("Linux armv7l".into()));
    assert_eq!(triple_for("FreeBSD amd64"), Err("FreeBSD amd64".into()));
    assert_eq!(triple_for("MINGW64_NT-10.0 x86_64"), Err("MINGW64_NT-10.0 x86_64".into()));
    assert!(triple_for("").is_err());
  }

  #[test]
  fn the_folder_name_carries_the_version_and_the_digest() {
    let sha = "0123456789abcdef".repeat(4);
    let id = install_id("0.1.0", &sha);
    assert_eq!(id, "kingu-ptyd-0.1.0-0123456789abcdef");
    assert!(valid_id(&id));
    assert!(valid_id(&install_id("0.2.0-beta/1", &sha)), "odd version characters are replaced");
    assert!(!valid_id("kingu-ptyd-1; rm -rf ~"));
    assert!(!valid_id("../kingu-ptyd-1"));
  }

  #[test]
  fn decides_ready_install_or_impossible() {
    let sha = "ab".repeat(32);
    let have = [artefact("x86_64-unknown-linux-musl", &sha)];
    let id = install_id("0.1.0", &sha);
    let probe = |uname: &str, installed: Vec<(String, HostInfo)>| Probe { uname: uname.into(), installed };
    // Installed and compatible.
    assert_eq!(decide(&probe("Linux x86_64", vec![(id.clone(), info(1, 1))]), &have, "0.1.0"), Holder::Ready { id: id.clone(), platform: "Linux x86_64".into(), installed: false });
    // Nothing there, another version's folder only, or a binary whose protocol this app dropped.
    for installed in [vec![], vec![("kingu-ptyd-0.0.9-ffffffffffffffff".to_string(), info(1, 1))], vec![(id.clone(), info(99, 99))], vec![(id.clone(), HostInfo { name: "other".into(), ..info(1, 1) })]] {
      assert_eq!(decide(&probe("Linux x86_64", installed), &have, "0.1.0"), Holder::NeedsInstall { id: id.clone(), platform: "Linux x86_64".into(), size: 10 });
    }
    // A supported platform this build has no binary for, and one nobody builds.
    assert_eq!(decide(&probe("Linux aarch64", vec![]), &have, "0.1.0"), Holder::NoArtefact { platform: "Linux aarch64".into(), triple: "aarch64-unknown-linux-musl".into() });
    assert_eq!(decide(&probe("SunOS sun4v", vec![]), &have, "0.1.0"), Holder::Unsupported { platform: "SunOS sun4v".into() });
    // A newer daemon that still accepts this protocol is usable; one that dropped it is not.
    assert!(usable(&info(3, 1)));
    assert!(!usable(&info(3, 2)));
  }

  #[test]
  fn reads_the_probe_and_ignores_noise() {
    let p = parse_probe("Welcome to box\n@@kingu-uname Linux x86_64\n@@kingu-holder kingu-ptyd-0.1.0-aa {\"name\":\"kingu-ptyd\",\"version\":\"0.1.0\",\"protocol\":1,\"minCompatible\":1,\"os\":\"linux\",\"arch\":\"x86_64\"}\n@@kingu-holder kingu-ptyd-0.1.0-bb \n@@kingu-holder kingu-ptyd-0.1.0-cc not json\n");
    assert_eq!(p.uname, "Linux x86_64");
    assert_eq!(p.installed, vec![("kingu-ptyd-0.1.0-aa".to_string(), info(1, 1))]);
    assert_eq!(parse_probe("").uname, "");
  }

  /// A stand-in for the uploaded binary: a script that answers `host-info` (the real one is a
  /// compiled program; the install script only runs it and reads its first line).
  const FAKE: &str = "#!/bin/sh\n[ \"$1\" = host-info ] && printf '%s\\n' '{\"name\":\"kingu-ptyd\",\"version\":\"0.1.0\",\"protocol\":1,\"minCompatible\":1,\"os\":\"linux\",\"arch\":\"x86_64\"}'\n";

  fn sha_of(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
  }

  #[test]
  fn installs_only_a_whole_binary_that_runs_and_the_probe_then_finds_it() {
    let home = tempfile::tempdir().unwrap();
    let bytes = FAKE.as_bytes();
    let sha = sha_of(bytes);
    let id = install_id("0.1.0", &sha);
    let folder = home.path().join(ROOT).join(&id);

    // Not installed yet: the probe names the platform only.
    let (code, out, _) = sh(&probe_script(&[id.clone()]), home.path(), b"");
    assert_eq!(code, 0);
    let before = parse_probe(&out);
    assert!(!before.uname.is_empty());
    assert!(before.installed.is_empty());

    // A cut upload and a wrong checksum leave nothing behind.
    let (code, _, err) = sh(&install_script(&id, &sha, bytes.len() as u64).unwrap(), home.path(), &bytes[..10]);
    assert_eq!(code, 21, "{err}");
    let (code, _, err) = sh(&install_script(&id, &"0".repeat(64), bytes.len() as u64).unwrap(), home.path(), bytes);
    assert_eq!(code, 22, "{err}");
    // A file that isn't the daemon (it prints no handshake) is refused too.
    let junk = b"#!/bin/sh\necho hello\n";
    let (code, _, err) = sh(&install_script(&id, &sha_of(junk), junk.len() as u64).unwrap(), home.path(), junk);
    assert_eq!(code, 23, "{err}");
    assert!(err.contains("cannot run on this host"), "{err}");
    assert!(!folder.exists());
    assert_eq!(std::fs::read_dir(home.path().join(ROOT)).unwrap().count(), 0, "no upload folder is left");

    // The whole binary: installed, private, and it answers the handshake.
    let (code, out, err) = sh(&install_script(&id, &sha, bytes.len() as u64).unwrap(), home.path(), bytes);
    assert_eq!(code, 0, "{err}");
    assert_eq!(parse_probe(&out).installed, vec![(id.clone(), info(1, 1))]);
    assert!(folder.join(".install-complete").exists());
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(std::fs::metadata(folder.join("kingu-ptyd")).unwrap().permissions().mode() & 0o777, 0o700);
    }
    let (_, out, _) = sh(&probe_script(&[id.clone(), "kingu-ptyd-0.1.0-other".into()]), home.path(), b"");
    assert_eq!(parse_probe(&out).installed, vec![(id.clone(), info(1, 1))]);
    // Installing again replaces the folder in place.
    let (code, _, err) = sh(&install_script(&id, &sha, bytes.len() as u64).unwrap(), home.path(), bytes);
    assert_eq!(code, 0, "{err}");
    // A folder whose install never finished doesn't count.
    std::fs::remove_file(folder.join(".install-complete")).unwrap();
    let (_, out, _) = sh(&probe_script(&[id.clone()]), home.path(), b"");
    assert!(parse_probe(&out).installed.is_empty());

    assert!(install_script("bad id", &sha, 1).is_err());
    assert!(install_script(&id, "xyz", 1).is_err());
  }

  /// A stand-in holder that prints its arguments one per line.
  fn echo_holder(home: &Path, id: &str) {
    let d = home.join(ROOT).join(id);
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("kingu-ptyd"), "#!/bin/sh\nfor a in \"$@\"; do printf '[%s]\\n' \"$a\"; done\n").unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      std::fs::set_permissions(d.join("kingu-ptyd"), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
  }

  #[test]
  fn the_start_script_hands_the_holder_every_word_unchanged() {
    let home = tempfile::tempdir().unwrap();
    let home_s = home.path().to_str().unwrap();
    let id = "kingu-ptyd-0.1.0-aaaaaaaaaaaaaaaa";
    // Without the holder's folder the script says so by its exit code.
    let script = start_script(id, "ssh:abc123", "/srv/it's $x", Some("abcdef123456"), Some(&["claude".into(), "fix $HOME; rm -rf /".into(), "--settings".into(), "{\"a\":\"b c\"}".into()])).unwrap();
    assert_eq!(sh(&script, home.path(), b"").0, EXIT_NO_HOLDER);
    echo_holder(home.path(), id);
    let (code, out, err) = sh(&script, home.path(), b"");
    assert_eq!(code, 0, "{err}");
    let words: Vec<&str> = out.lines().collect();
    assert_eq!(
      words,
      [
        "[attach]",
        "[--dir]",
        &format!("[{home_s}/{ROOT}/run]"),
        "[--key]",
        "[ssh:abc123]",
        "[--cwd]",
        "[/srv/it's $x]",
        "[--env]",
        &format!("[KINGU_AGENT_HOOK_FILE={home_s}/{HOOKS_DIR}/abcdef123456.jsonl]"),
        "[--idle-seconds]",
        "[900]",
        "[--]",
        "[claude]",
        "[fix $HOME; rm -rf /]",
        "[--settings]",
        "[{\"a\":\"b c\"}]",
      ]
    );
    assert!(home.path().join(HOOKS_DIR).is_dir());
    // A plain shell: no hook file, no command.
    let (_, out, _) = sh(&start_script(id, "ssh:k", "/srv/app", None, None).unwrap(), home.path(), b"");
    assert!(!out.contains("--env") && !out.contains("[--]"), "{out}");
    let (_, out, _) = sh(&reattach_script(id, "ssh:k").unwrap(), home.path(), b"");
    assert_eq!(out.lines().collect::<Vec<_>>(), ["[attach]", "[--dir]", &format!("[{home_s}/{ROOT}/run]"), "[--key]", "[ssh:k]"]);
    let (_, out, _) = sh(&end_script(id, "ssh:k").unwrap(), home.path(), b"");
    assert!(out.starts_with("[end]"), "{out}");
    // A reattach to a host whose holder is gone reads as "no session".
    assert_eq!(sh(&reattach_script("kingu-ptyd-0.1.0-gone", "ssh:k").unwrap(), home.path(), b"").0, EXIT_NO_SESSION);
    assert_eq!(sh(&sessions_script("kingu-ptyd-0.1.0-gone").unwrap(), home.path(), b"").1.trim(), "[]");

    assert!(start_script(id, "bad key", "/srv/app", None, None).is_err());
    assert!(start_script(id, "ssh:k", "relative", None, None).is_err());
    assert!(start_script(id, "ssh:k", "/srv/app", Some("x"), None).is_err());
    assert!(start_script("nope", "ssh:k", "/srv/app", None, None).is_err());
  }

  #[test]
  fn the_terminals_ssh_keeps_alive_and_takes_orcas_30_seconds_to_connect() {
    let a = terminal_ssh(&target(), "exec x");
    assert_eq!(a[..10], ["ssh", "-t", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ConnectTimeout=30", "--", "box"]);
    assert_eq!(a[10], "sh -c 'exec x'");
    assert_eq!(a.len(), 11);
  }

  /// A stand-in `ssh` on PATH: each call appends its last argument to a log and exits with the
  /// next code of a list, so the loop's decisions can be watched without a host.
  fn fake_ssh(dir: &Path, codes: &[i32]) -> String {
    let codes = codes.iter().map(i32::to_string).collect::<Vec<_>>().join(" ");
    std::fs::write(
      dir.join("ssh"),
      format!(
        "#!/bin/sh\nd={dir}\nfor a in \"$@\"; do last=$a; done\nif [ \"$1\" = -O ]; then echo check >> \"$d/log\"; n=$(cat \"$d/checks\" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > \"$d/checks\"; [ \"$n\" -ge 2 ]; exit $?; fi\nprintf '%s\\n' \"$last\" >> \"$d/log\"\ni=$(cat \"$d/calls\" 2>/dev/null || echo 0); i=$((i + 1)); echo $i > \"$d/calls\"\n[ -n \"${{KINGU_TEST_SLEEP-}}\" ] && sleep \"$KINGU_TEST_SLEEP\"\nset -- {codes}\neval \"c=\\${{$i}}\"\nexit \"${{c:-0}}\"\n",
        dir = sh_quote(dir.to_str().unwrap())
      ),
    )
    .unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      std::fs::set_permissions(dir.join("ssh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    format!("{}:{}", dir.display(), std::env::var("PATH").unwrap_or_default())
  }

  fn run_loop(script: &str, path: &str, sleep: Option<&str>) -> (i32, String) {
    let mut c = Command::new("sh");
    c.arg("-c").arg(script).env("PATH", path).stdin(Stdio::null());
    if let Some(s) = sleep {
      c.env("KINGU_TEST_SLEEP", s);
    }
    let o = c.output().unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned())
  }

  fn log(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dir.join("log")).unwrap_or_default().lines().map(str::to_string).collect()
  }

  #[test]
  fn a_lost_connection_waits_for_the_host_then_reattaches_until_the_session_ends() {
    let tmp = tempfile::tempdir().unwrap();
    let t = target();
    let text = LoopText::default();
    let first = terminal_ssh(&t, "START");
    let again = terminal_ssh(&t, "AGAIN");
    let wait: Vec<String> = ["ssh", "-O", "check", "--", "box"].map(String::from).to_vec();
    // The first run and the first reattach both lose the connection (after running a while, as
    // a real drop does); the second reattach ends normally.
    let path = fake_ssh(tmp.path(), &[255, 255, 0]);
    let script = loop_script(&first, Some(&again), Some(&wait), true, &text);
    // Each stand-in run "lasts" long enough not to count as a refused dial.
    let script = script.replace(&format!("-lt {SHORT_RUN_S}"), "-lt 0").replace("sleep 2", "sleep 0");
    let (code, out) = run_loop(&script, &path, None);
    assert_eq!(code, 0, "{out}");
    let calls = log(tmp.path());
    assert_eq!(calls.iter().filter(|l| *l != "check").collect::<Vec<_>>(), ["sh -c 'START'", "sh -c 'AGAIN'", "sh -c 'AGAIN'"]);
    // The host was asked until its shared connection answered, before each reattach.
    assert_eq!(calls[1], "check");
    assert!(calls.iter().filter(|l| *l == "check").count() >= 3, "{calls:?}");
    assert_eq!(out.matches(&text.lost_held).count(), 2);
    assert_eq!(out.matches(&text.reattaching).count(), 2);
    assert!(!out.contains(&text.ended) && !out.contains(&text.gave_up));
  }

  #[test]
  fn a_session_that_ended_meanwhile_is_said_and_a_normal_exit_never_loops() {
    let tmp = tempfile::tempdir().unwrap();
    let t = target();
    let text = LoopText::default();
    let (first, again) = (terminal_ssh(&t, "START"), terminal_ssh(&t, "AGAIN"));
    let path = fake_ssh(tmp.path(), &[255, EXIT_NO_SESSION]);
    let script = loop_script(&first, Some(&again), None, true, &text).replace(&format!("-lt {SHORT_RUN_S}"), "-lt 0").replace("sleep 5", "sleep 0").replace("sleep 2", "sleep 0");
    let (code, out) = run_loop(&script, &path, None);
    assert_eq!(code, EXIT_NO_SESSION);
    assert!(out.contains(&text.ended), "{out}");

    let tmp = tempfile::tempdir().unwrap();
    let path = fake_ssh(tmp.path(), &[0]);
    let (code, out) = run_loop(&loop_script(&first, Some(&again), None, true, &text), &path, None);
    assert_eq!((code, out.as_str()), (0, ""));
    assert_eq!(log(tmp.path()), ["sh -c 'START'"]);
    // Any other exit code is the remote command's own and ends the loop as well.
    let tmp = tempfile::tempdir().unwrap();
    let path = fake_ssh(tmp.path(), &[1]);
    assert_eq!(run_loop(&loop_script(&first, Some(&again), None, true, &text), &path, None), (1, String::new()));
  }

  #[test]
  fn ssh_that_fails_at_once_three_times_stops_the_loop() {
    let tmp = tempfile::tempdir().unwrap();
    let t = target();
    let text = LoopText::default();
    let (first, again) = (terminal_ssh(&t, "START"), terminal_ssh(&t, "AGAIN"));
    let path = fake_ssh(tmp.path(), &[255, 255, 255, 255, 255, 255]);
    let script = loop_script(&first, Some(&again), None, false, &text).replace("sleep 5", "sleep 0").replace("sleep 2", "sleep 0");
    let (code, out) = run_loop(&script, &path, None);
    assert_eq!(code, 255);
    assert_eq!(log(tmp.path()).len(), 3, "the first run and two more");
    assert!(out.contains(&text.gave_up));
    assert_eq!(out.matches(&text.lost_restart).count(), 2);
    assert_eq!(out.matches(&text.restarting).count(), 2, "a restart is said as one, never as a reattach");
    assert!(!out.contains(&text.reattaching) && !out.contains(&text.lost_held));
  }

  #[test]
  fn with_nothing_to_bring_back_the_loss_is_only_said() {
    let tmp = tempfile::tempdir().unwrap();
    let text = LoopText::default();
    let path = fake_ssh(tmp.path(), &[255, 0]);
    let (code, out) = run_loop(&loop_script(&terminal_ssh(&target(), "START"), None, None, false, &text), &path, None);
    assert_eq!(code, 255);
    assert!(out.contains(&text.lost_gone));
    assert_eq!(log(tmp.path()), ["sh -c 'START'"]);
  }

  #[test]
  fn the_wait_asks_the_shared_connection() {
    let home = tempfile::tempdir().unwrap();
    assert_eq!(wait_argv(&target(), home.path()), None, "no ~/.ssh: connections aren't shared");
    std::fs::create_dir(home.path().join(".ssh")).unwrap();
    let a = wait_argv(&target(), home.path()).unwrap();
    assert_eq!(a[..3], ["ssh", "-O", "check"]);
    assert!(a.contains(&"ControlPath=~/.ssh/kingu-%C".to_string()));
    assert_eq!(a[a.len() - 2..], ["--", "box"]);
  }

  #[test]
  fn a_claude_on_the_host_gets_its_answer_through_the_hold_files() {
    let home = tempfile::tempdir().unwrap();
    let (token, hold) = ("abcdef123456", "1795160000-42");
    // The hold script lands next to the holder, from stdin.
    let (code, _, err) = sh(&hold_setup_script(), home.path(), hooks::PERMISSION_HOLD_SCRIPT.as_bytes());
    assert_eq!(code, 0, "{err}");
    assert_eq!(std::fs::read_to_string(home.path().join(ROOT).join(HOLD_SCRIPT)).unwrap(), hooks::PERMISSION_HOLD_SCRIPT);
    assert!(hold_command(token).contains("/.kingu/host/permission-hold.sh\" \"$HOME/.kingu/agent-hooks/abcdef123456.jsonl\""));

    // Nobody waits: nothing is written.
    let (_, out, _) = sh(&answer_script(token, hold).unwrap(), home.path(), b"{}\n");
    assert_eq!(out.trim(), "none");
    let dir = home.path().join(HOOKS_DIR);
    assert!(!dir.join(format!("{token}.{hold}.answer")).exists());

    // The hook waits and its request is on record: the session answer must match it.
    let request = serde_json::json!({ "kingu_hold": hold, "hook_event_name": "PermissionRequest", "tool_name": "Bash", "permission_suggestions": [{ "type": "addRules", "behavior": "allow", "rules": [{ "toolName": "Bash", "ruleContent": "npm test:*" }] }] });
    std::fs::write(dir.join(format!("{token}.jsonl")), format!("{{\"hook_event_name\":\"Stop\"}}\n{request}\n")).unwrap();
    std::fs::write(dir.join(format!("{token}.{hold}.wait")), "").unwrap();
    let (_, out, _) = sh(&held_request_script(token, hold).unwrap(), home.path(), b"");
    let on_record: serde_json::Value = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(on_record, request);
    assert!(permission_reply(Some(&on_record), true, Some(&["rule:Bash".to_string()]), None, None).is_err(), "grants other than the ones shown");
    assert!(permission_reply(None, true, Some(&["rule:Bash(npm test:*)".to_string()]), None, None).is_err(), "no request on record");
    let reply = permission_reply(Some(&on_record), true, Some(&["rule:Bash(npm test:*)".to_string()]), None, None).unwrap();
    let (_, out, _) = sh(&answer_script(token, hold).unwrap(), home.path(), format!("{reply}\n").as_bytes());
    assert_eq!(out.trim(), "answered");
    let written: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join(format!("{token}.{hold}.answer"))).unwrap()).unwrap();
    assert_eq!(written["hookSpecificOutput"]["decision"]["updatedPermissions"][0]["destination"], "session");
    assert!(!dir.join(format!("{token}.{hold}.answer.tmp")).exists());

    let deny: serde_json::Value = serde_json::from_str(&permission_reply(None, false, None, Some(" use\n pnpm "), None).unwrap()).unwrap();
    assert_eq!(deny["hookSpecificOutput"]["decision"], serde_json::json!({ "behavior": "deny", "message": "use pnpm" }));
    let once: serde_json::Value = serde_json::from_str(&permission_reply(None, true, None, None, None).unwrap()).unwrap();
    assert_eq!(once["hookSpecificOutput"]["decision"], serde_json::json!({ "behavior": "allow" }));

    assert!(answer_script("x", hold).is_err());
    assert!(answer_script(token, "../x").is_err());
    assert!(held_request_script(token, "1; rm").is_err());
  }

  /// The hold script itself, run as claude runs it on the host, prints the answer the answer
  /// script wrote: the whole remote permission path on this computer's `sh`.
  #[test]
  #[cfg(unix)]
  fn the_hold_script_on_the_host_prints_the_answer_the_card_gave() {
    let home = tempfile::tempdir().unwrap();
    let token = "abcdef123456";
    sh(&hold_setup_script(), home.path(), hooks::PERMISSION_HOLD_SCRIPT.as_bytes());
    let mut hook = Command::new("sh").arg("-c").arg(hold_command(token)).env("HOME", home.path()).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    {
      use std::io::Write;
      hook.stdin.take().unwrap().write_all(br#"{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"ls"}}"#).unwrap();
    }
    // The window learns the hold id from the hook file, as it does over ssh.
    let file = home.path().join(HOOKS_DIR).join(format!("{token}.jsonl"));
    let until = std::time::Instant::now() + Duration::from_secs(10);
    let hold = loop {
      let text = std::fs::read_to_string(&file).unwrap_or_default();
      if let Some(v) = text.lines().find_map(|l| serde_json::from_str::<serde_json::Value>(l).ok()).and_then(|v| v["kingu_hold"].as_str().map(str::to_string)) {
        break v;
      }
      assert!(std::time::Instant::now() < until, "the hold never recorded its request");
      std::thread::sleep(Duration::from_millis(50));
    };
    let reply = permission_reply(None, true, None, None, None).unwrap();
    let (_, out, _) = sh(&answer_script(token, &hold).unwrap(), home.path(), format!("{reply}\n").as_bytes());
    assert_eq!(out.trim(), "answered");
    let printed = hook.wait_with_output().unwrap();
    let v: serde_json::Value = serde_json::from_slice(&printed.stdout).unwrap();
    assert_eq!(v["hookSpecificOutput"]["decision"]["behavior"], "allow");
  }

  /// "Always allow" from the side bar: the claude on the host saves Claude's suggested allow rules
  /// itself (`localSettings` / `userSettings`); only the rules shown, never a folder or a mode, and
  /// never without the grants shown.
  #[test]
  fn a_remote_answer_can_save_the_suggested_rules_for_the_project_or_everywhere() {
    let request = serde_json::json!({ "hook_event_name": "PermissionRequest", "tool_name": "Bash", "permission_suggestions": [
      { "type": "addRules", "behavior": "allow", "destination": "localSettings", "rules": [{ "toolName": "Bash", "ruleContent": "npm test:*" }] },
      { "type": "addDirectories", "directories": ["/srv/other"], "destination": "session" }
    ] });
    let shown = ["rule:Bash(npm test:*)".to_string()];
    for (scope, destination) in [(Scope::Project, "localSettings"), (Scope::User, "userSettings")] {
      let reply: serde_json::Value = serde_json::from_str(&permission_reply(Some(&request), true, Some(&shown), None, Some(scope)).unwrap()).unwrap();
      let updates = &reply["hookSpecificOutput"]["decision"]["updatedPermissions"];
      assert_eq!(updates.as_array().unwrap().len(), 1, "only the allow rules: {updates}");
      assert_eq!(updates[0]["destination"], destination);
      assert_eq!(updates[0]["rules"], serde_json::json!([{ "toolName": "Bash", "ruleContent": "npm test:*" }]));
    }
    // The folder is shown for the session, so a project grant naming it does not match.
    let with_dir = ["rule:Bash(npm test:*)".to_string(), "dir:/srv/other".to_string()];
    assert!(permission_reply(Some(&request), true, Some(&with_dir), None, Some(Scope::Project)).is_err());
    assert!(permission_reply(Some(&request), true, Some(&with_dir), None, None).is_ok());
    assert!(permission_reply(Some(&request), true, None, None, Some(Scope::User)).is_err(), "a scope without grants is never a silent once");
  }

  /// The hold script on the host when nobody answers in time (its 122 s, run fast with a `sleep`
  /// that returns at once): claude gets `{}`, so it asks in its own terminal, never an allow; the
  /// card's late answer then finds no hold and is refused. A hold claude ended (HUP) is the same.
  #[test]
  #[cfg(unix)]
  fn an_unanswered_hold_on_the_host_ends_with_no_decision_and_refuses_a_late_answer() {
    use std::io::Write;
    let home = tempfile::tempdir().unwrap();
    let token = "abcdef654321";
    sh(&hold_setup_script(), home.path(), hooks::PERMISSION_HOLD_SCRIPT.as_bytes());
    let bin = home.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("sleep"), "#!/bin/sh\nexit 0\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(bin.join("sleep"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
    let mut hook = Command::new("sh").arg("-c").arg(hold_command(token)).env("HOME", home.path()).env("PATH", &path).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    hook.stdin.take().unwrap().write_all(br#"{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"rm -rf /"}}"#).unwrap();
    let printed = hook.wait_with_output().unwrap();
    assert_eq!(String::from_utf8_lossy(&printed.stdout).trim(), "{}", "no decision: claude falls back to its own prompt");
    let text = std::fs::read_to_string(home.path().join(HOOKS_DIR).join(format!("{token}.jsonl"))).unwrap();
    let hold = text.lines().find_map(|l| serde_json::from_str::<serde_json::Value>(l).ok()?["kingu_hold"].as_str().map(str::to_string)).unwrap();
    let reply = permission_reply(None, true, None, None, None).unwrap();
    let (_, out, _) = sh(&answer_script(token, &hold).unwrap(), home.path(), format!("{reply}\n").as_bytes());
    assert_eq!(out.trim(), "none", "a late allow reaches nothing");
    let left: Vec<_> = std::fs::read_dir(home.path().join(HOOKS_DIR)).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(left, [format!("{token}.jsonl")], "no wait or answer file is left behind");

    // claude ends the hook (its own timeout, or the session quit): the hold leaves with nothing.
    let mut hook = Command::new("sh").arg("-c").arg(format!("exec {}", hold_command(token))).env("HOME", home.path()).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    hook.stdin.take().unwrap().write_all(br#"{"hook_event_name":"PermissionRequest","tool_name":"Bash"}"#).unwrap();
    let dir = home.path().join(HOOKS_DIR);
    let until = std::time::Instant::now() + Duration::from_secs(10);
    while !std::fs::read_dir(&dir).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().ends_with(".wait")) {
      assert!(std::time::Instant::now() < until, "the hold never started waiting");
      std::thread::sleep(Duration::from_millis(50));
    }
    Command::new("kill").args(["-HUP", &hook.id().to_string()]).status().unwrap();
    let printed = hook.wait_with_output().unwrap();
    assert!(!String::from_utf8_lossy(&printed.stdout).contains("allow"));
    assert!(!std::fs::read_dir(&dir).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().ends_with(".wait")), "a hold that ended can't be answered");
  }

  #[test]
  fn only_older_folders_are_candidates_never_the_one_in_use_or_a_newer_one() {
    let cur = "kingu-ptyd-0.2.0-aaaaaaaaaaaaaaaa".to_string();
    let folders: Vec<String> = ["kingu-ptyd-0.1.9-bbbbbbbbbbbbbbbb", "kingu-ptyd-0.2.0-cccccccccccccccc", "kingu-ptyd-0.10.0-dddddddddddddddd", "kingu-ptyd-0.2.1_beta-eeeeeeeeeeeeeeee", "kingu-ptyd-x.y-ffffffffffffffff", "kingu-ptyd-0.1-1111111111111111", &cur].map(String::from).to_vec();
    assert_eq!(prune_candidates(&folders, &cur, "0.2.0"), ["kingu-ptyd-0.1.9-bbbbbbbbbbbbbbbb", "kingu-ptyd-0.2.0-cccccccccccccccc", "kingu-ptyd-0.1-1111111111111111"]);
    assert!(prune_candidates(&folders, &cur, "weird").is_empty());
    assert_eq!(parse_folders("noise\n@@kingu-holder-dir kingu-ptyd-0.1.0-aa\n@@kingu-holder-dir ../x\n"), ["kingu-ptyd-0.1.0-aa"]);
  }

  /// The real prune script on this computer's `sh` and `ps`: a folder a running process uses
  /// stays, an idle one goes, an unfinished one and the current one are never listed.
  #[test]
  #[cfg(unix)]
  fn the_prune_keeps_a_folder_a_process_runs_from_and_removes_the_idle_ones() {
    let home = tempfile::tempdir().unwrap();
    let mk = |id: &str, complete: bool| {
      let d = home.path().join(ROOT).join(id);
      std::fs::create_dir_all(&d).unwrap();
      std::fs::write(d.join("kingu-ptyd"), "#!/bin/sh\nsleep 30\n").unwrap();
      use std::os::unix::fs::PermissionsExt;
      std::fs::set_permissions(d.join("kingu-ptyd"), std::fs::Permissions::from_mode(0o700)).unwrap();
      if complete {
        std::fs::write(d.join(".install-complete"), "").unwrap();
      }
    };
    let (busy, idle, half, cur) = ("kingu-ptyd-0.1.0-1111111111111111", "kingu-ptyd-0.1.1-2222222222222222", "kingu-ptyd-0.1.2-3333333333333333", "kingu-ptyd-0.2.0-4444444444444444");
    mk(busy, true);
    mk(idle, true);
    mk(half, false);
    mk(cur, true);
    // A "daemon" of the busy folder, started by its path as attach starts one.
    let mut daemon = Command::new(home.path().join(ROOT).join(busy).join("kingu-ptyd")).spawn().unwrap();
    std::thread::sleep(Duration::from_millis(200));

    let (_, out, _) = sh(&folders_script(), home.path(), b"");
    let mut listed = parse_folders(&out);
    listed.sort();
    assert_eq!(listed, [busy, idle, cur], "an unfinished install is never listed");
    let doomed = prune_candidates(&listed, cur, "0.2.0");
    assert_eq!(doomed, [busy, idle]);
    let (code, out, err) = sh(&prune_script(&doomed), home.path(), b"");
    assert_eq!(code, 0, "{err}");
    let p = parse_prune(&out);
    assert_eq!((p.removed.as_slice(), p.kept.as_slice(), p.unknown), ([idle.to_string()].as_slice(), [busy.to_string()].as_slice(), false), "{out}");
    assert!(home.path().join(ROOT).join(busy).exists() && !home.path().join(ROOT).join(idle).exists());
    assert!(home.path().join(ROOT).join(cur).exists() && home.path().join(ROOT).join(half).exists());
    assert!(std::fs::read_dir(home.path().join(ROOT)).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with(".gc-")));

    // Once its process ended, the next prune takes it too.
    let _ = daemon.kill();
    let _ = daemon.wait();
    let (_, out, _) = sh(&prune_script(&[busy.to_string()]), home.path(), b"");
    assert_eq!(parse_prune(&out).removed, [busy]);
    // With no process list the host keeps everything.
    assert!(parse_prune("@@kingu-prune unknown\n").unknown);
  }

  #[test]
  fn held_sessions_are_read_from_the_daemons_list() {
    let out = "motd line\n[{\"key\":\"ssh:abc\",\"cwd\":\"/srv/app\",\"alive\":true,\"pid\":7,\"foreground\":{\"pid\":9,\"name\":\"claude\"}},{\"key\":\"ade:x\",\"cwd\":\"/y\",\"alive\":true}]\n";
    assert_eq!(parse_sessions(out), vec![HeldSession { key: "ssh:abc".into(), cwd: "/srv/app".into(), alive: true, command: Some("claude".into()) }]);
    assert!(parse_sessions("").is_empty());
    assert!(parse_sessions("garbage").is_empty());
  }
}
