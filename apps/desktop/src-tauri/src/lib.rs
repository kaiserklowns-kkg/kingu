mod agent;
mod fileops;
mod floating;
mod fs;
mod git;
mod lsp;
mod menu;
mod pty;
mod replace;
mod search;
mod sessions;
mod settings;
mod shell_env;
mod snap;
mod system;
mod team;
mod usage;
mod watcher;
mod workspace;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use workspace::{Recent, Workspace, resolve_in};

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
fn app_info(ws: State<'_, Workspace>) -> AppInfo {
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
async fn system_stats(ptys: State<'_, pty::Ptys>, keep: State<'_, system::KeepAwake>) -> Result<system::Stats, String> {
  Ok(system::stats(ptys.list(), &keep))
}

/// Listening TCP ports for the status bar's Ports popup.
#[tauri::command]
async fn system_ports() -> Result<Vec<system::Port>, String> {
  blocking(system::ports).await
}

/// Stops a process Kingu started (Resource Manager / Ports "Stop Process").
#[tauri::command]
fn system_kill(pid: u32) -> Result<(), String> {
  system::kill(pid)
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
#[tauri::command]
fn client_log(level: String, message: String) {
  match level.as_str() {
    "error" => log::error!("[webview] {message}"),
    _ => log::info!("[webview] {message}"),
  }
}

const MAX_OPEN_BYTES: u64 = 5 * 1024 * 1024;

#[tauri::command]
fn read_workspace_file(ws: State<'_, Workspace>, rel: String) -> Result<String, String> {
  let path = resolve_in(&ws.root()?, &rel)?;
  let len = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
  if len > MAX_OPEN_BYTES {
    return Err(format!("{rel}: larger than {MAX_OPEN_BYTES} bytes"));
  }
  std::fs::read_to_string(&path).map_err(|e| format!("{rel}: {e}"))
}

/// An image of the workspace as a `data:` URL, for the editor's image viewer.
#[tauri::command]
async fn fs_read_data_url(ws: State<'_, Workspace>, rel: String) -> Result<String, String> {
  let path = resolve_in(&ws.root()?, &rel)?;
  blocking(move || fs::image_data_url(&path, 4 * MAX_OPEN_BYTES).map_err(|e| format!("{rel}: {e}"))).await
}

#[tauri::command]
fn fs_list_dir(ws: State<'_, Workspace>, rel: String) -> Result<Vec<fs::DirEntry>, String> {
  let root = ws.root()?;
  let dir = if rel.is_empty() { root.clone() } else { resolve_in(&root, &rel)? };
  let mut entries = fs::list_dir(&root, &dir)?;
  git::mark_ignored(&dir, &mut entries);
  Ok(entries)
}

const QUICK_OPEN_LIMIT: usize = 20_000;

#[tauri::command]
async fn fs_list_files(ws: State<'_, Workspace>) -> Result<Vec<String>, String> {
  let Some(root) = ws.current() else { return Ok(Vec::new()) };
  tauri::async_runtime::spawn_blocking(move || fs::list_files(&root, QUICK_OPEN_LIMIT))
    .await
    .map_err(|e| e.to_string())
}

/// Saves over an existing workspace file (the prototype has no "new file" yet).
#[tauri::command]
fn fs_write_file(ws: State<'_, Workspace>, rel: String, content: String) -> Result<(), String> {
  let path = resolve_in(&ws.root()?, &rel)?;
  if !path.is_file() {
    return Err(format!("{rel}: not a file"));
  }
  std::fs::write(&path, content).map_err(|e| format!("{rel}: {e}"))?;
  log::info!("saved {rel}");
  Ok(())
}

/// Current branch for the status bar; `None` outside a git repository.
#[tauri::command]
fn git_branch(ws: State<'_, Workspace>) -> Option<String> {
  let out = std::process::Command::new("git")
    .args(["rev-parse", "--abbrev-ref", "HEAD"])
    .current_dir(ws.current()?)
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
fn git_dir(ws: &Workspace, slug: Option<&str>) -> Result<PathBuf, String> {
  let root = ws.root()?;
  match slug {
    None | Some("") => Ok(root),
    Some(slug) => {
      agent::worktree::validate_slug(slug)?;
      let dir = agent::worktree::worktree_path(&root, slug);
      if dir.is_dir() { Ok(dir) } else { Err(format!("ไม่พบ worktree ของงาน {slug}")) }
    }
  }
}

/// Runs a git operation off the main thread (status can take a while in a large repository).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Source Control view: branch, ahead/behind and changed files; `None` outside a repository.
#[tauri::command]
async fn git_status(ws: State<'_, Workspace>, slug: Option<String>) -> Result<Option<git::GitStatus>, String> {
  if ws.current().is_none() {
    return Ok(None);
  }
  let root = git_dir(&ws, slug.as_deref())?;
  blocking(move || git::status(&root)).await
}

#[tauri::command]
async fn git_stage(ws: State<'_, Workspace>, paths: Vec<String>, slug: Option<String>) -> Result<(), String> {
  let root = git_dir(&ws, slug.as_deref())?;
  let paths = checked(&root, paths)?;
  blocking(move || git::stage(&root, &paths)).await
}

#[tauri::command]
async fn git_unstage(ws: State<'_, Workspace>, paths: Vec<String>, slug: Option<String>) -> Result<(), String> {
  let root = git_dir(&ws, slug.as_deref())?;
  let paths = checked(&root, paths)?;
  blocking(move || git::unstage(&root, &paths)).await
}

/// Deleting untracked files needs `delete_untracked`, set only after the user confirmed.
#[tauri::command]
async fn git_discard(ws: State<'_, Workspace>, paths: Vec<String>, delete_untracked: Option<bool>, slug: Option<String>) -> Result<(), String> {
  let root = git_dir(&ws, slug.as_deref())?;
  let paths = checked(&root, paths)?;
  blocking(move || git::discard(&root, &paths, delete_untracked.unwrap_or(false))).await
}

#[tauri::command]
async fn git_commit(ws: State<'_, Workspace>, message: String, amend: Option<bool>, slug: Option<String>) -> Result<(), String> {
  let root = git_dir(&ws, slug.as_deref())?;
  blocking(move || git::commit(&root, &message, amend.unwrap_or(false))).await?;
  log::info!("committed");
  Ok(())
}

#[tauri::command]
async fn git_checkout(ws: State<'_, Workspace>, branch: String) -> Result<(), String> {
  let root = ws.root()?;
  blocking(move || git::checkout(&root, &branch)).await
}

#[tauri::command]
async fn git_sync(ws: State<'_, Workspace>, slug: Option<String>) -> Result<(), String> {
  let root = git_dir(&ws, slug.as_deref())?;
  blocking(move || git::sync(&root)).await
}

/// Usage limits of one agent provider (`claude` or `codex`) for the status bar.
#[tauri::command]
async fn usage_fetch(provider: String) -> Result<usage::ProviderUsage, String> {
  blocking(move || match provider.as_str() {
    "claude" => Ok(usage::fetch_claude()),
    "codex" => Ok(usage::fetch_codex()),
    other => Err(format!("{other}: unknown provider")),
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
async fn git_numstat(ws: State<'_, Workspace>, slug: Option<String>) -> Result<git::NumStat, String> {
  let root = git_dir(&ws, slug.as_deref())?;
  blocking(move || git::numstat(&root)).await
}

#[tauri::command]
async fn git_push(ws: State<'_, Workspace>, slug: Option<String>, force: Option<bool>) -> Result<(), String> {
  let root = git_dir(&ws, slug.as_deref())?;
  blocking(move || git::push(&root, force.unwrap_or(false))).await
}

#[tauri::command]
async fn git_pull(ws: State<'_, Workspace>, slug: Option<String>, ff_only: Option<bool>) -> Result<(), String> {
  let root = git_dir(&ws, slug.as_deref())?;
  blocking(move || git::pull(&root, ff_only.unwrap_or(false))).await
}

#[tauri::command]
async fn git_fetch(ws: State<'_, Workspace>, slug: Option<String>) -> Result<(), String> {
  let root = git_dir(&ws, slug.as_deref())?;
  blocking(move || git::fetch(&root)).await
}

#[tauri::command]
async fn git_rebase(ws: State<'_, Workspace>, slug: Option<String>, base: String) -> Result<(), String> {
  let root = git_dir(&ws, slug.as_deref())?;
  blocking(move || git::rebase(&root, &base)).await
}

/// The Commits panel of Source Control.
#[tauri::command]
async fn git_log(ws: State<'_, Workspace>, slug: Option<String>, limit: Option<u32>) -> Result<Vec<git::Commit>, String> {
  let root = git_dir(&ws, slug.as_deref())?;
  blocking(move || git::log(&root, limit.unwrap_or(50))).await
}

/// The pull request of the worktree's branch and its checks (`gh pr view --json`), or null when
/// the branch has none. Errors when `gh` is missing or not signed in.
#[tauri::command]
async fn gh_pr_view(ws: State<'_, Workspace>, slug: Option<String>) -> Result<Option<serde_json::Value>, String> {
  let root = git_dir(&ws, slug.as_deref())?;
  blocking(move || {
    let gh = agent::review::gh_bin().ok_or("ยังไม่ได้ติดตั้ง GitHub CLI (gh)")?;
    let out = shell_env::command(&gh)
      .current_dir(&root)
      .args(["pr", "view", "--json", "number,title,state,url,isDraft,headRefName,baseRefName,mergeable,reviewDecision,statusCheckRollup,additions,deletions,author,createdAt,autoMergeRequest"])
      .output()
      .map_err(|e| format!("gh: {e}"))?;
    if !out.status.success() {
      let err = String::from_utf8_lossy(&out.stderr);
      if err.contains("no pull requests found") {
        return Ok(None);
      }
      return Err(format!("gh pr view: {}", err.trim()));
    }
    serde_json::from_slice(&out.stdout).map(Some).map_err(|e| e.to_string())
  })
  .await
}

#[tauri::command]
fn open_web_url(url: String) -> Result<(), String> {
  system::open_web_url(&url)
}

/// Runs `gh` in `dir`; its stderr becomes the error.
fn gh_run(dir: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
  let gh = agent::review::gh_bin().ok_or("ยังไม่ได้ติดตั้ง GitHub CLI (gh)")?;
  let out = shell_env::command(&gh).current_dir(dir).env("GH_PROMPT_DISABLED", "1").args(args).output().map_err(|e| format!("gh: {e}"))?;
  if !out.status.success() {
    return Err(format!("gh {}: {}", args.first().unwrap_or(&""), String::from_utf8_lossy(&out.stderr).trim()));
  }
  Ok(out.stdout)
}

/// Checks tab actions on the branch's PR: `merge` (with `squash` / `merge` / `rebase`), `close`,
/// `reopen`, `ready` (out of draft).
#[tauri::command]
async fn gh_pr_action(ws: State<'_, Workspace>, slug: Option<String>, action: String, method: Option<String>) -> Result<(), String> {
  let root = git_dir(&ws, slug.as_deref())?;
  blocking(move || {
    let flag = match method.as_deref() {
      Some("merge") => "--merge",
      Some("rebase") => "--rebase",
      _ => "--squash",
    };
    let args: Vec<&str> = match action.as_str() {
      "merge" => vec!["pr", "merge", flag],
      "auto" => vec!["pr", "merge", "--auto", flag],
      "disableAuto" => vec!["pr", "merge", "--disable-auto"],
      "close" => vec!["pr", "close"],
      "reopen" => vec!["pr", "reopen"],
      "ready" => vec!["pr", "ready"],
      other => return Err(format!("{other}: unknown PR action")),
    };
    gh_run(&root, &args).map(|_| ())
  })
  .await
}

#[tauri::command]
async fn gh_pr_edit_title(ws: State<'_, Workspace>, slug: Option<String>, title: String) -> Result<(), String> {
  let root = git_dir(&ws, slug.as_deref())?;
  if title.trim().is_empty() {
    return Err("PR title is empty".into());
  }
  blocking(move || gh_run(&root, &["pr", "edit", "--title", title.trim()]).map(|_| ())).await
}

/// The PR's conversation comments and reviews (`gh pr view --json comments,reviews`).
#[tauri::command]
async fn gh_pr_comments(ws: State<'_, Workspace>, slug: Option<String>) -> Result<serde_json::Value, String> {
  let root = git_dir(&ws, slug.as_deref())?;
  blocking(move || {
    let out = gh_run(&root, &["pr", "view", "--json", "comments,reviews"])?;
    serde_json::from_slice(&out).map_err(|e| e.to_string())
  })
  .await
}

#[tauri::command]
async fn gh_pr_comment(ws: State<'_, Workspace>, slug: Option<String>, body: String) -> Result<(), String> {
  let root = git_dir(&ws, slug.as_deref())?;
  if body.trim().is_empty() {
    return Err("Comment is empty".into());
  }
  if body.len() > 60_000 {
    return Err("Comment is too large to submit safely.".into());
  }
  blocking(move || gh_run(&root, &["pr", "comment", "--body", &body]).map(|_| ())).await
}

/// The failed steps' log of a GitHub Actions check (from its details URL), last 150 lines.
#[tauri::command]
async fn gh_check_log(ws: State<'_, Workspace>, slug: Option<String>, url: String) -> Result<String, String> {
  let root = git_dir(&ws, slug.as_deref())?;
  let run = url.split("/actions/runs/").nth(1).and_then(|r| r.split(['/', '?']).next()).filter(|r| r.chars().all(|c| c.is_ascii_digit()) && !r.is_empty()).map(str::to_owned);
  let Some(run) = run else { return Err("No inline details are available for this check.".into()) };
  blocking(move || {
    let out = gh_run(&root, &["run", "view", &run, "--log-failed"])?;
    let text = String::from_utf8_lossy(&out);
    let lines: Vec<&str> = text.lines().collect();
    Ok(lines[lines.len().saturating_sub(150)..].join("\n"))
  })
  .await
}

/// Files a commit changed (`git show --name-status`), for the Commits panel.
#[tauri::command]
async fn git_show_files(ws: State<'_, Workspace>, slug: Option<String>, hash: String) -> Result<Vec<(String, String)>, String> {
  let root = git_dir(&ws, slug.as_deref())?;
  git::check_rev(&hash)?;
  blocking(move || {
    let out = git::run(&root, &["show", "--name-status", "--format=", "--end-of-options", &hash])?;
    Ok(String::from_utf8_lossy(&out).lines().filter_map(|l| l.split_once('\t')).map(|(s, p)| (s.chars().next().unwrap_or('M').to_string(), p.rsplit('\t').next().unwrap_or(p).to_owned())).collect())
  })
  .await
}

/// Commits ahead of and behind `base` (Change Base Ref's compare).
#[tauri::command]
async fn git_compare(ws: State<'_, Workspace>, slug: Option<String>, base: String) -> Result<(u32, u32), String> {
  let root = git_dir(&ws, slug.as_deref())?;
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
async fn git_refs(ws: State<'_, Workspace>, slug: Option<String>) -> Result<Vec<String>, String> {
  let root = git_dir(&ws, slug.as_deref())?;
  blocking(move || {
    let out = git::run(&root, &["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"])?;
    Ok(String::from_utf8_lossy(&out).lines().filter(|l| !l.is_empty() && !l.ends_with("/HEAD")).map(str::to_owned).collect())
  })
  .await
}

/// Source Control AI: a commit message for the staged diff, written by Claude Code (`claude -p`).
/// Only runs when the user presses the sparkle button.
#[tauri::command]
async fn ai_commit_message(ws: State<'_, Workspace>, slug: Option<String>) -> Result<String, String> {
  let root = git_dir(&ws, slug.as_deref())?;
  blocking(move || {
    let diff = git::run(&root, &["diff", "--cached", "--no-color"])?;
    if diff.is_empty() {
      return Err("Stage at least one file to generate a message.".into());
    }
    let diff = String::from_utf8_lossy(&diff[..diff.len().min(120_000)]).into_owned();
    let prompt = "Write a git commit message for the staged diff on stdin. First line: imperative summary under 72 characters. Then, only if useful, a blank line and a short body. Output only the message, no code fences.";
    let mut child = shell_env::command("claude")
      .current_dir(&root)
      .args(["-p", prompt])
      .stdin(std::process::Stdio::piped())
      .stdout(std::process::Stdio::piped())
      .stderr(std::process::Stdio::piped())
      .spawn()
      .map_err(|e| format!("claude: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
      use std::io::Write;
      stdin.write_all(diff.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
      return Err(format!("claude: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
  })
  .await
}

/// Claude Code sessions run in the open folder or its worktrees (Agents tab).
#[tauri::command]
async fn claude_sessions(ws: State<'_, Workspace>, limit: Option<usize>) -> Result<Vec<sessions::Session>, String> {
  let root = ws.root()?;
  blocking(move || Ok(sessions::list(&root, limit.unwrap_or(250)))).await
}

/// Source Control's PR composer: pushes the branch (setting its upstream) and opens a PR.
/// Returns the PR's URL.
#[tauri::command]
async fn gh_pr_create(ws: State<'_, Workspace>, slug: Option<String>, base: String, title: String, body: String, draft: bool) -> Result<String, String> {
  let root = git_dir(&ws, slug.as_deref())?;
  git::check_rev(&base)?;
  if title.trim().is_empty() {
    return Err("Enter a pull request title.".into());
  }
  blocking(move || {
    git::run(&root, &["push", "-q", "-u", "origin", "HEAD"]).map_err(|e| format!("Push failed. Resolve the push error, then try again. {e}"))?;
    let mut args = vec!["pr", "create", "--base", base.as_str(), "--title", title.trim(), "--body", body.as_str()];
    if draft {
      args.push("--draft");
    }
    let out = gh_run(&root, &args)?;
    Ok(String::from_utf8_lossy(&out).lines().rev().find(|l| l.starts_with("http")).unwrap_or_default().trim().to_owned())
  })
  .await
}

/// PR title and description written by Claude Code from the branch's diff against `base`
/// (only on click). Returns `{title, body}`.
#[tauri::command]
async fn ai_pr_details(ws: State<'_, Workspace>, slug: Option<String>, base: String) -> Result<serde_json::Value, String> {
  let root = git_dir(&ws, slug.as_deref())?;
  git::check_rev(&base)?;
  blocking(move || {
    let log = git::run(&root, &["log", "--format=- %s", &format!("{base}..HEAD")]).unwrap_or_default();
    let diff = git::run(&root, &["diff", "--no-color", &format!("{base}...HEAD")]).unwrap_or_default();
    let input = format!("Commits:\n{}\n\nDiff:\n{}", String::from_utf8_lossy(&log), String::from_utf8_lossy(&diff[..diff.len().min(120_000)]));
    let prompt = "Write a pull request title and description for the commits and diff on stdin. Reply with exactly a first line holding the title (under 72 characters), a blank line, then a markdown description. No code fences around the whole reply.";
    let mut child = shell_env::command("claude")
      .current_dir(&root)
      .args(["-p", prompt])
      .stdin(std::process::Stdio::piped())
      .stdout(std::process::Stdio::piped())
      .stderr(std::process::Stdio::piped())
      .spawn()
      .map_err(|e| format!("claude: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
      use std::io::Write;
      stdin.write_all(input.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
      return Err(format!("claude: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    let (title, body) = text.split_once('\n').unwrap_or((&text, ""));
    Ok(serde_json::json!({ "title": title.trim().trim_start_matches('#').trim(), "body": body.trim() }))
  })
  .await
}

/// Review threads of the branch's PR (GitHub GraphQL through `gh api`).
#[tauri::command]
async fn gh_review_threads(ws: State<'_, Workspace>, slug: Option<String>, number: u64) -> Result<serde_json::Value, String> {
  let root = git_dir(&ws, slug.as_deref())?;
  blocking(move || {
    let query = "query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved path line comments(first:50){nodes{id databaseId body createdAt author{login} reactionGroups{content viewerHasReacted reactors{totalCount}}}}}}}}}";
    let out = gh_run(&root, &["api", "graphql", "-F", "owner={owner}", "-F", "repo={repo}", "-F", &format!("n={number}"), "-f", &format!("query={query}")])?;
    serde_json::from_slice(&out).map_err(|e| e.to_string())
  })
  .await
}

/// Resolves or reopens a review thread.
#[tauri::command]
async fn gh_resolve_thread(ws: State<'_, Workspace>, slug: Option<String>, thread: String, resolve: bool) -> Result<(), String> {
  let root = git_dir(&ws, slug.as_deref())?;
  blocking(move || {
    let m = if resolve { "resolveReviewThread" } else { "unresolveReviewThread" };
    let query = format!("mutation($id:ID!){{{m}(input:{{threadId:$id}}){{thread{{id}}}}}}");
    gh_run(&root, &["api", "graphql", "-f", &format!("id={thread}"), "-f", &format!("query={query}")]).map(|_| ())
  })
  .await
}

/// Replies inside a review thread.
#[tauri::command]
async fn gh_reply_thread(ws: State<'_, Workspace>, slug: Option<String>, thread: String, body: String) -> Result<(), String> {
  let root = git_dir(&ws, slug.as_deref())?;
  if body.trim().is_empty() {
    return Err("Comment is empty".into());
  }
  blocking(move || {
    let query = "mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}";
    gh_run(&root, &["api", "graphql", "-f", &format!("id={thread}"), "-f", &format!("body={body}"), "-f", &format!("query={query}")]).map(|_| ())
  })
  .await
}

/// Adds or removes a reaction (THUMBS_UP, HEART, …) on a comment by its node id.
#[tauri::command]
async fn gh_react(ws: State<'_, Workspace>, slug: Option<String>, subject: String, content: String, remove: bool) -> Result<(), String> {
  let root = git_dir(&ws, slug.as_deref())?;
  const ALLOWED: [&str; 8] = ["THUMBS_UP", "THUMBS_DOWN", "LAUGH", "CONFUSED", "HEART", "HOORAY", "ROCKET", "EYES"];
  if !ALLOWED.contains(&content.as_str()) {
    return Err(format!("{content}: unknown reaction"));
  }
  blocking(move || {
    let m = if remove { "removeReaction" } else { "addReaction" };
    let query = format!("mutation($id:ID!,$c:ReactionContent!){{{m}(input:{{subjectId:$id,content:$c}}){{reaction{{content}}}}}}");
    gh_run(&root, &["api", "graphql", "-f", &format!("id={subject}"), "-f", &format!("c={content}"), "-f", &format!("query={query}")]).map(|_| ())
  })
  .await
}

/// Moves a Claude Code session transcript of this folder to the Trash (Agents tab › Delete).
#[tauri::command]
async fn delete_claude_session(ws: State<'_, Workspace>, path: String) -> Result<(), String> {
  let root = ws.root()?;
  let p = std::path::PathBuf::from(&path);
  let home = std::env::var_os("HOME").map(std::path::PathBuf::from).ok_or("no home folder")?;
  let projects = home.join(".claude").join("projects");
  let dir = p.parent().and_then(|d| d.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
  let prefix = sessions::encode(&root);
  let ours = p.starts_with(&projects) && p.extension().and_then(|e| e.to_str()) == Some("jsonl") && (dir == prefix || dir.starts_with(&format!("{prefix}-")));
  if !ours {
    return Err("Only sessions of this folder can be deleted.".into());
  }
  blocking(move || trash::delete(&p).map_err(|e| e.to_string())).await
}

/// Aborts the merge, rebase or cherry-pick in progress (Source Control's conflict card).
#[tauri::command]
async fn git_abort(ws: State<'_, Workspace>, slug: Option<String>) -> Result<String, String> {
  let root = git_dir(&ws, slug.as_deref())?;
  blocking(move || {
    for op in ["merge", "rebase", "cherry-pick"] {
      if git::run(&root, &[op, "--abort"]).is_ok() {
        return Ok(op.to_owned());
      }
    }
    Err("No merge, rebase or cherry-pick is in progress.".into())
  })
  .await
}

/// HEAD version of a file for the diff editor; empty when the file is not in HEAD.
#[tauri::command]
async fn git_show_head(ws: State<'_, Workspace>, rel: String) -> Result<String, String> {
  let root = ws.root()?;
  git::check_rel(&root, &rel)?;
  blocking(move || git::show_head(&root, &rel)).await
}

#[tauri::command]
fn pty_spawn(
  ws: State<'_, Workspace>,
  ptys: State<'_, pty::Ptys>,
  cols: u16,
  rows: u16,
  on_data: Channel<String>,
  slug: Option<String>,
  run: Option<Vec<String>>,
  floating_cwd: Option<String>,
  app: AppHandle,
) -> Result<u32, String> {
  // A task terminal starts in the task's worktree (the ADE's per-worktree terminals); a floating
  // workspace terminal in its own directory setting. No folder open: the home folder, like VS
  // Code's empty window.
  let cwd = match slug {
    _ if floating_cwd.is_some() => {
      let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
      floating::terminal_cwd(floating_cwd.as_deref().unwrap_or("~"), &data)?
    }
    Some(slug) => {
      agent::worktree::validate_slug(&slug)?;
      let dir = agent::worktree::worktree_path(&ws.root()?, &slug);
      if !dir.is_dir() {
        return Err(format!("ไม่พบ worktree ของงาน {slug}"));
      }
      dir
    }
    None => ws.current().or_else(|| std::env::var_os("HOME").map(PathBuf::from)).unwrap_or_else(|| PathBuf::from("/")),
  };
  let id = pty::spawn_shell(&ptys, &cwd, cols, rows, on_data, run.as_deref())?;
  log::info!("terminal {id} started ({cols}x{rows})");
  Ok(id)
}

#[tauri::command]
fn worktree_create(
  ws: State<'_, Workspace>,
  slug: String,
  base: Option<String>,
) -> Result<agent::worktree::WorktreeInfo, String> {
  agent::worktree::create(&ws.root()?, &slug, base.as_deref())
}

#[tauri::command]
fn worktree_list(ws: State<'_, Workspace>) -> Result<Vec<agent::worktree::WorktreeInfo>, String> {
  // No folder open: no tasks to list (not an error in the Agent panel).
  ws.current().map_or(Ok(Vec::new()), |root| agent::worktree::list(&root))
}

#[tauri::command]
fn worktree_remove(
  ws: State<'_, Workspace>,
  slug: String,
  force: Option<bool>,
  delete_branch: Option<bool>,
) -> Result<(), String> {
  agent::worktree::remove(&ws.root()?, &slug, force.unwrap_or(false), delete_branch.unwrap_or(false))
}

/// Find in Files: streams ripgrep matches per file; a new search cancels the previous one.
#[tauri::command]
fn search_text(
  ws: State<'_, Workspace>,
  searches: State<'_, Arc<search::Searches>>,
  options: search::SearchOptions,
  on_event: Channel<search::SearchEvent>,
) -> Result<u32, String> {
  if options.query.is_empty() {
    searches.cancel();
    return Err("query is empty".into());
  }
  let rg = search::find_rg(std::env::var_os("KINGU_RG"), shell_env::path())?;
  searches.start(&rg, &ws.root()?, &options, move |ev| on_event.send(ev).is_ok())
}

/// Search: Replace. Rewrites the matches of the last search (refusing files changed since) and
/// returns edits for files the webview has open, which it applies to their editor models.
#[tauri::command]
async fn search_replace(ws: State<'_, Workspace>, request: replace::ReplaceRequest) -> Result<Vec<replace::FileResult>, String> {
  let root = ws.root()?;
  let results = blocking(move || replace::replace_all(&root, &request)).await?;
  let written: usize = results.iter().filter(|r| r.outcome == replace::Outcome::Written).map(|r| r.replaced).sum();
  log::info!("search_replace: {written} replacements written in {} files", results.len());
  Ok(results)
}

#[tauri::command]
fn search_cancel(searches: State<'_, Arc<search::Searches>>) {
  searches.cancel();
}

/// Starts the language server for `language` in the workspace; server messages stream over `on_event`.
#[tauri::command]
fn lsp_start(
  ws: State<'_, Workspace>,
  servers: State<'_, lsp::Servers>,
  language: String,
  on_event: Channel<lsp::LspEvent>,
) -> Result<u32, String> {
  lsp::start_for(&servers, &ws.root()?, &language, on_event)
}

// ---------------------------------------------------------------------------------------------
// Open Folder (VS Code: workbench.action.files.openFolder, File: Open Recent)

/// Emitted with a debounced batch of changed paths under the open folder.
const FILES_CHANGED: &str = "workspace:files-changed";

#[derive(Clone, serde::Serialize)]
struct FilesChanged {
  root: String,
  /// Workspace-relative; `""` means "anything may have changed" (watcher rescan).
  paths: Vec<String>,
}

/// Makes `dir` the open folder (none for `None`). The old folder's language servers and running
/// search are stopped first and the watcher moves to the new root. Returns the canonical root.
fn switch_root(app: &AppHandle, dir: Option<&Path>) -> Result<Option<PathBuf>, String> {
  let root = dir.map(workspace::canonical_dir).transpose()?;
  app.state::<lsp::Servers>().stop_all();
  app.state::<Arc<search::Searches>>().cancel();
  let ws = app.state::<Workspace>();
  match &root {
    Some(r) => {
      ws.open(r)?;
    }
    None => ws.close(),
  }
  let handle = app.clone();
  let label = root.as_ref().map(|r| r.display().to_string()).unwrap_or_default();
  let emit = move |paths| {
    let _ = handle.emit(FILES_CHANGED, FilesChanged { root: label.clone(), paths });
  };
  // A folder that cannot be watched (e.g. out of inotify handles) still opens.
  if let Err(e) = app.state::<watcher::FileWatcher>().watch(root.as_deref(), emit) {
    log::error!("{e}");
  }
  let recent = app.state::<Recent>();
  let saved = match &root {
    Some(r) => recent.opened(r),
    None => recent.closed(),
  };
  if let Err(e) = saved {
    log::error!("recent folders: {e}");
  }
  log::info!("workspace: {}", root.as_ref().map(|r| r.display().to_string()).unwrap_or_else(|| "(none)".into()));
  Ok(root)
}

#[tauri::command]
fn workspace_open(app: AppHandle, path: String) -> Result<String, String> {
  let root = switch_root(&app, Some(Path::new(&path)))?;
  Ok(root.map(|r| r.display().to_string()).unwrap_or_default())
}

#[tauri::command]
fn workspace_close(app: AppHandle) -> Result<(), String> {
  switch_root(&app, None).map(|_| ())
}

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
fn fs_create_file(ws: State<'_, Workspace>, rel: String) -> Result<(), String> {
  fileops::create_file(&ws.root()?, &rel)?;
  log::info!("created {rel}");
  Ok(())
}

#[tauri::command]
fn fs_create_dir(ws: State<'_, Workspace>, rel: String) -> Result<(), String> {
  fileops::create_dir(&ws.root()?, &rel)?;
  log::info!("created folder {rel}");
  Ok(())
}

#[tauri::command]
fn fs_rename(ws: State<'_, Workspace>, from: String, to: String) -> Result<(), String> {
  fileops::rename(&ws.root()?, &from, &to)?;
  log::info!("renamed {from} to {to}");
  Ok(())
}

/// Moves to the Trash; the webview confirms first.
#[tauri::command]
async fn fs_delete(ws: State<'_, Workspace>, rel: String) -> Result<(), String> {
  let root = ws.root()?;
  let r = rel.clone();
  blocking(move || fileops::trash(&root, &r)).await?;
  log::info!("moved {rel} to the Trash");
  Ok(())
}

#[tauri::command]
fn fs_reveal(ws: State<'_, Workspace>, rel: String) -> Result<(), String> {
  fileops::reveal(&ws.root()?, &rel)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .manage(Workspace::default())
    .manage(watcher::FileWatcher::default())
    .manage(pty::Ptys::default())
    .manage(system::KeepAwake::default())
    .manage(Arc::new(agent::AgentHost::default()))
    .manage(Arc::new(search::Searches::default()))
    .manage(lsp::Servers::default())
    .manage(menu::MenuState::default())
    .setup(|app| {
      shell_env::init();
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // Reopen the last folder if it still exists, else KINGU_WORKSPACE, else the welcome view.
      let recent = Recent::load(app.path().app_data_dir()?.join("recent.json"));
      let start = workspace::startup_root(recent.data().last.as_deref(), std::env::var_os("KINGU_WORKSPACE"));
      app.manage(recent);
      team::install(app)?;
      menu::install(app.handle());
      if let Some(root) = start
        && let Err(e) = switch_root(app.handle(), Some(&root))
      {
        log::error!("reopen {}: {e}", root.display());
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      app_info,
      system_stats,
      fs_read_data_url,
      system_ports,
      system_kill,
      open_local_url,
      keep_awake_set,
      client_log,
      read_workspace_file,
      fs_list_dir,
      fs_list_files,
      fs_write_file,
      fs_create_file,
      fs_create_dir,
      fs_rename,
      fs_delete,
      fs_reveal,
      workspace_open,
      workspace_close,
      workspace_recent,
      workspace_recent_remove,
      workspace_recent_clear,
      git_branch,
      git_status,
      git_stage,
      git_unstage,
      git_discard,
      git_commit,
      git_checkout,
      git_sync,
      git_numstat,
      git_push,
      git_pull,
      git_fetch,
      git_rebase,
      git_log,
      gh_pr_view,
      open_web_url,
      gh_pr_action,
      gh_pr_edit_title,
      gh_pr_comments,
      gh_pr_comment,
      gh_check_log,
      git_show_files,
      git_compare,
      git_refs,
      ai_commit_message,
      claude_sessions,
      gh_pr_create,
      ai_pr_details,
      gh_review_threads,
      gh_resolve_thread,
      gh_reply_thread,
      gh_react,
      delete_claude_session,
      git_abort,
      usage_fetch,
      usage_detect,
      floating_note_new,
      floating_note_read,
      floating_note_write,
      floating_dir,
      git_show_head,
      pty_spawn,
      pty::pty_write,
      pty::pty_resize,
      pty::pty_kill,
      worktree_create,
      worktree_list,
      worktree_remove,
      agent::agent_start,
      agent::agent_send,
      agent::agent_answer_permission,
      agent::agent_interrupt,
      agent::agent_stop,
      agent::tasks_load,
      agent::tasks_save,
      agent::git_branches,
      agent::worktree_diff_stat,
      agent::worktree_diff_text,
      agent::git_diff_text,
      agent::worktree_reject,
      agent::worktree_commit,
      agent::worktree_merge,
      agent::worktree_list_files,
      agent::git_show_ref,
      agent::gh_status,
      agent::worktree_pr_create,
      search_text,
      search_cancel,
      search_replace,
      lsp_start,
      lsp::lsp_send,
      lsp::lsp_stop,
      settings::settings_read,
      settings::settings_write,
      snap::snap_list,
      snap::snap_trust,
      snap::snap_skill_plugins,
      team::team_sign_in,
      team::team_sign_out,
      team::team_status,
      team::team_sync_task,
      team::team_sync_now,
      menu::menu_set_model,
      menu::menu_set_checked,
      menu::menu_set_enabled,
      menu::window_titlebar_double_click,
      menu::app_quit
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      if let tauri::RunEvent::Exit = event {
        app.state::<lsp::Servers>().stop_all();
        app.state::<Arc<agent::AgentHost>>().shutdown();
      }
    });
}
