import { describe, expect, test } from 'bun:test';
import { namesOfTags, parseIndex, pick, scopedName, tagsToDrop, touched, withSaved } from './workspaceState.ts';
import { rootTag } from '#lib/terminal/sessions.ts';
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

	test('cleanup: stale workspaces and the oldest beyond the limit lose their state, open ones never', () => {
		let index = parseIndex({ junk: { scope: 'x', used: 1 }, [rootTag('/bad')]: { scope: 3 } });
		expect(index).toEqual({});
		for (const [i, scope] of ['/a', 'empty:e1', '/b', '/c', 'empty:e2'].entries()) index = touched(index, scope, i);
		expect(index[rootTag('/a')]).toEqual({ scope: '/a', used: 0 });
		const stale = new Set(['empty:e1', 'empty:e2']);
		// e2 is this window's: kept although stale.
		expect(tagsToDrop(index, stale, new Set(['empty:e2']), 10)).toEqual([rootTag('empty:e1')]);
		// Only 2 kept: the least recently used go (the open one stays, although it is the oldest).
		expect(tagsToDrop(index, new Set(), new Set(['/a']), 2).sort()).toEqual([rootTag('empty:e1'), rootTag('/b'), rootTag('/c')].sort());
		const names = [scopedName('kingu.workbench.layout', '/b'), 'kingu.workbench.layout', `kingu.panelTerminals:${rootTag('/b')}`, scopedName('kingu.search.view', '/a'), 'kingu.x:short'];
		expect(namesOfTags(names, new Set([rootTag('/b')]))).toEqual([names[0], names[2]]);
	});
});
