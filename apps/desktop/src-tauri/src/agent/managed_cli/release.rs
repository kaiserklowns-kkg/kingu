//! Releases on disk: `<app data>/agent-runtimes/<agent>/<version>/`, each published whole by one
//! rename and marked by a receipt, as Orca's (`main/node-runtime/managed-runtime-release.ts`,
//! `managed-runtime-release-install.ts`). An install downloads into `.download-<pid>-<n>/` beside
//! the releases, verifies the digest, unpacks, checks that the program starts and answers the
//! release's version, writes the receipt, and only then renames the folder into place; whatever
//! fails before that leaves nothing but the staging folder, which is removed on the way out.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::archive;
use super::fetch::{self, DownloadError, Http};
use super::pin::{Format, Pin, Source, Target};
use crate::agent::runtimes;
use crate::i18n::msg::ManagedCliMsg;
use crate::tr;

pub const RECEIPT: &str = ".install-complete.json";
const RECEIPT_MAX_BYTES: u64 = 8 * 1024;
/// Orca's `FREE_SPACE_MARGIN_BYTES` and `UNPACKED_RATIO`.
const FREE_SPACE_MARGIN: u64 = 256 * 1024 * 1024;
const UNPACKED_RATIO: u64 = 3;
/// The most an archive may unpack to: far above any real release, far below a full disk.
const UNPACK_FACTOR: u64 = 40;
const VALIDATE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct ReceiptMember {
  path: String,
  bytes: u64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct Receipt {
  #[serde(rename = "releaseId")]
  release_id: String,
  version: String,
  platform: String,
  arch: String,
  members: Vec<ReceiptMember>,
}

/// A version is also a folder name: one plain path segment.
pub fn version_is_a_folder_name(version: &str) -> bool {
  !version.is_empty() && version.len() <= 64 && !version.starts_with('.') && version.bytes().all(|b| b.is_ascii_alphanumeric() || b".+-_".contains(&b))
}

fn member_path(folder: &Path, member: &str) -> Option<PathBuf> {
  let parts: Vec<&str> = member.split('/').collect();
  parts.iter().all(|p| !p.is_empty() && *p != "." && *p != ".." && !p.contains('\\')).then(|| parts.iter().fold(folder.to_path_buf(), |at, p| at.join(p)))
}

#[cfg(unix)]
fn is_executable_file(meta: &fs::Metadata) -> bool {
  use std::os::unix::fs::PermissionsExt;
  meta.is_file() && meta.permissions().mode() & 0o111 != 0
}
#[cfg(not(unix))]
fn is_executable_file(meta: &fs::Metadata) -> bool {
  meta.is_file()
}

#[derive(Debug, PartialEq, Eq)]
enum Read {
  Whole(String),
  Broken,
  Unreadable,
}

fn absent(e: &std::io::Error) -> bool {
  matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory)
}

/// One release folder: whole when its receipt names this version, this platform, and members that
/// are still executable files of the recorded size (links never count).
fn read_release(folder: &Path, version: &str) -> Read {
  let check = || -> std::io::Result<Read> {
    let receipt_path = folder.join(RECEIPT);
    let stat = fs::symlink_metadata(&receipt_path)?;
    if !fs::symlink_metadata(folder)?.is_dir() || !stat.is_file() || stat.len() > RECEIPT_MAX_BYTES {
      return Ok(Read::Broken);
    }
    let Ok(receipt) = serde_json::from_str::<Receipt>(&fs::read_to_string(&receipt_path)?) else { return Ok(Read::Broken) };
    let digest_len = receipt.release_id.len();
    if receipt.version != version || receipt.platform != std::env::consts::OS || receipt.arch != std::env::consts::ARCH || receipt.members.is_empty() || !(fetch::is_hex(&receipt.release_id, digest_len) && (digest_len == 64 || digest_len == 128)) {
      return Ok(Read::Broken);
    }
    for member in &receipt.members {
      let Some(path) = member_path(folder, &member.path) else { return Ok(Read::Broken) };
      let meta = fs::symlink_metadata(&path)?;
      if !is_executable_file(&meta) || meta.len() != member.bytes || member.bytes == 0 {
        return Ok(Read::Broken);
      }
    }
    Ok(Read::Whole(receipt.release_id))
  };
  match check() {
    Ok(read) => read,
    Err(e) if absent(&e) => Read::Broken,
    Err(_) => Read::Unreadable,
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
  pub folder: PathBuf,
  pub version: String,
  /// It is the looked-up release itself (same version, same download).
  pub current: bool,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Releases {
  /// The whole looked-up release, else the newest whole one; staging, links and partial copies never.
  pub release: Option<Installed>,
  pub broken: Vec<String>,
  pub unreadable: bool,
}

pub fn resolve_installed(root: &Path, pin: Option<&Pin>) -> Releases {
  let names: Vec<String> = match fs::read_dir(root) {
    Ok(entries) => entries.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| !n.starts_with('.')).collect(),
    Err(e) => return Releases { unreadable: !absent(&e), ..Releases::default() },
  };
  let reads: Vec<(String, Read)> = names.into_iter().map(|n| (n.clone(), read_release(&root.join(&n), &n))).collect();
  let mut whole: Vec<(&str, &str)> = reads.iter().filter_map(|(n, r)| if let Read::Whole(id) = r { Some((n.as_str(), id.as_str())) } else { None }).collect();
  let pinned = pin.and_then(|p| whole.iter().find(|(n, id)| *n == p.version && *id == p.digest.hex()).copied());
  whole.sort_by(|a, b| runtimes::compare_versions(b.0, a.0).then_with(|| b.0.cmp(a.0)));
  let chosen = pinned.or(whole.first().copied());
  Releases {
    release: chosen.map(|(n, _)| Installed { folder: root.join(n), version: n.to_owned(), current: pinned.is_some() }),
    broken: reads.iter().filter(|(_, r)| *r == Read::Broken).map(|(n, _)| n.clone()).collect(),
    unreadable: reads.iter().any(|(_, r)| *r == Read::Unreadable),
  }
}

/// Whether `root` may hold a published release; an unreadable one may, so callers fail closed.
pub fn may_be_published(root: &Path) -> bool {
  match fs::read_dir(root) {
    Ok(entries) => entries.flatten().filter(|e| !e.file_name().to_string_lossy().starts_with('.')).any(|e| match fs::symlink_metadata(e.path().join(RECEIPT)) {
      Ok(m) => m.is_file(),
      Err(err) => !absent(&err),
    }),
    Err(e) => !absent(&e),
  }
}

/// Removes every entry of `root` but `keep` (old releases, abandoned staging folders).
pub fn reclaim(root: &Path, keep: &[&str]) {
  let Ok(entries) = fs::read_dir(root) else { return };
  for entry in entries.flatten() {
    let name = entry.file_name();
    if keep.iter().any(|k| name == **k) {
      continue;
    }
    let path = entry.path();
    let removed = if fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir()) { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
    if let Err(e) = removed {
      log::warn!("managed install: {} not removed ({e})", path.display());
    }
  }
}

#[cfg(unix)]
fn make_executable(path: &Path) -> std::io::Result<()> {
  use std::os::unix::fs::PermissionsExt;
  fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}
#[cfg(not(unix))]
fn make_executable(_: &Path) -> std::io::Result<()> {
  Ok(())
}

#[cfg(unix)]
fn free_bytes(dir: &Path) -> Option<u64> {
  use std::os::unix::ffi::OsStrExt;
  let path = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
  let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
  // SAFETY: `path` is a NUL-terminated string and `stat` a zeroed statvfs for the call to fill.
  (unsafe { libc::statvfs(path.as_ptr(), &mut stat) } == 0).then(|| stat.f_bavail as u64 * stat.f_frsize as u64)
}
#[cfg(not(unix))]
fn free_bytes(_: &Path) -> Option<u64> {
  None
}

/// What a release needs once unpacked, before it is checked (Orca's `prepare`).
fn prepare(source: &Source, release: &Path, t: &Target, budget: u64) -> Result<(), String> {
  let command = member_path(release, &source.command(t)).ok_or("bad command path")?;
  match source {
    // The package ships its binary brotli-compressed to fit npm's size limit.
    Source::Grok => {
      let compressed = release.join("package").join(format!("{}.br", source.command(t)));
      let input = fs::File::open(&compressed).map_err(|_| tr!(ManagedCliMsg::Missing, label = "Grok", file = format!("package/{}.br", source.command(t))))?;
      fs::create_dir_all(command.parent().unwrap_or(release)).map_err(|e| e.to_string())?;
      let mut out = fs::OpenOptions::new().write(true).create_new(true).open(&command).map_err(|e| e.to_string())?;
      let mut reader = std::io::Read::take(brotli::Decompressor::new(std::io::BufReader::new(input), 64 * 1024), budget + 1);
      let written = std::io::copy(&mut reader, &mut out).map_err(|e| tr!(ManagedCliMsg::Unpack, label = "Grok", detail = e))?;
      if written > budget {
        return Err(tr!(ManagedCliMsg::Unpack, label = "Grok", detail = archive::Refusal::TooLarge));
      }
      drop(out);
      fs::remove_dir_all(release.join("package")).map_err(|e| e.to_string())
    }
    // OMP reads this beside its bin folder and leaves updates to the named manager instead of replacing itself.
    Source::Omp => fs::write(release.join("manager.json"), r#"{"name":"Kingu"}"#).map_err(|e| e.to_string()),
    // Each executable is the one Orca pinned, byte for byte, before any of it runs.
    Source::AgyAcpServer => {
      let members = super::pin::agy_acp_members(t).ok_or_else(|| tr!(ManagedCliMsg::ReleaseMismatch, label = "Antigravity"))?;
      verify_members(release, &members).map_err(|detail| {
        log::warn!("managed install: Antigravity ACP server refused: {detail}");
        tr!(ManagedCliMsg::ReleaseMismatch, label = "Antigravity")
      })
    }
    // The archive names its binary `antigravity`; launches and terminals run `agy`.
    Source::Agy if !t.windows() => fs::rename(release.join("antigravity"), &command).map_err(|_| tr!(ManagedCliMsg::Missing, label = "Antigravity", file = "antigravity")),
    // Beside the command, so the folder on a terminal's PATH answers to the alias too.
    Source::Registry { alias: Some(alias), .. } => {
      let named = command.with_file_name(if t.windows() { format!("{alias}.exe") } else { (*alias).to_owned() });
      if fs::symlink_metadata(&command).is_ok_and(|m| m.is_file()) && fs::hard_link(&command, &named).is_err() {
        fs::copy(&command, &named).map_err(|e| e.to_string())?;
      }
      Ok(())
    }
    _ => Ok(()),
  }
}

/// Each `(path, sha256, bytes)` is a plain file in `release` of that size and digest (Orca's
/// pinned `members`); the first one that is not says why.
pub fn verify_members(release: &Path, members: &[(&str, &str, u64)]) -> Result<(), String> {
  use sha2::Digest as _;
  use std::io::Read as _;
  for (path, sha256, bytes) in members {
    let file = member_path(release, path).ok_or_else(|| format!("{path}: not a release path"))?;
    let meta = fs::symlink_metadata(&file).map_err(|_| format!("{path}: missing"))?;
    if !meta.is_file() || meta.len() != *bytes {
      return Err(format!("{path}: {} bytes, expected {bytes}", meta.len()));
    }
    let mut hasher = sha2::Sha256::new();
    let mut input = fs::File::open(&file).map_err(|e| format!("{path}: {e}"))?;
    let mut buf = vec![0u8; 1 << 16];
    loop {
      let n = input.read(&mut buf).map_err(|e| format!("{path}: {e}"))?;
      if n == 0 {
        break;
      }
      hasher.update(&buf[..n]);
    }
    let got: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if got != *sha256 {
      return Err(format!("{path}: checksum mismatch"));
    }
  }
  Ok(())
}

/// What a failed start check observed.
#[derive(Debug, PartialEq, Eq)]
pub enum StartFailure {
  Timeout,
  Exit(String),
  Version(String),
}

/// Runs `<program> --version` (at most 60 s) and requires the release's version back (Orca
/// `requireRuntimeAnswersVersion`). `prefix_ok`: the registry lists `2026.11.19` for a program
/// that answers `2026.11.19-f005e9d`.
pub fn answers_version(program: &Path, expected: &str, prefix_ok: bool, env: &[(&str, &str)]) -> Result<(), StartFailure> {
  use std::io::Read as _;
  use std::process::Stdio;
  let spawn = || crate::shell_env::command(program).arg("--version").envs(env.iter().copied()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn();
  // A file just written can still be open for writing in a process forked a moment ago (ETXTBSY).
  let mut tries = 0;
  let mut child = loop {
    match spawn() {
      Ok(child) => break child,
      Err(e) if e.raw_os_error() == Some(26) && tries < 20 => {
        tries += 1;
        std::thread::sleep(Duration::from_millis(25));
      }
      Err(e) => return Err(StartFailure::Exit(e.to_string())),
    }
  };
  let started = std::time::Instant::now();
  let status = loop {
    match child.try_wait() {
      Ok(Some(status)) => break status,
      Ok(None) if started.elapsed() < VALIDATE_TIMEOUT => std::thread::sleep(Duration::from_millis(25)),
      _ => {
        let _ = child.kill();
        let _ = child.wait();
        return Err(StartFailure::Timeout);
      }
    }
  };
  let mut out = Vec::new();
  if let Some(pipe) = child.stdout.as_mut() {
    let _ = pipe.take(64 * 1024).read_to_end(&mut out);
  }
  if !status.success() {
    return Err(StartFailure::Exit(status.code().map_or_else(|| "a signal".to_owned(), |c| format!("code {c}"))));
  }
  let answered = String::from_utf8_lossy(&out).trim().to_owned();
  let parsed = runtimes::parse_cli_version(&answered);
  match parsed.as_deref() {
    Some(v) if v == expected || prefix_ok && v.strip_prefix(expected).is_some_and(|rest| rest.starts_with('-')) => Ok(()),
    _ => Err(StartFailure::Version(parsed.unwrap_or_else(|| answered.chars().filter(|c| !c.is_control()).take(80).collect()))),
  }
}

fn start_failure_text(label: &str, expected: &str, failure: &StartFailure) -> String {
  let detail = match failure {
    StartFailure::Timeout => tr!(ManagedCliMsg::StartTimeout, seconds = VALIDATE_TIMEOUT.as_secs()),
    StartFailure::Exit(status) => tr!(ManagedCliMsg::StartExit, status),
    StartFailure::Version(answered) => tr!(ManagedCliMsg::StartVersion, answered = if answered.is_empty() { "?" } else { answered }, expected),
  };
  tr!(ManagedCliMsg::NoStart, label, detail)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
  Downloading,
  Extracting,
  Verifying,
  Removing,
  Succeeded,
  Failed,
  Cancelled,
}

#[derive(Debug, PartialEq, Eq)]
pub enum InstallError {
  Cancelled,
  /// Worded for the user.
  Failed(String),
}

impl From<String> for InstallError {
  fn from(text: String) -> Self {
    InstallError::Failed(text)
  }
}

pub struct Install<'a> {
  pub label: &'a str,
  pub source: &'a Source,
  pub target: Target,
  pub root: &'a Path,
  pub pin: &'a Pin,
  pub http: &'a dyn Http,
  pub cancel: &'a AtomicBool,
  /// Whether the unpacked program is the release (it starts and answers its version).
  pub validate: &'a dyn Fn(&Path, &Pin) -> Result<(), StartFailure>,
  pub free_bytes: &'a dyn Fn(&Path) -> Option<u64>,
  pub progress: &'a mut dyn FnMut(Phase, u64),
}

static STAGING: AtomicU64 = AtomicU64::new(0);

/// Installs `pin` under `root`. Returns once the release folder is in place (the rename commits:
/// nothing after it can undo the install). An error or a cancel before that leaves `root` as it was.
pub fn install_release(input: &mut Install) -> Result<(), InstallError> {
  let Install { label, pin, root, .. } = *input;
  let cancelled = |input: &Install| if input.cancel.load(Ordering::SeqCst) { Err(InstallError::Cancelled) } else { Ok(()) };
  fetch::require_https(&pin.url).map_err(|_| tr!(ManagedCliMsg::ReleaseMismatch, label))?;
  if !version_is_a_folder_name(&pin.version) || pin.executables.is_empty() || pin.executables.iter().any(|e| member_path(root, e).is_none()) {
    return Err(tr!(ManagedCliMsg::ReleaseMismatch, label).into());
  }
  let folder = root.join(&pin.version);
  fs::create_dir_all(root).map_err(|e| e.to_string())?;
  let validate = |input: &Install, folder: &Path| -> Result<(), InstallError> {
    let command = member_path(folder, &input.source.command(&input.target)).ok_or_else(|| tr!(ManagedCliMsg::ReleaseMismatch, label))?;
    (input.validate)(&command, pin).map_err(|failure| {
      log::warn!("managed install: {label} did not start from {}: {failure:?}", folder.display());
      InstallError::Failed(start_failure_text(label, &pin.version, &failure))
    })
  };
  if fs::symlink_metadata(&folder).is_ok() {
    // Only a receipt for this exact download proves an existing copy whole; anything else is repaired.
    (input.progress)(Phase::Verifying, 0);
    if resolve_installed(root, Some(pin)).release.is_some_and(|r| r.current) {
      validate(input, &folder)?;
      return cancelled(input);
    }
    (input.progress)(Phase::Downloading, 0);
  }
  // A single-file release is renamed into place, so it never needs room for two copies.
  let needed = if pin.format == Format::File { pin.bytes } else { pin.bytes.saturating_mul(1 + UNPACKED_RATIO) };
  if (input.free_bytes)(root).is_some_and(|free| free < needed.saturating_add(FREE_SPACE_MARGIN)) {
    return Err(tr!(ManagedCliMsg::DiskSpace, label, megabytes = (needed + FREE_SPACE_MARGIN).div_ceil(1024 * 1024)).into());
  }
  let staging = root.join(format!(".download-{}-{}", std::process::id(), STAGING.fetch_add(1, Ordering::SeqCst)));
  let _ = fs::remove_dir_all(&staging);
  let result = stage_and_publish(input, &staging, &folder, &validate, &cancelled);
  if let Err(e) = fs::remove_dir_all(&staging) {
    log::warn!("managed install: staging {} not removed ({e})", staging.display());
  }
  result
}

fn stage_and_publish(
  input: &mut Install,
  staging: &Path,
  folder: &Path,
  validate: &dyn Fn(&Install, &Path) -> Result<(), InstallError>,
  cancelled: &dyn Fn(&Install) -> Result<(), InstallError>,
) -> Result<(), InstallError> {
  let Install { label, pin, .. } = *input;
  let release = staging.join("release");
  fs::create_dir_all(&release).map_err(|e| e.to_string())?;
  let archive_path = staging.join("download");
  let progress = &mut *input.progress;
  let mut shown = std::time::Instant::now() - Duration::from_secs(1);
  let mut on_bytes = |bytes: u64| {
    if shown.elapsed() >= Duration::from_millis(250) {
      shown = std::time::Instant::now();
      progress(Phase::Downloading, bytes);
    }
  };
  // Nothing of the download is unpacked, made executable or run before its digest matched.
  fetch::download_verified(input.http, &pin.url, &pin.digest, pin.bytes, &archive_path, input.cancel, true, &mut on_bytes).map_err(|e| match e {
    DownloadError::Cancelled => InstallError::Cancelled,
    DownloadError::Mismatch(detail) => {
      log::warn!("managed install: {label} download refused: {detail}");
      InstallError::Failed(if detail.contains("checksum mismatch") { tr!(ManagedCliMsg::ChecksumMismatch, label) } else { tr!(ManagedCliMsg::ReleaseMismatch, label) })
    }
    DownloadError::Network(detail) => {
      log::warn!("managed install: {label} download failed: {detail}");
      InstallError::Failed(tr!(ManagedCliMsg::DownloadFailed, label))
    }
    DownloadError::Io(detail) => InstallError::Failed(detail),
  })?;
  (input.progress)(Phase::Extracting, pin.bytes);
  let budget = pin.bytes.saturating_mul(UNPACK_FACTOR).saturating_add(FREE_SPACE_MARGIN);
  let unpacked = match pin.format {
    Format::File => {
      let dest = member_path(&release, &pin.executables[0]).filter(|_| pin.executables.len() == 1).ok_or_else(|| tr!(ManagedCliMsg::ReleaseMismatch, label))?;
      fs::create_dir_all(dest.parent().unwrap_or(&release)).and_then(|()| fs::rename(&archive_path, &dest)).map_err(|e| archive::Refusal::Io(e.to_string()))
    }
    Format::TarGz => archive::unpack_tar_gz(&archive_path, &release, budget),
    Format::Zip => archive::unpack_zip(&archive_path, &release, budget),
  };
  unpacked.map_err(|refusal| tr!(ManagedCliMsg::Unpack, label, detail = refusal))?;
  // The archive is no longer needed once unpacked; free its space before checking.
  let _ = fs::remove_file(&archive_path);
  cancelled(input)?;
  (input.progress)(Phase::Verifying, pin.bytes);
  // Before the check, so a command `prepare` unpacks is checked like a downloaded one.
  prepare(input.source, &release, &input.target, budget)?;
  let mut members = Vec::new();
  for executable in &pin.executables {
    let path = member_path(&release, executable).ok_or_else(|| tr!(ManagedCliMsg::ReleaseMismatch, label))?;
    let meta = fs::symlink_metadata(&path).ok().filter(|m| m.is_file() && m.len() > 0).ok_or_else(|| tr!(ManagedCliMsg::Missing, label, file = executable))?;
    make_executable(&path).map_err(|e| e.to_string())?;
    members.push(ReceiptMember { path: executable.clone(), bytes: meta.len() });
  }
  validate(input, &release)?;
  // Written before the rename, so a published release never carries a partial receipt.
  let receipt = Receipt { release_id: pin.digest.hex().to_owned(), version: pin.version.clone(), platform: std::env::consts::OS.into(), arch: std::env::consts::ARCH.into(), members };
  let receipt_file = fs::OpenOptions::new().write(true).create_new(true).open(release.join(RECEIPT)).map_err(|e| e.to_string())?;
  serde_json::to_writer(receipt_file, &receipt).map_err(|e| e.to_string())?;
  cancelled(input)?;
  if fs::symlink_metadata(folder).is_ok() {
    fs::rename(folder, staging.join("damaged")).map_err(|e| e.to_string())?;
  }
  fs::rename(&release, folder).map_err(|e| e.to_string())?;
  Ok(())
}

pub fn real_free_bytes(dir: &Path) -> Option<u64> {
  free_bytes(dir)
}

#[cfg(all(test, unix))]
mod tests {
  use super::super::archive::tests::{gz, tar_entry, tar_of, zip_of};
  use super::super::fetch::Digest;
  use super::super::fetch::tests::{Fake, sha256_hex, sha512_hex};
  use super::*;
  use std::io::Write;
  use std::os::unix::fs::PermissionsExt;

  const MAC: Target = Target { os: "macos", arch: "aarch64", musl: false };
  const URL: &str = "https://example.test/dl/tool.tar.gz";
  const COPILOT: Source = Source::Copilot;

  fn script(version: &str) -> Vec<u8> {
    format!("#!/bin/sh\necho \"tool {version}\"\n").into_bytes()
  }

  fn copilot_archive(version: &str) -> Vec<u8> {
    gz(&tar_of(&[tar_entry("copilot", b'0', 0o755, "", &script(version)), tar_entry("README.md", b'0', 0o644, "", b"hi")]))
  }

  fn pin_for(version: &str, body: &[u8], format: Format, executables: &[&str]) -> Pin {
    Pin { version: version.into(), url: URL.into(), digest: Digest::Sha256(sha256_hex(body)), bytes: body.len() as u64, format, executables: executables.iter().map(|e| (*e).to_owned()).collect() }
  }

  /// Runs the real `--version` check, with the phases recorded.
  fn run(root: &Path, http: &Fake, pin: &Pin, source: &Source, cancel: &AtomicBool) -> (Result<(), InstallError>, Vec<Phase>) {
    let mut phases = Vec::new();
    let mut progress = |phase: Phase, _: u64| {
      if phases.last() != Some(&phase) {
        phases.push(phase);
      }
    };
    let prefix_ok = matches!(source, Source::Registry { .. });
    let validate = |program: &Path, pin: &Pin| answers_version(program, &pin.version, prefix_ok, &[]);
    let mut install = Install { label: "Tool", source, target: MAC, root, pin, http, cancel, validate: &validate, free_bytes: &|_| None, progress: &mut progress };
    let result = install_release(&mut install);
    (result, phases)
  }

  fn entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    names.sort();
    names
  }

  #[test]
  fn installs_a_verified_release_by_one_rename() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("agent-runtimes/copilot");
    let body = copilot_archive("1.0.110");
    let pin = pin_for("1.0.110", &body, Format::TarGz, &["copilot"]);
    let http = Fake::with(&[(URL, 200, &body)]);
    let (result, phases) = run(&root, &http, &pin, &COPILOT, &AtomicBool::new(false));
    result.unwrap();
    assert_eq!(phases, [Phase::Downloading, Phase::Extracting, Phase::Verifying]);
    assert_eq!(entries(&root), ["1.0.110"], "no staging folder is left");
    assert_eq!(entries(&root.join("1.0.110")), [RECEIPT, "README.md", "copilot"]);
    assert_eq!(fs::metadata(root.join("1.0.110/copilot")).unwrap().permissions().mode() & 0o777, 0o755);
    let installed = resolve_installed(&root, Some(&pin));
    assert_eq!(installed.release, Some(Installed { folder: root.join("1.0.110"), version: "1.0.110".into(), current: true }));

    // Installing the same release again downloads nothing: the receipt proves it, the start check repeats.
    let asked = http.asked().len();
    let (again, phases) = run(&root, &http, &pin, &COPILOT, &AtomicBool::new(false));
    again.unwrap();
    assert_eq!((http.asked().len(), phases), (asked, vec![Phase::Verifying]));

    // A damaged copy (its command gone) is replaced by a fresh download.
    fs::remove_file(root.join("1.0.110/copilot")).unwrap();
    assert_eq!(resolve_installed(&root, Some(&pin)), Releases { release: None, broken: vec!["1.0.110".into()], unreadable: false });
    let (repair, _) = run(&root, &http, &pin, &COPILOT, &AtomicBool::new(false));
    repair.unwrap();
    assert!(resolve_installed(&root, Some(&pin)).release.unwrap().current);
    assert_eq!(entries(&root), ["1.0.110"]);
  }

  #[test]
  fn a_checksum_mismatch_installs_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("copilot");
    let body = copilot_archive("1.0.110");
    let mut pin = pin_for("1.0.110", &body, Format::TarGz, &["copilot"]);
    // The publisher's digest names other bytes than the ones served.
    let tampered = copilot_archive("6.6.6");
    let http = Fake::with(&[(URL, 200, &tampered)]);
    pin.bytes = tampered.len() as u64;
    let ran = std::cell::Cell::new(false);
    let validate = |_: &Path, _: &Pin| {
      ran.set(true);
      Ok(())
    };
    let mut phases = Vec::new();
    let mut progress = |phase: Phase, _: u64| phases.push(phase);
    let mut install = Install { label: "Tool", source: &COPILOT, target: MAC, root: &root, pin: &pin, http: &http, cancel: &AtomicBool::new(false), validate: &validate, free_bytes: &|_| None, progress: &mut progress };
    let err = install_release(&mut install).unwrap_err();
    assert!(matches!(&err, InstallError::Failed(text) if text.contains("checksum")), "{err:?}");
    assert!(!ran.get(), "nothing of a mismatched download is run");
    assert!(!phases.contains(&Phase::Extracting), "nothing of a mismatched download is unpacked");
    assert_eq!(entries(&root), Vec::<String>::new(), "nothing is left behind");
    assert_eq!(resolve_installed(&root, Some(&pin)), Releases::default());
    // sha512 pins are held to the same rule.
    pin.digest = Digest::Sha512(sha512_hex(&body));
    let (result, _) = run(&root, &http, &pin, &COPILOT, &AtomicBool::new(false));
    assert!(matches!(result, Err(InstallError::Failed(t)) if t.contains("checksum")));
    pin.digest = Digest::Sha512(sha512_hex(&tampered));
    pin.version = "6.6.6".into();
    run(&root, &http, &pin, &COPILOT, &AtomicBool::new(false)).0.unwrap();
  }

  #[test]
  fn a_failed_install_leaves_the_folder_as_it_was() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("copilot");
    let old = copilot_archive("1.0.100");
    let old_pin = pin_for("1.0.100", &old, Format::TarGz, &["copilot"]);
    run(&root, &Fake::with(&[(URL, 200, &old)]), &old_pin, &COPILOT, &AtomicBool::new(false)).0.unwrap();
    let before = entries(&root.join("1.0.100"));
    let failing: Vec<(&str, Vec<u8>, Format, &[&str])> = vec![
      // An entry climbing out of the release, a link pointing out of it.
      ("traversal", gz(&tar_of(&[tar_entry("copilot", b'0', 0o755, "", &script("2.0.0")), tar_entry("../../evil", b'0', 0o755, "", b"x")])), Format::TarGz, &["copilot"]),
      ("link", gz(&tar_of(&[tar_entry("copilot", b'2', 0o777, "/bin/sh", b"")])), Format::TarGz, &["copilot"]),
      // The command is missing, or a link to something else in the release.
      ("missing", gz(&tar_of(&[tar_entry("other", b'0', 0o755, "", &script("2.0.0"))])), Format::TarGz, &["copilot"]),
      ("linked", gz(&tar_of(&[tar_entry("real", b'0', 0o755, "", &script("2.0.0")), tar_entry("copilot", b'2', 0o777, "real", b"")])), Format::TarGz, &["copilot"]),
      // It starts but is another release; it does not start at all.
      ("version", copilot_archive("9.9.9"), Format::TarGz, &["copilot"]),
      ("exit", gz(&tar_of(&[tar_entry("copilot", b'0', 0o755, "", b"#!/bin/sh\nexit 3\n")])), Format::TarGz, &["copilot"]),
      ("not-gzip", b"plain text".to_vec(), Format::TarGz, &["copilot"]),
      ("not-zip", b"plain text".to_vec(), Format::Zip, &["copilot"]),
    ];
    for (what, body, format, executables) in failing {
      let pin = pin_for("2.0.0", &body, format, executables);
      let (result, _) = run(&root, &Fake::with(&[(URL, 200, &body)]), &pin, &COPILOT, &AtomicBool::new(false));
      assert!(matches!(result, Err(InstallError::Failed(_))), "{what}: {result:?}");
      assert_eq!(entries(&root), ["1.0.100"], "{what}: nothing new, no staging folder");
      assert_eq!(entries(&root.join("1.0.100")), before, "{what}");
      assert_eq!(entries(dir.path()), ["copilot"], "{what}: nothing beside the install folder");
      assert_eq!(resolve_installed(&root, Some(&pin)).release.unwrap().version, "1.0.100", "{what}: the earlier release still runs");
    }
    // Unreachable, gone, or a pin that names no https URL / no plain folder name.
    let pin = pin_for("2.0.0", &old, Format::TarGz, &["copilot"]);
    assert!(run(&root, &Fake::with(&[(URL, 404, b"")]), &pin, &COPILOT, &AtomicBool::new(false)).0.is_err());
    for bad in [Pin { url: "http://example.test/dl/tool.tar.gz".into(), ..pin.clone() }, Pin { version: "../2.0.0".into(), ..pin.clone() }, Pin { version: ".hidden".into(), ..pin.clone() }, Pin { executables: vec!["../copilot".into()], ..pin.clone() }, Pin { executables: vec![], ..pin.clone() }] {
      let http = Fake::with(&[(URL, 200, &old), ("http://example.test/dl/tool.tar.gz", 200, &old)]);
      assert!(run(&root, &http, &bad, &COPILOT, &AtomicBool::new(false)).0.is_err(), "{bad:?}");
      assert!(http.asked().is_empty(), "{bad:?}: refused before any request");
    }
    // Too little disk space, and a cancel: both before anything is written.
    let mut none = |_: Phase, _: u64| {};
    let ok = |_: &Path, _: &Pin| Ok(());
    let http = Fake::with(&[(URL, 200, &old)]);
    let mut tight = Install { label: "Tool", source: &COPILOT, target: MAC, root: &root, pin: &pin, http: &http, cancel: &AtomicBool::new(false), validate: &ok, free_bytes: &|_| Some(1024), progress: &mut none };
    assert!(matches!(install_release(&mut tight), Err(InstallError::Failed(t)) if t.contains("MB")));
    assert_eq!(run(&root, &http, &pin, &COPILOT, &AtomicBool::new(true)).0, Err(InstallError::Cancelled));
    assert_eq!(entries(&root), ["1.0.100"]);
  }

  #[test]
  fn the_acp_servers_executables_must_be_the_pinned_bytes() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("agy_acp_server.par"), b"server").unwrap();
    fs::write(dir.path().join("localharness_external"), b"harness").unwrap();
    let (server, harness) = (sha256_hex(b"server"), sha256_hex(b"harness"));
    assert_eq!(verify_members(dir.path(), &[("agy_acp_server.par", &server, 6), ("localharness_external", &harness, 7)]), Ok(()));
    // Another size, another digest, a missing member, a path out of the release.
    assert!(verify_members(dir.path(), &[("agy_acp_server.par", &server, 7)]).unwrap_err().contains("bytes"));
    assert!(verify_members(dir.path(), &[("localharness_external", &server, 7)]).unwrap_err().contains("checksum"));
    assert!(verify_members(dir.path(), &[("gone", &server, 6)]).unwrap_err().contains("missing"));
    assert!(verify_members(dir.path(), &[("../agy_acp_server.par", &server, 6)]).is_err());
    // The real pin refuses anything but Google's build, so a stand-in is never installed.
    let body = zip_of(|z| {
      z.start_file("agy_acp_server.par", zip::write::SimpleFileOptions::default().unix_permissions(0o755)).unwrap();
      std::io::Write::write_all(z, b"#!/bin/sh\n").unwrap();
      z.start_file("localharness_external", zip::write::SimpleFileOptions::default()).unwrap();
      std::io::Write::write_all(z, b"x").unwrap();
    });
    let root = dir.path().join("antigravity");
    let pin = pin_for("1.5.2", &body, Format::Zip, &["agy_acp_server.par", "localharness_external"]);
    let ok = |_: &Path, _: &Pin| Ok(());
    let mut none = |_: Phase, _: u64| {};
    let http = Fake::with(&[(URL, 200, &body)]);
    let mut install = Install { label: "Antigravity", source: &Source::AgyAcpServer, target: MAC, root: &root, pin: &pin, http: &http, cancel: &AtomicBool::new(false), validate: &ok, free_bytes: &|_| None, progress: &mut none };
    assert!(matches!(install_release(&mut install), Err(InstallError::Failed(t)) if t.contains("Antigravity")));
    assert!(entries(&root).is_empty(), "nothing is published");
  }

  #[test]
  fn each_kind_of_release_lands_where_launches_look() {
    let dir = tempfile::tempdir().unwrap();
    // OMP, Kimi: the download is the executable; OMP also gets its manager file.
    let body = script("17.2.0");
    let root = dir.path().join("omp");
    run(&root, &Fake::with(&[(URL, 200, &body)]), &pin_for("17.2.0", &body, Format::File, &["bin/omp"]), &Source::Omp, &AtomicBool::new(false)).0.unwrap();
    assert_eq!(fs::read(root.join("17.2.0/bin/omp")).unwrap(), body);
    assert_eq!(fs::metadata(root.join("17.2.0/bin/omp")).unwrap().permissions().mode() & 0o777, 0o755);
    assert_eq!(fs::read_to_string(root.join("17.2.0/manager.json")).unwrap(), r#"{"name":"Kingu"}"#);

    // Grok: npm's tarball holds the binary brotli-compressed under package/.
    let mut br = Vec::new();
    brotli::CompressorWriter::new(&mut br, 4096, 5, 20).write_all(&script("0.9.4")).unwrap();
    let body = gz(&tar_of(&[tar_entry("package/package.json", b'0', 0o644, "", b"{}"), tar_entry("package/bin/grok.br", b'0', 0o644, "", &br)]));
    let root = dir.path().join("grok");
    run(&root, &Fake::with(&[(URL, 200, &body)]), &pin_for("0.9.4", &body, Format::TarGz, &["bin/grok"]), &Source::Grok, &AtomicBool::new(false)).0.unwrap();
    assert_eq!(fs::read(root.join("0.9.4/bin/grok")).unwrap(), script("0.9.4"));
    assert_eq!(entries(&root.join("0.9.4")), [RECEIPT, "bin"], "the npm package folder is gone");
    let bare = gz(&tar_of(&[tar_entry("package/package.json", b'0', 0o644, "", b"{}")]));
    assert!(run(&root, &Fake::with(&[(URL, 200, &bare)]), &pin_for("0.9.5", &bare, Format::TarGz, &["bin/grok"]), &Source::Grok, &AtomicBool::new(false)).0.is_err());

    // agy: the archive names its binary `antigravity`.
    let body = gz(&tar_of(&[tar_entry("antigravity", b'0', 0o755, "", &script("1.6.0"))]));
    let root = dir.path().join("agy");
    run(&root, &Fake::with(&[(URL, 200, &body)]), &pin_for("1.6.0", &body, Format::TarGz, &["agy"]), &Source::Agy, &AtomicBool::new(false)).0.unwrap();
    assert_eq!(entries(&root.join("1.6.0")), [RECEIPT, "agy"]);

    // OpenCode 2: a zip, the command also under the name its own installer gives it; Cursor
    // answers its build (`2026.11.19-f005e9d`) for the listed `2026.11.19`.
    let oc2 = Source::Registry { registry_id: "opencode-v2", command: "opencode", windows_command: "opencode.exe", alias: Some("opencode2") };
    let body = zip_of(|z| {
      z.start_file("opencode", zip::write::SimpleFileOptions::default().unix_permissions(0o755)).unwrap();
      z.write_all(&script("2.3.2")).unwrap();
    });
    let root = dir.path().join("opencode2");
    run(&root, &Fake::with(&[(URL, 200, &body)]), &pin_for("2.3.2", &body, Format::Zip, &["opencode"]), &oc2, &AtomicBool::new(false)).0.unwrap();
    assert_eq!(fs::read(root.join("2.3.2/opencode2")).unwrap(), script("2.3.2"));
    let cursor = Source::Registry { registry_id: "cursor", command: "dist-package/cursor-agent", windows_command: "dist-package/cursor-agent.cmd", alias: None };
    let body = gz(&tar_of(&[tar_entry("./dist-package/", b'5', 0o755, "", b""), tar_entry("./dist-package/cursor-agent", b'0', 0o755, "", &script("2026.11.19-f005e9d"))]));
    let root = dir.path().join("cursor");
    run(&root, &Fake::with(&[(URL, 200, &body)]), &pin_for("2026.11.19", &body, Format::TarGz, &["dist-package/cursor-agent"]), &cursor, &AtomicBool::new(false)).0.unwrap();
    assert!(root.join("2026.11.19/dist-package/cursor-agent").is_file());
    let program = root.join("2026.11.19/dist-package/cursor-agent");
    assert_eq!(answers_version(&program, "2026.11.19", false, &[]), Err(StartFailure::Version("2026.11.19-f005e9d".into())));
    assert_eq!(answers_version(&program, "2026.11.1", true, &[]), Err(StartFailure::Version("2026.11.19-f005e9d".into())));
  }

  #[test]
  fn the_looked_up_release_wins_then_the_newest_whole_one() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("copilot");
    assert_eq!(resolve_installed(&root, None), Releases::default(), "a missing folder is simply empty");
    assert!(!may_be_published(&root));
    let mut pins = Vec::new();
    for v in ["1.0.9", "1.0.10", "1.0.100"] {
      let body = copilot_archive(v);
      let pin = pin_for(v, &body, Format::TarGz, &["copilot"]);
      run(&root, &Fake::with(&[(URL, 200, &body)]), &pin, &COPILOT, &AtomicBool::new(false)).0.unwrap();
      pins.push(pin);
    }
    assert!(may_be_published(&root));
    // No lookup yet (or it failed): the newest whole release, by version rather than by name.
    let newest = resolve_installed(&root, None).release.unwrap();
    assert_eq!((newest.version.as_str(), newest.current), ("1.0.100", false));
    // The looked-up release wins even when older ones sort above it.
    let pinned = resolve_installed(&root, Some(&pins[1])).release.unwrap();
    assert_eq!((pinned.version.as_str(), pinned.current), ("1.0.10", true));
    // A republished build under the same version is not the looked-up release.
    let republished = Pin { digest: Digest::Sha256(sha256_hex(b"other bytes")), ..pins[2].clone() };
    assert!(!resolve_installed(&root, Some(&republished)).release.unwrap().current);
    // A newer release not installed yet: the newest installed one runs, not current.
    let next = pin_for("1.1.0", b"x", Format::TarGz, &["copilot"]);
    let behind = resolve_installed(&root, Some(&next)).release.unwrap();
    assert_eq!((behind.version.as_str(), behind.current), ("1.0.100", false));

    // What never counts: staging folders, a folder without a receipt, a receipt for another
    // version / platform, a member that is a link, shrank, or lost its executable bit.
    fs::create_dir_all(root.join(".download-1-2/release")).unwrap();
    fs::create_dir_all(root.join("9.0.0")).unwrap();
    fs::write(root.join("9.0.0/copilot"), script("9.0.0")).unwrap();
    let receipt = |version: &str, platform: &str, bytes: usize| serde_json::json!({ "releaseId": "a".repeat(64), "version": version, "platform": platform, "arch": std::env::consts::ARCH, "members": [{ "path": "copilot", "bytes": bytes }] }).to_string();
    let size = script("9.0.0").len();
    let cases: Vec<(&str, Box<dyn Fn(&Path)>)> = vec![
      ("no receipt", Box::new(|_| {})),
      ("another version", Box::new(move |f| fs::write(f.join(RECEIPT), receipt("8.0.0", std::env::consts::OS, size)).unwrap())),
      ("another platform", Box::new(move |f| fs::write(f.join(RECEIPT), receipt("9.0.0", "plan9", size)).unwrap())),
      ("not executable", Box::new(move |f| fs::write(f.join(RECEIPT), receipt("9.0.0", std::env::consts::OS, size)).unwrap())),
      ("another size", Box::new(move |f| {
        fs::set_permissions(f.join("copilot"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(f.join(RECEIPT), receipt("9.0.0", std::env::consts::OS, size + 1)).unwrap();
      })),
      ("a link", Box::new(move |f| {
        fs::rename(f.join("copilot"), f.join("real")).unwrap();
        std::os::unix::fs::symlink("real", f.join("copilot")).unwrap();
        fs::write(f.join(RECEIPT), receipt("9.0.0", std::env::consts::OS, size)).unwrap();
      })),
      ("junk receipt", Box::new(|f| fs::write(f.join(RECEIPT), "{").unwrap())),
      ("a climbing member", Box::new(move |f| fs::write(f.join(RECEIPT), receipt("9.0.0", std::env::consts::OS, size).replace("\"copilot\"", "\"../1.0.100/copilot\"")).unwrap())),
    ];
    for (what, damage) in cases {
      damage(&root.join("9.0.0"));
      let found = resolve_installed(&root, None);
      assert_eq!(found.release.as_ref().unwrap().version, "1.0.100", "{what}");
      assert_eq!(found.broken, ["9.0.0"], "{what}");
    }
    // A link named like a release is not one.
    std::os::unix::fs::symlink(root.join("1.0.100"), root.join("99.0.0")).unwrap();
    assert_eq!(resolve_installed(&root, None).release.unwrap().version, "1.0.100");

    // Reclaim keeps the release launches resolve to and the one running chats may still use.
    reclaim(&root, &["1.0.100", "1.0.10"]);
    assert_eq!(entries(&root), ["1.0.10", "1.0.100"]);
    assert!(version_is_a_folder_name("2026.11.19") && !version_is_a_folder_name("..") && !version_is_a_folder_name("a/b") && !version_is_a_folder_name(""));
  }

  /// By hand, against the publishers (never in CI): `KINGU_LIVE_INSTALL_DIR=<empty dir>
  /// KINGU_LIVE_INSTALL_AGENTS=cursor,opencode cargo test -p kingu-desktop --lib live_layout -- --ignored --nocapture`.
  /// Looks each agent up, downloads and verifies its build through `fetch`, unpacks and prepares it
  /// into the folder, and checks the command lands where launches look. The start check is
  /// replaced by a stub: nothing downloaded is ever run.
  #[test]
  #[ignore = "downloads real releases"]
  fn live_layout() {
    let (Ok(dir), Ok(agents)) = (std::env::var("KINGU_LIVE_INSTALL_DIR"), std::env::var("KINGU_LIVE_INSTALL_AGENTS")) else { return };
    let target = Target::here();
    for id in agents.split(',') {
      let m = super::super::managed(id).unwrap_or_else(|| panic!("no managed agent {id}"));
      let pin = super::super::pin::lookup(&super::super::fetch::Reqwest, m.id, &m.source, &target).unwrap().unwrap_or_else(|| panic!("{id}: no build for this host"));
      println!("{id}: {} {} {:?} {} bytes, {:?}", pin.version, pin.url, pin.format, pin.bytes, pin.digest);
      let root = Path::new(&dir).join(m.folder);
      let not_run = |_: &Path, _: &Pin| Ok(());
      let mut shown = 0;
      let mut progress = |phase: Phase, bytes: u64| {
        if bytes >= shown + 50_000_000 || !matches!(phase, Phase::Downloading) {
          shown = bytes;
          println!("{id}: {phase:?} {bytes}");
        }
      };
      let mut input = Install { label: m.label, source: &m.source, target, root: &root, pin: &pin, http: &super::super::fetch::Reqwest, cancel: &AtomicBool::new(false), validate: &not_run, free_bytes: &real_free_bytes, progress: &mut progress };
      install_release(&mut input).unwrap_or_else(|e| panic!("{id}: {e:?}"));
      let folder = root.join(&pin.version);
      let command = member_path(&folder, &m.source.command(&target)).unwrap();
      let meta = fs::symlink_metadata(&command).unwrap();
      assert!(is_executable_file(&meta) && meta.len() > 0, "{id}: {} is not an executable file", command.display());
      let found = resolve_installed(&root, Some(&pin));
      assert!(found.release.as_ref().is_some_and(|r| r.current), "{id}: the receipt does not name this download");
      let mut top: Vec<String> = fs::read_dir(&folder).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
      top.sort();
      println!("{id}: {} ({} bytes) ready; release folder holds {top:?}", command.display(), meta.len());
    }
  }
}
