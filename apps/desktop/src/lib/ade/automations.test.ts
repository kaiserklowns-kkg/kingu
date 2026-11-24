import { describe, expect, test } from 'bun:test';
import { CATCH_UP_MS, consentKey, decide, isScheduled, MISSED_GRACE_MS, newAutomation, nextRunOf, runTitle, scheduleLabel, type Automation } from './automations.ts';
import { setLocale } from '#lib/i18n/index.ts';

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const NINE = at(2026, 10, 18, 9);
const idle = () => false;

function auto(patch: Partial<Automation> = {}): Automation {
	return { ...newAutomation({ id: 'a', name: 'รีวิว deps', prompt: 'ตรวจ dependency', schedule: 'daily 09:00' }, at(2026, 10, 1)), enabled: true, enabled_at: at(2026, 10, 1), ...patch };
}

describe('decide', () => {
	test('runs when due, on time', () => {
		expect(decide([auto()], NINE + 30_000, {}, idle)).toEqual([{ id: 'a', due: NINE, action: 'run' }]);
	});

	test('nothing before the time, or once handled', () => {
		expect(decide([auto({ last_due_at: at(2026, 10, 17, 9) })], NINE - 60_000, {}, idle)).toEqual([]);
		expect(decide([auto({ last_due_at: NINE })], NINE + 60_000, {}, idle)).toEqual([]);
		// Handled in this session but not saved yet.
		expect(decide([auto({ last_due_at: at(2026, 10, 17, 9) })], NINE + 60_000, { a: NINE }, idle)).toEqual([]);
	});

	test('new automations are off, and disabled ones never run', () => {
		expect(newAutomation({ id: 'x', name: 'x', prompt: 'p', schedule: 'daily 09:00' }, 0).enabled).toBe(false);
		expect(decide([auto({ enabled: false })], NINE + 1, {}, idle)).toEqual([]);
	});

	test('the global switch stops everything', () => {
		expect(decide([auto()], NINE + 1, {}, idle, false)).toEqual([]);
	});

	test('enabling never starts a backlog: due times before enabled_at do not run', () => {
		expect(decide([auto({ enabled_at: NINE + 60_000 })], NINE + 120_000, {}, idle)).toEqual([]);
		expect(decide([auto({ enabled_at: NINE - 60_000 })], NINE + 120_000, {}, idle)).toHaveLength(1);
	});

	test('catch-up: closed for a week runs once, for the latest due time', () => {
		const a = auto({ last_due_at: at(2026, 10, 10, 9) });
		const now = at(2026, 10, 18, 14);
		expect(decide([a], now, {}, idle)).toEqual([{ id: 'a', due: NINE, action: 'run' }]);
		// After recording it, nothing more until tomorrow.
		expect(decide([{ ...a, last_due_at: NINE }], now + 60_000, {}, idle)).toEqual([]);
		expect(decide([{ ...a, last_due_at: NINE }], at(2026, 10, 19, 9), {}, idle)).toEqual([{ id: 'a', due: at(2026, 10, 19, 9), action: 'run' }]);
	});

	test('without catch-up a missed run is skipped (and recorded), an on-time one still runs', () => {
		const a = auto({ catch_up: false, last_due_at: at(2026, 10, 17, 9) });
		const [late] = decide([a], NINE + MISSED_GRACE_MS + 1, {}, idle);
		expect(late).toMatchObject({ id: 'a', due: NINE, action: 'skip' });
		expect(late.action === 'skip' && late.reason).toContain('catch-up');
		expect(decide([a], NINE + MISSED_GRACE_MS, {}, idle)).toEqual([{ id: 'a', due: NINE, action: 'run' }]);
	});

	test('skips while the previous run still works', () => {
		const a = auto({ last_task_slug: 'deps-1', last_due_at: at(2026, 10, 17, 9) });
		const [d] = decide([a], NINE + 1, {}, (slug) => slug === 'deps-1');
		expect(d).toMatchObject({ id: 'a', due: NINE, action: 'skip' });
		expect(d.action === 'skip' && d.reason).toContain('kingu/deps-1');
		expect(decide([a], NINE + 1, {}, (slug) => slug === 'other')).toEqual([{ id: 'a', due: NINE, action: 'run' }]);
	});

	test('bad schedules decide nothing', () => {
		expect(decide([auto({ schedule: 'sometimes' })], NINE + 1, {}, idle)).toEqual([]);
	});

	test('each automation independently', () => {
		const list = [auto(), auto({ id: 'b', schedule: 'every 1h' }), auto({ id: 'c', enabled: false })];
		const ids = decide(list, NINE + 1, {}, idle).map((d) => d.id);
		expect(ids).toEqual(['a', 'b']);
	});

	test('every: due by its own cadence from the last handled time', () => {
		const a = auto({ schedule: 'every 2h', last_due_at: NINE });
		expect(decide([a], NINE + 2 * 3_600_000 - 1, {}, idle)).toEqual([]);
		expect(decide([a], NINE + 5 * 3_600_000, {}, idle)).toEqual([{ id: 'a', due: NINE + 4 * 3_600_000, action: 'run' }]);
	});
});

describe('helpers', () => {
	test('next run follows the schedule, none while off', () => {
		expect(nextRunOf(auto(), NINE + 1)).toBe(at(2026, 10, 19, 9));
		expect(nextRunOf(auto({ enabled: false }), NINE + 1)).toBeNull();
		expect(nextRunOf(auto({ schedule: 'every 2h', last_due_at: NINE }), NINE + 1)).toBe(NINE + 2 * 3_600_000);
	});

	test('run titles carry the local date and time', () => {
		expect(runTitle('deps review', new Date(2026, 0, 5, 7, 3))).toBe('deps review 2026-01-05 07:03');
	});

	test('consent covers what would run', () => {
		const a = auto();
		const renamed: Automation = { ...a, name: 'renamed', last_run_at: 5 };
		expect(consentKey('/r', a)).toBe(consentKey('/r', renamed));
		expect(consentKey('/r', a)).not.toBe(consentKey('/r', { ...a, prompt: 'rm -rf' }));
		expect(consentKey('/r', a)).not.toBe(consentKey('/other', a));
		expect(consentKey('/r', a)).not.toBe(consentKey('/r', { ...a, schedule: 'every 15m' }));
	});
});

// VS Code 1.145 triggers: a five-field expression in a saved zone (automationCron.ts), with VS
// Code's catch-up rule (agentHostAutomationService.ts `_claimDueRuns`).
describe('VS Code triggers', () => {
	const Z = (iso: string) => Date.parse(iso);
	const created = Z('2026-11-01T00:00:00Z');
	function cron(patch: Partial<Automation> = {}): Automation {
		return {
			...newAutomation({ id: 'c', name: 'สรุป commit', prompt: 'สรุป commit วันนี้', schedule: '0 9,17 * * MON-FRI', trigger: 'cron', time_zone: 'UTC' }, created),
			enabled: true,
			enabled_at: created,
			...patch
		};
	}
	// Tue 2026-11-24.
	const NINE_UTC = Z('2026-11-24T09:00:00Z');

	test('new ones keep the trigger and zone, and are off', () => {
		const a = newAutomation({ id: 'x', name: 'x', prompt: 'p', schedule: '0 9 * * *', trigger: 'daily', time_zone: 'Asia/Bangkok' }, 0);
		expect([a.trigger, a.time_zone, a.enabled]).toEqual(['daily', 'Asia/Bangkok', false]);
		expect('trigger' in newAutomation({ id: 'y', name: 'y', prompt: 'p', schedule: 'daily 09:00' }, 0)).toBe(false);
	});

	test('runs on time; within a minute it is not a catch-up', () => {
		const a = cron({ last_due_at: Z('2026-11-23T17:00:00Z') });
		expect(decide([a], NINE_UTC + 30_000, {}, idle)).toEqual([{ id: 'c', due: NINE_UTC, action: 'run', handled: NINE_UTC + 30_000 }]);
		expect(decide([a], NINE_UTC - 1, {}, idle)).toEqual([]);
	});

	test('evaluated in its own zone', () => {
		// 09:00 in Bangkok is 02:00 UTC.
		const a = cron({ schedule: '0 9 * * *', time_zone: 'Asia/Bangkok', last_due_at: Z('2026-11-23T03:00:00Z') });
		expect(decide([a], Z('2026-11-24T02:00:10Z'), {}, idle)).toMatchObject([{ action: 'run', due: Z('2026-11-24T02:00:00Z') }]);
	});

	test('closed over several occurrences: one catch-up run, all of them handled', () => {
		const a = cron({ last_due_at: Z('2026-11-20T17:00:00Z') });
		const now = Z('2026-11-24T12:00:00Z');
		const [d] = decide([a], now, {}, idle);
		// The first missed occurrence (Mon 09:00) is the run; everything up to now is handled by it.
		expect(d).toEqual({ id: 'c', due: Z('2026-11-23T09:00:00Z'), action: 'run', handled: now });
		expect(decide([{ ...a, last_due_at: now }], now + 60_000, {}, idle)).toEqual([]);
		expect(decide([a], now + 60_000, { c: now }, idle)).toEqual([]);
	});

	test('catch-up off (VS Code misfire `skip`): a minute late is skipped, on time still runs', () => {
		const a = cron({ catch_up: false, last_due_at: Z('2026-11-23T17:00:00Z') });
		const [late] = decide([a], NINE_UTC + CATCH_UP_MS, {}, idle);
		expect(late).toMatchObject({ action: 'skip', due: NINE_UTC, handled: NINE_UTC + CATCH_UP_MS });
		expect(decide([a], NINE_UTC + CATCH_UP_MS - 1, {}, idle)).toMatchObject([{ action: 'run' }]);
	});

	test('one session at a time', () => {
		const a = cron({ last_due_at: Z('2026-11-23T17:00:00Z'), last_task_slug: 'sum-1' });
		expect(decide([a], NINE_UTC + 1, {}, (s) => s === 'sum-1')).toMatchObject([{ action: 'skip' }]);
	});

	test('enabling never starts a backlog', () => {
		const a = cron({ enabled_at: NINE_UTC + 60_000 });
		expect(decide([a], Z('2026-11-24T16:00:00Z'), {}, idle)).toEqual([]);
	});

	test('Manual never runs on its own; invalid expressions decide nothing', () => {
		const manual = cron({ trigger: 'manual', schedule: 'manual' });
		expect(decide([manual], Z('2027-01-01T00:00:00Z'), {}, idle)).toEqual([]);
		expect(nextRunOf(manual, NINE_UTC)).toBeNull();
		expect(isScheduled(manual)).toBe(false);
		const bad = cron({ schedule: '5/15 * * * *' });
		expect(isScheduled(bad)).toBe(false);
		expect(decide([bad], Z('2027-01-01T00:00:00Z'), {}, idle)).toEqual([]);
	});

	test('next run in the zone; the global switch stops it', () => {
		expect(nextRunOf(cron(), NINE_UTC)).toBe(Z('2026-11-24T17:00:00Z'));
		expect(decide([cron({ last_due_at: Z('2026-11-23T17:00:00Z') })], NINE_UTC + 1, {}, idle, false)).toEqual([]);
	});

	test('the list shows VS Code\'s description', () => {
		setLocale('en');
		expect(scheduleLabel(cron())).toMatch(/^Runs at 9:00\sAM and 5:00\sPM on Monday through Friday\./);
		expect(scheduleLabel(cron({ trigger: 'manual', schedule: 'manual' }))).toContain('Run now');
		expect(scheduleLabel(auto())).toBe('daily 09:00');
	});

	test('consent covers the trigger and its zone; older keys are unchanged', () => {
		const a = cron();
		expect(consentKey('/r', a)).not.toBe(consentKey('/r', { ...a, time_zone: 'Asia/Bangkok' }));
		expect(consentKey('/r', a)).not.toBe(consentKey('/r', { ...a, trigger: 'weekdays' }));
		const old = auto();
		expect(consentKey('/r', old)).toBe(JSON.stringify(['/r', old.id, old.prompt, old.schedule, old.base, old.mode]));
	});
});
