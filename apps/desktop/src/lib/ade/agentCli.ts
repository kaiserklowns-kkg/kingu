// Agents run the Orca way: a CLI (`claude`, `codex`, …) in a terminal of the task's worktree,
// started with the prompt as its last argument. Older tasks may carry our legacy timeline (the
// agent host's SDK session). A CLI task stores `cli:<command>` as its agent. Per-CLI behaviour (resume, MCP,
// status) lives in agentProfiles.ts. Pure, so `bun test` covers it.

import { profileOf, programOf } from '#lib/ade/agentProfiles.ts';
import { t } from '#lib/i18n/index.ts';

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
	/** The profile whose startup update prompt is kept away (a launch Kingu hands a prompt; see UPDATE_PROMPT_ARGS). */
	noUpdatePrompt?: string;
};

/**
 * Orca's STARTUP_UPDATE_PROMPT_SUPPRESSION_ARGS / _ENV (shared/agent-launch/startup/
 * tui-agent-launch-command.ts): a CLI started with a prompt nobody is watching must not stop at
 * its "update available" screen. Enter on Codex's picks "Update now", which installs and exits,
 * and a pasted prompt would answer it. Only for a launch that carries a prompt, never a resume or
 * a bare start (Orca: launch-only).
 */
export const UPDATE_PROMPT_ARGS: Readonly<Record<string, readonly string[]>> = {
	codex: ['-c', 'check_for_update_on_startup=false'],
	aider: ['--no-check-update', '--no-show-release-notes'],
	cursor: ['--disable-auto-update']
};
export const UPDATE_PROMPT_ENV: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	claude: { DISABLE_AUTOUPDATER: '1' },
	opencode: { OPENCODE_DISABLE_AUTOUPDATE: 'true' },
	opencode2: { OPENCODE_DISABLE_AUTOUPDATE: 'true' },
	antigravity: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
	grok: { GROK_DISABLE_AUTOUPDATER: '1' },
	pi: { PI_SKIP_VERSION_CHECK: '1' },
	kimi: { KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_CLI_NO_AUTO_UPDATE: '1' }
};

/** The words after the program with the profile's update-prompt arguments, unless they are there already. */
function withoutUpdatePrompt(profileId: string, rest: readonly string[]): string[] {
	const args = UPDATE_PROMPT_ARGS[profileId];
	if (!args) return [...rest];
	// Aider's last boolean flag wins, even over a configured --check-update: they go last, before a `--`.
	if (profileId === 'aider') {
		const end = rest.indexOf('--');
		return end < 0 ? [...rest, ...args] : [...rest.slice(0, end), ...args, ...rest.slice(end)];
	}
	const marker = args[args.length - 1].split('=', 1)[0];
	return rest.some((a) => a.includes(marker)) ? [...rest] : [...args, ...rest];
}

/**
 * A profile's launch argv with the user's launch settings: the program word replaced, the env
 * added through `env NAME=value …` (before the profile's own assignments, which win), for
 * claude the in-process agent teams flag, and with `noUpdatePrompt` that profile's update-prompt
 * arguments and environment. Pure.
 */
export function withLaunchOptions(argv: readonly string[], o: LaunchOptions): string[] {
	let i = 0;
	const prefix: string[] = [];
	if (argv[0] && (argv[0].split('/').pop() ?? '') === 'env') {
		i = 1;
		while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) prefix.push(argv[i++]);
	}
	if (i >= argv.length) return [...argv];
	const mine = [...(o.env ?? []), ...(o.claudeTeams ? ['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1'] : []), ...prefix];
	// The update-prompt env goes first and never over a name the launch already sets (yours wins).
	const named = new Set(mine.map((a) => a.slice(0, a.indexOf('='))));
	const quiet = Object.entries((o.noUpdatePrompt && UPDATE_PROMPT_ENV[o.noUpdatePrompt]) || {}).filter(([k]) => !named.has(k)).map(([k, v]) => `${k}=${v}`);
	const env = [...quiet, ...mine];
	const rest = o.noUpdatePrompt ? withoutUpdatePrompt(o.noUpdatePrompt, argv.slice(i + 1)) : argv.slice(i + 1);
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
	if (program === null) return t('ade.agentCli.badOverride', { setting: `kingu.agent.cmdOverrides.${profileId}` });
	const own = profileId === 'custom' ? [] : envAssignments(get(agentEnvSetting(profileId)) as Record<string, unknown> | undefined);
	if (own === null) return t('ade.agentCli.badEnv', { setting: agentEnvSetting(profileId) });
	// Orca's resolveTuiAgentLaunchEnv: the permission env first, and never over a name you set.
	const named = new Set(own.map((a) => a.slice(0, a.indexOf('='))));
	const env = [...permissionEnv(profileId, cliPermissions(get)).filter((a) => !named.has(a.slice(0, a.indexOf('=')))), ...own];
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
 * Each profile's skip-every-permission-prompt flags (Orca's YOLO_TUI_AGENT_ARGS), which
 * `kingu.agent.cliPermissions` = `yolo` adds. opencode has none (Goose's is an env var, YOLO_ENV);
 * the custom profile gets none.
 */
export const YOLO_ARGS: Readonly<Record<string, readonly string[]>> = {
	claude: ['--dangerously-skip-permissions'],
	codex: ['--dangerously-bypass-approvals-and-sandbox'],
	gemini: ['--yolo'],
	cursor: ['--yolo'],
	copilot: ['--yolo'],
	amp: ['--dangerously-allow-all'],
	droid: ['--auto', 'high'],
	qwen: ['--approval-mode', 'yolo'],
	aider: ['--yes-always'],
	// The rest of Orca's YOLO_TUI_AGENT_ARGS (shared/agent-launch/permissions/tui-agent-permissions.ts).
	codebuddy: ['--dangerously-skip-permissions'],
	openclaude: ['--dangerously-skip-permissions'],
	qoder: ['--dangerously-skip-permissions'],
	'qoder-cn': ['--dangerously-skip-permissions'],
	antigravity: ['--dangerously-skip-permissions'],
	kiro: ['--trust-all-tools'],
	crush: ['--yolo'],
	autohand: ['--unrestricted'],
	cline: ['--auto-approve', 'true'],
	'command-code': ['--yolo'],
	continue: ['--allow', '*'],
	// Kimi Code's --yolo is "ask when needed"; --auto never asks.
	kimi: ['--auto'],
	muse: ['--yolo'],
	zcode: ['--mode', 'yolo'],
	'mistral-vibe': ['--agent', 'auto-approve'],
	rovo: ['--yolo'],
	hermes: ['--yolo'],
	grok: ['--permission-mode', 'bypassPermissions'],
	devin: ['--permission-mode', 'bypass', '--respect-workspace-trust', 'false'],
	ante: ['--yolo'],
	trae: ['--yolo']
};

/**
 * Each profile's "run what is safe, ask for the rest" flags (Orca's AUTO_TUI_AGENT_ARGS), which
 * `kingu.agent.cliPermissions` = `auto` adds. Only these three have such a mode; every other CLI
 * keeps asking under `auto` (Orca leaves them on their earlier choice; Kingu has one setting, so
 * that is manual).
 */
export const AUTO_ARGS: Readonly<Record<string, readonly string[]>> = {
	claude: ['--permission-mode', 'auto'],
	codex: ['--approve-for-me'],
	// Cursor's server classifier runs safe tool calls and asks for the rest.
	cursor: ['--auto-review']
};

/** The environment `yolo` adds (Orca's YOLO_TUI_AGENT_ENV): Goose's bypass is an env var, not a flag. */
export const YOLO_ENV: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	goose: { GOOSE_MODE: 'auto' }
};

export type CliPermissions = 'manual' | 'auto' | 'yolo';

/** `kingu.agent.cliPermissions`; anything but `auto` / `yolo` is manual (no flag, no env). */
export function cliPermissions(get: (id: string) => unknown): CliPermissions {
	const v = get('kingu.agent.cliPermissions');
	return v === 'yolo' || v === 'auto' ? v : 'manual';
}

/** The flags `mode` adds for a profile (Orca's agentPermissionArgs); none under manual. */
export function permissionArgs(profileId: string, mode: CliPermissions): readonly string[] {
	return (mode === 'yolo' ? YOLO_ARGS[profileId] : mode === 'auto' ? AUTO_ARGS[profileId] : undefined) ?? [];
}

/** The `NAME=value` words `mode` adds for a profile (Orca's agentPermissionEnv: only the bypass has any). */
export function permissionEnv(profileId: string, mode: CliPermissions): string[] {
	return mode === 'yolo' ? Object.entries(YOLO_ENV[profileId] ?? {}).map(([k, v]) => `${k}=${v}`) : [];
}

// Orca's Ask / Accept edits recipes (tui-agent-permission-choice.ts): Kingu has no such mode, but
// their options count as "this command already sets a permission".
const OTHER_PERMISSION_ARGS: Readonly<Record<string, readonly string[]>> = {
	claude: ['--permission-mode'],
	grok: ['--permission-mode'],
	codex: ['-a', '-s']
};
/** Orca's EXTRA_CARRIERS (permissions/agent-permission-args.ts): other options of a CLI that set its permission policy. */
const EXTRA_CARRIERS: Readonly<Record<string, readonly string[]>> = {
	claude: [
		'--permission-mode',
		'--dangerously-skip-permissions',
		'--allow-dangerously-skip-permissions',
		'--permission-prompt-tool',
		'--permission-prompts',
		'--allowedTools',
		'--allowed-tools',
		'--disallowedTools',
		'--disallowed-tools'
	],
	codex: ['-a', '--ask-for-approval', '-s', '--sandbox', '--yolo', '--not-so-yolo', '--full-auto'],
	grok: ['--permission-mode', '--always-approve', '--yolo', '--dangerously-skip-permissions'],
	gemini: ['--approval-mode', '-y'],
	// Cursor exits when --auto-review meets --force (or its -f, --yolo aliases).
	cursor: ['-f', '--force'],
	// Kimi rejects --yolo (and its aliases) combined with --auto.
	kimi: ['-y', '--yolo', '--yes', '--auto-approve']
};
const CODEX_PERMISSION_CONFIG = ['approval_policy', 'sandbox_mode', 'approvals_reviewer', 'sandbox_workspace_write'];

/** An option's name: codex's joined short forms (`-aon-request`) and `--name=value` cut down to the name. */
function optionName(profileId: string, token: string): string {
	if ((profileId === 'codex' && /^-[acs].+/.test(token) && !token.startsWith('--')) || (/^-m.+/.test(token) && !token.startsWith('--'))) return token.slice(0, 2);
	return token.split('=', 1)[0];
}

/**
 * Whether `args` (the words after the program) already choose the CLI's permission policy (Orca's
 * `agentArgsSetPermission`): one of its permission options, or for codex a `-c` override of an
 * approval / sandbox key. Then Kingu adds no permission flag of its own: the CLI would refuse the
 * pair (cursor, kimi) or run on whichever came last. Words after `--` are a prompt, not options.
 */
export function setsPermission(profileId: string, args: readonly string[]): boolean {
	const carriers = new Set([...(YOLO_ARGS[profileId] ?? []), ...(AUTO_ARGS[profileId] ?? []), ...(OTHER_PERMISSION_ARGS[profileId] ?? []), ...(EXTRA_CARRIERS[profileId] ?? [])].filter((a) => a.startsWith('-')));
	const end = args.indexOf('--');
	const options = end < 0 ? args : args.slice(0, end);
	return options.some((token, i) => {
		const name = optionName(profileId, token);
		if (carriers.has(name)) return true;
		if (profileId !== 'codex' || (name !== '-c' && name !== '--config')) return false;
		const value = token !== name ? token.slice(name.length + (token[name.length] === '=' ? 1 : 0)) : options[i + 1];
		return !!value?.includes('=') && CODEX_PERMISSION_CONFIG.includes(value.slice(0, value.indexOf('=')).trim().split('.')[0]);
	});
}

/**
 * The command a new terminal task runs: `kingu.agent.cli` (default `claude`), plus the extra
 * arguments set for that CLI's profile (`kingu.agent.args.<id>`), so switching CLIs with the
 * picker keeps each one's flags. With `kingu.agent.cliPermissions` = `yolo` or `auto` (Orca's
 * Agent Permissions), a profile whose arguments you left empty gets that mode's flags, unless the
 * command already sets its permission policy (`setsPermission`); arguments you set win. The
 * default, `manual`, adds nothing. Null when either is not a plain command.
 */
export function agentCommand(get: (id: string) => string | undefined): string[] | null {
	const base = parseCliCommand(get('kingu.agent.cli') || 'claude');
	if (!base) return null;
	const profile = profileOf(base);
	const extra = profile.id === 'custom' ? '' : (get(agentArgsSetting(profile.id)) ?? '').trim();
	if (!extra) {
		const flags = permissionArgs(profile.id, cliPermissions(get));
		const at = base.findIndex((w) => (w.split('/').pop() ?? w) === programOf(base));
		return flags.length && !setsPermission(profile.id, base.slice(at + 1)) ? [...base, ...flags] : base;
	}
	const args = parseCliCommand(extra);
	return args ? [...base, ...args] : null;
}

/**
 * The `kingu.agent.cli` value a new task uses when the create form picked `pick` (a program from
 * the picker): the default command itself when it runs that program (it keeps its flags, e.g.
 * `claude --model opus`), else the bare program. Orca's create-time agent selector.
 */
export function agentForPick(pick: string, current: string): string {
	const cur = parseCliCommand(current.trim() || 'claude');
	if (cur && profileOf(cur).id === profileOf([pick]).id) return current.trim() || 'claude';
	return pick;
}
