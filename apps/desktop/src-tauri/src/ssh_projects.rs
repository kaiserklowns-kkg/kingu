//! Projects on an SSH host (Orca's repos with a `connectionId`): a git repository on a saved SSH
//! host (ssh_hosts.rs) joins the side bar, its task worktrees are made there with
//! `git worktree add`, and its terminals and agent CLIs run there over `ssh -t`. Kingu keeps no
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
/// A terminal's command, and the hook token of a claude session started in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TerminalRun {
  pub run: Vec<String>,
  pub hook: Option<String>,
}

/// Orca relays an SSH agent's hooks to the client (`src/main/agent-hooks/server/server-ingest-remote.ts`);
/// Kingu gives a claude on the host the same per-session hooks it gives a local one
/// (agent/hooks.rs `settings_json`, through `--settings`, so nothing in the host's own claude
/// settings changes), appending to `$HOME/.kingu/agent-hooks/<token>.jsonl` there, which
/// `ssh_remote_hook_read` reads over ssh. Only the events every claude knows (Orca's floor: the
/// host's claude version isn't probed). Other CLIs: none (their title is the status).
pub fn with_hooks(agent: &[String], token: &str) -> Option<Vec<String>> {
  let program = crate::agent::cli::program_of(agent)?;
  if program.rsplit('/').next() != Some("claude") || agent.iter().any(|w| w == "--settings") {
    return None;
  }
  let at = agent.iter().position(|w| std::ptr::eq(w, program))?;
  let file = format!("\"$HOME/.kingu/agent-hooks/{token}.jsonl\"");
  let command = format!("mkdir -p \"$HOME/.kingu/agent-hooks\" && {{ cat; echo; }} >> {file}");
  let entry = serde_json::json!([{ "hooks": [{ "type": "command", "command": command }] }]);
  let hooks: serde_json::Map<String, serde_json::Value> = crate::agent::hooks::EVENTS.iter().map(|e| (e.to_string(), entry.clone())).collect();
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

#[tauri::command]
pub fn ssh_project_terminal(targets: State<'_, Targets>, projects: State<'_, Projects>, host: String, root: String, path: String, agent: Option<Vec<String>>) -> Result<TerminalRun, String> {
  let t = checked(&targets, &projects, &host, &root)?;
  if !inside_project(&root, &path) {
    return Err(tr!(ProjectsMsg::RemoteBadPath, path));
  }
  let hooked = agent.as_deref().and_then(|a| random_token().and_then(|tok| with_hooks(a, &tok).map(|argv| (argv, tok))));
  Ok(match hooked {
    Some((argv, token)) => TerminalRun { run: terminal_argv(&t, &path, Some(&argv)), hook: Some(token) },
    None => TerminalRun { run: terminal_argv(&t, &path, agent.as_deref()), hook: None },
  })
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
    let argv = with_hooks(&["env".into(), "A=1".into(), "/usr/bin/claude".into(), "fix it".into()], "abcdef12").unwrap();
    assert_eq!(argv[..3], ["env", "A=1", "/usr/bin/claude"]);
    assert_eq!(argv[3], "--settings");
    assert_eq!(argv[5], "fix it");
    let v: serde_json::Value = serde_json::from_str(&argv[4]).unwrap();
    let cmd = v["hooks"]["Stop"][0]["hooks"][0]["command"].as_str().unwrap().to_string();
    assert!(with_hooks(&["codex".into()], "abcdef12").is_none());
    assert!(with_hooks(&["claude".into(), "--settings".into(), "x".into()], "abcdef12").is_none());
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

  #[test]
  fn refuses_bad_slugs_bases_and_prefixes() {
    assert!(create_script("/r", "Bad Slug", None, None, &[]).is_err());
    assert!(create_script("/r", "ok", Some("-x"), None, &[]).is_err());
    assert!(create_script("/r", "ok", Some("a b"), None, &[]).is_err());
    assert!(create_script("/r", "ok", None, Some("../"), &[]).is_err());
    assert!(remove_script("/r", "../x", true).is_err());
  }
}
