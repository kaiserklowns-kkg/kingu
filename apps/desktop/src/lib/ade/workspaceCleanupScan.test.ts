import { describe, expect, test } from 'bun:test';
import { candidateInput, cleanupPreview, cleanupReceipt, evaluateScan, slugsToRemove, type CleanupCandidate, type CleanupScan, type CleanupTaskContext } from './workspaceCleanupScan';
import type { WorkspaceCleanupKeepCause } from './workspaceCleanupEvaluation';
import { getDefaultWorkspaceCleanupRules, resolveWorkspaceCleanupPolicy } from './workspaceCleanupPolicy';

const NOW = Date.UTC(2026, 10, 16);
const DAY = 86_400_000;

const cand = (over: Partial<CleanupCandidate> = {}): CleanupCandidate => ({
	path: '/p/.kingu/worktrees/a',
	branch: 'kingu/a',
	head: 'abc',
	slug: 'a',
	isMain: false,
	detached: false,
	locked: false,
	checkedAt: NOW,
	clean: true,
	ignoredFiles: false,
	unpushed: false,
	merged: true,
	unchanged: false,
	unknownBase: false,
	base: 'origin/main',
	error: null,
	lastActivityAt: NOW - 3 * DAY,
	...over
});
const scan = (...candidates: CleanupCandidate[]): CleanupScan => ({ scannedAt: NOW, candidates });
const merged = resolveWorkspaceCleanupPolicy({ workspaceCleanupPolicy: { ...getDefaultWorkspaceCleanupRules(), merged: { enabled: true } } });
const ctx: Record<string, CleanupTaskContext> = {};
const verdicts = (s: CleanupScan, policy = merged) => evaluateScan(s, policy, (slug) => ctx[slug]);

describe('workspace cleanup scan → evaluator input', () => {
	test('git facts become reasons and blockers', () => {
		const input = candidateInput(cand({ merged: false, unchanged: true, clean: false, unpushed: true, ignoredFiles: true }), undefined);
		expect(input.reasons).toEqual(['unchanged']);
		expect(input.blockers).toEqual(['dirty-files', 'unpushed-commits', 'ignored-files']);
	});

	test('what the app knows about the task protects it', () => {
		const input = candidateInput(cand(), { liveAgent: true, active: true, dirtyEditor: true });
		expect(input.blockers).toEqual(['active-workspace', 'live-agent', 'dirty-editor-buffer']);
	});

	test('the main checkout and a worktree Kingu did not create are never offered', () => {
		const v = verdicts(scan(cand({ slug: 'main', isMain: true }), cand({ slug: null, path: '/elsewhere' }), cand()));
		expect([...v.keys()]).toEqual(['a']);
		expect(candidateInput(cand({ slug: null }), undefined).blockers).toContain('folder-repo');
	});

	test('a clean, pushed, merged task is removed once its rule is on', () => {
		expect(slugsToRemove(verdicts(scan(cand())))).toEqual(['a']);
	});

	test('nothing is removed while every rule is off', () => {
		const off = resolveWorkspaceCleanupPolicy({});
		const v = verdicts(scan(cand()), off).get('a')!;
		expect(v.evaluation).toEqual({ action: 'keep', cause: 'rules-off' });
	});

	test('work that could be lost is kept, with the cause named', () => {
		const cases: [Partial<CleanupCandidate>, WorkspaceCleanupKeepCause][] = [
			[{ clean: false }, 'uncommitted-changes'],
			[{ unpushed: true }, 'unpushed-commits'],
			[{ ignoredFiles: true }, 'ignored-files'],
			[{ checkedAt: null, clean: null, error: 'folder missing' }, 'git-unknown']
		];
		for (const [over, cause] of cases) {
			const e = verdicts(scan(cand(over))).get('a')!.evaluation;
			expect([over, e.action === 'keep' && e.cause]).toEqual([over, cause]);
		}
	});

	test('a live agent, the open task, or an unsaved editor keeps the task', () => {
		for (const [c, cause] of [[{ liveAgent: true }, 'agent-running'], [{ active: true }, 'active-workspace'], [{ dirtyEditor: true }, 'unsaved-editor-changes']] as const) {
			ctx.a = { liveAgent: false, active: false, dirtyEditor: false, ...c };
			const e = verdicts(scan(cand())).get('a')!.evaluation;
			expect([cause, e.action === 'keep' && e.cause]).toEqual([cause, cause]);
		}
		delete ctx.a;
	});

	test('a task touched in the last hour is kept even when merged; the task’s own update counts', () => {
		expect(verdicts(scan(cand({ lastActivityAt: NOW - 60_000 }))).get('a')!.evaluation).toMatchObject({ action: 'keep', cause: 'recently-active' });
		ctx.a = { liveAgent: false, active: false, dirtyEditor: false, updatedAt: NOW - 1000 };
		expect(verdicts(scan(cand())).get('a')!.evaluation).toMatchObject({ action: 'keep', cause: 'recently-active' });
		delete ctx.a;
	});

	test('archive is never offered: an inactive rule set to archive keeps the task', () => {
		const rules = { ...getDefaultWorkspaceCleanupRules(), inactive: { enabled: true, afterDays: 1, action: 'archive' as const } };
		const v = verdicts(scan(cand({ merged: false })), resolveWorkspaceCleanupPolicy({ workspaceCleanupPolicy: rules })).get('a')!;
		expect(v.evaluation).toMatchObject({ action: 'keep', cause: 'archive-unavailable' });
		expect(slugsToRemove(new Map([['a', v]]))).toEqual([]);
	});

	test('the CLI preview names the rules that are on and each task in plain words', () => {
		const v = verdicts(scan(cand(), cand({ slug: 'b', path: '/p/b', clean: false })));
		expect(cleanupPreview(merged, v)).toEqual({
			rules: 'merged',
			tasks: [
				{ slug: 'a', action: 'delete', label: 'merged' },
				{ slug: 'b', action: 'keep', label: 'uncommitted changes' }
			]
		});
		expect(cleanupPreview(resolveWorkspaceCleanupPolicy({}), new Map()).rules).toBe('off');
		const off = resolveWorkspaceCleanupPolicy({ workspaceCleanupPolicy: { ...getDefaultWorkspaceCleanupRules(), merged: { enabled: true } } }, { workspaceCleanupPolicy: { mode: 'off' } });
		expect(cleanupPreview(off, new Map()).rules).toBe('off (this project)');
	});

	test('the run receipt lists what was removed, what failed and how many were kept', () => {
		expect(cleanupReceipt(['a'], [{ slug: 'b', error: 'x' }], 3)).toEqual({ removed: ['a'], failed: [{ slug: 'b', error: 'x' }], kept: 3 });
	});
});
