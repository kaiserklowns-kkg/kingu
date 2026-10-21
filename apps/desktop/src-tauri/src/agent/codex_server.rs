//! Codex's shared app-server, handled the way Orca handles it (`kingu.codex.*` settings):
//! - Isolation: Codex 0.156+ starts one background app-server per `CODEX_HOME` and every
//!   interactive `codex` joins it, so the server runs every terminal's hooks with the first
//!   terminal's environment (Kingu's per-task hook file) and they all end with it. Kingu launches a
//!   task's codex with `--no-daemon` when the binary's `--help` lists that flag (0.155 and older
//!   exit 2 on it), probed on every launch because an upgrade changes the answer.
//! - Warning: a codex you typed into a terminal yourself can still join a running shared server.
//!   [`joins_shared_server`] mirrors Codex's own opt-outs on its command line, and the server is
//!   live when its control socket (`<CODEX_HOME>/app-server-control/app-server-control.sock`)
//!   accepts a connection (a crashed server leaves the file behind, so it is connected to, not
//!   stat'ed). Nothing is sent over the socket.
//!
//! Neither command runs a model or reads a credential: `--help` and `ps` only.

use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const HELP_TIMEOUT: Duration = Duration::from_secs(5);
const HELP_MAX_BYTES: usize = 512 * 1024;

/// A plain program word or an absolute path, as `kingu.agent.cmdOverrides` allows.
fn plain_program(program: &str) -> bool {
  !program.is_empty() && program.bytes().all(|b| b.is_ascii_alphanumeric() || b"._/+-@%:,=".contains(&b))
}

/// `program` as a file: an absolute path as is, else found on `path`.
fn resolve(program: &str, path: Option<OsString>) -> Option<PathBuf> {
  let p = Path::new(program);
  if p.is_absolute() {
    return p.is_file().then(|| p.to_path_buf());
  }
  if program.contains('/') {
    return None;
  }
  crate::agent::review::find_on_path(program, path)
}

/// `<bin> --help` lists `--no-daemon` (bounded: a hung binary only costs the flag).
pub fn supports_no_daemon(bin: &Path) -> bool {
  let Ok(mut child) = Command::new(bin).arg("--help").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else {
    return false;
  };
  let mut stdout = child.stdout.take();
  let reader = std::thread::spawn(move || {
    let mut out = Vec::new();
    if let Some(s) = stdout.as_mut() {
      let _ = s.take(HELP_MAX_BYTES as u64).read_to_end(&mut out);
    }
    out
  });
  let start = Instant::now();
  loop {
    match child.try_wait() {
      Ok(Some(_)) => break,
      Ok(None) if start.elapsed() < HELP_TIMEOUT => std::thread::sleep(Duration::from_millis(20)),
      _ => {
        let _ = child.kill();
        let _ = child.wait();
        return false;
      }
    }
  }
  reader.join().is_ok_and(|out| String::from_utf8_lossy(&out).contains("--no-daemon"))
}

/// Whether a task's codex should get `--no-daemon`: the binary (`codex`, or the override) supports it.
#[tauri::command(async)]
pub fn codex_supports_no_daemon(program: String) -> bool {
  plain_program(&program) && resolve(&program, crate::shell_env::path().or_else(|| std::env::var_os("PATH"))).is_some_and(|bin| supports_no_daemon(&bin))
}

// ---- the shared-server warning ---------------------------------------------------------------

/// Flags that keep a codex off the shared server (Codex's `daemon_startup.rs` exclusions); every
/// `-c` / `--enable` / `--disable` counts, so a missed warning is possible, a false one is not.
const EMBEDDED_FLAGS: &[&str] = &[
  "--no-daemon", "--oss", "--remote", "--profile", "-p", "--strict-config", "--dangerously-bypass-hook-trust", "--search", "--approve-for-me",
  "--not-so-yolo", "--enable", "--disable", "--config", "-c",
];

/// Subcommands that do not open the TUI on the shared server (all but `resume`, `fork`, `agents`).
const NON_TUI_SUBCOMMANDS: &[&str] = &[
  "exec", "e", "review", "login", "logout", "mcp", "plugin", "app-server", "remote-control", "app", "completion", "update", "doctor", "sandbox",
  "debug", "execpolicy", "apply", "a", "queue", "archive", "delete", "migrate-rollouts", "unarchive", "cloud", "cloud-tasks", "responses-api-proxy",
  "stdio-to-uds", "exec-server", "features", "tcp-tunnel", "help",
];

/// Flags without a value: the word after one is still the first positional.
const VALUELESS_FLAGS: &[&str] = &["--dangerously-bypass-approvals-and-sandbox", "--yolo", "--no-alt-screen", "--worktree"];

/// The program word: `codex`, `codex.exe`, the npm `codex.js` launcher, or a platform binary (`codex-aarch64-…`).
fn is_codex_program(word: &str) -> bool {
  let base = word.rsplit(['/', '\\']).next().unwrap_or(word).to_ascii_lowercase();
  let Some(rest) = base.strip_prefix("codex") else { return false };
  rest.is_empty() || matches!(rest, ".js" | ".mjs" | ".cjs" | ".exe" | ".cmd") || (rest.starts_with('-') && rest.len() > 1)
}

fn is_embedded_flag(word: &str) -> bool {
  let name = word.split('=').next().unwrap_or(word);
  // clap also takes a short flag glued to its value (`-pwork`).
  EMBEDDED_FLAGS.contains(&name) || (word.len() > 2 && (word.starts_with("-p") || word.starts_with("-c")) && !word[2..].starts_with('-'))
}

/// Process-table words: whitespace splits, double quotes group (as Windows quotes paths).
fn words(line: &str) -> Vec<String> {
  let mut out = Vec::new();
  let mut cur = String::new();
  let mut quoted = false;
  for c in line.chars() {
    match c {
      '"' => {
        quoted = !quoted;
        cur.push(c);
      }
      c if c.is_whitespace() && !quoted => {
        if !cur.is_empty() {
          out.push(std::mem::take(&mut cur));
        }
      }
      c => cur.push(c),
    }
  }
  if !cur.is_empty() {
    out.push(cur);
  }
  out.into_iter().map(|w| w.trim_matches(['"', '\'']).to_owned()).collect()
}

/// A codex command line (from `ps`) that is an interactive codex joining the shared server when
/// one runs. Only the first positional can be a subcommand; later words are prompt text.
pub fn joins_shared_server(command_line: &str) -> bool {
  let words = words(command_line);
  let Some(at) = words.iter().position(|w| is_codex_program(w)) else { return false };
  let args = &words[at + 1..];
  if args.iter().any(|a| is_embedded_flag(a)) {
    return false;
  }
  for (i, word) in args.iter().enumerate() {
    if word.starts_with('-') {
      continue;
    }
    if NON_TUI_SUBCOMMANDS.contains(&word.as_str()) {
      return false;
    }
    // This word may be the previous flag's value (`-m gpt-5 exec`): look one further.
    let prev = i.checked_sub(1).map(|j| args[j].as_str());
    if prev.is_none_or(|p| !p.starts_with('-') || p.contains('=') || VALUELESS_FLAGS.contains(&p)) {
      return true;
    }
  }
  true
}

/// The `CODEX_HOME` a codex the user types uses: Kingu's own environment's, else `~/.codex`.
fn codex_home() -> Option<PathBuf> {
  match std::env::var_os("CODEX_HOME") {
    Some(d) if !d.is_empty() => Some(PathBuf::from(d)),
    _ => std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".codex")),
  }
}

/// `<home>/app-server-control/app-server-control.sock`, with the home canonicalized as Codex does.
pub fn socket_path(home: &Path) -> PathBuf {
  std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf()).join("app-server-control").join("app-server-control.sock")
}

/// The shared server accepts clients on its socket right now.
#[cfg(unix)]
pub fn server_live(home: &Path) -> bool {
  std::os::unix::net::UnixStream::connect(socket_path(home)).is_ok()
}

#[cfg(not(unix))]
pub fn server_live(_home: &Path) -> bool {
  // Windows keeps a pid record instead of a socket; not read here.
  false
}

/// The full command line of `pid` (`ps -o command=`), or None when it is gone.
fn command_line(pid: u32) -> Option<String> {
  let out = Command::new("ps").args(["-ww", "-o", "command=", "-p", &pid.to_string()]).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
  let line = String::from_utf8_lossy(&out.stdout).trim().to_owned();
  (out.status.success() && !line.is_empty()).then_some(line)
}

/// Whether the job in front of a terminal (`pid`, from `pty_foreground` / `pty_list`) is a codex
/// that joined a live shared server.
#[tauri::command(async)]
pub fn codex_shared_server_joined(pid: u32) -> bool {
  if cfg!(windows) {
    return false;
  }
  command_line(pid).is_some_and(|line| joins_shared_server(&line)) && codex_home().is_some_and(|h| server_live(&h))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn interactive_codex_joins_the_shared_server() {
    for line in [
      "codex",
      "/opt/homebrew/bin/codex fix the tests",
      "node /usr/local/lib/node_modules/@openai/codex/bin/codex.js",
      "codex resume --last",
      "codex -m gpt-5 fix it",
      "codex --yolo fix it",
      "\"C:\\Program Files\\codex.exe\"",
      "codex-aarch64-apple-darwin",
    ] {
      assert!(joins_shared_server(line), "{line}");
    }
  }

  #[test]
  fn opt_outs_and_other_subcommands_do_not() {
    for line in [
      "codex --no-daemon",
      "codex --remote=ws://x",
      "codex -c model=o3",
      "codex -pwork",
      "codex exec hello",
      "codex app-server daemon stop",
      "codex features disable daemon_auto_start",
      "codex --dangerously-bypass-approvals-and-sandbox exec",
      "codex -m gpt-5 exec",
      "zsh",
      "codexx",
      "vim codex.txt",
    ] {
      assert!(!joins_shared_server(line), "{line}");
    }
  }

  #[test]
  fn program_words() {
    assert!(is_codex_program("codex") && is_codex_program("/a/b/codex.js") && is_codex_program("codex.EXE"));
    assert!(!is_codex_program("codex-") && !is_codex_program("mycodex") && !is_codex_program("codex.txt"));
    assert!(plain_program("codex") && plain_program("/opt/codex-beta/codex"));
    assert!(!plain_program("codex; rm -rf /") && !plain_program("") && !plain_program("$(x)"));
  }

  #[cfg(unix)]
  fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let p = dir.join(name);
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
  }

  /// Stand-in binaries (shell scripts), never a real codex.
  #[cfg(unix)]
  #[test]
  fn probes_help_for_the_flag() {
    let tmp = tempfile::tempdir().unwrap();
    let new = script(tmp.path(), "codex", "echo '  --no-daemon  Run without the shared app-server'");
    let old = script(tmp.path(), "codex-old", "echo 'Usage: codex [OPTIONS]'; exit 0");
    let failing = script(tmp.path(), "codex-bad", "exit 2");
    assert!(supports_no_daemon(&new));
    assert!(!supports_no_daemon(&old));
    assert!(!supports_no_daemon(&failing));
    assert!(!supports_no_daemon(&tmp.path().join("missing")));
    assert_eq!(resolve("codex", Some(tmp.path().as_os_str().to_owned())), Some(new.clone()));
    assert_eq!(resolve(new.to_str().unwrap(), None), Some(new));
    assert_eq!(resolve("bin/codex", Some(tmp.path().as_os_str().to_owned())), None);
  }

  #[cfg(unix)]
  #[test]
  fn hung_help_times_out() {
    let tmp = tempfile::tempdir().unwrap();
    let hung = script(tmp.path(), "codex", "sleep 30");
    let start = Instant::now();
    assert!(!supports_no_daemon(&hung));
    assert!(start.elapsed() < HELP_TIMEOUT + Duration::from_secs(2));
  }

  #[cfg(unix)]
  #[test]
  fn live_server_is_a_socket_that_accepts() {
    // A short folder: sun_path holds about 100 bytes and macOS temp dirs are long.
    let tmp = tempfile::tempdir_in("/tmp").unwrap();
    let home = tmp.path().join("h");
    std::fs::create_dir_all(home.join("app-server-control")).unwrap();
    assert!(!server_live(&home), "no socket");
    let path = socket_path(&home);
    // The path must fit sun_path; macOS temp dirs are long, so skip when it would not.
    if path.as_os_str().len() >= 100 {
      return;
    }
    let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
    assert!(server_live(&home));
    drop(listener);
    assert!(!server_live(&home), "a left-behind socket file is not a live server");
  }
}
