// The composer's dropdowns (the mode pill's menu, the model picker, the options menu): rows in
// sections with an optional search field, like Cursor's "Switch Agent Mode" and "Search models"
// menus. Pure so `bun test` covers it; ComposerMenu.svelte draws it.

import type { IconName } from '#lib/workbench/Icon.svelte';

export type MenuRow = {
	id: string;
	label: string;
	description?: string;
	icon?: IconName;
	/** The row is the current choice. */
	checked?: boolean;
	/** The section the row belongs to; a header is drawn where it changes. */
	section?: string;
	keyLabel?: string;
	disabled?: boolean;
	/** Drawn in the warning colour (Run Everything). */
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
