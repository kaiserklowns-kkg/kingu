// The Agent Debug Log of a chat (VS Code's chat debug view, chatDebug/): rows Rust builds from the
// chat's transcript (`chat_debug_events`, agent/chat_debug.rs), and the view's filters. Pure, so
// `bun test` covers it; ChatDebugView.svelte draws it in an editor tab `chat-debug://<chat id>`.

/** Mirrors Rust `chat_debug::DebugEvent`. */
export type DebugEvent = {
	seq: number;
	t: number;
	kind: DebugKind;
	name: string;
	detail: string;
	duration_ms?: number;
	is_error: boolean;
	request?: number;
	subagent?: string;
	data: unknown;
};

export type DebugTotals = {
	requests: number;
	turns: number;
	tool_calls: number;
	tool_errors: number;
	hooks: number;
	errors: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
	cost_usd: number;
	duration_ms: number;
};

export type DebugLog = { chat_id: string; title: string; runtime: string; model: string | null; events: DebugEvent[]; totals: DebugTotals };

/** The row kinds, in the order the filter lists them. */
export const DEBUG_KINDS = ['run', 'session', 'user', 'assistant', 'thinking', 'tool', 'permission', 'guard', 'hook', 'turn', 'context', 'mcp', 'artifact', 'feedback', 'error', 'exit'] as const;
export type DebugKind = (typeof DEBUG_KINDS)[number];

/** The editor tab of a chat's debug log. */
export const CHAT_DEBUG_PREFIX = 'chat-debug://';
export const chatDebugKey = (id: string) => CHAT_DEBUG_PREFIX + id;
export const isChatDebugKey = (key: string) => key.startsWith(CHAT_DEBUG_PREFIX);
export function chatIdOfDebugKey(key: string): string | null {
	if (!isChatDebugKey(key)) return null;
	const id = key.slice(CHAT_DEBUG_PREFIX.length);
	return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ? id : null;
}

export type DebugFilter = { kinds: ReadonlySet<DebugKind>; query: string; errorsOnly?: boolean };

/** Text of a row the search looks at: its kind, name, summary and the event itself. */
function haystack(e: DebugEvent): string {
	let data = '';
	try {
		data = JSON.stringify(e.data) ?? '';
	} catch {
		// A cyclic value cannot come from Rust; leave it out.
	}
	return `${e.kind}\n${e.name}\n${e.detail}\n${data}`.toLowerCase();
}

/**
 * The rows the filter keeps: a kind turned on, errors only when asked, and the query's terms
 * (VS Code's debug filter): comma-separated, case-insensitive; `!term` leaves rows out, and of the
 * other terms at least one must match.
 */
export function filterDebugEvents(events: readonly DebugEvent[], filter: DebugFilter): DebugEvent[] {
	const terms = filter.query
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	const include = terms.filter((t) => !t.startsWith('!'));
	const exclude = terms
		.filter((t) => t.startsWith('!'))
		.map((t) => t.slice(1).trim())
		.filter(Boolean);
	return events.filter((e) => {
		if (!filter.kinds.has(e.kind)) return false;
		if (filter.errorsOnly && !e.is_error) return false;
		if (!include.length && !exclude.length) return true;
		const text = haystack(e);
		if (exclude.some((t) => text.includes(t))) return false;
		return !include.length || include.some((t) => text.includes(t));
	});
}

/** How many rows of each kind there are (for the filter's counts). */
export function kindCounts(events: readonly DebugEvent[]): Partial<Record<DebugKind, number>> {
	const out: Partial<Record<DebugKind, number>> = {};
	for (const e of events) out[e.kind] = (out[e.kind] ?? 0) + 1;
	return out;
}

/** `250 ms`, `2.6 s`, `1 m 05 s`. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
	const s = Math.round(ms / 1000);
	return `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, '0')} s`;
}

/** The row's time of day, `14:03:07.250`, and its offset from the log's first row, `+2.6 s`. */
export function rowTime(t: number, first: number): { clock: string; offset: string } {
	const d = new Date(t);
	const pad = (n: number, w = 2) => String(n).padStart(w, '0');
	return { clock: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`, offset: `+${formatDuration(Math.max(0, t - first))}` };
}
