/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { costTotals, formatCost, type Run } from './runs';

const run = (o: Partial<Run> = {}): Run => ({
	id: 'r1',
	task_id: 't1',
	task_title: 'Fix login',
	project_id: 'p1',
	project_name: 'shop',
	source: 'manual',
	external_ref: null,
	adapter: 'claude-code',
	model: 'opus',
	machine_id: null,
	started_at: '2026-10-17T09:00:00Z',
	ended_at: '2026-10-17T09:05:00Z',
	exit_reason: 'done',
	input_tokens: 100,
	output_tokens: 20,
	cost_usd: 0.5,
	created_by: 'alice',
	...o
});

describe('costTotals', () => {
	test('sums cost per task, person and project, highest first', () => {
		const t = costTotals([
			run(),
			run({ id: 'r2', cost_usd: 1.25, created_by: 'bob' }),
			run({ id: 'r3', task_id: 't2', task_title: 'Add search', source: 'github', external_ref: 'acme/shop#7', project_id: 'p2', project_name: 'api', cost_usd: 2 }),
			run({ id: 'r4', task_id: 't2', task_title: 'Add search', external_ref: 'acme/shop#7', project_id: 'p2', project_name: 'api', cost_usd: null, created_by: null })
		]);
		expect(t.total).toBe(3.75);
		expect(t.unknown).toBe(1);
		expect(t.byTask.map((r) => [r.label, r.cost, r.runs, r.unknown])).toEqual([
			['Add search (acme/shop#7)', 2, 2, 1],
			['Fix login', 1.75, 2, 0]
		]);
		expect(t.byPerson.map((r) => [r.label, r.cost])).toEqual([
			['alice', 2.5],
			['bob', 1.25],
			['ไม่ทราบ', 0]
		]);
		expect(t.byProject.map((r) => [r.label, r.cost, r.tokens])).toEqual([
			['api', 2, 240],
			['shop', 1.75, 240]
		]);
	});

	test('empty history', () => {
		expect(costTotals([])).toEqual({ byTask: [], byPerson: [], byProject: [], total: 0, unknown: 0 });
	});
});

test('formatCost', () => {
	expect(formatCost(0.4213)).toBe('$0.4213');
	expect(formatCost(12)).toBe('$12.00');
	expect(formatCost(null)).toBe('—');
});
