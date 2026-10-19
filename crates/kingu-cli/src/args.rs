//! Command-line parsing (no dependencies): `kingu [--json] <command> …`. Pure, so every form is
//! tested; errors come in the current language (`i18n`); reading stdin for `--prompt -` and resolving relative paths happen in `main`.

use crate::i18n::{Msg, tr};

/// The help text in the current language (`i18n`).
pub fn usage() -> &'static str {
  crate::i18n::usage()
}

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
  ArtifactPublish {
    file: String,
    title: Option<String>,
    description: Option<String>,
    /// `(path, name)`: a file to include and its name inside the artifact (None: worked out from the path).
    assets: Vec<(String, Option<String>)>,
    id: Option<String>,
  },
  ArtifactList,
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
  args.get(*i).cloned().ok_or_else(|| tr(Msg::NeedsValue, &[("flag", &flag)]))
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
    "artifact" | "artifacts" => artifact(&args[1..]),
    other => Err(tr(Msg::UnknownCommand, &[("command", &other)])),
  }
}

fn no_more(args: &[String], c: Command) -> Result<Command, String> {
  match args.first() {
    None => Ok(c),
    Some(a) => Err(tr(Msg::UnexpectedArgument, &[("arg", a)])),
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
      return Err(tr(Msg::UnknownOption, &[("option", &a)]));
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
  let Some(sub) = args.first() else { return Err(tr(Msg::TaskNeedsSubcommand, &[])) };
  let rest = &args[1..];
  match sub.as_str() {
    "list" | "ls" => no_more(rest, Command::TaskList),
    "create" | "new" => {
      let (pos, flags) = split(rest, &["--prompt", "-p", "--base", "-b", "--mode", "-m"], &["--background"])?;
      let title = pos.join(" ").trim().to_owned();
      if title.is_empty() {
        return Err(tr(Msg::TaskCreateNeedsTitle, &[]));
      }
      let mode = flag(&flags, &["--mode", "-m"]);
      if let Some(m) = mode.as_deref().filter(|m| !matches!(*m, "terminal" | "timeline")) {
        return Err(tr(Msg::BadMode, &[("mode", &m)]));
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
        [] => Err(tr(Msg::TaskOpenNeedsSlug, &[])),
        _ => Err(tr(Msg::TaskOpenOneSlug, &[])),
      }
    }
    other => Err(tr(Msg::UnknownTaskCommand, &[("command", &other)])),
  }
}

fn open(args: &[String]) -> Result<Command, String> {
  let (pos, _) = split(args, &[], &[])?;
  match pos.as_slice() {
    [p] => {
      let (path, line, column) = split_position(p);
      Ok(Command::Open { path, line, column })
    }
    [] => Err(tr(Msg::OpenNeedsPath, &[])),
    _ => Err(tr(Msg::OpenOnePath, &[])),
  }
}

fn notify(args: &[String]) -> Result<Command, String> {
  let (pos, flags) = split(args, &["--title", "-t"], &[])?;
  let message = pos.join(" ").trim().to_owned();
  if message.is_empty() {
    return Err(tr(Msg::NotifyNeedsMessage, &[]));
  }
  Ok(Command::Notify { message, title: flag(&flags, &["--title", "-t"]).filter(|t| !t.trim().is_empty()) })
}

/// An artifact id: 16 lowercase hex digits.
pub fn is_artifact_id(id: &str) -> bool {
  id.len() == 16 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn artifact(args: &[String]) -> Result<Command, String> {
  let Some(sub) = args.first() else { return Err(tr(Msg::ArtifactNeedsSubcommand, &[])) };
  let rest = &args[1..];
  match sub.as_str() {
    "list" | "ls" => no_more(rest, Command::ArtifactList),
    "publish" => {
      let (pos, flags) = split(rest, &["--title", "-t", "--description", "-d", "--asset", "-a", "--id"], &[])?;
      let file = match pos.as_slice() {
        [f] => f.to_string(),
        [] => return Err(tr(Msg::ArtifactNeedsFile, &[])),
        _ => return Err(tr(Msg::ArtifactOneFile, &[])),
      };
      let id = flag(&flags, &["--id"]);
      if let Some(i) = id.as_deref().filter(|i| !is_artifact_id(i)) {
        return Err(tr(Msg::ArtifactBadId, &[("id", &i)]));
      }
      let mut assets = Vec::new();
      for (k, v) in &flags {
        if k != "--asset" && k != "-a" {
          continue;
        }
        let (path, name) = match v.split_once('=') {
          Some((p, n)) => (p.to_owned(), Some(n.to_owned())),
          None => (v.clone(), None),
        };
        if path.is_empty() || name.as_deref().is_some_and(str::is_empty) {
          return Err(tr(Msg::ArtifactBadAsset, &[("value", &v)]));
        }
        assets.push((path, name));
      }
      let text = |names: &[&str]| flag(&flags, names).map(|t| t.trim().to_owned()).filter(|t| !t.is_empty());
      Ok(Command::ArtifactPublish { file, title: text(&["--title", "-t"]), description: text(&["--description", "-d"]), assets, id })
    }
    other => Err(tr(Msg::UnknownArtifactCommand, &[("command", &other)])),
  }
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
  fn parses_artifact_commands() {
    assert_eq!(c(&["artifact", "list"]), Command::ArtifactList);
    assert_eq!(c(&["artifacts", "ls"]), Command::ArtifactList);
    assert!(p(&["artifact", "list", "x"]).is_err());
    assert_eq!(
      c(&["artifact", "publish", "report.html", "-t", " Report ", "--asset", "img/a.png", "-a=data.json=d/data.json", "--id", "0123456789abcdef"]),
      Command::ArtifactPublish {
        file: "report.html".into(),
        title: Some("Report".into()),
        description: None,
        assets: vec![("img/a.png".into(), None), ("data.json".into(), Some("d/data.json".into()))],
        id: Some("0123456789abcdef".into()),
      }
    );
    assert_eq!(
      c(&["artifact", "publish", "notes.md", "--description", "สรุป", "--title", " "]),
      Command::ArtifactPublish { file: "notes.md".into(), title: None, description: Some("สรุป".into()), assets: vec![], id: None }
    );
    assert!(p(&["artifact", "publish"]).unwrap_err().contains("needs"));
    assert!(p(&["artifact", "publish", "a.html", "b.html"]).is_err());
    assert!(p(&["artifact", "publish", "a.html", "--id", "ABC"]).unwrap_err().contains("--id"));
    assert!(p(&["artifact", "publish", "a.html", "--asset", "x="]).is_err());
    assert!(p(&["artifact"]).is_err() && p(&["artifact", "delete"]).is_err());
    assert!(is_artifact_id("0123456789abcdef") && !is_artifact_id("0123456789ABCDEF") && !is_artifact_id("0123"));
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
