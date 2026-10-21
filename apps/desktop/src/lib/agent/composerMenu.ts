// The composer's dropdowns (the mode pill's menu, the model picker, the options menu): rows in
// sections with an optional search field, like Cursor's "Switch Agent Mode" and "Search models"
// menus. Pure so `bun test` covers it; ComposerMenu.svelte draws it.

import type { IconName } from '#lib/workbench/Icon.svelte';

export type MenuRow = {
	id: string;
	label: string;
	description?: string;
	icon?: IconName;
	/** A product icon id, over `icon` (the chat's pickers name VS Code's icons). */
	codicon?: string;
	/** An agent whose mark is drawn, over `codicon` (agentIcons.ts). */
	agent?: string;
	/** The row is the current choice. */
	checked?: boolean;
	/** The section the row belongs to; a header is drawn where it changes. */
	section?: string;
	keyLabel?: string;
	disabled?: boolean;
	/** Drawn in the warning colour (Allow all). */
	warn?: boolean;
	/** A CSS colour for the row's icon (a mode's colour). */
	color?: string;
};

/** Rows whose label, description or id contains every word of `query` (case-insensitive). */
export function filterRows(rows: readonly MenuRow[], query: string): MenuRow[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return [...rows];
	return rows.filter((r) => {
		const hay = `${r.label} ${r.description ?? ''} ${r.id}`.toLowerCase();
		return words.every((w) => hay.includes(w));
	});
}

/** Whether row `i` starts a new section (a header goes above it). */
export const startsSection = (rows: readonly MenuRow[], i: number): boolean => !!rows[i]?.section && (i === 0 || rows[i - 1].section !== rows[i].section);

/** The next enabled row from `active` going `dir`, wrapping; -1 when none is enabled. */
export function nextEnabled(rows: readonly MenuRow[], active: number, dir: 1 | -1): number {
	const n = rows.length;
	for (let step = 1; step <= n; step++) {
		const i = (((active + dir * step) % n) + n) % n;
		if (!rows[i].disabled) return i;
	}
	return -1;
}

/** The row to highlight when the menu opens: the checked one, else the first enabled one. */
export function initialActive(rows: readonly MenuRow[]): number {
	const checked = rows.findIndex((r) => r.checked && !r.disabled);
	return checked >= 0 ? checked : rows.findIndex((r) => !r.disabled);
}

export type Box = { left: number; top: number; right: number; bottom: number };

/**
 * Where a dropdown goes (fixed, in viewport px): next to its trigger `anchor`, `width` at most the
 * room inside `bounds` (the chat panel, within the viewport) less a margin, kept inside it
 * horizontally, above or below the trigger with the height there is room for. A fixed menu never
 * widens or scrolls the panel it opens from.
 */
export function placeMenu(
	anchor: Box,
	bounds: Box,
	opts: { width: number; align: 'left' | 'right'; below: boolean; margin?: number; gap?: number }
): { left: number; width: number; top?: number; bottom?: number; maxHeight: number; viewportBottom: number } {
	const m = opts.margin ?? 4;
	const gap = opts.gap ?? 6;
	const width = Math.max(120, Math.min(opts.width, bounds.right - bounds.left - 2 * m));
	const wanted = opts.align === 'left' ? anchor.left : anchor.right - width;
	const left = Math.max(bounds.left + m, Math.min(wanted, bounds.right - m - width));
	if (opts.below) return { left, width, top: anchor.bottom + gap, maxHeight: Math.max(80, bounds.bottom - anchor.bottom - gap - m), viewportBottom: bounds.bottom };
	return { left, width, bottom: bounds.bottom - anchor.top + gap, maxHeight: Math.max(80, anchor.top - gap - bounds.top - m), viewportBottom: bounds.bottom };
}
