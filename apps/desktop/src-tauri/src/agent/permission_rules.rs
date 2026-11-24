//! The permission grants Kingu gives a terminal claude it started, kept on record so every one is
//! visible and the persisted ones can be taken back.
//!
//! Scopes (Claude Code's own `updatedPermissions` destinations, PermissionRequest hook output;
//! Claude 2.1.330 accepts `session`, `localSettings`, `projectSettings`, `userSettings`):
//! - `session`: Claude's suggestions with `destination: "session"` (Orca's `allowForSession`,
//!   claude-structured-prompt-replies.ts; hooks.rs `session_grants`). Claude has no way to take a
//!   session rule back from outside the session (a hook answer can carry `removeRules`, but only
//!   to a request that is asked, and the granted call is no longer asked), so the record says it
//!   ends with the session.
//! - `project` → `localSettings` (`.claude/settings.local.json`): Claude's own "Yes, and don't ask
//!   again … in this project", the destination of its suggestions, git-ignored by Claude's design
//!   (its label: "project, gitignored"). Not `projectSettings` (`.claude/settings.json`, shared
//!   with everyone through git). Claude 2.1.330 keeps a linked worktree's local settings in the
//!   main checkout when it owns it (`canonicalGitRoot`), older versions in the working folder, so
//!   both are looked at.
//! - `user` → `userSettings` (`<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json`): Claude's "… in
//!   any project (user settings)".
//!
//! Only allow rules Claude itself suggested go to a settings file: never a folder, a mode, a deny
//! or remove rule, and nothing for a command that leaves the sandbox. Claude writes the file
//! itself (it appends to `permissions.allow`, written `Tool(content)` with `\`, `(` and `)`
//! escaped in the content); Kingu records what it asked for, reads the files back, and on Revoke
//! removes exactly that entry from the file, leaving the rest of the text as it was.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::hooks;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
  Session,
  Project,
  User,
}

impl Scope {
  pub fn parse(s: &str) -> Option<Self> {
    match s {
      "session" => Some(Self::Session),
      "project" => Some(Self::Project),
      "user" => Some(Self::User),
      _ => None,
    }
  }

  /// Claude's `updatedPermissions` destination.
  pub fn destination(self) -> &'static str {
    match self {
      Self::Session => "session",
      Self::Project => "localSettings",
      Self::User => "userSettings",
    }
  }
}

/// What an answer with `scope` grants for a PermissionRequest payload: the grants as the card
/// shows them (`rule:Bash(npm test:*)`, …) and the `updatedPermissions` that apply exactly those.
/// Built from `hooks::session_grants` (the same whitelist); a settings-file scope keeps only its
/// allow rules, sent with Kingu's destination for that scope.
pub fn scoped_grants(request: &Value, scope: Scope) -> (Vec<String>, Vec<Value>) {
  let (keys, updates) = hooks::session_grants(request);
  if scope == Scope::Session {
    return (keys, updates);
  }
  let rules: Vec<Value> = updates
    .iter()
    .filter(|u| u["type"] == "addRules" && u["behavior"] == "allow")
    .flat_map(|u| u["rules"].as_array().cloned().unwrap_or_default())
    .collect();
  let keys: Vec<String> = keys.into_iter().filter(|k| k.starts_with("rule:")).collect();
  if rules.is_empty() || rules.len() != keys.len() {
    return (Vec::new(), Vec::new());
  }
  (keys, vec![json!({ "type": "addRules", "rules": rules, "behavior": "allow", "destination": scope.destination() })])
}

/// Answers the waiting hold with `scope`, granting exactly `shown`. The request on record must
/// still yield exactly those grants for that scope, or it is an error and nothing is answered.
/// `None` when the hook no longer waits; else the request that was answered.
pub fn answer_scoped(file: &Path, hold: &str, scope: Scope, shown: &[String]) -> Result<Option<Value>, String> {
  if !hooks::valid_hold(hold) {
    return Err("invalid hold id".into());
  }
  if !hold_waits(file, hold) {
    return Ok(None);
  }
  let request = hooks::held_request(file, hold)?.ok_or("the permission request is no longer on record")?;
  let (keys, updates) = scoped_grants(&request, scope);
  if keys.is_empty() || keys != shown {
    return Err("the grant does not match the request".into());
  }
  Ok(hooks::answer_hold(file, hold, &hooks::permission_reply_session(updates))?.then_some(request))
}

fn hold_waits(file: &Path, hold: &str) -> bool {
  let base = file.with_extension("");
  let Some(name) = base.file_name().and_then(|n| n.to_str()) else { return false };
  base.with_file_name(format!("{name}.{hold}.wait")).exists()
}

// ---------------------------------------------------------------------------------------------
// Where Claude keeps the rules.

/// Claude's own escaping of a rule's content in a settings file.
pub fn escape_content(content: &str) -> String {
  content.replace('\\', "\\\\").replace('(', "\\(").replace(')', "\\)")
}

/// The ways a rule can be written in `permissions.allow`: Claude's escaped form, and the plain one.
pub fn rule_forms(tool: &str, content: Option<&str>) -> Vec<String> {
  match content.filter(|c| !c.is_empty()) {
    None => vec![tool.to_owned()],
    Some(c) => {
      let escaped = format!("{tool}({})", escape_content(c));
      let plain = format!("{tool}({c})");
      if escaped == plain { vec![plain] } else { vec![escaped, plain] }
    }
  }
}

/// Claude's config folder for a session: the one its transcript is in
/// (`<config>/projects/<project>/<session>.jsonl`), else `CLAUDE_CONFIG_DIR`, else `~/.claude`.
pub fn config_dir(request: &Value, env_dir: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
  let from_transcript = request["transcript_path"].as_str().map(Path::new).and_then(|t| {
    let projects = t.parent()?.parent()?;
    (projects.file_name()? == "projects").then(|| projects.parent().map(Path::to_path_buf)).flatten()
  });
  from_transcript.or(env_dir).or_else(|| home.map(|h| h.join(".claude")))
}

/// The settings files a rule of `scope` may be in. `roots`: the git roots of `cwd` (its top level
/// and the main checkout of a linked worktree).
pub fn settings_files(scope: Scope, cwd: Option<&Path>, config: Option<&Path>, roots: &dyn Fn(&Path) -> Vec<PathBuf>) -> Vec<PathBuf> {
  match scope {
    Scope::Session => Vec::new(),
    Scope::User => config.map(|c| vec![c.join("settings.json")]).unwrap_or_default(),
    Scope::Project => {
      let Some(cwd) = cwd else { return Vec::new() };
      let mut out: Vec<PathBuf> = Vec::new();
      for dir in std::iter::once(cwd.to_path_buf()).chain(roots(cwd)) {
        let f = dir.join(".claude").join("settings.local.json");
        if !out.contains(&f) {
          out.push(f);
        }
      }
      out
    }
  }
}

fn git(dir: &Path, args: &[&str]) -> Option<std::process::Output> {
  crate::shell_env::command("git").arg("-C").arg(dir).args(args).stdin(std::process::Stdio::null()).output().ok()
}

/// `cwd`'s git top level and, for a linked worktree, the main checkout.
pub fn git_roots(cwd: &Path) -> Vec<PathBuf> {
  let Some(out) = git(cwd, &["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]).filter(|o| o.status.success()) else { return Vec::new() };
  let text = String::from_utf8_lossy(&out.stdout);
  let mut lines = text.lines();
  let mut roots = Vec::new();
  if let Some(top) = lines.next().filter(|l| !l.is_empty()) {
    roots.push(PathBuf::from(top));
  }
  if let Some(common) = lines.next().map(PathBuf::from) {
    if common.file_name().is_some_and(|n| n == ".git") {
      if let Some(main) = common.parent() {
        roots.push(main.to_path_buf());
      }
    }
  }
  roots
}

/// Git would track `file` (already in the index, or inside a work tree and not ignored).
pub fn git_would_track(file: &Path) -> bool {
  // The nearest folder that exists (`.claude` may not yet).
  let Some(dir) = file.ancestors().skip(1).find(|d| d.is_dir()) else { return false };
  let path = file.to_string_lossy();
  if git(dir, &["ls-files", "--error-unmatch", "--", &path]).is_some_and(|o| o.status.success()) {
    return true;
  }
  // check-ignore: 0 ignored, 1 not ignored, 128 not in a repository.
  git(dir, &["check-ignore", "-q", "--", &path]).and_then(|o| o.status.code()) == Some(1)
}

// ---------------------------------------------------------------------------------------------
// `permissions.allow` in a settings file, found by position so an edit touches nothing else.
// Settings files may carry comments and trailing commas (JSONC); both are read as Claude does.

#[derive(Debug)]
enum Node {
  Obj(Vec<(String, Span)>),
  Arr(Vec<Span>),
  Str(String),
  Other,
}

#[derive(Debug)]
struct Span {
  start: usize,
  end: usize,
  node: Node,
}

struct Scan<'a> {
  b: &'a [u8],
  i: usize,
}

const MAX_DEPTH: usize = 64;

impl Scan<'_> {
  fn ws(&mut self) -> Result<(), String> {
    loop {
      match self.b.get(self.i) {
        Some(b' ' | b'\t' | b'\n' | b'\r') => self.i += 1,
        Some(b'/') if self.b.get(self.i + 1) == Some(&b'/') => {
          while self.b.get(self.i).is_some_and(|&c| c != b'\n') {
            self.i += 1;
          }
        }
        Some(b'/') if self.b.get(self.i + 1) == Some(&b'*') => {
          let rest = &self.b[self.i + 2..];
          let end = rest.windows(2).position(|w| w == b"*/").ok_or("unclosed comment")?;
          self.i += 2 + end + 2;
        }
        _ => return Ok(()),
      }
    }
  }

  fn string(&mut self) -> Result<String, String> {
    let start = self.i;
    self.i += 1;
    loop {
      match self.b.get(self.i) {
        None => return Err("unclosed string".into()),
        Some(b'\\') => self.i += 2,
        Some(b'"') => {
          self.i += 1;
          let raw = std::str::from_utf8(&self.b[start..self.i]).map_err(|e| e.to_string())?;
          return serde_json::from_str(raw).map_err(|e| e.to_string());
        }
        Some(_) => self.i += 1,
      }
    }
  }

  fn value(&mut self, depth: usize) -> Result<Span, String> {
    if depth > MAX_DEPTH {
      return Err("nested too deep".into());
    }
    self.ws()?;
    let start = self.i;
    let node = match self.b.get(self.i) {
      Some(b'{') => {
        self.i += 1;
        let mut members = Vec::new();
        loop {
          self.ws()?;
          match self.b.get(self.i) {
            Some(b'}') => break,
            Some(b'"') => {}
            _ => return Err(format!("unexpected byte at {}", self.i)),
          }
          let key = self.string()?;
          self.ws()?;
          if self.b.get(self.i) != Some(&b':') {
            return Err(format!("expected ':' at {}", self.i));
          }
          self.i += 1;
          members.push((key, self.value(depth + 1)?));
          self.ws()?;
          match self.b.get(self.i) {
            Some(b',') => self.i += 1,
            Some(b'}') => break,
            _ => return Err(format!("expected ',' or '}}' at {}", self.i)),
          }
        }
        self.i += 1;
        Node::Obj(members)
      }
      Some(b'[') => {
        self.i += 1;
        let mut items = Vec::new();
        loop {
          self.ws()?;
          if self.b.get(self.i) == Some(&b']') {
            break;
          }
          items.push(self.value(depth + 1)?);
          self.ws()?;
          match self.b.get(self.i) {
            Some(b',') => self.i += 1,
            Some(b']') => break,
            _ => return Err(format!("expected ',' or ']' at {}", self.i)),
          }
        }
        self.i += 1;
        Node::Arr(items)
      }
      Some(b'"') => Node::Str(self.string()?),
      Some(c) if c.is_ascii_alphanumeric() || *c == b'-' => {
        while self.b.get(self.i).is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'+' | b'.')) {
          self.i += 1;
        }
        Node::Other
      }
      _ => return Err(format!("unexpected byte at {}", self.i)),
    };
    Ok(Span { start, end: self.i, node })
  }
}

fn parse(text: &str) -> Result<Span, String> {
  let mut s = Scan { b: text.as_bytes(), i: 0 };
  // A UTF-8 byte order mark is not part of the document.
  if text.starts_with('\u{feff}') {
    s.i = 3;
  }
  let root = s.value(0)?;
  s.ws()?;
  if s.i != text.len() {
    return Err("text after the settings object".into());
  }
  Ok(root)
}

/// The `permissions.allow` array's items (the last of a repeated key wins, as in JSON.parse).
fn allow_items(root: &Span) -> Option<&Vec<Span>> {
  let Node::Obj(members) = &root.node else { return None };
  let (_, perms) = members.iter().rev().find(|(k, _)| k == "permissions")?;
  let Node::Obj(members) = &perms.node else { return None };
  let (_, allow) = members.iter().rev().find(|(k, _)| k == "allow")?;
  match &allow.node {
    Node::Arr(items) => Some(items),
    _ => None,
  }
}

fn item_is(item: &Span, forms: &[String]) -> bool {
  matches!(&item.node, Node::Str(s) if forms.iter().any(|f| f == s))
}

/// The settings text's allow rules (strings only).
pub fn allow_rules(text: &str) -> Result<Vec<String>, String> {
  let root = parse(text)?;
  Ok(allow_items(&root).map(|items| items.iter().filter_map(|i| if let Node::Str(s) = &i.node { Some(s.clone()) } else { None }).collect()).unwrap_or_default())
}

/// `text` without the allow entries written as any of `forms`, everything else byte for byte;
/// `None` when there is none.
pub fn remove_allow_rule(text: &str, forms: &[String]) -> Result<Option<String>, String> {
  let mut out = text.to_owned();
  let mut removed = 0;
  loop {
    let root = parse(&out)?;
    let Some(items) = allow_items(&root) else { break };
    let Some(k) = items.iter().position(|i| item_is(i, forms)) else { break };
    let range = if k + 1 < items.len() {
      // The item, its comma and the space up to the next one.
      items[k].start..items[k + 1].start
    } else if k > 0 {
      // The last one: from the end of the one before (its comma goes too).
      items[k - 1].end..items[k].end
    } else {
      items[k].start..items[k].end
    };
    out.replace_range(range, "");
    removed += 1;
    if removed > 10_000 {
      return Err("too many entries".into());
    }
  }
  if removed == 0 {
    return Ok(None);
  }
  // The result says the same as before less those entries, or nothing is written.
  let before = allow_rules(text)?;
  let after = allow_rules(&out)?;
  let expected: Vec<String> = before.into_iter().filter(|r| !forms.contains(r)).collect();
  if after != expected {
    return Err("the edit would change more than that rule".into());
  }
  if let Ok(mut v) = serde_json::from_str::<Value>(text) {
    if let Some(a) = v.pointer_mut("/permissions/allow").and_then(Value::as_array_mut) {
      a.retain(|x| !x.as_str().is_some_and(|s| forms.iter().any(|f| f == s)));
    }
    if serde_json::from_str::<Value>(&out).ok() != Some(v) {
      return Err("the edit would change more than that rule".into());
    }
  }
  Ok(Some(out))
}

/// Settings files are small; past this Kingu does not edit one.
const MAX_SETTINGS: usize = 4 * 1024 * 1024;

/// Removes the rule from `path` (a symlink's target is edited in place), written whole and
/// renamed over it with its permissions. False when the file does not hold it.
pub fn revoke_in_file(path: &Path, forms: &[String]) -> Result<bool, String> {
  let real = match std::fs::canonicalize(path) {
    Ok(p) => p,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
    Err(e) => return Err(format!("{}: {e}", path.display())),
  };
  let bytes = std::fs::read(&real).map_err(|e| format!("{}: {e}", real.display()))?;
  if bytes.len() > MAX_SETTINGS {
    return Err(format!("{}: too large", real.display()));
  }
  let text = String::from_utf8(bytes).map_err(|_| format!("{}: not UTF-8", real.display()))?;
  let Some(out) = remove_allow_rule(&text, forms).map_err(|e| format!("{}: {e}", real.display()))? else { return Ok(false) };
  let dir = real.parent().ok_or("settings file has no folder")?;
  let name = real.file_name().and_then(|n| n.to_str()).unwrap_or("settings.json");
  let tmp = dir.join(format!(".{name}.kingu-{}.tmp", std::process::id()));
  let result = (|| -> Result<(), String> {
    use std::io::Write;
    let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(out.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    if let Ok(meta) = std::fs::metadata(&real) {
      std::fs::set_permissions(&tmp, meta.permissions()).map_err(|e| e.to_string())?;
    }
    // Claude may have written the file meanwhile: then nothing is replaced.
    if std::fs::read(&real).map_err(|e| e.to_string())? != text.as_bytes() {
      return Err("the file changed while it was being edited; try again".into());
    }
    std::fs::rename(&tmp, &real).map_err(|e| e.to_string())
  })();
  if let Err(e) = result {
    let _ = std::fs::remove_file(&tmp);
    return Err(format!("{}: {e}", real.display()));
  }
  Ok(true)
}

fn file_has(path: &Path, forms: &[String]) -> bool {
  std::fs::read_to_string(path).ok().and_then(|t| allow_rules(&t).ok()).is_some_and(|rules| rules.iter().any(|r| forms.contains(r)))
}

// ---------------------------------------------------------------------------------------------
// Kingu's record of what it granted (`<app data>/agent-permission-grants.json`).

const LEDGER: &str = "agent-permission-grants.json";
const MAX_RECORDS: usize = 500;
const MAX_DETAIL: usize = 300;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Granted {
  pub id: String,
  pub scope: Scope,
  /// As the card showed it (`rule:Bash(npm test:*)`, `dir:/w`, `mode:acceptEdits`).
  pub grant: String,
  /// For a rule: the tool and its content, as Claude writes them.
  #[serde(default)]
  pub tool_name: Option<String>,
  #[serde(default)]
  pub rule_content: Option<String>,
  /// What was asked when it was granted (tool, command or path).
  #[serde(default)]
  pub tool: Option<String>,
  #[serde(default)]
  pub detail: Option<String>,
  /// Claude's working folder and config folder of that session.
  #[serde(default)]
  pub cwd: Option<String>,
  #[serde(default)]
  pub config_dir: Option<String>,
  /// The session's hook token (session grants: live while its hook file is).
  #[serde(default)]
  pub token: Option<String>,
  pub at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Ledger {
  #[serde(default)]
  grants: Vec<Granted>,
}

fn read_ledger(path: &Path) -> Ledger {
  std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn write_ledger(path: &Path, ledger: &Ledger) -> Result<(), String> {
  let text = serde_json::to_string_pretty(ledger).map_err(|e| e.to_string())?;
  crate::settings::write_atomic(path, &text)
}

fn ledger_lock() -> std::sync::MutexGuard<'static, ()> {
  static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
  LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
  std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn new_id(seed: &str) -> String {
  use std::sync::atomic::{AtomicU64, Ordering};
  static N: AtomicU64 = AtomicU64::new(0);
  let n = N.fetch_add(1, Ordering::Relaxed);
  crate::snap::sha256_hex(format!("{seed}:{}:{n}:{}", now_ms(), std::process::id()).as_bytes())[..16].to_owned()
}

fn clip(s: &str, max: usize) -> String {
  if s.chars().count() > max { format!("{}…", s.chars().take(max).collect::<String>()) } else { s.to_owned() }
}

/// The records an answer with `scope` adds: one per grant.
pub fn records_for(request: &Value, scope: Scope, token: &str, config: Option<&Path>, at: u64) -> Vec<Granted> {
  let (keys, updates) = scoped_grants(request, scope);
  let rules: Vec<&Value> = updates.iter().filter(|u| u["type"] == "addRules").flat_map(|u| u["rules"].as_array().into_iter().flatten()).collect();
  let mut rule = rules.into_iter();
  let detail = request["tool_input"].as_object().and_then(|i| ["command", "file_path", "path", "url", "pattern"].iter().find_map(|k| i.get(*k)?.as_str())).map(|d| clip(d, MAX_DETAIL));
  keys
    .into_iter()
    .map(|grant| {
      let r = grant.starts_with("rule:").then(|| rule.next()).flatten();
      Granted {
        id: new_id(&grant),
        scope,
        tool_name: r.and_then(|r| r["toolName"].as_str().map(str::to_owned)),
        rule_content: r.and_then(|r| r["ruleContent"].as_str().map(str::to_owned)),
        grant,
        tool: request["tool_name"].as_str().map(str::to_owned),
        detail: detail.clone(),
        cwd: request["cwd"].as_str().map(str::to_owned),
        config_dir: config.map(|c| c.display().to_string()),
        token: (scope == Scope::Session).then(|| token.to_owned()),
        at,
      }
    })
    .collect()
}

/// Adds records, keeping at most `MAX_RECORDS` (the oldest session ones go first).
fn remember(path: &Path, records: Vec<Granted>) -> Result<(), String> {
  let _g = ledger_lock();
  let mut ledger = read_ledger(path);
  ledger.grants.extend(records);
  while ledger.grants.len() > MAX_RECORDS {
    let i = ledger.grants.iter().position(|g| g.scope == Scope::Session).unwrap_or(0);
    ledger.grants.remove(i);
  }
  write_ledger(path, &ledger)
}

#[derive(Debug, Serialize)]
pub struct GrantView {
  #[serde(flatten)]
  pub granted: Granted,
  /// A session grant: its session still runs (its hook file is there).
  pub live: bool,
  /// A persisted rule: the settings file that holds it now (none: not found there).
  pub file: Option<String>,
  /// The files Claude may have written it to.
  pub files: Vec<String>,
  /// Git would track the file that holds it (a commit would share the rule).
  pub tracked: bool,
}

impl Granted {
  fn forms(&self) -> Vec<String> {
    self.tool_name.as_deref().map(|t| rule_forms(t, self.rule_content.as_deref())).unwrap_or_default()
  }

  fn files(&self, roots: &dyn Fn(&Path) -> Vec<PathBuf>) -> Vec<PathBuf> {
    settings_files(self.scope, self.cwd.as_deref().map(Path::new), self.config_dir.as_deref().map(Path::new), roots)
  }
}

/// The records, each with where it stands; session records whose session ended are dropped.
pub fn list(path: &Path, session_live: &dyn Fn(&str) -> bool, roots: &dyn Fn(&Path) -> Vec<PathBuf>, tracked: &dyn Fn(&Path) -> bool) -> Result<Vec<GrantView>, String> {
  let _g = ledger_lock();
  let mut ledger = read_ledger(path);
  let before = ledger.grants.len();
  ledger.grants.retain(|g| g.scope != Scope::Session || g.token.as_deref().is_some_and(session_live));
  if ledger.grants.len() != before {
    write_ledger(path, &ledger)?;
  }
  Ok(ledger
    .grants
    .iter()
    .rev()
    .map(|g| {
      let files = g.files(roots);
      let forms = g.forms();
      let file = files.iter().find(|f| !forms.is_empty() && file_has(f, &forms)).cloned();
      GrantView {
        live: g.scope == Scope::Session,
        tracked: file.as_deref().is_some_and(tracked),
        file: file.map(|f| f.display().to_string()),
        files: files.iter().map(|f| f.display().to_string()).collect(),
        granted: g.clone(),
      }
    })
    .collect())
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Revoked {
  /// The files the rule was removed from (none: it was no longer in any, the record is dropped).
  pub files: Vec<String>,
}

/// Revokes a persisted rule: removed from every file of its scope that holds it, then the record
/// goes. A session grant cannot be revoked (an error, nothing changes).
pub fn revoke(path: &Path, id: &str, roots: &dyn Fn(&Path) -> Vec<PathBuf>) -> Result<Revoked, String> {
  let _g = ledger_lock();
  let mut ledger = read_ledger(path);
  let i = ledger.grants.iter().position(|g| g.id == id).ok_or("no such grant")?;
  let g = &ledger.grants[i];
  if g.scope == Scope::Session {
    return Err("a session grant ends with its session; Claude takes no answer that removes it".into());
  }
  let forms = g.forms();
  if forms.is_empty() {
    return Err("this grant names no rule".into());
  }
  let mut files = Vec::new();
  for f in g.files(roots) {
    if revoke_in_file(&f, &forms)? {
      files.push(f.display().to_string());
    }
  }
  ledger.grants.remove(i);
  write_ledger(path, &ledger)?;
  Ok(Revoked { files })
}

// ---------------------------------------------------------------------------------------------
// Commands.

fn ledger_path(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(LEDGER))
}

fn home() -> Option<PathBuf> {
  std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

fn env_config_dir() -> Option<PathBuf> {
  std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Answers the waiting hold of session `token` for `scope` (`agent_permission_answer` with a
/// grant) and records what was granted. False when the hook no longer waits.
pub fn answer_and_record(app: &AppHandle, token: &str, file: &Path, hold: &str, scope: Scope, shown: &[String]) -> Result<bool, String> {
  let Some(request) = answer_scoped(file, hold, scope, shown)? else { return Ok(false) };
  let config = config_dir(&request, env_config_dir(), home());
  let records = records_for(&request, scope, token, config.as_deref(), now_ms());
  if let Err(e) = ledger_path(app).and_then(|p| remember(&p, records)) {
    log::warn!("permission grants record: {e}");
  }
  Ok(true)
}

#[derive(Debug, Serialize, Default)]
pub struct ScopeFiles {
  /// The files a rule of this scope may be saved to.
  pub files: Vec<String>,
  /// Git would track one of them.
  pub tracked: bool,
}

#[derive(Debug, Serialize, Default)]
pub struct Scopes {
  pub project: Option<ScopeFiles>,
  pub user: Option<ScopeFiles>,
}

/// Where "Always allow in this project" / "Always allow" would save the waiting request's rules,
/// and whether git would track that file; none when Claude suggested no allow rule.
#[tauri::command]
pub async fn agent_permission_scopes(app: AppHandle, token: String, hold: String) -> Result<Scopes, String> {
  let file = hooks::file_of(&app, &token)?;
  tauri::async_runtime::spawn_blocking(move || {
    let Some(request) = hooks::held_request(&file, &hold)? else { return Ok(Scopes::default()) };
    if scoped_grants(&request, Scope::Project).0.is_empty() {
      return Ok(Scopes::default());
    }
    let cwd = request["cwd"].as_str().map(PathBuf::from);
    let config = config_dir(&request, env_config_dir(), home());
    let info = |scope| {
      let files = settings_files(scope, cwd.as_deref(), config.as_deref(), &git_roots);
      ScopeFiles { tracked: files.iter().any(|f| git_would_track(f)), files: files.iter().map(|f| f.display().to_string()).collect() }
    };
    Ok(Scopes { project: cwd.is_some().then(|| info(Scope::Project)), user: config.is_some().then(|| info(Scope::User)) })
  })
  .await
  .map_err(|e| e.to_string())?
}

/// Every grant Kingu gave a terminal claude that still stands: live sessions' grants and the
/// rules it had Claude save, read back from the settings files.
#[tauri::command]
pub async fn agent_permission_grants(app: AppHandle) -> Result<Vec<GrantView>, String> {
  let path = ledger_path(&app)?;
  let live = move |token: &str| hooks::file_of(&app, token).is_ok_and(|f| f.exists());
  tauri::async_runtime::spawn_blocking(move || list(&path, &live, &git_roots, &git_would_track)).await.map_err(|e| e.to_string())?
}

/// Removes a rule Kingu had Claude save from its settings file.
#[tauri::command]
pub async fn agent_permission_revoke(app: AppHandle, id: String) -> Result<Revoked, String> {
  let path = ledger_path(&app)?;
  tauri::async_runtime::spawn_blocking(move || revoke(&path, &id, &git_roots)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;

  fn request() -> Value {
    json!({ "hook_event_name": "PermissionRequest", "cwd": "/w/task", "transcript_path": "/cfg/projects/-w-task/s.jsonl", "tool_name": "Bash", "tool_input": { "command": "npm test" }, "permission_suggestions": [
      { "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "npm test:*" }, { "toolName": "mcp__x__y" }], "behavior": "allow", "destination": "localSettings" },
      { "type": "addDirectories", "directories": ["/w"], "destination": "localSettings" },
      { "type": "setMode", "mode": "acceptEdits", "destination": "session" },
      { "type": "setMode", "mode": "bypassPermissions", "destination": "userSettings" },
      { "type": "addRules", "rules": [{ "toolName": "Bash" }], "behavior": "deny", "destination": "userSettings" },
      { "type": "removeRules", "rules": [{ "toolName": "Bash" }], "behavior": "deny", "destination": "projectSettings" },
      { "type": "replaceRules", "rules": [{ "toolName": "Bash" }], "behavior": "allow", "destination": "userSettings" },
    ] })
  }

  #[test]
  fn each_destination_keeps_only_whitelisted_allow_rules() {
    let r = request();
    let (keys, updates) = scoped_grants(&r, Scope::Session);
    assert_eq!(keys, ["rule:Bash(npm test:*)", "rule:mcp__x__y", "dir:/w", "mode:acceptEdits"]);
    assert!(updates.iter().all(|u| u["destination"] == "session"));
    for (scope, dest) in [(Scope::Project, "localSettings"), (Scope::User, "userSettings")] {
      let (keys, updates) = scoped_grants(&r, scope);
      assert_eq!(keys, ["rule:Bash(npm test:*)", "rule:mcp__x__y"], "{scope:?}");
      assert_eq!(updates, vec![json!({ "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "npm test:*" }, { "toolName": "mcp__x__y" }], "behavior": "allow", "destination": dest })]);
    }
    // No allow rule suggested (folders and modes only), or a command leaving the sandbox: nothing to save.
    let only_dirs = json!({ "permission_suggestions": [{ "type": "addDirectories", "directories": ["/w"] }, { "type": "setMode", "mode": "acceptEdits" }] });
    assert!(scoped_grants(&only_dirs, Scope::Project).0.is_empty());
    assert!(!scoped_grants(&only_dirs, Scope::Session).0.is_empty());
    let mut out = r.clone();
    out["tool_input"]["dangerouslyDisableSandbox"] = true.into();
    for scope in [Scope::Session, Scope::Project, Scope::User] {
      assert!(scoped_grants(&out, scope).0.is_empty());
    }
    assert_eq!(Scope::parse("project"), Some(Scope::Project));
    assert_eq!(Scope::parse("projectSettings"), None);
  }

  fn held(dir: &Path, request: &Value) -> (PathBuf, String) {
    let file = dir.join("tok12345.jsonl");
    let hold = "1795160000-4242";
    let mut line = request.to_string();
    line.replace_range(..1, &format!("{{\"kingu_hold\":\"{hold}\","));
    std::fs::write(&file, format!("{line}\n")).unwrap();
    std::fs::write(dir.join(format!("tok12345.{hold}.wait")), b"").unwrap();
    (file, hold.to_owned())
  }

  fn answered(dir: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(dir.join("tok12345.1795160000-4242.answer")).ok()?).ok()
  }

  #[test]
  fn a_scoped_answer_must_match_the_request_and_its_scope() {
    let dir = tempfile::tempdir().unwrap();
    let r = request();
    let (file, hold) = held(dir.path(), &r);
    let session: Vec<String> = scoped_grants(&r, Scope::Session).0;
    let rules: Vec<String> = scoped_grants(&r, Scope::Project).0;
    // The session's grants sent for a settings scope, a rule list for the session, a partial list: refused.
    assert!(answer_scoped(&file, &hold, Scope::Project, &session).is_err());
    assert!(answer_scoped(&file, &hold, Scope::Session, &rules).is_err());
    assert!(answer_scoped(&file, &hold, Scope::User, &rules[..1]).is_err());
    assert!(answer_scoped(&file, &hold, Scope::User, &[]).is_err());
    assert!(answered(dir.path()).is_none());
    assert!(answer_scoped(&file, "../x", Scope::User, &rules).is_err());
    let got = answer_scoped(&file, &hold, Scope::User, &rules).unwrap().unwrap();
    assert_eq!(got["tool_name"], "Bash");
    assert_eq!(answered(dir.path()).unwrap()["hookSpecificOutput"]["decision"], json!({ "behavior": "allow", "updatedPermissions": [
      { "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "npm test:*" }, { "toolName": "mcp__x__y" }], "behavior": "allow", "destination": "userSettings" },
    ] }));
    // A hold that ended takes nothing.
    std::fs::remove_file(dir.path().join("tok12345.1795160000-4242.wait")).unwrap();
    assert_eq!(answer_scoped(&file, &hold, Scope::User, &rules).unwrap(), None);
  }

  #[test]
  fn files_follow_claudes_settings_sources() {
    let r = request();
    let config = config_dir(&r, Some("/env".into()), Some("/home/u".into())).unwrap();
    assert_eq!(config, Path::new("/cfg"));
    assert_eq!(config_dir(&json!({}), Some("/env".into()), Some("/home/u".into())).unwrap(), Path::new("/env"));
    assert_eq!(config_dir(&json!({ "transcript_path": "/x/s.jsonl" }), None, Some("/home/u".into())).unwrap(), Path::new("/home/u/.claude"));
    let roots = |_: &Path| vec![PathBuf::from("/w/task"), PathBuf::from("/repo")];
    assert_eq!(settings_files(Scope::User, None, Some(&config), &roots), [PathBuf::from("/cfg/settings.json")]);
    assert_eq!(settings_files(Scope::Project, Some(Path::new("/w/task")), None, &roots), [PathBuf::from("/w/task/.claude/settings.local.json"), PathBuf::from("/repo/.claude/settings.local.json")]);
    assert!(settings_files(Scope::Session, Some(Path::new("/w")), Some(&config), &roots).is_empty());
    assert_eq!(rule_forms("Bash", Some("npm test:*")), ["Bash(npm test:*)"]);
    assert_eq!(rule_forms("Bash", Some("echo (a)")), [r"Bash(echo \(a\))", "Bash(echo (a))"]);
    assert_eq!(rule_forms("WebFetch", None), ["WebFetch"]);
  }

  #[test]
  fn removing_a_rule_leaves_the_rest_of_the_text() {
    let forms = vec!["Bash(npm test:*)".to_owned()];
    let text = "{\n  \"permissions\": {\n    \"allow\": [\n      \"Read(*)\",\n      \"Bash(npm test:*)\",\n      \"WebFetch\"\n    ],\n    \"deny\": [\"Bash(npm test:*)\"]\n  },\n  \"model\":   \"opus\"\n}\n";
    let out = remove_allow_rule(text, &forms).unwrap().unwrap();
    assert_eq!(out, "{\n  \"permissions\": {\n    \"allow\": [\n      \"Read(*)\",\n      \"WebFetch\"\n    ],\n    \"deny\": [\"Bash(npm test:*)\"]\n  },\n  \"model\":   \"opus\"\n}\n");
    // Last, only, repeated, with comments and a trailing comma.
    assert_eq!(remove_allow_rule(r#"{"permissions":{"allow":["a","Bash(npm test:*)"]}}"#, &forms).unwrap().unwrap(), r#"{"permissions":{"allow":["a"]}}"#);
    assert_eq!(remove_allow_rule(r#"{"permissions":{"allow":[ "Bash(npm test:*)" ]}}"#, &forms).unwrap().unwrap(), r#"{"permissions":{"allow":[  ]}}"#);
    assert_eq!(remove_allow_rule(r#"{"permissions":{"allow":["Bash(npm test:*)","x","Bash(npm test:*)"]}}"#, &forms).unwrap().unwrap(), r#"{"permissions":{"allow":["x"]}}"#);
    let jsonc = "// mine\n{ \"permissions\": { /* keep */ \"allow\": [\"Bash(npm test:*)\", \"x\",], }, }\n";
    assert_eq!(remove_allow_rule(jsonc, &forms).unwrap().unwrap(), "// mine\n{ \"permissions\": { /* keep */ \"allow\": [\"x\",], }, }\n");
    // Not there, not in allow, or not a settings object: nothing to remove; broken text is an error.
    assert_eq!(remove_allow_rule(r#"{"permissions":{"deny":["Bash(npm test:*)"]}}"#, &forms).unwrap(), None);
    assert_eq!(remove_allow_rule(r#"{"allow":["Bash(npm test:*)"]}"#, &forms).unwrap(), None);
    assert!(remove_allow_rule(r#"{"permissions":{"allow":["Bash(npm test:*)""#, &forms).is_err());
    // An escaped string that decodes to the rule counts; one that does not, does not.
    assert_eq!(remove_allow_rule(r#"{"permissions":{"allow":["Bash(npm test:*)"]}}"#, &forms).unwrap().unwrap(), r#"{"permissions":{"allow":[]}}"#);
  }

  #[test]
  fn grant_record_and_revoke_round_trip_on_temp_files() {
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().join("task");
    let cfg = tmp.path().join("cfg");
    std::fs::create_dir_all(cwd.join(".claude")).unwrap();
    std::fs::create_dir_all(cfg.join("projects/p")).unwrap();
    let mut r = request();
    r["cwd"] = json!(cwd.display().to_string());
    r["transcript_path"] = json!(cfg.join("projects/p/s.jsonl").display().to_string());
    let ledger = tmp.path().join(LEDGER);
    let config = config_dir(&r, None, None);
    remember(&ledger, records_for(&r, Scope::Project, "tok12345", config.as_deref(), 1)).unwrap();
    remember(&ledger, records_for(&r, Scope::User, "tok12345", config.as_deref(), 2)).unwrap();
    remember(&ledger, records_for(&r, Scope::Session, "tok12345", config.as_deref(), 3)).unwrap();
    // What Claude writes after the answer (its format), with a rule of the person's own beside it.
    let local = cwd.join(".claude/settings.local.json");
    std::fs::write(&local, "{\n  \"permissions\": {\n    \"allow\": [\n      \"Read(*)\",\n      \"Bash(npm test:*)\",\n      \"mcp__x__y\"\n    ]\n  }\n}").unwrap();
    let user = cfg.join("settings.json");
    std::fs::write(&user, "{\n  \"theme\": \"dark\",\n  \"permissions\": { \"allow\": [\"Bash(npm test:*)\"] }\n}\n").unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      std::fs::set_permissions(&user, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let no_roots = |_: &Path| Vec::new();
    let views = list(&ledger, &|t| t == "tok12345", &no_roots, &|_| false).unwrap();
    assert_eq!(views.len(), 2 + 2 + 4);
    let find = |scope: Scope, grant: &str| views.iter().find(|v| v.granted.scope == scope && v.granted.grant == grant).unwrap();
    assert_eq!(find(Scope::Project, "rule:Bash(npm test:*)").file.as_deref(), Some(local.display().to_string().as_str()));
    assert_eq!(find(Scope::User, "rule:mcp__x__y").file, None, "not in the user file");
    assert!(find(Scope::Session, "mode:acceptEdits").live);
    // A session grant cannot be revoked.
    assert!(revoke(&ledger, &find(Scope::Session, "dir:/w").granted.id, &no_roots).is_err());
    // Revoke the project rule: exactly that entry goes, the person's own stays.
    let id = find(Scope::Project, "rule:Bash(npm test:*)").granted.id.clone();
    assert_eq!(revoke(&ledger, &id, &no_roots).unwrap().files, [local.display().to_string()]);
    assert_eq!(std::fs::read_to_string(&local).unwrap(), "{\n  \"permissions\": {\n    \"allow\": [\n      \"Read(*)\",\n      \"mcp__x__y\"\n    ]\n  }\n}");
    let id = find(Scope::User, "rule:Bash(npm test:*)").granted.id.clone();
    revoke(&ledger, &id, &no_roots).unwrap();
    assert_eq!(std::fs::read_to_string(&user).unwrap(), "{\n  \"theme\": \"dark\",\n  \"permissions\": { \"allow\": [] }\n}\n");
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(std::fs::metadata(&user).unwrap().permissions().mode() & 0o777, 0o600, "the file keeps its permissions");
    }
    // A rule no longer in any file: Revoke only drops the record.
    let id = find(Scope::User, "rule:mcp__x__y").granted.id.clone();
    assert!(revoke(&ledger, &id, &no_roots).unwrap().files.is_empty());
    // The session ended: its grants leave the list.
    let views = list(&ledger, &|_| false, &no_roots, &|_| false).unwrap();
    assert_eq!(views.iter().map(|v| v.granted.grant.as_str()).collect::<Vec<_>>(), ["rule:mcp__x__y"]);
    assert!(revoke(&ledger, "nope", &no_roots).is_err());
    // Nothing else was left in the folders.
    let names: Vec<String> = std::fs::read_dir(cwd.join(".claude")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, ["settings.local.json"]);
  }

  #[cfg(unix)]
  #[test]
  fn a_symlinked_settings_file_is_edited_at_its_target() {
    let tmp = tempfile::tempdir().unwrap();
    let real = tmp.path().join("dotfiles-settings.json");
    std::fs::write(&real, r#"{"permissions":{"allow":["WebFetch","x"]}}"#).unwrap();
    let link = tmp.path().join("settings.json");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    assert!(revoke_in_file(&link, &["WebFetch".to_owned()]).unwrap());
    assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    assert_eq!(std::fs::read_to_string(&real).unwrap(), r#"{"permissions":{"allow":["x"]}}"#);
    assert!(!revoke_in_file(&tmp.path().join("missing.json"), &["x".to_owned()]).unwrap());
  }

  #[test]
  fn git_tracking_of_a_settings_file() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    let ok = std::process::Command::new("git").arg("-C").arg(repo).args(["init", "-q"]).status().is_ok_and(|s| s.success());
    if !ok {
      return; // no git here
    }
    let local = repo.join(".claude/settings.local.json");
    assert!(git_would_track(&local), "not ignored: git would track it");
    std::fs::write(repo.join(".gitignore"), ".claude/settings.local.json\n").unwrap();
    assert!(!git_would_track(&local));
    assert!(git_roots(repo).iter().any(|r| r.ends_with(repo.file_name().unwrap())));
  }
}
