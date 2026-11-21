// Agent profiles: what Kingu knows about each agent CLI it runs in a task terminal (Orca's
// TUI_AGENT_CONFIG + resume argv). Per CLI: how the prompt goes in, how to resume, how Snap MCP
// servers and skills reach it for one run (argv, env, or a file the caller writes into the
// session's `runDir`), where its status comes from and which AI account env it gets.
// A command that matches no profile runs as typed with the prompt as its last argument. Pure.

import { cliWithMcp, stdioOnly, type McpServer, type McpServers } from '#lib/ade/mcp.ts';
import { t } from '#lib/i18n/index.ts';

/**
 * Where a session's state comes from. `hooks`: Claude Code hooks (`--settings`) report every
 * phase. `notify`: codex's `notify` program reports each finished turn (and the session id),
 * and with `kingu.agent.statusHooks` its hooks.json hooks report every phase. `agent-hooks`: the
 * status hooks Kingu installs for the CLI (Rust status_hooks.rs) report through the session's
 * `KINGU_AGENT_HOOK_FILE`. Until hooks report (or without them): printing = working, else waiting.
 */
export type StatusSource = 'hooks' | 'notify' | 'agent-hooks' | 'output';
/** The AI account (accounts module) whose env the CLI's terminal gets; Rust picks it by program name. */
export type AccountProvider = 'claude' | 'codex';

export type LaunchHow = { prompt: string } | { resume: string | null } | { fresh: true };
export type LaunchContext = {
	/** A session id Kingu chose for a new session (profiles with `ownsSessionId`). */
	sessionId?: string;
	/** claude: the `--settings` JSON with the hook commands. */
	hookSettings?: string | null;
	/** codex, `agent-hooks` CLIs: the session's hook jsonl file (codex `notify`, `KINGU_AGENT_HOOK_FILE`). */
	hookFile?: string | null;
	/** opencode: the session's `OPENCODE_CONFIG_DIR` holding Kingu's status plugin. */
	opencodeDir?: string | null;
	/**
	 * A folder of this session's own outside the worktree (in the app cache, like the hook file)
	 * for the files a launch returns. Without it, what needs a file goes without (gemini MCP).
	 */
	runDir?: string | null;
	servers: McpServers;
	/** Skill plugin folders (`.claude-plugin/plugin.json`, `skills/<name>/SKILL.md`; see mcp.ts). */
	plugins: readonly string[];
};
/** A file the caller writes (creating its folder) before it starts the argv; `path` is under `runDir`. */
export type LaunchFile = { path: string; content: string };
/** `typePrompt`: the prompt is pasted into the CLI once it is up (CLIs without a prompt argument). */
export type Launch = { argv: string[]; typePrompt?: string; files?: LaunchFile[] };

export type AgentProfile = {
	id: string;
	/** Orca's agent kind (shared/agent-kind.ts) when it differs from `id` (Kingu's older ids: `qwen`). */
	kind?: string;
	title: string;
	/** Program names that select this profile (the first one is what the picker sets). */
	bins: readonly string[];
	/** Other programs that must be on PATH too before the profile counts as installed (Orca's detectRequiredCommands). */
	requires?: readonly string[];
	/** Resume works only with a session id (no "latest session" form): `cliResume` gives null. */
	resumeNeedsId?: boolean;
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
	return Object.entries(stdioOnly(servers)).flatMap(([name, s]) => {
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

// ---- MCP and skill formats of the other CLIs --------------------------------------------------
//
// Only per-run mechanisms: nothing is written into the worktree or the user's own config. Left
// out, for want of one: codex skills (only `$CODEX_HOME/skills`, `~/.agents/skills` and the
// repo's `.agents/skills`; the app-server's `skills/extraRoots/set` is not the TUI's, and a
// CODEX_HOME of our own would also move its login, sessions, trust and hooks.json), gemini
// skills (`~/.gemini/skills` sits in the folder with its OAuth login, which GEMINI_CLI_HOME
// moves along), amp skills (`amp.skills.path` only through settings files; `--settings-file`
// replaces the user's), cursor-agent MCP and skills (only `~/.cursor` and `.cursor/`; its
// CURSOR_CONFIG_DIR is undocumented).

/** A plugin folder's skills folder (its `skills/<name>/SKILL.md`). */
const pluginSkills = (dir: string) => `${dir.replace(/\/+$/, '')}/skills`;

/**
 * opencode: `OPENCODE_CONFIG_CONTENT` is merged over its config files; local servers take one
 * command array, and `skills.paths` folders are searched for `**\/SKILL.md` (opencode v1.19
 * packages/opencode/src/skill/index.ts). Its deep merge replaces arrays, so a `skills.paths` of
 * the user's own config is left out of a run that gets skills from Kingu. UNVERIFIED: opencode's
 * unreleased rewrite (dev branch, packages/core) reads `skills` as a plain array instead.
 */
export function opencodeConfig(servers: McpServers, plugins: readonly string[] = []): string | null {
	const entries = Object.entries(stdioOnly(servers));
	if (!entries.length && !plugins.length) return null;
	return JSON.stringify({
		...(entries.length ? { mcp: Object.fromEntries(entries.map(([name, s]) => [name, { type: 'local', command: [s.command, ...s.args], environment: s.env, enabled: true }])) } : {}),
		...(plugins.length ? { skills: { paths: plugins.map(pluginSkills) } } : {})
	});
}

/**
 * Gemini CLI expands `$VAR` / `${VAR}` in every settings string and has no escape; `${UNSET:-$}`
 * gives a bare `$` (one pass, the result is not expanded again; gemini-cli
 * packages/cli/src/utils/envVarResolver.ts). Only a `$` it would expand is replaced.
 */
const GEMINI_DOLLAR = '${KINGU_LITERAL_DOLLAR:-$}';
export const geminiLiteral = (s: string) => s.replace(/\$(?=[\w{])/g, () => GEMINI_DOLLAR);

/**
 * Gemini CLI: a settings file with the servers in `mcpServers`, for the session's
 * GEMINI_CLI_SYSTEM_DEFAULTS_PATH. System defaults are the lowest settings layer and
 * `mcpServers` is merged key by key (gemini-cli packages/cli/src/config/settings.ts,
 * settingsSchema.ts), so the user's own servers and `mcp.allowed` / `mcp.excluded` still apply.
 * A server's env goes through `env K=V cmd`: gemini expands env values a second time
 * (dotenv-expand, packages/core/src/tools/mcp-client.ts) but passes args as they are.
 */
export function geminiSystemDefaults(servers: McpServers): string | null {
	const entries = Object.entries(stdioOnly(servers));
	if (!entries.length) return null;
	const server = (s: McpServer) => {
		const env = Object.entries(s.env);
		// `env` would take a program with `=` in its name for one more variable.
		if (env.length && !s.command.includes('=')) return { command: 'env', args: [...env.map(([k, v]) => `${k}=${v}`), s.command, ...s.args].map(geminiLiteral) };
		return { command: geminiLiteral(s.command), args: s.args.map(geminiLiteral), ...(env.length ? { env: Object.fromEntries(env.map(([k, v]) => [k, geminiLiteral(v)])) } : {}) };
	};
	return JSON.stringify({ mcpServers: Object.fromEntries(entries.map(([name, s]) => [name, server(s)])) });
}

/** The gemini settings file of a run, and the env that points Gemini CLI at it. */
export function geminiMcp(ctx: Pick<LaunchContext, 'servers' | 'runDir'>): Extras {
	const content = geminiSystemDefaults(ctx.servers);
	if (!content || !ctx.runDir) return {};
	const path = `${ctx.runDir.replace(/\/+$/, '')}/gemini-system-defaults.json`;
	return { env: { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: path }, files: [{ path, content }] };
}

/**
 * Copilot CLI `--plugin-dir=DIR` (repeatable) mounts a plugin for this session only; its legacy
 * plugin manifest may be `.claude-plugin/plugin.json` and skills default to `skills/`
 * (docs.github.com copilot-cli-reference: cli-command-reference, cli-plugin-reference).
 */
export const copilotPluginArgs = (plugins: readonly string[]) => plugins.map((dir) => `--plugin-dir=${dir}`);

/** Copilot CLI `--additional-mcp-config`: `{ mcpServers: { name: { type: 'local', … } } }`. */
export function copilotMcpConfig(servers: McpServers): string | null {
	const entries = Object.entries(stdioOnly(servers));
	if (!entries.length) return null;
	return JSON.stringify({ mcpServers: Object.fromEntries(entries.map(([name, s]) => [name, { type: 'local', command: s.command, args: s.args, env: s.env, tools: ['*'] }])) });
}

/** Amp `--mcp-config`: the `amp.mcpServers` shape, `{ name: { command, args, env } }`. */
export function ampMcpConfig(servers: McpServers): string | null {
	const entries = Object.entries(stdioOnly(servers));
	if (!entries.length) return null;
	return JSON.stringify(Object.fromEntries(entries.map(([name, s]) => [name, { command: s.command, args: s.args, env: s.env }])));
}

// ---- profiles --------------------------------------------------------------------------------

/** What MCP servers and skills add to a launch: arguments right after the base command, env, files. */
type Extras = { args?: string[]; env?: Record<string, string>; files?: LaunchFile[] };

type Spec = Omit<AgentProfile, 'launch' | 'canResume' | 'mcp' | 'skills' | 'resumeNeedsId'> & {
	/**
	 * Where the prompt goes (Orca's promptInjectionMode): a positional argument (`sep`: always after
	 * `--`, Orca's argvPromptSeparator), a flag, Hermes' `chat --query=` form, or pasted once the CLI
	 * is up (`stdin-after-start`).
	 */
	prompt: { kind: 'argv'; sep?: boolean } | { kind: 'flag'; flag: string } | { kind: 'hermes' } | { kind: 'type' };
	/** The resume argv after the base command (null: the CLI cannot resume; a null result: not without an id). */
	resume: ((id: string | null) => string[] | null) | null;
	/**
	 * Arguments Orca's launchCmd puts after the program (`kiro-cli chat --tui`, `acli rovodev run`),
	 * added unless the command already has them; `resume: false` leaves them out of a resume.
	 */
	launchArgs?: { args: readonly string[]; resume?: boolean };
	mcp?: boolean;
	skills?: boolean;
	extras?: (ctx: LaunchContext) => Extras;
};

/** The session's status hook file (and opencode's plugin folder), as env for the CLI. */
export function hookEnv(ctx: Pick<LaunchContext, 'hookFile' | 'opencodeDir'>): Record<string, string> {
	return {
		...(ctx.hookFile ? { KINGU_AGENT_HOOK_FILE: ctx.hookFile } : {}),
		...(ctx.opencodeDir ? { OPENCODE_CONFIG_DIR: ctx.opencodeDir } : {})
	};
}

const envPrefix = (env: Record<string, string>) => {
	const e = Object.entries(env);
	return e.length ? ['env', ...e.map(([k, v]) => `${k}=${v}`)] : [];
};

/** `base` with `args` right after its program word, unless they already follow it. */
export function withLaunchArgs(base: readonly string[], args: readonly string[]): string[] {
	if (!args.length) return [...base];
	let i = 0;
	if (base[0] && programName(base[0]) === 'env') {
		i = 1;
		while (i < base.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(base[i])) i++;
	}
	if (i >= base.length) return [...base];
	const after = base.slice(i + 1);
	if (args.every((a, k) => after[k] === a)) return [...base];
	return [...base.slice(0, i + 1), ...args, ...after];
}

/** Hermes' startup query (Orca planHermesStartupQuery): `hermes chat --query=<prompt> … --tui`, its own `--tui`/`--query` dropped. */
function hermesQuery(head: readonly string[], prompt: string): string[] {
	let i = 0;
	if (head[0] && programName(head[0]) === 'env') {
		i = 1;
		while (i < head.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(head[i])) i++;
	}
	const rest = head.slice(i + 1).filter((a) => a !== 'chat' && a !== '--tui' && a !== '--cli' && !a.startsWith('--query='));
	return [...head.slice(0, i + 1), 'chat', `--query=${prompt}`, ...rest, '--tui'];
}

function simple(spec: Spec): AgentProfile {
	const { prompt, resume, mcp = false, skills = false, extras, launchArgs, ...rest } = spec;
	return {
		...rest,
		canResume: resume !== null,
		...(resume && resume(null) === null ? { resumeNeedsId: true } : {}),
		mcp,
		skills,
		launch(base, how, ctx) {
			const x = extras?.(skills ? ctx : { ...ctx, plugins: [] }) ?? {};
			const resuming = 'resume' in how;
			const cmd = launchArgs && (!resuming || launchArgs.resume !== false) ? withLaunchArgs(base, launchArgs.args) : base;
			const head = [...envPrefix({ ...(rest.status === 'agent-hooks' ? hookEnv(ctx) : {}), ...x.env }), ...cmd, ...(x.args ?? [])];
			const files = x.files?.length ? { files: x.files } : {};
			if ('resume' in how) {
				const r = resume?.(how.resume) ?? null;
				return { argv: r ? [...head, ...r] : head, ...files };
			}
			if ('fresh' in how) return { argv: head, ...files };
			if (prompt.kind === 'type') return { argv: head, typePrompt: how.prompt, ...files };
			if (prompt.kind === 'hermes') return { argv: hermesQuery(head, how.prompt), ...files };
			if (prompt.kind === 'flag') return { argv: [...head, ...valueFlag(prompt.flag, how.prompt)], ...files };
			return { argv: [...head, ...(prompt.sep ? ['--', how.prompt] : positional(how.prompt))], ...files };
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
		const head = [...envPrefix(hookEnv({ hookFile: ctx.hookFile })), ...base, ...codexMcpArgs(ctx.servers), ...(ctx.hookFile ? codexNotifyArgs(ctx.hookFile) : [])];
		if ('resume' in how) return { argv: [...head, 'resume', how.resume ?? '--last'] };
		if ('fresh' in how) return { argv: head };
		return { argv: [...head, ...positional(how.prompt)] };
	}
};

/** Status from hooks Kingu installs (status_hooks.rs); the others go by their terminal output. */
const H = 'agent-hooks' as const;
const O = 'output' as const;
const plain = { account: null, ownsSessionId: false } as const;
const byId = (...flags: string[]) => (id: string | null) => (id ? [...flags, id] : null);

/** Orca's agents beyond the ones above, in Orca's order. */
const ORCA_AGENTS: readonly Spec[] = [
	{ id: 'grok', title: 'Grok', bins: ['grok'], status: H, ...plain, prompt: { kind: 'argv', sep: true }, resume: byId('--resume') },
	{ id: 'devin', title: 'Devin', bins: ['devin'], status: H, ...plain, prompt: { kind: 'argv', sep: true }, resume: byId('--resume') },
	// The installer ships kiro-cli; `chat --tui` is the interactive TUI (its trust flags belong to chat).
	{ id: 'kiro', title: 'Kiro', bins: ['kiro-cli'], status: H, ...plain, launchArgs: { args: ['chat', '--tui'] }, prompt: { kind: 'type' }, resume: byId('--resume-id') },
	{ id: 'kimi', title: 'Kimi', bins: ['kimi', 'kimi-code'], status: H, ...plain, prompt: { kind: 'type' }, resume: byId('--session') },
	{ id: 'antigravity', title: 'Antigravity', bins: ['agy'], status: H, ...plain, prompt: { kind: 'flag', flag: '--prompt-interactive' }, resume: byId('--conversation') },
	{ id: 'qoder', title: 'Qoder CLI', bins: ['qodercli', 'qoder'], status: H, ...plain, prompt: { kind: 'flag', flag: '--prompt-interactive' }, resume: byId('--resume') },
	{ id: 'qoder-cn', title: 'Qoder CLI China', bins: ['qoderclicn', 'qodercn'], status: H, ...plain, prompt: { kind: 'flag', flag: '--prompt-interactive' }, resume: byId('--resume') },
	// `--trust` skips the first-run trust prompt, which would take the task text.
	{ id: 'command-code', title: 'Command Code', bins: ['command-code'], status: H, ...plain, launchArgs: { args: ['--trust'] }, prompt: { kind: 'argv' }, resume: null },
	// Bare hermes opens the classic REPL; `--tui` is the full-screen one; a prompt goes in as `chat --query=`.
	{ id: 'hermes', title: 'Hermes', bins: ['hermes'], status: H, ...plain, launchArgs: { args: ['--tui'], resume: false }, prompt: { kind: 'hermes' }, resume: byId('--resume') },
	{ id: 'codebuddy', title: 'CodeBuddy', bins: ['codebuddy', 'cbc'], status: H, ...plain, prompt: { kind: 'argv' }, resume: byId('--resume') },
	{ id: 'openclaude', title: 'OpenClaude', bins: ['openclaude'], status: H, ...plain, prompt: { kind: 'argv' }, resume: null },
	{ id: 'muse', title: 'Muse', bins: ['muse'], status: H, ...plain, launchArgs: { args: ['--trust-workspace'], resume: false }, prompt: { kind: 'type' }, resume: byId('resume') },
	{ id: 'zcode', title: 'ZCode', bins: ['zcode'], status: H, ...plain, prompt: { kind: 'type' }, resume: byId('--resume') },
	// dsh-tui needs the dsh backend; a bare first launch opens the session browser, `.` the composer.
	{ id: 'dsh', title: 'DeepSeek Harness', bins: ['dsh-tui', 'dst'], requires: ['dsh'], status: H, ...plain, launchArgs: { args: ['.'], resume: false }, prompt: { kind: 'type' }, resume: byId('--backend=dsh', '--resume') },
	{ id: 'jcode', title: 'Jcode', bins: ['jcode'], status: H, ...plain, prompt: { kind: 'type' }, resume: byId('--resume') },
	// pi resumes by its session file (`--session <file>`), which Kingu does not know.
	{ id: 'pi', title: 'Pi', bins: ['pi'], status: H, ...plain, prompt: { kind: 'argv' }, resume: null },
	{ id: 'omp', title: 'OMP', bins: ['omp'], status: H, ...plain, prompt: { kind: 'argv' }, resume: byId('--resume') },
	{ id: 'prime-agent', title: 'Prime Agent', bins: ['prime-agent'], status: O, ...plain, prompt: { kind: 'argv', sep: true }, resume: null },
	{ id: 'mimo-code', title: 'MiMo Code', bins: ['mimo'], status: H, ...plain, prompt: { kind: 'flag', flag: '--prompt' }, resume: byId('--session') },
	// The private server inherits this pane's hook env.
	{ id: 'opencode2', title: 'OpenCode 2', bins: ['opencode2'], status: H, ...plain, launchArgs: { args: ['--standalone'] }, prompt: { kind: 'flag', flag: '--prompt' }, resume: byId('--session') },
	{ id: 'goose', title: 'Goose', bins: ['goose'], status: O, ...plain, prompt: { kind: 'type' }, resume: null },
	{ id: 'kilo', title: 'Kilocode', bins: ['kilo'], status: O, ...plain, prompt: { kind: 'type' }, resume: null },
	{ id: 'crush', title: 'Charm', bins: ['crush'], status: O, ...plain, prompt: { kind: 'type' }, resume: null },
	{ id: 'aug', title: 'Auggie', bins: ['auggie'], status: O, ...plain, prompt: { kind: 'type' }, resume: null },
	{ id: 'cline', title: 'Cline', bins: ['cline'], status: O, ...plain, prompt: { kind: 'type' }, resume: byId('--id') },
	{ id: 'codebuff', title: 'Codebuff', bins: ['codebuff'], status: O, ...plain, prompt: { kind: 'type' }, resume: null },
	{ id: 'freebuff', title: 'Freebuff', bins: ['freebuff'], status: O, ...plain, prompt: { kind: 'type' }, resume: null },
	// The binary is `cn` (`continue` is a shell keyword).
	{ id: 'continue', title: 'Continue', bins: ['cn'], status: O, ...plain, prompt: { kind: 'type' }, resume: null },
	{ id: 'mistral-vibe', title: 'Mistral Vibe', bins: ['vibe', 'mistral-vibe'], status: O, ...plain, prompt: { kind: 'type' }, resume: null },
	// Rovo Dev is an acli subcommand; an instruction argument there would run one-shot.
	{ id: 'rovo', title: 'Rovo Dev', bins: ['acli'], status: O, ...plain, launchArgs: { args: ['rovodev', 'run'] }, prompt: { kind: 'type' }, resume: null },
	{ id: 'openclaw', title: 'OpenClaw', bins: ['openclaw'], status: O, ...plain, prompt: { kind: 'type' }, resume: null },
	{ id: 'autohand', title: 'Autohand Code', bins: ['autohand'], status: O, ...plain, prompt: { kind: 'type' }, resume: null },
	// `ante --prompt` is headless.
	{ id: 'ante', title: 'Ante', bins: ['ante'], status: O, ...plain, prompt: { kind: 'type' }, resume: null },
	// TRAE CN's own `traecli` (bytedance/trae-agent also installs trae-cli).
	{ id: 'trae', title: 'Trae', bins: ['traecli'], status: O, ...plain, prompt: { kind: 'argv', sep: true }, resume: null }
];

export const PROFILES: readonly AgentProfile[] = [
	claude,
	codex,
	simple({
		id: 'gemini',
		title: 'Gemini CLI',
		bins: ['gemini'],
		status: 'agent-hooks',
		account: null,
		ownsSessionId: false,
		prompt: { kind: 'flag', flag: '--prompt-interactive' },
		resume: (id) => ['--resume', id ?? 'latest'],
		// MCP through a settings file of the run (needs `runDir`); no per-run skills (see above).
		mcp: true,
		extras: geminiMcp
	}),
	simple({
		id: 'opencode',
		title: 'OpenCode',
		bins: ['opencode'],
		status: 'agent-hooks',
		account: null,
		ownsSessionId: false,
		prompt: { kind: 'flag', flag: '--prompt' },
		resume: (id) => (id ? ['--session', id] : ['--continue']),
		mcp: true,
		skills: true,
		extras: (ctx) => {
			const config = opencodeConfig(ctx.servers, ctx.plugins);
			return config ? { env: { OPENCODE_CONFIG_CONTENT: config } } : {};
		}
	}),
	simple({
		id: 'cursor',
		title: 'Cursor Agent',
		bins: ['cursor-agent'],
		status: 'agent-hooks',
		account: null,
		ownsSessionId: false,
		prompt: { kind: 'argv' },
		resume: (id) => (id ? ['--resume', id] : ['resume'])
	}),
	simple({
		id: 'copilot',
		title: 'GitHub Copilot CLI',
		bins: ['copilot'],
		status: 'agent-hooks',
		account: null,
		ownsSessionId: false,
		// `--prompt` runs once and exits; `--interactive` keeps the session.
		prompt: { kind: 'flag', flag: '--interactive' },
		resume: (id) => (id ? [`--resume=${id}`] : ['--continue']),
		mcp: true,
		skills: true,
		extras: (ctx) => {
			const config = copilotMcpConfig(ctx.servers);
			return { args: [...(config ? ['--additional-mcp-config', config] : []), ...copilotPluginArgs(ctx.plugins)] };
		}
	}),
	simple({
		id: 'amp',
		title: 'Amp',
		bins: ['amp'],
		// Kingu's Amp plugin (status_hooks.rs, Orca amp/agent-status-plugin-source.ts).
		status: 'agent-hooks',
		account: null,
		ownsSessionId: false,
		// `amp -x` is one-shot; the interactive TUI takes no prompt argument.
		prompt: { kind: 'type' },
		resume: (id) => ['threads', 'continue', ...(id ? [id] : [])],
		mcp: true,
		extras: (ctx) => {
			const config = ampMcpConfig(ctx.servers);
			return config ? { args: ['--mcp-config', config] } : {};
		}
	}),
	simple({
		id: 'droid',
		title: 'Factory Droid',
		bins: ['droid'],
		status: 'agent-hooks',
		account: null,
		ownsSessionId: false,
		prompt: { kind: 'argv' },
		resume: (id) => ['--resume', ...(id ? [id] : [])]
	}),
	simple({
		id: 'qwen',
		kind: 'qwen-code',
		title: 'Qwen Code',
		bins: ['qwen'],
		status: 'agent-hooks',
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
	}),
	// ---- the rest of Orca's TUI agents (shared/agent-launch/catalog/tui-agent-config.ts; resume argv
	// from shared/agent-launch/startup/agent-resume-argv.ts). `claude-agent-teams` is claude with
	// `kingu.agent.claudeAgentTeams` (agentCli.ts), not a profile of its own.
	...ORCA_AGENTS.map(simple)
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
	return p.canResume && !p.resumeNeedsId ? p.launch(argv, { resume: null }, { servers: {}, plugins: [] }).argv : null;
}

/** Every program name the picker looks for on PATH (with the ones a profile also requires). */
export const KNOWN_BINS: readonly string[] = [...new Set(PROFILES.flatMap((p) => [...p.bins, ...(p.requires ?? [])]))];

/** The profile's program found on PATH (`found`), with every program it also requires; else undefined. */
export function foundBin(p: AgentProfile, found: readonly string[]): string | undefined {
	if (!(p.requires ?? []).every((r) => found.includes(r))) return undefined;
	return p.bins.find((b) => found.includes(b));
}

// ---- the CLI picker ("Agent: Choose CLI…") ----------------------------------------------------

export const CUSTOM_PICK = '__custom';
export type PickRow = { id: string; label: string; description: string; /** The agent whose mark the row shows (agent/agentIcons.ts). */ agent?: string };

/** What Kingu does with the CLI, for the picker row. */
export function profileSummary(p: AgentProfile): string {
	const status = t(p.status === 'hooks' || p.status === 'agent-hooks' ? 'ade.agentProfiles.statusHooks' : p.status === 'notify' ? 'ade.agentProfiles.statusNotify' : 'ade.agentProfiles.statusOutput');
	return [status, p.canResume ? t('ade.agentProfiles.canResume') : null, p.mcp ? 'MCP' : null, p.skills ? 'skills' : null, p.account ? t('ade.agentProfiles.account', { account: p.account }) : null].filter(Boolean).join(' · ');
}

/** Picker rows: the profiles whose program is in `found`, in profile order. */
export function pickerItems(found: readonly string[], current: string): PickRow[] {
	const rows: PickRow[] = PROFILES.flatMap((p) => {
		const bin = foundBin(p, found);
		return bin ? [{ id: bin, label: p.title, description: `${bin} — ${profileSummary(p)}`, agent: p.id }] : [];
	});
	rows.push({ id: CUSTOM_PICK, label: 'Custom…', description: current ? t('ade.agentProfiles.current', { command: current }) : t('ade.agentProfiles.typeCommand') });
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
