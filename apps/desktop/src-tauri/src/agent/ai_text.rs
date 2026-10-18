//! Source-control AI (Orca's commit-message / PR-details generation): runs an agent CLI once,
//! non-interactively and read-only, in the repository (or task worktree), feeding it a prompt the
//! page built from the context below, and returns its text. Which program runs and with which
//! flags comes only from the user's own settings.json (`kingu.git.ai.agent`, `kingu.git.ai.model`,
//! `kingu.git.ai.customCommand`), read here, never from the page or the repository. Also the
//! repository's pull request template (Orca's "use template").

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State};

use crate::git;
use crate::workspace::Workspace;

/// How long one generation may take before it is killed.
pub const TIMEOUT: Duration = Duration::from_secs(180);
/// Output kept from the agent (its answer is a commit message or a PR body).
pub const MAX_OUTPUT: usize = 64 * 1024;
/// Orca's STAGED_DIFF_BYTE_BUDGET: the patch handed to the prompt.
pub const MAX_PATCH: usize = 200_000;
const MAX_PROMPT: usize = 400_000;
const MAX_SUMMARY: usize = 16_000;

/// The headless invocation of a known agent CLI (Orca's commit-message agent specs): the program,
/// its arguments, and the prompt on stdin (`None`: the prompt is an argument).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
  pub argv: Vec<String>,
  pub stdin: Option<String>,
}

/// A model name passed as one flag value: no leading `-`, no spaces or shell-ish characters.
pub fn valid_model(model: &str) -> bool {
  !model.is_empty() && model.len() <= 100 && !model.starts_with('-') && model.chars().all(|c| c.is_ascii_alphanumeric() || "._:/@[]-".contains(c))
}

/// The agent profile ids that have a headless mode Kingu knows how to drive.
pub const AGENTS: &[&str] = &["claude", "codex", "gemini", "qwen", "opencode", "cursor", "copilot", "amp"];

/// Orca's buildArgs for `agent`, read-only where the CLI has such a mode. `model` empty = the
/// CLI's own default.
pub fn invocation(agent: &str, model: &str, prompt: &str) -> Result<Invocation, String> {
  if !model.is_empty() && !valid_model(model) {
    return Err(format!("kingu.git.ai.model: {model:?} ไม่ใช่ชื่อ model ที่ใช้ได้"));
  }
  let m = |flag: &str| if model.is_empty() { vec![] } else { vec![flag.to_owned(), model.to_owned()] };
  let s = |v: &[&str]| v.iter().map(|x| (*x).to_owned()).collect::<Vec<_>>();
  let stdin = Some(prompt.to_owned());
  let (argv, stdin) = match agent {
    // `claude -p` reads the prompt from stdin; plan mode keeps it from touching files.
    "claude" => ([s(&["claude", "-p", "--output-format", "text", "--permission-mode", "plan"]), m("--model")].concat(), stdin),
    "codex" => ([s(&["codex", "exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only"]), m("--model")].concat(), stdin),
    "opencode" => ([s(&["opencode", "run", "--agent", "plan"]), m("--model")].concat(), stdin),
    "amp" => ([s(&["amp", "--execute", "--no-notifications", "--no-ide", "--no-jetbrains"]), m("--mode")].concat(), stdin),
    // These take the prompt as an argument (Orca: promptDelivery argv).
    "gemini" | "qwen" => ([s(&[agent]), m("--model"), s(&["--approval-mode", "plan", "-p"]), vec![prompt.to_owned()]].concat(), None),
    "cursor" => ([s(&["cursor-agent", "--print", "--mode", "ask", "--output-format", "text"]), m("--model"), vec![prompt.to_owned()]].concat(), None),
    "copilot" => ([s(&["copilot", "--silent", "--no-custom-instructions"]), m("--model"), s(&["--prompt"]), vec![prompt.to_owned()]].concat(), None),
    _ => return Err(format!("{agent}: ยังไม่รองรับการสร้างข้อความด้วย agent นี้ — เลือก {} หรือ custom", AGENTS.join(", "))),
  };
  Ok(Invocation { argv, stdin })
}

/// Splits a command line into words the way a shell would for plain words and quotes (`'…'`,
/// `"…"`, `\x`), without running a shell: `$`, `|`, `;` stay literal characters.
pub fn split_command(cmd: &str) -> Result<Vec<String>, String> {
  let mut words = Vec::new();
  let mut cur = String::new();
  let mut any = false;
  let mut chars = cmd.chars();
  while let Some(c) = chars.next() {
    match c {
      '\'' => {
        any = true;
        loop {
          match chars.next() {
            Some('\'') => break,
            Some(x) => cur.push(x),
            None => return Err("คำสั่งมี ' ที่ไม่ปิด".into()),
          }
        }
      }
      '"' => {
        any = true;
        loop {
          match chars.next() {
            Some('"') => break,
            Some('\\') => match chars.next() {
              Some(x) => cur.push(x),
              None => return Err("คำสั่งจบด้วย \\".into()),
            },
            Some(x) => cur.push(x),
            None => return Err("คำสั่งมี \" ที่ไม่ปิด".into()),
          }
        }
      }
      '\\' => {
        any = true;
        cur.push(chars.next().ok_or("คำสั่งจบด้วย \\")?);
      }
      c if c.is_whitespace() => {
        if any {
          words.push(std::mem::take(&mut cur));
          any = false;
        }
      }
      c => {
        any = true;
        cur.push(c);
      }
    }
  }
  if any {
    words.push(cur);
  }
  Ok(words)
}

/// Orca's custom agent command: `{prompt}` inside an argument is replaced by the prompt (passed
/// as an argument), otherwise the prompt goes to stdin.
pub fn custom_invocation(template: &str, prompt: &str) -> Result<Invocation, String> {
  let words = split_command(template)?;
  if words.is_empty() {
    return Err("kingu.git.ai.customCommand ว่างอยู่".into());
  }
  if words.iter().any(|w| w.contains("{prompt}")) {
    Ok(Invocation { argv: words.iter().map(|w| w.replace("{prompt}", prompt)).collect(), stdin: None })
  } else {
    Ok(Invocation { argv: words, stdin: Some(prompt.to_owned()) })
  }
}

/// The agent `kingu.git.ai.agent` names, or with it empty the one `kingu.agent.cli` starts
/// (its program's name), else claude (Orca: the default agent).
pub fn resolve_agent(setting: &str, agent_cli: &str) -> String {
  let setting = setting.trim();
  if !setting.is_empty() {
    return setting.to_owned();
  }
  let program = split_command(agent_cli).ok().and_then(|w| w.into_iter().next()).unwrap_or_default();
  let name = Path::new(&program).file_name().and_then(|n| n.to_str()).unwrap_or("");
  let name = if name == "cursor-agent" { "cursor" } else { name };
  if AGENTS.contains(&name) { name.to_owned() } else { "claude".to_owned() }
}

/// Runs `inv` in `dir`, killing it (and what it started) after `timeout`. The end of stdout on
/// success; stderr (or stdout) in the error otherwise.
pub fn run(inv: &Invocation, dir: &Path, timeout: Duration) -> Result<String, String> {
  let (program, args) = inv.argv.split_first().ok_or("no program")?;
  let mut cmd = crate::shell_env::command(program);
  cmd.args(args).current_dir(dir).stdin(if inv.stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
  }
  let mut child = cmd.spawn().map_err(|e| format!("{program}: {e}"))?;
  if let (Some(text), Some(mut pipe)) = (inv.stdin.clone(), child.stdin.take()) {
    // A thread, so a CLI that does not read all of stdin cannot block us.
    std::thread::spawn(move || {
      let _ = pipe.write_all(text.as_bytes());
    });
  }
  let (mut out, mut err) = (child.stdout.take().ok_or("no stdout")?, child.stderr.take().ok_or("no stderr")?);
  let read_capped = |r: &mut dyn Read| {
    let mut b = Vec::new();
    let _ = r.take((MAX_OUTPUT * 4) as u64).read_to_end(&mut b);
    b
  };
  let out_reader = std::thread::spawn(move || read_capped(&mut out));
  let err_reader = std::thread::spawn(move || {
    let mut b = Vec::new();
    let _ = err.by_ref().take((MAX_OUTPUT * 4) as u64).read_to_end(&mut b);
    b
  });
  let start = Instant::now();
  let status = loop {
    if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
      break Some(status);
    }
    if start.elapsed() >= timeout {
      #[cfg(unix)]
      // SAFETY: plain syscall on the process group created for this child above.
      unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
      }
      let _ = child.kill();
      let _ = child.wait();
      break None;
    }
    std::thread::sleep(Duration::from_millis(50));
  };
  let stdout = String::from_utf8_lossy(&out_reader.join().unwrap_or_default()).into_owned();
  let stderr = String::from_utf8_lossy(&err_reader.join().unwrap_or_default()).into_owned();
  let Some(status) = status else {
    return Err(format!("{program} ใช้เวลานานเกิน {} วินาทีจึงหยุดไว้", timeout.as_secs()));
  };
  if !status.success() {
    let detail = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
    return Err(format!("{program} จบด้วย {}: {}", status.code().map_or("signal".into(), |c| c.to_string()), tail(detail, 1500)));
  }
  let text = tail(stdout.trim(), MAX_OUTPUT);
  if text.is_empty() {
    return Err(format!("{program} ไม่ได้ตอบอะไรกลับมา"));
  }
  Ok(text)
}

fn tail(s: &str, max: usize) -> String {
  match s.char_indices().rev().nth(max) {
    Some((i, _)) => s[i..].to_owned(),
    None => s.to_owned(),
  }
}

fn head(s: &str, max: usize) -> String {
  match s.char_indices().nth(max) {
    Some((i, _)) => format!("{}\n…(ตัดไว้ {} ตัวอักษร)", &s[..i], s.len() - i),
    None => s.to_owned(),
  }
}

fn text(out: Vec<u8>) -> String {
  String::from_utf8_lossy(&out).into_owned()
}

/// What the commit-message prompt is built from: the staged changes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CommitContext {
  pub branch: Option<String>,
  /// `git diff --cached --name-status`.
  pub summary: String,
  /// `git diff --cached`, cut at `MAX_PATCH`; empty when nothing is staged.
  pub patch: String,
}

pub fn commit_context(dir: &Path) -> Result<CommitContext, String> {
  let branch = git::run(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok().map(|o| text(o).trim().to_owned());
  let summary = head(text(git::run(dir, &["diff", "--cached", "--name-status"])?).trim(), MAX_SUMMARY);
  let patch = head(&text(git::run(dir, &["diff", "--cached", "--no-color", "--no-ext-diff"])?), MAX_PATCH);
  Ok(CommitContext { branch, summary, patch })
}

/// What the PR-details prompt is built from: the branch's commits and changes since `base`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PrContext {
  pub branch: Option<String>,
  pub commits: String,
  pub summary: String,
  pub patch: String,
}

pub fn pr_context(dir: &Path, base: &str) -> Result<PrContext, String> {
  let fork = super::review::merge_base(dir, base)?;
  let range = format!("{fork}..HEAD");
  let branch = git::run(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok().map(|o| text(o).trim().to_owned());
  let commits = head(text(git::run(dir, &["log", "--no-merges", "--max-count=100", "--format=- %s", &range])?).trim(), MAX_SUMMARY);
  let summary = head(text(git::run(dir, &["diff", "--name-status", &range])?).trim(), MAX_SUMMARY);
  let patch = head(&text(git::run(dir, &["diff", "--no-color", "--no-ext-diff", &range])?), MAX_PATCH);
  Ok(PrContext { branch, commits, summary, patch })
}

/// The upstream of local branch `base` (`origin/main`), for comparing a task against it.
pub fn upstream_of(dir: &Path, base: &str) -> Option<String> {
  git::check_rev(base).ok()?;
  let up = text(git::run(dir, &["rev-parse", "--abbrev-ref", "--end-of-options", &format!("{base}@{{upstream}}")]).ok()?).trim().to_owned();
  (!up.is_empty() && git::check_rev(&up).is_ok()).then_some(up)
}

const TEMPLATE_FILES: &[&str] = &[
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
];
const MAX_TEMPLATE: u64 = 64 * 1024;

/// The repository's pull request template, where GitHub looks for one (a single file, else the
/// first of `.github/PULL_REQUEST_TEMPLATE/*.md`). Regular files inside `dir` only.
pub fn pr_template(dir: &Path) -> Option<String> {
  let read = |p: PathBuf| -> Option<String> {
    let meta = std::fs::symlink_metadata(&p).ok()?;
    if !meta.is_file() || meta.len() > MAX_TEMPLATE {
      return None;
    }
    let t = std::fs::read_to_string(&p).ok()?;
    (!t.trim().is_empty()).then_some(t)
  };
  for f in TEMPLATE_FILES {
    if let Some(t) = read(dir.join(f)) {
      return Some(t);
    }
  }
  let folder = dir.join(".github/PULL_REQUEST_TEMPLATE");
  if std::fs::symlink_metadata(&folder).ok()?.is_dir() {
    let mut names: Vec<_> = std::fs::read_dir(&folder).ok()?.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("md"))).collect();
    names.sort();
    return names.into_iter().find_map(read);
  }
  None
}

fn repo_dir(ws: &Workspace, slug: Option<&str>) -> Result<PathBuf, String> {
  let root = ws.root()?;
  // An empty slug is the open folder itself (the ADE's primary worktree).
  match slug.filter(|s| !s.is_empty()) {
    Some(s) => super::review::task_dir(&root, s),
    None => Ok(root),
  }
}

fn user_string(config: &Path, key: &str) -> String {
  crate::settings::user_value(config, key).and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

/// The invocation the user's settings ask for.
pub fn invocation_from_settings(config: &Path, prompt: &str) -> Result<Invocation, String> {
  let agent = resolve_agent(&user_string(config, "kingu.git.ai.agent"), &user_string(config, "kingu.agent.cli"));
  if agent == "custom" {
    return custom_invocation(&user_string(config, "kingu.git.ai.customCommand"), prompt);
  }
  invocation(&agent, user_string(config, "kingu.git.ai.model").trim(), prompt)
}

#[tauri::command]
pub async fn ai_commit_context(ws: State<'_, Workspace>, slug: Option<String>) -> Result<CommitContext, String> {
  let dir = repo_dir(&ws, slug.as_deref())?;
  tauri::async_runtime::spawn_blocking(move || commit_context(&dir)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ai_pr_context(ws: State<'_, Workspace>, slug: String, base: String) -> Result<PrContext, String> {
  let dir = repo_dir(&ws, Some(&slug))?;
  tauri::async_runtime::spawn_blocking(move || pr_context(&dir, &base)).await.map_err(|e| e.to_string())?
}

/// Runs the source-control AI agent of the user's settings on `prompt` in the repository.
#[tauri::command]
pub async fn ai_generate(app: AppHandle, ws: State<'_, Workspace>, slug: Option<String>, prompt: String) -> Result<String, String> {
  if prompt.len() > MAX_PROMPT {
    return Err("prompt ยาวเกินไป".into());
  }
  let dir = repo_dir(&ws, slug.as_deref())?;
  let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
  let inv = invocation_from_settings(&config, &prompt)?;
  log::info!("source-control AI: {} in {}", inv.argv[0], dir.display());
  tauri::async_runtime::spawn_blocking(move || run(&inv, &dir, TIMEOUT)).await.map_err(|e| e.to_string())?
}

/// The task worktree's pull request template (`kingu.pr.useTemplate`), or `None`.
#[tauri::command]
pub async fn ai_pr_template(ws: State<'_, Workspace>, slug: String) -> Result<Option<String>, String> {
  let dir = repo_dir(&ws, Some(&slug))?;
  tauri::async_runtime::spawn_blocking(move || pr_template(&dir)).await.map_err(|e| e.to_string())
}

/// `base`'s upstream (`origin/main`) in the open folder, or `None`.
#[tauri::command]
pub async fn git_base_upstream(ws: State<'_, Workspace>, base: String) -> Result<Option<String>, String> {
  let root = ws.root()?;
  tauri::async_runtime::spawn_blocking(move || upstream_of(&root, &base)).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn known_agents_run_headless_and_read_only() {
    let i = invocation("claude", "", "P").unwrap();
    assert_eq!(i.argv, ["claude", "-p", "--output-format", "text", "--permission-mode", "plan"]);
    assert_eq!(i.stdin.as_deref(), Some("P"));
    let i = invocation("codex", "gpt-5.5", "P").unwrap();
    assert_eq!(i.argv, ["codex", "exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "--model", "gpt-5.5"]);
    let i = invocation("cursor", "", "P").unwrap();
    assert_eq!((i.argv.last().map(String::as_str), i.stdin), (Some("P"), None));
    let i = invocation("gemini", "", "P").unwrap();
    assert_eq!(i.argv, ["gemini", "--approval-mode", "plan", "-p", "P"]);
    assert_eq!(invocation("amp", "rush", "P").unwrap().argv.last().map(String::as_str), Some("rush"));
    assert!(invocation("aider", "", "P").is_err());
    assert!(invocation("claude", "--dangerously-skip-permissions", "P").is_err());
    assert!(invocation("claude", "a b", "P").is_err());
  }

  #[test]
  fn custom_commands_split_without_a_shell() {
    assert_eq!(split_command(r#"llm -m 'gpt x' "a \"b\"" c\ d"#).unwrap(), ["llm", "-m", "gpt x", "a \"b\"", "c d"]);
    assert_eq!(split_command("echo $HOME; rm").unwrap(), ["echo", "$HOME;", "rm"]);
    assert_eq!(split_command("x ''").unwrap(), ["x", ""]);
    assert!(split_command("x 'open").is_err());
    let i = custom_invocation("llm -s {prompt}", "P").unwrap();
    assert_eq!((i.argv, i.stdin), (vec!["llm".to_owned(), "-s".to_owned(), "P".to_owned()], None));
    let i = custom_invocation("llm --stdin", "P").unwrap();
    assert_eq!(i.stdin.as_deref(), Some("P"));
    assert!(custom_invocation("  ", "P").is_err());
  }

  #[test]
  fn the_agent_follows_the_setting_then_the_agent_cli() {
    assert_eq!(resolve_agent("codex", "claude"), "codex");
    assert_eq!(resolve_agent("", "/opt/bin/codex --full-auto"), "codex");
    assert_eq!(resolve_agent("", "cursor-agent"), "cursor");
    assert_eq!(resolve_agent("", "aider"), "claude");
    assert_eq!(resolve_agent("", ""), "claude");
  }

  #[cfg(unix)]
  #[test]
  fn runs_a_fake_agent_with_stdin_timeout_and_errors() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let script = tmp.path().join("fake-agent");
    std::fs::write(&script, "#!/bin/sh\nif [ \"$1\" = fail ]; then echo boom >&2; exit 3; fi\nif [ \"$1\" = sleep ]; then sleep 5; fi\nprintf 'subject: '; cat; echo; echo \"$PWD\"\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let s = script.display().to_string();
    let ok = run(&Invocation { argv: vec![s.clone()], stdin: Some("Fix it".into()) }, tmp.path(), TIMEOUT).unwrap();
    assert!(ok.starts_with("subject: Fix it"), "{ok}");
    assert!(ok.ends_with(tmp.path().file_name().unwrap().to_str().unwrap()), "{ok}");
    let err = run(&Invocation { argv: vec![s.clone(), "fail".into()], stdin: None }, tmp.path(), TIMEOUT).unwrap_err();
    assert!(err.contains("3") && err.contains("boom"), "{err}");
    let err = run(&Invocation { argv: vec![s, "sleep".into()], stdin: None }, tmp.path(), Duration::from_millis(300)).unwrap_err();
    assert!(err.contains("นานเกิน"), "{err}");
    assert!(run(&Invocation { argv: vec!["/nonexistent/agent".into()], stdin: None }, tmp.path(), TIMEOUT).is_err());
  }

  fn git_in(dir: &Path, args: &[&str]) {
    let ok = std::process::Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(ok.status.success(), "{args:?}: {}", String::from_utf8_lossy(&ok.stderr));
  }

  #[test]
  fn reads_staged_and_branch_context_and_the_pr_template() {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path();
    git_in(d, &["init", "-q", "-b", "main"]);
    git_in(d, &["config", "user.email", "t@e"]);
    git_in(d, &["config", "user.name", "t"]);
    std::fs::write(d.join("a.txt"), "one\n").unwrap();
    git_in(d, &["add", "."]);
    git_in(d, &["commit", "-q", "-m", "init"]);
    git_in(d, &["checkout", "-q", "-b", "feat"]);
    std::fs::write(d.join("a.txt"), "two\n").unwrap();
    let c = commit_context(d).unwrap();
    assert_eq!((c.branch.as_deref(), c.patch.as_str()), (Some("feat"), ""));
    git_in(d, &["add", "a.txt"]);
    let c = commit_context(d).unwrap();
    assert!(c.summary.contains("M\ta.txt") && c.patch.contains("+two"), "{c:?}");
    git_in(d, &["commit", "-q", "-m", "Change a"]);
    let p = pr_context(d, "main").unwrap();
    assert!(p.commits.contains("- Change a") && p.patch.contains("+two"), "{p:?}");
    assert_eq!(upstream_of(d, "main"), None);
    assert_eq!(pr_template(d), None);
    std::fs::create_dir_all(d.join(".github/PULL_REQUEST_TEMPLATE")).unwrap();
    std::fs::write(d.join(".github/PULL_REQUEST_TEMPLATE/b.md"), "## B\n").unwrap();
    std::fs::write(d.join(".github/PULL_REQUEST_TEMPLATE/a.md"), "## A\n").unwrap();
    assert_eq!(pr_template(d).as_deref(), Some("## A\n"));
    std::fs::write(d.join(".github/pull_request_template.md"), "## Summary\n").unwrap();
    assert_eq!(pr_template(d).as_deref(), Some("## Summary\n"));
  }
}
