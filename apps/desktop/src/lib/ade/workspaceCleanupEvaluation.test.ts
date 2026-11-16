import { describe, expect, test } from 'bun:test';
import {
	WORKSPACE_CLEANUP_RULE_GRACE_MS,
	evaluateWorkspaceCleanup,
	type WorkspaceCleanupBlocker,
	type WorkspaceCleanupInput,
	type WorkspaceCleanupInputReason
} from './workspaceCleanupEvaluation';
import {
	getDefaultWorkspaceCleanupRules,
	resolveWorkspaceCleanupPolicy,
	type WorkspaceCleanupPolicy,
	type WorkspaceCleanupRules
} from './workspaceCleanupPolicy';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 16, 12);

const policy = (over: Partial<WorkspaceCleanupRules> = {}, source: WorkspaceCleanupPolicy['source'] = 'global'): WorkspaceCleanupPolicy => {
	const rules = { ...getDefaultWorkspaceCleanupRules(), ...over };
	return source === 'project-off'
		? resolveWorkspaceCleanupPolicy({ workspaceCleanupPolicy: rules }, { workspaceCleanupPolicy: { mode: 'off' } })
		: { source, rules, inactiveActionSupported: rules.inactive.action !== 'archive' };
};

const input = (over: Partial<WorkspaceCleanupInput> = {}): WorkspaceCleanupInput => ({
	reasons: [],
	blockers: [],
	git: { checkedAt: NOW, clean: true },
	lastActivityAt: NOW - 2 * 60 * 60 * 1000,
	...over
});

const withBlockers = (...blockers: WorkspaceCleanupBlocker[]) => input({ reasons: ['merged'], blockers });
const withReasons = (...reasons: WorkspaceCleanupInputReason[]) => input({ reasons });

describe('workspace cleanup evaluation', () => {
	test('no rule enabled keeps with rules-off', () => {
		expect(evaluateWorkspaceCleanup(input(), policy(), NOW)).toEqual({ action: 'keep', cause: 'rules-off' });
	});

	test('main worktrees and folder projects are never removable', () => {
		const merged = policy({ merged: { enabled: true } });
		expect(evaluateWorkspaceCleanup(input({ reasons: ['merged'], blockers: ['main-worktree'] }), merged, NOW)).toEqual({
			action: 'keep',
			cause: 'not-removable'
		});
		expect(evaluateWorkspaceCleanup(input({ reasons: ['merged'], blockers: ['folder-repo'] }), merged, NOW)).toEqual({
			action: 'keep',
			cause: 'not-removable'
		});
	});

	test('project-off keeps even when the global rules would delete', () => {
		const rules = policy({ merged: { enabled: true } });
		expect(evaluateWorkspaceCleanup(input({ reasons: ['merged'] }), { ...rules, source: 'project-off' }, NOW)).toEqual({
			action: 'keep',
			cause: 'project-off'
		});
	});

	test('pinned keeps a workspace the rules would otherwise remove', () => {
		expect(evaluateWorkspaceCleanup(withBlockers('pinned'), policy({ merged: { enabled: true } }), NOW)).toEqual({
			action: 'keep',
			cause: 'pinned'
		});
	});

	test('merged deletes only when the rule and reason are present', () => {
		const merged = policy({ merged: { enabled: true } });
		expect(evaluateWorkspaceCleanup(withReasons('merged'), merged, NOW)).toEqual({ action: 'delete', reason: 'merged' });
		expect(evaluateWorkspaceCleanup(input(), merged, NOW)).toEqual({ action: 'keep', cause: 'no-rule-matched' });
	});

	test('automation and orchestration rules delete their matching reason', () => {
		const automation = policy({ automationRuns: { enabled: true } });
		expect(evaluateWorkspaceCleanup(withReasons('automation-run'), automation, NOW)).toEqual({ action: 'delete', reason: 'automation-run' });
		const workers = policy({ orchestrationWorkers: { enabled: true } });
		expect(evaluateWorkspaceCleanup(withReasons('orchestration-worker'), workers, NOW)).toEqual({
			action: 'delete',
			reason: 'orchestration-worker'
		});
	});

	test('a rule touched within the hour is kept as recently active', () => {
		const recently = input({ reasons: ['merged'], lastActivityAt: NOW - WORKSPACE_CLEANUP_RULE_GRACE_MS + 1 });
		expect(evaluateWorkspaceCleanup(recently, policy({ merged: { enabled: true } }), NOW)).toEqual({
			action: 'keep',
			cause: 'recently-active',
			reason: 'merged'
		});
	});

	test('waiting shows the closest threshold', () => {
		const p = policy({ unchanged: { enabled: true, afterDays: 5 }, inactive: { enabled: true, afterDays: 30, action: 'delete' } });
		const waiting = input({ reasons: ['unchanged'], lastActivityAt: NOW - 2 * DAY });
		expect(evaluateWorkspaceCleanup(waiting, p, NOW)).toEqual({
			action: 'keep',
			cause: 'waiting',
			waiting: { elapsedDays: 2, afterDays: 5 }
		});
		const inactiveOnly = input({ lastActivityAt: NOW - 10 * DAY });
		expect(evaluateWorkspaceCleanup(inactiveOnly, p, NOW)).toEqual({
			action: 'keep',
			cause: 'waiting',
			waiting: { elapsedDays: 10, afterDays: 30 }
		});
	});

	test('unchanged needs both the reason and the threshold', () => {
		const unchanged = policy({ unchanged: { enabled: true, afterDays: 7 } });
		expect(evaluateWorkspaceCleanup(input({ reasons: ['unchanged'], lastActivityAt: NOW - 8 * DAY }), unchanged, NOW)).toEqual({
			action: 'delete',
			reason: 'unchanged'
		});
		expect(evaluateWorkspaceCleanup(input({ lastActivityAt: NOW - 8 * DAY }), unchanged, NOW)).toEqual({
			action: 'keep',
			cause: 'no-rule-matched'
		});
	});

	test('inactive is time-only and deletes past its threshold', () => {
		const inactive = policy({ inactive: { enabled: true, afterDays: 30, action: 'delete' } });
		expect(evaluateWorkspaceCleanup(input({ lastActivityAt: NOW - 31 * DAY }), inactive, NOW)).toEqual({
			action: 'delete',
			reason: 'inactive'
		});
	});

	test('an archive rule keeps when archive is unsupported', () => {
		const inactive = policy({ inactive: { enabled: true, afterDays: 1, action: 'archive' } });
		expect(inactive.inactiveActionSupported).toBe(false);
		expect(evaluateWorkspaceCleanup(input({ lastActivityAt: NOW - 2 * DAY }), inactive, NOW)).toEqual({
			action: 'keep',
			cause: 'archive-unavailable',
			reason: 'inactive'
		});
		expect(evaluateWorkspaceCleanup(input({ lastActivityAt: NOW - 2 * DAY }), { ...inactive, inactiveActionSupported: true }, NOW)).toEqual({
			action: 'archive',
			reason: 'inactive'
		});
	});

	test('protections follow their priority order', () => {
		const merged = policy({ merged: { enabled: true } });
		expect(evaluateWorkspaceCleanup(input({ reasons: ['merged'], blockers: ['live-agent', 'active-workspace'] }), merged, NOW)).toEqual({
			action: 'keep',
			cause: 'active-workspace',
			reason: 'merged'
		});
		expect(evaluateWorkspaceCleanup(withBlockers('live-agent'), merged, NOW)).toEqual({
			action: 'keep',
			cause: 'agent-running',
			reason: 'merged'
		});
		expect(evaluateWorkspaceCleanup(withBlockers('running-terminal'), merged, NOW)).toEqual({
			action: 'keep',
			cause: 'terminal-running',
			reason: 'merged'
		});
		expect(evaluateWorkspaceCleanup(withBlockers('terminal-liveness-unknown'), merged, NOW)).toEqual({
			action: 'keep',
			cause: 'terminal-unknown',
			reason: 'merged'
		});
		expect(evaluateWorkspaceCleanup(withBlockers('dirty-editor-buffer'), merged, NOW)).toEqual({
			action: 'keep',
			cause: 'unsaved-editor-changes',
			reason: 'merged'
		});
	});

	test('dirty, unpushed, ignored and unknown Git states keep work', () => {
		const merged = policy({ merged: { enabled: true } });
		expect(evaluateWorkspaceCleanup(input({ reasons: ['merged'], git: { checkedAt: NOW, clean: false } }), merged, NOW)).toEqual({
			action: 'keep',
			cause: 'uncommitted-changes',
			reason: 'merged'
		});
		expect(evaluateWorkspaceCleanup(input({ reasons: ['merged'], blockers: ['dirty-files'] }), merged, NOW)).toEqual({
			action: 'keep',
			cause: 'uncommitted-changes',
			reason: 'merged'
		});
		expect(evaluateWorkspaceCleanup(input({ reasons: ['merged'], blockers: ['unpushed-commits'] }), merged, NOW)).toEqual({
			action: 'keep',
			cause: 'unpushed-commits',
			reason: 'merged'
		});
		expect(evaluateWorkspaceCleanup(input({ reasons: ['merged'], blockers: ['unknown-base'] }), merged, NOW)).toEqual({
			action: 'keep',
			cause: 'git-unknown',
			reason: 'merged'
		});
		expect(evaluateWorkspaceCleanup(input({ reasons: ['merged'], git: { checkedAt: null, clean: true } }), merged, NOW)).toEqual({
			action: 'keep',
			cause: 'git-unknown',
			reason: 'merged'
		});
		expect(evaluateWorkspaceCleanup(input({ reasons: ['merged'], git: { checkedAt: NOW, clean: null } }), merged, NOW)).toEqual({
			action: 'keep',
			cause: 'git-unknown',
			reason: 'merged'
		});
	});

	test('ignored files protect only under any-local-files', () => {
		const anyLocal = policy({ merged: { enabled: true }, keepWhen: 'any-local-files' });
		expect(evaluateWorkspaceCleanup(input({ reasons: ['merged'], blockers: ['ignored-files'] }), anyLocal, NOW)).toEqual({
			action: 'keep',
			cause: 'ignored-files',
			reason: 'merged'
		});
		const uncommitted = policy({ merged: { enabled: true }, keepWhen: 'uncommitted' });
		expect(evaluateWorkspaceCleanup(input({ reasons: ['merged'], blockers: ['ignored-files'] }), uncommitted, NOW)).toEqual({
			action: 'delete',
			reason: 'merged'
		});
	});
});
