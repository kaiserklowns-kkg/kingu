// The terminal daemon's generations from the page's side (kingu-ptyd protocol docs, pty.rs): every
// daemon has an `epoch`; a terminal remembers the one it showed its session in. When the app's
// connection to the daemon comes back (`pty-daemon`), a terminal either re-attaches (the same daemon:
// only the output stopped) or starts over (a different daemon: its session is gone). Pure, so the
// decision is tested without a window.

/** Rust `pty::DaemonEvent`. */
export type DaemonEvent = { epoch: number; previous: number | null; restarted: boolean };

/** Rust `kingu_ptyd::protocol::DaemonStatus` (`startedAt`: Unix seconds). */
export type DaemonInfo = { pid: number; epoch: number; protocol: number; appVersion: string; startedAt: number; sessions: number; alive: number; clients: number };

/** Rust `pty::DaemonStatusReport`. */
export type DaemonStatusReport = { backend: 'daemon' | 'local'; connected: boolean; daemon: DaemonInfo | null; agents: number; terminals: number };

/** Rust `pty::RestartReport`. */
export type RestartReport = { ended: number; epoch: number; pid: number };

export type TerminalReaction = 'ignore' | 'reattach' | 'start-over';

/** The error a re-attach gets when the session it asked for ended with another daemon generation. */
export const isStaleAttach = (error: unknown): boolean => String(error).startsWith('stale-attach:');

/**
 * What a terminal does when the daemon connection came back. `seen`: the epoch it last showed its
 * session in (0: unknown: in-process, an older daemon, or not attached yet); `live`: it has a session.
 * A terminal without a session has nothing to lose or resume, so it ignores the event.
 */
export function reactToDaemonEvent(event: DaemonEvent, seen: number, live: boolean): TerminalReaction {
	if (!live) return 'ignore';
	if (!event.restarted) return 'reattach';
	// A restarted daemon holds only sessions started in it: one that was started there has its epoch.
	return seen !== 0 && seen === event.epoch ? 'reattach' : 'start-over';
}

/** `3 min`, `2 h 5 min`, `4 d 1 h`: how long a daemon has run, from its start (Unix seconds). */
export function uptime(startedAt: number, nowMs: number): string {
	const s = Math.max(0, Math.floor(nowMs / 1000 - startedAt));
	const [d, h, m] = [Math.floor(s / 86400), Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60)];
	if (d) return `${d} d ${h} h`;
	if (h) return `${h} h ${m} min`;
	return `${m} min`;
}
