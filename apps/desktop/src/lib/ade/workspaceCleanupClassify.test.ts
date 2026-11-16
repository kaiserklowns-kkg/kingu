import { describe, expect, test } from 'bun:test';
import {
	LOCAL_EXECUTION_HOST_ID,
	WORKSPACE_CLEANUP_ARCHIVED_IDLE_MS,
	WORKSPACE_CLEANUP_CLASSIFIER_VERSION,
	WORKSPACE_CLEANUP_IDLE_MS,
	canQueueWorkspaceCleanupCandidate,
	createWorkspaceCleanupFingerprint,
	getPersistedWorkspaceCleanupActivityAt,
	getWorkspaceCleanupAutomationRunReasons,
	getWorkspaceCleanupCandidateHostId,
	getWorkspaceCleanupCandidateIdentity,
	getWorkspaceCleanupIdentityWorktreeId,
	getWorkspaceCleanupInactivityReasons,
	getWorkspaceCleanupMergeReasons,
	getWorkspaceCleanupOrchestrationWorkerReasons,
	getWorkspaceCleanupRemovalHostId,
	isFinalAutomationRunStatus,
	isWorkspaceCleanupHeadLanded,
	isWorkspaceOldForCleanup,
	needsWorkspaceCleanupRemovalApproval,
	normalizeExecutionHostId,
	shouldForceWorkspaceCleanupRemoval,
	shouldHideWorkspaceCleanupCandidate,
	toSshExecutionHostId,
	type WorkspaceCleanupCandidate
} from './workspaceCleanupClassify';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 16, 12);

const candidate = (over: Partial<WorkspaceCleanupCandidate> = {}): WorkspaceCleanupCandidate => ({
	worktreeId: 'wt-1',
	blockers: [],
	git: { checkedAt: NOW, clean: true },
	branch: 'feat/x',
	head: 'abc123',
	lastActivityAt: NOW - DAY,
	...over
});

describe('workspace cleanup classifiers', () => {
	test('merge reasons distinguish merged, unchanged and not landed', () => {
		expect(getWorkspaceCleanupMergeReasons()).toEqual([]);
		expect(getWorkspaceCleanupMergeReasons({ mergedReview: { containsHead: true } })).toEqual(['merged']);
		expect(getWorkspaceCleanupMergeReasons({ headInDefaultBranch: true, aheadOfDefault: 3 })).toEqual(['merged']);
		expect(getWorkspaceCleanupMergeReasons({ headInDefaultBranch: true, aheadOfDefault: 0, mergedReview: {} })).toEqual(['merged']);
		expect(getWorkspaceCleanupMergeReasons({ headInDefaultBranch: true, aheadOfDefault: 0 })).toEqual(['unchanged']);
		expect(getWorkspaceCleanupMergeReasons({ aheadOfDefault: 0 })).toEqual(['unchanged']);
		expect(getWorkspaceCleanupMergeReasons({ aheadOfDefault: 2 })).toEqual([]);
	});

	test('inactivity reasons use archived (7d) and inactive (30d) thresholds', () => {
		expect(getWorkspaceCleanupInactivityReasons({ isArchived: true, lastActivityAt: NOW - WORKSPACE_CLEANUP_ARCHIVED_IDLE_MS }, NOW)).toEqual([
			'archived'
		]);
		expect(getWorkspaceCleanupInactivityReasons({ isArchived: true, lastActivityAt: NOW - WORKSPACE_CLEANUP_IDLE_MS }, NOW)).toEqual([
			'archived',
			'inactive'
		]);
		expect(getWorkspaceCleanupInactivityReasons({ lastActivityAt: NOW - WORKSPACE_CLEANUP_IDLE_MS }, NOW)).toEqual(['inactive']);
		expect(getWorkspaceCleanupInactivityReasons({ isArchived: true, lastActivityAt: NOW - DAY }, NOW)).toEqual([]);
	});

	test('head landed checks default, review and coordinator branches', () => {
		expect(isWorkspaceCleanupHeadLanded()).toBe(false);
		expect(isWorkspaceCleanupHeadLanded({ headInDefaultBranch: true })).toBe(true);
		expect(isWorkspaceCleanupHeadLanded({ mergedReview: { containsHead: true } })).toBe(true);
		expect(isWorkspaceCleanupHeadLanded({ headInCoordinatorBranch: true })).toBe(true);
		expect(isWorkspaceCleanupHeadLanded({ mergedReview: { containsHead: false } })).toBe(false);
	});

	test('a released worker whose work landed can be cleaned', () => {
		expect(getWorkspaceCleanupOrchestrationWorkerReasons(true, { headInDefaultBranch: true })).toEqual(['orchestration-worker']);
		expect(getWorkspaceCleanupOrchestrationWorkerReasons(false, { headInDefaultBranch: true })).toEqual([]);
		expect(getWorkspaceCleanupOrchestrationWorkerReasons(true)).toEqual([]);
	});

	test('automation runs must be final and no longer hold a terminal', () => {
		expect(isFinalAutomationRunStatus('completed')).toBe(true);
		expect(isFinalAutomationRunStatus('running')).toBe(false);
		expect(getWorkspaceCleanupAutomationRunReasons({ automationRunId: 'run-1' }, () => ({ status: 'completed' }))).toEqual(['automation-run']);
		expect(getWorkspaceCleanupAutomationRunReasons({ automationRunId: 'run-1' }, () => ({ status: 'completed', terminalPtyId: 'pty' }))).toEqual([]);
		expect(getWorkspaceCleanupAutomationRunReasons({ automationRunId: 'run-1' }, () => ({ status: 'running' }))).toEqual([]);
		expect(getWorkspaceCleanupAutomationRunReasons(undefined, () => ({ status: 'completed' }))).toEqual([]);
		expect(getWorkspaceCleanupAutomationRunReasons({ origin: 'client', automationRunId: 'run-1' }, () => ({ status: 'completed' }))).toEqual([]);
	});

	test('persisted activity takes the newest of last activity, creation and terminal use', () => {
		expect(getPersistedWorkspaceCleanupActivityAt({})).toBe(0);
		expect(getPersistedWorkspaceCleanupActivityAt({ lastActivityAt: 3, createdAt: 7, lastTerminalUseAt: 5 })).toBe(7);
		expect(getPersistedWorkspaceCleanupActivityAt({ lastActivityAt: Number.NaN, createdAt: 7 })).toBe(7);
	});

	test('fingerprints bucket activity by day and record Git state', () => {
		const base = { branch: 'feat/x', head: 'abc', gitClean: true, lastActivityAt: NOW };
		expect(createWorkspaceCleanupFingerprint(base)).toBe(
			[WORKSPACE_CLEANUP_CLASSIFIER_VERSION, 'feat/x', 'abc', 'clean', Math.floor(NOW / DAY)].join('|')
		);
		expect(createWorkspaceCleanupFingerprint({ ...base, gitClean: null })).toContain('|unknown|');
		expect(createWorkspaceCleanupFingerprint({ ...base, gitClean: false })).toContain('|dirty|');
		expect(createWorkspaceCleanupFingerprint({ ...base, lastActivityAt: NOW + DAY })).not.toBe(createWorkspaceCleanupFingerprint(base));
	});

	test('host identity prefers an explicit host, then a connection, and fails removal closed', () => {
		expect(normalizeExecutionHostId(' local ')).toBe(LOCAL_EXECUTION_HOST_ID);
		expect(normalizeExecutionHostId('ssh:box')).toBe('ssh:box');
		expect(normalizeExecutionHostId('runtime:vm')).toBe('runtime:vm');
		expect(normalizeExecutionHostId('nope')).toBeNull();
		expect(toSshExecutionHostId('a b')).toBe('ssh:a%20b');
		expect(getWorkspaceCleanupRemovalHostId({ connectionId: 'box' })).toBe('ssh:box');
		expect(getWorkspaceCleanupRemovalHostId({ executionHostId: 'ssh:explicit', connectionId: 'box' })).toBe('ssh:explicit');
		expect(getWorkspaceCleanupRemovalHostId({})).toBeNull();
		expect(getWorkspaceCleanupCandidateHostId({})).toBe(LOCAL_EXECUTION_HOST_ID);
		const row = candidate({ executionHostId: 'ssh:box' });
		const identity = getWorkspaceCleanupCandidateIdentity(row);
		expect(identity).toBe(`ssh:box\0wt-1`);
		expect(getWorkspaceCleanupIdentityWorktreeId(identity)).toBe('wt-1');
		expect(getWorkspaceCleanupIdentityWorktreeId('wt-2')).toBe('wt-2');
	});

	test('queueing refuses main, folder and disconnected hosts', () => {
		expect(canQueueWorkspaceCleanupCandidate({ blockers: [] })).toBe(true);
		expect(canQueueWorkspaceCleanupCandidate({ blockers: ['main-worktree'] })).toBe(false);
		expect(canQueueWorkspaceCleanupCandidate({ blockers: ['folder-repo'] })).toBe(false);
		expect(canQueueWorkspaceCleanupCandidate({ blockers: ['ssh-disconnected'] })).toBe(false);
		expect(canQueueWorkspaceCleanupCandidate({ blockers: ['dirty-files'] })).toBe(true);
	});

	test('force and approval follow clean Git and risky blockers', () => {
		expect(shouldForceWorkspaceCleanupRemoval(candidate())).toBe(false);
		expect(shouldForceWorkspaceCleanupRemoval(candidate({ git: { checkedAt: NOW, clean: false } }))).toBe(true);
		expect(shouldForceWorkspaceCleanupRemoval(candidate({ git: { checkedAt: null, clean: true } }))).toBe(true);
		expect(shouldForceWorkspaceCleanupRemoval(candidate({ blockers: ['dirty-files'] }))).toBe(true);
		expect(shouldForceWorkspaceCleanupRemoval(candidate({ blockers: ['unpushed-commits'] }))).toBe(true);
		expect(shouldForceWorkspaceCleanupRemoval(candidate({ blockers: ['unknown-base'] }))).toBe(true);
		expect(needsWorkspaceCleanupRemovalApproval(candidate())).toBe(false);
		expect(needsWorkspaceCleanupRemovalApproval(candidate({ blockers: ['ignored-files'] }))).toBe(true);
		expect(needsWorkspaceCleanupRemovalApproval(candidate({ git: { checkedAt: NOW, clean: false } }))).toBe(true);
	});

	test('dismissal hides only the same fingerprint on the same host', () => {
		const row = candidate({ executionHostId: 'ssh:box' });
		const fingerprint = createWorkspaceCleanupFingerprint({
			branch: row.branch,
			head: row.head,
			gitClean: row.git.clean,
			lastActivityAt: row.lastActivityAt
		});
		const dismissal = {
			worktreeId: row.worktreeId,
			dismissedAt: NOW,
			fingerprint,
			classifierVersion: WORKSPACE_CLEANUP_CLASSIFIER_VERSION,
			executionHostId: 'ssh:box'
		};
		expect(shouldHideWorkspaceCleanupCandidate({ ...row, fingerprint }, dismissal)).toBe(true);
		expect(shouldHideWorkspaceCleanupCandidate({ ...row, fingerprint }, { ...dismissal, fingerprint: 'other' })).toBe(false);
		expect(shouldHideWorkspaceCleanupCandidate({ ...row, fingerprint }, { ...dismissal, classifierVersion: 1 })).toBe(false);
		expect(shouldHideWorkspaceCleanupCandidate({ ...row, fingerprint }, { ...dismissal, executionHostId: 'ssh:other' })).toBe(false);
		expect(shouldHideWorkspaceCleanupCandidate({ ...row, fingerprint }, { ...dismissal, executionHostId: undefined })).toBe(true);
	});

	test('old-for-cleanup is any inactivity reason', () => {
		expect(isWorkspaceOldForCleanup({ lastActivityAt: NOW - 31 * DAY }, NOW)).toBe(true);
		expect(isWorkspaceOldForCleanup({ isArchived: true, lastActivityAt: NOW - 8 * DAY }, NOW)).toBe(true);
		expect(isWorkspaceOldForCleanup({ lastActivityAt: NOW - DAY }, NOW)).toBe(false);
	});
});
