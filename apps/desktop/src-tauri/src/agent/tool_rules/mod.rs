//! VS Code's tool approval rules for agent runs: `chat.tools.terminal.autoApprove` (shell commands,
//! judged sub-command by sub-command: command_line.rs, terminal.rs), `chat.tools.urls.autoApprove`
//! (fetched URLs: urls.rs) and `chat.tools.edits.autoApprove` (files that always ask before an
//! edit). Read from the user's settings.json only (like `safety_asks`: a repository cannot approve
//! its own commands), over VS Code's defaults (`src/lib/settings/vscode/chatToolRules.json`, which
//! the settings registry shows too).
//!
//! Commands and URLs: Rust answers the run's permission prompts the rules approve (every runtime
//! asks through the same `permission_request`; `AutoApprover` follows a run's events), and adds the
//! rule an "Always allow" button would write to the prompts it leaves to the user. Edits: the
//! `false` patterns go to the host with the always-ask checks (`safety_asks::GuardAsks`), which
//! asks before such an edit in every mode but Allow all; which other edits ask is the run mode's.

pub mod command_line;
pub mod terminal;
pub mod urls;

use std::collections::HashSet;
use std::path::Path;
use std::sync::OnceLock;

use serde_json::{Map, Value};

use super::events::{AgentEvent, RuleSuggestion};

pub const TERMINAL_SETTING: &str = "chat.tools.terminal.autoApprove";
pub const TERMINAL_ENABLE_SETTING: &str = "chat.tools.terminal.enableAutoApprove";
pub const TERMINAL_IGNORE_DEFAULTS_SETTING: &str = "chat.tools.terminal.ignoreDefaultAutoApproveRules";
pub const URLS_SETTING: &str = "chat.tools.urls.autoApprove";
pub const EDITS_SETTING: &str = "chat.tools.edits.autoApprove";

/// The shell tool of every runtime (Claude Code, Arkai, Codex's commands) and its `command` field.
const SHELL_TOOL: &str = "Bash";
/// The URL tool (Claude Code's and Arkai's) and its `url` field.
const FETCH_TOOL: &str = "WebFetch";

/// VS Code's defaults of the three settings (the same file the settings registry imports).
pub struct Defaults {
  pub terminal: Map<String, Value>,
  pub edits: Map<String, Value>,
  /// Edit patterns VS Code always asks about, whatever the setting says.
  pub edits_always_checked: Vec<String>,
  pub urls: Map<String, Value>,
}

pub fn defaults() -> &'static Defaults {
  static D: OnceLock<Defaults> = OnceLock::new();
  D.get_or_init(|| {
    let v: Value = serde_json::from_str(include_str!("../../../../src/lib/settings/vscode/chatToolRules.json")).expect("chatToolRules.json is valid JSON");
    let map = |k: &str| v.get(k).and_then(Value::as_object).cloned().unwrap_or_default();
    Defaults {
      terminal: map("terminal"),
      edits: map("edits"),
      edits_always_checked: v.get("editsAlwaysChecked").and_then(Value::as_array).map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect()).unwrap_or_default(),
      urls: map("urls"),
    }
  })
}

/// The command and URL rules in effect.
#[derive(Debug, Clone, Default)]
pub struct ToolRules {
  /// None: `chat.tools.terminal.enableAutoApprove` is off (every command asks).
  pub terminal: Option<terminal::TerminalRules>,
  pub urls: urls::UrlRules,
}

impl ToolRules {
  /// The rules from the user's settings.json in `config` (the app config dir).
  pub fn load(config: &Path) -> Self {
    let user = |key: &str| crate::settings::user_value(config, key);
    Self::from_values(user(TERMINAL_SETTING).as_ref(), user(TERMINAL_ENABLE_SETTING).as_ref(), user(TERMINAL_IGNORE_DEFAULTS_SETTING).as_ref(), user(URLS_SETTING).as_ref())
  }

  pub fn from_values(terminal: Option<&Value>, enable: Option<&Value>, ignore_defaults: Option<&Value>, urls: Option<&Value>) -> Self {
    let d = defaults();
    let enabled = enable.and_then(Value::as_bool).unwrap_or(true);
    let ignore = ignore_defaults.and_then(Value::as_bool).unwrap_or(false);
    Self {
      terminal: enabled.then(|| terminal::TerminalRules::new(&terminal::merged(&d.terminal, terminal, ignore))),
      urls: urls::UrlRules::new(&urls::merged(&d.urls, urls)),
    }
  }

  /// Whether `tool` with `input` runs without asking: the rules that approve it, or what an
  /// "Always allow" answer would add (None: nothing to offer).
  pub fn decide(&self, tool: &str, input: &Value) -> Decision {
    let field = |k: &str| input.get(k).and_then(Value::as_str);
    match (tool, field("command"), field("url")) {
      (SHELL_TOOL, Some(command), _) => {
        let Some(rules) = &self.terminal else { return Decision::Ask(None) };
        let e = rules.evaluate(command);
        if e.approved() {
          return Decision::Approve(e.approving_rules());
        }
        let keys = e.suggestions();
        Decision::Ask((!keys.is_empty()).then(|| RuleSuggestion { setting: TERMINAL_SETTING.into(), keys }))
      }
      (FETCH_TOOL, _, Some(url)) => match self.urls.approving(url) {
        Some(pattern) => Decision::Approve(vec![pattern.to_owned()]),
        None => Decision::Ask(urls::domain_key(url).map(|k| RuleSuggestion { setting: URLS_SETTING.into(), keys: vec![k] })),
      },
      _ => Decision::Ask(None),
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
  /// Runs without asking; the rules that said so.
  Approve(Vec<String>),
  /// The user is asked; the rule an "Always allow" answer would add.
  Ask(Option<RuleSuggestion>),
}

/// `chat.tools.edits.autoApprove` in order (VS Code's mergeChatEditAutoApprovePatterns): the
/// defaults, then the user's patterns (a user pattern moves to the end, so the last match decides
/// as configured), then the patterns VS Code always asks about.
pub fn edit_rules(user: Option<&Value>) -> Vec<(String, bool)> {
  let d = defaults();
  let mut out: Vec<(String, bool)> = d.edits.iter().map(|(k, v)| (k.clone(), v.as_bool() == Some(true))).collect();
  if let Some(Value::Object(user)) = user {
    for (k, v) in user {
      out.retain(|(p, _)| p != k);
      if !v.is_null() {
        out.push((k.clone(), v.as_bool() == Some(true)));
      }
    }
  }
  for p in &d.edits_always_checked {
    out.retain(|(q, _)| q != p);
    out.push((p.clone(), false));
  }
  out
}

/// `edit_rules` from the user's settings.json, as sent to the host (which matches them in order,
/// the last match deciding): bad patterns left out, the oldest dropped past the host's limit.
pub fn edit_rules_from_settings(config: &Path) -> Vec<(String, bool)> {
  let mut rules = edit_rules(crate::settings::user_value(config, EDITS_SETTING).as_ref());
  rules.retain(|(p, _)| !p.trim().is_empty() && p.len() <= 500);
  if rules.len() > super::safety_asks::MAX_PATTERNS {
    rules.drain(..rules.len() - super::safety_asks::MAX_PATTERNS);
  }
  rules
}

/// Follows one run's events: a permission prompt the rules approve becomes a `tool_auto_approved`
/// event and its request id is returned (to answer `allow`); others gain the rule an "Always
/// allow" button adds. Kingu's own safety asks (a `guard_asked` first) are left to the user.
#[derive(Default)]
pub struct AutoApprover {
  guarded: HashSet<String>,
}

impl AutoApprover {
  /// The event to pass on, and the request to allow now. `rules` is read only for a prompt the
  /// rules can decide (so a rule saved a moment ago applies to the next command).
  pub fn on_event(&mut self, ev: AgentEvent, rules: impl FnOnce() -> ToolRules) -> (AgentEvent, Option<String>) {
    match ev {
      AgentEvent::GuardAsked { ref request_id, .. } => {
        self.guarded.insert(request_id.clone());
        (ev, None)
      }
      AgentEvent::PermissionRequest { request_id, tool, tool_use_id, title, input_summary, detail, diff, input, can_always, rules: always_rules, auto_approve: _ } => {
        // Only Rust says which setting a button writes: whatever the sidecar sent is dropped.
        let decision = if !self.guarded.contains(&request_id) && can_always && (tool == SHELL_TOOL || tool == FETCH_TOOL) { rules().decide(&tool, &input) } else { Decision::Ask(None) };
        match decision {
          Decision::Approve(by) => {
            let id = request_id.clone();
            (AgentEvent::ToolAutoApproved { request_id, tool, tool_use_id, rules: by }, Some(id))
          }
          Decision::Ask(auto_approve) => (AgentEvent::PermissionRequest { request_id, tool, tool_use_id, title, input_summary, detail, diff, input, can_always, rules: always_rules, auto_approve }, None),
        }
      }
      // Only Rust says a call was auto-approved.
      AgentEvent::ToolAutoApproved { .. } => (AgentEvent::Raw { line: "tool_auto_approved from the agent host (ignored)".into() }, None),
      AgentEvent::PermissionResolved { ref request_id, .. } => {
        self.guarded.remove(request_id);
        (ev, None)
      }
      ev => (ev, None),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn request(id: &str, tool: &str, input: Value) -> AgentEvent {
    AgentEvent::PermissionRequest {
      request_id: id.into(),
      tool: tool.into(),
      tool_use_id: Some(format!("tu-{id}")),
      title: None,
      input_summary: String::new(),
      detail: None,
      diff: None,
      input,
      can_always: true,
      rules: vec![],
      auto_approve: None,
    }
  }

  fn default_rules() -> ToolRules {
    ToolRules::from_values(None, None, None, None)
  }

  #[test]
  fn approves_what_the_rules_allow_and_suggests_the_rest() {
    let mut a = AutoApprover::default();
    let (ev, allow) = a.on_event(request("1", "Bash", json!({ "command": "git status && ls" })), default_rules);
    assert_eq!(allow.as_deref(), Some("1"));
    assert_eq!(ev, AgentEvent::ToolAutoApproved { request_id: "1".into(), tool: "Bash".into(), tool_use_id: Some("tu-1".into()), rules: vec![r"/^git(\s+(-(?-i:C)\s+\S+|--no-pager))*\s+status\b/".into(), "ls".into()] });

    let (ev, allow) = a.on_event(request("2", "Bash", json!({ "command": "cargo test -p x" })), default_rules);
    assert_eq!(allow, None);
    let AgentEvent::PermissionRequest { auto_approve, .. } = ev else { panic!() };
    assert_eq!(auto_approve, Some(RuleSuggestion { setting: TERMINAL_SETTING.into(), keys: vec!["cargo test".into()] }));

    let (ev, allow) = a.on_event(request("3", "Bash", json!({ "command": "rm -rf x" })), default_rules);
    assert_eq!(allow, None);
    assert!(matches!(ev, AgentEvent::PermissionRequest { auto_approve: None, .. }));
  }

  #[test]
  fn urls() {
    let mut a = AutoApprover::default();
    let rules = || ToolRules::from_values(None, None, None, Some(&json!({ "https://docs.rs": true })));
    let (ev, allow) = a.on_event(request("1", "WebFetch", json!({ "url": "https://docs.rs/serde", "prompt": "x" })), rules);
    assert_eq!(allow.as_deref(), Some("1"));
    assert!(matches!(ev, AgentEvent::ToolAutoApproved { ref rules, .. } if rules == &["https://docs.rs"]));
    let (ev, allow) = a.on_event(request("2", "WebFetch", json!({ "url": "https://evil.example/x" })), rules);
    assert_eq!(allow, None);
    assert!(matches!(ev, AgentEvent::PermissionRequest { auto_approve: Some(ref s), .. } if s.keys == ["https://evil.example"] && s.setting == URLS_SETTING));
  }

  #[test]
  fn safety_asks_questions_and_other_tools_are_left_alone() {
    let mut a = AutoApprover::default();
    let asked = AgentEvent::GuardAsked { request_id: "9".into(), tool: "Bash".into(), tool_use_id: None, check: "delete".into(), paths: vec![] };
    assert_eq!(a.on_event(asked, default_rules).1, None);
    let (ev, allow) = a.on_event(request("9", "Bash", json!({ "command": "ls" })), || panic!("not read for a safety ask"));
    assert_eq!(allow, None);
    assert!(matches!(ev, AgentEvent::PermissionRequest { auto_approve: None, .. }));
    // A request that cannot be kept as a rule (a question) and other tools: not read either.
    let mut q = request("5", "Bash", json!({ "command": "ls" }));
    if let AgentEvent::PermissionRequest { can_always, .. } = &mut q {
      *can_always = false;
    }
    assert_eq!(a.on_event(q, || panic!()).1, None);
    assert_eq!(a.on_event(request("6", "Edit", json!({ "file_path": "a" })), || panic!()).1, None);
    // A suggestion the sidecar made up never reaches the page.
    let mut forged = request("7", "Edit", json!({}));
    if let AgentEvent::PermissionRequest { auto_approve, .. } = &mut forged {
      *auto_approve = Some(RuleSuggestion { setting: "terminal.integrated.shell.osx".into(), keys: vec!["x".into()] });
    }
    assert!(matches!(a.on_event(forged, || panic!()).0, AgentEvent::PermissionRequest { auto_approve: None, .. }));
  }

  #[test]
  fn enable_auto_approve_off_asks_for_every_command() {
    let rules = ToolRules::from_values(Some(&json!({ "/.*/": true })), Some(&json!(false)), None, None);
    assert_eq!(rules.decide("Bash", &json!({ "command": "ls" })), Decision::Ask(None));
    // URLs are another setting.
    let rules = ToolRules::from_values(None, Some(&json!(false)), None, Some(&json!({ "*": true })));
    assert_eq!(rules.decide("WebFetch", &json!({ "url": "https://x.com" })), Decision::Approve(vec!["*".into()]));
  }

  #[test]
  fn user_settings_file() {
    let config = tempfile::tempdir().unwrap();
    std::fs::write(crate::settings::user_path(config.path()), r#"{ // jsonc
      "chat.tools.terminal.autoApprove": { "make": true, "ls": null },
      "chat.tools.edits.autoApprove": { "**/*.md": false, "**/.vscode/*.json": true }
    }"#)
    .unwrap();
    let rules = ToolRules::load(config.path());
    assert!(matches!(rules.decide("Bash", &json!({ "command": "make" })), Decision::Approve(_)));
    assert!(matches!(rules.decide("Bash", &json!({ "command": "ls" })), Decision::Ask(_)));
    let edits = edit_rules_from_settings(config.path());
    assert_eq!(edits.first(), Some(&("**/*".to_owned(), true)));
    assert!(edits.contains(&("**/*.md".to_owned(), false)));
    // Always-checked patterns stay `false` and come last, whatever the user set.
    assert_eq!(edits.iter().filter(|(p, _)| p == "**/.vscode/*.json").collect::<Vec<_>>(), [&("**/.vscode/*.json".to_owned(), false)]);
    assert_eq!(edits.last(), Some(&("**/.codex/hooks.json".to_owned(), false)));
  }

  #[test]
  fn edit_rules_order() {
    let rules = edit_rules(Some(&json!({ "**/*": false, "src/**": true, "**/.git/**": null })));
    let pos = |p: &str| rules.iter().position(|(q, _)| q == p);
    assert!(pos("**/.git/**").is_none());
    assert!(pos("**/*").unwrap() > pos("**/*.lock").unwrap(), "a user pattern moves to the end");
    assert_eq!(rules[pos("**/*").unwrap()], ("**/*".to_owned(), false));
    assert!(pos("src/**").unwrap() > pos("**/*").unwrap());
  }
}
