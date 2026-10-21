// Mirrors `AgentEvent` / `WorktreeInfo` in src-tauri/src/agent (and apps/agent-host/src/protocol.ts),
// plus the pure reducer that folds a run's events into what the UI shows.

import { t } from '#lib/i18n/index.ts';
import type { ArtifactEvent } from '#lib/artifacts/artifacts.ts';

export type Usage = {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
};

/**
 * `allow` once; "always" for this session (`allow_always`), this folder (`allow_workspace`: the
 * folder's `.claude/settings.local.json`, not committed) or everywhere (`allow_user`); or `deny`.
 */
export type Decision = 'allow' | 'allow_always' | 'allow_workspace' | 'allow_user' | 'deny';

/** A slash command the session knows (SDK `supportedCommands()`). */
export type SessionCommand = { name: string; description: string; argument_hint: string };

/** A model the session can use (SDK `supportedModels()`). */
export type ModelOption = { value: string; display_name: string; description: string };

/** How full the context window was after the last turn. */
export type ContextUsage = { used: number; max: number };

export type PermissionRequest = {
	kind: 'permission_request';
	request_id: string;
	tool: string;
	tool_use_id: string | null;
	title: string | null;
	input_summary: string;
	detail: string | null;
	diff: { added: number; removed: number } | null;
	input: unknown;
	can_always: boolean;
	/** The rules an "always" answer adds (`Bash(npm test:*)`); absent or empty: the whole tool. */
	rules?: string[];
	/** Added by Rust (agent/tool_rules): the `chat.tools.*.autoApprove` rule "Always allow" writes (toolRules.ts). */
	auto_approve?: RuleSuggestion | null;
};

/** `keys` set to true in the object setting `setting` (`chat.tools.terminal.autoApprove` or `chat.tools.urls.autoApprove`). */
export type RuleSuggestion = { setting: string; keys: string[] };

/** Why Kingu asked before a call, whatever the permission mode (agent-host guards/asks.ts). */
export type GuardAsked = { kind: 'guard_asked'; request_id: string; tool: string; tool_use_id: string | null; check: 'outside_cwd' | 'delete' | 'protected' | 'mcp' | 'edit_rule'; paths: string[] };

/** Added by Rust in place of a prompt the `chat.tools.*.autoApprove` rules approved (Rust answered it). */
export type ToolAutoApproved = { kind: 'tool_auto_approved'; request_id: string; tool: string; tool_use_id: string | null; rules: string[] };

/** A vote on an answer (VS Code's helpful / unhelpful). */
export type Vote = 'up' | 'down';

export type ResultEvent = {
	kind: 'result';
	subtype: string;
	is_error: boolean;
	result: string | null;
	session_id: string | null;
	num_turns: number | null;
	duration_ms: number | null;
	total_cost_usd: number | null;
	usage?: Usage | null;
};

/** On a subagent's own events: the id of the Task/Agent `tool_use` that started it (absent otherwise). */
type Parent = { parent_tool_use_id?: string | null };

export type AgentEvent =
	| { kind: 'system'; subtype: string; session_id: string | null; model: string | null }
	/** What the session started with: its slash command names, tools and MCP servers. Not a timeline entry. */
	| { kind: 'session_info'; slash_commands: string[]; tools: string[]; mcp_servers: { name: string; status: string }[] }
	/** The session's MCP servers now (status, error, source, tools); replaces the last list. Not a timeline entry. */
	| { kind: 'mcp_status'; servers: { name: string; status: string; error: string | null; source: string | null; tools: string[] }[] }
	/** The session's slash commands with descriptions; replaces the last list. Not a timeline entry. */
	| { kind: 'commands'; commands: SessionCommand[] }
	/** The models the session can switch to; replaces the last list (modelCatalog). Not a timeline entry. */
	| { kind: 'models'; models: ModelOption[] }
	/** How full the context window is after a turn. Not a timeline entry. */
	| { kind: 'context_usage'; used_tokens: number; max_tokens: number }
	| ({ kind: 'message'; role: string; text: string } & Parent)
	| { kind: 'delta'; block: 'text' | 'thinking' | string; text: string }
	| ({ kind: 'thinking'; text: string } & Parent)
	| ({ kind: 'tool_use'; id: string; name: string; input: unknown } & Parent)
	| ({ kind: 'tool_result'; tool_use_id: string; content: string; is_error: boolean } & Parent)
	| ResultEvent
	| PermissionRequest
	| { kind: 'permission_resolved'; request_id: string; decision: Decision | 'cancelled' }
	/** Added by Rust after a chat's user message: that message is request `request` (its checkpoint). */
	| { kind: 'checkpoint'; request: number }
	/** Added by Rust: the chat's working set changed (chatEdits reloads it). Not a timeline entry. */
	| { kind: 'edits_changed'; request: number | null }
	/** Kingu's safety check refused a tool call (agent-host guards/), in any permission mode. */
	| { kind: 'guard_blocked'; tool: string; tool_use_id: string | null; check: 'security' | 'repetition'; threats: string[]; detail: string }
	/** Kingu's always-ask check stopped a call for the user (any permission mode); its `permission_request` follows. */
	| GuardAsked
	/** A tool call the user's auto-approve rules let run without a prompt; its row says by which rule. */
	| ToolAutoApproved
	/** The agent published an artifact (its `artifact_publish` tool): the chat shows a card that opens it. */
	| ArtifactEvent
	/** The user's thumbs up / down on the answer to chat request `request` (null: taken back). Kept in the transcript. */
	| { kind: 'feedback'; request: number; vote: Vote | null }
	| { kind: 'error'; message: string }
	| { kind: 'raw'; line: string }
	| { kind: 'stderr'; line: string }
	| { kind: 'exit'; code: number | null; signal: number | null; stopped: boolean };

export type WorktreeInfo = {
	path: string;
	head: string | null;
	branch: string | null;
	slug: string | null;
	bare: boolean;
	detached: boolean;
	locked: boolean;
	prunable: boolean;
};

// ---------------------------------------------------------------------------------------------
// Run state

/**
 * starting: asked Rust to start · running: a turn is in progress · waiting: a permission prompt
 * needs the user · idle: turn finished, session open for follow-ups · stopped/failed/done: ended.
 */
export type RunStatus = 'starting' | 'running' | 'waiting' | 'idle' | 'stopped' | 'failed' | 'done';

/** A run status in the UI language. Getters, so `STATUS_LABEL[s]` in markup follows kingu.uiLanguage. */
export const STATUS_LABEL: Readonly<Record<RunStatus, string>> = {
	get starting() {
		return t('team.agent.status.starting');
	},
	get running() {
		return t('team.agent.status.running');
	},
	get waiting() {
		return t('team.agent.status.waiting');
	},
	get idle() {
		return t('team.agent.status.idle');
	},
	get stopped() {
		return t('team.agent.status.stopped');
	},
	get failed() {
		return t('team.agent.status.failed');
	},
	get done() {
		return t('team.agent.status.done');
	}
};

/** Timeline entries: every event except streaming deltas and permission bookkeeping. */
export type TimelineEvent = Exclude<
	AgentEvent,
	{ kind: 'delta' } | { kind: 'permission_resolved' } | { kind: 'edits_changed' } | { kind: 'session_info' } | { kind: 'commands' } | { kind: 'models' } | { kind: 'mcp_status' } | { kind: 'context_usage' }
>;

export type RunState = {
	status: RunStatus;
	items: TimelineEvent[];
	/** Streaming text/thinking not yet replaced by its complete message. */
	draft: { text: string; thinking: string };
	/** Unanswered permission requests, oldest first. */
	pending: PermissionRequest[];
	/** Answers by request id, so timeline cards can show what was decided. */
	decisions: Record<string, Decision | 'cancelled'>;
	sessionId: string | null;
	model: string | null;
	/** Latest result (its cost and usage are cumulative for the session). */
	result: ResultEvent | null;
	error: string | null;
	ended: boolean;
	/** The session's slash commands: with descriptions once listed, else the names from its start. */
	commands: SessionCommand[];
	/** After the last turn; null until one has finished. */
	context: ContextUsage | null;
};

/** Oldest timeline entries are dropped past this, so a long session stays responsive. */
export const MAX_ITEMS = 3000;

export function initialRun(): RunState {
	return {
		status: 'starting',
		items: [],
		draft: { text: '', thinking: '' },
		pending: [],
		decisions: {},
		sessionId: null,
		model: null,
		result: null,
		error: null,
		ended: false,
		commands: [],
		context: null
	};
}

const live = (s: RunState): RunStatus => (s.pending.length ? 'waiting' : 'running');

/** Folds one event into the run (mutates `s`, so it works on Svelte `$state` proxies too). */
export function applyEvent(s: RunState, ev: AgentEvent): void {
	switch (ev.kind) {
		case 'delta':
			if (ev.block === 'thinking') s.draft.thinking += ev.text;
			else s.draft.text += ev.text;
			if (!s.ended) s.status = live(s);
			return;
		case 'permission_resolved':
			s.pending = s.pending.filter((p) => p.request_id !== ev.request_id);
			s.decisions[ev.request_id] = ev.decision;
			if (!s.ended) s.status = live(s);
			return;
		case 'edits_changed':
			return;
		case 'session_info':
			// Names only: a list with descriptions (`commands`) is not replaced by them.
			if (!s.commands.some((c) => c.description || c.argument_hint)) s.commands = ev.slash_commands.map((name) => ({ name, description: '', argument_hint: '' }));
			return;
		case 'commands':
			s.commands = ev.commands;
			return;
		case 'models':
		case 'mcp_status':
			// Kept by the MCP store (mcp/mcp.svelte.ts), not by the run.
			return;
		case 'context_usage':
			if (ev.max_tokens > 0) s.context = { used: ev.used_tokens, max: ev.max_tokens };
			return;
		case 'permission_request':
			if (!s.ended) {
				s.pending.push(ev);
				s.status = 'waiting';
			}
			break;
		case 'message':
			// A subagent's message does not end the main agent's streaming text (deltas are the main agent's).
			if (ev.parent_tool_use_id) break;
			if (ev.role === 'assistant') s.draft.text = '';
			else if (!s.ended) s.status = live(s);
			break;
		case 'thinking':
			if (!ev.parent_tool_use_id) s.draft.thinking = '';
			break;
		case 'system':
			s.sessionId = ev.session_id ?? s.sessionId;
			s.model = ev.model ?? s.model;
			if (!s.ended) s.status = live(s);
			break;
		case 'result':
			s.result = ev;
			s.sessionId = ev.session_id ?? s.sessionId;
			s.draft = { text: '', thinking: '' };
			if (!s.ended) s.status = s.pending.length ? 'waiting' : 'idle';
			break;
		case 'error':
			s.error = ev.message;
			break;
		case 'exit':
			s.ended = true;
			for (const p of s.pending) s.decisions[p.request_id] = 'cancelled';
			s.pending = [];
			s.draft = { text: '', thinking: '' };
			s.status = ev.stopped ? 'stopped' : s.error || (ev.code ?? 0) !== 0 || ev.signal != null ? 'failed' : 'done';
			break;
	}
	s.items.push(ev);
	if (s.items.length > MAX_ITEMS) s.items.splice(0, s.items.length - MAX_ITEMS);
}

/** True while the run can take a follow-up without being restarted. */
export const isLive = (s: Pick<RunState, 'ended' | 'status'>) => !s.ended && s.status !== 'starting';

// ---------------------------------------------------------------------------------------------
// Formatting

const MAX_SLUG = 48;

/** Task title → worktree slug (a-z, 0-9, '-'); titles with no ASCII letters (e.g. Thai) get a generated one. */
export function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, MAX_SLUG)
		.replace(/-+$/, '');
	return slug || `task-${Date.now().toString(36)}`;
}

const ARG_KEYS = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description'];

/** One-line argument summary for `● Tool(arg)` rows. */
export function toolArg(input: unknown, max = 80): string {
	let arg = '';
	if (input && typeof input === 'object') {
		const obj = input as Record<string, unknown>;
		const key = ARG_KEYS.find((k) => typeof obj[k] === 'string');
		const first = Object.values(obj).find((v) => typeof v === 'string');
		arg = String(key ? obj[key] : (first ?? ''));
	}
	arg = arg.replace(/\s+/g, ' ').trim();
	return arg.length > max ? `${arg.slice(0, max - 1)}…` : arg;
}

export function firstLine(text: string, max = 120): string {
	const line = text.trim().split('\n', 1)[0] ?? '';
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** "$0.0123 · 12.3k in · 456 out · 3 turns" for a result. */
export function formatUsage(r: Pick<ResultEvent, 'total_cost_usd' | 'usage' | 'num_turns'>): string {
	const parts: string[] = [];
	if (r.total_cost_usd != null) parts.push(`$${r.total_cost_usd.toFixed(4)}`);
	if (r.usage) {
		const input = r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens;
		parts.push(`${compact(input)} in`, `${compact(r.usage.output_tokens)} out`);
	}
	if (r.num_turns != null) parts.push(`${r.num_turns} turns`);
	return parts.join(' · ');
}
