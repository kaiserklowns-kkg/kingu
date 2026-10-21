/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { buildRunSync, buildTaskSync, clientTaskId, issueSource, teamStatusLabel, type TeamRunInput, type TeamStatus } from './team';
import { setLocale } from '#lib/i18n/index.ts';

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
	const s = (o: Partial<TeamStatus>): TeamStatus => ({ server: 'https://t.example', signed_in: true, online: true, pending: 0, last_error: null, stream: 'connected', ...o });

	test('hidden without a server URL', () => expect(teamStatusLabel('', null)).toBeNull());
	test('connected', () => expect(teamStatusLabel('https://t.example', s({}))?.text).toBe('Team ✓'));
	test('unknown yet counts as connected', () => expect(teamStatusLabel('https://t.example', s({ online: null }))?.text).toBe('Team ✓'));
	test('offline shows pending', () => {
		const l = teamStatusLabel('https://t.example', s({ online: false, pending: 3 }));
		expect(l?.text).toBe('Team: Offline');
		expect(l?.tooltip).toContain('3 items pending');
		expect(l?.warn).toBe(true);
		expect(teamStatusLabel('https://t.example', s({ online: false, pending: 1 }))?.tooltip).toContain('1 item pending');
	});
	test('live updates in the tooltip; reconnecting shows ↻', () => {
		expect(teamStatusLabel('https://t.example', s({}))?.tooltip).toContain('Live updates: Connected');
		const l = teamStatusLabel('https://t.example', s({ stream: 'reconnecting' }));
		expect(l?.text).toBe('Team ↻');
		expect(l?.warn).toBe(false);
		expect(teamStatusLabel('https://t.example', s({ stream: 'off' }))?.tooltip).toContain('Live updates: Off');
	});
	test('signed out', () => expect(teamStatusLabel('https://t.example', s({ signed_in: false }))?.text).toBe('Team: Not Signed In'));
	test('in Thai', () => {
		setLocale('th');
		try {
			const l = teamStatusLabel('https://t.example', s({ online: false, pending: 3 }));
			expect(l?.text).toBe('ทีม: ออฟไลน์');
			expect(l?.tooltip).toContain('รอส่ง 3 รายการ');
			expect(teamStatusLabel('https://t.example', s({}))?.tooltip).toContain('อัปเดตสด: เชื่อมต่อแล้ว');
		} finally {
			setLocale('en');
		}
	});
});

describe('issueSource', () => {
	test('GitHub issues name their repository when the URL is github.com', () => {
		expect(issueSource({ number: 42, url: 'https://github.com/acme/app/issues/42', provider: 'github' })).toEqual({ source: 'github', external_ref: 'acme/app#42' });
		// Links saved before Linear have no provider: GitHub.
		expect(issueSource({ number: 7, url: 'https://github.com/acme/app/issues/7?x=1' })).toEqual({ source: 'github', external_ref: 'acme/app#7' });
		expect(issueSource({ number: 7, url: 'https://ghe.example.com/acme/app/issues/7' })).toEqual({ source: 'github', external_ref: '#7' });
	});

	test('Linear uses the identifier; bad links are left out', () => {
		expect(issueSource({ number: 123, url: 'https://linear.app/acme/issue/ENG-123/x', provider: 'linear', key: 'ENG-123' })).toEqual({ source: 'linear', external_ref: 'ENG-123' });
		expect(issueSource({ number: 1, url: 'https://linear.app/x', provider: 'linear' })).toBeUndefined();
		expect(issueSource({ number: 9, url: 'https://acme.atlassian.net/browse/ENG-9', provider: 'jira', key: 'ENG-9' })).toEqual({ source: 'jira', external_ref: 'ENG-9' });
		expect(issueSource({ number: 9, url: 'https://github.com/acme/api/issues/9', provider: 'github', key: 'acme/api#9' })).toEqual({ source: 'github', external_ref: 'acme/api#9' });
		expect(issueSource({ number: 9, url: 'https://gitlab.com/acme/app/-/issues/9', provider: 'gitlab', key: 'acme/app#9' })).toBeUndefined();
		expect(issueSource({ number: 0, url: 'https://github.com/a/b/issues/0' })).toBeUndefined();
		expect(issueSource(null)).toBeUndefined();
	});

	test('buildTaskSync carries the issue', () => {
		const p = buildTaskSync({ id: 't', title: 'Fix', status: 'review', issue: { number: 42, url: 'https://github.com/acme/app/issues/42' } }, now);
		expect(p).toMatchObject({ source: 'github', external_ref: 'acme/app#42' });
		expect(buildTaskSync({ id: 't', title: 'Fix', status: 'review' }, now)).not.toHaveProperty('source');
	});
});

describe('buildRunSync', () => {
	const run: TeamRunInput = {
		taskId: 'shop web:fix-login',
		agent: 'claude-code',
		model: 'claude-opus-5-5',
		status: 'done',
		startedAt: Date.parse('2026-10-17T09:00:00Z'),
		at: Date.parse('2026-10-17T09:05:00Z'),
		inputTokens: 1500,
		outputTokens: 300,
		costUsd: 0.4213
	};

	test('maps a run to the payload, keyed by its start', () => {
		expect(buildRunSync(run, now)).toEqual({
			client_task_id: 'shop-web:fix-login',
			client_run_id: String(Date.parse('2026-10-17T09:00:00Z')),
			adapter: 'claude-code',
			model: 'claude-opus-5-5',
			exit_reason: 'done',
			started_at: '2026-10-17T09:00:00.000Z',
			ended_at: '2026-10-17T09:05:00.000Z',
			input_tokens: 1500,
			output_tokens: 300,
			cost_usd: 0.4213,
			updated_at: now.toISOString()
		});
	});

	test('only finished turns and ended runs; unknown cost is left out', () => {
		expect(buildRunSync({ ...run, status: 'running' }, now)).toBeNull();
		expect(buildRunSync({ ...run, status: 'waiting' }, now)).toBeNull();
		expect(buildRunSync({ ...run, status: 'idle' }, now)?.exit_reason).toBe('idle');
		expect(buildRunSync({ ...run, startedAt: 0 }, now)).toBeNull();
		const p = buildRunSync({ ...run, costUsd: null, inputTokens: null, outputTokens: undefined, model: null }, now)!;
		expect(p).not.toHaveProperty('cost_usd');
		expect(p).not.toHaveProperty('model');
		expect([p.input_tokens, p.output_tokens]).toEqual([0, 0]);
		expect(buildRunSync({ ...run, costUsd: Number.NaN }, now)).not.toHaveProperty('cost_usd');
		// A turn end before the start (clock step) is clamped.
		expect(buildRunSync({ ...run, at: run.startedAt - 1000 }, now)?.ended_at).toBe('2026-10-17T09:00:00.000Z');
	});
});
