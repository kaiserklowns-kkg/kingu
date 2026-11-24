import { describe, expect, test } from 'bun:test';
import { setLocale } from '#lib/i18n/index.ts';
import type { ManagedOperation } from '#lib/agent/managedCli.ts';
import { REMOTE_INSTALLABLE, askText, hostAgentView, isBusy, mayOffer, parseHostAgents, parseHostStatus, parseNever, setNever, withStatus, type HostAgentStatus } from './sshAgentInstall';
import { INSTALL_PAGES } from './sshAgents';

setLocale('en');

const base: HostAgentStatus = {
	host: 'box',
	agent: 'codex',
	label: 'Codex',
	command: 'codex',
	available: true,
	unavailable: null,
	version: null,
	downloadBytes: null,
	downloadHost: null,
	installedVersion: null,
	installedCurrent: false,
	damaged: false,
	canRemove: false,
	source: null,
	externalPath: null,
	operation: null
};
const op = (o: Partial<ManagedOperation>): ManagedOperation => ({ id: 4, kind: 'install', phase: 'downloading', downloadedBytes: 0, totalBytes: null, ...o });

describe('sshAgentInstall', () => {
	test("Rust's host listing is read loosely", () => {
		const raw = { host: 'box', platform: 'Linux x86_64', build: 'linux-x64', problem: null, agents: [{ ...base, version: '0.50.0', downloadBytes: 5_000_000, downloadHost: 'github.com', unavailable: undefined }, { agent: 'x' }, 7] };
		const h = parseHostAgents(raw);
		expect(h).toEqual({ host: 'box', platform: 'Linux x86_64', build: 'linux-x64', problem: null, agents: [{ ...base, version: '0.50.0', downloadBytes: 5_000_000, downloadHost: 'github.com' }] });
		expect(parseHostStatus({ ...base, host: 3 })).toBeNull();
		expect(parseHostStatus({ ...base, command: null })?.command).toBe('codex');
		expect([parseHostAgents(null), parseHostAgents({ agents: [] })]).toEqual([null, null]);
		expect(parseHostAgents({ host: 'h', agents: 'no' })).toEqual({ host: 'h', platform: '', build: null, problem: null, agents: [] });
	});

	test('an event replaces its own row only', () => {
		const h = { host: 'box', platform: 'Linux x86_64', build: 'linux-x64', problem: null, agents: [base, { ...base, agent: 'claude', label: 'Claude Code' }] };
		const next = withStatus(h, { ...base, installedVersion: '0.50.0' });
		expect(next.agents.map((a) => [a.agent, a.installedVersion])).toEqual([
			['codex', '0.50.0'],
			['claude', null]
		]);
		expect(withStatus(h, { ...base, agent: 'omp', label: 'OMP' }).agents.length).toBe(3);
	});

	test('a row says what runs on the host and what an install downloads, before anything is', () => {
		expect(hostAgentView({ ...base, version: '0.50.0', downloadBytes: 5_400_000, downloadHost: 'github.com' })).toEqual({ status: 'Not installed. 6 MB download from github.com.', error: null, progress: null, action: { kind: 'install', label: 'Install' }, removable: false });
		expect(hostAgentView(base).status).toBe('Not installed.');
		expect(hostAgentView({ ...base, source: 'external', externalPath: '/usr/local/bin/codex' })).toMatchObject({ status: 'Uses the copy found on this host.', action: null });
		expect(hostAgentView({ ...base, source: 'managed', installedVersion: '0.49.0', canRemove: true, version: '0.50.0' })).toMatchObject({ status: 'Installed by Kingu · 0.49.0', action: { kind: 'install', label: 'Update' }, removable: true });
		expect(hostAgentView({ ...base, source: 'managed', installedVersion: '0.50.0', installedCurrent: true, canRemove: true, version: '0.50.0' })).toMatchObject({ action: null, removable: true });
		// Why it can't be installed is said instead of an Install button.
		expect(hostAgentView({ ...base, available: false, unavailable: 'The host has neither curl nor wget to download with.' })).toMatchObject({ status: 'The host has neither curl nor wget to download with.', action: null });
	});

	test("progress follows the host's download, then unpacking and the start check; Cancel is offered", () => {
		const half = hostAgentView({ ...base, operation: op({ downloadedBytes: 27_000_000, totalBytes: 54_000_000 }) });
		expect(half).toMatchObject({ status: 'Downloading on the host: 27.0 MB of 54.0 MB.', progress: 50, action: { kind: 'cancel', label: 'Cancel', operation: 4 }, removable: false });
		expect(hostAgentView({ ...base, operation: op({ downloadedBytes: 1_000_000 }) }).status).toBe('Downloading on the host: 1.0 MB.');
		expect(hostAgentView({ ...base, operation: op({ phase: 'extracting' }) })).toMatchObject({ status: 'Unpacking Codex on the host.', progress: null });
		expect(hostAgentView({ ...base, operation: op({ phase: 'verifying' }) }).status).toBe('Checking that Codex starts.');
		expect(hostAgentView({ ...base, operation: op({}) }, true).status).toBe('Cancelling…');
		expect(hostAgentView({ ...base, canRemove: true, operation: op({ kind: 'remove', phase: 'removing' }) })).toMatchObject({ status: 'Removing…', action: null, removable: false });
		expect([isBusy(base), isBusy({ ...base, operation: op({}) }), isBusy({ ...base, operation: op({ phase: 'succeeded' }) }), isBusy(undefined)]).toEqual([false, true, false, false]);
	});

	test('a failure says why and offers a retry; a cancel says nothing was installed', () => {
		expect(hostAgentView({ ...base, operation: op({ phase: 'failed', error: "the download doesn't match the publisher's checksum" }) })).toMatchObject({ error: "Couldn’t install Codex: the download doesn't match the publisher's checksum", action: { kind: 'install', label: 'Try again' } });
		expect(hostAgentView({ ...base, operation: op({ phase: 'cancelled' }) })).toMatchObject({ status: 'Installation cancelled. Nothing was installed.', action: { kind: 'install', label: 'Try again' } });
		expect(hostAgentView({ ...base, source: 'managed', installedVersion: '0.50.0', canRemove: true, operation: op({ kind: 'remove', phase: 'failed', error: 'Codex is running on this host; quit it there first' }) })).toMatchObject({ error: 'Couldn’t remove Codex: Codex is running on this host; quit it there first', removable: true });
	});

	test('the question names the size, the source and the folder', () => {
		expect(askText({ ...base, downloadBytes: 54_000_000, downloadHost: 'github.com' }, 'box')).toBe('Install Codex on box? 54 MB download from github.com, checked against the publisher’s checksum. It goes into ~/.kingu/agent-runtimes, no sudo.');
		expect(askText(base, 'box')).toBe('Install Codex on box? It goes into ~/.kingu/agent-runtimes, no sudo.');
	});

	test('the missing-agent prompt offers only what Kingu can install there, unless Never was said', () => {
		expect(mayOffer('codex', 'box', {})).toBe(true);
		expect(mayOffer('aider', 'box', {})).toBe(false);
		expect(mayOffer('grok', 'box', {}), 'Grok needs brotli on the host').toBe(false);
		expect(mayOffer('codex', 'box', { box: ['codex'] })).toBe(false);
		expect(mayOffer('codex', 'other', { box: ['codex'] })).toBe(true);
		// Every installable agent is a catalog agent with an install page.
		for (const id of REMOTE_INSTALLABLE) expect(INSTALL_PAGES[id]).toBeDefined();
	});

	test('Never answers are kept per host and read defensively', () => {
		expect(parseNever('{"box":["codex","codex","nope",3],"a":"x","b":[]}')).toEqual({ box: ['codex'] });
		expect([parseNever(null), parseNever('[]'), parseNever('{')]).toEqual([{}, {}, {}]);
		const once = setNever({}, 'box', 'codex', true);
		expect(once).toEqual({ box: ['codex'] });
		expect(setNever(once, 'box', 'claude', true)).toEqual({ box: ['codex', 'claude'] });
		expect(setNever(once, 'box', 'codex', false)).toEqual({});
		expect(once).toEqual({ box: ['codex'] });
	});
});
