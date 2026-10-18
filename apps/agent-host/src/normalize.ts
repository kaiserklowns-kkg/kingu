// SDK messages → normalized `AgentEvent`s (the shape the desktop app renders).
// Pure and loosely typed on input, so a newer SDK adding fields or message types never breaks it:
// anything unrecognized becomes a `raw` event instead of being dropped.

import type { AgentEvent, DiffStats, Usage } from './protocol.ts';

/** Tool results can be whole files; the timeline only needs a preview. */
export const MAX_TOOL_RESULT_CHARS = 4000;
const MAX_SUMMARY_CHARS = 500;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function truncate(s: string, max: number): string {
	const chars = Array.from(s);
	return chars.length > max ? `${chars.slice(0, max).join('')}…` : s;
}

/** `tool_result.content` is a string or a list of `{type:"text",text}` blocks. */
function contentText(v: unknown): string {
	if (typeof v === 'string') return v;
	if (Array.isArray(v)) return v.map((b) => (isObj(b) && typeof b.text === 'string' ? b.text : JSON.stringify(b))).join('\n');
	if (v == null) return '';
	return JSON.stringify(v);
}

function blocks(msg: Obj, role: string): AgentEvent[] | null {
	const content = isObj(msg.message) ? msg.message.content : undefined;
	// A subagent's message (inside a Task/Agent call): its events name that call, so the chat nests them.
	const parentId = str(msg.parent_tool_use_id);
	const parent = parentId ? { parent_tool_use_id: parentId } : {};
	if (typeof content === 'string') return [{ kind: 'message', role, text: content, ...parent }];
	if (!Array.isArray(content)) return null;
	return content.map((b): AgentEvent => {
		if (!isObj(b)) return { kind: 'raw', line: JSON.stringify(b) };
		switch (b.type) {
			case 'text':
				return { kind: 'message', role, text: str(b.text) ?? '', ...parent };
			case 'thinking':
				return { kind: 'thinking', text: str(b.thinking) ?? '', ...parent };
			case 'tool_use':
				return { kind: 'tool_use', id: str(b.id) ?? '', name: str(b.name) ?? '', input: b.input ?? null, ...parent };
			case 'tool_result':
				return {
					kind: 'tool_result',
					tool_use_id: str(b.tool_use_id) ?? '',
					content: truncate(contentText(b.content), MAX_TOOL_RESULT_CHARS),
					is_error: b.is_error === true,
					...parent
				};
			default:
				return { kind: 'raw', line: JSON.stringify(b) };
		}
	});
}

/** UUIDs as the SDK writes them (any case, with dashes). */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/**
 * `events` then an `anchor` with the message's uuid, for a message of the session's main chain:
 * not a subagent's (`parent_tool_use_id`) and not one replayed from the log.
 */
function withAnchor(msg: Obj, events: AgentEvent[]): AgentEvent[] {
	if (!isUuid(msg.uuid) || msg.parent_tool_use_id || msg.isReplay) return events;
	return [...events, { kind: 'anchor', uuid: msg.uuid }];
}

/** Totals over `modelUsage` (all models, subagents included); falls back to the main-loop `usage`. */
export function usageOf(msg: Obj): Usage | null {
	const total: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
	if (isObj(msg.modelUsage) && Object.keys(msg.modelUsage).length) {
		for (const m of Object.values(msg.modelUsage)) {
			if (!isObj(m)) continue;
			total.input_tokens += num(m.inputTokens) ?? 0;
			total.output_tokens += num(m.outputTokens) ?? 0;
			total.cache_read_input_tokens += num(m.cacheReadInputTokens) ?? 0;
			total.cache_creation_input_tokens += num(m.cacheCreationInputTokens) ?? 0;
		}
		return total;
	}
	if (isObj(msg.usage)) {
		const u = msg.usage;
		return {
			input_tokens: num(u.input_tokens) ?? 0,
			output_tokens: num(u.output_tokens) ?? 0,
			cache_read_input_tokens: num(u.cache_read_input_tokens) ?? 0,
			cache_creation_input_tokens: num(u.cache_creation_input_tokens) ?? 0
		};
	}
	return null;
}

/** Maps one SDK message to events; unknown messages become `raw`. */
export function normalize(msg: unknown): AgentEvent[] {
	const raw = (): AgentEvent[] => [{ kind: 'raw', line: truncate(JSON.stringify(msg) ?? String(msg), MAX_TOOL_RESULT_CHARS) }];
	if (!isObj(msg)) return raw();
	switch (msg.type) {
		case 'system':
			if (msg.subtype !== 'init') return []; // status/hook/task chatter: not timeline material
			return [{ kind: 'system', subtype: 'init', session_id: str(msg.session_id), model: str(msg.model) }];
		case 'assistant':
			return withAnchor(msg, blocks(msg, 'assistant') ?? raw());
		case 'user':
			// Replayed/synthetic user turns only carry tool results worth showing. A subagent's prompt
			// (user text under a Task call) is that call's input already, and never a new request.
			return withAnchor(msg, (blocks(msg, 'user') ?? raw()).filter((e) => e.kind !== 'message' || !(msg.isSynthetic || msg.parent_tool_use_id)));
		case 'stream_event': {
			const ev = isObj(msg.event) ? msg.event : null;
			if (!ev || ev.type !== 'content_block_delta' || !isObj(ev.delta) || msg.parent_tool_use_id) return [];
			const d = ev.delta;
			if (d.type === 'text_delta' && typeof d.text === 'string') return [{ kind: 'delta', block: 'text', text: d.text }];
			if (d.type === 'thinking_delta' && typeof d.thinking === 'string') return [{ kind: 'delta', block: 'thinking', text: d.thinking }];
			return [];
		}
		case 'result': {
			const errors = Array.isArray(msg.errors) ? msg.errors.filter((e) => typeof e === 'string').join('\n') : '';
			return [
				{
					kind: 'result',
					subtype: str(msg.subtype) ?? '',
					is_error: msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype.startsWith('error')),
					result: str(msg.result) ?? (errors || null),
					session_id: str(msg.session_id),
					num_turns: num(msg.num_turns),
					duration_ms: num(msg.duration_ms),
					total_cost_usd: num(msg.total_cost_usd),
					usage: usageOf(msg)
				}
			];
		}
		default:
			return raw();
	}
}

// ---------------------------------------------------------------------------------------------
// Permission request summaries

const lineCount = (s: unknown) => (typeof s === 'string' && s.length ? s.split('\n').length : 0);

/** Readable one-liner plus diff stats for a tool call awaiting approval. */
export function summarizeTool(tool: string, input: unknown): { summary: string; detail: string | null; diff: DiffStats | null } {
	const o = isObj(input) ? input : {};
	const path = str(o.file_path) ?? str(o.notebook_path) ?? str(o.path);
	let summary = '';
	let detail: string | null = null;
	let diff: DiffStats | null = null;
	switch (tool) {
		case 'Bash':
			summary = str(o.command) ?? '';
			detail = str(o.description);
			break;
		case 'Edit':
			summary = path ?? '';
			diff = { added: lineCount(o.new_string), removed: lineCount(o.old_string) };
			break;
		case 'MultiEdit': {
			summary = path ?? '';
			const edits = Array.isArray(o.edits) ? o.edits.filter(isObj) : [];
			diff = edits.reduce<DiffStats>((d, e) => ({ added: d.added + lineCount(e.new_string), removed: d.removed + lineCount(e.old_string) }), { added: 0, removed: 0 });
			break;
		}
		case 'Write':
			summary = path ?? '';
			diff = { added: lineCount(o.content), removed: 0 };
			break;
		case 'NotebookEdit':
			summary = path ?? '';
			diff = { added: lineCount(o.new_source), removed: 0 };
			break;
		case 'WebFetch':
			summary = str(o.url) ?? '';
			detail = str(o.prompt);
			break;
		case 'WebSearch':
			summary = str(o.query) ?? '';
			break;
		case 'AskUserQuestion':
			// The questions themselves; their options travel in `input`.
			summary = (Array.isArray(o.questions) ? o.questions : []).map((q) => (isObj(q) ? (str(q.question) ?? '') : '')).filter(Boolean).join('\n');
			break;
		default: {
			const first = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description'].map((k) => str(o[k])).find((v) => v);
			summary = first ?? (Object.keys(o).length ? JSON.stringify(o) : '');
		}
	}
	return { summary: truncate(summary.trim(), MAX_SUMMARY_CHARS), detail: detail && truncate(detail, MAX_SUMMARY_CHARS), diff };
}
