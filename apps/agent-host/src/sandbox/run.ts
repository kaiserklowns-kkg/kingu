// A run's sandbox for the commands Kingu itself runs (Arkai's Bash tool): what a command is
// launched as and with which environment, and what a failed sandboxed run tells the model.
//
// - `launch`: the command under `sandbox-exec` (profile.ts) on macOS or bubblewrap (linux.ts) on
//   Linux, with the run's own `TMPDIR`; or, once
//   the user said yes to running it outside (the retry prompt, arkai/session.ts), the command as
//   is. On a machine that cannot sandbox it throws: with the setting on, a command never runs
//   bare unless the user approved exactly that.
// - Masked variables (`chat.agent.sandbox.credentials.envVars`): never in a command's
//   environment, sandboxed or not, and neither is another variable that carries the same value.
//   VS Code's runtime also gives the value back at a proxy for the listed HTTPS hosts
//   (`injectHosts`); Kingu does not, since that takes decrypting TLS (docs/ADE-PARITY.md item 7):
//   a masked variable is only hidden.
// - Domain lists: `ready` starts the run's filtering proxy (proxy.ts) when a list applies, and
//   a sandboxed launch then gets the proxy variables and a profile whose only way out is it. On
//   Linux the sandbox has no network namespace of its own, so `ready` also starts the bridge to
//   the proxy (linux.ts `ProxyBridge`), and it needs `socat`.
// - Reads: each launch adds the home paths its command's tools need (reads.ts) to the run's policy.
// - Denial detection: VS Code's `outputLooksSandboxBlocked` / `outputLooksSandboxNetworkBlocked`
//   (src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/sandboxOutputAnalyzer.ts)
//   and the note its SandboxOutputAnalyzer puts before a failed command's output.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxConfig } from './config.ts';
import { needsProxy, type DomainRules } from './domains.ts';
import { findSystemExecutable, hostFs, linuxArgv, probeBwrap, ProxyBridge, removeMountPoints, socatMissing, type FsView } from './linux.ts';
import { gitDirs, macosArgv, policy, sandboxBackend, withGrants, type Backend, type Policy } from './profile.ts';
import { DomainProxy, upstreamFrom, type ProxyOptions } from './proxy.ts';
import { commandGrants, pathDirsInHome } from './reads.ts';
import { applyGrant, blockedLine, diagnose, type Diagnosis, type Refusal, type SandboxGrant } from './retry.ts';

export type Env = Record<string, string | undefined>;

/** A value this long that equals or sits inside another variable's is taken as the same secret. */
const MIN_SECRET = 8;

/**
 * `env` without the masked variables, and without any other variable whose value contains a
 * masked one (a token exported under two names, a URL with the password in it). Names compare
 * exactly, or without case on Windows, where the environment is case-insensitive.
 */
export function maskEnv(env: Env, masked: readonly string[], platform: string = process.platform): Env {
	if (!masked.length) return { ...env };
	const fold = (n: string) => (platform === 'win32' ? n.toUpperCase() : n);
	const names = new Set(masked.map(fold));
	const secrets = Object.entries(env)
		.filter(([k, v]) => names.has(fold(k)) && typeof v === 'string' && v.length >= MIN_SECRET)
		.map(([, v]) => v as string);
	const out: Env = {};
	for (const [k, v] of Object.entries(env)) {
		if (names.has(fold(k))) continue;
		if (typeof v === 'string' && secrets.some((s) => v.includes(s))) continue;
		out[k] = v;
	}
	return out;
}

export type Denial = 'network' | 'filesystem';

/** VS Code's `outputLooksSandboxBlocked` (terminal wrapping's newlines are folded first). */
const BLOCKED = /Operation not permitted|Permission denied|Read-only file system|sandbox-exec|bwrap|sandbox_violation|No such file or directory/i;
/** VS Code's `outputLooksSandboxNetworkBlocked`, plus newer curl's words for a proxy's refusal. */
const NETWORK_BLOCKED =
	/CONNECT tunnel failed, response 403|Could not resolve host|Temporary failure in name resolution|Name or service not known|EAI_AGAIN|ENETUNREACH|Network is unreachable|Received HTTP code 403 from proxy after CONNECT|SOCKS(?:v?5)? error|not allowed by ruleset|network (?:access )?(?:blocked|disabled)|(?:connect|socket).*(?:Operation not permitted|Permission denied)|(?:Operation not permitted|Permission denied).*(?:connect|socket)/i;

/** What in a sandboxed command's output looks like the sandbox stopped it, or null. */
export function classifyDenial(output: string): Denial | null {
	const text = output.replace(/\n/g, ' ');
	if (NETWORK_BLOCKED.test(text)) return 'network';
	return BLOCKED.test(text) ? 'filesystem' : null;
}

/** `sandbox-exec` or `bwrap` itself could not set the sandbox up (e.g. this process is already sandboxed, or user namespaces are off). */
export const applyFailed = (code: number | null, output: string) => code !== 0 && /sandbox-exec: |sandbox_apply|^bwrap: /m.test(output.slice(0, 2000));

/**
 * What goes before the output of a sandboxed command that failed (VS Code's
 * SandboxOutputAnalyzer, with Kingu's setting and parameter names).
 */
export function failureNote(
	c: Pick<SandboxConfig, 'allowUnsandboxedCommands' | 'allowNetwork'> & Partial<Pick<SandboxConfig, 'allowedDomains' | 'deniedDomains'>>,
	output: string,
	diagnosis: Pick<Diagnosis, 'blocked'> | null = null
): string {
	const denial = classifyDenial(output);
	const lines = ['Command failed while running in sandboxed mode. If the command failed due to sandboxing:'];
	// Kingu-only: the rule that stopped it, when Kingu could tell (retry.ts).
	const by = diagnosis ? blockedLine(diagnosis.blocked) : null;
	if (by) lines.push(by);
	const lists = !!(c.allowedDomains?.length || c.deniedDomains?.length);
	if (denial === 'network' && lists)
		lines.push('- The output looks like blocked network access: the sandbox only reaches the domains chat.agent.sandbox.network.allowedDomains allows and deniedDomains does not deny, through its proxy (HTTP(S), SOCKS5, git over ssh).');
	else if (denial === 'network' && !c.allowNetwork) lines.push('- The output looks like blocked network access: the sandbox allows no outbound network (chat.agent.sandbox.network.allowNetwork is off).');
	else if (denial === 'filesystem') lines.push('- The output looks like a blocked file access: the sandbox only allows writes in the project folder and $TMPDIR, and reads in the home folder only in the project folder and the tool folders the command needs.');
	lines.push(
		'- If it would be reasonable to extend the sandbox rules, tell the user which path to add to readwritePaths in chat.agent.sandbox.fileSystem.userConfiguredPaths.',
		c.allowUnsandboxedCommands
			? '- Otherwise retry the command with requestUnsandboxedExecution=true and provide requestUnsandboxedExecutionReason. Do NOT ask the user: setting this flag shows them a confirmation prompt.'
			: '- Running commands outside the sandbox is disabled by chat.agent.sandbox.allowUnsandboxedCommands. Do not set requestUnsandboxedExecution=true.'
	);
	return `${lines.join('\n')}\n\nHere is the output of the command:\n`;
}

/** How a command reaches the network through the proxy (proxy.ts `env`). */
const VIA_PROXY = 'HTTP(S) clients use HTTPS_PROXY, other TCP clients ALL_PROXY (SOCKS5), git over ssh GIT_SSH_COMMAND; for ssh itself run `eval "$GIT_SSH_COMMAND" user@host`.';

/** What the Bash tool tells the model about the sandbox (VS Code's `createSandboxLines`). */
export function sandboxLines(c: Pick<SandboxConfig, 'allowUnsandboxedCommands' | 'allowNetwork' | 'allowLocalNetwork'> & Partial<Pick<SandboxConfig, 'allowedDomains' | 'deniedDomains'>>): string {
	const allowed = c.allowedDomains ?? [];
	const denied = c.deniedDomains ?? [];
	const network = allowed.length
		? `- Network access in the sandbox is limited to these domains, through the sandbox's proxy: ${allowed.join(', ')}${denied.length ? `; except ${denied.join(', ')}` : ''}. ${VIA_PROXY}`
		: c.allowNetwork && denied.length
			? `- The network is available in the sandbox through its proxy, except these domains: ${denied.join(', ')}. ${VIA_PROXY}`
			: c.allowNetwork
				? '- The network is available in the sandbox.'
				: `- All network access is blocked in the sandbox${c.allowLocalNetwork ? ' except localhost' : ''}.`;
	return [
		'Sandboxing:',
		'- Commands run in a sandbox by default: files can be written only in the project folder and $TMPDIR.',
		'- Anything that needs a temporary directory must use $TMPDIR. /tmp is not writable.',
		'- Files in the home folder outside the project folder are not readable, except the tool folders a command needs (e.g. ~/.gitconfig for git, ~/.cargo for cargo).',
		network,
		...(c.allowUnsandboxedCommands
			? [
					"- When a command fails due to sandbox restrictions (e.g. 'Operation not permitted', network failures, file access errors), re-run it with requestUnsandboxedExecution=true and requestUnsandboxedExecutionReason saying why. Do NOT ask the user for permission: setting this flag shows them a confirmation prompt.",
					'- Do NOT set requestUnsandboxedExecution=true without first running the command in the sandbox and seeing it fail because of the sandbox.'
				]
			: ['- Running commands outside the sandbox is disabled by chat.agent.sandbox.allowUnsandboxedCommands. Do not set requestUnsandboxedExecution=true.'])
	].join('\n');
}

/** `done`: call once the command has exited (Linux removes the mount points it left for missing paths). */
export type Launch = { argv: string[]; env: Env; sandboxed: boolean; done?: () => void };

export class SandboxUnavailable extends Error {}

export type SandboxDeps = {
	platform?: string;
	home?: string;
	tmpRoot?: string;
	exists?: (p: string) => boolean;
	proxy?: Pick<ProxyOptions, 'resolve' | 'isLocal'>;
	/** Linux: `/proc/version` (WSL 1 cannot sandbox), the bwrap capability probe (null: works), the file system the mounts are made from. */
	procVersion?: () => string | null;
	probe?: (bwrap: string) => string | null;
	fs?: FsView;
};

/** One run's sandbox: its policy is made once (the working folder does not change), its temp folder on first use. */
export class RunSandbox {
	readonly problem: string | null;
	private readonly backend: Backend;
	/** Linux: the bwrap probe's answer, once asked (null: it works). */
	private probed: string | null | undefined;
	private bridge: ProxyBridge | null = null;
	private bridgeDir: string | null = null;
	/** Linux: commands still running, and the mount points to remove once none is. */
	private running = 0;
	private mountPoints = new Set<string>();
	private tmp: string | null = null;
	private cached: Policy | null = null;
	private proxy: DomainProxy | null = null;
	private starting: Promise<DomainProxy> | null = null;
	rules: DomainRules;
	/** Hosts the proxy refused, numbered, for `diagnose` (the last 200). */
	private refusals: (Refusal & { seq: number })[] = [];
	private refusalSeq = 0;

	constructor(
		/** The run's settings; `grant` widens them for the rest of the run. */
		public config: SandboxConfig,
		private readonly cwd: string,
		private readonly deps: SandboxDeps = {}
	) {
		this.backend = sandboxBackend(deps.platform ?? process.platform, deps.exists, deps.procVersion);
		this.problem = this.backend.kind === 'none' ? this.backend.problem : null;
		this.rules = { open: config.allowNetwork, allowed: config.allowedDomains, denied: config.deniedDomains };
	}

	/**
	 * Starts the filtering proxy when a domain list applies (once per run; `env` gives the upstream
	 * proxy, if any). Before every sandboxed launch: without it, such a launch has no network.
	 */
	async ready(env: Env): Promise<void> {
		if (this.proxy || this.problem || !needsProxy(this.rules)) return;
		const linux = this.backend.kind === 'bwrap';
		if (linux && !this.socat()) throw new Error(socatMissing());
		this.starting ??= DomainProxy.start({
			rules: this.rules,
			localNetwork: this.config.allowLocalNetwork,
			upstream: upstreamFrom(env),
			onRefused: (host, why) => {
				this.refusals.push({ host, why, seq: ++this.refusalSeq });
				if (this.refusals.length > 200) this.refusals.splice(0, this.refusals.length - 200);
			},
			...this.deps.proxy
		});
		let proxy: DomainProxy;
		try {
			proxy = await this.starting;
		} finally {
			this.starting = null;
		}
		if (linux && !this.bridge) {
			try {
				// Outside the run's temp folder, which sandboxed commands can write (and so remove the socket from).
				const root = this.deps.tmpRoot ?? tmpdir();
				mkdirSync(root, { recursive: true });
				this.bridgeDir ??= mkdtempSync(join(root, 'kingu-sbx-net-'));
				this.bridge = await ProxyBridge.start(join(this.bridgeDir, 'proxy.sock'), proxy.port);
			} catch (e) {
				proxy.close();
				throw e;
			}
		}
		this.proxy = proxy;
		this.cached = null;
	}

	private socat(): string | null {
		return findSystemExecutable('socat', this.deps.exists);
	}

	get home() {
		return this.deps.home ?? homedir();
	}

	/** The run's own temp folder (0700), the only temp place a sandboxed command may write. */
	private tmpDir(): string {
		if (!this.tmp) {
			const root = this.deps.tmpRoot ?? tmpdir();
			mkdirSync(root, { recursive: true });
			this.tmp = mkdtempSync(join(root, 'kingu-sandbox-'));
		}
		return this.tmp;
	}

	policy(): Policy {
		return (this.cached ??= policy(this.config, { cwd: this.cwd, home: this.home, tmp: this.tmpDir(), git: gitDirs(this.cwd), proxyPort: this.proxy?.port ?? null }));
	}

	/**
	 * How `argv` (a shell and its command) is launched. `unsandboxed`: the user approved running
	 * this one outside. Throws `SandboxUnavailable` when it must be sandboxed and cannot be.
	 */
	launch(argv: string[], env: Env, unsandboxed: boolean): Launch {
		const clean = maskEnv(env, this.config.maskedEnv, this.deps.platform ?? process.platform);
		if (unsandboxed) {
			if (!this.config.allowUnsandboxedCommands) throw new SandboxUnavailable('Unsandboxed execution is disabled by the chat.agent.sandbox.allowUnsandboxedCommands setting.');
			return { argv, env: clean, sandboxed: false };
		}
		if (this.problem)
			throw new SandboxUnavailable(
				`The command was not run: the sandbox is on (chat.agent.sandbox.enabled) and ${this.problem}.${this.config.allowUnsandboxedCommands ? ' Retry with requestUnsandboxedExecution=true and requestUnsandboxedExecutionReason to ask the user to run it outside the sandbox.' : ''}`
			);
		if (this.backend.kind === 'bwrap') {
			this.probed ??= (this.deps.probe ?? probeBwrap)(this.backend.bwrap);
			if (this.probed) throw new SandboxUnavailable(`The command was not run: the sandbox is on (chat.agent.sandbox.enabled) and ${this.probed}`);
		}
		const tmp = this.tmpDir();
		const base = this.policy();
		const platform = this.deps.platform ?? process.platform;
		// The command's own tools (VS Code: per command, with its per-OS lists) and the PATH folders in home.
		const grants = commandGrants(argv.at(-1) ?? '', platform);
		const p = withGrants(base, { read: [...grants.read, ...pathDirsInHome(clean.PATH, this.home)], write: grants.write }, this.home);
		const proxyEnv = base.proxyPort !== null && this.proxy ? this.proxy.env(this.config.allowLocalNetwork, platform) : {};
		const launchEnv = { ...clean, ...proxyEnv, TMPDIR: tmp };
		if (this.backend.kind !== 'bwrap') return { argv: macosArgv(p, argv), env: launchEnv, sandboxed: true };
		const socat = this.socat();
		// No bridge up (before `ready`): no network at all, the same as macOS before its proxy starts.
		const link = base.proxyPort !== null && this.bridge && socat ? { socket: this.bridge.socket, port: base.proxyPort, socat } : null;
		const out = linuxArgv(this.backend.bwrap, p, argv, { cwd: this.cwd, link }, this.deps.fs ?? hostFs);
		for (const m of out.created) this.mountPoints.add(m);
		this.running++;
		let once = false;
		const done = () => {
			if (once) return;
			once = true;
			// A mount point removed while another command still runs would detach that command's mount.
			if (--this.running > 0) return;
			removeMountPoints([...this.mountPoints]);
			this.mountPoints.clear();
		};
		return { argv: out.argv, env: launchEnv, sandboxed: true, done };
	}

	/** A mark before a launch: `diagnose` then looks only at the proxy's refusals after it. */
	refusalMark(): number {
		return this.refusalSeq;
	}

	/**
	 * What the sandbox stopped in a failed command, the rule that stopped it and the grant to offer
	 * (retry.ts). `mark`: from `refusalMark` before the command started.
	 */
	diagnose(output: string, command: string, mark: number): Diagnosis {
		const refusals = this.refusals.filter((r) => r.seq > mark).map(({ host, why }) => ({ host, why }));
		try {
			return diagnose(classifyDenial(output), output, { config: this.config, policy: this.policy(), cwd: this.cwd, home: this.home, command, refusals });
		} catch {
			// A path the profile cannot carry (control characters): nothing to offer.
			return { grant: null, blocked: [] };
		}
	}

	/** The user allowed `g` for the rest of the run: the next launch has it. */
	grant(g: SandboxGrant) {
		this.config = applyGrant(this.config, g);
		this.rules = { open: this.config.allowNetwork, allowed: this.config.allowedDomains, denied: this.config.deniedDomains };
		this.proxy?.setRules(this.rules);
		this.cached = null;
	}

	/** The run ended: its proxy stops, its temp folder goes. */
	dispose() {
		this.proxy?.close();
		this.proxy = null;
		this.bridge?.close();
		this.bridge = null;
		if (this.bridgeDir) rmSync(this.bridgeDir, { recursive: true, force: true });
		this.bridgeDir = null;
		removeMountPoints([...this.mountPoints]);
		this.mountPoints.clear();
		if (!this.tmp) return;
		try {
			rmSync(this.tmp, { recursive: true, force: true });
		} catch {
			// Left for the OS to clean.
		}
		this.tmp = null;
	}
}
