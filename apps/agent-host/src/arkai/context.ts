// Keeping an Arkai conversation inside the model's context window. Before each request the
// conversation is measured (characters / 3.5, corrected by what the provider last counted); when
// it would not leave room for the answer:
// 1. tool results before the current turn are cut to their first lines;
// 2. the oldest turns (a user message and everything up to the next one) are dropped and
//    summarised in a few lines at the start of the first turn kept: what the user asked, which
//    files were changed, which commands ran, how each turn ended;
// 3. the current turn's older tool results are cut, the newest ones last.
// The current turn is never dropped. Pure, so `bun test` covers it.

import type { Msg, ToolCall } from './messages.ts';

/** Characters per token, roughly, for code and English (Thai counts higher: the correction fixes it). */
const CHARS_PER_TOKEN = 3.5;
/** Tokens each message costs besides its text (role, framing). */
const MESSAGE_OVERHEAD = 6;
/** Compaction goes down to this share of the limit, so it is not needed again at the next step. */
const TARGET = 0.7;
const OLD_RESULT_CHARS = 600;
const CURRENT_RESULT_CHARS = 2000;
const LAST_RESORT_CHARS = 300;
const SUMMARY_LINE = 240;

export const SUMMARY_HEADER = '[Earlier conversation, summarised to fit the context window]';
export const CUT_NOTE = '… (cut to fit the context window)';

export const estimateTokens = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);

function callTokens(c: ToolCall) {
	return estimateTokens(c.name) + estimateTokens(c.arguments) + 4;
}

export function messageTokens(m: Msg): number {
	switch (m.role) {
		case 'user':
			// An image is about a thousand tokens at most providers' default resolution.
			return MESSAGE_OVERHEAD + estimateTokens(m.text) + (m.images?.length ?? 0) * 1000;
		case 'assistant':
			return MESSAGE_OVERHEAD + estimateTokens(m.text) + m.calls.reduce((n, c) => n + callTokens(c), 0);
		case 'tool':
			return MESSAGE_OVERHEAD + estimateTokens(m.content);
	}
}

export const conversationTokens = (messages: readonly Msg[]) => messages.reduce((n, m) => n + messageTokens(m), 0);

export type Budget = {
	/** The model's context window. */
	window: number;
	/** Room kept for the answer. */
	maxTokens: number;
	/** The system prompt and tool definitions, estimated. */
	fixed: number;
	/** The provider's count over our estimate at the last request (1: none yet). */
	calibration?: number;
};

/** The most conversation tokens that still leave room for the answer. */
export function conversationLimit(b: Budget): number {
	return Math.max(1024, b.window - b.maxTokens - b.fixed - 256);
}

export type Fitted = { messages: Msg[]; compacted: boolean; droppedTurns: number };

/** Where each turn starts: the indexes of user messages. */
function turnStarts(messages: readonly Msg[]): number[] {
	const out: number[] = [];
	messages.forEach((m, i) => {
		if (m.role === 'user') out.push(i);
	});
	return out;
}

function cut(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n${CUT_NOTE}` : text;
}

const oneLine = (s: string, max = SUMMARY_LINE) => {
	const t = s.replace(/\s+/g, ' ').trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
};

function args(c: ToolCall): Record<string, unknown> {
	try {
		const v: unknown = JSON.parse(c.arguments || '{}');
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** A few lines on dropped turns: what was asked, changed, run and answered. */
export function summarise(dropped: readonly Msg[], maxChars: number): string {
	const lines: string[] = [];
	let turn: { asked: string; files: Set<string>; commands: string[]; tools: number; answer: string } | null = null;
	const close = () => {
		if (!turn) return;
		const bits = [`- The user asked: ${oneLine(turn.asked) || '(no text)'}`];
		if (turn.files.size) bits.push(`  Files changed: ${[...turn.files].slice(0, 12).join(', ')}`);
		if (turn.commands.length) bits.push(`  Commands run: ${turn.commands.slice(0, 6).map((c) => oneLine(c, 80)).join('; ')}`);
		if (turn.answer) bits.push(`  You answered: ${oneLine(turn.answer)}`);
		else if (turn.tools) bits.push(`  (${turn.tools} tool calls, no final answer)`);
		lines.push(bits.join('\n'));
		turn = null;
	};
	for (const m of dropped) {
		if (m.role === 'user') {
			close();
			let asked = m.text;
			// A turn that already starts with a summary: its lines come first, as they were.
			if (asked.startsWith(SUMMARY_HEADER)) {
				const end = asked.indexOf('\n\n');
				lines.push(...asked.slice(SUMMARY_HEADER.length + 1, end < 0 ? undefined : end).split('\n').filter(Boolean));
				asked = end < 0 ? '' : asked.slice(end + 2);
			}
			turn = { asked, files: new Set(), commands: [], tools: 0, answer: '' };
			continue;
		}
		turn ??= { asked: '', files: new Set(), commands: [], tools: 0, answer: '' };
		if (m.role === 'assistant') {
			if (m.text.trim()) turn.answer = m.text;
			for (const c of m.calls) {
				turn.tools++;
				const a = args(c);
				if ((c.name === 'Write' || c.name === 'Edit') && typeof a.file_path === 'string') turn.files.add(a.file_path);
				if (c.name === 'Bash' && typeof a.command === 'string') turn.commands.push(a.command);
			}
		}
	}
	close();
	// Too long: the oldest lines go first.
	const all = lines.join('\n').split('\n');
	let size = all.reduce((n, l) => n + l.length + 1, 0);
	let from = 0;
	while (from < all.length - 1 && SUMMARY_HEADER.length + 3 + size > maxChars) size -= all[from++]!.length + 1;
	return `${SUMMARY_HEADER}\n${from ? '…\n' : ''}${all.slice(from).join('\n')}`;
}

/** Tool results in `[from, to)` cut to `max` characters. */
function cutResults(messages: Msg[], from: number, to: number, max: number): boolean {
	let changed = false;
	for (let i = from; i < to; i++) {
		const m = messages[i]!;
		if (m.role === 'tool' && m.content.length > max + CUT_NOTE.length + 1) {
			messages[i] = { ...m, content: cut(m.content, max) };
			changed = true;
		}
	}
	return changed;
}

/** The conversation made to fit `budget` (the same array when it already does). */
export function fitContext(messages: readonly Msg[], budget: Budget): Fitted {
	const factor = Math.min(3, Math.max(0.5, budget.calibration ?? 1));
	const limit = conversationLimit(budget);
	const size = (ms: readonly Msg[]) => conversationTokens(ms) * factor;
	if (size(messages) <= limit) return { messages: messages as Msg[], compacted: false, droppedTurns: 0 };
	const target = limit * TARGET;
	let out = [...messages];
	let starts = turnStarts(out);
	const current = starts[starts.length - 1] ?? 0;

	// 1. Old tool results to their first lines.
	cutResults(out, 0, current, OLD_RESULT_CHARS);
	if (size(out) <= target) return { messages: out, compacted: true, droppedTurns: 0 };

	// 2. The oldest turns, summarised.
	let drop = 0;
	starts = turnStarts(out);
	const keepFrom = (k: number) => starts[k] ?? out.length;
	const summaryBudget = Math.floor(limit * 0.15 * 3.5);
	let k = 0;
	while (k < starts.length - 1) {
		k++;
		const rest = out.slice(keepFrom(k));
		const summaryTokens = Math.min(summaryBudget / 3.5, estimateTokens(summarise(out.slice(0, keepFrom(k)), summaryBudget)));
		if (conversationTokens(rest) * factor + summaryTokens <= target) break;
	}
	if (k > 0) {
		drop = k;
		const dropped = out.slice(0, keepFrom(k));
		const rest = out.slice(keepFrom(k));
		const first = rest[0];
		const summary = summarise(dropped, summaryBudget);
		if (first?.role === 'user') rest[0] = { ...first, text: `${summary}\n\n${first.text}` };
		out = rest;
	}
	if (size(out) <= limit) return { messages: out, compacted: true, droppedTurns: drop };

	// 3. The current turn's tool results: all but the two newest, then those too.
	const results = out.flatMap((m, i) => (m.role === 'tool' ? [i] : []));
	const keepWhole = results.slice(-2)[0] ?? out.length;
	cutResults(out, 0, keepWhole, CURRENT_RESULT_CHARS);
	if (size(out) > limit) cutResults(out, 0, keepWhole, LAST_RESORT_CHARS);
	if (size(out) > limit) cutResults(out, 0, out.length, CURRENT_RESULT_CHARS);
	return { messages: out, compacted: true, droppedTurns: drop };
}
