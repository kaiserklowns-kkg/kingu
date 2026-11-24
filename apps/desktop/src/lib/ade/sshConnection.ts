// An SSH host's connection lifecycle (Orca's `SshConnectionStatus` and its reconnect ladder): the
// states a host goes through, which failures are final (sign-in) and which are retried, and the
// delays between retries after a drop. Pure (the clock, the timers and the probe are handed in),
// so `bun test` covers it; the store is sshConnections.svelte.ts.
//
// Orca source (3b2f28b30): src/main/ssh/connection/ssh-connection-timing.ts,
// src/main/ssh/connection/reconnect/{ssh-reconnect-ladder,ssh-connection-reconnect,ssh-reconnect-error-classification}.ts,
// src/main/ssh/connection/ssh-connection.ts `connect`, src/renderer/src/ssh/{ssh-connection-recoverability,ssh-connect-verb}.ts.
// Kingu has no host server, so Orca's `deploying-relay` state doesn't exist here, and "connected"
// means the shared system-ssh connection (ssh_hosts.rs `mux_args`) answered a probe.

/** Orca `SshConnectionStatus` without `deploying-relay`. */
export type SshStatus = 'disconnected' | 'connecting' | 'auth-failed' | 'connected' | 'reconnecting' | 'reconnection-failed' | 'error';

/** Orca `SshConnectionState`: `reconnectAttempt` is the delay step of the current outage. */
export type SshState = { status: SshStatus; error: string | null; reconnectAttempt: number };

export const DISCONNECTED: SshState = { status: 'disconnected', error: null, reconnectAttempt: 0 };

/** Orca `INITIAL_RETRY_ATTEMPTS` / `INITIAL_RETRY_DELAY_MS`: a first connect retries errno-shaped failures only. */
export const INITIAL_RETRY_ATTEMPTS = 5;
export const INITIAL_RETRY_DELAY_MS = 2000;
/** Orca `RECONNECT_BACKOFF_MS`: the wait before each redial after a drop. */
export const RECONNECT_BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 5000, 10000, 10000, 10000, 30000, 30000];
/** Orca `STABLE_CONNECTION_MS`: a connection that held this long restarts the delays at the next drop. */
export const STABLE_CONNECTION_MS = 60_000;
/**
 * Orca `FLAP_DELAY_CAP_MS`: the longest table delay below (60 s relay grace − 30 s connect − 20 s
 * reattach) = 10 s, so 5 s. Kingu has no relay whose grace could run out; the cap is kept so a
 * flapping host is redialled as often as Orca redials it.
 */
export const FLAP_DELAY_CAP_MS = 5000;
/** Orca `STALE_BACKGROUND_ATTEMPT_MS`: a dial older than this when the network returns is replaced. */
export const STALE_BACKGROUND_ATTEMPT_MS = 5000;
/** Orca's keepalive (`keepaliveInterval: 15_000`, `ServerAliveInterval=15`): how often a connected host is probed. */
export const KEEPALIVE_MS = 15_000;

const CONNECTING: Record<SshStatus, boolean> = { disconnected: false, connecting: true, 'auth-failed': false, connected: false, reconnecting: true, 'reconnection-failed': false, error: false };
const CAN_CONNECT: Record<SshStatus, boolean> = { disconnected: true, connecting: false, 'auth-failed': true, connected: false, reconnecting: false, 'reconnection-failed': true, error: true };

/** Orca `isConnectingSshStatus`: a transient the host drives; no user action helps yet. */
export const isConnecting = (s: SshStatus | null | undefined) => (s ? CONNECTING[s] : false);
/** Orca `canConnectSshStatus`. */
export const canConnect = (s: SshStatus | null | undefined) => (s ? CAN_CONNECT[s] : false);

/** Orca `sshConnectVerb`: Reconnect after a failed sign-in, Retry after an error, else Connect. */
export function connectVerb(s: SshStatus | null | undefined): 'connect' | 'reconnect' | 'retry' {
	return s === 'auth-failed' ? 'reconnect' : s === 'error' || s === 'reconnection-failed' ? 'retry' : 'connect';
}

/** The status's UI string (Orca `STATUS_LABELS`): the i18n key `sshRemote.conn.<this>`. */
export function statusKey(s: SshStatus): 'sshRemote.conn.disconnected' | 'sshRemote.conn.connecting' | 'sshRemote.conn.authFailed' | 'sshRemote.conn.connected' | 'sshRemote.conn.reconnecting' | 'sshRemote.conn.reconnectionFailed' | 'sshRemote.conn.error' {
	return s === 'auth-failed' ? 'sshRemote.conn.authFailed' : s === 'reconnection-failed' ? 'sshRemote.conn.reconnectionFailed' : `sshRemote.conn.${s}`;
}

/** Orca `statusColor`: connected, in progress, failed, idle. */
export function statusTone(s: SshStatus): 'ok' | 'busy' | 'bad' | 'idle' {
	if (s === 'connected') return 'ok';
	if (isConnecting(s)) return 'busy';
	return s === 'disconnected' ? 'idle' : 'bad';
}

// ---------------------------------------------------------------------------------------------
// Which failure is which (Orca ssh-reconnect-error-classification.ts, on ssh's own words: Kingu
// always runs the system ssh, whose failures are prose on stderr).

/** Orca `isPassphraseError`. */
export function isPassphraseError(message: string): boolean {
	const m = message.toLowerCase();
	return m.includes('passphrase') || m.includes('encrypted key') || m.includes('bad decrypt');
}

/** Orca `isAuthError` (its message tests; ssh2's error level has no system-ssh counterpart). */
export function isAuthError(message: string): boolean {
	const m = message.toLowerCase();
	return (
		m.includes('all configured authentication methods failed') ||
		m.includes('authentication failed') ||
		m.includes('too many authentication failures') ||
		/permission denied(?:, please try again\.?| \([^)]*(?:publickey|password|keyboard-interactive|gssapi|hostbased)[^)]*\))/.test(m)
	);
}

/** Orca types this failure (`isHostKeyVerificationError`); the system ssh says it in these words. */
export function isHostKeyError(message: string): boolean {
	const m = message.toLowerCase();
	return m.includes('host key verification failed') || m.includes('remote host identification has changed');
}

/** Orca `isTransientError`: the errno-shaped failures a first connect retries. */
export function isTransientError(message: string): boolean {
	return message === 'Timed out while waiting for SSH authentication' || ['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'].some((c) => message.includes(c));
}

/** Orca `NETWORK_LIKE_ERROR_FRAGMENTS`, plus ssh_hosts.rs's own timeout ("ssh did not finish within"). */
const NETWORK_LIKE = [
	'no route to host',
	'network is unreachable',
	'network is down',
	'host is down',
	'temporary failure in name resolution',
	'name or service not known',
	'nodename nor servname',
	'could not resolve hostname',
	'system ssh connection timed out',
	'ssh did not finish within',
	'timed out while waiting for handshake',
	'connection timed out',
	'operation timed out',
	'connection refused',
	'connection reset',
	'broken pipe',
	'kex_exchange_identification',
	'ssh_exchange_identification',
	'lost connection',
	'connection lost before handshake',
	'remote end closed',
	'connection closed by remote'
];

/** Orca `isTransientReconnectError`: what the ladder keeps retrying. Sign-in and host-key failures never are. */
export function isTransientReconnectError(message: string): boolean {
	if (isHostKeyError(message) || isAuthError(message) || isPassphraseError(message)) return false;
	if (isTransientError(message)) return true;
	const m = message.toLowerCase();
	return NETWORK_LIKE.some((f) => m.includes(f));
}

// ---------------------------------------------------------------------------------------------
// The ladder (Orca `SshReconnectLadder`, line for line)

export type ReconnectDecision = { kind: 'retry'; delayMs: number; attemptIndex: number } | { kind: 'give-up' };

/** Every retry moves one delay up; only failed dials count toward giving up, so a host that connects and drops again still backs off without running out. */
export class ReconnectLadder {
	#delayIndex = 0;
	#failed = 0;
	#connectedAt: number | null = null;

	next(now: number): ReconnectDecision {
		const connectedAt = this.#connectedAt;
		// The stable-connection reset is used once, never again inside the same outage.
		this.#connectedAt = null;
		if (connectedAt !== null && now - connectedAt >= STABLE_CONNECTION_MS) this.#delayIndex = 0;
		if (this.#failed >= RECONNECT_BACKOFF_MS.length) return { kind: 'give-up' };
		const attemptIndex = Math.min(this.#delayIndex, RECONNECT_BACKOFF_MS.length - 1);
		this.#delayIndex = attemptIndex + 1;
		const table = RECONNECT_BACKOFF_MS[attemptIndex]!;
		return { kind: 'retry', delayMs: this.#failed === 0 ? Math.min(table, FLAP_DELAY_CAP_MS) : table, attemptIndex };
	}

	get failedAttemptStreak() {
		return this.#failed;
	}

	markConnected(now: number) {
		this.#failed = 0;
		this.#connectedAt = now;
	}

	markAttemptFailed() {
		this.#failed += 1;
		this.#connectedAt = null;
	}

	reset() {
		this.#delayIndex = 0;
		this.#failed = 0;
		this.#connectedAt = null;
	}
}

// ---------------------------------------------------------------------------------------------
// One host's connection (Orca `SshConnection.connect` + `SshConnectionReconnector`)

export type ConnectionDeps = {
	/** One dial: resolves when the host answered, rejects with ssh's message. `interactive`: may ask for a passphrase. */
	probe: (interactive: boolean) => Promise<void>;
	now: () => number;
	setTimer: (run: () => void, ms: number) => unknown;
	clearTimer: (handle: unknown) => void;
	sleep: (ms: number) => Promise<void>;
	/** Every state change, in order. */
	publish: (state: SshState) => void;
};

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class HostConnection {
	state: SshState = DISCONNECTED;
	#deps: ConnectionDeps;
	#ladder = new ReconnectLadder();
	#timer: unknown = null;
	/** Orca's connect generation: a newer dial supersedes one still in flight. */
	#generation = 0;
	/** Orca `recordSshUserDisconnected`: after Disconnect nothing redials until the user connects. */
	#userDisconnected = false;
	#attemptStartedAt: number | null = null;

	constructor(deps: ConnectionDeps) {
		this.#deps = deps;
	}

	#set(status: SshStatus, error: string | null = null, reconnectAttempt = this.state.reconnectAttempt) {
		this.state = { status, error, reconnectAttempt };
		this.#deps.publish(this.state);
	}

	/** Read through a method: the state moves under an `await` (a newer dial, a Disconnect). */
	#connected(): boolean {
		return this.state.status === 'connected';
	}

	#cancelTimer() {
		if (this.#timer !== null) this.#deps.clearTimer(this.#timer);
		this.#timer = null;
	}

	/**
	 * Orca `SshConnection.connect`: up to `INITIAL_RETRY_ATTEMPTS` dials `INITIAL_RETRY_DELAY_MS`
	 * apart, retrying errno-shaped failures only; a sign-in failure ends as `auth-failed`, anything
	 * else as `error`. `user`: the user asked (lifts a Disconnect, may prompt for a passphrase).
	 * Resolves to whether the host is connected.
	 */
	async connect(user: boolean): Promise<boolean> {
		if (this.#userDisconnected && !user) return false;
		if (user) this.#userDisconnected = false;
		if (this.#connected()) return true;
		// A dial or the ladder is already at work (Orca offers no Connect then: `canConnectSshStatus`).
		if (isConnecting(this.state.status)) return false;
		this.#cancelTimer();
		let last = 'Connection failed';
		for (let attempt = 0; attempt < INITIAL_RETRY_ATTEMPTS; attempt++) {
			const generation = ++this.#generation;
			this.#set('connecting', null, 0);
			try {
				await this.#deps.probe(user);
				if (generation !== this.#generation) return this.#connected();
				this.#ladder.reset();
				this.#ladder.markConnected(this.#deps.now());
				this.#set('connected', null, 0);
				return true;
			} catch (e) {
				if (generation !== this.#generation) return this.#connected();
				last = text(e);
				if (isAuthError(last) || isPassphraseError(last)) return (this.#set('auth-failed', last), false);
				if (!isTransientError(last)) return (this.#set('error', last), false);
				if (attempt < INITIAL_RETRY_ATTEMPTS - 1) {
					await this.#deps.sleep(INITIAL_RETRY_DELAY_MS);
					if (generation !== this.#generation) return this.#connected();
				}
			}
		}
		this.#set('error', last);
		return false;
	}

	/** Orca's `end`/`close`/`error` of a live connection: a connected host stopped answering. */
	dropped() {
		if (this.state.status !== 'connected') return;
		this.#scheduleReconnect();
	}

	/** Orca `recordSshUserDisconnected` + `disconnect`: stops every redial until an explicit connect. */
	disconnect() {
		this.#userDisconnected = true;
		this.#generation++;
		this.#cancelTimer();
		this.#ladder.reset();
		this.#set('disconnected', null, 0);
	}

	/**
	 * Orca `retryAfterNetworkReturn`: the network came back (or the computer woke). A spent ladder,
	 * a pending wait, or a dial older than `STALE_BACKGROUND_ATTEMPT_MS` starts over with a fresh
	 * budget; failures while asleep don't prove the host is unreachable now.
	 */
	networkReturned(): boolean {
		if (this.#userDisconnected) return false;
		const s = this.state.status;
		const started = this.#attemptStartedAt;
		const stalled = s === 'reconnection-failed' || (s === 'reconnecting' && this.#timer !== null) || (s === 'connecting' && started !== null && this.#deps.now() - started >= STALE_BACKGROUND_ATTEMPT_MS);
		if (!stalled) return false;
		this.#cancelTimer();
		this.#ladder.reset();
		this.#set('reconnecting', null, 0);
		void this.#runReconnectAttempt();
		return true;
	}

	/** Orca `scheduleReconnect`. */
	#scheduleReconnect() {
		if (this.#userDisconnected || this.#timer !== null) return;
		const d = this.#ladder.next(this.#deps.now());
		if (d.kind === 'give-up') return this.#set('reconnection-failed', 'Max reconnection attempts reached');
		this.#set('reconnecting', null, d.attemptIndex);
		this.#timer = this.#deps.setTimer(() => {
			this.#timer = null;
			if (!this.#userDisconnected) void this.#runReconnectAttempt();
		}, d.delayMs);
	}

	/**
	 * Orca `runReconnectAttempt`: the dial itself shows as `connecting` (Orca `attemptConnect`),
	 * with the attempt count back at 0. It never asks for a passphrase: nobody is waiting for the prompt.
	 */
	async #runReconnectAttempt() {
		const generation = ++this.#generation;
		this.#attemptStartedAt = this.#deps.now();
		this.#set('connecting', null, 0);
		try {
			await this.#deps.probe(false);
			if (generation !== this.#generation) return;
			this.#ladder.markConnected(this.#deps.now());
			this.#set('connected', null, 0);
		} catch (e) {
			if (generation !== this.#generation) return;
			const message = text(e);
			if (isAuthError(message) || isPassphraseError(message)) return this.#set('auth-failed', message);
			if (!isTransientReconnectError(message)) return this.#set('error', message);
			this.#ladder.markAttemptFailed();
			this.#scheduleReconnect();
		} finally {
			if (generation === this.#generation) this.#attemptStartedAt = null;
		}
	}
}
