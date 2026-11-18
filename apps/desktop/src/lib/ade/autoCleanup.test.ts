import { describe, expect, test } from 'bun:test';
import { ACTIVITY_LIMIT, AUTO_CHECK_MS, autoRunDue, nextAutoRunAt, normalizeActivity, parseStoredActivity, serializeActivity, withActivity, withActivityLock, activityKey, ACTIVITY_KEY, type AutoState, type CleanupActivity } from './autoCleanup';

const base: AutoState = { enabled: true, rulesOn: true, hasFolder: true, busy: false, lastRunAt: null, now: 1_000_000 };
const act = (over: Partial<CleanupActivity> = {}): CleanupActivity => ({ at: 1, source: 'auto', removed: ['a'], archived: [], failed: [], kept: 0, ...over });

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
		expect(withActivity([], act({ removed: [], archived: [] }))).toEqual([]);
		expect(withActivity([], act({ removed: [], archived: ['b'] })).length).toBe(1);
		expect(withActivity([], act({ removed: [], source: 'cli' })).length).toBe(1);
		expect(withActivity([], act({ removed: [], failed: [{ slug: 'x', error: 'e' }] })).length).toBe(1);
	});
});

describe('stored workspace cleanup activity', () => {
	const stored = (body: object) => JSON.stringify({ v: 1, ...body });

	test('round-trips activity and the last run', () => {
		const s = { activity: [act({ at: 5 }), act({ at: 3, source: 'cli', failed: [{ slug: 'x', error: 'e' }] })], lastRunAt: 7 };
		expect(parseStoredActivity(serializeActivity(s))).toEqual(s);
	});

	test('anything unreadable is empty, not an error', () => {
		const empty = { activity: [], lastRunAt: null };
		for (const raw of [null, '', '{nope', 'null', '[]', '42', JSON.stringify({ v: 2, activity: [act()], lastRunAt: 1 }), JSON.stringify({ activity: [act()] })]) expect([raw, parseStoredActivity(raw)]).toEqual([raw, empty]);
		expect(parseStoredActivity(stored({ activity: 'x', lastRunAt: -1 }))).toEqual(empty);
		expect(parseStoredActivity(stored({ lastRunAt: 'soon' }))).toEqual(empty);
	});

	test('one bad row is dropped and the rest are kept, newest first and bounded', () => {
		const rows = [act({ at: 1 }), null, 'x', { ...act(), at: -5 }, { ...act(), source: 'cron' }, act({ at: 9 }), ...Array.from({ length: ACTIVITY_LIMIT }, (_, i) => act({ at: 2 + i / 100 }))];
		const { activity } = parseStoredActivity(stored({ activity: rows, lastRunAt: 3 }));
		expect(activity.length).toBe(ACTIVITY_LIMIT);
		expect(activity[0].at).toBe(9);
		expect(activity.every((a, i) => i === 0 || activity[i - 1].at >= a.at)).toBe(true);
	});

	test('a row is repaired field by field', () => {
		expect(normalizeActivity({ at: 4, source: 'dialog', removed: ['a', 1, null], failed: [{ slug: 's', error: 'e', extra: 1 }, { slug: 2 }], kept: -3 })).toEqual({
			at: 4,
			source: 'dialog',
			removed: ['a'],
			archived: [],
			failed: [{ slug: 's', error: 'e' }],
			kept: 0
		});
		expect(normalizeActivity({ at: 4, source: 'auto' })).toEqual({ at: 4, source: 'auto', removed: [], archived: [], failed: [], kept: 0 });
		expect(normalizeActivity({ at: Number.NaN, source: 'auto' })).toBeNull();
	});

	test('a stored last run keeps a reopened window from running before the interval', () => {
		const now = 10 * AUTO_CHECK_MS;
		const { lastRunAt } = parseStoredActivity(serializeActivity({ activity: [], lastRunAt: now - AUTO_CHECK_MS / 2 }));
		expect(autoRunDue({ ...base, now, lastRunAt })).toBe(false);
		expect(autoRunDue({ ...base, now: now + AUTO_CHECK_MS / 2, lastRunAt })).toBe(true);
	});
});

describe('withActivityLock', () => {
	test('runs under the Activity lock when Web Locks exist', async () => {
		const names: string[] = [];
		const locks = { request: <T>(name: string, cb: () => T) => (names.push(name), Promise.resolve(cb())) };
		expect(await withActivityLock(() => 7, ACTIVITY_KEY, locks)).toBe(7);
		expect(names).toEqual([ACTIVITY_KEY]);
	});

	test('runs the work directly without the API, and a throw rejects', async () => {
		expect(await withActivityLock(() => 'ok', ACTIVITY_KEY, undefined)).toBe('ok');
		await expect(withActivityLock(() => { throw new Error('x'); }, ACTIVITY_KEY, undefined)).rejects.toThrow('x');
	});
});

describe('activityKey', () => {
	test('is one key per folder, and the old key when there is none', () => {
		expect(activityKey(null)).toBe(ACTIVITY_KEY);
		expect(activityKey('/a')).not.toBe(activityKey('/b'));
		expect(activityKey('/a')).toBe(activityKey('/a'));
	});

	test('locks per folder', async () => {
		const names: string[] = [];
		const locks = { request: <T>(name: string, cb: () => T) => (names.push(name), Promise.resolve(cb())) };
		await withActivityLock(() => 0, activityKey('/a'), locks);
		expect(names).toEqual([activityKey('/a')]);
	});
});

describe('nextAutoRunAt', () => {
	test('is an hour after the last run, and never a time in the past', () => {
		const now = 10 * AUTO_CHECK_MS;
		expect(nextAutoRunAt(true, now - 1000, now)).toBe(now - 1000 + AUTO_CHECK_MS);
		expect(nextAutoRunAt(true, now - AUTO_CHECK_MS, now)).toBeNull();
		expect(nextAutoRunAt(true, now - 5 * AUTO_CHECK_MS, now)).toBeNull();
		expect(nextAutoRunAt(true, null, now)).toBeNull();
		expect(nextAutoRunAt(false, now - 1000, now)).toBeNull();
	});
});
