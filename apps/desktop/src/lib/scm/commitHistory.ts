// The commit input's message history (VS Code's SCM input history: history.showPrevious /
// history.showNext, ↑/↓ in the input). Pure, so bun tests cover it; commitInput.svelte.ts keeps
// one per repository and wires the keys.

/** Messages kept per repository. */
export const HISTORY_MAX = 50;

/** `entries` with `message` as the newest (a repeat moves to the end, the oldest fall off). */
export function addEntry(entries: readonly string[], message: string, max = HISTORY_MAX): string[] {
	const m = message.trim();
	if (!m) return [...entries];
	return [...entries.filter((e) => e !== m), m].slice(-max);
}

/** Where ↑/↓ is in the history: `index` into the entries, or `null` on the draft being typed. */
export type HistoryCursor = { index: number | null; draft: string };

export const freshCursor = (): HistoryCursor => ({ index: null, draft: '' });

/**
 * One step back (`-1`, ↑) or forward (`+1`, ↓) from `cursor` with the input showing `current`:
 * the new cursor and the text to show, or null when there is nowhere to go. Leaving the draft
 * keeps it, so ↓ past the newest entry brings it back.
 */
export function step(entries: readonly string[], cursor: HistoryCursor, current: string, dir: -1 | 1): { cursor: HistoryCursor; value: string } | null {
	if (!entries.length) return null;
	if (cursor.index === null) {
		if (dir === 1) return null;
		const index = entries.length - 1;
		return { cursor: { index, draft: current }, value: entries[index] };
	}
	const index = cursor.index + dir;
	if (index < 0) return null;
	if (index >= entries.length) return { cursor: { index: null, draft: '' }, value: cursor.draft };
	return { cursor: { index, draft: cursor.draft }, value: entries[index] };
}

/** ↑ moves through the history only with the caret on the first line, ↓ only on the last (VS Code). */
export function caretAllows(value: string, caret: number, dir: -1 | 1): boolean {
	return dir === -1 ? !value.slice(0, caret).includes('\n') : !value.slice(caret).includes('\n');
}
