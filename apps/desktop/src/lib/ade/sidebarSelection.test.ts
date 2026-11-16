import { describe, expect, test } from 'bun:test';
import { menuTargets, rangeSelect, toggleSelect } from './sidebarSelection';

describe('sidebar multi-select (Orca use-selection)', () => {
	test('⌘-click toggles, starting from the open worktree', () => {
		expect(toggleSelect([], 'a', 'b')).toEqual(['a', 'b']);
		expect(toggleSelect(['a', 'b'], 'a', 'a')).toEqual(['b']);
		expect(toggleSelect([], null, 'b')).toEqual(['b']);
		expect(toggleSelect([], 'b', 'b')).toEqual(['b']);
	});
	test('shift-click selects the visible range either way', () => {
		const order = ['', 'a', 'b', 'c', 'd'];
		expect(rangeSelect(order, 'a', 'c')).toEqual(['a', 'b', 'c']);
		expect(rangeSelect(order, 'd', 'b')).toEqual(['b', 'c', 'd']);
		expect(rangeSelect(order, 'gone', 'b')).toEqual(['b']);
		expect(rangeSelect(order, 'a', 'gone')).toEqual([]);
	});
	test('the menu acts on the selection only from a selected card', () => {
		expect(menuTargets(['a', 'b'], 'a')).toEqual(['a', 'b']);
		expect(menuTargets(['a', 'b'], 'c')).toEqual(['c']);
		expect(menuTargets(['a'], 'a')).toEqual(['a']);
	});
});
