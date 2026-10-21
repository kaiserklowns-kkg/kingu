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

use crate::i18n::msg::LspMsg;
use crate::tr;
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

/// How a server can be installed; [`install_methods`] keeps those whose tool is on this machine.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Package {
  /// npm packages (space-separated), installed globally with bun or npm.
  Npm(&'static str),
  /// A `go install` path.
  Go(&'static str),
  /// A rustup component.
  Rustup(&'static str),
  Brew(&'static str),
  /// A Python tool, installed with pipx or uv.
  PyTool(&'static str),
  /// `cargo install --locked` arguments (space-separated).
  Cargo(&'static str),
  /// A Python module (debugpy), installed into the user's python3 with pip.
  Pip(&'static str),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ServerSpec {
  /// Key shared by languages served by one process (`javascript` uses `typescript`).
  pub key: &'static str,
  /// Shown to the user, e.g. in "Not installed: TypeScript language server".
  pub display: &'static str,
  /// Executable names in order of preference (basedpyright before pyright).
  pub binaries: &'static [&'static str],
  pub args: &'static [&'static str],
  pub install: &'static [Package],
}

const LANGSERVERS_EXTRACTED: Package = Package::Npm("vscode-langservers-extracted");

/// Languages are Monaco language ids (see `src/lib/editor/languages.ts`). Built-in snaps' servers
/// (rust-analyzer, snap_builtin.rs) come first, then the table.
pub fn spec_for(language: &str) -> Option<ServerSpec> {
  use Package::*;
  if let Some(spec) = crate::snap_builtin::spec_for(language) {
    return Some(spec);
  }
  let spec = |key, display, binaries, args, install| ServerSpec { key, display, binaries, args, install };
  Some(match language {
    "typescript" | "javascript" | "typescriptreact" | "javascriptreact" => spec(
      "typescript",
      "TypeScript language server",
      &["typescript-language-server"],
      &["--stdio"],
      &[Npm("typescript-language-server typescript")],
    ),
    "go" => spec("go", "gopls", &["gopls"], &[], &[Go("golang.org/x/tools/gopls@latest"), Brew("gopls")]),
    "svelte" => spec("svelte", "Svelte language server", &["svelteserver"], &["--stdio"], &[Npm("svelte-language-server")]),
    "python" => spec(
      "python",
      "basedpyright",
      &["basedpyright-langserver", "pyright-langserver"],
      &["--stdio"],
      &[PyTool("basedpyright"), Npm("basedpyright")],
    ),
    "json" | "jsonc" => spec("json", "JSON language server", &["vscode-json-language-server"], &["--stdio"], &[LANGSERVERS_EXTRACTED]),
    "css" | "scss" | "less" => spec("css", "CSS language server", &["vscode-css-language-server"], &["--stdio"], &[LANGSERVERS_EXTRACTED]),
    "html" => spec("html", "HTML language server", &["vscode-html-language-server"], &["--stdio"], &[LANGSERVERS_EXTRACTED]),
    "yaml" => spec("yaml", "YAML language server", &["yaml-language-server"], &["--stdio"], &[Npm("yaml-language-server"), Brew("yaml-language-server")]),
    "toml" => spec("toml", "Taplo", &["taplo"], &["lsp", "stdio"], &[Brew("taplo"), Cargo("taplo-cli --features lsp")]),
    _ => return None,
  })
}

/// Directories searched after PATH. A GUI app launched from Finder gets a minimal PATH, so the
/// usual per-user tool locations are added explicitly, then the `node_modules/.bin` of each of
/// `roots` (VS Code finds a project-local server in every workspace folder; the folder a server
/// starts for comes first).
fn extra_dirs(home: Option<&Path>, roots: &[PathBuf]) -> Vec<PathBuf> {
  let mut dirs = Vec::new();
  if let Some(h) = home {
    dirs.push(h.join(".cargo/bin"));
    dirs.push(h.join("go/bin"));
    dirs.push(h.join(".bun/bin"));
    // pipx and `uv tool` install here; it is often missing from PATH until `pipx ensurepath`.
    dirs.push(h.join(".local/bin"));
  }
  dirs.extend(roots.iter().map(|r| r.join("node_modules/.bin")));
  dirs.push("/opt/homebrew/bin".into());
  dirs.push("/usr/local/bin".into());
  dirs
}

pub(crate) fn is_executable(p: &Path) -> bool {
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

/// `name` on `path`, else in the extra dirs. The bool is whether it came from `path`.
pub(crate) fn find_executable(name: &str, path: Option<&OsStr>, home: Option<&Path>, root: &Path) -> Option<(PathBuf, bool)> {
  find_executable_in(name, path, home, &[root.to_path_buf()])
}

/// [`find_executable`] looking in the `node_modules/.bin` of each of `roots`, in order.
pub(crate) fn find_executable_in(name: &str, path: Option<&OsStr>, home: Option<&Path>, roots: &[PathBuf]) -> Option<(PathBuf, bool)> {
  let on_path = path.map(|p| std::env::split_paths(p).collect::<Vec<_>>()).unwrap_or_default();
  if let Some(p) = on_path.iter().map(|d| d.join(name)).find(|p| is_executable(p)) {
    return Some((p, true));
  }
  extra_dirs(home, roots).into_iter().map(|d| d.join(name)).find(|p| is_executable(p)).map(|p| (p, false))
}

/// `KINGU_LSP_<KEY>` (a path to the server binary), else the first of `binaries` found on
/// `path` + the extra dirs.
pub fn resolve_binary(
  spec: &ServerSpec,
  override_var: Option<OsString>,
  path: Option<&OsStr>,
  home: Option<&Path>,
  roots: &[PathBuf],
) -> Result<PathBuf, String> {
  resolve_named(spec.display, spec.binaries, &override_name(spec), override_var, path, home, roots)
}

/// [`resolve_binary`] for a server described by its parts (a snap's language server, snap_lsp.rs).
pub fn resolve_named(display: &str, binaries: &[&str], var: &str, override_var: Option<OsString>, path: Option<&OsStr>, home: Option<&Path>, roots: &[PathBuf]) -> Result<PathBuf, String> {
  if let Some(o) = override_var.filter(|o| !o.is_empty()) {
    let p = PathBuf::from(o);
    return if is_executable(&p) { Ok(p) } else { Err(tr!(LspMsg::NotExecutable, name = display, path = p.display(), var)) };
  }
  binaries
    .iter()
    .find_map(|b| find_executable_in(b, path, home, roots))
    .map(|(p, _)| p)
    .ok_or_else(|| tr!(LspMsg::NotOnPath, name = display, binaries = binaries.join(&tr!(LspMsg::Or)), var))
}

pub fn override_name(spec: &ServerSpec) -> String {
  override_var_of(spec.key)
}

/// `KINGU_LSP_<KEY>`, anything but letters and digits as `_` (`zig/zls` → `KINGU_LSP_ZIG_ZLS`).
pub fn override_var_of(key: &str) -> String {
  format!("KINGU_LSP_{}", key.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' }).collect::<String>())
}

/// The server binary for `language` (a project-local one from the `node_modules/.bin` of
/// `roots`, first one first), or the "not installed" error (no process is started).
pub fn check(language: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
  let spec = spec_for(language).ok_or_else(|| tr!(LspMsg::NoServer, language))?;
  let home = std::env::var_os("HOME").map(PathBuf::from);
  resolve_binary(&spec, std::env::var_os(override_name(&spec)), crate::shell_env::path().as_deref(), home.as_deref(), roots)
}

/// `roots` with `first` moved to the front (the folder a per-folder server starts for).
pub fn roots_from(first: &Path, roots: &[PathBuf]) -> Vec<PathBuf> {
  std::iter::once(first.to_path_buf()).chain(roots.iter().filter(|r| r.as_path() != first).cloned()).collect()
}

// ---------------------------------------------------------------------------------------------
// Installing a missing server (VS Code installs an extension; Kingu runs the tool's own installer
// in a visible terminal, never silently)

/// Package managers Kingu knows how to drive.
pub const INSTALL_TOOLS: &[&str] = &["bun", "npm", "go", "rustup", "brew", "pipx", "uv", "cargo", "python3"];

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct InstallMethod {
  /// The package manager (`bun`, `brew`, …).
  pub tool: &'static str,
  /// Typed into a terminal; `argv[0]` is the tool, by name when the shell finds it on PATH.
  pub argv: Vec<String>,
}

/// The tools a kind of package installs with, in order of preference, and the words each puts
/// before the package's own.
pub type Installers = &'static [(&'static str, &'static [&'static str])];
pub const NPM: Installers = &[("bun", &["add", "-g"]), ("npm", &["i", "-g"])];
pub const GO: Installers = &[("go", &["install"])];
pub const RUSTUP: Installers = &[("rustup", &["component", "add"])];
pub const BREW: Installers = &[("brew", &["install"])];
pub const PYTOOL: Installers = &[("pipx", &["install"]), ("uv", &["tool", "install"])];
pub const CARGO: Installers = &[("cargo", &["install", "--locked"])];
pub const PIP: Installers = &[("python3", &["-m", "pip", "install", "--user"])];

fn installers(pkg: Package) -> (Installers, &'static str) {
  match pkg {
    Package::Npm(p) => (NPM, p),
    Package::Go(p) => (GO, p),
    Package::Rustup(c) => (RUSTUP, c),
    Package::Brew(f) => (BREW, f),
    Package::PyTool(p) => (PYTOOL, p),
    Package::Cargo(a) => (CARGO, a),
    Package::Pip(m) => (PIP, m),
  }
}

/// Install commands for `spec` in its order of preference, for the tools `program` knows
/// (`program(tool)` is what to put in `argv[0]`, `None` when the tool is absent).
pub fn install_methods(spec: &ServerSpec, program: impl Fn(&str) -> Option<String>) -> Vec<InstallMethod> {
  let packages: Vec<_> = spec.install.iter().map(|p| installers(*p)).collect();
  install_commands(packages.iter().map(|(i, w)| (*i, *w)), program)
}

/// [`install_methods`] for packages given as (installers, package words).
pub fn install_commands<'a>(packages: impl IntoIterator<Item = (Installers, &'a str)>, program: impl Fn(&str) -> Option<String>) -> Vec<InstallMethod> {
  let mut out = Vec::new();
  for (installers, words) in packages {
    for &(tool, head) in installers {
      debug_assert!(INSTALL_TOOLS.contains(&tool));
      if let Some(prog) = program(tool) {
        let argv = std::iter::once(prog).chain(head.iter().map(|s| s.to_string())).chain(words.split_whitespace().map(String::from)).collect();
        out.push(InstallMethod { tool, argv });
      }
    }
  }
  out
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct InstallInfo {
  pub server: &'static str,
  pub binary: &'static str,
  pub methods: Vec<InstallMethod>,
}

/// Install commands for the server of `language` usable on this machine (login-shell PATH).
pub fn install_info(language: &str, roots: &[PathBuf]) -> Result<InstallInfo, String> {
  let spec = spec_for(language).ok_or_else(|| tr!(LspMsg::NoServer, language))?;
  let methods = install_methods(&spec, tool_program(roots));
  Ok(InstallInfo { server: spec.display, binary: spec.binaries[0], methods })
}

/// What `argv[0]` of an install command is: the tool by name when the terminal's shell will find
/// it on the login-shell PATH, otherwise its full path; `None` when this machine lacks it.
pub fn tool_program(roots: &[PathBuf]) -> impl Fn(&str) -> Option<String> {
  let home = std::env::var_os("HOME").map(PathBuf::from);
  let path = crate::shell_env::path();
  let roots = roots.to_vec();
  move |tool| find_executable_in(tool, path.as_deref(), home.as_deref(), &roots).map(|(p, on_path)| if on_path { tool.to_string() } else { p.to_string_lossy().into_owned() })
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
  /// The window that started each server (a window's folder switch or close stops only its own).
  owners: Mutex<HashMap<u32, String>>,
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

  /// Records the window that started server `id`.
  pub fn own(&self, id: u32, window: &str) {
    self.owners.lock().unwrap().insert(id, window.to_string());
  }

  /// A window switched folders or closed: its servers go (the other windows' keep running).
  pub fn stop_window(&self, window: &str) {
    let ids: Vec<u32> = {
      let mut owners = self.owners.lock().unwrap();
      let ids = owners.iter().filter(|(_, w)| *w == window).map(|(id, _)| *id).collect::<Vec<_>>();
      owners.retain(|_, w| w != window);
      ids
    };
    let gone: Vec<_> = {
      let mut running = self.running.lock().unwrap();
      ids.iter().filter_map(|id| running.remove(id)).collect()
    };
    for s in &gone {
      kill(s);
    }
    if !gone.is_empty() {
      log::info!("stopped {} language server(s) of window {window}", gone.len());
    }
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
/// "Not installed: <server> (…)" (`LspMsg::NotOnPath`) when the binary cannot be found.
/// It runs in `cwd`; a project-local binary is looked for in each of `roots`, in order.
pub fn start_for(servers: &Servers, cwd: &Path, roots: &[PathBuf], language: &str, on_event: Channel<LspEvent>) -> Result<u32, String> {
  let spec = spec_for(language).ok_or_else(|| tr!(LspMsg::NoServer, language))?;
  let cwd = cwd.to_path_buf();
  let home = std::env::var_os("HOME").map(PathBuf::from);
  let program = check(language, roots)?;
  let env = server_env(crate::shell_env::vars_os(), &program, home.as_deref());
  let launch = Launch { program: program.clone(), args: spec.args.iter().map(|s| s.to_string()).collect(), cwd, env };
  let id = start_launch(servers, launch, on_event)?;
  log::info!("language server {id} started for {language}: {}", program.display());
  Ok(id)
}

/// Starts `launch` with its messages going to `on_event`.
pub fn start_launch(servers: &Servers, launch: Launch, on_event: Channel<LspEvent>) -> Result<u32, String> {
  servers.start(
    launch,
    Arc::new(move |ev| {
      let _ = on_event.send(ev);
    }),
  )
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
    let s = |l: &str| spec_for(l).unwrap_or_else(|| panic!("no spec for {l}"));
    // (language, key, binaries, args)
    let table: &[(&str, &str, &[&str], &[&str])] = &[
      ("rust", "rust", &["rust-analyzer"], &[]),
      ("typescript", "typescript", &["typescript-language-server"], &["--stdio"]),
      ("javascript", "typescript", &["typescript-language-server"], &["--stdio"]),
      ("go", "go", &["gopls"], &[]),
      ("svelte", "svelte", &["svelteserver"], &["--stdio"]),
      ("python", "python", &["basedpyright-langserver", "pyright-langserver"], &["--stdio"]),
      ("json", "json", &["vscode-json-language-server"], &["--stdio"]),
      ("jsonc", "json", &["vscode-json-language-server"], &["--stdio"]),
      ("css", "css", &["vscode-css-language-server"], &["--stdio"]),
      ("scss", "css", &["vscode-css-language-server"], &["--stdio"]),
      ("less", "css", &["vscode-css-language-server"], &["--stdio"]),
      ("html", "html", &["vscode-html-language-server"], &["--stdio"]),
      ("yaml", "yaml", &["yaml-language-server"], &["--stdio"]),
      ("toml", "toml", &["taplo"], &["lsp", "stdio"]),
    ];
    for &(lang, key, binaries, args) in table {
      let spec = s(lang);
      assert_eq!((spec.key, spec.binaries, spec.args), (key, binaries, args), "{lang}");
      assert!(!spec.install.is_empty(), "{lang} has no install method");
    }
    for none in ["markdown", "plaintext", "ini", "sql", "shell"] {
      assert!(spec_for(none).is_none(), "{none}");
    }
    assert_eq!(override_name(&s("typescript")), "KINGU_LSP_TYPESCRIPT");
    assert_eq!(override_name(&s("scss")), "KINGU_LSP_CSS");
  }

  #[cfg(unix)]
  fn fake_bin(dir: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let p = dir.join(name);
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
  }

  /// A spec whose binary cannot exist on any machine, so "not found" does not depend on what
  /// is installed in /opt/homebrew/bin.
  const MISSING: ServerSpec = ServerSpec { key: "missing", display: "Missing server", binaries: &["kingu-test-no-such-server"], args: &[], install: &[] };

  #[cfg(unix)]
  #[test]
  fn resolves_from_path_home_and_override() {
    let tmp = tempfile::tempdir().unwrap();
    let (bin, home, root) = (tmp.path().join("bin"), tmp.path().join("home"), tmp.path().join("ws"));
    for d in [&bin, &home.join(".cargo/bin"), &root] {
      std::fs::create_dir_all(d).unwrap();
    }
    let rust = spec_for("rust").unwrap();
    let ra = fake_bin(&home.join(".cargo/bin"), "rust-analyzer", "");
    assert_eq!(resolve_binary(&rust, None, Some(bin.as_os_str()), Some(&home), &[root.clone()]).unwrap(), ra);
    let on_path = fake_bin(&bin, "rust-analyzer", "");
    assert_eq!(resolve_binary(&rust, None, Some(bin.as_os_str()), Some(&home), &[root.clone()]).unwrap(), on_path);

    let err = resolve_binary(&MISSING, None, Some(bin.as_os_str()), Some(&home), &[root.clone()]).unwrap_err();
    assert!(err.starts_with("Not installed: Missing server"), "{err}");
    assert!(err.starts_with("Not installed:"), "{err}");
    assert!(err.contains("kingu-test-no-such-server") && err.contains("KINGU_LSP_MISSING"), "{err}");

    let custom = fake_bin(tmp.path(), "my-server", "");
    assert_eq!(resolve_binary(&MISSING, Some(custom.clone().into()), None, None, &[root.clone()]).unwrap(), custom);
    assert!(resolve_binary(&MISSING, Some("/nonexistent/srv".into()), None, None, &[root.clone()]).unwrap_err().starts_with("Not installed:"));
  }

  #[cfg(unix)]
  #[test]
  fn resolves_every_new_server_from_fake_binaries() {
    let tmp = tempfile::tempdir().unwrap();
    let (bin, root) = (tmp.path().join("bin"), tmp.path().join("ws"));
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(root.join("node_modules/.bin")).unwrap();
    for lang in ["svelte", "python", "json", "css", "html", "yaml", "toml"] {
      let spec = spec_for(lang).unwrap();
      let fake = fake_bin(&bin, spec.binaries[0], "");
      assert_eq!(resolve_binary(&spec, None, Some(bin.as_os_str()), None, &[root.clone()]).unwrap(), fake, "{lang}");
    }
    // A project-local install (node_modules/.bin) is found when PATH has none.
    let local = fake_bin(&root.join("node_modules/.bin"), "svelteserver", "");
    let empty = tmp.path().join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    assert_eq!(resolve_binary(&spec_for("svelte").unwrap(), None, Some(empty.as_os_str()), None, &[root.clone()]).unwrap(), local);
  }

  #[cfg(unix)]
  #[test]
  fn finds_project_local_servers_in_every_root_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let (a, b, empty) = (tmp.path().join("a"), tmp.path().join("b"), tmp.path().join("empty"));
    for d in [&empty, &a.join("node_modules/.bin"), &b.join("node_modules/.bin")] {
      std::fs::create_dir_all(d).unwrap();
    }
    let spec = spec_for("svelte").unwrap();
    // Only the second folder has it: still found.
    let in_b = fake_bin(&b.join("node_modules/.bin"), "svelteserver", "");
    let roots = [a.clone(), b.clone()];
    assert_eq!(resolve_binary(&spec, None, Some(empty.as_os_str()), None, &roots).unwrap(), in_b);
    // Both have it: the folder the server starts for wins.
    let in_a = fake_bin(&a.join("node_modules/.bin"), "svelteserver", "");
    assert_eq!(resolve_binary(&spec, None, Some(empty.as_os_str()), None, &roots).unwrap(), in_a);
    assert_eq!(resolve_binary(&spec, None, Some(empty.as_os_str()), None, &roots_from(&b, &roots)).unwrap(), in_b);
    assert_eq!(roots_from(&b, &roots), vec![b.clone(), a.clone()]);
  }

  #[cfg(unix)]
  #[test]
  fn prefers_basedpyright_over_pyright_wherever_they_are() {
    let tmp = tempfile::tempdir().unwrap();
    let (bin, home, root) = (tmp.path().join("bin"), tmp.path().join("home"), tmp.path().join("ws"));
    for d in [&bin, &home.join(".local/bin"), &root] {
      std::fs::create_dir_all(d).unwrap();
    }
    let py = spec_for("python").unwrap();
    let path = Some(bin.as_os_str());
    fake_bin(&bin, "pyright-langserver", "");
    // basedpyright in an extra dir (pipx's ~/.local/bin) beats pyright on PATH.
    let based = fake_bin(&home.join(".local/bin"), "basedpyright-langserver", "");
    let got = resolve_binary(&py, None, path, Some(&home), &[root.clone()]).unwrap();
    assert!(got.ends_with("basedpyright-langserver"), "{got:?}");
    let based_on_path = fake_bin(&bin, "basedpyright-langserver", "");
    assert_eq!(resolve_binary(&py, None, path, Some(&home), &[root.clone()]).unwrap(), based_on_path);
    assert_ne!(based, based_on_path);
  }

  fn argvs(methods: &[InstallMethod]) -> Vec<String> {
    methods.iter().map(|m| m.argv.join(" ")).collect()
  }

  #[test]
  fn install_methods_follow_the_tools_present() {
    let only = |tools: &'static [&'static str]| move |t: &str| tools.contains(&t).then(|| t.to_string());
    let m = |lang: &str, tools: &'static [&'static str]| argvs(&install_methods(&spec_for(lang).unwrap(), only(tools)));
    let all = INSTALL_TOOLS;

    assert_eq!(m("svelte", all), ["bun add -g svelte-language-server", "npm i -g svelte-language-server"]);
    assert_eq!(m("svelte", &["npm"]), ["npm i -g svelte-language-server"]);
    assert_eq!(m("typescript", &["bun"]), ["bun add -g typescript-language-server typescript"]);
    for lang in ["json", "css", "scss", "less", "html"] {
      assert_eq!(m(lang, &["npm"]), ["npm i -g vscode-langservers-extracted"], "{lang}");
    }
    assert_eq!(m("yaml", all), ["bun add -g yaml-language-server", "npm i -g yaml-language-server", "brew install yaml-language-server"]);
    assert_eq!(m("go", all), ["go install golang.org/x/tools/gopls@latest", "brew install gopls"]);
    assert_eq!(m("go", &["brew"]), ["brew install gopls"]);
    assert_eq!(m("rust", all), ["rustup component add rust-analyzer", "brew install rust-analyzer"]);
    assert_eq!(m("toml", all), ["brew install taplo", "cargo install --locked taplo-cli --features lsp"]);
    assert_eq!(m("python", all), ["pipx install basedpyright", "uv tool install basedpyright", "bun add -g basedpyright", "npm i -g basedpyright"]);
    assert_eq!(m("python", &["uv"]), ["uv tool install basedpyright"]);
    for lang in ["rust", "typescript", "go", "svelte", "python", "json", "css", "html", "yaml", "toml"] {
      assert!(m(lang, &[]).is_empty(), "{lang}");
    }

    // argv stays split (the terminal quotes each word); argv[0] is whatever the probe returned.
    let full = install_methods(&spec_for("svelte").unwrap(), |t| (t == "bun").then(|| "/Users/me/.bun/bin/bun".to_string()));
    let argv: Vec<String> = ["/Users/me/.bun/bin/bun", "add", "-g", "svelte-language-server"].map(String::from).into();
    assert_eq!(full, [InstallMethod { tool: "bun", argv }]);
  }

  #[cfg(unix)]
  #[test]
  fn finds_tools_on_path_by_name_and_elsewhere_by_path() {
    let tmp = tempfile::tempdir().unwrap();
    let (bin, home, root) = (tmp.path().join("bin"), tmp.path().join("home"), tmp.path().join("ws"));
    for d in [&bin, &home.join(".bun/bin"), &root] {
      std::fs::create_dir_all(d).unwrap();
    }
    let bun = fake_bin(&home.join(".bun/bin"), "kingu-test-bun", "");
    assert_eq!(find_executable("kingu-test-bun", Some(bin.as_os_str()), Some(&home), &root), Some((bun, false)));
    let on_path = fake_bin(&bin, "kingu-test-bun", "");
    assert_eq!(find_executable("kingu-test-bun", Some(bin.as_os_str()), Some(&home), &root), Some((on_path, true)));
    std::fs::write(bin.join("kingu-test-noexec"), "").unwrap();
    assert_eq!(find_executable("kingu-test-noexec", Some(bin.as_os_str()), Some(&home), &root), None);
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
    let Ok(program) = resolve_binary(&spec, std::env::var_os(override_name(&spec)), std::env::var_os("PATH").as_deref(), home.as_deref(), &[root.clone()]) else {
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
    let Ok(program) = resolve_binary(&spec, std::env::var_os(override_name(&spec)), std::env::var_os("PATH").as_deref(), home.as_deref(), &[root.clone()]) else {
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
