//! Command-line parsing (no dependencies): `kingu [--json] <command> …`. Pure, so every form is
//! tested; reading stdin for `--prompt -` and resolving relative paths happen in `main`.

pub const USAGE: &str = "kingu: control the running Kingu app from a terminal or an agent

Usage:
  kingu status                       Kingu's version, open folder and task count
  kingu task list                    tasks of the open folder (slug, status, title)
  kingu task create <title> [--prompt <text>|-] [--base <branch>] [--mode terminal|timeline] [--background]
                                     start a task in a new worktree; prints its slug
  kingu task open <slug>             show a task in Kingu
  kingu open <path>[:line[:column]]  open a file (in the open folder) or a folder in Kingu
  kingu notify <message…> [--title <title>]
                                     post a desktop notification

Options:
  --json         print the app's answer as JSON
  -h, --help     this help
  -V, --version  the command's version

The app must be running. Inside Kingu's terminals `kingu` is on PATH; elsewhere run
\"Shell Command: Install 'kingu' command in PATH\" from Kingu's command palette.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
  Help,
  Version,
  Status,
  TaskList,
  TaskCreate {
    title: String,
    /// `-` means stdin.
    prompt: Option<String>,
    base: Option<String>,
    mode: Option<String>,
    background: bool,
  },
  TaskOpen {
    slug: String,
  },
  Open {
    path: String,
    line: Option<u32>,
    column: Option<u32>,
  },
  Notify {
    message: String,
    title: Option<String>,
  },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
  pub command: Command,
  pub json: bool,
}

/// `file.ts:12:3` → (`file.ts`, 12, 3); a suffix that is not a positive number stays in the path.
pub fn split_position(arg: &str) -> (String, Option<u32>, Option<u32>) {
  let num = |s: &str| s.parse::<u32>().ok().filter(|n| *n > 0 && !s.starts_with('+'));
  if let Some((rest, last)) = arg.rsplit_once(':')
    && let Some(n) = num(last)
  {
    if let Some((path, line)) = rest.rsplit_once(':')
      && let Some(l) = num(line)
      && !path.is_empty()
    {
      return (path.to_owned(), Some(l), Some(n));
    }
    if !rest.is_empty() {
      return (rest.to_owned(), Some(n), None);
    }
  }
  (arg.to_owned(), None, None)
}

fn value(args: &[String], i: &mut usize, flag: &str) -> Result<String, String> {
  *i += 1;
  args.get(*i).cloned().ok_or_else(|| format!("{flag} needs a value"))
}

/// Parses everything after the program name.
pub fn parse(argv: impl IntoIterator<Item = String>) -> Result<Invocation, String> {
  let all: Vec<String> = argv.into_iter().collect();
  let mut json = false;
  let mut help = false;
  let mut version = false;
  // Global flags anywhere before `--`; everything else is positional or a command flag.
  let mut rest = Vec::new();
  let mut literal = false;
  for a in all {
    match a.as_str() {
      _ if literal => rest.push(a),
      "--" => {
        literal = true;
        rest.push(a);
      }
      "--json" => json = true,
      "-h" | "--help" => help = true,
      "-V" | "--version" => version = true,
      _ => rest.push(a),
    }
  }
  let command = if help {
    Command::Help
  } else if version {
    Command::Version
  } else {
    command(&rest)?
  };
  Ok(Invocation { command, json })
}

fn command(args: &[String]) -> Result<Command, String> {
  let Some(first) = args.first() else { return Ok(Command::Help) };
  match first.as_str() {
    "help" => Ok(Command::Help),
    "version" => Ok(Command::Version),
    "status" => no_more(&args[1..], Command::Status),
    "task" | "tasks" => task(&args[1..]),
    "open" => open(&args[1..]),
    "notify" => notify(&args[1..]),
    other => Err(format!("unknown command `{other}` (try `kingu --help`)")),
  }
}

fn no_more(args: &[String], c: Command) -> Result<Command, String> {
  match args.first() {
    None => Ok(c),
    Some(a) => Err(format!("unexpected argument `{a}`")),
  }
}

/// Positional arguments and `--flag value` pairs.
type Split<'a> = (Vec<&'a str>, Vec<(String, String)>);

/// Positional arguments and `--flag value` pairs (flags listed in `with_value`), `--` ending flags.
fn split<'a>(args: &'a [String], with_value: &[&str], switches: &[&str]) -> Result<Split<'a>, String> {
  let mut pos = Vec::new();
  let mut flags = Vec::new();
  let mut i = 0;
  let mut literal = false;
  while i < args.len() {
    let a = args[i].as_str();
    if literal {
      pos.push(a);
    } else if a == "--" {
      literal = true;
    } else if let Some((k, v)) = a.split_once('=').filter(|(k, _)| with_value.contains(k)) {
      flags.push((k.to_owned(), v.to_owned()));
    } else if with_value.contains(&a) {
      let v = value(args, &mut i, a)?;
      flags.push((a.to_owned(), v));
    } else if switches.contains(&a) {
      flags.push((a.to_owned(), String::new()));
    } else if a.starts_with("--") || (a.starts_with('-') && a.len() > 1) {
      return Err(format!("unknown option `{a}`"));
    } else {
      pos.push(a);
    }
    i += 1;
  }
  Ok((pos, flags))
}

fn flag(flags: &[(String, String)], names: &[&str]) -> Option<String> {
  flags.iter().rev().find(|(k, _)| names.contains(&k.as_str())).map(|(_, v)| v.clone())
}

fn task(args: &[String]) -> Result<Command, String> {
  let Some(sub) = args.first() else { return Err("`kingu task` needs list, create or open".into()) };
  let rest = &args[1..];
  match sub.as_str() {
    "list" | "ls" => no_more(rest, Command::TaskList),
    "create" | "new" => {
      let (pos, flags) = split(rest, &["--prompt", "-p", "--base", "-b", "--mode", "-m"], &["--background"])?;
      let title = pos.join(" ").trim().to_owned();
      if title.is_empty() {
        return Err("`kingu task create` needs a title".into());
      }
      let mode = flag(&flags, &["--mode", "-m"]);
      if let Some(m) = mode.as_deref().filter(|m| !matches!(*m, "terminal" | "timeline")) {
        return Err(format!("--mode must be terminal or timeline, not `{m}`"));
      }
      Ok(Command::TaskCreate {
        title,
        prompt: flag(&flags, &["--prompt", "-p"]),
        base: flag(&flags, &["--base", "-b"]).filter(|b| !b.trim().is_empty()),
        mode,
        background: flag(&flags, &["--background"]).is_some(),
      })
    }
    "open" | "show" => {
      let (pos, _) = split(rest, &[], &[])?;
      match pos.as_slice() {
        [slug] => Ok(Command::TaskOpen { slug: slug.to_string() }),
        [] => Err("`kingu task open` needs a task slug (see `kingu task list`)".into()),
        _ => Err("`kingu task open` takes one slug".into()),
      }
    }
    other => Err(format!("unknown task command `{other}` (list, create, open)")),
  }
}

fn open(args: &[String]) -> Result<Command, String> {
  let (pos, _) = split(args, &[], &[])?;
  match pos.as_slice() {
    [p] => {
      let (path, line, column) = split_position(p);
      Ok(Command::Open { path, line, column })
    }
    [] => Err("`kingu open` needs a path".into()),
    _ => Err("`kingu open` takes one path".into()),
  }
}

fn notify(args: &[String]) -> Result<Command, String> {
  let (pos, flags) = split(args, &["--title", "-t"], &[])?;
  let message = pos.join(" ").trim().to_owned();
  if message.is_empty() {
    return Err("`kingu notify` needs a message".into());
  }
  Ok(Command::Notify { message, title: flag(&flags, &["--title", "-t"]).filter(|t| !t.trim().is_empty()) })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn p(args: &[&str]) -> Result<Invocation, String> {
    parse(args.iter().map(|s| s.to_string()))
  }

  fn c(args: &[&str]) -> Command {
    p(args).unwrap().command
  }

  #[test]
  fn parses_status_help_version_and_json() {
    assert_eq!(c(&[]), Command::Help);
    assert_eq!(c(&["--help"]), Command::Help);
    assert_eq!(c(&["task", "create", "x", "-h"]), Command::Help);
    assert_eq!(c(&["-V"]), Command::Version);
    assert_eq!(p(&["status", "--json"]).unwrap(), Invocation { command: Command::Status, json: true });
    assert_eq!(p(&["--json", "task", "list"]).unwrap(), Invocation { command: Command::TaskList, json: true });
    assert!(p(&["status", "now"]).is_err());
    assert!(p(&["frobnicate"]).unwrap_err().contains("unknown command"));
  }

  #[test]
  fn parses_task_commands() {
    assert_eq!(
      c(&["task", "create", "Fix", "login", "--prompt", "Steps: …", "--base=main", "-m", "timeline", "--background"]),
      Command::TaskCreate { title: "Fix login".into(), prompt: Some("Steps: …".into()), base: Some("main".into()), mode: Some("timeline".into()), background: true }
    );
    assert_eq!(
      c(&["task", "new", "แก้ login", "-p", "-"]),
      Command::TaskCreate { title: "แก้ login".into(), prompt: Some("-".into()), base: None, mode: None, background: false }
    );
    // `--` lets a title start with a dash.
    assert_eq!(c(&["task", "create", "--", "-x"]), Command::TaskCreate { title: "-x".into(), prompt: None, base: None, mode: None, background: false });
    assert!(p(&["task", "create"]).unwrap_err().contains("title"));
    assert!(p(&["task", "create", "x", "--prompt"]).unwrap_err().contains("needs a value"));
    assert!(p(&["task", "create", "x", "--mode", "cloud"]).unwrap_err().contains("--mode"));
    assert!(p(&["task", "create", "x", "--force"]).unwrap_err().contains("unknown option"));
    assert_eq!(c(&["task", "open", "fix-login"]), Command::TaskOpen { slug: "fix-login".into() });
    assert!(p(&["task", "open"]).is_err() && p(&["task", "open", "a", "b"]).is_err());
    assert!(p(&["task"]).is_err() && p(&["task", "delete"]).is_err());
  }

  #[test]
  fn parses_open_with_positions_and_notify() {
    assert_eq!(c(&["open", "src/main.rs:12:3"]), Command::Open { path: "src/main.rs".into(), line: Some(12), column: Some(3) });
    assert_eq!(c(&["open", "a.ts:7"]), Command::Open { path: "a.ts".into(), line: Some(7), column: None });
    assert_eq!(c(&["open", "."]), Command::Open { path: ".".into(), line: None, column: None });
    assert!(p(&["open"]).is_err() && p(&["open", "a", "b"]).is_err());
    assert_eq!(c(&["notify", "build", "done", "--title", "CI"]), Command::Notify { message: "build done".into(), title: Some("CI".into()) });
    assert_eq!(c(&["notify", "เสร็จแล้ว"]), Command::Notify { message: "เสร็จแล้ว".into(), title: None });
    assert!(p(&["notify"]).is_err() && p(&["notify", "  "]).is_err());
  }

  #[test]
  fn splits_line_and_column_suffixes_only_when_numeric() {
    assert_eq!(split_position("a.rs:1:2"), ("a.rs".into(), Some(1), Some(2)));
    assert_eq!(split_position("a.rs:9"), ("a.rs".into(), Some(9), None));
    assert_eq!(split_position("a.rs"), ("a.rs".into(), None, None));
    assert_eq!(split_position("a.rs:0"), ("a.rs:0".into(), None, None));
    assert_eq!(split_position("a.rs:x"), ("a.rs:x".into(), None, None));
    assert_eq!(split_position("C:\\x"), ("C:\\x".into(), None, None));
    assert_eq!(split_position(":5"), (":5".into(), None, None));
    assert_eq!(split_position("a:+5"), ("a:+5".into(), None, None));
  }
}
