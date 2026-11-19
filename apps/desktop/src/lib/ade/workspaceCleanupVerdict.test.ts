import { describe, expect, test } from 'bun:test';
import { formatWorkspaceCleanupKeepCause, formatWorkspaceCleanupRuleReason } from './workspaceCleanupVerdict';

describe('workspace cleanup labels', () => {
	test('rule reasons use plain words', () => {
		expect(formatWorkspaceCleanupRuleReason('merged')).toBe('merged');
		expect(formatWorkspaceCleanupRuleReason('unchanged')).toBe('no changes');
		expect(formatWorkspaceCleanupRuleReason('inactive')).toBe('inactive');
		expect(formatWorkspaceCleanupRuleReason('automation-run')).toBe('finished automation run');
		expect(formatWorkspaceCleanupRuleReason('orchestration-worker')).toBe('released orchestration worker');
	});

	test('keep causes use plain words and waiting includes both numbers', () => {
		expect(formatWorkspaceCleanupKeepCause('rules-off')).toBe('no rule on');
		expect(formatWorkspaceCleanupKeepCause('uncommitted-changes')).toBe('uncommitted changes');
		expect(formatWorkspaceCleanupKeepCause('already-archived')).toBe('already archived');
		expect(formatWorkspaceCleanupKeepCause('waiting', { elapsedDays: 3, afterDays: 7 })).toBe('waiting 3 of 7 days');
	});
});
