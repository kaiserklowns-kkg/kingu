//! Language servers (VS Code gets these from extensions): one child process per language,
//! spawned on demand without a shell, speaking JSON-RPC over stdio with `Content-Length`
//! framing. Messages are passed through to the webview untouched; the LSP client lives there.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use tauri::State;
use tauri::ipc::Channel;

/// Server → webview traffic.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LspEvent {
  /// One JSON-RPC message, as the server sent it.
  Message { json: String },
  Stderr { line: String },
  Exit { code: Option<i32> },
}

pub type Sink = Arc<dyn Fn(LspEvent) + Send + Sync>;

// ---------------------------------------------------------------------------------------------
// Framing

/// Wraps one JSON-RPC message in an LSP base-protocol frame.
pub fn encode(json: &str) -> Vec<u8> {
  let mut out = format!("Content-Length: {}\r\n\r\n", json.len()).into_bytes();
  out.extend_from_slice(json.as_bytes());
  out
}

/// Incremental decoder for `Content-Length` frames: feed it whatever a read returned and take
/// out every complete message. Lengths are in bytes, so multi-byte UTF-8 content is fine.
#[derive(Default)]
pub struct FrameDecoder {
  buf: Vec<u8>,
}

const MAX_FRAME: usize = 256 * 1024 * 1024;

impl FrameDecoder {
  pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, String> {
    self.buf.extend_from_slice(bytes);
    let mut out = Vec::new();
    while let Some(header_end) = self.buf.windows(4).position(|w| w == b"\r\n\r\n") {
      let header = std::str::from_utf8(&self.buf[..header_end]).map_err(|_| "non-UTF-8 LSP header")?;
      let mut len = None;
      for line in header.split("\r\n") {
        if let Some((name, value)) = line.split_once(':')
          && name.trim().eq_ignore_ascii_case("content-length")
        {
          len = Some(value.trim().parse::<usize>().map_err(|_| format!("bad Content-Length: {value:?}"))?);
        }
      }
      let len = len.ok_or_else(|| format!("LSP header without Content-Length: {header:?}"))?;
      if len > MAX_FRAME {
        return Err(format!("LSP frame of {len} bytes is too large"));
      }
      let start = header_end + 4;
      if self.buf.len() < start + len {
        break;
      }
      out.push(String::from_utf8_lossy(&self.buf[start..start + len]).into_owned());
      self.buf.drain(..start + len);
    }
    Ok(out)
  }
}

// ---------------------------------------------------------------------------------------------
// Server table and binary resolution

#[derive(Debug, Clone, PartialEq)]
pub struct ServerSpec {
  /// Key shared by languages served by one process (`javascript` uses `typescript`).
  pub key: &'static str,
  /// Shown to the user, e.g. in "TypeScript language server not installed".
  pub display: &'static str,
  pub binary: &'static str,
  pub args: &'static [&'static str],
}

pub fn spec_for(language: &str) -> Option<ServerSpec> {
  Some(match language {
    "rust" => ServerSpec { key: "rust", display: "rust-analyzer", binary: "rust-analyzer", args: &[] },
    "typescript" | "javascript" | "typescriptreact" | "javascriptreact" => ServerSpec {
      key: "typescript",
      display: "TypeScript language server",
      binary: "typescript-language-server",
      args: &["--stdio"],
    },
    "go" => ServerSpec { key: "go", display: "gopls", binary: "gopls", args: &[] },
    _ => return None,
  })
}

/// Directories searched after PATH. A GUI app launched from Finder gets a minimal PATH, so the
/// usual per-user tool locations are added explicitly.
fn extra_dirs(home: Option<&Path>, root: &Path) -> Vec<PathBuf> {
  let mut dirs = Vec::new();
  if let Some(h) = home {
    dirs.push(h.join(".cargo/bin"));
    dirs.push(h.join("go/bin"));
  }
  dirs.push(root.join("node_modules/.bin"));
  dirs.push("/opt/homebrew/bin".into());
  dirs.push("/usr/local/bin".into());
  dirs
}

fn is_executable(p: &Path) -> bool {
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
  }
  #[cfg(not(unix))]
  {
    p.is_file()
  }
}

/// `KINGU_LSP_<KEY>` (a path to the server binary), else `binary` on `path` + the extra dirs.
pub fn resolve_binary(
  spec: &ServerSpec,
  override_var: Option<OsString>,
  path: Option<&OsStr>,
  home: Option<&Path>,
  root: &Path,
) -> Result<PathBuf, String> {
  if let Some(o) = override_var.filter(|o| !o.is_empty()) {
    let p = PathBuf::from(o);
    return if is_executable(&p) {
      Ok(p)
    } else {
      Err(format!("{} not installed: {} (from {}) is not an executable", spec.display, p.display(), override_name(spec)))
    };
  }
  let dirs = path.map(|p| std::env::split_paths(p).collect::<Vec<_>>()).unwrap_or_default();
  dirs
    .into_iter()
    .chain(extra_dirs(home, root))
    .map(|d| d.join(spec.binary))
    .find(|p| is_executable(p))
    .ok_or_else(|| format!("{} not installed ({} not found on PATH; set {} to its path)", spec.display, spec.binary, override_name(spec)))
}

pub fn override_name(spec: &ServerSpec) -> String {
  format!("KINGU_LSP_{}", spec.key.to_uppercase())
}

const ENV_ALLOWLIST: &[&str] = &[
  "PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME",
  "CARGO_HOME", "RUSTUP_HOME", "RUSTUP_TOOLCHAIN", "GOPATH", "GOROOT", "GOFLAGS", "GOCACHE",
  "GOMODCACHE", "GOPROXY", "NODE_PATH",
];

/// Allowlisted environment, with the server's own directory and `~/.cargo/bin` put on PATH so
/// rust-analyzer finds `cargo` and a Node-based server finds `node` next to it.
pub fn server_env(vars: impl IntoIterator<Item = (OsString, OsString)>, binary: &Path, home: Option<&Path>) -> Vec<(OsString, OsString)> {
  let mut env: Vec<_> = vars.into_iter().filter(|(k, _)| k.to_str().is_some_and(|k| ENV_ALLOWLIST.contains(&k))).collect();
  let mut path: Vec<PathBuf> = env.iter().find(|(k, _)| k == "PATH").map(|(_, v)| std::env::split_paths(v).collect()).unwrap_or_default();
  let mut add = |d: PathBuf| {
    if !path.contains(&d) {
      path.push(d);
    }
  };
  if let Some(dir) = binary.parent() {
    add(dir.to_path_buf());
  }
  if let Some(h) = home {
    add(h.join(".cargo/bin"));
  }
  for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
    add(d.into());
  }
  env.retain(|(k, _)| k != "PATH");
  if let Ok(joined) = std::env::join_paths(path) {
    env.push(("PATH".into(), joined));
  }
  env
}

// ---------------------------------------------------------------------------------------------
// Processes

struct Server {
  child: Mutex<Child>,
  pid: u32,
  /// Frames queued for the writer thread, so `lsp_send` never blocks on a full pipe.
  tx: mpsc::Sender<Vec<u8>>,
}

#[derive(Default)]
pub struct Servers {
  next_id: AtomicU32,
  running: Arc<Mutex<HashMap<u32, Arc<Server>>>>,
}

pub struct Launch {
  pub program: PathBuf,
  pub args: Vec<String>,
  pub cwd: PathBuf,
  pub env: Vec<(OsString, OsString)>,
}

#[cfg(unix)]
fn signal_group(pid: u32, sig: i32) {
  // The server leads its own process group, which also reaches `cargo check` and friends.
  unsafe {
    libc::kill(-(pid as i32), sig);
  }
}

impl Servers {
  pub fn start(&self, launch: Launch, sink: Sink) -> Result<u32, String> {
    let mut cmd = Command::new(&launch.program);
    cmd
      .args(&launch.args)
      .current_dir(&launch.cwd)
      .env_clear()
      .envs(launch.env)
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.spawn().map_err(|e| format!("{}: {e}", launch.program.display()))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let server = Arc::new(Server { pid: child.id(), child: Mutex::new(child), tx });
    self.running.lock().unwrap().insert(id, server.clone());

    std::thread::spawn(move || {
      for frame in rx {
        if stdin.write_all(&frame).and_then(|_| stdin.flush()).is_err() {
          break;
        }
      }
    });

    let err_sink = sink.clone();
    let stderr_thread = std::thread::spawn(move || {
      let mut r = BufReader::new(stderr);
      let mut line = Vec::new();
      while matches!(r.read_until(b'\n', &mut line), Ok(n) if n > 0) {
        err_sink(LspEvent::Stderr { line: String::from_utf8_lossy(&line).trim_end().to_owned() });
        line.clear();
      }
    });

    let running = self.running.clone();
    std::thread::spawn(move || {
      let mut decoder = FrameDecoder::default();
      let mut chunk = vec![0u8; 64 * 1024];
      loop {
        match stdout.read(&mut chunk) {
          Ok(0) | Err(_) => break,
          Ok(n) => match decoder.push(&chunk[..n]) {
            Ok(msgs) => msgs.into_iter().for_each(|json| sink(LspEvent::Message { json })),
            Err(e) => {
              log::error!("language server {id}: {e}");
              sink(LspEvent::Stderr { line: format!("kingu: {e}") });
              break;
            }
          },
        }
      }
      let _ = stderr_thread.join();
      let code = loop {
        match server.child.lock().unwrap().try_wait() {
          Ok(Some(s)) => break s.code(),
          Ok(None) => {}
          Err(_) => break None,
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
      };
      running.lock().unwrap().remove(&id);
      log::info!("language server {id} exited (code {code:?})");
      sink(LspEvent::Exit { code });
    });
    Ok(id)
  }

  pub fn send(&self, id: u32, json: &str) -> Result<(), String> {
    let server = self.running.lock().unwrap().get(&id).cloned().ok_or("no such language server")?;
    server.tx.send(encode(json)).map_err(|_| "language server input is closed".to_string())
  }

  /// Kills the server (the client sends `shutdown`/`exit` first when it can).
  pub fn stop(&self, id: u32) -> Result<(), String> {
    let server = self.running.lock().unwrap().get(&id).cloned().ok_or("no such language server")?;
    kill(&server);
    Ok(())
  }

  /// On app exit: nothing may outlive the window.
  pub fn stop_all(&self) {
    let all: Vec<_> = self.running.lock().unwrap().drain().map(|(_, s)| s).collect();
    for s in &all {
      kill(s);
    }
    if !all.is_empty() {
      log::info!("stopped {} language server(s)", all.len());
    }
  }

  #[cfg(test)]
  fn is_running(&self, id: u32) -> bool {
    self.running.lock().unwrap().contains_key(&id)
  }
}

fn kill(server: &Server) {
  #[cfg(unix)]
  signal_group(server.pid, libc::SIGKILL);
  #[cfg(not(unix))]
  let _ = server.pid;
  let _ = server.child.lock().unwrap().kill();
}

// ---------------------------------------------------------------------------------------------
// Commands

/// Starts the server for `language`; its messages stream over `on_event`. Fails with
/// "<server> not installed (…)" when the binary cannot be found.
pub fn start_for(servers: &Servers, root: &Path, language: &str, on_event: Channel<LspEvent>) -> Result<u32, String> {
  let spec = spec_for(language).ok_or_else(|| format!("no language server for {language}"))?;
  let home = std::env::var_os("HOME").map(PathBuf::from);
  let program = resolve_binary(&spec, std::env::var_os(override_name(&spec)), std::env::var_os("PATH").as_deref(), home.as_deref(), root)?;
  let env = server_env(std::env::vars_os(), &program, home.as_deref());
  let launch = Launch { program: program.clone(), args: spec.args.iter().map(|s| s.to_string()).collect(), cwd: root.to_path_buf(), env };
  let id = servers.start(
    launch,
    Arc::new(move |ev| {
      let _ = on_event.send(ev);
    }),
  )?;
  log::info!("language server {id} started for {language}: {}", program.display());
  Ok(id)
}

#[tauri::command]
pub fn lsp_send(servers: State<'_, Servers>, id: u32, message: String) -> Result<(), String> {
  servers.send(id, &message)
}

#[tauri::command]
pub fn lsp_stop(servers: State<'_, Servers>, id: u32) -> Result<(), String> {
  servers.stop(id)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn encodes_byte_lengths() {
    let frame = encode(r#"{"a":"ก"}"#);
    assert_eq!(frame, "Content-Length: 11\r\n\r\n{\"a\":\"ก\"}".as_bytes());
  }

  #[test]
  fn decodes_split_and_partial_frames() {
    let bytes = encode(r#"{"jsonrpc":"2.0","id":1}"#);
    let mut d = FrameDecoder::default();
    // Every split point, including inside the header and its terminator.
    for cut in 0..bytes.len() {
      let mut d2 = FrameDecoder::default();
      let mut got = d2.push(&bytes[..cut]).unwrap();
      assert!(got.is_empty(), "cut {cut}");
      got.extend(d2.push(&bytes[cut..]).unwrap());
      assert_eq!(got, [r#"{"jsonrpc":"2.0","id":1}"#], "cut {cut}");
    }
    // Byte at a time.
    let mut got = Vec::new();
    for b in &bytes {
      got.extend(d.push(std::slice::from_ref(b)).unwrap());
    }
    assert_eq!(got.len(), 1);
  }

  #[test]
  fn decodes_several_messages_in_one_read() {
    let mut bytes = encode("{\"id\":1}");
    bytes.extend(encode("{\"id\":2}"));
    bytes.extend(&encode("{\"id\":3}")[..5]);
    let mut d = FrameDecoder::default();
    assert_eq!(d.push(&bytes).unwrap(), ["{\"id\":1}", "{\"id\":2}"]);
    assert_eq!(d.push(&encode("{\"id\":3}")[5..]).unwrap(), ["{\"id\":3}"]);
  }

  #[test]
  fn counts_multibyte_utf8_in_bytes_even_when_cut_mid_character() {
    let json = r#"{"message":"ตัวแปร x ไม่ได้ใช้ 🦀"}"#;
    let bytes = encode(json);
    let mid = bytes.len() - 3; // inside the 4-byte crab
    let mut d = FrameDecoder::default();
    assert!(d.push(&bytes[..mid]).unwrap().is_empty());
    assert_eq!(d.push(&bytes[mid..]).unwrap(), [json]);
  }

  #[test]
  fn accepts_extra_headers_in_any_case() {
    let raw = b"content-length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}";
    assert_eq!(FrameDecoder::default().push(raw).unwrap(), ["{}"]);
  }

  #[test]
  fn rejects_a_header_without_length() {
    assert!(FrameDecoder::default().push(b"Content-Type: x\r\n\r\n{}").unwrap_err().contains("Content-Length"));
    assert!(FrameDecoder::default().push(b"Content-Length: nope\r\n\r\n").is_err());
  }

  #[test]
  fn maps_languages_to_servers() {
    assert_eq!(spec_for("rust").unwrap().binary, "rust-analyzer");
    assert_eq!(spec_for("javascript").unwrap().key, "typescript");
    assert_eq!(spec_for("typescript").unwrap().args, ["--stdio"]);
    assert_eq!(spec_for("go").unwrap().binary, "gopls");
    assert!(spec_for("markdown").is_none());
    assert_eq!(override_name(&spec_for("typescript").unwrap()), "KINGU_LSP_TYPESCRIPT");
  }

  #[cfg(unix)]
  fn fake_bin(dir: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let p = dir.join(name);
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
  }

  #[cfg(unix)]
  #[test]
  fn resolves_from_path_home_and_override() {
    let tmp = tempfile::tempdir().unwrap();
    let (bin, home, root) = (tmp.path().join("bin"), tmp.path().join("home"), tmp.path().join("ws"));
    for d in [&bin, &home.join(".cargo/bin"), &root] {
      std::fs::create_dir_all(d).unwrap();
    }
    let rust = spec_for("rust").unwrap();
    let ts = spec_for("typescript").unwrap();
    let ra = fake_bin(&home.join(".cargo/bin"), "rust-analyzer", "");
    assert_eq!(resolve_binary(&rust, None, Some(bin.as_os_str()), Some(&home), &root).unwrap(), ra);
    let on_path = fake_bin(&bin, "rust-analyzer", "");
    assert_eq!(resolve_binary(&rust, None, Some(bin.as_os_str()), Some(&home), &root).unwrap(), on_path);

    let err = resolve_binary(&ts, None, Some(bin.as_os_str()), Some(&home), &root).unwrap_err();
    assert!(err.starts_with("TypeScript language server not installed"), "{err}");
    assert!(err.contains("KINGU_LSP_TYPESCRIPT"), "{err}");

    let custom = fake_bin(tmp.path(), "my-tsls", "");
    assert_eq!(resolve_binary(&ts, Some(custom.clone().into()), None, None, &root).unwrap(), custom);
    assert!(resolve_binary(&ts, Some("/nonexistent/tsls".into()), None, None, &root).unwrap_err().contains("not installed"));
  }

  #[test]
  fn server_env_is_filtered_and_extends_path() {
    let env = server_env(
      [("PATH".into(), "/usr/bin".into()), ("GITHUB_TOKEN".into(), "t".into()), ("CARGO_HOME".into(), "/c".into())],
      Path::new("/opt/tools/bin/gopls"),
      Some(Path::new("/h")),
    );
    let keys: Vec<_> = env.iter().map(|(k, _)| k.to_str().unwrap()).collect();
    assert_eq!(keys, ["CARGO_HOME", "PATH"]);
    let path: Vec<_> = std::env::split_paths(&env[1].1).collect();
    assert_eq!(path[0], Path::new("/usr/bin"));
    assert!(path.contains(&PathBuf::from("/opt/tools/bin")));
    assert!(path.contains(&PathBuf::from("/h/.cargo/bin")));
  }

  fn collect() -> (Sink, mpsc::Receiver<LspEvent>) {
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    (Arc::new(move |ev| tx.lock().unwrap().send(ev).unwrap()), rx)
  }

  fn recv(rx: &mpsc::Receiver<LspEvent>, secs: u64) -> LspEvent {
    rx.recv_timeout(std::time::Duration::from_secs(secs)).expect("no event from language server in time")
  }

  /// A shell "server" that echoes framed stdin back: exercises both directions of framing.
  #[cfg(unix)]
  #[test]
  fn round_trips_through_an_echo_server() {
    let tmp = tempfile::tempdir().unwrap();
    let cat = fake_bin(tmp.path(), "echo-server", "echo starting >&2\nexec cat");
    let servers = Servers::default();
    let (sink, rx) = collect();
    let launch = Launch { program: cat, args: vec![], cwd: tmp.path().into(), env: vec![("PATH".into(), "/usr/bin:/bin".into())] };
    let id = servers.start(launch, sink).unwrap();
    servers.send(id, r#"{"jsonrpc":"2.0","method":"a","params":"สวัสดี"}"#).unwrap();
    servers.send(id, r#"{"jsonrpc":"2.0","method":"b"}"#).unwrap();
    let mut msgs = Vec::new();
    while msgs.len() < 2 {
      match recv(&rx, 10) {
        LspEvent::Message { json } => msgs.push(json),
        LspEvent::Stderr { line } => assert_eq!(line, "starting"),
        ev => panic!("{ev:?}"),
      }
    }
    assert_eq!(msgs, [r#"{"jsonrpc":"2.0","method":"a","params":"สวัสดี"}"#, r#"{"jsonrpc":"2.0","method":"b"}"#]);
    servers.stop(id).unwrap();
    loop {
      if let LspEvent::Exit { .. } = recv(&rx, 10) {
        break;
      }
    }
    assert!(!servers.is_running(id));
    assert!(servers.send(id, "{}").is_err());
  }

  #[cfg(unix)]
  #[test]
  fn stop_all_kills_every_server() {
    let tmp = tempfile::tempdir().unwrap();
    let sleeper = fake_bin(tmp.path(), "sleeper", "exec sleep 30");
    let servers = Servers::default();
    let (sink, rx) = collect();
    for _ in 0..2 {
      let launch = Launch { program: sleeper.clone(), args: vec![], cwd: tmp.path().into(), env: vec![("PATH".into(), "/usr/bin:/bin".into())] };
      servers.start(launch, sink.clone()).unwrap();
    }
    servers.stop_all();
    let exits = (0..2).filter(|_| loop {
      if let LspEvent::Exit { .. } = recv(&rx, 10) {
        break true;
      }
    });
    assert_eq!(exits.count(), 2);
  }

  /// Runs the real rust-analyzer against a tiny Cargo project: initialize, didOpen, then wait for
  /// both kinds of diagnostics it produces — native ones answered to a `textDocument/diagnostic`
  /// pull, and `cargo check` ones pushed with `publishDiagnostics`. Skipped without rust-analyzer.
  #[test]
  fn rust_analyzer_publishes_diagnostics() {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let spec = spec_for("rust").unwrap();
    let Ok(program) = resolve_binary(&spec, std::env::var_os(override_name(&spec)), std::env::var_os("PATH").as_deref(), home.as_deref(), &root) else {
      eprintln!("rust-analyzer not installed; skipping");
      return;
    };
    // rustup's proxy is installed even without the component; make sure it actually runs.
    if !Command::new(&program).arg("--version").output().is_ok_and(|o| o.status.success()) {
      eprintln!("rust-analyzer does not run; skipping");
      return;
    }
    std::fs::create_dir(root.join("src")).unwrap();
    std::fs::write(root.join("Cargo.toml"), "[package]\nname = \"lsp_probe\"\nversion = \"0.1.0\"\nedition = \"2021\"\n").unwrap();
    // Line 1 for rust-analyzer itself; line 2 for rustc (a type error rust-analyzer does not report by default).
    let source = "// ข้อความ\nmod nowhere;\nfn main() { let _x: i32 = \"s\"; }\n";
    std::fs::write(root.join("src/main.rs"), source).unwrap();

    let servers = Servers::default();
    let (sink, rx) = collect();
    let env = server_env(std::env::vars_os(), &program, home.as_deref());
    let id = servers.start(Launch { program, args: vec![], cwd: root.clone(), env }, sink).unwrap();
    let send = |v: serde_json::Value| servers.send(id, &v.to_string()).unwrap();
    let root_uri = format!("file://{}", root.display());
    let file_uri = format!("{root_uri}/src/main.rs");
    send(serde_json::json!({
      "jsonrpc": "2.0", "id": "init", "method": "initialize",
      "params": {
        "processId": std::process::id(), "rootUri": root_uri,
        "workspaceFolders": [{ "uri": root_uri, "name": "probe" }],
        "capabilities": {
          "textDocument": { "publishDiagnostics": {}, "diagnostic": {} },
          "window": { "workDoneProgress": true },
          "experimental": { "serverStatusNotification": true },
          "general": { "positionEncodings": ["utf-16"] }
        }
      }
    }));

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(240);
    let (mut native, mut checked) = (None, None);
    while native.is_none() || checked.is_none() {
      let left = deadline.saturating_duration_since(std::time::Instant::now());
      assert!(!left.is_zero(), "rust-analyzer: diagnostics not in time (native {native:?}, cargo check {checked:?})");
      let LspEvent::Message { json } = recv(&rx, left.as_secs() + 1) else { continue };
      let msg: serde_json::Value = serde_json::from_str(&json).unwrap();
      if msg["id"] == "init" {
        assert_eq!(msg["result"]["capabilities"]["positionEncoding"], "utf-16");
        send(serde_json::json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }));
        send(serde_json::json!({
          "jsonrpc": "2.0", "method": "textDocument/didOpen",
          "params": { "textDocument": { "uri": file_uri, "languageId": "rust", "version": 1, "text": source } }
        }));
      } else if msg["id"] == "pull" {
        native = msg["result"]["items"].as_array().and_then(|a| a.first()).cloned();
      } else if msg.get("id").is_some() && msg.get("method").is_some() {
        // window/workDoneProgress/create, workspace/diagnostic/refresh, …
        send(serde_json::json!({ "jsonrpc": "2.0", "id": msg["id"], "result": null }));
      } else if msg["method"] == "experimental/serverStatus" && msg["params"]["quiescent"] == true && native.is_none() {
        send(serde_json::json!({ "jsonrpc": "2.0", "id": "pull", "method": "textDocument/diagnostic", "params": { "textDocument": { "uri": file_uri } } }));
      } else if msg["method"] == "textDocument/publishDiagnostics" && msg["params"]["uri"] == file_uri.as_str() {
        checked = checked.or_else(|| msg["params"]["diagnostics"].as_array().and_then(|a| a.first()).cloned());
      }
    }
    let (native, checked) = (native.unwrap(), checked.unwrap());
    assert_eq!(native["range"]["end"], serde_json::json!({ "line": 1, "character": 12 }), "{native}");
    assert!(native["message"].as_str().unwrap_or_default().contains("nowhere"), "{native}");
    assert!(checked["range"]["start"]["line"].as_u64().is_some(), "{checked}");
    servers.stop(id).unwrap();
  }
  /// rust-analyzer over the real transport: prepareRename + rename (a WorkspaceEdit with
  /// `documentChanges`) and document formatting on a file with Thai text before the symbol.
  /// Skipped without rust-analyzer; formatting is skipped when rustfmt is unavailable.
  #[test]
  fn rust_analyzer_renames_and_formats() {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let spec = spec_for("rust").unwrap();
    let Ok(program) = resolve_binary(&spec, std::env::var_os(override_name(&spec)), std::env::var_os("PATH").as_deref(), home.as_deref(), &root) else {
      eprintln!("rust-analyzer not installed; skipping");
      return;
    };
    if !Command::new(&program).arg("--version").output().is_ok_and(|o| o.status.success()) {
      eprintln!("rust-analyzer does not run; skipping");
      return;
    }
    std::fs::create_dir(root.join("src")).unwrap();
    std::fs::write(root.join("Cargo.toml"), "[package]\nname = \"lsp_rename\"\nversion = \"0.1.0\"\nedition = \"2021\"\n").unwrap();
    // `helper` on line 1 sits after a Thai string and an emoji: UTF-16 character 31.
    let source = "fn main() { let _x = helper(); }\nconst S: &str = \"สวัสดี🦀\"; fn helper() -> i32 { 1 }\n";
    std::fs::write(root.join("src/main.rs"), source).unwrap();

    let servers = Servers::default();
    let (sink, rx) = collect();
    let env = server_env(std::env::vars_os(), &program, home.as_deref());
    let id = servers.start(Launch { program, args: vec![], cwd: root.clone(), env }, sink).unwrap();
    let send = |v: serde_json::Value| servers.send(id, &v.to_string()).unwrap();
    let root_uri = format!("file://{}", root.display());
    let file_uri = format!("{root_uri}/src/main.rs");
    send(serde_json::json!({
      "jsonrpc": "2.0", "id": "init", "method": "initialize",
      "params": {
        "processId": std::process::id(), "rootUri": root_uri,
        "workspaceFolders": [{ "uri": root_uri, "name": "probe" }],
        "capabilities": {
          "workspace": { "workspaceEdit": { "documentChanges": true } },
          "textDocument": { "rename": { "prepareSupport": true } },
          "window": { "workDoneProgress": true },
          "experimental": { "serverStatusNotification": true },
          "general": { "positionEncodings": ["utf-16"] }
        }
      }
    }));
    let at = serde_json::json!({ "textDocument": { "uri": file_uri }, "position": { "line": 1, "character": 33 } });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(240);
    let (mut prepared, mut renamed, mut formatted, mut asked) = (None, None, None, false);
    while prepared.is_none() || renamed.is_none() || formatted.is_none() {
      let left = deadline.saturating_duration_since(std::time::Instant::now());
      assert!(!left.is_zero(), "rust-analyzer: no rename in time ({prepared:?}, {renamed:?})");
      let LspEvent::Message { json } = recv(&rx, left.as_secs() + 1) else { continue };
      let msg: serde_json::Value = serde_json::from_str(&json).unwrap();
      if msg["id"] == "init" {
        send(serde_json::json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }));
        send(serde_json::json!({
          "jsonrpc": "2.0", "method": "textDocument/didOpen",
          "params": { "textDocument": { "uri": file_uri, "languageId": "rust", "version": 1, "text": source } }
        }));
      } else if msg["id"] == "prepare" {
        prepared = Some(msg["result"].clone());
      } else if msg["id"] == "rename" {
        renamed = Some(msg["result"].clone());
      } else if msg["id"] == "format" {
        formatted = Some(msg.get("error").map_or_else(|| msg["result"].clone(), |_| serde_json::Value::Null));
      } else if msg.get("id").is_some() && msg.get("method").is_some() {
        send(serde_json::json!({ "jsonrpc": "2.0", "id": msg["id"], "result": null }));
      } else if msg["method"] == "experimental/serverStatus" && msg["params"]["quiescent"] == true && !asked {
        asked = true;
        send(serde_json::json!({ "jsonrpc": "2.0", "id": "prepare", "method": "textDocument/prepareRename", "params": at }));
        let mut params = at.clone();
        params["newName"] = "assist".into();
        send(serde_json::json!({ "jsonrpc": "2.0", "id": "rename", "method": "textDocument/rename", "params": params }));
        let options = serde_json::json!({ "tabSize": 4, "insertSpaces": true });
        send(serde_json::json!({ "jsonrpc": "2.0", "id": "format", "method": "textDocument/formatting", "params": { "textDocument": { "uri": file_uri }, "options": options } }));
      }
    }
    let prepared = prepared.unwrap();
    let range = prepared.get("range").unwrap_or(&prepared);
    assert_eq!(range["start"], serde_json::json!({ "line": 1, "character": 31 }), "{prepared}");
    assert_eq!(range["end"], serde_json::json!({ "line": 1, "character": 37 }), "{prepared}");
    let renamed = renamed.unwrap();
    let edits = renamed["documentChanges"][0]["edits"].as_array().cloned().unwrap_or_default();
    assert_eq!(renamed["documentChanges"][0]["textDocument"]["uri"], file_uri.as_str(), "{renamed}");
    assert_eq!(edits.len(), 2, "{renamed}");
    assert!(edits.iter().all(|e| e["newText"] == "assist"), "{renamed}");
    match formatted.unwrap() {
      serde_json::Value::Array(edits) => assert!(!edits.is_empty(), "rustfmt should reflow `fn main() {{ … }}`"),
      _ => eprintln!("formatting unavailable (rustfmt missing?); skipped"),
    }
    servers.stop(id).unwrap();
  }
}
