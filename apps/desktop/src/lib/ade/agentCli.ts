// Agents run the Orca way: a CLI (`claude`, `codex`, …) in a terminal of the task's worktree,
// started with the prompt as its last argument. The other way is our timeline (the agent host's
// SDK session). A CLI task stores `cli:<command>` as its agent. Per-CLI behaviour (resume, MCP,
// status) lives in agentProfiles.ts. Pure, so `bun test` covers it.

import { profileOf, programOf } from '#lib/ade/agentProfiles.ts';

export { claudeResume, claudeStart, cliResume } from '#lib/ade/agentProfiles.ts';

export type RunMode = 'terminal' | 'timeline';
export const CLI_PREFIX = 'cli:';

/** A setting word: no spaces, quotes or shell syntax (Rust also quotes each argument). */
const WORD = /^[A-Za-z0-9._/=:@%+,-]+$/;

/** `kingu.agent.cli` ("claude", "codex --full-auto", …) as argv, or null when it is not a plain command. */
export function parseCliCommand(command: string): string[] | null {
	const argv = command.trim().split(/\s+/).filter(Boolean);
	return argv.length && argv.every((a) => WORD.test(a)) ? argv : null;
}

export const isCliAgent = (agent: string) => agent.startsWith(CLI_PREFIX);
export const cliAgent = (argv: string[]) => CLI_PREFIX + argv.join(' ');
/** The argv saved in a task's `agent`, or null for a timeline task. */
export const cliOf = (agent: string) => (isCliAgent(agent) ? parseCliCommand(agent.slice(CLI_PREFIX.length)) : null);

/** Start: the command with the prompt as one last argument (a multi-line prompt stays one argument). */
export const cliStart = (argv: string[], prompt: string) => [...argv, prompt];

/** "claude" / "codex" for labels. */
export const cliName = (argv: string[]) => programOf(argv);

/** Output in the last 2.5s means the agent is working (Orca's spinner); otherwise it waits for you. */
export const WORKING_MS = 2500;
export const isWorking = (lastOutput: number | undefined, now: number) => lastOutput !== undefined && now - lastOutput < WORKING_MS;

/** The setting with a profile's extra arguments, e.g. `kingu.agent.args.codex`. */
export const agentArgsSetting = (profileId: string) => `kingu.agent.args.${profileId}`;

/** The setting with a profile's launch environment, e.g. `kingu.agent.env.claude` (Orca's agentDefaultEnv). */
export const agentEnvSetting = (profileId: string) => `kingu.agent.env.${profileId}`;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A launch env setting as `NAME=value` words; null when a name is not a plain env name or a value holds a control character. */
export function envAssignments(env: Record<string, unknown> | undefined): string[] | null {
	const out: string[] = [];
	for (const [k, v] of Object.entries(env ?? {})) {
		// eslint-disable-next-line no-control-regex
		if (!ENV_NAME.test(k) || typeof v !== 'string' || /[\x00-\x1f\x7f]/.test(v)) return null;
		out.push(`${k}=${v}`);
	}
	return out;
}

/** `kingu.agent.cmdOverrides[profile]` (Orca's agentCmdOverrides): the binary to run instead, or null (none or not a plain word). */
export function cmdOverride(overrides: Record<string, unknown> | undefined, profileId: string): string | null | undefined {
	const v = overrides?.[profileId];
	if (typeof v !== 'string' || !v.trim()) return undefined;
	return WORD.test(v.trim()) ? v.trim() : null;
}

export type LaunchOptions = {
	/** Binary that replaces the program word. */
	program?: string;
	/** `NAME=value` words the CLI starts with; the profile's own (hook files) still win. */
	env?: string[];
	/** Orca's claudeAgentTeamsMode `in-process`: `--teammate-mode in-process` + the experimental env flag. */
	claudeTeams?: boolean;
};

/**
 * A profile's launch argv with the user's launch settings: the program word replaced, the env
 * added through `env NAME=value …` (before the profile's own assignments, which win), and for
 * claude the in-process agent teams flag. Pure.
 */
export function withLaunchOptions(argv: readonly string[], o: LaunchOptions): string[] {
	let i = 0;
	const prefix: string[] = [];
	if (argv[0] && (argv[0].split('/').pop() ?? '') === 'env') {
		i = 1;
		while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) prefix.push(argv[i++]);
	}
	if (i >= argv.length) return [...argv];
	const env = [...(o.env ?? []), ...(o.claudeTeams ? ['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1'] : []), ...prefix];
	const rest = argv.slice(i + 1);
	const teams = o.claudeTeams && !rest.some((a) => a === '--teammate-mode' || a.startsWith('--teammate-mode=')) ? ['--teammate-mode', 'in-process'] : [];
	return [...(env.length ? ['env', ...env] : []), o.program ?? argv[i], ...teams, ...rest];
}

/**
 * The launch options for a profile from the settings: `kingu.agent.cmdOverrides`,
 * `kingu.agent.env.<profile>` and `kingu.agent.claudeAgentTeams`. An error string when a value
 * is not usable (the launch is refused rather than run differently than configured).
 */
export function launchOptions(profileId: string, get: (id: string) => unknown): LaunchOptions | string {
	const program = cmdOverride(get('kingu.agent.cmdOverrides') as Record<string, unknown> | undefined, profileId);
	if (program === null) return `kingu.agent.cmdOverrides.${profileId} ต้องเป็นคำสั่งหรือ path ธรรมดา (ไม่มีอักขระของ shell)`;
	const env = profileId === 'custom' ? [] : envAssignments(get(agentEnvSetting(profileId)) as Record<string, unknown> | undefined);
	if (env === null) return `${agentEnvSetting(profileId)} ต้องเป็นชื่อตัวแปรธรรมดา (A-Z 0-9 _) และค่าที่ไม่มีอักขระควบคุม`;
	return { program, env, claudeTeams: profileId === 'claude' && get('kingu.agent.claudeAgentTeams') === 'in-process' };
}

/**
 * Orca's disabledTuiAgents (`kingu.agent.disabled`): the found programs whose profile is not
 * disabled — the current CLI's profile always stays, so hiding never breaks kingu.agent.cli.
 */
export function enabledBins(found: readonly string[], disabled: readonly unknown[] | undefined, currentProfileId: string | null): string[] {
	const off = new Set((disabled ?? []).filter((d): d is string => typeof d === 'string'));
	return found.filter((bin) => {
		const id = profileOf([bin]).id;
		return id === currentProfileId || !off.has(id);
	});
}

/**
 * The command a new terminal task runs: `kingu.agent.cli` (default `claude`), plus the extra
 * arguments set for that CLI's profile (`kingu.agent.args.<id>`), so switching CLIs with the
 * picker keeps each one's flags. Null when either is not a plain command.
 */
export function agentCommand(get: (id: string) => string | undefined): string[] | null {
	const base = parseCliCommand(get('kingu.agent.cli') || 'claude');
	if (!base) return null;
	const profile = profileOf(base);
	const extra = profile.id === 'custom' ? '' : (get(agentArgsSetting(profile.id)) ?? '').trim();
	if (!extra) return base;
	const args = parseCliCommand(extra);
	return args ? [...base, ...args] : null;
}
