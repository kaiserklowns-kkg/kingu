//! A worktree on an SSH host opened as a window's workspace (Orca opens a remote repository's
//! worktree like a local one: `src/main/providers/execution-host-provider-dispatch.ts` sends each
//! filesystem and git call to the local provider or to the SSH one). Kingu's split: the window's
//! session holds a [`RemoteRoot`] instead of local folders, so `Workspace::root()` refuses every
//! command that has no remote side yet ("not on an SSH host yet"), and the commands that do (the
//! Explorer, text files, Quick Open, Search, Source Control, terminals) check
//! `Workspace::remote()` first and run here: one `ssh … sh -c '<script>'` per call over the shared
//! connection (ssh_hosts.rs `remote_input`, `ControlMaster`, in-app prompts through ssh_askpass.rs).
//!
//! The webview names the root `ssh://<host id><path>` (never a local path, so nothing local is
//! touched by mistake) and every file inside it by its path relative to it, as for a local folder.

use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::fs::DirEntry;
use crate::git::{CommitOptions, GitStatus, Operation, StatusOptions};
use crate::search::{RgParser, SearchEvent, SearchOptions};
use crate::ssh_hosts::{self, Target, posix_dir, sh_quote};
use crate::ssh_remote::check_rel;
use crate::textfile::{self, Expected, ReadOptions, ReadResult, Stat, WriteResult};

pub const SCHEME: &str = "ssh://";
/// A remote file larger than this never opens (Kingu's limit over ssh, **estimated**; a local
/// file may go to `textfile::MAX_FILE_SIZE`).
pub const REMOTE_MAX_FILE: u64 = 50 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_millis(ssh_hosts::REMOTE_TIMEOUT_MS * 2);
const GIT_TIMEOUT: Duration = Duration::from_millis(crate::ssh_remote::GIT_TIMEOUT_MS);
const QUICK_OPEN_LIMIT: usize = 20_000;
/// Search output read from the host at most (Kingu's, **estimated**).
const SEARCH_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteRoot {
  pub target: Target,
  /// The SSH project's root (projects.json).
  pub root: String,
  /// The worktree opened: the root or one of its task worktrees.
  pub path: String,
}

/// What the webview learns of it (windows.rs `WorkspaceState.remote`).
#[derive(Debug, Clone, Serialize)]
pub struct RemoteInfo {
  pub host: String,
  pub host_label: String,
  pub root: String,
  pub path: String,
  pub uri: String,
}

impl RemoteRoot {
  pub fn uri(&self) -> String {
    format!("{SCHEME}{}{}", self.target.id, self.path)
  }

  /// `app [host]` (a task worktree: `app / slug [host]`).
  pub fn name(&self) -> String {
    let leaf = |p: &str| p.trim_end_matches('/').rsplit('/').next().unwrap_or(p).to_string();
    let base = if self.path == self.root { leaf(&self.root) } else { format!("{} / {}", leaf(&self.root), leaf(&self.path)) };
    format!("{base} [{}]", self.target.label)
  }

  pub fn info(&self) -> RemoteInfo {
    RemoteInfo { host: self.target.id.clone(), host_label: self.target.label.clone(), root: self.root.clone(), path: self.path.clone(), uri: self.uri() }
  }

  /// A webview path (relative, or `ssh://…` absolute) → the path inside the worktree (`""`: its top).
  pub fn rel(&self, p: &str) -> Result<String, String> {
    let uri = self.uri();
    let p = p.strip_prefix(&uri).map(|r| r.trim_start_matches('/')).unwrap_or(p);
    let p = p.trim_start_matches("./").trim_end_matches('/');
    if p.is_empty() || p == "." {
      return Ok(String::new());
    }
    check_rel(p)?;
    Ok(p.to_string())
  }

  /// Like [`Self::rel`], but the top itself is refused (a file operation needs a file).
  pub fn file(&self, p: &str) -> Result<String, String> {
    let r = self.rel(p)?;
    if r.is_empty() { Err(crate::tr!(crate::i18n::msg::ProjectsMsg::RemoteBadFile, path = p)) } else { Ok(r) }
  }

  fn run(&self, script: &str, input: Option<Vec<u8>>, limit: Duration) -> Result<String, String> {
    ssh_hosts::remote_input(&self.target, script, input, limit)
  }

  fn cd(&self) -> String {
    format!("cd {} || exit 1", posix_dir(&self.path))
  }
}

fn q(rel: &str) -> String {
  sh_quote(&format!("./{rel}"))
}

fn b64(text: &str) -> Result<Vec<u8>, String> {
  let joined: String = text.chars().filter(|c| !c.is_whitespace()).collect();
  base64::engine::general_purpose::STANDARD.decode(joined).map_err(|_| crate::tr!(crate::i18n::msg::ProjectsMsg::RemoteBadAnswer))
}

const MARK: &str = "@@kingu-mark";

// ---------------------------------------------------------------------------------------------
// Files

/// One folder: its entries (folders marked `/`), then which of them git ignores.
pub fn list_script(worktree: &str, rel: &str) -> String {
  let into = if rel.is_empty() { String::new() } else { format!(" && cd -- {}", q(rel)) };
  format!(
    "cd {}{into} || exit 1\nl=$(command ls -1A | while IFS= read -r f; do if [ -d \"$f\" ]; then printf '%s/\\n' \"$f\"; else printf '%s\\n' \"$f\"; fi; done)\nprintf '%s\\n' \"$l\"\nprintf '%s\\n' '{MARK}'\nprintf '%s\\n' \"$l\" | git check-ignore --stdin 2>/dev/null\ntrue",
    posix_dir(worktree)
  )
}

pub fn parse_list(out: &str, rel: &str) -> Vec<DirEntry> {
  let (list, ignored) = out.split_once(&format!("{MARK}\n")).unwrap_or((out, ""));
  let ignored: std::collections::HashSet<&str> = ignored.lines().map(|l| l.trim_end_matches('/')).collect();
  list
    .lines()
    .filter(|l| !l.is_empty())
    .map(|l| {
      let (name, is_dir) = match l.strip_suffix('/') {
        Some(n) => (n, true),
        None => (l, false),
      };
      let path = if rel.is_empty() { name.to_string() } else { format!("{rel}/{name}") };
      DirEntry { name: name.to_string(), rel: path, is_dir, ignored: ignored.contains(name), untracked: false, modified: 0 }
    })
    .filter(|e| e.name != ".git")
    .collect()
}

pub fn list_dir(r: &RemoteRoot, path: &str) -> Result<Vec<DirEntry>, String> {
  let rel = r.rel(path)?;
  Ok(parse_list(&r.run(&list_script(&r.path, &rel), None, TIMEOUT)?, &rel))
}

/// `d` for a folder, else the size, then (when at most `limit`) the bytes as base64.
pub fn bytes_script(worktree: &str, rel: &str, limit: u64) -> String {
  format!(
    "cd {} || exit 1\nf={}\nif [ -d \"$f\" ]; then printf 'd\\n'; exit 0; fi\n[ -f \"$f\" ] || {{ printf '%s: no such file\\n' \"$f\" >&2; exit 2; }}\ns=$(wc -c < \"$f\" | tr -d ' ')\nprintf '%s\\n' \"$s\"\nif [ \"$s\" -le {limit} ]; then base64 < \"$f\"; fi",
    posix_dir(worktree),
    q(rel)
  )
}

pub enum Bytes {
  Dir,
  TooLarge(u64),
  Data(Vec<u8>),
}

pub fn parse_bytes(out: &str, limit: u64) -> Result<Bytes, String> {
  let (first, rest) = out.split_once('\n').unwrap_or((out, ""));
  if first == "d" {
    return Ok(Bytes::Dir);
  }
  let size: u64 = first.trim().parse().map_err(|_| crate::tr!(crate::i18n::msg::ProjectsMsg::RemoteBadAnswer))?;
  if size > limit {
    return Ok(Bytes::TooLarge(size));
  }
  b64(rest).map(Bytes::Data)
}

fn bytes(r: &RemoteRoot, rel: &str, limit: u64) -> Result<Bytes, String> {
  parse_bytes(&r.run(&bytes_script(&r.path, rel, limit), None, TIMEOUT)?, limit)
}

/// The text file service's read (textfile.rs `read`), over ssh.
pub fn read(r: &RemoteRoot, path: &str, opts: &ReadOptions) -> Result<ReadResult, String> {
  let rel = r.file(path)?;
  let confirm = opts.large_file_limit.unwrap_or(textfile::LARGE_FILE_LIMIT).clamp(1, REMOTE_MAX_FILE);
  let limit = if opts.accept_large { REMOTE_MAX_FILE } else { confirm };
  match bytes(r, &rel, limit)? {
    Bytes::Dir => Err(crate::tr!(crate::i18n::msg::FilesMsg::IsADirectoryBare)),
    Bytes::TooLarge(size) => Ok(ReadResult::TooLarge { size, limit }),
    Bytes::Data(b) => Ok(textfile::decode_file(&b, opts)),
  }
}

/// A whole file as text (Source Control's diffs read through `read_workspace_file`).
pub fn read_text(r: &RemoteRoot, path: &str) -> Result<String, String> {
  let rel = r.file(path)?;
  match bytes(r, &rel, 5 * 1024 * 1024)? {
    Bytes::Data(b) => Ok(String::from_utf8_lossy(&b).into_owned()),
    Bytes::Dir => Err(crate::tr!(crate::i18n::msg::FilesMsg::IsADirectoryBare)),
    Bytes::TooLarge(size) => Err(format!("{rel}: larger than 5 MB ({size} bytes)")),
  }
}

fn stat_of(b: &[u8]) -> Stat {
  // No mtime over ssh: the hash alone decides a conflict.
  Stat { mtime: 0, size: b.len() as u64, hash: textfile::hash(b), readonly: false }
}

/// The text file service's save: refused as a conflict when the host's file no longer has the
/// content the editor loaded (by hash; Kingu has no mtime over ssh), then written through stdin.
pub fn write(r: &RemoteRoot, path: &str, content: &str, encoding: &str, expected: Option<&Expected>) -> Result<WriteResult, String> {
  let rel = r.file(path)?;
  let data = match textfile::encode(content, encoding) {
    Ok(b) => b,
    Err(textfile::EncodeError::Unmappable(ch)) => return Ok(WriteResult::Unencodable { ch: ch.to_string() }),
  };
  if let Some(exp) = expected
    && !exp.hash.is_empty()
    && let Ok(Bytes::Data(now)) = bytes(r, &rel, REMOTE_MAX_FILE)
    && textfile::hash(&now) != exp.hash
  {
    return Ok(WriteResult::Conflict { stat: stat_of(&now) });
  }
  write_bytes(r, &rel, data.clone())?;
  Ok(WriteResult::Saved { stat: stat_of(&data) })
}

pub fn write_bytes(r: &RemoteRoot, rel: &str, data: Vec<u8>) -> Result<(), String> {
  r.run(&crate::ssh_remote::write_script(&r.path, rel)?, Some(data), TIMEOUT).map(drop)
}

pub fn create_file(r: &RemoteRoot, path: &str) -> Result<(), String> {
  let rel = r.file(path)?;
  r.run(&format!("{}\nf={}\n[ -e \"$f\" ] && {{ printf '%s already exists\\n' \"$f\" >&2; exit 1; }}\nmkdir -p \"$(dirname \"$f\")\" && : > \"$f\"", r.cd(), q(&rel)), None, TIMEOUT).map(drop)
}

pub fn create_dir(r: &RemoteRoot, path: &str) -> Result<(), String> {
  let rel = r.file(path)?;
  r.run(&format!("{}\nmkdir -p {}", r.cd(), q(&rel)), None, TIMEOUT).map(drop)
}

/// Rename or move inside the worktree; an existing target is refused.
pub fn rename(r: &RemoteRoot, from: &str, to: &str) -> Result<(), String> {
  let (a, b) = (r.file(from)?, r.file(to)?);
  r.run(
    &format!("{}\na={}\nb={}\n[ -e \"$b\" ] && {{ printf '%s already exists\\n' \"$b\" >&2; exit 1; }}\nmkdir -p \"$(dirname \"$b\")\" && mv \"$a\" \"$b\"", r.cd(), q(&a), q(&b)),
    None,
    TIMEOUT,
  )
  .map(drop)
}

/// Deletes for good (the host has no trash Kingu can reach; the Explorer asks first).
pub fn delete(r: &RemoteRoot, path: &str) -> Result<(), String> {
  let rel = r.file(path)?;
  r.run(&format!("{}\nrm -rf {}", r.cd(), q(&rel)), None, TIMEOUT).map(drop)
}

/// Quick Open's files (`git ls-files`, tracked and untracked, not ignored).
pub fn list_files(r: &RemoteRoot) -> Result<Vec<String>, String> {
  let mut files = crate::ssh_remote::parse_files(&r.run(&crate::ssh_remote::files_script(&r.path), None, TIMEOUT)?);
  files.truncate(QUICK_OPEN_LIMIT);
  Ok(files)
}

// ---------------------------------------------------------------------------------------------
// Search

/// ripgrep on the host when it has one (the same arguments and JSON as a local search), else
/// `git grep` (fixed text or an extended regex, `-i`, `-w`), whose lines are matched here.
pub fn search_script(worktree: &str, opts: &SearchOptions) -> String {
  let rg = crate::search::build_args(opts).iter().map(|a| sh_quote(&a.to_string_lossy())).collect::<Vec<_>>().join(" ");
  let mut gg = vec!["git", "-c", "core.quotePath=false", "grep", "-z", "-n", "-I", "--untracked", "--no-color"].into_iter().map(String::from).collect::<Vec<_>>();
  gg.push(if opts.is_regex { "-E".into() } else { "-F".into() });
  if !opts.match_case {
    gg.push("-i".into());
  }
  if opts.whole_word {
    gg.push("-w".into());
  }
  gg.push("-e".into());
  gg.push(sh_quote(&opts.query));
  format!(
    "cd {} || exit 1\nif command -v rg >/dev/null 2>&1; then printf 'rg\\n'; rg {rg} | head -c {SEARCH_BYTES}; else printf 'git\\n'; {} | head -c {SEARCH_BYTES}; fi\ntrue",
    posix_dir(worktree),
    gg.join(" ")
  )
}

/// The matches of `query` in `line` (byte ranges), as the search options ask.
fn line_matches(re: &regex::Regex, line: &str) -> Vec<(usize, usize)> {
  re.find_iter(line).filter(|m| m.end() > m.start()).map(|m| (m.start(), m.end())).collect()
}

pub fn search_regex(opts: &SearchOptions) -> Result<regex::Regex, String> {
  let body = if opts.is_regex { opts.query.clone() } else { regex::escape(&opts.query) };
  let body = if opts.whole_word { format!(r"\b(?:{body})\b") } else { body };
  regex::RegexBuilder::new(&body).case_insensitive(!opts.match_case).build().map_err(|e| e.to_string())
}

/// Search events from the host's answer: File per file, then Done.
pub fn parse_search(out: &str, opts: &SearchOptions, elapsed_ms: u64) -> Vec<SearchEvent> {
  let max = opts.max_results.unwrap_or(20_000).max(1);
  let (kind, rest) = out.split_once('\n').unwrap_or(("", ""));
  let mut events = Vec::new();
  let mut files = 0;
  let mut matches = 0;
  if kind == "rg" {
    let mut parser = RgParser::default();
    parser.full_lines = opts.context_lines.is_some();
    for line in rest.lines() {
      if let Some(ev) = parser.feed(line, max) {
        events.push(ev);
      }
      if parser.matches >= max {
        break;
      }
    }
    if let Some(ev) = parser.finish() {
      events.push(ev);
    }
    files = parser.files;
    matches = parser.matches;
  } else if let Ok(re) = search_regex(opts) {
    let mut by_file: Vec<(String, Vec<crate::search::TextMatch>)> = Vec::new();
    for l in rest.lines() {
      let mut parts = l.splitn(3, '\0');
      let (Some(path), Some(n), Some(text)) = (parts.next(), parts.next(), parts.next()) else { continue };
      let Ok(n) = n.parse::<u32>() else { continue };
      let found: Vec<_> = line_matches(&re, text).into_iter().map(|(s, e)| crate::search::make_match(n, text, s, e)).collect();
      if found.is_empty() {
        continue;
      }
      match by_file.last_mut() {
        Some((p, m)) if p == path => m.extend(found),
        _ => by_file.push((path.to_string(), found)),
      }
    }
    for (path, mut m) in by_file {
      if matches >= max {
        break;
      }
      m.truncate(max - matches);
      matches += m.len();
      files += 1;
      events.push(SearchEvent::File { path, matches: m, version: String::new(), modified: 0, lines: Vec::new() });
    }
  }
  events.push(SearchEvent::Done { files, matches, limit_hit: matches >= max, elapsed_ms });
  events
}

pub fn search(r: &RemoteRoot, opts: &SearchOptions) -> Result<Vec<SearchEvent>, String> {
  if opts.query.is_empty() {
    return Ok(vec![SearchEvent::Done { files: 0, matches: 0, limit_hit: false, elapsed_ms: 0 }]);
  }
  let started = std::time::Instant::now();
  let out = r.run(&search_script(&r.path, opts), None, GIT_TIMEOUT)?;
  Ok(parse_search(&out, opts, started.elapsed().as_millis() as u64))
}

// ---------------------------------------------------------------------------------------------
// Source Control

/// `git status` with the same arguments as a local folder (git.rs `status_args`), the remotes,
/// and the operation markers in the git dir. Outside a repository: a marker line only.
pub fn status_script(worktree: &str, opts: &StatusOptions) -> String {
  let args = crate::git::status_args(opts).iter().map(|a| sh_quote(a)).collect::<Vec<_>>().join(" ");
  format!(
    "cd {} || exit 1\ngit rev-parse --git-dir >/dev/null 2>&1 || {{ printf 'none\\n'; exit 0; }}\nprintf 'repo\\n'\ngit {args} || exit 1\nprintf '\\0%s\\n' '{MARK}'\ngit remote\nprintf '%s\\n' '{MARK}'\nd=$(git rev-parse --absolute-git-dir)\nfor m in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do [ -e \"$d/$m\" ] && printf '%s\\n' \"$m\"; done\ntrue",
    posix_dir(worktree)
  )
}

pub fn parse_status(out: &str) -> Option<GitStatus> {
  let rest = out.strip_prefix("repo\n")?;
  let (status, rest) = rest.split_once(&format!("\0{MARK}\n")).unwrap_or((rest, ""));
  let (remotes, ops) = rest.split_once(&format!("{MARK}\n")).unwrap_or((rest, ""));
  let mut st = crate::git::parse_status(status, "");
  st.entries.retain(|e| !crate::git::in_task_worktree(&e.path));
  st.remotes = remotes.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect();
  let has = |m: &str| ops.lines().any(|l| l == m);
  st.operation = if has("rebase-merge") || has("rebase-apply") {
    Some(Operation::Rebase)
  } else if has("MERGE_HEAD") {
    Some(Operation::Merge)
  } else if has("CHERRY_PICK_HEAD") {
    Some(Operation::CherryPick)
  } else if has("REVERT_HEAD") {
    Some(Operation::Revert)
  } else {
    None
  };
  Some(st)
}

pub fn status(r: &RemoteRoot, opts: &StatusOptions) -> Result<Option<GitStatus>, String> {
  Ok(parse_status(&r.run(&status_script(&r.path, opts), None, TIMEOUT)?))
}

fn rels(r: &RemoteRoot, paths: &[String]) -> Result<Vec<String>, String> {
  paths.iter().map(|p| r.file(p)).collect()
}

pub fn stage(r: &RemoteRoot, paths: &[String], on: bool) -> Result<(), String> {
  let paths = rels(r, paths)?;
  r.run(&crate::ssh_remote::stage_script(&r.path, &paths, on)?, None, GIT_TIMEOUT).map(drop)
}

/// Discard: tracked files from the index; untracked ones only when the user confirmed (`delete_untracked`).
pub fn discard(r: &RemoteRoot, paths: &[String], delete_untracked: bool) -> Result<(), String> {
  let paths = rels(r, paths)?;
  let mut s = format!("{}\nrc=0", r.cd());
  for p in &paths {
    let qp = q(p);
    let untracked = if delete_untracked { format!("git --literal-pathspecs clean -f -q -- {qp} || rc=1") } else { "true".into() };
    s.push_str(&format!(
      "\nif git --literal-pathspecs ls-files --error-unmatch -- {qp} >/dev/null 2>&1; then git --literal-pathspecs restore --worktree -- {qp} 2>/dev/null || git --literal-pathspecs checkout -q -- {qp} || rc=1; else {untracked}; fi"
    ));
  }
  s.push_str("\nexit $rc");
  r.run(&s, None, GIT_TIMEOUT).map(drop)
}

/// `git commit` with the local flags (git.rs `commit_flags`), the message on stdin.
pub fn commit(r: &RemoteRoot, message: &str, opts: &CommitOptions) -> Result<(), String> {
  if message.trim().is_empty() {
    return Err(crate::tr!(crate::i18n::msg::ScmMsg::CommitMessageEmpty));
  }
  let flags = crate::git::commit_flags(opts).join(" ");
  r.run(&format!("{}\ngit {flags} -F -", r.cd()), Some(message.as_bytes().to_vec()), GIT_TIMEOUT).map(drop)
}

/// `rev` (`HEAD` or the index, `""`) version of a file; `None` when it has none.
pub fn show(r: &RemoteRoot, path: &str, rev: &str) -> Result<Option<String>, String> {
  let rel = r.file(path)?;
  let spec = sh_quote(&format!("{rev}:./{rel}"));
  let out = r.run(&format!("{}\ngit cat-file -e {spec} 2>/dev/null || {{ printf 'none\\n'; exit 0; }}\nprintf 'some\\n'\ngit show {spec} | base64", r.cd()), None, TIMEOUT)?;
  match out.split_once('\n') {
    Some(("some", rest)) => Ok(Some(String::from_utf8_lossy(&b64(rest)?).into_owned())),
    _ => Ok(None),
  }
}

/// fetch / pull / push / sync on the host (its credentials, never prompting for git's own).
pub fn net(r: &RemoteRoot, what: &str, remote: Option<&str>) -> Result<String, String> {
  let remote = remote.filter(|x| !x.is_empty() && !x.starts_with('-')).map(sh_quote);
  let push = match &remote {
    Some(rm) => format!("git push -q -u {rm} HEAD"),
    None => "if git rev-parse -q --verify '@{u}' >/dev/null 2>&1; then git push -q; else git push -q -u origin HEAD; fi".into(),
  };
  let cmd = match what {
    "fetch" => "git fetch -q --prune".to_string(),
    "pull" => "git pull -q".to_string(),
    "push" => push,
    "sync" => format!("git pull -q && {{ {push}; }}"),
    _ => return Err(format!("unknown git operation {what}")),
  };
  r.run(&format!("{}\nexport GIT_TERMINAL_PROMPT=0\n{cmd} || exit 1\ngit rev-parse --abbrev-ref --symbolic-full-name '@{{u}}' 2>/dev/null; true", r.cd()), None, GIT_TIMEOUT).map(|o| o.trim().to_string())
}

/// The window's single "repository" (git_repos.rs `Detection`) for Source Control.
pub fn repositories(r: &RemoteRoot) -> crate::git_repos::Detection {
  let uri = std::path::PathBuf::from(r.uri());
  crate::git_repos::Detection {
    repositories: vec![crate::git_repos::RepoInfo { dir: uri.clone(), folder: uri.clone(), toplevel: uri, kind: crate::git_repos::RepoKind::Folder }],
    parents: Vec::new(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::Path;
  use std::process::Command;

  fn target(alias: &str) -> Target {
    Target { id: "e2e".into(), label: "e2e".into(), config_host: Some(alias.into()), host: alias.into(), port: 22, username: String::new(), identity_file: None, jump_host: None, proxy_command: None }
  }

  #[test]
  fn names_and_paths() {
    let r = RemoteRoot { target: target("box"), root: "/srv/app".into(), path: "/srv/app/.kingu/worktrees/fix".into() };
    assert_eq!(r.uri(), "ssh://e2e/srv/app/.kingu/worktrees/fix");
    assert_eq!(r.name(), "app / fix [e2e]");
    assert_eq!(r.rel("").unwrap(), "");
    assert_eq!(r.rel("src/a.rs").unwrap(), "src/a.rs");
    assert_eq!(r.rel("ssh://e2e/srv/app/.kingu/worktrees/fix/src/a.rs").unwrap(), "src/a.rs");
    assert_eq!(r.rel("ssh://e2e/srv/app/.kingu/worktrees/fix").unwrap(), "");
    assert!(r.rel("../x").is_err());
    assert!(r.rel("/etc/passwd").is_err());
    assert!(r.file("").is_err());
  }

  #[test]
  fn a_remote_session_refuses_local_commands_and_survives_a_restart() {
    let ws = crate::workspace::Workspace::new(None);
    let r = RemoteRoot { target: target("box"), root: "/srv/app".into(), path: "/srv/app".into() };
    ws.set_session(crate::workspace::WindowSession { remote: Some(r.clone()), ..Default::default() });
    assert!(ws.root().is_err(), "nothing local runs in a remote window");
    assert!(ws.roots().is_empty() && ws.current().is_none());
    assert_eq!(ws.remote(), Some(r.clone()));
    assert_eq!(ws.session().identity().as_deref(), Some("ssh://e2e/srv/app"));
    let saved = serde_json::to_string(&ws.session()).unwrap();
    let back: crate::workspace::WindowSession = serde_json::from_str(&saved).unwrap();
    assert_eq!(back.remote, Some(r));
    // An older session file has no `remote`.
    let old: crate::workspace::WindowSession = serde_json::from_str(r#"{"folders":[{"path":"/x"}]}"#).unwrap();
    assert!(old.remote.is_none());
  }

  fn sh(script: &str) -> String {
    let o = Command::new("sh").arg("-c").arg(script).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).into_owned()
  }

  fn git(dir: &Path, args: &[&str]) {
    let o = Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=t", "-c", "user.email=t@e", "-c", "commit.gpgsign=false"]).args(args).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
  }

  fn repo() -> (tempfile::TempDir, String) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap().join("ws");
    std::fs::create_dir_all(root.join("src")).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    std::fs::write(root.join(".gitignore"), "build/\n*.log\n").unwrap();
    std::fs::write(root.join("src/a.rs"), "fn main() { println!(\"Hello\"); }\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-q", "-m", "init"]);
    std::fs::create_dir(root.join("build")).unwrap();
    std::fs::write(root.join("x.log"), "x").unwrap();
    (tmp, root.to_string_lossy().into_owned())
  }

  #[test]
  fn scripts_read_lists_search_and_status_run_by_sh() {
    let (_tmp, root) = repo();
    let l = parse_list(&sh(&list_script(&root, "")), "");
    let names: Vec<_> = l.iter().map(|e| (e.name.as_str(), e.is_dir, e.ignored)).collect();
    assert!(names.contains(&("build", true, true)) && names.contains(&("x.log", false, true)) && names.contains(&("src", true, false)), "{names:?}");
    assert!(!names.iter().any(|n| n.0 == ".git"));
    let l = parse_list(&sh(&list_script(&root, "src")), "src");
    assert_eq!(l[0].rel, "src/a.rs");

    match parse_bytes(&sh(&bytes_script(&root, "src/a.rs", 1000)), 1000).unwrap() {
      Bytes::Data(b) => assert!(b.starts_with(b"fn main")),
      _ => panic!(),
    }
    assert!(matches!(parse_bytes(&sh(&bytes_script(&root, "src/a.rs", 3)), 3).unwrap(), Bytes::TooLarge(_)));
    assert!(matches!(parse_bytes(&sh(&bytes_script(&root, "src", 3)), 3).unwrap(), Bytes::Dir));

    let mut opts: SearchOptions = serde_json::from_value(serde_json::json!({ "query": "hello" })).unwrap();
    let ev = parse_search(&sh(&search_script(&root, &opts)), &opts, 0);
    match &ev[0] {
      SearchEvent::File { path, matches, .. } => {
        assert_eq!(path, "src/a.rs");
        assert_eq!(matches[0].text, "Hello");
      }
      e => panic!("{e:?}"),
    }
    // The git grep fallback gives the same.
    let fallback = sh(&search_script(&root, &opts).replace("command -v rg", "false"));
    let ev2 = parse_search(&fallback, &opts, 0);
    assert_eq!(serde_json::to_value(&ev[0]).unwrap()["matches"], serde_json::to_value(&ev2[0]).unwrap()["matches"]);
    opts.match_case = true;
    let ev = parse_search(&sh(&search_script(&root, &opts).replace("command -v rg", "false")), &opts, 0);
    assert!(matches!(ev[0], SearchEvent::Done { matches: 0, .. }));

    std::fs::write(Path::new(&root).join("src/a.rs"), "changed\n").unwrap();
    let st = parse_status(&sh(&status_script(&root, &StatusOptions::default()))).unwrap();
    assert_eq!(st.branch.as_deref(), Some("main"));
    assert_eq!(st.entries.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), vec!["src/a.rs"]);
    assert!(parse_status(&sh(&status_script("/", &StatusOptions::default()))).is_none());
  }

  /// Against a real sshd: `KINGU_SSH_CONFIG` names an ssh config whose host `kingu-e2e` is it
  /// (see MECHANICS.md › SSH worktrees). Runs everything the window does over ssh.
  #[test]
  #[ignore]
  fn e2e_remote_workspace() {
    if std::env::var_os("KINGU_SSH_CONFIG").is_none() {
      return;
    }
    let (_tmp, root) = repo();
    let r = RemoteRoot { target: target("kingu-e2e"), root: root.clone(), path: root.clone() };
    let names: Vec<_> = list_dir(&r, "").unwrap().into_iter().map(|e| e.name).collect();
    assert!(names.contains(&"src".to_string()), "{names:?}");
    let ReadResult::Text { content, stat, .. } = read(&r, "src/a.rs", &ReadOptions::default()).unwrap() else { panic!() };
    assert!(content.starts_with("fn main"));
    let saved = write(&r, "src/a.rs", "ใหม่\n", "utf8", Some(&Expected { mtime: 0, hash: stat.hash.clone() })).unwrap();
    assert!(matches!(saved, WriteResult::Saved { .. }));
    // The editor's old hash is now stale: a conflict, nothing written.
    let again = write(&r, "src/a.rs", "other\n", "utf8", Some(&Expected { mtime: 0, hash: stat.hash })).unwrap();
    assert!(matches!(again, WriteResult::Conflict { .. }));
    assert_eq!(std::fs::read_to_string(Path::new(&root).join("src/a.rs")).unwrap(), "ใหม่\n");
    create_file(&r, "new/b.txt").unwrap();
    rename(&r, "new/b.txt", "new/c.txt").unwrap();
    assert!(Path::new(&root).join("new/c.txt").is_file());
    delete(&r, "new").unwrap();
    assert!(list_files(&r).unwrap().contains(&"src/a.rs".to_string()));
    let opts: SearchOptions = serde_json::from_value(serde_json::json!({ "query": "ใหม่" })).unwrap();
    assert!(matches!(&search(&r, &opts).unwrap()[0], SearchEvent::File { path, .. } if path == "src/a.rs"));
    let st = status(&r, &StatusOptions::default()).unwrap().unwrap();
    assert_eq!(st.entries.len(), 1);
    stage(&r, &["src/a.rs".into()], true).unwrap();
    assert_eq!(show(&r, "src/a.rs", "").unwrap().as_deref(), Some("ใหม่\n"));
    assert!(show(&r, "src/a.rs", "HEAD").unwrap().unwrap().starts_with("fn main"));
    commit(&r, "remote commit", &CommitOptions::default()).unwrap_or_else(|e| panic!("{e}"));
    assert!(status(&r, &StatusOptions::default()).unwrap().unwrap().entries.is_empty());
    std::fs::write(Path::new(&root).join("src/a.rs"), "dirty\n").unwrap();
    discard(&r, &["src/a.rs".into()], false).unwrap();
    assert_eq!(std::fs::read_to_string(Path::new(&root).join("src/a.rs")).unwrap(), "ใหม่\n");
    // No origin: fetch fails with git's own message.
    assert!(net(&r, "push", None).is_err());
  }
}
