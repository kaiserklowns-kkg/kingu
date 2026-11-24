import { describe, expect, test } from 'bun:test';
import { SCHEMA, settingProblems, validate } from '../registry';
import { getDefaultWorkspaceCleanupRules, normalizeRepoWorkspaceCleanupPolicy, normalizeWorkspaceCleanupRules } from '#lib/ade/workspaceCleanupPolicy.ts';

const RULES = 'kingu.workspaceCleanup.rules';
const PROJECT = 'kingu.workspaceCleanup.project';

describe('Workspace Cleanup settings', () => {
	test('every rule is off by default, and the default is exactly what the policy normalizes to', () => {
		const def = SCHEMA.get(RULES)!.default;
		expect(def).toEqual(getDefaultWorkspaceCleanupRules());
		expect(normalizeWorkspaceCleanupRules(def)).toEqual(def as never);
		expect(JSON.stringify(def)).not.toContain('"enabled":true');
		expect(normalizeRepoWorkspaceCleanupPolicy(SCHEMA.get(PROJECT)!.default)).toBeUndefined();
	});

	test('valid values are accepted, invalid ones fall back instead of enabling a rule', () => {
		const rules = { ...getDefaultWorkspaceCleanupRules(), merged: { enabled: true } };
		expect(validate(SCHEMA.get(RULES)!, rules)).toEqual(rules);
		expect(validate(SCHEMA.get(PROJECT)!, { mode: 'off' })).toEqual({ mode: 'off' });
		expect(validate(SCHEMA.get(PROJECT)!, { mode: 'custom', rules })).toEqual({ mode: 'custom', rules });
		expect(validate(SCHEMA.get(RULES)!, { merged: { enabled: 'yes' } })).toBeUndefined();
		expect(validate(SCHEMA.get(RULES)!, { unchanged: { enabled: true, afterDays: 0 } })).toBeUndefined();
		expect(validate(SCHEMA.get(PROJECT)!, { mode: 'delete-everything' })).toBeUndefined();
	});

	test('deleting the chat history of deleted workspaces is off by default and never set by a repository', () => {
		const id = 'kingu.workspaceCleanup.deleteChatHistory';
		expect([SCHEMA.get(id)?.default, SCHEMA.get(id)?.scope]).toEqual([false, 'application']);
		expect(settingProblems({ [id]: true }, 'workspace').some((p) => p.id === id)).toBe(true);
	});

	test("a repository's own .kingu/settings.json cannot turn cleanup on", () => {
		const on = { ...getDefaultWorkspaceCleanupRules(), merged: { enabled: true } };
		const problems = settingProblems({ [RULES]: on, [PROJECT]: { mode: 'custom', rules: on } }, 'workspace');
		expect([RULES, PROJECT].map((id) => problems.some((p) => p.id === id))).toEqual([true, true]);
	});
});
