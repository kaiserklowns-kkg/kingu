// Agent profiles: what Kingu knows about each agent CLI it runs in a task terminal (Orca's
// TUI_AGENT_CONFIG + resume argv). Per CLI: how the prompt goes in, how to resume, how Snap MCP
// servers and skills reach it, where its status comes from and which AI account env it gets.
// A command that matches no profile runs as typed with the prompt as its last argument. Pure.

import { cliWithMcp, type McpServers } from '#lib/ade/mcp.ts';

/**
 * Where a session's state comes from. `hooks`: Claude Code hooks (`--settings`) report every
 * phase. `notify`: codex's `notify` program reports each finished turn (and the session id);
 * working comes from the output. `output`: printing = working, else waiting for you.
 */
export type StatusSource = 'hooks' | 'notify' | 'output';
/** The AI account (accounts module) whose env the CLI's terminal gets; Rust picks it by program name. */
export type AccountProvider = 'claude' | 'codex';

export type LaunchHow = { prompt: string } | { resume: string | null } | { fresh: true };
export type LaunchContext = {
	/** A session id Kingu chose for a new session (profiles with `ownsSessionId`). */
	sessionId?: string;
	/** claude: the `--settings` JSON with the hook commands. */
	hookSettings?: string | null;
	/** codex: the hook jsonl file its `notify` program appends to. */
	hookFile?: string | null;
	servers: McpServers;
	plugins: readonly string[];
};
/** `typePrompt`: the prompt is pasted into the CLI once it is up (CLIs without a prompt argument). */
export type Launch = { argv: string[]; typePrompt?: string };

export type AgentProfile = {
	id: string;
	title: string;
	/** Program names that select this profile (the first one is what the picker sets). */
	bins: readonly string[];
	status: StatusSource;
	account: AccountProvider | null;
	/** Kingu chooses the session id at start (so a restart resumes exactly it). */
	ownsSessionId: boolean;
	/** The CLI can continue a session (by id, else its latest one in the worktree). */
	canResume: boolean;
	/** What the report / picker says about MCP and skills support. */
	mcp: boolean;
	skills: boolean;
	launch(base: string[], how: LaunchHow, ctx: LaunchContext): Launch;
};

const programName = (word: string) => word.split('/').pop() ?? word;

/** The program of an argv, past an `env VAR=value …` prefix (how env-configured CLIs are started). */
export function programOf(argv: readonly string[]): string {
	let i = 0;
	if (argv[0] && programName(argv[0]) === 'env') {
		i = 1;
		while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) i++;
	}
	return programName(argv[i] ?? argv[0] ?? '');
}

/** A value flag whose value may start with `-`: joined (`--flag=-x`) so the parser cannot take it for a flag. */
const valueFlag = (flag: string, value: string) => (value.startsWith('-') ? [`${flag}=${value}`] : [flag, value]);
/** A positional prompt after `--` when it starts with `-` (clap, commander and yargs all stop at `--`). */
const positional = (prompt: string) => (prompt.startsWith('-') ? ['--', prompt] : [prompt]);

// ---- TOML values for codex `-c key=value` (the value is parsed as TOML) ------------------------

/** A TOML basic string; JSON's escapes (\" \\ \n \uXXXX) are TOML's too. */
export const tomlString = (s: string) => JSON.stringify(s);
const tomlArray = (xs: readonly string[]) => `[${xs.map(tomlString).join(', ')}]`;
const tomlTable = (o: Record<string, string>) => `{ ${Object.entries(o).map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`).join(', ')} }`;
/** codex splits `-c` keys on dots: a server name keeps to a bare TOML key. */
const codexKey = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '_');

/** codex `-c` overrides that add each MCP server (`mcp_servers.<name>.command/args/env`). */
export function codexMcpArgs(servers: McpServers): string[] {
	return Object.entries(servers).flatMap(([name, s]) => {
		const key = `mcp_servers.${codexKey(name)}`;
		return [
			'-c',
			`${key}.command=${tomlString(s.command)}`,
			'-c',
			`${key}.args=${tomlArray(s.args)}`,
			...(Object.keys(s.env).length ? ['-c', `${key}.env=${tomlTable(s.env)}`] : [])
		];
	});
}

/**
 * codex's `notify` program gets the turn's JSON as its last argument; this one appends it as a
 * line to the hook file Kingu reads. The path comes from Rust and never contains a quote.
 */
export function codexNotifyArgs(hookFile: string): string[] {
	if (/['\n]/.test(hookFile)) return [];
	const script = `printf '%s\\n' "$1" >> '${hookFile}'`;
	return ['-c', `notify=${tomlArray(['sh', '-c', script, 'kingu-notify'])}`];
}

// ---- MCP config formats of the other CLIs -----------------------------------------------------

/** opencode: `OPENCODE_CONFIG_CONTENT` is merged over its config files; local servers take one command array. */
export function opencodeConfig(servers: McpServers): string | null {
	const entries = Object.entries(servers);
	if (!entries.length) return null;
	return JSON.stringify({
		mcp: Object.fromEntries(entries.map(([name, s]) => [name, { type: 'local', command: [s.command, ...s.args], environment: s.env, enabled: true }]))
	});
}

/** Copilot CLI `--additional-mcp-config`: `{ mcpServers: { name: { type: 'local', … } } }`. */
export function copilotMcpConfig(servers: McpServers): string | null {
	const entries = Object.entries(servers);
	if (!entries.length) return null;
	return JSON.stringify({ mcpServers: Object.fromEntries(entries.map(([name, s]) => [name, { type: 'local', command: s.command, args: s.args, env: s.env, tools: ['*'] }])) });
}

/** Amp `--mcp-config`: the `amp.mcpServers` shape, `{ name: { command, args, env } }`. */
export function ampMcpConfig(servers: McpServers): string | null {
	const entries = Object.entries(servers);
	if (!entries.length) return null;
	return JSON.stringify(Object.fromEntries(entries.map(([name, s]) => [name, { command: s.command, args: s.args, env: s.env }])));
}

// ---- profiles --------------------------------------------------------------------------------

type Spec = Omit<AgentProfile, 'launch' | 'canResume' | 'mcp' | 'skills'> & {
	/** Where the prompt goes: a positional argument, a flag, or pasted once the CLI is up. */
	prompt: { kind: 'argv' } | { kind: 'flag'; flag: string } | { kind: 'type' };
	/** The resume argv after the base command (null: the CLI cannot resume). */
	resume: ((id: string | null) => string[]) | null;
	/** MCP / skills: arguments right after the base command, or an env prefix. */
	mcpArgs?: (servers: McpServers) => string[];
	mcpEnv?: (servers: McpServers) => Record<string, string>;
};

function simple(spec: Spec): AgentProfile {
	const { prompt, resume, mcpArgs, mcpEnv, ...rest } = spec;
	return {
		...rest,
		canResume: resume !== null,
		mcp: !!(mcpArgs || mcpEnv),
		skills: false,
		launch(base, how, ctx) {
			const env = Object.entries(mcpEnv?.(ctx.servers) ?? {});
			const head = [...(env.length ? ['env', ...env.map(([k, v]) => `${k}=${v}`)] : []), ...base, ...(mcpArgs?.(ctx.servers) ?? [])];
			if ('resume' in how) return { argv: resume ? [...head, ...resume(how.resume)] : head };
			if ('fresh' in how) return { argv: head };
			if (prompt.kind === 'type') return { argv: head, typePrompt: how.prompt };
			return { argv: [...head, ...(prompt.kind === 'flag' ? valueFlag(prompt.flag, how.prompt) : positional(how.prompt))] };
		}
	};
}

/**
 * claude, started the way Kingu can follow it: a session id we choose (so a restart resumes exactly
 * this session with `--resume`) and `--settings` hooks that report its state. Both before the prompt.
 */
export function claudeStart(argv: string[], prompt: string, sessionId: string, settings: string | null): string[] {
	return [...argv, '--session-id', sessionId, ...(settings ? ['--settings', settings] : []), prompt];
}

/** Continue the task's own session when its id is known, else the latest one in the worktree. */
export function claudeResume(argv: string[], sessionId: string | null, settings: string | null): string[] {
	return [...argv, ...(sessionId ? ['--resume', sessionId] : ['--continue']), ...(settings ? ['--settings', settings] : [])];
}

/**
 * claude: a session id we choose and `--settings` hooks before the prompt; skill plugins and the
 * variadic `--mcp-config` after it (see cliWithMcp).
 */
const claude: AgentProfile = {
	id: 'claude',
	title: 'Claude Code',
	bins: ['claude'],
	status: 'hooks',
	account: 'claude',
	ownsSessionId: true,
	canResume: true,
	mcp: true,
	skills: true,
	launch(base, how, ctx) {
		const settings = ctx.hookSettings ?? null;
		let argv: string[];
		if ('resume' in how) argv = claudeResume(base, how.resume, settings);
		else if ('prompt' in how && ctx.sessionId) argv = claudeStart(base, how.prompt, ctx.sessionId, settings);
		else if ('prompt' in how) argv = [...base, how.prompt];
		else argv = [...base, ...(ctx.sessionId ? ['--session-id', ctx.sessionId] : []), ...(settings ? ['--settings', settings] : [])];
		return { argv: cliWithMcp(argv, ctx.servers, ctx.plugins) };
	}
};

/** codex: `-c` overrides (MCP servers, the notify program) go before the prompt or `resume`. */
const codex: AgentProfile = {
	id: 'codex',
	title: 'Codex CLI',
	bins: ['codex'],
	status: 'notify',
	account: 'codex',
	ownsSessionId: false,
	canResume: true,
	mcp: true,
	skills: false,
	launch(base, how, ctx) {
		const head = [...base, ...codexMcpArgs(ctx.servers), ...(ctx.hookFile ? codexNotifyArgs(ctx.hookFile) : [])];
		if ('resume' in how) return { argv: [...head, 'resume', how.resume ?? '--last'] };
		if ('fresh' in how) return { argv: head };
		return { argv: [...head, ...positional(how.prompt)] };
	}
};

export const PROFILES: readonly AgentProfile[] = [
	claude,
	codex,
	simple({
		id: 'gemini',
		title: 'Gemini CLI',
		bins: ['gemini'],
		status: 'output',
		account: null,
		ownsSessionId: false,
		prompt: { kind: 'flag', flag: '--prompt-interactive' },
		resume: (id) => ['--resume', id ?? 'latest']
	}),
	simple({
		id: 'opencode',
		title: 'OpenCode',
		bins: ['opencode'],
		status: 'output',
		account: null,
		ownsSessionId: false,
		prompt: { kind: 'flag', flag: '--prompt' },
		resume: (id) => (id ? ['--session', id] : ['--continue']),
		mcpEnv: (servers): Record<string, string> => {
			const config = opencodeConfig(servers);
			return config ? { OPENCODE_CONFIG_CONTENT: config } : {};
		}
	}),
	simple({
		id: 'cursor',
		title: 'Cursor Agent',
		bins: ['cursor-agent'],
		status: 'output',
		account: null,
		ownsSessionId: false,
		prompt: { kind: 'argv' },
		resume: (id) => (id ? ['--resume', id] : ['resume'])
	}),
	simple({
		id: 'copilot',
		title: 'GitHub Copilot CLI',
		bins: ['copilot'],
		status: 'output',
		account: null,
		ownsSessionId: false,
		// `--prompt` runs once and exits; `--interactive` keeps the session.
		prompt: { kind: 'flag', flag: '--interactive' },
		resume: (id) => (id ? [`--resume=${id}`] : ['--continue']),
		mcpArgs: (servers) => {
			const config = copilotMcpConfig(servers);
			return config ? ['--additional-mcp-config', config] : [];
		}
	}),
	simple({
		id: 'amp',
		title: 'Amp',
		bins: ['amp'],
		status: 'output',
		account: null,
		ownsSessionId: false,
		// `amp -x` is one-shot; the interactive TUI takes no prompt argument.
		prompt: { kind: 'type' },
		resume: (id) => ['threads', 'continue', ...(id ? [id] : [])],
		mcpArgs: (servers) => {
			const config = ampMcpConfig(servers);
			return config ? ['--mcp-config', config] : [];
		}
	}),
	simple({
		id: 'droid',
		title: 'Factory Droid',
		bins: ['droid'],
		status: 'output',
		account: null,
		ownsSessionId: false,
		prompt: { kind: 'argv' },
		resume: (id) => ['--resume', ...(id ? [id] : [])]
	}),
	simple({
		id: 'qwen',
		title: 'Qwen Code',
		bins: ['qwen'],
		status: 'output',
		account: null,
		ownsSessionId: false,
		prompt: { kind: 'type' },
		resume: (id) => (id ? ['--resume', id] : ['--continue'])
	}),
	simple({
		id: 'aider',
		title: 'Aider',
		bins: ['aider'],
		status: 'output',
		account: null,
		ownsSessionId: false,
		// `--message` sends one message and exits.
		prompt: { kind: 'type' },
		resume: () => ['--restore-chat-history']
	})
];

/** Any other command: the prompt as its last argument, no resume, status from the output. */
export const CUSTOM: AgentProfile = {
	id: 'custom',
	title: 'Custom',
	bins: [],
	status: 'output',
	account: null,
	ownsSessionId: false,
	canResume: false,
	mcp: false,
	skills: false,
	launch(base, how) {
		return { argv: 'prompt' in how ? [...base, how.prompt] : base };
	}
};

/** The profile of a command (`kingu.agent.cli` or a saved run) by its program name. */
export function profileOf(argv: readonly string[]): AgentProfile {
	const program = programOf(argv);
	return PROFILES.find((p) => p.bins.includes(program)) ?? CUSTOM;
}

/** Continue the latest session in that worktree, for the CLIs that can; null when it cannot. */
export function cliResume(argv: string[]): string[] | null {
	const p = profileOf(argv);
	return p.canResume ? p.launch(argv, { resume: null }, { servers: {}, plugins: [] }).argv : null;
}

/** Every program name the picker looks for on PATH. */
export const KNOWN_BINS: readonly string[] = PROFILES.flatMap((p) => p.bins);

// ---- the CLI picker ("Agent: Choose CLI…") ----------------------------------------------------

export const CUSTOM_PICK = '__custom';
export type PickRow = { id: string; label: string; description: string };

/** What Kingu does with the CLI, for the picker row. */
export function profileSummary(p: AgentProfile): string {
	const status = p.status === 'hooks' ? 'สถานะจาก hooks' : p.status === 'notify' ? 'สถานะจาก notify' : 'สถานะจาก output';
	return [status, p.canResume ? 'resume ได้' : null, p.mcp ? 'MCP' : null, p.skills ? 'skills' : null, p.account ? `บัญชี ${p.account}` : null].filter(Boolean).join(' · ');
}

/** Picker rows: the profiles whose program is in `found`, in profile order. */
export function pickerItems(found: readonly string[], current: string): PickRow[] {
	const have = new Set(found);
	const rows: PickRow[] = PROFILES.flatMap((p) => {
		const bin = p.bins.find((b) => have.has(b));
		return bin ? [{ id: bin, label: p.title, description: `${bin} — ${profileSummary(p)}` }] : [];
	});
	rows.push({ id: CUSTOM_PICK, label: 'Custom…', description: current ? `ตอนนี้: ${current}` : 'พิมพ์คำสั่งเอง' });
	return rows;
}

/**
 * When a pasted prompt is due: the CLI printed something, then went quiet (its composer is up);
 * at the latest after `maxMs` even without that.
 */
export function promptDue(startedAt: number, sawOutput: boolean, lastOutput: number | undefined, now: number, quietMs = 1500, minMs = 3000, maxMs = 20000): boolean {
	if (now - startedAt >= maxMs) return true;
	if (!sawOutput || lastOutput === undefined) return false;
	return now - startedAt >= minMs && now - lastOutput >= quietMs;
}

/** Bracketed paste keeps a multi-line prompt one message; Enter goes separately (see cliSessions). */
export const pasteText = (prompt: string) => `\x1b[200~${prompt.replace(/\x1b\[20[01]~/g, '')}\x1b[201~`;
