import { describe, expect, test } from 'bun:test';
import { pick, scopedName, withSaved } from './workspaceState.ts';
import { workspaceStateKey } from './workspaceFolders.ts';

describe('per-workspace UI state', () => {
	test('each workspace, and each empty window, has its own key', () => {
		expect(workspaceStateKey('/w/app', '/w/app', null)).toBe('/w/app');
		expect(workspaceStateKey('/w/x.code-workspace', '/w/app', null)).toBe('/w/x.code-workspace');
		expect(workspaceStateKey('untitled:7f', '/w/app', null)).toBe('untitled:7f');
		expect(workspaceStateKey(null, null, 'e1')).toBe('empty:e1');
		expect(workspaceStateKey(null, null, 'e2')).not.toBe(workspaceStateKey(null, null, 'e1'));
		expect(workspaceStateKey(null, null, null)).toBeNull();
		const a = scopedName('kingu.workbench.layout', '/w/app');
		expect(a).toMatch(/^kingu\.workbench\.layout:[0-9a-f]{8}$/);
		expect(scopedName('kingu.workbench.layout', 'empty:e1')).not.toBe(a);
		// The shared (sizes) key is never a workspace's.
		expect(a).not.toBe('kingu.workbench.layout');
	});

	test('a store keeps only its own keys from what was saved', () => {
		const old = { sidebarWidth: 280, panelVisible: true, sideView: 'scm' };
		expect(pick(old, ['panelVisible', 'sideView', 'zen'])).toEqual({ panelVisible: true, sideView: 'scm' });
		expect(pick({ sidebarWidth: 280 }, ['panelVisible'])).toBeNull();
		for (const bad of [null, 'x', 3, ['panelVisible']]) expect(pick(bad, ['panelVisible'])).toBeNull();
	});

	test('a workspace never opened gets the defaults; a saved one its own values of the right type', () => {
		const defaults = { panelVisible: false, sideView: 'explorer', zenExit: null as { a: number } | null, widths: [1] };
		expect(withSaved(defaults, null)).toEqual(defaults);
		expect(withSaved(defaults, { panelVisible: true, sideView: 'search', zenExit: { a: 1 } })).toEqual({ panelVisible: true, sideView: 'search', zenExit: { a: 1 }, widths: [1] });
		// Wrong types (an edited or older file) fall back to the default.
		expect(withSaved(defaults, { panelVisible: 'yes', sideView: 3, widths: { 0: 1 } })).toEqual(defaults);
	});
});
