import { expect, test } from 'bun:test';
import { openInEditor, type OpenPorts } from './editorOpen.ts';

type Entry = { model: { isDisposed(): boolean } };

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
}

const entry = (disposed = false): Entry => ({ model: { isDisposed: () => disposed } });

/** A group's editor host as EditorHost wires it: Monaco throws when a disposed editor gets a model. */
function host(placeholders: Map<string, unknown>, log: string[], name: string) {
	const state = { disposed: false, active: 'app.py' as string | null };
	const open = (path: string, load: () => Promise<Entry>) =>
		openInEditor({
			load,
			alive: () => !state.disposed,
			wanted: () => state.active === path,
			show: () => {
				if (state.disposed) throw new Error('InstantiationService has been disposed');
				log.push(`${name} shows ${path}`);
			},
			failed: (e) => placeholders.set(path, String(e))
		});
	return { state, open };
}

function ports(o: Partial<OpenPorts<Entry>> = {}) {
	const log: string[] = [];
	const p: OpenPorts<Entry> = {
		load: async () => entry(),
		alive: () => true,
		wanted: () => true,
		show: () => log.push('show'),
		failed: (e) => log.push(`failed ${e instanceof Error ? e.message : e}`),
		...o
	};
	return { p, log };
}

test('a loaded file is shown', async () => {
	const { p, log } = ports();
	expect(await openInEditor(p)).toBe('shown');
	expect(log).toEqual(['show']);
});

test('a file that cannot be read gets its placeholder', async () => {
	const { p, log } = ports({ load: async () => Promise.reject(new Error('binary')) });
	expect(await openInEditor(p)).toBe('failed');
	expect(log).toEqual(['failed binary']);
});

test('a read failure is the file’s own even when the editor went away', async () => {
	const { p, log } = ports({ load: async () => Promise.reject(new Error('too large')), alive: () => false });
	expect(await openInEditor(p)).toBe('failed');
	expect(log).toEqual(['failed too large']);
});

test('nothing happens when the tab changed, the editor went away or the model was disposed', async () => {
	for (const o of [{ wanted: () => false }, { alive: () => false }, { load: async () => entry(true) }]) {
		const { p, log } = ports(o);
		expect(await openInEditor(p)).toBe('stale');
		expect(log).toEqual([]);
	}
});

test('an error while showing a model in a live editor is reported', async () => {
	const { p, log } = ports({
		show: () => {
			throw new Error('bad model');
		}
	});
	expect(await openInEditor(p)).toBe('failed');
	expect(log).toEqual(['failed bad model']);
});

test('a host destroyed mid-load leaves the file to the host that replaced it (2026-11-24 log)', async () => {
	// Maximize, a first split or a hot reload recreates group 1's host while app.py is loading.
	const placeholders = new Map<string, unknown>();
	const log: string[] = [];
	const old = host(placeholders, log, 'old');
	const slow = deferred<Entry>();
	const oldOpen = old.open('app.py', () => slow.promise);
	old.state.disposed = true;

	const fresh = host(placeholders, log, 'new');
	expect(await fresh.open('app.py', async () => entry())).toBe('shown');

	slow.resolve(entry());
	expect(await oldOpen).toBe('stale');
	// Before the fix the old host threw on its disposed editor and the error became app.py's placeholder.
	expect(placeholders.size).toBe(0);
	expect(log).toEqual(['new shows app.py']);
});
