//! The app's side of the socket: request/reply calls, plus routing of output events to the
//! viewer (`Sink`) of each attach. Also starts the daemon when nothing answers.

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{BufReader, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::peer;
use crate::protocol::{ClientFrame, Hello, PROTOCOL, Request, ServerFrame, compatible, encode, read_frame, socket_name};
use crate::session::{Attached, SessionInfo, ShellSpec, Sink, is_agent_session_marker};

const CALL_TIMEOUT: Duration = Duration::from_secs(15);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);
const START_TIMEOUT: Duration = Duration::from_secs(5);
const LOG_NAME: &str = "kingu-ptyd.log";
const LOG_MAX_BYTES: u64 = 1 << 20;

#[derive(Debug)]
pub enum ConnectError {
  /// Nothing (usable) listens there: start a daemon.
  Unavailable(String),
  /// A daemon answered but speaks a protocol this app cannot use.
  Incompatible(Hello),
}

type Reply = Result<Value, String>;

#[derive(Default)]
struct Streams {
  sinks: HashMap<u64, (String, Sink)>,
  by_key: HashMap<String, u64>,
}

impl Streams {
  fn remove(&mut self, stream: u64) {
    if let Some((key, _)) = self.sinks.remove(&stream)
      && self.by_key.get(&key) == Some(&stream)
    {
      self.by_key.remove(&key);
    }
  }
}

struct Inner {
  writer: Mutex<UnixStream>,
  pending: Mutex<HashMap<u64, mpsc::Sender<Reply>>>,
  streams: Mutex<Streams>,
  next_id: AtomicU64,
  closed: AtomicBool,
}

pub struct Client {
  inner: Arc<Inner>,
  daemon: Hello,
}

impl Client {
  /// Connects and shakes hands; the daemon must run as this user and speak a compatible protocol.
  pub fn connect(path: &Path, app_version: &str) -> Result<Client, ConnectError> {
    let unavailable = |e: String| ConnectError::Unavailable(format!("{}: {e}", path.display()));
    let stream = UnixStream::connect(path).map_err(|e| unavailable(e.to_string()))?;
    peer::check_stream(&stream).map_err(unavailable)?;
    stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).map_err(|e| unavailable(e.to_string()))?;
    let ours = Hello::ours(app_version);
    let mut writer = stream.try_clone().map_err(|e| unavailable(e.to_string()))?;
    writer.write_all(&encode(&ClientFrame { id: 1, request: Request::Hello(ours.clone()) })).map_err(|e| unavailable(e.to_string()))?;
    let mut reader = BufReader::new(stream);
    let daemon: Hello = match read_frame::<ServerFrame>(&mut reader) {
      Ok(Some(ServerFrame::Reply { id: 1, ok, error: None })) => serde_json::from_value(ok).map_err(|e| unavailable(e.to_string()))?,
      Ok(Some(ServerFrame::Reply { error: Some(e), .. })) => return Err(unavailable(e)),
      Ok(_) => return Err(unavailable("no hello from the daemon".into())),
      Err(e) => return Err(unavailable(e.to_string())),
    };
    if !compatible(&ours, &daemon) {
      return Err(ConnectError::Incompatible(daemon));
    }
    reader.get_ref().set_read_timeout(None).map_err(|e| unavailable(e.to_string()))?;

    let inner = Arc::new(Inner {
      writer: Mutex::new(writer),
      pending: Mutex::default(),
      streams: Mutex::default(),
      next_id: AtomicU64::new(2),
      closed: AtomicBool::new(false),
    });
    let shared = inner.clone();
    std::thread::spawn(move || read_loop(reader, &shared));
    Ok(Client { inner, daemon })
  }

  /// The daemon's hello (its protocol, version and pid).
  pub fn daemon(&self) -> &Hello {
    &self.daemon
  }

  /// False once the connection dropped (the daemon exited or was killed).
  pub fn is_connected(&self) -> bool {
    !self.inner.closed.load(Ordering::SeqCst)
  }

  fn send(&self, id: u64, request: Request) -> Result<(), String> {
    if !self.is_connected() {
      return Err("The terminal daemon disconnected".into());
    }
    let mut w = self.inner.writer.lock().unwrap();
    w.write_all(&encode(&ClientFrame { id, request })).map_err(|e| {
      self.inner.closed.store(true, Ordering::SeqCst);
      format!("could not send a request to the terminal daemon: {e}")
    })
  }

  /// A request and its reply.
  pub fn call(&self, request: Request) -> Result<Value, String> {
    let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    self.inner.pending.lock().unwrap().insert(id, tx);
    if let Err(e) = self.send(id, request) {
      self.inner.pending.lock().unwrap().remove(&id);
      return Err(e);
    }
    let reply = rx.recv_timeout(CALL_TIMEOUT);
    self.inner.pending.lock().unwrap().remove(&id);
    reply.unwrap_or_else(|_| Err("the terminal daemon did not answer".into()))
  }

  fn call_as<T: serde::de::DeserializeOwned>(&self, request: Request) -> Result<T, String> {
    serde_json::from_value(self.call(request)?).map_err(|e| e.to_string())
  }

  /// A new viewer for `key`: replaces the key's earlier one, here and in the daemon.
  fn register(&self, key: &str, sink: Sink) -> u64 {
    let stream = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
    let mut streams = self.inner.streams.lock().unwrap();
    if let Some(old) = streams.by_key.insert(key.to_string(), stream) {
      streams.sinks.remove(&old);
    }
    streams.sinks.insert(stream, (key.to_string(), sink));
    stream
  }

  fn unregister(&self, stream: u64) {
    self.inner.streams.lock().unwrap().remove(stream);
  }

  /// Attaches to `key`, else the daemon starts a login shell for it (`ShellSpec`).
  pub fn spawn(&self, key: &str, spec: &ShellSpec<'_>, sink: Sink) -> Result<Attached, String> {
    let stream = self.register(key, sink);
    let env = (!spec.env.is_empty()).then(|| spec.env.clone());
    let request = Request::Spawn { key: key.into(), cwd: spec.cwd.display().to_string(), cols: spec.cols, rows: spec.rows, run: spec.run.map(<[String]>::to_vec), env, shell: spec.shell.map(str::to_string), args: spec.args.map(<[String]>::to_vec), unset: spec.unset.to_vec(), clean_env: spec.clean_env, stream };
    self.call_as(request).inspect_err(|_| self.unregister(stream))
  }

  pub fn attach(&self, key: &str, size: Option<(u16, u16)>, sink: Sink) -> Result<Option<Attached>, String> {
    let stream = self.register(key, sink);
    let r = self.call_as::<Option<Attached>>(Request::Attach { key: key.into(), cols: size.map(|s| s.0), rows: size.map(|s| s.1), stream });
    if !matches!(r, Ok(Some(_))) {
      self.unregister(stream);
    }
    r
  }

  /// Keystrokes: no reply is awaited (a dead key is ignored, as in the in-process backend).
  pub fn write(&self, key: &str, data: &str) -> Result<(), String> {
    self.send(0, Request::Write { key: key.into(), data: data.into() })
  }

  pub fn resize(&self, key: &str, cols: u16, rows: u16) -> Result<(), String> {
    self.send(0, Request::Resize { key: key.into(), cols, rows })
  }

  pub fn kill(&self, key: &str) -> Result<bool, String> {
    let stream = self.inner.streams.lock().unwrap().by_key.get(key).copied();
    if let Some(s) = stream {
      self.unregister(s);
    }
    self.call_as(Request::Kill { key: key.into() })
  }

  pub fn kill_all(&self) -> Result<usize, String> {
    self.call_as(Request::KillAll {})
  }

  pub fn list(&self) -> Result<Vec<SessionInfo>, String> {
    self.call_as(Request::List {})
  }
}

impl Drop for Client {
  fn drop(&mut self) {
    self.inner.closed.store(true, Ordering::SeqCst);
    let _ = self.inner.writer.lock().unwrap().shutdown(std::net::Shutdown::Both);
  }
}

fn read_loop(mut reader: BufReader<UnixStream>, inner: &Inner) {
  loop {
    match read_frame::<ServerFrame>(&mut reader) {
      Ok(Some(ServerFrame::Reply { id, ok, error })) => {
        if let Some(tx) = inner.pending.lock().unwrap().remove(&id) {
          let _ = tx.send(error.map_or(Ok(ok), Err));
        }
      }
      Ok(Some(ServerFrame::Output { stream, data, .. })) => {
        let mut streams = inner.streams.lock().unwrap();
        // Output of a stream that was replaced or closed is dropped: the new viewer got it in its replay.
        if let Some((_, sink)) = streams.sinks.get_mut(&stream)
          && !sink(data)
        {
          streams.remove(stream);
        }
      }
      Ok(None) | Err(_) => break,
    }
  }
  inner.closed.store(true, Ordering::SeqCst);
  for (_, tx) in inner.pending.lock().unwrap().drain() {
    let _ = tx.send(Err("The terminal daemon disconnected".into()));
  }
  let mut streams = inner.streams.lock().unwrap();
  for (_, (_, mut sink)) in streams.sinks.drain() {
    sink("\r\n[terminal daemon disconnected]\r\n".into());
  }
  streams.by_key.clear();
}

/// How the app finds or starts its daemon.
pub struct Launch {
  /// The `kingu-ptyd` executable.
  pub bin: PathBuf,
  /// Per-user private directory for the socket, lock and log.
  pub dir: PathBuf,
  pub app_version: String,
  /// Extra daemon arguments (tests: a short `--idle-seconds`).
  pub args: Vec<String>,
  /// Extra daemon environment (tests: `SHELL`).
  pub env: Vec<(String, String)>,
}

/// The socket used when the daemon on the usual one turned out incompatible.
pub fn fallback_socket_name(app_version: &str) -> String {
  let v: String = app_version.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).take(32).collect();
  format!("kingu-ptyd-{PROTOCOL}-v{v}.sock")
}

/// Connects to the user's daemon, starting one (detached, so it outlives the app) when nothing
/// answers. A daemon that speaks an incompatible protocol is left running with its sessions; a
/// new one starts on another socket name.
pub fn connect_or_start(launch: &Launch) -> Result<Client, String> {
  peer::prepare_dir(&launch.dir)?;
  let mut last = String::new();
  for name in [socket_name(), fallback_socket_name(&launch.app_version)] {
    let path = launch.dir.join(&name);
    match Client::connect(&path, &launch.app_version) {
      Ok(c) => return Ok(c),
      Err(ConnectError::Incompatible(h)) => {
        last = format!("the daemon at {} speaks protocol {} (compatible from {})", path.display(), h.protocol, h.min_compatible);
        continue;
      }
      Err(ConnectError::Unavailable(_)) => {}
    }
    start(launch, &name)?;
    let until = Instant::now() + START_TIMEOUT;
    loop {
      match Client::connect(&path, &launch.app_version) {
        Ok(c) => return Ok(c),
        Err(ConnectError::Incompatible(h)) => {
          last = format!("the daemon at {} speaks protocol {}", path.display(), h.protocol);
          break;
        }
        Err(ConnectError::Unavailable(e)) if Instant::now() >= until => return Err(format!("could not start the terminal daemon: {e}")),
        Err(ConnectError::Unavailable(_)) => std::thread::sleep(Duration::from_millis(25)),
      }
    }
  }
  Err(format!("the terminal daemon is unavailable: {last}"))
}

/// Starts the daemon in its own session (no controlling terminal, not in the app's process group,
/// so quitting the app or closing a terminal window does not signal it), stderr to the log.
fn start(launch: &Launch, name: &str) -> Result<(), String> {
  let log_path = launch.dir.join(LOG_NAME);
  let too_big = std::fs::metadata(&log_path).is_ok_and(|m| m.len() > LOG_MAX_BYTES);
  let log = OpenOptions::new()
    .create(true)
    .append(!too_big)
    .write(true)
    .truncate(too_big)
    .mode(0o600)
    .open(&log_path)
    .map_err(|e| format!("{}: {e}", log_path.display()))?;
  let mut cmd = Command::new(&launch.bin);
  cmd.arg("--dir").arg(&launch.dir).arg("--name").arg(name).args(&launch.args);
  cmd.envs(launch.env.iter().map(|(k, v)| (k, v)));
  cmd.current_dir("/").stdin(Stdio::null()).stdout(Stdio::null()).stderr(log);
  for (k, _) in std::env::vars_os() {
    if is_agent_session_marker(&k.to_string_lossy()) {
      cmd.env_remove(&k);
    }
  }
  unsafe {
    cmd.pre_exec(|| {
      if libc::setsid() < 0 {
        return Err(std::io::Error::last_os_error());
      }
      Ok(())
    });
  }
  let mut child = cmd.spawn().map_err(|e| format!("could not start {}: {e}", launch.bin.display()))?;
  // Reaped here if it exits while the app runs (idle, or another daemon won the lock).
  std::thread::spawn(move || {
    let _ = child.wait();
  });
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::fallback_socket_name;

  #[test]
  fn fallback_socket_name_is_a_plain_file_name() {
    let name = fallback_socket_name("0.2.0-beta/1");
    assert_eq!(name, format!("kingu-ptyd-{}-v0_2_0_beta_1.sock", crate::protocol::PROTOCOL));
    assert_ne!(name, crate::protocol::socket_name());
  }
}
