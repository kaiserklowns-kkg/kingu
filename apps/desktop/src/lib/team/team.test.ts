import { describe, expect, test } from 'bun:test';
import { buildTaskSync, clientTaskId, teamStatusLabel, type TeamStatus } from './team';

const now = new Date('2026-10-17T10:00:00.000Z');

describe('buildTaskSync', () => {
	test('maps a task to the snake_case payload and drops empty fields', () => {
		const p = buildTaskSync(
			{ id: 'task 42/x', title: '  Add\nlogin   page ', status: 'running', branch: 'kingu/login', agent: 'claude-code', model: '', additions: 12, deletions: 3.7, filesChanged: -1, startedAt: '2026-10-17T09:00:00Z' },
			now
		);
		expect(p).toEqual({
			client_task_id: 'task-42-x',
			title: 'Add login page',
			status: 'running',
			branch: 'kingu/login',
			agent: 'claude-code',
			diff_stats: { additions: 12, deletions: 3, files_changed: 0 },
			started_at: '2026-10-17T09:00:00.000Z',
			updated_at: '2026-10-17T10:00:00.000Z'
		});
	});

	test('bounds the title and id', () => {
		const p = buildTaskSync({ id: 'x'.repeat(200), title: 'a'.repeat(500), status: 'done' }, now);
		expect(p.title.length).toBe(300);
		expect(p.client_task_id.length).toBe(128);
		expect(p.diff_stats).toBeUndefined();
		expect(clientTaskId('')).toBe('task');
	});
});

describe('teamStatusLabel', () => {
	const s = (o: Partial<TeamStatus>): TeamStatus => ({ server: 'https://t.example', signed_in: true, online: true, pending: 0, last_error: null, ...o });

	test('hidden without a server URL', () => expect(teamStatusLabel('', null)).toBeNull());
	test('connected', () => expect(teamStatusLabel('https://t.example', s({}))?.text).toBe('ทีม ✓'));
	test('unknown yet counts as connected', () => expect(teamStatusLabel('https://t.example', s({ online: null }))?.text).toBe('ทีม ✓'));
	test('offline shows pending', () => {
		const l = teamStatusLabel('https://t.example', s({ online: false, pending: 3 }));
		expect(l?.text).toBe('ทีม: ออฟไลน์');
		expect(l?.tooltip).toContain('รอส่ง 3');
		expect(l?.warn).toBe(true);
	});
	test('signed out', () => expect(teamStatusLabel('https://t.example', s({ signed_in: false }))?.text).toBe('ทีม: ยังไม่ได้ลงชื่อเข้าใช้'));
});
