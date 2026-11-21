import { describe, expect, test } from 'bun:test';
import {
	activeAfterGroupClose,
	closeGroup,
	dropEdge,
	dropTarget,
	groupOf,
	groupTabs,
	liveGroups,
	migrateRegions,
	moveToGroup,
	parseSavedTabs,
	parseTabGroups,
	placeTab,
	rectStyle,
	renameTab,
	shownTree,
	splitGroup,
	splittable,
	stripStyle,
	withShown,
	type TabGroups
} from './adeSplit';
import { leaf, leaves, paneRects } from '#lib/terminal/paneLayout.ts';

const ids = ['main', 't1', 't2', 'b3', 'f:a.ts'];

describe('tab groups (Orca: every region has its own tab strip)', () => {
	test('which tabs can be in a group', () => {
		expect(['main', 't3', 'b12', 'f:src/a.ts', 'f:taskdiff://x'].every(splittable)).toBe(true);
		expect(['compose', 't', 'f:', 'g1'].some(splittable)).toBe(false);
	});

	test('dropping a tab on an edge moves it into a new group there; the rest stay in the first group', () => {
		const g = splitGroup(null, ids, 'g1', 't1', 'right')!;
		expect(leaves(g.tree)).toEqual(['g1', 'g2']);
		expect(groupTabs(g, ids, 'g1')).toEqual(['main', 't2', 'b3', 'f:a.ts']);
		expect(groupTabs(g, ids, 'g2')).toEqual(['t1']);
		expect(g.shown).toEqual({ g1: 'main', g2: 't1' });
		expect(shownTree(g)).toEqual({ type: 'split', direction: 'vertical', first: leaf('main'), second: leaf('t1') });
		// Splits nest.
		const n = splitGroup(g, ids, 'g2', 'f:a.ts', 'down')!;
		expect(leaves(n.tree)).toEqual(['g1', 'g2', 'g3']);
		expect(paneRects(n.tree).get('g3')).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
		expect(groupTabs(n, ids, 'g3')).toEqual(['f:a.ts']);
	});

	test("a group's only tab dropped on its own edge is a no-op; one tab cannot split", () => {
		const g = splitGroup(null, ids, 'g1', 't1', 'right')!;
		expect(splitGroup(g, ids, 'g2', 't1', 'down')).toBe(g);
		expect(splitGroup(null, ['main'], 'g1', 'main', 'right')).toBeNull();
		expect(splitGroup(g, ids, 'g9', 't2', 'right')).toBe(g);
		expect(splitGroup(g, ids, 'g1', 'compose', 'right')).toBe(g);
	});

	test("moving the last tab out of a group closes that group (into another group's edge or onto it)", () => {
		const g = splitGroup(null, ids, 'g1', 't1', 'right')!;
		// The group's only tab split off elsewhere: the emptied group goes.
		const s = splitGroup(g, ids, 'g1', 't1', 'down')!;
		expect(leaves(s.tree)).toEqual(['g1', 'g3']);
		expect(s.tree.type === 'split' && s.tree.direction).toBe('horizontal');
		// Dropped onto the other group: one group left, no split.
		expect(moveToGroup(g, ids, 't1', 'g1')).toBeNull();
	});

	test('moving a tab between groups shows it there; the source shows its most recent tab', () => {
		const g = splitGroup(null, ids, 'g1', 't1', 'right')!;
		const m = moveToGroup(withShown(g, 'b3'), ids, 'b3', 'g2', ['t2', 'main'])!;
		expect(groupTabs(m, ids, 'g2')).toEqual(['t1', 'b3']);
		expect(m.shown).toEqual({ g1: 't2', g2: 'b3' });
		expect(moveToGroup(m, ids, 'b3', 'g2')).toBe(m);
		expect(moveToGroup(m, ids, 'b3', 'g7')).toBe(m);
		expect(moveToGroup(null, ids, 'b3', 'g1')).toBeNull();
	});

	test('closing a tab: closed tabs drop out, an emptied group collapses, the active one is shown', () => {
		const g = splitGroup(null, ids, 'g1', 't1', 'right')!;
		expect(liveGroups(g, ['main', 't2'], 'main')).toBeNull();
		const live = liveGroups(g, ids, 't2')!;
		expect(live.shown).toEqual({ g1: 't2', g2: 't1' });
		expect(groupOf(live, 'b3')).toBe('g1');
		expect(liveGroups(undefined, ids, 'main')).toBeNull();
		// The active tab after a close: its neighbour in its own strip, else what the next group shows.
		expect(activeAfterGroupClose(live, ids, 't2', 't2')).toBe('b3');
		expect(activeAfterGroupClose(live, ids, 't1', 't1')).toBe('t2');
		expect(activeAfterGroupClose(live, ids, 'b3', 't1')).toBe('t1');
		expect(activeAfterGroupClose(null, ids, 't1', 't1')).toBe('t2');
	});

	test('new tabs join the active group; renames keep their group', () => {
		const g = splitGroup(null, ids, 'g1', 't1', 'right')!;
		const live = liveGroups(g, ids, 't1')!;
		const p = placeTab(live, 't9', 't1');
		expect(groupTabs(p, [...ids, 't9'], 'g2')).toEqual(['t1', 't9']);
		expect(placeTab(p, 't9', 'main')).toBe(p);
		const r = renameTab(withShown(p, 't9'), 't9', 'f:b.ts');
		expect(r.of['f:b.ts']).toBe('g2');
		expect(r.shown.g2).toBe('f:b.ts');
		expect(renameTab(r, 'nope', 'x')).toBe(r);
	});

	test('closing a region keeps its tabs in the group next to it', () => {
		const g = splitGroup(splitGroup(null, ids, 'g1', 't1', 'right'), ids, 'g2', 'b3', 'down')!;
		const c = closeGroup(g, ids, 'g3')!;
		expect(leaves(c.tree)).toEqual(['g1', 'g2']);
		expect(groupTabs(c, ids, 'g2')).toEqual(['t1', 'b3']);
		expect(c.shown.g2).toBe('t1');
		expect(closeGroup(c, ids, 'g1')).toBeNull();
		expect(closeGroup(c, ids, 'g8')).toBe(c);
	});

	test('styles and drop targets', () => {
		expect(rectStyle({ x: 0, y: 0, w: 0.5, h: 1 })).toBe('left:calc(0.000% + 0px);top:calc(0.000% + 0px);width:calc(50.000% - 2px);height:calc(100.000% - 0px)');
		expect(rectStyle({ x: 0.5, y: 0, w: 0.5, h: 1 }, 35)).toBe('left:calc(50.000% + 2px);top:calc(0.000% + 35px);width:calc(50.000% - 2px);height:calc(100.000% - 35px)');
		expect(stripStyle({ x: 0, y: 0.5, w: 1, h: 0.5 }, 35)).toBe('left:calc(0.000% + 0px);top:calc(50.000% + 2px);width:calc(100.000% - 0px);height:35px');
		const rects = paneRects(shownTree(splitGroup(null, ids, 'g1', 't1', 'right')!));
		expect(dropTarget(rects, 0.45, 0.5)).toEqual({ id: 'main', dir: 'right' });
		expect(dropTarget(rects, 0.75, 0.95)).toEqual({ id: 't1', dir: 'down' });
		expect(dropTarget(rects, 0.2, 0.2)).toBeNull();
		expect(dropTarget(rects, 0.2, 0.2, true)).toEqual({ id: 'main', dir: 'center' });
		expect(dropEdge(50, 50, 100, 100)).toBeNull();
	});
});

describe('saved tabs', () => {
	test('saved tabs come back checked', () => {
		const groups = splitGroup(null, ids, 'g1', 't1', 'right')!;
		const s = parseSavedTabs({
			browsers: { '': [{ id: 'b1', url: 'https://x.dev', title: 'X' }, { id: 'b2', url: 'javascript:alert(1)', title: 'bad' }] },
			files: { fix: [{ key: 'src/a.ts', preview: false }, { key: 'untitled:Untitled-1', preview: false }, { key: 'b.ts', preview: true }] },
			order: { fix: ['t1', 3] },
			colors: { 'fix:t1': '#f00', 'fix:t2': 'red' },
			layouts: { fix: groups, bad: { tree: { type: 'leaf', id: 'g1' }, of: {}, shown: {} }, x: { tree: { type: 'split', direction: 'vertical', first: { type: 'leaf', id: 'main' }, second: { type: 'leaf', id: 'g2' } }, of: {}, shown: {} } }
		});
		expect(s.browsers['']).toEqual([{ id: 'b1', url: 'https://x.dev', title: 'X' }]);
		expect(s.files.fix).toEqual([{ key: 'src/a.ts', preview: false }]);
		expect(s.order.fix).toEqual(['t1']);
		expect(s.colors).toEqual({ 'fix:t1': '#f00' });
		expect(Object.keys(s.layouts)).toEqual(['fix']);
		expect(s.layouts.fix).toEqual(groups);
		expect(parseSavedTabs(null).browsers).toEqual({});
	});

	test('saved groups drop bad tab and group ids; a round trip through JSON keeps them', () => {
		const g: TabGroups = JSON.parse(JSON.stringify(splitGroup(splitGroup(null, ids, 'g1', 't1', 'right'), ids, 'g2', 'f:a.ts', 'down')));
		expect(parseTabGroups(g)).toEqual(g);
		const bad = parseTabGroups({ ...g, of: { ...g.of, compose: 'g1', t2: 'g9', b3: 4 }, shown: { ...g.shown, g9: 't2', g1: 'compose' } })!;
		const { t2: _t2, b3: _b3, ...kept } = g.of;
		expect(bad.of).toEqual(kept);
		expect(bad.shown).toEqual({ g2: 't1', g3: 'f:a.ts' });
		expect(parseTabGroups('x')).toBeNull();
		// The emptied g1 shows its first tab again.
		expect(liveGroups(bad, ids, 't1')!.shown.g1).toBe('main');
	});

	test("an older Kingu's saved regions (a tree of tabs) become one group per region", () => {
		const old = { type: 'split', direction: 'vertical', first: { type: 'leaf', id: 'main' }, second: { type: 'split', direction: 'horizontal', ratio: 0.3, first: { type: 'leaf', id: 't1' }, second: { type: 'leaf', id: 'b3' } } };
		const m = parseTabGroups(old)!;
		expect(m).toEqual(migrateRegions(old as never));
		expect(leaves(m.tree)).toEqual(['g1', 'g2', 'g3']);
		expect(m.tree.type === 'split' && m.tree.second.type === 'split' && m.tree.second.ratio).toBe(0.3);
		expect(m.of).toEqual({ main: 'g1', t1: 'g2', b3: 'g3' });
		// Tabs the old regions did not show join the first group.
		const live = liveGroups(m, ids, 'main')!;
		expect(groupTabs(live, ids, 'g1')).toEqual(['main', 't2', 'f:a.ts']);
		expect(shownTree(live)).toEqual(old as never);
		expect(parseSavedTabs({ layouts: { fix: old } }).layouts.fix).toEqual(m);
		expect(parseTabGroups({ type: 'leaf', id: 'main' })).toBeNull();
	});
});
