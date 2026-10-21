// A run's events as VS Code's chat list: requests, each followed by its response made of parts
// (markdown, thinking, tool invocations, confirmations, errors). Internal events (session start,
// stderr, unknown SDK messages such as `rate_limit_event`) are not shown; the final `result` only
// closes the response (its text is the last assistant message again) and carries the usage shown
// on hover. Pure, so `bun test` covers it.

import { t } from '#lib/i18n/index.ts';
import { parseRequest, type ParsedRequest } from './chatPrompt';
import { guardAskedText, guardBlockedText } from './guardText';
import type { AgentEvent, PermissionRequest, ResultEvent, RunState, RunStatus, Vote } from './events';
import type { ArtifactEvent } from '#lib/artifacts/artifacts.ts';

export type ToolPart = {
	kind: 'tool';
	id: string;
	name: string;
	input: unknown;
	/** Set once the tool returned. */
	result?: { content: string; isError: boolean };
	/** A Task/Agent call: its subagent's own text, thinking and tool calls (VS Code's subagent part). */
	children?: Part[];
	/** The `chat.tools.*.autoApprove` rules that let it run without a prompt (`tool_auto_approved`). */
	autoApproved?: string[];
};

export type Part =
	| { kind: 'markdown'; text: string; streaming?: boolean }
	| { kind: 'thinking'; text: string; streaming?: boolean }
	| ToolPart
	/** `reason`: why Kingu's safety check asked (a `guard_asked` before it), shown on the card. */
	| { kind: 'confirmation'; request: PermissionRequest; reason?: string }
	| { kind: 'error'; message: string }
	/** A page the agent published (`artifact` event): a card that opens it. */
	| { kind: 'artifact'; artifact: ArtifactEvent }
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
	/** The user's vote on this answer (the last `feedback` event for its checkpoint). */
	feedback?: Vote | null;
};

export type ChatView = Pick<RunState, 'items' | 'draft' | 'decisions' | 'ended'> & { status?: RunStatus };

/** Events the list never shows (logged instead). */
export function isInternal(ev: AgentEvent): boolean {
	return ev.kind === 'raw' || ev.kind === 'stderr' || ev.kind === 'system';
}

/** Appends a message's text to `parts`, joined to the markdown just before it. */
function pushText(parts: Part[], text: string) {
	const prev = parts[parts.length - 1];
	if (prev?.kind === 'markdown') prev.text = `${prev.text}\n\n${text}`;
	else parts.push({ kind: 'markdown', text });
}

/** Folds the run's timeline into requests and responses. */
export function buildTurns(run: ChatView): Turn[] {
	const turns: Turn[] = [];
	/** Every tool call so far by id (results and subagent events find their call). */
	const tools = new Map<string, ToolPart>();
	let cur: Turn | null = null;
	const current = (): Turn => {
		if (!cur) {
			cur = { request: null, parts: [], result: null, done: false };
			turns.push(cur);
		}
		return cur;
	};
	/** Where an event's part goes: under its subagent's Task call when it has one, else the turn. */
	const sink = (parent: string | null | undefined): Part[] => {
		const call = parent ? tools.get(parent) : undefined;
		return call ? (call.children ??= []) : current().parts;
	};
	/** Why each safety ask was raised, by request id. */
	const askReasons = new Map<string, string>();
	/** Auto-approvals that came before their call's `tool_use`, by tool call id. */
	const approvedEarly = new Map<string, string[]>();
	/** Votes by checkpoint, the last one winning. */
	const votes = new Map<number, Vote | null>();
	const close = (canceled: boolean) => {
		if (!cur || cur.done) return;
		cur.done = true;
		if (canceled && cur.request) cur.parts.push({ kind: 'canceled' });
	};
	for (const ev of run.items) {
		switch (ev.kind) {
			case 'message': {
				if (ev.role === 'user' && ev.parent_tool_use_id) break; // a subagent's prompt: the Task call's input
				if (ev.role === 'user') {
					// A follow-up sent while the turn ran (an ADE task): the earlier turn just ends.
					close(false);
					cur = { request: { ...parseRequest(ev.text), sent: ev.text }, parts: [], result: null, done: false };
					turns.push(cur);
					break;
				}
				if (!ev.text.trim()) break;
				pushText(sink(ev.parent_tool_use_id), ev.text);
				break;
			}
			case 'thinking':
				if (ev.text.trim()) sink(ev.parent_tool_use_id).push({ kind: 'thinking', text: ev.text });
				break;
			case 'tool_use': {
				const tool: ToolPart = { kind: 'tool', id: ev.id, name: ev.name, input: ev.input };
				const early = approvedEarly.get(ev.id);
				if (early) tool.autoApproved = early;
				sink(ev.parent_tool_use_id).push(tool);
				if (ev.id) tools.set(ev.id, tool);
				break;
			}
			case 'tool_result': {
				const tool = tools.get(ev.tool_use_id);
				if (tool) tool.result = { content: ev.content, isError: ev.is_error };
				break;
			}
			case 'permission_request': {
				const decided = run.decisions[ev.request_id];
				// Answered ones leave only the tool row, unless the user said no.
				const reason = askReasons.get(ev.request_id);
				if (!decided || decided === 'deny' || decided === 'cancelled') current().parts.push({ kind: 'confirmation', request: ev, ...(reason ? { reason } : {}) });
				break;
			}
			case 'guard_asked':
				askReasons.set(ev.request_id, guardAskedText(ev));
				break;
			case 'tool_auto_approved': {
				if (!ev.tool_use_id) break;
				const tool = tools.get(ev.tool_use_id);
				if (tool) tool.autoApproved = ev.rules;
				else approvedEarly.set(ev.tool_use_id, ev.rules);
				break;
			}
			case 'feedback':
				votes.set(ev.request, ev.vote);
				break;
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
			case 'artifact':
				current().parts.push({ kind: 'artifact', artifact: ev });
				break;
			case 'guard_blocked':
				current().parts.push({ kind: 'error', message: guardBlockedText(ev) });
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
	for (const turn of turns) if (turn.checkpoint != null && votes.has(turn.checkpoint)) turn.feedback = votes.get(turn.checkpoint);
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

/**
 * The checkpoint "How did the agent do?" (Cursor's) asks about: the chat's last request, once its
 * answer is done, nothing runs and it has no vote yet; null when there is nothing to ask. Output
 * after that request is a turn of its own without a request (an error or exit line after the
 * result, a turn the agent took by itself) and does not hide the question.
 */
export function feedbackTarget(turns: readonly Turn[], busy: boolean): number | null {
	if (busy) return null;
	for (let i = turns.length - 1; i >= 0; i--) {
		const turn = turns[i];
		if (!turn.request) continue;
		return turn.done && turn.parts.length > 0 && turn.checkpoint != null && !turn.feedback ? turn.checkpoint : null;
	}
	return null;
}

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

// ---------------------------------------------------------------------------------------------
// Todos (TodoWrite), plans (ExitPlanMode), edits and subagents

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export type Todo = { content: string; status: TodoStatus; activeForm: string };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A TodoWrite call's list (`input.todos`): items without text are left out, unknown statuses read as pending. */
export function parseTodos(input: unknown): Todo[] | null {
	const list = isRecord(input) ? input.todos : undefined;
	if (!Array.isArray(list)) return null;
	return list.filter(isRecord).flatMap((x) => {
		const content = typeof x.content === 'string' ? x.content.trim() : '';
		if (!content) return [];
		const status: TodoStatus = x.status === 'in_progress' || x.status === 'completed' ? x.status : 'pending';
		const activeForm = typeof x.activeForm === 'string' && x.activeForm.trim() ? x.activeForm.trim() : content;
		return [{ content, status, activeForm }];
	});
}

/** The main agent's current todo list: the input of its last TodoWrite call (subagents' lists aside). */
export function latestTodos(turns: readonly Turn[]): Todo[] | null {
	for (let i = turns.length - 1; i >= 0; i--) {
		const parts = turns[i].parts;
		for (let j = parts.length - 1; j >= 0; j--) {
			const p = parts[j];
			if (p.kind === 'tool' && p.name === 'TodoWrite') return parseTodos(p.input);
		}
	}
	return null;
}

/**
 * The todo bar's header (VS Code's ChatTodoListWidget): the item worked on (the first in progress,
 * else the first not started) and its number `n` of `total`, counted from the completed ones.
 */
export function todoProgress(todos: readonly Todo[]): { done: number; total: number; n: number; current: Todo | null; inProgress: boolean } {
	const done = todos.filter((x) => x.status === 'completed').length;
	const working = todos.find((x) => x.status === 'in_progress');
	const current = working ?? todos.find((x) => x.status === 'pending') ?? null;
	return { done, total: todos.length, n: working ? done + 1 : Math.max(1, done), current, inProgress: !!working };
}

/** An ExitPlanMode call's plan (markdown), or null. */
export function planOf(input: unknown): string | null {
	const plan = isRecord(input) ? input.plan : undefined;
	return typeof plan === 'string' && plan.trim() ? plan : null;
}

const lineCount = (s: unknown) => (typeof s === 'string' && s.length ? s.split('\n').length : 0);

/** The file and `+added −removed` of an edit tool's call (the agent host's summarizeTool math); null for other tools. */
export function editOf(name: string, input: unknown): { path: string; added: number; removed: number } | null {
	if (name !== 'Edit' && name !== 'MultiEdit' && name !== 'Write' && name !== 'NotebookEdit') return null;
	const o = isRecord(input) ? input : {};
	const path = str(o, 'file_path', 'notebook_path');
	if (!path) return null;
	switch (name) {
		case 'Edit':
			return { path, added: lineCount(o.new_string), removed: lineCount(o.old_string) };
		case 'MultiEdit': {
			const edits: Record<string, unknown>[] = Array.isArray(o.edits) ? o.edits.filter(isRecord) : [];
			let added = 0;
			let removed = 0;
			for (const e of edits) {
				added += lineCount(e.new_string);
				removed += lineCount(e.old_string);
			}
			return { path, added, removed };
		}
		case 'Write':
			return { path, added: lineCount(o.content), removed: 0 };
		default:
			return { path, added: lineCount(o.new_source), removed: 0 };
	}
}

/** A line of an edit card's diff snippet: context (' '), removed ('-') or added ('+'). */
export type SnippetLine = { sign: ' ' | '-' | '+'; text: string };

/**
 * The few lines an edit card shows (Cursor's file edit card): the last unchanged line before the
 * change as context, then the removed and the added lines, `max` in all. Write shows its first
 * lines as added; MultiEdit its first edit.
 */
export function editSnippet(name: string, input: unknown, max = 6): SnippetLine[] {
	const o = isRecord(input) ? input : {};
	let before = '';
	let after = '';
	if (name === 'Edit') [before, after] = [String(o.old_string ?? ''), String(o.new_string ?? '')];
	else if (name === 'MultiEdit') {
		const first = Array.isArray(o.edits) ? o.edits.find(isRecord) : undefined;
		[before, after] = [String(first?.old_string ?? ''), String(first?.new_string ?? '')];
	} else if (name === 'Write') after = String(o.content ?? '');
	else if (name === 'NotebookEdit') after = String(o.new_source ?? '');
	else return [];
	const a = before ? before.split('\n') : [];
	const b = after ? after.split('\n') : [];
	let p = 0;
	while (p < a.length && p < b.length && a[p] === b[p]) p++;
	let ea = a.length;
	let eb = b.length;
	while (ea > p && eb > p && a[ea - 1] === b[eb - 1]) {
		ea--;
		eb--;
	}
	const out: SnippetLine[] = [];
	if (p > 0) out.push({ sign: ' ', text: a[p - 1] });
	for (const text of a.slice(p, ea)) out.push({ sign: '-', text });
	for (const text of b.slice(p, eb)) out.push({ sign: '+', text });
	return out.slice(0, max);
}

/** A progress line's verb and the rest ("Read src/x.ts" → "Read", "src/x.ts"): the verb is drawn bold (Cursor's). */
export function splitVerb(label: string): { verb: string; rest: string } {
	const m = /^(\S+)\s+([\s\S]*)$/.exec(label.trim());
	return m ? { verb: m[1], rest: m[2] } : { verb: label.trim(), rest: '' };
}

/** A Bash call's description (Claude Code's `description`), else null. */
export function bashDescription(input: unknown): string | null {
	const d = isRecord(input) ? input.description : null;
	return typeof d === 'string' && d.trim() ? d.trim() : null;
}

/**
 * Where a finished turn's steps end: the parts before its closing answer (the markdown after the
 * last step), which fold into "Worked for 2s". 0 when there are no steps to fold.
 */
export function activityEnd(parts: readonly { kind: string }[]): number {
	let end = parts.length;
	while (end > 0 && parts[end - 1].kind === 'markdown') end--;
	return end;
}

/** Parts that are the agent's steps (folded into "Worked for"); the rest is what it said or how it ended. */
const STEP_KINDS = new Set(['thinking', 'tool', 'confirmation']);

/**
 * How many leading parts a finished turn folds into "Worked for Ns" (Cursor's): the parts before
 * its final answer (the last run of text), so the answer and whatever follows it (an error,
 * "canceled", a skipped call) stay in view. A turn with no text, e.g. one a steered message
 * closed before it answered, folds up to its last step. 0 (no "Worked" row) for a turn still
 * running, one without a request (output before the first request), or one with no steps to fold.
 */
export function foldSteps(turn: { request: unknown; done: boolean; parts: readonly { kind: string }[] }): number {
	if (!turn.request || !turn.done) return 0;
	const parts = turn.parts;
	let end = -1;
	for (let i = parts.length - 1; i >= 0; i--) {
		if (parts[i].kind !== 'markdown') continue;
		end = i;
		while (end > 0 && parts[end - 1].kind === 'markdown') end--;
		break;
	}
	if (end < 0) {
		end = parts.length;
		while (end > 0 && !STEP_KINDS.has(parts[end - 1].kind)) end--;
	}
	return parts.slice(0, end).some((p) => STEP_KINDS.has(p.kind)) ? end : 0;
}

/**
 * Tool calls a turn does not draw as tool rows: one waiting for approval (its approval card stands
 * in for it until Run) and one the user skipped (only "Skipped …" is left). By tool call id.
 */
export function hiddenTools(parts: readonly Part[], decisions: Readonly<Record<string, string>>): Set<string> {
	const out = new Set<string>();
	for (const p of parts) {
		if (p.kind !== 'confirmation' || !p.request.tool_use_id || p.request.tool === 'AskUserQuestion') continue;
		const d = decisions[p.request.request_id];
		if (!d || d === 'deny' || d === 'cancelled') out.add(p.request.tool_use_id);
	}
	return out;
}

/** "Worked for 2s" / "1m 5s": a finished turn's duration. */
export function workedFor(ms: number | null | undefined): string | null {
	if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
	const sec = Math.max(1, Math.round(ms / 1000));
	if (sec < 60) return `${sec}s`;
	const m = Math.floor(sec / 60);
	return `${m}m ${sec % 60}s`;
}

export const isSubagentTool = (name: string) => name === 'Task' || name === 'Agent';

/** A subagent call's tool calls (nested ones included), how many still run, and their ids (pending approvals). */
export function subagentStats(tool: ToolPart): { tools: number; running: number; ids: Set<string> } {
	const ids = new Set<string>();
	let running = 0;
	const walk = (parts: readonly Part[]) => {
		for (const p of parts) {
			if (p.kind !== 'tool') continue;
			ids.add(p.id);
			if (!p.result) running++;
			if (p.children) walk(p.children);
		}
	};
	walk(tool.children ?? []);
	return { tools: ids.size, running, ids };
}
