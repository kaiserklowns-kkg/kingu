import { describe, expect, test } from 'bun:test';
import { emptyHistory, MAX_HISTORY, recordVisit, stepIndex } from './worktreeHistory';

describe("Orca's worktree history", () => {
	test('records visits, keeps A → B → A, and drops forward entries on a new visit', () => {
		let h = emptyHistory();
		for (const k of ['a', 'b', 'b', 'a']) h = recordVisit(h, k);
		expect(h).toEqual({ entries: ['a', 'b', 'a'], index: 2 });
		h = { ...h, index: 1 };
		h = recordVisit(h, 'c');
		expect(h).toEqual({ entries: ['a', 'b', 'c'], index: 2 });
	});

	test('keeps the newest 50', () => {
		let h = emptyHistory();
		for (let i = 0; i < MAX_HISTORY + 5; i++) h = recordVisit(h, `w${i}`);
		expect(h.entries).toHaveLength(MAX_HISTORY);
		expect(h.entries[0]).toBe('w5');
		expect(h.index).toBe(MAX_HISTORY - 1);
	});

	test('back and forward skip worktrees that are gone', () => {
		const h = { entries: ['a', 'gone', 'b', 'c'], index: 2 };
		const live = (k: string) => k !== 'gone';
		expect(stepIndex(h, true, live)).toBe(0);
		expect(stepIndex(h, false, live)).toBe(3);
		expect(stepIndex({ entries: ['a'], index: 0 }, true, live)).toBeNull();
		expect(stepIndex({ entries: ['a', 'gone'], index: 0 }, false, live)).toBeNull();
	});
});
