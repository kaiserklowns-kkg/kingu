// Orca's sidebar multi-select (sidebar/worktree-list/navigation/use-selection.ts): ⌘/Ctrl-click
// toggles a worktree, Shift-click selects the range from the last clicked one, a plain click
// starts over; right-click on a selected card acts on the whole selection. Pure.

/** ⌘-click on `key`: the selection starts from the open worktree when it was empty. */
export function toggleSelect(selection: readonly string[], current: string | null, key: string): string[] {
	const base = selection.length ? [...selection] : current !== null && current !== key ? [current] : [];
	return base.includes(key) ? base.filter((k) => k !== key) : [...base, key];
}

/** Shift-click: every visible row from `anchor` to `key`, inclusive, in `order`. */
export function rangeSelect(order: readonly string[], anchor: string | null, key: string): string[] {
	const to = order.indexOf(key);
	if (to < 0) return [];
	const from = anchor === null ? -1 : order.indexOf(anchor);
	if (from < 0) return [key];
	const [a, b] = from <= to ? [from, to] : [to, from];
	return order.slice(a, b + 1);
}

/** The keys a context menu on `key` acts on: the selection when the card is in it (2+), else the card. */
export function menuTargets(selection: readonly string[], key: string): string[] {
	return selection.length > 1 && selection.includes(key) ? [...selection] : [key];
}
