// The Search view's history (VS Code's SearchHistoryService, kept per workspace): what was
// searched for, replaced with, and the files to include and exclude, each browsed with ↑ and ↓ in
// its box like VS Code's HistoryInputBox. Pure, so bun tests cover it.

export type HistoryField = 'search' | 'replace' | 'include' | 'exclude';
export type SearchHistory = Record<HistoryField, string[]>;

/** VS Code's HistoryInputBox keeps 100 entries per box. */
export const MAX_HISTORY = 100;

export const emptyHistory = (): SearchHistory => ({ search: [], replace: [], include: [], exclude: [] });

/** `list` (oldest first) with `value` as its newest entry, once; blank values are not kept. */
export function remember(list: readonly string[], value: string, max = MAX_HISTORY): string[] {
	if (!value.trim()) return [...list];
	return [...list.filter((v) => v !== value), value].slice(-max);
}

export function parseHistory(raw: unknown): SearchHistory {
	const out = emptyHistory();
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
	for (const field of Object.keys(out) as HistoryField[]) {
		const list = (raw as Record<string, unknown>)[field];
		if (Array.isArray(list)) out[field] = list.filter((v): v is string => typeof v === 'string' && v.trim() !== '').slice(-MAX_HISTORY);
	}
	return out;
}

/**
 * One step through `list` (oldest first) from entry `at` (null: not browsing, the box shows what
 * was typed, `current`): ↑ (`-1`) goes to an older entry, ↓ (`1`) to a newer one and past the
 * newest back to what was typed (`at` null). Null when there is nowhere to go (↓ while not
 * browsing moves on to the results instead).
 */
export function historyStep(list: readonly string[], at: number | null, dir: -1 | 1, current: string): { at: number | null } | null {
	if (at === null) {
		if (dir === 1 || !list.length) return null;
		// The newest entry is usually what the box already shows.
		const last = list.length - 1;
		const start = list[last] === current ? last - 1 : last;
		return start < 0 ? null : { at: start };
	}
	if (dir === -1) return at > 0 ? { at: at - 1 } : null;
	return { at: at < list.length - 1 ? at + 1 : null };
}
