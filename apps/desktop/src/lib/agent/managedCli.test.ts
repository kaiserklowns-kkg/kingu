import { describe, expect, test } from 'bun:test';
import { setLocale } from '#lib/i18n/index.ts';
import { installable, installCard, isRunning, needsInstall, parseStatus, parseStatuses, settingsView, type ManagedOperation, type ManagedStatus } from './managedCli.ts';

setLocale('en');

const base: ManagedStatus = { agent: 'copilot', label: 'GitHub Copilot', available: true, version: null, downloadBytes: null, downloadHost: null, installedVersion: null, installedCurrent: false, damaged: false, canRemove: false, source: null, operation: null };
const op = (o: Partial<ManagedOperation>): ManagedOperation => ({ id: 7, kind: 'install', phase: 'downloading', downloadedBytes: 0, totalBytes: null, ...o });

describe('managedCli', () => {
	test('the Rust status is read loosely', () => {
		const raw = { agent: 'copilot', label: 'GitHub Copilot', available: true, version: '1.0.114', downloadBytes: 139620898, downloadHost: 'github.com', installedVersion: null, installedCurrent: false, damaged: false, canRemove: false, source: null, operation: { id: 3, kind: 'install', phase: 'downloading', downloadedBytes: 10, totalBytes: 139620898 } };
		expect(parseStatus(raw)).toEqual({ ...base, version: '1.0.114', downloadBytes: 139620898, downloadHost: 'github.com', operation: { id: 3, kind: 'install', phase: 'downloading', downloadedBytes: 10, totalBytes: 139620898 } });
		expect(parseStatus({ ...raw, source: 'elsewhere', operation: { id: 1, kind: 'install', phase: 'exploding' } })).toMatchObject({ source: null, operation: null });
		expect(parseStatus({ ...raw, operation: { id: 1, kind: 'install', phase: 'failed', error: 'no' } })?.operation).toEqual({ id: 1, kind: 'install', phase: 'failed', downloadedBytes: 0, totalBytes: null, error: 'no' });
		expect([parseStatus(null), parseStatus({ agent: 1 }), parseStatus('x')]).toEqual([null, null, null]);
		expect(parseStatuses([raw, 4, {}]).length).toBe(1);
		expect(parseStatuses('nope')).toEqual([]);
	});

	test('only an agent nothing here runs is offered, and only where a build exists', () => {
		const list = [base, { ...base, agent: 'grok', label: 'Grok', source: 'managed' as const }, { ...base, agent: 'cursor', label: 'Cursor', source: 'external' as const }, { ...base, agent: 'kimi', label: 'Kimi Code', available: false }, { ...base, agent: 'omp', label: 'OMP' }];
		expect(installable(list, ['claude', 'omp']).map((s) => s.agent)).toEqual(['copilot']);
		expect([needsInstall(base), needsInstall({ ...base, source: 'managed' }), needsInstall({ ...base, source: 'external' }), needsInstall(undefined)]).toEqual([true, false, false, false]);
		expect([isRunning(base), isRunning({ ...base, operation: op({}) }), isRunning({ ...base, operation: op({ phase: 'failed' }) }), isRunning({ ...base, operation: op({ kind: 'remove', phase: 'removing' }) })]).toEqual([false, true, false, true]);
	});

	test('the card says what is downloaded and from where before anything is', () => {
		const offer = installCard({ ...base, version: '1.0.114', downloadBytes: 139620898, downloadHost: 'github.com' });
		expect(offer).toMatchObject({ tone: 'offer', title: 'Install GitHub Copilot to start chatting', action: { kind: 'install', label: 'Install GitHub Copilot' }, progress: null, steps: null, hint: 'Also in Settings › Agents' });
		expect(offer.detail).toBe("One-time 140 MB download. It's shared by GitHub Copilot chats and terminals on this computer. It comes from github.com and is checked against the publisher's checksum before it runs.");
		// Before the lookup answers: no size, no host, still an offer.
		expect(installCard(base).detail).toBe("One-time download. It's shared by GitHub Copilot chats and terminals on this computer.");
		expect(installCard({ ...base, available: false })).toMatchObject({ title: 'GitHub Copilot is not available on this computer.', action: null });
		expect(installCard({ ...base, damaged: true }).detail).toBe('This copy of GitHub Copilot is damaged.');
	});

	test('a started chat gets the slim strip: continue, size and host, a short Install', () => {
		const looked = { ...base, version: '1.0.114', downloadBytes: 139620898, downloadHost: 'github.com' };
		expect(installCard(looked, false, 'strip')).toEqual({ tone: 'offer', title: 'Install GitHub Copilot to continue', detail: "140 MB download from github.com, checked against the publisher's checksum.", progress: null, steps: null, hint: null, action: { kind: 'install', label: 'Install' } });
		expect(installCard(base, false, 'strip').detail).toBeNull();
		expect(installCard({ ...looked, downloadHost: null }, false, 'strip').detail).toBe('140 MB download on this computer.');
		expect(installCard({ ...base, damaged: true }, false, 'strip').detail).toBe('This copy of GitHub Copilot is damaged.');
		// Running and ended cards are the hero's, without the size hint.
		expect(installCard({ ...looked, operation: op({ downloadedBytes: 35_000_000, totalBytes: 140_000_000 }) }, false, 'strip')).toEqual(installCard({ ...looked, operation: op({ downloadedBytes: 35_000_000, totalBytes: 140_000_000 }) }));
		expect(installCard({ ...looked, operation: op({ phase: 'failed', error: 'checksum mismatch' }) }, false, 'strip')).toMatchObject({ tone: 'failed', detail: 'checksum mismatch', hint: null, action: { label: 'Try again' } });
		expect(installCard({ ...looked, operation: op({ phase: 'failed' }) }).hint).toBe('140 MB download.');
	});

	test('the card follows the download, then says how it ended', () => {
		const down = installCard({ ...base, operation: op({ downloadedBytes: 35_000_000, totalBytes: 140_000_000 }) });
		expect(down).toMatchObject({ tone: 'running', title: 'Downloading GitHub Copilot', progress: { percent: 25, detail: '35.0 of 140.0 MB', percentText: '25%' }, action: { kind: 'cancel', label: 'Cancel', operation: 7 } });
		expect(down.steps?.map((s) => s.state)).toEqual(['current', 'todo', 'todo']);
		expect(installCard({ ...base, operation: op({ downloadedBytes: 5_000_000 }) }).progress).toEqual({ percent: null, detail: 'Downloading 5.0 MB.', percentText: null });
		const unpack = installCard({ ...base, operation: op({ phase: 'extracting', downloadedBytes: 9, totalBytes: 9 }) });
		expect([unpack.title, unpack.progress?.percent, unpack.steps?.map((s) => s.state)]).toEqual(['Unpacking GitHub Copilot', null, ['done', 'current', 'todo']]);
		expect(installCard({ ...base, operation: op({ phase: 'verifying' }) }).steps?.map((s) => s.state)).toEqual(['done', 'done', 'current']);
		expect(installCard({ ...base, operation: op({}) }, true)).toMatchObject({ title: 'Cancelling…', action: { kind: 'cancel', label: 'Cancelling…' } });
		expect(installCard({ ...base, operation: op({ phase: 'failed', error: 'The GitHub Copilot download did not match its published checksum, so nothing was installed.' }) })).toMatchObject({
			tone: 'failed',
			title: "Couldn't install GitHub Copilot",
			detail: 'The GitHub Copilot download did not match its published checksum, so nothing was installed.',
			action: { kind: 'install', label: 'Try again' }
		});
		expect(installCard({ ...base, operation: op({ phase: 'failed' }) }).detail).toBe('Installation failed. Try again.');
		expect(installCard({ ...base, downloadBytes: 2_000_000, operation: op({ phase: 'cancelled' }) })).toMatchObject({ tone: 'cancelled', title: 'Installation cancelled', detail: 'Nothing was installed.', hint: '2 MB download.', action: { kind: 'install', label: 'Retry installation' } });
		// A finished removal leaves the offer.
		expect(installCard({ ...base, operation: op({ kind: 'remove', phase: 'succeeded' }) }).tone).toBe('offer');
	});

	test("the Settings row: the user's own copy outranks Kingu's", () => {
		const settled = { spokenStatus: null, busy: false };
		expect(settingsView({ ...base, source: 'external', installedVersion: '1.0.110', canRemove: true })).toEqual({ status: 'Uses your own copy', spokenStatus: 'Uses your own GitHub Copilot', error: null, progress: null, action: null, removable: true, busy: false, wraps: false });
		expect(settingsView({ ...base, source: 'external' })).toMatchObject({ action: null, removable: false });
		// A failed install of Kingu's copy isn't the row's to show while the user's own runs; a failed Remove is.
		expect(settingsView({ ...base, source: 'external', operation: op({ phase: 'failed', error: 'why' }) })).toMatchObject({ error: null, wraps: false });
		expect(settingsView({ ...base, source: 'external', operation: op({ kind: 'remove', phase: 'failed', error: 'busy' }) })).toMatchObject({ error: 'busy', wraps: true });
		expect(settingsView({ ...base, downloadBytes: 139620898 })).toEqual({ ...settled, status: 'Not installed. 140 MB download.', error: null, progress: null, action: { kind: 'install', label: 'Install' }, removable: false, wraps: true });
		const current = { ...base, source: 'managed' as const, version: '1.0.114', installedVersion: '1.0.114', installedCurrent: true, canRemove: true };
		expect(settingsView(current)).toEqual({ ...settled, status: 'Installed by Kingu · 1.0.114', error: null, progress: null, action: null, removable: true, wraps: false });
		expect(settingsView({ ...current, installedVersion: '1.0.110', installedCurrent: false })).toMatchObject({ action: { kind: 'install', label: 'Update' }, wraps: true });
		// No lookup yet: an installed copy is not called outdated.
		expect(settingsView({ ...current, version: null, installedCurrent: false }).action).toBeNull();
		expect(settingsView({ ...base, available: false })).toMatchObject({ status: 'GitHub Copilot is not available on this computer.', action: null, wraps: true });
		expect(settingsView({ ...base, damaged: true, canRemove: true })).toMatchObject({ status: 'This copy of GitHub Copilot is damaged.', action: { kind: 'install', label: 'Reinstall' }, removable: true, wraps: true });
		expect(settingsView({ ...base, operation: op({ downloadedBytes: 70_000_000, totalBytes: 140_000_000 }) })).toEqual({ ...settled, status: 'Downloading 70.0 MB of 140.0 MB.', error: null, progress: 50, action: { kind: 'cancel', label: 'Cancel', operation: 7 }, removable: false, wraps: true });
		// Only a known, positive size gives a percent; otherwise the download spins.
		expect(settingsView({ ...base, operation: op({ downloadedBytes: 5_000_000, totalBytes: 0 }) })).toMatchObject({ status: 'Downloading 5.0 MB.', progress: null, busy: true });
		expect(settingsView({ ...base, operation: op({ downloadedBytes: 5_000_000, totalBytes: null }) })).toMatchObject({ progress: null, busy: true, wraps: true });
		// Unpacking and verifying show a spinner and short text; a screen reader hears the agent.
		expect(settingsView({ ...base, operation: op({ phase: 'verifying' }) })).toMatchObject({ status: 'Verifying…', spokenStatus: 'Verifying GitHub Copilot…', busy: true, progress: null });
		expect(settingsView({ ...base, operation: op({ phase: 'extracting' }) })).toMatchObject({ status: 'Unpacking…', spokenStatus: 'Unpacking GitHub Copilot…', busy: true });
		expect(settingsView({ ...base, operation: op({ phase: 'extracting' }) }, true)).toMatchObject({ status: 'Cancelling…', spokenStatus: null });
		expect(settingsView({ ...current, operation: op({ kind: 'remove', phase: 'removing' }) })).toEqual({ ...settled, status: 'Removing…', error: null, progress: null, action: null, removable: false, busy: true, wraps: false });
		expect(settingsView({ ...base, operation: op({ phase: 'failed', error: 'why' }) })).toMatchObject({ status: null, error: 'why', action: { kind: 'install', label: 'Try again' } });
		expect(settingsView({ ...base, operation: op({ phase: 'cancelled' }) })).toMatchObject({ status: 'Installation cancelled.', action: { kind: 'install', label: 'Try again' } });
	});
});
