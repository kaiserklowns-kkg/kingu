import { describe, expect, test } from 'bun:test';
import { cyclePane, dividers, equalize, hasLeaf, leaf, leaves, paneRects, parsePaneNode, removePane, setRatio, splitPane, type PaneNode } from './paneLayout.ts';

const valid = (id: string) => /^t\d+$/.test(id);

describe('split and close', () => {
	test('split right then down nests the new pane next to its source', () => {
		let t: PaneNode = leaf('t1');
		t = splitPane(t, 't1', 't2', 'vertical');
		t = splitPane(t, 't2', 't3', 'horizontal');
		expect(leaves(t)).toEqual(['t1', 't2', 't3']);
		expect(t).toEqual({ type: 'split', direction: 'vertical', first: leaf('t1'), second: { type: 'split', direction: 'horizontal', first: leaf('t2'), second: leaf('t3') } });
		expect(leaves(splitPane(leaf('t1'), 't1', 't2', 'vertical', true))).toEqual(['t2', 't1']);
		expect(splitPane(t, 'nope', 't9', 'vertical')).toEqual(t);
	});

	test('closing a pane promotes its sibling', () => {
		let t: PaneNode = splitPane(splitPane(leaf('t1'), 't1', 't2', 'vertical'), 't2', 't3', 'horizontal');
		t = removePane(t, 't2')!;
		expect(t).toEqual({ type: 'split', direction: 'vertical', first: leaf('t1'), second: leaf('t3') });
		t = removePane(t, 't1')!;
		expect(t).toEqual(leaf('t3'));
		expect(removePane(t, 't3')).toBeNull();
		expect(hasLeaf(t, 't3')).toBe(true);
	});
});

describe('sizes', () => {
	test('rects follow the ratios', () => {
		const t = setRatio(splitPane(splitPane(leaf('a'), 'a', 'b', 'vertical'), 'b', 'c', 'horizontal'), [], 0.25);
		const r = paneRects(t);
		expect(r.get('a')).toEqual({ x: 0, y: 0, w: 0.25, h: 1 });
		expect(r.get('b')).toEqual({ x: 0.25, y: 0, w: 0.75, h: 0.5 });
		expect(r.get('c')).toEqual({ x: 0.25, y: 0.5, w: 0.75, h: 0.5 });
		expect(dividers(t).map((d) => [d.path, d.direction, d.ratio])).toEqual([
			[[], 'vertical', 0.25],
			[[1], 'horizontal', 0.5]
		]);
		expect(setRatio(t, [], 2)).toMatchObject({ ratio: 0.95 });
	});

	test('equalize gives three side-by-side panes a third each (Orca weights)', () => {
		const t = equalize(splitPane(splitPane(leaf('a'), 'a', 'b', 'vertical'), 'b', 'c', 'vertical'));
		const r = paneRects(t);
		for (const id of ['a', 'b', 'c']) expect(r.get(id)!.w).toBeCloseTo(1 / 3);
		// A stacked pair counts once along the other axis.
		const mixed = equalize(splitPane(splitPane(leaf('a'), 'a', 'b', 'vertical'), 'b', 'c', 'horizontal'));
		expect(paneRects(mixed).get('a')!.w).toBeCloseTo(0.5);
	});
});

test('focus cycles and wraps', () => {
	expect(cyclePane(['a', 'b', 'c'], 'c', 1)).toBe('a');
	expect(cyclePane(['a', 'b', 'c'], 'a', -1)).toBe('c');
	expect(cyclePane([], 'a', 1)).toBe('a');
});

test('persisted trees are vetted', () => {
	const t = setRatio(splitPane(leaf('t1'), 't1', 't2', 'horizontal'), [], 0.3);
	expect(parsePaneNode(JSON.parse(JSON.stringify(t)), valid)).toEqual(t);
	expect(parsePaneNode({ type: 'leaf', id: 'x/../y' }, valid)).toBeNull();
	expect(parsePaneNode({ type: 'split', direction: 'diagonal', first: leaf('t1'), second: leaf('t2') }, valid)).toBeNull();
	expect(parsePaneNode({ type: 'split', direction: 'vertical', first: leaf('t1'), second: leaf('t1') }, valid)).toBeNull();
	expect(parsePaneNode({ type: 'split', direction: 'vertical', first: leaf('t1'), second: leaf('t2'), ratio: 7 }, valid)).toEqual(splitPane(leaf('t1'), 't1', 't2', 'vertical'));
	expect(parsePaneNode(null, valid)).toBeNull();
});
