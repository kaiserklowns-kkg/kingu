// The workbench body as one CSS grid (VS Code layout.ts: side bar left/right, panel
// bottom/top/left/right, panel alignment center/justify/left/right). Every part keeps its DOM node
// whatever the arrangement, so moving the panel or side bar never remounts the editors or
// terminals; only `grid-template-areas` changes. Pure, so it is unit-testable.

export type SideBarLocation = 'left' | 'right';
export type PanelLocation = 'bottom' | 'top' | 'left' | 'right';
export type PanelAlignment = 'center' | 'justify' | 'left' | 'right';

/** Grid areas: activity bar, side bar, editor, panel, secondary side bar, and their sashes. */
export type Area = 'act' | 'side' | 'sashS' | 'edit' | 'panel' | 'sashP' | 'sashX' | 'aux';

export type WorkbenchGrid = { columns: Area[]; rows: ('main' | 'panel' | 'sashP')[]; areas: Area[][] };

export function workbenchGrid(opts: { sideBar: SideBarLocation; panel: PanelLocation; alignment: PanelAlignment }): WorkbenchGrid {
	const sidePanel = opts.panel === 'left' || opts.panel === 'right';
	const middle: Area[] = opts.panel === 'left' ? ['panel', 'sashP', 'edit'] : opts.panel === 'right' ? ['edit', 'sashP', 'panel'] : ['edit'];
	// Left to right with the side bar on the left; mirrored with it on the right.
	const ltr: Area[] = ['act', 'side', 'sashS', ...middle, 'sashX', 'aux'];
	const columns = opts.sideBar === 'left' ? ltr : mirror(ltr, middle);
	const rows: WorkbenchGrid['rows'] = sidePanel ? ['main'] : opts.panel === 'top' ? ['panel', 'sashP', 'main'] : ['main', 'sashP', 'panel'];

	// Columns the bottom/top panel spans: the editor, out to an edge for left/right, all but the activity bar for justify.
	const edit = columns.indexOf('edit');
	const first = columns.findIndex((c) => c !== 'act');
	const last = columns.length - 1 - [...columns].reverse().findIndex((c) => c !== 'act');
	const [from, to] =
		opts.alignment === 'justify' ? [first, last] : opts.alignment === 'left' ? [first, edit] : opts.alignment === 'right' ? [edit, last] : [edit, edit];

	const areas = rows.map((row) => columns.map((col, i) => (row === 'main' || i < from || i > to ? col : row)));
	return { columns, rows, areas };
}

/** Mirrors the row but keeps a left/right panel on the same side of the editor (its location is absolute). */
function mirror(ltr: Area[], middle: Area[]): Area[] {
	const out = [...ltr].reverse();
	const at = out.indexOf(middle[middle.length - 1]);
	out.splice(at, middle.length, ...middle);
	return out;
}

export const gridTemplateAreas = (g: WorkbenchGrid) => g.areas.map((r) => `"${r.join(' ')}"`).join(' ');
export const gridTemplateColumns = (g: WorkbenchGrid) => g.columns.map((c) => (c === 'edit' ? 'minmax(0,1fr)' : 'auto')).join(' ');
export const gridTemplateRows = (g: WorkbenchGrid) => g.rows.map((r) => (r === 'main' ? 'minmax(0,1fr)' : 'auto')).join(' ');

/** Grid areas must be rectangles; true when every area name covers one. */
export function areasAreRectangles(g: WorkbenchGrid): boolean {
	const names = new Set(g.areas.flat());
	for (const name of names) {
		let top = Infinity, bottom = -1, left = Infinity, right = -1, count = 0;
		g.areas.forEach((row, r) =>
			row.forEach((a, c) => {
				if (a !== name) return;
				count++;
				top = Math.min(top, r);
				bottom = Math.max(bottom, r);
				left = Math.min(left, c);
				right = Math.max(right, c);
			})
		);
		if (count !== (bottom - top + 1) * (right - left + 1)) return false;
	}
	return true;
}
