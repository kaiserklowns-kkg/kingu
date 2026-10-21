import { describe, expect, test } from 'bun:test';
import { historyStep, MAX_HISTORY, parseHistory, remember } from './searchHistory.ts';

describe('search history', () => {
	test('newest last, once, bounded; blanks are not kept', () => {
		expect(remember(['a', 'b'], 'a')).toEqual(['b', 'a']);
		expect(remember(['a'], '  ')).toEqual(['a']);
		const long = Array.from({ length: MAX_HISTORY }, (_, i) => `q${i}`);
		const next = remember(long, 'new');
		expect(next.length).toBe(MAX_HISTORY);
		expect(next[0]).toBe('q1');
		expect(next.at(-1)).toBe('new');
	});

	test('what is read back is vetted', () => {
		expect(parseHistory({ search: ['a', 3, ''], include: 'x', exclude: ['*.lock'] })).toEqual({ search: ['a'], replace: [], include: [], exclude: ['*.lock'] });
		expect(parseHistory(null)).toEqual({ search: [], replace: [], include: [], exclude: [] });
	});

	test('↑ goes back, ↓ forward and past the newest to what was typed', () => {
		const list = ['one', 'two', 'three'];
		// ↓ while not browsing: nothing (the results get it).
		expect(historyStep(list, null, 1, 'typed')).toBeNull();
		expect(historyStep(list, null, -1, 'typed')).toEqual({ at: 2 });
		// The box already shows the newest: ↑ starts one before it.
		expect(historyStep(list, null, -1, 'three')).toEqual({ at: 1 });
		expect(historyStep(list, 1, -1, 'two')).toEqual({ at: 0 });
		expect(historyStep(list, 0, -1, 'one')).toBeNull();
		expect(historyStep(list, 0, 1, 'one')).toEqual({ at: 1 });
		expect(historyStep(list, 2, 1, 'three')).toEqual({ at: null });
		expect(historyStep([], null, -1, '')).toBeNull();
		expect(historyStep(['only'], null, -1, 'only')).toBeNull();
	});
});
