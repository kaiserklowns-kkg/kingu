//! The command's side: a parsed command → one request, sent over the app's socket; the answer
//! printed for a person (or as JSON with `--json`).

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::args::{Command, Editor};
use crate::i18n::{Msg, tr};
use crate::protocol::{self, Request, Response};

/// Exit codes: the app refused or failed; bad usage; the app is not running or unreachable.
pub const EXIT_FAILED: i32 = 1;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_UNAVAILABLE: i32 = 3;

/// Bigger prompts are refused here (the app keeps prompts under 64 KB).
pub const MAX_PROMPT: usize = 64 * 1024;

/// The method and params for `cmd`; `prompt` is the text read from stdin for `--prompt -`.
/// Relative paths are made absolute against `cwd`. None for commands handled locally.
pub fn request_of(cmd: &Command, cwd: &Path, stdin_prompt: Option<String>) -> Result<Option<(&'static str, Value)>, String> {
  Ok(Some(match cmd {
    Command::Help | Command::Version => return Ok(None),
    Command::Status => (protocol::METHOD_STATUS, json!({})),
    Command::TaskList => (protocol::METHOD_TASK_LIST, json!({})),
    Command::TaskCreate { title, prompt, base, mode, background } => {
      let prompt = match prompt.as_deref() {
        Some("-") => stdin_prompt.unwrap_or_default(),
        Some(p) => p.to_owned(),
        None => String::new(),
      };
      if prompt.len() > MAX_PROMPT {
        return Err(tr(Msg::PromptTooLarge, &[("kb", &(MAX_PROMPT / 1024))]));
      }
      // `cwd`: the app picks the window, and a caller inside a task's worktree dispatches a sub-task.
      (protocol::METHOD_TASK_CREATE, json!({ "title": title, "prompt": prompt, "base": base, "mode": mode, "open": !background, "cwd": cwd.display().to_string() }))
    }
    Command::TaskOpen { slug } => (protocol::METHOD_TASK_OPEN, json!({ "slug": slug })),
    // `cwd`: without a slug, the app finds the task whose worktree this runs in.
    Command::TaskSet { slug, comment } => (protocol::METHOD_TASK_SET, json!({ "slug": slug, "comment": comment, "cwd": cwd.display().to_string() })),
    Command::CleanupPreview => (protocol::METHOD_CLEANUP_PREVIEW, json!({ "cwd": cwd.display().to_string() })),
    Command::CleanupRun { request_id } => {
      let id = request_id.clone().unwrap_or_else(new_request_id);
      (protocol::METHOD_CLEANUP_RUN, json!({ "cwd": cwd.display().to_string(), "requestId": id }))
    }
    Command::CleanupReport => (protocol::METHOD_CLEANUP_REPORT, json!({ "cwd": cwd.display().to_string() })),
    Command::CleanupReceipt { request_id } => (protocol::METHOD_CLEANUP_RECEIPT, json!({ "cwd": cwd.display().to_string(), "requestId": request_id })),
    Command::Open { path, line, column } => {
      let p = Path::new(path);
      let abs = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
      (protocol::METHOD_OPEN, json!({ "path": abs.display().to_string(), "line": line, "column": column }))
    }
    Command::Notify { message, title } => (protocol::METHOD_NOTIFY, json!({ "message": message, "title": title })),
    Command::ArtifactPublish { file, title, description, assets, id } => {
      let entry = absolute(cwd, file);
      let folder = entry.parent().unwrap_or(cwd).to_path_buf();
      let assets: Vec<Value> = assets
        .iter()
        .map(|(path, name)| {
          let abs = absolute(cwd, path);
          let name = name.clone().unwrap_or_else(|| asset_name(&folder, &abs));
          json!({ "path": abs.display().to_string(), "name": name })
        })
        .collect();
      (
        protocol::METHOD_ARTIFACT_PUBLISH,
        json!({
          "cwd": cwd.display().to_string(),
          "file": entry.display().to_string(),
          "title": title,
          "description": description,
          "assets": assets,
          "id": id,
          "source": "cli",
        }),
      )
    }
    Command::ArtifactList => (protocol::METHOD_ARTIFACT_LIST, json!({ "cwd": cwd.display().to_string() })),
    // The login runs first (`main`), then `account_add_request` registers it.
    Command::AccountAdd { .. } => return Ok(None),
    Command::AccountList { agent } => (protocol::METHOD_ACCOUNT_LIST_DATA, json!({ "provider": agent })),
    Command::AccountSelect { agent, account } => (protocol::METHOD_ACCOUNT_SELECT_DATA, json!({ "provider": agent, "accountId": account })),
    Command::AccountRemove { agent, account } => (protocol::METHOD_ACCOUNT_REMOVE_DATA, json!({ "provider": agent, "accountId": account })),
    Command::Editor(e) => (protocol::METHOD_EDITOR_OPEN, editor_params(e, cwd)),
  }))
}

/// `editor.open`'s params: every path absolute (`main` has put the stdin file in its place).
pub fn editor_params(e: &Editor, cwd: &Path) -> Value {
  let paths: Vec<Value> = e.paths.iter().map(|t| json!({ "path": absolute(cwd, &t.path).display().to_string(), "line": t.line, "column": t.column })).collect();
  json!({
    "cwd": cwd.display().to_string(),
    "paths": paths,
    "diff": e.diff,
    "merge": e.merge,
    "add": e.add,
    "remove": e.remove,
    "newWindow": e.new_window,
    "reuseWindow": e.reuse_window,
    "wait": e.wait,
    "profile": e.profile,
  })
}

/// The launch arguments for a Kingu that is not running: the absolute paths.
pub fn launch_paths(e: &Editor, cwd: &Path) -> Vec<PathBuf> {
  e.paths.iter().map(|t| absolute(cwd, &t.path)).collect()
}

/// Bigger stdin is refused (VS Code reads it into a temporary file too).
pub const MAX_STDIN: usize = 64 * 1024 * 1024;

/// Writes what was read from stdin to a new owner-only `kingu-stdin-<n>.txt` in `dir`.
pub fn write_stdin_file(dir: &Path, text: &[u8]) -> Result<PathBuf, String> {
  use std::io::Write;
  for attempt in 0..16u32 {
    let n = protocol::new_token()?;
    let path = dir.join(format!("kingu-stdin-{}.txt", &n[..if attempt < 8 { 6 } else { 12 }]));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
      use std::os::unix::fs::OpenOptionsExt;
      opts.mode(0o600);
    }
    match opts.open(&path) {
      Ok(mut f) => return f.write_all(text).map(|()| path.clone()).map_err(|e| format!("{}: {e}", path.display())),
      Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
      Err(e) => return Err(format!("{}: {e}", path.display())),
    }
  }
  Err(format!("{}: no free name", dir.display()))
}

fn absolute(cwd: &Path, path: &str) -> PathBuf {
  let p = Path::new(path);
  if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) }
}

/// An asset's name inside the artifact: its path below the entry file's folder (with `/`), else
/// its file name. Lexical only (`a/../b` stays as typed; the app checks names).
pub fn asset_name(folder: &Path, asset: &Path) -> String {
  match asset.strip_prefix(folder) {
    Ok(rel) if !rel.as_os_str().is_empty() => rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"),
    _ => asset.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
  }
}

/// Registers a login `kingu account add` saved under `source_data_home` (an XDG data home).
pub fn account_add_request(agent: &str, label: Option<&str>, source_data_home: &Path) -> (&'static str, Value) {
  let label = label.map(str::to_owned).unwrap_or_else(|| if agent == "devin" { "Devin".into() } else { "OpenCode".into() });
  (protocol::METHOD_ACCOUNT_ADD_DATA, json!({ "provider": agent, "sourceDataHome": source_data_home.display().to_string(), "label": label }))
}

/// A managed-accounts answer (`{opencode: State, devin: State}`, either may be missing) as text.
fn render_data_accounts(result: &Value) -> String {
  let mut blocks = Vec::new();
  for (key, title) in [("opencode", "OpenCode"), ("devin", "Devin")] {
    let Some(state) = result.get(key).filter(|v| v.is_object()) else { continue };
    let accounts = state["accounts"].as_array().map(Vec::as_slice).unwrap_or_default();
    let active = state["activeAccountId"].as_str();
    let mark = |on: bool| if on { format!(" {}", tr(Msg::ActiveMark, &[])) } else { String::new() };
    let mut lines = vec![if accounts.is_empty() { tr(Msg::NoManaged, &[("provider", &title)]) } else { tr(Msg::ManagedHeader, &[("provider", &title), ("count", &accounts.len())]) }];
    lines.push(format!("  system  {}{}", tr(Msg::SystemDefault, &[]), mark(active.is_none())));
    for a in accounts {
      let id = a["id"].as_str().unwrap_or("");
      lines.push(format!("  {id}  {}{}", a["label"].as_str().unwrap_or(""), mark(active == Some(id))));
    }
    blocks.push(lines.join("\n"));
  }
  blocks.join("\n\n")
}

/// What a person sees for a successful answer.
/// `run-<ms>-<pid>`: unique enough for one machine, and printed so a lost answer can be recovered.
fn new_request_id() -> String {
  let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
  format!("run-{ms}-{}", std::process::id())
}

fn render_cleanup(method: &str, result: &Value) -> String {
  let rows = |key: &str| result[key].as_array().map(Vec::as_slice).unwrap_or_default();
  if method == protocol::METHOD_CLEANUP_PREVIEW {
    let tasks = rows("tasks");
    if tasks.is_empty() {
      return tr(Msg::CleanupNothing, &[]);
    }
    let ready = tasks.iter().filter(|t| t["action"] != "keep").count();
    let head = tr(Msg::CleanupPreviewHead, &[("ready", &ready), ("kept", &(tasks.len() - ready)), ("rules", &result["rules"].as_str().unwrap_or(""))]);
    let lines = tasks.iter().map(|t| format!("{}\t{}\t{}", t["slug"].as_str().unwrap_or(""), t["action"].as_str().unwrap_or(""), t["label"].as_str().unwrap_or("")));
    return std::iter::once(head).chain(lines).collect::<Vec<_>>().join("\n");
  }
  let mut out = vec![tr(
    Msg::CleanupRunDone,
    &[("removed", &rows("removed").len()), ("archived", &rows("archived").len()), ("failed", &rows("failed").len()), ("kept", &result["kept"].as_u64().unwrap_or(0))],
  )];
  out.extend(rows("removed").iter().chain(rows("archived")).map(|s| format!("  {}", s.as_str().unwrap_or(""))));
  out.extend(rows("failed").iter().map(|f| tr(Msg::CleanupFailedRow, &[("slug", &f["slug"].as_str().unwrap_or("")), ("error", &f["error"].as_str().unwrap_or(""))])));
  out.push(tr(Msg::CleanupRequestId, &[("id", &result["requestId"].as_str().unwrap_or(""))]));
  if result["replayed"] == true {
    out.push(tr(Msg::CleanupReplayed, &[]));
  }
  out.join("\n")
}

/// `ms` (milliseconds since 1970, UTC) as `YYYY-MM-DD HH:MM`, `offset` seconds east of UTC.
fn format_time(ms: i64, offset: i64) -> String {
  let secs = ms.div_euclid(1000) + offset;
  let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
  // Howard Hinnant's civil_from_days.
  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z - era * 146_097;
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let day = doy - (153 * mp + 2) / 5 + 1;
  let month = if mp < 10 { mp + 3 } else { mp - 9 };
  let year = yoe + era * 400 + i64::from(month <= 2);
  format!("{year:04}-{month:02}-{day:02} {:02}:{:02}", rem / 3600, rem % 3600 / 60)
}

/// The local time zone's offset from UTC at `ms`, in seconds (the C library knows the zone and DST).
#[cfg(unix)]
fn local_offset(ms: i64) -> i64 {
  let t = ms.div_euclid(1000) as libc::time_t;
  // SAFETY: `localtime_r` writes into `tm`, which outlives the call; null means it could not convert.
  let mut tm: libc::tm = unsafe { std::mem::zeroed() };
  if unsafe { libc::localtime_r(&t, &mut tm) }.is_null() { 0 } else { tm.tm_gmtoff as i64 }
}

#[cfg(not(unix))]
fn local_offset(_ms: i64) -> i64 {
  0
}

/// `kingu cleanup report`: compact lines; `offset` gives the time zone at a moment (local, or fixed in tests).
fn render_cleanup_report(result: &Value, offset: &dyn Fn(i64) -> i64) -> String {
  let time = |v: &Value| v.as_i64().map(|ms| format_time(ms, offset(ms)));
  let rules: Vec<&str> = result["rules"].as_array().map(Vec::as_slice).unwrap_or_default().iter().filter_map(Value::as_str).collect();
  let rules = match (result["source"].as_str(), rules.is_empty()) {
    (Some("project-off"), _) => tr(Msg::CleanupRulesOffProject, &[]),
    (_, true) => tr(Msg::CleanupRulesOff, &[]),
    _ => rules.join(", "),
  };
  let auto = result["auto"] == true;
  let state = tr(if auto { Msg::CleanupOn } else { Msg::CleanupOff }, &[]);
  let last = time(&result["lastRunAt"]).unwrap_or_else(|| tr(Msg::CleanupNever, &[]));
  let next = match time(&result["nextRunAt"]) {
    Some(t) => t,
    None if auto => tr(Msg::CleanupNextWhenOpen, &[]),
    None => tr(Msg::CleanupOff, &[]),
  };
  let mut out = vec![
    tr(Msg::CleanupReportRules, &[("rules", &rules)]),
    tr(Msg::CleanupReportAuto, &[("state", &state)]),
    tr(Msg::CleanupReportLastRun, &[("time", &last)]),
    tr(Msg::CleanupReportNextCheck, &[("time", &next)]),
  ];
  let activity = result["activity"].as_array().map(Vec::as_slice).unwrap_or_default();
  if activity.is_empty() {
    out.push(tr(Msg::CleanupNoActivity, &[]));
    return out.join("\n");
  }
  out.push(tr(Msg::CleanupReportActivity, &[]));
  for a in activity {
    let source = match a["source"].as_str() {
      Some("auto") => tr(Msg::CleanupSourceAuto, &[]),
      Some("cli") => tr(Msg::CleanupSourceCli, &[]),
      Some("dialog") => tr(Msg::CleanupSourceDialog, &[]),
      other => other.unwrap_or("").to_owned(),
    };
    let count = |key: &str| a[key].as_array().map_or(0, Vec::len);
    let row = tr(
      Msg::CleanupActivityRow,
      &[("time", &time(&a["at"]).unwrap_or_default()), ("source", &source), ("removed", &count("removed")), ("archived", &count("archived")), ("failed", &count("failed")), ("kept", &a["kept"].as_u64().unwrap_or(0))],
    );
    out.push(format!("  {row}"));
  }
  out.join("\n")
}

pub fn render(method: &str, result: &Value) -> String {
  match method {
    protocol::METHOD_CLEANUP_REPORT => render_cleanup_report(result, &local_offset),
    protocol::METHOD_CLEANUP_PREVIEW | protocol::METHOD_CLEANUP_RUN | protocol::METHOD_CLEANUP_RECEIPT => render_cleanup(method, result),
    protocol::METHOD_STATUS => {
      let mut out = format!("Kingu {} (pid {})", result["app_version"].as_str().unwrap_or("?"), result["pid"].as_u64().unwrap_or(0));
      match result["workspace"].as_str() {
        Some(w) => out.push_str(&format!("\n{}", tr(Msg::StatusFolder, &[("folder", &w), ("tasks", &result["tasks"].as_u64().unwrap_or(0))]))),
        None => out.push_str(&format!("\n{}", tr(Msg::NoFolder, &[]))),
      }
      out
    }
    protocol::METHOD_TASK_LIST => {
      let rows: Vec<String> = result["tasks"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|t| format!("{}\t{}\t{}", t["slug"].as_str().unwrap_or(""), t["status"].as_str().unwrap_or(""), t["title"].as_str().unwrap_or("")))
        .collect();
      if rows.is_empty() { tr(Msg::NoTasks, &[]) } else { rows.join("\n") }
    }
    protocol::METHOD_TASK_CREATE => result["slug"].as_str().unwrap_or("").to_owned(),
    protocol::METHOD_ARTIFACT_PUBLISH => {
      let version = result["version"].as_u64().unwrap_or(0).to_string();
      let head = tr(Msg::ArtifactPublished, &[("title", &result["title"].as_str().unwrap_or("")), ("id", &result["id"].as_str().unwrap_or("")), ("version", &version)]);
      format!("{head}\n{}", result["path"].as_str().unwrap_or(""))
    }
    protocol::METHOD_ARTIFACT_LIST => {
      let rows: Vec<String> = result["artifacts"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|a| format!("{}  v{}  {}  {}", a["id"].as_str().unwrap_or(""), a["version"].as_u64().unwrap_or(0), a["format"].as_str().unwrap_or(""), a["title"].as_str().unwrap_or("")))
        .collect();
      if rows.is_empty() { tr(Msg::NoArtifacts, &[]) } else { rows.join("\n") }
    }
    protocol::METHOD_ACCOUNT_LIST_DATA | protocol::METHOD_ACCOUNT_ADD_DATA | protocol::METHOD_ACCOUNT_SELECT_DATA | protocol::METHOD_ACCOUNT_REMOVE_DATA => render_data_accounts(result),
    _ => String::new(),
  }
}

/// How long an answer may take: starting a task waits for the window (the app gives it 30 s).
pub const ANSWER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);
/// `workspaceCleanup.run` removes worktrees one by one: the app gives it 10 minutes, so the command waits a little longer.
pub const CLEANUP_RUN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(11 * 60);

/// How long the command waits for `method`'s answer.
pub fn answer_timeout(method: &str) -> std::time::Duration {
  if method == protocol::METHOD_CLEANUP_RUN { CLEANUP_RUN_TIMEOUT } else { ANSWER_TIMEOUT }
}

/// Sends one request over the app's socket and reads its answer.
pub fn call(socket: &Path, token: &str, method: &str, params: Value) -> Result<Response, (i32, String)> {
  call_with(socket, token, method, params, Some(ANSWER_TIMEOUT))
}

/// [`call`] waiting `timeout` for the answer (`None`: as long as it takes, for `editor.wait`).
#[cfg(unix)]
pub fn call_with(socket: &Path, token: &str, method: &str, params: Value, timeout: Option<std::time::Duration>) -> Result<Response, (i32, String)> {
  use std::io::{BufRead, BufReader, Read, Write};
  use std::os::unix::net::UnixStream;
  use std::time::Duration;
  let mut stream = UnixStream::connect(socket).map_err(|e| (EXIT_UNAVAILABLE, tr(Msg::NotReachable, &[("socket", &socket.display()), ("detail", &e)])))?;
  let _ = stream.set_read_timeout(timeout);
  let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
  let req = Request { id: 1, auth_token: token.to_owned(), method: method.to_owned(), params };
  stream.write_all(protocol::encode(&req).as_bytes()).map_err(|e| (EXIT_UNAVAILABLE, tr(Msg::SendFailed, &[("detail", &e)])))?;
  let mut line = String::new();
  BufReader::new(stream.take(protocol::MAX_LINE as u64 + 1)).read_line(&mut line).map_err(|e| (EXIT_UNAVAILABLE, tr(Msg::NoAnswer, &[("detail", &e)])))?;
  if line.is_empty() {
    return Err((EXIT_UNAVAILABLE, tr(Msg::ClosedWithoutAnswer, &[])));
  }
  protocol::decode_response(&line).map_err(|e| (EXIT_FAILED, e))
}

#[cfg(not(unix))]
pub fn call_with(_socket: &Path, _token: &str, _method: &str, _params: Value, _timeout: Option<std::time::Duration>) -> Result<Response, (i32, String)> {
  Err((EXIT_UNAVAILABLE, tr(Msg::Unsupported, &[])))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_cleanup_run_waits_longer_than_the_app_does_and_other_commands_keep_the_usual_wait() {
    // The app answers within 10 minutes; the command must not give up before it.
    assert!(answer_timeout(protocol::METHOD_CLEANUP_RUN) > std::time::Duration::from_secs(10 * 60));
    for m in [protocol::METHOD_CLEANUP_PREVIEW, protocol::METHOD_TASK_CREATE, protocol::METHOD_STATUS] {
      assert_eq!(answer_timeout(m), ANSWER_TIMEOUT, "{m}");
    }
  }

  #[test]
  fn cleanup_report_asks_the_window_and_renders_rules_schedule_and_runs() {
    let cwd = Path::new("/repo");
    let (method, params) = request_of(&Command::CleanupReport, cwd, None).unwrap().unwrap();
    assert_eq!(method, protocol::METHOD_CLEANUP_REPORT);
    assert_eq!(method, "workspaceCleanup.report");
    assert_eq!(params["cwd"], "/repo");

    // 2026-11-16 07:03 UTC, shown at UTC+7.
    let at = 1_794_812_580_000_i64;
    let report = json!({
      "rules": ["merged", "inactive"], "source": "global", "auto": true, "lastRunAt": at, "nextRunAt": at + 3_600_000,
      "activity": [
        { "at": at, "source": "auto", "removed": ["a", "b"], "failed": [], "kept": 5 },
        { "at": at - 60_000, "source": "cli", "removed": [], "archived": ["d"], "failed": [{ "slug": "c", "error": "x" }], "kept": 1 }
      ]
    });
    assert_eq!(
      render_cleanup_report(&report, &|_| 7 * 3600),
      "rules: merged, inactive\nautomatic cleanup: on\nlast run: 2026-11-16 14:03\nnext check: 2026-11-16 15:03\nruns since this window opened (newest first):\n  2026-11-16 14:03  automatic  removed 2, archived 0, failed 0, kept 5\n  2026-11-16 14:02  command line  removed 0, archived 1, failed 1, kept 1"
    );

    let empty = json!({ "rules": [], "source": "project-off", "auto": true, "lastRunAt": null, "nextRunAt": null, "activity": [] });
    assert_eq!(
      render_cleanup_report(&empty, &|_| 0),
      "rules: off (this project)\nautomatic cleanup: on\nlast run: never\nnext check: as soon as a folder is open\nno cleanup has run since this window opened"
    );
    let off = json!({ "rules": [], "source": "global", "auto": false, "lastRunAt": null, "nextRunAt": null, "activity": [] });
    assert!(render_cleanup_report(&off, &|_| 0).starts_with("rules: off\nautomatic cleanup: off\nlast run: never\nnext check: off\n"));
  }

  #[test]
  fn builds_requests_with_absolute_paths_and_stdin_prompts() {
    let cwd = Path::new("/repo");
    let open = Command::Open { path: "src/a.ts".into(), line: Some(3), column: None };
    let (m, p) = request_of(&open, cwd, None).unwrap().unwrap();
    assert_eq!((m, p), (protocol::METHOD_OPEN, json!({ "path": "/repo/src/a.ts", "line": 3, "column": null })));
    let (_, p) = request_of(&Command::Open { path: "/etc/x".into(), line: None, column: None }, cwd, None).unwrap().unwrap();
    assert_eq!(p["path"], "/etc/x");
    let create = Command::TaskCreate { title: "Fix".into(), prompt: Some("-".into()), base: None, mode: Some("terminal".into()), background: true };
    let (m, p) = request_of(&create, cwd, Some("from stdin".into())).unwrap().unwrap();
    assert_eq!((m, p), (protocol::METHOD_TASK_CREATE, json!({ "title": "Fix", "prompt": "from stdin", "base": null, "mode": "terminal", "open": false, "cwd": "/repo" })));
    let big = Command::TaskCreate { title: "x".into(), prompt: Some("a".repeat(MAX_PROMPT + 1)), base: None, mode: None, background: false };
    assert!(request_of(&big, cwd, None).is_err());
    assert!(request_of(&Command::Help, cwd, None).unwrap().is_none());
    let (m, p) = request_of(&Command::Notify { message: "done".into(), title: None }, cwd, None).unwrap().unwrap();
    assert_eq!((m, p), (protocol::METHOD_NOTIFY, json!({ "message": "done", "title": null })));
  }

  #[test]
  fn builds_editor_requests_with_absolute_paths() {
    use crate::args::Target;
    let cwd = Path::new("/repo");
    let e = Editor {
      paths: vec![Target { path: "src/a.rs".into(), line: Some(3), column: Some(2) }, Target::plain("/etc/hosts"), Target::plain(".")],
      goto: true,
      wait: true,
      profile: Some("Work".into()),
      ..Default::default()
    };
    let (m, p) = request_of(&Command::Editor(e.clone()), cwd, None).unwrap().unwrap();
    assert_eq!(m, protocol::METHOD_EDITOR_OPEN);
    assert_eq!(
      p,
      json!({
        "cwd": "/repo",
        "paths": [{ "path": "/repo/src/a.rs", "line": 3, "column": 2 }, { "path": "/etc/hosts", "line": null, "column": null }, { "path": "/repo/.", "line": null, "column": null }],
        "diff": false, "merge": false, "add": false, "remove": false, "newWindow": false, "reuseWindow": false, "wait": true, "profile": "Work",
      })
    );
    assert_eq!(launch_paths(&e, cwd), [PathBuf::from("/repo/src/a.rs"), PathBuf::from("/etc/hosts"), PathBuf::from("/repo/.")]);
  }

  #[test]
  fn writes_stdin_to_a_private_temporary_file() {
    let tmp = tempfile::tempdir().unwrap();
    let a = write_stdin_file(tmp.path(), "สวัสดี\n".as_bytes()).unwrap();
    let b = write_stdin_file(tmp.path(), b"").unwrap();
    assert_ne!(a, b);
    assert!(a.file_name().unwrap().to_str().unwrap().starts_with("kingu-stdin-"));
    assert_eq!(std::fs::read_to_string(&a).unwrap(), "สวัสดี\n");
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(std::fs::metadata(&a).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert!(write_stdin_file(&tmp.path().join("missing"), b"x").is_err());
  }

  #[test]
  fn builds_artifact_requests() {
    let cwd = Path::new("/repo");
    let cmd = Command::ArtifactPublish {
      file: "out/report.html".into(),
      title: Some("Report".into()),
      description: None,
      assets: vec![("out/img/a.png".into(), None), ("/tmp/logo.svg".into(), None), ("data.json".into(), Some("d/data.json".into()))],
      id: None,
    };
    let (m, p) = request_of(&cmd, cwd, None).unwrap().unwrap();
    assert_eq!(m, protocol::METHOD_ARTIFACT_PUBLISH);
    assert_eq!(
      p,
      json!({
        "cwd": "/repo", "file": "/repo/out/report.html", "title": "Report", "description": null, "id": null, "source": "cli",
        "assets": [
          { "path": "/repo/out/img/a.png", "name": "img/a.png" },
          { "path": "/tmp/logo.svg", "name": "logo.svg" },
          { "path": "/repo/data.json", "name": "d/data.json" },
        ],
      })
    );
    assert_eq!(request_of(&Command::ArtifactList, cwd, None).unwrap().unwrap(), (protocol::METHOD_ARTIFACT_LIST, json!({ "cwd": "/repo" })));
    assert_eq!(asset_name(Path::new("/a"), Path::new("/a/b/c.png")), "b/c.png");
    assert_eq!(asset_name(Path::new("/a"), Path::new("/x/c.png")), "c.png");
  }

  #[test]
  fn renders_artifact_answers() {
    let published = json!({ "id": "0123456789abcdef", "version": 2, "title": "Report", "format": "html", "root": "/repo", "path": "/repo/.kingu/artifacts/0123456789abcdef/v2/index.html" });
    assert_eq!(render(protocol::METHOD_ARTIFACT_PUBLISH, &published), "Published Report (artifact 0123456789abcdef, version 2)\n/repo/.kingu/artifacts/0123456789abcdef/v2/index.html");
    let list = json!({ "root": "/repo", "artifacts": [{ "id": "0123456789abcdef", "title": "Report", "format": "markdown", "version": 3, "updated_at": 1 }] });
    assert_eq!(render(protocol::METHOD_ARTIFACT_LIST, &list), "0123456789abcdef  v3  markdown  Report");
    assert_eq!(render(protocol::METHOD_ARTIFACT_LIST, &json!({ "artifacts": [] })), "no artifacts");
  }

  #[test]
  fn renders_answers_for_people() {
    let status = json!({ "app_version": "0.1.0", "pid": 9, "workspace": "/repo", "tasks": 2 });
    assert_eq!(render(protocol::METHOD_STATUS, &status), "Kingu 0.1.0 (pid 9)\nfolder: /repo\ntasks: 2");
    assert!(render(protocol::METHOD_STATUS, &json!({ "app_version": "0.1.0", "pid": 9, "workspace": null })).ends_with("no folder open"));
    let list = json!({ "tasks": [{ "slug": "fix-login", "status": "running", "title": "Fix login" }] });
    assert_eq!(render(protocol::METHOD_TASK_LIST, &list), "fix-login\trunning\tFix login");
    assert_eq!(render(protocol::METHOD_TASK_LIST, &json!({ "tasks": [] })), "no tasks");
    assert_eq!(render(protocol::METHOD_TASK_CREATE, &json!({ "slug": "fix" })), "fix");
    assert_eq!(render(protocol::METHOD_NOTIFY, &json!(null)), "");
  }

  #[cfg(unix)]
  #[test]
  fn talks_to_a_server_over_a_unix_socket() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;
    let tmp = tempfile::tempdir().unwrap();
    let sock = tmp.path().join("s.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let token = protocol::new_token().unwrap();
    let server_token = token.clone();
    let server = std::thread::spawn(move || {
      for _ in 0..2 {
        let (stream, _) = listener.accept().unwrap();
        let mut line = String::new();
        BufReader::new(stream.try_clone().unwrap()).read_line(&mut line).unwrap();
        let res = protocol::handle_line(&line, &server_token, |r| Ok(json!({ "echo": r.params })));
        (&stream).write_all(protocol::encode(&res).as_bytes()).unwrap();
      }
    });
    let ok = call(&sock, &token, "status", json!({ "a": 1 })).unwrap();
    assert_eq!((ok.ok, ok.result), (true, Some(json!({ "echo": { "a": 1 } }))));
    let refused = call(&sock, "nope", "status", json!({})).unwrap();
    assert_eq!(refused.error.unwrap().code, protocol::ERR_UNAUTHORIZED);
    server.join().unwrap();
    let (code, _) = call(&tmp.path().join("missing.sock"), &token, "status", json!({})).unwrap_err();
    assert_eq!(code, EXIT_UNAVAILABLE);
  }
}
