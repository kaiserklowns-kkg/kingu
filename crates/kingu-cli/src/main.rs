//! `kingu …`: see `kingu_cli::args::usage()`. Linked as `kingu` by the app (its terminals' PATH and
//! "Shell Command: Install 'kingu' command in PATH").

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use kingu_cli::args::{self, Command, Target};
use kingu_cli::client::{self, EXIT_FAILED, EXIT_UNAVAILABLE, EXIT_USAGE};
use kingu_cli::i18n::{self, Lang, Msg, tr};
use kingu_cli::protocol::{self, Response};
use kingu_cli::{launch, runtime};
use serde_json::{Value, json};

/// How long a Kingu started by the command may take to listen.
const START_TIMEOUT: Duration = Duration::from_secs(30);

fn fail(code: i32, msg: impl std::fmt::Display) -> ! {
  eprintln!("kingu: {msg}");
  std::process::exit(code);
}

/// One request to the running app (`EXIT_UNAVAILABLE` when it is not running or not reachable).
fn send(runtime: &Path, method: &str, params: Value, timeout: Option<Duration>) -> Result<Response, (i32, String)> {
  if !runtime.exists() {
    return Err((EXIT_UNAVAILABLE, tr(Msg::NotRunning, &[])));
  }
  let rt = runtime::read(runtime).map_err(|e| (EXIT_UNAVAILABLE, e))?;
  client::call_with(Path::new(&rt.socket), &rt.token, method, params, timeout)
}

/// Waits for a Kingu the command started to answer.
fn wait_until_running(runtime: &Path) -> Result<(), String> {
  let deadline = Instant::now() + START_TIMEOUT;
  while Instant::now() < deadline {
    std::thread::sleep(Duration::from_millis(300));
    if send(runtime, protocol::METHOD_STATUS, json!({}), Some(Duration::from_secs(5))).is_ok_and(|r| r.ok) {
      return Ok(());
    }
  }
  Err(tr(Msg::StartTimeout, &[("seconds", &START_TIMEOUT.as_secs())]))
}

/// `-`: stdin into a temporary file, which then opens like a path typed in its place.
fn stdin_file() -> PathBuf {
  let mut buf = Vec::new();
  std::io::stdin().take(client::MAX_STDIN as u64 + 1).read_to_end(&mut buf).unwrap_or_else(|e| fail(EXIT_USAGE, tr(Msg::Stdin, &[("detail", &e)])));
  if buf.len() > client::MAX_STDIN {
    fail(EXIT_USAGE, tr(Msg::StdinTooLarge, &[("mb", &(client::MAX_STDIN / 1024 / 1024))]));
  }
  let file = client::write_stdin_file(&std::env::temp_dir(), &buf).unwrap_or_else(|e| fail(EXIT_FAILED, tr(Msg::Stdin, &[("detail", &e)])));
  eprintln!("{}", tr(Msg::StdinFile, &[("path", &file.display())]));
  file
}

fn main() {
  i18n::set(Lang::from_env());
  let inv = args::parse(std::env::args().skip(1)).unwrap_or_else(|e| fail(EXIT_USAGE, format!("{e}\n\n{}", args::usage())));
  let mut command = inv.command;
  match command {
    Command::Help => {
      println!("{}", args::usage());
      return;
    }
    Command::Version => {
      println!("kingu {}", env!("CARGO_PKG_VERSION"));
      return;
    }
    _ => {}
  }
  let stdin_prompt = match &command {
    Command::TaskCreate { prompt: Some(p), .. } if p == "-" => {
      let mut s = String::new();
      std::io::stdin().take(client::MAX_PROMPT as u64 + 1).read_to_string(&mut s).unwrap_or_else(|e| fail(EXIT_USAGE, tr(Msg::Stdin, &[("detail", &e)])));
      Some(s)
    }
    _ => None,
  };
  // Asked for before stdin is read, so `kingu -w -` still waits for the app it may have to start.
  let needs_app = matches!(&command, Command::Editor(e) if e.needs_running_app());
  if let Command::Editor(e) = &mut command
    && let Some(at) = e.stdin.take()
  {
    let file = stdin_file();
    e.paths.insert(at.min(e.paths.len()), Target::plain(file.display().to_string()));
  }
  let cwd = std::env::current_dir().unwrap_or_else(|e| fail(EXIT_USAGE, tr(Msg::CurrentFolder, &[("detail", &e)])));
  let Some((method, params)) = client::request_of(&command, &cwd, stdin_prompt).unwrap_or_else(|e| fail(EXIT_USAGE, e)) else { return };
  let path = runtime::runtime_path().unwrap_or_else(|| fail(EXIT_UNAVAILABLE, tr(Msg::NoDataFolder, &[])));
  let res = match send(&path, method, params.clone(), Some(client::ANSWER_TIMEOUT)) {
    Ok(res) => res,
    // Not running (or a runtime file left by an app that is gone): `kingu <paths>` and
    // `kingu open` start Kingu with them (VS Code's `code <path>`); what launch arguments cannot
    // carry waits for the started app and is sent then.
    Err((EXIT_UNAVAILABLE, e)) => {
      let launch_with = match &command {
        Command::Open { .. } => vec![PathBuf::from(params["path"].as_str().unwrap_or_default())],
        Command::Editor(ed) if !needs_app => client::launch_paths(ed, &cwd),
        Command::Editor(_) => Vec::new(),
        _ => fail(EXIT_UNAVAILABLE, e),
      };
      if let Err(detail) = launch::start(&launch_with) {
        fail(EXIT_UNAVAILABLE, tr(Msg::StartFailed, &[("detail", &detail)]));
      }
      let shown = launch_with.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(" ");
      eprintln!("kingu: {}", if shown.is_empty() { tr(Msg::StartingApp, &[]) } else { tr(Msg::Starting, &[("path", &shown)]) });
      if !needs_app {
        std::process::exit(0);
      }
      wait_until_running(&path).unwrap_or_else(|e| fail(EXIT_UNAVAILABLE, e));
      send(&path, method, params.clone(), Some(client::ANSWER_TIMEOUT)).unwrap_or_else(|(code, e)| fail(code, e))
    }
    Err((code, e)) => fail(code, e),
  };
  if inv.json {
    let out = if res.ok { res.result.clone().unwrap_or_default() } else { json!({ "error": res.error }) };
    println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
    if !res.ok {
      std::process::exit(EXIT_FAILED);
    }
  } else if !res.ok {
    fail(EXIT_FAILED, res.error.map_or_else(|| tr(Msg::Failed, &[]), |e| e.message));
  } else {
    let text = client::render(method, res.result.as_ref().unwrap_or(&Value::Null));
    if !text.is_empty() {
      println!("{text}");
    }
  }
  // `--wait`: blocks until the editors (or their window) close; Kingu quitting ends the wait too.
  if let Some(id) = res.result.as_ref().and_then(|r| r.get("waitId")).and_then(Value::as_u64) {
    match send(&path, protocol::METHOD_EDITOR_WAIT, json!({ "id": id }), None) {
      Ok(r) if !r.ok => fail(EXIT_FAILED, r.error.map_or_else(|| tr(Msg::Failed, &[]), |e| e.message)),
      _ => {}
    }
  }
}
