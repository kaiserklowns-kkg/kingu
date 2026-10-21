import { describe, expect, test } from 'bun:test';
import { childAgentRows, childAgentToggle, dispatchLineage } from './childAgents.ts';
import { nestTasks } from './attempts.ts';

const task = (slug: string, dispatchedBy?: string, parent?: string) => ({ slug, dispatchedBy: dispatchedBy ?? null, parent: parent ?? null });
const LIST = [task('lead'), task('w1', 'lead'), task('w2', 'lead'), task('w1a', 'w1'), task('solo')];
const open = { collapsed: () => false, selected: null };

describe('dispatchLineage', () => {
	test('links only to a listed dispatcher and drops cycles', () => {
		const m = dispatchLineage([task('a', 'b'), task('b', 'a'), task('c', 'gone'), task('d', 'd'), task('e', 'c')]);
		expect([...m]).toEqual([['e', 'c']]);
	});
});

describe('childAgentRows', () => {
	test('on: children nest under their dispatcher, grandchildren deeper', () => {
		const r = childAgentRows(LIST, { show: true, ...open });
		const nested = nestTasks(r.rows).map((n) => [n.item.slug, n.depth]);
		expect(nested).toEqual([
			['lead', 0],
			['w1', 1],
			['w1a', 2],
			['w2', 1],
			['solo', 0]
		]);
		expect(r.children.get('lead')).toBe(2);
		expect(r.children.get('w1')).toBe(1);
	});

	test('a stacked parent wins over the dispatcher', () => {
		const r = childAgentRows([task('lead'), task('base'), task('w', 'lead', 'base')], { show: true, ...open });
		expect(r.rows.find((t) => t.slug === 'w')?.parent).toBe('base');
	});

	test('folding a dispatcher hides every task below it, except the selected one', () => {
		const folded = (s: string) => s === 'lead';
		expect(childAgentRows(LIST, { show: true, collapsed: folded, selected: null }).rows.map((t) => t.slug)).toEqual(['lead', 'solo']);
		expect(childAgentRows(LIST, { show: true, collapsed: folded, selected: 'w1a' }).rows.map((t) => t.slug)).toEqual(['lead', 'w1a', 'solo']);
	});

	test('off (Orca default): children are hidden, counts kept, selected stays at the top level', () => {
		const r = childAgentRows(LIST, { show: false, collapsed: () => false, selected: 'w2' });
		expect(r.rows.map((t) => [t.slug, t.parent])).toEqual([
			['lead', null],
			['w2', null],
			['solo', null]
		]);
		expect(childAgentToggle('lead', r, { show: false, collapsed: () => false })).toEqual({ count: 2, expanded: false });
	});

	test('orphans (dispatcher not listed) stay at the top level either way', () => {
		const list = [task('w', 'removed')];
		expect(childAgentRows(list, { show: false, ...open }).rows).toEqual(list);
		expect(childAgentToggle('w', childAgentRows(list, { show: true, ...open }), { show: true, collapsed: () => false })).toBeNull();
	});
});
