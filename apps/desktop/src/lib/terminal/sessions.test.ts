import { describe, expect, test } from 'bun:test';
import { adeKey, cliKey, isValidKey, orphanKeys, panelKey, parseAdeTerminals, parseCliSessions, parsePanelTerminals, persist, restore } from './sessions.ts';

function memory() {
	const items = new Map<string, string>();
	return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), items };
}

describe('session keys', () => {
	test('every kind of terminal gets a key Rust accepts', () => {
		for (const key of [panelKey(3), adeKey('', 't1'), adeKey('fix-login', 't12'), cliKey('fix-login', 1760000000000)]) expect(isValidKey(key)).toBe(true);
		expect(adeKey('', 't1')).toBe('ade::t1');
		expect(cliKey('a', 5)).toBe('cli:a:5');
	});
	test('rejects what Rust rejects', () => {
		for (const key of ['', 'a b', 'a/b', 'ก', 'k'.repeat(129)]) expect(isValidKey(key)).toBe(false);
	});
	test('orphans are live keys the page does not show', () => {
		expect(orphanKeys(['panel:1', 'panel:2', 'cli:x:1'], new Set(['panel:2', 'ade::t1']))).toEqual(['panel:1', 'cli:x:1']);
	});
});

describe('persistence', () => {
	test('round-trips through storage', () => {
		const store = memory();
		const state = { list: [{ id: 2, title: 'zsh' }, { id: 5, title: 'test', run: ['go', 'test'] }], active: 5, seq: 5 };
		persist('p', state, store);
		expect(restore('p', parsePanelTerminals, store)).toEqual({ list: [{ id: 2, title: 'zsh', run: undefined }, { id: 5, title: 'test', run: ['go', 'test'] }], active: 5, seq: 5 });
	});
	test('missing, broken or unavailable storage reads as nothing', () => {
		const store = memory();
		expect(restore('p', parsePanelTerminals, store)).toBeNull();
		store.items.set('p', '{not json');
		expect(restore('p', parsePanelTerminals, store)).toBeNull();
		expect(restore('p', parsePanelTerminals, null)).toBeNull();
		const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
		expect(restore('p', parsePanelTerminals, throwing)).toBeNull();
		expect(() => persist('p', {}, throwing)).not.toThrow();
	});
	test('panel terminals: bad entries dropped, seq never reuses an id, active falls back', () => {
		expect(parsePanelTerminals({ list: [{ id: 7 }, { id: 'x' }, null, { id: 0 }], active: 99, seq: 3 })).toEqual({ list: [{ id: 7, title: 'zsh', run: undefined }], active: 7, seq: 7 });
		expect(parsePanelTerminals({ list: [], active: 1, seq: 1 })).toBeNull();
		expect(parsePanelTerminals([1, 2])).toBeNull();
	});
	test('ADE terminals: per worktree, seq covers every tab id', () => {
		const parsed = parseAdeTerminals({
			terminals: { '': [{ id: 't4', n: 1 }], 'fix-login': [{ id: 't9', n: 2, title: 'claude', run: ['claude'] }, { id: 'bad', n: 1 }], 'bad slug!': [{ id: 't1', n: 1 }], empty: [] },
			active: { '': 't4', x: 3 },
			seq: 2
		});
		expect(parsed).toEqual({
			terminals: { '': [{ id: 't4', n: 1, title: undefined, run: undefined }], 'fix-login': [{ id: 't9', n: 2, title: 'claude', run: ['claude'] }] },
			active: { '': 't4' },
			seq: 9
		});
		expect(parseAdeTerminals({ terminals: [], seq: 1 })).toBeNull();
	});
	test('CLI sessions keep their command (ignored on re-attach)', () => {
		expect(parseCliSessions({ a: { run: ['claude', 'fix it'], startedAt: 10 }, b: { run: [], startedAt: 1 }, c: { run: ['x'], startedAt: 'no' }, 'd e': { run: ['x'], startedAt: 1 } })).toEqual({
			a: { run: ['claude', 'fix it'], startedAt: 10 }
		});
		expect(parseCliSessions('x')).toBeNull();
		expect(parseCliSessions({ a: { run: ['claude'], startedAt: 1, hookToken: '3f2a9c1e-77aa-4d1b' } })).toEqual({ a: { run: ['claude'], startedAt: 1, hookToken: '3f2a9c1e-77aa-4d1b' } });
		expect(parseCliSessions({ a: { run: ['claude'], startedAt: 1, hookToken: '../x' } })).toEqual({ a: { run: ['claude'], startedAt: 1 } });
	});
});
