import { describe, expect, test } from 'bun:test';
import { applyRechecked, candidateInput, candidateVerdict, cleanupPreview, cleanupReceipt, cleanupTargets, evaluateScan, type CleanupCandidate, type CleanupScan, type CleanupTaskContext } from './workspaceCleanupScan';
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
	squashMerged: false,
	prMerged: false,
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
		const input = candidateInput(cand(), { liveAgent: true, active: true, dirtyEditor: true, pinned: true });
		expect(input.blockers).toEqual(['active-workspace', 'live-agent', 'dirty-editor-buffer', 'pinned']);
	});

	test('a task with a terminal open is kept: removing it would kill the live PTY', () => {
		const c: CleanupTaskContext = { liveAgent: false, active: false, dirtyEditor: false, runningTerminal: true };
		expect(candidateInput(cand(), c).blockers).toEqual(['running-terminal']);
		expect(evaluateScan(scan(cand()), merged, () => c).get('a')!.evaluation).toMatchObject({ action: 'keep', cause: 'terminal-running' });
		expect(candidateInput(cand(), { ...c, runningTerminal: false }).blockers).toEqual([]);
	});

	test('the main checkout and a worktree Kingu did not create are never offered', () => {
		const v = verdicts(scan(cand({ slug: 'main', isMain: true }), cand({ slug: null, path: '/elsewhere' }), cand()));
		expect([...v.keys()]).toEqual(['a']);
		expect(candidateInput(cand({ slug: null }), undefined).blockers).toContain('folder-repo');
	});

	test('a clean, pushed, merged task is removed once its rule is on', () => {
		expect(cleanupTargets(verdicts(scan(cand())))).toEqual([{ slug: 'a', action: 'delete' }]);
	});

	test('a squash-merged branch (Rust: merged, nothing unpublished) is removed by the merged rule', () => {
		const c = cand({ merged: true, squashMerged: true, unpushed: false });
		expect(candidateInput(c, undefined).reasons).toEqual(['merged']);
		expect(cleanupTargets(verdicts(scan(c)))).toEqual([{ slug: 'a', action: 'delete' }]);
		// The same branch before the squash: not merged, and its commits are unpublished work.
		expect(verdicts(scan(cand({ merged: false, unpushed: true }))).get('a')!.evaluation).toMatchObject({ action: 'keep' });
	});

	test('a PR-merged branch (Rust: merged, nothing unpublished) is removed by the merged rule', () => {
		const c = cand({ merged: true, prMerged: true, unpushed: false });
		expect(candidateInput(c, undefined).reasons).toEqual(['merged']);
		expect(cleanupTargets(verdicts(scan(c)))).toEqual([{ slug: 'a', action: 'delete' }]);
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

	test('an inactive archive rule archives the task instead of deleting its worktree', () => {
		const rules = { ...getDefaultWorkspaceCleanupRules(), inactive: { enabled: true, afterDays: 1, action: 'archive' as const } };
		const v = verdicts(scan(cand({ merged: false })), resolveWorkspaceCleanupPolicy({ workspaceCleanupPolicy: rules })).get('a')!;
		expect(v.evaluation).toEqual({ action: 'archive', reason: 'inactive' });
		expect(cleanupTargets(new Map([['a', v]]))).toEqual([{ slug: 'a', action: 'archive' }]);
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

	test('the run receipt lists what was removed, archived, failed and how many were kept', () => {
		expect(cleanupReceipt(['a'], ['b'], [{ slug: 'c', error: 'x' }], 3)).toEqual({ removed: ['a'], archived: ['b'], failed: [{ slug: 'c', error: 'x' }], kept: 3 });
	});

	describe('the action loop rechecks each target', () => {
		const targets = [
			{ slug: 'a', action: 'delete' as const },
			{ slug: 'b', action: 'archive' as const },
			{ slug: 'c', action: 'delete' as const }
		];

		test('acts only on targets whose verdict still matches, and keeps one that changed since the scan', async () => {
			const calls: string[] = [];
			const out = await applyRechecked(targets, async (t) => t.slug !== 'b', async (t) => (calls.push(t.slug), t.slug !== 'c'));
			expect(calls).toEqual(['a', 'c']);
			expect(out).toEqual({ removed: ['a'], archived: [], failed: [{ slug: 'c', error: 'not removed (see Kingu)' }], skipped: 1 });
		});

		test('archives an archive target instead of removing it', async () => {
			const out = await applyRechecked(targets.slice(1, 2), async () => true, async () => true);
			expect(out).toEqual({ removed: [], archived: ['b'], failed: [], skipped: 0 });
		});

		test('a failed rescan stops the loop and keeps the receipts so far', async () => {
			const calls: string[] = [];
			const recheck = async (t: (typeof targets)[number]) => {
				if (t.slug === 'b') throw new Error('git broke');
				return true;
			};
			const out = await applyRechecked(targets, recheck, async (t) => (calls.push(t.slug), true));
			expect(calls).toEqual(['a']);
			expect(out).toEqual({ removed: ['a'], archived: [], failed: [{ slug: 'b', error: 'recheck failed: git broke' }], skipped: 1 });
		});
	});

	describe('automation runs and orchestration workers', () => {
		const rulesFor = (key: 'automationRuns' | 'orchestrationWorkers') => resolveWorkspaceCleanupPolicy({ workspaceCleanupPolicy: { ...getDefaultWorkspaceCleanupRules(), [key]: { enabled: true } } });
		const fin = (over: Partial<CleanupTaskContext>): CleanupTaskContext => ({ liveAgent: false, active: false, dirtyEditor: false, finished: true, ...over });
		const decide = (c: CleanupCandidate, ctx: CleanupTaskContext, key: 'automationRuns' | 'orchestrationWorkers') => evaluateScan(scan(c), rulesFor(key), () => ctx).get('a')!.evaluation;

		test('a finished automation run is removed by the automation rule, whether or not it merged', () => {
			expect(decide(cand({ merged: false }), fin({ origin: 'automation' }), 'automationRuns')).toEqual({ action: 'delete', reason: 'automation-run' });
		});

		test('a finished released worker whose work landed (merged or unchanged) is removed by the worker rule', () => {
			expect(decide(cand({ merged: true }), fin({ dispatchedBy: 'coordinator' }), 'orchestrationWorkers')).toEqual({ action: 'delete', reason: 'orchestration-worker' });
			expect(decide(cand({ merged: false, unchanged: true }), fin({ dispatchedBy: 'coordinator' }), 'orchestrationWorkers')).toEqual({ action: 'delete', reason: 'orchestration-worker' });
		});

		test('an unmerged released worker is kept: its work has not landed', () => {
			expect(candidateInput(cand({ merged: false }), fin({ dispatchedBy: 'coordinator' })).reasons).toEqual([]);
			expect(decide(cand({ merged: false }), fin({ dispatchedBy: 'coordinator' }), 'orchestrationWorkers')).toMatchObject({ action: 'keep', cause: 'no-rule-matched' });
		});

		test('a run or worker still going, or one you started yourself, is not a reason', () => {
			expect(decide(cand({ merged: false }), fin({ origin: 'automation', finished: false }), 'automationRuns')).toMatchObject({ action: 'keep', cause: 'no-rule-matched' });
			expect(decide(cand({ merged: false }), fin({ dispatchedBy: 'c', finished: false }), 'orchestrationWorkers')).toMatchObject({ action: 'keep', cause: 'no-rule-matched' });
			expect(decide(cand({ merged: false }), fin({}), 'automationRuns')).toMatchObject({ action: 'keep', cause: 'no-rule-matched' });
		});

		test('the other rule being on does not remove it, and a rule that is off removes nothing', () => {
			expect(decide(cand({ merged: false }), fin({ origin: 'automation' }), 'orchestrationWorkers')).toMatchObject({ action: 'keep', cause: 'no-rule-matched' });
			expect(evaluateScan(scan(cand({ merged: false })), resolveWorkspaceCleanupPolicy({}), () => fin({ origin: 'automation' })).get('a')!.evaluation).toEqual({ action: 'keep', cause: 'rules-off' });
		});

		test('work that could be lost still keeps a finished automation run or worker', () => {
			for (const over of [{ clean: false }, { unpushed: true }, { ignoredFiles: true }]) {
				const e = decide(cand({ merged: false, ...over }), fin({ origin: 'automation' }), 'automationRuns');
				expect([over, e.action]).toEqual([over, 'keep']);
			}
		});
	});
});

describe('candidateVerdict (the per-worktree recheck)', () => {
	test('matches evaluateScan for one candidate', () => {
		const c = cand();
		expect(candidateVerdict(c, merged, ctx[c.slug!], NOW)).toEqual(verdicts(scan(c)).get('a')!);
	});

	test('the main checkout and a worktree without a slug get no verdict', () => {
		expect(candidateVerdict(cand({ isMain: true }), merged, undefined, NOW)).toBeNull();
		expect(candidateVerdict(cand({ slug: null }), merged, undefined, NOW)).toBeNull();
	});

	test('a fact that changed since the scan changes the verdict', () => {
		expect(candidateVerdict(cand(), merged, undefined, NOW)?.evaluation.action).toBe('delete');
		expect(candidateVerdict(cand({ merged: false }), merged, undefined, NOW)?.evaluation.action).not.toBe('delete');
	});
});
