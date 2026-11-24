// Orca 1.4.259's Workspace Cleanup evaluator, ported from the installed app.asar
// (`out/shared/workspace-cleanup/workspace-cleanup-evaluation.js`). This is the one decision every
// cleanup entry point (UI, CLI preview/run, auto-run) shares; do not add a second rule here.

import { hasEnabledWorkspaceCleanupRule, type WorkspaceCleanupPolicy } from './workspaceCleanupPolicy';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A workspace touched this recently may still be in use (a merged branch just checked out to read it). */
export const WORKSPACE_CLEANUP_RULE_GRACE_MS = 60 * 60 * 1000;

/** `main-worktree` and `folder-repo` are never removable, whatever the rules say. */
export const WORKSPACE_CLEANUP_NOT_REMOVABLE_BLOCKERS = new Set<WorkspaceCleanupBlocker>(['main-worktree', 'folder-repo']);

export type WorkspaceCleanupBlocker =
	| 'main-worktree'
	| 'folder-repo'
	| 'active-workspace'
	| 'live-agent'
	| 'running-terminal'
	| 'terminal-liveness-unknown'
	| 'dirty-editor-buffer'
	| 'dirty-files'
	| 'unpushed-commits'
	| 'ignored-files'
	| 'unknown-base'
	| 'git-status-error'
	| 'ssh-disconnected'
	| 'pinned';

export type WorkspaceCleanupInputReason = 'merged' | 'unchanged' | 'inactive' | 'archived' | 'automation-run' | 'orchestration-worker';
export type WorkspaceCleanupRuleReason = Exclude<WorkspaceCleanupInputReason, 'archived'>;

export type WorkspaceCleanupKeepCause =
	| 'not-removable'
	| 'project-off'
	| 'rules-off'
	| 'pinned'
	| 'already-archived'
	| 'no-rule-matched'
	| 'waiting'
	| 'recently-active'
	| 'active-workspace'
	| 'agent-running'
	| 'terminal-running'
	| 'terminal-unknown'
	| 'unsaved-editor-changes'
	| 'uncommitted-changes'
	| 'unpushed-commits'
	| 'ignored-files'
	| 'git-unknown'
	| 'archive-script'
	| 'removing';

export type WorkspaceCleanupWaiting = { elapsedDays: number; afterDays: number };

export type WorkspaceCleanupInput = {
	reasons: readonly WorkspaceCleanupInputReason[];
	blockers: readonly WorkspaceCleanupBlocker[];
	/** Fresh proof only: `checkedAt: null` or `clean: null` means Git status unknown, which is never removable. */
	git: { checkedAt: number | null; clean: boolean | null };
	lastActivityAt: number;
};

export type WorkspaceCleanupEvaluation =
	| { action: 'delete'; reason: WorkspaceCleanupRuleReason }
	| { action: 'archive'; reason: 'inactive' }
	| { action: 'keep'; cause: WorkspaceCleanupKeepCause; reason?: WorkspaceCleanupRuleReason; waiting?: WorkspaceCleanupWaiting };

// Priority order: the first present blocker names the keep cause.
const PROTECTIONS: readonly (readonly [WorkspaceCleanupBlocker, WorkspaceCleanupKeepCause])[] = [
	['active-workspace', 'active-workspace'],
	['live-agent', 'agent-running'],
	['running-terminal', 'terminal-running'],
	['terminal-liveness-unknown', 'terminal-unknown'],
	['dirty-editor-buffer', 'unsaved-editor-changes'],
	['dirty-files', 'uncommitted-changes'],
	['unpushed-commits', 'unpushed-commits'],
	['ignored-files', 'ignored-files'],
	['unknown-base', 'git-unknown'],
	['git-status-error', 'git-unknown'],
	['ssh-disconnected', 'git-unknown']
];

type RuleMatch = { reason: WorkspaceCleanupRuleReason } | { waiting: WorkspaceCleanupWaiting };

function timeRuleMatch(reason: WorkspaceCleanupRuleReason, afterDays: number, elapsedMs: number): RuleMatch {
	return elapsedMs >= afterDays * DAY_MS
		? { reason }
		: { waiting: { elapsedDays: Math.floor(Math.max(0, elapsedMs) / DAY_MS), afterDays } };
}

function matchRules(input: WorkspaceCleanupInput, policy: WorkspaceCleanupPolicy, elapsedMs: number): RuleMatch[] {
	const { rules } = policy;
	const matches: RuleMatch[] = [];
	if (rules.merged.enabled && input.reasons.includes('merged')) matches.push({ reason: 'merged' });
	if (rules.automationRuns.enabled && input.reasons.includes('automation-run')) matches.push({ reason: 'automation-run' });
	if (rules.orchestrationWorkers.enabled && input.reasons.includes('orchestration-worker'))
		matches.push({ reason: 'orchestration-worker' });
	if (rules.unchanged.enabled && input.reasons.includes('unchanged'))
		matches.push(timeRuleMatch('unchanged', rules.unchanged.afterDays, elapsedMs));
	if (rules.inactive.enabled) matches.push(timeRuleMatch('inactive', rules.inactive.afterDays, elapsedMs));
	return matches;
}

function closestWaiting(matches: RuleMatch[]): WorkspaceCleanupWaiting | undefined {
	let closest: WorkspaceCleanupWaiting | undefined;
	for (const match of matches) {
		if (
			'waiting' in match &&
			(!closest || match.waiting.afterDays - match.waiting.elapsedDays < closest.afterDays - closest.elapsedDays)
		) {
			closest = match.waiting;
		}
	}
	return closest;
}

function protectionCause(input: WorkspaceCleanupInput, policy: WorkspaceCleanupPolicy): WorkspaceCleanupKeepCause | null {
	for (const [blocker, cause] of PROTECTIONS) {
		if (blocker === 'ignored-files' && policy.rules.keepWhen !== 'any-local-files') continue;
		if (input.blockers.includes(blocker)) return cause;
	}
	// Removal needs fresh proof that nothing is uncommitted; absent evidence is never clean.
	if (input.git.checkedAt === null || input.git.clean === null) return 'git-unknown';
	return input.git.clean ? null : 'uncommitted-changes';
}

/** The one decision every cleanup entry point shares: what the runner does with a workspace now. */
export function evaluateWorkspaceCleanup(
	input: WorkspaceCleanupInput,
	policy: WorkspaceCleanupPolicy,
	now: number
): WorkspaceCleanupEvaluation {
	if (input.blockers.some((blocker) => WORKSPACE_CLEANUP_NOT_REMOVABLE_BLOCKERS.has(blocker))) {
		return { action: 'keep', cause: 'not-removable' };
	}
	if (policy.source === 'project-off') return { action: 'keep', cause: 'project-off' };
	if (!hasEnabledWorkspaceCleanupRule(policy.rules)) return { action: 'keep', cause: 'rules-off' };
	if (input.blockers.includes('pinned')) return { action: 'keep', cause: 'pinned' };
	if (input.reasons.includes('archived')) return { action: 'keep', cause: 'already-archived' };

	const elapsedMs = now - input.lastActivityAt;
	const matches = matchRules(input, policy, elapsedMs);
	const matched = matches.find((match): match is { reason: WorkspaceCleanupRuleReason } => 'reason' in match);
	if (!matched) {
		const waiting = closestWaiting(matches);
		return waiting ? { action: 'keep', cause: 'waiting', waiting } : { action: 'keep', cause: 'no-rule-matched' };
	}

	const { reason } = matched;
	if (elapsedMs < WORKSPACE_CLEANUP_RULE_GRACE_MS) return { action: 'keep', cause: 'recently-active', reason };

	const protection = protectionCause(input, policy);
	if (protection) return { action: 'keep', cause: protection, reason };

	if (reason !== 'inactive' || policy.rules.inactive.action === 'delete') return { action: 'delete', reason };
	return { action: 'archive', reason };
}
