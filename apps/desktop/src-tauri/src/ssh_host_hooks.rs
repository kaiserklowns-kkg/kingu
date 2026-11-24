//! Kingu's agent status hooks in the CLI configs of an SSH host (agent/status_hooks.rs does the
//! same on this computer), and taking them out again when `kingu.agent.statusHooks` is turned off.
//!
//! Orca (3b2f28b30) has its host server do this on the host: `startOrcadManagedAgentHooks`
//! (`src/main/orcad/host-runtime/orcad-managed-agent-hooks.ts`) reconciles every CLI's managed
//! hooks there, codex's included (`startCodexHooks`; the remote install
//! `src/main/codex/hooks/installation/codex-hook-remote-install.ts` writes `<home>/.codex/hooks.json`
//! and the `[hooks.state]` trust entries keyed by that path in `<home>/.codex/config.toml`), and
//! refreshes OpenCode's status plugin (`refreshInstalledOpenCodeStatusPlugins`, an overlay
//! `OPENCODE_CONFIG_DIR`, `src/main/opencode/status-hooks/hook-service.ts`). Kingu has no server on
//! the host, so each config is read over ssh, merged on this computer by the local rules
//! (`status_hooks::apply`, on a private copy) and written back, the old file kept as
//! `<file>.kingu.bak`.
//!
//! - **codex**: `~/.codex/hooks.json` plus the trust entries in `~/.codex/config.toml`, keyed by
//!   `<host home>/.codex/hooks.json` as Orca keys its remote install (locally Kingu keys them by the
//!   resolved path, trust.rs).
//! - **opencode**: no user config is edited. The plugin goes to
//!   `~/.kingu/host/agent-status/opencode/plugins/`, the session gets that folder as
//!   `OPENCODE_CONFIG_DIR` (opencode loads it on top of `~/.config/opencode`), and a folder the
//!   host's own `OPENCODE_CONFIG_DIR` names is mirrored in with links, as locally.
//! - **Removal** (the setting turned off): for each file Kingu wrote on a host (remembered on this
//!   computer with the SHA-256 of what was written, `ssh-host-hooks.json`), the `.kingu.bak` is put
//!   back only when the file is still exactly what Kingu wrote and the backup holds none of Kingu's
//!   entries; otherwise only Kingu's entries are taken out (the user's later edits stay).
//!
//! Everything that runs on the host is a script; the tests run them with `sh` and a temporary
//! `$HOME`, never on a host.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{Manager, State};

use crate::agent::status_hooks::{self, Agent};
use crate::ssh_holder::ROOT;
use crate::ssh_hosts::{self, Targets, sh_quote};

/// Under the host's `$HOME`: the script every entry runs.
pub const STATUS_DIR: &str = "agent-status";
pub const STATUS_SCRIPT: &str = "agent-status/agent-hook.sh";
/// codex's trust entries (next to its hooks.json).
pub const CODEX_TOML: &str = ".codex/config.toml";
/// opencode's overlay folder, under [`ROOT`].
const OPENCODE_DIR: &str = "agent-status/opencode";
/// status_hooks.rs `OPENCODE_PLUGIN` (the same file name as locally).
const OPENCODE_PLUGIN: &str = "kingu-agent-status.js";

const HOME_MARK: &str = "@@kingu-home ";
const FILE_MARK: &str = "@@kingu-file ";
const BAK_MARK: &str = "@@kingu-bak ";
const DIR_MARK: &str = "@@kingu-dir ";

// ---------------------------------------------------------------------------------------------
// Which file, which rules

/// What Kingu edits in a host file: one CLI's hook entries, or codex's trust entries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
  Hooks(Agent),
  CodexTrust,
}

/// The CLI's hook config relative to the host's `$HOME` (its default place: the host's own
/// `COPILOT_HOME`, `CODEX_HOME` and the like aren't known here). `None`: claude (hooks per
/// session, `--settings`), opencode (an overlay folder, [`opencode_setup_script`]) and anything
/// status_hooks.rs doesn't know.
pub fn status_config(agent: &str) -> Option<(Agent, String)> {
  let a = Agent::of_id(agent).filter(|a| !matches!(a, Agent::Claude))?;
  let home = PathBuf::from("/@kingu-home");
  let homes = crate::agent::trust::Homes { home: home.clone(), claude_config_dir: None, codex_home: None };
  let rel = a.file(&homes, &status_hooks::no_env_dir).strip_prefix(&home).ok()?.to_str()?.to_string();
  Some((a, rel))
}

/// The rules for a file Kingu recorded writing (`rel` under the host's home).
pub fn kind_of(rel: &str) -> Option<Kind> {
  if rel == CODEX_TOML {
    return Some(Kind::CodexTrust);
  }
  Agent::ALL.into_iter().find(|a| status_config(a.id()).is_some_and(|(_, r)| r == rel)).map(Kind::Hooks)
}

pub fn sha256(text: &str) -> String {
  Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------------------------
// Scripts

/// Resolves `$f` through a link (the file is written through it, as locally).
fn resolve(rel: &str) -> String {
  format!("f=\"$HOME\"/{}; if [ -L \"$f\" ]; then r=$(readlink -f \"$f\" 2>/dev/null) && [ -n \"$r\" ] && f=$r; fi", sh_quote(rel))
}

/// Prints the host's `$HOME`, then the file and its `.kingu.bak`, each after a mark with its byte
/// count (`-`: no such file), so their bytes come back exactly.
pub fn read_script(rel: &str) -> String {
  format!(
    "printf '{HOME_MARK}%s\\n' \"$HOME\"; {}; for g in \"$f\" \"$f.kingu.bak\"; do if [ \"$g\" = \"$f\" ]; then m='{FILE_MARK}'; else m='{BAK_MARK}'; fi; if [ -f \"$g\" ]; then printf '%s%s\\n' \"$m\" \"$(wc -c < \"$g\" | tr -d ' ')\"; cat \"$g\"; else printf '%s-\\n' \"$m\"; fi; done",
    resolve(rel)
  )
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HostFile {
  pub home: String,
  pub current: Option<String>,
  pub bak: Option<String>,
}

fn take_part<'a>(out: &'a [u8], mark: &str) -> Option<(Option<String>, &'a [u8])> {
  let at = out.windows(mark.len()).position(|w| w == mark.as_bytes())?;
  let rest = &out[at + mark.len()..];
  let nl = rest.iter().position(|b| *b == b'\n')?;
  let count = std::str::from_utf8(&rest[..nl]).ok()?.trim();
  let rest = &rest[nl + 1..];
  if count == "-" {
    return Some((None, rest));
  }
  let n: usize = count.parse().ok()?;
  let body = rest.get(..n)?;
  Some((Some(String::from_utf8(body.to_vec()).ok()?), &rest[n..]))
}

pub fn parse_read(out: &str) -> Option<HostFile> {
  let home = out.lines().find_map(|l| l.strip_prefix(HOME_MARK))?.trim().to_string();
  if !home.starts_with('/') || home.contains('\'') {
    return None;
  }
  let (current, rest) = take_part(out.as_bytes(), FILE_MARK)?;
  let (bak, _) = take_part(rest, BAK_MARK)?;
  Some(HostFile { home, current, bak })
}

/// Writes stdin to the file: the old file is kept as `<file>.kingu.bak`, a linked file is written
/// through its link, and the new one replaces it whole (private, as locally).
pub fn write_script(rel: &str) -> String {
  format!(
    "umask 077; {}; mkdir -p \"$(dirname \"$f\")\" || exit 1; if [ -f \"$f\" ]; then cp -p \"$f\" \"$f.kingu.bak\" || exit 1; fi; cat > \"$f.kingu.tmp\" && mv \"$f.kingu.tmp\" \"$f\"",
    resolve(rel)
  )
}

/// The SHA-256 of `$f` with whichever tool the host has (empty without one).
const HOST_SHA: &str = "h=; if command -v sha256sum >/dev/null 2>&1; then h=$(sha256sum \"$f\" | cut -d' ' -f1); elif command -v shasum >/dev/null 2>&1; then h=$(shasum -a 256 \"$f\" | cut -d' ' -f1); elif command -v openssl >/dev/null 2>&1; then h=$(openssl dgst -sha256 \"$f\" | sed 's/.*= *//'); fi";

/// Puts the `.kingu.bak` back over the file, only while the file is still `sha` (read just
/// before; a host without a hashing tool is trusted on that read). Prints `restored` or `changed`.
pub fn restore_script(rel: &str, sha: &str) -> Result<String, String> {
  if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
    return Err("invalid checksum".into());
  }
  Ok(format!(
    "{}; [ -f \"$f.kingu.bak\" ] || {{ printf 'changed\\n'; exit 0; }}; {HOST_SHA}; if [ -n \"$h\" ] && [ \"$h\" != {sha} ]; then printf 'changed\\n'; exit 0; fi; mv \"$f.kingu.bak\" \"$f\" && printf 'restored\\n'",
    resolve(rel)
  ))
}

/// Removes a file of Kingu's own (copilot's `kingu-desktop.json`, grok's `kingu-status.json`)
/// once nothing of the user's is left in it.
pub fn remove_script(rel: &str) -> String {
  format!("{}; rm -f \"$f\"", resolve(rel))
}

/// Writes the status script (stdin) the entries run, next to the holder.
pub fn status_script_setup() -> String {
  format!("umask 022; s=\"$HOME/{ROOT}/{STATUS_SCRIPT}\"; mkdir -p \"$(dirname \"$s\")\" && cat > \"$s.tmp\" && chmod 755 \"$s.tmp\" && mv \"$s.tmp\" \"$s\"")
}

/// The opencode overlay: the plugin (stdin) in `plugins/`, and the entries of the folder the
/// host's `OPENCODE_CONFIG_DIR` names linked in (fresh links each time). Prints the folder.
pub fn opencode_setup_script() -> String {
  format!(
    r#"umask 022; d="$HOME/{ROOT}/{OPENCODE_DIR}"; mkdir -p "$d/plugins" || exit 1
cat > "$d/plugins/{OPENCODE_PLUGIN}.tmp" && mv "$d/plugins/{OPENCODE_PLUGIN}.tmp" "$d/plugins/{OPENCODE_PLUGIN}" || exit 1
for l in "$d"/* "$d"/plugins/*; do if [ -L "$l" ]; then rm -f "$l"; fi; done
u=${{OPENCODE_CONFIG_DIR-}}
if [ -n "$u" ] && [ -d "$u" ] && [ "$u" != "$d" ]; then
  for e in "$u"/*; do
    [ -e "$e" ] || continue
    n=${{e##*/}}
    if [ "$n" = plugins ]; then
      for p in "$e"/*; do [ -e "$p" ] || continue; [ "${{p##*/}}" = {OPENCODE_PLUGIN} ] || ln -s "$p" "$d/plugins/${{p##*/}}"; done
    else
      ln -s "$e" "$d/$n"
    fi
  done
fi
printf '{DIR_MARK}%s\n' "$d""#
  )
}

pub fn parse_dir(out: &str) -> Option<String> {
  out.lines().find_map(|l| l.strip_prefix(DIR_MARK)).map(|d| d.trim().to_string()).filter(|d| d.starts_with('/'))
}

/// Everything of Kingu's under `~/.kingu/host/agent-status` (the script, opencode's overlay; links
/// in it are removed, never followed). An entry left anywhere then only drains its input.
pub fn status_dir_remove_script() -> String {
  format!("rm -rf \"$HOME/{ROOT}/{STATUS_DIR}\"")
}

// ---------------------------------------------------------------------------------------------
// Merging, on this computer

static SCRATCH: AtomicU64 = AtomicU64::new(0);

/// What a file becomes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Edit {
  Write(String),
  /// A file of Kingu's own with nothing left in it.
  Remove,
}

/// Kingu's entries for `agent` put in (`on`) or taken out of `current` (the host's file; `None`:
/// none) by the rules used on this computer (`status_hooks::apply`, on a private copy): the
/// user's own entries stay, a file that isn't JSON is an error. `None`: nothing to change.
pub fn merge_hooks(agent: Agent, current: Option<&str>, host_home: &str, on: bool) -> Result<Option<Edit>, String> {
  let dir = std::env::temp_dir().join(format!("kingu-host-hooks-{}-{}", std::process::id(), SCRATCH.fetch_add(1, Ordering::Relaxed)));
  kingu_ptyd::peer::prepare_dir(&dir)?;
  let file = dir.join("config.json");
  let done = (|| {
    if let Some(text) = current {
      std::fs::write(&file, text).map_err(|e| e.to_string())?;
    }
    let script = Path::new(host_home).join(ROOT).join(STATUS_SCRIPT);
    status_hooks::apply(agent, &file, &script, on)?;
    match std::fs::read_to_string(&file) {
      Ok(next) if Some(next.as_str()) == current => Ok(None),
      Ok(next) => Ok(Some(Edit::Write(next))),
      Err(_) if current.is_some() => Ok(Some(Edit::Remove)),
      Err(_) => Ok(None),
    }
  })();
  let _ = std::fs::remove_dir_all(&dir);
  done
}

/// codex's trust entries for the Kingu groups in `hooks` (codex's hooks.json as written on the
/// host), keyed `<host home>/.codex/hooks.json:<event>:<group>:0` as Orca keys its remote install;
/// `hooks: None` takes Kingu's entries out. A config.toml that doesn't parse is an error.
pub fn merge_trust(current: Option<&str>, hooks: Option<&str>, host_home: &str) -> Result<Option<Edit>, String> {
  let text = current.unwrap_or("");
  if toml::from_str::<toml::Table>(text.trim_start_matches('\u{feff}')).is_err() {
    return Err(format!("~/{CODEX_TOML} on the host is not valid TOML"));
  }
  let script = Path::new(host_home).join(ROOT).join(STATUS_SCRIPT);
  let source = format!("{}/.codex/hooks.json", host_home.trim_end_matches('/'));
  let mut entries = Vec::new();
  if let Some(h) = hooks {
    let v: Value = serde_json::from_str(h).map_err(|e| e.to_string())?;
    for (event, groups) in v.get("hooks").and_then(Value::as_object).into_iter().flatten() {
      for (i, g) in groups.as_array().into_iter().flatten().enumerate() {
        if g.to_string().contains(status_hooks::MARKER) {
          entries.push((format!("{source}:{}:{i}:0", status_hooks::codex_label(event)), status_hooks::codex_hash(event, &status_hooks::hook_command(&script, Agent::Codex, event, None))));
        }
      }
    }
  }
  let next = status_hooks::codex_state_edit(text, &entries);
  if next == text {
    return Ok(None);
  }
  toml::from_str::<toml::Table>(next.trim_start_matches('\u{feff}')).map_err(|e| e.to_string())?;
  Ok(Some(Edit::Write(next)))
}

/// Kingu's entries taken out of `text` under `kind`'s rules.
fn strip(kind: Kind, text: &str, home: &str) -> Result<Option<Edit>, String> {
  match kind {
    Kind::Hooks(a) => merge_hooks(a, Some(text), home, false),
    Kind::CodexTrust => merge_trust(Some(text), None, home),
  }
}

/// `text` holds an entry of Kingu's (its script path; codex's trust entries carry their own mark).
pub fn has_ours(kind: Kind, text: &str) -> bool {
  match kind {
    Kind::Hooks(_) => text.contains(status_hooks::MARKER),
    Kind::CodexTrust => status_hooks::codex_state_edit(text, &[]) != text,
  }
}

/// How a file Kingu wrote is undone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Undo {
  /// The `.kingu.bak` goes back: the file is exactly what Kingu wrote and the backup has none of
  /// Kingu's entries (the file as the user had it).
  Restore { sha: String },
  /// Kingu's entries taken out, everything else kept.
  Edit(Edit),
}

/// What to do with the file now (`written`: the SHA-256 of what Kingu wrote there). `None`: the
/// file is gone or has none of Kingu's entries.
pub fn undo_plan(kind: Kind, file: &HostFile, written: Option<&str>) -> Result<Option<Undo>, String> {
  let Some(current) = file.current.as_deref().filter(|c| has_ours(kind, c)) else { return Ok(None) };
  let sha = sha256(current);
  if written == Some(sha.as_str())
    && let Some(bak) = file.bak.as_deref()
    && !has_ours(kind, bak)
  {
    return Ok(Some(Undo::Restore { sha }));
  }
  Ok(strip(kind, current, &file.home)?.map(Undo::Edit))
}

// ---------------------------------------------------------------------------------------------
// What Kingu wrote on which host (on this computer)

static RECORDS: Mutex<()> = Mutex::new(());

/// host id → file under its home → SHA-256 of what Kingu wrote (`""` for opencode's folder).
pub type Records = BTreeMap<String, BTreeMap<String, String>>;

fn records_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("ssh-host-hooks.json"))
}

pub fn load(file: &Path) -> Records {
  std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save(file: &Path, r: &Records) -> Result<(), String> {
  if let Some(d) = file.parent() {
    std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
  }
  crate::agent::trust::replace_file(file, serde_json::to_string_pretty(r).map_err(|e| e.to_string())?.as_bytes(), Some(0o600))
}

/// Changes the records under the lock.
pub fn update(file: &Path, f: impl FnOnce(&mut Records)) -> Result<(), String> {
  let _one = RECORDS.lock().unwrap_or_else(|e| e.into_inner());
  let mut r = load(file);
  f(&mut r);
  r.retain(|_, files| !files.is_empty());
  save(file, &r)
}

/// The opencode overlay's record key (no file to compare).
const OPENCODE_RECORD: &str = ".kingu/host/agent-status/opencode";

// ---------------------------------------------------------------------------------------------
// Commands

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostHooks {
  /// The CLI reports through hooks now.
  pub hooked: bool,
  /// opencode: the session's `OPENCODE_CONFIG_DIR` on the host.
  pub opencode_config_dir: Option<String>,
}

/// Writes `edit` of `rel`, returning the SHA-256 of what was written (`None`: removed).
fn write(t: &ssh_hosts::Target, rel: &str, edit: Edit, limit: Duration) -> Result<Option<String>, String> {
  match edit {
    Edit::Write(text) => {
      let sha = sha256(&text);
      ssh_hosts::remote_input(t, &write_script(rel), Some(text.into_bytes()), limit)?;
      Ok(Some(sha))
    }
    Edit::Remove => ssh_hosts::remote(t, &remove_script(rel)).map(|_| None),
  }
}

/// Before `agent` (a profile id) starts on the host: Kingu's status hook entries are in its
/// config there and the script they run exists (Orca's host server installs its managed hooks on
/// the host the same way). The entries only write inside a session Kingu started
/// (`KINGU_AGENT_HOOK_FILE`).
#[tauri::command]
pub async fn ssh_remote_status_hooks(app: tauri::AppHandle, targets: State<'_, Targets>, id: String, agent: String) -> Result<HostHooks, String> {
  let t = targets.get(&id)?;
  let records = records_file(&app)?;
  ssh_hosts::blocking(move || {
    let limit = Duration::from_millis(ssh_hosts::REMOTE_TIMEOUT_MS);
    if agent == "opencode" {
      let dir = parse_dir(&ssh_hosts::remote_input(&t, &opencode_setup_script(), Some(status_hooks::OPENCODE_PLUGIN_SOURCE.as_bytes().to_vec()), limit)?).ok_or("the host did not name the opencode folder")?;
      update(&records, |r| {
        r.entry(id.clone()).or_default().insert(OPENCODE_RECORD.into(), String::new());
      })?;
      return Ok(HostHooks { hooked: true, opencode_config_dir: Some(dir) });
    }
    let Some((a, rel)) = status_config(&agent) else { return Ok(HostHooks::default()) };
    let file = parse_read(&ssh_hosts::remote(&t, &read_script(&rel))?).ok_or("the host did not name its home folder")?;
    let toml = if a == Agent::Codex { Some(parse_read(&ssh_hosts::remote(&t, &read_script(CODEX_TOML))?).ok_or("the host did not name its home folder")?) } else { None };
    ssh_hosts::remote_input(&t, &status_script_setup(), Some(status_hooks::SCRIPT.as_bytes().to_vec()), limit)?;
    let next = merge_hooks(a, file.current.as_deref(), &file.home, true)?;
    let hooks_now = match &next {
      Some(Edit::Write(text)) => Some(text.clone()),
      _ => file.current.clone(),
    };
    // codex: the trust entries are computed first, so a config.toml that doesn't parse stops
    // before hooks.json changes (Orca writes hooks before trust; neither is half-done here).
    let trust = match &toml {
      Some(tf) => merge_trust(tf.current.as_deref(), hooks_now.as_deref(), &tf.home)?,
      None => None,
    };
    if let Some(edit) = next {
      let sha = write(&t, &rel, edit, limit)?;
      update(&records, |r| {
        r.entry(id.clone()).or_default().insert(rel.clone(), sha.unwrap_or_default());
      })?;
      log::info!("agent status hooks for {agent} written on {} (~/{rel})", t.label);
    }
    if let Some(edit) = trust {
      let sha = write(&t, CODEX_TOML, edit, limit)?;
      update(&records, |r| {
        r.entry(id.clone()).or_default().insert(CODEX_TOML.into(), sha.unwrap_or_default());
      })?;
    }
    Ok(HostHooks { hooked: true, opencode_config_dir: None })
  })
  .await?
}

/// The hosts Kingu wrote status hook entries on (whose entries a turned-off setting takes out).
#[tauri::command]
pub fn ssh_remote_status_hooks_hosts(app: tauri::AppHandle) -> Result<Vec<String>, String> {
  Ok(load(&records_file(&app)?).into_keys().collect())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
  /// Files put back from their `.kingu.bak`.
  pub restored: Vec<String>,
  /// Files with Kingu's entries taken out (the user's edits since kept).
  pub stripped: Vec<String>,
  /// Files that could not be changed (each with its reason); they stay on record.
  pub failed: Vec<String>,
}

/// `kingu.agent.statusHooks` turned off: Kingu's entries leave every config it wrote on the host
/// ([`undo_plan`]); then Kingu's script and opencode's overlay go. No record: no ssh at all.
#[tauri::command]
pub async fn ssh_remote_status_hooks_remove(app: tauri::AppHandle, targets: State<'_, Targets>, id: String) -> Result<Removed, String> {
  let records = records_file(&app)?;
  let Some(files) = load(&records).remove(&id) else { return Ok(Removed::default()) };
  let t = targets.get(&id)?;
  ssh_hosts::blocking(move || {
    let limit = Duration::from_millis(ssh_hosts::REMOTE_TIMEOUT_MS);
    let mut out = Removed::default();
    // codex's trust entries before its hooks.json, the reverse of their writing.
    let mut order: Vec<(&String, &String)> = files.iter().collect();
    order.sort_by_key(|(rel, _)| if rel.as_str() == CODEX_TOML { 0 } else { 1 });
    for (rel, written) in order {
      let done: Result<(), String> = (|| {
        if rel == OPENCODE_RECORD {
          return Ok(());
        }
        let kind = kind_of(rel).ok_or("not a file Kingu writes")?;
        let file = parse_read(&ssh_hosts::remote(&t, &read_script(rel))?).ok_or("the host did not name its home folder")?;
        match undo_plan(kind, &file, Some(written).filter(|w| !w.is_empty()).map(String::as_str))? {
          None => {}
          Some(Undo::Restore { sha }) => {
            if ssh_hosts::remote(&t, &restore_script(rel, &sha)?)?.trim() == "restored" {
              out.restored.push(rel.clone());
            } else if let Some(u) = undo_plan(kind, &parse_read(&ssh_hosts::remote(&t, &read_script(rel))?).ok_or("the host did not name its home folder")?, None)? {
              // Changed between the read and the restore: only Kingu's entries go.
              if let Undo::Edit(e) = u {
                write(&t, rel, e, limit)?;
              }
              out.stripped.push(rel.clone());
            }
          }
          Some(Undo::Edit(e)) => {
            write(&t, rel, e, limit)?;
            out.stripped.push(rel.clone());
          }
        }
        Ok(())
      })();
      match done {
        Ok(()) => update(&records, |r| {
          if let Some(f) = r.get_mut(&id) {
            f.remove(rel);
          }
        })?,
        Err(e) => out.failed.push(format!("~/{rel}: {e}")),
      }
    }
    if out.failed.is_empty() {
      ssh_hosts::remote(&t, &status_dir_remove_script())?;
      log::info!("agent status hooks removed from {}: {} restored, {} stripped", t.label, out.restored.len(), out.stripped.len());
    }
    Ok(out)
  })
  .await?
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::process::{Command, Stdio};

  /// Runs `script` with `sh` as the host would, `home` as its `$HOME`, `input` on stdin.
  fn sh(script: &str, home: &Path, input: &[u8]) -> (i32, String, String) {
    sh_env(script, home, input, &[])
  }

  fn sh_env(script: &str, home: &Path, input: &[u8], env: &[(&str, &str)]) -> (i32, String, String) {
    use std::io::Write;
    let mut c = Command::new("sh");
    c.arg("-c").arg(script).env("HOME", home).env_remove("OPENCODE_CONFIG_DIR").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in env {
      c.env(k, v);
    }
    let mut c = c.spawn().unwrap();
    let mut stdin = c.stdin.take().unwrap();
    let bytes = input.to_vec();
    let w = std::thread::spawn(move || {
      let _ = stdin.write_all(&bytes);
    });
    let o = c.wait_with_output().unwrap();
    let _ = w.join();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
  }

  /// What `ssh_remote_status_hooks` does for `agent`, on `home` instead of a host.
  fn install(home: &Path, agent: &str, records: &mut BTreeMap<String, String>) {
    let (a, rel) = status_config(agent).unwrap();
    let file = parse_read(&sh(&read_script(&rel), home, b"").1).unwrap();
    let toml = (a == Agent::Codex).then(|| parse_read(&sh(&read_script(CODEX_TOML), home, b"").1).unwrap());
    sh(&status_script_setup(), home, status_hooks::SCRIPT.as_bytes());
    let next = merge_hooks(a, file.current.as_deref(), &file.home, true).unwrap();
    let hooks_now = match &next {
      Some(Edit::Write(t)) => Some(t.clone()),
      _ => file.current.clone(),
    };
    let trust = toml.as_ref().and_then(|tf| merge_trust(tf.current.as_deref(), hooks_now.as_deref(), &tf.home).unwrap());
    for (rel, edit) in [(rel.clone(), next), (CODEX_TOML.to_string(), trust)] {
      if let Some(Edit::Write(text)) = edit {
        let (code, _, err) = sh(&write_script(&rel), home, text.as_bytes());
        assert_eq!(code, 0, "{err}");
        records.insert(rel, sha256(&text));
      }
    }
  }

  /// What `ssh_remote_status_hooks_remove` does for one file.
  fn remove(home: &Path, rel: &str, written: &str) -> &'static str {
    let file = parse_read(&sh(&read_script(rel), home, b"").1).unwrap();
    match undo_plan(kind_of(rel).unwrap(), &file, Some(written)).unwrap() {
      None => "nothing",
      Some(Undo::Restore { sha }) => {
        assert_eq!(sh(&restore_script(rel, &sha).unwrap(), home, b"").1.trim(), "restored");
        "restored"
      }
      Some(Undo::Edit(Edit::Write(text))) => {
        sh(&write_script(rel), home, text.as_bytes());
        "stripped"
      }
      Some(Undo::Edit(Edit::Remove)) => {
        sh(&remove_script(rel), home, b"");
        "removed"
      }
    }
  }

  #[test]
  fn names_the_files_and_their_rules() {
    assert!(status_config("claude").is_none() && status_config("opencode").is_none() && status_config("nope").is_none());
    assert_eq!(status_config("gemini").unwrap().1, ".gemini/settings.json");
    assert_eq!(status_config("codex").unwrap().1, ".codex/hooks.json");
    assert_eq!(status_config("copilot").unwrap().1, ".copilot/hooks/kingu-desktop.json");
    assert_eq!(kind_of(".codex/hooks.json"), Some(Kind::Hooks(Agent::Codex)));
    assert_eq!(kind_of(CODEX_TOML), Some(Kind::CodexTrust));
    assert_eq!(kind_of(".gemini/settings.json"), Some(Kind::Hooks(Agent::Gemini)));
    assert_eq!(kind_of(".bashrc"), None);
  }

  #[test]
  #[cfg(unix)]
  fn the_read_brings_back_the_exact_bytes_of_the_file_and_its_backup() {
    let home = tempfile::tempdir().unwrap();
    let home_s = home.path().to_str().unwrap().to_string();
    let rel = ".gemini/settings.json";
    assert_eq!(parse_read(&sh(&read_script(rel), home.path(), b"").1), Some(HostFile { home: home_s.clone(), current: None, bak: None }));
    std::fs::create_dir_all(home.path().join(".gemini")).unwrap();
    // Content that looks like the marks, no final newline, and an empty backup.
    let tricky = "{\"a\":\"@@kingu-bak 3\\n\"}\n\n@@kingu-file 9";
    std::fs::write(home.path().join(rel), tricky).unwrap();
    std::fs::write(home.path().join(".gemini/settings.json.kingu.bak"), "").unwrap();
    let r = parse_read(&sh(&read_script(rel), home.path(), b"").1).unwrap();
    assert_eq!((r.current.as_deref(), r.bak.as_deref()), (Some(tricky), Some("")));
    // Through a link, the backup next to the link's target is the one read.
    let real = home.path().join("dotfiles");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::write(real.join("s.json"), "{}").unwrap();
    std::fs::write(real.join("s.json.kingu.bak"), "{\"old\":1}").unwrap();
    std::fs::remove_file(home.path().join(rel)).unwrap();
    std::os::unix::fs::symlink(real.join("s.json"), home.path().join(rel)).unwrap();
    let r = parse_read(&sh(&read_script(rel), home.path(), b"").1).unwrap();
    assert_eq!((r.current.as_deref(), r.bak.as_deref()), (Some("{}"), Some("{\"old\":1}")));
  }

  #[test]
  fn another_clis_status_hooks_are_merged_into_its_config_on_the_host() {
    let home = tempfile::tempdir().unwrap();
    let home_s = home.path().to_str().unwrap().to_string();
    let (a, rel) = status_config("gemini").unwrap();

    // No config yet: the merge makes the file, the write puts it there.
    let made = match merge_hooks(a, None, &home_s, true).unwrap() {
      Some(Edit::Write(t)) => t,
      other => panic!("{other:?}"),
    };
    let (code, _, err) = sh(&write_script(&rel), home.path(), made.as_bytes());
    assert_eq!(code, 0, "{err}");
    let file = home.path().join(&rel);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), made);
    assert!(!home.path().join(".gemini/settings.json.kingu.bak").exists(), "nothing to back up");
    let v: Value = serde_json::from_str(&made).unwrap();
    let cmd = v["hooks"]["BeforeAgent"][0]["hooks"][0]["command"].as_str().unwrap().to_string();
    assert!(cmd.contains(&format!("{home_s}/.kingu/host/agent-status/agent-hook.sh")), "{cmd}");

    // The user's own settings and hooks stay; the old file is kept; a second merge changes nothing.
    std::fs::write(&file, r#"{"theme":"dark","hooks":{"BeforeAgent":[{"hooks":[{"type":"command","command":"echo mine"}]}]}}"#).unwrap();
    let merged = match merge_hooks(a, Some(&std::fs::read_to_string(&file).unwrap()), &home_s, true).unwrap() {
      Some(Edit::Write(t)) => t,
      other => panic!("{other:?}"),
    };
    sh(&write_script(&rel), home.path(), merged.as_bytes());
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(v["theme"], "dark");
    let groups = v["hooks"]["BeforeAgent"].as_array().unwrap();
    assert_eq!(groups.len(), 2);
    assert_eq!(groups[0]["hooks"][0]["command"], "echo mine");
    assert!(std::fs::read_to_string(home.path().join(".gemini/settings.json.kingu.bak")).unwrap().contains("echo mine"));
    assert_eq!(merge_hooks(a, Some(&std::fs::read_to_string(&file).unwrap()), &home_s, true).unwrap(), None);
    assert!(merge_hooks(a, Some("not json"), &home_s, true).is_err(), "a config that doesn't parse is left alone");

    // The script lands where the entries point, and the entry, run as the CLI runs it inside a
    // Kingu session on the host, appends its tagged line to that session's hook file.
    let (code, _, err) = sh(&status_script_setup(), home.path(), status_hooks::SCRIPT.as_bytes());
    assert_eq!(code, 0, "{err}");
    let hook_file = home.path().join(crate::ssh_holder::HOOKS_DIR).join("abcdef123456.jsonl");
    std::fs::create_dir_all(hook_file.parent().unwrap()).unwrap();
    let mut c = Command::new("sh").arg("-c").arg(&cmd).env("HOME", home.path()).env("KINGU_AGENT_HOOK_FILE", &hook_file).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    {
      use std::io::Write;
      c.stdin.take().unwrap().write_all(br#"{"prompt":"hi"}"#).unwrap();
    }
    assert!(c.wait_with_output().unwrap().status.success());
    let line: Value = serde_json::from_str(std::fs::read_to_string(&hook_file).unwrap().trim()).unwrap();
    assert_eq!((line["kingu_hook"].as_str(), line["event"].as_str()), (Some("gemini"), Some("BeforeAgent")));
    assert_eq!(line["payload"]["prompt"], "hi");
  }

  #[test]
  fn codex_on_the_host_gets_its_hooks_and_the_trust_entries_orca_writes() {
    let home = tempfile::tempdir().unwrap();
    let home_s = home.path().to_str().unwrap().to_string();
    std::fs::create_dir_all(home.path().join(".codex")).unwrap();
    let user_toml = "model = \"o3\"\n\n[projects.\"/srv/app\"]\ntrust_level = \"trusted\"\n";
    std::fs::write(home.path().join(CODEX_TOML), user_toml).unwrap();
    std::fs::write(home.path().join(".codex/hooks.json"), r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]}}"#).unwrap();
    let mut rec = BTreeMap::new();
    install(home.path(), "codex", &mut rec);
    assert_eq!(rec.len(), 2, "{rec:?}");

    let hooks: Value = serde_json::from_str(&std::fs::read_to_string(home.path().join(".codex/hooks.json")).unwrap()).unwrap();
    assert_eq!(hooks["hooks"]["Stop"][0]["hooks"][0]["command"], "say done", "the user's group stays first");
    let ours = hooks["hooks"]["Stop"][1]["hooks"][0]["command"].as_str().unwrap();
    assert!(ours.contains(&format!("{home_s}/.kingu/host/agent-status/agent-hook.sh")), "{ours}");
    let toml_text = std::fs::read_to_string(home.path().join(CODEX_TOML)).unwrap();
    assert!(toml_text.starts_with(user_toml), "{toml_text}");
    let t: toml::Table = toml::from_str(&toml_text).unwrap();
    let state = t["hooks"]["state"].as_table().unwrap();
    // Each Kingu group is trusted at its own index, by the hash of exactly its command.
    let stop = &state[&format!("{home_s}/.codex/hooks.json:stop:1:0")];
    assert_eq!(stop["trusted_hash"].as_str().unwrap(), status_hooks::codex_hash("Stop", ours));
    assert!(state.contains_key(&format!("{home_s}/.codex/hooks.json:pre_tool_use:0:0")));
    assert!(state.keys().all(|k| k.starts_with(&format!("{home_s}/.codex/hooks.json:"))));
    // Again: nothing changes.
    let before = (std::fs::read_to_string(home.path().join(".codex/hooks.json")).unwrap(), toml_text.clone());
    install(home.path(), "codex", &mut rec);
    assert_eq!(before, (std::fs::read_to_string(home.path().join(".codex/hooks.json")).unwrap(), std::fs::read_to_string(home.path().join(CODEX_TOML)).unwrap()));
    // A config.toml that doesn't parse stops the merge.
    assert!(merge_trust(Some("[[["), Some("{}"), &home_s).is_err());

    // Turned off, nothing touched since: both files come back as they were (toml first).
    assert_eq!(remove(home.path(), CODEX_TOML, &rec[CODEX_TOML]), "restored");
    assert_eq!(remove(home.path(), ".codex/hooks.json", &rec[".codex/hooks.json"]), "restored");
    assert_eq!(std::fs::read_to_string(home.path().join(CODEX_TOML)).unwrap(), user_toml);
    assert_eq!(std::fs::read_to_string(home.path().join(".codex/hooks.json")).unwrap(), r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]}}"#);
    assert!(!home.path().join(".codex/hooks.json.kingu.bak").exists());
  }

  #[test]
  fn turning_off_restores_the_backup_only_while_the_file_is_kingus_and_otherwise_strips() {
    let home = tempfile::tempdir().unwrap();
    let rel = ".gemini/settings.json";
    std::fs::create_dir_all(home.path().join(".gemini")).unwrap();
    let mine = "{\n  \"theme\": \"dark\"\n}\n";
    std::fs::write(home.path().join(rel), mine).unwrap();

    // Untouched since Kingu's write: the user's file comes back byte for byte.
    let mut rec = BTreeMap::new();
    install(home.path(), "gemini", &mut rec);
    assert_ne!(std::fs::read_to_string(home.path().join(rel)).unwrap(), mine);
    assert_eq!(remove(home.path(), rel, &rec[rel]), "restored");
    assert_eq!(std::fs::read_to_string(home.path().join(rel)).unwrap(), mine);
    assert_eq!(remove(home.path(), rel, &rec[rel]), "nothing", "a second removal finds nothing");

    // Edited by the user since: only Kingu's entries go, the edit stays, the backup is not used.
    let mut rec = BTreeMap::new();
    install(home.path(), "gemini", &mut rec);
    let file = home.path().join(rel);
    let mut v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    v["fontSize"] = 14.into();
    std::fs::write(&file, serde_json::to_string_pretty(&v).unwrap()).unwrap();
    assert_eq!(remove(home.path(), rel, &rec[rel]), "stripped");
    let after: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!((after["theme"].as_str(), after["fontSize"].as_i64()), (Some("dark"), Some(14)));
    assert!(!after.to_string().contains(status_hooks::MARKER));

    // A backup that itself holds Kingu's entries (Kingu wrote twice) is never put back.
    let mut rec = BTreeMap::new();
    install(home.path(), "gemini", &mut rec);
    let with_ours = std::fs::read_to_string(&file).unwrap();
    std::fs::write(home.path().join(".gemini/settings.json.kingu.bak"), &with_ours).unwrap();
    assert_eq!(remove(home.path(), rel, &rec[rel]), "stripped");
    assert!(!std::fs::read_to_string(&file).unwrap().contains(status_hooks::MARKER));

    // A file Kingu created whole (no backup): its entries go, never the file of someone else.
    let fresh = tempfile::tempdir().unwrap();
    let mut rec = BTreeMap::new();
    install(fresh.path(), "gemini", &mut rec);
    assert_eq!(remove(fresh.path(), rel, &rec[rel]), "stripped");
    // copilot's file is Kingu's own: it goes once empty.
    let mut rec = BTreeMap::new();
    install(fresh.path(), "copilot", &mut rec);
    let crel = ".copilot/hooks/kingu-desktop.json";
    assert!(fresh.path().join(crel).exists());
    assert_eq!(remove(fresh.path(), crel, &rec[crel]), "removed");
    assert!(!fresh.path().join(crel).exists());

    // The restore checks the file again on the host: changed after the read, it is not replaced.
    let mut rec = BTreeMap::new();
    install(home.path(), "gemini", &mut rec);
    let r = parse_read(&sh(&read_script(rel), home.path(), b"").1).unwrap();
    let Some(Undo::Restore { sha }) = undo_plan(Kind::Hooks(Agent::Gemini), &r, Some(&rec[rel])).unwrap() else { panic!("expected a restore") };
    std::fs::write(&file, "{\"late\":true}").unwrap();
    assert_eq!(sh(&restore_script(rel, &sha).unwrap(), home.path(), b"").1.trim(), "changed");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\"late\":true}");
    assert!(restore_script(rel, "x; rm -rf ~").is_err());
  }

  #[test]
  fn opencode_on_the_host_gets_an_overlay_folder_with_the_plugin_and_the_users_folder_linked() {
    let home = tempfile::tempdir().unwrap();
    let (code, out, err) = sh(&opencode_setup_script(), home.path(), status_hooks::OPENCODE_PLUGIN_SOURCE.as_bytes());
    assert_eq!(code, 0, "{err}");
    let dir = parse_dir(&out).unwrap();
    assert_eq!(dir, format!("{}/.kingu/host/agent-status/opencode", home.path().display()));
    assert_eq!(std::fs::read_to_string(Path::new(&dir).join("plugins").join(OPENCODE_PLUGIN)).unwrap(), status_hooks::OPENCODE_PLUGIN_SOURCE);

    // The host's own OPENCODE_CONFIG_DIR: its files and plugins are linked in, Kingu's plugin wins.
    let user = home.path().join("my-opencode");
    std::fs::create_dir_all(user.join("plugins")).unwrap();
    std::fs::write(user.join("opencode.json"), "{}").unwrap();
    std::fs::write(user.join("plugins/mine.js"), "").unwrap();
    std::fs::write(user.join("plugins").join(OPENCODE_PLUGIN), "evil").unwrap();
    let (code, _, err) = sh_env(&opencode_setup_script(), home.path(), status_hooks::OPENCODE_PLUGIN_SOURCE.as_bytes(), &[("OPENCODE_CONFIG_DIR", user.to_str().unwrap())]);
    assert_eq!(code, 0, "{err}");
    let d = Path::new(&dir);
    assert!(std::fs::symlink_metadata(d.join("opencode.json")).unwrap().file_type().is_symlink());
    assert!(std::fs::symlink_metadata(d.join("plugins/mine.js")).unwrap().file_type().is_symlink());
    assert_eq!(std::fs::read_to_string(d.join("plugins").join(OPENCODE_PLUGIN)).unwrap(), status_hooks::OPENCODE_PLUGIN_SOURCE);
    // Without it again: the links go.
    sh(&opencode_setup_script(), home.path(), status_hooks::OPENCODE_PLUGIN_SOURCE.as_bytes());
    assert!(!d.join("opencode.json").exists() && !d.join("plugins/mine.js").exists());

    // Turned off: the whole folder goes, the user's linked folder stays.
    sh_env(&opencode_setup_script(), home.path(), status_hooks::OPENCODE_PLUGIN_SOURCE.as_bytes(), &[("OPENCODE_CONFIG_DIR", user.to_str().unwrap())]);
    sh(&status_dir_remove_script(), home.path(), b"");
    assert!(!home.path().join(ROOT).join(STATUS_DIR).exists());
    assert!(user.join("opencode.json").exists() && user.join("plugins/mine.js").exists());
  }

  #[test]
  fn records_keep_what_was_written_per_host() {
    let tmp = tempfile::tempdir().unwrap();
    let f = tmp.path().join("ssh-host-hooks.json");
    assert!(load(&f).is_empty());
    update(&f, |r| {
      r.entry("h1".into()).or_default().insert(".gemini/settings.json".into(), "ab".into());
    })
    .unwrap();
    update(&f, |r| {
      r.entry("h2".into()).or_default().insert(CODEX_TOML.into(), "cd".into());
    })
    .unwrap();
    assert_eq!(load(&f).keys().collect::<Vec<_>>(), ["h1", "h2"]);
    update(&f, |r| {
      r.get_mut("h1").unwrap().remove(".gemini/settings.json");
    })
    .unwrap();
    assert_eq!(load(&f).keys().collect::<Vec<_>>(), ["h2"], "a host with nothing left is dropped");
  }
}
