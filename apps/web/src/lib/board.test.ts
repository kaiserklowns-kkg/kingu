/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { applyEvent, columnOf, columns, describeChange, initBoard, mergeSnapshot, taskFromEvent, timeAgo, type Task, type TeamEvent } from './board';

const task = (o: Partial<Task> = {}): Task => ({
	id: 't1',
	project_id: 'p1',
	title: 'Add login page',
	status: 'running',
	branch: 'kingu/login',
	agent: 'claude-code',
	model: 'opus',
	additions: 12,
	deletions: 3,
	files_changed: 2,
	created_by: 'alice',
	updated_by: 'alice',
	created_at: '2026-10-17T09:00:00Z',
	updated_at: '2026-10-17T10:00:00Z',
	...o
});

const ev = (id: number, kind: TeamEvent['kind'], data: Partial<Task> | Record<string, unknown>): TeamEvent => ({
	id,
	kind,
	project_id: 'p1',
	task_id: (data as Task).id ?? null,
	at: '2026-10-17T10:00:00Z',
	data: data as Record<string, unknown>
});

describe('applyEvent', () => {
	test('adds a created task and moves it between columns on update', () => {
		let b = initBoard([]);
		b = applyEvent(b, ev(1, 'task.created', task()));
		expect(columns(b).active.map((t) => t.id)).toEqual(['t1']);
		b = applyEvent(b, ev(2, 'task.updated', task({ status: 'review', updated_at: '2026-10-17T10:05:00Z' })));
		expect(columns(b).active).toEqual([]);
		expect(columns(b).waiting[0].status).toBe('review');
		expect(b.lastEventId).toBe(2);
	});

	test('ignores replayed events (same object back)', () => {
		const b = applyEvent(initBoard([]), ev(5, 'task.created', task()));
		expect(applyEvent(b, ev(5, 'task.created', task({ title: 'dup' })))).toBe(b);
		expect(applyEvent(b, ev(3, 'task.updated', task({ title: 'old' })))).toBe(b);
	});

	test('ignores snapshots older than what the board has', () => {
		const b = initBoard([task({ status: 'done', updated_at: '2026-10-17T11:00:00Z' })]);
		const next = applyEvent(b, ev(9, 'task.updated', task({ status: 'running', updated_at: '2026-10-17T10:00:00Z' })));
		expect(next.tasks.t1.status).toBe('done');
		expect(next.lastEventId).toBe(9);
	});

	test('run events and malformed payloads only advance the cursor', () => {
		const b = initBoard([task()]);
		const r = applyEvent(b, ev(1, 'run.created', { id: 'r1', task_id: 't1' }));
		expect(r.tasks).toBe(b.tasks);
		const bad = applyEvent(r, ev(2, 'task.updated', { id: 't2', status: 'nope', title: 'x', project_id: 'p1', updated_at: 'x' }));
		expect(Object.keys(bad.tasks)).toEqual(['t1']);
		expect(bad.lastEventId).toBe(2);
	});
});

describe('mergeSnapshot', () => {
	test('adds new tasks but keeps newer streamed state', () => {
		const b = initBoard([task({ status: 'done', updated_at: '2026-10-17T11:00:00Z' })], 7);
		const m = mergeSnapshot(b, [task({ status: 'running', updated_at: '2026-10-17T10:00:00Z' }), task({ id: 't2' })]);
		expect(m.tasks.t1.status).toBe('done');
		expect(Object.keys(m.tasks).sort()).toEqual(['t1', 't2']);
		expect(m.lastEventId).toBe(7);
	});
});

describe('columns', () => {
	test('maps statuses to รอคุณ / กำลังทำ / เสร็จแล้ว', () => {
		expect(columnOf('needs_input')).toBe('waiting');
		expect(columnOf('failed')).toBe('waiting');
		expect(columnOf('backlog')).toBe('active');
		expect(columnOf('done')).toBe('done');
	});

	test('sorts newest first and filters by project', () => {
		const b = initBoard([
			task({ id: 'a', updated_at: '2026-10-17T10:00:00Z' }),
			task({ id: 'b', updated_at: '2026-10-17T12:00:00Z' }),
			task({ id: 'c', project_id: 'p2' })
		]);
		expect(columns(b).active.map((t) => t.id)).toEqual(['b', 'a', 'c']);
		expect(columns(b, 'p2').active.map((t) => t.id)).toEqual(['c']);
	});
});

describe('helpers', () => {
	test('taskFromEvent defaults numbers and rejects incomplete data', () => {
		expect(taskFromEvent({ id: 'x', project_id: 'p', title: 't', status: 'done', updated_at: '2026-10-17T10:00:00Z', additions: -5 })?.additions).toBe(0);
		expect(taskFromEvent({ id: 'x' })).toBeNull();
	});

	test('timeAgo in Thai', () => {
		const now = Date.parse('2026-10-17T12:00:00Z');
		expect(timeAgo('2026-10-17T11:59:50Z', now)).toBe('เมื่อสักครู่');
		expect(timeAgo('2026-10-17T11:55:00Z', now)).toBe('5 นาทีที่แล้ว');
		expect(timeAgo('2026-10-17T09:00:00Z', now)).toBe('3 ชั่วโมงที่แล้ว');
		expect(timeAgo('2026-10-15T12:00:00Z', now)).toBe('2 วันที่แล้ว');
		expect(timeAgo(null, now)).toBe('');
	});

	test('describeChange', () => {
		expect(describeChange(undefined, task())).toBe('งานใหม่: Add login page (กำลังทำ) โดย alice');
		expect(describeChange(task(), task({ status: 'done' }))).toBe('Add login page: กำลังทำ → เสร็จแล้ว');
	});
});
