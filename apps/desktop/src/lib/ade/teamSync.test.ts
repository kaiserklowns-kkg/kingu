import { describe, expect, test } from 'bun:test';
import { syncKey, toTeamTask } from './teamSync';
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
