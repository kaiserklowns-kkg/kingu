// Mirrors `AgentEvent` / `WorktreeInfo` in src-tauri/src/agent (and apps/agent-host/src/protocol.ts),
// plus the pure reducer that folds a run's events into what the UI shows.

export type Usage = {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
};

export type Decision = 'allow' | 'allow_always' | 'deny';

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
};

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

export type AgentEvent =
	| { kind: 'system'; subtype: string; session_id: string | null; model: string | null }
	| { kind: 'message'; role: string; text: string }
	| { kind: 'delta'; block: 'text' | 'thinking' | string; text: string }
	| { kind: 'thinking'; text: string }
	| { kind: 'tool_use'; id: string; name: string; input: unknown }
	| { kind: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }
	| ResultEvent
	| PermissionRequest
	| { kind: 'permission_resolved'; request_id: string; decision: Decision | 'cancelled' }
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

export const STATUS_LABEL: Record<RunStatus, string> = {
	starting: 'กำลังเริ่ม',
	running: 'กำลังทำงาน',
	waiting: 'รอคุณ',
	idle: 'พร้อมรับคำสั่ง',
	stopped: 'หยุดแล้ว',
	failed: 'ล้มเหลว',
	done: 'จบแล้ว'
};

/** Timeline entries: every event except streaming deltas and permission bookkeeping. */
export type TimelineEvent = Exclude<AgentEvent, { kind: 'delta' } | { kind: 'permission_resolved' }>;

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
		ended: false
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
		case 'permission_request':
			if (!s.ended) {
				s.pending.push(ev);
				s.status = 'waiting';
			}
			break;
		case 'message':
			if (ev.role === 'assistant') s.draft.text = '';
			else if (!s.ended) s.status = live(s);
			break;
		case 'thinking':
			s.draft.thinking = '';
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
