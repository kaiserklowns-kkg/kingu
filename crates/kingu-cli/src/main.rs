//! `kingu …`: see `kingu_cli::args::USAGE`. Linked as `kingu` by the app (its terminals' PATH and
//! "Shell Command: Install 'kingu' command in PATH").

use std::io::Read;

use kingu_cli::args::{self, Command};
use kingu_cli::client::{self, EXIT_FAILED, EXIT_UNAVAILABLE, EXIT_USAGE};
use kingu_cli::runtime;

fn fail(code: i32, msg: impl std::fmt::Display) -> ! {
  eprintln!("kingu: {msg}");
  std::process::exit(code);
}

fn main() {
  let inv = args::parse(std::env::args().skip(1)).unwrap_or_else(|e| fail(EXIT_USAGE, format!("{e}\n\n{}", args::USAGE)));
  match inv.command {
    Command::Help => {
      println!("{}", args::USAGE);
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
      std::io::stdin().take(client::MAX_PROMPT as u64 + 1).read_to_string(&mut s).unwrap_or_else(|e| fail(EXIT_USAGE, format!("stdin: {e}")));
      Some(s)
    }
    _ => None,
  };
  let cwd = std::env::current_dir().unwrap_or_else(|e| fail(EXIT_USAGE, format!("current folder: {e}")));
  let Some((method, params)) = client::request_of(&inv.command, &cwd, stdin_prompt).unwrap_or_else(|e| fail(EXIT_USAGE, e)) else { return };
  let path = runtime::runtime_path().unwrap_or_else(|| fail(EXIT_UNAVAILABLE, "cannot find Kingu's data folder (HOME is not set)"));
  if !path.exists() {
    fail(EXIT_UNAVAILABLE, "Kingu is not running (start the app first)");
  }
  let rt = runtime::read(&path).unwrap_or_else(|e| fail(EXIT_UNAVAILABLE, e));
  let res = client::call(std::path::Path::new(&rt.socket), &rt.token, method, params).unwrap_or_else(|(code, e)| fail(code, e));
  if inv.json {
    let out = if res.ok { res.result.clone().unwrap_or_default() } else { serde_json::json!({ "error": res.error }) };
    println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
    if !res.ok {
      std::process::exit(EXIT_FAILED);
    }
    return;
  }
  if !res.ok {
    fail(EXIT_FAILED, res.error.map_or_else(|| "failed".to_owned(), |e| e.message));
  }
  let text = client::render(method, &res.result.unwrap_or_default());
  if !text.is_empty() {
    println!("{text}");
  }
}
