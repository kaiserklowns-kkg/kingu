// Golden tests: the spec gives what the production launch paths build from the same settings.

import { describe, expect, test } from 'bun:test';
import { agentArgsSetting, agentCommand, agentEnvSetting, launchOptions, withLaunchOptions } from '#lib/ade/agentCli.ts';
import { PROFILES } from '#lib/ade/agentProfiles.ts';
import { EFFORTS, effortDefaults, runEffort } from './effort';
import { adeCommand, adeLaunchSpec, applyLaunchSpec, resolveLaunchSpec, type AdeLaunchSpec } from './launchSpec';

const getter = (s: Record<string, unknown>) => (k: string) => s[k];

/** Settings that exercise every ADE launch setting for `bin`'s profile. */
function adeSettings(profileId: string, bin: string, variant: number): Record<string, unknown> {
	const s: Record<string, unknown> = { 'kingu.agent.cli': bin };
	if (variant & 1) s['kingu.agent.cliPermissions'] = 'yolo';
	if (variant & 2) s[agentArgsSetting(profileId)] = '--verbose';
	if (variant & 4) s[agentEnvSetting(profileId)] = { FOO: 'bar' };
	if (variant & 8) s['kingu.agent.cmdOverrides'] = { [profileId]: `/opt/${bin}` };
	if (variant & 16) s['kingu.agent.claudeAgentTeams'] = 'in-process';
	return s;
}

describe('resolveLaunchSpec — ADE golden', () => {
	for (const p of PROFILES) {
		test(`${p.id}: equals agentCommand + launchOptions for every setting combination`, () => {
			for (let v = 0; v < 32; v++) {
				const get = getter(adeSettings(p.id, p.bins[0]!, v));
				const spec = resolveLaunchSpec({ surface: 'ade', get }) as AdeLaunchSpec;
				const argv = agentCommand((k) => get(k) as string | undefined)!;
				const options = launchOptions(p.id, get);
				if (typeof options === 'string') throw new Error(options);
				expect(spec.agentId).toBe(p.id);
				expect(spec.argv).toEqual(argv);
				const launch = p.launch(argv, { prompt: 'hi' }, { sessionId: 'sid', servers: {}, plugins: [] }).argv;
				expect(applyLaunchSpec(launch, spec)).toEqual(withLaunchOptions(launch, options));
				expect(spec.permissionMode).toBe(v & 1 ? 'yolo' : 'manual');
				expect([spec.mcp, spec.skills]).toEqual([p.mcp, p.skills]);
			}
		});
	}

	test('the default command is claude; a pick replaces kingu.agent.cli', () => {
		expect((resolveLaunchSpec({ surface: 'ade', get: getter({}) }) as AdeLaunchSpec).argv).toEqual(['claude']);
		const spec = resolveLaunchSpec({ surface: 'ade', agentId: 'codex', get: getter({ 'kingu.agent.cli': 'claude' }) }) as AdeLaunchSpec;
		expect(spec.agentId).toBe('codex');
	});

	test("a saved task command is launched as it is: the profile's args are not added again", () => {
		const get = getter({ 'kingu.agent.cliPermissions': 'yolo', [agentArgsSetting('codex')]: '--verbose', [agentEnvSetting('codex')]: { A: '1' } });
		const saved = adeCommand('codex', get)!;
		expect(saved).toEqual(['codex', '--verbose']);
		const spec = adeLaunchSpec(saved, get) as AdeLaunchSpec;
		expect(spec.argv).toEqual(saved);
		expect(spec.env).toEqual(['A=1']);
		expect(adeLaunchSpec(['claude'], getter({ 'kingu.agent.cmdOverrides': { claude: 'a b' } }))).toHaveProperty('error');
	});

	test('an unknown command is the custom profile', () => {
		const spec = resolveLaunchSpec({ surface: 'ade', get: getter({ 'kingu.agent.cli': 'mycli --x' }) }) as AdeLaunchSpec;
		expect(spec.agentId).toBe('custom');
		expect(spec.argv).toEqual(['mycli', '--x']);
	});

	test('unusable settings are an error, as the launch refuses them', () => {
		expect(resolveLaunchSpec({ surface: 'ade', get: getter({ 'kingu.agent.cli': 'claude; rm' }) })).toHaveProperty('error');
		expect(resolveLaunchSpec({ surface: 'ade', get: getter({ 'kingu.agent.cmdOverrides': { claude: 'a b' } }) })).toHaveProperty('error');
		expect(resolveLaunchSpec({ surface: 'ade', get: getter({ [agentEnvSetting('claude')]: { 'BAD NAME': 'x' } }) })).toHaveProperty('error');
	});
});

describe('resolveLaunchSpec — chat', () => {
	test('defaults: Claude, no model, default mode, no effort', () => {
		expect(resolveLaunchSpec({ surface: 'ide', get: getter({}) })).toEqual({
			surface: 'ide',
			agentId: 'claude',
			runtime: 'claude',
			model: null,
			effort: null,
			permissionMode: 'default',
			env: {}
		});
	});

	test('reads kingu.agent.runtime / model / permissionMode like chats.defaults() and AgentPanel', () => {
		const spec = resolveLaunchSpec({ surface: 'ide', get: getter({ 'kingu.agent.runtime': ' arkai ', 'kingu.agent.model': ' opus ', 'kingu.agent.permissionMode': 'plan' }) });
		expect([spec.runtime, spec.model, spec.permissionMode]).toEqual(['arkai', 'opus', 'plan']);
		expect(resolveLaunchSpec({ surface: 'ide', get: getter({ 'kingu.agent.permissionMode': 'yolo', 'kingu.agent.runtime': '  ' }) })).toMatchObject({ permissionMode: 'default', runtime: 'claude' });
		expect(resolveLaunchSpec({ surface: 'ide', agentId: 'codex', get: getter({ 'kingu.agent.runtime': 'arkai' }) }).runtime).toBe('codex');
	});

	test('effort equals runEffort with no pick when the model takes every level', () => {
		const cases: Record<string, unknown>[] = [{}, { claude: 'low' }, { '*': 'max' }, { claude: 'high', '*': 'low' }, { codex: 'medium' }, { claude: 'bogus', '*': 'low' }, 'high' as unknown as Record<string, unknown>];
		for (const v of cases) {
			for (const runtime of ['claude', 'codex', 'arkai']) {
				const spec = resolveLaunchSpec({ surface: 'ide', get: getter({ 'kingu.agent.runtime': runtime, 'kingu.chat.reasoningEffort': v }) });
				expect(spec.effort).toBe(runEffort(null, effortDefaults(v), runtime, EFFORTS));
			}
		}
	});
});
