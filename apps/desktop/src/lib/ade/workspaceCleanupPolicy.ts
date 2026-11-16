// Orca 1.4.259's Workspace Cleanup policy, ported from the installed app.asar
// (`out/shared/workspace-cleanup/workspace-cleanup-policy.js`; see
// docs/REA-essence-vscode-orca-cursor.md §9). Rules are off by default; a project can turn cleanup
// off or replace the global rules. Archive is not supported yet, so an archive rule is resolved as
// unavailable instead of silently deleting.

export const WORKSPACE_CLEANUP_POLICY_MIN_DAYS = 1;
export const WORKSPACE_CLEANUP_POLICY_MAX_DAYS = 3650;
/** 'uncommitted' keeps uncommitted and unpushed work; 'any-local-files' also keeps ignored files such as .env. */
export const WORKSPACE_CLEANUP_KEEP_WHEN_VALUES = ['uncommitted', 'any-local-files'] as const;
export const WORKSPACE_CLEANUP_INACTIVE_ACTIONS = ['delete', 'archive'] as const;
export const WORKSPACE_CLEANUP_RULE_KEYS = ['merged', 'unchanged', 'inactive', 'automationRuns', 'orchestrationWorkers'] as const;
export const WORKSPACE_ARCHIVE_SUPPORTED = false;

export type WorkspaceCleanupKeepWhen = (typeof WORKSPACE_CLEANUP_KEEP_WHEN_VALUES)[number];
export type WorkspaceCleanupInactiveAction = (typeof WORKSPACE_CLEANUP_INACTIVE_ACTIONS)[number];
export type WorkspaceCleanupRuleKey = (typeof WORKSPACE_CLEANUP_RULE_KEYS)[number];

export type WorkspaceCleanupRules = {
	merged: { enabled: boolean };
	unchanged: { enabled: boolean; afterDays: number };
	inactive: { enabled: boolean; afterDays: number; action: WorkspaceCleanupInactiveAction };
	automationRuns: { enabled: boolean };
	orchestrationWorkers: { enabled: boolean };
	keepWhen: WorkspaceCleanupKeepWhen;
};

/** A project's override: `off`, its own rules, or absent to inherit the global rules. */
export type RepoWorkspaceCleanupPolicy = { mode: 'off' } | { mode: 'custom'; rules: WorkspaceCleanupRules };

export type WorkspaceCleanupPolicySource = 'global' | 'project-custom' | 'project-off';

export type WorkspaceCleanupPolicy = {
	source: WorkspaceCleanupPolicySource;
	rules: WorkspaceCleanupRules;
	inactiveActionSupported: boolean;
};

export function hasEnabledWorkspaceCleanupRule(rules: WorkspaceCleanupRules): boolean {
	return WORKSPACE_CLEANUP_RULE_KEYS.some((key) => rules[key].enabled);
}

export function getDefaultWorkspaceCleanupRules(): WorkspaceCleanupRules {
	return {
		merged: { enabled: false },
		unchanged: { enabled: false, afterDays: 1 },
		inactive: { enabled: false, afterDays: 30, action: 'archive' },
		automationRuns: { enabled: false },
		orchestrationWorkers: { enabled: false },
		keepWhen: 'any-local-files'
	};
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const readRule = (value: unknown, key: WorkspaceCleanupRuleKey) => (isRecord(value) && isRecord(value[key]) ? value[key] : {});
const normalizeEnabled = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
const normalizeDays = (value: unknown, fallback: number) =>
	typeof value === 'number' && Number.isFinite(value)
		? Math.min(WORKSPACE_CLEANUP_POLICY_MAX_DAYS, Math.max(WORKSPACE_CLEANUP_POLICY_MIN_DAYS, Math.round(value)))
		: fallback;
const includesValue = <T extends string>(values: readonly T[], value: unknown): value is T => values.some((entry) => entry === value);

/** Repairs each field on its own; a missing or invalid field takes its off-by-default value. */
export function normalizeWorkspaceCleanupRules(value: unknown): WorkspaceCleanupRules {
	const defaults = getDefaultWorkspaceCleanupRules();
	const merged = readRule(value, 'merged');
	const unchanged = readRule(value, 'unchanged');
	const inactive = readRule(value, 'inactive');
	const automationRuns = readRule(value, 'automationRuns');
	const orchestrationWorkers = readRule(value, 'orchestrationWorkers');
	const keepWhen = isRecord(value) ? value.keepWhen : undefined;
	return {
		merged: { enabled: normalizeEnabled(merged.enabled, defaults.merged.enabled) },
		unchanged: {
			enabled: normalizeEnabled(unchanged.enabled, defaults.unchanged.enabled),
			afterDays: normalizeDays(unchanged.afterDays, defaults.unchanged.afterDays)
		},
		inactive: {
			enabled: normalizeEnabled(inactive.enabled, defaults.inactive.enabled),
			afterDays: normalizeDays(inactive.afterDays, defaults.inactive.afterDays),
			action: includesValue(WORKSPACE_CLEANUP_INACTIVE_ACTIONS, inactive.action) ? inactive.action : defaults.inactive.action
		},
		automationRuns: { enabled: normalizeEnabled(automationRuns.enabled, defaults.automationRuns.enabled) },
		orchestrationWorkers: { enabled: normalizeEnabled(orchestrationWorkers.enabled, defaults.orchestrationWorkers.enabled) },
		keepWhen: includesValue(WORKSPACE_CLEANUP_KEEP_WHEN_VALUES, keepWhen) ? keepWhen : defaults.keepWhen
	};
}

export function normalizeRepoWorkspaceCleanupPolicy(value: unknown): RepoWorkspaceCleanupPolicy | undefined {
	if (!isRecord(value)) return undefined;
	if (value.mode === 'off') return { mode: 'off' };
	if (value.mode === 'custom') return { mode: 'custom', rules: normalizeWorkspaceCleanupRules(value.rules) };
	return undefined;
}

/** The same rules with every rule off; thresholds and protections are kept. */
export function withEveryRuleOff(rules: WorkspaceCleanupRules): WorkspaceCleanupRules {
	return {
		merged: { enabled: false },
		unchanged: { ...rules.unchanged, enabled: false },
		inactive: { ...rules.inactive, enabled: false },
		automationRuns: { enabled: false },
		orchestrationWorkers: { enabled: false },
		keepWhen: rules.keepWhen
	};
}

const withArchiveSupport = (source: WorkspaceCleanupPolicySource, rules: WorkspaceCleanupRules): WorkspaceCleanupPolicy => ({
	source,
	rules,
	inactiveActionSupported: rules.inactive.action !== 'archive' || WORKSPACE_ARCHIVE_SUPPORTED
});

/** The one place that decides which cleanup rules apply to a project's workspaces. */
export function resolveWorkspaceCleanupPolicy(
	settings: { workspaceCleanupPolicy?: WorkspaceCleanupRules },
	repo?: { workspaceCleanupPolicy?: RepoWorkspaceCleanupPolicy }
): WorkspaceCleanupPolicy {
	const globalRules = settings.workspaceCleanupPolicy ?? getDefaultWorkspaceCleanupRules();
	const override = repo?.workspaceCleanupPolicy;
	if (override?.mode === 'custom') return withArchiveSupport('project-custom', override.rules);
	if (override?.mode === 'off') return withArchiveSupport('project-off', withEveryRuleOff(globalRules));
	return withArchiveSupport('global', globalRules);
}
