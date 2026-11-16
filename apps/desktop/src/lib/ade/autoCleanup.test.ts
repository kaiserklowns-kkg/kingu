import { describe, expect, test } from 'bun:test';
import { ACTIVITY_LIMIT, AUTO_CHECK_MS, autoRunDue, withActivity, type AutoState, type CleanupActivity } from './autoCleanup';

const base: AutoState = { enabled: true, rulesOn: true, hasFolder: true, busy: false, lastRunAt: null, now: 1_000_000 };
const act = (over: Partial<CleanupActivity> = {}): CleanupActivity => ({ at: 1, source: 'auto', removed: ['a'], failed: [], kept: 0, ...over });

describe('automatic workspace cleanup schedule', () => {
	test('runs only when switched on, a rule is on, a folder is open and nothing else is going', () => {
		expect(autoRunDue(base)).toBe(true);
		for (const off of [{ enabled: false }, { rulesOn: false }, { hasFolder: false }, { busy: true }]) expect([off, autoRunDue({ ...base, ...off })]).toEqual([off, false]);
	});

	test('waits a full interval after the last run', () => {
		expect(autoRunDue({ ...base, lastRunAt: base.now - AUTO_CHECK_MS + 1 })).toBe(false);
		expect(autoRunDue({ ...base, lastRunAt: base.now - AUTO_CHECK_MS })).toBe(true);
	});

	test('the activity list is newest first and bounded', () => {
		let list: CleanupActivity[] = [];
		for (let i = 0; i < ACTIVITY_LIMIT + 5; i++) list = withActivity(list, act({ at: i }));
		expect(list.length).toBe(ACTIVITY_LIMIT);
		expect(list[0].at).toBe(ACTIVITY_LIMIT + 4);
	});

	test('an automatic run that did nothing leaves no row, but an asked-for one does', () => {
		expect(withActivity([], act({ removed: [] }))).toEqual([]);
		expect(withActivity([], act({ removed: [], source: 'cli' })).length).toBe(1);
		expect(withActivity([], act({ removed: [], failed: [{ slug: 'x', error: 'e' }] })).length).toBe(1);
	});
});
