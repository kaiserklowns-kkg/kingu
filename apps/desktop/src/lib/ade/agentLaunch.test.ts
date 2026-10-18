import { describe, expect, test } from 'bun:test';
import { resolveSettings, SETTINGS } from '#lib/settings/registry.ts';
import { cliAgent, cmdOverride, enabledBins, envAssignments, launchOptions, withLaunchOptions } from './agentCli';
import { formatCacheLeft, isClaudeTask, promptCacheLeft, promptCacheTtl } from './promptCache';

const getter = (user: Record<string, unknown>) => {
	const m = resolveSettings(user, {});
	return (id: string) => m.get(id)?.value;
};

describe('agent launch settings (Orca agentCmdOverrides / agentDefaultEnv / claudeAgentTeamsMode)', () => {
	test('defaults change nothing', () => {
		const o = launchOptions('claude', getter({}));
		expect(o).toEqual({ program: undefined, env: [], claudeTeams: false });
		expect(withLaunchOptions(['claude', '--settings', '{}', 'P'], o as object)).toEqual(['claude', '--settings', '{}', 'P']);
	});

	test('a binary override, env and in-process teams', () => {
		const o = launchOptions(
			'claude',
			getter({ 'kingu.agent.cmdOverrides': { claude: '/opt/claude-beta/claude' }, 'kingu.agent.env.claude': { DISABLE_AUTOUPDATER: '1' }, 'kingu.agent.claudeAgentTeams': 'in-process' })
		);
		expect(typeof o).toBe('object');
		expect(withLaunchOptions(['env', 'KINGU_AGENT_HOOK_FILE=/h', 'claude', 'P'], o as object)).toEqual([
			'env',
			'DISABLE_AUTOUPDATER=1',
			'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1',
			'KINGU_AGENT_HOOK_FILE=/h',
			'/opt/claude-beta/claude',
			'--teammate-mode',
			'in-process',
			'P'
		]);
		// Teams only for claude, and never twice.
		expect((launchOptions('codex', getter({ 'kingu.agent.claudeAgentTeams': 'in-process' })) as { claudeTeams: boolean }).claudeTeams).toBe(false);
		expect(withLaunchOptions(['claude', '--teammate-mode=tmux'], { claudeTeams: true })).toEqual(['env', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1', 'claude', '--teammate-mode=tmux']);
	});

	test('unusable values refuse the launch', () => {
		expect(cmdOverride({ claude: 'claude; rm -rf ~' }, 'claude')).toBeNull();
		expect(cmdOverride({ claude: '  ' }, 'claude')).toBeUndefined();
		expect(typeof launchOptions('claude', getter({ 'kingu.agent.cmdOverrides': { claude: '$(evil)' } }))).toBe('string');
		expect(envAssignments({ 'BAD NAME': 'x' })).toBeNull();
		expect(envAssignments({ OK: 'a\nb' })).toBeNull();
		expect(envAssignments({ OK: 'a b' })).toEqual(['OK=a b']);
	});

	test('launch settings are user-only', () => {
		const ids = SETTINGS.filter((s) => s.id.startsWith('kingu.agent.env.') || s.id === 'kingu.agent.cmdOverrides' || s.id === 'kingu.agent.claudeAgentTeams').map((s) => s.id);
		expect(ids.length).toBeGreaterThan(8);
		const m = resolveSettings({}, Object.fromEntries(ids.map((id) => [id, id === 'kingu.agent.claudeAgentTeams' ? 'in-process' : { X: '1' }])));
		for (const id of ids) expect([id, m.get(id)?.source]).toEqual([id, 'default']);
	});

	test('disabled agents leave the picker, the current one stays', () => {
		expect(enabledBins(['claude', 'codex', 'gemini'], ['codex', 'claude'], 'claude')).toEqual(['claude', 'gemini']);
		expect(enabledBins(['claude'], undefined, null)).toEqual(['claude']);
	});
});

describe('prompt cache timer (Orca promptCacheTimerEnabled / promptCacheTtlMs)', () => {
	const view = (agent: string, status: 'review' | 'running', updatedAt = 1000, working = false) => ({ meta: { agent }, status, runtime: { working, updatedAt } });
	test('counts down for an idle Claude task only', () => {
		expect(promptCacheTtl(undefined)).toBe(300_000);
		expect(promptCacheTtl('1h')).toBe(3_600_000);
		expect(isClaudeTask('claude-code')).toBe(true);
		expect(isClaudeTask(cliAgent(['claude']))).toBe(true);
		expect(isClaudeTask(cliAgent(['codex']))).toBe(false);
		expect(promptCacheLeft(view('claude-code', 'review'), 300_000, 61_000)).toBe(240_000);
		expect(promptCacheLeft(view('claude-code', 'review'), 300_000, 999_999)).toBe(0);
		expect(promptCacheLeft(view('claude-code', 'running', 1000, true), 300_000, 2000)).toBeNull();
		expect(promptCacheLeft(view(cliAgent(['codex']), 'review'), 300_000, 2000)).toBeNull();
		expect(formatCacheLeft(240_000)).toBe('4:00');
		expect(formatCacheLeft(59_001)).toBe('1:00');
	});
	test('defaults off, 5 minutes', () => {
		const m = resolveSettings({}, {});
		expect([m.get('kingu.agent.promptCacheTimer')?.value, m.get('kingu.agent.promptCacheTtl')?.value, m.get('kingu.automations.confirmDelete')?.value]).toEqual([false, '5m', true]);
	});
});
