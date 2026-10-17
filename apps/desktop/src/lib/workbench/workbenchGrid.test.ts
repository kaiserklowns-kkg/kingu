/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { areasAreRectangles, gridTemplateAreas, gridTemplateColumns, gridTemplateRows, workbenchGrid, type PanelAlignment, type PanelLocation, type SideBarLocation } from './workbenchGrid';

test('default: side bar left, panel bottom under the editor only', () => {
	const g = workbenchGrid({ sideBar: 'left', panel: 'bottom', alignment: 'center' });
	expect(g.columns).toEqual(['act', 'side', 'sashS', 'edit', 'sashX', 'aux']);
	expect(gridTemplateAreas(g)).toBe('"act side sashS edit sashX aux" "act side sashS sashP sashX aux" "act side sashS panel sashX aux"');
	expect(gridTemplateColumns(g)).toBe('auto auto auto minmax(0,1fr) auto auto');
	expect(gridTemplateRows(g)).toBe('minmax(0,1fr) auto auto');
});

test('alignment spans the panel to the edges; the activity bar always stays full height', () => {
	const row = (alignment: PanelAlignment, sideBar: SideBarLocation = 'left') => workbenchGrid({ sideBar, panel: 'bottom', alignment }).areas[2].join(' ');
	expect(row('justify')).toBe('act panel panel panel panel panel');
	expect(row('left')).toBe('act panel panel panel sashX aux');
	expect(row('right')).toBe('act side sashS panel panel panel');
	expect(row('left', 'right')).toBe('panel panel panel sashS side act');
	expect(row('right', 'right')).toBe('aux sashX panel panel panel act');
});

test('side bar right mirrors the row; panel top / left / right', () => {
	expect(workbenchGrid({ sideBar: 'right', panel: 'bottom', alignment: 'center' }).columns).toEqual(['aux', 'sashX', 'edit', 'sashS', 'side', 'act']);
	const top = workbenchGrid({ sideBar: 'left', panel: 'top', alignment: 'center' });
	expect(top.rows).toEqual(['panel', 'sashP', 'main']);
	expect(top.areas[0][3]).toBe('panel');
	expect(workbenchGrid({ sideBar: 'left', panel: 'left', alignment: 'justify' }).areas).toEqual([['act', 'side', 'sashS', 'panel', 'sashP', 'edit', 'sashX', 'aux']]);
	expect(workbenchGrid({ sideBar: 'right', panel: 'right', alignment: 'center' }).columns).toEqual(['aux', 'sashX', 'edit', 'sashP', 'panel', 'sashS', 'side', 'act']);
	expect(workbenchGrid({ sideBar: 'right', panel: 'left', alignment: 'center' }).columns).toEqual(['aux', 'sashX', 'panel', 'sashP', 'edit', 'sashS', 'side', 'act']);
});

test('every arrangement is a valid grid (rectangular areas, each part once)', () => {
	for (const sideBar of ['left', 'right'] as SideBarLocation[])
		for (const panel of ['bottom', 'top', 'left', 'right'] as PanelLocation[])
			for (const alignment of ['center', 'justify', 'left', 'right'] as PanelAlignment[]) {
				const g = workbenchGrid({ sideBar, panel, alignment });
				expect([sideBar, panel, alignment, areasAreRectangles(g)]).toEqual([sideBar, panel, alignment, true]);
				expect(new Set(g.areas.flat())).toEqual(new Set(['act', 'side', 'sashS', 'edit', 'panel', 'sashP', 'sashX', 'aux']));
			}
});
