// Agent CLIs on an SSH host (Orca's per-host agent detection): what Rust's ssh_agents.rs found
// there, whether the command about to be started can run, and what to offer when it can't. Pure,
// so `bun test` covers it; sshProjects.svelte.ts asks the host and shows the choice.
//
// Orca source (3b2f28b30): src/main/preflight/installed-agent-detection.ts (a profile is installed
// when its command and every `requiredCommands` are found), src/renderer/src/components/agent/AgentLaunchInstallPrompt.tsx
// ("{{agent}} isn't installed on this host." with an "Install {{agent}}" link to the catalog's
// `homepageUrl`), src/renderer/src/lib/agent-catalog/agent-catalog-entries-{primary,secondary}.ts.

import { foundBin, profileOf, programOf, PROFILES, type AgentProfile } from './agentProfiles';

/** One CLI of `ssh_remote_agents`: `fallback` when only a version-manager folder has it, not the login PATH. */
export type HostAgent = { name: string; path: string; fallback: boolean };

/** Orca's `homepageUrl` per agent, by Kingu's profile id (Orca's `qwen-code` is Kingu's `qwen`). */
export const INSTALL_PAGES: Readonly<Record<string, string>> = {
	claude: 'https://code.claude.com/docs',
	openclaude: 'https://openclaude.gitlawb.com/',
	codex: 'https://github.com/openai/codex',
	grok: 'https://x.ai/cli',
	copilot: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli',
	opencode2: 'https://opencode.ai/v2/docs/',
	opencode: 'https://opencode.ai/docs/cli/',
	'mimo-code': 'https://mimo.xiaomi.com/coder',
	ante: 'https://github.com/AntigmaLabs/ante-preview',
	trae: 'https://docs.trae.cn/cli_get-started-with-trae-cli',
	muse: 'https://dev.meta.ai/docs/muse-code',
	dsh: 'https://github.com/ccch1mneyyy/dsh-TUI#quick-start',
	qoder: 'https://docs.qoder.com/cli/overview',
	'qoder-cn': 'https://docs.qoder.cn/cli/overview',
	zcode: 'https://zcode.z.ai/en/docs',
	pi: 'https://pi.dev',
	omp: 'https://omp.sh',
	'prime-agent': 'https://github.com/PrimeIntellect-ai/prime-agent',
	gemini: 'https://github.com/google-gemini/gemini-cli',
	antigravity: 'https://antigravity.google/docs/cli-overview',
	aider: 'https://aider.chat/docs/',
	goose: 'https://goose-docs.ai/docs/quickstart/',
	amp: 'https://ampcode.com/manual#install',
	kilo: 'https://kilo.ai/docs/cli',
	kiro: 'https://kiro.dev/docs/cli/',
	crush: 'https://github.com/charmbracelet/crush',
	aug: 'https://docs.augmentcode.com/cli/overview',
	autohand: 'https://github.com/autohandai/code-cli',
	cline: 'https://docs.cline.bot/cline-cli/overview',
	codebuff: 'https://www.codebuff.com/docs/help/quick-start',
	freebuff: 'https://freebuff.com/cli',
	'command-code': 'https://commandcode.ai/docs/quickstart',
	continue: 'https://docs.continue.dev/cli/quickstart',
	cursor: 'https://cursor.com/cli',
	droid: 'https://docs.factory.ai/cli/getting-started/quickstart',
	kimi: 'https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html',
	'mistral-vibe': 'https://github.com/mistralai/mistral-vibe',
	qwen: 'https://github.com/QwenLM/qwen-code',
	rovo: 'https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/',
	hermes: 'https://hermes-agent.nousresearch.com/docs/',
	devin: 'https://devin.ai/cli',
	openclaw: 'https://github.com/openclaw/openclaw',
	codebuddy: 'https://www.codebuddy.ai/cli',
	jcode: 'https://github.com/1jehuang/jcode'
};

/** The index of the program word of an argv, past an `env VAR=value …` prefix (agentProfiles.ts `programOf`). */
function programIndex(argv: readonly string[]): number {
	if (!argv[0] || (argv[0].split('/').pop() ?? argv[0]) !== 'env') return 0;
	let i = 1;
	while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!)) i++;
	return i < argv.length ? i : 0;
}

export type HostLaunch =
	/** The command can start on the host: `argv` as given, its program by absolute path when only a fallback folder has it. */
	| { kind: 'ok'; argv: string[] }
	/** The host doesn't have `program` (or a program its profile also requires). */
	| { kind: 'missing'; program: string; profile: AgentProfile; installPage: string | null };

/**
 * Whether `argv` (the agent command Kingu would start) can run on a host that has `found`.
 * A program given by path (`~/bin/agent`, `/opt/x/claude`) is the user's own choice of a file on
 * the host and is started as written.
 */
export function hostLaunch(argv: readonly string[], found: readonly HostAgent[]): HostLaunch {
	const at = programIndex(argv);
	const word = argv[at] ?? '';
	if (word.includes('/')) return { kind: 'ok', argv: [...argv] };
	const program = programOf(argv);
	const profile = profileOf(argv);
	const names = found.map((f) => f.name);
	const hit = found.find((f) => f.name === program);
	const missing = (profile.requires ?? []).find((r) => !names.includes(r));
	if (!hit || missing) return { kind: 'missing', program: hit ? missing! : program, profile, installPage: INSTALL_PAGES[profile.id] ?? null };
	if (!hit.fallback) return { kind: 'ok', argv: [...argv] };
	const out = [...argv];
	out[at] = hit.path;
	return { kind: 'ok', argv: out };
}

/** The known agents the host has, in catalog order, each with the program name that selects it. */
export function hostProfiles(found: readonly HostAgent[]): { profile: AgentProfile; bin: string }[] {
	const names = found.map((f) => f.name);
	return PROFILES.flatMap((profile) => {
		const bin = foundBin(profile, names);
		return bin ? [{ profile, bin }] : [];
	});
}
