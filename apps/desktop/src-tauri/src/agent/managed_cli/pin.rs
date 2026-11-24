//! Which release of an agent CLI Kingu installs: looked up, like Orca, from the publisher at
//! install time — the build for this host, its download URL and the digest the publisher lists.
//! Orca 1.4.269 hard-codes none of these for the agent CLIs; each source below is the one its file
//! names, the lookup addresses copied from it:
//!
//! - OpenCode, OpenCode 2, Cursor: the ACP Registry (`main/acp/registry/acp-registry-catalog.ts`,
//!   `acp-registry-managed-runtime.ts`); the sha256 is the listing's, else `<archive>.sha256`.
//! - GitHub Copilot, OMP: the latest GitHub release and its `SHA256SUMS.txt`
//!   (`main/node-runtime/github-latest-release.ts`, `main/copilot/copilot-managed-runtime.ts`,
//!   `main/omp/omp-managed-runtime.ts`).
//! - Grok: the npm platform package, by npm's sha512 (`main/grok/grok-managed-runtime.ts`).
//! - Kimi Code: its release manifest (`main/kimi/kimi-managed-runtime.ts`).
//! - Antigravity's `agy`: Google's updater manifest, sha512 (`main/antigravity/agy-managed-runtime.ts`).
//! - Antigravity's ACP server (`agy_acp_server`): the one exception, pinned like Orca's
//!   (`main/antigravity/antigravity-acp-runtime.ts`): one release, the archive's sha256 and each
//!   executable's sha256 and size inside it, for the chats Kingu signs in itself.
//!
//! A release without a published digest is never a pin. Parsing is apart from the network (`Http`),
//! so tests read fixtures.

use serde::Deserialize;

use super::fetch::{self, Digest, Http};
use crate::agent::runtimes;

pub const ACP_REGISTRY: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const NPM_REGISTRY: &str = "https://registry.npmjs.org";
const GROK_PACKAGE: &str = "@xai-official/grok";
const KIMI_RELEASES: &str = "https://code.kimi.com/kimi-code";
const AGY_MANIFESTS: &str = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const AGY_BUILDS: &str = "https://storage.googleapis.com/antigravity-public/antigravity-cli/";
const MAX_JSON: usize = 8 * 1024 * 1024;
const MAX_SMALL: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
  TarGz,
  Zip,
  /// The download is the one executable itself.
  File,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pin {
  pub version: String,
  pub url: String,
  pub digest: Digest,
  /// The download's size: shown before the install, and the most that is ever read.
  pub bytes: u64,
  pub format: Format,
  /// Paths in the release that must be there, made executable once the download is verified.
  pub executables: Vec<String>,
}

/// The machine a build is picked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Target {
  /// `macos`, `linux` or `windows` (Rust's `std::env::consts::OS`).
  pub os: &'static str,
  /// `aarch64` or `x86_64`.
  pub arch: &'static str,
  pub musl: bool,
}

impl Target {
  pub fn here() -> Self {
    Target { os: std::env::consts::OS, arch: std::env::consts::ARCH, musl: cfg!(target_env = "musl") }
  }
  pub fn windows(&self) -> bool {
    self.os == "windows"
  }
  /// Node's names, which the publishers use: `arm64` / `x64`.
  fn node_arch(&self) -> Option<&'static str> {
    match self.arch {
      "aarch64" => Some("arm64"),
      "x86_64" => Some("x64"),
      _ => None,
    }
  }
  /// Node's `process.platform`.
  fn node_os(&self) -> Option<&'static str> {
    match self.os {
      "macos" => Some("darwin"),
      "linux" => Some("linux"),
      "windows" => Some("win32"),
      _ => None,
    }
  }
}

fn exe(name: &str, t: &Target) -> String {
  if t.windows() { format!("{name}.exe") } else { name.to_owned() }
}

/// Where an agent's release comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
  /// An ACP Registry listing; `command` is where its `cmd` must sit in the release, `alias`
  /// another name the agent's own installer gives the command.
  Registry { registry_id: &'static str, command: &'static str, windows_command: &'static str, alias: Option<&'static str> },
  Copilot,
  Grok,
  Kimi,
  Omp,
  Agy,
  /// Antigravity's ACP server and its harness, pinned (Orca's `ANTIGRAVITY_ACP_RUNTIME`).
  AgyAcpServer,
}

impl Source {
  /// The command's path inside a release folder (Orca's `executable`).
  pub fn command(&self, t: &Target) -> String {
    match self {
      Source::Registry { command, windows_command, .. } => (if t.windows() { *windows_command } else { *command }).to_owned(),
      Source::Copilot => exe("copilot", t),
      Source::Grok => exe("bin/grok", t),
      Source::Kimi => exe("kimi", t),
      Source::Omp => exe("bin/omp", t),
      Source::Agy => exe("agy", t),
      Source::AgyAcpServer => agy_acp_server(t).to_owned(),
    }
  }

  /// Whether this host has a build to look for (Orca's `available`), before any lookup.
  pub fn has_build(&self, t: &Target) -> bool {
    match self {
      Source::Registry { .. } => acp_target(t).is_some(),
      Source::Copilot => copilot_target(t).is_some(),
      Source::Grok => grok_package(t).is_some(),
      Source::Kimi => kimi_target(t).is_some(),
      Source::Omp => omp_asset(t).is_some(),
      Source::Agy => agy_platform(t).is_some(),
      Source::AgyAcpServer => agy_acp_build(t).is_some(),
    }
  }
}

// ---- targets (each publisher's name for this host) --------------------------------------------

/// The registry's key: `darwin-aarch64`, `linux-x86_64-musl`.
pub fn acp_target(t: &Target) -> Option<String> {
  let os = match t.os {
    "macos" => "darwin",
    "linux" => "linux",
    "windows" => "windows",
    _ => return None,
  };
  matches!(t.arch, "aarch64" | "x86_64").then(|| format!("{os}-{}{}", t.arch, if os == "linux" && t.musl { "-musl" } else { "" }))
}

/// `darwin-arm64`, `linuxmusl-x64`.
pub fn copilot_target(t: &Target) -> Option<String> {
  let os = match t.node_os()? {
    "linux" if t.musl => "linuxmusl",
    os => os,
  };
  Some(format!("{os}-{}", t.node_arch()?))
}

/// `@xai-official/grok-darwin-arm64`; its Linux builds are static, so they run on musl too.
pub fn grok_package(t: &Target) -> Option<String> {
  Some(format!("{GROK_PACKAGE}-{}-{}", t.node_os()?, t.node_arch()?))
}

/// `darwin-arm64`; Kimi Code ships no musl build.
pub fn kimi_target(t: &Target) -> Option<String> {
  if t.os == "linux" && t.musl {
    return None;
  }
  Some(format!("{}-{}", t.node_os()?, t.node_arch()?))
}

/// `omp-darwin-arm64`, `omp-linux-musl-x64`, `omp-windows-x64.exe`.
pub fn omp_asset(t: &Target) -> Option<String> {
  let os = match t.os {
    "macos" => "darwin",
    "linux" if t.musl => "linux-musl",
    "linux" => "linux",
    "windows" => "windows",
    _ => return None,
  };
  Some(format!("omp-{os}-{}{}", t.node_arch()?, if t.windows() { ".exe" } else { "" }))
}

/// `darwin_arm64`, `linux_amd64_musl`, `windows_amd64`.
pub fn agy_platform(t: &Target) -> Option<String> {
  let cpu = match t.arch {
    "x86_64" => "amd64",
    "aarch64" => "arm64",
    _ => return None,
  };
  match t.os {
    "macos" => Some(format!("darwin_{cpu}")),
    "windows" => Some(format!("windows_{cpu}")),
    "linux" => Some(format!("linux_{cpu}{}", if t.musl { "_musl" } else { "" })),
    _ => None,
  }
}

// ---- ACP Registry ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct RegistryBinary {
  pub archive: String,
  pub cmd: String,
  #[serde(default)]
  pub sha256: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct RegistryAgent {
  pub id: String,
  pub version: String,
  pub distribution: RegistryDistribution,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct RegistryDistribution {
  #[serde(default)]
  pub binary: Option<std::collections::BTreeMap<String, RegistryBinary>>,
}

/// The registry's listings. Each agent parses alone, so one malformed listing never hides the others.
pub fn parse_registry(json: &str) -> Result<Vec<RegistryAgent>, String> {
  let doc: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("the ACP Registry is unreadable ({e})"))?;
  let agents = doc.get("agents").and_then(|a| a.as_array()).ok_or("the ACP Registry lists no agents")?;
  Ok(
    agents
      .iter()
      .filter_map(|a| serde_json::from_value::<RegistryAgent>(a.clone()).ok())
      .filter(|a| {
        let v = a.version.as_bytes();
        !a.id.is_empty() && v.first().is_some_and(u8::is_ascii_digit) && v.iter().all(|b| b.is_ascii_alphanumeric() || b".+-".contains(b))
      })
      .collect(),
  )
}

/// `cmd` as a path inside the release; None for anything that could leave the release folder.
pub fn release_member(cmd: &str) -> Option<String> {
  let cmd = cmd.strip_prefix("./").or_else(|| cmd.strip_prefix(".\\")).unwrap_or(cmd);
  let parts: Vec<&str> = cmd.split(['/', '\\']).collect();
  parts.iter().all(|p| !p.is_empty() && *p != "." && *p != ".." && !p.contains(':') && !p.contains('\0')).then(|| parts.join("/"))
}

fn archive_format(url: &url::Url) -> Option<Format> {
  let path = url.path();
  if path.ends_with(".tar.gz") {
    Some(Format::TarGz)
  } else if path.ends_with(".zip") {
    Some(Format::Zip)
  } else {
    None
  }
}

/// The first word of a `<file>.sha256` body, when it is a sha256.
fn listed_sha256(body: &str) -> Option<String> {
  let first = body.split_whitespace().next()?.to_ascii_lowercase();
  fetch::is_hex(&first, 64).then_some(first)
}

fn registry_pin(http: &dyn Http, registry_id: &str, command: &str, agent_id: &str, t: &Target) -> Result<Option<Pin>, String> {
  let Some(key) = acp_target(t) else { return Ok(None) };
  let body = fetch::text(http, ACP_REGISTRY, None, MAX_JSON)?.ok_or("ACP Registry lookup failed (404)")?;
  let Some(listing) = parse_registry(&body)?.into_iter().find(|a| a.id == registry_id) else { return Ok(None) };
  let Some(target) = listing.distribution.binary.as_ref().and_then(|b| b.get(&key)) else { return Ok(None) };
  let version = listing.version.clone();
  // The launch gate's floors: a listed release below them is never installed.
  let too_old = runtimes::minimum_for(&version, runtimes::min_versions(agent_id)).is_some_and(|m| runtimes::compare_versions(&version, m).is_lt());
  let url = fetch::require_https(&target.archive);
  let format = url.as_ref().ok().and_then(archive_format);
  // Launches find Kingu's copy at a fixed path, so a moved command waits for a Kingu update.
  let (Some(format), false, true) = (format, too_old, release_member(&target.cmd).as_deref() == Some(command)) else {
    log::warn!("managed install: {registry_id} {version} for {key} is not one Kingu can run");
    return Ok(None);
  };
  // Some publishers list no hash in the registry but publish one beside the archive.
  let sha256 = match target.sha256.as_deref().map(str::to_ascii_lowercase) {
    Some(s) if fetch::is_hex(&s, 64) => Some(s),
    Some(_) => None,
    None => fetch::text(http, &format!("{}.sha256", target.archive), None, MAX_SMALL)?.as_deref().and_then(listed_sha256),
  };
  let Some(sha256) = sha256 else {
    log::warn!("managed install: {registry_id} {version} for {key} publishes no checksum");
    return Ok(None);
  };
  let bytes = http.size(&target.archive)?;
  Ok(Some(Pin { version, url: target.archive.clone(), digest: Digest::Sha256(sha256), bytes, format, executables: vec![command.to_owned()] }))
}

// ---- GitHub latest release ------------------------------------------------------------------

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

/// `v1.2.3` → `1.2.3`; any other tag is unexpected.
fn tag_version(tag: &str) -> Option<&str> {
  let v = tag.strip_prefix('v')?;
  let mut parts = v.split('.');
  let ok = (0..3).all(|_| parts.next().is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))) && parts.next().is_none();
  ok.then_some(v)
}

struct GithubBuild {
  version: String,
  url: String,
  sha256: String,
  bytes: u64,
}

/// `asset` in `repo`'s latest release, hashed by the release's `SHA256SUMS.txt`; None when not published.
fn github_latest(http: &dyn Http, label: &str, repo: &str, asset: &str) -> Result<Option<GithubBuild>, String> {
  let body = fetch::text(http, &format!("https://api.github.com/repos/{repo}/releases/latest"), Some("application/vnd.github+json"), MAX_JSON)?.ok_or_else(|| format!("{label} release lookup failed (404)"))?;
  let release: GithubRelease = serde_json::from_str(&body).map_err(|e| format!("{label} release lookup answered something unexpected ({e})"))?;
  let version = tag_version(&release.tag_name).ok_or_else(|| format!("{label} release {} has an unexpected tag", release.tag_name))?.to_owned();
  let (Some(build), Some(sums)) = (release.assets.iter().find(|a| a.name == asset), release.assets.iter().find(|a| a.name == "SHA256SUMS.txt")) else { return Ok(None) };
  let list = fetch::text(http, &sums.browser_download_url, None, MAX_JSON)?.ok_or_else(|| format!("{label} {version} checksum lookup failed (404)"))?;
  let listed = list.lines().map(|l| l.split_whitespace().collect::<Vec<_>>()).find(|w| w.get(1) == Some(&asset)).map(|w| w[0].to_ascii_lowercase());
  let github = build.digest.as_deref().and_then(|d| d.strip_prefix("sha256:")).map(str::to_ascii_lowercase);
  // GitHub's own digest, when present, must agree with the published list.
  match listed {
    Some(sha256) if fetch::is_hex(&sha256, 64) && github.as_ref().is_none_or(|g| *g == sha256) && build.size > 0 => {
      fetch::require_https(&build.browser_download_url)?;
      Ok(Some(GithubBuild { version, url: build.browser_download_url.clone(), sha256, bytes: build.size }))
    }
    _ => Err(format!("{label} {version} has no matching checksum for {asset}")),
  }
}

// ---- npm (Grok) -----------------------------------------------------------------------------

/// npm's `sha512-<base64>` integrity as hex; None for anything that is not one sha512.
pub fn npm_sha512_hex(integrity: &str) -> Option<String> {
  use base64::Engine as _;
  let bytes = base64::engine::general_purpose::STANDARD.decode(integrity.strip_prefix("sha512-")?).ok()?;
  (bytes.len() == 64).then(|| bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn grok_pin(http: &dyn Http, t: &Target) -> Result<Option<Pin>, String> {
  let Some(package) = grok_package(t) else { return Ok(None) };
  let json = |url: String| -> Result<serde_json::Value, String> {
    let body = fetch::text(http, &url, Some("application/json"), MAX_JSON)?.ok_or("Grok release lookup failed (404)")?;
    serde_json::from_str(&body).map_err(|e| format!("Grok release lookup answered something unexpected ({e})"))
  };
  let latest = json(format!("{NPM_REGISTRY}/{GROK_PACKAGE}/latest"))?;
  let version = latest.get("version").and_then(|v| v.as_str()).filter(|v| tag_version(&format!("v{v}")).is_some()).ok_or("Grok answered an unexpected latest release")?.to_owned();
  let build = json(format!("{NPM_REGISTRY}/{package}/{version}"))?;
  let dist = |k: &str| build.get("dist").and_then(|d| d.get(k)).and_then(|v| v.as_str());
  let tarball = dist("tarball").filter(|u| u.starts_with(&format!("{NPM_REGISTRY}/")));
  let sha512 = dist("integrity").and_then(npm_sha512_hex);
  let (Some(tarball), Some(sha512), true) = (tarball, sha512, build.get("version").and_then(|v| v.as_str()) == Some(&version)) else {
    return Err(format!("Grok {version} has no matching build for {package}"));
  };
  Ok(Some(Pin { version, url: tarball.to_owned(), digest: Digest::Sha512(sha512), bytes: http.size(tarball)?, format: Format::TarGz, executables: vec![Source::Grok.command(t)] }))
}

// ---- Kimi Code ------------------------------------------------------------------------------

#[derive(Deserialize)]
struct KimiManifest {
  version: String,
  platforms: std::collections::BTreeMap<String, KimiBuild>,
}

#[derive(Deserialize)]
struct KimiBuild {
  filename: String,
  checksum: String,
}

fn kimi_pin(http: &dyn Http, t: &Target) -> Result<Option<Pin>, String> {
  let Some(target) = kimi_target(t) else { return Ok(None) };
  let latest = fetch::text(http, &format!("{KIMI_RELEASES}/latest"), None, MAX_SMALL)?.ok_or("Kimi Code release lookup failed (404)")?;
  let version = latest.trim().to_owned();
  // A version is also a URL segment below: digits, dots and a plain prerelease only.
  if !runtimes::is_version(&version) || !version.bytes().all(|b| b.is_ascii_alphanumeric() || b".-+".contains(&b)) {
    return Err("Kimi Code answered an unexpected latest release".into());
  }
  let body = fetch::text(http, &format!("{KIMI_RELEASES}/binaries/{version}/manifest.json"), None, MAX_JSON)?.ok_or_else(|| format!("Kimi Code {version} manifest lookup failed (404)"))?;
  let manifest: KimiManifest = serde_json::from_str(&body).map_err(|e| format!("Kimi Code {version} manifest is unreadable ({e})"))?;
  let Some(build) = manifest.platforms.get(&target).filter(|_| manifest.version == version) else { return Ok(None) };
  let plain = !build.filename.is_empty() && build.filename.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b)) && build.filename != "." && build.filename != "..";
  if !plain || !fetch::is_hex(&build.checksum, 64) {
    return Err(format!("Kimi Code {version} manifest is unreadable (its {target} build)"));
  }
  let url = format!("{KIMI_RELEASES}/binaries/{version}/{}", build.filename);
  let bytes = http.size(&url)?;
  Ok(Some(Pin { version, url, digest: Digest::Sha256(build.checksum.clone()), bytes, format: Format::File, executables: vec![Source::Kimi.command(t)] }))
}

// ---- agy ------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct AgyManifest {
  version: String,
  url: String,
  sha512: String,
}

fn agy_pin(http: &dyn Http, t: &Target) -> Result<Option<Pin>, String> {
  let Some(platform) = agy_platform(t) else { return Ok(None) };
  let body = fetch::text(http, &format!("{AGY_MANIFESTS}/{platform}.json"), Some("application/json"), MAX_SMALL)?.ok_or("Antigravity release lookup failed (404)")?;
  let manifest: AgyManifest = serde_json::from_str(&body).map_err(|e| format!("Antigravity release lookup answered something unexpected ({e})"))?;
  let sha512 = manifest.sha512.to_ascii_lowercase();
  // Parsed, so a `..` segment can't climb out of Google's folder.
  let url = fetch::require_https(&manifest.url)?;
  if tag_version(&format!("v{}", manifest.version)).is_none() || !url.as_str().starts_with(AGY_BUILDS) || !fetch::is_hex(&sha512, 128) {
    return Err("Antigravity release lookup answered something unexpected".into());
  }
  // As Google's installer does, the download's name says what it is: a bare exe, or a tar.gz.
  let format = match (t.windows(), url.path()) {
    (true, p) if p.ends_with(".exe") => Format::File,
    (false, p) if p.ends_with(".tar.gz") => Format::TarGz,
    _ => return Err(format!("Antigravity {} is published in a form Kingu can't install: {url}", manifest.version)),
  };
  let bytes = http.size(url.as_str())?;
  Ok(Some(Pin { version: manifest.version, url: url.into(), digest: Digest::Sha512(sha512), bytes, format, executables: vec![Source::Agy.command(t)] }))
}

// ---- Antigravity's ACP server ---------------------------------------------------------------

/// Orca's pin (`antigravity-acp-runtime.ts`): 1.4.2 and later write `skills/system/run-workflow`
/// into the chat's folder unless the session disables `run_workflow` (agent-host acpDialects.ts
/// does); a newer release is checked in an empty folder before this moves.
pub const AGY_ACP_VERSION: &str = "1.5.2";
const AGY_ACP_RELEASES: &str = "https://dl.google.com/agy-extensions/releases";

/// One host's archive and the two executables inside it, each with its sha256 and size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AcpServerBuild {
  pub path: &'static str,
  pub archive: &'static str,
  pub archive_bytes: u64,
  pub server: &'static str,
  pub server_bytes: u64,
  pub harness: &'static str,
  pub harness_bytes: u64,
}

/// By Node's `<platform>-<arch>`, copied from Orca's `PINNED`.
const AGY_ACP_BUILDS: &[(&str, AcpServerBuild)] = &[
  ("darwin-arm64", AcpServerBuild {
    path: "macos/agy-acp-server-1.5.2-darwin-arm64.zip",
    archive: "123a16d5c40a8ac99e20f01a62b68dd860fd96b1c528dfb8eaa37ca8733d4845",
    archive_bytes: 100_309_778,
    server: "4cea3c96875a4bb66a1c136d972b5cfdc5f7c91579ff7b9cbfc158a4358270bc",
    server_bytes: 179_921_328,
    harness: "31ec5f444b8c849ddb14da1c0893a87dddab60f1d5e282b79db36dc41b2521ab",
    harness_bytes: 129_208_672,
  }),
  ("darwin-x64", AcpServerBuild {
    path: "macos/agy-acp-server-1.5.2-darwin-x86_64.zip",
    archive: "92addb5580577b5356d35484d72d1a113d9c5312ad766bcb304983aa8e3fbb06",
    archive_bytes: 106_351_992,
    server: "eaeea2dcd5d162ad075de71fc902d9a3d63116ec5452d81798e30b3c06c6df37",
    server_bytes: 184_312_784,
    harness: "72530625a54510fdba6746c0c4b461f9b1c3222163b0c595f0ed7df660cb6134",
    harness_bytes: 134_350_320,
  }),
  ("linux-x64", AcpServerBuild {
    path: "linux/agy-acp-server-1.5.2-linux-x86_64.zip",
    archive: "99dd8612450805011619d7b8447ce374c289e00549d8557f36790e1dd6256852",
    archive_bytes: 273_964_075,
    server: "f472860b79c4816a32817e589afdb01cec0ca731e5fa428eae873b14be12387f",
    server_bytes: 714_384_320,
    harness: "072fc497e7814b0e25a7d80109bceddacd815eb351d2e48ce579a05510e0cfdf",
    harness_bytes: 139_194_456,
  }),
  ("linux-arm64", AcpServerBuild {
    path: "linux/agy-acp-server-1.5.2-linux-arm64.zip",
    archive: "e729e05ef54ef0763e48900032466b47fa7c9939cde257f93ba49410ab577acb",
    archive_bytes: 264_270_419,
    server: "748dda64d889552943b5527c78aa2804b4e2b9fed7501ae63eb0890ad539380e",
    server_bytes: 721_649_155,
    harness: "06b2fcf3c20d76cec15fc9db952731a2058356311e0760cb818feeabca6d6f91",
    harness_bytes: 132_598_576,
  }),
  ("win32-x64", AcpServerBuild {
    path: "windows/agy-acp-server-1.5.2-windows-x86_64.zip",
    archive: "5cbadd4f4df698572473d8890fc26ec2dc1724501f06e3a963941daec2bd21d6",
    archive_bytes: 105_407_645,
    server: "722d5677f5547e49e2f4796d21ae1d638e0186ec0ecd49b69b12ed6a2de81e54",
    server_bytes: 58_368_800,
    harness: "afc584c54d1a1826d4c430a580d5df12d4bd297eb6ca57e4a8116cf4de72c307",
    harness_bytes: 155_357_336,
  }),
  ("win32-arm64", AcpServerBuild {
    path: "windows/agy-acp-server-1.5.2-windows-arm64.zip",
    archive: "8a4b2ea8df2ffefae33309348752e9119d21a6d36090c0eb48631c2e8f5781ab",
    archive_bytes: 108_049_351,
    server: "1d0e8de59edc7f22edc1b3a1ebc9569b331eda6ec249471c0115a70a97b71b46",
    server_bytes: 65_130_848,
    harness: "88ca79bc3fc76e97ef8a68cd3e7b4b6c503bbf135f2cbca5bc00ec3c02125f05",
    harness_bytes: 146_707_096,
  }),
];

/// This host's pinned build of the server; None where Google ships none.
pub fn agy_acp_build(t: &Target) -> Option<&'static AcpServerBuild> {
  let key = format!("{}-{}", t.node_os()?, t.node_arch()?);
  AGY_ACP_BUILDS.iter().find(|(k, _)| *k == key).map(|(_, b)| b)
}

/// The server program in the release folder.
pub fn agy_acp_server(t: &Target) -> &'static str {
  if t.windows() { "agy_acp_server.exe" } else { "agy_acp_server.par" }
}

/// The harness the server finds beside itself.
pub fn agy_acp_harness(t: &Target) -> &'static str {
  if t.windows() { "localharness_external.exe" } else { "localharness_external" }
}

/// The executables a release must hold, with the sha256 and size each must have.
pub fn agy_acp_members(t: &Target) -> Option<[(&'static str, &'static str, u64); 2]> {
  let b = agy_acp_build(t)?;
  Some([(agy_acp_server(t), b.server, b.server_bytes), (agy_acp_harness(t), b.harness, b.harness_bytes)])
}

fn agy_acp_pin(t: &Target) -> Option<Pin> {
  let b = agy_acp_build(t)?;
  Some(Pin {
    version: AGY_ACP_VERSION.into(),
    url: format!("{AGY_ACP_RELEASES}/{}", b.path),
    digest: Digest::Sha256(b.archive.into()),
    bytes: b.archive_bytes,
    format: Format::Zip,
    executables: vec![agy_acp_server(t).into(), agy_acp_harness(t).into()],
  })
}

/// The latest release of `source` for this host: `Ok(None)` when the publisher has no build (or
/// none Kingu can verify and run), an error when it could not be asked.
pub fn lookup(http: &dyn Http, agent_id: &str, source: &Source, t: &Target) -> Result<Option<Pin>, String> {
  match source {
    Source::Registry { registry_id, .. } => registry_pin(http, registry_id, &source.command(t), agent_id, t),
    Source::Copilot => {
      let Some(target) = copilot_target(t) else { return Ok(None) };
      let (ext, format) = if t.windows() { ("zip", Format::Zip) } else { ("tar.gz", Format::TarGz) };
      Ok(github_latest(http, "GitHub Copilot", "github/copilot-cli", &format!("copilot-{target}.{ext}"))?.map(|b| Pin { version: b.version, url: b.url, digest: Digest::Sha256(b.sha256), bytes: b.bytes, format, executables: vec![source.command(t)] }))
    }
    Source::Omp => {
      let Some(asset) = omp_asset(t) else { return Ok(None) };
      Ok(github_latest(http, "OMP", "can1357/oh-my-pi", &asset)?.map(|b| Pin { version: b.version, url: b.url, digest: Digest::Sha256(b.sha256), bytes: b.bytes, format: Format::File, executables: vec![source.command(t)] }))
    }
    Source::Grok => grok_pin(http, t),
    Source::Kimi => kimi_pin(http, t),
    Source::Agy => agy_pin(http, t),
    Source::AgyAcpServer => Ok(agy_acp_pin(t)),
  }
}

#[cfg(test)]
mod tests {
  use super::super::fetch::tests::Fake;
  use super::*;

  const MAC: Target = Target { os: "macos", arch: "aarch64", musl: false };
  const LINUX: Target = Target { os: "linux", arch: "x86_64", musl: false };
  const MUSL: Target = Target { os: "linux", arch: "aarch64", musl: true };
  const WIN: Target = Target { os: "windows", arch: "x86_64", musl: false };
  const BSD: Target = Target { os: "freebsd", arch: "x86_64", musl: false };
  const RISCV: Target = Target { os: "linux", arch: "riscv64", musl: false };
  const OPENCODE: Source = Source::Registry { registry_id: "opencode", command: "opencode", windows_command: "opencode.exe", alias: None };
  const CURSOR: Source = Source::Registry { registry_id: "cursor", command: "dist-package/cursor-agent", windows_command: "dist-package/cursor-agent.cmd", alias: None };
  const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  /// Orca's target functions, host by host.
  #[test]
  fn each_publisher_names_this_host_its_own_way() {
    let all = |f: fn(&Target) -> Option<String>| [MAC, LINUX, MUSL, WIN, BSD, RISCV].map(|t| f(&t));
    let s = |v: &str| Some(v.to_owned());
    assert_eq!(all(acp_target), [s("darwin-aarch64"), s("linux-x86_64"), s("linux-aarch64-musl"), s("windows-x86_64"), None, None]);
    assert_eq!(all(copilot_target), [s("darwin-arm64"), s("linux-x64"), s("linuxmusl-arm64"), s("win32-x64"), None, None]);
    assert_eq!(all(grok_package), [s("@xai-official/grok-darwin-arm64"), s("@xai-official/grok-linux-x64"), s("@xai-official/grok-linux-arm64"), s("@xai-official/grok-win32-x64"), None, None]);
    assert_eq!(all(kimi_target), [s("darwin-arm64"), s("linux-x64"), None, s("win32-x64"), None, None]);
    assert_eq!(all(omp_asset), [s("omp-darwin-arm64"), s("omp-linux-x64"), s("omp-linux-musl-arm64"), s("omp-windows-x64.exe"), None, None]);
    assert_eq!(all(agy_platform), [s("darwin_arm64"), s("linux_amd64"), s("linux_arm64_musl"), s("windows_amd64"), None, None]);
    assert_eq!([Source::Grok.command(&MAC), Source::Grok.command(&WIN), CURSOR.command(&WIN), Source::Omp.command(&LINUX)], ["bin/grok", "bin/grok.exe", "dist-package/cursor-agent.cmd", "bin/omp"]);
    assert!(Source::Kimi.has_build(&MAC) && !Source::Kimi.has_build(&MUSL) && Source::Grok.has_build(&MUSL) && !OPENCODE.has_build(&BSD));
  }

  #[test]
  fn the_antigravity_acp_server_is_pinned_like_orcas() {
    let http = Fake::default();
    let mac = lookup(&http, "antigravity-server", &Source::AgyAcpServer, &MAC).unwrap().unwrap();
    assert_eq!(mac.url, "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.5.2-darwin-arm64.zip");
    assert_eq!((mac.version.as_str(), mac.bytes, mac.format), ("1.5.2", 100_309_778, Format::Zip));
    assert_eq!(mac.digest, Digest::Sha256("123a16d5c40a8ac99e20f01a62b68dd860fd96b1c528dfb8eaa37ca8733d4845".into()));
    assert_eq!(mac.executables, ["agy_acp_server.par", "localharness_external"]);
    assert!(http.asked().is_empty(), "a pinned release needs no lookup");
    let win = lookup(&http, "antigravity-server", &Source::AgyAcpServer, &WIN).unwrap().unwrap();
    assert_eq!(win.executables, ["agy_acp_server.exe", "localharness_external.exe"]);
    assert!(win.url.ends_with("windows-x86_64.zip"));
    assert_eq!(lookup(&http, "antigravity-server", &Source::AgyAcpServer, &BSD).unwrap(), None);
    assert!(Source::AgyAcpServer.has_build(&LINUX) && !Source::AgyAcpServer.has_build(&RISCV));
    assert_eq!(agy_acp_members(&LINUX).unwrap()[0], ("agy_acp_server.par", "f472860b79c4816a32817e589afdb01cec0ca731e5fa428eae873b14be12387f", 714_384_320));
    for (_, b) in AGY_ACP_BUILDS {
      assert!([b.archive, b.server, b.harness].iter().all(|h| fetch::is_hex(h, 64)), "{}", b.path);
    }
  }

  /// The registry as published 2026-11-22 (trimmed): OpenCode lists its sha256, Cursor none.
  fn registry(opencode_version: &str) -> String {
    serde_json::json!({ "version": "1.0.0", "agents": [
      { "id": "broken", "version": 7 },
      { "id": "npm-only", "version": "1.0.0", "distribution": { "npx": { "package": "x" } } },
      { "id": "opencode", "version": opencode_version, "distribution": { "binary": {
        "darwin-aarch64": { "archive": format!("https://github.com/anomalyco/opencode/releases/download/v{opencode_version}/opencode-darwin-arm64.zip"), "cmd": "./opencode", "args": ["acp"], "sha256": A.to_uppercase() },
        "linux-x86_64": { "archive": format!("https://github.com/anomalyco/opencode/releases/download/v{opencode_version}/opencode-linux-x64.tar.gz"), "cmd": "./opencode", "args": ["acp"], "sha256": B },
        "windows-x86_64": { "archive": "https://example.test/opencode-windows-x64.zip", "cmd": "./opencode.exe", "sha256": B }
      } } },
      { "id": "cursor", "version": "2026.11.19", "distribution": { "binary": {
        "darwin-aarch64": { "archive": "https://downloads.cursor.com/lab/2026.11.19-f005e9d/darwin/arm64/agent-cli-package.tar.gz", "cmd": "./dist-package/cursor-agent", "args": ["acp"] },
        "windows-x86_64": { "archive": "https://downloads.cursor.com/lab/2026.11.19-f005e9d/windows/x64/agent-cli-package.zip", "cmd": "./dist-package\\cursor-agent.cmd" }
      } } }
    ] })
    .to_string()
  }

  #[test]
  fn registry_listings_parse_alone() {
    let agents = parse_registry(&registry("2.3.2")).unwrap();
    assert_eq!(agents.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["npm-only", "opencode", "cursor"], "a malformed listing hides only itself");
    assert_eq!(agents[0].distribution.binary, None);
    assert!(parse_registry("{}").is_err() && parse_registry("nope").is_err());
    assert_eq!(parse_registry(r#"{"agents":[{"id":"x","version":"v1","distribution":{}},{"id":"y","version":"1 2","distribution":{}}]}"#).unwrap(), []);
    for (cmd, member) in [("./opencode", Some("opencode")), ("./dist-package\\cursor-agent.cmd", Some("dist-package/cursor-agent.cmd")), ("bin/tool", Some("bin/tool")), ("../tool", None), ("./a/../../b", None), ("/usr/bin/tool", None), ("C:\\tool.exe", None), ("a//b", None), ("", None)] {
      assert_eq!(release_member(cmd).as_deref(), member, "{cmd:?}");
    }
  }

  #[test]
  fn a_registry_pin_is_the_listed_build_with_a_published_checksum() {
    let cursor_mac = "https://downloads.cursor.com/lab/2026.11.19-f005e9d/darwin/arm64/agent-cli-package.tar.gz";
    let opencode_mac = "https://github.com/anomalyco/opencode/releases/download/v2.3.2/opencode-darwin-arm64.zip";
    let http = Fake::with(&[(ACP_REGISTRY, 200, registry("2.3.2").as_bytes()), (opencode_mac, 200, &[0u8; 77]), (cursor_mac, 200, &[0u8; 99]), (&format!("{cursor_mac}.sha256"), 200, format!("{B}  agent-cli-package.tar.gz\n").as_bytes())]);
    assert_eq!(
      lookup(&http, "opencode", &OPENCODE, &MAC).unwrap(),
      Some(Pin { version: "2.3.2".into(), url: opencode_mac.into(), digest: Digest::Sha256(A.into()), bytes: 77, format: Format::Zip, executables: vec!["opencode".into()] })
    );
    // Cursor lists no hash: the one published beside the archive.
    assert_eq!(
      lookup(&http, "cursor", &CURSOR, &MAC).unwrap(),
      Some(Pin { version: "2026.11.19".into(), url: cursor_mac.into(), digest: Digest::Sha256(B.into()), bytes: 99, format: Format::TarGz, executables: vec!["dist-package/cursor-agent".into()] })
    );
    // No checksum anywhere: not a pin. The archive itself is never requested by a lookup.
    http.put(&format!("{cursor_mac}.sha256"), 404, b"");
    assert_eq!(lookup(&http, "cursor", &CURSOR, &MAC).unwrap(), None);
    http.put(&format!("{cursor_mac}.sha256"), 200, b"<html>not a hash</html>");
    assert_eq!(lookup(&http, "cursor", &CURSOR, &MAC).unwrap(), None);
    assert!(!http.asked().iter().any(|u| u == cursor_mac || u == opencode_mac));
    // No build for this host, an agent the registry does not list, a host the registry has no key for.
    assert_eq!(lookup(&http, "opencode", &OPENCODE, &MUSL).unwrap(), None);
    assert_eq!(lookup(&http, "opencode2", &Source::Registry { registry_id: "opencode-v2", command: "opencode", windows_command: "opencode.exe", alias: Some("opencode2") }, &MAC).unwrap(), None);
    assert_eq!(lookup(&http, "opencode", &OPENCODE, &BSD).unwrap(), None);
    // The command moved inside the release: launches would not find it.
    assert_eq!(lookup(&http, "opencode", &Source::Registry { registry_id: "opencode", command: "bin/opencode", windows_command: "opencode.exe", alias: None }, &MAC).unwrap(), None);
    // Below the launch gate's floor for its release line (Orca OPENCODE_MINIMUM_VERSIONS, CURSOR_MINIMUM_VERSIONS).
    for (v, ok) in [("1.18.30", false), ("1.18.31", true), ("2.0.13", false), ("2.0.14", true)] {
      let url = format!("https://github.com/anomalyco/opencode/releases/download/v{v}/opencode-darwin-arm64.zip");
      let http = Fake::with(&[(ACP_REGISTRY, 200, registry(v).as_bytes()), (&url, 200, b"x")]);
      assert_eq!(lookup(&http, "opencode", &OPENCODE, &MAC).unwrap().is_some(), ok, "{v}");
    }
    // An unreachable registry is an error, not "no build".
    assert!(lookup(&Fake::default(), "opencode", &OPENCODE, &MAC).is_err());
    // A listing that names a non-https archive is not a pin.
    let plain = registry("2.3.2").replace("https://github.com/anomalyco", "http://github.com/anomalyco");
    assert_eq!(lookup(&Fake::with(&[(ACP_REGISTRY, 200, plain.as_bytes())]), "opencode", &OPENCODE, &MAC).unwrap(), None);
  }

  fn github(tag: &str, assets: &[(&str, u64, Option<&str>)]) -> String {
    let assets: Vec<_> = assets.iter().map(|(name, size, digest)| serde_json::json!({ "name": name, "size": size, "browser_download_url": format!("https://github.com/dl/{tag}/{name}"), "digest": digest })).collect();
    serde_json::json!({ "tag_name": tag, "assets": assets }).to_string()
  }

  #[test]
  fn github_releases_are_hashed_by_their_checksum_list() {
    let api = "https://api.github.com/repos/github/copilot-cli/releases/latest";
    let sums = "https://github.com/dl/v1.0.110/SHA256SUMS.txt";
    let list = format!("{B}  copilot-linux-x64.tar.gz\n{A}  copilot-darwin-arm64.tar.gz\n{B}  copilot-win32-x64.zip\n");
    let digest = format!("sha256:{A}");
    let release = github("v1.0.110", &[("copilot-darwin-arm64.tar.gz", 5000, Some(&digest)), ("copilot-win32-x64.zip", 6000, None), ("SHA256SUMS.txt", 300, None)]);
    let http = Fake::with(&[(api, 200, release.as_bytes()), (sums, 200, list.as_bytes())]);
    assert_eq!(
      lookup(&http, "copilot", &Source::Copilot, &MAC).unwrap(),
      Some(Pin { version: "1.0.110".into(), url: "https://github.com/dl/v1.0.110/copilot-darwin-arm64.tar.gz".into(), digest: Digest::Sha256(A.into()), bytes: 5000, format: Format::TarGz, executables: vec!["copilot".into()] })
    );
    let win = lookup(&http, "copilot", &Source::Copilot, &WIN).unwrap().unwrap();
    assert_eq!((win.format, win.executables, win.digest), (Format::Zip, vec!["copilot.exe".to_owned()], Digest::Sha256(B.into())));
    assert_eq!(lookup(&http, "copilot", &Source::Copilot, &MUSL).unwrap(), None, "no build published for this host");
    // GitHub's own digest disagrees with the list; a build the list does not name; an odd tag.
    let other = format!("sha256:{B}");
    http.put(api, 200, github("v1.0.110", &[("copilot-darwin-arm64.tar.gz", 5000, Some(&other)), ("SHA256SUMS.txt", 300, None)]).as_bytes());
    assert!(lookup(&http, "copilot", &Source::Copilot, &MAC).unwrap_err().contains("no matching checksum"));
    http.put(api, 200, github("v1.0.110", &[("copilot-linux-x64.tar.gz", 5000, None), ("SHA256SUMS.txt", 300, None)]).as_bytes());
    http.put(sums, 200, b"only-one-word\n");
    assert!(lookup(&http, "copilot", &Source::Copilot, &LINUX).is_err());
    http.put(api, 200, github("nightly", &[]).as_bytes());
    assert!(lookup(&http, "copilot", &Source::Copilot, &MAC).unwrap_err().contains("unexpected tag"));
    assert_eq!([tag_version("v1.2.3"), tag_version("1.2.3"), tag_version("v1.2"), tag_version("v1.2.3-rc.1"), tag_version("v1.2.3.4")], [Some("1.2.3"), None, None, None, None]);

    // OMP: the asset is the executable itself, placed at bin/omp.
    let omp = "https://api.github.com/repos/can1357/oh-my-pi/releases/latest";
    let http = Fake::with(&[(omp, 200, github("v17.2.0", &[("omp-darwin-arm64", 9000, None), ("SHA256SUMS.txt", 100, None)]).as_bytes()), ("https://github.com/dl/v17.2.0/SHA256SUMS.txt", 200, format!("{A}  omp-darwin-arm64\n").as_bytes())]);
    assert_eq!(
      lookup(&http, "omp", &Source::Omp, &MAC).unwrap(),
      Some(Pin { version: "17.2.0".into(), url: "https://github.com/dl/v17.2.0/omp-darwin-arm64".into(), digest: Digest::Sha256(A.into()), bytes: 9000, format: Format::File, executables: vec!["bin/omp".into()] })
    );
  }

  #[test]
  fn grok_is_npms_platform_package_by_its_sha512() {
    use base64::Engine as _;
    let integrity = format!("sha512-{}", base64::engine::general_purpose::STANDARD.encode([0xabu8; 64]));
    assert_eq!(npm_sha512_hex(&integrity), Some("ab".repeat(64)));
    assert_eq!([npm_sha512_hex("sha1-q83v"), npm_sha512_hex("sha512-q83v"), npm_sha512_hex("sha512-***")], [None, None, None]);
    let latest = "https://registry.npmjs.org/@xai-official/grok/latest";
    let package = "https://registry.npmjs.org/@xai-official/grok-darwin-arm64/0.9.4";
    let tarball = "https://registry.npmjs.org/@xai-official/grok-darwin-arm64/-/grok-darwin-arm64-0.9.4.tgz";
    let build = |version: &str, tarball: &str, integrity: &str| serde_json::json!({ "version": version, "dist": { "tarball": tarball, "integrity": integrity } }).to_string();
    let http = Fake::with(&[(latest, 200, br#"{"version":"0.9.4"}"#), (package, 200, build("0.9.4", tarball, &integrity).as_bytes()), (tarball, 200, &[0u8; 321])]);
    assert_eq!(
      lookup(&http, "grok", &Source::Grok, &MAC).unwrap(),
      Some(Pin { version: "0.9.4".into(), url: tarball.into(), digest: Digest::Sha512("ab".repeat(64)), bytes: 321, format: Format::TarGz, executables: vec!["bin/grok".into()] })
    );
    for bad in [build("0.9.5", tarball, &integrity), build("0.9.4", "https://evil.test/grok.tgz", &integrity), build("0.9.4", tarball, "sha1-q83v"), "{}".to_owned()] {
      http.put(package, 200, bad.as_bytes());
      assert!(lookup(&http, "grok", &Source::Grok, &MAC).is_err(), "{bad}");
    }
    http.put(latest, 200, br#"{"version":"../../x"}"#);
    assert!(lookup(&http, "grok", &Source::Grok, &MAC).is_err());
    assert_eq!(lookup(&http, "grok", &Source::Grok, &BSD).unwrap(), None);
  }

  #[test]
  fn kimi_and_agy_follow_their_manifests() {
    let latest = "https://code.kimi.com/kimi-code/latest";
    let manifest = "https://code.kimi.com/kimi-code/binaries/2.6.1/manifest.json";
    let binary = "https://code.kimi.com/kimi-code/binaries/2.6.1/kimi-darwin-arm64";
    let doc = |version: &str, filename: &str, checksum: &str| serde_json::json!({ "version": version, "platforms": { "darwin-arm64": { "filename": filename, "checksum": checksum } } }).to_string();
    let http = Fake::with(&[(latest, 200, b"2.6.1\n"), (manifest, 200, doc("2.6.1", "kimi-darwin-arm64", A).as_bytes()), (binary, 200, &[0u8; 55])]);
    assert_eq!(
      lookup(&http, "kimi", &Source::Kimi, &MAC).unwrap(),
      Some(Pin { version: "2.6.1".into(), url: binary.into(), digest: Digest::Sha256(A.into()), bytes: 55, format: Format::File, executables: vec!["kimi".into()] })
    );
    assert_eq!(lookup(&http, "kimi", &Source::Kimi, &LINUX).unwrap(), None, "the manifest has no build for this host");
    assert_eq!(lookup(&http, "kimi", &Source::Kimi, &MUSL).unwrap(), None);
    for bad in [doc("2.6.1", "../../evil", A), doc("2.6.1", "kimi", "ABC"), "[]".to_owned()] {
      http.put(manifest, 200, bad.as_bytes());
      assert!(lookup(&http, "kimi", &Source::Kimi, &MAC).is_err(), "{bad}");
    }
    http.put(manifest, 200, doc("2.6.0", "kimi-darwin-arm64", A).as_bytes());
    assert_eq!(lookup(&http, "kimi", &Source::Kimi, &MAC).unwrap(), None, "the manifest is another release's");
    for bad in ["<html>", "2.6.1/../../x", "latest"] {
      http.put(latest, 200, bad.as_bytes());
      assert!(lookup(&http, "kimi", &Source::Kimi, &MAC).is_err(), "{bad}");
    }

    let agy = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json";
    let build = "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.6.0/antigravity-darwin-arm64.tar.gz";
    let sha = "CD".repeat(64);
    let doc = |url: &str, sha: &str| serde_json::json!({ "version": "1.6.0", "url": url, "sha512": sha }).to_string();
    let http = Fake::with(&[(agy, 200, doc(build, &sha).as_bytes()), (build, 200, &[0u8; 88])]);
    assert_eq!(
      lookup(&http, "antigravity", &Source::Agy, &MAC).unwrap(),
      Some(Pin { version: "1.6.0".into(), url: build.into(), digest: Digest::Sha512("cd".repeat(64)), bytes: 88, format: Format::TarGz, executables: vec!["agy".into()] })
    );
    for (url, sha) in [("https://evil.test/agy.tar.gz", sha.as_str()), ("https://storage.googleapis.com/antigravity-public/antigravity-cli/../../other/agy.tar.gz", sha.as_str()), (build, A), ("https://storage.googleapis.com/antigravity-public/antigravity-cli/1.6.0/agy.pkg", sha.as_str())] {
      http.put(agy, 200, doc(url, sha).as_bytes());
      assert!(lookup(&http, "antigravity", &Source::Agy, &MAC).is_err(), "{url}");
    }
  }
}
