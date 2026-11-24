// Orca's worktree history (renderer store/slices/ui/workspace-navigation-history.ts, ⌥⌘← / ⌥⌘→):
// a linear list of visited worktrees, oldest first, with an index on the current one. A visit
// after going back drops the forward entries; the same worktree twice in a row is one entry
// (A → B → A stays three); at most 50 entries. Back / forward skip worktrees that are gone. Pure.

export const MAX_HISTORY = 50;

export type WorktreeHistory = { entries: string[]; index: number };

export const emptyHistory = (): WorktreeHistory => ({ entries: [], index: -1 });

/** Orca `appendHistoryEntry`. */
export function recordVisit(h: WorktreeHistory, key: string): WorktreeHistory {
	if (h.entries[h.index] === key) return h;
	const entries = [...h.entries.slice(0, h.index + 1), key];
	const evict = Math.max(0, entries.length - MAX_HISTORY);
	return { entries: entries.slice(evict), index: entries.length - 1 - evict };
}

/** The index back / forward goes to (the nearest live entry), or null (Orca `find{Prev,Next}LiveWorktreeHistoryIndex`). */
export function stepIndex(h: WorktreeHistory, back: boolean, live: (key: string) => boolean): number | null {
	if (back) {
		for (let i = h.index - 1; i >= 0; i--) if (live(h.entries[i])) return i;
	} else {
		for (let i = h.index + 1; i < h.entries.length; i++) if (live(h.entries[i])) return i;
	}
	return null;
}
