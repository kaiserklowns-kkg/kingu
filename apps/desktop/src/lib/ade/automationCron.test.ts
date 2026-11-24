import { describe, expect, test } from 'bun:test';
import { cronError, describeAutomationCron, nextAutomationCronOccurrence, nextCronOccurrences, presetExpression, presetFields, splitCron } from './automationCron.ts';
import { setLocale } from '#lib/i18n/index.ts';

const iso = (d: Date) => d.toISOString();
const utc = (s: string) => new Date(s);

describe('cron grammar (VS Code automationCron.ts)', () => {
	test('accepts the documented forms', () => {
		for (const e of ['0 9,17 * * MON-FRI', '0 9 1 * *', '*/30 * * * *', '0-59/15 * * * *', '0 12 * * 7', '0 0 1 jan,JUL *', '* * * * *', '0 9 1 * MON'])
			expect([e, cronError(e, 'UTC')]).toEqual([e, null]);
	});

	test('refuses what VS Code refuses, with its messages', () => {
		setLocale('en');
		expect(cronError('0 9 * *', 'UTC')).toBe('Automation schedule must contain exactly five fields: minute, hour, day of month, month, day of week.');
		expect(cronError('0 0 9 * * *', 'UTC')).toContain('exactly five fields');
		expect(cronError('@daily', 'UTC')).toContain('exactly five fields');
		// Steps from a single value are not supported (Kingu's own text schedules allowed `5/15`).
		expect(cronError('5/15 * * * *', 'UTC')).toBe("Minute steps require '*' or a range such as 0-59.");
		expect(cronError('60 * * * *', 'UTC')).toBe('Minute value is outside 0-59.');
		expect(cronError('0 17-9 * * *', 'UTC')).toBe('Hour ranges must be ascending.');
		expect(cronError('0 9 ,1 * *', 'UTC')).toBe('Day of month contains an empty list item.');
		expect(cronError('*/0 * * * *', 'UTC')).toBe('Minute step must be a positive integer.');
		expect(cronError('0 9 30 2 *', 'UTC')).toBe('Automation schedule cannot match a real calendar date.');
		expect(cronError('0 9 * * *', 'Not/AZone')).toBe('Automation schedule uses an invalid time zone.');
		// Empty is incomplete, not wrong: the form keeps Create unavailable without an error.
		expect(cronError('   ', 'UTC')).toBeNull();
	});

	test('errors follow the UI language', () => {
		setLocale('th');
		expect(cronError('60 * * * *', 'UTC')).toBe('ค่าในช่องนาทีอยู่นอกช่วง 0-59');
		setLocale('en');
	});
});

describe('next occurrence', () => {
	test('in the saved time zone, not the machine one', () => {
		// 09:00 in Bangkok (UTC+7) is 02:00 UTC.
		expect(iso(nextAutomationCronOccurrence('0 9 * * *', 'Asia/Bangkok', utc('2026-11-24T00:00:00Z')))).toBe('2026-11-24T02:00:00.000Z');
		expect(iso(nextAutomationCronOccurrence('0 9 * * *', 'UTC', utc('2026-11-24T00:00:00Z')))).toBe('2026-11-24T09:00:00.000Z');
	});

	test('strictly after, to the minute', () => {
		expect(iso(nextAutomationCronOccurrence('*/30 * * * *', 'UTC', utc('2026-11-24T10:30:00Z')))).toBe('2026-11-24T11:00:00.000Z');
		expect(iso(nextAutomationCronOccurrence('*/30 * * * *', 'UTC', utc('2026-11-24T10:29:59Z')))).toBe('2026-11-24T10:30:00.000Z');
	});

	test('weekdays only, and both day fields restricted means either', () => {
		// 2026-11-28 is a Saturday: the next weekday 09:00 is Monday the 30th.
		expect(iso(nextAutomationCronOccurrence('0 9,17 * * MON-FRI', 'UTC', utc('2026-11-27T17:00:00Z')))).toBe('2026-11-30T09:00:00.000Z');
		// `0 9 1 * MON`: the 1st of a month or any Monday. After Tue 2026-12-01 09:00 comes Mon the 7th.
		expect(iso(nextAutomationCronOccurrence('0 9 1 * MON', 'UTC', utc('2026-12-01T09:00:00Z')))).toBe('2026-12-07T09:00:00.000Z');
		expect(iso(nextAutomationCronOccurrence('0 9 1 * MON', 'UTC', utc('2026-11-27T00:00:00Z')))).toBe('2026-11-30T09:00:00.000Z');
	});

	test('a time skipped by daylight saving runs on the next day it exists', () => {
		// New York springs forward on 2026-03-08 at 02:00: 02:30 does not exist that day.
		expect(iso(nextAutomationCronOccurrence('30 2 * * *', 'America/New_York', utc('2026-03-08T05:00:00Z')))).toBe('2026-03-09T06:30:00.000Z');
	});

	test('a rare date (Feb 29) is found years ahead', () => {
		expect(iso(nextAutomationCronOccurrence('0 0 29 2 *', 'UTC', utc('2026-03-01T00:00:00Z')))).toBe('2028-02-29T00:00:00.000Z');
	});

	test('preview of the next runs', () => {
		expect(nextCronOccurrences('0 9 * * *', 'UTC', Date.parse('2026-11-24T10:00:00Z'), 3).map((t) => new Date(t).toISOString())).toEqual([
			'2026-11-25T09:00:00.000Z',
			'2026-11-26T09:00:00.000Z',
			'2026-11-27T09:00:00.000Z'
		]);
		expect(nextCronOccurrences('bad', 'UTC', 0, 3)).toEqual([]);
	});
});

describe('description (VS Code describeAutomationCron)', () => {
	test('reads like VS Code', () => {
		setLocale('en');
		const d = (e: string) => describeAutomationCron(e, 'en-US');
		expect(d('0 9,17 * * MON-FRI')).toBe('Runs at 9:00 AM and 5:00 PM on Monday through Friday.');
		expect(d('0 9 1 * *')).toBe('Runs at 9:00 AM on day 1 of the month.');
		expect(d('*/30 * * * *')).toBe('Runs every 30 minutes every day.');
		expect(d('* * * * *')).toBe('Runs every minute every day.');
		expect(d('15 * * * *')).toBe('Runs at minute 15 of every hour every day.');
		expect(d('0 */6 * * *')).toBe('Runs every 6 hours every day.');
		expect(d('0 9 1 * MON')).toBe('Runs at 9:00 AM on day 1 of the month and also on Monday.');
		expect(d('0 9 * 1,7 *')).toBe('In January and July, runs at 9:00 AM every day.');
	});
});

describe('presets (VS Code scheduleTrigger)', () => {
	test('become cron expressions and read back', () => {
		expect(presetExpression('hourly', { hour: 0, minute: 7, day: 0 })).toBe('7 * * * *');
		expect(presetExpression('daily', { hour: 9, minute: 30, day: 0 })).toBe('30 9 * * *');
		expect(presetExpression('weekdays', { hour: 18, minute: 0, day: 0 })).toBe('0 18 * * 1-5');
		expect(presetExpression('weekly', { hour: 8, minute: 5, day: 4 })).toBe('5 8 * * 4');
		expect(presetExpression('manual', { hour: 0, minute: 0, day: 0 })).toBeNull();
		expect(presetFields('5 8 * * 4')).toEqual({ minute: 5, hour: 8, day: 4 });
		expect(presetFields('7 * * * *')).toEqual({ minute: 7, hour: 0, day: 0 });
		expect(presetFields('5 8 * * SUN')).toEqual({ minute: 5, hour: 8, day: 0 });
	});

	test('a pasted expression splits into the five inputs', () => {
		expect(splitCron('  0 9,17 *  * MON-FRI ')).toEqual(['0', '9,17', '*', '*', 'MON-FRI']);
		expect(splitCron('0 9 * *')).toBeNull();
	});
});
