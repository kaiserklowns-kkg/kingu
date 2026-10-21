// Keyboard navigation for a list or tree whose rows hold their own buttons (VS Code's list
// controller): ↑/↓, Home/End and PageUp/PageDown move focus between rows; Enter and Space on a
// row are the row's own (its button's click). Lists with their own key handling don't need it.

import { listTarget } from './accessibleView';

const ROWS = '[role="treeitem"], [role="listitem"], [role="option"], [role="row"]';
const FOCUSABLE = 'button, a[href], [tabindex]:not([tabindex="-1"]), [tabindex="-1"]';

/** The element to focus for a row: the row itself when focusable, else its first button or link. */
function focusTarget(row: HTMLElement): HTMLElement | null {
	if (row.hasAttribute('tabindex') || row instanceof HTMLButtonElement) return row;
	return row.querySelector<HTMLElement>(FOCUSABLE);
}

/** Svelte action: `use:listKeys` (rows: `selector`, else items with a list role, else direct children). */
export function listKeys(node: HTMLElement, selector?: string) {
	const onKey = (e: KeyboardEvent) => {
		if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
		const target = e.target as HTMLElement;
		if (target.closest('input, textarea, .monaco-editor, [contenteditable="true"]')) return;
		let rows = [...node.querySelectorAll<HTMLElement>(selector ?? ROWS)];
		if (!rows.length && !selector) rows = [...node.children].filter((c): c is HTMLElement => c instanceof HTMLElement && !!focusTarget(c));
		rows = rows.filter((r) => r.offsetParent !== null || r.getClientRects().length > 0);
		const current = rows.findIndex((r) => r.contains(target));
		const page = Math.max(1, Math.floor(node.clientHeight / Math.max(1, rows[0]?.offsetHeight ?? 22)));
		const next = listTarget(e.key, current, rows.length, page);
		if (next === null || next === current) return;
		const el = focusTarget(rows[next]);
		if (!el) return;
		e.preventDefault();
		el.focus();
		el.scrollIntoView({ block: 'nearest' });
	};
	node.addEventListener('keydown', onKey);
	return { destroy: () => node.removeEventListener('keydown', onKey) };
}
