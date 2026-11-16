// Keyboard actions in the Run and Debug view's lists (VS Code: breakpointsView.ts,
// variablesView.ts, watchExpressionsView.ts keybindings with `focusedView == …`):
//   Breakpoints: Space toggles, ↵ opens, ⌘↵ (Ctrl+Enter) opens to the side, F2 edits,
//                ⌘⌫ (Delete off macOS) removes.
//   Variables:   F2 (↵ on macOS) sets the value, ⌘C copies it, → / ← expand / collapse.
//   Watch:       F2 (↵ on macOS) edits, ⌘⌫ (Delete) removes, ⌘C copies the value. (VS Code's ⌥⌘C
//                Copy Expression is not bound: Kingu's Copy Path of Active File takes ⌥⌘C outside editors.)
//   Every list:  ↑ / ↓ / Home / End move between rows (list navigation).
// Pure: the view hands in the key and acts on the answer.

export type DebugRowKind = 'breakpoint' | 'functionBreakpoint' | 'dataBreakpoint' | 'instructionBreakpoint' | 'variable' | 'watch';
export type DebugRowAction = 'toggle' | 'open' | 'openToSide' | 'edit' | 'remove' | 'copy' | 'expand' | 'collapse' | 'next' | 'previous' | 'first' | 'last';
export type KeyLike = { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean };

const BREAKPOINT_KINDS: readonly DebugRowKind[] = ['breakpoint', 'functionBreakpoint', 'dataBreakpoint', 'instructionBreakpoint'];

export function debugRowAction(kind: DebugRowKind, e: KeyLike, mac: boolean): DebugRowAction | null {
	const cmd = mac ? !!e.metaKey : !!e.ctrlKey;
	const other = mac ? !!e.ctrlKey : !!e.metaKey;
	const plain = !cmd && !other && !e.altKey && !e.shiftKey;
	if (plain) {
		if (e.key === 'ArrowDown') return 'next';
		if (e.key === 'ArrowUp') return 'previous';
		if (e.key === 'Home') return 'first';
		if (e.key === 'End') return 'last';
	}
	const remove = mac ? cmd && !e.altKey && !e.shiftKey && e.key === 'Backspace' : plain && e.key === 'Delete';
	if (BREAKPOINT_KINDS.includes(kind)) {
		if (plain && e.key === ' ') return 'toggle';
		if (remove) return 'remove';
		if (kind === 'breakpoint' || kind === 'functionBreakpoint') if (plain && e.key === 'F2') return 'edit';
		if (kind === 'breakpoint' || kind === 'instructionBreakpoint') {
			if (plain && e.key === 'Enter') return 'open';
			if (cmd && !e.altKey && !e.shiftKey && e.key === 'Enter' && kind === 'breakpoint') return 'openToSide';
		}
		return null;
	}
	const edit = plain && (e.key === 'F2' || (mac && e.key === 'Enter'));
	if (kind === 'variable') {
		if (edit) return 'edit';
		if (cmd && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c') return 'copy';
		if (plain && e.key === 'ArrowRight') return 'expand';
		if (plain && e.key === 'ArrowLeft') return 'collapse';
		return null;
	}
	// watch
	if (edit) return 'edit';
	if (remove) return 'remove';
	if (cmd && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c') return 'copy';
	return null;
}

/** The row to focus after next / previous / first / last among `count` rows (clamped, no wrap, like a list). */
export function moveRow(action: 'next' | 'previous' | 'first' | 'last', at: number, count: number): number {
	if (count <= 0) return -1;
	if (action === 'first') return 0;
	if (action === 'last') return count - 1;
	return Math.max(0, Math.min(count - 1, at + (action === 'next' ? 1 : -1)));
}

/** Debug Console filter (VS Code's repl filter): comma-separated terms; `!term` hides lines that
 * contain it; with any plain term, a line must contain one of them. Case-insensitive. */
export function replFilter(query: string): (text: string) => boolean {
	const terms = query
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	const include = terms.filter((s) => !s.startsWith('!'));
	const exclude = terms.filter((s) => s.startsWith('!') && s.length > 1).map((s) => s.slice(1));
	if (!include.length && !exclude.length) return () => true;
	return (text) => {
		const l = text.toLowerCase();
		if (exclude.some((x) => l.includes(x))) return false;
		return !include.length || include.some((x) => l.includes(x));
	};
}
