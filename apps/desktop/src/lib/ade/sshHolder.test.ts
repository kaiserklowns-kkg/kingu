import { describe, expect, test } from 'bun:test';
import { agentLink, ensureHolder, holderBusy, holderId, holderWaits, liveRecords, megabytes, parseConsents, parseRecords, restorable, type Consent, type ConsentAnswer, type Holder, type HolderState } from './sshHolder';

function deps(over: { enabled?: boolean; probe?: () => Promise<Holder>; install?: () => Promise<Holder>; consent?: Consent | 'later' | null; ask?: (q: { platform: string; size: number }) => Promise<ConsentAnswer | null> }) {
	const seen: HolderState[] = [];
	const calls: string[] = [];
	return {
		seen,
		calls,
		deps: {
			enabled: () => over.enabled ?? true,
			probe: () => {
				calls.push('probe');
				return over.probe ? over.probe() : Promise.reject(new Error('no probe'));
			},
			install: () => {
				calls.push('install');
				return over.install ? over.install() : Promise.reject(new Error('no install'));
			},
			publish: (s: HolderState) => void seen.push(s),
			consent: () => (over.consent === undefined ? 'allow' : over.consent),
			...(over.ask ? { ask: over.ask } : {}),
			remember: (a: ConsentAnswer) => void calls.push(`remember:${a}`)
		}
	};
}

const ID = 'kingu-ptyd-0.1.0-0123456789abcdef';

describe('ensureHolder', () => {
	test('a host that has the holder is ready without an install', async () => {
		const d = deps({ probe: async () => ({ status: 'ready', id: ID, platform: 'Linux x86_64', installed: false }) });
		const s = await ensureHolder(d.deps);
		expect(s).toEqual({ phase: 'ready', id: ID, platform: 'Linux x86_64' });
		expect(d.calls).toEqual(['probe']);
		expect(d.seen.map((x) => x.phase)).toEqual(['checking', 'ready']);
		expect(holderId(s)).toBe(ID);
	});

	test('a host without it gets it installed, and that is said once', async () => {
		const d = deps({
			probe: async () => ({ status: 'needs-install', id: ID, platform: 'Linux x86_64', size: 1_100_000 }),
			install: async () => ({ status: 'ready', id: ID, platform: 'Linux x86_64', installed: true })
		});
		const s = await ensureHolder(d.deps);
		expect(s).toEqual({ phase: 'ready', id: ID, platform: 'Linux x86_64', installedNow: true });
		expect(d.calls).toEqual(['probe', 'install']);
		expect(d.seen.map((x) => x.phase)).toEqual(['checking', 'installing', 'ready']);
	});

	test('the setting off never touches the host', async () => {
		const d = deps({ enabled: false });
		expect(await ensureHolder(d.deps)).toEqual({ phase: 'off' });
		expect(d.calls).toEqual([]);
	});

	test('a platform without a holder, or a binary missing from this build, is a state with its reason', async () => {
		const a = deps({ probe: async () => ({ status: 'unsupported', platform: 'FreeBSD amd64' }) });
		expect(await ensureHolder(a.deps)).toEqual({ phase: 'unsupported', platform: 'FreeBSD amd64' });
		const b = deps({ probe: async () => ({ status: 'no-artefact', platform: 'Linux aarch64', triple: 'aarch64-unknown-linux-musl' }) });
		const s = await ensureHolder(b.deps);
		expect(s).toEqual({ phase: 'no-artefact', platform: 'Linux aarch64', triple: 'aarch64-unknown-linux-musl' });
		expect(b.calls).toEqual(['probe']);
		expect(holderId(s)).toBeNull();
	});

	test('a failed probe or install is a state, never a throw, and never loops', async () => {
		const a = deps({ probe: async () => Promise.reject(new Error('ssh did not finish within 15 s')) });
		expect(await ensureHolder(a.deps)).toEqual({ phase: 'failed', error: 'ssh did not finish within 15 s' });
		const need: Holder = { status: 'needs-install', id: ID, platform: 'Linux x86_64', size: 1 };
		const b = deps({ probe: async () => need, install: async () => Promise.reject('kingu-install: the terminal host cannot run on this host ()') });
		expect(await ensureHolder(b.deps)).toEqual({ phase: 'failed', platform: 'Linux x86_64', error: 'kingu-install: the terminal host cannot run on this host ()' });
		const c = deps({ probe: async () => need, install: async () => need });
		const s = await ensureHolder(c.deps);
		expect(s.phase).toBe('failed');
		expect(c.calls).toEqual(['probe', 'install']);
	});

	test('busy only while it checks or installs', () => {
		expect(holderBusy({ phase: 'checking' })).toBe(true);
		expect(holderBusy({ phase: 'installing' })).toBe(true);
		expect(holderBusy({ phase: 'ready', id: ID })).toBe(false);
		expect(holderBusy(undefined)).toBe(false);
	});
});

describe('agentLink', () => {
	test('a connected host is live whatever the mode', () => {
		for (const m of ['held', 'restart', 'plain'] as const) expect(agentLink(m, 'connected')).toBe('live');
	});

	test('away, a held terminal is held, a resumable agent restarts, anything else is lost', () => {
		for (const st of ['reconnecting', 'reconnection-failed', 'disconnected', 'auth-failed', 'error', 'connecting'] as const) {
			expect(agentLink('held', st)).toBe('held');
			expect(agentLink('restart', st)).toBe('restarting');
			expect(agentLink('plain', st)).toBe('lost');
		}
	});
});

describe('held session records', () => {
	const rec = (host: string) => ({ host, root: '/srv/app', path: '/srv/app', name: 'app · box', holder: ID });

	test('sessions the host no longer holds are dropped, other hosts are left alone', () => {
		const all = { 'ssh:aaaaaaaaaaaa': rec('h1'), 'ssh:bbbbbbbbbbbb': rec('h1'), 'ssh:cccccccccccc': rec('h2') };
		expect(Object.keys(liveRecords(all, 'h1', ['ssh:bbbbbbbbbbbb', 'ssh:zzzzzzzzzzzz']))).toEqual(['ssh:bbbbbbbbbbbb', 'ssh:cccccccccccc']);
	});

	test('stored records are read defensively', () => {
		expect(parseRecords(null)).toEqual({});
		expect(parseRecords('not json')).toEqual({});
		expect(parseRecords('[1]')).toEqual({});
		const raw = JSON.stringify({ 'ssh:aaaaaaaaaaaa': { ...rec('h1'), token: 'abcdef123456', agent: true, extra: 1 }, 'ssh:bad key': rec('h1'), 'ssh:bbbbbbbbbbbb': { host: 'h1' }, 'ssh:cccccccccccc': null });
		expect(parseRecords(raw)).toEqual({ 'ssh:aaaaaaaaaaaa': { ...rec('h1'), token: 'abcdef123456', agent: true } });
	});

	test('megabytes', () => {
		expect(megabytes(1_153_434)).toBe('1.1 MB');
	});
});

describe('asking before installing', () => {
	const needs = async (): Promise<Holder> => ({ status: 'needs-install', id: ID, platform: 'Linux x86_64', size: 1_500_000 });
	const ready = async (): Promise<Holder> => ({ status: 'ready', id: ID, platform: 'Linux x86_64', installed: true });

	test('no answer yet and nobody to ask: the host waits, nothing is uploaded', async () => {
		const d = deps({ probe: needs, install: ready, consent: null });
		const s = await ensureHolder(d.deps);
		expect(s).toEqual({ phase: 'consent', platform: 'Linux x86_64', size: 1_500_000 });
		expect(d.calls).toEqual(['probe']);
		expect(holderWaits(s)).toBe(true);
		expect(holderId(s)).toBeNull();
	});

	test('asked: Install installs and is kept; Not now and Never install nothing', async () => {
		const yes = deps({ probe: needs, install: ready, consent: null, ask: async () => 'install' });
		expect((await ensureHolder(yes.deps)).phase).toBe('ready');
		expect(yes.calls).toEqual(['probe', 'remember:install', 'install']);
		for (const answer of ['later', 'never'] as const) {
			const no = deps({ probe: needs, install: ready, consent: null, ask: async () => answer });
			expect(await ensureHolder(no.deps)).toEqual({ phase: 'declined', declined: answer, platform: 'Linux x86_64', size: 1_500_000 });
			expect(no.calls).toEqual(['probe', `remember:${answer}`]);
		}
		// A dismissed question is Not now.
		const gone = deps({ probe: needs, install: ready, consent: null, ask: async () => null });
		expect((await ensureHolder(gone.deps)).declined).toBe('later');
	});

	test('a kept answer is never asked again: allow installs (an upgrade too), never and not-now do not', async () => {
		let asked = 0;
		const ask = async () => (asked++, 'install' as const);
		expect((await ensureHolder(deps({ probe: needs, install: ready, consent: 'allow', ask }).deps)).phase).toBe('ready');
		const never = deps({ probe: needs, install: ready, consent: 'never', ask });
		expect(await ensureHolder(never.deps)).toEqual({ phase: 'declined', declined: 'never' });
		// Never: the host is not even probed, so an installed holder is not used either.
		expect(never.calls).toEqual([]);
		expect((await ensureHolder(deps({ probe: needs, install: ready, consent: 'later', ask }).deps)).declined).toBe('later');
		expect(asked).toBe(0);
	});

	test('a holder already on the host is used without asking (nothing to install)', async () => {
		const d = deps({ probe: async () => ({ status: 'ready', id: ID, platform: 'Linux x86_64', installed: false }), consent: null, ask: async () => 'never' });
		expect((await ensureHolder(d.deps)).phase).toBe('ready');
		expect(d.calls).toEqual(['probe']);
	});

	test('kept answers are read defensively', () => {
		expect(parseConsents(null)).toEqual({});
		expect(parseConsents('[]')).toEqual({});
		expect(parseConsents('{"a":"allow","b":"never","c":"later","d":1}')).toEqual({ a: 'allow', b: 'never' });
	});
});

describe('restoring held tabs after a restart', () => {
	const rec = (host: string) => ({ host, root: '/srv/app', path: '/srv/app', name: 'app · box', holder: ID });
	test('the live sessions of that host started here, not already open', () => {
		const all = { 'ssh:aaaaaaaaaaaa': rec('h1'), 'ssh:bbbbbbbbbbbb': rec('h1'), 'ssh:cccccccccccc': rec('h1'), 'ssh:dddddddddddd': rec('h2') };
		const out = restorable(all, 'h1', ['ssh:aaaaaaaaaaaa', 'ssh:bbbbbbbbbbbb', 'ssh:dddddddddddd', 'ssh:eeeeeeeeeeee'], new Set(['ssh:bbbbbbbbbbbb']));
		expect(out.map(([k]) => k)).toEqual(['ssh:aaaaaaaaaaaa']);
	});
});
