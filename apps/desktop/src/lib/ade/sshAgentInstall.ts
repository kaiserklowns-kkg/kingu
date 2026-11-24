// Agent CLIs Kingu installs on an SSH host (Rust ssh_agent_install.rs): what SSH Hosts › Agents
// says for each, and whether the missing-agent prompt of an SSH project may offer an install.
// Pure, so `bun test` covers it; the store is sshAgentInstalls.svelte.ts.
//
// Orca installs an agent CLI on whichever host runs it (`managedRuntime.install`, answered by the
// host's own server: src/main/runtime/rpc/methods/host-management/managed-runtime-install.ts) and
// shows it with the same view as a local one (src/renderer/src/components/managed-runtime/
// managed-runtime-install-view.ts). Kingu reuses its local row's status shape (agent/managedCli.ts)
// and, like its terminal holder (sshHolder.ts), asks first: Install / Not now / Never for this host.

import { t } from '#lib/i18n/index.ts';
import { megabytes, parseStatus, type ManagedAction, type ManagedPhase, type ManagedStatus } from '#lib/agent/managedCli.ts';

/** Rust `RemoteStatus`: the local status plus the host, the launcher's name and why it can't be installed. */
export type HostAgentStatus = ManagedStatus & {
	host: string;
	/** The name a terminal on the host starts it by (`cursor-agent`). */
	command: string;
	unavailable: string | null;
	/** The user's own copy on the host, when there is one. */
	externalPath: string | null;
};

/** Rust `HostAgents`. */
export type HostAgents = { host: string; platform: string; build: string | null; problem: string | null; agents: HostAgentStatus[] };

/**
 * The agents Rust's `catalog()` can install on a host, by Kingu's profile id (agentProfiles.ts):
 * Orca's `MANAGED_AGENT_CLI_IDS` without Grok, whose package needs brotli on the host.
 */
export const REMOTE_INSTALLABLE: readonly string[] = ['claude', 'codex', 'opencode', 'opencode2', 'cursor', 'copilot', 'kimi', 'omp', 'antigravity'];

const str = (x: unknown) => (typeof x === 'string' ? x : null);

export function parseHostStatus(v: unknown): HostAgentStatus | null {
	const base = parseStatus(v);
	if (!base) return null;
	const s = v as Record<string, unknown>;
	if (typeof s.host !== 'string') return null;
	return { ...base, host: s.host, command: str(s.command) ?? base.agent, unavailable: str(s.unavailable), externalPath: str(s.externalPath) };
}

export function parseHostAgents(v: unknown): HostAgents | null {
	if (!v || typeof v !== 'object') return null;
	const h = v as Record<string, unknown>;
	if (typeof h.host !== 'string') return null;
	const agents = Array.isArray(h.agents) ? h.agents.flatMap((a) => parseHostStatus(a) ?? []) : [];
	return { host: h.host, platform: str(h.platform) ?? '', build: str(h.build), problem: str(h.problem), agents };
}

/** A status from an event replaces its row; the rest of the host's listing stays. */
export function withStatus(h: HostAgents, s: HostAgentStatus): HostAgents {
	const agents = h.agents.some((a) => a.agent === s.agent) ? h.agents.map((a) => (a.agent === s.agent ? s : a)) : [...h.agents, s];
	return { ...h, agents };
}

const RUNNING: readonly ManagedPhase[] = ['downloading', 'extracting', 'verifying', 'removing'];
export const isBusy = (s: HostAgentStatus | null | undefined) => !!s?.operation && RUNNING.includes(s.operation.phase);

export type HostAgentView = {
	status: string | null;
	error: string | null;
	/** Percent downloaded, while a download of known size runs. */
	progress: number | null;
	action: ManagedAction | null;
	removable: boolean;
};

const size = (bytes: number | null) => (bytes ? String(Math.ceil(bytes / 1_000_000)) : null);

/** SSH Hosts › Agents, one row (Orca `managedRuntimeInstallView` for a remote host). */
export function hostAgentView(s: HostAgentStatus, cancelling = false): HostAgentView {
	const agent = s.label;
	const op = s.operation;
	if (op?.phase === 'removing') return { status: t('sshAgentInstall.removing'), error: null, progress: null, action: null, removable: false };
	if (op && RUNNING.includes(op.phase)) {
		const { downloadedBytes: done, totalBytes: total } = op;
		const status = cancelling
			? t('sshAgentInstall.cancelling')
			: op.phase === 'extracting'
				? t('sshAgentInstall.extracting', { agent })
				: op.phase === 'verifying'
					? t('sshAgentInstall.verifying', { agent })
					: total === null
						? t('sshAgentInstall.downloading', { done: megabytes(done) })
						: t('sshAgentInstall.downloadingOf', { done: megabytes(done), total: megabytes(total) });
		return { status, error: null, progress: op.phase === 'downloading' && total ? Math.min(100, (done / total) * 100) : null, action: { kind: 'cancel', label: t('sshAgentInstall.cancel'), operation: op.id }, removable: false };
	}
	const failed = op?.phase === 'failed';
	const error = failed ? t(op.kind === 'install' ? 'sshAgentInstall.failed' : 'sshAgentInstall.removeFailed', { agent, error: op.error ?? '' }) : null;
	const view = (status: string | null, label: string | null): HostAgentView => ({ status, error, progress: null, action: label === null ? null : { kind: 'install', label }, removable: s.canRemove });
	// The user's own copy runs on the host; installing Kingu's would add nothing.
	if (s.source === 'external') return view(t('sshAgentInstall.external'), null);
	if (s.installedVersion !== null) return view(t('sshAgentInstall.installed', { version: s.installedVersion }), s.available && s.version !== null && !s.installedCurrent ? t('sshAgentInstall.update') : null);
	if (!s.available) return view(s.unavailable, null);
	if (op?.kind === 'install' && op.phase === 'cancelled') return view(t('sshAgentInstall.cancelled'), t('sshAgentInstall.tryAgain'));
	if (op?.kind === 'install' && failed) return view(null, t('sshAgentInstall.tryAgain'));
	const mb = size(s.downloadBytes);
	const detail = mb === null ? null : s.downloadHost ? t('sshAgentInstall.size', { size: mb, from: s.downloadHost }) : t('sshAgentInstall.sizeOnly', { size: mb });
	return view([t('sshAgentInstall.notInstalled'), detail].filter(Boolean).join(' '), t('sshAgentInstall.install'));
}

/** What the install question says: the size and where it comes from, when known. */
export function askText(s: HostAgentStatus, host: string): string {
	const mb = size(s.downloadBytes);
	const sized = mb !== null && s.downloadHost ? t('sshAgentInstall.askSize', { size: mb, from: s.downloadHost }) : '';
	return t('sshAgentInstall.ask', { agent: s.label, host, size: sized });
}

/**
 * Whether the missing-agent prompt may offer to install `agent` (a profile id) on `host`: Kingu
 * can install it there and the user didn't say Never for it on this host.
 */
export function mayOffer(agent: string, host: string, never: Readonly<Record<string, readonly string[]>>): boolean {
	return REMOTE_INSTALLABLE.includes(agent) && !(never[host] ?? []).includes(agent);
}

/** The kept Never answers (`kingu.ssh.agentInstallNever`: host → agent ids), read defensively. */
export function parseNever(raw: string | null): Record<string, string[]> {
	try {
		const v: unknown = raw ? JSON.parse(raw) : null;
		if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
		const out: Record<string, string[]> = {};
		for (const [host, ids] of Object.entries(v as Record<string, unknown>)) {
			const list = Array.isArray(ids) ? [...new Set(ids.filter((x): x is string => typeof x === 'string' && REMOTE_INSTALLABLE.includes(x)))] : [];
			if (list.length) out[host] = list;
		}
		return out;
	} catch {
		return {};
	}
}

/** `never` with `agent` on `host` set (`on`) or cleared. */
export function setNever(never: Readonly<Record<string, readonly string[]>>, host: string, agent: string, on: boolean): Record<string, string[]> {
	const next: Record<string, string[]> = Object.fromEntries(Object.entries(never).map(([h, ids]) => [h, [...ids]]));
	const list = (next[host] ?? []).filter((a) => a !== agent);
	if (on) list.push(agent);
	if (list.length) next[host] = list;
	else delete next[host];
	return next;
}
