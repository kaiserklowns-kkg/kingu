// The terminal holder on an SSH host (Rust ssh_holder.rs): the states the window walks through to
// find or install it, and what a remote terminal does when its connection drops. Pure, so
// `bun test` covers it; the store is sshHolders.svelte.ts.
//
// Orca installs its host server while a host connects and shows that as `connecting` with a
// setup phase (`managedServer { kind: 'setting-up', phase: 'deploying' | … }`,
// src/shared/remote-runtime/ssh/ssh-types.ts); a host it cannot serve is marked unserved and gets
// a plain SSH terminal without persistence (src/main/ssh/host-server/ssh-host-unserved-status.ts).
// Kingu: `checking` → `installing` → `ready`, or one of the reasons there is no holder
// (`off`, `unsupported`, `no-artefact`, `failed`, `consent`, `declined`), in which case a terminal
// runs under plain `ssh -t` and an agent is started again with its resume command after a reconnect.
//
// Orca installs `orcad` on an empty host as part of connecting, without asking ("Orca installs
// itself on an empty SSH host and keeps itself up to date",
// src/renderer/src/components/settings/runtime-environments/managed-servers/runtime-install-server-dialog.tsx;
// `deps.deploy` in src/main/ssh/host-server/ssh-host-server-on-connect.ts). Kingu asks first, per
// host, the first time something would be installed there: Install / Not now / Never for this
// host. The answer is kept per host (Not now only until Kingu restarts) and can be changed in SSH:
// Hosts…; a host already holding this build's holder is used without asking (nothing is installed),
// except one set to Never, where no holder is used at all.

import type { SshStatus } from './sshConnection';

/** What Rust's `ssh_holder_probe` / `ssh_holder_install` answer. */
export type Holder =
	| { status: 'ready'; id: string; platform: string; installed: boolean }
	| { status: 'needs-install'; id: string; platform: string; size: number }
	| { status: 'unsupported'; platform: string }
	| { status: 'no-artefact'; platform: string; triple: string };

export type HolderPhase = 'unknown' | 'checking' | 'installing' | 'ready' | 'off' | 'unsupported' | 'no-artefact' | 'failed' | 'consent' | 'declined';

/** The user's answer for a host, kept across restarts. */
export type Consent = 'allow' | 'never';
/** What the install question offers. */
export type ConsentAnswer = 'install' | 'later' | 'never';

export type HolderState = {
	phase: HolderPhase;
	/** The holder's folder on the host (`ready`). */
	id?: string;
	/** `uname -sm` of the host. */
	platform?: string;
	/** The binary this build lacks (`no-artefact`). */
	triple?: string;
	error?: string;
	/** This check installed it (said once to the user). */
	installedNow?: boolean;
	/** The upload's size (`consent`: asked before installing). */
	size?: number;
	/** `declined`: Not now (until Kingu restarts) or Never for this host. */
	declined?: 'later' | 'never';
};

export const HOLDER_UNKNOWN: HolderState = { phase: 'unknown' };

export type HolderDeps = {
	/** `kingu.ssh.terminalHost`: off never probes and never installs. */
	enabled: () => boolean;
	probe: () => Promise<Holder>;
	install: () => Promise<Holder>;
	publish: (state: HolderState) => void;
	/** The user's answer for this host so far: kept (`allow`, `never`), Not now this run (`later`), or none. */
	consent: () => Consent | 'later' | null;
	/** Asks now (the user is starting something on the host); absent: the host waits in `consent`. Null: dismissed. */
	ask?: (q: { platform: string; size: number }) => Promise<ConsentAnswer | null>;
	/** Keeps the answer (Not now only in memory). */
	remember?: (a: ConsentAnswer) => void;
};

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

function settled(h: Holder): HolderState | null {
	if (h.status === 'ready') return { phase: 'ready', id: h.id, platform: h.platform, ...(h.installed ? { installedNow: true } : {}) };
	if (h.status === 'unsupported') return { phase: 'unsupported', platform: h.platform };
	if (h.status === 'no-artefact') return { phase: 'no-artefact', platform: h.platform, triple: h.triple };
	return null;
}

/**
 * Finds the holder on a connected host, installing it when this build has the host's binary.
 * Every outcome is a state (never a throw): a host whose holder can't be had still works, without
 * one. An install that answers "still to install" is a failure, not a loop.
 */
export async function ensureHolder(deps: HolderDeps): Promise<HolderState> {
	const done = (s: HolderState) => {
		deps.publish(s);
		return s;
	};
	if (!deps.enabled()) return done({ phase: 'off' });
	// Never for this host: no holder there is used, not even one already installed.
	if (deps.consent() === 'never') return done({ phase: 'declined', declined: 'never' });
	deps.publish({ phase: 'checking' });
	let found: Holder;
	try {
		found = await deps.probe();
	} catch (e) {
		return done({ phase: 'failed', error: text(e) });
	}
	const now = settled(found);
	if (now || found.status !== 'needs-install') return done(now ?? { phase: 'failed', error: 'unexpected answer' });
	const asked = { platform: found.platform, size: found.size };
	let consent = deps.consent();
	if (consent === null && deps.ask) {
		const answer = (await deps.ask(asked).catch(() => null)) ?? 'later';
		deps.remember?.(answer);
		consent = answer === 'install' ? 'allow' : answer;
	}
	if (consent === null) return done({ phase: 'consent', ...asked });
	if (consent !== 'allow') return done({ phase: 'declined', declined: consent, ...asked });
	deps.publish({ phase: 'installing', platform: found.platform });
	try {
		const installed = settled(await deps.install());
		return done(installed ?? { phase: 'failed', platform: found.platform, error: 'the terminal host did not install' });
	} catch (e) {
		return done({ phase: 'failed', platform: found.platform, error: text(e) });
	}
}

/** The holder's id when terminals can be held on the host, else null. */
export const holderId = (s: HolderState | undefined): string | null => (s?.phase === 'ready' && s.id ? s.id : null);

/** A check is running (the side bar shows it next to the host). */
export const holderBusy = (s: HolderState | undefined) => s?.phase === 'checking' || s?.phase === 'installing';

/** Installing waits for the user: asked when they start something on the host, or not wanted. */
export const holderWaits = (s: HolderState | undefined) => s?.phase === 'consent' || s?.phase === 'declined';

/** The kept answers (`kingu.ssh.holderConsent`), read defensively. */
export function parseConsents(raw: string | null): Record<string, Consent> {
	try {
		const v: unknown = raw ? JSON.parse(raw) : null;
		if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
		return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, Consent] => e[1] === 'allow' || e[1] === 'never'));
	} catch {
		return {};
	}
}

/** What a remote terminal does when its connection drops (Rust `TerminalRun.mode`). */
export type TerminalMode = 'held' | 'restart' | 'plain';

/**
 * Where a remote agent stands, by its host's connection: `live` while the host is connected;
 * else `held` (it keeps running on the host and is reattached), `restarting` (it ended with the
 * connection and is started again with its resume command) or `lost` (it ended, nothing brings it
 * back). A restart is never called a reattach.
 */
export type AgentLink = 'live' | 'held' | 'restarting' | 'lost';

export function agentLink(mode: TerminalMode, host: SshStatus): AgentLink {
	if (host === 'connected') return 'live';
	return mode === 'held' ? 'held' : mode === 'restart' ? 'restarting' : 'lost';
}

/** `1048576` → `1.0 MB` (the install notice). */
export const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** A held session Kingu started, remembered so its tab can be opened again after a restart. */
export type HeldRecord = { host: string; root: string; path: string; name: string; holder: string; token?: string; agent?: boolean };

/** Records of sessions the host still holds; the rest ended and are dropped. */
export function liveRecords(records: Record<string, HeldRecord>, host: string, liveKeys: readonly string[]): Record<string, HeldRecord> {
	const live = new Set(liveKeys);
	return Object.fromEntries(Object.entries(records).filter(([key, r]) => r.host !== host || live.has(key)));
}

/** What the store keeps in localStorage, read defensively (a hand-edited or older value is dropped). */
export function parseRecords(raw: string | null): Record<string, HeldRecord> {
	if (!raw) return {};
	try {
		const v: unknown = JSON.parse(raw);
		if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
		const out: Record<string, HeldRecord> = {};
		for (const [key, r] of Object.entries(v as Record<string, Partial<HeldRecord> | null>)) {
			if (!/^ssh:[A-Za-z0-9]{8,64}$/.test(key) || !r) continue;
			if (typeof r.host !== 'string' || typeof r.root !== 'string' || typeof r.path !== 'string' || typeof r.name !== 'string' || typeof r.holder !== 'string') continue;
			out[key] = { host: r.host, root: r.root, path: r.path, name: r.name, holder: r.holder, ...(typeof r.token === 'string' ? { token: r.token } : {}), ...(r.agent ? { agent: true } : {}) };
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * After Kingu restarted: the live sessions this computer started on `host` whose tabs aren't open,
 * to be opened again in tabs by themselves (Orca restores a remote pane into its saved tab and
 * reattaches it: src/renderer/src/store/terminals/hydration/terminal-session-row-hydration.ts
 * `reconnectPtyIdByRetainedTabId`). A session started elsewhere (no record) is left to SSH:
 * Reattach Terminal on Host….
 */
export function restorable(records: Record<string, HeldRecord>, host: string, liveKeys: readonly string[], openKeys: ReadonlySet<string>): [string, HeldRecord][] {
	const live = new Set(liveKeys);
	return Object.entries(records).filter(([key, r]) => r.host === host && live.has(key) && !openKeys.has(key));
}
