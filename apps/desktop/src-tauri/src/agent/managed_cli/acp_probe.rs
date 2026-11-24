//! The start check of Antigravity's ACP server (Orca `main/antigravity/antigravity-acp-runtime-probe.ts`
//! `probeAntigravityAcpServer`): the server has no `--version`, so an install is accepted only when
//! it answers ACP `initialize` as the pinned release — run from a throwaway folder that is also its
//! `GEMINI_HOME`, so the check never reads or writes a sign-in, and stopped afterwards.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::release::StartFailure;

/// Orca's `PROBE_TIMEOUT_MS`: the server unpacks about 1 GB on a cold start.
pub const TIMEOUT: Duration = Duration::from_secs(90);
/// The name the managed server gives itself (the host's `agy acp` says "Antigravity ACP Server").
pub const SERVER_NAME: &str = "antigravity-acp";

/// Whether `initialize`'s answer is the pinned server (Orca `isPinnedServer`).
pub fn is_pinned_server(result: &Value, version: &str) -> Result<(), StartFailure> {
  let info = &result["agentInfo"];
  let answered = info["version"].as_str().unwrap_or_default();
  if info["name"].as_str() == Some(SERVER_NAME) && !answered.is_empty() && answered != version {
    return Err(StartFailure::Version(answered.to_owned()));
  }
  let caps = &result["agentCapabilities"];
  let ok = info["name"].as_str() == Some(SERVER_NAME)
    && answered == version
    && result["protocolVersion"].as_u64() == Some(1)
    && caps["loadSession"].as_bool() == Some(true)
    && !caps["sessionCapabilities"]["resume"].is_null()
    && !caps["auth"]["logout"].is_null()
    && result["authMethods"].as_array().is_some_and(|m| m.iter().any(|x| x["id"].as_str() == Some("oauth-personal")));
  if ok { Ok(()) } else { Err(StartFailure::Exit(format!("it did not answer as Antigravity {version}"))) }
}

static PROBES: AtomicU64 = AtomicU64::new(0);

/// A folder of its own under the system temp folder, removed when dropped.
struct Scratch(PathBuf);
impl Scratch {
  fn new() -> std::io::Result<Self> {
    let dir = std::env::temp_dir().join(format!("kingu-antigravity-probe-{}-{}", std::process::id(), PROBES.fetch_add(1, Ordering::SeqCst)));
    std::fs::create_dir_all(&dir)?;
    Ok(Scratch(dir))
  }
}
impl Drop for Scratch {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.0);
  }
}

/// Starts `program` (with `args`) from a throwaway folder, sends `initialize`, and requires the
/// pinned release's answer within `timeout`. The server is killed afterwards either way.
pub fn probe_server(program: &Path, args: &[&str], version: &str, timeout: Duration) -> Result<(), StartFailure> {
  let scratch = Scratch::new().map_err(|e| StartFailure::Exit(e.to_string()))?;
  let home = scratch.0.to_string_lossy().into_owned();
  let mut cmd = crate::shell_env::command(program);
  cmd.args(args).current_dir(&scratch.0).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
  for (k, v) in crate::agent::antigravity::SERVER_ENV {
    cmd.env(k, v);
  }
  for k in crate::agent::antigravity::scrubbed_env(std::env::vars().map(|(k, _)| k)) {
    cmd.env_remove(k);
  }
  cmd.env("GEMINI_HOME", &home).env("TMPDIR", &home).env("TEMP", &home).env("TMP", &home);
  let mut child = cmd.spawn().map_err(|e| StartFailure::Exit(e.to_string()))?;
  let (tx, rx) = mpsc::channel::<Value>();
  if let Some(out) = child.stdout.take() {
    std::thread::spawn(move || {
      for line in BufReader::new(out).lines().map_while(Result::ok) {
        if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
          if v["id"] == json!(1) && tx.send(v).is_err() {
            return;
          }
        }
      }
    });
  }
  let init = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "protocolVersion": 1,
    "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false},
    "clientInfo": {"name": "kingu", "title": "Kingu", "version": env!("CARGO_PKG_VERSION")}
  }});
  let sent = child.stdin.as_mut().map(|stdin| writeln!(stdin, "{init}").and_then(|()| stdin.flush()));
  let started = Instant::now();
  let outcome = match sent {
    Some(Ok(())) => match rx.recv_timeout(timeout) {
      Ok(reply) if reply.get("error").is_some() => Err(StartFailure::Exit(format!("initialize failed: {}", reply["error"]["message"].as_str().unwrap_or("error")))),
      Ok(reply) => is_pinned_server(&reply["result"], version),
      Err(mpsc::RecvTimeoutError::Timeout) => Err(StartFailure::Timeout),
      Err(mpsc::RecvTimeoutError::Disconnected) => Err(StartFailure::Exit(match child.try_wait() {
        Ok(Some(status)) => status.code().map_or_else(|| "a signal".to_owned(), |c| format!("code {c}")),
        _ => "no answer".to_owned(),
      })),
    },
    _ => Err(StartFailure::Exit("its input closed".into())),
  };
  let _ = child.kill();
  let _ = child.wait();
  log::info!("managed install: Antigravity ACP server check took {:?}: {}", started.elapsed(), if outcome.is_ok() { "ok" } else { "refused" });
  drop(scratch);
  outcome
}

#[cfg(all(test, unix))]
mod tests {
  use super::*;
  use std::os::unix::fs::PermissionsExt;

  fn answer(name: &str, version: &str) -> Value {
    json!({"protocolVersion": 1, "agentInfo": {"name": name, "version": version},
      "agentCapabilities": {"loadSession": true, "sessionCapabilities": {"resume": {}}, "auth": {"logout": {}}},
      "authMethods": [{"id": "oauth-personal", "name": "Sign in with Google"}]})
  }

  #[test]
  fn only_the_pinned_server_passes() {
    assert_eq!(is_pinned_server(&answer("antigravity-acp", "1.5.2"), "1.5.2"), Ok(()));
    assert_eq!(is_pinned_server(&answer("antigravity-acp", "1.6.0"), "1.5.2"), Err(StartFailure::Version("1.6.0".into())));
    assert!(is_pinned_server(&answer("Antigravity ACP Server", "1.5.2"), "1.5.2").is_err(), "the host's agy acp is not the managed server");
    let mut no_google = answer("antigravity-acp", "1.5.2");
    no_google["authMethods"] = json!([{"id": "gemini-api-key"}]);
    assert!(is_pinned_server(&no_google, "1.5.2").is_err());
    let mut no_resume = answer("antigravity-acp", "1.5.2");
    no_resume["agentCapabilities"]["sessionCapabilities"] = json!({});
    assert!(is_pinned_server(&no_resume, "1.5.2").is_err());
  }

  fn script(dir: &Path, body: &str) -> PathBuf {
    let p = dir.join("agy_acp_server.par");
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
  }

  #[test]
  fn the_check_runs_the_server_from_a_throwaway_home() {
    let dir = tempfile::tempdir().unwrap();
    let reply = serde_json::to_string(&json!({"jsonrpc": "2.0", "id": 1, "result": answer("antigravity-acp", "1.5.2")})).unwrap();
    // It answers only when GEMINI_HOME is its own folder and the sign-in store is file based.
    let ok = script(dir.path(), &format!("read line\n[ \"$(cd \"$GEMINI_HOME\" && pwd -P)\" = \"$(pwd -P)\" ] && [ \"$AGY_ACP_FORCE_FILE_STORAGE\" = 1 ] && [ -z \"$GEMINI_API_KEY\" ] && echo '{reply}'\nsleep 5"));
    assert_eq!(probe_server(&ok, &[], "1.5.2", Duration::from_secs(10)), Ok(()));
    let silent = script(dir.path(), "sleep 5");
    assert_eq!(probe_server(&silent, &[], "1.5.2", Duration::from_millis(300)), Err(StartFailure::Timeout));
    let crash = script(dir.path(), "exit 3");
    assert!(matches!(probe_server(&crash, &[], "1.5.2", Duration::from_secs(10)), Err(StartFailure::Exit(_))));
  }
}
