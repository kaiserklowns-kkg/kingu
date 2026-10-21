//! `kingu …`: see `kingu_cli::args::usage()`. Linked as `kingu` by the app (its terminals' PATH and
//! "Shell Command: Install 'kingu' command in PATH").

use std::io::Read;

use kingu_cli::args::{self, Command};
use kingu_cli::client::{self, EXIT_FAILED, EXIT_UNAVAILABLE, EXIT_USAGE};
use kingu_cli::i18n::{self, Lang, Msg, tr};
use kingu_cli::{launch, runtime};

fn fail(code: i32, msg: impl std::fmt::Display) -> ! {
  eprintln!("kingu: {msg}");
  std::process::exit(code);
}

fn main() {
  i18n::set(Lang::from_env());
  let inv = args::parse(std::env::args().skip(1)).unwrap_or_else(|e| fail(EXIT_USAGE, format!("{e}\n\n{}", args::usage())));
  match inv.command {
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
  let stdin_prompt = match &inv.command {
    Command::TaskCreate { prompt: Some(p), .. } if p == "-" => {
      let mut s = String::new();
      std::io::stdin().take(client::MAX_PROMPT as u64 + 1).read_to_string(&mut s).unwrap_or_else(|e| fail(EXIT_USAGE, tr(Msg::Stdin, &[("detail", &e)])));
      Some(s)
    }
    _ => None,
  };
  let cwd = std::env::current_dir().unwrap_or_else(|e| fail(EXIT_USAGE, tr(Msg::CurrentFolder, &[("detail", &e)])));
  let Some((method, params)) = client::request_of(&inv.command, &cwd, stdin_prompt).unwrap_or_else(|e| fail(EXIT_USAGE, e)) else { return };
  // `kingu open` starts Kingu with the path when it is not running (VS Code's `code <path>`).
  let start_instead = |e: String| -> ! {
    let Command::Open { .. } = &inv.command else { fail(EXIT_UNAVAILABLE, e) };
    let target = std::path::PathBuf::from(params["path"].as_str().unwrap_or_default());
    match launch::start(&target) {
      Ok(()) => {
        eprintln!("kingu: {}", tr(Msg::Starting, &[("path", &target.display())]));
        std::process::exit(0);
      }
      Err(detail) => fail(EXIT_UNAVAILABLE, tr(Msg::StartFailed, &[("detail", &detail)])),
    }
  };
  let path = runtime::runtime_path().unwrap_or_else(|| fail(EXIT_UNAVAILABLE, tr(Msg::NoDataFolder, &[])));
  if !path.exists() {
    start_instead(tr(Msg::NotRunning, &[]));
  }
  let rt = runtime::read(&path).unwrap_or_else(|e| fail(EXIT_UNAVAILABLE, e));
  let res = match client::call(std::path::Path::new(&rt.socket), &rt.token, method, params.clone()) {
    Ok(res) => res,
    // A runtime file left by an app that is gone.
    Err((EXIT_UNAVAILABLE, e)) => start_instead(e),
    Err((code, e)) => fail(code, e),
  };
  if inv.json {
    let out = if res.ok { res.result.clone().unwrap_or_default() } else { serde_json::json!({ "error": res.error }) };
    println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
    if !res.ok {
      std::process::exit(EXIT_FAILED);
    }
    return;
  }
  if !res.ok {
    fail(EXIT_FAILED, res.error.map_or_else(|| tr(Msg::Failed, &[]), |e| e.message));
  }
  let text = client::render(method, &res.result.unwrap_or_default());
  if !text.is_empty() {
    println!("{text}");
  }
}
