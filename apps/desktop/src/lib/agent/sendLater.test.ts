import { describe, expect, test } from 'bun:test';
import { absoluteLater, chatScheduled, dueMessages, laterPresets, parseLaterCommand, parseLaterTime, parseLocalDateTime, parseScheduled, relativeLater, toLocalDateTime, tomorrowMorning, type ScheduledMessage } from './sendLater.ts';

const MIN = 60_000;
// Tuesday 2026-11-24 15:10 local time.
const NOW = new Date(2026, 10, 24, 15, 10, 0, 0);

const item = (over: Partial<ScheduledMessage> = {}): ScheduledMessage => ({
	id: 'a',
	root: '/r',
	chatId: 'c1',
	label: 'check the build',
	message: { text: 'check the build', images: [] },
	runAt: NOW.getTime() + 10 * MIN,
	createdAt: NOW.getTime(),
	...over
});

describe('Send Later', () => {
	test("the picker's choices, VS Code's order, Tomorrow Morning at 9:00", () => {
		const p = laterPresets(NOW);
		expect(p.map((x) => x.id)).toEqual(['m5', 'm10', 'm15', 'm30', 'h1', 'h24', 'tomorrow']);
		expect(p[0].at - NOW.getTime()).toBe(5 * MIN);
		expect(p[5].at - NOW.getTime()).toBe(24 * 60 * MIN);
		const t = new Date(tomorrowMorning(NOW));
		expect([t.getDate(), t.getHours(), t.getMinutes()]).toEqual([25, 9, 0]);
	});

	test('a datetime-local value as local time; invalid ones refused (parseScheduledChatTime)', () => {
		expect(parseLocalDateTime('2026-11-24T16:05')?.getTime()).toBe(new Date(2026, 10, 24, 16, 5).getTime());
		expect(parseLocalDateTime('2026-02-30T10:00')).toBeUndefined();
		expect(parseLocalDateTime('2026-11-24T25:00')).toBeUndefined();
		expect(parseLocalDateTime('tomorrow')).toBeUndefined();
		expect(toLocalDateTime(new Date(2026, 0, 5, 7, 3).getTime())).toBe('2026-01-05T07:03');
	});

	test('relative labels: due, under a minute, whole minutes / hours / days', () => {
		const now = NOW.getTime();
		expect(relativeLater(now - 1, now)).toEqual({ kind: 'due' });
		expect(relativeLater(now + 30_000, now)).toEqual({ kind: 'soon' });
		expect(relativeLater(now + 10 * MIN + 5, now)).toEqual({ kind: 'minutes', n: 10 });
		expect(relativeLater(now + 150 * MIN, now)).toEqual({ kind: 'hours', n: 2 });
		expect(relativeLater(now + 50 * 60 * MIN, now)).toEqual({ kind: 'days', n: 2 });
	});

	test('exact labels: today, tomorrow, a weekday this week, else the date', () => {
		const now = NOW.getTime();
		expect(absoluteLater(now + 30 * MIN, now, 'en-US').kind).toBe('today');
		expect(absoluteLater(tomorrowMorning(NOW), now, 'en-US')).toMatchObject({ kind: 'tomorrow', clock: '9:00 AM' });
		expect(absoluteLater(new Date(2026, 10, 27, 10, 0).getTime(), now, 'en-US')).toMatchObject({ kind: 'weekday', day: 'Fri' });
		expect(absoluteLater(new Date(2026, 11, 24, 10, 0).getTime(), now, 'en-US')).toMatchObject({ kind: 'date', day: 'Dec 24' });
		expect(absoluteLater(new Date(2027, 0, 9, 10, 0).getTime(), now, 'en-US')).toMatchObject({ kind: 'date', day: 'Jan 9, 2027' });
	});

	test('the stored list keeps well-formed entries; long past due ones are dropped', () => {
		const good = item();
		const stale = item({ id: 'old', runAt: NOW.getTime() - 31 * 24 * 60 * MIN });
		const raw = JSON.stringify([good, stale, { id: 'x' }, item({ id: 'blank', message: { text: '  ', images: [] } }), item({ id: 'img', message: { text: 'a', images: [3] as unknown as string[] } })]);
		expect(parseScheduled(raw, NOW.getTime()).map((s) => s.id)).toEqual(['a']);
		expect(parseScheduled('nope', 0)).toEqual([]);
		expect(parseScheduled('{"a":1}', 0)).toEqual([]);
		expect(parseScheduled(null, 0)).toEqual([]);
	});

	test('due ones of the open folder, oldest first; one that failed waits for Send Now', () => {
		const now = NOW.getTime();
		const list = [item({ id: 'b', runAt: now - MIN }), item({ id: 'a', runAt: now - 2 * MIN }), item({ id: 'later' }), item({ id: 'other', root: '/x', runAt: now - MIN }), item({ id: 'failed', runAt: now - MIN, failed: true })];
		expect(dueMessages(list, '/r', now).map((s) => s.id)).toEqual(['a', 'b']);
		expect(dueMessages(list, null, now)).toEqual([]);
		expect(chatScheduled(list, '/r', 'c1').map((s) => s.id)).toEqual(['a', 'b', 'failed', 'later']);
		expect(chatScheduled(list, '/r', 'c2')).toEqual([]);
	});
});

describe('/later (Kingu-only)', () => {
	test('spans from now', () => {
		const now = NOW.getTime();
		expect(parseLaterTime('10m', NOW)).toBe(now + 10 * MIN);
		expect(parseLaterTime('90 min', NOW)).toBe(now + 90 * MIN);
		expect(parseLaterTime('2h', NOW)).toBe(now + 120 * MIN);
		expect(parseLaterTime('1h30m', NOW)).toBe(now + 90 * MIN);
		expect(parseLaterTime('1h 30m', NOW)).toBe(now + 90 * MIN);
		expect(parseLaterTime('1d', NOW)).toBe(now + 1440 * MIN);
		expect(parseLaterTime('0m', NOW)).toBeNull();
		expect(parseLaterTime('10', NOW)).toBeNull();
		expect(parseLaterTime('soon', NOW)).toBeNull();
	});

	test('clock times: today, or tomorrow once passed; tomorrow alone is 9:00', () => {
		expect(parseLaterTime('16:00', NOW)).toBe(new Date(2026, 10, 24, 16, 0).getTime());
		expect(parseLaterTime('2:30pm', NOW)).toBe(new Date(2026, 10, 25, 14, 30).getTime());
		expect(parseLaterTime('9am', NOW)).toBe(new Date(2026, 10, 25, 9, 0).getTime());
		expect(parseLaterTime('tomorrow', NOW)).toBe(tomorrowMorning(NOW));
		expect(parseLaterTime('tomorrow 14:00', NOW)).toBe(new Date(2026, 10, 25, 14, 0).getTime());
		expect(parseLaterTime('24:00', NOW)).toBeNull();
		expect(parseLaterTime('13pm', NOW)).toBeNull();
		expect(parseLaterTime('9:75', NOW)).toBeNull();
	});

	test('the command: the longest leading time, then the message', () => {
		expect(parseLaterCommand('/later 10m check the build', NOW)).toEqual({ at: NOW.getTime() + 10 * MIN, message: 'check the build' });
		expect(parseLaterCommand('/later 1h 30m run the tests\nand report', NOW)).toEqual({ at: NOW.getTime() + 90 * MIN, message: 'run the tests\nand report' });
		expect(parseLaterCommand('/later tomorrow 9am deploy', NOW)).toEqual({ at: new Date(2026, 10, 25, 9, 0).getTime(), message: 'deploy' });
		expect(parseLaterCommand('/later tomorrow deploy', NOW)).toEqual({ at: tomorrowMorning(NOW), message: 'deploy' });
		expect(parseLaterCommand('/later 10m', NOW)).toEqual({ error: 'message' });
		expect(parseLaterCommand('/later whenever do it', NOW)).toEqual({ error: 'time' });
		expect(parseLaterCommand('/later', NOW)).toEqual({ error: 'time' });
		expect(parseLaterCommand('/latest 10m x', NOW)).toBeNull();
		expect(parseLaterCommand('please /later 10m x', NOW)).toBeNull();
	});
});
