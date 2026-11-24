//! Projects on an SSH host (Orca's repos with a `connectionId`): a git repository on a saved SSH
//! host (ssh_hosts.rs) joins the side bar, its task worktrees are made there with
//! `git worktree add`, and its terminals and agent CLIs run there over `ssh -t` (held on the host
//! by Kingu's terminal daemon where it could be installed, ssh_holder.rs). Kingu keeps no
//! copy of the files: every read is one `ssh -o BatchMode=yes … sh -c '<script>'` (never a
//! password prompt; the user's keys and agent apply), and the project record is projects.rs's,
//! with its `host` field set.
//!
//! Rules (MECHANICS.md › Projects on SSH hosts; Orca source at commit 9103a362): the folder picked
//! is resolved to its repository's top level, and a linked worktree to its main checkout
//! (`src/main/ipc/repos/local-repo-registration.ts:addLocalRepoFromPath`, `mainRepoPath`); a folder
//! is known when the same host has the same path (`src/main/ipc/repos/nested-repo-import-handler.ts`,
//! `(repo.connectionId ?? null) === (args.connectionId ?? null)`); a task worktree uses the
//! repository-relative layout this computer uses, `<root>/.kingu/worktrees/<slug>`
//! (`src/main/ipc/worktree-logic.ts:computeRemoteWorktreePath` keeps a repo-relative layout on
//! the host), made with `git worktree add --no-track -b <branch> <path> <base>`
//! (`src/main/git/worktrees/creation/worktree-add.ts:performAddWorktree`).

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tauri::State;

use crate::agent::worktree::{self, WorktreeInfo};
use crate::i18n::msg::{AgentMsg, ProjectsMsg, TasksMsg};
use crate::projects::{Added, Project, Projects};
use crate::ssh_holder::{self, LoopText};
use crate::ssh_hosts::{self, Target, Targets, posix_dir, sh_quote};
use crate::tr;

/// `git worktree add` on the host may check out a large tree (Kingu's limit, **estimated**).
pub const CREATE_TIMEOUT_MS: u64 = 120_000;
/// Marks the start of the per-worktree status part of [`listing_script`]'s output.
const STATUS_MARK: &str = "@@kingu-status";
const WT_MARK: &str = "@@kingu-wt ";

// ---------------------------------------------------------------------------------------------
// Scripts (pure, so the tests read them)

/// The repository of folder `path`: its top level, then its common git folder (absolute).
pub fn root_script(path: &str) -> String {
  format!(r#"cd {} && top=$(git rev-parse --show-toplevel) && common=$(cd "$(git rev-parse --git-common-dir)" && pwd -P) && printf '%s\n%s\n' "$top" "$common""#, posix_dir(path))
}

/// Orca `Wxe`: the repository's top level, or the main checkout when the folder is a linked
/// worktree (its common git folder is `<main>/.git`).
pub fn parse_root(out: &str) -> Option<String> {
  let mut lines = out.lines().map(str::trim).filter(|l| !l.is_empty());
  let top = lines.next()?.to_string();
  let common = lines.next()?;
  if !top.starts_with('/') {
    return None;
  }
  match common.strip_suffix("/.git") {
    Some(main) if !main.is_empty() && main != top => Some(main.to_string()),
    _ => Some(top),
  }
}

/// The worktrees of `root` (`git worktree list --porcelain`), then each one's
/// `git status --porcelain=v1 --branch` after a marker line naming it.
pub fn listing_script(root: &str) -> String {
  format!(
    r#"cd {} && git worktree list --porcelain && printf '%s\n' '{STATUS_MARK}' && git worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r w; do printf '{WT_MARK}%s\n' "$w"; git -C "$w" status --porcelain=v1 --branch 2>/dev/null; done"#,
    posix_dir(root)
  )
}

/// A worktree on the host with what `git status` says of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemoteWorktree {
  #[serde(flatten)]
  pub info: WorktreeInfo,
  /// Changed and untracked files; `None` when its status couldn't be read.
  pub changes: Option<u32>,
  pub upstream: Option<String>,
  pub ahead: u32,
  pub behind: u32,
}

/// `## main...origin/main [ahead 1, behind 2]` → (upstream, ahead, behind).
pub(crate) fn parse_branch_line(line: &str) -> (Option<String>, u32, u32) {
  let rest = line.trim_start_matches("## ");
  let (head, counts) = match rest.split_once(" [") {
    Some((h, c)) => (h, c.trim_end_matches(']')),
    None => (rest, ""),
  };
  let upstream = head.split_once("...").map(|(_, u)| u.trim().to_string()).filter(|u| !u.is_empty());
  let mut ahead = 0;
  let mut behind = 0;
  for part in counts.split(',').map(str::trim) {
    if let Some(n) = part.strip_prefix("ahead ") {
      ahead = n.parse().unwrap_or(0);
    } else if let Some(n) = part.strip_prefix("behind ") {
      behind = n.parse().unwrap_or(0);
    }
  }
  (upstream, ahead, behind)
}

pub fn parse_listing(out: &str) -> Vec<RemoteWorktree> {
  let (list, status) = match out.split_once(&format!("{STATUS_MARK}\n")) {
    Some((l, s)) => (l, s),
    None => (out, ""),
  };
  let mut rows: Vec<RemoteWorktree> = worktree::parse_porcelain(list)
    .into_iter()
    .filter(|w| !w.bare)
    .map(|info| RemoteWorktree { info, changes: None, upstream: None, ahead: 0, behind: 0 })
    .collect();
  let mut current: Option<usize> = None;
  for line in status.lines() {
    if let Some(path) = line.strip_prefix(WT_MARK) {
      current = rows.iter().position(|r| r.info.path == path);
      if let Some(i) = current {
        rows[i].changes = Some(0);
      }
      continue;
    }
    let Some(i) = current else { continue };
    if line.starts_with("## ") {
      let (u, a, b) = parse_branch_line(line);
      rows[i].upstream = u;
      rows[i].ahead = a;
      rows[i].behind = b;
    } else if !line.trim().is_empty() {
      rows[i].changes = Some(rows[i].changes.unwrap_or(0) + 1);
    }
  }
  rows
}

/// Kingu's task worktree for `slug` in `root` on the host.
pub fn remote_worktree_path(root: &str, slug: &str) -> String {
  worktree::worktree_path(Path::new(root), slug).to_string_lossy().into_owned()
}

/// `git worktree add --no-track -b <prefix><slug> -- <root>/.kingu/worktrees/<slug> <commit>` on the host,
/// after the same checks as on this computer (agent/worktree.rs `create_named_sparse`): the base
/// must be a commit, the folder must not exist, the branch name must be valid; `.kingu/` is kept
/// out of git's view through `info/exclude` once per repository.
///
/// With `sparse` folders, Orca's `addSparseWorktree` (`src/main/git/worktrees/creation/worktree-sparse-add.ts`,
/// as agent/worktree.rs does here): `worktree add --no-checkout`, then in the worktree
/// `sparse-checkout init --cone`, `sparse-checkout set -- <folders>` and `checkout <branch>`; a
/// failed step removes the half-made worktree and its branch again.
pub fn create_script(root: &str, slug: &str, base: Option<&str>, prefix: Option<&str>, sparse: &[String]) -> Result<String, String> {
  worktree::validate_slug(slug)?;
  let sparse = worktree::normalize_sparse_dirs(sparse)?;
  let prefix = prefix.unwrap_or(worktree::DEFAULT_BRANCH_PREFIX);
  worktree::validate_prefix(prefix)?;
  let base = base.map(str::trim).filter(|b| !b.is_empty()).unwrap_or("HEAD");
  if base.starts_with('-') || base.chars().any(|c| c.is_whitespace() || c.is_control()) {
    return Err(tr!(TasksMsg::BadBaseRef, base));
  }
  let path = remote_worktree_path(root, slug);
  let branch = format!("{prefix}{slug}");
  let fail = |msg: String, code: u8| format!("{{ printf '%s\\n' {} >&2; exit {code}; }}", sh_quote(&msg));
  let mut rules = vec![worktree::EXCLUDE_MARK.to_string()];
  rules.extend(worktree::exclude_rules(""));
  let rules = rules.iter().map(|r| sh_quote(r)).collect::<Vec<_>>().join(" ");
  Ok(format!(
    "cd {root_q} || exit 1\n\
     commit=$(git rev-parse --verify --quiet --end-of-options {base_q}) || {not_commit}\n\
     if [ -e {path_q} ]; then {exists}; fi\n\
     git check-ref-format --branch {branch_q} >/dev/null 2>&1 || {bad_branch}\n\
     ex=\"$(git rev-parse --git-common-dir)/info/exclude\"\n\
     if ! grep -qxF {mark_q} \"$ex\" 2>/dev/null; then mkdir -p \"$(dirname \"$ex\")\" && printf '\\n' >> \"$ex\" && printf '%s\\n' {rules} >> \"$ex\"; fi\n\
     {add}",
    root_q = posix_dir(root),
    base_q = sh_quote(&format!("{base}^{{commit}}")),
    not_commit = fail(tr!(ProjectsMsg::RemoteNotACommit, base), 3),
    path_q = sh_quote(&path),
    exists = fail(tr!(ProjectsMsg::RemoteWorktreeExists, path = path), 4),
    branch_q = sh_quote(&branch),
    bad_branch = fail(tr!(AgentMsg::BadBranchName, branch = branch), 5),
    mark_q = sh_quote(worktree::EXCLUDE_MARK),
    add = add_step(&path, &branch, &sparse),
  ))
}

/// The `git worktree add` step of [`create_script`] (run in the repository, `$commit` set).
fn add_step(path: &str, branch: &str, sparse: &[String]) -> String {
  let (path_q, branch_q) = (sh_quote(path), sh_quote(branch));
  if sparse.is_empty() {
    return format!("git worktree add --no-track -b {branch_q} -- {path_q} \"$commit\"");
  }
  let dirs = sparse.iter().map(|d| sh_quote(d)).collect::<Vec<_>>().join(" ");
  format!(
    "git worktree add --no-track --no-checkout -b {branch_q} -- {path_q} \"$commit\" || exit 1\n\
     if ! {{ git -C {path_q} sparse-checkout init --cone && git -C {path_q} sparse-checkout set -- {dirs} && git -C {path_q} checkout -q {branch_q}; }}; then\n\
     git worktree remove --force -- {path_q} >/dev/null 2>&1; git branch -D -- {branch_q} >/dev/null 2>&1; exit 6\n\
     fi"
  )
}

/// `git worktree remove [--force] -- <path>`: the branch stays (Kingu's choice for the host,
/// **estimated**; its local removal asks what to do with the branch).
pub fn remove_script(root: &str, slug: &str, force: bool) -> Result<String, String> {
  worktree::validate_slug(slug)?;
  Ok(format!("cd {} && git worktree remove {}-- {}", posix_dir(root), if force { "--force " } else { "" }, sh_quote(&remote_worktree_path(root, slug))))
}

/// Orca `src/main/ssh/remote-exec/ssh-login-shell-command.ts:buildSshLoginShellCommand`: the
/// user's shell runs the command with `-lc`, but with `-c` for `sh`, `dash`, `csh` and `tcsh`
/// (csh and tcsh reject `-lc`).
pub const SHELL_MODE: &str = r#"s="${SHELL:-sh}"; case "${s##*/}" in sh|dash|csh|tcsh) m=-c ;; *) m=-lc ;; esac"#;

/// The terminal argv for `path` on the host: a login shell there, or `agent` (argv, each word
/// quoted) run by the user's shell first ([`SHELL_MODE`]), a login shell staying open after it
/// (Kingu's choice, **estimated**). The script goes through `sh -c` as every Kingu remote command
/// does, so a fish or tcsh login shell on the host still reads it. Like Orca's plain SSH terminal
/// (`src/main/ssh/plain-ssh-terminal/plain-ssh-terminal-args.ts`), no `-T` and no `BatchMode`:
/// the terminal may ask for a passphrase itself.
pub fn terminal_argv(t: &Target, path: &str, agent: Option<&[String]>) -> Vec<String> {
  let mut argv = vec!["ssh".to_string(), "-t".to_string()];
  argv.extend(ssh_hosts::destination_args(t));
  argv.push(format!("sh -c {}", sh_quote(&terminal_script(path, agent))));
  argv
}

/// The script [`terminal_argv`] hands to `sh -c` on the host.
pub fn terminal_script(path: &str, agent: Option<&[String]>) -> String {
  let cd = format!("cd -- {} || exit 1", posix_dir(path));
  match agent.filter(|a| !a.is_empty()) {
    None => format!("{cd}; exec \"${{SHELL:-sh}}\" -l"),
    Some(a) => {
      let cmd = a.iter().map(|w| sh_quote(w)).collect::<Vec<_>>().join(" ");
      format!("{cd}; {SHELL_MODE}; \"$s\" $m {}; exec \"$s\" -l", sh_quote(&cmd))
    }
  }
}

/// [`terminal_script`] for an agent whose session gets `KINGU_AGENT_HOOK_FILE` (the hook file of
/// `token` on the host), as a session the holder starts does (ssh_holder.rs `start_script`).
pub fn agent_script(path: &str, agent: &[String], token: Option<&str>) -> String {
  let script = terminal_script(path, Some(agent));
  match token {
    Some(t) => format!("mkdir -p \"$HOME/{dir}\"; export KINGU_AGENT_HOOK_FILE=\"$HOME/{dir}/{t}.jsonl\"; {script}", dir = crate::ssh_holder::HOOKS_DIR),
    None => script,
  }
}

/// `path` is the project's root or one of its task worktrees.
pub fn inside_project(root: &str, path: &str) -> bool {
  let root = root.trim_end_matches('/');
  path == root || path.strip_prefix(&format!("{root}/.kingu/worktrees/")).is_some_and(|slug| worktree::validate_slug(slug).is_ok())
}

// ---------------------------------------------------------------------------------------------
// Commands

#[tauri::command]
pub fn ssh_projects_list(projects: State<'_, Projects>) -> Vec<Project> {
  projects.remote_list()
}

/// Adds folder `path` of host `host`: resolved on the host to its repository first.
#[tauri::command]
pub async fn ssh_project_add(targets: State<'_, Targets>, projects: State<'_, Projects>, host: String, path: String) -> Result<Added, String> {
  let t = targets.get(&host)?;
  let not_repo = tr!(ProjectsMsg::RemoteNotRepo, path = path, host = t.label);
  let script = root_script(&path);
  let out = ssh_hosts::blocking(move || ssh_hosts::remote(&t, &script)).await?.map_err(|e| {
    log::info!("ssh project {host}:{path}: {e}");
    format!("{not_repo} ({e})")
  })?;
  let root = parse_root(&out).ok_or(not_repo)?;
  let added = projects.add_remote(&host, &root)?;
  if !added.existed {
    log::info!("ssh project added: {host}:{root}");
  }
  Ok(added)
}

#[tauri::command]
pub fn ssh_project_remove(projects: State<'_, Projects>, host: String, path: String) -> Result<(), String> {
  projects.remove_remote(&host, &path)
}

fn checked(targets: &Targets, projects: &Projects, host: &str, root: &str) -> Result<Target, String> {
  projects.check_remote(host, root)?;
  targets.get(host)
}

/// The project's worktrees on the host with their branch and status.
#[tauri::command]
pub async fn ssh_project_worktrees(targets: State<'_, Targets>, projects: State<'_, Projects>, host: String, root: String) -> Result<Vec<RemoteWorktree>, String> {
  let t = checked(&targets, &projects, &host, &root)?;
  ssh_hosts::blocking(move || ssh_hosts::remote(&t, &listing_script(&root)).map(|o| parse_listing(&o))).await?
}

/// A task worktree on the host (see [`create_script`]).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_project_worktree_add(
  targets: State<'_, Targets>,
  projects: State<'_, Projects>,
  host: String,
  root: String,
  slug: String,
  base: Option<String>,
  prefix: Option<String>,
  sparse: Option<Vec<String>>,
) -> Result<String, String> {
  let t = checked(&targets, &projects, &host, &root)?;
  let script = create_script(&root, &slug, base.as_deref(), prefix.as_deref(), sparse.as_deref().unwrap_or_default())?;
  let path = remote_worktree_path(&root, &slug);
  ssh_hosts::blocking(move || ssh_hosts::remote_within(&t, &script, Duration::from_millis(CREATE_TIMEOUT_MS))).await??;
  log::info!("ssh worktree {slug} created at {host}:{path}");
  Ok(path)
}

#[tauri::command]
pub async fn ssh_project_worktree_remove(targets: State<'_, Targets>, projects: State<'_, Projects>, host: String, root: String, slug: String, force: bool) -> Result<(), String> {
  let t = checked(&targets, &projects, &host, &root)?;
  let script = remove_script(&root, &slug, force)?;
  ssh_hosts::blocking(move || ssh_hosts::remote_within(&t, &script, Duration::from_millis(CREATE_TIMEOUT_MS))).await??;
  Ok(())
}

/// The terminal argv for the project root or a task worktree of it, optionally starting `agent`.
/// A terminal's command, the hook token of an agent session started in it, and what happens to
/// it when the connection drops.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TerminalRun {
  pub run: Vec<String>,
  pub hook: Option<String>,
  /// The session's key in the host's terminal daemon, when it is held there.
  pub key: Option<String>,
  /// `held`: the terminal keeps running on the host and is reattached; `restart`: the agent ends
  /// with the connection and is started again with its resume command; `plain`: it just ends.
  pub mode: &'static str,
}

/// Orca relays an SSH agent's hooks to the client (`src/main/agent-hooks/server/server-ingest-remote.ts`);
/// Kingu gives a claude on the host the same per-session hooks it gives a local one
/// (agent/hooks.rs `settings_json`, through `--settings`, so nothing in the host's own claude
/// settings changes), appending to `$HOME/.kingu/agent-hooks/<token>.jsonl` there, which
/// `ssh_remote_hook_read` reads over ssh. Only the events every claude knows (Orca's floor: the
/// host's claude version isn't probed). With `hold`, PermissionRequest runs the hold script on the
/// host instead (ssh_holder.rs `hold_command`) and waits for the card's answer, as a local claude's
/// does. Other CLIs take no per-session hooks; theirs report through `KINGU_AGENT_HOOK_FILE` when
/// the host's own CLI config has Kingu's entries.
pub fn with_hooks(agent: &[String], token: &str, hold: bool) -> Option<Vec<String>> {
  let program = crate::agent::cli::program_of(agent)?;
  if program.rsplit('/').next() != Some("claude") || agent.iter().any(|w| w == "--settings") {
    return None;
  }
  let at = agent.iter().position(|w| std::ptr::eq(w, program))?;
  let file = format!("\"$HOME/.kingu/agent-hooks/{token}.jsonl\"");
  let command = format!("mkdir -p \"$HOME/.kingu/agent-hooks\" && {{ cat; echo; }} >> {file}");
  let entry = serde_json::json!([{ "hooks": [{ "type": "command", "command": command }] }]);
  let held = serde_json::json!([{ "hooks": [{ "type": "command", "command": crate::ssh_holder::hold_command(token), "timeout": crate::agent::hooks::PERMISSION_HOLD_TIMEOUT_SECONDS }] }]);
  let hooks: serde_json::Map<String, serde_json::Value> = crate::agent::hooks::EVENTS.iter().map(|e| (e.to_string(), if hold && *e == "PermissionRequest" { held.clone() } else { entry.clone() })).collect();
  let mut out = agent.to_vec();
  out.splice(at + 1..at + 1, ["--settings".to_string(), serde_json::json!({ "hooks": hooks }).to_string()]);
  Some(out)
}

fn random_token() -> Option<String> {
  use std::io::Read;
  let mut b = [0u8; 12];
  std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).ok()?;
  Some(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// What a terminal of the project runs, by what the host can do ([`TerminalRun::mode`]).
///
/// - `holder` (the id ssh_holder.rs found or installed): the session starts in the host's terminal
///   daemon and the tab runs the reattach loop.
/// - else, with `agent` and its `resume` argv: the agent runs under `ssh -t` as before, and after
///   a lost connection the loop starts `resume` once the host is back.
/// - else: one `ssh -t`, which ends with its connection.
///
/// Every agent's session gets a hook file (`hook`); a claude also gets per-session hooks writing
/// to it, with the permission hold when `hold` says the host has the hold script.
#[allow(clippy::too_many_arguments)]
pub fn terminal_run(t: &Target, path: &str, agent: Option<&[String]>, resume: Option<&[String]>, holder: Option<&str>, hold: bool, token: Option<&str>, key: &str, home: &Path, text: &LoopText) -> Result<TerminalRun, String> {
  let agent = agent.filter(|a| !a.is_empty());
  let token = token.filter(|_| agent.is_some());
  let hooked = |argv: &[String]| token.and_then(|tok| with_hooks(argv, tok, hold)).unwrap_or_else(|| argv.to_vec());
  let wait = ssh_holder::wait_argv(t, home);
  let looped = |first: &[String], again: Option<&[String]>, held: bool| vec!["sh".to_string(), "-c".to_string(), ssh_holder::loop_script(first, again, wait.as_deref(), held, text)];
  if let Some(id) = holder {
    let first = ssh_holder::terminal_ssh(t, &ssh_holder::start_script(id, key, path, token, agent.map(hooked).as_deref())?);
    let again = ssh_holder::terminal_ssh(t, &ssh_holder::reattach_script(id, key)?);
    return Ok(TerminalRun { run: looped(&first, Some(&again), true), hook: token.map(str::to_string), key: Some(key.to_string()), mode: "held" });
  }
  let Some(agent) = agent else {
    return Ok(TerminalRun { run: terminal_argv(t, path, None), hook: None, key: None, mode: "plain" });
  };
  let first = ssh_holder::terminal_ssh(t, &agent_script(path, &hooked(agent), token));
  let again = resume.filter(|r| !r.is_empty()).map(|r| ssh_holder::terminal_ssh(t, &agent_script(path, &hooked(r), token)));
  let mode = if again.is_some() { "restart" } else { "plain" };
  Ok(TerminalRun { run: looped(&first, again.as_deref(), false), hook: token.map(str::to_string), key: None, mode })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn ssh_project_terminal(
  app: tauri::AppHandle,
  targets: State<'_, Targets>,
  projects: State<'_, Projects>,
  host: String,
  root: String,
  path: String,
  agent: Option<Vec<String>>,
  resume: Option<Vec<String>>,
  holder: Option<String>,
  hold: Option<bool>,
  text: Option<LoopText>,
) -> Result<TerminalRun, String> {
  let t = checked(&targets, &projects, &host, &root)?;
  if !inside_project(&root, &path) {
    return Err(tr!(ProjectsMsg::RemoteBadPath, path));
  }
  let token = random_token();
  let key = ssh_holder::session_key(&random_token().ok_or("no random source for a session key")?);
  // A claude held on the host gets the browser tools, relayed to this computer's browser
  // (ssh_browser_relay.rs; the run is the session's hook token, closing the tab ends it).
  let agent = match (agent, token.as_deref(), holder.as_deref()) {
    (Some(a), Some(run), Some(h)) => Some(crate::ssh_browser_relay::offer(&app, &t, h, run, &path, &a).unwrap_or(a)),
    (a, ..) => a,
  };
  terminal_run(&t, &path, agent.as_deref(), resume.as_deref(), holder.as_deref(), hold.unwrap_or(false), token.as_deref(), &key, &ssh_hosts::dirs_home(), &text.unwrap_or_default())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::process::Command;

  fn sh(script: &str, dir: &Path) -> (bool, String, String) {
    let o = Command::new("sh").arg("-c").arg(script).current_dir(dir).env("HOME", dir).env("SHELL", "/bin/sh").output().unwrap();
    (o.status.success(), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
  }

  fn git(dir: &Path, args: &[&str]) {
    let o = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
  }

  fn repo() -> (tempfile::TempDir, String) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap().join("repo");
    std::fs::create_dir(&root).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    std::fs::write(root.join("a.txt"), "a").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
    (tmp, root.to_string_lossy().into_owned())
  }

  #[test]
  fn resolves_a_folder_to_its_repository_and_a_linked_worktree_to_its_main_checkout() {
    assert_eq!(parse_root("/srv/app\n/srv/app/.git\n"), Some("/srv/app".into()));
    assert_eq!(parse_root("/srv/app/.kingu/worktrees/x\n/srv/app/.git\n"), Some("/srv/app".into()));
    assert_eq!(parse_root("/srv/app\n/srv/app.git\n"), Some("/srv/app".into()));
    assert_eq!(parse_root(""), None);
    assert_eq!(parse_root("relative\n/x/.git\n"), None);
  }

  #[test]
  fn reads_branch_lines() {
    assert_eq!(parse_branch_line("## main...origin/main [ahead 1, behind 2]"), (Some("origin/main".into()), 1, 2));
    assert_eq!(parse_branch_line("## kingu/x"), (None, 0, 0));
    assert_eq!(parse_branch_line("## main...origin/main [behind 3]"), (Some("origin/main".into()), 0, 3));
    assert_eq!(parse_branch_line("## HEAD (no branch)"), (None, 0, 0));
  }

  #[test]
  fn only_the_root_and_its_task_worktrees_get_a_terminal() {
    assert!(inside_project("/srv/app", "/srv/app"));
    assert!(inside_project("/srv/app/", "/srv/app/.kingu/worktrees/fix-login"));
    assert!(!inside_project("/srv/app", "/srv/app/.kingu/worktrees/../../etc"));
    assert!(!inside_project("/srv/app", "/srv/other"));
  }

  #[test]
  fn terminal_quotes_the_folder_and_every_agent_word() {
    let t = Target { id: "h".into(), label: "h".into(), config_host: Some("box".into()), host: "box".into(), port: 22, username: String::new(), identity_file: None, jump_host: None, proxy_command: None };
    let a = terminal_argv(&t, "/srv/app", None);
    assert_eq!(a[..4], ["ssh", "-t", "--", "box"]);
    assert_eq!(a[4], format!("sh -c {}", sh_quote(&terminal_script("/srv/app", None))));
    // What the host runs (a stand-in: printf for the agent, stdin closed so the shell left open
    // exits) lands in the folder and receives each word unchanged, however it is spelled.
    let tmp = tempfile::tempdir().unwrap();
    let odd = tmp.path().canonicalize().unwrap().join("it's $x");
    std::fs::create_dir(&odd).unwrap();
    let odd = odd.to_string_lossy().into_owned();
    let script = terminal_script(&odd, Some(&["sh".into(), "-c".into(), "printf '[%s]' \"$PWD\" \"$0\"".into(), "fix $HOME; rm -rf /".into()]));
    let (ok, out, err) = sh(&script, Path::new("/"));
    assert!(ok, "{err}");
    assert!(out.starts_with(&format!("[{odd}][fix $HOME; rm -rf /]")), "{out}");
  }

  #[test]
  fn csh_and_plain_sh_get_c_others_lc() {
    for (shell, mode) in [("/bin/sh", "-c"), ("/usr/bin/tcsh", "-c"), ("/bin/bash", "-lc"), ("/usr/local/bin/fish", "-lc"), ("", "-c")] {
      let (ok, out, _) = sh(&format!("SHELL={shell}; {SHELL_MODE}; printf %s \"$m\""), Path::new("/"));
      assert!(ok);
      assert_eq!(out, mode, "{shell}");
    }
  }

  #[test]
  fn makes_lists_and_removes_a_task_worktree_with_the_scripts_run_by_sh() {
    let (_tmp, root) = repo();
    let dir = Path::new(&root);
    let script = create_script(&root, "fix-login", None, None, &[]).unwrap();
    let (ok, _, err) = sh(&script, dir);
    assert!(ok, "{err}");
    // .kingu is excluded once, even when made twice.
    let (ok, _, err) = sh(&create_script(&root, "fix-login", None, None, &[]).unwrap(), dir);
    assert!(!ok);
    assert!(err.contains("already exists"), "{err}");
    let exclude = std::fs::read_to_string(dir.join(".git/info/exclude")).unwrap();
    assert_eq!(exclude.matches(worktree::EXCLUDE_MARK).count(), 1);

    std::fs::write(dir.join(".kingu/worktrees/fix-login/b.txt"), "b").unwrap();
    let (ok, out, err) = sh(&listing_script(&root), dir);
    assert!(ok, "{err}");
    let rows = parse_listing(&out);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].info.path, root);
    assert_eq!(rows[0].changes, Some(0), "the main checkout is clean: .kingu is excluded");
    let task = &rows[1];
    assert_eq!(task.info.slug.as_deref(), Some("fix-login"));
    assert_eq!(task.info.branch.as_deref(), Some("kingu/fix-login"));
    assert_eq!(task.changes, Some(1));

    let (ok, _, err) = sh(&create_script(&root, "other", Some("no-such-ref"), None, &[]).unwrap(), dir);
    assert!(!ok);
    assert!(err.contains("no-such-ref"), "{err}");

    let (ok, _, _) = sh(&remove_script(&root, "fix-login", false).unwrap(), dir);
    assert!(!ok, "a worktree with changes needs force");
    let (ok, _, err) = sh(&remove_script(&root, "fix-login", true).unwrap(), dir);
    assert!(ok, "{err}");
    let (_, out, _) = sh(&listing_script(&root), dir);
    assert_eq!(parse_listing(&out).len(), 1);

    let (ok, out, err) = sh(&root_script(&format!("{root}/.kingu")), dir);
    // `.kingu` is inside the repository: its root is the repository.
    assert!(ok, "{err}");
    assert_eq!(parse_root(&out).as_deref(), Some(root.as_str()));
  }

  #[test]
  fn makes_a_sparse_worktree_from_a_chosen_base() {
    let (_tmp, root) = repo();
    let dir = Path::new(&root);
    std::fs::create_dir_all(dir.join("web")).unwrap();
    std::fs::create_dir_all(dir.join("api")).unwrap();
    std::fs::write(dir.join("web/w.txt"), "w").unwrap();
    std::fs::write(dir.join("api/a.txt"), "a").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "two"]);
    git(dir, &["branch", "base-x", "HEAD~1"]);
    let (ok, _, err) = sh(&create_script(&root, "sparse", None, None, &["web".into()]).unwrap(), dir);
    assert!(ok, "{err}");
    let wt = dir.join(".kingu/worktrees/sparse");
    assert!(wt.join("web/w.txt").exists());
    assert!(!wt.join("api").exists(), "only the chosen folder is checked out");
    assert!(wt.join("a.txt").exists(), "top-level files stay (cone mode)");
    let (ok, _, err) = sh(&create_script(&root, "old", Some("base-x"), None, &[]).unwrap(), dir);
    assert!(ok, "{err}");
    assert!(!dir.join(".kingu/worktrees/old/web").exists(), "started from base-x");
    assert!(create_script(&root, "x", None, None, &["/abs".into()]).is_err());
  }

  #[test]
  fn a_claude_on_the_host_gets_hooks_that_append_to_its_own_file() {
    let argv = with_hooks(&["env".into(), "A=1".into(), "/usr/bin/claude".into(), "fix it".into()], "abcdef12", false).unwrap();
    assert_eq!(argv[..3], ["env", "A=1", "/usr/bin/claude"]);
    assert_eq!(argv[3], "--settings");
    assert_eq!(argv[5], "fix it");
    let v: serde_json::Value = serde_json::from_str(&argv[4]).unwrap();
    let cmd = v["hooks"]["Stop"][0]["hooks"][0]["command"].as_str().unwrap().to_string();
    assert!(with_hooks(&["codex".into()], "abcdef12", false).is_none());
    assert!(with_hooks(&["claude".into(), "--settings".into(), "x".into()], "abcdef12", false).is_none());
    // With the hold script on the host, only PermissionRequest waits for the card's answer.
    let held = with_hooks(&["claude".into()], "abcdef12", true).unwrap();
    let hv: serde_json::Value = serde_json::from_str(&held[2]).unwrap();
    assert_eq!(hv["hooks"]["PermissionRequest"][0]["hooks"][0]["command"], crate::ssh_holder::hold_command("abcdef12"));
    assert_eq!(hv["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"], 130);
    assert_eq!(hv["hooks"]["Stop"], v["hooks"]["Stop"]);
    // The hook command, run by a shell on the "host", appends the payload as one line.
    let tmp = tempfile::tempdir().unwrap();
    let mut c = Command::new("sh").arg("-c").arg(&cmd).env("HOME", tmp.path()).stdin(std::process::Stdio::piped()).spawn().unwrap();
    use std::io::Write;
    c.stdin.take().unwrap().write_all(br#"{"hook_event_name":"Stop"}"#).unwrap();
    assert!(c.wait().unwrap().success());
    let text = std::fs::read_to_string(tmp.path().join(".kingu/agent-hooks/abcdef12.jsonl")).unwrap();
    assert_eq!(text, "{\"hook_event_name\":\"Stop\"}\n");
    // The whole argv still survives the terminal script's quoting.
    let script = terminal_script("/", Some(&["sh".into(), "-c".into(), "printf '[%s]' \"$1\"".into(), "x".into(), argv[4].clone()]));
    let (ok, out, err) = sh(&script, Path::new("/"));
    assert!(ok, "{err}");
    assert!(out.starts_with(&format!("[{}]", argv[4])), "{out}");
  }

  fn box_target() -> Target {
    Target { id: "h".into(), label: "h".into(), config_host: Some("box".into()), host: "box".into(), port: 22, username: String::new(), identity_file: None, jump_host: None, proxy_command: None }
  }

  #[test]
  fn a_terminal_is_held_restarted_or_plain_by_what_the_host_can_do() {
    let t = box_target();
    let home = tempfile::tempdir().unwrap();
    let text = LoopText::default();
    let id = "kingu-ptyd-0.1.0-aaaaaaaaaaaaaaaa";
    let claude = ["claude".to_string(), "fix it".to_string()];
    let resume = ["claude".to_string(), "--continue".to_string()];
    let run = |agent: Option<&[String]>, resume: Option<&[String]>, holder: Option<&str>| terminal_run(&t, "/srv/app", agent, resume, holder, true, Some("abcdef123456"), "ssh:k1", home.path(), &text).unwrap();

    // Held: the daemon starts the session, the loop reattaches to the same key, never the agent again.
    let held = run(Some(&claude), Some(&resume), Some(id));
    assert_eq!((held.mode, held.key.as_deref(), held.hook.as_deref()), ("held", Some("ssh:k1"), Some("abcdef123456")));
    assert_eq!(held.run[..2], ["sh", "-c"]);
    let script = &held.run[2];
    assert!(script.contains("attach --dir") && script.contains("--key ssh:k1 --cwd"), "{script}");
    assert_eq!(script.matches("fix it").count(), 1, "the prompt is in the start command only");
    assert!(!script.contains("--continue"), "a held session is reattached, not resumed");
    assert!(script.contains(&text.lost_held) && script.contains(&text.reattaching));
    assert!(script.contains("KINGU_AGENT_HOOK_FILE=$HOME/.kingu/agent-hooks/abcdef123456.jsonl"));
    assert!(script.contains("permission-hold.sh"), "the claude waits for the card's answer");
    // A plain shell is held too, without a hook file.
    let shell = run(None, None, Some(id));
    assert_eq!((shell.mode, shell.hook), ("held", None));
    assert!(!shell.run[2].contains("KINGU_AGENT_HOOK_FILE"));

    // No holder: the agent is started again with its resume command, and that is what is said.
    let restart = run(Some(&claude), Some(&resume), None);
    assert_eq!((restart.mode, restart.key.as_deref(), restart.hook.as_deref()), ("restart", None, Some("abcdef123456")));
    let script = &restart.run[2];
    assert!(script.contains("--continue") && script.contains(&text.restarting) && script.contains(&text.lost_restart));
    assert!(!script.contains(&text.reattaching) && !script.contains("attach --dir"));
    assert!(script.contains("export KINGU_AGENT_HOOK_FILE="));
    // A CLI that can't resume: the loss is only said.
    let gone = run(Some(&["aider".to_string()]), None, None);
    assert_eq!(gone.mode, "plain");
    assert!(gone.run[2].contains(&text.lost_gone) && !gone.run[2].contains("while"));
    // A plain shell without a holder is the one ssh it always was.
    let plain = run(None, None, None);
    assert_eq!((plain.mode, &plain.run), ("plain", &terminal_argv(&t, "/srv/app", None)));

    // The agent's loop is a multi-line script: pty_spawn types a short line instead of echoing
    // every line of it as a continuation prompt (pty.rs `run_through_env`).
    for r in [&held, &restart, &gone] {
      let (typed, script) = crate::pty::run_through_env(&r.run).expect("the loop goes through the environment");
      assert_eq!(script, r.run[2]);
      let line = kingu_ptyd::command_line(&typed).unwrap();
      assert!(!line.contains('\n') && line.len() < 40, "{line}");
    }
  }

  #[test]
  fn an_agent_without_a_holder_still_gets_its_hook_file() {
    let tmp = tempfile::tempdir().unwrap();
    let script = agent_script("/", &["sh".into(), "-c".into(), "printf '[%s]' \"$KINGU_AGENT_HOOK_FILE\"".into()], Some("abcdef123456"));
    let (ok, out, err) = sh(&script, tmp.path());
    assert!(ok, "{err}");
    assert!(out.starts_with(&format!("[{}/.kingu/agent-hooks/abcdef123456.jsonl]", tmp.path().display())), "{out}");
    assert!(tmp.path().join(".kingu/agent-hooks").is_dir());
  }

  #[test]
  fn refuses_bad_slugs_bases_and_prefixes() {
    assert!(create_script("/r", "Bad Slug", None, None, &[]).is_err());
    assert!(create_script("/r", "ok", Some("-x"), None, &[]).is_err());
    assert!(create_script("/r", "ok", Some("a b"), None, &[]).is_err());
    assert!(create_script("/r", "ok", None, Some("../"), &[]).is_err());
    assert!(remove_script("/r", "../x", true).is_err());
  }
}
