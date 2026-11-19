import { describe, expect, test } from 'bun:test';
import {
	WORKSPACE_CLEANUP_POLICY_MAX_DAYS,
	WORKSPACE_CLEANUP_POLICY_MIN_DAYS,
	getDefaultWorkspaceCleanupRules,
	hasEnabledWorkspaceCleanupRule,
	normalizeRepoWorkspaceCleanupPolicy,
	normalizeWorkspaceCleanupRules,
	resolveWorkspaceCleanupPolicy,
	withEveryRuleOff,
	type WorkspaceCleanupRules
} from './workspaceCleanupPolicy';

const rules = (over: Partial<WorkspaceCleanupRules> = {}): WorkspaceCleanupRules => ({ ...getDefaultWorkspaceCleanupRules(), ...over });

describe('workspace cleanup policy', () => {
	test('every rule is off by default, so nothing is deleted', () => {
		const all = getDefaultWorkspaceCleanupRules();
		expect(hasEnabledWorkspaceCleanupRule(all)).toBe(false);
		expect(all.unchanged.afterDays).toBe(1);
		expect(all.inactive).toEqual({ enabled: false, afterDays: 30, action: 'archive' });
		expect(all.keepWhen).toBe('any-local-files');
	});

	test('normalize repairs each field independently and clamps days', () => {
		expect(normalizeWorkspaceCleanupRules(undefined)).toEqual(getDefaultWorkspaceCleanupRules());
		const fixed = normalizeWorkspaceCleanupRules({
			merged: { enabled: 'yes' },
			unchanged: { enabled: true, afterDays: 0 },
			inactive: { enabled: true, afterDays: 99_999, action: 'nope' },
			automationRuns: { enabled: true },
			orchestrationWorkers: { enabled: 'no' },
			keepWhen: 'nope'
		});
		expect(fixed.merged.enabled).toBe(false);
		expect(fixed.unchanged).toEqual({ enabled: true, afterDays: WORKSPACE_CLEANUP_POLICY_MIN_DAYS });
		expect(fixed.inactive.afterDays).toBe(WORKSPACE_CLEANUP_POLICY_MAX_DAYS);
		expect(fixed.inactive.action).toBe('archive');
		expect(fixed.automationRuns.enabled).toBe(true);
		expect(fixed.orchestrationWorkers.enabled).toBe(false);
		expect(fixed.keepWhen).toBe('any-local-files');
	});

	test('normalizeRepo accepts only off and custom, repairing custom rules', () => {
		expect(normalizeRepoWorkspaceCleanupPolicy({ mode: 'off' })).toEqual({ mode: 'off' });
		const custom = normalizeRepoWorkspaceCleanupPolicy({ mode: 'custom', rules: { merged: { enabled: true } } });
		expect(custom?.mode).toBe('custom');
		expect(custom?.mode === 'custom' && custom.rules.merged.enabled).toBe(true);
		expect(custom?.mode === 'custom' && custom.rules.inactive.action).toBe('archive');
		expect(normalizeRepoWorkspaceCleanupPolicy({ mode: 'nope' })).toBeUndefined();
		expect(normalizeRepoWorkspaceCleanupPolicy(null)).toBeUndefined();
	});

	test('global rules inherit unless the project overrides them', () => {
		const global = rules({ merged: { enabled: true } });
		expect(resolveWorkspaceCleanupPolicy({ workspaceCleanupPolicy: global })).toEqual({
			source: 'global',
			rules: global
		});
		expect(resolveWorkspaceCleanupPolicy({ workspaceCleanupPolicy: global }, { workspaceCleanupPolicy: { mode: 'off' } }).source).toBe('project-off');
		expect(
			resolveWorkspaceCleanupPolicy({ workspaceCleanupPolicy: global }, { workspaceCleanupPolicy: { mode: 'custom', rules: rules({ merged: { enabled: true } }) } })
				.source
		).toBe('project-custom');
	});

	test('project-off turns every rule off but keeps thresholds and protections', () => {
		const global = rules({ inactive: { enabled: true, afterDays: 7, action: 'delete' }, keepWhen: 'uncommitted' });
		const resolved = resolveWorkspaceCleanupPolicy(
			{ workspaceCleanupPolicy: global },
			{ workspaceCleanupPolicy: { mode: 'off' } }
		);
		expect(hasEnabledWorkspaceCleanupRule(resolved.rules)).toBe(false);
		expect(resolved.rules.inactive).toEqual({ enabled: false, afterDays: 7, action: 'delete' });
		expect(resolved.rules.keepWhen).toBe('uncommitted');
	});

	test('withEveryRuleOff keeps thresholds and protections', () => {
		const off = withEveryRuleOff(rules({ inactive: { enabled: true, afterDays: 7, action: 'delete' }, keepWhen: 'uncommitted' }));
		expect(hasEnabledWorkspaceCleanupRule(off)).toBe(false);
		expect(off.inactive).toEqual({ enabled: false, afterDays: 7, action: 'delete' });
		expect(off.keepWhen).toBe('uncommitted');
	});
});
