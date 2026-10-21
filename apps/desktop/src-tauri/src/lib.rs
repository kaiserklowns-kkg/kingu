mod accounts;
mod agent;
mod artifacts;
mod attachments;
mod backup;
mod cli_server;
mod dap;
mod dialog;
mod external;
mod fileops;
mod floating;
mod fs;
mod git;
mod git_editor;
mod git_graph;
mod git_ops;
mod git_output;
mod git_queue;
mod git_repos;
mod i18n;
mod glob;
mod git_remote;
mod gitlab;
mod jira;
mod linear;
mod local_ai;
mod local_history;
mod logging;
mod lsp;
mod menu;
mod net_proxy;
mod project;
mod projects;
mod notify;
mod pty;
mod replace;
mod search;
mod smart_search;
mod sessions;
mod settings;
mod shell_env;
mod shell_integration;
mod skill_hub;
mod snap;
mod snap_install;
mod snap_sandbox;
mod snippets;
mod startup;
mod system;
mod tasks;
mod testing;
mod terminal_links;
mod team;
mod usage;
mod user_profiles;
mod textfile;
mod tracker_http;
mod vault;
mod voice;
mod watcher;
mod window;
mod windows;
mod workspace;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use workspace::{Recent, Workspace, Workspaces, resolve_in};

#[derive(serde::Serialize)]
struct AppInfo {
  name: &'static str,
  version: &'static str,
  os: &'static str,
  arch: &'static str,
  /// Root of the open folder, `""` when none is open.
  workspace: String,
}

#[tauri::command]
fn app_info(ws: Workspace) -> AppInfo {
  log::info!("app_info requested by webview");
  AppInfo {
    name: "Kingu",
    version: env!("CARGO_PKG_VERSION"),
    os: std::env::consts::OS,
    arch: std::env::consts::ARCH,
    workspace: ws.current().map(|r| r.display().to_string()).unwrap_or_default(),
  }
}

/// Status bar resources (memory, CPU, processes, terminals, keep-awake), polled by the webview.
#[tauri::command]
async fn system_stats(app: tauri::AppHandle, ptys: State<'_, pty::Ptys>, keep: State<'_, system::KeepAwake>) -> Result<system::Stats, String> {
  Ok(system::stats(ptys.terminals(), ptys.daemon_pid(), &system::webkit_pids(&app), &keep))
}

/// Listening TCP ports for the status bar's Ports popup.
#[tauri::command]
async fn system_ports(ptys: State<'_, pty::Ptys>) -> Result<Vec<system::Port>, String> {
  let daemon = ptys.daemon_pid();
  blocking(move || system::ports(daemon)).await
}

/// Stops a process Kingu started (Resource Manager / Ports "Stop Process").
#[tauri::command]
fn system_kill(ptys: State<'_, pty::Ptys>, pid: u32) -> Result<(), String> {
  system::kill(pid, ptys.daemon_pid())
}

/// Opens `http://localhost:<port>` in the default browser.
#[tauri::command]
fn open_local_url(url: String) -> Result<(), String> {
  system::open_local_url(&url)
}

/// Keeps the Mac awake (display and idle sleep) while on, like Orca's ☕ toggle.
#[tauri::command]
fn keep_awake_set(keep: State<'_, system::KeepAwake>, on: bool) -> Result<bool, String> {
  keep.set(on)
}

/// Webview errors and milestones, so they show up in the app log (WKWebView has no CDP).
/// Bounded per line; the log's formatter masks anything that looks like a credential.
#[tauri::command]
fn client_log(level: String, message: String) {
  const MAX: usize = 4000;
  let message = if message.chars().count() > MAX { format!("{}… (cut)", message.chars().take(MAX).collect::<String>()) } else { message };
  match level.as_str() {
    "error" => log::error!("[webview] {message}"),
    "warning" | "warn" => log::warn!("[webview] {message}"),
    "debug" => log::debug!("[webview] {message}"),
    "trace" => log::trace!("[webview] {message}"),
    _ => log::info!("[webview] {message}"),
  }
}

const MAX_OPEN_BYTES: u64 = 5 * 1024 * 1024;

#[tauri::command]
fn read_workspace_file(ws: Workspace, rel: String) -> Result<String, String> {
  // A file of an open repository above a root folder too (Source Control's diff of it).
  let path = ws.resolve_with_repos(&rel)?;
  let len = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
  if len > MAX_OPEN_BYTES {
    return Err(format!("{rel}: larger than {MAX_OPEN_BYTES} bytes"));
  }
  std::fs::read_to_string(&path).map_err(|e| format!("{rel}: {e}"))
}

/// An image of the workspace as a `data:` URL, for the editor's image viewer.
#[tauri::command]
async fn fs_read_data_url(ws: Workspace, rel: String) -> Result<String, String> {
  let path = ws.resolve(&rel)?;
  blocking(move || fs::image_data_url(&path, 4 * MAX_OPEN_BYTES).map_err(|e| format!("{rel}: {e}"))).await
}

/// Opens a file for a text editor: decoded with its encoding, or a binary / too-large answer the
/// editor shows as a placeholder (VS Code's text file service read).
#[tauri::command]
async fn textfile_read(ws: Workspace, rel: String, options: textfile::ReadOptions) -> Result<textfile::ReadResult, String> {
  let path = ws.resolve_with_repos(&rel)?;
  blocking(move || textfile::read(&path, &options).map_err(|e| format!("{rel}: {e}"))).await
}

/// Saves a text editor with its encoding. With `expected` (what the editor loaded or last saved)
/// a file that changed on disk since is not overwritten: the result is a conflict.
#[tauri::command]
async fn textfile_write(
  ws: Workspace,
  rel: String,
  content: String,
  encoding: String,
  expected: Option<textfile::Expected>,
) -> Result<textfile::WriteResult, String> {
  let (root, inner) = ws.locate_with_repos(&rel)?;
  let path = textfile::resolve_for_write(&root, &inner)?;
  blocking(move || {
    let result = textfile::write(&path, &content, &encoding, expected.as_ref()).map_err(|e| format!("{rel}: {e}"))?;
    if matches!(result, textfile::WriteResult::Saved { .. }) {
      log::info!("saved {rel} ({encoding})");
    }
    Ok(result)
  })
  .await
}

#[tauri::command]
fn fs_list_dir(ws: Workspace, rel: String) -> Result<Vec<fs::DirEntry>, String> {
  let (root, inner) = ws.locate(&rel)?;
  let dir = if inner.is_empty() { root.clone() } else { resolve_in(&root, &inner)? };
  let mut entries = fs::list_dir(&root, &dir)?;
  git::mark_ignored(&dir, &mut entries);
  // Another root folder's entries carry absolute paths (see workspace.rs).
  for e in &mut entries {
    e.rel = ws.qualify(&root, &e.rel);
  }
  Ok(entries)
}

const QUICK_OPEN_LIMIT: usize = 20_000;

#[tauri::command]
async fn fs_list_files(ws: Workspace) -> Result<Vec<String>, String> {
  let roots = ws.roots();
  tauri::async_runtime::spawn_blocking(move || {
    let mut out = Vec::new();
    for root in &roots {
      let left = QUICK_OPEN_LIMIT.saturating_sub(out.len());
      if left == 0 {
        break;
      }
      out.extend(fs::list_files(root, left).into_iter().map(|rel| workspace::qualify_in(&roots, root, &rel)));
    }
    out
  })
  .await
  .map_err(|e| e.to_string())
}

/// Saves over an existing workspace file (the prototype has no "new file" yet).
#[tauri::command]
fn fs_write_file(ws: Workspace, rel: String, content: String) -> Result<(), String> {
  let path = ws.resolve(&rel)?;
  if !path.is_file() {
    return Err(format!("{rel}: not a file"));
  }
  std::fs::write(&path, content).map_err(|e| format!("{rel}: {e}"))?;
  log::info!("saved {rel}");
  Ok(())
}

/// Current branch for the status bar; `None` outside a git repository.
#[tauri::command]
fn git_branch(ws: Workspace, repo: Option<String>) -> Option<String> {
  let out = std::process::Command::new("git")
    .args(["rev-parse", "--abbrev-ref", "HEAD"])
    .current_dir(git_repos::repo_or_root(&ws, repo.as_deref()).ok()?)
    .output()
    .ok()?;
  out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Paths from the webview, each checked to stay inside the workspace (they may be deleted files).
fn checked(root: &Path, paths: Vec<String>) -> Result<Vec<String>, String> {
  for p in &paths {
    git::check_rel(root, p)?;
  }
  Ok(paths)
}

/// The repository a Source Control command acts on: the open folder, or a task's worktree
/// (`slug`), so the Agents layout's right side bar works for whichever worktree is selected.
fn git_dir(ws: &Workspace, slug: Option<&str>, repo: Option<&str>) -> Result<PathBuf, String> {
  repo_dir(ws, slug.filter(|s| !s.is_empty()), repo)
}

/// Runs a git operation off the main thread (status can take a while in a large repository).
pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// The repository a Source Control command acts on: `repo` (one of a multi-root workspace's
/// repositories, git_repos.rs), else the first folder, or the task worktree `slug` (the ADE's
/// right side bar works on the selected worktree).
fn repo_dir(ws: &Workspace, slug: Option<&str>, repo: Option<&str>) -> Result<PathBuf, String> {
  match slug {
    Some(s) => agent::review::task_dir(&ws.root()?, s),
    None => git_repos::repo_or_root(ws, repo),
  }
}

/// Source Control view: branch, ahead/behind and changed files; `None` outside a repository.
#[tauri::command]
async fn git_status(ws: Workspace, slug: Option<String>, options: Option<git::StatusOptions>, repo: Option<String>) -> Result<Option<git::GitStatus>, String> {
  if slug.is_none() && ws.current().is_none() {
    return Ok(None);
  }
  let dir = repo_dir(&ws, slug.as_deref(), repo.as_deref())?;
  blocking(move || git::status_with(&dir, &options.unwrap_or_default())).await
}

#[tauri::command]
async fn git_stage(ws: Workspace, paths: Vec<String>, slug: Option<String>, repo: Option<String>) -> Result<(), String> {
  let dir = repo_dir(&ws, slug.as_deref(), repo.as_deref())?;
  let paths = checked(&dir, paths)?;
  blocking(move || git::stage(&dir, &paths)).await
}

#[tauri::command]
async fn git_unstage(ws: Workspace, paths: Vec<String>, slug: Option<String>, repo: Option<String>) -> Result<(), String> {
  let dir = repo_dir(&ws, slug.as_deref(), repo.as_deref())?;
  let paths = checked(&dir, paths)?;
  blocking(move || git::unstage(&dir, &paths)).await
}

/// Deleting untracked files needs `delete_untracked`, set only after the user confirmed;
/// `to_trash` (git.discardUntrackedChangesToTrash) moves them to the trash instead.
#[tauri::command]
async fn git_discard(ws: Workspace, paths: Vec<String>, delete_untracked: Option<bool>, to_trash: Option<bool>, slug: Option<String>, repo: Option<String>) -> Result<(), String> {
  let dir = repo_dir(&ws, slug.as_deref(), repo.as_deref())?;
  let paths = checked(&dir, paths)?;
  blocking(move || git::discard(&dir, &paths, delete_untracked.unwrap_or(false), to_trash.unwrap_or(false))).await
}

/// `options` carries the commit flags of VS Code's git settings (sign-off, signing) and commands
/// (Commit (No Verify), Commit Empty); `amend` is kept for older callers.
#[tauri::command]
async fn git_commit(ws: Workspace, message: String, amend: Option<bool>, options: Option<git::CommitOptions>, slug: Option<String>, repo: Option<String>) -> Result<(), String> {
  let dir = repo_dir(&ws, slug.as_deref(), repo.as_deref())?;
  let mut opts = options.unwrap_or_default();
  opts.amend |= amend.unwrap_or(false);
  blocking(move || git::commit(&dir, &message, &opts)).await?;
  log::info!("committed{}", slug.map(|s| format!(" in task {s}")).unwrap_or_default());
  Ok(())
}

/// `git.path` changed in the user settings: Rust re-reads it from the file itself (it picks the
/// program git commands run, so the webview never passes the path).
#[tauri::command]
fn git_reload_path(app: AppHandle) -> Result<(), String> {
  git::load_git_path(&app.path().app_config_dir().map_err(|e| e.to_string())?);
  Ok(())
}

/// Whether git runs (`git.ignoreMissingGitWarning`): its version, `None` when it cannot run, and
/// whether a folder of the window has a `.git` (VS Code warns only then).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitProbe {
  version: Option<String>,
  has_repository: bool,
}

#[tauri::command]
async fn git_probe(ws: Workspace) -> Result<GitProbe, String> {
  let roots = ws.roots();
  blocking(move || Ok(GitProbe { version: git::version(), has_repository: roots.iter().any(|f| f.join(".git").exists()) })).await
}

/// `git.requireGitUserConfig`: whether `user.name` and `user.email` are configured.
#[tauri::command]
async fn git_user_configured(ws: Workspace, slug: Option<String>, repo: Option<String>) -> Result<bool, String> {
  let dir = repo_dir(&ws, slug.as_deref(), repo.as_deref())?;
  blocking(move || Ok(git::user_configured(&dir))).await
}

/// Usage limits of one agent provider for the status bar: `claude`, `codex`, `gemini`, or one of
/// Orca's others (`usage::fetch_more`), which read `options` (their non-secret settings).
#[tauri::command]
async fn usage_fetch(provider: String, options: Option<usage::Options>) -> Result<usage::ProviderUsage, String> {
  blocking(move || match provider.as_str() {
    "claude" => Ok(usage::fetch_claude()),
    "codex" => Ok(usage::fetch_codex()),
    "gemini" => Ok(usage::fetch_gemini()),
    other => usage::fetch_more(other, &options.unwrap_or_default()).ok_or_else(|| crate::tr!(crate::i18n::msg::UsageMsg::UnknownProvider, provider = other)),
  })
  .await
}

/// Which usage-provider credentials (`usage::secrets::IDS`) are saved; never their values.
#[tauri::command]
async fn usage_secret_status() -> Result<BTreeMap<String, bool>, String> {
  use accounts::secrets::SecretStore;
  blocking(|| Ok(usage::secrets::IDS.iter().map(|(id, _)| ((*id).to_owned(), usage::secrets::UsageKeychain.get(id).is_some())).collect())).await
}

/// Saves a pasted usage-provider credential in the Keychain; an empty value removes it.
#[tauri::command]
async fn usage_secret_set(id: String, value: String) -> Result<(), String> {
  use accounts::secrets::SecretStore;
  if !usage::secrets::known(&id) {
    return Err(crate::tr!(crate::i18n::msg::UsageMsg::UnknownSecret, id = id));
  }
  blocking(move || match usage::secrets::clean(&value) {
    Some(v) => usage::secrets::UsageKeychain.set(&id, &v),
    None => usage::secrets::UsageKeychain.delete(&id),
  })
  .await
}

/// Agent CLIs installed on this computer.
#[tauri::command]
async fn usage_detect() -> Result<Vec<String>, String> {
  blocking(|| Ok(usage::detect())).await
}

/// Floating workspace notes: a new `Untitled.md` in the app-owned folder, then read and save.
#[tauri::command]
fn floating_note_new(app: AppHandle) -> Result<String, String> {
  let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
  Ok(floating::new_note(&data)?.display().to_string())
}

#[tauri::command]
fn floating_note_read(path: String) -> Result<String, String> {
  floating::read_note(&path)
}

#[tauri::command]
fn floating_note_write(path: String, text: String) -> Result<(), String> {
  floating::write_note(&path, &text)
}

/// The app-owned floating workspace folder (where Open Markdown starts).
#[tauri::command]
fn floating_dir(app: AppHandle) -> Result<String, String> {
  let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
  Ok(floating::app_dir(&data)?.display().to_string())
}

/// Lines added and deleted per changed file (`git diff --numstat`), unstaged and staged.
#[tauri::command]
async fn git_numstat(ws: Workspace, slug: Option<String>, repo: Option<String>) -> Result<git::NumStat, String> {
  let root = git_dir(&ws, slug.as_deref(), repo.as_deref())?;
  blocking(move || git::numstat(&root)).await
}

#[tauri::command]
/// Force push with lease (the ADE's Source Control menu); a plain push is `git_remote::git_push`.
async fn git_force_push(ws: Workspace, slug: Option<String>, repo: Option<String>) -> Result<(), String> {
  let root = git_dir(&ws, slug.as_deref(), repo.as_deref())?;
  blocking(move || git::push(&root, true)).await
}

#[tauri::command]
/// Fast-forward only (the ADE's Source Control menu); a plain pull is `git_remote::git_pull`.
async fn git_pull_ff_only(ws: Workspace, slug: Option<String>, repo: Option<String>) -> Result<(), String> {
  let root = git_dir(&ws, slug.as_deref(), repo.as_deref())?;
  blocking(move || git::pull(&root, true)).await
}

#[tauri::command]
async fn git_rebase(ws: Workspace, slug: Option<String>, base: String, repo: Option<String>) -> Result<(), String> {
  let root = git_dir(&ws, slug.as_deref(), repo.as_deref())?;
  blocking(move || git::rebase(&root, &base)).await
}

/// The Commits panel of Source Control.
#[tauri::command]
async fn git_log(ws: Workspace, slug: Option<String>, limit: Option<u32>, repo: Option<String>) -> Result<Vec<git::Commit>, String> {
  let root = git_dir(&ws, slug.as_deref(), repo.as_deref())?;
  blocking(move || git::log(&root, limit.unwrap_or(50))).await
}

#[tauri::command]
fn open_web_url(url: String) -> Result<(), String> {
  system::open_web_url(&url)
}

/// Files a commit changed (`git show --name-status`), for the Commits panel.
#[tauri::command]
async fn git_show_files(ws: Workspace, slug: Option<String>, hash: String, repo: Option<String>) -> Result<Vec<(String, String)>, String> {
  let root = git_dir(&ws, slug.as_deref(), repo.as_deref())?;
  git::check_rev(&hash)?;
  blocking(move || {
    let out = git::run(&root, &["show", "--name-status", "--format=", "--end-of-options", &hash])?;
    Ok(String::from_utf8_lossy(&out).lines().filter_map(|l| l.split_once('\t')).map(|(s, p)| (s.chars().next().unwrap_or('M').to_string(), p.rsplit('\t').next().unwrap_or(p).to_owned())).collect())
  })
  .await
}

/// Commits ahead of and behind `base` (Change Base Ref's compare).
#[tauri::command]
async fn git_compare(ws: Workspace, slug: Option<String>, base: String, repo: Option<String>) -> Result<(u32, u32), String> {
  let root = git_dir(&ws, slug.as_deref(), repo.as_deref())?;
  git::check_rev(&base)?;
  blocking(move || {
    let out = git::run(&root, &["rev-list", "--left-right", "--count", &format!("{base}...HEAD")])?;
    let text = String::from_utf8_lossy(&out);
    let mut n = text.split_whitespace().map(|x| x.parse::<u32>().unwrap_or(0));
    let (behind, ahead) = (n.next().unwrap_or(0), n.next().unwrap_or(0));
    Ok((ahead, behind))
  })
  .await
}

/// Local and remote branch names, for the base ref picker.
#[tauri::command]
async fn git_ref_names(ws: Workspace, slug: Option<String>, repo: Option<String>) -> Result<Vec<String>, String> {
  let root = git_dir(&ws, slug.as_deref(), repo.as_deref())?;
  blocking(move || {
    let out = git::run(&root, &["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"])?;
    Ok(String::from_utf8_lossy(&out).lines().filter(|l| !l.is_empty() && !l.ends_with("/HEAD")).map(str::to_owned).collect())
  })
  .await
}

/// Claude Code sessions run in the open folder or its worktrees (Agents tab).
#[tauri::command]
async fn claude_sessions(ws: Workspace, limit: Option<usize>) -> Result<Vec<sessions::Session>, String> {
  let root = ws.root()?;
  blocking(move || Ok(sessions::list(&root, limit.unwrap_or(250)))).await
}

/// Moves a Claude Code session transcript of this folder to the Trash (Agents tab › Delete).
#[tauri::command]
async fn delete_claude_session(ws: Workspace, path: String) -> Result<(), String> {
  let root = ws.root()?;
  let p = std::path::PathBuf::from(&path);
  let home = std::env::var_os("HOME").map(std::path::PathBuf::from).ok_or("no home folder")?;
  let projects = home.join(".claude").join("projects");
  let dir = p.parent().and_then(|d| d.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
  let prefix = sessions::encode(&root);
  let plain = p.components().all(|c| matches!(c, std::path::Component::RootDir | std::path::Component::Normal(_)));
  let ours = plain && p.starts_with(&projects) && p.extension().and_then(|e| e.to_str()) == Some("jsonl") && (dir == prefix || dir.starts_with(&format!("{prefix}-")));
  if !ours {
    return Err("Only sessions of this folder can be deleted.".into());
  }
  blocking(move || trash::delete(&p).map_err(|e| e.to_string())).await
}

/// Aborts the merge, rebase, cherry-pick or revert in progress (Source Control's conflict card).
#[tauri::command]
async fn git_abort(ws: Workspace, slug: Option<String>, repo: Option<String>) -> Result<git::Operation, String> {
  let root = git_dir(&ws, slug.as_deref(), repo.as_deref())?;
  blocking(move || git::abort_operation(&root)).await
}

/// Continues the merge, rebase, cherry-pick or revert once its conflicts are resolved and staged.
#[tauri::command]
async fn git_continue(ws: Workspace, slug: Option<String>, repo: Option<String>) -> Result<git::Operation, String> {
  let root = git_dir(&ws, slug.as_deref(), repo.as_deref())?;
  blocking(move || git::continue_operation(&root)).await
}

/// HEAD version of a file for the diff editor; empty when the file is not in HEAD.
#[tauri::command]
async fn git_show_head(ws: Workspace, rel: String) -> Result<String, String> {
  let (root, rel) = git_repos::locate_file(&ws, &rel)?;
  blocking(move || git::show_head(&root, &rel)).await
}

/// Terminal session `key`: re-attaches to its live shell (`run` is not typed again), else starts one.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
fn pty_spawn(
  app: AppHandle,
  ws: Workspace,
  ptys: State<'_, pty::Ptys>,
  accounts: State<'_, accounts::Accounts>,
  key: String,
  cols: u16,
  rows: u16,
  on_data: Channel<String>,
  slug: Option<String>,
  run: Option<Vec<String>>,
  terminal: Option<TerminalSettings>,
  cwd_from: Option<String>,
  floating_cwd: Option<String>,
  task: Option<tasks::TaskLaunch>,
  folder: Option<String>,
  reported_cwd: Option<String>,
) -> Result<kingu_ptyd::Attached, String> {
  pty::validate_key(&key)?;
  // `folder`: the root folder of a multi-root window the terminal belongs to (the user's pick, or
  // a split's source); absent, the first folder. It must be inside one of the window's roots.
  let folder = pty::terminal_folder(&ws.roots(), folder.as_deref())?;
  // A task terminal (tasks.rs) is a panel terminal running the task instead of a shell.
  if task.is_some() && !key.starts_with("panel:") {
    return Err(format!("terminal {key}: tasks run in panel terminals"));
  }
  // A split pane starts where its source pane's shell is now (VS Code's splitCwd "inherited",
  // Orca's resolve-split-cwd), else where a new terminal would.
  // terminal.integrated.splitCwd picks which directory (inherited, the source's initial one, or the root).
  let split_mode = terminal.as_ref().and_then(|t| t.split_cwd.clone()).unwrap_or_else(|| "inherited".into());
  // `reported_cwd`: the source's directory as its shell integration reported it (OSC 633 P;Cwd), else the process's.
  let reported = reported_cwd.map(PathBuf::from).filter(|d| d.is_absolute() && d.is_dir());
  let inherited = cwd_from.as_deref().and_then(|from| pty::split_cwd(&split_mode, || reported.or_else(|| ptys.live_cwd(from)), || ptys.initial_cwd(from), folder.clone()));
  // A task terminal starts in the task's worktree (the ADE's per-worktree terminals); a floating
  // workspace terminal in its own directory setting. No folder open: the terminal starts in the
  // home folder, like VS Code's empty window.
  let cwd = match (inherited, slug.clone()) {
    (Some(dir), _) => dir,
    (None, _) if floating_cwd.is_some() => {
      let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
      floating::terminal_cwd(floating_cwd.as_deref().unwrap_or("~"), &data)?
    }
    (None, Some(slug)) => {
      agent::worktree::validate_slug(&slug)?;
      let dir = agent::worktree::worktree_path(&ws.root()?, &slug);
      if !dir.is_dir() {
        return Err(crate::tr!(crate::i18n::msg::CoreMsg::NoTaskWorktree, slug));
      }
      dir
    }
    (None, None) => {
      let folder = folder.clone();
      let fallback = folder.clone().or_else(|| std::env::var_os("HOME").map(PathBuf::from)).unwrap_or_else(|| PathBuf::from("/"));
      pty::terminal_cwd(terminal.as_ref().and_then(|t| t.cwd.as_deref()), folder.as_deref(), fallback)
    }
  };
  let terminal = terminal.unwrap_or_default();
  // Only an agent CLI's terminal (`cli:` keys) gets the active AI account's env, never an
  // ordinary terminal, so an API key does not leak into every shell.
  // terminal.integrated.env.*: a `null` value removes the variable.
  let (mut env, mut unset) = pty::split_env(terminal.env);
  // terminal.integrated.inheritEnv / detectLocale.
  let clean_env = terminal.inherit_env == Some(false);
  let current_lang = env.get("LANG").cloned().or_else(|| if clean_env || unset.iter().any(|k| k == "LANG") { None } else { std::env::var("LANG").ok() });
  if let Some(lang) = pty::lang_env(terminal.detect_locale.as_deref().unwrap_or("auto"), current_lang.as_deref(), terminal.locale.as_deref()) {
    env.insert("LANG".into(), lang);
  }
  if let Some(program) = run.as_deref().and_then(agent::cli::program_of)
    && key.starts_with("cli:")
  {
    env.extend(accounts::env_for_program(&accounts, program)?);
  }
  // http.proxy for agent CLIs (they call model APIs), unless terminal.integrated.env sets or unsets it.
  if key.starts_with("cli:") {
    for (k, v) in net_proxy::env() {
      if !env.contains_key(&k) && !unset.contains(&k) {
        env.insert(k, v);
      }
    }
  }
  // terminal.integrated.defaultProfile.*: the profile's path (a name looked up on PATH, or a list
  // tried in turn, like VS Code), else the legacy terminal.integrated.shell.* (an absolute path).
  let profile_shell = if terminal.paths.is_empty() {
    None
  } else {
    let found = pty::resolve_shell(&terminal.paths, shell_env::path().as_deref())
      .ok_or_else(|| crate::tr!(crate::i18n::msg::CoreMsg::ProfileShellMissing, paths = terminal.paths.join(", ")))?;
    Some(found.to_string_lossy().into_owned())
  };
  let shell = profile_shell.as_deref().or(terminal.shell.as_deref()).filter(|s| !s.trim().is_empty());
  // A task: its folder and env, and /bin/sh running the task wrapper with the task's argv.
  let (cwd, task_args) = match &task {
    Some(t) => {
      env.extend(t.env.iter().map(|(k, v)| (k.clone(), v.clone())));
      let default_shell = shell.map(str::to_owned).or_else(|| std::env::var("SHELL").ok().filter(|s| !s.is_empty())).unwrap_or_else(|| "/bin/zsh".into());
      (tasks::task_cwd(t, cwd)?, Some(tasks::wrapper_args(t, &default_shell)?))
    }
    None => (cwd, None),
  };
  let (shell, shell_args) = match &task_args {
    Some(args) => (Some(tasks::POSIX_SHELL), Some(args.as_slice())),
    None => (shell, terminal.args.as_deref()),
  };
  let run = if task.is_some() { None } else { run };
  // kingu.terminal.scopeHistoryByWorktree (ADE terminals): history of their own per worktree.
  if terminal.scope_history && !key.starts_with("cli:") {
    let scope = match slug.as_deref() {
      Some(s) => agent::worktree::worktree_path(&ws.root()?, s),
      None => folder.clone().unwrap_or_else(|| cwd.clone()),
    };
    let program = shell.map(str::to_owned).or_else(|| std::env::var("SHELL").ok()).unwrap_or_default();
    let history = app.path().app_data_dir().map_err(|e| e.to_string())?.join("terminal-history");
    match pty::scoped_history_env(&program, &history, &scope) {
      Ok(vars) => env.extend(vars),
      Err(e) => log::warn!("terminal history: {e}"),
    }
  }
  // Every terminal of a task's worktree gets its own status hook file, so an agent CLI started by
  // hand in any pane reports its state (status_hooks.rs; inert for every other program).
  let pane_hooks = key.starts_with("ade:") && slug.is_some() && !env.contains_key("KINGU_AGENT_HOOK_FILE") && !unset.iter().any(|k| k == "KINGU_AGENT_HOOK_FILE");
  if pane_hooks {
    match agent::hooks::pane_file(&app, &key).and_then(|f| agent::hooks::quotable_path(&f).map(str::to_owned)) {
      Ok(file) => {
        env.insert("KINGU_AGENT_HOOK_FILE".into(), file);
      }
      Err(e) => log::warn!("terminal {key}: no agent status file ({e})"),
    }
  }
  // terminal.integrated.shellIntegration.enabled: Kingu's scripts for zsh, bash, fish and pwsh
  // (shell_integration.rs), not for a task or an agent CLI's terminal.
  let mut injected_args: Option<Vec<String>> = None;
  if terminal.shell_integration && task.is_none() && !key.starts_with("cli:") {
    let program = shell.map(str::to_owned).or_else(|| std::env::var("SHELL").ok().filter(|s| !s.is_empty())).unwrap_or_else(|| "/bin/zsh".into());
    let inherited = |k: &str| if clean_env || unset.iter().any(|u| u == k) { None } else { std::env::var(k).ok() };
    let user_zdotdir = env.get("ZDOTDIR").cloned().or_else(|| inherited("ZDOTDIR"));
    let home = env.get("HOME").cloned().or_else(|| std::env::var("HOME").ok());
    let scripts = app.path().app_data_dir().map_err(|e| e.to_string()).and_then(|d| shell_integration::ensure_scripts(&d).map_err(|e| e.to_string()));
    match scripts {
      Ok(dir) => {
        if let Some(inj) = shell_integration::injection(&program, shell_args, &dir, user_zdotdir.as_deref(), home.as_deref()) {
          // A `null` in terminal.integrated.env must not remove what the injection needs.
          unset.retain(|u| !inj.env.iter().any(|(k, _)| k == u));
          env.extend(inj.env);
          injected_args = Some(inj.args);
        }
      }
      Err(e) => log::warn!("terminal {key}: no shell integration ({e})"),
    }
  }
  let shell_args = injected_args.as_deref().or(shell_args);
  // The `kingu` command on PATH (cli_server.rs).
  cli_server::terminal_env(&mut env, &unset);
  let attached = ptys.open(&key, &cwd, cols, rows, run.as_deref(), &env, shell, shell_args, &unset, clean_env, pty::channel_sink(on_data))?;
  ptys.own(&key, ws.label());
  if attached.spawned && pane_hooks {
    agent::hooks::pane_file_reset(&app, &key);
  }
  if attached.spawned {
    log::info!("terminal {key} started ({cols}x{rows})");
  } else {
    log::info!("terminal {key} re-attached ({cols}x{rows})");
  }
  Ok(attached)
}

/// `terminal.integrated.*` for a new shell, read by the webview from the user's settings
/// (they are user-only, so a folder's workspace settings cannot pick the program that runs).
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct TerminalSettings {
  shell: Option<String>,
  /// The default profile's `path` candidates (terminal.integrated.profiles.*); they win over `shell`.
  paths: Vec<String>,
  args: Option<Vec<String>>,
  /// `terminal.integrated.env.*`: `null` removes a variable.
  env: BTreeMap<String, Option<String>>,
  cwd: Option<String>,
  /// `kingu.terminal.scopeHistoryByWorktree` for an ADE terminal.
  #[serde(rename = "scopeHistory")]
  scope_history: bool,
  /// `terminal.integrated.inheritEnv`.
  inherit_env: Option<bool>,
  /// `terminal.integrated.detectLocale` and the UI locale it uses.
  detect_locale: Option<String>,
  locale: Option<String>,
  /// `terminal.integrated.splitCwd`.
  split_cwd: Option<String>,
  /// `terminal.integrated.shellIntegration.enabled`.
  shell_integration: bool,
}

/// `files.watcherExclude`.
#[tauri::command]
fn watcher_set_exclude(ws: Workspace, globs: Vec<String>) {
  ws.set_watch_exclude(&globs);
}

/// `files.watcherInclude`.
#[tauri::command]
fn watcher_set_include(ws: Workspace, paths: Vec<String>) {
  ws.set_watch_include(&paths);
}

#[tauri::command]
fn worktree_create(
  ws: Workspace,
  slug: String,
  base: Option<String>,
  prefix: Option<String>,
  branch: Option<String>,
) -> Result<agent::worktree::WorktreeInfo, String> {
  agent::worktree::create_named(&ws.root()?, &slug, base.as_deref(), prefix.as_deref(), branch.as_deref())
}

/// Before a task forks from `base`: fast-forward it from its upstream when safe
/// (`kingu.worktree.refreshBaseOnCreate`); returns what happened, for the status bar.
#[tauri::command]
async fn worktree_refresh_base(ws: Workspace, base: String) -> Result<Option<String>, String> {
  let root = ws.root()?;
  tauri::async_runtime::spawn_blocking(move || agent::worktree::refresh_base(&root, &base, std::time::Duration::from_secs(30)))
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn worktree_list(ws: Workspace, projects: State<'_, projects::Projects>, root: Option<String>) -> Result<Vec<agent::worktree::WorktreeInfo>, String> {
  // No folder open: no tasks to list (not an error in the Agent panel). `root`: another added
  // project's worktrees, for the side bar.
  projects::root_arg(&ws, &projects, root)?.map_or(Ok(Vec::new()), |root| agent::worktree::list(&root))
}

/// `delete_branch`: `keep` (default), `safe` (`git branch -d`) or `force`; returns the branch a
/// safe delete kept because it is not merged. Off the main thread: deleting a big worktree
/// (node_modules) takes a while, and the window must keep working meanwhile.
#[tauri::command]
async fn worktree_remove(
  ws: Workspace,
  slug: String,
  force: Option<bool>,
  delete_branch: Option<String>,
) -> Result<Option<String>, String> {
  let branch = agent::worktree::DeleteBranch::parse(delete_branch.as_deref())?;
  let root = ws.root()?;
  tauri::async_runtime::spawn_blocking(move || agent::worktree::remove(&root, &slug, force.unwrap_or(false), branch))
    .await
    .map_err(|e| e.to_string())?
}

/// Find in Files: streams ripgrep matches per file; a new search cancels the previous one.
#[tauri::command]
fn search_text(ws: Workspace, options: search::SearchOptions, on_event: Channel<search::SearchEvent>) -> Result<u32, String> {
  let searches = &ws.state().searches;
  if options.query.is_empty() {
    searches.cancel();
    return Err("query is empty".into());
  }
  let rg = search::find_rg(std::env::var_os("KINGU_RG"), shell_env::path())?;
  searches.start_roots(&rg, search_roots(&ws, search::for_workspace(options))?, move |ev| on_event.send(ev).is_ok())
}

/// Every root folder to search, with the options for it: a multi-root `./name/` pattern in
/// "files to include" searches only that folder (VS Code's multi-root search). Results from a
/// root other than the first come back with absolute paths.
fn search_roots(ws: &Workspace, options: search::SearchOptions) -> Result<Vec<search::Root>, String> {
  ws.root()?;
  let folders = ws.folders();
  let names: Vec<String> = folders.iter().map(workspace::Folder::label).collect();
  let includes = if folders.len() > 1 { search::split_include(&options.include, &names) } else { vec![Some(options.include.clone())] };
  let roots: Vec<PathBuf> = folders.iter().map(|f| f.path.clone()).collect();
  Ok(
    folders
      .iter()
      .zip(includes)
      .filter_map(|(f, include)| {
        let include = include?;
        let prefix = workspace::qualify_in(&roots, &f.path, "");
        let prefix = if prefix.is_empty() { prefix } else { format!("{prefix}/") };
        Some(search::Root { dir: f.path.clone(), prefix, options: search::SearchOptions { include, ..options.clone() } })
      })
      .collect(),
  )
}

/// Search: Replace. Rewrites the matches of the last search (refusing files changed since) and
/// returns edits for files the webview has open, which it applies to their editor models.
#[tauri::command]
async fn search_replace(ws: Workspace, request: replace::ReplaceRequest) -> Result<Vec<replace::FileResult>, String> {
  ws.root()?;
  let results = blocking(move || replace::replace_all_in(|path| ws.locate(path).map(|(root, _)| root), &request)).await?;
  let written: usize = results.iter().filter(|r| r.outcome == replace::Outcome::Written).map(|r| r.replaced).sum();
  log::info!("search_replace: {written} replacements written in {} files", results.len());
  Ok(results)
}

/// The ADE's right side bar (Files › Contents): its own ripgrep slot (per window), so it never
/// cancels the IDE's Find in Files, run in the selected worktree so that worktree's ignore files apply.
#[tauri::command]
fn worktree_search(
  ws: Workspace,
  slug: Option<String>,
  options: search::SearchOptions,
  on_event: Channel<search::SearchEvent>,
) -> Result<u32, String> {
  let searches = &ws.state().worktree_searches;
  if options.query.is_empty() {
    searches.cancel();
    return Err("query is empty".into());
  }
  let dir = repo_dir(&ws, slug.as_deref(), None)?;
  let rg = search::find_rg(std::env::var_os("KINGU_RG"), shell_env::path())?;
  searches.start(&rg, &dir, &options, move |ev| on_event.send(ev).is_ok())
}

#[tauri::command]
fn worktree_search_cancel(ws: Workspace) {
  ws.state().worktree_searches.cancel();
}

/// The Search Editor (`search.action.openNewEditor`): its own ripgrep slot (per window), so it
/// never cancels the Search view's search. `options.context_lines` is always set, so files carry
/// whole lines.
#[tauri::command]
fn search_editor_text(ws: Workspace, mut options: search::SearchOptions, on_event: Channel<search::SearchEvent>) -> Result<u32, String> {
  let searches = &ws.state().editor_searches;
  if options.query.is_empty() {
    searches.cancel();
    return Err("query is empty".into());
  }
  options.context_lines.get_or_insert(0);
  let rg = search::find_rg(std::env::var_os("KINGU_RG"), shell_env::path())?;
  searches.start_roots(&rg, search_roots(&ws, search::for_workspace(options))?, move |ev| on_event.send(ev).is_ok())
}

#[tauri::command]
fn search_editor_cancel(ws: Workspace) {
  ws.state().editor_searches.cancel();
}

#[tauri::command]
fn search_cancel(ws: Workspace) {
  ws.state().searches.cancel();
}

/// Starts the language server for `language` in the workspace; server messages stream over `on_event`.
#[tauri::command]
fn lsp_start(
  ws: Workspace,
  servers: State<'_, lsp::Servers>,
  language: String,
  folder: Option<String>,
  on_event: Channel<lsp::LspEvent>,
) -> Result<u32, String> {
  // `folder`: the root folder a server is started for on its own (one that cannot be told about
  // several folders); absent, the first. It runs there, and a project-local binary is looked for
  // in that folder's node_modules first, then in every other folder's.
  let roots = ws.roots();
  let cwd = match folder.as_deref() {
    Some(f) => roots.iter().find(|r| r.as_path() == Path::new(f)).cloned().ok_or_else(|| crate::tr!(crate::i18n::msg::FilesMsg::OutsideWorkspace, path = f))?,
    None => ws.root()?,
  };
  let id = lsp::start_for(&servers, &cwd, &lsp::roots_from(&cwd, &roots), &language, on_event)?;
  servers.own(id, ws.label());
  Ok(id)
}

/// Whether the server for `language` can be started now (re-resolved on every call, so a server
/// installed meanwhile is found): its path, or the "Not installed: …" error.
#[tauri::command]
fn lsp_check(ws: Workspace, language: String) -> Result<String, String> {
  ws.root()?;
  lsp::check(&language, &ws.roots()).map(|p| p.to_string_lossy().into_owned())
}

/// Install commands for the server of `language` that this machine's tools can run.
#[tauri::command]
fn lsp_install_methods(ws: Workspace, language: String) -> Result<lsp::InstallInfo, String> {
  ws.root()?;
  lsp::install_info(&language, &ws.roots())
}

// ---------------------------------------------------------------------------------------------
// Debugging (VS Code: debug adapters from extensions; Kingu: lldb-dap, dlv dap, debugpy)

/// Starts the debug adapter for a launch.json `type`; adapter messages stream over `on_event`.
/// `python` is the configuration's interpreter, preferred for debugpy.
#[tauri::command]
fn dap_start(
  ws: Workspace,
  sessions: State<'_, dap::Sessions>,
  debug_type: String,
  python: Option<String>,
  on_event: Channel<dap::DapEvent>,
) -> Result<u32, String> {
  let id = dap::start_for(&sessions, &ws.root()?, &debug_type, python.as_deref().map(Path::new), on_event)?;
  sessions.own(id, ws.label());
  Ok(id)
}

/// The adapter program for `debug_type`, or the "Not installed: …" error (re-resolved every call).
#[tauri::command]
async fn dap_check(ws: Workspace, debug_type: String, python: Option<String>) -> Result<String, String> {
  let root = ws.root()?;
  blocking(move || dap::check(&debug_type, python.as_deref().map(Path::new), &root).map(|(_, r)| r.program.to_string_lossy().into_owned())).await
}

#[tauri::command]
fn dap_install_methods(ws: Workspace, debug_type: String) -> Result<lsp::InstallInfo, String> {
  dap::install_info(&debug_type, &ws.root()?)
}

/// `${env:NAME}` in launch.json: the named variables of the environment debuggees get.
#[tauri::command]
fn debug_env(names: Vec<String>) -> std::collections::HashMap<String, String> {
  shell_env::vars_os()
    .into_iter()
    .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
    .filter(|(k, _)| names.contains(k))
    .collect()
}

/// A build step before a launch (e.g. `cargo build`), run in the workspace root and awaited.
#[tauri::command]
async fn debug_build(ws: Workspace, argv: Vec<String>) -> Result<dap::BuildResult, String> {
  let root = ws.root()?;
  blocking(move || dap::run_build(&argv, &root)).await
}

/// A child session of debug session `parent` (js-debug's `startDebugging`): another connection to
/// the same adapter server.
#[tauri::command]
fn dap_start_child(sessions: State<'_, dap::Sessions>, parent: u32, on_event: Channel<dap::DapEvent>) -> Result<u32, String> {
  let id = dap::start_child_for(&sessions, parent, on_event)?;
  if let Some(owner) = sessions.owner(parent) {
    sessions.own(id, &owner);
  }
  Ok(id)
}

/// js-debug's pinned release and whether it (and node) are installed.
#[tauri::command]
fn dap_js_debug_status(ws: Workspace) -> dap::JsDebugStatus {
  dap::js_debug_status(&ws.root().unwrap_or_default())
}

/// Downloads the pinned js-debug, checks its SHA-256 and unpacks it (only when the user asked in
/// Run and Debug). Returns the path of `dapDebugServer.js`.
#[tauri::command]
async fn dap_js_debug_install() -> Result<String, String> {
  blocking(|| dap::install_js_debug(dap::download_js_debug).map(|p| p.to_string_lossy().into_owned())).await
}

/// Processes for `${command:pickProcess}`.
#[tauri::command]
async fn debug_processes() -> Result<Vec<dap::ProcessEntry>, String> {
  blocking(dap::list_processes).await
}

// ---------------------------------------------------------------------------------------------
// Testing (VS Code: the Test Explorer; Kingu drives cargo, bun, vitest, jest, go and pytest)

/// A test listing command (`cargo test -- --list`, `go test -list .`, `pytest --collect-only -q`)
/// in the workspace (or `cwd`, relative to it), awaited.
#[tauri::command]
async fn testing_collect(ws: Workspace, argv: Vec<String>, cwd: Option<String>) -> Result<dap::BuildResult, String> {
  let root = ws.root()?;
  let dir = match cwd.filter(|c| !c.is_empty() && c != ".") {
    Some(rel) => resolve_in(&root, &rel)?,
    None => root,
  };
  blocking(move || testing::collect(&argv, &dir)).await
}

/// A fresh path for a jest/vitest JSON report.
#[tauri::command]
fn testing_report_new() -> Result<String, String> {
  testing::new_report(&testing::report_dir())
}

/// The report written to a path from `testing_report_new` (read once), or null.
#[tauri::command]
fn testing_report_take(path: String) -> Result<Option<String>, String> {
  testing::take_report(&testing::report_dir(), &path)
}

/// A fresh directory for a run with coverage that writes `lcov.info` (bun, jest, vitest).
#[tauri::command]
fn testing_coverage_new() -> Result<String, String> {
  testing::new_coverage_dir(&testing::report_dir())
}

/// The `lcov.info` written into a directory from `testing_coverage_new` (read once), or null.
#[tauri::command]
fn testing_coverage_take(path: String) -> Result<Option<String>, String> {
  testing::take_coverage(&testing::report_dir(), &path)
}

// ---------------------------------------------------------------------------------------------
// Open Recent (VS Code: File: Open Recent); opening folders and windows is in windows.rs

/// Recently opened folders, most recent first.
#[tauri::command]
fn workspace_recent(recent: State<'_, Recent>) -> Vec<String> {
  recent.data().folders.iter().map(|f| f.display().to_string()).collect()
}

#[tauri::command]
fn workspace_recent_remove(recent: State<'_, Recent>, path: String) -> Result<(), String> {
  recent.remove(Path::new(&path))
}

#[tauri::command]
fn workspace_recent_clear(recent: State<'_, Recent>) -> Result<(), String> {
  recent.clear()
}

// ---------------------------------------------------------------------------------------------
// Explorer file operations

#[tauri::command]
fn fs_create_file(ws: Workspace, rel: String) -> Result<(), String> {
  let (root, inner) = ws.locate(&rel)?;
  fileops::create_file(&root, &inner)?;
  log::info!("created {rel}");
  Ok(())
}

#[tauri::command]
fn fs_create_dir(ws: Workspace, rel: String) -> Result<(), String> {
  let (root, inner) = ws.locate(&rel)?;
  fileops::create_dir(&root, &inner)?;
  log::info!("created folder {rel}");
  Ok(())
}

#[tauri::command]
fn fs_rename(ws: Workspace, from: String, to: String) -> Result<(), String> {
  let ((root, a), (to_root, b)) = (ws.locate(&from)?, ws.locate(&to)?);
  if root != to_root {
    // Across root folders: a move into the destination's folder under the new name.
    let dir = b.rsplit_once('/').map_or("", |(d, _)| d).to_string();
    let name = b.rsplit_once('/').map_or(b.as_str(), |(_, n)| n).to_string();
    let source = resolve_in(&root, &a)?;
    let moved = fileops::import(&to_root, std::slice::from_ref(&source), &dir, fileops::Naming::Disabled)?;
    let moved_to = moved.first().cloned().unwrap_or_default();
    if moved_to.rsplit('/').next() != Some(name.as_str()) {
      fileops::rename(&to_root, &moved_to, &b)?;
    }
    fileops::delete_for_good(&root, &a)?;
    log::info!("moved {from} to {to}");
    return Ok(());
  }
  fileops::rename(&root, &a, &b)?;
  log::info!("renamed {from} to {to}");
  Ok(())
}

/// Where deleted entries are kept for the explorer's undo (cleared at every launch).
fn undo_stash(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join("file-undo"))
}

/// Moves to the Trash, or deletes for good when `use_trash` is false (`files.enableTrash`); the
/// webview confirms first. A trashed entry returns the token that undoes it with `fs_restore`
/// (`None` when it was too large to keep a copy of); a delete for good keeps no copy.
#[tauri::command]
async fn fs_delete(ws: Workspace, app: AppHandle, rel: String, use_trash: Option<bool>) -> Result<Option<String>, String> {
  let (root, r) = ws.locate(&rel)?;
  let token = if use_trash.unwrap_or(true) {
    let stash = undo_stash(&app)?;
    let token = blocking(move || fileops::trash_with_undo(&root, &r, &stash)).await?;
    log::info!("moved to the Trash: {rel}");
    token
  } else {
    blocking(move || fileops::delete_for_good(&root, &r)).await?;
    log::info!("deleted {rel}");
    None
  };
  Ok(token)
}

/// Undoes `fs_delete`: puts the kept copy back at `rel`.
#[tauri::command]
async fn fs_restore(ws: Workspace, app: AppHandle, rel: String, token: String) -> Result<(), String> {
  let (root, r) = ws.locate(&rel)?;
  let stash = undo_stash(&app)?;
  blocking(move || fileops::restore(&root, &r, &token, &stash)).await?;
  log::info!("restored {rel}");
  Ok(())
}

#[tauri::command]
fn fs_reveal(ws: Workspace, rel: String) -> Result<(), String> {
  let (root, inner) = ws.locate(&rel)?;
  fileops::reveal(&root, &inner)
}

/// Paste / ⌥-drag: copies `from` into the folder `to_dir`; returns the new path (`a copy.ts` on a clash).
#[tauri::command]
async fn fs_copy(ws: Workspace, from: String, to_dir: String, naming: Option<fileops::Naming>) -> Result<String, String> {
  let ((root, a), (to_root, dir)) = (ws.locate(&from)?, ws.locate(&to_dir)?);
  let naming = naming.unwrap_or_default();
  let target = to_root.clone();
  let rel = blocking(move || {
    if root == to_root {
      fileops::copy(&root, &a, &dir, naming)
    } else {
      // Into another root folder: a copy from outside it, like a drop from Finder.
      let source = resolve_in(&root, &a)?;
      fileops::import(&to_root, &[source], &dir, naming).map(|r| r.into_iter().next().unwrap_or_default())
    }
  })
  .await?;
  log::info!("copied to {rel}");
  Ok(ws.qualify(&target, &rel))
}

/// Cut/paste and drag and drop: moves `from` into the folder `to_dir`; returns the new path.
#[tauri::command]
fn fs_move(ws: Workspace, from: String, to_dir: String) -> Result<String, String> {
  let ((root, a), (to_root, dir)) = (ws.locate(&from)?, ws.locate(&to_dir)?);
  let rel = if root == to_root {
    fileops::move_into(&root, &a, &dir)?
  } else {
    let source = resolve_in(&root, &a)?;
    let moved = fileops::import(&to_root, &[source], &dir, fileops::Naming::Disabled)?.into_iter().next().unwrap_or_default();
    fileops::delete_for_good(&root, &a)?;
    moved
  };
  let rel = ws.qualify(&to_root, &rel);
  log::info!("moved {from} to {rel}");
  Ok(rel)
}

/// Files dropped on the window from Finder. Only these may be imported, so the webview cannot
/// copy an arbitrary file from outside the workspace into it.
#[derive(Default)]
struct DroppedPaths(std::sync::Mutex<Vec<PathBuf>>);

/// External drop (Finder → Explorer): copies the dropped `paths` into the folder `to_dir`.
#[tauri::command]
async fn fs_import(
  ws: Workspace,
  dropped: State<'_, DroppedPaths>,
  paths: Vec<String>,
  to_dir: String,
  naming: Option<fileops::Naming>,
) -> Result<Vec<String>, String> {
  let (root, to_dir) = ws.locate(&to_dir)?;
  let allowed = dropped.0.lock().map_err(|e| e.to_string())?.clone();
  let sources: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
  if let Some(bad) = sources.iter().find(|p| !allowed.contains(p)) {
    return Err(format!("{}: not a dropped file", bad.display()));
  }
  let target = root.clone();
  let rels = blocking(move || fileops::import(&root, &sources, &to_dir, naming.unwrap_or_default())).await?;
  log::info!("imported {} dropped item(s)", rels.len());
  Ok(rels.iter().map(|r| ws.qualify(&target, r)).collect())
}

#[derive(serde::Serialize)]
struct SavedAs {
  /// Workspace-relative path, or None when the user saved outside the open folder.
  rel: Option<String>,
  path: String,
}

/// Save As (and the first save of an untitled editor): the native save dialog, then the write.
/// The dialog runs here so the webview never names a path outside the workspace itself.
#[tauri::command]
async fn fs_save_as(
  app: AppHandle,
  window: tauri::WebviewWindow,
  ws: Workspace,
  content: String,
  name: String,
  dir: Option<String>,
  default_path: Option<String>,
) -> Result<Option<SavedAs>, String> {
  use tauri_plugin_dialog::DialogExt;
  let root = ws.current();
  let start = match (&root, dir) {
    (Some(r), Some(d)) => ws.resolve(&d).unwrap_or_else(|_| r.clone()),
    (Some(r), None) => r.clone(),
    (None, _) => external::dialog_home(&app, default_path.as_deref())?,
  };
  let handle = app.clone();
  let picked = tauri::async_runtime::spawn_blocking(move || handle.dialog().file().set_parent(&window).set_directory(start).set_file_name(name).blocking_save_file())
    .await
    .map_err(|e| e.to_string())?;
  let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
  std::fs::write(&path, content).map_err(|e| format!("{}: {e}", path.display()))?;
  log::info!("saved as {}", path.display());
  let real = path.canonicalize().unwrap_or_else(|_| path.clone());
  let rel = root.and(ws.locate(&real.display().to_string()).ok()).map(|(r, inner)| ws.qualify(&r, &inner));
  // Saved outside the folder: the editor goes on with it as an external file (external.rs).
  if rel.is_none() {
    app.state::<external::ExternalFiles>().allow(&real);
  }
  Ok(Some(SavedAs { rel, path: path.display().to_string() }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_notification::init())
    .manage(Workspaces::default())
    .manage(window::CloseGuard::default())
    .manage(pty::Ptys::default())
    .manage(system::KeepAwake::default())
    .manage(Arc::new(agent::AgentHost::default()))
    .manage(Arc::new(agent::chat_edits::ChatEdits::default()))
    .manage(Arc::new(vault::Vault::default()))
    .manage(Arc::new(local_ai::completions::Completions::default()))
    .manage(Arc::new(local_ai::semantic::Semantic::default()))
    .manage(lsp::Servers::default())
    .manage(dap::Sessions::default())
    .manage(git_remote::GitOps::default())
    .manage(git_remote::CloneOps::default())
    .manage(menu::MenuState::default())
    .manage(DroppedPaths::default())
    .manage(artifacts::preview::Previews::default())
    .manage(voice::Voice::default())
    // Artifact previews (artifacts/preview.rs): served only to the sandboxed preview iframe.
    .register_uri_scheme_protocol(artifacts::preview::SCHEME, artifacts::preview::handle)
    .setup(|app| {
      let config_dir = app.path().app_config_dir()?;
      // application.shellEnvironmentResolutionTimeout (user settings only: it is read before any folder opens).
      shell_env::init(shell_env::resolution_timeout(
        settings::user_value(&config_dir, "application.shellEnvironmentResolutionTimeout").as_ref(),
      ));
      net_proxy::init(&config_dir);
      app.manage(settings::ConfigWatcher::default());
      if let Err(e) = settings::watch_config(app.handle(), &config_dir) {
        log::warn!("settings watcher: {e}");
      }
      system::set_config_dir(config_dir);
      // Release builds too: a rotating, size-limited Kingu.log in the app log dir (logging.rs).
      app.handle().plugin(logging::plugin())?;
      log::set_max_level(logging::DEFAULT_LEVEL);
      // The last session's windows (window.restoreWindows), else KINGU_WORKSPACE, else the welcome view.
      let recent = Recent::load(app.path().app_data_dir()?.join("recent.json"));
      let restore = settings::user_value(&app.path().app_config_dir()?, "window.restoreWindows");
      let last_session = recent.data();
      app.manage(recent);
      app.manage(projects::Projects::load(app.path().app_data_dir()?.join("projects.json")));
      app.manage(external::ExternalFiles::load(app.path().app_data_dir()?.join("external-files.json")));
      app.manage(Arc::new(local_history::LocalHistory::new(app.path().app_data_dir()?.join("History"))));
      let data = app.path().app_data_dir()?;
      dap::set_adapters_dir(data.join("debug-adapters"));
      #[cfg(unix)]
      let (runtime, uid) = (
        std::env::var_os("XDG_RUNTIME_DIR").filter(|_| cfg!(target_os = "linux")).map(PathBuf::from),
        kingu_ptyd::peer::own_uid(),
      );
      #[cfg(not(unix))]
      let (runtime, uid) = (None, 0);
      pty::Ptys::init(app.handle(), pty::daemon_dir(&data, runtime, &std::env::temp_dir(), uid));
      team::install(app)?;
      accounts::install(app)?;
      cli_server::install(app)?;
      git::load_git_path(&app.path().app_config_dir()?);
      // A git operation waiting for another one in the same repository (status bar).
      let queue_events = app.handle().clone();
      git_queue::set_notifier(move |e| {
        let _ = queue_events.emit("git-queue", e);
      });
      menu::install(app.handle());
      // The explorer's undo history lives in the webview, so last run's undo copies are orphans.
      if let Ok(stash) = undo_stash(app.handle()) {
        std::thread::spawn(move || {
          let _ = std::fs::remove_dir_all(stash);
        });
      }
      // Folders and files Kingu was launched with (`kingu open <path>` when it was not running).
      let cwd = std::env::current_dir().unwrap_or_default();
      let launch = startup::launch_args(std::env::args_os().skip(1), &cwd);
      windows::restore(app.handle(), restore.as_ref().and_then(|v| v.as_str()), &last_session, &launch);
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      app_info,
      i18n::app_set_locale,
      system_stats,
      fs_read_data_url,
      system_ports,
      system_kill,
      open_local_url,
      keep_awake_set,
      client_log,
      read_workspace_file,
      textfile_read,
      textfile_write,
      backup::backup_write,
      backup::backup_list,
      backup::backup_read,
      backup::backup_discard,
      fs_list_dir,
      fs_list_files,
      fs_write_file,
      fs_create_file,
      fs_create_dir,
      fs_rename,
      fs_delete,
      fs_restore,
      fs_reveal,
      fs_copy,
      fs_move,
      fs_import,
      fs_save_as,
      external::external_pick_files,
      external::external_recent,
      external::external_forget,
      external::external_clear,
      external::external_textfile_read,
      external::external_textfile_write,
      external::workspace_file_read,
      user_profiles::profiles_list,
      user_profiles::profile_create,
      user_profiles::profile_switch,
      user_profiles::profile_rename,
      user_profiles::profile_delete,
      user_profiles::profile_export,
      user_profiles::profile_import_preview,
      user_profiles::profile_import,
      windows::workspace_state,
      windows::workspace_folders,
      windows::workspace_open,
      windows::workspace_open_folders,
      windows::workspace_close,
      windows::workspace_add_folders,
      windows::workspace_remove_folder,
      windows::workspace_set_file,
      windows::window_new,
      windows::window_focus_folder,
      windows::window_count,
      windows::workspace_storage_stale,
      window::window_close,
      window::window_close_cancelled,
      snippets::snippets_user_list,
      snippets::snippets_user_read,
      snippets::snippets_user_write,
      workspace_recent,
      workspace_recent_remove,
      workspace_recent_clear,
      git_branch,
      git_repos::git_repositories,
      git_status,
      git_stage,
      git_unstage,
      git_discard,
      git_commit,
      git_reload_path,
      git_probe,
      git_user_configured,
      git_numstat,
      git_force_push,
      git_pull_ff_only,
      git_rebase,
      git_log,
      open_web_url,
      agent::forge::forge_pr_action,
      agent::forge::forge_pr_edit_title,
      agent::forge::forge_pr_comments,
      agent::forge::forge_pr_comment,
      agent::forge::forge_check_log,
      git_show_files,
      git_compare,
      git_ref_names,
      claude_sessions,
      vault::vault_list,
      vault::vault_search,
      vault::vault_transcript,
      vault::vault_stats,
      agent::forge::forge_pr_create,
      agent::forge::forge_review_threads,
      agent::forge::forge_reply_thread,
      agent::forge::forge_react,
      delete_claude_session,
      git_abort,
      git_continue,
      usage_fetch,
      usage_detect,
      usage_secret_status,
      usage_secret_set,
      voice::voice_status,
      voice::voice_set_openai_key,
      voice::voice_clear_openai_key,
      voice::voice_transcribe,
      floating_note_new,
      floating_note_read,
      floating_note_write,
      floating_dir,
      git_show_head,
      git_editor::scm_show_index,
      git_editor::scm_show_stage,
      git_editor::scm_stage_patch,
      git_editor::scm_blame,
      git_editor::scm_file_log,
      git_editor::scm_commit_info,
      git_remote::git_fetch,
      git_remote::git_pull,
      git_remote::git_push,
      git_remote::git_sync,
      git_remote::git_cancel,
      git_remote::git_refs,
      git_remote::git_checkout,
      git_remote::git_create_branch,
      git_remote::git_delete_branch,
      git_remote::git_stash_push,
      git_remote::git_stash_list,
      git_remote::git_stash_apply,
      git_remote::git_stash_drop,
      git_remote::git_clone,
      git_remote::git_clone_cancel,
      git_graph::scm_graph_log,
      git_graph::scm_changed_files,
      git_graph::scm_diff_range,
      git_graph::scm_merge_base,
      git_ops::git_merge_branch,
      git_ops::git_rebase_branch,
      git_ops::git_cherry_pick,
      git_ops::git_checkout_detached,
      git_ops::git_tag_create,
      git_ops::git_tag_delete,
      git_ops::git_tags_push,
      git_ops::git_undo_commit,
      git_ops::git_ignore_paths,
      git_ops::git_remote_list,
      git_ops::git_remote_add,
      git_ops::git_remote_remove,
      git_ops::git_remote_rename,
      git_ops::git_stash_show,
      git_ops::git_stash_diff,
      git_ops::git_stash_clear,
      git_ops::git_commit_editmsg_prepare,
      git_ops::git_commit_editmsg_read,
      git_ops::scm_worktree_list,
      git_ops::scm_worktree_add,
      git_ops::scm_worktree_remove,
      project::git_init,
      project::project_create,
      projects::projects_list,
      projects::projects_add,
      projects::projects_remove,
      pty_spawn,
      pty::pty_write,
      pty::pty_resize,
      pty::pty_kill,
      pty::pty_attach,
      pty::pty_list,
      pty::pty_backend,
      pty::pty_foreground,
      terminal_links::terminal_link_target,
      shell_integration::terminal_shell_history,
      terminal_links::terminal_open_url,
      worktree_create,
      worktree_refresh_base,
      worktree_list,
      worktree_remove,
      agent::worktree_from::worktree_create_from_branch,
      agent::worktree_from::worktree_create_from_pr,
      agent::worktree_from::worktree_rename_branch,
      agent::worktree_from::gh_pr_lookup,
      agent::worktree_from::gh_pr_list,
      agent::agent_start,
      notify::agent_notify,
      notify::app_badge,
      dialog::message_box,
      attachments::paste_image_save,
      attachments::chat_attachment_preview,
      agent::trust::agent_trust_workspace,
      agent::codex_server::codex_supports_no_daemon,
      agent::codex_server::codex_shared_server_joined,
      agent::mcp::mcp_list,
      agent::mcp::mcp_trust,
      agent::mcp::mcp_user_read,
      agent::mcp::mcp_user_write,
      agent::mcp::mcp_add_server,
      agent::mcp::mcp_remove_server,
      agent::status_hooks::agent_status_hooks_install,
      agent::status_hooks::agent_status_hooks_remove,
      agent::hooks::agent_hook_settings,
      agent::hooks::agent_hook_file,
      agent::cli::agent_cli_found,
      agent::runtimes::agent_runtimes,
      agent::arkai::arkai_providers,
      agent::arkai::arkai_set_key,
      agent::arkai::arkai_delete_key,
      agent::hooks::agent_hook_read,
      agent::hooks::agent_hook_clear,
      agent::hooks::agent_pane_hook_read,
      agent::hooks::agent_pane_hook_clear,
      agent::agent_send,
      agent::agent_answer_permission,
      agent::agent_interrupt,
      agent::agent_stop,
      agent::agent_set_options,
      agent::chats_load,
      agent::slash_commands::chat_slash_commands,
      agent::chats_save,
      agent::chat_transcript_load,
      agent::chat_transcript_delete,
      agent::chat_context_git_diff,
      agent::chat_export,
      agent::chat_import,
      agent::chat_edits_list,
      agent::chat_edits_original,
      agent::chat_edits_keep,
      agent::chat_edits_undo,
      agent::chat_edits_restore,
      agent::chat_edits_hunks,
      agent::chat_edits_hunk,
      agent::rules::chat_rules,
      agent::customizations::chat_customizations,
      agent::customizations::chat_prompt_file,
      agent::chat_rewind,
      agent::chat_rewind_redo,
      agent::chat_fork,
      agent::tasks_load,
      agent::tasks_save,
      agent::tasks_update,
      agent::diff_notes_load,
      agent::diff_notes_save,
      agent::worktree_commits,
      agent::automations_load,
      agent::automations_save,
      agent::git_branches,
      agent::worktree_diff_stat,
      agent::worktree_diff_text,
      agent::git_diff_text,
      agent::worktree_reject,
      agent::worktree_hunks,
      agent::worktree_reject_hunks,
      agent::worktree_commit,
      agent::worktree_merge,
      agent::worktree_list_files,
      agent::git_show_ref,
      agent::gh_status,
      agent::worktree_pr_create,
      agent::worktree_pr,
      agent::worktree_pr_merge,
      agent::gh_merge_settings,
      agent::worktree_pr_check_logs,
      agent::worktree_pr_threads,
      agent::gh_resolve_thread,
      agent::scripts::worktree_script,
      agent::open_in::worktree_open_in,
      agent::ai_text::ai_commit_context,
      agent::ai_text::ai_pr_context,
      agent::ai_text::ai_generate,
      agent::ai_text::ai_chat_title,
      agent::chat_extras::ai_chat_followups,
      agent::chat_extras::chat_feedback,
      agent::chat_extras::memories_list,
      agent::chat_extras::memory_add,
      agent::chat_extras::memory_change,
      agent::chat_extras::chat_chime,
      agent::ai_text::ai_pr_template,
      agent::ai_text::git_base_upstream,
      agent::scripts::worktree_script_trust,
      tasks::tasks_file,
      tasks::tasks_trust,
      tasks::tasks_workspace_file,
      tasks::tasks_workspace_trust,
      agent::scripts::worktree_script_prepare,
      agent::scripts::worktree_setup_marker,
      agent::scripts::worktree_setup_status,
      agent::scripts::worktree_link_shared,
      agent::kingu_yaml::kingu_yaml,
      agent::scripts::worktree_archive_run,
      agent::gh_issues_list,
      agent::gh_issue_view,
      agent::gh_issue_comment,
      agent::gh_issue_open,
      artifacts::artifacts_list,
      artifacts::artifact_get,
      artifacts::artifact_read_entry,
      artifacts::artifact_delete,
      artifacts::artifact_export,
      artifacts::preview::artifact_preview,
      artifacts::preview::artifact_preview_html,
      artifacts::preview::artifact_preview_close,
      artifacts::team::artifact_share_team,
      artifacts::team::team_artifacts_list,
      artifacts::team::team_artifact_get,
      artifacts::team::team_artifact_delete,
      cli_server::cli_reply,
      cli_server::cli_install,
      cli_server::cli_uninstall,
      cli_server::cli_skill_plugin,
      linear::linear_status,
      linear::linear_connect,
      linear::linear_disconnect,
      linear::linear_issues_list,
      linear::linear_issue_view,
      linear::linear_issue_comment,
      linear::linear_issue_open,
      gitlab::gitlab_status,
      gitlab::gitlab_connect,
      gitlab::gitlab_disconnect,
      gitlab::gitlab_issues_list,
      gitlab::gitlab_issue_view,
      gitlab::gitlab_issue_comment,
      gitlab::gitlab_issue_open,
      jira::jira_status,
      jira::jira_connect,
      jira::jira_disconnect,
      jira::jira_issues_list,
      jira::jira_issue_view,
      jira::jira_issue_comment,
      jira::jira_issue_open,
      agent::gh_projects::gh_projects_list,
      agent::gh_projects::gh_project_items,
      agent::gh_projects::gh_project_issue_view,
      agent::gh_projects::gh_project_issue_comment,
      agent::gh_projects::gh_project_issue_open,
      search_text,
      search_cancel,
      search_editor_text,
      search_editor_cancel,
      worktree_search,
      worktree_search_cancel,
      search_replace,
      local_history::local_history_add,
      local_history::local_history_list,
      local_history::local_history_read,
      local_history::local_history_rename,
      local_history::local_history_delete,
      local_history::local_history_delete_all,
      local_history::local_history_restore,
      local_history::local_history_move,
      local_history::local_history_files,
      local_ai::local_ai_complete,
      local_ai::local_ai_cancel,
      local_ai::semantic_index,
      local_ai::semantic_status,
      local_ai::semantic_search,
      local_ai::semantic_clear,
      lsp_start,
      lsp_check,
      lsp_install_methods,
      lsp::lsp_send,
      lsp::lsp_stop,
      dap_start,
      dap_check,
      dap_install_methods,
      debug_build,
      debug_env,
      dap::dap_send,
      dap_start_child,
      dap_js_debug_status,
      dap_js_debug_install,
      debug_processes,
      testing_collect,
      testing_report_new,
      testing_report_take,
      testing_coverage_new,
      testing_coverage_take,
      dap::dap_stop,
      settings::settings_read,
      settings::settings_read_folder,
      settings::settings_write,
      watcher_set_exclude,
      watcher_set_include,
      window::window_close_guard,
      window::window_close_confirmed,
      snap::snap_list,
      snap::snap_trust,
      snap::snap_skill_plugins,
      snap_sandbox::snap_sandbox_info,
      snap_install::snap_install_git,
      snap_install::snap_install_folder,
      snap_install::snap_update_prepare,
      snap_install::snap_install_commit,
      snap_install::snap_install_cancel,
      snap_install::snap_uninstall,
      snap_install::snap_new,
      snap_install::snap_lock,
      snap_install::snap_reveal,
      skill_hub::skill_hub_list,
      skill_hub::skill_hub_set_enabled,
      skill_hub::skill_hub_prepare,
      skill_hub::skill_hub_prepare_update,
      skill_hub::skill_hub_commit,
      skill_hub::skill_hub_cancel,
      skill_hub::skill_hub_remove,
      skill_hub::skill_hub_reveal,
      skill_hub::skill_hub_read,
      skill_hub::skill_hub_export,
      skill_hub::skill_hub_plugins,
      skill_hub::skill_hub_check_updates,
      snap_install::snap_manifest_read,
      snap_install::snap_manifest_write,
      accounts::ai_accounts_list,
      accounts::ai_account_add,
      accounts::ai_account_set_key,
      accounts::ai_account_remove,
      accounts::ai_account_set_active,
      accounts::ai_account_login_command,
      accounts::ai_usage_get,
      accounts::ai_usage_refresh,
      accounts::ai_usage_history,
      team::team_sign_in,
      team::team_sign_out,
      team::team_status,
      team::team_sync_task,
      team::team_sync_run,
      logging::open_logs_folder,
      logging::app_log_tail,
      logging::app_set_log_level,
      git_output::git_output_since,
      team::team_sync_now,
      team::team_events_start,
      team::team_events_stop,
      team::snaps::team_snap_catalog,
      team::snaps::team_snap_approve,
      team::snaps::snap_install_team,
      team::skills::team_skill_list,
      team::skills::team_skill_share,
      team::skills::team_skill_unshare,
      team::skills::team_skill_install,
      menu::menu_set_model,
      menu::menu_set_checked,
      menu::menu_set_enabled,
      menu::window_titlebar_double_click,
      menu::app_quit
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      if let tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }), .. } = &event
        && let Ok(mut dropped) = app.state::<DroppedPaths>().0.lock()
      {
        *dropped = paths.clone();
      }
      // Closing a window or a user quit (⌘Q) waits for the page while it has something to ask.
      if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { api, .. }, .. } = &event
        && window::on_close_requested(app, label)
      {
        api.prevent_close();
      }
      if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Focused(true), .. } = &event {
        app.state::<Workspaces>().focused(label);
        menu::window_focused(app, label);
        windows::save_windows(app);
      }
      // Each window's place on screen, for window.restoreWindows.
      if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_), .. } = &event {
        windows::on_moved(app, label);
      }
      if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } = &event {
        windows::on_destroyed(app, label);
      }
      if let tauri::RunEvent::ExitRequested { code, api, .. } = &event {
        if code.is_none() && window::on_exit_requested(app) {
          api.prevent_exit();
        } else {
          app.state::<window::CloseGuard>().start_quit();
        }
      }
      if let tauri::RunEvent::Exit = event {
        app.state::<lsp::Servers>().stop_all();
        app.state::<dap::Sessions>().stop_all();
        app.state::<Arc<agent::AgentHost>>().shutdown();
      }
    });
}
