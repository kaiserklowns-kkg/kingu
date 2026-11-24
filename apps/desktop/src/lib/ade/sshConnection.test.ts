import { describe, expect, test } from 'bun:test';
import {
	canConnect,
	connectVerb,
	FLAP_DELAY_CAP_MS,
	HostConnection,
	INITIAL_RETRY_ATTEMPTS,
	INITIAL_RETRY_DELAY_MS,
	isAuthError,
	isConnecting,
	isHostKeyError,
	isPassphraseError,
	isTransientError,
	isTransientReconnectError,
	RECONNECT_BACKOFF_MS,
	ReconnectLadder,
	STABLE_CONNECTION_MS,
	STALE_BACKGROUND_ATTEMPT_MS,
	statusTone,
	type SshState,
	type SshStatus
} from './sshConnection';

const REFUSED = 'ssh: connect to host box port 22: Connection refused';
const DENIED = 'me@box: Permission denied (publickey,password).';

describe('what ssh said', () => {
	test('sign-in failures are final, in OpenSSH wording', () => {
		expect(isAuthError(DENIED)).toBe(true);
		expect(isAuthError('Permission denied, please try again.')).toBe(true);
		expect(isAuthError('Received disconnect from 10.0.0.5 port 22:2: Too many authentication failures')).toBe(true);
		// A file the account can't read is not a sign-in failure.
		expect(isAuthError('bash: /srv/app: Permission denied')).toBe(false);
		expect(isPassphraseError('Load key "/Users/me/.ssh/id_ed25519": incorrect passphrase supplied to decrypt private key')).toBe(true);
		expect(isHostKeyError('Host key verification failed.')).toBe(true);
		for (const m of [DENIED, 'Host key verification failed.', 'bad decrypt']) expect(isTransientReconnectError(m)).toBe(false);
	});

	test('network failures are retried by the ladder, but a first connect retries errno-shaped ones only', () => {
		for (const m of [
			REFUSED,
			'ssh: connect to host box port 22: Operation timed out',
			'ssh: Could not resolve hostname box: nodename nor servname provided, or not known',
			'kex_exchange_identification: Connection closed by remote host',
			'client_loop: send disconnect: Broken pipe',
			'ssh did not finish within 15 s',
			'connect ETIMEDOUT 10.0.0.5:22'
		])
			expect(isTransientReconnectError(m)).toBe(true);
		expect(isTransientError(REFUSED)).toBe(false);
		expect(isTransientError('connect ECONNREFUSED 10.0.0.5:22')).toBe(true);
		// Not about the network at all.
		expect(isTransientReconnectError('This account is currently not available.')).toBe(false);
		// A bare "Connection closed by" covers a permanent refusal (MaxStartups, DenyUsers).
		expect(isTransientReconnectError('Connection closed by 10.0.0.5 port 22')).toBe(false);
	});

	test('each status says whether Connect is offered and which word it uses', () => {
		const all: SshStatus[] = ['disconnected', 'connecting', 'auth-failed', 'connected', 'reconnecting', 'reconnection-failed', 'error'];
		expect(all.filter((s) => canConnect(s))).toEqual(['disconnected', 'auth-failed', 'reconnection-failed', 'error']);
		expect(all.filter((s) => isConnecting(s))).toEqual(['connecting', 'reconnecting']);
		expect(all.map((s) => connectVerb(s))).toEqual(['connect', 'connect', 'reconnect', 'connect', 'connect', 'retry', 'retry']);
		expect(all.map((s) => statusTone(s))).toEqual(['idle', 'busy', 'bad', 'ok', 'busy', 'bad', 'bad']);
		expect(canConnect(null)).toBe(false);
		expect(connectVerb(undefined)).toBe('connect');
	});
});

describe('the reconnect ladder', () => {
	test('failed dials walk the whole table, then give up', () => {
		const l = new ReconnectLadder();
		l.markConnected(0);
		const delays: number[] = [];
		for (;;) {
			const d = l.next(1000);
			if (d.kind === 'give-up') break;
			delays.push(d.delayMs);
			l.markAttemptFailed();
		}
		// The first redial follows a live connection, so it is capped; the rest are the table's.
		expect(delays).toEqual([1000, ...RECONNECT_BACKOFF_MS.slice(1)]);
		expect(l.failedAttemptStreak).toBe(RECONNECT_BACKOFF_MS.length);
	});

	test('a host that connects and drops again backs off up to the cap without ever giving up', () => {
		const l = new ReconnectLadder();
		const delays: number[] = [];
		let now = 0;
		for (let i = 0; i < 20; i++) {
			l.markConnected(now);
			now += 1000;
			const d = l.next(now);
			expect(d.kind).toBe('retry');
			if (d.kind === 'retry') delays.push(d.delayMs);
		}
		expect(delays.slice(0, 4)).toEqual([1000, 2000, 5000, 5000]);
		expect(Math.max(...delays)).toBe(FLAP_DELAY_CAP_MS);
	});

	test('a connection that held a minute starts the delays over, once', () => {
		const l = new ReconnectLadder();
		l.markConnected(0);
		l.next(10);
		l.next(20);
		l.markConnected(1000);
		const d = l.next(1000 + STABLE_CONNECTION_MS);
		expect(d).toEqual({ kind: 'retry', delayMs: 1000, attemptIndex: 0 });
		expect(l.next(1000 + STABLE_CONNECTION_MS + 1)).toEqual({ kind: 'retry', delayMs: 2000, attemptIndex: 1 });
	});
});

/** A HostConnection with a hand-driven clock: `answers` are the outcomes of successive dials. */
function harness(answers: (string | null)[]) {
	const states: SshState[] = [];
	const dials: boolean[] = [];
	const sleeps: number[] = [];
	let now = 0;
	let timer: { run: () => void; ms: number } | null = null;
	const gates: (() => void)[] = [];
	let held = false;
	const c = new HostConnection({
		probe: async (interactive) => {
			dials.push(interactive);
			if (held) await new Promise<void>((r) => gates.push(r));
			const a = answers.shift();
			if (a) throw new Error(a);
		},
		now: () => now,
		setTimer: (run, ms) => (timer = { run, ms }),
		clearTimer: () => (timer = null),
		sleep: async (ms) => void sleeps.push(ms),
		publish: (s) => states.push(s)
	});
	return {
		c,
		states,
		dials,
		sleeps,
		statuses: () => states.map((s) => s.status),
		advance: (ms: number) => (now += ms),
		pending: () => timer?.ms ?? null,
		/** Lets the pending wait run out and the dial after it settle. */
		fire: async () => {
			const t = timer;
			timer = null;
			t?.run();
			await new Promise((r) => setTimeout(r, 0));
		},
		hold: () => (held = true),
		release: async () => {
			held = false;
			gates.splice(0).forEach((g) => g());
			await new Promise((r) => setTimeout(r, 0));
		}
	};
}

describe('a host connection', () => {
	test('connects, and a second connect of a connected host dials nothing', async () => {
		const h = harness([null]);
		expect(await h.c.connect(true)).toBe(true);
		expect(h.statuses()).toEqual(['connecting', 'connected']);
		expect(await h.c.connect(true)).toBe(true);
		expect(h.dials).toEqual([true]);
	});

	test('a refused sign-in ends as auth-failed without a retry; other prose as error', async () => {
		const a = harness([DENIED]);
		expect(await a.c.connect(true)).toBe(false);
		expect(a.c.state).toEqual({ status: 'auth-failed', error: DENIED, reconnectAttempt: 0 });
		expect(a.dials.length).toBe(1);
		const b = harness([REFUSED]);
		expect(await b.c.connect(false)).toBe(false);
		expect(b.c.state.status).toBe('error');
		expect(b.dials).toEqual([false]);
	});

	test('a first connect retries errno-shaped failures five times, two seconds apart', async () => {
		const h = harness(Array(INITIAL_RETRY_ATTEMPTS).fill('connect ECONNRESET'));
		expect(await h.c.connect(true)).toBe(false);
		expect(h.dials.length).toBe(INITIAL_RETRY_ATTEMPTS);
		expect(h.sleeps).toEqual(Array(INITIAL_RETRY_ATTEMPTS - 1).fill(INITIAL_RETRY_DELAY_MS));
		expect(h.c.state.status).toBe('error');
		const ok = harness(['connect ECONNRESET', null]);
		expect(await ok.c.connect(true)).toBe(true);
	});

	test('a drop redials on the ladder, never prompting, and comes back connected', async () => {
		const h = harness([null, REFUSED, REFUSED, null]);
		await h.c.connect(true);
		h.c.dropped();
		expect(h.c.state).toEqual({ status: 'reconnecting', error: null, reconnectAttempt: 0 });
		expect(h.pending()).toBe(1000);
		await h.fire();
		expect(h.statuses().slice(2)).toEqual(['reconnecting', 'connecting', 'reconnecting']);
		expect(h.c.state.reconnectAttempt).toBe(1);
		expect(h.pending()).toBe(2000);
		await h.fire();
		expect(h.pending()).toBe(5000);
		await h.fire();
		expect(h.c.state).toEqual({ status: 'connected', error: null, reconnectAttempt: 0 });
		expect(h.pending()).toBe(null);
		expect(h.dials).toEqual([true, false, false, false]);
		// Only a connected host can drop.
		const idle = harness([]);
		idle.c.dropped();
		expect(idle.states).toEqual([]);
	});

	test('a sign-in failure while redialling stops the ladder', async () => {
		const h = harness([null, DENIED]);
		await h.c.connect(true);
		h.c.dropped();
		await h.fire();
		expect(h.c.state).toEqual({ status: 'auth-failed', error: DENIED, reconnectAttempt: 0 });
		expect(h.pending()).toBe(null);
	});

	test('nine failed redials end as reconnection-failed; the network returning starts over', async () => {
		const h = harness([null, ...Array(RECONNECT_BACKOFF_MS.length).fill(REFUSED), null]);
		await h.c.connect(true);
		h.c.dropped();
		const waits: number[] = [];
		while (h.pending() !== null) {
			waits.push(h.pending()!);
			await h.fire();
		}
		expect(waits).toEqual([1000, ...RECONNECT_BACKOFF_MS.slice(1)]);
		expect(h.c.state).toEqual({ status: 'reconnection-failed', error: 'Max reconnection attempts reached', reconnectAttempt: 0 });
		expect(h.c.networkReturned()).toBe(true);
		await new Promise((r) => setTimeout(r, 0));
		expect(h.c.state.status).toBe('connected');
	});

	test('the network returning cuts a pending wait short and replaces a stale dial, but leaves a fresh one', async () => {
		const h = harness([null, REFUSED, null]);
		await h.c.connect(true);
		expect(h.c.networkReturned()).toBe(false);
		h.c.dropped();
		await h.fire();
		expect(h.pending()).toBe(2000);
		expect(h.c.networkReturned()).toBe(true);
		await new Promise((r) => setTimeout(r, 0));
		expect(h.c.state.status).toBe('connected');
		expect(h.pending()).toBe(null);

		const s = harness([null, null, null]);
		await s.c.connect(true);
		s.c.dropped();
		s.hold();
		void s.fire();
		await new Promise((r) => setTimeout(r, 0));
		// A dial just started is left alone; one older than the stale limit is replaced.
		expect(s.c.state.status).toBe('connecting');
		expect(s.c.networkReturned()).toBe(false);
		s.advance(STALE_BACKGROUND_ATTEMPT_MS);
		expect(s.c.networkReturned()).toBe(true);
		expect(s.dials.length).toBe(3);
		await s.release();
		expect(s.c.state.status).toBe('connected');
		expect(s.statuses().filter((x) => x === 'connected').length).toBe(2);
	});

	test('Disconnect stops every redial until the user connects again', async () => {
		const h = harness([null, null]);
		await h.c.connect(true);
		h.c.dropped();
		h.c.disconnect();
		expect(h.c.state.status).toBe('disconnected');
		expect(h.pending()).toBe(null);
		expect(h.c.networkReturned()).toBe(false);
		expect(await h.c.connect(false)).toBe(false);
		expect(h.dials.length).toBe(1);
		expect(await h.c.connect(true)).toBe(true);
	});

	test('a dial superseded by Disconnect cannot publish over it', async () => {
		const h = harness([null]);
		h.hold();
		const p = h.c.connect(true);
		h.c.disconnect();
		await h.release();
		expect(await p).toBe(false);
		expect(h.c.state.status).toBe('disconnected');
	});
});

test('every status has a UI string', async () => {
	const { en } = await import('#lib/i18n/en.ts');
	const { statusKey } = await import('./sshConnection');
	const all: SshStatus[] = ['disconnected', 'connecting', 'auth-failed', 'connected', 'reconnecting', 'reconnection-failed', 'error'];
	for (const s of all) expect(typeof en[statusKey(s)]).toBe('string');
	for (const v of ['connect', 'reconnect', 'retry'] as const) expect(typeof en[`sshRemote.verb.${v}`]).toBe('string');
});
