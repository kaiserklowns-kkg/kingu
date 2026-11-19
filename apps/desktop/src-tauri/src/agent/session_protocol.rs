//! The Agent Supervisor's one typed protocol for every agent session, chat (sidecar events,
//! `events::AgentEvent`) and terminal (hook payloads, `hooks.rs` / `status_hooks.rs`).
//!
//! Named after VS Code's Agent Host Protocol actions
//! (`src/vs/platform/agentHost/common/state/protocol/channels-chat/actions.ts`: `chat/turnStarted`,
//! `chat/responsePart`, `chat/toolCallStart` → `toolCallDelta` → `toolCallComplete` →
//! `toolCallContentChanged`, `chat/turnComplete`, `chat/turnCancelled`, `chat/usage`, `chat/error`,
//! `chat/inputRequested`; `channels-session`: `session/*`), with Kingu's prefixes `session/`,
//! `turn/`, `toolCall/`. Hook events are folded the way Orca's hook listener maps providers
//! (`src/shared/agent-hook-listener/normalization/normalize-hook-payload.ts`, `providers/*`) and
//! the way the webview's `src/lib/ade/agentHooks.ts` decides phases; this file keeps only what
//! the protocol needs (phase, turn, tool calls, inputs), the card text stays in agentHooks.ts.
//!
//! `apply` is the one reducer; `src/lib/agent/sessionProtocol.ts` mirrors it for the webview's
//! snapshot + replay. Change both together (their tests share fixtures).

use std::collections::BTreeSet;

use serde_json::Value;

use super::events::AgentEvent;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
  /// An agent chat (sidecar run bound to a chat id).
  Chat,
  /// An ADE task run (sidecar run bound to a task worktree), or a folder run.
  Run,
  /// The agent CLI Kingu launched in a task terminal (cliSessions.svelte.ts).
  Tui,
  /// Any other terminal pane of a task where a CLI with status hooks runs (paneAgents.svelte.ts).
  Pane,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
  Starting,
  Working,
  Waiting,
  Idle,
  Ended,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputKind {
  Permission,
  Question,
  Elicitation,
  Mcp,
}

/// Where a session runs and who owns it (Orca `AgentSessionOwnerBinding`: claim, generation,
/// pty, surface).
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Binding {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub run_id: Option<u32>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub pty_key: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub hook_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SessionInfo {
  pub id: String,
  pub kind: SessionKind,
  /// The owner key (ledger caller): `chat:<root>:<id>` or `task:<root>:<slug>`.
  pub owner: String,
  #[serde(default)]
  pub root: Option<String>,
  #[serde(default)]
  pub slug: Option<String>,
  /// The folder the agent works in.
  #[serde(default)]
  pub worktree: Option<String>,
  /// sha256 of `worktree` (op_ledger::scope_digest).
  pub scope: String,
  /// The CLI or runtime (`claude`, `codex`, …), when known.
  #[serde(default)]
  pub agent: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PendingInput {
  pub request_id: String,
  pub kind: InputKind,
  #[serde(default)]
  pub tool: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct UsageTotals {
  pub input_tokens: u64,
  pub output_tokens: u64,
  pub cost_usd: f64,
  #[serde(default)]
  pub context_used: Option<u64>,
  #[serde(default)]
  pub context_max: Option<u64>,
}

/// A session as the snapshot shows it.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SessionState {
  #[serde(flatten)]
  pub info: SessionInfo,
  pub binding: Binding,
  /// Bumped on every new binding (a new run, a replaced hook file).
  pub generation: u32,
  pub phase: Phase,
  #[serde(default)]
  pub provider_session_id: Option<String>,
  #[serde(default)]
  pub turn: Option<String>,
  pub turns: u32,
  /// Tool calls started and not complete, by id → tool name.
  pub tools: std::collections::BTreeMap<String, String>,
  pub pending: Vec<PendingInput>,
  pub usage: UsageTotals,
  #[serde(default)]
  pub last_error: Option<String>,
  pub updated_at: u64,
}

impl SessionState {
  pub fn new(info: SessionInfo, now: u64) -> Self {
    SessionState {
      info,
      binding: Binding::default(),
      generation: 0,
      phase: Phase::Starting,
      provider_session_id: None,
      turn: None,
      turns: 0,
      tools: Default::default(),
      pending: Vec::new(),
      usage: UsageTotals::default(),
      last_error: None,
      updated_at: now,
    }
  }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PartKind {
  Text,
  Thinking,
}

/// One protocol action. Field names are snake_case like `AgentEvent`; the tags are the
/// Agent Host names.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type")]
#[allow(clippy::large_enum_variant)] // actions are built once and serialized; boxing would only add noise
pub enum Action {
  #[serde(rename = "session/added")]
  SessionAdded { session: SessionState },
  /// A new run / hook file / pane took the session (generation bumped, phase `starting`).
  #[serde(rename = "session/bound")]
  SessionBound { session_id: String, binding: Binding, generation: u32 },
  /// The binding changed within its generation (the run id became known).
  #[serde(rename = "session/bindingChanged")]
  SessionBindingChanged { session_id: String, binding: Binding },
  #[serde(rename = "session/providerSessionSet")]
  ProviderSessionSet { session_id: String, provider_session_id: String },
  /// The agent is up and waiting for a prompt (a hook `SessionStart` with no turn).
  #[serde(rename = "session/ready")]
  SessionReady { session_id: String },
  #[serde(rename = "session/ended")]
  SessionEnded { session_id: String, reason: String },
  #[serde(rename = "session/removed")]
  SessionRemoved { session_id: String },
  #[serde(rename = "turn/started")]
  TurnStarted {
    session_id: String,
    turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prompt: Option<String>,
  },
  /// A whole text or thinking block (token deltas stay on the run's own channel).
  #[serde(rename = "turn/responsePart")]
  ResponsePart {
    session_id: String,
    turn_id: String,
    part: PartKind,
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_tool_call_id: Option<String>,
  },
  #[serde(rename = "toolCall/start")]
  ToolCallStart {
    session_id: String,
    turn_id: String,
    tool_call_id: String,
    tool_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_tool_call_id: Option<String>,
  },
  #[serde(rename = "toolCall/delta")]
  ToolCallDelta { session_id: String, turn_id: String, tool_call_id: String, input: Value },
  #[serde(rename = "toolCall/complete")]
  ToolCallComplete {
    session_id: String,
    turn_id: String,
    tool_call_id: String,
    is_error: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    result: Option<String>,
  },
  /// The tool changed a file (a chat edit's snapshot).
  #[serde(rename = "toolCall/contentChanged")]
  ToolCallContentChanged { session_id: String, turn_id: String, tool_call_id: String, path: String },
  #[serde(rename = "turn/complete")]
  TurnComplete {
    session_id: String,
    turn_id: String,
    is_error: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    result: Option<String>,
  },
  #[serde(rename = "turn/cancelled")]
  TurnCancelled { session_id: String, turn_id: String, reason: String },
  #[serde(rename = "usage")]
  Usage {
    session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context_used: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context_max: Option<u64>,
  },
  #[serde(rename = "error")]
  Error {
    session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
    message: String,
  },
  #[serde(rename = "inputRequested")]
  InputRequested {
    session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
    request_id: String,
    input_kind: InputKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    message: Option<String>,
  },
  #[serde(rename = "inputResolved")]
  InputResolved { session_id: String, request_id: String, decision: String },
}

impl Action {
  pub fn session_id(&self) -> &str {
    match self {
      Action::SessionAdded { session } => &session.info.id,
      Action::SessionBound { session_id, .. }
      | Action::SessionBindingChanged { session_id, .. }
      | Action::ProviderSessionSet { session_id, .. }
      | Action::SessionReady { session_id }
      | Action::SessionEnded { session_id, .. }
      | Action::SessionRemoved { session_id }
      | Action::TurnStarted { session_id, .. }
      | Action::ResponsePart { session_id, .. }
      | Action::ToolCallStart { session_id, .. }
      | Action::ToolCallDelta { session_id, .. }
      | Action::ToolCallComplete { session_id, .. }
      | Action::ToolCallContentChanged { session_id, .. }
      | Action::TurnComplete { session_id, .. }
      | Action::TurnCancelled { session_id, .. }
      | Action::Usage { session_id, .. }
      | Action::Error { session_id, .. }
      | Action::InputRequested { session_id, .. }
      | Action::InputResolved { session_id, .. } => session_id,
    }
  }
}

fn settle_phase(s: &mut SessionState) {
  if s.phase == Phase::Ended {
    return;
  }
  s.phase = if !s.pending.is_empty() {
    Phase::Waiting
  } else if s.turn.is_some() {
    Phase::Working
  } else {
    Phase::Idle
  };
}

/// Folds one action into its session (not `SessionAdded` / `SessionRemoved`: the registry's).
pub fn apply(s: &mut SessionState, a: &Action, now: u64) {
  s.updated_at = now;
  match a {
    Action::SessionAdded { .. } | Action::SessionRemoved { .. } => {}
    Action::SessionBound { binding, generation, .. } => {
      s.binding = binding.clone();
      s.generation = *generation;
      s.phase = Phase::Starting;
      s.turn = None;
      s.tools.clear();
      s.pending.clear();
      s.last_error = None;
    }
    Action::SessionBindingChanged { binding, .. } => s.binding = binding.clone(),
    Action::ProviderSessionSet { provider_session_id, .. } => s.provider_session_id = Some(provider_session_id.clone()),
    Action::SessionReady { .. } => {
      if s.phase == Phase::Starting {
        s.phase = Phase::Idle;
      }
    }
    Action::SessionEnded { .. } => {
      s.phase = Phase::Ended;
      s.turn = None;
      s.tools.clear();
      s.pending.clear();
    }
    Action::TurnStarted { turn_id, .. } => {
      s.turn = Some(turn_id.clone());
      s.turns += 1;
      settle_phase(s);
    }
    Action::ResponsePart { .. } | Action::ToolCallDelta { .. } | Action::ToolCallContentChanged { .. } => {}
    Action::ToolCallStart { tool_call_id, tool_name, .. } => {
      s.tools.insert(tool_call_id.clone(), tool_name.clone());
    }
    Action::ToolCallComplete { tool_call_id, .. } => {
      s.tools.remove(tool_call_id);
    }
    Action::TurnComplete { turn_id, .. } | Action::TurnCancelled { turn_id, .. } => {
      if s.turn.as_deref() == Some(turn_id.as_str()) {
        s.turn = None;
        s.tools.clear();
      }
      settle_phase(s);
    }
    Action::Usage { input_tokens, output_tokens, cost_usd, context_used, context_max, .. } => {
      s.usage.input_tokens += input_tokens;
      s.usage.output_tokens += output_tokens;
      s.usage.cost_usd += cost_usd.unwrap_or(0.0);
      if context_used.is_some() {
        s.usage.context_used = *context_used;
        s.usage.context_max = *context_max;
      }
    }
    Action::Error { message, .. } => s.last_error = Some(message.clone()),
    Action::InputRequested { request_id, input_kind, tool, .. } => {
      if s.phase != Phase::Ended && !s.pending.iter().any(|p| &p.request_id == request_id) {
        s.pending.push(PendingInput { request_id: request_id.clone(), kind: *input_kind, tool: tool.clone() });
      }
      settle_phase(s);
    }
    Action::InputResolved { request_id, .. } => {
      s.pending.retain(|p| &p.request_id != request_id);
      settle_phase(s);
    }
  }
}

fn preview(s: &str, max: usize) -> String {
  let line = s.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
  if line.chars().count() > max { format!("{}…", line.chars().take(max - 1).collect::<String>()) } else { line.to_owned() }
}

/// AskUserQuestion (claude), request_user_input (codex), ask_user (copilot), AskUser (droid)…
/// (agentHooks.ts `isQuestionTool`, Orca `isAskUserQuestionTool`).
pub fn is_question_tool(name: &str) -> bool {
  let n: String = name.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
  matches!(n.as_str(), "askuserquestion" | "requestuserinput" | "askuser" | "question")
}

/// Turn ids count every turn the session ever started (across generations): unique per session.
pub fn next_turn(s: &SessionState) -> String {
  format!("t{}", s.turns + 1)
}

/// The actions a sidecar event of a chat or task run means, given the session as it is.
/// Turns a prompt starts are added by `Supervisor::prompt`; content arriving with no open turn
/// (a follow-up the SDK picked up after the last result) opens one itself.
pub fn from_agent_event(s: &SessionState, ev: &AgentEvent) -> Vec<Action> {
  let sid = s.info.id.clone();
  let mut out = Vec::new();
  let ended = s.phase == Phase::Ended;
  let t = s.turn.clone().unwrap_or_else(|| next_turn(s));
  match ev {
    AgentEvent::System { session_id: Some(id), .. } | AgentEvent::Result { session_id: Some(id), .. } if s.provider_session_id.as_deref() != Some(id) => {
      out.push(Action::ProviderSessionSet { session_id: sid.clone(), provider_session_id: id.clone() });
    }
    _ => {}
  }
  if ended {
    return out;
  }
  match ev {
    AgentEvent::Message { role, text, parent_tool_use_id } if role == "assistant" => {
      out.push(Action::ResponsePart { session_id: sid.clone(), turn_id: t.clone(), part: PartKind::Text, text: text.clone(), parent_tool_call_id: parent_tool_use_id.clone() });
    }
    AgentEvent::Thinking { text, parent_tool_use_id } => {
      out.push(Action::ResponsePart { session_id: sid.clone(), turn_id: t.clone(), part: PartKind::Thinking, text: text.clone(), parent_tool_call_id: parent_tool_use_id.clone() });
    }
    AgentEvent::ToolUse { id, name, input, parent_tool_use_id } => {
      out.push(Action::ToolCallStart { session_id: sid.clone(), turn_id: t.clone(), tool_call_id: id.clone(), tool_name: name.clone(), parent_tool_call_id: parent_tool_use_id.clone() });
      out.push(Action::ToolCallDelta { session_id: sid.clone(), turn_id: t.clone(), tool_call_id: id.clone(), input: input.clone() });
    }
    AgentEvent::ToolResult { tool_use_id, content, is_error, .. } => {
      out.push(Action::ToolCallComplete { session_id: sid.clone(), turn_id: t.clone(), tool_call_id: tool_use_id.clone(), is_error: *is_error, result: Some(preview(content, 200)) });
    }
    AgentEvent::FileSnapshot { tool_use_id, path, .. } => {
      out.push(Action::ToolCallContentChanged { session_id: sid.clone(), turn_id: t.clone(), tool_call_id: tool_use_id.clone(), path: path.clone() });
    }
    AgentEvent::PermissionRequest { request_id, tool, title, input_summary, .. } => {
      let kind = if is_question_tool(tool) { InputKind::Question } else { InputKind::Permission };
      let message = title.clone().filter(|m| !m.is_empty()).or_else(|| (!input_summary.is_empty()).then(|| preview(input_summary, 80)));
      out.push(Action::InputRequested { session_id: sid.clone(), turn_id: Some(t.clone()), request_id: request_id.clone(), input_kind: kind, tool: Some(tool.clone()), message });
    }
    AgentEvent::PermissionResolved { request_id, decision } => {
      out.push(Action::InputResolved { session_id: sid.clone(), request_id: request_id.clone(), decision: decision.clone() });
    }
    AgentEvent::McpRequest { request_id, ask, server, message, .. } => {
      let kind = if ask == "elicitation" { InputKind::Elicitation } else { InputKind::Mcp };
      out.push(Action::InputRequested { session_id: sid.clone(), turn_id: Some(t.clone()), request_id: request_id.clone(), input_kind: kind, tool: Some(server.clone()), message: (!message.is_empty()).then(|| preview(message, 80)) });
    }
    AgentEvent::McpRequestResolved { request_id, action } => {
      out.push(Action::InputResolved { session_id: sid.clone(), request_id: request_id.clone(), decision: action.clone() });
    }
    AgentEvent::ContextUsage { used_tokens, max_tokens } => {
      out.push(Action::Usage { session_id: sid.clone(), turn_id: s.turn.clone(), input_tokens: 0, output_tokens: 0, cost_usd: None, context_used: Some(*used_tokens), context_max: Some(*max_tokens) });
    }
    AgentEvent::Result { is_error, result, usage, total_cost_usd, .. } => {
      if usage.is_some() || total_cost_usd.is_some() {
        let (i, o) = usage.as_ref().map_or((0, 0), |u| (u.input_tokens, u.output_tokens));
        out.push(Action::Usage { session_id: sid.clone(), turn_id: s.turn.clone(), input_tokens: i, output_tokens: o, cost_usd: *total_cost_usd, context_used: None, context_max: None });
      }
      if let Some(t) = &s.turn {
        out.push(Action::TurnComplete { session_id: sid.clone(), turn_id: t.clone(), is_error: *is_error, result: result.as_deref().map(|r| preview(r, 200)) });
      }
    }
    AgentEvent::Error { message } => {
      out.push(Action::Error { session_id: sid.clone(), turn_id: s.turn.clone(), message: message.clone() });
    }
    AgentEvent::Exit { code, signal, stopped } => {
      if let Some(t) = &s.turn {
        out.push(Action::TurnCancelled { session_id: sid.clone(), turn_id: t.clone(), reason: if *stopped { "stopped".into() } else { "exit".into() } });
      }
      let reason = if *stopped {
        "stopped"
      } else if code.unwrap_or(0) != 0 || signal.is_some() || s.last_error.is_some() {
        "failed"
      } else {
        "done"
      };
      out.push(Action::SessionEnded { session_id: sid.clone(), reason: reason.into() });
    }
    _ => {}
  }
  let content = out.iter().any(|a| matches!(a, Action::ResponsePart { .. } | Action::ToolCallStart { .. } | Action::ToolCallComplete { .. } | Action::ToolCallContentChanged { .. } | Action::InputRequested { .. }));
  if s.turn.is_none() && content {
    out.insert(0, Action::TurnStarted { session_id: sid, turn_id: t, prompt: None });
  }
  out
}

// ---------------------------------------------------------------------------------------------
// Hook events (terminal agents)

/// What the supervisor keeps per hook-reporting session beside its protocol state: the bytes of
/// its hook file already folded, and Orca's child roster (subagents keep the lead's turn open).
#[derive(Debug, Default, Clone)]
pub struct HookCursor {
  pub ingested: u64,
  subagents: BTreeSet<String>,
  lead_done: bool,
  seq: u64,
}

fn s_of<'a>(p: &'a Value, keys: &[&str]) -> Option<&'a str> {
  keys.iter().find_map(|k| p.get(*k).and_then(Value::as_str).filter(|v| !v.is_empty()))
}

fn tool_of(p: &Value) -> Option<String> {
  s_of(p, &["tool_name", "toolName", "name"]).map(str::to_owned).or_else(|| p.get("tool").and_then(|t| t.get("name")).and_then(Value::as_str).map(str::to_owned))
}

fn input_of(p: &Value) -> Value {
  ["tool_input", "toolInput", "input", "args", "arguments"].iter().find_map(|k| p.get(*k).cloned()).unwrap_or(Value::Null)
}

fn high_risk(p: &Value) -> bool {
  [Some(p), p.get("tool_input"), p.get("input"), p.get("arguments")]
    .into_iter()
    .flatten()
    .any(|x| x.get("riskLevel").and_then(Value::as_str) == Some("high") || x.get("risk_level").and_then(Value::as_str) == Some("high"))
}

#[derive(Debug, PartialEq)]
enum Hook {
  SessionStart,
  TurnStart(Option<String>),
  ToolStart { tool: Option<String>, id: Option<String>, input: Value },
  ToolEnd { id: Option<String>, tool: Option<String>, error: bool },
  Input { kind: InputKind, tool: Option<String>, message: Option<String> },
  /// Answered (the CLI went on): every open input resolves.
  Resume,
  TurnEnd { error: Option<String> },
  Interrupted,
  Part(String),
  SubagentStart(String),
  SubagentStop(String),
  SessionEnd,
  ProcessExit,
  Ignore,
}

const COPILOT_NAMES: &[(&str, &str)] = &[
  ("sessionStart", "SessionStart"),
  ("sessionEnd", "SessionEnd"),
  ("userPromptSubmitted", "UserPromptSubmit"),
  ("preToolUse", "PreToolUse"),
  ("postToolUse", "PostToolUse"),
  ("agentStop", "Stop"),
  ("errorOccurred", "ErrorOccurred"),
  ("notification", "Notification"),
  ("permissionRequest", "PermissionRequest"),
];

/// (provider, event, payload) of one hook line: Kingu's tagged status-hook lines, codex
/// `notify`, or a bare Claude Code hook payload.
fn split(ev: &Value) -> (String, String, Value) {
  if ev.get("type").and_then(Value::as_str) == Some("agent-turn-complete") {
    return ("codex-notify".into(), "agent-turn-complete".into(), ev.clone());
  }
  if let Some(provider) = ev.get("kingu_hook").and_then(Value::as_str) {
    let payload = ev.get("payload").filter(|p| p.is_object()).cloned().unwrap_or(Value::Object(Default::default()));
    let mut event = ev.get("event").and_then(Value::as_str).unwrap_or("").to_owned();
    if provider == "claude"
      && let Some(name) = payload.get("hook_event_name").and_then(Value::as_str)
    {
      event = name.to_owned();
    }
    return (provider.to_owned(), event, payload);
  }
  ("claude".into(), ev.get("hook_event_name").and_then(Value::as_str).unwrap_or("").to_owned(), ev.clone())
}

fn classify(provider: &str, event: &str, p: &Value, s: &SessionState) -> Hook {
  let tool = tool_of(p);
  let question = || Hook::Input { kind: InputKind::Question, tool: tool.clone(), message: None };
  let tool_start = || Hook::ToolStart { tool: tool.clone(), id: s_of(p, &["tool_use_id", "toolUseId"]).map(str::to_owned), input: input_of(p) };
  let tool_end = |error| Hook::ToolEnd { id: s_of(p, &["tool_use_id", "toolUseId"]).map(str::to_owned), tool: tool.clone(), error };
  let prompt = || s_of(p, &["prompt"]).map(|x| preview(x, 200));
  match provider {
    "codex-notify" => return Hook::TurnEnd { error: None },
    "kingu" => return if event == "ProcessExit" { Hook::ProcessExit } else { Hook::Ignore },
    "opencode" => {
      return match event {
        "SessionBusy" if s.turn.is_none() => Hook::TurnStart(None),
        "SessionBusy" => Hook::Resume,
        "SessionIdle" => Hook::TurnEnd { error: None },
        "SessionStart" => Hook::SessionStart,
        "PermissionRequest" => Hook::Input { kind: InputKind::Permission, tool: s_of(p, &["permission", "type"]).map(str::to_owned).or(tool), message: None },
        "AskUserQuestion" => question(),
        _ => Hook::Ignore,
      };
    }
    // codex reports its subagents' hooks too; only the lead's move the session (agentHooks.ts).
    "codex" if p.get("agent_id").is_some() => return Hook::Ignore,
    _ => {}
  }
  let name = COPILOT_NAMES.iter().find(|(from, _)| provider == "copilot" && *from == event).map_or(event, |(_, to)| to);
  let agent_id = s_of(p, &["agent_id"]).map(str::to_owned);
  match name {
    "SessionStart" | "sessionStart" => Hook::SessionStart,
    "UserPromptSubmit" | "BeforeAgent" | "beforeSubmitPrompt" => Hook::TurnStart(prompt()),
    "PreToolUse" | "BeforeTool" | "preToolUse" | "beforeShellExecution" | "beforeMCPExecution" => {
      if tool.as_deref().is_some_and(is_question_tool) {
        Hook::Input { kind: InputKind::Question, tool: tool.clone(), message: None }
      } else if provider == "droid" && high_risk(p) {
        Hook::Input { kind: InputKind::Permission, tool: tool.clone(), message: None }
      } else {
        tool_start()
      }
    }
    "PostToolUse" | "AfterTool" | "postToolUse" => tool_end(false),
    "PostToolUseFailure" | "postToolUseFailure" => tool_end(true),
    "PermissionRequest" => {
      if tool.as_deref().is_some_and(is_question_tool) {
        question()
      } else {
        Hook::Input { kind: InputKind::Permission, tool: tool.clone(), message: None }
      }
    }
    "Elicitation" => Hook::Input { kind: InputKind::Elicitation, tool: None, message: s_of(p, &["message"]).map(|m| preview(m, 80)) },
    "ElicitationResult" => Hook::Resume,
    "Notification" => {
      let kind = s_of(p, &["notification_type"]).unwrap_or("");
      let message = s_of(p, &["message"]).unwrap_or("");
      if kind == "elicitation_dialog" {
        return Hook::Input { kind: InputKind::Elicitation, tool: None, message: Some(preview(message, 80)).filter(|m| !m.is_empty()) };
      }
      let lower = message.to_ascii_lowercase();
      if provider == "droid" && lower.contains("waiting for") && lower.contains("input") {
        return Hook::TurnEnd { error: None };
      }
      // While a question is open, "waiting for your input" is about that question.
      if s.pending.iter().any(|i| i.kind != InputKind::Permission) {
        return Hook::Ignore;
      }
      let perm = kind == "permission_prompt" || lower.contains("permission") || (provider == "droid" && lower.contains("approv"));
      if perm { Hook::Input { kind: InputKind::Permission, tool: None, message: Some(preview(message, 80)).filter(|m| !m.is_empty()) } } else { Hook::Ignore }
    }
    "afterAgentResponse" => s_of(p, &["text"]).map_or(Hook::Ignore, |t| Hook::Part(t.to_owned())),
    "SubagentStart" => agent_id.map_or(Hook::Ignore, Hook::SubagentStart),
    "SubagentStop" => agent_id.map_or(Hook::Ignore, Hook::SubagentStop),
    // A subagent's own Stop carries its agent id; only the lead's ends the turn.
    "Stop" | "AfterAgent" | "stop" if agent_id.is_some() && provider == "claude" => Hook::Ignore,
    "Stop" | "AfterAgent" | "stop" => Hook::TurnEnd { error: None },
    "StopFailure" => Hook::TurnEnd { error: Some(s_of(p, &["message", "error"]).map_or_else(|| "error".to_owned(), |m| preview(m, 200))) },
    "ErrorOccurred" if p.get("recoverable").and_then(Value::as_bool) == Some(true) => Hook::Resume,
    "ErrorOccurred" => Hook::TurnEnd {
      error: Some(s_of(p, &["error"]).or_else(|| p.get("error").and_then(|e| e.get("message")).and_then(Value::as_str)).map_or_else(|| "error".to_owned(), |m| preview(m, 200))),
    },
    "Interrupt" => Hook::Interrupted,
    "PostCompact" if s.phase == Phase::Working => Hook::TurnEnd { error: None },
    "SessionEnd" if provider == "claude" => Hook::SessionEnd,
    "SessionEnd" | "sessionEnd" => Hook::TurnEnd { error: None },
    _ => Hook::Ignore,
  }
}

impl HookCursor {
  fn next(&mut self, what: &str) -> String {
    self.seq += 1;
    format!("{what}{}", self.seq)
  }

  /// The actions of one hook line for session `s`, in order. The caller applies each before
  /// normalizing the next line (`s` must be current).
  pub fn normalize(&mut self, s: &SessionState, ev: &Value) -> Vec<Action> {
    let sid = s.info.id.clone();
    let (provider, event, payload) = split(ev);
    let hook = classify(&provider, &event, &payload, s);
    let mut out = Vec::new();
    if s.phase == Phase::Ended && !matches!(hook, Hook::SessionStart | Hook::TurnStart(_)) {
      return out;
    }
    if provider != "codex-notify"
      && let Some(id) = s_of(&payload, &["session_id", "sessionID"])
      && s.provider_session_id.as_deref() != Some(id)
    {
      out.push(Action::ProviderSessionSet { session_id: sid.clone(), provider_session_id: id.to_owned() });
    }
    if provider == "codex-notify"
      && let Some(id) = s_of(&payload, &["thread-id"])
      && s.provider_session_id.as_deref() != Some(id)
    {
      out.push(Action::ProviderSessionSet { session_id: sid.clone(), provider_session_id: id.to_owned() });
    }
    // Whatever the CLI does next answers what it asked (agentHooks.ts: working()/idle() clear it).
    let resolves = matches!(hook, Hook::TurnStart(_) | Hook::ToolStart { .. } | Hook::ToolEnd { .. } | Hook::Resume | Hook::TurnEnd { .. } | Hook::Interrupted | Hook::SessionStart);
    if resolves {
      for p in &s.pending {
        out.push(Action::InputResolved { session_id: sid.clone(), request_id: p.request_id.clone(), decision: "answered".into() });
      }
    }
    let mut turn = s.turn.clone();
    let open_turn = |out: &mut Vec<Action>, cur: &mut Option<String>, prompt: Option<String>| -> String {
      if let Some(t) = cur.clone() {
        return t;
      }
      let t = next_turn(s);
      out.push(Action::TurnStarted { session_id: sid.clone(), turn_id: t.clone(), prompt });
      *cur = Some(t.clone());
      t
    };
    match hook {
      Hook::Ignore => {}
      Hook::SessionStart => {
        if s.phase == Phase::Ended {
          // A new CLI in the same pane: a new generation of the session.
          out.push(Action::SessionBound { session_id: sid.clone(), binding: s.binding.clone(), generation: s.generation + 1 });
        }
        if let Some(t) = &s.turn {
          out.push(Action::TurnComplete { session_id: sid.clone(), turn_id: t.clone(), is_error: false, result: None });
        } else if matches!(s.phase, Phase::Starting | Phase::Ended) {
          out.push(Action::SessionReady { session_id: sid.clone() });
        }
        self.subagents.clear();
        self.lead_done = false;
      }
      Hook::TurnStart(prompt) => {
        if s.phase == Phase::Ended {
          out.push(Action::SessionBound { session_id: sid.clone(), binding: s.binding.clone(), generation: s.generation + 1 });
        }
        if let Some(t) = &s.turn {
          // A new prompt while a turn is open (a steered message): the open one is done.
          out.push(Action::TurnComplete { session_id: sid.clone(), turn_id: t.clone(), is_error: false, result: None });
        }
        self.lead_done = false;
        let t = next_turn(s);
        out.push(Action::TurnStarted { session_id: sid.clone(), turn_id: t, prompt });
      }
      Hook::ToolStart { tool, id, input } => {
        self.lead_done = false;
        let t = open_turn(&mut out, &mut turn, None);
        let id = id.unwrap_or_else(|| self.next("h"));
        let name = tool.unwrap_or_else(|| "tool".into());
        out.push(Action::ToolCallStart { session_id: sid.clone(), turn_id: t.clone(), tool_call_id: id.clone(), tool_name: name, parent_tool_call_id: None });
        if !input.is_null() {
          out.push(Action::ToolCallDelta { session_id: sid.clone(), turn_id: t, tool_call_id: id, input });
        }
      }
      Hook::ToolEnd { id, tool, error } => {
        let t = open_turn(&mut out, &mut turn, None);
        let found = id.filter(|i| s.tools.contains_key(i)).or_else(|| {
          let by_name = tool.as_ref().and_then(|n| s.tools.iter().rev().find(|(_, v)| *v == n).map(|(k, _)| k.clone()));
          by_name.or_else(|| s.tools.keys().next_back().cloned())
        });
        if let Some(id) = found {
          out.push(Action::ToolCallComplete { session_id: sid.clone(), turn_id: t, tool_call_id: id, is_error: error, result: None });
        }
      }
      Hook::Input { kind, tool, message } => {
        let t = open_turn(&mut out, &mut turn, None);
        // One open ask per kind: a second PermissionRequest for the same prompt is not a new one.
        if !s.pending.iter().any(|p| p.kind == kind) {
          let request_id = self.next("in");
          out.push(Action::InputRequested { session_id: sid.clone(), turn_id: Some(t), request_id, input_kind: kind, tool, message });
        }
      }
      Hook::Resume => {
        if s.turn.is_none() && s.phase != Phase::Idle {
          open_turn(&mut out, &mut turn, None);
        }
      }
      Hook::Part(text) => {
        if let Some(t) = &s.turn {
          out.push(Action::ResponsePart { session_id: sid.clone(), turn_id: t.clone(), part: PartKind::Text, text: preview(&text, 200), parent_tool_call_id: None });
        }
      }
      Hook::TurnEnd { error } => {
        // Orca's roster rule: the lead's Stop while subagents still run is not the end.
        if !self.subagents.is_empty() && error.is_none() {
          self.lead_done = true;
          return out;
        }
        let t = turn.clone().unwrap_or_else(|| next_turn(s));
        if turn.is_none() {
          out.push(Action::TurnStarted { session_id: sid.clone(), turn_id: t.clone(), prompt: None });
        }
        if let Some(e) = &error {
          out.push(Action::Error { session_id: sid.clone(), turn_id: Some(t.clone()), message: e.clone() });
        }
        out.push(Action::TurnComplete { session_id: sid.clone(), turn_id: t, is_error: error.is_some(), result: None });
        self.lead_done = false;
      }
      Hook::Interrupted => {
        if let Some(t) = &s.turn {
          out.push(Action::TurnCancelled { session_id: sid.clone(), turn_id: t.clone(), reason: "interrupted".into() });
        }
      }
      Hook::SubagentStart(id) => {
        self.subagents.insert(id);
      }
      Hook::SubagentStop(id) => {
        if self.subagents.remove(&id) && self.subagents.is_empty() && self.lead_done {
          self.lead_done = false;
          if let Some(t) = &s.turn {
            out.push(Action::TurnComplete { session_id: sid.clone(), turn_id: t.clone(), is_error: false, result: None });
          }
        }
      }
      Hook::SessionEnd => {
        self.subagents.clear();
        out.push(Action::SessionEnded { session_id: sid.clone(), reason: "session_end".into() });
      }
      Hook::ProcessExit => {
        self.subagents.clear();
        out.push(Action::SessionEnded { session_id: sid.clone(), reason: "process_exit".into() });
      }
    }
    out
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn session(kind: SessionKind) -> SessionState {
    SessionState::new(
      SessionInfo { id: "s1".into(), kind, owner: "task:/r:a".into(), root: Some("/r".into()), slug: Some("a".into()), worktree: Some("/r/w".into()), scope: "x".into(), agent: None },
      0,
    )
  }

  fn run_chat(s: &mut SessionState, evs: Vec<Value>) -> Vec<Action> {
    let mut all = Vec::new();
    for v in evs {
      for a in from_agent_event(s, &AgentEvent::from_host(v)) {
        apply(s, &a, 1);
        all.push(a);
      }
    }
    all
  }

  fn run_hooks(s: &mut SessionState, c: &mut HookCursor, evs: Vec<Value>) -> Vec<Action> {
    let mut all = Vec::new();
    for v in evs {
      for a in c.normalize(s, &v) {
        apply(s, &a, 1);
        all.push(a);
      }
    }
    all
  }

  fn types(a: &[Action]) -> Vec<String> {
    a.iter().map(|a| serde_json::to_value(a).unwrap()["type"].as_str().unwrap().to_owned()).collect()
  }

  #[test]
  fn chat_events_make_a_turn_with_a_full_tool_lifecycle() {
    let mut s = session(SessionKind::Chat);
    let acts = run_chat(
      &mut s,
      vec![
        json!({"kind": "system", "subtype": "init", "session_id": "sdk-1"}),
        json!({"kind": "tool_use", "id": "tu1", "name": "Edit", "input": {"file_path": "a.ts"}}),
        json!({"kind": "file_snapshot", "tool_use_id": "tu1", "tool": "Edit", "path": "a.ts", "existed": true}),
        json!({"kind": "permission_request", "request_id": "r1", "tool": "Edit", "input_summary": "a.ts"}),
      ],
    );
    assert_eq!(types(&acts), ["session/providerSessionSet", "turn/started", "toolCall/start", "toolCall/delta", "toolCall/contentChanged", "inputRequested"]);
    assert_eq!(s.phase, Phase::Waiting);
    assert_eq!(s.pending.len(), 1);
    let acts = run_chat(
      &mut s,
      vec![
        json!({"kind": "permission_resolved", "request_id": "r1", "decision": "allow"}),
        json!({"kind": "tool_result", "tool_use_id": "tu1", "content": "ok", "is_error": false}),
        json!({"kind": "message", "role": "assistant", "text": "done"}),
        json!({"kind": "result", "subtype": "success", "is_error": false, "result": "done", "session_id": "sdk-1", "usage": {"input_tokens": 3, "output_tokens": 4}, "total_cost_usd": 0.5}),
      ],
    );
    assert_eq!(types(&acts), ["inputResolved", "toolCall/complete", "turn/responsePart", "usage", "turn/complete"]);
    assert_eq!((s.phase, s.turn.is_none(), s.turns, s.usage.output_tokens), (Phase::Idle, true, 1, 4));
    let acts = run_chat(&mut s, vec![json!({"kind": "exit", "code": 0, "signal": null, "stopped": false})]);
    assert_eq!(types(&acts), ["session/ended"]);
    assert_eq!(s.phase, Phase::Ended);
  }

  #[test]
  fn an_exit_mid_turn_cancels_it_and_drops_open_inputs() {
    let mut s = session(SessionKind::Run);
    run_chat(&mut s, vec![json!({"kind": "mcp_request", "request_id": "m1", "type": "elicitation", "server": "srv"})]);
    assert_eq!(s.pending[0].kind, InputKind::Elicitation);
    let acts = run_chat(&mut s, vec![json!({"kind": "exit", "code": null, "signal": null, "stopped": true})]);
    assert_eq!(types(&acts), ["turn/cancelled", "session/ended"]);
    assert!(s.pending.is_empty());
    // Nothing after the end opens a turn again.
    assert!(run_chat(&mut s, vec![json!({"kind": "permission_request", "request_id": "r", "tool": "X", "input_summary": ""})]).iter().all(|a| !matches!(a, Action::TurnStarted { .. })));
    assert!(s.pending.is_empty());
  }

  #[test]
  fn claude_hooks_follow_agent_hooks_ts() {
    let mut s = session(SessionKind::Tui);
    let mut c = HookCursor::default();
    run_hooks(&mut s, &mut c, vec![json!({"hook_event_name": "SessionStart", "session_id": "c-1"})]);
    assert_eq!((s.phase, s.provider_session_id.as_deref()), (Phase::Idle, Some("c-1")));
    let acts = run_hooks(
      &mut s,
      &mut c,
      vec![
        json!({"hook_event_name": "UserPromptSubmit", "prompt": "fix it"}),
        json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_use_id": "tu1", "tool_input": {"command": "ls"}}),
        json!({"hook_event_name": "PermissionRequest", "tool_name": "Bash"}),
      ],
    );
    assert_eq!(types(&acts), ["turn/started", "toolCall/start", "toolCall/delta", "inputRequested"]);
    assert_eq!(s.phase, Phase::Waiting);
    let acts = run_hooks(&mut s, &mut c, vec![json!({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_use_id": "tu1"}), json!({"hook_event_name": "Stop"})]);
    assert_eq!(types(&acts), ["inputResolved", "toolCall/complete", "turn/complete"]);
    assert_eq!(s.phase, Phase::Idle);
    run_hooks(&mut s, &mut c, vec![json!({"hook_event_name": "SessionEnd"})]);
    assert_eq!(s.phase, Phase::Ended);
  }

  #[test]
  fn questions_and_subagents() {
    let mut s = session(SessionKind::Pane);
    let mut c = HookCursor::default();
    run_hooks(&mut s, &mut c, vec![json!({"kingu_hook": "claude", "event": "x", "payload": {"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion", "tool_input": {}}})]);
    assert_eq!((s.phase, s.pending[0].kind), (Phase::Waiting, InputKind::Question));
    // "Waiting for your input" while the question is open is about that question.
    run_hooks(&mut s, &mut c, vec![json!({"hook_event_name": "Notification", "message": "Claude needs your permission"})]);
    assert_eq!(s.pending.len(), 1);
    run_hooks(&mut s, &mut c, vec![json!({"hook_event_name": "SubagentStart", "agent_id": "a1"}), json!({"hook_event_name": "PostToolUse", "tool_name": "AskUserQuestion"}), json!({"hook_event_name": "Stop"})]);
    // The lead stopped while a subagent runs: still working.
    assert_eq!(s.phase, Phase::Working);
    run_hooks(&mut s, &mut c, vec![json!({"hook_event_name": "Stop", "agent_id": "a1"}), json!({"hook_event_name": "SubagentStop", "agent_id": "a1"})]);
    assert_eq!(s.phase, Phase::Idle);
  }

  #[test]
  fn other_clis_and_codex_notify() {
    let mut s = session(SessionKind::Tui);
    let mut c = HookCursor::default();
    run_hooks(&mut s, &mut c, vec![json!({"kingu_hook": "gemini", "event": "BeforeAgent", "payload": {"prompt": "hi"}}), json!({"kingu_hook": "gemini", "event": "BeforeTool", "payload": {"tool_name": "ls"}})]);
    assert_eq!((s.phase, s.tools.len()), (Phase::Working, 1));
    run_hooks(&mut s, &mut c, vec![json!({"kingu_hook": "gemini", "event": "AfterTool", "payload": {}}), json!({"kingu_hook": "gemini", "event": "AfterAgent", "payload": {}})]);
    assert_eq!((s.phase, s.tools.len()), (Phase::Idle, 0));
    run_hooks(&mut s, &mut c, vec![json!({"kingu_hook": "copilot", "event": "permissionRequest", "payload": {"toolName": "shell"}})]);
    assert_eq!(s.phase, Phase::Waiting);
    run_hooks(&mut s, &mut c, vec![json!({"type": "agent-turn-complete", "thread-id": "th-1", "last-assistant-message": "ok"})]);
    assert_eq!((s.phase, s.provider_session_id.as_deref()), (Phase::Idle, Some("th-1")));
    run_hooks(&mut s, &mut c, vec![json!({"kingu_hook": "codex", "event": "UserPromptSubmit", "payload": {"agent_id": "sub"}})]);
    assert_eq!(s.phase, Phase::Idle);
    run_hooks(&mut s, &mut c, vec![json!({"kingu_hook": "opencode", "event": "SessionBusy", "payload": {}})]);
    assert_eq!(s.phase, Phase::Working);
    run_hooks(&mut s, &mut c, vec![json!({"kingu_hook": "kingu", "event": "ProcessExit"})]);
    assert_eq!(s.phase, Phase::Ended);
    // A new CLI in the same pane: a new generation.
    run_hooks(&mut s, &mut c, vec![json!({"hook_event_name": "UserPromptSubmit", "prompt": "again"})]);
    assert_eq!((s.phase, s.generation, s.turn.as_deref()), (Phase::Working, 1, Some("t4")));
  }

  #[test]
  fn actions_serialize_with_agent_host_names() {
    let a = Action::ToolCallStart { session_id: "s".into(), turn_id: "t".into(), tool_call_id: "c".into(), tool_name: "Bash".into(), parent_tool_call_id: None };
    assert_eq!(serde_json::to_value(&a).unwrap(), json!({"type": "toolCall/start", "session_id": "s", "turn_id": "t", "tool_call_id": "c", "tool_name": "Bash"}));
    let back: Action = serde_json::from_value(serde_json::to_value(&a).unwrap()).unwrap();
    assert_eq!(back, a);
  }
}
