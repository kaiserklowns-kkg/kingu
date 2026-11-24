//! A GitHub account per project (Orca's per-repository `ghAccount`:
//! `src/main/github/accounts/{gh-account-token,gh-capability-state,gh-account-binding-inventory,
//! auth-diagnose,github-project-account}.ts`, `src/shared/github/accounts/account-binding.ts`,
//! `src/main/git/command-runner/hosted-cli/gh-bound-account-env.ts`, and the Repository pane's
//! `RepositoryGitHubAccountSection.tsx`).
//!
//! - The binding is `kingu.repo.ghAccount` = `{ host, user }` in Kingu's per-repository store
//!   (settings scope `repo`), never the repository's own files. A task worktree uses its main
//!   checkout's binding.
//! - Every `gh` call Kingu makes for that project (PRs, checks, issues, GitHub Projects, PR
//!   creation) gets a short-lived token of exactly that keyring login: `gh auth token --user U
//!   --hostname H`, read with the ambient `GH_TOKEN`/`GITHUB_TOKEN`/`GH_HOST`/… removed, and put in
//!   `GH_TOKEN` (`GH_ENTERPRISE_TOKEN` on GitHub Enterprise Server hosts) of that one child. Tokens
//!   are cached 5 minutes (a miss 30 seconds), never logged, never sent to the webview.
//! - It fails closed: a bound project whose login is gone, or a gh older than 2.40 (no `auth token
//!   --user`), gets an error naming the account, never the ambient login.
//! - No binding: gh's own active login, as before. `gh auth …` calls themselves are never bound.
//!
//! Kingu-only: the picker suggests the login named like the owner of the project's `origin`
//! remote ([`suggested`]).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

pub const SETTING: &str = "kingu.repo.ghAccount";
const POSITIVE_TTL: Duration = Duration::from_secs(5 * 60);
const NEGATIVE_TTL: Duration = Duration::from_secs(30);
const UNSUPPORTED_RETRY: Duration = Duration::from_secs(30 * 60);
const UNKNOWN_RETRY: Duration = Duration::from_secs(60);
const TIMEOUT: Duration = Duration::from_secs(10);
/// Variables that would make a bound call use another login (Orca `AMBIENT_GH_ENV_KEYS`).
pub const AMBIENT: [&str; 6] = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST", "GH_REPO"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
  pub host: String,
  pub user: String,
}

/// Orca `normalizeGhAccountBinding`: a lower-case host name (optionally with a port) and a login
/// without whitespace; else None.
pub fn normalize(v: &serde_json::Value) -> Option<Binding> {
  let host = v.get("host")?.as_str()?.trim().to_ascii_lowercase();
  let user = v.get("user")?.as_str()?.trim().to_owned();
  let (name, port) = host.split_once(':').map_or((host.as_str(), None), |(h, p)| (h, Some(p)));
  let host_ok = name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
    && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    && port.is_none_or(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
  let user_ok = !user.is_empty() && user.len() <= 255 && !user.contains(char::is_whitespace) && !user.contains('\0');
  (host_ok && user_ok).then_some(Binding { host, user })
}

/// github.com, github.localhost and `*.ghe.com` read `GH_TOKEN`; other hosts `GH_ENTERPRISE_TOKEN`.
pub fn token_env_var(host: &str) -> &'static str {
  let h = host.trim().to_ascii_lowercase();
  if h.is_empty() || h == "github.com" || h == "github.localhost" || h.ends_with(".ghe.com") { "GH_TOKEN" } else { "GH_ENTERPRISE_TOKEN" }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
  pub host: String,
  pub user: String,
  pub active: bool,
  /// `keyring` (bindable) or `env` (a `GH_TOKEN`/`GITHUB_TOKEN` login, which can't be bound).
  pub source: &'static str,
  pub env_token: Option<String>,
  pub scopes: Vec<String>,
}

/// Orca `parseAuthStatus`: the logins `gh auth status` lists, on either stream.
pub fn parse_auth_status(text: &str) -> Vec<Account> {
  let mut out: Vec<Account> = Vec::new();
  let mut host: Option<String> = None;
  let mut current: Option<Account> = None;
  for raw in text.lines() {
    let line = raw.trim_end_matches('\r');
    let t = line.trim();
    let bare = t.trim_end_matches(':').trim();
    if !line.starts_with(char::is_whitespace) && !bare.is_empty() && !bare.to_ascii_lowercase().starts_with("logged") && bare.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':')) {
      host = Some(bare.to_owned());
      continue;
    }
    if let Some(i) = t.find("Logged in to ") {
      let rest = &t[i + "Logged in to ".len()..];
      let mut words = rest.split_whitespace();
      let (Some(h), Some("account"), Some(user)) = (words.next(), words.next(), words.next()) else { continue };
      let label = rest.split_once('(').and_then(|(_, r)| r.split_once(')')).map(|(l, _)| l.trim().to_owned()).unwrap_or_default();
      let env_token = (label == "GH_TOKEN" || label == "GITHUB_TOKEN").then_some(label);
      if let Some(c) = current.take() {
        out.push(c);
      }
      current = Some(Account {
        host: if h.is_empty() { host.clone().unwrap_or_else(|| "github.com".into()) } else { h.to_owned() },
        user: user.to_owned(),
        active: false,
        source: if env_token.is_some() { "env" } else { "keyring" },
        env_token,
        scopes: Vec::new(),
      });
      continue;
    }
    let Some(c) = current.as_mut() else { continue };
    if let Some(v) = t.split_once("Active account:").map(|(_, v)| v.trim().to_ascii_lowercase()) {
      c.active = v == "true";
    } else if let Some(v) = t.split_once("Token scopes:").map(|(_, v)| v) {
      c.scopes = v.split(',').map(|s| s.trim().trim_matches(|q| q == '\'' || q == '"').to_owned()).filter(|s| !s.is_empty()).collect();
    }
  }
  out.extend(current);
  out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
  Supported,
  /// gh older than 2.40: no `gh auth token --user`.
  Unsupported,
  /// The probe itself failed (retried after a minute).
  Unknown,
}

/// Orca `probeMultiAccountCapability`: `gh auth token --help` names `--user`.
pub fn capability_of(help: Result<String, String>) -> Capability {
  match help {
    Ok(text) if text.contains("--user") => Capability::Supported,
    Ok(_) => Capability::Unsupported,
    Err(e) => {
      let e = e.to_ascii_lowercase();
      if e.contains("unknown flag: --user") || e.contains("unknown command") { Capability::Unsupported } else { Capability::Unknown }
    }
  }
}

fn without_ambient(cmd: &mut Command) {
  for k in AMBIENT {
    cmd.env_remove(k);
  }
  cmd.env("GH_PROMPT_DISABLED", "1").env("GH_NO_UPDATE_NOTIFIER", "1").env("NO_COLOR", "1");
}

/// Runs `gh args…` (unbound, ambient login variables removed) with a time limit: stdout+stderr, or the failure.
fn gh_plain(gh: &Path, args: &[&str]) -> Result<(bool, String, String), String> {
  let mut cmd = crate::shell_env::command(gh);
  cmd.args(args).current_dir(std::env::temp_dir()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
  without_ambient(&mut cmd);
  let mut child = cmd.spawn().map_err(|e| format!("gh: {e}"))?;
  let deadline = Instant::now() + TIMEOUT;
  loop {
    match child.try_wait() {
      Ok(Some(_)) => break,
      Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(30)),
      _ => {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("gh {} timed out", args.join(" ")));
      }
    }
  }
  let out = child.wait_with_output().map_err(|e| format!("gh: {e}"))?;
  Ok((out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned()))
}

struct Cache {
  capability: Option<(Capability, Instant)>,
  tokens: BTreeMap<(String, String), (Option<String>, Instant)>,
}

static CACHE: Mutex<Cache> = Mutex::new(Cache { capability: None, tokens: BTreeMap::new() });

fn cache() -> std::sync::MutexGuard<'static, Cache> {
  CACHE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Forgets what was probed and read (Settings' Refresh).
pub fn invalidate() {
  let mut c = cache();
  c.capability = None;
  c.tokens.clear();
}

/// Whether this gh can read one login's token (cached: supported for good, unsupported 30 min, unknown 1 min).
pub fn capability(gh: &Path) -> Capability {
  if let Some((c, until)) = cache().capability
    && Instant::now() < until
  {
    return c;
  }
  let c = capability_of(gh_plain(gh, &["auth", "token", "--help"]).and_then(|(ok, out, err)| if ok { Ok(format!("{out}\n{err}")) } else { Err(format!("{out}\n{err}")) }));
  let retry = match c {
    Capability::Supported => Duration::from_secs(365 * 24 * 3600),
    Capability::Unsupported => UNSUPPORTED_RETRY,
    Capability::Unknown => UNKNOWN_RETRY,
  };
  cache().capability = Some((c, Instant::now() + retry));
  c
}

fn unavailable(b: &Binding) -> String {
  format!("The GitHub account {}@{} chosen for this project isn't signed in to gh here. Run `gh auth login --hostname {}` as {}, or pick another account in the project's settings.", b.user, b.host, b.host, b.user)
}

fn unsupported() -> String {
  "This gh is too old for a per-project GitHub account (needs gh 2.40 or later, with `gh auth token --user`). Update gh, or clear the project's GitHub account.".into()
}

/// The login's token: `gh auth token --user U --hostname H`, cached.
pub fn token(gh: &Path, b: &Binding) -> Result<String, String> {
  let key = (b.host.clone(), b.user.clone());
  if let Some((t, until)) = cache().tokens.get(&key).cloned()
    && Instant::now() < until
  {
    return t.ok_or_else(|| unavailable(b));
  }
  match capability(gh) {
    Capability::Supported => {}
    Capability::Unsupported => return Err(unsupported()),
    Capability::Unknown => return Err(unavailable(b)),
  }
  match gh_plain(gh, &["auth", "token", "--user", &b.user, "--hostname", &b.host]) {
    Ok((true, out, _)) if !out.trim().is_empty() => {
      let t = out.replace(['\r', '\n'], "").trim().to_owned();
      cache().tokens.insert(key, (Some(t.clone()), Instant::now() + POSITIVE_TTL));
      Ok(t)
    }
    // A timeout or spawn failure stays retryable; a definite miss is remembered briefly.
    Err(_) => Err(unavailable(b)),
    Ok(_) => {
      cache().tokens.insert(key, (None, Instant::now() + NEGATIVE_TTL));
      Err(unavailable(b))
    }
  }
}

/// The main checkout of `dir` (a task worktree's), from its git common dir.
fn main_checkout(dir: &Path) -> Option<PathBuf> {
  let out = crate::git::run(dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).ok()?;
  let common = PathBuf::from(String::from_utf8_lossy(&out).trim());
  (common.file_name()? == ".git").then(|| common.parent().map(Path::to_path_buf)).flatten()
}

/// The project's binding: `dir`'s own, else its main checkout's. An unreadable value is no binding.
pub fn binding_in(config: &Path, dir: &Path) -> Option<Binding> {
  let read = |root: &Path| crate::settings::repo_value(config, root, SETTING).filter(|v| !v.is_null());
  let v = read(dir).or_else(|| main_checkout(dir).filter(|m| m != dir).and_then(|m| read(&m)))?;
  match normalize(&v) {
    Some(b) => Some(b),
    None => {
      log::warn!("{SETTING}: not a {{host, user}} account; using gh's own login");
      None
    }
  }
}

/// Sets `cmd` (a gh call for `dir` whose first argument is `first`) to the project's bound login,
/// if it has one; `gh auth …` is never bound.
pub fn bind(cmd: &mut Command, gh: &Path, dir: &Path, first: Option<&str>) -> Result<(), String> {
  if first == Some("auth") {
    return Ok(());
  }
  let Some(config) = crate::system::config_dir() else { return Ok(()) };
  let Some(b) = binding_in(config, dir) else { return Ok(()) };
  apply(cmd, &b, &token(gh, &b)?);
  Ok(())
}

/// The child's environment for a bound call: ambient logins removed, the token in its variable.
pub fn apply(cmd: &mut Command, b: &Binding, token: &str) {
  for k in AMBIENT {
    cmd.env_remove(k);
  }
  cmd.env(token_env_var(&b.host), token).env("GH_PROMPT_DISABLED", "1");
}

/// `gh` run in `dir` under the project's account (the PATH and proxy of
/// [`crate::shell_env::command`]); `first`: the call's first argument.
pub fn command(gh: &Path, dir: &Path, first: Option<&str>) -> Result<Command, String> {
  let mut cmd = crate::shell_env::command(gh);
  cmd.current_dir(dir);
  bind(&mut cmd, gh, dir, first)?;
  Ok(cmd)
}

// ---- the Repository pane ------------------------------------------------------------------------

/// Kingu-only: the bindable login whose name is the owner of `origin` (`git@github.com:me/x`).
pub fn suggested(accounts: &[Account], origin: Option<&str>) -> Option<Binding> {
  let (host, path) = crate::ssh_remote::remote_host_path(origin?)?;
  let owner = path.split('/').next()?;
  let host = if host == "ssh.github.com" { "github.com".to_owned() } else { host };
  accounts.iter().find(|a| a.source == "keyring" && a.host.eq_ignore_ascii_case(&host) && a.user.eq_ignore_ascii_case(owner)).map(|a| Binding { host: a.host.to_ascii_lowercase(), user: a.user.clone() })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
  pub installed: bool,
  pub capability: Capability,
  pub accounts: Vec<Account>,
  pub binding: Option<Binding>,
  pub suggested: Option<Binding>,
}

fn inventory(root: &Path, refresh: bool) -> Inventory {
  let Some(gh) = super::review::gh_bin() else {
    return Inventory { installed: false, capability: Capability::Unknown, accounts: Vec::new(), binding: None, suggested: None };
  };
  if refresh {
    invalidate();
  }
  let capability = capability(&gh);
  let accounts = gh_plain(&gh, &["auth", "status"]).map(|(_, out, err)| parse_auth_status(&format!("{out}\n{err}"))).unwrap_or_default();
  let origin = crate::git::run(root, &["remote", "get-url", "origin"]).ok().map(|o| String::from_utf8_lossy(&o).trim().to_owned());
  Inventory {
    installed: true,
    capability,
    binding: crate::system::config_dir().and_then(|c| binding_in(c, root)),
    suggested: suggested(&accounts, origin.as_deref()),
    accounts,
  }
}

/// Orca `validateGhAccountBinding`: a binding is good only when gh can bind at all, the login is
/// a keyring login on its host here, and its token reads.
pub fn validate(gh: &Path, b: &Binding, accounts: &[Account]) -> Result<(), String> {
  match capability(gh) {
    Capability::Supported => {}
    Capability::Unsupported => return Err(unsupported()),
    Capability::Unknown => return Err("Couldn't tell whether this gh can use a per-project account. Try again.".into()),
  }
  let found = accounts.iter().find(|a| a.host.eq_ignore_ascii_case(&b.host) && a.user.eq_ignore_ascii_case(&b.user)).ok_or_else(|| unavailable(b))?;
  if found.source != "keyring" {
    return Err("A GH_TOKEN or GITHUB_TOKEN login can't be bound to a project: sign in with `gh auth login` instead.".into());
  }
  token(gh, b).map(|_| ())
}

/// The project pane's account list: gh's logins here, the project's binding, the suggestion.
#[tauri::command]
pub async fn gh_accounts(ws: crate::workspace::Workspace, refresh: Option<bool>) -> Result<Inventory, String> {
  let root = ws.root()?;
  tauri::async_runtime::spawn_blocking(move || inventory(&root, refresh.unwrap_or(false))).await.map_err(|e| e.to_string())
}

/// Checks an account before the pane saves it as the project's (the pane writes the repo setting).
#[tauri::command]
pub async fn gh_account_validate(host: String, user: String) -> Result<Binding, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let b = normalize(&serde_json::json!({ "host": host, "user": user })).ok_or("That GitHub account isn't valid.")?;
    let gh = super::review::gh_bin().ok_or_else(super::issues::gh_missing)?;
    let accounts = gh_plain(&gh, &["auth", "status"]).map(|(_, out, err)| parse_auth_status(&format!("{out}\n{err}"))).unwrap_or_default();
    validate(&gh, &b, &accounts)?;
    Ok(b)
  })
  .await
  .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;
  use std::collections::HashMap;

  const STATUS: &str = "github.com\n  ✓ Logged in to github.com account alice (keyring)\n  - Active account: true\n  - Git operations protocol: ssh\n  - Token: gho_************************************\n  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n\n  ✓ Logged in to github.com account alice-work (keyring)\n  - Active account: false\n  - Token scopes: 'repo'\n\n  ✓ Logged in to github.com account ci-bot (GH_TOKEN)\n  - Active account: false\n\nghe.example.com:\n  ✓ Logged in to ghe.example.com account alice (/Users/a/.config/gh/hosts.yml)\n  - Active account: true\n";

  #[test]
  fn gh_auth_status_lists_every_login() {
    let a = parse_auth_status(STATUS);
    let brief: Vec<(&str, &str, bool, &str)> = a.iter().map(|x| (x.host.as_str(), x.user.as_str(), x.active, x.source)).collect();
    assert_eq!(brief, [("github.com", "alice", true, "keyring"), ("github.com", "alice-work", false, "keyring"), ("github.com", "ci-bot", false, "env"), ("ghe.example.com", "alice", true, "keyring")]);
    assert_eq!(a[0].scopes, ["gist", "read:org", "repo", "workflow"]);
    assert_eq!(a[2].env_token.as_deref(), Some("GH_TOKEN"));
    assert!(parse_auth_status("You are not logged into any GitHub hosts. To log in, run: gh auth login").is_empty());
  }

  #[test]
  fn a_binding_is_a_host_and_a_login() {
    assert_eq!(normalize(&json!({ "host": " GitHub.com ", "user": " Alice-Work " })), Some(Binding { host: "github.com".into(), user: "Alice-Work".into() }));
    assert_eq!(normalize(&json!({ "host": "ghe.example.com:8443", "user": "a_b.c" })).map(|b| b.host), Some("ghe.example.com:8443".into()));
    for bad in [json!({ "host": "github.com" }), json!({ "host": "-x", "user": "a" }), json!({ "host": "a/b", "user": "a" }), json!({ "host": "github.com", "user": "a b" }), json!("alice@github.com")] {
      assert_eq!(normalize(&bad), None, "{bad}");
    }
    assert_eq!([token_env_var("github.com"), token_env_var("acme.ghe.com"), token_env_var("ghe.example.com")], ["GH_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN"]);
  }

  #[test]
  fn capability_comes_from_auth_token_help() {
    assert_eq!(capability_of(Ok("  -h, --hostname string\n  -u, --user string".into())), Capability::Supported);
    assert_eq!(capability_of(Ok("  -h, --hostname string".into())), Capability::Unsupported);
    assert_eq!(capability_of(Err("unknown command \"token\" for \"gh auth\"".into())), Capability::Unsupported);
    assert_eq!(capability_of(Err("gh: No such file or directory".into())), Capability::Unknown);
  }

  #[test]
  fn a_bound_call_gets_that_logins_token_and_no_ambient_one() {
    let b = Binding { host: "ghe.example.com".into(), user: "alice".into() };
    let mut cmd = Command::new("gh");
    cmd.env("GH_TOKEN", "ambient").env("GITHUB_TOKEN", "ambient2");
    apply(&mut cmd, &b, "tok");
    let envs: HashMap<String, Option<String>> = cmd.get_envs().map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned()))).collect();
    assert_eq!(envs["GH_ENTERPRISE_TOKEN"].as_deref(), Some("tok"));
    for k in ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_REPO"] {
      assert_eq!(envs[k], None, "{k} removed");
    }
  }

  #[test]
  fn a_task_worktree_uses_its_projects_binding() {
    let config = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path().canonicalize().unwrap();
    let git = |dir: &Path, args: &[&str]| assert!(Command::new("git").current_dir(dir).args(args).output().unwrap().status.success(), "{args:?}");
    git(&root, &["init", "-q"]);
    git(&root, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"]);
    let wt = root.join(".kingu/worktrees/task");
    git(&root, &["worktree", "add", "-q", "-b", "task", wt.to_str().unwrap()]);
    assert_eq!(binding_in(config.path(), &wt), None);
    crate::settings::write_atomic(&crate::settings::repo_path(config.path(), &root), r#"{ "kingu.repo.ghAccount": { "host": "github.com", "user": "alice-work" } }"#).unwrap();
    let want = Some(Binding { host: "github.com".into(), user: "alice-work".into() });
    assert_eq!(binding_in(config.path(), &root), want);
    assert_eq!(binding_in(config.path(), &wt), want);
    // A malformed value is no binding.
    crate::settings::write_atomic(&crate::settings::repo_path(config.path(), &root), r#"{ "kingu.repo.ghAccount": "alice" }"#).unwrap();
    assert_eq!(binding_in(config.path(), &wt), None);
  }

  #[test]
  fn the_suggestion_is_the_login_named_like_origins_owner() {
    let a = parse_auth_status(STATUS);
    assert_eq!(suggested(&a, Some("git@github.com:alice-work/site.git")), Some(Binding { host: "github.com".into(), user: "alice-work".into() }));
    assert_eq!(suggested(&a, Some("https://github.com/Alice/x")).map(|b| b.user), Some("alice".into()));
    // An env-token login can't be bound; another owner or host has none.
    assert_eq!(suggested(&a, Some("https://github.com/ci-bot/x")), None);
    assert_eq!(suggested(&a, Some("https://github.com/acme/x")), None);
    assert_eq!(suggested(&a, None), None);
  }
}
