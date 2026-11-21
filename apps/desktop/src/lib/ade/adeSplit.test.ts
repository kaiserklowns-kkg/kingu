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
	regionCloses,
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

	test('dropping on the left or top edge puts the new group first', () => {
		const l = splitGroup(null, ids, 'g1', 't1', 'left')!;
		expect(shownTree(l)).toEqual({ type: 'split', direction: 'vertical', first: leaf('t1'), second: leaf('main') });
		const u = splitGroup(l, ids, 'g1', 'b3', 'up')!;
		expect(leaves(u.tree)).toEqual(['g2', 'g3', 'g1']);
		expect(paneRects(u.tree).get('g3')).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
		expect(groupTabs(u, ids, 'g3')).toEqual(['b3']);
	});

	test("Orca's no-op: a group's only tab dropped on the facing edge of the group beside it", () => {
		const g = splitGroup(null, ids, 'g1', 't1', 'right')!;
		// t1 is alone in g2, right of g1: g1's right edge would rebuild the same layout.
		expect(splitGroup(g, ids, 'g1', 't1', 'right')).toBe(g);
		// Its other edges do move it.
		expect(leaves(splitGroup(g, ids, 'g1', 't1', 'left')!.tree)).toEqual(['g3', 'g1']);
		// A group with more tabs splits on the facing edge too.
		const m = moveToGroup(g, ids, 'b3', 'g2')!;
		expect(leaves(splitGroup(m, ids, 'g1', 't1', 'right')!.tree)).toEqual(['g1', 'g3', 'g2']);
		const v = splitGroup(null, ids, 'g1', 't2', 'down')!;
		expect(splitGroup(v, ids, 'g1', 't2', 'down')).toBe(v);
		const vu = splitGroup(null, ids, 'g1', 't2', 'up')!;
		expect(splitGroup(vu, ids, 'g1', 't2', 'up')).toBe(vu);
	});

	test('closing a region closes its tabs (all but the agent tab); the region then collapses', () => {
		const g = splitGroup(splitGroup(null, ids, 'g1', 't1', 'right'), ids, 'g2', 'b3', 'down')!;
		const two = moveToGroup(g, ids, 'f:a.ts', 'g3')!;
		expect(regionCloses(two, ids, 'g3')).toEqual(['b3', 'f:a.ts']);
		expect(regionCloses(two, ids, 'g1')).toEqual(['t2']);
		// Both closed: g3 is gone.
		const left = ['main', 't1', 't2'];
		const c = closeGroup(two, left, 'g3')!;
		expect(leaves(c.tree)).toEqual(['g1', 'g2']);
		// One close cancelled (the file asked and was kept): the region stays.
		expect(closeGroup(two, [...left, 'f:a.ts'], 'g3')).toBe(two);
		// The agent tab never closes: it moves to the region next to it.
		const a = closeGroup(c, ['main', 't1'], 'g1');
		expect(a).toBeNull();
		const three = splitGroup(c, ids, 'g2', 'b3', 'down')!;
		const moved = closeGroup(three, ['main', 't1', 'b3'], 'g1')!;
		expect(leaves(moved.tree)).toEqual(['g2', 'g3']);
		expect(groupTabs(moved, ['main', 't1', 'b3'], 'g2')).toEqual(['main', 't1']);
		expect(closeGroup(c, ids, 'g8')).toBe(c);
	});

	test('styles and drop targets', () => {
		expect(rectStyle({ x: 0, y: 0, w: 0.5, h: 1 })).toBe('left:calc(0.000% + 0px);top:calc(0.000% + 0px);width:calc(50.000% - 2px);height:calc(100.000% - 0px)');
		expect(rectStyle({ x: 0.5, y: 0, w: 0.5, h: 1 }, 35)).toBe('left:calc(50.000% + 2px);top:calc(0.000% + 35px);width:calc(50.000% - 2px);height:calc(100.000% - 35px)');
		expect(stripStyle({ x: 0, y: 0.5, w: 1, h: 0.5 }, 35)).toBe('left:calc(0.000% + 0px);top:calc(50.000% + 2px);width:calc(100.000% - 0px);height:35px');
		const rects = paneRects(shownTree(splitGroup(null, ids, 'g1', 't1', 'right')!));
		// Orca's zones: 20% of the width on either side, then 20% of the body's height above and below.
		expect(dropTarget(rects, 0.45, 0.5)).toEqual({ id: 'main', dir: 'right' });
		expect(dropTarget(rects, 0.05, 0.5)).toEqual({ id: 'main', dir: 'left' });
		expect(dropTarget(rects, 0.55, 0.5)).toEqual({ id: 't1', dir: 'left' });
		expect(dropTarget(rects, 0.75, 0.95)).toEqual({ id: 't1', dir: 'down' });
		expect(dropTarget(rects, 0.25, 0.05)).toEqual({ id: 'main', dir: 'up' });
		expect(dropTarget(rects, 0.25, 0.5)).toBeNull();
		expect(dropTarget(rects, 0.25, 0.5, true)).toEqual({ id: 'main', dir: 'center' });
		// With a tab strip (top 0.1): its middle is the strip's own drop; "up" is measured in the body below it.
		expect(dropTarget(rects, 0.25, 0.05, true, 0.1)).toBeNull();
		expect(dropTarget(rects, 0.25, 0.15, true, 0.1)).toEqual({ id: 'main', dir: 'up' });
		expect(dropTarget(rects, 0.25, 0.3, true, 0.1)).toEqual({ id: 'main', dir: 'center' });
		// The side bands run the whole height, strip included.
		expect(dropTarget(rects, 0.02, 0.05, true, 0.1)).toEqual({ id: 'main', dir: 'left' });
		expect(dropEdge(50, 50, 100, 100)).toBeNull();
		expect(dropEdge(19, 50, 100, 100)).toBe('left');
		expect(dropEdge(81, 50, 100, 100)).toBe('right');
		expect(dropEdge(50, 19, 100, 100)).toBe('up');
		expect(dropEdge(50, 81, 100, 100)).toBe('down');
		expect(dropEdge(50, 0, 100, 100, 0)).toBe('up');
		expect(dropEdge(50, 0, 100, 0)).toBeNull();
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
