//! Command-line parsing (no dependencies): `kingu [--json] <command> …`, and anything that is not
//! a command is VS Code's `code [options] [paths…]` (`Command::Editor`). Pure, so every form is
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
  /// `kingu account add`: the CLI's own login in a temporary XDG home, then registered by the app.
  AccountAdd {
    agent: String,
    label: Option<String>,
    integration: Option<String>,
  },
  AccountList {
    agent: Option<String>,
  },
  AccountSelect {
    agent: String,
    /// None: System default.
    account: Option<String>,
  },
  AccountRemove {
    agent: String,
    account: String,
  },
  /// `kingu [options] [paths…]`: VS Code's `code` command line.
  Editor(Editor),
}

/// A file or folder named on the command line, with a position (`-g file:line:column`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
  pub path: String,
  pub line: Option<u32>,
  pub column: Option<u32>,
}

impl Target {
  pub fn plain(path: impl Into<String>) -> Self {
    Self { path: path.into(), line: None, column: None }
  }
}

/// The editor form of the command line (VS Code's `code [options] [paths…]`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Editor {
  /// Files and folders as typed (relative ones are made absolute by `client`).
  pub paths: Vec<Target>,
  /// `-g`: paths carry `:line[:column]`.
  pub goto: bool,
  /// `-d a b`: a diff editor of two files.
  pub diff: bool,
  /// `-m a b base result`: a three-way merge of two versions into `result`.
  pub merge: bool,
  /// `-a`: the folders are added to the last active window.
  pub add: bool,
  /// `--remove`: the folders are removed from the last active window.
  pub remove: bool,
  pub new_window: bool,
  pub reuse_window: bool,
  /// `-w`: return only once the opened editors (or the window) are closed.
  pub wait: bool,
  pub profile: Option<String>,
  /// `-`: stdin goes into a temporary file that opens like any other, at this place among `paths`.
  pub stdin: Option<usize>,
}

impl Editor {
  /// Anything a freshly started app cannot do from its launch arguments alone.
  pub fn needs_running_app(&self) -> bool {
    self.goto || self.diff || self.merge || self.add || self.remove || self.wait || self.profile.is_some() || self.stdin.is_some()
  }
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
      "-v" | "-V" | "--version" => version = true,
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
    "account" | "accounts" => account(&args[1..]),
    // Anything else is VS Code's `code [options] [paths…]` (`kingu ./status` for a path named like a command).
    _ => editor(args),
  }
}

/// `kingu [options] [paths…]`. Single-letter switches may be grouped (`-nw`).
fn editor(args: &[String]) -> Result<Command, String> {
  let mut e = Editor::default();
  let mut raw: Vec<String> = Vec::new();
  let mut literal = false;
  let mut i = 0;
  while i < args.len() {
    let a = args[i].as_str();
    if literal {
      raw.push(a.to_owned());
      i += 1;
      continue;
    }
    match a {
      "--" => literal = true,
      "-" if e.stdin.is_some() => return Err(tr(Msg::UnexpectedArgument, &[("arg", &a)])),
      "-" => e.stdin = Some(raw.len()),
      "--goto" => e.goto = true,
      "--diff" => e.diff = true,
      "--merge" => e.merge = true,
      "--add" => e.add = true,
      "--remove" => e.remove = true,
      "--new-window" => e.new_window = true,
      "--reuse-window" => e.reuse_window = true,
      "--wait" => e.wait = true,
      "--profile" => e.profile = Some(value(args, &mut i, a)?),
      _ if a.starts_with("--profile=") => e.profile = Some(a["--profile=".len()..].to_owned()),
      _ if a.starts_with("--") => return Err(tr(Msg::UnknownOption, &[("option", &a)])),
      _ if a.len() > 1 && a.starts_with('-') => {
        for c in a[1..].chars() {
          match c {
            'g' => e.goto = true,
            'd' => e.diff = true,
            'm' => e.merge = true,
            'a' => e.add = true,
            'n' => e.new_window = true,
            'r' => e.reuse_window = true,
            'w' => e.wait = true,
            _ => return Err(tr(Msg::UnknownOption, &[("option", &a)])),
          }
        }
      }
      _ => raw.push(a.to_owned()),
    }
    i += 1;
  }
  if e.profile.as_deref().is_some_and(|p| p.trim().is_empty()) {
    return Err(tr(Msg::NeedsValue, &[("flag", &"--profile")]));
  }
  let goto = e.goto;
  e.paths = raw
    .into_iter()
    .map(|p| {
      if goto {
        let (path, line, column) = split_position(&p);
        Target { path, line, column }
      } else {
        Target::plain(p)
      }
    })
    .collect();
  let count = e.paths.len() + usize::from(e.stdin.is_some());
  if e.new_window && e.reuse_window {
    return Err(tr(Msg::NewAndReuse, &[]));
  }
  if [e.diff, e.merge, e.add, e.remove].iter().filter(|b| **b).count() > 1 {
    return Err(tr(Msg::ConflictingModes, &[]));
  }
  if e.diff && count != 2 {
    return Err(tr(Msg::DiffNeedsTwo, &[]));
  }
  if e.merge && count != 4 {
    return Err(tr(Msg::MergeNeedsFour, &[]));
  }
  if (e.add || e.remove) && (e.paths.is_empty() || e.stdin.is_some()) {
    return Err(tr(Msg::AddNeedsFolders, &[("flag", &if e.add { "--add" } else { "--remove" })]));
  }
  Ok(Command::Editor(e))
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


fn data_agent(flags: &[(String, String)]) -> Result<String, String> {
  match flag(flags, &["--agent"]).as_deref() {
    Some(a @ ("opencode" | "devin")) => Ok(a.to_owned()),
    _ => Err(tr(Msg::AccountNeedsAgent, &[])),
  }
}

fn account(args: &[String]) -> Result<Command, String> {
  let Some(sub) = args.first() else { return Err(tr(Msg::AccountNeedsSubcommand, &[])) };
  let (pos, flags) = split(&args[1..], &["--agent", "--label", "--integration", "--account"], &[])?;
  if let Some(extra) = pos.first() {
    return Err(tr(Msg::UnexpectedArgument, &[("arg", extra)]));
  }
  match sub.as_str() {
    "add" => {
      let agent = data_agent(&flags)?;
      let integration = flag(&flags, &["--integration"]);
      if integration.is_some() && agent != "opencode" || integration.as_deref().is_some_and(|i| i.trim().is_empty()) {
        return Err(tr(Msg::IntegrationOnlyOpencode, &[]));
      }
      Ok(Command::AccountAdd { agent, label: flag(&flags, &["--label"]), integration })
    }
    "list" | "ls" => {
      let agent = if flag(&flags, &["--agent"]).is_some() { Some(data_agent(&flags)?) } else { None };
      Ok(Command::AccountList { agent })
    }
    "select" | "rm" | "remove" => {
      let (Ok(agent), Some(account)) = (data_agent(&flags), flag(&flags, &["--account"]).filter(|a| !a.trim().is_empty())) else {
        return Err(tr(Msg::AccountNeedsId, &[]));
      };
      if sub == "select" {
        Ok(Command::AccountSelect { agent, account: Some(account).filter(|a| a != "system") })
      } else if account == "system" {
        Err(tr(Msg::AccountNeedsId, &[]))
      } else {
        Ok(Command::AccountRemove { agent, account })
      }
    }
    other => Err(tr(Msg::UnknownAccountCommand, &[("command", &other)])),
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
    assert_eq!(c(&["-v"]), Command::Version);
    assert_eq!(c(&[".", "--version"]), Command::Version);
    assert_eq!(p(&["status", "--json"]).unwrap(), Invocation { command: Command::Status, json: true });
    assert_eq!(p(&["--json", "task", "list"]).unwrap(), Invocation { command: Command::TaskList, json: true });
    assert!(p(&["status", "now"]).is_err());
    // Anything that is not a command is a path to open (VS Code's `code <path>`).
    assert_eq!(c(&["frobnicate"]), Command::Editor(Editor { paths: vec![Target::plain("frobnicate")], ..Default::default() }));
  }

  fn ed(args: &[&str]) -> Editor {
    match c(args) {
      Command::Editor(e) => e,
      other => panic!("{args:?}: {other:?}"),
    }
  }

  #[test]
  fn parses_the_editor_form_like_vs_code() {
    assert_eq!(ed(&["."]).paths, [Target::plain(".")]);
    assert_eq!(ed(&["src", "README.md"]).paths, [Target::plain("src"), Target::plain("README.md")]);
    // Without -g a `:12` stays part of the name; with it, it is the position.
    assert_eq!(ed(&["a.rs:12"]).paths, [Target::plain("a.rs:12")]);
    let g = ed(&["-g", "src/a.rs:12:3", "b.ts:4"]);
    assert!(g.goto);
    assert_eq!(g.paths, [Target { path: "src/a.rs".into(), line: Some(12), column: Some(3) }, Target { path: "b.ts".into(), line: Some(4), column: None }]);
    assert_eq!(ed(&["--goto", "x.md:2"]).paths[0].line, Some(2));
    let d = ed(&["-d", "a.txt", "b.txt"]);
    assert!(d.diff && d.paths.len() == 2);
    assert!(p(&["--diff", "a.txt"]).unwrap_err().contains("two"));
    let m = ed(&["--merge", "ours", "theirs", "base", "out"]);
    assert!(m.merge && m.paths.len() == 4);
    assert!(p(&["-m", "a", "b", "c"]).unwrap_err().contains("four"));
    assert!(p(&["-d", "-m", "a", "b"]).is_err());
    let a = ed(&["-a", "../lib"]);
    assert!(a.add && a.paths == [Target::plain("../lib")]);
    assert!(ed(&["--remove", "x"]).remove);
    assert!(p(&["--add"]).unwrap_err().contains("--add"));
    assert!(p(&["--add", "--remove", "x"]).is_err());
    let n = ed(&["-n", "-w", "f.txt"]);
    assert!(n.new_window && n.wait && !n.reuse_window);
    // Grouped single-letter switches, as git's `core.editor = kingu -nw` would pass them.
    let grouped = ed(&["-nw", "COMMIT_EDITMSG"]);
    assert!(grouped.new_window && grouped.wait);
    assert!(ed(&["--reuse-window", "."]).reuse_window);
    assert!(p(&["-n", "-r"]).unwrap_err().contains("--new-window"));
    assert!(p(&["-x"]).unwrap_err().contains("unknown option"));
    assert!(p(&["-wx"]).unwrap_err().contains("unknown option"));
    assert!(p(&["--frobnicate"]).unwrap_err().contains("unknown option"));
    assert_eq!(ed(&["--profile", "Work", "."]).profile.as_deref(), Some("Work"));
    assert_eq!(ed(&["--profile=Thai Docs"]).profile.as_deref(), Some("Thai Docs"));
    assert!(p(&["--profile"]).unwrap_err().contains("needs a value"));
    assert!(p(&["--profile", " "]).is_err());
    // `-` reads stdin, in its place among the paths; only once.
    let s = ed(&["-d", "old.txt", "-"]);
    assert_eq!((s.stdin, s.paths.len()), (Some(1), 1));
    assert_eq!(ed(&["-"]).stdin, Some(0));
    assert!(p(&["-", "-"]).is_err());
    // `--` ends the options: a file may start with a dash.
    assert_eq!(ed(&["-w", "--", "-notes.md", "-n"]).paths, [Target::plain("-notes.md"), Target::plain("-n")]);
    // A window with no paths (focus, or a new empty one).
    assert_eq!(ed(&["-n"]), Editor { new_window: true, ..Default::default() });
  }

  #[test]
  fn only_plain_paths_can_wait_for_a_fresh_app() {
    assert!(!ed(&["."]).needs_running_app());
    assert!(!ed(&["-n", "a", "b"]).needs_running_app());
    for args in [&["-g", "a:1"][..], &["-d", "a", "b"], &["-w", "a"], &["-a", "x"], &["--profile", "P"], &["-"]] {
      assert!(ed(args).needs_running_app(), "{args:?}");
    }
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
