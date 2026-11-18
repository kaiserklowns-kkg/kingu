// Workspace Cleanup, scan side: turns what Rust's `workspace_cleanup_scan` read from Git
// (src-tauri/src/workspace_cleanup.rs) and what the app knows about a task into the
// `WorkspaceCleanupInput` of the one evaluator (workspaceCleanupEvaluation.ts), and says what each
// task's verdict is. Pure, so the dialog, a CLI preview and an automatic run decide the same way.

import {
	evaluateWorkspaceCleanup,
	type WorkspaceCleanupBlocker,
	type WorkspaceCleanupEvaluation,
	type WorkspaceCleanupInput,
	type WorkspaceCleanupInputReason
} from './workspaceCleanupEvaluation';
import type { WorkspaceCleanupPolicy } from './workspaceCleanupPolicy';
import { formatWorkspaceCleanupKeepCause, formatWorkspaceCleanupRuleReason } from './workspaceCleanupVerdict';

/** Rust `workspace_cleanup::Candidate`. */
export type CleanupCandidate = {
	path: string;
	branch: string | null;
	head: string | null;
	slug: string | null;
	isMain: boolean;
	detached: boolean;
	locked: boolean;
	checkedAt: number | null;
	clean: boolean | null;
	ignoredFiles: boolean;
	unpushed: boolean;
	merged: boolean;
	unchanged: boolean;
	/** Squash / rebase merged: everything the branch changed is in the base with the same content (Rust sets `merged` and clears `unpushed` with it). */
	squashMerged: boolean;
	/** A merged GitHub PR, GitLab MR or Bitbucket PR whose head commit is this worktree's HEAD (Rust sets `merged` and clears `unpushed` with it). */
	prMerged: boolean;
	unknownBase: boolean;
	base: string | null;
	error: string | null;
	lastActivityAt: number;
};

/** Rust `workspace_cleanup::Scan`. */
export type CleanupScan = { scannedAt: number; candidates: CleanupCandidate[] };
/** Rust `workspace_cleanup::Size`: `sizeBytes` is null when the folder could not be measured. */
export type CleanupSize = { path: string; sizeBytes: number | null };
export type CleanupProgress = { scanned: number; total: number; current: string | null };

/** What only the app knows about a task. */
export type CleanupTaskContext = {
	/** The agent works, waits on you, or its session is still open in the worktree. */
	liveAgent: boolean;
	/** The task is the one open in the editor area now. */
	active: boolean;
	/** An editor of the task's files (or an edited diff) has unsaved changes. */
	dirtyEditor: boolean;
	/** The task has a terminal tab open: a live PTY that removing the worktree would kill. */
	runningTerminal?: boolean;
	/** Task's own last update (ms), so a turn that never touched Git still counts as activity. */
	updatedAt?: number;
	/** What started the task besides you (`automation`, `cli`), and the task whose agent dispatched it (orchestration). */
	origin?: 'automation' | 'cli' | null;
	dispatchedBy?: string | null;
	/** The agent's work is over: not running and not waiting on you. Only a finished run or worker is a cleanup reason. */
	finished?: boolean;
	/** Pinned in the side bar for this folder: the user asked to keep it in sight, so cleanup never touches it. */
	pinned?: boolean;
	/** Already archived: its worktree is still there, so a later run must not archive it again. */
	archived?: boolean;
};

export function candidateInput(c: CleanupCandidate, ctx: CleanupTaskContext | undefined): WorkspaceCleanupInput {
	const reasons: WorkspaceCleanupInputReason[] = [];
	if (c.merged) reasons.push('merged');
	if (c.unchanged) reasons.push('unchanged');
	// Finished automation runs and released orchestration workers (Orca's two other rules): what
	// started the task is the reason, and the protections below still keep any work that could be lost.
	// A worker counts only once its work has landed (merged, or nothing changed), as in Orca.
	if (ctx?.finished && ctx.origin === 'automation') reasons.push('automation-run');
	if (ctx?.finished && ctx.dispatchedBy && (c.merged || c.unchanged)) reasons.push('orchestration-worker');
	if (ctx?.archived) reasons.push('archived');
	const blockers: WorkspaceCleanupBlocker[] = [];
	if (c.isMain) blockers.push('main-worktree');
	// A worktree Kingu did not create is not a task: it has no remove path here, so it is never offered.
	if (!c.slug) blockers.push('folder-repo');
	if (ctx?.active) blockers.push('active-workspace');
	if (ctx?.liveAgent) blockers.push('live-agent');
	if (ctx?.runningTerminal) blockers.push('running-terminal');
	if (ctx?.dirtyEditor) blockers.push('dirty-editor-buffer');
	if (ctx?.pinned) blockers.push('pinned');
	if (c.clean === false) blockers.push('dirty-files');
	if (c.unpushed) blockers.push('unpushed-commits');
	if (c.ignoredFiles) blockers.push('ignored-files');
	if (c.error) blockers.push('git-status-error');
	// `unknownBase` is not a blocker: it only means `merged` / `unchanged` cannot be told, and what
	// removal could lose (uncommitted or unpushed work) is already guarded above.
	return {
		reasons,
		blockers,
		git: { checkedAt: c.checkedAt, clean: c.clean },
		lastActivityAt: Math.max(c.lastActivityAt, ctx?.updatedAt ?? 0)
	};
}

export type CleanupVerdict = { slug: string; path: string; evaluation: WorkspaceCleanupEvaluation };

/** One worktree's verdict at `at`; null for the main checkout and foreign worktrees (not tasks). */
export function candidateVerdict(c: CleanupCandidate, policy: WorkspaceCleanupPolicy, ctx: CleanupTaskContext | undefined, at: number): CleanupVerdict | null {
	if (!c.slug || c.isMain) return null;
	return { slug: c.slug, path: c.path, evaluation: evaluateWorkspaceCleanup(candidateInput(c, ctx), policy, at) };
}

/** One verdict per task worktree. */
export function evaluateScan(scan: CleanupScan, policy: WorkspaceCleanupPolicy, contextOf: (slug: string) => CleanupTaskContext | undefined): Map<string, CleanupVerdict> {
	const out = new Map<string, CleanupVerdict>();
	for (const c of scan.candidates) {
		const v = c.slug ? candidateVerdict(c, policy, contextOf(c.slug), scan.scannedAt) : null;
		if (v) out.set(v.slug, v);
	}
	return out;
}

export type CleanupAction = 'delete' | 'archive';
export type CleanupTarget = { slug: string; action: CleanupAction };

/** Tasks the rules say to act on now, with the action the evaluator chose. */
export const cleanupTargets = (verdicts: ReadonlyMap<string, CleanupVerdict>): CleanupTarget[] =>
	[...verdicts.values()].flatMap((v) => (v.evaluation.action === 'keep' ? [] : [{ slug: v.slug, action: v.evaluation.action }]));

const RULE_KEYS = ['merged', 'unchanged', 'inactive', 'automationRuns', 'orchestrationWorkers'] as const;

/** `kingu cleanup preview`'s answer: `rules` names what is on (`off` when nothing is), each task its verdict in plain words. */
export function cleanupPreview(policy: WorkspaceCleanupPolicy, verdicts: ReadonlyMap<string, CleanupVerdict>) {
	const on = RULE_KEYS.filter((k) => policy.rules[k].enabled);
	const rules = policy.source === 'project-off' ? 'off (this project)' : on.length ? on.join('+') : 'off';
	const tasks = [...verdicts.values()].map(({ slug, evaluation: e }) => ({
		slug,
		action: e.action,
		label: e.action === 'keep' ? formatWorkspaceCleanupKeepCause(e.cause, e.waiting) : formatWorkspaceCleanupRuleReason(e.reason)
	}));
	return { rules, tasks };
}

/**
 * The action loop of a run: each target is checked again right before it goes (`recheck` says
 * whether the same action is still what the rules choose; it throws when the fresh read fails), so
 * a task that changed since the scan is kept. A failed recheck stops the loop: that target is
 * failed, the rest are not touched. `skipped` counts targets left alone (no longer one, or never
 * reached).
 */
export async function applyRechecked(
	targets: readonly CleanupTarget[],
	recheck: (target: CleanupTarget) => Promise<boolean>,
	apply: (target: CleanupTarget) => Promise<boolean>
): Promise<{ removed: string[]; archived: string[]; failed: { slug: string; error: string }[]; skipped: number }> {
	const removed: string[] = [];
	const archived: string[] = [];
	const failed: { slug: string; error: string }[] = [];
	let skipped = 0;
	const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
	for (const [i, target] of targets.entries()) {
		let still: boolean;
		try {
			still = await recheck(target);
		} catch (e) {
			failed.push({ slug: target.slug, error: `recheck failed: ${message(e)}` });
			skipped += targets.length - i - 1;
			break;
		}
		if (!still) {
			skipped++;
			continue;
		}
		try {
			if (await apply(target)) (target.action === 'archive' ? archived : removed).push(target.slug);
			else failed.push({ slug: target.slug, error: target.action === 'archive' ? 'not archived (see Kingu)' : 'not removed (see Kingu)' });
		} catch (e) {
			failed.push({ slug: target.slug, error: message(e) });
		}
	}
	return { removed, archived, failed, skipped };
}

/** `kingu cleanup run`'s answer (Rust adds `requestId`; a replay adds `replayed`). */
export const cleanupReceipt = (removed: string[], archived: string[], failed: { slug: string; error: string }[], kept: number) => ({ removed, archived, failed, kept });
