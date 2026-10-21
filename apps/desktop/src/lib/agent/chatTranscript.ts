// Moving around an agent chat's transcript (VS Code's chat find widget and prompt navigation,
// Orca's selection quote, long-prompt fold and Continue): the pure parts. The DOM side is
// chatFindDom.ts (text and ranges of the list) and the components ChatFind, ChatSelectionQuote
// and SideChat; the commands are chatTranscriptCommands.svelte.ts.

import type { Turn } from './chatParts.ts';

export type FindOptions = { caseSensitive: boolean; wholeWord: boolean; regex: boolean };
export type Match = { start: number; end: number };
export type FindResult = { matches: Match[]; invalid: boolean };

/** More matches than this are not highlighted (a one-letter query over a long chat). */
export const MAX_MATCHES = 5000;

const WORD = /[\p{L}\p{N}_]/u;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where `query` occurs in `text`: plain or a regex, case-folded unless asked, optionally whole words. */
export function findMatches(text: string, query: string, o: FindOptions): FindResult {
	if (!query) return { matches: [], invalid: false };
	let re: RegExp;
	try {
		re = new RegExp(o.regex ? query : escapeRegex(query), o.caseSensitive ? 'gu' : 'giu');
	} catch {
		return { matches: [], invalid: true };
	}
	const matches: Match[] = [];
	for (let m = re.exec(text); m; m = re.exec(text)) {
		const start = m.index;
		const end = start + m[0].length;
		if (end === start) {
			// An empty match (`a*`, `^`): step past it, never highlight it.
			re.lastIndex = start + 1;
			continue;
		}
		if (o.wholeWord && (WORD.test(text[start - 1] ?? '') || WORD.test(text[end] ?? ''))) continue;
		matches.push({ start, end });
		if (matches.length >= MAX_MATCHES) break;
	}
	return { matches, invalid: false };
}

/** The match after (dir 1) or before (dir -1) `current`, wrapping; the first or last one from none. */
export function stepMatch(current: number, count: number, dir: 1 | -1): number {
	if (count <= 0) return -1;
	if (current < 0 || current >= count) return dir === 1 ? 0 : count - 1;
	return (current + dir + count) % count;
}

/** After the text changed: the match at or after the one that was current (by offset), else the first. */
export function keepMatch(matches: readonly Match[], previousStart: number | null): number {
	if (!matches.length) return -1;
	if (previousStart === null) return 0;
	const i = matches.findIndex((m) => m.start >= previousStart);
	return i < 0 ? matches.length - 1 : i;
}

/**
 * Previous / Next Prompt (VS Code's chat.previousUserPrompt / nextUserPrompt): given where each
 * request row would scroll to (ascending) and the list's scroll position, the row to go to. It
 * stops at the first and the last (no wrap); null when there is nowhere to go.
 */
export function promptStep(targets: readonly number[], scrollTop: number, dir: 1 | -1, slack = 2): number | null {
	if (!targets.length) return null;
	if (dir === 1) {
		const i = targets.findIndex((y) => y > scrollTop + slack);
		return i < 0 ? null : i;
	}
	const i = targets.findLastIndex((y) => y < scrollTop - slack);
	return i < 0 ? null : i;
}

/** Orca's fold of a long request: more than this many lines or characters starts folded. */
export const FOLD_LINES = 8;
export const FOLD_CHARS = 600;

/** Whether a request is long enough to fold behind "Show more" (decided from the text alone). */
export function foldsPrompt(text: string, lines = FOLD_LINES, chars = FOLD_CHARS): boolean {
	return text.length > chars || text.split('\n').length > lines;
}

/** Text as a markdown quote for the chat input, then the blank line a reply follows. */
export function quoteBlock(text: string): string {
	const lines = text.trim().split(/\r?\n/);
	return `${lines.map((line) => (line.trim() ? `> ${line}` : '>')).join('\n')}\n\n`;
}

/** The input after Quote: the quote after what is typed (a blank line between). */
export function withQuote(input: string, text: string): string {
	const before = input.trimEnd();
	return `${before ? `${before}\n\n` : ''}${quoteBlock(text)}`;
}

/** What Continue sends after a stopped turn (Orca's Continue). */
export const CONTINUE_PROMPT = 'continue';

/** Continue under the last turn: it has a request and was stopped (not failed), and nothing runs. */
export function continuable(turns: readonly Turn[], running: boolean): boolean {
	const last = turns[turns.length - 1];
	return !running && !!last?.request && last.done && last.parts[last.parts.length - 1]?.kind === 'canceled';
}

/** A side chat's first message: the excerpt as a quote, then the question. */
export function sideChatMessage(excerpt: string, question: string): string {
	const q = question.trim();
	return excerpt.trim() ? `${quoteBlock(excerpt)}${q}` : q;
}
