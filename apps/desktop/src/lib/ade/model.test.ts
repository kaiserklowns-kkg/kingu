import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	renamedTitle,
	MAX_TITLE,
	adoptOrphans,
	aggregateStats,
	columnOf,
	commitMessage,
	effectiveStatus,
	followUpPlan,
	formatSummaryUsage,
	groupTasks,
	lastEventOf,
	newTask,
	nextNeedingAttention,
	patchTask,
	pruneAccepted,
	removeTask,
	reviewChip,
	runSummary,
	sameSummary,
	taskStatusOf,
	timeAgo,
	toTaskRuntime,
	statusLabel,
	isQuestion,
	toggleAccepted,
	uniqueSlug,
	upsertTask,
	type DiffStat,
	type FileChange,
	type RunView,
	type TaskMeta,
	type TaskRuntime,
	type TaskView
} from './model';
import { applyEvent, initialRun, type AgentEvent, type PermissionRequest, type RunState } from '../agent/events';
import { BOARD_KEY, isAdeEditor, slugOfTaskKey, taskKey } from './keys';
import { fileOf, isDiffKey, parseTaskDiffKey, tabLabel, taskDiffKey } from '../workbench/scm';
import { remapPath } from '../workbench/fileTree';
import { setLocale } from '#lib/i18n/index.ts';

// These tests check the Thai UI text.
beforeAll(() => setLocale('th'));
afterAll(() => setLocale('en'));

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

describe('agents store → TaskRuntime adapter', () => {
	const run = (events: AgentEvent[]): RunView & RunState => {
		const r = { ...initialRun(), slug: 't' };
		for (const ev of events) applyEvent(r, ev);
		return r;
	};
	const init: AgentEvent = { kind: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-5-5' };
	const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 };
	const ok: AgentEvent = { kind: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'sess-1', num_turns: 2, duration_ms: 1, total_cost_usd: 0.1, usage };
	const exit = (extra: Partial<Extract<AgentEvent, { kind: 'exit' }>> = {}): AgentEvent => ({ kind: 'exit', code: 0, signal: null, stopped: false, ...extra });
	const perm = (id: string, tool = 'Bash'): PermissionRequest => ({
		kind: 'permission_request',
		request_id: id,
		tool,
		tool_use_id: null,
		title: null,
		input_summary: 'npm test',
		detail: null,
		diff: null,
		input: { command: 'npm test' },
		can_always: true
	});

	test('a starting or working run is กำลังทำ', () => {
		expect(toTaskRuntime(run([]))).toMatchObject({ status: 'running', runStatus: 'starting', live: true, working: true, lastEvent: 'กำลังเริ่ม' });
		const rt = toTaskRuntime(run([init, { kind: 'tool_use', id: '1', name: 'Edit', input: { file_path: 'src/a.ts' } }]), 42);
		expect(rt).toMatchObject({ status: 'running', runStatus: 'running', model: 'claude-opus-5-5', sessionId: 'sess-1', lastEvent: 'Edit(src/a.ts)', updatedAt: 42 });
	});

	test('streamed deltas are the last event until the message completes', () => {
		const r = run([init, { kind: 'delta', block: 'text', text: 'กำลังแก้ ' }, { kind: 'delta', block: 'text', text: 'ไฟล์\nบรรทัดสอง' }]);
		expect(lastEventOf(r)).toBe('กำลังแก้ ไฟล์');
		applyEvent(r, { kind: 'message', role: 'assistant', text: 'แก้เสร็จแล้ว' });
		expect(lastEventOf(r)).toBe('แก้เสร็จแล้ว');
	});

	test('AskUserQuestion is a question, not a permission prompt', () => {
		const q = { ...perm('q1', 'AskUserQuestion'), input: { questions: [{ question: 'ใช้ฐานข้อมูลไหน?', header: 'DB' }] } };
		const rt = toTaskRuntime(run([init, q]));
		expect(rt).toMatchObject({ status: 'waiting', question: true, lastEvent: 'ถาม: ใช้ฐานข้อมูลไหน?' });
		expect(statusLabel({ status: rt.status, runtime: rt })).toBe('agent ถามคุณ');
		expect(isQuestion({ status: 'waiting', runtime: { question: false } })).toBe(false);
		expect(toTaskRuntime(run([init, perm('p1')])).question).toBe(false);
	});

	test('a permission request is รอคุณ (waiting) until answered', () => {
		const r = run([init, perm('p1'), perm('p2', 'Write')]);
		expect(toTaskRuntime(r)).toMatchObject({ status: 'waiting', runStatus: 'waiting', pendingPermissions: 2, working: true, lastEvent: 'ขออนุญาตใช้ Bash: npm test' });
		expect(effectiveStatus(newTask({ slug: 't', title: 't', prompt: '', base: 'main' }, 0), toTaskRuntime(r))).toBe('waiting');
		applyEvent(r, { kind: 'permission_resolved', request_id: 'p1', decision: 'allow' });
		applyEvent(r, { kind: 'permission_resolved', request_id: 'p2', decision: 'deny' });
		expect(toTaskRuntime(r)).toMatchObject({ status: 'running', pendingPermissions: 0 });
	});

	test('a finished turn (session still open) needs review, with usage', () => {
		const rt = toTaskRuntime(run([init, ok]));
		expect(rt).toMatchObject({ status: 'review', runStatus: 'idle', live: true, working: false, lastEvent: 'agent ทำงานเสร็จ' });
		expect(rt.usage).toBe('$0.1000 · 1.5k in · 200 out · 2 turns');
	});

	test('ended runs: done and stopped are reviews; errors and failed exits fail', () => {
		expect(toTaskRuntime(run([init, ok, exit()]))).toMatchObject({ status: 'review', runStatus: 'done', live: false, working: false });
		expect(toTaskRuntime(run([init, exit({ code: null, signal: 15, stopped: true })]))).toMatchObject({ status: 'review', runStatus: 'stopped', lastEvent: 'หยุดแล้ว' });
		expect(taskStatusOf(run([init, { ...ok, is_error: true, subtype: 'error_max_turns', result: 'boom' }]))).toBe('failed');
		expect(taskStatusOf(run([init, exit({ code: 1 })]))).toBe('failed');
		const crashed = run([{ kind: 'error', message: 'agent host exited' }, exit({ code: null })]);
		expect(toTaskRuntime(crashed)).toMatchObject({ status: 'failed', error: 'agent host exited', lastEvent: 'ข้อผิดพลาด: agent host exited' });
		// Pending requests are cancelled when the run ends.
		expect(toTaskRuntime(run([init, perm('p1'), exit({ stopped: true })]))).toMatchObject({ status: 'review', pendingPermissions: 0 });
	});

	test('run summary for tasks.json', () => {
		const s = runSummary(run([init, ok, exit()]), 5000);
		expect(s).toEqual({ status: 'done', at: 5000, summary: 'agent ทำงานเสร็จ', error: null, cost_usd: 0.1, input_tokens: 1500, output_tokens: 200, num_turns: 2 });
		expect(formatSummaryUsage(s)).toBe('$0.1000 · 1.5k in · 200 out · 2 turns');
		// The run's start (team sync's run id) is kept when known; a new run is a different summary.
		const started = runSummary(run([init, ok, exit()]), 5000, 1234);
		expect(started.started_at).toBe(1234);
		expect(sameSummary(started, { ...started, started_at: 9999 })).toBe(false);
		expect(sameSummary(s, { ...s, at: 9 })).toBe(true);
		expect(sameSummary(s, { ...s, status: 'stopped' })).toBe(false);
		expect(sameSummary(s, null)).toBe(false);
		expect(formatSummaryUsage(runSummary(run([exit({ stopped: true })]), 1))).toBe('');
	});

	test('follow-ups: send to the store when it has the session, else resume the saved one', () => {
		const live = run([init]);
		expect(followUpPlan(live, null)).toEqual({ kind: 'send' });
		expect(followUpPlan(run([init, ok, exit()]), 'older')).toEqual({ kind: 'send' });
		expect(followUpPlan(undefined, 'sess-saved')).toEqual({ kind: 'start', resume: 'sess-saved' });
		expect(followUpPlan(run([exit({ code: 1 })]), 'sess-saved')).toEqual({ kind: 'start', resume: 'sess-saved' });
		expect(followUpPlan(undefined, null)).toEqual({ kind: 'start', resume: null });
	});
});

describe('grouping and sorting', () => {
	test('effective status: live runs win, interrupted runs become reviews', () => {
		const rt = (status: TaskRuntime['status'], pendingPermissions = 0): TaskRuntime => ({
			slug: 'a',
			status,
			runStatus: 'running',
			live: true,
			working: true,
			sessionId: null,
			pendingPermissions
		});
		expect(effectiveStatus(meta('a', { status: 'review' }), rt('running'))).toBe('running');
		expect(effectiveStatus(meta('a'), rt('running', 2))).toBe('waiting');
		expect(effectiveStatus(meta('a', { status: 'running' }))).toBe('review');
		expect(effectiveStatus(meta('a', { status: 'done' }), rt('review'))).toBe('done');
		expect([columnOf('waiting'), columnOf('failed'), columnOf('review'), columnOf('running'), columnOf('done')]).toEqual(['attention', 'attention', 'attention', 'active', 'done']);
	});

	const live = (slug: string, pendingPermissions: number, updatedAt: number): TaskRuntime => ({
		slug,
		status: 'running',
		runStatus: pendingPermissions ? 'waiting' : 'running',
		live: true,
		working: true,
		sessionId: null,
		pendingPermissions,
		updatedAt
	});

	test('รอคุณ: waiting, then failed, then review, oldest first; others newest first', () => {
		const views = [
			view(meta('review-new', { status: 'review', updated_at: 50 })),
			view(meta('review-old', { status: 'review', updated_at: 10 })),
			view(meta('failed', { status: 'failed', updated_at: 99 })),
			view(meta('waiting', { status: 'review', updated_at: 99 }), live('waiting', 1, 100)),
			view(meta('run-old', { updated_at: 1 }), live('run-old', 0, 5)),
			view(meta('run-new', { updated_at: 1 }), live('run-new', 0, 500)),
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
		expect(tabLabel(key)).toBe('a b.ts (task fix)');
		expect(remapPath(key, '.kingu', 'x')).toBeNull();
		expect(parseTaskDiffKey('diff:src/a.ts')).toBeNull();
		expect(fileOf('diff:src/a.ts')).toBe('src/a.ts');
	});
});

describe('rename (Orca getWorktreeTitleRenameCommit)', () => {
	test('trimmed new name; empty or unchanged cancels', () => {
		expect(renamedTitle('old', '  แก้ login  ')).toBe('แก้ login');
		expect(renamedTitle('old', '   ')).toBeNull();
		expect(renamedTitle('old', ' old ')).toBeNull();
	});
	test('capped at the tasks.json limit in characters', () => {
		expect([...renamedTitle('old', 'ก'.repeat(MAX_TITLE + 20))!]).toHaveLength(MAX_TITLE);
	});
});
