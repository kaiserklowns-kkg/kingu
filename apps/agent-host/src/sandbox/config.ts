// The agent sandbox's settings as the host gets them with `start` (`sandbox`), in the shape of VS
// Code's agent host config (src/vs/platform/agentHost/common/sandboxConfigSchema.ts,
// `ISandboxConfigValue`; the setting ids are `chat.agent.sandbox.*`,
// src/vs/platform/sandbox/common/settings.ts). Rust reads them from the user's settings.json only
// (agent/sandbox.rs) and sends them as they are: they are checked here, and a value that does not
// fit refuses the run instead of being skipped, so a mistyped masked variable or denied path never
// runs as if it were not there.
//
// What each runtime does with it:
// - Arkai: Kingu runs its Bash tool itself, under `sandbox-exec` (profile.ts, run.ts).
// - Claude: the Agent SDK's own sandbox (`claudeSandbox`), which wraps the Bash tool the SDK runs.
// - Codex and ACP agents run their own tools: not covered (host.ts says so in the run's log).

import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import { normalizeDomainPattern } from './domains.ts';

/** VS Code's `AgentHostSandboxKey` names (the wire keys). */
export type SandboxParam = {
	enabled?: unknown;
	allowNetwork?: unknown;
	allowLocalNetwork?: unknown;
	allowUnsandboxedCommands?: unknown;
	credentials?: unknown;
	'fileSystem.userConfiguredPaths'?: unknown;
	/** `chat.agent.sandbox.network.allowedDomains` / `deniedDomains` (VS Code's `AgentHostSandboxKey`). */
	allowedNetworkDomains?: unknown;
	deniedNetworkDomains?: unknown;
};

export type SandboxConfig = {
	/** `chat.agent.sandbox.network.allowNetwork` (VS Code's default: true). False: no IP networking. */
	allowNetwork: boolean;
	/** `chat.agent.sandbox.network.allowLocalNetwork`: with the network off, loopback still works. */
	allowLocalNetwork: boolean;
	/** `chat.agent.sandbox.allowUnsandboxedCommands`: a command may run outside after the user's yes. */
	allowUnsandboxedCommands: boolean;
	/** `chat.agent.sandbox.fileSystem.userConfiguredPaths`. Precedence: denied > readonly > readwrite. */
	readwritePaths: string[];
	readonlyPaths: string[];
	deniedPaths: string[];
	/** `chat.agent.sandbox.credentials.envVars`: the names hidden from every command of the run. */
	maskedEnv: string[];
	/**
	 * `chat.agent.sandbox.network.allowedDomains` / `deniedDomains`, normalized (domains.ts). Denied
	 * wins; an allow list is the only way out when there is one (also with the network off).
	 */
	allowedDomains: string[];
	deniedDomains: string[];
};

export class SandboxConfigError extends Error {}

const MAX_PATHS = 200;
const MAX_PATH = 4096;
const MAX_MASKED = 200;
const MAX_DOMAINS = 500;
/** A POSIX environment variable name. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function flag(v: unknown, key: string, fallback: boolean): boolean {
	if (v === undefined || v === null) return fallback;
	if (typeof v !== 'boolean') throw new SandboxConfigError(`chat.agent.sandbox.${key} must be true or false`);
	return v;
}

function paths(v: unknown, key: string): string[] {
	if (v === undefined || v === null) return [];
	if (!Array.isArray(v) || v.length > MAX_PATHS || !v.every((p) => typeof p === 'string' && p.trim() !== '' && p.length <= MAX_PATH && !/[\0-\x1f\x7f]/.test(p)))
		throw new SandboxConfigError(`chat.agent.sandbox.fileSystem.userConfiguredPaths.${key} must be a list of at most ${MAX_PATHS} paths`);
	return [...new Set(v as string[])];
}

/** A domain list, each pattern in VS Code's normalized form; one that is not a pattern refuses the run. */
function domains(v: unknown, key: string): string[] {
	if (v === undefined || v === null) return [];
	const setting = `chat.agent.sandbox.network.${key}`;
	if (!Array.isArray(v) || v.length > MAX_DOMAINS) throw new SandboxConfigError(`${setting} must be a list of at most ${MAX_DOMAINS} domains`);
	const out: string[] = [];
	for (const p of v) {
		const n = typeof p === 'string' && p.length <= 300 ? normalizeDomainPattern(p) : undefined;
		if (!n) throw new SandboxConfigError(`${setting}: ${JSON.stringify(String(p).slice(0, 80))} is not a domain pattern (example.com, *.example.com or *)`);
		out.push(n);
	}
	return [...new Set(out)];
}

/** The masked variable names of `credentials` (`{ envVars: { NAME: { injectHosts: [...] } } }`, or null). */
function masked(v: unknown): string[] {
	if (v === undefined || v === null) return [];
	if (!isObj(v)) throw new SandboxConfigError('chat.agent.sandbox.credentials.envVars must be an object of variable names');
	const vars = v.envVars;
	if (vars === undefined || vars === null) return [];
	if (!isObj(vars) || Object.keys(vars).length > MAX_MASKED) throw new SandboxConfigError('chat.agent.sandbox.credentials.envVars must be an object of variable names');
	for (const [name, entry] of Object.entries(vars)) {
		// The message names the key, never a value: a secret pasted as the key's value stays out of the log.
		if (!ENV_NAME.test(name)) throw new SandboxConfigError(`chat.agent.sandbox.credentials.envVars: ${JSON.stringify(name.slice(0, 80))} is not an environment variable name`);
		if (!isObj(entry) || !Array.isArray(entry.injectHosts) || !entry.injectHosts.every((h) => typeof h === 'string'))
			throw new SandboxConfigError(`chat.agent.sandbox.credentials.envVars.${name} must be { "injectHosts": [hosts] }`);
	}
	return Object.keys(vars);
}

/**
 * The run's sandbox from the `start` parameter: null when it is off (absent, or `enabled` not
 * `on`). Throws `SandboxConfigError` for anything else that does not fit.
 */
export function sandboxConfig(raw: unknown): SandboxConfig | null {
	if (raw === undefined || raw === null) return null;
	if (!isObj(raw)) throw new SandboxConfigError('sandbox must be an object');
	const p = raw as SandboxParam;
	// VS Code's `AgentSandboxEnabledValue` (`off` | `on`); the older boolean form means the same.
	if (p.enabled === undefined || p.enabled === null || p.enabled === 'off' || p.enabled === false) return null;
	if (p.enabled !== 'on' && p.enabled !== true) throw new SandboxConfigError('chat.agent.sandbox.enabled must be "on" or "off"');
	const fs = p['fileSystem.userConfiguredPaths'];
	if (fs !== undefined && fs !== null && !isObj(fs)) throw new SandboxConfigError('chat.agent.sandbox.fileSystem.userConfiguredPaths must be an object');
	const f = (fs ?? {}) as Record<string, unknown>;
	const denied = paths(f.deniedPaths, 'deniedPaths');
	const readonly = paths(f.readonlyPaths, 'readonlyPaths').filter((x) => !denied.includes(x));
	return {
		allowNetwork: flag(p.allowNetwork, 'network.allowNetwork', true),
		allowLocalNetwork: flag(p.allowLocalNetwork, 'network.allowLocalNetwork', false),
		allowUnsandboxedCommands: flag(p.allowUnsandboxedCommands, 'allowUnsandboxedCommands', true),
		// VS Code's buildSandboxConfigForSdk: each path in exactly one list.
		readwritePaths: paths(f.readwritePaths, 'readwritePaths').filter((x) => !denied.includes(x) && !readonly.includes(x)),
		readonlyPaths: readonly,
		deniedPaths: denied,
		maskedEnv: masked(p.credentials),
		allowedDomains: domains(p.allowedNetworkDomains, 'allowedDomains'),
		deniedDomains: domains(p.deniedNetworkDomains, 'deniedDomains')
	};
}

/**
 * The Claude Agent SDK's `sandbox` option for a run: its own sandbox (Seatbelt on macOS,
 * bubblewrap on Linux) around the Bash tool it runs. `failIfUnavailable` stays the SDK's default
 * for this option (true): a machine that cannot sandbox ends the run instead of running bare.
 * Bash keeps its permission prompts (`autoAllowBashIfSandboxed: false`): the sandbox is a second
 * layer, not a reason to ask less. A masked variable is `deny` (unset for sandboxed commands),
 * not `mask`: the SDK puts a masked value back only on requests its proxy decrypts, which for
 * HTTPS takes its experimental `tlsTerminate` (a man-in-the-middle CA that sandboxed commands
 * must trust) or `allowPlaintextInject` (the secret in cleartext). Kingu turns on neither, so
 * `injectHosts` is not honoured (see docs/ADE-PARITY.md item 7).
 *
 * The SDK's `deny` holds for sandboxed commands only: one the user lets run outside would see
 * the variable. So the host also takes the masked variables out of the session's own environment
 * (host.ts, `claudeEnv`); `keptMasked` are the ones it could not take out (the account Kingu
 * signed the session in with), and while there are any, no command may leave the sandbox.
 */
export function claudeSandbox(c: SandboxConfig, keptMasked: readonly string[] = []): SandboxSettings {
	const denyWrite = [...c.readonlyPaths, ...c.deniedPaths];
	return {
		enabled: true,
		autoAllowBashIfSandboxed: false,
		allowUnsandboxedCommands: c.allowUnsandboxedCommands && keptMasked.length === 0,
		// The SDK's sandbox sends commands through its own proxy and asks about each new host
		// (`SandboxNetworkAccess`). Network on (VS Code's default): every host is on the allowlist and
		// loopback is reachable. Off: nothing is on it and nothing is asked about. The domain lists go
		// to the SDK's own `allowedDomains` / `deniedDomains` with the same reading as Arkai's proxy
		// (domains.ts `hostAllowed`): denied always, an allow list replaces `*`, and no host outside
		// the lists is asked about (`strictAllowlist`).
		network: {
			allowedDomains: c.allowedDomains.length ? c.allowedDomains : c.allowNetwork ? ['*'] : [],
			...(c.deniedDomains.length ? { deniedDomains: c.deniedDomains } : {}),
			...(c.allowNetwork && !c.allowedDomains.length ? {} : { strictAllowlist: true }),
			...(c.allowNetwork || c.allowLocalNetwork ? { allowLocalBinding: true } : {})
		},
		...(c.readwritePaths.length || denyWrite.length || c.deniedPaths.length
			? {
					filesystem: {
						...(c.readwritePaths.length ? { allowWrite: c.readwritePaths } : {}),
						...(denyWrite.length ? { denyWrite } : {}),
						...(c.deniedPaths.length ? { denyRead: c.deniedPaths } : {})
					}
				}
			: {}),
		...(c.maskedEnv.length ? { credentials: { envVars: c.maskedEnv.map((name) => ({ name, mode: 'deny' as const })) } } : {})
	};
}
