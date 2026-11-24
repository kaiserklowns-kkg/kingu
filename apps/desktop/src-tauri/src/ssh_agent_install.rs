//! Agent CLIs Kingu installs on an SSH host (Claude Code, Codex, OpenCode, Cursor, Copilot, …),
//! for a host without the user's own copy. The remote counterpart of agent/managed_cli.
//!
//! Orca (source at /Users/bright/src-ref/orca) installs agent CLIs on whichever host runs the
//! chat: `managedRuntime.install` (`src/main/runtime/rpc/methods/host-management/managed-runtime-install.ts`)
//! is a host-management RPC answered by the host's own server (`orcad`, under `~/.orca-remote`,
//! `src/main/managed-server/install/remote-install-root.ts`), so on an SSH host the download, the
//! digest check and the unpack all happen **on the host**, into the host's own data folder
//! (`src/main/node-runtime/managed-runtime-installation.ts`, `managed-runtime-release-install.ts`),
//! for the host's platform (`claudeManagedPlatform`, `codexManagedTarget` and the musl probe of
//! `src/main/node-runtime/linux-libc-probe.ts`). The catalog is `MANAGED_AGENT_CLI_IDS`
//! (`src/main/managed-agent-cli/managed-agent-cli-registry.ts`); the user's own install always wins.
//!
//! Kingu has no server of its own on the host, so it does the same over ssh:
//!
//! - **Platform.** `uname -sm`, plus the C library on Linux (`ldd --version`, `/lib/ld-musl-*`),
//!   picks the publisher's build ([`target_of`]). macOS and Linux on x86_64 / arm64.
//! - **Lookup here, download there.** The release (version, URL, size, digest) is looked up on
//!   this computer with agent/managed_cli/pin.rs (JSON is parsed by Kingu, never by a shell on the
//!   host); the host downloads that one URL itself (`curl`, else `wget`) and checks the digest
//!   (`sha256sum` / `sha512sum`, `shasum`, or `openssl`) before anything is unpacked. A host
//!   without a checksum tool is refused, unlike the holder's upload (ssh_holder.rs), which Kingu
//!   itself already verified.
//! - **Where.** `~/.kingu/agent-runtimes/<agent>/<version>/`, published by one rename, plus a
//!   two-line launcher in `~/.kingu/bin` (marked as Kingu's; a file of the user's there is never
//!   touched). No sudo, nothing outside `~/.kingu`. ssh_agents.rs looks in `~/.kingu/bin` last, so
//!   the user's own install still wins and a terminal starts Kingu's copy by its absolute path.
//! - **Checked before it is used.** The unpacked program must answer `--version` with the
//!   release's version before it is published (Orca `requireRuntimeAnswersVersion`).
//! - **Asked first.** Nothing is installed until the user presses Install (SSH Hosts › Agents, or
//!   the missing-agent prompt of an SSH project); Remove refuses while a program of the release
//!   runs on the host.
//!
//! Everything sent to the host is a script built here, so the tests run the scripts with `sh`, a
//! stand-in `curl` and a temporary `$HOME`; nothing in the tests reaches a host or the network.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::agent::managed_cli::fetch::{self, Digest, Http};
use crate::agent::managed_cli::pin::{self, Format, Pin, Source, Target};
use crate::agent::managed_cli::release::{self, Phase};
use crate::agent::managed_cli::{self as managed, Managed, Operation};
use crate::ssh_agents;
use crate::ssh_hosts::{self, Targets, sh_quote};

pub const EVENT: &str = "ssh-agent-install:changed";
/// Under the host's `$HOME`.
pub const RUNTIMES: &str = ".kingu/agent-runtimes";
pub const BIN: &str = ".kingu/bin";
const RECEIPT: &str = ".install-complete";
/// The probe: `uname`, tools, releases and the detection walk (ssh_agents.rs allows 10 s for it).
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const REMOVE_TIMEOUT: Duration = Duration::from_secs(60);
/// Space an install needs beyond the download (agent/managed_cli/release.rs: unpacked ≤ 3×, 256 MB margin).
const UNPACKED_RATIO: u64 = 3;
const FREE_SPACE_MARGIN: u64 = 256 * 1024 * 1024;
const LOOKUP_TTL: Duration = Duration::from_secs(60 * 60);

const CLAUDE_RELEASES: &str = "https://downloads.claude.ai/claude-code-releases";
const CODEX_REPO: &str = "openai/codex";

const UNAME_MARK: &str = "@@kingu-uname ";
const LIBC_MARK: &str = "@@kingu-libc ";
const HOME_MARK: &str = "@@kingu-home ";
const TOOL_MARK: &str = "@@kingu-tool ";
const FREE_MARK: &str = "@@kingu-free ";
const RELEASE_MARK: &str = "@@kingu-release ";
const PROGRESS_MARK: &str = "@@kingu-progress ";
const PHASE_MARK: &str = "@@kingu-phase ";
const INSTALLED_MARK: &str = "@@kingu-installed ";
const REMOVED_MARK: &str = "@@kingu-removed";
const ERROR_MARK: &str = "kingu-install: ";

// ---------------------------------------------------------------------------------------------
// The catalog

#[derive(Debug, Clone, Copy)]
pub enum Kind {
  /// Orca's `CLAUDE_MANAGED_RUNTIME` (Kingu's chats run Claude through the agent host, so the local
  /// catalog has no Claude; a host's terminals do run it).
  Claude,
  /// Orca's `CODEX_MANAGED_RUNTIME`.
  Codex,
  Managed(&'static Managed),
}

/// An agent CLI Kingu can install on a host.
#[derive(Debug, Clone, Copy)]
pub struct RemoteAgent {
  pub id: &'static str,
  pub label: &'static str,
  /// Its folder under `~/.kingu/agent-runtimes` (one path segment).
  pub folder: &'static str,
  pub kind: Kind,
}

/// Orca's `MANAGED_AGENT_CLI_IDS` that unpack with the host's own tools. Grok's npm package ships
/// its binary brotli-compressed, which a host rarely has a tool for, so it stays local-only.
/// Antigravity's ACP server is no terminal command: it runs the chats Kingu signs in itself, on
/// this computer (agent/antigravity.rs), so a host gets only `agy` (one "Antigravity" row).
pub fn catalog() -> Vec<RemoteAgent> {
  let mut out = vec![
    RemoteAgent { id: "claude", label: "Claude Code", folder: "claude", kind: Kind::Claude },
    RemoteAgent { id: "codex", label: "Codex", folder: "codex", kind: Kind::Codex },
  ];
  out.extend(managed::MANAGED.iter().filter(|m| m.id != "grok" && m.source != Source::AgyAcpServer).map(|m| RemoteAgent { id: m.id, label: m.label, folder: m.folder, kind: Kind::Managed(m) }));
  out
}

pub fn agent(id: &str) -> Option<RemoteAgent> {
  catalog().into_iter().find(|a| a.id == id)
}

impl RemoteAgent {
  /// The command's path inside a release folder.
  pub fn command(&self, t: &Target) -> String {
    match self.kind {
      Kind::Claude => "claude".into(),
      Kind::Codex => "bin/codex".into(),
      Kind::Managed(m) => m.source.command(t),
    }
  }

  /// The launchers in `~/.kingu/bin`: (name, member it starts). The command's own name, and the
  /// alias its installer adds (`opencode2`).
  pub fn launchers(&self, t: &Target) -> Vec<(String, String)> {
    let command = self.command(t);
    let base = command.rsplit('/').next().unwrap_or(&command).to_owned();
    let mut out = vec![(base, command.clone())];
    if let Kind::Managed(Managed { source: Source::Registry { alias: Some(alias), .. }, .. }) = self.kind {
      out.push(((*alias).to_owned(), command));
    }
    out
  }

  pub fn env(&self) -> &'static [(&'static str, &'static str)] {
    match self.kind {
      Kind::Managed(m) => m.env,
      _ => &[],
    }
  }

  pub fn has_build(&self, t: &Target) -> bool {
    match self.kind {
      Kind::Claude => claude_platform(t).is_some(),
      Kind::Codex => codex_target(t).is_some(),
      Kind::Managed(m) => m.source.has_build(t),
    }
  }

  /// The latest release for `t` (agent/managed_cli/pin.rs for the agents Kingu installs locally too).
  pub fn lookup(&self, http: &dyn Http, t: &Target) -> Result<Option<Pin>, String> {
    let pin = match self.kind {
      Kind::Claude => claude_pin(http, t)?,
      Kind::Codex => codex_pin(http, t)?,
      Kind::Managed(m) => pin::lookup(http, m.id, &m.source, t)?,
    };
    // A zip (OpenCode's macOS builds) unpacks with the host's `unzip`, as Orca's
    // `getZipExtractorCommand` does on a POSIX host; `Probe::refuses` says when it has none.
    Ok(pin)
  }

  /// What a release needs once unpacked, before it is checked (release.rs `prepare`, the parts a
  /// POSIX host needs): run in the staging folder.
  fn prepare(&self) -> &'static str {
    match self.kind {
      // OMP reads this beside its bin folder and leaves updates to the named manager.
      Kind::Managed(Managed { source: Source::Omp, .. }) => r#"printf '{"name":"Kingu"}' > manager.json"#,
      // The archive names its binary `antigravity`; terminals run `agy`.
      Kind::Managed(Managed { source: Source::Agy, .. }) => "if [ -f antigravity ]; then mv antigravity agy; fi",
      _ => "",
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Claude Code and Codex releases (Orca `claude-managed-runtime.ts`, `codex-managed-runtime.ts`)

/// Orca `claudeManagedPlatform`: `darwin-arm64`, `linux-x64-musl`.
pub fn claude_platform(t: &Target) -> Option<String> {
  let arch = match t.arch {
    "x86_64" => "x64",
    "aarch64" => "arm64",
    _ => return None,
  };
  match t.os {
    "macos" => Some(format!("darwin-{arch}")),
    "linux" => Some(format!("linux-{arch}{}", if t.musl { "-musl" } else { "" })),
    "windows" => Some(format!("win32-{arch}")),
    _ => None,
  }
}

/// Orca `codexManagedTarget`; Linux builds are static (musl) and serve glibc hosts too.
pub fn codex_target(t: &Target) -> Option<String> {
  let os = match t.os {
    "macos" => "apple-darwin",
    "linux" => "unknown-linux-musl",
    "windows" => "pc-windows-msvc",
    _ => return None,
  };
  matches!(t.arch, "x86_64" | "aarch64").then(|| format!("{}-{os}", t.arch))
}

/// Orca `codexPackageExecutables`: what a whole package has.
pub fn codex_executables(t: &Target) -> Vec<String> {
  let mut out = vec!["bin/codex".to_owned(), "bin/codex-code-mode-host".to_owned(), "codex-path/rg".to_owned()];
  if t.os == "linux" {
    out.push("codex-resources/bwrap".into());
  }
  out
}

#[derive(Deserialize)]
struct ClaudeManifest {
  version: String,
  platforms: HashMap<String, ClaudeBuild>,
}

#[derive(Deserialize)]
struct ClaudeBuild {
  binary: String,
  checksum: String,
  size: u64,
}

fn plain_semver(v: &str) -> bool {
  let parts: Vec<&str> = v.split('.').collect();
  parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Claude's `latest` channel (Orca follows the host's `autoUpdatesChannel`; Kingu reads no file
/// on the host for it and takes Claude's default).
pub fn claude_pin(http: &dyn Http, t: &Target) -> Result<Option<Pin>, String> {
  let Some(platform) = claude_platform(t) else { return Ok(None) };
  let version = fetch::text(http, &format!("{CLAUDE_RELEASES}/latest"), None, 1024)?.ok_or("Claude release lookup failed (404)")?.trim().to_owned();
  if !plain_semver(&version) {
    return Err("Claude answered an unexpected latest release".into());
  }
  let body = fetch::text(http, &format!("{CLAUDE_RELEASES}/{version}/manifest.json"), None, 1024 * 1024)?.ok_or_else(|| format!("Claude {version} manifest lookup failed (404)"))?;
  let manifest: ClaudeManifest = serde_json::from_str(&body).map_err(|e| format!("Claude {version} manifest is unreadable ({e})"))?;
  let Some(build) = manifest.platforms.get(&platform).filter(|_| manifest.version == version) else { return Ok(None) };
  let checksum = build.checksum.to_ascii_lowercase();
  if !matches!(build.binary.as_str(), "claude" | "claude.exe") || !fetch::is_hex(&checksum, 64) || build.size == 0 {
    return Err(format!("Claude {version} manifest is unreadable (its {platform} build)"));
  }
  Ok(Some(Pin { version: version.clone(), url: format!("{CLAUDE_RELEASES}/{version}/{platform}/{}", build.binary), digest: Digest::Sha256(checksum), bytes: build.size, format: Format::File, executables: vec!["claude".into()] }))
}

#[derive(Deserialize)]
struct GithubRelease {
  tag_name: String,
  assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
  name: String,
  size: u64,
  browser_download_url: String,
  #[serde(default)]
  digest: Option<String>,
}

/// Codex's latest GitHub release (`rust-v1.2.3`), its `codex-package-<target>.tar.gz` hashed by
/// `codex-package_SHA256SUMS` (Orca `githubLatestReleaseAsset`).
pub fn codex_pin(http: &dyn Http, t: &Target) -> Result<Option<Pin>, String> {
  let Some(target) = codex_target(t) else { return Ok(None) };
  let body = fetch::text(http, &format!("https://api.github.com/repos/{CODEX_REPO}/releases/latest"), Some("application/vnd.github+json"), 8 * 1024 * 1024)?.ok_or("Codex release lookup failed (404)")?;
  let release: GithubRelease = serde_json::from_str(&body).map_err(|e| format!("Codex release lookup answered something unexpected ({e})"))?;
  let version = release.tag_name.strip_prefix("rust-v").filter(|v| plain_semver(v)).ok_or_else(|| format!("Codex release {} has an unexpected tag", release.tag_name))?.to_owned();
  let asset = format!("codex-package-{target}.tar.gz");
  let (Some(build), Some(sums)) = (release.assets.iter().find(|a| a.name == asset), release.assets.iter().find(|a| a.name == "codex-package_SHA256SUMS")) else { return Ok(None) };
  let list = fetch::text(http, &sums.browser_download_url, None, 1024 * 1024)?.ok_or_else(|| format!("Codex {version} checksum lookup failed (404)"))?;
  let listed = list.lines().map(|l| l.split_whitespace().collect::<Vec<_>>()).find(|w| w.get(1).map(|n| n.trim_start_matches('*')) == Some(asset.as_str())).map(|w| w[0].to_ascii_lowercase());
  let github = build.digest.as_deref().and_then(|d| d.strip_prefix("sha256:")).map(str::to_ascii_lowercase);
  match listed {
    Some(sha256) if fetch::is_hex(&sha256, 64) && github.as_ref().is_none_or(|g| *g == sha256) && build.size > 0 => {
      fetch::require_https(&build.browser_download_url)?;
      Ok(Some(Pin { version, url: build.browser_download_url.clone(), digest: Digest::Sha256(sha256), bytes: build.size, format: Format::TarGz, executables: codex_executables(t) }))
    }
    _ => Err(format!("Codex {version} has no matching checksum for {asset}")),
  }
}

// ---------------------------------------------------------------------------------------------
// The host: platform, tools, releases, the user's own copies

/// `uname -sm` and whether the C library is musl → the build to download; `Err` names the platform.
pub fn target_of(uname: &str, musl: bool) -> Result<Target, String> {
  let mut words = uname.split_whitespace();
  let (os, arch) = (words.next().unwrap_or(""), words.next().unwrap_or(""));
  let arch = match arch {
    "x86_64" | "amd64" => "x86_64",
    "aarch64" | "arm64" => "aarch64",
    _ => return Err(uname.trim().to_owned()),
  };
  match os {
    "Linux" => Ok(Target { os: "linux", arch, musl }),
    "Darwin" => Ok(Target { os: "macos", arch, musl: false }),
    _ => Err(uname.trim().to_owned()),
  }
}

/// Orca `parseLinuxLibc`, reduced to the one fact a download needs: the loader or `ldd` says musl.
pub fn is_musl(libc_probe: &str) -> bool {
  libc_probe.lines().any(|l| l.trim_start().to_ascii_lowercase().starts_with("musl libc") || l.contains("ld-musl-"))
}

const TOOLS: &[&str] = &["curl", "wget", "sha256sum", "sha512sum", "shasum", "openssl", "tar", "gzip", "unzip"];

/// Prints the host's platform, C library, `$HOME`, tools, free space and Kingu's releases, then
/// runs ssh_agents.rs's detection for `names` (the launchers' names: a hit outside `~/.kingu` is
/// the user's own copy).
pub fn probe_script(names: &[String]) -> String {
  let tools = TOOLS.join(" ");
  let head = format!(
    r#"printf '{UNAME_MARK}%s\n' "$(uname -sm 2>/dev/null)"
printf '{HOME_MARK}%s\n' "$HOME"
if [ "$(uname -s 2>/dev/null)" = Linux ]; then
  _kg_libc=$( (LC_ALL=C ldd --version 2>&1; for l in /lib/ld-musl-*.so.1; do [ -e "$l" ] && printf '%s\n' "$l"; done) | head -n 5 | tr '\n' ' ')
  printf '{LIBC_MARK}%s\n' "$_kg_libc"
fi
for _kg_t in {tools}; do if command -v "$_kg_t" >/dev/null 2>&1; then printf '{TOOL_MARK}%s\n' "$_kg_t"; fi; done
_kg_free=$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {{print $4}}')
printf '{FREE_MARK}%s\n' "$_kg_free"
for _kg_d in "$HOME/{RUNTIMES}"/*/*; do
  if [ -f "$_kg_d/{RECEIPT}" ]; then printf '{RELEASE_MARK}%s\n' "${{_kg_d#"$HOME/{RUNTIMES}/"}}"; fi
done"#
  );
  let names = ssh_agents::probe_names(names);
  if names.is_empty() { head } else { format!("{head}\n{}", ssh_agents::detect_script(&names)) }
}

/// What the probe found on a host.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Probe {
  pub uname: String,
  pub home: String,
  pub musl: bool,
  pub tools: Vec<String>,
  /// Free bytes in `$HOME`, when `df` answered.
  pub free: Option<u64>,
  /// `(folder, version)` of each whole release Kingu installed.
  pub releases: Vec<(String, String)>,
  pub found: Vec<ssh_agents::Found>,
}

impl Probe {
  pub fn has(&self, tool: &str) -> bool {
    self.tools.iter().any(|t| t == tool)
  }

  pub fn target(&self) -> Result<Target, String> {
    target_of(&self.uname, self.musl)
  }

  /// Why nothing can be installed on this host, if something stops it.
  pub fn problem(&self) -> Option<String> {
    if let Err(platform) = self.target() {
      return Some(format!("Kingu has no agent builds for this host's platform ({}).", if platform.is_empty() { "unknown" } else { &platform }));
    }
    if !self.has("curl") && !self.has("wget") {
      return Some("The host has neither curl nor wget to download with.".into());
    }
    if !["sha256sum", "shasum", "openssl"].iter().any(|t| self.has(t)) {
      return Some("The host has no checksum tool (sha256sum, shasum or openssl), so a download can't be checked there.".into());
    }
    None
  }

  /// Why `pin` can't be installed here (a digest or an archive the host has no tool for).
  pub fn refuses(&self, pin: &Pin) -> Option<String> {
    if matches!(pin.digest, Digest::Sha512(_)) && !["sha512sum", "shasum", "openssl"].iter().any(|t| self.has(t)) {
      return Some("The host has no SHA-512 tool (sha512sum, shasum or openssl) to check this download.".into());
    }
    if pin.format == Format::TarGz && !(self.has("tar") && self.has("gzip")) {
      return Some("The host needs tar and gzip to unpack this download.".into());
    }
    if pin.format == Format::Zip && !self.has("unzip") {
      return Some("The host needs unzip to unpack this download.".into());
    }
    if let Some(free) = self.free {
      let need = pin.bytes.saturating_mul(1 + UNPACKED_RATIO).saturating_add(FREE_SPACE_MARGIN);
      if free < need {
        return Some(format!("Not enough free space in the host's home folder ({} MB free, {} MB needed).", free / 1_000_000, need / 1_000_000));
      }
    }
    None
  }

  /// Kingu's newest whole release of `a` on the host.
  pub fn installed(&self, a: &RemoteAgent) -> Option<String> {
    self.releases.iter().filter(|(f, _)| f == a.folder).map(|(_, v)| v.clone()).max_by(|x, y| crate::agent::runtimes::compare_versions(x, y))
  }

  /// The user's own copy of `a` (found outside `~/.kingu`).
  pub fn external(&self, a: &RemoteAgent, t: &Target) -> Option<&ssh_agents::Found> {
    let ours = format!("{}/.kingu/", self.home.trim_end_matches('/'));
    let names = a.launchers(t);
    self.found.iter().find(|f| names.iter().any(|(n, _)| *n == f.name) && !(self.home.starts_with('/') && f.path.starts_with(&ours)))
  }
}

pub fn parse_probe(out: &str, names: &[String]) -> Probe {
  let mut p = Probe::default();
  for line in out.lines() {
    if let Some(v) = line.strip_prefix(UNAME_MARK) {
      p.uname = v.trim().to_owned();
    } else if let Some(v) = line.strip_prefix(HOME_MARK) {
      p.home = v.trim().to_owned();
    } else if let Some(v) = line.strip_prefix(LIBC_MARK) {
      p.musl = is_musl(v) || v.contains("musl libc");
    } else if let Some(v) = line.strip_prefix(TOOL_MARK) {
      let v = v.trim();
      if TOOLS.contains(&v) && !p.has(v) {
        p.tools.push(v.to_owned());
      }
    } else if let Some(v) = line.strip_prefix(FREE_MARK) {
      p.free = v.trim().parse::<u64>().ok().map(|kb| kb.saturating_mul(1024));
    } else if let Some(v) = line.strip_prefix(RELEASE_MARK)
      && let Some((folder, version)) = v.trim().split_once('/')
      && valid_folder(folder)
      && release::version_is_a_folder_name(version)
    {
      p.releases.push((folder.to_owned(), version.to_owned()));
    }
  }
  p.found = ssh_agents::parse_detected(out, &ssh_agents::probe_names(names));
  p
}

/// A folder name under `~/.kingu/agent-runtimes` (it goes into scripts).
fn valid_folder(s: &str) -> bool {
  !s.is_empty() && s.len() <= 32 && !s.starts_with(['.', '-']) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}

/// Every launcher name of the catalog for `t`, asked about at once.
pub fn launcher_names(t: &Target) -> Vec<String> {
  catalog().iter().flat_map(|a| a.launchers(t).into_iter().map(|(n, _)| n)).collect()
}

// ---------------------------------------------------------------------------------------------
// Install and remove scripts

/// Downloads `pin` on the host, checks its size and digest, unpacks it into a staging folder,
/// checks the program answers its version, then publishes it with one rename and writes the
/// launchers. Exit codes: 20 can't write, 21 size, 22 checksum, 23 doesn't run, 24 no downloader,
/// 25 download failed, 26 no checksum tool, 27 unsafe archive, 28 a program is missing, 29 unpack.
pub fn install_script(a: &RemoteAgent, t: &Target, pin: &Pin) -> Result<String, String> {
  if !valid_folder(a.folder) || !release::version_is_a_folder_name(&pin.version) {
    return Err("invalid release folder".into());
  }
  let url = fetch::require_https(&pin.url)?;
  let (bits, hex) = match &pin.digest {
    Digest::Sha256(h) => (256, h),
    Digest::Sha512(h) => (512, h),
  };
  if !fetch::is_hex(hex, bits / 4) {
    return Err("invalid checksum".into());
  }
  let command = a.command(t);
  let member_ok = |m: &str| pin::release_member(m).as_deref() == Some(m);
  if !member_ok(&command) || !pin.executables.iter().all(|m| member_ok(m)) {
    return Err("invalid program path in the release".into());
  }
  let launchers = a.launchers(t);
  if !launchers.iter().all(|(n, m)| ssh_agents::valid_name(n) && member_ok(m)) {
    return Err("invalid launcher name".into());
  }
  let env: String = a.env().iter().map(|(k, v)| format!("{k}={} ", sh_quote(v))).collect();
  let unpack = match pin.format {
    Format::TarGz => r#"_kg_bad=$(gzip -dc "$a" | tar -tf - 2>/dev/null | grep -E '^/|(^|/)\.\.(/|$)' | head -n 1)
[ -z "$_kg_bad" ] || fail 27 "the archive names a path outside its folder ($_kg_bad)"
(cd "$stage" && gzip -dc "$a" | tar -xf -) || fail 29 "the download could not be unpacked"
rm -f "$a""#
      .to_owned(),
    Format::File => format!("mkdir -p \"$(dirname \"$stage/{command}\")\" && mv \"$a\" \"$stage/{command}\" || fail 29 \"the download could not be put in place\""),
    // Orca `getZipExtractorCommand`: `unzip -q <zip> -d <dir>`; the member list is checked first.
    Format::Zip => r#"_kg_list=$(unzip -Z1 "$a" 2>/dev/null) || fail 29 "the download could not be read as a zip"
_kg_bad=$(printf '%s\n' "$_kg_list" | grep -E '^/|\\|(^|/)\.\.(/|$)' | head -n 1)
[ -z "$_kg_bad" ] || fail 27 "the archive names a path outside its folder ($_kg_bad)"
unzip -qo "$a" -d "$stage" </dev/null >/dev/null || fail 29 "the download could not be unpacked"
rm -f "$a""#
      .to_owned(),
  };
  let executables = pin.executables.iter().map(|m| sh_quote(m)).collect::<Vec<_>>().join(" ");
  let launch = launchers
    .iter()
    .map(|(n, m)| {
      format!(
        r#"w="$bin/{n}"
if [ ! -e "$w" ] || grep -q '^# Kingu-managed {folder}$' "$w" 2>/dev/null; then
  printf '#!/bin/sh\n# Kingu-managed {folder}\nexec {env}"$HOME/{RUNTIMES}/{folder}/{version}/{m}" "$@"\n' > "$w.tmp" && chmod 755 "$w.tmp" && mv "$w.tmp" "$w"
fi"#,
        folder = a.folder,
        version = pin.version,
        env = if env.is_empty() { String::new() } else { format!("env {}", env.replace('\'', r"'\''").replace('%', "%%")) },
      )
    })
    .collect::<Vec<_>>()
    .join("\n");
  let script = r#"umask 022
fail() { printf 'kingu-install: %s\n' "$2" >&2; exit "$1"; }
root="$HOME/@RUNTIMES@/@FOLDER@"; bin="$HOME/@BIN@"; rel="$root/@VERSION@"
stage="$root/.incoming-$$"; a="$root/.download-$$"; pid=
mkdir -p "$root" "$bin" || fail 20 "can't write $root"
find "$root" -maxdepth 1 -name '.incoming-*' -mmin +120 -exec rm -rf {} + 2>/dev/null
find "$root" -maxdepth 1 -name '.download-*' -mmin +120 -exec rm -f {} + 2>/dev/null
trap 'if [ -n "$pid" ]; then kill "$pid" 2>/dev/null; fi; rm -rf "$stage" "$a"' EXIT
trap 'exit 130' HUP INT TERM PIPE
url=@URL@
if command -v curl >/dev/null 2>&1; then
  curl -fsSL --proto '=https' --retry 2 --connect-timeout 30 -o "$a" "$url" 2>"$a.err" &
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$a" "$url" 2>"$a.err" &
else
  fail 24 "the host has neither curl nor wget"
fi
pid=$!
while kill -0 "$pid" 2>/dev/null; do
  n=$(wc -c < "$a" 2>/dev/null | tr -d ' '); [ -n "$n" ] || n=0
  printf '@PROGRESS@%s\n' "$n"
  if [ "$n" -gt @BYTES@ ]; then fail 21 "the download is larger than published"; fi
  sleep 1
done
wait "$pid"; rc=$?; pid=
e=$(tail -n 1 "$a.err" 2>/dev/null); rm -f "$a.err"
[ "$rc" = 0 ] || fail 25 "the download failed ($e)"
n=$(wc -c < "$a" | tr -d ' ')
printf '@PROGRESS@%s\n' "$n"
[ "$n" = @BYTES@ ] || fail 21 "incomplete download ($n of @BYTES@ bytes)"
h=
if command -v sha@BITS@sum >/dev/null 2>&1; then h=$(sha@BITS@sum "$a" | cut -d' ' -f1)
elif command -v shasum >/dev/null 2>&1; then h=$(shasum -a @BITS@ "$a" | cut -d' ' -f1)
elif command -v openssl >/dev/null 2>&1; then h=$(openssl dgst -sha@BITS@ "$a" | sed 's/.*= *//')
fi
[ -n "$h" ] || fail 26 "the host has no SHA-@BITS@ tool to check the download"
[ "$h" = @HEX@ ] || fail 22 "the download doesn't match the publisher's checksum"
printf '@PHASE@extracting\n'
rm -rf "$stage"; mkdir "$stage" || fail 20 "can't write $stage"
@UNPACK@
(cd "$stage" && @PREPARE@) || fail 29 "the release could not be prepared"
for m in @EXECUTABLES@; do
  [ -f "$stage/$m" ] || fail 28 "the release has no $m"
  chmod 755 "$stage/$m" || fail 20 "can't make $m runnable"
done
printf '@PHASE@verifying\n'
to=; if command -v timeout >/dev/null 2>&1; then to="timeout 60"; fi
v=$($to env @ENV@"$stage/@COMMAND@" --version </dev/null 2>/dev/null | head -n 3 | tr '\n' ' ')
case "$v" in
  *@VERSION@*) ;;
  *) fail 23 "the installed program doesn't start or answers another version (${v:-no answer})" ;;
esac
: > "$stage/@RECEIPT@"
old="$root/.old-$$"
if [ -d "$rel" ]; then mv "$rel" "$old" || fail 20 "can't replace $rel"; fi
mv "$stage" "$rel" || fail 20 "can't publish $rel"
stage=; rm -rf "$old"
printf '@INSTALLED@%s\n' @VERSION@
@LAUNCH@
procs=$(ps -A -ww -o args= 2>/dev/null) || procs=$(ps -o args 2>/dev/null) || procs=
for d in "$root"/*; do
  [ -d "$d" ] && [ "$d" != "$rel" ] || continue
  case "$procs" in ''|*"$d/"*) continue ;; esac
  rm -rf "$d"
done
exit 0"#;
  Ok(
    script
      .replace("@RUNTIMES@", RUNTIMES)
      .replace("@BIN@", BIN)
      .replace("@FOLDER@", a.folder)
      .replace("@URL@", &sh_quote(url.as_str()))
      .replace("@PROGRESS@", PROGRESS_MARK)
      .replace("@PHASE@", PHASE_MARK)
      .replace("@INSTALLED@", INSTALLED_MARK)
      .replace("@BYTES@", &pin.bytes.to_string())
      .replace("@BITS@", &bits.to_string())
      .replace("@HEX@", hex)
      .replace("@UNPACK@", &unpack)
      .replace("@PREPARE@", if a.prepare().is_empty() { ":" } else { a.prepare() })
      .replace("@EXECUTABLES@", &executables)
      .replace("@ENV@", &env)
      .replace("@COMMAND@", &command)
      .replace("@RECEIPT@", RECEIPT)
      .replace("@LAUNCH@", &launch)
      .replace("@VERSION@", &pin.version),
  )
}

/// Removes Kingu's copy of `a` (every release and its launchers), refusing while a program of it
/// runs on the host (exit 30) or when the host lists no processes (31).
pub fn remove_script(a: &RemoteAgent, t: &Target) -> Result<String, String> {
  if !valid_folder(a.folder) {
    return Err("invalid release folder".into());
  }
  let launchers = a.launchers(t).into_iter().filter(|(n, _)| ssh_agents::valid_name(n)).map(|(n, _)| sh_quote(&n)).collect::<Vec<_>>().join(" ");
  Ok(format!(
    r#"fail() {{ printf '{ERROR_MARK}%s\n' "$2" >&2; exit "$1"; }}
root="$HOME/{RUNTIMES}/{folder}"; bin="$HOME/{BIN}"
procs=$(ps -A -ww -o args= 2>/dev/null) || procs=$(ps -o args 2>/dev/null) || procs=
[ -n "$procs" ] || fail 31 "the host lists no processes, so Kingu can't tell whether {label} is running"
case "$procs" in *"$root/"*) fail 30 "{label} is running on this host; quit it there first" ;; esac
for n in {launchers}; do
  w="$bin/$n"
  if [ -f "$w" ] && grep -q '^# Kingu-managed {folder}$' "$w" 2>/dev/null; then rm -f "$w"; fi
done
if [ -d "$root" ]; then
  g="$HOME/{RUNTIMES}/.gc-{folder}-$$"
  mv "$root" "$g" && rm -rf "$g" || fail 20 "can't remove $root"
fi
printf '{REMOVED_MARK}\n'"#,
    folder = a.folder,
    label = a.label,
  ))
}

/// A line of the install script's output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Line {
  Progress(u64),
  Phase(Phase),
  Installed(String),
}

pub fn parse_line(line: &str) -> Option<Line> {
  let line = line.trim_end();
  if let Some(n) = line.strip_prefix(PROGRESS_MARK) {
    return n.trim().parse().ok().map(Line::Progress);
  }
  if let Some(p) = line.strip_prefix(PHASE_MARK) {
    return match p.trim() {
      "extracting" => Some(Line::Phase(Phase::Extracting)),
      "verifying" => Some(Line::Phase(Phase::Verifying)),
      _ => None,
    };
  }
  line.strip_prefix(INSTALLED_MARK).map(|v| Line::Installed(v.trim().to_owned()))
}

/// What a failed script said: its own last `kingu-install:` line, else ssh's last line, else the code.
pub fn failure_text(code: Option<i32>, stderr: &str) -> String {
  if let Some(own) = stderr.lines().rev().find_map(|l| l.trim().strip_prefix(ERROR_MARK)) {
    return own.trim().to_owned();
  }
  match (code, stderr.lines().rev().map(str::trim).find(|l| !l.is_empty())) {
    (Some(255), Some(last)) => format!("ssh: {last}"),
    (_, Some(last)) => last.to_owned(),
    (Some(c), None) => format!("the host's install stopped (code {c})"),
    (None, None) => "the host's install stopped".to_owned(),
  }
}

// ---------------------------------------------------------------------------------------------
// State and commands

/// Rust's answer per host and agent: `managed_cli::Status`'s fields (the frontend reads both alike)
/// plus the host and the launcher's name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
  pub host: String,
  pub agent: &'static str,
  pub label: &'static str,
  /// The name a terminal starts it by.
  pub command: String,
  pub available: bool,
  /// Why it can't be installed on this host (the host lacks a tool, the publisher a build).
  pub unavailable: Option<String>,
  pub version: Option<String>,
  pub download_bytes: Option<u64>,
  pub download_host: Option<String>,
  pub installed_version: Option<String>,
  pub installed_current: bool,
  pub damaged: bool,
  pub can_remove: bool,
  /// What a terminal on the host runs now: Kingu's copy, the user's own, or nothing.
  pub source: Option<&'static str>,
  /// The user's own copy, when there is one.
  pub external_path: Option<String>,
  pub operation: Option<Operation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostAgents {
  pub host: String,
  /// `uname -sm`.
  pub platform: String,
  /// The build picked for it (`linux-x64-musl`), when Kingu has one.
  pub build: Option<String>,
  pub problem: Option<String>,
  pub agents: Vec<RemoteStatus>,
}

#[derive(Default)]
struct Slot {
  operation: Option<Operation>,
  cancel: Arc<AtomicBool>,
}

type PinKey = (&'static str, &'static str, &'static str, bool);

/// Kingu's installs on SSH hosts, kept while the app runs.
#[derive(Default)]
pub struct RemoteInstalls {
  slots: Mutex<HashMap<(String, &'static str), Slot>>,
  probes: Mutex<HashMap<String, Probe>>,
  pins: Mutex<HashMap<PinKey, (Option<Pin>, Instant)>>,
  next_id: AtomicU64,
}

fn build_name(t: &Target) -> String {
  let arch = if t.arch == "aarch64" { "arm64" } else { "x64" };
  format!("{}-{arch}{}", if t.os == "macos" { "darwin" } else { t.os }, if t.musl { "-musl" } else { "" })
}

impl RemoteInstalls {
  fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
  }

  fn pin_key(a: &RemoteAgent, t: &Target) -> PinKey {
    (a.id, t.os, t.arch, t.musl)
  }

  fn cached_pin(&self, a: &RemoteAgent, t: &Target) -> Option<Option<Pin>> {
    Self::lock(&self.pins).get(&Self::pin_key(a, t)).map(|(p, _)| p.clone())
  }

  /// The latest release for the host's platform, looked up at most once an hour.
  fn refresh_pin(&self, http: &dyn Http, a: &RemoteAgent, t: &Target) -> Result<Option<Pin>, String> {
    if let Some((p, at)) = Self::lock(&self.pins).get(&Self::pin_key(a, t))
      && at.elapsed() < LOOKUP_TTL
    {
      return Ok(p.clone());
    }
    let p = a.lookup(http, t)?;
    Self::lock(&self.pins).insert(Self::pin_key(a, t), (p.clone(), Instant::now()));
    Ok(p)
  }

  pub fn status(&self, host: &str, a: &RemoteAgent) -> RemoteStatus {
    let probe = Self::lock(&self.probes).get(host).cloned();
    let operation = Self::lock(&self.slots).get(&(host.to_owned(), a.id)).and_then(|s| s.operation.clone());
    status_of(host, a, probe.as_ref(), probe.as_ref().and_then(|p| p.target().ok()).and_then(|t| self.cached_pin(a, &t)), operation)
  }

  fn host_agents(&self, host: &str) -> HostAgents {
    let probe = Self::lock(&self.probes).get(host).cloned().unwrap_or_default();
    HostAgents { host: host.to_owned(), platform: probe.uname.clone(), build: probe.target().ok().map(|t| build_name(&t)), problem: probe.problem(), agents: catalog().iter().map(|a| self.status(host, a)).collect() }
  }

  fn set_probe(&self, host: &str, p: Probe) {
    Self::lock(&self.probes).insert(host.to_owned(), p);
  }

  fn update(&self, host: &str, a: &RemoteAgent, id: u64, change: impl FnOnce(&mut Operation)) -> bool {
    match Self::lock(&self.slots).get_mut(&(host.to_owned(), a.id)).and_then(|s| s.operation.as_mut()).filter(|op| op.id == id) {
      Some(op) => {
        change(op);
        true
      }
      None => false,
    }
  }
}

/// The status of `a` on a host from what is known: the last probe, the last lookup, the operation.
pub fn status_of(host: &str, a: &RemoteAgent, probe: Option<&Probe>, pin: Option<Option<Pin>>, operation: Option<Operation>) -> RemoteStatus {
  let target = probe.and_then(|p| p.target().ok());
  let installed = probe.and_then(|p| p.installed(a));
  let external = match (probe, target) {
    (Some(p), Some(t)) => p.external(a, &t).map(|f| f.path.clone()),
    _ => None,
  };
  let known = pin.clone().flatten();
  let unavailable = match (probe, target) {
    (None, _) => None,
    (Some(p), None) => p.problem(),
    (Some(p), Some(t)) => p
      .problem()
      .or_else(|| (!a.has_build(&t)).then(|| format!("{} publishes no build for {}.", a.label, build_name(&t))))
      .or_else(|| matches!(pin, Some(None)).then(|| format!("{} publishes no build Kingu can install for {}.", a.label, build_name(&t))))
      .or_else(|| known.as_ref().and_then(|k| p.refuses(k))),
  };
  let command = target.map_or_else(|| a.id.to_owned(), |t| a.launchers(&t)[0].0.clone());
  RemoteStatus {
    host: host.to_owned(),
    agent: a.id,
    label: a.label,
    command,
    available: probe.is_some() && unavailable.is_none(),
    unavailable,
    version: known.as_ref().map(|p| p.version.clone()),
    download_bytes: known.as_ref().map(|p| p.bytes),
    download_host: known.as_ref().and_then(|p| url::Url::parse(&p.url).ok()).and_then(|u| u.host_str().map(str::to_owned)),
    installed_current: installed.is_some() && installed == known.as_ref().map(|p| p.version.clone()),
    installed_version: installed.clone(),
    damaged: false,
    can_remove: installed.is_some(),
    source: if external.is_some() { Some("external") } else { installed.as_ref().map(|_| "managed") },
    external_path: external,
    operation,
  }
}

fn probe_host(t: &ssh_hosts::Target) -> Result<Probe, String> {
  // Names for every platform's launchers (they are the same on macOS and Linux).
  let names = launcher_names(&Target { os: "linux", arch: "x86_64", musl: false });
  let out = ssh_hosts::remote_within(t, &probe_script(&names), PROBE_TIMEOUT)?;
  let p = parse_probe(&out, &names);
  if p.uname.is_empty() {
    return Err("the host didn't answer the platform probe".into());
  }
  Ok(p)
}

fn running(op: &Operation) -> bool {
  matches!(op.phase, Phase::Downloading | Phase::Extracting | Phase::Verifying | Phase::Removing)
}

fn emit(app: &AppHandle, s: &RemoteStatus) {
  let _ = app.emit(EVENT, s);
}

/// The agents Kingu can install on host `id` and where each stands. `lookup`: ask the publishers
/// for their latest releases too (so sizes and versions show before an install).
#[tauri::command]
pub async fn ssh_agent_installs(targets: State<'_, Targets>, installs: State<'_, Arc<RemoteInstalls>>, id: String, lookup: bool) -> Result<HostAgents, String> {
  let t = targets.get(&id)?;
  let installs = installs.inner().clone();
  ssh_hosts::blocking(move || {
    let probe = probe_host(&t)?;
    let target = probe.target().ok();
    installs.set_probe(&t.id, probe);
    if let (true, Some(target)) = (lookup, target) {
      let http = fetch::Reqwest;
      std::thread::scope(|s| {
        for a in catalog().into_iter().filter(|a| a.has_build(&target)) {
          let (installs, http) = (&installs, &http);
          s.spawn(move || {
            if let Err(e) = installs.refresh_pin(http, &a, &target) {
              log::warn!("ssh agent install: {} latest release unknown: {e}", a.id);
            }
          });
        }
      });
    }
    Ok(installs.host_agents(&t.id))
  })
  .await?
}

/// Starts installing `agent` on host `id` (only ever from the user's click) and answers at once;
/// progress arrives as [`EVENT`]s.
#[tauri::command]
pub fn ssh_agent_install(app: AppHandle, targets: State<'_, Targets>, installs: State<'_, Arc<RemoteInstalls>>, id: String, agent: String) -> Result<RemoteStatus, String> {
  let t = targets.get(&id)?;
  let a = self::agent(&agent).ok_or_else(|| format!("Kingu can't install {agent} on an SSH host"))?;
  let installs = installs.inner().clone();
  let op_id = installs.next_id.fetch_add(1, Ordering::SeqCst) + 1;
  let started = {
    let mut slots = RemoteInstalls::lock(&installs.slots);
    let slot = slots.entry((t.id.clone(), a.id)).or_default();
    match &slot.operation {
      Some(op) if running(op) && op.kind == "remove" => return Err(format!("{} is being removed from this host", a.label)),
      Some(op) if running(op) => None,
      _ => {
        let cancel = Arc::new(AtomicBool::new(false));
        slot.cancel = cancel.clone();
        slot.operation = Some(Operation { id: op_id, kind: "install", phase: Phase::Downloading, downloaded_bytes: 0, total_bytes: None, error: None });
        Some(cancel)
      }
    }
  };
  if let Some(cancel) = started {
    let (installs, app) = (installs.clone(), app.clone());
    std::thread::Builder::new().name(format!("ssh-install-{}", a.id)).spawn(move || run_install(&app, &installs, &t, &a, op_id, &cancel)).map_err(|e| e.to_string())?;
  }
  let s = installs.status(&id, &a);
  emit(&app, &s);
  Ok(s)
}

fn run_install(app: &AppHandle, installs: &RemoteInstalls, t: &ssh_hosts::Target, a: &RemoteAgent, op: u64, cancel: &AtomicBool) {
  let publish = |change: &dyn Fn(&mut Operation)| {
    if installs.update(&t.id, a, op, |o| change(o)) {
      emit(app, &installs.status(&t.id, a));
    }
  };
  let outcome: Result<bool, String> = (|| {
    let probe = probe_host(t)?;
    let target = probe.target().map_err(|p| format!("Kingu has no agent builds for this host's platform ({p})."))?;
    installs.set_probe(&t.id, probe.clone());
    if let Some(problem) = probe.problem() {
      return Err(problem);
    }
    let pin = installs.refresh_pin(&fetch::Reqwest, a, &target).map_err(|e| format!("Couldn't look up {}'s latest release: {e}", a.label))?.ok_or_else(|| format!("{} publishes no build Kingu can install for {}.", a.label, build_name(&target)))?;
    if let Some(refusal) = probe.refuses(&pin) {
      return Err(refusal);
    }
    publish(&|o| o.total_bytes = Some(pin.bytes));
    if cancel.load(Ordering::SeqCst) {
      return Ok(false);
    }
    let script = install_script(a, &target, &pin)?;
    stream(t, &script, cancel, &|line| match line {
      Line::Progress(n) => publish(&|o| o.downloaded_bytes = n.min(pin.bytes)),
      Line::Phase(p) => publish(&|o| o.phase = p),
      Line::Installed(_) => {}
    })
  })();
  // What the host has now, whatever happened.
  if let Ok(p) = probe_host(t) {
    installs.set_probe(&t.id, p);
  }
  publish(&|o| match &outcome {
    Ok(true) => {
      o.phase = Phase::Succeeded;
      o.error = None;
    }
    Ok(false) => o.phase = Phase::Cancelled,
    Err(e) => {
      o.phase = Phase::Failed;
      o.error = Some(e.clone());
    }
  });
}

/// Runs `script` on the host, handing each marker line to `on`, until it ends, `cancel` is set or
/// the deadline passes (fetch.rs: 45 minutes). `Ok(true)`: the release was published (a Cancel
/// that comes after that still ends in success, as Orca's does); `Ok(false)`: cancelled first.
fn stream(t: &ssh_hosts::Target, script: &str, cancel: &AtomicBool, on: &dyn Fn(Line)) -> Result<bool, String> {
  let mut cmd = ssh_hosts::background(t, true);
  cmd.arg(format!("sh -c {}", sh_quote(script)));
  let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("ssh: {e}"))?;
  let (tx, rx) = std::sync::mpsc::channel::<String>();
  let out = child.stdout.take();
  let reader = std::thread::spawn(move || {
    if let Some(out) = out {
      for line in BufReader::new(out).lines().map_while(Result::ok) {
        if tx.send(line).is_err() {
          break;
        }
      }
    }
  });
  let mut err = child.stderr.take();
  let errs = std::thread::spawn(move || {
    let mut s = String::new();
    if let Some(e) = err.as_mut() {
      let _ = e.take(64 * 1024).read_to_string(&mut s);
    }
    s
  });
  let started = Instant::now();
  let mut published = false;
  let mut stopped: Option<String> = None;
  let status = loop {
    match rx.recv_timeout(Duration::from_millis(100)) {
      Ok(line) => {
        if let Some(l) = parse_line(&line) {
          if matches!(l, Line::Installed(_)) {
            published = true;
          }
          if !cancel.load(Ordering::SeqCst) {
            on(l);
          }
        }
        continue;
      }
      Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
      Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {}
    }
    if stopped.is_none() && (cancel.load(Ordering::SeqCst) || started.elapsed() > fetch::DEADLINE) {
      // Closing the connection ends the script: its next progress line fails and its trap cleans up.
      stopped = Some(if cancel.load(Ordering::SeqCst) { String::new() } else { "the install took longer than 45 minutes".into() });
      let _ = child.kill();
    }
    if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
      break s;
    }
  };
  let _ = reader.join();
  for line in rx.try_iter() {
    if matches!(parse_line(&line), Some(Line::Installed(_))) {
      published = true;
    }
  }
  let stderr = errs.join().unwrap_or_default();
  if published {
    return Ok(true);
  }
  match stopped {
    Some(reason) if reason.is_empty() => Ok(false),
    Some(reason) => Err(reason),
    None if status.success() => Err("the host's install ended without publishing the release".into()),
    None => Err(failure_text(status.code(), &stderr)),
  }
}

/// Cancels the install `operation` of `agent` on host `id`.
#[tauri::command]
pub fn ssh_agent_install_cancel(installs: State<'_, Arc<RemoteInstalls>>, id: String, agent: String, operation: u64) -> Result<RemoteStatus, String> {
  let a = self::agent(&agent).ok_or_else(|| format!("unknown agent {agent}"))?;
  if let Some(slot) = RemoteInstalls::lock(&installs.slots).get(&(id.clone(), a.id))
    && slot.operation.as_ref().is_some_and(|op| op.id == operation && running(op))
  {
    slot.cancel.store(true, Ordering::SeqCst);
  }
  Ok(installs.status(&id, &a))
}

/// Removes Kingu's copy of `agent` from host `id` (the user confirmed); refused while it runs there.
#[tauri::command]
pub async fn ssh_agent_remove(app: AppHandle, targets: State<'_, Targets>, installs: State<'_, Arc<RemoteInstalls>>, id: String, agent: String) -> Result<RemoteStatus, String> {
  let t = targets.get(&id)?;
  let a = self::agent(&agent).ok_or_else(|| format!("unknown agent {agent}"))?;
  let installs = installs.inner().clone();
  let op_id = installs.next_id.fetch_add(1, Ordering::SeqCst) + 1;
  {
    let mut slots = RemoteInstalls::lock(&installs.slots);
    let slot = slots.entry((t.id.clone(), a.id)).or_default();
    if slot.operation.as_ref().is_some_and(running) {
      return Err(format!("{} is being installed or removed on this host", a.label));
    }
    slot.operation = Some(Operation { id: op_id, kind: "remove", phase: Phase::Removing, downloaded_bytes: 0, total_bytes: None, error: None });
  }
  emit(&app, &installs.status(&t.id, &a));
  let (inst, app2) = (installs.clone(), app.clone());
  ssh_hosts::blocking(move || {
    let outcome = (|| {
      let target = RemoteInstalls::lock(&inst.probes).get(&t.id).and_then(|p| p.target().ok()).unwrap_or(Target { os: "linux", arch: "x86_64", musl: false });
      let out = ssh_hosts::remote_within(&t, &remove_script(&a, &target)?, REMOVE_TIMEOUT).map_err(|e| failure_text(None, &e))?;
      if out.lines().any(|l| l.trim() == REMOVED_MARK) { Ok(()) } else { Err("the host didn't confirm the removal".to_owned()) }
    })();
    if let Ok(p) = probe_host(&t) {
      inst.set_probe(&t.id, p);
    }
    inst.update(&t.id, &a, op_id, |o| match &outcome {
      Ok(()) => o.phase = Phase::Succeeded,
      Err(e) => {
        o.phase = Phase::Failed;
        o.error = Some(e.clone());
      }
    });
    let s = inst.status(&t.id, &a);
    emit(&app2, &s);
    outcome.map(|()| s)
  })
  .await?
}

#[cfg(all(test, unix))]
mod tests {
  use super::*;
  use crate::agent::managed_cli::archive::tests::{gz, tar_entry, tar_of};
  use crate::agent::managed_cli::fetch::tests::{Fake, sha256_hex, sha512_hex};
  use std::os::unix::fs::PermissionsExt;
  use std::path::{Path, PathBuf};
  use std::process::Command;

  const LINUX: Target = Target { os: "linux", arch: "x86_64", musl: false };
  const MUSL_ARM: Target = Target { os: "linux", arch: "aarch64", musl: true };
  const MAC: Target = Target { os: "macos", arch: "aarch64", musl: false };

  // ---- platform ------------------------------------------------------------------------------

  #[test]
  fn uname_and_the_c_library_pick_the_build() {
    assert_eq!(target_of("Linux x86_64", false), Ok(LINUX));
    assert_eq!(target_of("Linux aarch64\n", true), Ok(MUSL_ARM));
    assert_eq!(target_of("Linux arm64", false), Ok(Target { os: "linux", arch: "aarch64", musl: false }));
    assert_eq!(target_of("Darwin arm64", true), Ok(MAC), "macOS has no musl");
    assert_eq!(target_of("Darwin x86_64", false), Ok(Target { os: "macos", arch: "x86_64", musl: false }));
    assert_eq!(target_of("Linux riscv64", false), Err("Linux riscv64".into()));
    assert_eq!(target_of("FreeBSD amd64", false), Err("FreeBSD amd64".into()));
    assert_eq!(target_of("", false), Err(String::new()));
  }

  /// Orca `parseLinuxLibc`'s evidence: Alpine's `ldd` banner or its loader.
  #[test]
  fn musl_is_told_by_ldd_or_its_loader() {
    assert!(is_musl("musl libc (x86_64)\nVersion 1.2.4\n"));
    assert!(is_musl("/lib/ld-musl-aarch64.so.1"));
    assert!(!is_musl("ldd (Ubuntu GLIBC 2.39-0ubuntu8) 2.39"));
    assert!(!is_musl(""));
  }

  #[test]
  fn each_agent_names_the_host_its_publishers_way() {
    assert_eq!([LINUX, MUSL_ARM, MAC].map(|t| claude_platform(&t)), [Some("linux-x64".into()), Some("linux-arm64-musl".into()), Some("darwin-arm64".into())]);
    assert_eq!([LINUX, MUSL_ARM, MAC].map(|t| codex_target(&t)), [Some("x86_64-unknown-linux-musl".into()), Some("aarch64-unknown-linux-musl".into()), Some("aarch64-apple-darwin".into())]);
    assert!(codex_executables(&LINUX).contains(&"codex-resources/bwrap".to_owned()));
    assert!(!codex_executables(&MAC).contains(&"codex-resources/bwrap".to_owned()));
    assert_eq!(build_name(&MUSL_ARM), "linux-arm64-musl");
    assert_eq!(build_name(&MAC), "darwin-arm64");
  }

  #[test]
  fn launchers_are_the_names_a_terminal_starts() {
    let names = |id: &str| agent(id).unwrap().launchers(&LINUX).into_iter().map(|(n, _)| n).collect::<Vec<_>>();
    assert_eq!(names("claude"), ["claude"]);
    assert_eq!(names("codex"), ["codex"]);
    assert_eq!(names("cursor"), ["cursor-agent"]);
    assert_eq!(names("opencode2"), ["opencode", "opencode2"]);
    assert_eq!(names("antigravity"), ["agy"]);
    assert_eq!(agent("cursor").unwrap().launchers(&LINUX)[0].1, "dist-package/cursor-agent");
    assert!(agent("grok").is_none(), "Grok's package needs brotli on the host");
    // Antigravity's ACP server runs only this computer's chats: one "Antigravity" row, agy's.
    assert!(agent(crate::agent::antigravity::SERVER_ID).is_none());
    let labels: Vec<_> = catalog().iter().map(|a| a.label).collect();
    assert!(labels.iter().all(|l| labels.iter().filter(|m| *m == l).count() == 1), "{labels:?}");
    assert!(catalog().iter().all(|a| valid_folder(a.folder)));
  }

  // ---- lookups -------------------------------------------------------------------------------

  #[test]
  fn claude_comes_from_its_manifest_for_the_hosts_platform() {
    let sum = "ab".repeat(32);
    let manifest = format!(r#"{{"version":"2.1.3","platforms":{{"linux-x64":{{"binary":"claude","checksum":"{sum}","size":1234}}}}}}"#);
    let http = Fake::with(&[(&format!("{CLAUDE_RELEASES}/latest"), 200, b"2.1.3\n"), (&format!("{CLAUDE_RELEASES}/2.1.3/manifest.json"), 200, manifest.as_bytes())]);
    let pin = claude_pin(&http, &LINUX).unwrap().unwrap();
    assert_eq!(pin.url, format!("{CLAUDE_RELEASES}/2.1.3/linux-x64/claude"));
    assert_eq!((pin.digest, pin.bytes, pin.format), (Digest::Sha256(sum), 1234, Format::File));
    // No build for a musl arm host in this manifest.
    assert_eq!(claude_pin(&http, &MUSL_ARM).unwrap(), None);
    let bad = Fake::with(&[(&format!("{CLAUDE_RELEASES}/latest"), 200, b"latest; rm -rf ~")]);
    assert!(claude_pin(&bad, &LINUX).is_err());
  }

  #[test]
  fn codex_comes_from_its_github_release_and_checksum_list() {
    let sum = "cd".repeat(32);
    let api = "https://api.github.com/repos/openai/codex/releases/latest";
    let sums_url = "https://github.com/openai/codex/releases/download/rust-v0.50.0/codex-package_SHA256SUMS";
    let pkg = "https://github.com/openai/codex/releases/download/rust-v0.50.0/codex-package-x86_64-unknown-linux-musl.tar.gz";
    let release = format!(
      r#"{{"tag_name":"rust-v0.50.0","assets":[{{"name":"codex-package-x86_64-unknown-linux-musl.tar.gz","size":99,"browser_download_url":"{pkg}","digest":"sha256:{sum}"}},{{"name":"codex-package_SHA256SUMS","size":1,"browser_download_url":"{sums_url}"}}]}}"#
    );
    let list = format!("{sum}  codex-package-x86_64-unknown-linux-musl.tar.gz\n");
    let http = Fake::with(&[(api, 200, release.as_bytes()), (sums_url, 200, list.as_bytes())]);
    let pin = codex_pin(&http, &LINUX).unwrap().unwrap();
    assert_eq!((pin.version.as_str(), pin.url.as_str(), pin.bytes, pin.format), ("0.50.0", pkg, 99, Format::TarGz));
    assert_eq!(pin.executables, codex_executables(&LINUX));
    // GitHub's digest disagreeing with the list is refused.
    let wrong = Fake::with(&[(api, 200, release.replace(&format!("sha256:{sum}"), &format!("sha256:{}", "ee".repeat(32))).as_bytes()), (sums_url, 200, list.as_bytes())]);
    assert!(codex_pin(&wrong, &LINUX).is_err());
    // No package for this platform: nothing to install, not an error.
    assert_eq!(codex_pin(&http, &MAC).unwrap(), None);
  }

  // ---- probe ---------------------------------------------------------------------------------

  fn probe_with(tools: &[&str], free: Option<u64>) -> Probe {
    Probe { uname: "Linux x86_64".into(), home: "/home/u".into(), musl: false, tools: tools.iter().map(|s| s.to_string()).collect(), free, releases: vec![], found: vec![] }
  }

  #[test]
  fn a_host_without_a_downloader_or_checksum_tool_is_refused() {
    assert_eq!(probe_with(&["curl", "sha256sum", "tar", "gzip"], None).problem(), None);
    assert!(probe_with(&["sha256sum"], None).problem().unwrap().contains("curl nor wget"));
    assert!(probe_with(&["wget"], None).problem().unwrap().contains("checksum"));
    let mut bsd = probe_with(&["curl", "shasum"], None);
    bsd.uname = "FreeBSD amd64".into();
    assert!(bsd.problem().unwrap().contains("FreeBSD amd64"));
    let pin = |digest, format, bytes| Pin { version: "1.0.0".into(), url: "https://x.test/a".into(), digest, bytes, format, executables: vec![] };
    let p = probe_with(&["curl", "sha256sum"], Some(10 * 1024 * 1024 * 1024));
    assert!(p.refuses(&pin(Digest::Sha256("a".repeat(64)), Format::File, 1)).is_none());
    assert!(p.refuses(&pin(Digest::Sha512("a".repeat(128)), Format::File, 1)).unwrap().contains("SHA-512"));
    assert!(p.refuses(&pin(Digest::Sha256("a".repeat(64)), Format::TarGz, 1)).unwrap().contains("tar and gzip"));
    assert!(p.refuses(&pin(Digest::Sha256("a".repeat(64)), Format::Zip, 1)).unwrap().contains("unzip"));
    assert!(probe_with(&["curl", "sha256sum", "unzip"], None).refuses(&pin(Digest::Sha256("a".repeat(64)), Format::Zip, 1)).is_none());
    let small = probe_with(&["curl", "sha256sum"], Some(300 * 1024 * 1024));
    assert!(small.refuses(&pin(Digest::Sha256("a".repeat(64)), Format::File, 100_000_000)).unwrap().contains("free space"));
  }

  #[test]
  fn status_says_whose_copy_runs_and_what_an_install_downloads() {
    let a = agent("codex").unwrap();
    let mut p = probe_with(&["curl", "sha256sum", "tar", "gzip"], None);
    let pin = Pin { version: "0.50.0".into(), url: "https://github.com/x".into(), digest: Digest::Sha256("a".repeat(64)), bytes: 5_000_000, format: Format::TarGz, executables: vec![] };
    let s = status_of("box", &a, Some(&p), Some(Some(pin.clone())), None);
    assert_eq!((s.available, s.source, s.installed_version.clone(), s.download_bytes, s.download_host.as_deref()), (true, None, None, Some(5_000_000), Some("github.com")));
    p.releases = vec![("codex".into(), "0.49.0".into()), ("codex".into(), "0.50.0".into()), ("claude".into(), "2.0.0".into())];
    // Kingu's launcher in ~/.kingu/bin is its own copy, not the user's.
    p.found = vec![ssh_agents::Found { name: "codex".into(), path: "/home/u/.kingu/bin/codex".into(), fallback: true }];
    let s = status_of("box", &a, Some(&p), Some(Some(pin.clone())), None);
    assert_eq!((s.source, s.installed_version.as_deref(), s.installed_current, s.can_remove), (Some("managed"), Some("0.50.0"), true, true));
    p.found.push(ssh_agents::Found { name: "codex".into(), path: "/usr/local/bin/codex".into(), fallback: false });
    p.found.remove(0);
    let s = status_of("box", &a, Some(&p), Some(Some(pin)), None);
    assert_eq!((s.source, s.external_path.as_deref()), (Some("external"), Some("/usr/local/bin/codex")));
    // Not probed yet: nothing is offered.
    assert!(!status_of("box", &a, None, None, None).available);
    // The publisher has no build for this host.
    let s = status_of("box", &a, Some(&probe_with(&["curl", "sha256sum"], None)), Some(None), None);
    assert!(!s.available && s.unavailable.unwrap().contains("no build"));
  }

  /// The probe as a host runs it: `sh -c`, a temporary `$HOME`, this machine's own `uname`.
  #[test]
  fn the_probe_reads_platform_tools_releases_and_the_users_own_copies() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().canonicalize().unwrap();
    std::fs::create_dir_all(home.join(".kingu/agent-runtimes/codex/0.50.0")).unwrap();
    std::fs::write(home.join(".kingu/agent-runtimes/codex/0.50.0").join(RECEIPT), "").unwrap();
    // Half an install (no receipt) is not a release.
    std::fs::create_dir_all(home.join(".kingu/agent-runtimes/claude/2.0.0")).unwrap();
    exe(&home.join("tools"), "claude", "#!/bin/sh\n");
    let names = launcher_names(&LINUX);
    let path = format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", home.join("tools").display());
    let out = Command::new("/bin/sh").arg("-c").arg(probe_script(&names)).env_clear().env("HOME", &home).env("SHELL", "/usr/bin/false").env("PATH", &path).current_dir(&home).output().unwrap();
    let p = parse_probe(&String::from_utf8_lossy(&out.stdout), &names);
    assert_eq!(p.home, home.to_string_lossy());
    assert!(p.target().is_ok(), "this machine is a host Kingu has builds for: {}", p.uname);
    assert!(p.has("tar") && p.has("gzip"));
    assert_eq!(p.releases, vec![("codex".to_owned(), "0.50.0".to_owned())]);
    assert!(p.free.is_some_and(|f| f > 0));
    let t = p.target().unwrap();
    assert_eq!(p.external(&agent("claude").unwrap(), &t).map(|f| f.path.clone()), Some(home.join("tools/claude").to_string_lossy().into_owned()));
  }

  // ---- install and remove, run with sh ------------------------------------------------------

  fn exe(dir: &Path, name: &str, body: &str) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let p = dir.join(name);
    std::fs::write(&p, body).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
  }

  /// A `curl` that "downloads" `file` to its `-o` path.
  fn fake_curl(bin: &Path, file: &Path) {
    exe(bin, "curl", &format!("#!/bin/sh\nout=\nwhile [ $# -gt 0 ]; do case \"$1\" in -o) out=$2; shift ;; esac; shift; done\ncat '{}' > \"$out\"\n", file.display()));
  }

  struct Host {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    bin: PathBuf,
    download: PathBuf,
  }

  fn host(download: &[u8]) -> Host {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let (home, bin, download_at) = (root.join("home"), root.join("fakebin"), root.join("served"));
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(&download_at, download).unwrap();
    fake_curl(&bin, &download_at);
    Host { _tmp: tmp, home, bin, download: download_at }
  }

  fn run(h: &Host, script: &str) -> (Option<i32>, String, String) {
    let path = format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", h.bin.display());
    let o = Command::new("/bin/sh").arg("-c").arg(script).env_clear().env("HOME", &h.home).env("PATH", path).stdin(Stdio::null()).output().unwrap();
    (o.status.code(), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
  }

  fn codex_package(version: &str) -> Vec<u8> {
    let prog = format!("#!/bin/sh\necho 'codex-cli {version}'\n");
    gz(&tar_of(&[
      tar_entry("bin/codex", b'0', 0o644, "", prog.as_bytes()),
      tar_entry("bin/codex-code-mode-host", b'0', 0o755, "", b"#!/bin/sh\n"),
      tar_entry("codex-path/rg", b'0', 0o755, "", b"#!/bin/sh\n"),
      tar_entry("codex-resources/bwrap", b'0', 0o755, "", b"#!/bin/sh\n"),
    ]))
  }

  fn codex_pin_for(bytes: &[u8], version: &str) -> Pin {
    Pin { version: version.into(), url: "https://github.com/openai/codex/releases/download/x/codex.tar.gz".into(), digest: Digest::Sha256(sha256_hex(bytes)), bytes: bytes.len() as u64, format: Format::TarGz, executables: codex_executables(&LINUX) }
  }

  #[test]
  fn installs_a_verified_release_with_a_launcher_and_reports_progress() {
    let pkg = codex_package("0.50.0");
    let h = host(&pkg);
    let a = agent("codex").unwrap();
    let (code, out, err) = run(&h, &install_script(&a, &LINUX, &codex_pin_for(&pkg, "0.50.0")).unwrap());
    assert_eq!(code, Some(0), "{err}");
    let lines: Vec<Line> = out.lines().filter_map(parse_line).collect();
    assert!(lines.contains(&Line::Progress(pkg.len() as u64)));
    assert!(lines.contains(&Line::Phase(Phase::Extracting)) && lines.contains(&Line::Phase(Phase::Verifying)));
    assert_eq!(lines.last(), Some(&Line::Installed("0.50.0".into())));
    let rel = h.home.join(".kingu/agent-runtimes/codex/0.50.0");
    assert!(rel.join(RECEIPT).is_file());
    assert_eq!(std::fs::metadata(rel.join("bin/codex")).unwrap().permissions().mode() & 0o111, 0o111, "made runnable");
    // The launcher starts the release by `$HOME`, so it runs as the user sees it.
    let launcher = h.home.join(".kingu/bin/codex");
    let o = Command::new(&launcher).arg("--version").env("HOME", &h.home).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&o.stdout).trim(), "codex-cli 0.50.0");
    // Nothing else is left behind.
    let left: Vec<String> = std::fs::read_dir(h.home.join(".kingu/agent-runtimes/codex")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(left, ["0.50.0"]);

    // An update publishes the new release and drops the old one nothing runs from.
    let next = codex_package("0.51.0");
    std::fs::write(&h.download, &next).unwrap();
    let (code, _, err) = run(&h, &install_script(&a, &LINUX, &codex_pin_for(&next, "0.51.0")).unwrap());
    assert_eq!(code, Some(0), "{err}");
    assert!(!h.home.join(".kingu/agent-runtimes/codex/0.50.0").exists());
    assert!(std::fs::read_to_string(&launcher).unwrap().contains("/codex/0.51.0/bin/codex"));

    // Remove takes the release and Kingu's launcher, never a file of the user's.
    exe(&h.home.join(".kingu/bin"), "opencode", "#!/bin/sh\n# the user's own\n");
    let (code, out, err) = run(&h, &remove_script(&a, &LINUX).unwrap());
    assert_eq!(code, Some(0), "{err}");
    assert!(out.contains(REMOVED_MARK));
    assert!(!h.home.join(".kingu/agent-runtimes/codex").exists());
    assert!(!launcher.exists());
    assert!(h.home.join(".kingu/bin/opencode").exists());
  }

  #[test]
  fn a_download_that_doesnt_match_its_checksum_is_never_unpacked() {
    let pkg = codex_package("0.50.0");
    let h = host(&pkg);
    let mut pin = codex_pin_for(&pkg, "0.50.0");
    pin.digest = Digest::Sha256("0".repeat(64));
    let (code, _, err) = run(&h, &install_script(&agent("codex").unwrap(), &LINUX, &pin).unwrap());
    assert_eq!(code, Some(22));
    assert_eq!(failure_text(code, &err), "the download doesn't match the publisher's checksum");
    // Staging and download are gone; nothing was published.
    let left: Vec<_> = std::fs::read_dir(h.home.join(".kingu/agent-runtimes/codex")).unwrap().collect();
    assert!(left.is_empty());
    assert!(!h.home.join(".kingu/bin/codex").exists());
  }

  #[test]
  fn sizes_unsafe_archives_and_wrong_programs_are_refused() {
    let a = agent("codex").unwrap();
    // A size other than the published one.
    let pkg = codex_package("0.50.0");
    let h = host(&pkg);
    let mut pin = codex_pin_for(&pkg, "0.50.0");
    pin.bytes += 1;
    assert_eq!(run(&h, &install_script(&a, &LINUX, &pin).unwrap()).0, Some(21));
    // An archive naming a path outside its folder.
    let evil = gz(&tar_of(&[tar_entry("../escape", b'0', 0o644, "", b"x")]));
    let h = host(&evil);
    let (code, _, err) = run(&h, &install_script(&a, &LINUX, &codex_pin_for(&evil, "0.50.0")).unwrap());
    assert_eq!(code, Some(27), "{err}");
    assert!(!h.home.join(".kingu/agent-runtimes/escape").exists());
    // A program that answers another version.
    let h = host(&pkg);
    let (code, _, err) = run(&h, &install_script(&a, &LINUX, &codex_pin_for(&pkg, "0.99.0")).unwrap());
    assert_eq!(code, Some(23), "{err}");
    assert!(failure_text(code, &err).contains("codex-cli 0.50.0"));
    // A package missing a program it needs.
    let partial = gz(&tar_of(&[tar_entry("bin/codex", b'0', 0o755, "", b"#!/bin/sh\necho 0.50.0\n")]));
    let h = host(&partial);
    assert_eq!(run(&h, &install_script(&a, &LINUX, &codex_pin_for(&partial, "0.50.0")).unwrap()).0, Some(28));
  }

  #[test]
  fn a_single_file_release_with_a_sha512_digest_installs() {
    let prog = b"#!/bin/sh\necho '2.1.3 (Claude Code)'\n";
    let h = host(prog);
    let pin = Pin { version: "2.1.3".into(), url: format!("{CLAUDE_RELEASES}/2.1.3/linux-x64/claude"), digest: Digest::Sha512(sha512_hex(prog)), bytes: prog.len() as u64, format: Format::File, executables: vec!["claude".into()] };
    let (code, _, err) = run(&h, &install_script(&agent("claude").unwrap(), &LINUX, &pin).unwrap());
    assert_eq!(code, Some(0), "{err}");
    assert!(h.home.join(".kingu/agent-runtimes/claude/2.1.3/claude").is_file());
    assert!(h.home.join(".kingu/bin/claude").is_file());
  }

  #[test]
  fn an_existing_file_of_the_users_is_never_replaced_by_a_launcher() {
    let prog = b"#!/bin/sh\necho '2.1.3'\n";
    let h = host(prog);
    exe(&h.home.join(".kingu/bin"), "claude", "#!/bin/sh\necho mine\n");
    let pin = Pin { version: "2.1.3".into(), url: "https://x.test/claude".into(), digest: Digest::Sha256(sha256_hex(prog)), bytes: prog.len() as u64, format: Format::File, executables: vec!["claude".into()] };
    assert_eq!(run(&h, &install_script(&agent("claude").unwrap(), &LINUX, &pin).unwrap()).0, Some(0));
    assert_eq!(std::fs::read_to_string(h.home.join(".kingu/bin/claude")).unwrap(), "#!/bin/sh\necho mine\n");
  }

  #[test]
  fn the_agents_own_env_goes_into_its_launcher_and_its_check() {
    // agy: its archive names the binary `antigravity`, and it must not update itself.
    let prog = b"#!/bin/sh\n[ \"$AGY_CLI_DISABLE_AUTO_UPDATE\" = true ] && echo 1.2.3\n";
    let pkg = gz(&tar_of(&[tar_entry("antigravity", b'0', 0o755, "", prog)]));
    let h = host(&pkg);
    let pin = Pin { version: "1.2.3".into(), url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/x.tar.gz".into(), digest: Digest::Sha256(sha256_hex(&pkg)), bytes: pkg.len() as u64, format: Format::TarGz, executables: vec!["agy".into()] };
    let (code, _, err) = run(&h, &install_script(&agent("antigravity").unwrap(), &LINUX, &pin).unwrap());
    assert_eq!(code, Some(0), "{err}");
    assert!(std::fs::read_to_string(h.home.join(".kingu/bin/agy")).unwrap().contains("AGY_CLI_DISABLE_AUTO_UPDATE='true'"));
  }

  /// OpenCode's macOS builds are zips (the ACP Registry's `darwin-aarch64`): unpacked by `unzip`.
  #[test]
  fn a_zip_release_unpacks_with_the_hosts_unzip() {
    use crate::agent::managed_cli::archive::tests::zip_of;
    use std::io::Write;
    use zip::write::SimpleFileOptions as O;
    let pkg = zip_of(|z| {
      z.start_file("opencode", O::default().unix_permissions(0o644)).unwrap();
      z.write_all(b"#!/bin/sh\necho 2.4.1\n").unwrap();
    });
    let h = host(&pkg);
    let a = agent("opencode2").unwrap();
    let pin = Pin { version: "2.4.1".into(), url: "https://github.com/anomalyco/opencode/releases/download/v2.4.1/opencode-darwin-arm64.zip".into(), digest: Digest::Sha256(sha256_hex(&pkg)), bytes: pkg.len() as u64, format: Format::Zip, executables: vec!["opencode".into()] };
    let (code, _, err) = run(&h, &install_script(&a, &MAC, &pin).unwrap());
    assert_eq!(code, Some(0), "{err}");
    let o = Command::new(h.home.join(".kingu/bin/opencode2")).env("HOME", &h.home).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&o.stdout).trim(), "2.4.1");
    // A member outside the release folder is refused before anything is unpacked.
    let evil = zip_of(|z| {
      z.start_file("../evil", O::default()).unwrap();
      z.write_all(b"x").unwrap();
    });
    std::fs::write(&h.download, &evil).unwrap();
    let (code, _, err) = run(&h, &install_script(&a, &MAC, &Pin { digest: Digest::Sha256(sha256_hex(&evil)), bytes: evil.len() as u64, ..pin }).unwrap());
    assert_eq!(code, Some(27), "{err}");
  }

  #[test]
  fn remove_refuses_while_the_agent_runs_on_the_host() {
    let h = host(b"");
    let rel = h.home.join(".kingu/agent-runtimes/codex/0.50.0/bin");
    let prog = exe(&rel, "codex", "#!/bin/sh\nsleep 30\n");
    let mut running = Command::new(&prog).spawn().unwrap();
    std::thread::sleep(Duration::from_millis(200));
    let (code, _, err) = run(&h, &remove_script(&agent("codex").unwrap(), &LINUX).unwrap());
    let _ = running.kill();
    let _ = running.wait();
    assert_eq!(code, Some(30), "{err}");
    assert!(failure_text(code, &err).contains("Codex is running"));
    assert!(rel.exists());
  }

  #[test]
  fn scripts_refuse_anything_that_isnt_a_plain_release() {
    let a = agent("codex").unwrap();
    let ok = codex_pin_for(b"x", "0.50.0");
    assert!(install_script(&a, &LINUX, &Pin { version: "../x".into(), ..ok.clone() }).is_err());
    assert!(install_script(&a, &LINUX, &Pin { url: "http://x.test/a".into(), ..ok.clone() }).is_err());
    assert!(install_script(&a, &LINUX, &Pin { digest: Digest::Sha256("zz".into()), ..ok.clone() }).is_err());
    assert!(install_script(&a, &LINUX, &Pin { executables: vec!["../../.bashrc".into()], ..ok.clone() }).is_err());
    // A URL is quoted, never interpreted.
    let s = install_script(&a, &LINUX, &Pin { url: "https://x.test/a?$(touch /tmp/pwn)'".into(), ..ok }).unwrap();
    assert!(s.contains("url='https://x.test/a?"), "{s}");
  }

  #[test]
  fn output_lines_and_failures_read_as_the_user_sees_them() {
    assert_eq!(parse_line("@@kingu-progress 1024\n"), Some(Line::Progress(1024)));
    assert_eq!(parse_line("@@kingu-phase extracting"), Some(Line::Phase(Phase::Extracting)));
    assert_eq!(parse_line("@@kingu-installed 1.0.0"), Some(Line::Installed("1.0.0".into())));
    assert_eq!(parse_line("Welcome to box"), None);
    assert_eq!(failure_text(Some(25), "noise\nkingu-install: the download failed (curl: (6) Could not resolve host)\n"), "the download failed (curl: (6) Could not resolve host)");
    assert_eq!(failure_text(Some(255), "ssh: connect to host box port 22: Connection refused\n"), "ssh: ssh: connect to host box port 22: Connection refused");
    assert_eq!(failure_text(Some(9), ""), "the host's install stopped (code 9)");
  }
}
