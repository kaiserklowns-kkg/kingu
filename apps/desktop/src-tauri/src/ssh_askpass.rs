//! Passphrase and password prompts inside the app for Kingu's background ssh commands (Orca's
//! `ssh:credential-request` / `ssh:submitCredential` / `ssh:needsPassphrasePrompt`,
//! `src/main/ipc/ssh/ssh-passphrase.ts`, `ssh-connection-handlers.ts`). Orca's ssh library asks its
//! window directly; Kingu runs the system ssh, so ssh gets `SSH_ASKPASS` = a small helper script
//! (`SSH_ASKPASS_REQUIRE=force`, so a terminal Kingu was started from is never used):
//!
//! 1. the helper makes a FIFO in Kingu's own folder (mode 0700), writes `<target>\n<prompt>` next to it
//!    as `<id>.req` and blocks reading the FIFO;
//! 2. a watcher thread here sees the request and asks the window (`ssh:credential-request`), or
//!    answers from the in-memory cache;
//! 3. the answer goes through the FIFO (`1<value>` or `0` for Cancel) to the helper, which prints it
//!    for ssh. A FIFO holds nothing on disk, so a key's passphrase is never written anywhere.
//!
//! Rules from Orca: a request waits at most 120 s (`SSH_CREDENTIAL_TIMEOUT_MS`,
//! `src/main/ssh/connection/ssh-connection-timing.ts`), then counts as declined; Cancel declines the
//! host, and every other request queued for it is cancelled too; a declined host is not prompted
//! again (background commands run with `BatchMode=yes`) until it is tested again (`ssh:testConnection`
//! clears it); entered credentials are kept in memory for the app's run (Orca's
//! `hasCachedCredential`). Kingu's own: a cached answer that ssh asks for again within 10 s was
//! wrong, so it is dropped and the user is asked (**estimated**).

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// Orca `SSH_CREDENTIAL_TIMEOUT_MS`.
pub const TIMEOUT: Duration = Duration::from_secs(120);
const RETRY_WINDOW: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(150);

/// The helper ssh runs. `$1` is ssh's prompt. Its own timer cancels after 130 s should Kingu
/// never answer (then nothing is left blocked).
pub const HELPER: &str = r#"#!/bin/sh
# Managed by Kingu: asks the Kingu window for an ssh passphrase (ssh_askpass.rs).
d="${KINGU_ASKPASS_DIR-}"
[ -n "$d" ] && [ -d "$d" ] || exit 1
umask 077
id="$$-$(date +%s)"
fifo="$d/$id.fifo"
mkfifo "$fifo" || exit 1
printf '%s\n%s' "${KINGU_SSH_TARGET-}" "$1" > "$d/$id.tmp" && mv "$d/$id.tmp" "$d/$id.req"
( trap 'kill "$s" 2>/dev/null; exit 0' TERM; sleep 130 & s=$!; wait "$s"; [ -p "$fifo" ] && printf '0\n' > "$fifo" ) </dev/null >/dev/null 2>&1 &
timer=$!
IFS= read -r ans < "$fifo"
kill "$timer" 2>/dev/null
rm -f "$fifo" "$d/$id.req"
case "$ans" in
  1*) printf '%s\n' "${ans#1}" ;;
  *) exit 1 ;;
esac
"#;

#[derive(Debug, Clone, Serialize)]
pub struct Request {
  pub id: String,
  pub target: String,
  pub prompt: String,
  /// Shown as typed (a yes/no host key question), not hidden.
  pub echo: bool,
}

#[derive(Default)]
struct State {
  /// Requests the window was asked about, with when they came.
  pending: HashMap<String, (Request, Instant)>,
  /// Requests already handled (their files may linger a moment).
  seen: HashSet<String>,
  cache: HashMap<String, String>,
  auto: HashMap<String, Instant>,
  declined: HashSet<String>,
}

struct Askpass {
  dir: PathBuf,
  helper: PathBuf,
  app: AppHandle,
  state: Mutex<State>,
}

static ASKPASS: OnceLock<Askpass> = OnceLock::new();

/// A secret prompt (passphrase, password, PIN), else a question shown as typed.
pub fn is_secret(prompt: &str) -> bool {
  let p = prompt.to_ascii_lowercase();
  ["passphrase", "password", "pin for", "pin:", "verification code", "one-time"].iter().any(|w| p.contains(w))
}

/// `<target>\n<prompt>` of a request file.
pub fn parse_request(id: &str, text: &str) -> Request {
  let (target, prompt) = text.split_once('\n').unwrap_or(("", text));
  Request { id: id.to_string(), target: target.to_string(), prompt: prompt.trim().to_string(), echo: !is_secret(prompt) }
}

/// The FIFO answer: `1<value>\n`, or `0\n` (Cancel). A value can't hold a line break.
pub fn answer_line(value: Option<&str>) -> String {
  match value {
    Some(v) => format!("1{}\n", v.replace(['\n', '\r'], "")),
    None => "0\n".into(),
  }
}

pub fn install(app: &AppHandle) {
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    let Ok(base) = app.path().app_cache_dir() else { return };
    let dir = base.join("ssh-askpass");
    let helper = base.join("kingu-ssh-askpass.sh");
    let ok = std::fs::create_dir_all(&dir).is_ok()
      && std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).is_ok()
      && std::fs::write(&helper, HELPER).is_ok()
      && std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).is_ok();
    if !ok {
      log::warn!("ssh askpass: could not prepare {}", dir.display());
      return;
    }
    // Requests of an earlier run are dead.
    if let Ok(rd) = std::fs::read_dir(&dir) {
      for e in rd.flatten() {
        let _ = std::fs::remove_file(e.path());
      }
    }
    if ASKPASS.set(Askpass { dir, helper, app: app.clone(), state: Mutex::default() }).is_ok() {
      std::thread::spawn(watch);
    }
  }
  #[cfg(not(unix))]
  let _ = app;
}

/// Lets `cmd` (an ssh) ask for credentials through the window, unless the host was declined.
/// Returns whether it may (the caller then omits `BatchMode=yes`).
pub fn apply(cmd: &mut Command, target: &str) -> bool {
  let Some(a) = ASKPASS.get() else { return false };
  if a.state.lock().unwrap_or_else(|e| e.into_inner()).declined.contains(target) {
    return false;
  }
  cmd.env("SSH_ASKPASS", &a.helper).env("SSH_ASKPASS_REQUIRE", "force").env("DISPLAY", std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into())).env("KINGU_ASKPASS_DIR", &a.dir).env("KINGU_SSH_TARGET", target);
  true
}

/// A prompt is open: background commands don't count this time against their limit.
pub fn waiting() -> bool {
  ASKPASS.get().is_some_and(|a| !a.state.lock().unwrap_or_else(|e| e.into_inner()).pending.is_empty())
}

/// Testing a host again lets it prompt again (Orca `clearSshCredentialDeclined`).
pub fn clear_declined(target: &str) {
  if let Some(a) = ASKPASS.get() {
    a.state.lock().unwrap_or_else(|e| e.into_inner()).declined.remove(target);
  }
}

fn write_answer(dir: &Path, id: &str, line: String) {
  let fifo = dir.join(format!("{id}.fifo"));
  // Opening blocks until the helper reads; a helper that died never does, so not on our thread.
  std::thread::spawn(move || {
    if let Ok(mut f) = std::fs::OpenOptions::new().write(true).open(&fifo) {
      let _ = f.write_all(line.as_bytes());
    }
  });
}

fn watch() {
  let Some(a) = ASKPASS.get() else { return };
  loop {
    std::thread::sleep(POLL);
    let mut found = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&a.dir) {
      for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if let Some(id) = name.strip_suffix(".req")
          && id.bytes().all(|b| b.is_ascii_digit() || b == b'-')
        {
          found.push((id.to_string(), e.path()));
        }
      }
    }
    let mut st = a.state.lock().unwrap_or_else(|e| e.into_inner());
    // Requests whose helper finished are forgotten (their file is gone).
    let live: HashSet<&String> = found.iter().map(|(id, _)| id).collect();
    st.seen.retain(|id| live.contains(id));
    let mut emit = Vec::new();
    for (id, path) in &found {
      if st.seen.contains(id) {
        continue;
      }
      let Ok(text) = std::fs::read_to_string(path) else { continue };
      st.seen.insert(id.clone());
      let req = parse_request(id, &text);
      if st.declined.contains(&req.target) {
        write_answer(&a.dir, id, answer_line(None));
        continue;
      }
      let key = format!("{}\n{}", req.target, req.prompt);
      let retried = st.auto.get(&key).is_some_and(|t| t.elapsed() < RETRY_WINDOW);
      if retried {
        st.cache.remove(&key);
        st.auto.remove(&key);
      } else if let Some(v) = st.cache.get(&key).cloned() {
        st.auto.insert(key, Instant::now());
        write_answer(&a.dir, id, answer_line(Some(&v)));
        continue;
      }
      st.pending.insert(id.clone(), (req.clone(), Instant::now()));
      emit.push(req);
    }
    let expired: Vec<String> = st.pending.iter().filter(|(_, (_, at))| at.elapsed() > TIMEOUT).map(|(id, _)| id.clone()).collect();
    for id in expired {
      decline(a, &mut st, &id);
    }
    drop(st);
    for req in emit {
      let _ = a.app.emit("ssh:credential-request", &req);
    }
  }
}

/// Cancel (or a timeout): this request and every other one for the same host.
fn decline(a: &Askpass, st: &mut State, id: &str) {
  let Some((req, _)) = st.pending.remove(id) else { return };
  write_answer(&a.dir, id, answer_line(None));
  st.declined.insert(req.target.clone());
  let others: Vec<String> = st.pending.iter().filter(|(_, (r, _))| r.target == req.target).map(|(i, _)| i.clone()).collect();
  for o in others {
    st.pending.remove(&o);
    write_answer(&a.dir, &o, answer_line(None));
    let _ = a.app.emit("ssh:credential-resolved", &o);
  }
  let _ = a.app.emit("ssh:credential-resolved", id);
}

/// The window's answer (`value` none: Cancel).
#[tauri::command]
pub fn ssh_submit_credential(id: String, value: Option<String>) -> Result<(), String> {
  let a = ASKPASS.get().ok_or("ssh prompts are not available")?;
  let mut st = a.state.lock().unwrap_or_else(|e| e.into_inner());
  match value {
    None => decline(a, &mut st, &id),
    Some(v) => {
      let Some((req, _)) = st.pending.remove(&id) else { return Ok(()) };
      // A secret is kept in memory for the run; a yes/no answer is not.
      if !req.echo {
        st.cache.insert(format!("{}\n{}", req.target, req.prompt), v.clone());
      }
      write_answer(&a.dir, &id, answer_line(Some(&v)));
      let _ = a.app.emit("ssh:credential-resolved", &id);
    }
  }
  Ok(())
}

/// Orca `ssh:needsPassphrasePrompt`: the host was declined, so automatic work should not start
/// (it would fail without asking).
#[tauri::command]
pub fn ssh_needs_passphrase_prompt(id: String) -> bool {
  ASKPASS.get().is_some_and(|a| a.state.lock().unwrap_or_else(|e| e.into_inner()).declined.contains(&id))
}

/// Requests still waiting (a window opened late, or reloaded).
#[tauri::command]
pub fn ssh_pending_credentials() -> Vec<Request> {
  ASKPASS.get().map(|a| a.state.lock().unwrap_or_else(|e| e.into_inner()).pending.values().map(|(r, _)| r.clone()).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::process::Stdio;

  #[test]
  fn tells_secrets_from_questions() {
    assert!(is_secret("Enter passphrase for key '/Users/a/.ssh/id_ed25519': "));
    assert!(is_secret("bright@box's password: "));
    assert!(!is_secret("Are you sure you want to continue connecting (yes/no/[fingerprint])? "));
    let r = parse_request("1-2", "h1\nEnter passphrase for key 'k': ");
    assert_eq!((r.target.as_str(), r.prompt.as_str(), r.echo), ("h1", "Enter passphrase for key 'k':", false));
    assert_eq!(answer_line(Some("a b\n")), "1a b\n");
    assert_eq!(answer_line(None), "0\n");
  }

  /// The helper as ssh runs it: the request appears, the FIFO answer comes out on stdout
  /// (trailing spaces and backslashes kept), Cancel exits non-zero, and nothing is left behind.
  #[cfg(unix)]
  #[test]
  fn the_helper_round_trips_an_answer_through_its_fifo() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("q");
    std::fs::create_dir(&dir).unwrap();
    let helper = tmp.path().join("h.sh");
    std::fs::write(&helper, HELPER).unwrap();
    for (answer, expect) in [(Some(r"p\ss wörd "), Some("p\\ss wörd \n")), (None, None)] {
      let child = Command::new("sh").arg(&helper).arg("Enter passphrase: ").env("KINGU_ASKPASS_DIR", &dir).env("KINGU_SSH_TARGET", "t1").stdout(Stdio::piped()).spawn().unwrap();
      let start = Instant::now();
      let (id, text) = loop {
        let req = std::fs::read_dir(&dir).unwrap().flatten().find(|e| e.file_name().to_string_lossy().ends_with(".req"));
        if let Some(e) = req {
          let name = e.file_name().to_string_lossy().into_owned();
          break (name.trim_end_matches(".req").to_string(), std::fs::read_to_string(e.path()).unwrap());
        }
        assert!(start.elapsed() < Duration::from_secs(5), "no request");
        std::thread::sleep(Duration::from_millis(20));
      };
      assert_eq!(parse_request(&id, &text).target, "t1");
      write_answer(&dir, &id, answer_line(answer));
      let out = child.wait_with_output().unwrap();
      match expect {
        Some(e) => {
          assert!(out.status.success());
          assert_eq!(String::from_utf8_lossy(&out.stdout), e);
        }
        None => assert!(!out.status.success()),
      }
      assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "fifo and request removed");
    }
  }
}
