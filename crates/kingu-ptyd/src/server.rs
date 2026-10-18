//! The daemon: one per user and protocol, listening on `<dir>/kingu-ptyd-<protocol>.sock`. It owns
//! the PTY sessions (`Host`), so they keep running while no app is connected, and exits only
//! after `idle` with no sessions and no clients.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::peer;
use crate::protocol::{ClientFrame, Hello, Request, ServerFrame, compatible, encode, read_frame};
use crate::session::{Host, ShellSpec, Sink, validate_key};

pub struct Config {
  pub dir: PathBuf,
  /// Socket file name inside `dir` (`protocol::socket_name()` unless the app picked another).
  pub name: String,
  pub idle: Duration,
  pub version: String,
}

#[derive(Debug, PartialEq)]
pub enum Exit {
  /// No sessions and no clients for the idle timeout.
  Idle,
  /// Another daemon holds this socket's lock.
  AlreadyRunning,
}

pub fn log(msg: impl std::fmt::Display) {
  let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
  eprintln!("[{secs}] kingu-ptyd[{}]: {msg}", std::process::id());
}

/// Held for the daemon's lifetime: a second daemon for the same socket sees it and leaves, so a
/// race between two app launches never ends with one daemon deleting the other's socket.
fn take_lock(path: &Path) -> Result<Option<File>, String> {
  let file = OpenOptions::new().create(true).truncate(false).write(true).mode(0o600).open(path).map_err(|e| format!("{}: {e}", path.display()))?;
  if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
    Ok(Some(file))
  } else {
    let e = io::Error::last_os_error();
    if e.kind() == io::ErrorKind::WouldBlock { Ok(None) } else { Err(format!("lock {}: {e}", path.display())) }
  }
}

/// Binds the socket readable and writable by this user only (the umask covers the moment
/// between bind and chmod).
fn bind_private(path: &Path) -> Result<UnixListener, String> {
  match fs::remove_file(path) {
    Ok(()) => log(format!("removed stale socket {}", path.display())),
    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
    Err(e) => return Err(format!("{}: {e}", path.display())),
  }
  let old = unsafe { libc::umask(0o177) };
  let bound = UnixListener::bind(path);
  unsafe { libc::umask(old) };
  let listener = bound.map_err(|e| format!("bind {}: {e}", path.display()))?;
  fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| format!("{}: {e}", path.display()))?;
  Ok(listener)
}

pub fn run(cfg: &Config) -> Result<Exit, String> {
  peer::prepare_dir(&cfg.dir)?;
  let socket = cfg.dir.join(&cfg.name);
  let Some(_lock) = take_lock(&cfg.dir.join(format!("{}.lock", cfg.name)))? else {
    log("another daemon owns this socket; exiting");
    return Ok(Exit::AlreadyRunning);
  };
  let listener = bind_private(&socket)?;
  log(format!("listening on {} (idle exit after {:?})", socket.display(), cfg.idle));

  let host = Arc::new(Host::default());
  let clients = Arc::new(AtomicUsize::new(0));
  let hello = Hello::ours(&cfg.version);
  {
    let host = host.clone();
    let clients = clients.clone();
    std::thread::spawn(move || {
      for conn in listener.incoming() {
        let Ok(stream) = conn else { continue };
        if let Err(e) = peer::check_stream(&stream) {
          log(e);
          continue;
        }
        clients.fetch_add(1, Ordering::SeqCst);
        let (host, clients, hello) = (host.clone(), clients.clone(), hello.clone());
        std::thread::spawn(move || {
          serve(stream, &host, &hello);
          clients.fetch_sub(1, Ordering::SeqCst);
        });
      }
    });
  }

  let tick = (cfg.idle / 4).clamp(Duration::from_millis(50), Duration::from_secs(5));
  let mut idle_since: Option<Instant> = None;
  loop {
    std::thread::sleep(tick);
    if host.is_empty() && clients.load(Ordering::SeqCst) == 0 {
      if idle_since.get_or_insert_with(Instant::now).elapsed() >= cfg.idle {
        break;
      }
    } else {
      idle_since = None;
    }
  }
  let _ = fs::remove_file(&socket);
  log("idle: no sessions and no clients; exiting");
  Ok(Exit::Idle)
}

/// One client connection: handshake, then requests until it closes. Output of the sessions it
/// attached to goes through the same writer queue as the replies.
fn serve(stream: UnixStream, host: &Host, hello: &Hello) {
  let Ok(mut out) = stream.try_clone() else { return };
  // Bounded: a client that stops reading slows its terminals down instead of growing this queue.
  let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(1024);
  let closed = Arc::new(AtomicBool::new(false));
  let writer = {
    let closed = closed.clone();
    std::thread::spawn(move || {
      loop {
        match rx.recv_timeout(Duration::from_millis(500)) {
          Ok(buf) => {
            if out.write_all(&buf).is_err() {
              break;
            }
          }
          Err(RecvTimeoutError::Timeout) if closed.load(Ordering::SeqCst) => break,
          Err(RecvTimeoutError::Timeout) => {}
          Err(RecvTimeoutError::Disconnected) => break,
        }
      }
      closed.store(true, Ordering::SeqCst);
      let _ = out.shutdown(std::net::Shutdown::Both);
    })
  };

  let mut reader = BufReader::new(stream);
  let reply = |id: u64, result: Result<Value, String>| {
    if id == 0 {
      return;
    }
    let frame = match result {
      Ok(ok) => ServerFrame::Reply { id, ok, error: None },
      Err(e) => ServerFrame::Reply { id, ok: Value::Null, error: Some(e) },
    };
    let _ = tx.send(encode(&frame));
  };

  match read_frame::<ClientFrame>(&mut reader) {
    Ok(Some(ClientFrame { id, request: Request::Hello(theirs) })) => {
      reply(id, Ok(serde_json::to_value(hello).unwrap_or_default()));
      if !compatible(hello, &theirs) {
        log(format!("incompatible client (protocol {}, min {}, app {})", theirs.protocol, theirs.min_compatible, theirs.app_version));
        return finish(tx, &closed, writer);
      }
    }
    _ => return finish(tx, &closed, writer),
  }

  loop {
    let frame = match read_frame::<ClientFrame>(&mut reader) {
      Ok(Some(f)) => f,
      Ok(None) => break,
      Err(e) => {
        log(format!("dropping client: {e}"));
        break;
      }
    };
    let result = handle(host, frame.request, &tx, &closed);
    reply(frame.id, result);
  }
  finish(tx, &closed, writer);
}

fn finish(tx: SyncSender<Vec<u8>>, closed: &AtomicBool, writer: std::thread::JoinHandle<()>) {
  drop(tx);
  closed.store(true, Ordering::SeqCst);
  let _ = writer.join();
}

fn sink(tx: &SyncSender<Vec<u8>>, closed: &Arc<AtomicBool>, key: &str, stream: u64) -> Sink {
  let (tx, closed, key) = (tx.clone(), closed.clone(), key.to_string());
  Box::new(move |data| !closed.load(Ordering::SeqCst) && tx.send(encode(&ServerFrame::Output { key: key.clone(), stream, data })).is_ok())
}

fn handle(host: &Host, request: Request, tx: &SyncSender<Vec<u8>>, closed: &Arc<AtomicBool>) -> Result<Value, String> {
  let json = |v: Result<Value, serde_json::Error>| v.map_err(|e| e.to_string());
  match request {
    Request::Hello(_) => Err("hello ซ้ำ".into()),
    Request::Spawn { key, cwd, cols, rows, run, env, stream } => {
      let env = env.unwrap_or_default();
      let spec = ShellSpec { cwd: Path::new(&cwd), cols, rows, run: run.as_deref(), env: &env };
      let attached = host.open(&key, &spec, sink(tx, closed, &key, stream))?;
      if attached.spawned {
        log(format!("terminal {key} started in {cwd}"));
      }
      json(serde_json::to_value(attached))
    }
    Request::Attach { key, cols, rows, stream } => {
      validate_key(&key)?;
      json(serde_json::to_value(host.attach(&key, cols.zip(rows), sink(tx, closed, &key, stream))))
    }
    Request::Write { key, data } => host.write(&key, data.as_bytes()).map(|()| Value::Null),
    Request::Resize { key, cols, rows } => host.resize(&key, cols, rows).map(|()| Value::Null),
    Request::Kill { key } => {
      let killed = host.kill(&key);
      if killed {
        log(format!("terminal {key} killed"));
      }
      Ok(Value::Bool(killed))
    }
    Request::KillAll {} => {
      let n = host.kill_all();
      log(format!("killed all {n} terminals"));
      Ok(Value::from(n))
    }
    Request::List {} => json(serde_json::to_value(host.list())),
  }
}

/// Options for `kingu-ptyd` (the app passes `--dir`; the rest are for tests and debugging).
pub fn parse_args(args: impl IntoIterator<Item = String>, version: &str) -> Result<Config, String> {
  let mut dir = None;
  let mut name = crate::protocol::socket_name();
  let mut idle = Duration::from_secs(30 * 60);
  let mut it = args.into_iter();
  while let Some(a) = it.next() {
    let mut value = || it.next().ok_or(format!("{a} ต้องมีค่า"));
    match a.as_str() {
      "--dir" => dir = Some(PathBuf::from(value()?)),
      "--name" => name = value()?,
      "--idle-minutes" => idle = Duration::from_secs(value()?.parse::<u64>().map_err(|e| e.to_string())? * 60),
      "--idle-seconds" => idle = Duration::from_secs(value()?.parse::<u64>().map_err(|e| e.to_string())?),
      _ => return Err(format!("ไม่รู้จัก argument {a}")),
    }
  }
  if name.is_empty() || name.contains('/') || name.starts_with('.') {
    return Err(format!("ชื่อ socket ไม่ถูกต้อง: {name:?}"));
  }
  let dir = dir.ok_or("ต้องระบุ --dir")?;
  if !dir.is_absolute() {
    return Err("--dir ต้องเป็น absolute path".into());
  }
  Ok(Config { dir, name, idle, version: version.to_string() })
}

#[cfg(test)]
mod tests {
  use std::time::Duration;

  use super::parse_args;

  #[test]
  fn parses_daemon_arguments() {
    let args = |a: &[&str]| parse_args(a.iter().map(|s| s.to_string()), "0.1.0");
    let cfg = args(&["--dir", "/tmp/k"]).unwrap();
    assert_eq!(cfg.idle, Duration::from_secs(1800));
    assert_eq!(cfg.name, crate::protocol::socket_name());
    assert_eq!(args(&["--dir", "/tmp/k", "--idle-minutes", "2"]).unwrap().idle, Duration::from_secs(120));
    assert_eq!(args(&["--dir", "/tmp/k", "--idle-seconds", "3", "--name", "x.sock"]).unwrap().name, "x.sock");
    assert!(args(&[]).is_err());
    assert!(args(&["--dir", "rel"]).is_err());
    assert!(args(&["--dir", "/tmp/k", "--name", "../x"]).is_err());
    assert!(args(&["--dir", "/tmp/k", "--bogus"]).is_err());
    assert!(args(&["--dir"]).is_err());
  }
}
