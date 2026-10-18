// A run's events as VS Code's chat list: requests, each followed by its response made of parts
// (markdown, thinking, tool invocations, confirmations, errors). Internal events (session start,
// stderr, unknown SDK messages such as `rate_limit_event`) are not shown; the final `result` only
// closes the response (its text is the last assistant message again) and carries the usage shown
// on hover. Pure, so `bun test` covers it.

import { t } from '#lib/i18n/index.ts';
import { parseRequest, type ParsedRequest } from './chatPrompt';
import type { AgentEvent, PermissionRequest, ResultEvent, RunState, RunStatus } from './events';

export type ToolPart = {
	kind: 'tool';
	id: string;
	name: string;
	input: unknown;
	/** Set once the tool returned. */
	result?: { content: string; isError: boolean };
};

export type Part =
	| { kind: 'markdown'; text: string; streaming?: boolean }
	| { kind: 'thinking'; text: string; streaming?: boolean }
	| ToolPart
	| { kind: 'confirmation'; request: PermissionRequest }
	| { kind: 'error'; message: string }
	/** The turn was cut short (Stop, or the session ended mid-turn). */
	| { kind: 'canceled' };

export type Turn = {
	/** null for output before the first request (e.g. a run started elsewhere). */
	request: (ParsedRequest & { sent: string }) | null;
	parts: Part[];
	/** The turn's result (usage for the hover); null while it runs or when it was cut off. */
	result: ResultEvent | null;
	/** False while the agent is still working on it. */
	done: boolean;
	/** The chat request (checkpoint) index Rust gave the user message; null outside chats. */
	checkpoint?: number | null;
};

export type ChatView = Pick<RunState, 'items' | 'draft' | 'decisions' | 'ended'> & { status?: RunStatus };

/** Events the list never shows (logged instead). */
export function isInternal(ev: AgentEvent): boolean {
	return ev.kind === 'raw' || ev.kind === 'stderr' || ev.kind === 'system';
}

const lastPart = (turn: Turn) => turn.parts[turn.parts.length - 1];

function findTool(turns: Turn[], id: string): ToolPart | undefined {
	for (let i = turns.length - 1; i >= 0; i--) {
		for (const p of turns[i].parts) if (p.kind === 'tool' && p.id === id) return p;
	}
	return undefined;
}

/** Folds the run's timeline into requests and responses. */
export function buildTurns(run: ChatView): Turn[] {
	const turns: Turn[] = [];
	let cur: Turn | null = null;
	const current = (): Turn => {
		if (!cur) {
			cur = { request: null, parts: [], result: null, done: false };
			turns.push(cur);
		}
		return cur;
	};
	const close = (canceled: boolean) => {
		if (!cur || cur.done) return;
		cur.done = true;
		if (canceled && cur.request) cur.parts.push({ kind: 'canceled' });
	};
	for (const ev of run.items) {
		switch (ev.kind) {
			case 'message': {
				if (ev.role === 'user') {
					// A follow-up sent while the turn ran (an ADE task): the earlier turn just ends.
					close(false);
					cur = { request: { ...parseRequest(ev.text), sent: ev.text }, parts: [], result: null, done: false };
					turns.push(cur);
					break;
				}
				if (!ev.text.trim()) break;
				const turn = current();
				const prev = lastPart(turn);
				if (prev?.kind === 'markdown') prev.text = `${prev.text}\n\n${ev.text}`;
				else turn.parts.push({ kind: 'markdown', text: ev.text });
				break;
			}
			case 'thinking':
				if (ev.text.trim()) current().parts.push({ kind: 'thinking', text: ev.text });
				break;
			case 'tool_use':
				current().parts.push({ kind: 'tool', id: ev.id, name: ev.name, input: ev.input });
				break;
			case 'tool_result': {
				const tool = findTool(turns, ev.tool_use_id);
				if (tool) tool.result = { content: ev.content, isError: ev.is_error };
				break;
			}
			case 'permission_request': {
				const decided = run.decisions[ev.request_id];
				// Answered ones leave only the tool row, unless the user said no.
				if (!decided || decided === 'deny' || decided === 'cancelled') current().parts.push({ kind: 'confirmation', request: ev });
				break;
			}
			case 'result': {
				const turn = current();
				turn.result = ev;
				if (ev.is_error) {
					const msg = (ev.result ?? '').trim();
					if (msg) turn.parts.push({ kind: 'error', message: msg });
					else turn.parts.push({ kind: 'canceled' });
				}
				turn.done = true;
				cur = null;
				break;
			}
			case 'checkpoint':
				// Comes right after its user message: that turn is this request (Restore checkpoint).
				if (cur) (cur as Turn).checkpoint = ev.request;
				break;
			case 'error':
				current().parts.push({ kind: 'error', message: ev.message });
				break;
			case 'exit': {
				const failed = !ev.stopped && ((ev.code ?? 0) !== 0 || ev.signal != null);
				const open = cur as Turn | null;
				if (failed && !(open?.parts.some((p) => p.kind === 'error') ?? false)) {
					current().parts.push({ kind: 'error', message: ev.signal != null ? t('chatView.exitSignal', { signal: ev.signal }) : t('chatView.exitCode', { code: ev.code ?? 0 }) });
				}
				close(!failed);
				cur = null;
				break;
			}
			default:
				// system / raw / stderr: internal.
				break;
		}
	}
	const live = !run.ended;
	if (live && (run.draft.thinking || run.draft.text)) {
		const turn = current();
		if (run.draft.thinking) turn.parts.push({ kind: 'thinking', text: run.draft.thinking, streaming: true });
		if (run.draft.text) turn.parts.push({ kind: 'markdown', text: run.draft.text, streaming: true });
	}
	if (!live) for (const turn of turns) turn.done = true;
	// An idle live session has finished its last turn even when no result came for it.
	if (live && run.status === 'idle') for (const turn of turns) turn.done = true;
	return turns;
}

/** The response's text, for Copy: its markdown parts. */
export const responseText = (turn: Turn) =>
	turn.parts
		.filter((p): p is Extract<Part, { kind: 'markdown' }> => p.kind === 'markdown')
		.map((p) => p.text)
		.join('\n\n');

/** The last request that was sent (Retry). */
export function lastRequest(turns: readonly Turn[]): Turn['request'] {
	for (let i = turns.length - 1; i >= 0; i--) if (turns[i].request) return turns[i].request;
	return null;
}

/** The chat's prompts, oldest first, a repeat right after itself kept once (↑/↓ history). */
export function promptHistory(turns: readonly Turn[]): string[] {
	const out: string[] = [];
	for (const turn of turns) {
		const text = turn.request?.text.trim();
		if (text && out[out.length - 1] !== text) out.push(text);
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// Tool rows: "Read src/x.ts", "Edited y.ts", "Ran `npm test`"

const str = (o: Record<string, unknown>, ...keys: string[]) => {
	for (const k of keys) if (typeof o[k] === 'string' && o[k]) return o[k] as string;
	return '';
};
const oneLine = (s: string, max = 80) => {
	const flat = s.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** A path for a row: relative to `cwd` when under it. */
export function shortPath(path: string, cwd?: string | null): string {
	if (cwd) {
		const base = cwd.replace(/\/+$/, '') + '/';
		if (path.startsWith(base)) return path.slice(base.length);
	}
	return path;
}

/** The one-line label of a tool row, past tense once it finished (VS Code's pastTenseMessage). */
export function toolLabel(name: string, input: unknown, done: boolean, cwd?: string | null): string {
	const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
	const file = shortPath(str(o, 'file_path', 'notebook_path', 'path'), cwd);
	const tense = done ? 'done' : 'running';
	switch (name) {
		case 'Read':
			return t(`chatView.tool.read.${tense}`, { file });
		case 'Edit':
		case 'MultiEdit':
		case 'NotebookEdit':
			return t(`chatView.tool.edit.${tense}`, { file });
		case 'Write':
			return t(`chatView.tool.write.${tense}`, { file });
		case 'Bash':
			return t(`chatView.tool.bash.${tense}`, { command: oneLine(str(o, 'command')) });
		case 'Grep':
			return t(`chatView.tool.grep.${tense}`, { pattern: oneLine(str(o, 'pattern'), 60) });
		case 'Glob':
			return t(`chatView.tool.glob.${tense}`, { pattern: oneLine(str(o, 'pattern'), 60) });
		case 'WebFetch':
			return t(`chatView.tool.fetch.${tense}`, { url: oneLine(str(o, 'url'), 60) });
		case 'WebSearch':
			return t(`chatView.tool.search.${tense}`, { query: oneLine(str(o, 'query'), 60) });
		case 'Task':
		case 'Agent':
			return t(`chatView.tool.task.${tense}`, { description: oneLine(str(o, 'description', 'prompt'), 60) });
		case 'TodoWrite':
			return t(`chatView.tool.todo.${tense}`);
		case 'AskUserQuestion':
			return t(`chatView.tool.ask.${tense}`);
		case 'ExitPlanMode':
			return t(`chatView.tool.plan.${tense}`);
	}
	const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
	const tool = mcp ? `${mcp[2]} (${mcp[1]})` : name;
	const arg = oneLine(str(o, 'file_path', 'path', 'command', 'pattern', 'url', 'query', 'description'), 60);
	return arg ? t(`chatView.tool.otherArg.${tense}`, { tool, arg }) : t(`chatView.tool.other.${tense}`, { tool });
}
