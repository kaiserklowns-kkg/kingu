import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { latestDue, nextRun, nextRuns, parseSchedule, upcoming, type Schedule } from './schedule.ts';

// A zone with DST, so the transitions are exercised (2026: Mar 8 02:00 → 03:00, Nov 1 02:00 → 01:00).
const savedTz = process.env.TZ;
beforeAll(() => {
	process.env.TZ = 'America/New_York';
});
afterAll(() => {
	if (savedTz === undefined) delete process.env.TZ;
	else process.env.TZ = savedTz;
});

const p = (n: number) => String(n).padStart(2, '0');
/** Local wall-clock rendering with the UTC offset, e.g. `2026-03-08 03:30 -04`. */
function local(d: Date | null): string | null {
	if (!d) return null;
	const off = -d.getTimezoneOffset() / 60;
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${off < 0 ? '-' : '+'}${p(Math.abs(off))}`;
}
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const next = (s: string, after: Date) => local(nextRun(s, after));
const runs = (s: string, after: Date, n: number) => nextRuns(s, after, n).map(local);
function parsed(s: string): Schedule {
	const r = parseSchedule(s);
	if (!r.ok) throw new Error(r.error);
	return r.schedule;
}
const error = (s: string) => {
	const r = parseSchedule(s);
	return r.ok ? null : r.error;
};

describe('parseSchedule', () => {
	test('accepts the readable forms and cron', () => {
		for (const s of ['daily 09:00', 'DAILY 9:05', 'weekdays 18:30', 'weekly mon,thu 09:00', 'weekly sun 00:00', 'every 15m', 'every 2h', 'every 168h', '0 9 * * 1-5', '*/15 * * * *', '0,30 8-17 * * mon-fri', '0 0 1 jan,jul *', '0 12 * * 7', '5/20 * * * *'])
			expect(error(s)).toBeNull();
	});

	test('normalizes cron fields', () => {
		expect(parsed('0,30 8-10/2 * * mon-fri')).toMatchObject({ minute: [0, 30], hour: [8, 10], dow: [1, 2, 3, 4, 5], either: false });
		expect(parsed('0 12 * * 0,7')).toMatchObject({ dow: [0] });
		expect(parsed('5/20 * * * *')).toMatchObject({ minute: [5, 25, 45] });
		expect(parsed('0 0 1,15 * fri')).toMatchObject({ either: true });
		expect(parsed('0 0 */2 * fri')).toMatchObject({ either: false });
		expect(parsed('weekly thu,mon,thu 09:00')).toMatchObject({ dow: [1, 4], hour: [9], minute: [0] });
		expect(parsed('every 90m')).toEqual({ kind: 'every', ms: 90 * 60_000 });
	});

	test('explains mistakes in Thai', () => {
		expect(error('')).toContain('ยังไม่ได้ใส่ตารางเวลา');
		expect(error('daily')).toContain('ต้องตามด้วยเวลา');
		expect(error('daily 24:00')).toContain('ไม่มีจริง');
		expect(error('daily 9am')).toContain('HH:MM');
		expect(error('weekly funday 09:00')).toContain('ไม่รู้จักวัน');
		expect(error('weekly 09:00')).toContain('weekly mon,thu 09:00');
		expect(error('every 10m')).toContain('15 นาที');
		expect(error('every 169h')).toContain('7 วัน');
		expect(error('every 2d')).toContain('every 30m');
		expect(error('* * * * *')).toContain('15 นาที');
		expect(error('*/10 9 * * *')).toContain('15 นาที');
		expect(error('0,50 9-10 * * *')).toContain('15 นาที');
		expect(error('60 * * * *')).toContain('นอกช่วง');
		expect(error('0 0 0 * *')).toContain('นอกช่วง');
		expect(error('0 0 * 13 *')).toContain('นอกช่วง');
		expect(error('0 0 * * 8')).toContain('นอกช่วง');
		expect(error('0 0 5-1 * *')).toContain('น้อยไปมาก');
		expect(error('0/0 * * * *')).toContain('จำนวนเต็มบวก');
		expect(error('0 0 31 2 *')).toContain('ไม่มีวันที่ตรง');
		expect(error('0 9 * *')).toContain('ไม่รู้จักตารางเวลา');
		expect(error('hourly')).toContain('ไม่รู้จักตารางเวลา');
		expect(error('0,,5 * * * *')).toContain('จุลภาค');
	});

	test('a gap of 50 minutes inside one hour is fine when the hours are not adjacent', () => {
		expect(error('0,50 9 * * *')).toBeNull();
		expect(error('0,50 9,11 * * *')).toBeNull();
	});
});

describe('nextRun', () => {
	test('daily, weekdays, weekly', () => {
		expect(next('daily 09:00', at(2026, 10, 18, 8, 59))).toBe('2026-10-18 09:00 -04');
		expect(next('daily 09:00', at(2026, 10, 18, 9, 0))).toBe('2026-10-19 09:00 -04');
		// 2026-10-17 is a Saturday.
		expect(next('weekdays 09:00', at(2026, 10, 17, 10))).toBe('2026-10-19 09:00 -04');
		expect(next('weekdays 09:00', at(2026, 10, 23, 9, 30))).toBe('2026-10-26 09:00 -04');
		expect(runs('weekly mon,thu 18:00', at(2026, 10, 18), 3)).toEqual(['2026-10-19 18:00 -04', '2026-10-22 18:00 -04', '2026-10-26 18:00 -04']);
	});

	test('every counts from the given time', () => {
		expect(nextRun('every 15m', new Date(1_000))?.getTime()).toBe(1_000 + 15 * 60_000);
	});

	test('cron steps, lists and ranges', () => {
		expect(runs('*/15 * * * *', at(2026, 10, 18, 9, 7), 3)).toEqual(['2026-10-18 09:15 -04', '2026-10-18 09:30 -04', '2026-10-18 09:45 -04']);
		expect(runs('0 8-17/3 * * *', at(2026, 10, 18, 12), 3)).toEqual(['2026-10-18 14:00 -04', '2026-10-18 17:00 -04', '2026-10-19 08:00 -04']);
		expect(runs('30 9 * * mon-fri', at(2026, 10, 16, 10), 2)).toEqual(['2026-10-19 09:30 -04', '2026-10-20 09:30 -04']);
	});

	test('month ends', () => {
		expect(runs('0 0 31 * *', at(2026, 1, 31, 1), 3)).toEqual(['2026-03-31 00:00 -04', '2026-05-31 00:00 -04', '2026-07-31 00:00 -04']);
		expect(next('0 12 30 * *', at(2026, 1, 30, 13))).toBe('2026-03-30 12:00 -04');
		expect(next('0 0 1 * *', at(2026, 12, 31, 23, 59))).toBe('2027-01-01 00:00 -05');
	});

	test('Feb 29 waits for a leap year (and skips 2100)', () => {
		expect(next('0 9 29 2 *', at(2026, 3, 1))).toBe('2028-02-29 09:00 -05');
		expect(next('0 9 29 2 *', at(2096, 3, 1))).toBe('2104-02-29 09:00 -05');
	});

	test('dom and dow both restricted match either (vixie cron)', () => {
		// The 13th, or any Friday: 2026-10-16 is a Friday.
		expect(runs('0 0 13 * fri', at(2026, 10, 10), 3)).toEqual(['2026-10-13 00:00 -04', '2026-10-16 00:00 -04', '2026-10-23 00:00 -04']);
		// A `*` step in dom: both must match (Fridays on odd days).
		expect(runs('0 0 */2 * fri', at(2026, 10, 1), 2)).toEqual(['2026-10-09 00:00 -04', '2026-10-23 00:00 -04']);
	});

	test('a time skipped by the spring DST jump runs at the shifted time, once', () => {
		expect(next('daily 02:30', at(2026, 3, 7, 3))).toBe('2026-03-08 03:30 -04');
		expect(next('daily 02:30', at(2026, 3, 8, 3, 30))).toBe('2026-03-09 02:30 -04');
		// 02:30 (shifted to 03:30) and 03:00 that day: in time order, no duplicate.
		expect(runs('0,30 2-3 * * *', at(2026, 3, 8, 1), 3)).toEqual(['2026-03-08 03:00 -04', '2026-03-08 03:30 -04', '2026-03-09 02:00 -04']);
	});

	test('a time repeated when clocks fall back runs once', () => {
		expect(runs('daily 01:30', at(2026, 10, 31, 12), 2)).toEqual(['2026-11-01 01:30 -04', '2026-11-02 01:30 -05']);
		// Asked during the repeated hour (EST), the EDT run is already past.
		const second = new Date(at(2026, 11, 1, 1, 30).getTime() + 3_600_000);
		expect(local(second)).toBe('2026-11-01 01:30 -05');
		expect(next('daily 01:30', second)).toBe('2026-11-02 01:30 -05');
		// Hourly runs: wall-clock hours, the repeated one once.
		expect(runs('0 * * * *', at(2026, 11, 1, 0, 30), 3)).toEqual(['2026-11-01 01:00 -04', '2026-11-01 02:00 -05', '2026-11-01 03:00 -05']);
	});

	test('every is real elapsed time across DST', () => {
		const t = at(2026, 3, 8, 1, 30).getTime();
		expect(local(nextRun('every 1h', new Date(t)))).toBe('2026-03-08 03:30 -04');
	});

	test('bad schedules have no next run', () => {
		expect(nextRun('nonsense', new Date())).toBeNull();
		expect(nextRuns('nonsense', new Date(), 3)).toEqual([]);
	});
});

describe('latestDue', () => {
	test('the latest due time only, never every missed one', () => {
		const from = at(2026, 10, 10, 12).getTime();
		const now = at(2026, 10, 18, 10).getTime();
		expect(latestDue('daily 09:00', from, now)).toBe(at(2026, 10, 18, 9).getTime());
		expect(latestDue('daily 09:00', from, at(2026, 10, 18, 8).getTime())).toBe(at(2026, 10, 17, 9).getTime());
		expect(latestDue('daily 09:00', at(2026, 10, 18, 9).getTime(), now)).toBeNull();
	});

	test('includes now, excludes from', () => {
		const nine = at(2026, 10, 18, 9).getTime();
		expect(latestDue('daily 09:00', nine - 1, nine)).toBe(nine);
		expect(latestDue('daily 09:00', nine, nine + 60_000)).toBeNull();
	});

	test('sparse schedules look back far enough', () => {
		expect(latestDue('0 9 29 2 *', at(2020, 1, 1).getTime(), at(2026, 10, 18).getTime())).toBe(at(2024, 2, 29, 9).getTime());
		expect(latestDue('0 0 1 1 *', at(2025, 6, 1).getTime(), at(2026, 10, 18).getTime())).toBe(at(2026, 1, 1).getTime());
		expect(latestDue('0 0 1 1 *', at(2026, 6, 1).getTime(), at(2026, 10, 18).getTime())).toBeNull();
	});

	test('every keeps its cadence from the anchor', () => {
		const m = 60_000;
		expect(latestDue('every 15m', 0, 14 * m)).toBeNull();
		expect(latestDue('every 15m', 0, 15 * m)).toBe(15 * m);
		expect(latestDue('every 15m', 0, 100 * m)).toBe(90 * m);
		expect(upcoming('every 15m', 0, 100 * m)).toBe(105 * m);
		expect(upcoming('every 15m', 0, 90 * m)).toBe(105 * m);
	});

	test('bad schedules are never due', () => {
		expect(latestDue('nonsense', 0, Date.now())).toBeNull();
	});
});
