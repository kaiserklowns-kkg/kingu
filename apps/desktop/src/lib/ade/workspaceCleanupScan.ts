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
	/** Task's own last update (ms), so a turn that never touched Git still counts as activity. */
	updatedAt?: number;
	/** What started the task besides you (`automation`), and the task whose agent dispatched it (orchestration). */
	origin?: 'automation' | null;
	dispatchedBy?: string | null;
	/** The agent's work is over: not running and not waiting on you. Only a finished run or worker is a cleanup reason. */
	finished?: boolean;
};

export function candidateInput(c: CleanupCandidate, ctx: CleanupTaskContext | undefined): WorkspaceCleanupInput {
	const reasons: WorkspaceCleanupInputReason[] = [];
	if (c.merged) reasons.push('merged');
	if (c.unchanged) reasons.push('unchanged');
	// Finished automation runs and released orchestration workers (Orca's two other rules): what
	// started the task is the reason, and the protections below still keep any work that could be lost.
	if (ctx?.finished && ctx.origin === 'automation') reasons.push('automation-run');
	if (ctx?.finished && ctx.dispatchedBy) reasons.push('orchestration-worker');
	const blockers: WorkspaceCleanupBlocker[] = [];
	if (c.isMain) blockers.push('main-worktree');
	// A worktree Kingu did not create is not a task: it has no remove path here, so it is never offered.
	if (!c.slug) blockers.push('folder-repo');
	if (ctx?.active) blockers.push('active-workspace');
	if (ctx?.liveAgent) blockers.push('live-agent');
	if (ctx?.dirtyEditor) blockers.push('dirty-editor-buffer');
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

/** One verdict per task worktree (the main checkout and foreign worktrees are not tasks and get none). */
export function evaluateScan(scan: CleanupScan, policy: WorkspaceCleanupPolicy, contextOf: (slug: string) => CleanupTaskContext | undefined): Map<string, CleanupVerdict> {
	const out = new Map<string, CleanupVerdict>();
	for (const c of scan.candidates) {
		if (!c.slug || c.isMain) continue;
		out.set(c.slug, { slug: c.slug, path: c.path, evaluation: evaluateWorkspaceCleanup(candidateInput(c, contextOf(c.slug)), policy, scan.scannedAt) });
	}
	return out;
}

/** Slugs the rules say to remove now (archive is not offered: Kingu cannot archive yet). */
export const slugsToRemove = (verdicts: ReadonlyMap<string, CleanupVerdict>): string[] => [...verdicts.values()].filter((v) => v.evaluation.action === 'delete').map((v) => v.slug);

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

/** `kingu cleanup run`'s answer (Rust adds `requestId`; a replay adds `replayed`). */
export const cleanupReceipt = (removed: string[], failed: { slug: string; error: string }[], kept: number) => ({ removed, failed, kept });
