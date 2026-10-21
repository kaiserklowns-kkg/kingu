import { describe, expect, test } from 'bun:test';
import { maximizeAux, restoreAux } from './auxMaximize.ts';
import { gridTemplateColumns, workbenchGrid } from './workbenchGrid.ts';

describe('Maximize Secondary Side Bar', () => {
	test('maximizing hides the side bar and panel and shows the secondary side bar', () => {
		const { parts, restore } = maximizeAux({ sideBar: true, panel: true, auxiliaryBar: false });
		expect(parts).toEqual({ sideBar: false, panel: false, auxiliaryBar: true });
		expect(restore).toEqual({ sideBar: true, panel: true, auxiliaryBar: false });
	});

	test('restoring brings back what showed before, and keeps the secondary side bar as it is', () => {
		const { restore } = maximizeAux({ sideBar: true, panel: false, auxiliaryBar: true });
		// The side bar was shown again while maximized; the panel too.
		expect(restoreAux({ sideBar: true, panel: true, auxiliaryBar: true }, restore)).toEqual({ sideBar: true, panel: false, auxiliaryBar: true });
		// Hiding the secondary side bar ends maximized mode: it stays hidden.
		expect(restoreAux({ sideBar: false, panel: false, auxiliaryBar: false }, restore)).toEqual({ sideBar: true, panel: false, auxiliaryBar: false });
	});

	test('nothing saved: nothing changes', () => {
		expect(restoreAux({ sideBar: false, panel: true, auxiliaryBar: true }, null)).toEqual({ sideBar: false, panel: true, auxiliaryBar: true });
	});

	test('the grid gives the secondary side bar the editor’s share while maximized', () => {
		const g = workbenchGrid({ sideBar: 'left', panel: 'bottom', alignment: 'center' });
		expect(gridTemplateColumns(g)).toBe('auto auto auto minmax(0,1fr) auto auto');
		expect(gridTemplateColumns(g, 'aux')).toBe('auto auto auto 0px auto minmax(0,1fr)');
		const right = workbenchGrid({ sideBar: 'right', panel: 'bottom', alignment: 'center' });
		expect(gridTemplateColumns(right, 'aux')).toBe('minmax(0,1fr) auto 0px auto auto auto');
	});
});
