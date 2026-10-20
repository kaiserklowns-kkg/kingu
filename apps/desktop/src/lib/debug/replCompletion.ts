// Debug Console completions (VS Code: repl.ts CompletionItemProvider over the DAP `completions`
// request). Pure: what replaces what when an item is accepted, and how items are ordered.

import type { CompletionItem } from './protocol.ts';

/** The word being typed before `cursor` (0-based): identifier characters only. */
export function wordBefore(text: string, cursor: number): { start: number; word: string } {
	let start = cursor;
	while (start > 0 && /[\w$\p{L}\p{M}]/u.test(text[start - 1])) start--;
	return { start, word: text.slice(start, cursor) };
}

/**
 * Accepting `item` in `text` with the caret at `cursor` (0-based). DAP's `start` is 1-based here
 * (Kingu sends columnsStartAt1) and with `length` says what to overwrite; without them the word
 * before the caret is replaced, like VS Code. Returns the new text and caret.
 */
export function applyCompletion(text: string, cursor: number, item: CompletionItem): { text: string; cursor: number } {
	const insert = item.text ?? item.label;
	let from: number;
	let to: number;
	if (item.start !== undefined) {
		from = Math.max(0, Math.min(text.length, item.start - 1));
		to = Math.min(text.length, from + (item.length ?? 0));
	} else {
		from = wordBefore(text, cursor).start;
		to = cursor;
	}
	return { text: text.slice(0, from) + insert + text.slice(to), cursor: from + insert.length };
}

/** Items that match the word being typed (prefix, case-insensitive), by `sortText` then label. */
export function rankCompletions(items: readonly CompletionItem[], word: string): CompletionItem[] {
	const w = word.toLowerCase();
	return items
		.filter((i) => !w || i.label.toLowerCase().startsWith(w))
		.sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label))
		.slice(0, 50);
}
