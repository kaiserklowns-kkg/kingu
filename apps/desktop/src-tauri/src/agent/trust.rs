//! Pre-trusting a task worktree for the agent CLI about to start in it (Orca's agent trust
//! presets, `agentWorkspaceTrustEnabled`, Kingu's `kingu.agent.trustWorkspace`). Without it a new
//! worktree opens with the CLI's "do you trust this folder?" prompt, and the prompt Kingu passed
//! (argv or paste) is lost behind it. Before each CLI launch in a task worktree Kingu records the
//! worktree as trusted in that CLI's own config, exactly where the CLI looks:
//!
//! - claude: `projects[<path>].hasTrustDialogAccepted = true` in `$CLAUDE_CONFIG_DIR/.claude.json`
//!   (or `~/.claude.json`; a legacy `<config dir>/.config.json` wins when present). Only an
//!   existing file is edited, under Claude's own lock (`<file>.lock`, a directory, as
//!   proper-lockfile makes it); a held lock is never broken, the launch just stays untrusted.
//! - codex: `[projects."<path>"] trust_level = "trusted"` in `$CODEX_HOME/config.toml` (default
//!   `~/.codex`), edited as text so comments and layout stay as the user wrote them.
//! - cursor-agent: `~/.cursor/projects/<path slug>/.workspace-trusted`.
//! - copilot: the path appended to `trustedFolders` in `~/.copilot/config.json` (0600).
//!
//! Safety: only `<repo>/.kingu/worktrees/<slug>` (resolved here, never a path from the page) and
//! never a filesystem root, a home folder or an ancestor of one; an already-trusted path changes
//! nothing; a file that does not parse is left alone; other keys are kept; the previous file is
//! copied to `<file>.kingu.bak` before it is replaced; writes go to a temp file with the original
//! mode and are renamed over the original (a symlinked config is written through to its target);
//! one Kingu write at a time. Every failure is only logged: the CLI then asks as it would anyway.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{Map, Value};

use crate::i18n::msg::TasksMsg;
use crate::tr;

/// One trust write at a time within Kingu (several tasks can start at once).
pub(crate) static WRITING: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Preset {
  Claude,
  Codex,
  Cursor,
  Copilot,
}

impl Preset {
  /// The preset of an agent CLI by its program name (`/usr/local/bin/claude` → claude).
  pub fn of_program(program: &str) -> Option<Self> {
    match program.rsplit('/').next().unwrap_or(program) {
      "claude" => Some(Self::Claude),
      "codex" => Some(Self::Codex),
      "cursor-agent" => Some(Self::Cursor),
      "copilot" => Some(Self::Copilot),
      _ => None,
    }
  }

  /// Whether trusting a folder also trusts everything under it (so a home must never be trusted).
  fn inherits(self) -> bool {
    matches!(self, Self::Claude | Self::Copilot)
  }
}

/// What a trust write did.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
  Trusted,
  Unchanged,
  /// claude: no config file yet (a CLI that never ran asks anyway, and creates it itself).
  MissingConfig,
  /// The config does not parse (or has an unexpected shape): left alone.
  Unreadable,
  /// Claude holds its config lock.
  Locked,
  /// A root, a home or an ancestor of a home.
  TooBroad,
}

/// Where the CLI's per-user config lives for this launch.
#[derive(Debug, Clone)]
pub struct Homes {
  pub home: PathBuf,
  /// `CLAUDE_CONFIG_DIR` of the launch (the active account's, else Kingu's own env).
  pub claude_config_dir: Option<PathBuf>,
  /// `CODEX_HOME` of the launch.
  pub codex_home: Option<PathBuf>,
}

pub(crate) fn real(p: &Path) -> PathBuf {
  fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// A filesystem root, a home folder, or an ancestor of one (compared both literally and resolved).
pub fn too_broad(path: &Path, homes: &[&Path]) -> bool {
  if homes.is_empty() {
    return true;
  }
  let forms = [path.to_path_buf(), real(path)];
  forms.iter().any(|p| {
    p.parent().is_none()
      || homes.iter().any(|h| {
        let hs = [h.to_path_buf(), real(h)];
        hs.iter().any(|h| h == p || h.starts_with(p))
      })
  })
}

/// Copies the current file to `<file>.kingu.bak` and replaces it with `content`, atomically, with
/// the original's mode. `file` must already be the real (non-symlink) target.
pub(crate) fn replace_file(file: &Path, content: &[u8], new_mode: Option<u32>) -> Result<(), String> {
  let dir = file.parent().ok_or("config has no folder")?;
  fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  let name = file.file_name().and_then(|n| n.to_str()).ok_or("bad config name")?;
  let existing = fs::metadata(file).ok();
  #[cfg(unix)]
  let mode = {
    use std::os::unix::fs::PermissionsExt;
    existing.as_ref().map(|m| m.permissions().mode() & 0o777).or(new_mode)
  };
  #[cfg(not(unix))]
  let mode: Option<u32> = new_mode;
  if existing.is_some() {
    let bak = dir.join(format!("{name}.kingu.bak"));
    if fs::symlink_metadata(&bak).is_ok_and(|m| m.file_type().is_symlink()) {
      return Err(tr!(TasksMsg::BackupIsSymlink, path = bak.display()));
    }
    let tmp = dir.join(format!("{name}.kingu.bak.{}.tmp", std::process::id()));
    fs::copy(file, &tmp).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &bak).map_err(|e| {
      let _ = fs::remove_file(&tmp);
      e.to_string()
    })?;
  }
  let tmp = dir.join(format!(".{name}.kingu-trust-{}-{}.tmp", std::process::id(), nanos()));
  let write = || -> std::io::Result<()> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
      use std::os::unix::fs::OpenOptionsExt;
      opts.mode(mode.unwrap_or(0o644));
    }
    let mut f = opts.open(&tmp)?;
    #[cfg(unix)]
    if let Some(m) = mode {
      use std::os::unix::fs::PermissionsExt;
      // Past the umask: the replacement keeps exactly the original's mode.
      f.set_permissions(fs::Permissions::from_mode(m))?;
    }
    f.write_all(content)?;
    f.sync_all()?;
    fs::rename(&tmp, file)
  };
  write().map_err(|e| {
    let _ = fs::remove_file(&tmp);
    e.to_string()
  })
}

fn nanos() -> u128 {
  std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}

/// The file a write goes to: a symlinked config is written through to its target.
pub(crate) fn write_target(file: &Path) -> Result<PathBuf, String> {
  match fs::symlink_metadata(file) {
    Ok(m) if m.file_type().is_symlink() => fs::canonicalize(file).map_err(|e| e.to_string()),
    _ => Ok(file.to_path_buf()),
  }
}

// ---- claude ----------------------------------------------------------------------------------

/// Claude's global config: `<dir>/.config.json` (legacy) when it exists, else `.claude.json` in
/// `CLAUDE_CONFIG_DIR` or the home folder.
pub fn claude_config_file(h: &Homes) -> PathBuf {
  let dir = h.claude_config_dir.clone().unwrap_or_else(|| h.home.join(".claude"));
  let legacy = dir.join(".config.json");
  if legacy.is_file() {
    return legacy;
  }
  h.claude_config_dir.clone().unwrap_or_else(|| h.home.clone()).join(".claude.json")
}

/// Claude keys a project by its path: both the path as given and its resolved form.
fn claude_keys(path: &Path) -> Vec<String> {
  let mut keys: Vec<String> = Vec::new();
  for p in [path.to_path_buf(), real(path)] {
    if let Some(s) = p.to_str()
      && !keys.iter().any(|k| k == s)
    {
      keys.push(s.to_owned());
    }
  }
  keys
}

/// The config with every key trusted, or None when it already is.
pub fn plan_claude(config: &mut Map<String, Value>, keys: &[String]) -> Result<bool, Outcome> {
  let projects = config.entry("projects").or_insert_with(|| Value::Object(Map::new()));
  let Some(projects) = projects.as_object_mut() else { return Err(Outcome::Unreadable) };
  if keys.iter().any(|k| projects.get(k).and_then(|p| p.get("hasTrustDialogAccepted")) == Some(&Value::Bool(true))) {
    return Ok(false);
  }
  for k in keys {
    match projects.get_mut(k).and_then(Value::as_object_mut) {
      Some(entry) => {
        entry.insert("hasTrustDialogAccepted".into(), Value::Bool(true));
      }
      None => {
        projects.insert(k.clone(), serde_json::json!({ "hasTrustDialogAccepted": true }));
      }
    }
  }
  Ok(true)
}

pub(crate) fn read_json_object(file: &Path) -> Result<Option<Map<String, Value>>, Outcome> {
  let text = match fs::read_to_string(file) {
    Ok(t) => t,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(_) => return Err(Outcome::Unreadable),
  };
  match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
    Ok(Value::Object(m)) => Ok(Some(m)),
    _ => Err(Outcome::Unreadable),
  }
}

/// Claude's own lock on its config (proper-lockfile: an atomic `mkdir <file>.lock`).
struct LockDir(PathBuf);

impl LockDir {
  fn take(file: &Path) -> Option<Self> {
    let lock = PathBuf::from(format!("{}.lock", file.display()));
    let mut wait = Duration::from_millis(50);
    for attempt in 0..5 {
      match fs::create_dir(&lock) {
        Ok(()) => return Some(Self(lock)),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && attempt < 4 => {
          std::thread::sleep(wait);
          wait = (wait * 2).min(Duration::from_millis(250));
        }
        Err(_) => return None,
      }
    }
    None
  }
}

impl Drop for LockDir {
  fn drop(&mut self) {
    let _ = fs::remove_dir(&self.0);
  }
}

pub fn trust_claude(path: &Path, h: &Homes) -> Result<Outcome, String> {
  let file = claude_config_file(h);
  let keys = claude_keys(path);
  // Plan without the lock first: an already-trusted worktree never touches Claude's lock.
  let mut config = match read_json_object(&file) {
    Ok(Some(c)) => c,
    Ok(None) => return Ok(Outcome::MissingConfig),
    Err(o) => return Ok(o),
  };
  match plan_claude(&mut config, &keys) {
    Ok(false) => return Ok(Outcome::Unchanged),
    Err(o) => return Ok(o),
    Ok(true) => {}
  }
  let target = write_target(&file)?;
  let Some(_lock) = LockDir::take(&file) else { return Ok(Outcome::Locked) };
  // Claude may have written since: plan again on what is there now, under its lock.
  let mut config = match read_json_object(&target) {
    Ok(Some(c)) => c,
    Ok(None) => return Ok(Outcome::MissingConfig),
    Err(o) => return Ok(o),
  };
  match plan_claude(&mut config, &keys) {
    Ok(false) => return Ok(Outcome::Unchanged),
    Err(o) => return Ok(o),
    Ok(true) => {}
  }
  let text = serde_json::to_string_pretty(&Value::Object(config)).map_err(|e| e.to_string())? + "\n";
  replace_file(&target, text.as_bytes(), None)?;
  Ok(Outcome::Trusted)
}

// ---- codex -----------------------------------------------------------------------------------

pub fn codex_config_file(h: &Homes) -> PathBuf {
  h.codex_home.clone().unwrap_or_else(|| h.home.join(".codex")).join("config.toml")
}

/// The keys of a TOML table header line (`[projects."/a"]` → `["projects", "/a"]`), any spelling.
pub(crate) fn header_keys(line: &str) -> Option<Vec<String>> {
  let t = line.trim();
  if !t.starts_with('[') || t.starts_with("[[") {
    return None;
  }
  let table: toml::Table = toml::from_str(t).ok()?;
  let mut keys = Vec::new();
  let mut cur = &table;
  loop {
    let mut it = cur.iter();
    let (k, v) = it.next()?;
    if it.next().is_some() {
      return None;
    }
    keys.push(k.clone());
    match v.as_table() {
      Some(next) if !next.is_empty() => cur = next,
      Some(_) => return Some(keys),
      None => return None,
    }
  }
}

/// `trust_level = "<value>"` on a line (any key spelling): its value.
fn trust_level_of(line: &str) -> Option<String> {
  let table: toml::Table = toml::from_str(line.trim()).ok()?;
  if table.len() != 1 {
    return None;
  }
  table.get("trust_level").map(|v| v.as_str().unwrap_or_default().to_owned())
}

/// Lines that start inside a multi-line string are never headers or keys.
pub(crate) fn line_starts(text: &str) -> Vec<(usize, bool)> {
  let mut out = Vec::new();
  let mut open: Option<&str> = None;
  let mut pos = 0;
  for line in text.split_inclusive('\n') {
    out.push((pos, open.is_some()));
    for delim in ["\"\"\"", "'''"] {
      let n = line.matches(delim).count();
      if n % 2 == 1 {
        open = match open {
          Some(d) if d == delim => None,
          None => Some(delim),
          other => other,
        };
      }
    }
    pos += line.len();
  }
  out
}

/// `text` with `path` trusted, or None when it already is. Edits as text: everything else stays.
pub fn plan_codex(text: &str, path: &str) -> Option<String> {
  let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
  let lines: Vec<&str> = text.split_inclusive('\n').collect();
  let starts = line_starts(text);
  let is_ours = |i: usize| !starts[i].1 && header_keys(lines[i]).is_some_and(|k| k.len() == 2 && k[0] == "projects" && k[1] == path);
  if let Some(h) = (0..lines.len()).find(|&i| is_ours(i)) {
    let end = (h + 1..lines.len()).find(|&i| !starts[i].1 && lines[i].trim_start().starts_with('[')).unwrap_or(lines.len());
    let mut out: Vec<String> = lines.iter().map(|l| (*l).to_owned()).collect();
    match (h + 1..end).find(|&i| !starts[i].1 && trust_level_of(lines[i]).is_some()) {
      Some(i) if trust_level_of(lines[i]).as_deref() == Some("trusted") => return None,
      Some(i) => {
        let nl = if lines[i].ends_with("\r\n") { "\r\n" } else if lines[i].ends_with('\n') { "\n" } else { "" };
        out[i] = format!("trust_level = \"trusted\"{nl}");
      }
      None => {
        let header = &mut out[h];
        if !header.ends_with('\n') {
          header.push_str(eol);
        }
        header.push_str(&format!("trust_level = \"trusted\"{eol}"));
      }
    }
    return Some(out.concat());
  }
  // A blank line before the new table.
  let sep = if text.is_empty() || text.ends_with(&format!("{eol}{eol}")) {
    ""
  } else if text.ends_with('\n') {
    eol
  } else if eol == "\r\n" {
    "\r\n\r\n"
  } else {
    "\n\n"
  };
  Some(format!("{text}{sep}[projects.{}]{eol}trust_level = \"trusted\"{eol}", serde_json::to_string(path).ok()?))
}

pub fn trust_codex(path: &Path, h: &Homes) -> Result<Outcome, String> {
  let file = codex_config_file(h);
  let key = real(path);
  let key = key.to_str().ok_or("path is not UTF-8")?;
  let target = write_target(&file)?;
  let text = match fs::read_to_string(&target) {
    Ok(t) => t,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
    Err(_) => return Ok(Outcome::Unreadable),
  };
  let body = text.strip_prefix('\u{feff}').unwrap_or(&text);
  // A config codex itself would reject is not ours to touch.
  if toml::from_str::<toml::Table>(body).is_err() {
    return Ok(Outcome::Unreadable);
  }
  let Some(next) = plan_codex(body, key) else { return Ok(Outcome::Unchanged) };
  if toml::from_str::<toml::Table>(&next).is_err() {
    return Ok(Outcome::Unreadable);
  }
  replace_file(&target, next.as_bytes(), Some(0o600))?;
  Ok(Outcome::Trusted)
}

// ---- cursor / copilot ------------------------------------------------------------------------

/// cursor-agent's per-project folder name: the absolute path without its leading slash, with
/// separators and characters a file name cannot hold turned into `-`.
pub fn cursor_slug(abs: &str) -> String {
  let trimmed = abs.trim_start_matches(['/', '\\']);
  let mut out = String::new();
  let mut dash = false;
  for c in trimmed.chars() {
    if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
      if !dash {
        out.push('-');
      }
      dash = true;
    } else {
      out.push(c);
      dash = false;
    }
  }
  out
}

pub fn trust_cursor(path: &Path, h: &Homes) -> Result<Outcome, String> {
  let abs = real(path);
  let abs = abs.to_str().ok_or("path is not UTF-8")?;
  let slug = cursor_slug(abs);
  if slug.is_empty() {
    return Ok(Outcome::Unchanged);
  }
  let file = h.home.join(".cursor").join("projects").join(slug).join(".workspace-trusted");
  if fs::symlink_metadata(&file).is_ok() {
    return Ok(Outcome::Unchanged);
  }
  let at = time_iso();
  let text = serde_json::to_string_pretty(&serde_json::json!({ "trustedAt": at, "workspacePath": abs })).map_err(|e| e.to_string())? + "\n";
  replace_file(&file, text.as_bytes(), None)?;
  Ok(Outcome::Trusted)
}

/// Now as ISO 8601 UTC (`2026-10-18T09:30:00.000Z`).
fn time_iso() -> String {
  let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
  let (days, rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
  // Civil from days (Howard Hinnant's algorithm).
  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z - era * 146_097;
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = doy - (153 * mp + 2) / 5 + 1;
  let m = if mp < 10 { mp + 3 } else { mp - 9 };
  let y = yoe + era * 400 + i64::from(m <= 2);
  format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000)
}

pub fn trust_copilot(path: &Path, h: &Homes) -> Result<Outcome, String> {
  let file = h.home.join(".copilot").join("config.json");
  let abs = real(path);
  let abs_s = abs.to_str().ok_or("path is not UTF-8")?;
  let target = write_target(&file)?;
  let mut config = match read_json_object(&target) {
    Ok(Some(c)) => c,
    Ok(None) => Map::new(),
    Err(o) => return Ok(o),
  };
  let existing: Vec<Value> = match config.get("trustedFolders") {
    Some(Value::Array(a)) => a.clone(),
    Some(_) => return Ok(Outcome::Unreadable),
    None => Vec::new(),
  };
  if existing.iter().filter_map(Value::as_str).any(|s| real(Path::new(s)) == abs) {
    return Ok(Outcome::Unchanged);
  }
  let mut folders = existing;
  folders.push(Value::String(abs_s.to_owned()));
  config.insert("trustedFolders".into(), Value::Array(folders));
  let text = serde_json::to_string_pretty(&Value::Object(config)).map_err(|e| e.to_string())? + "\n";
  replace_file(&target, text.as_bytes(), Some(0o600))?;
  Ok(Outcome::Trusted)
}

/// Trusts `worktree` for `preset`'s CLI (the caller resolved it from the open repo and a slug).
pub fn trust(preset: Preset, worktree: &Path, h: &Homes) -> Result<Outcome, String> {
  if !worktree.is_absolute() || !worktree.is_dir() {
    return Err(tr!(TasksMsg::NotWorktreeFolder, path = worktree.display()));
  }
  // Trust in claude and copilot covers subfolders: never a home or its ancestors (Orca's guard).
  if worktree.parent().is_none() || (preset.inherits() && too_broad(worktree, &[h.home.as_path()])) {
    return Ok(Outcome::TooBroad);
  }
  let _one = WRITING.lock().unwrap_or_else(|e| e.into_inner());
  match preset {
    Preset::Claude => trust_claude(worktree, h),
    Preset::Codex => trust_codex(worktree, h),
    Preset::Cursor => trust_cursor(worktree, h),
    Preset::Copilot => trust_copilot(worktree, h),
  }
}

/// The config homes a CLI started now gets: the active account's (`CLAUDE_CONFIG_DIR` /
/// `CODEX_HOME`, as pty_spawn hands them over), else Kingu's own env, else the defaults.
pub fn launch_homes(app: &tauri::AppHandle, program: &str) -> Result<Homes, String> {
  use tauri::Manager;
  let account = crate::accounts::env_for_program(&app.state::<crate::accounts::Accounts>(), program)?;
  let own = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from).filter(|p| p.is_absolute());
  let from = |k: &str| account.get(k).map(PathBuf::from).filter(|p| p.is_absolute()).or_else(|| own(k));
  let home = std::env::var_os("HOME").map(PathBuf::from).filter(|p| p.is_absolute()).ok_or("HOME is not set")?;
  Ok(Homes { home, claude_config_dir: from("CLAUDE_CONFIG_DIR"), codex_home: from("CODEX_HOME") })
}

/// Before an agent CLI starts in task `slug`'s worktree (`kingu.agent.trustWorkspace`): trusts it
/// for that CLI, in the config of the account the launch uses. Returns what happened, for the log.
#[tauri::command]
pub async fn agent_trust_workspace(app: tauri::AppHandle, slug: String, program: String) -> Result<Option<Outcome>, String> {
  use tauri::Manager;
  super::worktree::validate_slug(&slug)?;
  let Some(preset) = Preset::of_program(&program) else { return Ok(None) };
  let root = app.state::<crate::workspace::Workspace>().root()?;
  let worktree = super::worktree::worktree_path(&root, &slug);
  let homes = launch_homes(&app, &program)?;
  let outcome = tauri::async_runtime::spawn_blocking(move || trust(preset, &worktree, &homes)).await.map_err(|e| e.to_string())??;
  log::info!("agent trust {slug} ({program}): {outcome:?}");
  Ok(Some(outcome))
}

#[cfg(test)]
mod tests {
  use super::*;

  struct Env {
    _dir: tempfile::TempDir,
    root: PathBuf,
    home: PathBuf,
    wt: PathBuf,
  }

  fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let home = root.join("home");
    let wt = root.join("repo/.kingu/worktrees/fix-bug");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&wt).unwrap();
    Env { _dir: dir, root, home, wt }
  }

  fn homes(e: &Env) -> Homes {
    Homes { home: e.home.clone(), claude_config_dir: None, codex_home: None }
  }

  fn json(p: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap()
  }

  #[test]
  fn presets_by_program() {
    assert_eq!(Preset::of_program("/opt/bin/claude"), Some(Preset::Claude));
    assert_eq!(Preset::of_program("codex"), Some(Preset::Codex));
    assert_eq!(Preset::of_program("cursor-agent"), Some(Preset::Cursor));
    assert_eq!(Preset::of_program("copilot"), Some(Preset::Copilot));
    assert_eq!(Preset::of_program("gemini"), None);
  }

  #[test]
  fn claude_merges_into_the_existing_config_and_keeps_its_mode() {
    let e = env();
    let file = e.home.join(".claude.json");
    let key = e.wt.to_str().unwrap().to_owned();
    fs::write(&file, format!(r#"{{"zeta":1,"oauthAccount":{{"emailAddress":"a@b"}},"projects":{{"{key}":{{"allowedTools":["Bash"]}},"/other":{{"x":true}}}},"alpha":2}}"#)).unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert_eq!(trust(Preset::Claude, &e.wt, &homes(&e)).unwrap(), Outcome::Trusted);
    let v = json(&file);
    assert_eq!(v["projects"][&key]["hasTrustDialogAccepted"], true);
    assert_eq!(v["projects"][&key]["allowedTools"][0], "Bash");
    assert_eq!(v["projects"]["/other"]["x"], true);
    assert_eq!(v["oauthAccount"]["emailAddress"], "a@b");
    // Key order is the user's, not alphabetical.
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.find("\"zeta\"").unwrap() < text.find("\"alpha\"").unwrap());
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert!(e.home.join(".claude.json.kingu.bak").is_file(), "the previous file is kept");
    assert!(!PathBuf::from(format!("{}.lock", file.display())).exists(), "lock released");
    assert_eq!(trust(Preset::Claude, &e.wt, &homes(&e)).unwrap(), Outcome::Unchanged);
  }

  #[test]
  fn claude_follows_the_account_config_dir() {
    let e = env();
    let acct = e.root.join("accounts/claude-1");
    fs::create_dir_all(&acct).unwrap();
    fs::write(acct.join(".claude.json"), "{}").unwrap();
    fs::write(e.home.join(".claude.json"), "{}").unwrap();
    let h = Homes { claude_config_dir: Some(acct.clone()), ..homes(&e) };
    assert_eq!(trust(Preset::Claude, &e.wt, &h).unwrap(), Outcome::Trusted);
    assert_eq!(json(&acct.join(".claude.json"))["projects"][e.wt.to_str().unwrap()]["hasTrustDialogAccepted"], true);
    assert_eq!(json(&e.home.join(".claude.json")), serde_json::json!({}), "the personal config is untouched");
  }

  #[test]
  fn claude_legacy_config_wins() {
    let e = env();
    fs::create_dir_all(e.home.join(".claude")).unwrap();
    fs::write(e.home.join(".claude/.config.json"), "{}").unwrap();
    assert_eq!(claude_config_file(&homes(&e)), e.home.join(".claude/.config.json"));
  }

  #[test]
  fn claude_leaves_missing_corrupt_and_locked_configs_alone() {
    let e = env();
    let file = e.home.join(".claude.json");
    assert_eq!(trust(Preset::Claude, &e.wt, &homes(&e)).unwrap(), Outcome::MissingConfig);
    assert!(!file.exists());
    fs::write(&file, "{not json").unwrap();
    assert_eq!(trust(Preset::Claude, &e.wt, &homes(&e)).unwrap(), Outcome::Unreadable);
    assert_eq!(fs::read_to_string(&file).unwrap(), "{not json");
    fs::write(&file, r#"{"projects":[1]}"#).unwrap();
    assert_eq!(trust(Preset::Claude, &e.wt, &homes(&e)).unwrap(), Outcome::Unreadable);
    fs::write(&file, "{}").unwrap();
    let lock = PathBuf::from(format!("{}.lock", file.display()));
    fs::create_dir(&lock).unwrap();
    assert_eq!(trust(Preset::Claude, &e.wt, &homes(&e)).unwrap(), Outcome::Locked);
    assert!(lock.is_dir(), "Claude's lock is never broken");
    assert_eq!(fs::read_to_string(&file).unwrap(), "{}");
  }

  #[cfg(unix)]
  #[test]
  fn claude_writes_through_a_symlinked_config() {
    let e = env();
    let real_file = e.root.join("dotfiles/claude.json");
    fs::create_dir_all(real_file.parent().unwrap()).unwrap();
    fs::write(&real_file, "{}").unwrap();
    std::os::unix::fs::symlink(&real_file, e.home.join(".claude.json")).unwrap();
    assert_eq!(trust(Preset::Claude, &e.wt, &homes(&e)).unwrap(), Outcome::Trusted);
    assert!(fs::symlink_metadata(e.home.join(".claude.json")).unwrap().file_type().is_symlink());
    assert_eq!(json(&real_file)["projects"][e.wt.to_str().unwrap()]["hasTrustDialogAccepted"], true);
  }

  #[test]
  fn never_a_home_or_root() {
    let e = env();
    fs::write(e.home.join(".claude.json"), "{}").unwrap();
    assert_eq!(trust(Preset::Claude, &e.home, &homes(&e)).unwrap(), Outcome::TooBroad);
    assert_eq!(trust(Preset::Claude, &e.root, &homes(&e)).unwrap(), Outcome::TooBroad);
    assert!(too_broad(Path::new("/"), &[e.home.as_path()]));
    assert!(!too_broad(&e.wt, &[e.home.as_path()]));
    assert_eq!(json(&e.home.join(".claude.json")), serde_json::json!({}));
  }

  #[test]
  fn codex_appends_a_project_table_and_keeps_the_rest() {
    let path = "/r/.kingu/worktrees/a";
    let text = "# my config\nmodel = \"o3\"\n\n[projects.\"/other\"]\ntrust_level = \"trusted\"\n";
    let next = plan_codex(text, path).unwrap();
    assert_eq!(next, format!("{text}\n[projects.\"{path}\"]\ntrust_level = \"trusted\"\n"));
    assert_eq!(plan_codex(&next, path), None);
    assert_eq!(plan_codex("", path).unwrap(), format!("[projects.\"{path}\"]\ntrust_level = \"trusted\"\n"));
    assert_eq!(plan_codex("a = 1", path).unwrap(), format!("a = 1\n\n[projects.\"{path}\"]\ntrust_level = \"trusted\"\n"));
    assert!(plan_codex("a = 1\r\n", path).unwrap().ends_with("\r\n\r\n[projects.\"/r/.kingu/worktrees/a\"]\r\ntrust_level = \"trusted\"\r\n"));
  }

  #[test]
  fn codex_updates_an_existing_table_in_any_spelling() {
    let path = "/r/w";
    assert_eq!(
      plan_codex("[projects.'/r/w']\n\"trust_level\" = 'untrusted' \nx = 1\n[other]\n", path).unwrap(),
      "[projects.'/r/w']\ntrust_level = \"trusted\"\nx = 1\n[other]\n"
    );
    assert_eq!(plan_codex("[ projects . \"/r/w\" ]\nx = 1\n", path).unwrap(), "[ projects . \"/r/w\" ]\ntrust_level = \"trusted\"\nx = 1\n");
    assert_eq!(plan_codex("[projects.\"/r/w\"]\ntrust_level = \"trusted\"\n", path), None);
    // A header inside a multi-line string is text, not a table.
    let tricky = "note = \"\"\"\n[projects.\"/r/w\"]\n\"\"\"\n";
    assert!(plan_codex(tricky, path).unwrap().starts_with(tricky));
    // Paths with quotes and backslashes are escaped.
    let odd = "/r/a \"b\"\\c";
    let next = plan_codex("", odd).unwrap();
    let t: toml::Table = toml::from_str(&next).unwrap();
    assert_eq!(t["projects"][odd]["trust_level"].as_str(), Some("trusted"));
    assert_eq!(plan_codex(&next, odd), None);
  }

  #[test]
  fn codex_writes_codex_home_with_a_backup_and_skips_a_broken_file() {
    let e = env();
    let codex_home = e.root.join("accounts/codex-1");
    let h = Homes { codex_home: Some(codex_home.clone()), ..homes(&e) };
    assert_eq!(trust(Preset::Codex, &e.wt, &h).unwrap(), Outcome::Trusted);
    let file = codex_home.join("config.toml");
    let t: toml::Table = toml::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(t["projects"][e.wt.to_str().unwrap()]["trust_level"].as_str(), Some("trusted"));
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert!(!e.home.join(".codex").exists(), "only the launch's CODEX_HOME");
    assert_eq!(trust(Preset::Codex, &e.wt, &h).unwrap(), Outcome::Unchanged);
    fs::write(&file, "model = \"o3\"\n[bad\n").unwrap();
    assert_eq!(trust(Preset::Codex, &e.wt, &h).unwrap(), Outcome::Unreadable);
    assert_eq!(fs::read_to_string(&file).unwrap(), "model = \"o3\"\n[bad\n");
    fs::write(&file, "model = \"o3\"\n").unwrap();
    assert_eq!(trust(Preset::Codex, &e.wt, &h).unwrap(), Outcome::Trusted);
    assert_eq!(fs::read_to_string(codex_home.join("config.toml.kingu.bak")).unwrap(), "model = \"o3\"\n");
  }

  #[test]
  fn cursor_marker_file() {
    let e = env();
    assert_eq!(cursor_slug("/Users/a/wt"), "Users-a-wt");
    assert_eq!(cursor_slug("C:\\x\\y"), "C-x-y");
    assert_eq!(trust(Preset::Cursor, &e.wt, &homes(&e)).unwrap(), Outcome::Trusted);
    let file = e.home.join(".cursor/projects").join(cursor_slug(e.wt.to_str().unwrap())).join(".workspace-trusted");
    let v = json(&file);
    assert_eq!(v["workspacePath"], e.wt.to_str().unwrap());
    assert!(v["trustedAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(trust(Preset::Cursor, &e.wt, &homes(&e)).unwrap(), Outcome::Unchanged);
  }

  #[test]
  fn copilot_trusted_folders() {
    let e = env();
    let file = e.home.join(".copilot/config.json");
    assert_eq!(trust(Preset::Copilot, &e.wt, &homes(&e)).unwrap(), Outcome::Trusted);
    assert_eq!(json(&file)["trustedFolders"], serde_json::json!([e.wt.to_str().unwrap()]));
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert_eq!(trust(Preset::Copilot, &e.wt, &homes(&e)).unwrap(), Outcome::Unchanged);
    fs::write(&file, r#"{"model":"x","trustedFolders":["/a"]}"#).unwrap();
    assert_eq!(trust(Preset::Copilot, &e.wt, &homes(&e)).unwrap(), Outcome::Trusted);
    let v = json(&file);
    assert_eq!(v["model"], "x");
    assert_eq!(v["trustedFolders"], serde_json::json!(["/a", e.wt.to_str().unwrap()]));
    fs::write(&file, r#"{"trustedFolders":"oops"}"#).unwrap();
    assert_eq!(trust(Preset::Copilot, &e.wt, &homes(&e)).unwrap(), Outcome::Unreadable);
  }

  #[test]
  fn iso_time() {
    let t = time_iso();
    assert_eq!(t.len(), 24);
    assert!(t.starts_with("20"));
  }
}
