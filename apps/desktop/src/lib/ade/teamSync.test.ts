import { describe, expect, test } from 'bun:test';
import { runKey, syncKey, toTeamRun, toTeamTask } from './teamSync';
import type { TaskView } from './model';

const view = (over: Partial<TaskView> = {}): TaskView =>
	({
		meta: {
			slug: 'fix-login',
			title: 'แก้บั๊ก login',
			prompt: 'secret prompt text',
			base: 'main',
			created_at: 1,
			updated_at: 2,
			agent: 'claude-code',
			model: 'claude-opus-5-5',
			status: 'running',
			pr_url: null,
			accepted: [],
			merged_at: null,
			session_id: 'sess',
			last_run: null,
			issue: null
		},
		status: 'waiting',
		stat: {
			base: 'main',
			merge_base: 'a',
			head: 'b',
			ahead: 1,
			behind: 0,
			dirty: true,
			files: [
				{ path: 'src/a.ts', orig_path: null, status: 'M', added: 3, deleted: 1 },
				{ path: 'img.png', orig_path: null, status: 'A', added: null, deleted: null }
			]
		},
		...over
	}) as TaskView;

describe('toTeamTask', () => {
	test('maps status and totals, never the prompt or file names', () => {
		const t = toTeamTask(view(), 'shop-web');
		expect(t).toMatchObject({ id: 'shop-web:fix-login', status: 'needs_input', branch: 'kingu/fix-login', additions: 3, deletions: 1, filesChanged: 2 });
		expect(JSON.stringify(t)).not.toContain('secret prompt');
		expect(JSON.stringify(t)).not.toContain('src/a.ts');
	});

	test('sync key ignores unchanged tasks and changes with status', () => {
		expect(syncKey(toTeamTask(view(), 'f'))).toBe(syncKey(toTeamTask(view(), 'f')));
		expect(syncKey(toTeamTask(view({ status: 'review' }), 'f'))).not.toBe(syncKey(toTeamTask(view(), 'f')));
	});
});

describe('toTeamRun', () => {
	const lastRun = { status: 'idle' as const, at: 5_000, summary: 'x', error: null, cost_usd: 0.25, input_tokens: 100, output_tokens: 20, num_turns: 1 };

	test('the latest run with its start; never the summary text', () => {
		const v = view({ meta: { ...view().meta, last_run: { ...lastRun, started_at: 1_000 } } });
		const r = toTeamRun(v, 'shop-web');
		expect(r).toEqual({ taskId: 'shop-web:fix-login', agent: 'claude-code', model: 'claude-opus-5-5', status: 'idle', startedAt: 1_000, at: 5_000, inputTokens: 100, outputTokens: 20, costUsd: 0.25 });
		expect(JSON.stringify(r)).not.toContain('summary');
	});

	test('nothing for runs saved before start times were kept', () => {
		expect(toTeamRun(view({ meta: { ...view().meta, last_run: lastRun } }), 'f')).toBeNull();
		expect(toTeamRun(view(), 'f')).toBeNull();
	});

	test('run key changes with usage, not with the save time', () => {
		const a = toTeamRun(view({ meta: { ...view().meta, last_run: { ...lastRun, started_at: 1 } } }), 'f')!;
		expect(runKey({ ...a, at: 99 })).toBe(runKey(a));
		expect(runKey({ ...a, costUsd: 0.5 })).not.toBe(runKey(a));
		expect(runKey({ ...a, status: 'done' })).not.toBe(runKey(a));
	});

	test('the task carries its issue', () => {
		const issue = { number: 42, url: 'https://github.com/acme/app/issues/42', title: 'x' };
		expect(toTeamTask(view({ meta: { ...view().meta, issue } }), 'f').issue).toEqual(issue);
		expect(syncKey(toTeamTask(view({ meta: { ...view().meta, issue } }), 'f'))).not.toBe(syncKey(toTeamTask(view(), 'f')));
	});
});
