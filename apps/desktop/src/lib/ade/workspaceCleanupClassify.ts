// Orca 1.4.259's cleanup candidate classifiers and identity rules, ported from the installed
// app.asar (`out/shared/workspace-cleanup/workspace-cleanup.js` and
// `workspace-cleanup-host-identity.js`). These turn raw workspace facts into the `reasons` and
// `blockers` that workspaceCleanupEvaluation.ts consumes.

import type { WorkspaceCleanupBlocker, WorkspaceCleanupInputReason } from './workspaceCleanupEvaluation';

const DAY_MS = 24 * 60 * 60 * 1000;

export const WORKSPACE_CLEANUP_CLASSIFIER_VERSION = 2;
export const WORKSPACE_CLEANUP_ARCHIVED_IDLE_MS = 7 * DAY_MS;
export const WORKSPACE_CLEANUP_IDLE_MS = 30 * DAY_MS;
export const WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT = 500;

const WORKSPACE_CLEANUP_QUEUE_BLOCKERS = new Set<WorkspaceCleanupBlocker>(['main-worktree', 'folder-repo', 'ssh-disconnected']);
export const WORKSPACE_CLEANUP_FORCE_REMOVE_BLOCKERS = new Set<WorkspaceCleanupBlocker>(['dirty-files', 'unpushed-commits', 'unknown-base']);
// Active deletion uses sidebar-style focus handoff; live agents require stop confirmation at deletion,
// so neither blocks bulk selection.
export const WORKSPACE_CLEANUP_BULK_SELECT_EXCLUSIONS = new Set(['dismissed']);

export type WorkspaceCleanupCandidate = {
	worktreeId: string;
	executionHostId?: string | null;
	connectionId?: string | null;
	blockers: readonly WorkspaceCleanupBlocker[];
	git: { checkedAt: number | null; clean: boolean | null };
	branch: string;
	head: string;
	lastActivityAt: number;
};

export type WorkspaceCleanupDismissal = {
	worktreeId: string;
	dismissedAt: number;
	fingerprint: string;
	classifierVersion: number;
	executionHostId?: string;
};

export const LOCAL_EXECUTION_HOST_ID = 'local';
const IDENTITY_SEPARATOR = '\0';
const HOST_PREFIXES = ['ssh:', 'runtime:'];

/** Trims a stored id; blank is absent. Unknown spellings are rejected so removal cannot guess a host. */
export function normalizeExecutionHostId(value: string | null | undefined): string | null {
	const normalized = value?.trim();
	if (!normalized) return null;
	if (normalized === LOCAL_EXECUTION_HOST_ID) return normalized;
	return HOST_PREFIXES.some((prefix) => normalized.startsWith(prefix) && normalized.length > prefix.length) ? normalized : null;
}

export function toSshExecutionHostId(targetId: string): string {
	return `ssh:${encodeURIComponent(targetId)}`;
}

function resolveWorkspaceCleanupRemovalHostId(candidate: {
	executionHostId?: string | null;
	connectionId?: string | null;
}): string | null {
	const explicitHostId = normalizeExecutionHostId(candidate.executionHostId);
	if (explicitHostId) return explicitHostId;
	const connectionId = candidate.connectionId?.trim();
	return connectionId ? toSshExecutionHostId(connectionId) : null;
}

/** Legacy display/index rows need a bucket; destructive removal must never use this fallback. */
export function getWorkspaceCleanupCandidateHostId(candidate: {
	executionHostId?: string | null;
	connectionId?: string | null;
}): string {
	return resolveWorkspaceCleanupRemovalHostId(candidate) ?? LOCAL_EXECUTION_HOST_ID;
}

/** Require proven host ownership for removal. Old unqualified rows return null and must fail closed. */
export function getWorkspaceCleanupRemovalHostId(candidate: { executionHostId?: string | null; connectionId?: string | null }): string | null {
	return resolveWorkspaceCleanupRemovalHostId(candidate);
}

export function getWorkspaceCleanupHostIdentity(hostId: string, id: string): string {
	return `${hostId}${IDENTITY_SEPARATOR}${id}`;
}

export function getWorkspaceCleanupCandidateIdentity(candidate: WorkspaceCleanupCandidate): string {
	return getWorkspaceCleanupHostIdentity(getWorkspaceCleanupCandidateHostId(candidate), candidate.worktreeId);
}

export function getWorkspaceCleanupIdentityWorktreeId(identity: string): string {
	const separatorIndex = identity.indexOf(IDENTITY_SEPARATOR);
	return separatorIndex === -1 ? identity : identity.slice(separatorIndex + IDENTITY_SEPARATOR.length);
}

export function canQueueWorkspaceCleanupCandidate(candidate: { blockers: readonly WorkspaceCleanupBlocker[] }): boolean {
	return !candidate.blockers.some((blocker) => WORKSPACE_CLEANUP_QUEUE_BLOCKERS.has(blocker));
}

export function shouldForceWorkspaceCleanupRemoval(candidate: {
	git: { checkedAt: number | null; clean: boolean | null };
	blockers: readonly WorkspaceCleanupBlocker[];
}): boolean {
	return (
		candidate.git.clean !== true ||
		candidate.git.checkedAt === null ||
		candidate.blockers.some((blocker) => WORKSPACE_CLEANUP_FORCE_REMOVE_BLOCKERS.has(blocker))
	);
}

/** Rows the user must review before removal; ignored files never make git refuse, so they need no force. */
export function needsWorkspaceCleanupRemovalApproval(candidate: {
	git: { checkedAt: number | null; clean: boolean | null };
	blockers: readonly WorkspaceCleanupBlocker[];
}): boolean {
	return shouldForceWorkspaceCleanupRemoval(candidate) || candidate.blockers.includes('ignored-files');
}

export function createWorkspaceCleanupFingerprint(args: {
	branch: string;
	head: string;
	gitClean: boolean | null;
	lastActivityAt: number;
	classifierVersion?: number;
}): string {
	const version = args.classifierVersion ?? WORKSPACE_CLEANUP_CLASSIFIER_VERSION;
	const lastActivityBucket = Math.floor((args.lastActivityAt || 0) / DAY_MS);
	return [version, args.branch, args.head, args.gitClean === null ? 'unknown' : args.gitClean ? 'clean' : 'dirty', lastActivityBucket].join('|');
}

export function getWorkspaceCleanupInactivityReasons(
	workspace: { isArchived?: boolean; lastActivityAt: number },
	scannedAt: number
): WorkspaceCleanupInputReason[] {
	const reasons: WorkspaceCleanupInputReason[] = [];
	if (workspace.isArchived && scannedAt - workspace.lastActivityAt >= WORKSPACE_CLEANUP_ARCHIVED_IDLE_MS) reasons.push('archived');
	if (scannedAt - workspace.lastActivityAt >= WORKSPACE_CLEANUP_IDLE_MS) reasons.push('inactive');
	return reasons;
}

export function isWorkspaceCleanupHeadLanded(
	merge?: { headInDefaultBranch?: boolean; mergedReview?: { containsHead?: boolean }; headInCoordinatorBranch?: boolean }
): boolean {
	return merge !== undefined && (merge.headInDefaultBranch === true || merge.mergedReview?.containsHead === true || merge.headInCoordinatorBranch === true);
}

/** A workspace a worker start created, whose worker was released, and whose work already landed. */
export function getWorkspaceCleanupOrchestrationWorkerReasons(
	releasedWorker: boolean | undefined,
	merge?: { headInDefaultBranch?: boolean; mergedReview?: { containsHead?: boolean }; headInCoordinatorBranch?: boolean }
): WorkspaceCleanupInputReason[] {
	return releasedWorker && isWorkspaceCleanupHeadLanded(merge) ? ['orchestration-worker'] : [];
}

export function getWorkspaceCleanupMergeReasons(merge?: {
	mergedReview?: { containsHead?: boolean };
	headInDefaultBranch?: boolean;
	aheadOfDefault?: number;
}): WorkspaceCleanupInputReason[] {
	if (!merge) return [];
	// A Git-proved squash or rebase is a merge even when no review was cached for the branch.
	const merged =
		merge.mergedReview?.containsHead === true ||
		(merge.headInDefaultBranch === true && ((merge.aheadOfDefault ?? 0) > 0 || merge.mergedReview !== undefined));
	if (merged) return ['merged'];
	return merge.aheadOfDefault === 0 ? ['unchanged'] : [];
}

const FINAL_AUTOMATION_RUN_STATUSES = new Set([
	'completed',
	'dispatch_failed',
	'skipped_precheck',
	'skipped_missed',
	'skipped_unavailable',
	'skipped_needs_interactive_auth'
]);

/** Statuses a run can never leave; only these are safe to evict from history. */
export function isFinalAutomationRunStatus(status: string): boolean {
	return FINAL_AUTOMATION_RUN_STATUSES.has(status);
}

export function getWorkspaceCleanupAutomationRunReasons(
	provenance: { origin?: string; automationRunId: string } | undefined,
	findRun: (automationRunId: string) => { status: string; terminalPtyId?: string | null } | undefined
): WorkspaceCleanupInputReason[] {
	// A client-origin label names another owner's run, which this host cannot see finish.
	if (!provenance || provenance.origin === 'client') return [];
	const run = findRun(provenance.automationRunId);
	return run && isFinalAutomationRunStatus(run.status) && !run.terminalPtyId ? ['automation-run'] : [];
}

/** Newest activity stamp Orca itself persisted; 0 when it never observed the workspace. */
export function getPersistedWorkspaceCleanupActivityAt(workspace: {
	lastActivityAt?: number;
	createdAt?: number;
	lastTerminalUseAt?: number;
}): number {
	const lastActivityAt = Number.isFinite(workspace.lastActivityAt) ? (workspace.lastActivityAt ?? 0) : 0;
	const createdAt = Number.isFinite(workspace.createdAt) ? (workspace.createdAt ?? 0) : 0;
	// Written only by a sidebar-inputs host; absent on every other build.
	const terminalUseAt = Number.isFinite(workspace.lastTerminalUseAt) ? (workspace.lastTerminalUseAt ?? 0) : 0;
	return Math.max(lastActivityAt, createdAt, terminalUseAt);
}

export function isWorkspaceOldForCleanup(workspace: { isArchived?: boolean; lastActivityAt: number }, scannedAt: number): boolean {
	return getWorkspaceCleanupInactivityReasons(workspace, scannedAt).length > 0;
}

export function shouldHideWorkspaceCleanupCandidate(
	candidate: { worktreeId: string; fingerprint: string; executionHostId?: string | null; connectionId?: string | null },
	dismissal?: WorkspaceCleanupDismissal
): boolean {
	return (
		dismissal?.worktreeId === candidate.worktreeId &&
		dismissal.fingerprint === candidate.fingerprint &&
		dismissal.classifierVersion === WORKSPACE_CLEANUP_CLASSIFIER_VERSION &&
		// New dismissals hide only their host's row; legacy unqualified ones retain fingerprint-only matching.
		(dismissal.executionHostId === undefined || dismissal.executionHostId === getWorkspaceCleanupCandidateHostId(candidate))
	);
}
