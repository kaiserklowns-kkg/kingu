import { describe, expect, test } from 'bun:test';
import { consentKey, decide, MISSED_GRACE_MS, newAutomation, nextRunOf, runTitle, type Automation } from './automations.ts';

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
