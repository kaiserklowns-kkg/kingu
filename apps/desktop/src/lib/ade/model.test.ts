import { describe, expect, test } from 'bun:test';
import {
	adoptOrphans,
	aggregateStats,
	columnOf,
	commitMessage,
	effectiveStatus,
	groupTasks,
	newTask,
	nextNeedingAttention,
	patchTask,
	pruneAccepted,
	reduceRun,
	removeTask,
	reviewChip,
	startRun,
	timeAgo,
	toggleAccepted,
	uniqueSlug,
	upsertTask,
	type DiffStat,
	type FileChange,
	type RuntimeEvent,
	type TaskMeta,
	type TaskRuntime,
	type TaskView
} from './model';
import { BOARD_KEY, isAdeEditor, slugOfTaskKey, taskKey } from './keys';
import { fileOf, isDiffKey, parseTaskDiffKey, tabLabel, taskDiffKey } from '../workbench/scm';
import { remapPath } from '../workbench/fileTree';

const meta = (slug: string, extra: Partial<TaskMeta> = {}): TaskMeta => ({ ...newTask({ slug, title: `Task ${slug}`, prompt: 'p', base: 'main' }, 1000), ...extra });
const view = (m: TaskMeta, runtime?: TaskRuntime, stat?: DiffStat): TaskView => ({ meta: m, runtime, status: effectiveStatus(m, runtime), stat });
const file = (path: string, added: number | null, deleted: number | null, status = 'M'): FileChange => ({ path, orig_path: null, status, added, deleted });
const stat = (extra: Partial<DiffStat> = {}): DiffStat => ({ base: 'main', merge_base: 'abc', head: 'def', ahead: 0, behind: 0, dirty: false, files: [], ...extra });

describe('tasks.json reducers', () => {
	test('newTask starts running with defaults', () => {
		const t = newTask({ slug: 'a', title: '  Fix it  ', prompt: 'do', base: 'main' }, 5);
		expect(t).toMatchObject({ slug: 'a', title: 'Fix it', status: 'running', agent: 'claude-code', created_at: 5, updated_at: 5, accepted: [], pr_url: null });
	});

	test('upsert replaces by slug or appends, without mutating', () => {
		const list = [meta('a'), meta('b')];
		const replaced = upsertTask(list, meta('a', { title: 'new' }));
		expect(replaced.map((t) => t.title)).toEqual(['new', 'Task b']);
		expect(list[0].title).toBe('Task a');
		expect(upsertTask(list, meta('c')).map((t) => t.slug)).toEqual(['a', 'b', 'c']);
	});

	test('remove and patch', () => {
		const list = [meta('a'), meta('b')];
		expect(removeTask(list, 'a').map((t) => t.slug)).toEqual(['b']);
		const patched = patchTask(list, 'b', { status: 'review', model: 'opus' }, 2000);
		expect(patched[1]).toMatchObject({ slug: 'b', status: 'review', model: 'opus', updated_at: 2000 });
		expect(patched[0]).toBe(list[0]);
		expect(patchTask(list, 'zzz', { status: 'done' }, 3)).toEqual(list);
	});

	test('toggleAccepted adds sorted and removes; pruneAccepted drops stale marks', () => {
		let list = [meta('a')];
		list = toggleAccepted(list, 'a', 'z.ts', 1);
		list = toggleAccepted(list, 'a', 'b.ts', 2);
		expect(list[0].accepted).toEqual(['b.ts', 'z.ts']);
		list = toggleAccepted(list, 'a', 'z.ts', 3);
		expect(list[0].accepted).toEqual(['b.ts']);
		expect(pruneAccepted(['b.ts', 'gone.ts'], [file('b.ts', 1, 0)])).toEqual(['b.ts']);
	});

	test('adoptOrphans adds unknown worktrees as tasks to review', () => {
		const list = [meta('a')];
		const out = adoptOrphans(list, ['a', 'old-run'], 'main', 9);
		expect(out.map((t) => [t.slug, t.status, t.base])).toEqual([
			['a', 'running', 'main'],
			['old-run', 'review', 'main']
		]);
		expect(adoptOrphans(list, ['a'], 'main', 9)).toBe(list);
	});

	test('uniqueSlug suffixes taken slugs within 48 chars', () => {
		expect(uniqueSlug('Fix login', new Set())).toBe('fix-login');
		expect(uniqueSlug('Fix login', new Set(['fix-login', 'fix-login-2']))).toBe('fix-login-3');
		const long = 'a'.repeat(60);
		const s = uniqueSlug(long, new Set(['a'.repeat(48)]));
		expect(s.length).toBeLessThanOrEqual(48);
		expect(s.endsWith('-2')).toBe(true);
		expect(uniqueSlug('แก้บั๊ก', new Set())).toMatch(/^task-/);
	});
});

describe('runtime reducer', () => {
	const run = (events: RuntimeEvent[]) => events.reduce((s, ev, i) => reduceRun(s, ev, 100 + i), startRun('t', 0)).runtime;

	test('a clean run ends ready for review, with the model and last event', () => {
		const rt = run([
			{ kind: 'system', subtype: 'init', session_id: 's', model: 'claude-opus' },
			{ kind: 'tool_use', id: '1', name: 'Edit', input: { file_path: 'src/a.ts' } },
			{ kind: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', num_turns: 2, duration_ms: 1, total_cost_usd: 0.1 },
			{ kind: 'exit', code: 0, signal: null, stopped: false }
		]);
		expect(rt).toMatchObject({ status: 'review', model: 'claude-opus', lastEvent: 'agent ทำงานเสร็จ', pendingPermissions: 0 });
	});

	test('errors and non-zero exits fail; stopping is a review', () => {
		expect(run([{ kind: 'result', subtype: 'error', is_error: true, result: 'boom', session_id: null, num_turns: 1, duration_ms: 1, total_cost_usd: null }, { kind: 'exit', code: 0, signal: null, stopped: false }]).status).toBe('failed');
		expect(run([{ kind: 'exit', code: 1, signal: null, stopped: false }]).status).toBe('failed');
		expect(run([{ kind: 'exit', code: null, signal: 15, stopped: true }]).status).toBe('review');
	});

	test('permission requests make it wait until resolved', () => {
		let s = startRun('t', 0);
		s = reduceRun(s, { kind: 'permission_request', id: 'p1', tool: 'Bash' }, 1);
		expect(s.runtime).toMatchObject({ status: 'waiting', pendingPermissions: 1, lastEvent: 'ขออนุญาตใช้ Bash' });
		s = reduceRun(s, { kind: 'permission_resolved', id: 'p1', allowed: true }, 2);
		expect(s.runtime).toMatchObject({ status: 'running', pendingPermissions: 0 });
	});
});

describe('grouping and sorting', () => {
	test('effective status: live runs win, interrupted runs become reviews', () => {
		const rt = (status: TaskRuntime['status'], pendingPermissions = 0): TaskRuntime => ({ slug: 'a', status, pendingPermissions });
		expect(effectiveStatus(meta('a', { status: 'review' }), rt('running'))).toBe('running');
		expect(effectiveStatus(meta('a'), rt('running', 2))).toBe('waiting');
		expect(effectiveStatus(meta('a', { status: 'running' }))).toBe('review');
		expect(effectiveStatus(meta('a', { status: 'done' }), rt('review'))).toBe('done');
		expect([columnOf('waiting'), columnOf('failed'), columnOf('review'), columnOf('running'), columnOf('done')]).toEqual(['attention', 'attention', 'attention', 'active', 'done']);
	});

	test('รอคุณ: waiting, then failed, then review, oldest first; others newest first', () => {
		const views = [
			view(meta('review-new', { status: 'review', updated_at: 50 })),
			view(meta('review-old', { status: 'review', updated_at: 10 })),
			view(meta('failed', { status: 'failed', updated_at: 99 })),
			view(meta('waiting', { status: 'review', updated_at: 99 }), { slug: 'waiting', status: 'running', pendingPermissions: 1, updatedAt: 100 }),
			view(meta('run-old', { updated_at: 1 }), { slug: 'run-old', status: 'running', pendingPermissions: 0, updatedAt: 5 }),
			view(meta('run-new', { updated_at: 1 }), { slug: 'run-new', status: 'running', pendingPermissions: 0, updatedAt: 500 }),
			view(meta('done-a', { status: 'done', updated_at: 3 })),
			view(meta('done-b', { status: 'done', updated_at: 7 }))
		];
		const g = groupTasks(views);
		const slugs = (l: TaskView[]) => l.map((v) => v.meta.slug);
		expect(slugs(g.attention)).toEqual(['waiting', 'failed', 'review-old', 'review-new']);
		expect(slugs(g.active)).toEqual(['run-new', 'run-old']);
		expect(slugs(g.done)).toEqual(['done-b', 'done-a']);
		expect(nextNeedingAttention(views)?.meta.slug).toBe('waiting');
		expect(nextNeedingAttention(views, 'waiting')?.meta.slug).toBe('failed');
		expect(nextNeedingAttention(views, 'review-new')?.meta.slug).toBe('waiting');
		expect(nextNeedingAttention([view(meta('d', { status: 'done' }))])).toBeUndefined();
	});
});

describe('stats and chips', () => {
	test('aggregates line counts and counts binary files apart', () => {
		expect(aggregateStats([file('a', 3, 1), file('b', 10, 0, 'A'), file('img.png', null, null), file('c', 0, 4, 'D')])).toEqual({ files: 4, added: 13, deleted: 5, binary: 1 });
		expect(aggregateStats([])).toEqual({ files: 0, added: 0, deleted: 0, binary: 0 });
	});

	test('review chip follows merge, PR, dirty and ahead state', () => {
		expect(reviewChip({ meta: meta('a', { merged_at: 1, pr_url: 'x' }), stat: stat() }).label).toBe('merge แล้ว');
		expect(reviewChip({ meta: meta('a', { pr_url: 'https://x' }) }).tone).toBe('info');
		expect(reviewChip({ meta: meta('a'), statError: 'no worktree' }).tone).toBe('error');
		expect(reviewChip({ meta: meta('a'), stat: stat({ dirty: true, ahead: 2 }) }).label).toBe('ยังไม่ commit');
		expect(reviewChip({ meta: meta('a'), stat: stat({ ahead: 2 }) }).label).toBe('2 commit รอ merge');
		expect(reviewChip({ meta: meta('a'), stat: stat() }).label).toBe('ไม่มีการเปลี่ยนแปลง');
	});

	test('time ago in Thai', () => {
		const now = 10 * 86_400_000;
		expect(timeAgo(now - 5_000, now)).toBe('เมื่อสักครู่');
		expect(timeAgo(now - 5 * 60_000, now)).toBe('5 นาทีที่แล้ว');
		expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3 ชม.ที่แล้ว');
		expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2 วันที่แล้ว');
	});

	test('commit message is the title, with the slug when it differs', () => {
		expect(commitMessage(meta('a', { title: 'Fix login' }))).toBe('Fix login\n\nKingu task: a');
		expect(commitMessage(meta('a', { title: 'a' }))).toBe('a');
	});
});

describe('editor keys', () => {
	test('task and board keys', () => {
		expect(slugOfTaskKey(taskKey('fix'))).toBe('fix');
		expect(slugOfTaskKey('src/a.ts')).toBeNull();
		expect(isAdeEditor(BOARD_KEY) && isAdeEditor(taskKey('x')) && !isAdeEditor('diff:a')).toBe(true);
	});

	test('task diff keys point into the worktree and are never remapped', () => {
		const key = taskDiffKey('fix', 'src/a b.ts');
		expect(isDiffKey(key)).toBe(true);
		expect(parseTaskDiffKey(key)).toEqual({ slug: 'fix', rel: 'src/a b.ts' });
		expect(fileOf(key)).toBe('.kingu/worktrees/fix/src/a b.ts');
		expect(tabLabel(key)).toBe('a b.ts (งาน fix)');
		expect(remapPath(key, '.kingu', 'x')).toBeNull();
		expect(parseTaskDiffKey('diff:src/a.ts')).toBeNull();
		expect(fileOf('diff:src/a.ts')).toBe('src/a.ts');
	});
});
