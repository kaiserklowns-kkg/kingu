import { describe, expect, test } from 'bun:test';
import { closeRegion, dropEdge, dropTarget, liveTree, parseSavedTabs, rectStyle, showIn, splitTab, splittable } from './adeSplit';
import { leaves, paneRects } from '#lib/terminal/paneLayout.ts';

describe('tab regions (Orca drag to edge, nested groups)', () => {
	test('which tabs can be a region', () => {
		expect(['main', 't3', 'b12', 'f:src/a.ts', 'f:taskdiff://x'].every(splittable)).toBe(true);
		expect(['compose', 't', 'f:'].some(splittable)).toBe(false);
	});
	test('splits nest, move a tab that is already shown, and close back to one', () => {
		let t = splitTab(null, 'main', 't1', 'right');
		expect(leaves(t!)).toEqual(['main', 't1']);
		t = splitTab(t, 't1', 'f:a.ts', 'down');
		expect(leaves(t!)).toEqual(['main', 't1', 'f:a.ts']);
		expect(paneRects(t!).get('f:a.ts')).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
		// Dropping a shown tab elsewhere moves it.
		t = splitTab(t, 'main', 'f:a.ts', 'down');
		expect(leaves(t!)).toEqual(['main', 'f:a.ts', 't1']);
		expect(splitTab(t, 'main', 'main', 'right')).toBe(t);
		t = closeRegion(t, 'f:a.ts');
		expect(leaves(t!)).toEqual(['main', 't1']);
		expect(closeRegion(t, 't1')).toBeNull();
	});
	test('picking a tab shows it in the active region; closed tabs drop out', () => {
		const t = splitTab(null, 'main', 't1', 'right');
		expect(leaves(showIn(t, 'main', 'b2')!)).toEqual(['b2', 't1']);
		expect(showIn(t, 'main', 't1')).toBe(t);
		expect(showIn(t, 'main', 'compose')).toBeNull();
		expect(liveTree(t, new Set(['main']), 'main')).toBeNull();
		expect(liveTree(t, new Set(['main', 't1']), 'b9')).toBeNull();
		expect(liveTree(t, new Set(['main', 't1']), 'main')).toBe(t);
	});
	test('styles and drop targets', () => {
		expect(rectStyle({ x: 0, y: 0, w: 0.5, h: 1 })).toBe('left:calc(0.000% + 0px);top:calc(0.000% + 0px);width:calc(50.000% - 2px);height:calc(100.000% - 0px)');
		const rects = paneRects(splitTab(null, 'main', 't1', 'right')!);
		expect(dropTarget(rects, 0.45, 0.5)).toEqual({ id: 'main', dir: 'right' });
		expect(dropTarget(rects, 0.75, 0.95)).toEqual({ id: 't1', dir: 'down' });
		expect(dropTarget(rects, 0.2, 0.2)).toBeNull();
		expect(dropEdge(50, 50, 100, 100)).toBeNull();
	});
	test('saved tabs come back checked', () => {
		const s = parseSavedTabs({
			browsers: { '': [{ id: 'b1', url: 'https://x.dev', title: 'X' }, { id: 'b2', url: 'javascript:alert(1)', title: 'bad' }] },
			files: { fix: [{ key: 'src/a.ts', preview: false }, { key: 'untitled:Untitled-1', preview: false }, { key: 'b.ts', preview: true }] },
			order: { fix: ['t1', 3] },
			colors: { 'fix:t1': '#f00', 'fix:t2': 'red' },
			layouts: { fix: splitTab(null, 'main', 't1', 'right'), bad: { type: 'leaf', id: 'main' }, x: { type: 'split', direction: 'vertical', first: { type: 'leaf', id: 'compose' }, second: { type: 'leaf', id: 't1' } } }
		});
		expect(s.browsers['']).toEqual([{ id: 'b1', url: 'https://x.dev', title: 'X' }]);
		expect(s.files.fix).toEqual([{ key: 'src/a.ts', preview: false }]);
		expect(s.order.fix).toEqual(['t1']);
		expect(s.colors).toEqual({ 'fix:t1': '#f00' });
		expect(Object.keys(s.layouts)).toEqual(['fix']);
		expect(parseSavedTabs(null).browsers).toEqual({});
	});
});
