//! Runs an agent CLI as a child process (no shell) in a task worktree, parses its stdout
//! line by line into `AgentEvent`s, and supports stopping it.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::events::{AgentEvent, parse_claude_line};

/// Grace period between SIGTERM and SIGKILL on stop.
const STOP_GRACE: Duration = Duration::from_secs(3);
const STOP_RESEND: Duration = Duration::from_millis(250);
const ENV_ALLOWLIST: &[&str] = &["PATH", "HOME", "USER", "LANG", "TERM", "SHELL"];

pub type Sink = Arc<dyn Fn(AgentEvent) + Send + Sync>;
pub type LineParser = fn(&str) -> Vec<AgentEvent>;

/// What to run: program, arguments, working directory, environment and output format.
pub struct Launch {
  pub program: PathBuf,
  pub args: Vec<String>,
  pub cwd: PathBuf,
  pub env: Vec<(OsString, OsString)>,
  pub parse: LineParser,
}

/// Claude Code headless: `claude -p --output-format stream-json --verbose -- <prompt>`.
/// `--` keeps a prompt starting with '-' from being read as a flag.
pub fn claude_launch(bin: PathBuf, prompt: &str, cwd: PathBuf, env: Vec<(OsString, OsString)>) -> Launch {
  let args = ["-p", "--output-format", "stream-json", "--verbose", "--", prompt].map(str::to_owned).to_vec();
  Launch { program: bin, args, cwd, env, parse: parse_claude_line }
}

/// Keeps only the allowlisted variables plus `ANTHROPIC_*`, so app secrets do not leak to the agent.
pub fn allowed_env(vars: impl IntoIterator<Item = (OsString, OsString)>) -> Vec<(OsString, OsString)> {
  vars
    .into_iter()
    .filter(|(k, _)| {
      k.to_str().is_some_and(|k| ENV_ALLOWLIST.contains(&k) || k.starts_with("ANTHROPIC_"))
    })
    .collect()
}

struct Run {
  child: Mutex<Child>,
  pid: u32,
  stopped: AtomicBool,
}

pub struct Agents {
  next_id: AtomicU32,
  runs: Arc<Mutex<HashMap<u32, Arc<Run>>>>,
  /// Claude Code binary: `KINGU_CLAUDE_BIN`, else `claude` looked up on PATH.
  pub claude_bin: PathBuf,
}

impl Default for Agents {
  fn default() -> Self {
    let claude_bin = std::env::var_os("KINGU_CLAUDE_BIN").map(PathBuf::from).unwrap_or_else(|| "claude".into());
    Self { next_id: AtomicU32::new(0), runs: Arc::default(), claude_bin }
  }
}

/// Reads `r` line by line (lossy UTF-8, so a bad byte never ends the stream).
fn for_each_line(r: impl Read, mut f: impl FnMut(&str)) {
  let mut r = BufReader::new(r);
  let mut buf = Vec::new();
  loop {
    buf.clear();
    match r.read_until(b'\n', &mut buf) {
      Ok(0) | Err(_) => break,
      Ok(_) => f(String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n'])),
    }
  }
}

#[cfg(unix)]
fn signal_group(pid: u32, sig: i32) {
  // The child leads its own process group, so this also reaches its tool subprocesses.
  unsafe {
    libc::kill(-(pid as i32), sig);
  }
}

impl Agents {
  /// Spawns the agent; events go to `sink`, ending with exactly one `Exit`.
  pub fn start(&self, launch: Launch, sink: Sink) -> Result<u32, String> {
    let mut cmd = Command::new(&launch.program);
    cmd
      .args(&launch.args)
      .current_dir(&launch.cwd)
      .env_clear()
      .envs(launch.env)
      .stdin(Stdio::null())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.spawn().map_err(|e| format!("{}: {e}", launch.program.display()))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let run = Arc::new(Run { pid: child.id(), child: Mutex::new(child), stopped: AtomicBool::new(false) });
    self.runs.lock().unwrap().insert(id, run.clone());

    let err_sink = sink.clone();
    let stderr_thread = std::thread::spawn(move || {
      for_each_line(stderr, |line| err_sink(AgentEvent::Stderr { line: line.to_owned() }));
    });

    let runs = self.runs.clone();
    let parse = launch.parse;
    std::thread::spawn(move || {
      for_each_line(stdout, |line| parse(line).into_iter().for_each(|ev| sink(ev)));
      let _ = stderr_thread.join();
      // Poll rather than block in wait(), so stop() can still take the lock to kill.
      let status = loop {
        match run.child.lock().unwrap().try_wait() {
          Ok(Some(s)) => break Some(s),
          Ok(None) => {}
          Err(_) => break None,
        }
        std::thread::sleep(Duration::from_millis(20));
      };
      runs.lock().unwrap().remove(&id);
      #[cfg(unix)]
      let signal = status.and_then(|s| std::os::unix::process::ExitStatusExt::signal(&s));
      #[cfg(not(unix))]
      let signal = None;
      let code = status.and_then(|s| s.code());
      log::info!("agent run {id} exited (code {code:?}, signal {signal:?})");
      sink(AgentEvent::Exit { code, signal, stopped: run.stopped.load(Ordering::Relaxed) });
    });
    Ok(id)
  }

  /// Asks the agent to stop (SIGTERM to its process group), then kills it after a grace period.
  pub fn stop(&self, id: u32) -> Result<(), String> {
    let run = self.runs.lock().unwrap().get(&id).cloned().ok_or("no such agent run")?;
    run.stopped.store(true, Ordering::Relaxed);
    log::info!("agent run {id} stopping");
    #[cfg(unix)]
    {
      let runs = self.runs.clone();
      // Still registered means no Exit yet (the leader or a straggler holds stdout open).
      let alive = move || runs.lock().unwrap().contains_key(&id);
      std::thread::spawn(move || {
        let started = std::time::Instant::now();
        // Re-sent while waiting: a process forked while the first signal was in flight misses it.
        while alive() && started.elapsed() < STOP_GRACE {
          signal_group(run.pid, libc::SIGTERM);
          std::thread::sleep(STOP_RESEND);
        }
        if alive() {
          log::info!("agent run {id} ignored SIGTERM, killing");
          signal_group(run.pid, libc::SIGKILL);
        }
      });
      Ok(())
    }
    #[cfg(not(unix))]
    {
      let _ = run.pid;
      run.child.lock().unwrap().kill().map_err(|e| e.to_string())
    }
  }

  #[cfg(test)]
  fn is_running(&self, id: u32) -> bool {
    self.runs.lock().unwrap().contains_key(&id)
  }
}

#[cfg(all(test, unix))]
mod tests {
  use super::*;
  use std::os::unix::fs::PermissionsExt;
  use std::path::Path;
  use std::sync::mpsc;

  fn fake_agent(dir: &Path, body: &str) -> PathBuf {
    let path = dir.join("fake-claude");
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
  }

  fn collect() -> (Sink, mpsc::Receiver<AgentEvent>) {
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    (Arc::new(move |ev| tx.lock().unwrap().send(ev).unwrap()), rx)
  }

  fn until_exit(rx: &mpsc::Receiver<AgentEvent>) -> Vec<AgentEvent> {
    let mut out = Vec::new();
    loop {
      let ev = rx.recv_timeout(Duration::from_secs(10)).expect("agent did not exit in time");
      let done = matches!(ev, AgentEvent::Exit { .. });
      out.push(ev);
      if done {
        return out;
      }
    }
  }

  fn test_env() -> Vec<(OsString, OsString)> {
    allowed_env([
      ("PATH".into(), "/usr/bin:/bin".into()),
      ("KINGU_SECRET".into(), "leak".into()),
      ("ANTHROPIC_MODEL".into(), "m".into()),
    ])
  }

  #[test]
  fn filters_the_environment() {
    let env = allowed_env([
      ("PATH".into(), "/bin".into()),
      ("HOME".into(), "/h".into()),
      ("AWS_SECRET_ACCESS_KEY".into(), "x".into()),
      ("ANTHROPIC_API_KEY".into(), "k".into()),
      ("GITHUB_TOKEN".into(), "t".into()),
      ("LANG".into(), "th_TH.UTF-8".into()),
    ]);
    let keys: Vec<_> = env.iter().map(|(k, _)| k.to_str().unwrap()).collect();
    assert_eq!(keys, ["PATH", "HOME", "ANTHROPIC_API_KEY", "LANG"]);
  }

  #[test]
  fn claude_launch_puts_the_prompt_after_double_dash() {
    let l = claude_launch("claude".into(), "--help me", "/w".into(), vec![]);
    assert_eq!(l.args, ["-p", "--output-format", "stream-json", "--verbose", "--", "--help me"]);
  }

  #[test]
  fn runs_a_fake_agent_end_to_end() {
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().canonicalize().unwrap();
    let bin = fake_agent(
      &cwd,
      r#"echo "args=$*"
echo "cwd=$(pwd)"
echo "secret=${KINGU_SECRET:-unset} model=${ANTHROPIC_MODEL:-unset}"
echo '{"type":"system","subtype":"init","session_id":"s-1","model":"fake"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"สวัสดี"},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.txt"}}]}}'
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"hello"}]}}'
echo 'oops' >&2
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","num_turns":1}'
exit 3"#,
    );
    let agents = Agents::default();
    let (sink, rx) = collect();
    let id = agents.start(claude_launch(bin, "แก้บั๊ก", cwd.clone(), test_env()), sink).unwrap();
    let events = until_exit(&rx);
    assert!(!agents.is_running(id));

    let raw: Vec<_> = events.iter().filter_map(|e| if let AgentEvent::Raw { line } = e { Some(line.as_str()) } else { None }).collect();
    assert_eq!(
      raw,
      [
        "args=-p --output-format stream-json --verbose -- แก้บั๊ก",
        &format!("cwd={}", cwd.display()),
        "secret=unset model=m",
      ]
    );
    let stdout: Vec<_> = events.iter().filter(|e| !matches!(e, AgentEvent::Raw { .. } | AgentEvent::Stderr { .. })).collect();
    assert!(matches!(stdout[0], AgentEvent::System { subtype, .. } if subtype == "init"));
    assert!(matches!(stdout[1], AgentEvent::Message { text, .. } if text == "สวัสดี"));
    assert!(matches!(stdout[2], AgentEvent::ToolUse { name, .. } if name == "Read"));
    assert!(matches!(stdout[3], AgentEvent::ToolResult { content, .. } if content == "hello"));
    assert!(matches!(stdout[4], AgentEvent::Result { result: Some(r), .. } if r == "done"));
    assert_eq!(stdout[5], &AgentEvent::Exit { code: Some(3), signal: None, stopped: false });
    assert_eq!(stdout.len(), 6);
    assert!(events.contains(&AgentEvent::Stderr { line: "oops".into() }));
  }

  #[test]
  fn stops_a_running_agent_and_its_subprocesses() {
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().canonicalize().unwrap();
    // `sleep` runs as a grandchild holding stdout open, like a tool subprocess would.
    let bin = fake_agent(&cwd, "echo '{\"type\":\"system\",\"subtype\":\"init\"}'\nsleep 30\necho never");
    let agents = Agents::default();
    let (sink, rx) = collect();
    let id = agents.start(claude_launch(bin, "x", cwd, test_env()), sink).unwrap();
    assert!(matches!(rx.recv_timeout(Duration::from_secs(10)).unwrap(), AgentEvent::System { .. }));
    assert!(agents.is_running(id));
    let started = std::time::Instant::now();
    agents.stop(id).unwrap();
    let events = until_exit(&rx);
    assert!(started.elapsed() < STOP_GRACE, "SIGTERM should end it before SIGKILL: {events:?}");
    assert!(matches!(events.last(), Some(AgentEvent::Exit { stopped: true, signal: Some(_), .. })), "{events:?}");
    assert!(!events.contains(&AgentEvent::Raw { line: "never".into() }));
    assert!(agents.stop(id).is_err());
  }

  #[test]
  fn reports_a_missing_binary() {
    let agents = Agents::default();
    let (sink, _rx) = collect();
    let err = agents.start(claude_launch("/nonexistent/claude".into(), "x", "/".into(), test_env()), sink).unwrap_err();
    assert!(err.contains("/nonexistent/claude"));
  }
}
