//! Which MCP servers may run: VS Code's MCP access and allow/deny lists, with the 1.145 rule that
//! a managed allowlist is authoritative.
//!
//! VS Code (src/vs/platform/mcp/common/allowedMcpServers.ts, allowedMcpServersService.ts):
//! - `chat.mcp.access` (`none` | `registry` | `all`, mcpManagement.ts `mcpAccessConfig`): `none`
//!   turns every server off.
//! - `chat.mcp.allowedServers` / `chat.mcp.deniedServers` (`mcpAllowedServersConfig`,
//!   `mcpDeniedServersConfig`): lists of `{ serverName }`, `{ serverUrl }` (with `*` wildcards) or
//!   `{ serverCommand: [command, ...args] }` (exact). Deny always wins; an unset allowlist allows
//!   everything, an empty one nothing (`checkMcpServerAllowed`). A name entry stands in only when
//!   the list has no entry of the server's own transport (URL for remote, command for stdio).
//! - Enterprise-managed settings (src/vs/platform/policy/common/copilotManagedSettings.ts):
//!   `allowedMcpServers`, `deniedMcpServers` and `allowManagedMcpServersOnly`. A managed value wins
//!   over the user's (`getValue`); with `allowManagedMcpServersOnly` the allowlist is the managed
//!   one only (absent: empty) and the denylist is every source's together (`getPolicyLists`).
//! - 1.145, "Managed MCP allowlist precedence": with a managed allowlist, `registry` access no longer
//!   requires the registry; the list decides.
//!
//! Kingu has no enterprise server, so the managed tier is a machine file an administrator writes
//! (`managed_path`, root-owned on a managed Mac or Linux box) with those three keys. Kingu has no
//! MCP registry either, so `registry` access without a managed allowlist allows no server.
//!
//! Applied in `agent_start` (mod.rs) to every server a run gets, in the MCP Servers view
//! (`McpEntry::blocked`), and handed to Claude Code as its `managedSettings` (`for_sdk`) so the
//! servers it reads itself (the user's `~/.claude.json`) are held to the same lists.
//! Kingu-only: the message names the list and the entry that decided, not only "your organization".

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::host::McpServer;

pub const ACCESS: &str = "chat.mcp.access";
pub const ALLOWED: &str = "chat.mcp.allowedServers";
pub const DENIED: &str = "chat.mcp.deniedServers";
/// The managed settings' keys (`COPILOT_ALLOWED_MCP_SERVERS_KEY`, …).
pub const MANAGED_ALLOWED: &str = "allowedMcpServers";
pub const MANAGED_DENIED: &str = "deniedMcpServers";
pub const MANAGED_ONLY: &str = "allowManagedMcpServersOnly";

/// One list entry; a malformed one is dropped (VS Code's `isValidMatcher`: exactly one field).
#[derive(Debug, Clone, PartialEq)]
pub enum Matcher {
  Name(String),
  Url(String),
  Command(Vec<String>),
}

impl Matcher {
  fn parse(v: &Value) -> Option<Self> {
    let o = v.as_object()?;
    let name = o.get("serverName").and_then(Value::as_str).filter(|s| !s.is_empty());
    let url = o.get("serverUrl").and_then(Value::as_str).filter(|s| !s.is_empty());
    let cmd = o.get("serverCommand").and_then(Value::as_array).filter(|a| !a.is_empty() && a.iter().all(Value::is_string));
    match (name, url, cmd) {
      (Some(n), None, None) => Some(Self::Name(n.into())),
      (None, Some(u), None) => Some(Self::Url(u.into())),
      (None, None, Some(c)) => Some(Self::Command(c.iter().filter_map(|a| a.as_str().map(String::from)).collect())),
      _ => None,
    }
  }

  fn to_json(&self) -> Value {
    match self {
      Self::Name(n) => json!({ "serverName": n }),
      Self::Url(u) => json!({ "serverUrl": u }),
      Self::Command(c) => json!({ "serverCommand": c }),
    }
  }

  fn shown(&self) -> String {
    self.to_json().to_string()
  }
}

/// VS Code's `getMcpServerMatchers`: `None` when the value is not a list (unset).
pub fn matchers(v: Option<&Value>) -> Option<Vec<Matcher>> {
  Some(v?.as_array()?.iter().filter_map(Matcher::parse).collect())
}

/// A server as the lists see it: its name, and its URL (remote) or `[command, ...args]` (stdio).
pub struct Identity<'a> {
  pub name: &'a str,
  pub url: Option<&'a str>,
  pub command: Option<Vec<String>>,
}

impl<'a> Identity<'a> {
  pub fn of(name: &'a str, s: &'a McpServer) -> Self {
    match s.url.as_deref() {
      Some(url) if s.command.is_empty() => Self { name, url: Some(url), command: None },
      _ => Self { name, url: None, command: Some(std::iter::once(s.command.clone()).chain(s.args.iter().cloned()).collect()) },
    }
  }
}

fn matches(m: &Matcher, id: &Identity) -> bool {
  match m {
    Matcher::Name(n) => n == id.name,
    Matcher::Url(p) => id.url.is_some_and(|u| matches_url(p, u)),
    Matcher::Command(c) => id.command.as_ref().is_some_and(|cmd| cmd == c),
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
  Allowed,
  Denied,
  NotAllowed,
}

/// VS Code's `checkMcpServerAllowed`, with the entry that decided.
pub fn check<'m>(allow: Option<&'m [Matcher]>, deny: Option<&'m [Matcher]>, id: &Identity) -> (Verdict, Option<&'m Matcher>) {
  if let Some(hit) = deny.and_then(|d| d.iter().find(|m| matches(m, id))) {
    return (Verdict::Denied, Some(hit));
  }
  let Some(allow) = allow else { return (Verdict::Allowed, None) };
  // The server's own transport's entries, when the list has any; else every entry (names too).
  let own: Vec<&Matcher> = allow
    .iter()
    .filter(|m| match m {
      Matcher::Url(_) => id.url.is_some(),
      Matcher::Command(_) => id.url.is_none() && id.command.is_some(),
      Matcher::Name(_) => false,
    })
    .collect();
  let pool: Vec<&Matcher> = if own.is_empty() { allow.iter().collect() } else { own };
  match pool.into_iter().find(|m| matches(m, id)) {
    Some(hit) => (Verdict::Allowed, Some(hit)),
    None => (Verdict::NotAllowed, None),
  }
}

// ---------------------------------------------------------------------------------------------
// URL patterns (VS Code's `matchesUrlPattern`)

fn authority_end(s: &str, from: usize) -> usize {
  s[from..].find(['/', '\\', '?', '#']).map_or(s.len(), |i| from + i)
}

/// `fetch`'s destination of an http(s) URL (origin + path + query), else the pattern form.
fn destination(url: &str) -> Option<String> {
  match url::Url::parse(url) {
    Ok(u) if u.scheme() == "http" || u.scheme() == "https" => Some(format!("{}{}{}", u.origin().ascii_serialization(), u.path(), u.query().map(|q| format!("?{q}")).unwrap_or_default())),
    Ok(_) => destination_pattern(url),
    Err(_) => None,
  }
}

fn split_host_port(authority: &str) -> Option<(&str, Option<&str>)> {
  if authority.starts_with('[') {
    let close = authority.find(']')?;
    return match &authority[close + 1..] {
      "" => Some((authority, None)),
      rest if rest.starts_with(':') => Some((&authority[..=close], Some(&rest[1..]))),
      _ => None,
    };
  }
  match authority.rfind(':') {
    Some(i) => Some((&authority[..i], Some(&authority[i + 1..]))),
    None if !authority.is_empty() => Some((authority, None)),
    None => None,
  }
}

/// VS Code's `toNetworkDestinationPattern`.
fn destination_pattern(pattern: &str) -> Option<String> {
  let Some(sep) = pattern.find("://") else { return Some(pattern.to_owned()) };
  let scheme = pattern[..sep].to_ascii_lowercase();
  let rest = &pattern[sep + 3..];
  let end = authority_end(rest, 0);
  if scheme != "http" && scheme != "https" {
    return Some(format!("{scheme}://{}{}", rest[..end].to_ascii_lowercase(), &rest[end..]));
  }
  let mut authority = &rest[..end];
  if let Some(at) = authority.rfind('@') {
    authority = &authority[at + 1..];
  }
  let (host, port) = split_host_port(authority)?;
  let default = if scheme == "https" { "443" } else { "80" };
  let port = port.filter(|p| *p != default);
  let mut after = rest[end..].replace('\\', "/");
  if let Some(h) = after.find('#') {
    after.truncate(h);
  }
  if after.is_empty() {
    after = "/".into();
  } else if after.starts_with('?') {
    after = format!("/{after}");
  }
  Some(format!("{scheme}://{}{}{after}", host.to_ascii_lowercase(), port.map(|p| format!(":{p}")).unwrap_or_default()))
}

fn pattern_regex(pattern: &str) -> String {
  let start = pattern.find("://").map_or(0, |i| i + 3);
  let end = authority_end(pattern, start);
  let chars: Vec<(usize, char)> = pattern.char_indices().collect();
  let mut out = String::from("^");
  let mut i = 0;
  while i < chars.len() {
    let (at, c) = chars[i];
    if at < end && c == ':' && chars.get(i + 1).is_some_and(|(_, n)| *n == '*') {
      out.push_str(r"(:[^/@\\?#]*)?");
      i += 2;
      continue;
    }
    if c == '*' {
      out.push_str(if at < end { r"[^/@\\?#]*" } else { ".*" });
    } else {
      out.push_str(&regex::escape(&c.to_string()));
    }
    i += 1;
  }
  out.push('$');
  out
}

pub fn matches_url(pattern: &str, url: &str) -> bool {
  let Some(dest) = destination(url) else { return false };
  let origin_only = pattern.find("://").is_some_and(|i| authority_end(pattern, i + 3) == pattern.len());
  if !pattern.contains('*') && !origin_only {
    return destination(pattern).is_some_and(|p| p == dest);
  }
  let Some(norm) = destination_pattern(&if origin_only { format!("{pattern}/*") } else { pattern.to_owned() }) else { return false };
  regex::Regex::new(&pattern_regex(&norm)).is_ok_and(|re| re.is_match(&dest))
}

// ---------------------------------------------------------------------------------------------
// The policy

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Access {
  #[default]
  All,
  Registry,
  None,
}

/// Where a list came from, for the message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum From {
  User,
  Managed,
  Both,
}

#[derive(Debug, Clone, Default)]
pub struct Policy {
  pub access: Access,
  allow: Option<(Vec<Matcher>, From)>,
  deny: Option<(Vec<Matcher>, From)>,
  /// An administrator's allowlist exists (VS Code's `hasManagedAllowlist`).
  managed_allowlist: bool,
}

/// The managed settings file: written by an administrator, never by Kingu.
pub fn managed_path() -> PathBuf {
  if cfg!(target_os = "macos") {
    PathBuf::from("/Library/Application Support/Kingu/managed-settings.json")
  } else if cfg!(windows) {
    PathBuf::from(r"C:\ProgramData\Kingu\managed-settings.json")
  } else {
    PathBuf::from("/etc/kingu/managed-settings.json")
  }
}

impl Policy {
  /// `user`: the user's setting by id; `managed`: the managed settings object, if any.
  pub fn from_values(user: impl Fn(&str) -> Option<Value>, managed: Option<&Value>) -> Self {
    let access = match user(ACCESS).as_ref().and_then(Value::as_str) {
      Some("none") => Access::None,
      Some("registry") => Access::Registry,
      _ => Access::All,
    };
    let m = |k: &str| managed.and_then(|v| v.get(k));
    let managed_only = m(MANAGED_ONLY).and_then(Value::as_bool) == Some(true);
    let (m_allow, m_deny) = (matchers(m(MANAGED_ALLOWED)), matchers(m(MANAGED_DENIED)));
    let (u_allow, u_deny) = (matchers(user(ALLOWED).as_ref()), matchers(user(DENIED).as_ref()));
    let allow = if managed_only {
      Some((m_allow.clone().unwrap_or_default(), From::Managed))
    } else {
      m_allow.clone().map(|l| (l, From::Managed)).or(u_allow.map(|l| (l, From::User)))
    };
    let deny = if managed_only {
      match (u_deny, m_deny) {
        (None, None) => None,
        (u, m) => Some(([u.unwrap_or_default(), m.unwrap_or_default()].concat(), From::Both)),
      }
    } else {
      m_deny.map(|l| (l, From::Managed)).or(u_deny.map(|l| (l, From::User)))
    };
    Self { access, allow, deny, managed_allowlist: m_allow.is_some() || managed_only }
  }

  /// The user's settings.json in `config` and the managed file. A managed file that is there
  /// but does not parse blocks every server: it may be the one that restricts them.
  pub fn from_settings(config: &Path) -> Self {
    Self::from_files(config, &managed_path())
  }

  pub fn from_files(config: &Path, managed: &Path) -> Self {
    let managed_value = match crate::settings::read(managed) {
      Ok(None) => None,
      Ok(Some(text)) => match serde_json::from_str::<Value>(&crate::settings::strip_jsonc(&text)) {
        Ok(v) => Some(v),
        Err(_) => Some(json!({ MANAGED_ONLY: true, MANAGED_ALLOWED: [] })),
      },
      Err(_) => Some(json!({ MANAGED_ONLY: true, MANAGED_ALLOWED: [] })),
    };
    Self::from_values(|k| crate::settings::user_value(config, k), managed_value.as_ref())
  }

  /// Whether `name` may run, or why not (VS Code's words, plus the entry that decided).
  pub fn check_server(&self, name: &str, server: &McpServer) -> Result<(), String> {
    self.check_identity(&Identity::of(name, server))
  }

  pub fn check_identity(&self, id: &Identity) -> Result<(), String> {
    if self.access == Access::None {
      return Err(format!("Model Context Protocol servers are turned off ({ACCESS} is \"none\")."));
    }
    let allow = self.allow.as_ref().map(|(l, _)| l.as_slice());
    let deny = self.deny.as_ref().map(|(l, _)| l.as_slice());
    // `registry` without a managed allowlist: only registry servers, and Kingu has no registry.
    if self.access == Access::Registry && !self.managed_allowlist {
      if let (Verdict::Denied, Some(hit)) = check(None, deny, id) {
        return Err(self.denied_text(hit));
      }
      return Err(format!("{ACCESS} is \"registry\", which allows only servers from an MCP registry, and Kingu has none. Use \"all\", or have an administrator list the server in the managed {MANAGED_ALLOWED}."));
    }
    match check(allow, deny, id) {
      (Verdict::Allowed, _) => Ok(()),
      (Verdict::Denied, hit) => Err(self.denied_text(hit.expect("a deny verdict has its entry"))),
      (Verdict::NotAllowed, _) => {
        let managed = self.allow.as_ref().is_some_and(|(_, f)| *f != From::User);
        let named = allow.is_some_and(|l| l.iter().any(|m| matches!(m, Matcher::Name(n) if n == id.name)));
        let base = if managed {
          "This Model Context Protocol server is not in the list of servers allowed by your organization.".to_owned()
        } else {
          format!("This Model Context Protocol server is not in {ALLOWED}.")
        };
        let why = match (named, id.url.is_some()) {
          (true, true) => " A name entry matches, but this allowlist contains URL entries, so the server must match an allowed URL.",
          (true, false) => " A name entry matches, but this allowlist contains command entries, so the server must match an allowed command and arguments.",
          _ => "",
        };
        let tail = if managed { " Please contact your administrator for more information." } else { "" };
        Err(format!("{base}{why}{tail}"))
      }
    }
  }

  fn denied_text(&self, hit: &Matcher) -> String {
    match self.deny.as_ref().map(|(_, f)| *f) {
      Some(From::User) => format!("This Model Context Protocol server is blocked by {DENIED} (entry {}).", hit.shown()),
      _ => format!("This Model Context Protocol server is blocked by your organization (the {MANAGED_DENIED} or {DENIED} entry {}). Contact your administrator for more information.", hit.shown()),
    }
  }

  /// Claude Code's `managedSettings` for the same lists (its schema is VS Code's), or `None`.
  /// `none` access and Kingu's registry rule become an empty allowlist.
  pub fn for_sdk(&self) -> Option<Value> {
    let closed = self.access == Access::None || (self.access == Access::Registry && !self.managed_allowlist);
    let allow = if closed { Some(Vec::new()) } else { self.allow.as_ref().map(|(l, _)| l.clone()) };
    let deny = self.deny.as_ref().map(|(l, _)| l.clone());
    if allow.is_none() && deny.is_none() {
      return None;
    }
    let mut out = serde_json::Map::new();
    if let Some(a) = allow {
      out.insert(MANAGED_ALLOWED.into(), Value::Array(a.iter().map(Matcher::to_json).collect()));
    }
    if let Some(d) = deny {
      out.insert(MANAGED_DENIED.into(), Value::Array(d.iter().map(Matcher::to_json).collect()));
    }
    Some(Value::Object(out))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn policy(user: Value, managed: Option<Value>) -> Policy {
    Policy::from_values(|k| user.get(k).cloned(), managed.as_ref())
  }
  fn stdio(cmd: &str, args: &[&str]) -> McpServer {
    McpServer { command: cmd.into(), args: args.iter().map(|a| a.to_string()).collect(), ..Default::default() }
  }
  fn remote(url: &str) -> McpServer {
    McpServer { kind: Some("http".into()), url: Some(url.into()), ..Default::default() }
  }

  #[test]
  fn url_patterns_match_like_vscode() {
    assert!(matches_url("https://mcp.example.com/mcp", "https://mcp.example.com:443/mcp"));
    assert!(!matches_url("https://mcp.example.com/mcp", "https://mcp.example.com/mcp/other"));
    assert!(matches_url("https://*.example.com/*", "https://a.example.com/x/y"));
    assert!(!matches_url("https://*.example.com/*", "https://a.example.com.evil.dev/x"));
    // An authority wildcard never crosses into user info or the path.
    assert!(!matches_url("https://*.example.com/*", "https://evil.dev/@a.example.com/x"));
    assert!(!matches_url("https://*.example.com/*", "https://a.example.com@evil.dev/x"));
    // Origin only: any path on it.
    assert!(matches_url("https://mcp.example.com", "https://MCP.example.com/a?b=1"));
    assert!(matches_url("https://mcp.example.com:*", "https://mcp.example.com:8443/a"));
    assert!(!matches_url("https://mcp.example.com/mcp", "not a url"));
  }

  #[test]
  fn unset_allows_all_empty_allows_none_and_deny_wins() {
    let open = policy(json!({}), None);
    assert!(open.check_server("x", &stdio("node", &["a.js"])).is_ok());
    assert_eq!(open.for_sdk(), None);
    let none = policy(json!({ ALLOWED: [] }), None);
    assert_eq!(none.check_server("x", &stdio("node", &["a.js"])).unwrap_err(), format!("This Model Context Protocol server is not in {ALLOWED}."));
    let both = policy(json!({ ALLOWED: [{ "serverName": "db" }], DENIED: [{ "serverName": "db" }] }), None);
    assert_eq!(both.check_server("db", &stdio("db", &[])).unwrap_err(), format!("This Model Context Protocol server is blocked by {DENIED} (entry {{\"serverName\":\"db\"}})."));
    // Malformed entries are dropped, not errors.
    let bad = policy(json!({ ALLOWED: [{ "serverName": "a", "serverUrl": "b" }, 5, { "serverCommand": [] }, { "serverName": "ok" }] }), None);
    assert!(bad.check_server("ok", &stdio("x", &[])).is_ok());
    assert!(bad.check_server("a", &stdio("x", &[])).is_err());
  }

  #[test]
  fn a_name_entry_stands_in_only_without_entries_of_the_servers_transport() {
    let p = policy(json!({ ALLOWED: [{ "serverName": "remote" }, { "serverUrl": "https://ok.example/*" }, { "serverCommand": ["node", "approved-server.js"] }] }), None);
    assert!(p.check_server("anything", &remote("https://ok.example/mcp")).is_ok());
    let err = p.check_server("remote", &remote("https://other.example/mcp")).unwrap_err();
    assert!(err.contains("A name entry matches, but this allowlist contains URL entries"), "{err}");
    assert!(p.check_server("x", &stdio("node", &["approved-server.js"])).is_ok());
    assert!(p.check_server("x", &stdio("node", &["approved-server.js", "--extra"])).is_err());
    // Names only: names decide for every transport.
    let names = policy(json!({ ALLOWED: [{ "serverName": "remote" }] }), None);
    assert!(names.check_server("remote", &remote("https://any.example/")).is_ok());
  }

  #[test]
  fn the_managed_tier_wins_and_managed_only_ignores_the_users_allowlist() {
    let managed = json!({ MANAGED_ALLOWED: [{ "serverUrl": "https://mcp.example.com/mcp" }, { "serverCommand": ["node", "approved-server.js"] }] });
    let p = policy(json!({ ALLOWED: [{ "serverName": "mine" }] }), Some(managed.clone()));
    assert!(p.check_server("mine", &stdio("x", &[])).unwrap_err().contains("allowed by your organization"));
    assert!(p.check_server("srv", &remote("https://mcp.example.com/mcp")).is_ok());
    // allowManagedMcpServersOnly: the managed list, or none at all; everyone's denies together.
    let only = policy(json!({ ALLOWED: [{ "serverName": "mine" }], DENIED: [{ "serverName": "srv" }] }), Some(json!({ MANAGED_ONLY: true })));
    assert!(only.check_server("mine", &stdio("x", &[])).is_err());
    let only2 = policy(json!({ DENIED: [{ "serverName": "srv" }] }), Some(json!({ MANAGED_ONLY: true, MANAGED_ALLOWED: [{ "serverName": "srv" }, { "serverName": "b" }] })));
    assert!(only2.check_server("srv", &stdio("x", &[])).unwrap_err().contains("blocked by your organization"));
    assert!(only2.check_server("b", &stdio("x", &[])).is_ok());
  }

  #[test]
  fn access_none_and_registry() {
    let off = policy(json!({ ACCESS: "none" }), None);
    assert!(off.check_server("x", &stdio("x", &[])).unwrap_err().contains("turned off"));
    assert_eq!(off.for_sdk(), Some(json!({ MANAGED_ALLOWED: [] })));
    // Registry without a managed allowlist: Kingu has no registry, so nothing.
    let reg = policy(json!({ ACCESS: "registry", ALLOWED: [{ "serverName": "x" }] }), None);
    assert!(reg.check_server("x", &stdio("x", &[])).unwrap_err().contains("Kingu has none"));
    // 1.145: a managed allowlist takes precedence over registry-only access.
    let managed = policy(json!({ ACCESS: "registry" }), Some(json!({ MANAGED_ALLOWED: [{ "serverCommand": ["node", "approved-server.js"] }] })));
    assert!(managed.check_server("x", &stdio("node", &["approved-server.js"])).is_ok());
    assert!(managed.check_server("y", &stdio("node", &["other.js"])).is_err());
  }

  #[test]
  fn for_claude_code_the_lists_in_its_settings_shape() {
    let p = policy(json!({ ALLOWED: [{ "serverUrl": "https://a/*" }], DENIED: [{ "serverCommand": ["rm"] }] }), None);
    assert_eq!(p.for_sdk(), Some(json!({ MANAGED_ALLOWED: [{ "serverUrl": "https://a/*" }], MANAGED_DENIED: [{ "serverCommand": ["rm"] }] })));
  }

  #[test]
  fn read_from_files_and_a_broken_managed_file_blocks_everything() {
    let config = tempfile::tempdir().unwrap();
    let user = crate::settings::user_path(config.path());
    std::fs::create_dir_all(user.parent().unwrap()).unwrap();
    std::fs::write(&user, r#"{ "chat.mcp.deniedServers": [{ "serverName": "bad" }] }"#).unwrap();
    let managed = config.path().join("managed.json");
    let p = Policy::from_files(config.path(), &managed);
    assert!(p.check_server("bad", &stdio("x", &[])).is_err());
    assert!(p.check_server("good", &stdio("x", &[])).is_ok());
    std::fs::write(&managed, "{ not json").unwrap();
    assert!(Policy::from_files(config.path(), &managed).check_server("good", &stdio("x", &[])).is_err());
  }
}
