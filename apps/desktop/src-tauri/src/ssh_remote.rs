//! Files, Source Control and pull requests of a worktree on an SSH host (Orca serves these through
//! its remote server's filesystem and git providers, `src/main/providers/filesystem/provider-contract.ts`
//! and `src/main/providers/git/provider-contract.ts`). Kingu has no server on the host: every call is
//! one `ssh -o BatchMode=yes … sh -c '<script>'` (ssh_hosts.rs `remote_input`), the worktree must be
//! an added project's root or one of its task worktrees (ssh_projects.rs `inside_project`), and file
//! paths are relative to it, never leaving it.
//!
//! What crosses the wire: file contents leave the host as base64 (any bytes survive), and a saved
//! file or a commit message goes to the host on stdin, never in the command line. A pull request
//! is opened from this computer, as Orca does (`gh` runs on the client whatever the host;
//! `src/main/github/client/create/create-github-pull-request.ts`): the branch is pushed on the host,
//! then GitHub (`gh pr create --repo … --head …`), GitLab or Bitbucket (agent/mr.rs, bitbucket.rs)
//! get the request with the tokens stored here.

use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use tauri::State;

use crate::agent::mr::{self, Forge};
use crate::i18n::msg::{ForgeMsg, MrMsg, ProjectsMsg};
use crate::projects::Projects;
use crate::sparse_presets::Preset;
use crate::ssh_hosts::{self, Target, Targets, posix_dir, sh_quote};
use crate::ssh_projects::{inside_project, parse_branch_line};
use crate::tr;

/// Files larger than this open as "too large" (Kingu's limit, **estimated**).
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Push and commit may run hooks and talk to the remote (Kingu's limit, **estimated**).
pub const GIT_TIMEOUT_MS: u64 = 120_000;
const MARK_A: &str = "@@kingu-a";
const MARK_B: &str = "@@kingu-b";
const MARK_DEFAULT: &str = "@@kingu-default";

// ---------------------------------------------------------------------------------------------
// Paths and scripts (pure, so the tests run them with `sh`)

/// A path inside the worktree: relative, no `..`, no `.git` part, no control characters.
pub fn check_rel(rel: &str) -> Result<(), String> {
  let bad = rel.is_empty()
    || rel.starts_with('/')
    || rel.chars().any(char::is_control)
    || rel.split('/').any(|p| p.is_empty() || p == "." || p == ".." || p == ".git");
  if bad { Err(tr!(ProjectsMsg::RemoteBadFile, path = rel)) } else { Ok(()) }
}

/// `./<rel>` quoted: never read as an option, and relative to the worktree in git's `<rev>:./path`.
fn rel_q(rel: &str) -> String {
  sh_quote(&format!("./{rel}"))
}

/// One folder of the worktree (`rel` empty: its top), listed like SSH Hosts › Files.
pub fn dir_script(worktree: &str, rel: &str) -> Result<String, String> {
  let into = if rel.is_empty() {
    String::new()
  } else {
    check_rel(rel)?;
    format!(" && cd -- {}", rel_q(rel))
  };
  Ok(format!("cd {}{into} && {}", posix_dir(worktree), ssh_hosts::LIST_SCRIPT))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Entry {
  pub name: String,
  pub dir: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Listing {
  pub entries: Vec<Entry>,
  pub truncated: bool,
}

/// Folders first, then files, by name; `.git` left out; at most `ssh_hosts::MAX_ENTRIES`.
pub fn parse_dir(out: &str) -> Listing {
  let mut entries: Vec<Entry> = out
    .lines()
    .filter(|l| !l.is_empty())
    .map(|l| match l.strip_suffix('/') {
      Some(n) => Entry { name: n.to_string(), dir: true },
      None => Entry { name: l.to_string(), dir: false },
    })
    .filter(|e| e.name != ".git")
    .collect();
  entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
  let truncated = entries.len() > ssh_hosts::MAX_ENTRIES;
  entries.truncate(ssh_hosts::MAX_ENTRIES);
  Listing { entries, truncated }
}

/// The file's size on one line, then (when it isn't too large) its bytes as base64.
pub fn read_script(worktree: &str, rel: &str) -> Result<String, String> {
  check_rel(rel)?;
  Ok(format!(
    "cd {} || exit 1\nf={}\n[ -f \"$f\" ] || {{ printf '%s\\n' {} >&2; exit 2; }}\ns=$(wc -c < \"$f\" | tr -d ' ')\nprintf '%s\\n' \"$s\"\nif [ \"$s\" -le {MAX_FILE_BYTES} ]; then base64 < \"$f\"; fi",
    posix_dir(worktree),
    rel_q(rel),
    sh_quote(&tr!(ProjectsMsg::RemoteNotAFile, path = rel)),
  ))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileRead {
  pub size: u64,
  /// UTF-8 text; `None` when binary or too large.
  pub text: Option<String>,
  pub binary: bool,
  pub too_large: bool,
}

fn decode_b64(text: &str) -> Result<Vec<u8>, String> {
  let joined: String = text.chars().filter(|c| !c.is_whitespace()).collect();
  base64::engine::general_purpose::STANDARD.decode(joined).map_err(|_| tr!(ProjectsMsg::RemoteBadAnswer))
}

/// Text when the bytes are UTF-8 without NUL (Kingu's binary test, **estimated**).
fn as_text(bytes: Vec<u8>) -> Option<String> {
  if bytes.contains(&0) { None } else { String::from_utf8(bytes).ok() }
}

pub fn parse_read(out: &str) -> Result<FileRead, String> {
  let (first, rest) = out.split_once('\n').unwrap_or((out, ""));
  let size: u64 = first.trim().parse().map_err(|_| tr!(ProjectsMsg::RemoteBadAnswer))?;
  if size > MAX_FILE_BYTES {
    return Ok(FileRead { size, text: None, binary: false, too_large: true });
  }
  let text = as_text(decode_b64(rest)?);
  Ok(FileRead { size, binary: text.is_none(), text, too_large: false })
}

/// Saves stdin as the file: the whole of it lands in a temporary file next to it first, so a
/// dropped connection never leaves half a file; then it is copied over the old one (keeping its
/// mode and owner), or moved into place for a new file whose folders are made.
pub fn write_script(worktree: &str, rel: &str) -> Result<String, String> {
  check_rel(rel)?;
  Ok(format!(
    "cd {} || exit 1\nf={}\nmkdir -p \"$(dirname \"$f\")\" || exit 1\nt=\"$f.kingu-save.$$\"\nif cat > \"$t\"; then\n  if [ -e \"$f\" ]; then cat \"$t\" > \"$f\" && rm -f \"$t\"; else mv -f \"$t\" \"$f\"; fi\nelse rm -f \"$t\"; exit 1; fi",
    posix_dir(worktree),
    rel_q(rel)
  ))
}

/// `git status --porcelain=v1 -z --branch --untracked-files=all` in the worktree.
pub fn status_script(worktree: &str) -> String {
  format!("cd {} && git status --porcelain=v1 -z --branch --untracked-files=all", posix_dir(worktree))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Change {
  pub path: String,
  /// The old path of a rename or copy.
  pub orig: Option<String>,
  /// git's index (X) and worktree (Y) letters; `?` for untracked.
  pub x: String,
  pub y: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct GitStatus {
  pub branch: Option<String>,
  pub upstream: Option<String>,
  pub ahead: u32,
  pub behind: u32,
  pub changes: Vec<Change>,
}

/// The branch of `## main...origin/main [ahead 1]` (`## No commits yet on main` → `main`;
/// detached → none).
fn branch_of(line: &str) -> Option<String> {
  let rest = line.trim_start_matches("## ");
  let rest = rest.strip_prefix("No commits yet on ").or_else(|| rest.strip_prefix("Initial commit on ")).unwrap_or(rest);
  let head = rest.split(" [").next().unwrap_or(rest);
  let head = head.split("...").next().unwrap_or(head).trim();
  (!head.is_empty() && !head.starts_with("HEAD (")).then(|| head.to_string())
}

pub fn parse_status(out: &str) -> GitStatus {
  let mut st = GitStatus::default();
  let mut fields = out.split('\0').filter(|f| !f.is_empty());
  while let Some(f) = fields.next() {
    if f.starts_with("## ") {
      let (u, a, b) = parse_branch_line(f);
      st.branch = branch_of(f);
      st.upstream = u;
      st.ahead = a;
      st.behind = b;
      continue;
    }
    if f.len() < 4 || !f.is_char_boundary(2) {
      continue;
    }
    let (xy, path) = f.split_at(2);
    let (x, y) = (xy[..1].to_string(), xy[1..].to_string());
    let orig = if x == "R" || x == "C" || y == "R" || y == "C" { fields.next().map(str::to_string) } else { None };
    st.changes.push(Change { path: path[1..].to_string(), orig, x, y });
  }
  st
}

/// Both sides of one file's diff, each as base64 after its marker: `staged` compares the last
/// commit with the index; otherwise the index (the last commit when the file isn't in it) with the
/// file on the host. A side that doesn't exist is empty (an added or a deleted file).
pub fn diff_script(worktree: &str, rel: &str, staged: bool) -> Result<String, String> {
  check_rel(rel)?;
  let cap = format!("head -c {}", MAX_FILE_BYTES + 1);
  let (a, b) = if staged {
    (format!("git show \"HEAD:$f\" 2>/dev/null | {cap} | base64"), format!("git show \":$f\" 2>/dev/null | {cap} | base64"))
  } else {
    (
      format!("if git cat-file -e \":$f\" 2>/dev/null; then git show \":$f\"; else git show \"HEAD:$f\" 2>/dev/null; fi | {cap} | base64"),
      format!("if [ -f \"$f\" ]; then {cap} < \"$f\" | base64; fi"),
    )
  };
  Ok(format!("cd {} || exit 1\nf={}\nprintf '%s\\n' '{MARK_A}'\n{a}\nprintf '%s\\n' '{MARK_B}'\n{b}", posix_dir(worktree), rel_q(rel)))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileDiff {
  pub original: String,
  pub modified: String,
  pub binary: bool,
  pub too_large: bool,
}

pub fn parse_diff(out: &str) -> Result<FileDiff, String> {
  let bad = || tr!(ProjectsMsg::RemoteBadAnswer);
  let rest = out.split_once(&format!("{MARK_A}\n")).ok_or_else(bad)?.1;
  let (a, b) = rest.split_once(&format!("{MARK_B}\n")).or_else(|| rest.strip_suffix(MARK_B).map(|a| (a, ""))).ok_or_else(bad)?;
  let (a, b) = (decode_b64(a)?, decode_b64(b)?);
  let too_large = a.len() as u64 > MAX_FILE_BYTES || b.len() as u64 > MAX_FILE_BYTES;
  if too_large {
    return Ok(FileDiff { original: String::new(), modified: String::new(), binary: false, too_large });
  }
  match (as_text(a), as_text(b)) {
    (Some(original), Some(modified)) => Ok(FileDiff { original, modified, binary: false, too_large }),
    _ => Ok(FileDiff { original: String::new(), modified: String::new(), binary: true, too_large }),
  }
}

/// Stage (`git add -A`) or unstage (`git reset -q HEAD`, or `git rm --cached` before the first
/// commit) the given paths.
pub fn stage_script(worktree: &str, paths: &[String], stage: bool) -> Result<String, String> {
  if paths.is_empty() {
    return Ok("true".into());
  }
  for p in paths {
    check_rel(p)?;
  }
  let list = paths.iter().map(|p| rel_q(p)).collect::<Vec<_>>().join(" ");
  let cd = posix_dir(worktree);
  Ok(if stage {
    format!("cd {cd} && git add -A -- {list}")
  } else {
    format!("cd {cd} || exit 1\nif git rev-parse -q --verify HEAD >/dev/null; then git reset -q HEAD -- {list}; else git rm -r -q --cached -- {list}; fi")
  })
}

/// `git commit -q -F -` (the message on stdin), then the new commit's short id.
pub fn commit_script(worktree: &str) -> String {
  format!("cd {} && git commit -q -F - && git rev-parse --short HEAD", posix_dir(worktree))
}

/// `git push -q -u origin HEAD` on the host (its own credentials; never prompting).
pub fn push_script(worktree: &str) -> String {
  format!("cd {} && GIT_TERMINAL_PROMPT=0 git push -q -u origin HEAD", posix_dir(worktree))
}

/// The repository's branches (local, then remote-tracking), then the default one origin names.
pub fn branches_script(root: &str) -> String {
  format!(
    "cd {} || exit 1\ngit for-each-ref --format='%(refname:short)' refs/heads refs/remotes\nprintf '%s\\n' '{MARK_DEFAULT}'\ngit symbolic-ref -q --short refs/remotes/origin/HEAD\ntrue",
    posix_dir(root)
  )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Branches {
  pub branches: Vec<String>,
  /// `origin/main` when origin's HEAD is known.
  pub default: Option<String>,
}

pub fn parse_branches(out: &str) -> Branches {
  let (list, default) = out.split_once(&format!("{MARK_DEFAULT}\n")).unwrap_or((out, ""));
  let branches = list.lines().map(str::trim).filter(|l| !l.is_empty() && !l.ends_with("/HEAD") && *l != "origin").map(str::to_string).collect();
  let default = default.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string);
  Branches { branches, default }
}

/// The project's sparse checkout presets, kept on the host where this computer keeps a local
/// project's (`<root>/.kingu/sparse-presets.json`, sparse_presets.rs).
pub fn presets_script(root: &str) -> String {
  format!("cat {}/.kingu/sparse-presets.json 2>/dev/null; true", posix_dir(root))
}

pub fn parse_presets(out: &str) -> Vec<Preset> {
  serde_json::from_str(out.trim()).unwrap_or_default()
}

/// origin's URL, then the branch checked out.
pub fn pr_info_script(worktree: &str) -> String {
  format!("cd {} && git remote get-url origin && git symbolic-ref -q --short HEAD", posix_dir(worktree))
}

/// The host and path of a git remote URL: `https://h/o/r.git`, `ssh://git@h:22/o/r`, `git@h:o/r`.
pub fn remote_host_path(url: &str) -> Option<(String, String)> {
  let url = url.trim();
  let (host, path) = if let Some((_, rest)) = url.split_once("://") {
    let (authority, path) = rest.split_once('/')?;
    let host = authority.rsplit('@').next()?;
    (host.split(':').next()?.to_string(), path.to_string())
  } else {
    let (authority, path) = url.split_once(':')?;
    if authority.contains('/') {
      return None;
    }
    (authority.rsplit('@').next()?.to_string(), path.to_string())
  };
  let path = path.trim_matches('/').trim_end_matches(".git").to_string();
  (!host.is_empty() && !path.is_empty()).then(|| (host.to_lowercase(), path))
}

/// `gh --repo` for a GitHub remote: `owner/repo` on github.com, `host/owner/repo` elsewhere.
pub fn github_repo(url: &str) -> Option<String> {
  let (host, path) = remote_host_path(url)?;
  let parts: Vec<&str> = path.split('/').collect();
  let ok = parts.len() == 2 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')));
  if !ok {
    return None;
  }
  Some(if host == "github.com" || host == "ssh.github.com" { path } else { format!("{host}/{path}") })
}

/// Where origin's pull requests go (agent/mr.rs `forge`, from a URL read on the host).
fn forge_of(url: &str) -> Forge {
  if let Some(repo) = crate::bitbucket::parse_remote(url) {
    return Forge::Bitbucket(repo);
  }
  let configured = crate::system::config_dir().and_then(|d| crate::settings::user_value(d, "kingu.gitlab.host"));
  let hosts = mr::gitlab_hosts(configured.as_ref().and_then(serde_json::Value::as_str));
  mr::project_of_remote(url, &hosts).map_or(Forge::Github, Forge::Gitlab)
}

/// Discards worktree changes path by path (Orca `discardChanges`,
/// `src/main/git/source-control/mutations/discard-changes.ts`): a tracked file is restored from
/// the index (`git restore --worktree`, else `git checkout` on an older git), an untracked one is
/// removed (`git clean -f`). Pathspecs are literal, so `*` in a name matches only itself.
pub fn discard_script(worktree: &str, paths: &[String]) -> Result<String, String> {
  let mut out = format!("cd {} || exit 1\nrc=0", posix_dir(worktree));
  for p in paths {
    check_rel(p)?;
    let q = rel_q(p);
    out.push_str(&format!(
      "\nif git --literal-pathspecs ls-files --error-unmatch -- {q} >/dev/null 2>&1; then git --literal-pathspecs restore --worktree -- {q} 2>/dev/null || git --literal-pathspecs checkout -q -- {q} || rc=1; else git --literal-pathspecs clean -f -q -- {q} || rc=1; fi"
    ));
  }
  out.push_str("\nexit $rc");
  Ok(out)
}

/// `git fetch --prune origin` (Orca `fetchRemote`) or `git pull` (Orca `pullBranch`, the host's own
/// pull settings) on the host, never prompting.
pub fn sync_script(worktree: &str, pull: bool) -> String {
  let cmd = if pull { "git pull -q" } else { "git fetch -q --prune origin" };
  format!("cd {} && GIT_TERMINAL_PROMPT=0 {cmd}", posix_dir(worktree))
}

/// Quick Open's list: tracked and untracked files git doesn't ignore, at most `MAX_FILES`.
pub const MAX_FILES: usize = 50_000;
pub fn files_script(worktree: &str) -> String {
  format!("cd {} && git -c core.quotePath=false ls-files --cached --others --exclude-standard | head -n {MAX_FILES}", posix_dir(worktree))
}

pub fn parse_files(out: &str) -> Vec<String> {
  let mut seen = std::collections::HashSet::new();
  out.lines().filter(|l| !l.is_empty() && !l.starts_with('"') && check_rel(l).is_ok()).filter(|l| seen.insert(*l)).map(str::to_string).collect()
}

/// Search hits are cut here (Kingu's limit, **estimated**).
pub const MAX_HITS: usize = 500;
const MAX_HIT_TEXT: usize = 300;

/// `git grep` for fixed text in tracked and untracked files, binary files skipped.
pub fn grep_script(worktree: &str, query: &str, case_sensitive: bool) -> String {
  format!(
    "cd {} || exit 1\ngit -c core.quotePath=false grep -z -n -I --no-color -F {}--untracked -e {} | head -n {}\ntrue",
    posix_dir(worktree),
    if case_sensitive { "" } else { "-i " },
    sh_quote(query),
    MAX_HITS + 1
  )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Hit {
  pub path: String,
  pub line: u32,
  pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Hits {
  pub hits: Vec<Hit>,
  pub truncated: bool,
}

/// `path\0line\0text` lines.
pub fn parse_grep(out: &str) -> Hits {
  let mut hits: Vec<Hit> = out
    .lines()
    .filter_map(|l| {
      let mut parts = l.splitn(3, '\0');
      let path = parts.next()?.to_string();
      let line = parts.next()?.parse().ok()?;
      let text: String = parts.next().unwrap_or("").chars().take(MAX_HIT_TEXT).collect();
      Some(Hit { path, line, text })
    })
    .collect();
  let truncated = hits.len() > MAX_HITS;
  hits.truncate(MAX_HITS);
  Hits { hits, truncated }
}

/// One cheap look at the worktree for auto-refresh: its git status, then (when a file is open)
/// that file's `cksum`, so a change made on the host (an agent's edit) shows without a full read.
pub fn poll_script(worktree: &str, rel: Option<&str>) -> Result<String, String> {
  let mut s = format!("{}\nprintf '\\0%s\\n' '{MARK_A}'", status_script(worktree));
  if let Some(rel) = rel {
    check_rel(rel)?;
    s.push_str(&format!("\ncksum < {} 2>/dev/null", rel_q(rel)));
  }
  Ok(s)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Poll {
  pub status: GitStatus,
  /// The open file's `cksum` line; none when it's gone or none is open.
  pub sum: Option<String>,
}

pub fn parse_poll(out: &str) -> Poll {
  let (status, rest) = out.split_once(&format!("\0{MARK_A}\n")).unwrap_or((out, ""));
  let sum = rest.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string);
  Poll { status: parse_status(status), sum }
}

/// A remote claude session's hook file, `$HOME/.kingu/agent-hooks/<token>.jsonl` on the host.
pub fn hook_file_expr(token: &str) -> Result<String, String> {
  if !crate::agent::hooks::valid_token(token) {
    return Err("invalid hook token".into());
  }
  Ok(format!("\"$HOME/.kingu/agent-hooks/{token}.jsonl\""))
}

/// Its size, then what follows `offset` (at most 1 MB).
pub fn hook_read_script(token: &str, offset: u64) -> Result<String, String> {
  let f = hook_file_expr(token)?;
  Ok(format!(
    "f={f}\n[ -f \"$f\" ] || {{ printf '0\\n'; exit 0; }}\ns=$(wc -c < \"$f\" | tr -d ' ')\nprintf '%s\\n' \"$s\"\nif [ \"$s\" -gt {offset} ]; then tail -c +{} \"$f\" | head -c 1048576; fi",
    offset + 1
  ))
}

pub fn parse_hook_read(out: &str, offset: u64) -> crate::agent::hooks::HookRead {
  let (first, rest) = out.split_once('\n').unwrap_or((out, ""));
  let size: u64 = first.trim().parse().unwrap_or(0);
  if size < offset {
    // A new file under the same name: start over.
    return crate::agent::hooks::HookRead { events: Vec::new(), offset: 0 };
  }
  let (events, used) = crate::agent::hooks::parse_lines(rest.as_bytes());
  crate::agent::hooks::HookRead { events, offset: offset + used as u64 }
}

// ---------------------------------------------------------------------------------------------
// Commands

/// The host of an added project, once `path` is known to be its root or a task worktree of it.
fn target(targets: &Targets, projects: &Projects, host: &str, root: &str, path: &str) -> Result<Target, String> {
  projects.check_remote(host, root)?;
  if !inside_project(root, path) {
    return Err(tr!(ProjectsMsg::RemoteBadPath, path));
  }
  targets.get(host)
}

async fn run(t: Target, script: String, input: Option<Vec<u8>>, limit_ms: u64) -> Result<String, String> {
  ssh_hosts::blocking(move || ssh_hosts::remote_input(&t, &script, input, Duration::from_millis(limit_ms))).await?
}

#[tauri::command]
pub async fn ssh_remote_dir(targets: State<'_, Targets>, projects: State<'_, Projects>, host: String, root: String, path: String, rel: String) -> Result<Listing, String> {
  let t = target(&targets, &projects, &host, &root, &path)?;
  run(t, dir_script(&path, &rel)?, None, ssh_hosts::REMOTE_TIMEOUT_MS).await.map(|o| parse_dir(&o))
}

#[tauri::command]
pub async fn ssh_remote_read(targets: State<'_, Targets>, projects: State<'_, Projects>, host: String, root: String, path: String, rel: String) -> Result<FileRead, String> {
  let t = target(&targets, &projects, &host, &root, &path)?;
  parse_read(&run(t, read_script(&path, &rel)?, None, ssh_hosts::REMOTE_TIMEOUT_MS * 2).await?)
}

#[tauri::command]
pub async fn ssh_remote_write(targets: State<'_, Targets>, projects: State<'_, Projects>, host: String, root: String, path: String, rel: String, text: String) -> Result<(), String> {
  let t = target(&targets, &projects, &host, &root, &path)?;
  run(t, write_script(&path, &rel)?, Some(text.into_bytes()), ssh_hosts::REMOTE_TIMEOUT_MS * 2).await.map(drop)
}

#[tauri::command]
pub async fn ssh_remote_status(targets: State<'_, Targets>, projects: State<'_, Projects>, host: String, root: String, path: String) -> Result<GitStatus, String> {
  let t = target(&targets, &projects, &host, &root, &path)?;
  run(t, status_script(&path), None, ssh_hosts::REMOTE_TIMEOUT_MS).await.map(|o| parse_status(&o))
}

#[tauri::command]
pub async fn ssh_remote_diff(targets: State<'_, Targets>, projects: State<'_, Projects>, host: String, root: String, path: String, rel: String, staged: bool) -> Result<FileDiff, String> {
  let t = target(&targets, &projects, &host, &root, &path)?;
  parse_diff(&run(t, diff_script(&path, &rel, staged)?, None, ssh_hosts::REMOTE_TIMEOUT_MS * 2).await?)
}

#[tauri::command]
pub async fn ssh_remote_stage(targets: State<'_, Targets>, projects: State<'_, Projects>, host: String, root: String, path: String, paths: Vec<String>, stage: bool) -> Result<(), String> {
  let t = target(&targets, &projects, &host, &root, &path)?;
  run(t, stage_script(&path, &paths, stage)?, None, GIT_TIMEOUT_MS).await.map(drop)
}

/// Commits what is staged; returns the new commit's short id.
#[tauri::command]
pub async fn ssh_remote_commit(targets: State<'_, Targets>, projects: State<'_, Projects>, host: String, root: String, path: String, message: String) -> Result<String, String> {
  if message.trim().is_empty() {
    return Err(tr!(ProjectsMsg::RemoteEmptyMessage));
  }
  let t = target(&targets, &projects, &host, &root, &path)?;
  run(t, commit_script(&path), Some(message.into_bytes()), GIT_TIMEOUT_MS).await.map(|o| o.trim().to_string())
}

#[tauri::command]
pub async fn ssh_remote_push(targets: State<'_, Targets>, projects: State<'_, Projects>, host: String, root: String, path: String) -> Result<(), String> {
  let t = target(&targets, &projects, &host, &root, &path)?;
  run(t, push_script(&path), None, GIT_TIMEOUT_MS).await.map(drop).map_err(|e| tr!(ProjectsMsg::RemotePushFailed, detail = e))
}

/// Branches a new task can start from.
#[tauri::command]
pub async fn ssh_remote_branches(targets: State<'_, Targets>, projects: State<'_, Projects>, host: String, root: String) -> Result<Branches, String> {
  let t = target(&targets, &projects, &host, &root, &root)?;
  run(t, branches_script(&root), None, ssh_hosts::REMOTE_TIMEOUT_MS).await.map(|o| parse_branches(&o))
}

#[tauri::command]
pub async fn ssh_remote_presets(targets: State<'_, Targets>, projects: State<'_, Projects>, host: String, root: String) -> Result<Vec<Preset>, String> {
  let t = target(&targets, &projects, &host, &root, &root)?;
  run(t, presets_script(&root), None, ssh_hosts::REMOTE_TIMEOUT_MS).await.map(|o| parse_presets(&o))
}

#[tauri::command]
pub async fn ssh_remote_discard(targets: State<'_, Targets>, projects: State<'_, Projects>, host: String, root: String, path: String, paths: Vec<String>) -> Result<(), String> {
  let t = target(&targets, &projects, &host, &root, &path)?;
  run(t, discard_script(&path, &paths)?, None, GIT_TIMEOUT_MS).await.map(drop)
}

/// `pull`: false → fetch.
#[tauri::command]
pub async fn ssh_remote_sync(targets: State<'_, Targets>, projects: State<'_, Projects>, host: String, root: String, path: String, pull: bool) -> Result<(), String> {
  let t = target(&targets, &projects, &host, &root, &path)?;
  run(t, sync_script(&path, pull), None, GIT_TIMEOUT_MS).await.map(drop)
}

#[tauri::command]
pub async fn ssh_remote_files(targets: State<'_, Targets>, projects: State<'_, Projects>, host: String, root: String, path: String) -> Result<Vec<String>, String> {
  let t = target(&targets, &projects, &host, &root, &path)?;
  run(t, files_script(&path), None, ssh_hosts::REMOTE_TIMEOUT_MS * 2).await.map(|o| parse_files(&o))
}

#[tauri::command]
pub async fn ssh_remote_grep(targets: State<'_, Targets>, projects: State<'_, Projects>, host: String, root: String, path: String, query: String, case_sensitive: bool) -> Result<Hits, String> {
  if query.is_empty() || query.contains('\n') {
    return Ok(Hits { hits: Vec::new(), truncated: false });
  }
  let t = target(&targets, &projects, &host, &root, &path)?;
  run(t, grep_script(&path, &query, case_sensitive), None, ssh_hosts::REMOTE_TIMEOUT_MS * 2).await.map(|o| parse_grep(&o))
}

#[tauri::command]
pub async fn ssh_remote_poll(targets: State<'_, Targets>, projects: State<'_, Projects>, host: String, root: String, path: String, rel: Option<String>) -> Result<Poll, String> {
  let t = target(&targets, &projects, &host, &root, &path)?;
  run(t, poll_script(&path, rel.as_deref())?, None, ssh_hosts::REMOTE_TIMEOUT_MS).await.map(|o| parse_poll(&o))
}

/// New hook events of a claude session on the host (see `ssh_projects::agent_settings`).
#[tauri::command]
pub async fn ssh_remote_hook_read(targets: State<'_, Targets>, projects: State<'_, Projects>, host: String, root: String, token: String, offset: u64) -> Result<crate::agent::hooks::HookRead, String> {
  let t = target(&targets, &projects, &host, &root, &root)?;
  let out = run(t, hook_read_script(&token, offset)?, None, ssh_hosts::REMOTE_TIMEOUT_MS).await?;
  Ok(parse_hook_read(&out, offset))
}

/// Removes a finished session's hook file on the host.
#[tauri::command]
pub async fn ssh_remote_hook_clear(targets: State<'_, Targets>, projects: State<'_, Projects>, host: String, root: String, token: String) -> Result<(), String> {
  let t = target(&targets, &projects, &host, &root, &root)?;
  run(t, format!("rm -f {}", hook_file_expr(&token)?), None, ssh_hosts::REMOTE_TIMEOUT_MS).await.map(drop)
}

/// Pushes the worktree's branch on the host, then opens the pull request (GitLab: merge request)
/// from this computer; returns its URL.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_remote_pr_create(
  targets: State<'_, Targets>,
  projects: State<'_, Projects>,
  host: String,
  root: String,
  path: String,
  base: String,
  title: String,
  body: String,
  draft: bool,
) -> Result<String, String> {
  let t = target(&targets, &projects, &host, &root, &path)?;
  crate::git::check_rev(&base)?;
  if title.trim().is_empty() {
    return Err(tr!(ForgeMsg::PrEmptyTitle));
  }
  let info = run(t.clone(), pr_info_script(&path), None, ssh_hosts::REMOTE_TIMEOUT_MS).await?;
  let mut lines = info.lines().map(str::trim).filter(|l| !l.is_empty());
  let url = lines.next().unwrap_or_default().to_string();
  let branch = lines.next().map(str::to_string).ok_or_else(|| tr!(ProjectsMsg::RemoteNoBranch))?;
  let forge = forge_of(&url);
  let repo = match forge {
    Forge::Github => Some(github_repo(&url).ok_or_else(|| tr!(ProjectsMsg::RemoteNoGithub, url = url))?),
    _ => None,
  };
  run(t, push_script(&path), None, GIT_TIMEOUT_MS).await.map_err(|e| tr!(ProjectsMsg::RemotePushFailed, detail = e))?;
  let base = base.strip_prefix("origin/").unwrap_or(&base).to_string();
  ssh_hosts::blocking(move || match forge {
    Forge::Gitlab(p) => {
      let (t, r) = crate::agent::forge::gitlab(&p)?;
      if title.trim().is_empty() {
        return Err(tr!(MrMsg::EmptyTitle));
      }
      mr::create(&t, &r, &branch, &base, &title, &body, draft)
    }
    Forge::Bitbucket(repo) => {
      let t = crate::bitbucket::connected_for_create()?;
      crate::bitbucket::create(&t, &repo, &branch, &base, &title, &body)
    }
    Forge::Github => {
      let bin = crate::agent::review::gh_bin().ok_or_else(crate::agent::issues::gh_missing)?;
      let repo = repo.unwrap_or_default();
      let mut args = vec!["pr", "create", "--repo", repo.as_str(), "--head", branch.as_str(), "--base", base.as_str(), "--title", title.trim(), "--body", body.as_str()];
      if draft {
        args.push("--draft");
      }
      // Not in any local repository, so gh reads nothing but its arguments.
      let out = crate::shell_env::command(&bin).current_dir(std::env::temp_dir()).env("GH_PROMPT_DISABLED", "1").args(&args).output().map_err(|e| format!("gh: {e}"))?;
      if !out.status.success() {
        return Err(format!("gh pr create: {}", String::from_utf8_lossy(&out.stderr).trim()));
      }
      Ok(String::from_utf8_lossy(&out.stdout).lines().rev().find(|l| l.starts_with("http")).unwrap_or_default().trim().to_owned())
    }
  })
  .await?
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Write;
  use std::path::Path;
  use std::process::{Command, Stdio};

  fn sh_in(script: &str, input: &[u8]) -> (bool, String, String) {
    let mut c = Command::new("sh").arg("-c").arg(script).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    c.stdin.take().unwrap().write_all(input).unwrap();
    let o = c.wait_with_output().unwrap();
    (o.status.success(), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
  }
  fn sh(script: &str) -> (bool, String, String) {
    sh_in(script, b"")
  }
  fn git(dir: &Path, args: &[&str]) {
    let o = Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"]).args(args).output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
  }
  fn repo() -> (tempfile::TempDir, String) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap().join("it's repo");
    std::fs::create_dir(&root).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    std::fs::create_dir(root.join("src")).unwrap();
    std::fs::write(root.join("src/-x $y.rs"), "fn main() {}\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-q", "-m", "init"]);
    (tmp, root.to_string_lossy().into_owned())
  }

  #[test]
  fn refuses_paths_leaving_the_worktree() {
    for bad in ["", "/etc/passwd", "../x", "a/../../b", ".git/config", "a//b", "a\nb", "./a"] {
      assert!(check_rel(bad).is_err(), "{bad:?}");
    }
    for ok in ["a.txt", "src/-x $y.rs", ".github/workflows/ci.yml", "it's"] {
      assert!(check_rel(ok).is_ok(), "{ok:?}");
    }
  }

  #[test]
  fn lists_reads_and_saves_files_with_the_scripts_run_by_sh() {
    let (_tmp, root) = repo();
    let (ok, out, err) = sh(&dir_script(&root, "").unwrap());
    assert!(ok, "{err}");
    let l = parse_dir(&out);
    assert_eq!(l.entries, vec![Entry { name: "src".into(), dir: true }, Entry { name: "a.txt".into(), dir: false }], "folders first, .git left out");
    let (ok, out, _) = sh(&dir_script(&root, "src").unwrap());
    assert!(ok);
    assert_eq!(parse_dir(&out).entries[0].name, "-x $y.rs");

    let (ok, out, err) = sh(&read_script(&root, "src/-x $y.rs").unwrap());
    assert!(ok, "{err}");
    let r = parse_read(&out).unwrap();
    assert_eq!(r.text.as_deref(), Some("fn main() {}\n"));
    assert_eq!(r.size, 13);
    let (ok, _, err) = sh(&read_script(&root, "missing.txt").unwrap());
    assert!(!ok && err.contains("missing.txt"), "{err}");

    // Saving: an existing file keeps its mode; a new one gets its folders.
    let a = Path::new(&root).join("a.txt");
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      std::fs::set_permissions(&a, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let (ok, _, err) = sh_in(&write_script(&root, "a.txt").unwrap(), "two ✓\n".as_bytes());
    assert!(ok, "{err}");
    assert_eq!(std::fs::read_to_string(&a).unwrap(), "two ✓\n");
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(std::fs::metadata(&a).unwrap().permissions().mode() & 0o777, 0o755);
    }
    let (ok, _, err) = sh_in(&write_script(&root, "new/deep/b.txt").unwrap(), b"b");
    assert!(ok, "{err}");
    assert_eq!(std::fs::read_to_string(Path::new(&root).join("new/deep/b.txt")).unwrap(), "b");
    assert!(std::fs::read_dir(Path::new(&root).join("new/deep")).unwrap().count() == 1, "no temporary file left");

    // Binary files are told apart.
    std::fs::write(Path::new(&root).join("bin"), [0u8, 159, 146, 150]).unwrap();
    let (_, out, _) = sh(&read_script(&root, "bin").unwrap());
    let r = parse_read(&out).unwrap();
    assert!(r.binary && r.text.is_none());
  }

  #[test]
  fn status_diff_stage_commit_with_the_scripts_run_by_sh() {
    let (_tmp, root) = repo();
    let dir = Path::new(&root);
    std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
    std::fs::write(dir.join("new file.txt"), "n\n").unwrap();
    git(dir, &["mv", "src/-x $y.rs", "src/moved.rs"]);

    let (ok, out, err) = sh(&status_script(&root));
    assert!(ok, "{err}");
    let st = parse_status(&out);
    assert_eq!(st.branch.as_deref(), Some("main"));
    let find = |p: &str| st.changes.iter().find(|c| c.path == p).cloned().unwrap_or_else(|| panic!("{p}: {:?}", st.changes));
    assert_eq!((find("a.txt").x.as_str(), find("a.txt").y.as_str()), (" ", "M"));
    assert_eq!(find("new file.txt").x, "?");
    let mv = find("src/moved.rs");
    assert_eq!((mv.x.as_str(), mv.orig.as_deref()), ("R", Some("src/-x $y.rs")));

    let (ok, out, err) = sh(&diff_script(&root, "a.txt", false).unwrap());
    assert!(ok, "{err}");
    let d = parse_diff(&out).unwrap();
    assert_eq!((d.original.as_str(), d.modified.as_str()), ("one\n", "one\ntwo\n"));
    let (_, out, _) = sh(&diff_script(&root, "new file.txt", false).unwrap());
    let d = parse_diff(&out).unwrap();
    assert_eq!((d.original.as_str(), d.modified.as_str()), ("", "n\n"), "untracked: nothing before");

    let (ok, _, err) = sh(&stage_script(&root, &["a.txt".into(), "new file.txt".into()], true).unwrap());
    assert!(ok, "{err}");
    let (_, out, _) = sh(&diff_script(&root, "a.txt", true).unwrap());
    assert_eq!(parse_diff(&out).unwrap().modified, "one\ntwo\n");
    let (ok, _, err) = sh(&stage_script(&root, &["new file.txt".into()], false).unwrap());
    assert!(ok, "{err}");
    let (_, out, _) = sh(&status_script(&root));
    assert_eq!(parse_status(&out).changes.iter().find(|c| c.path == "new file.txt").unwrap().x, "?");

    let script = format!("export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@e GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@e; {}", commit_script(&root));
    let (ok, out, err) = sh_in(&script, "Fix it's \"quoting\" $HOME\n\nbody".as_bytes());
    assert!(ok, "{err}");
    assert!(!out.trim().is_empty());
    let log = Command::new("git").arg("-C").arg(dir).args(["log", "-1", "--format=%B"]).output().unwrap();
    assert!(String::from_utf8_lossy(&log.stdout).starts_with("Fix it's \"quoting\" $HOME\n\nbody"));

    let (ok, out, _) = sh(&branches_script(&root));
    assert!(ok);
    let b = parse_branches(&out);
    assert_eq!(b.branches, vec!["main".to_string()]);
    assert_eq!(b.default, None);
  }

  #[test]
  fn discard_fetch_search_and_poll_with_the_scripts_run_by_sh() {
    let (_tmp, root) = repo();
    let dir = Path::new(&root);
    std::fs::write(dir.join("a.txt"), "changed\n").unwrap();
    std::fs::write(dir.join("*"), "star\n").unwrap();
    std::fs::write(dir.join("junk.txt"), "j").unwrap();
    let (ok, _, err) = sh(&discard_script(&root, &["a.txt".into(), "*".into()]).unwrap());
    assert!(ok, "{err}");
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\n");
    assert!(!dir.join("*").exists(), "the untracked file is removed");
    assert!(dir.join("junk.txt").exists(), "`*` matched only itself");

    let (ok, out, _) = sh(&files_script(&root));
    assert!(ok);
    let files = parse_files(&out);
    assert!(files.contains(&"src/-x $y.rs".to_string()) && files.contains(&"junk.txt".to_string()), "{files:?}");

    let (ok, out, err) = sh(&grep_script(&root, "FN MAIN", false));
    assert!(ok, "{err}");
    let h = parse_grep(&out);
    assert_eq!(h.hits, vec![Hit { path: "src/-x $y.rs".into(), line: 1, text: "fn main() {}".into() }]);
    let (_, out, _) = sh(&grep_script(&root, "FN MAIN", true));
    assert!(parse_grep(&out).hits.is_empty());
    let (_, out, _) = sh(&grep_script(&root, "'; rm -rf / #", false));
    assert!(parse_grep(&out).hits.is_empty());

    let (ok, out, err) = sh(&poll_script(&root, Some("a.txt")).unwrap());
    assert!(ok, "{err}");
    let p = parse_poll(&out);
    assert_eq!(p.status.branch.as_deref(), Some("main"));
    assert_eq!(p.status.changes.len(), 1, "junk.txt");
    let first = p.sum.clone().unwrap();
    std::fs::write(dir.join("a.txt"), "two\n").unwrap();
    let (_, out, _) = sh(&poll_script(&root, Some("a.txt")).unwrap());
    assert_ne!(parse_poll(&out).sum.unwrap(), first);
    let (_, out, _) = sh(&poll_script(&root, Some("gone.txt")).unwrap());
    assert_eq!(parse_poll(&out).sum, None);

    // fetch without an origin fails cleanly (the error is shown).
    let (ok, _, _) = sh(&sync_script(&root, false));
    assert!(!ok);
  }

  #[test]
  fn reads_a_remote_hook_file_from_an_offset() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_string_lossy().into_owned();
    let run = |off: u64| {
      let o = Command::new("sh").arg("-c").arg(hook_read_script("abcdef12", off).unwrap()).env("HOME", &home).output().unwrap();
      parse_hook_read(&String::from_utf8_lossy(&o.stdout), off)
    };
    assert_eq!(run(0).events.len(), 0);
    std::fs::create_dir_all(tmp.path().join(".kingu/agent-hooks")).unwrap();
    let f = tmp.path().join(".kingu/agent-hooks/abcdef12.jsonl");
    std::fs::write(&f, "{\"hook_event_name\":\"Stop\"}\n{\"hook_event_name\":\"Pre").unwrap();
    let r = run(0);
    assert_eq!(r.events.len(), 1);
    assert_eq!(r.offset, 27);
    std::fs::write(&f, "{\"hook_event_name\":\"Stop\"}\n{\"hook_event_name\":\"PreToolUse\"}\n").unwrap();
    let r = run(27);
    assert_eq!(r.events[0]["hook_event_name"], "PreToolUse");
    std::fs::write(&f, "").unwrap();
    assert_eq!(run(r.offset).offset, 0, "a new file starts over");
    assert!(hook_read_script("bad token;", 0).is_err());
  }

  /// Against a real sshd (`KINGU_SSH_E2E_DIR` holds `plain`/`locked` keys, `kh` known hosts, port
  /// 22222): every script over ssh with `sh -c` as `ssh_hosts::remote_input` sends it, a save over
  /// stdin, the shared connection, and the passphrase of `locked` going through the askpass helper
  /// and its FIFO. `cargo test --lib ssh_remote::tests::e2e -- --ignored`.
  #[test]
  #[ignore]
  fn e2e_over_a_real_ssh() {
    let Ok(dir) = std::env::var("KINGU_SSH_E2E_DIR") else { return };
    let dir = Path::new(&dir).to_path_buf();
    let base = |key: &str, extra: &[&str]| {
      let mut c = Command::new("ssh");
      // No user config: its agent and keychain settings never see the test keys.
      c.args(["-F", "/dev/null"]);
      c.args(extra);
      // The test keys never reach the user's agent or keychain.
      if cfg!(target_os = "macos") {
        c.args(["-o", "UseKeychain=no"]);
      }
      c.args(["-o", &format!("UserKnownHostsFile={}", dir.join("kh").display()), "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "AddKeysToAgent=no", "-o", "ConnectTimeout=10", "-T"]);
      c.args(["-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/kingu-e2e-%C", "-o", "ControlPersist=20"]);
      c.args(["-p", "22222", "-i", dir.join(key).to_str().unwrap(), "--", "127.0.0.1"]);
      c
    };
    let remote = |key: &str, script: &str, input: &[u8]| {
      let mut c = base(key, &["-o", "BatchMode=yes"]);
      c.arg(format!("sh -c {}", sh_quote(script)));
      let mut ch = c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
      ch.stdin.take().unwrap().write_all(input).unwrap();
      let o = ch.wait_with_output().unwrap();
      (o.status.success(), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
    };
    let (_tmp, root) = repo();
    let (ok, out, err) = remote("plain", &dir_script(&root, "").unwrap(), b"");
    assert!(ok, "{err}");
    assert_eq!(parse_dir(&out).entries.len(), 2);
    let (ok, _, err) = remote("plain", &write_script(&root, "src/new.rs").unwrap(), "// ใหม่\n".as_bytes());
    assert!(ok, "{err}");
    let (_, out, _) = remote("plain", &read_script(&root, "src/new.rs").unwrap(), b"");
    assert_eq!(parse_read(&out).unwrap().text.as_deref(), Some("// ใหม่\n"));
    let (_, out, _) = remote("plain", &status_script(&root), b"");
    assert!(parse_status(&out).changes.iter().any(|c| c.path == "src/new.rs"));
    let (_, out, _) = remote("plain", &grep_script(&root, "ใหม่", true), b"");
    assert_eq!(parse_grep(&out).hits[0].path, "src/new.rs");
    let (_, out, _) = remote("plain", &diff_script(&root, "src/new.rs", false).unwrap(), b"");
    assert_eq!(parse_diff(&out).unwrap().modified, "// ใหม่\n");
    let (ok, _, err) = remote("plain", &discard_script(&root, &["src/new.rs".into()]).unwrap(), b"");
    assert!(ok, "{err}");
    assert!(!Path::new(&root).join("src/new.rs").exists());

    // The locked key: ssh asks the helper, the "app" answers through the FIFO.
    let q = dir.join("askq");
    let _ = std::fs::remove_dir_all(&q);
    std::fs::create_dir(&q).unwrap();
    let helper = dir.join("askpass.sh");
    std::fs::write(&helper, crate::ssh_askpass::HELPER).unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    // Its own connection (options given first win in ssh), so the key is really used.
    let mut c = base("locked", &["-o", "BatchMode=no", "-o", "ControlMaster=no", "-o", "ControlPath=none"]);
    c.arg("echo locked-ok");
    c.env("SSH_ASKPASS", &helper).env("SSH_ASKPASS_REQUIRE", "force").env("DISPLAY", ":0").env("KINGU_ASKPASS_DIR", &q).env("KINGU_SSH_TARGET", "e2e");
    let mut child = c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let start = std::time::Instant::now();
    let (id, text) = loop {
      if let Some(e) = std::fs::read_dir(&q).unwrap().flatten().find(|e| e.file_name().to_string_lossy().ends_with(".req")) {
        let n = e.file_name().to_string_lossy().into_owned();
        break (n.trim_end_matches(".req").to_string(), std::fs::read_to_string(e.path()).unwrap());
      }
      if start.elapsed().as_secs() >= 10 || matches!(child.try_wait(), Ok(Some(_))) {
        let _ = child.kill();
        let o = child.wait_with_output().unwrap();
        panic!("ssh never asked: {:?} {} {}", o.status, String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
      }
      std::thread::sleep(std::time::Duration::from_millis(20));
    };
    let req = crate::ssh_askpass::parse_request(&id, &text);
    assert!(!req.echo && req.prompt.contains("passphrase"), "{req:?}");
    let mut f = std::fs::OpenOptions::new().write(true).open(q.join(format!("{id}.fifo"))).unwrap();
    f.write_all(crate::ssh_askpass::answer_line(Some("sec ret\\pw")).as_bytes()).unwrap();
    drop(f);
    let o = child.wait_with_output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    assert_eq!(String::from_utf8_lossy(&o.stdout).trim(), "locked-ok");
    let _ = Command::new("ssh").args(["-o", "ControlPath=/tmp/kingu-e2e-%C", "-O", "exit", "-p", "22222", "127.0.0.1"]).output();
  }

  #[test]
  fn reads_status_headers() {
    let st = parse_status("## main...origin/main [ahead 2]\0 M a\0R  new\0old\0?? n\0");
    assert_eq!((st.branch.as_deref(), st.upstream.as_deref(), st.ahead), (Some("main"), Some("origin/main"), 2));
    assert_eq!(st.changes.len(), 3);
    assert_eq!(st.changes[1].orig.as_deref(), Some("old"));
    assert_eq!(parse_status("## No commits yet on main\0").branch.as_deref(), Some("main"));
    assert_eq!(parse_status("## HEAD (no branch)\0").branch, None);
  }

  #[test]
  fn reads_presets_and_branches() {
    let p = parse_presets(r#"[{"id":"sp-1","name":"Web","directories":["web"],"createdAt":1,"updatedAt":2}]"#);
    assert_eq!(p[0].directories, vec!["web".to_string()]);
    assert!(parse_presets("").is_empty());
    let b = parse_branches("main\norigin/HEAD\norigin/main\n@@kingu-default\norigin/main\n");
    assert_eq!(b.branches, vec!["main".to_string(), "origin/main".to_string()]);
    assert_eq!(b.default.as_deref(), Some("origin/main"));
  }

  #[test]
  fn finds_the_github_repository_of_a_remote() {
    assert_eq!(github_repo("git@github.com:acme/app.git").as_deref(), Some("acme/app"));
    assert_eq!(github_repo("https://github.com/acme/app").as_deref(), Some("acme/app"));
    assert_eq!(github_repo("ssh://git@ssh.github.com:443/acme/app.git").as_deref(), Some("acme/app"));
    assert_eq!(github_repo("https://user@ghe.corp.io/acme/app.git").as_deref(), Some("ghe.corp.io/acme/app"));
    assert_eq!(github_repo("/srv/git/app.git"), None);
    assert_eq!(github_repo("https://github.com/acme/app/extra"), None);
  }
}
