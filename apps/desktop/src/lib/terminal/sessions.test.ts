import { describe, expect, test } from 'bun:test';
import {
	adeKey,
	backgroundKeys,
	cliKey,
	isValidKey,
	keyTag,
	liveCliSessions,
	orphanKeys,
	panelKey,
	parseAdeTerminals,
	parseCliSessions,
	panelGroups,
	parsePanelTerminals,
	persist,
	restore,
	rootTag,
	storeName,
	withoutRun
} from './sessions.ts';
import { leaf, splitPane } from './paneLayout.ts';

function memory() {
	const items = new Map<string, string>();
	return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), items };
}

describe('root tags', () => {
	test('stable, short, and different per folder', () => {
		expect(rootTag('/Users/a/proj')).toBe(rootTag('/Users/a/proj'));
		expect(rootTag('/Users/a/proj')).toMatch(/^[0-9a-f]{8}$/);
		expect(rootTag('/Users/a/proj')).not.toBe(rootTag('/Users/a/proj2'));
		expect(rootTag('/Users/a/โปรเจกต์')).toMatch(/^[0-9a-f]{8}$/);
		// No folder open is a root of its own.
		expect(rootTag(null)).toBe(rootTag(null));
		expect(rootTag(null)).not.toBe(rootTag('/'));
	});
});

describe('session keys', () => {
	const tag = rootTag('/repo');
	test('every kind of terminal gets a key Rust accepts', () => {
		const longest = 'a'.repeat(48);
		for (const key of [panelKey(tag, 3), adeKey(tag, '', 't1'), adeKey(tag, 'fix-login', 't12'), cliKey(tag, 'fix-login', 1760000000000), cliKey(tag, longest, 1760000000000)]) expect(isValidKey(key)).toBe(true);
		expect(adeKey('ab12cd34', '', 't1')).toBe('ade:ab12cd34::t1');
		expect(cliKey('ab12cd34', 'a', 5)).toBe('cli:ab12cd34:a:5');
		expect(panelKey('ab12cd34', 2)).toBe('panel:ab12cd34:2');
	});
	test('two folders never share a key', () => {
		const other = rootTag('/other');
		expect(panelKey(tag, 1)).not.toBe(panelKey(other, 1));
		expect(adeKey(tag, '', 't1')).not.toBe(adeKey(other, '', 't1'));
		expect(cliKey(tag, 'x', 1)).not.toBe(cliKey(other, 'x', 1));
	});
	test('rejects what Rust rejects', () => {
		for (const key of ['', 'a b', 'a/b', 'ก', 'k'.repeat(129)]) expect(isValidKey(key)).toBe(false);
	});
	test('the root tag reads back from a key', () => {
		expect(keyTag(panelKey(tag, 1))).toBe(tag);
		expect(keyTag(adeKey(tag, 'w', 't1'))).toBe(tag);
		expect(keyTag(cliKey(tag, 's', 1))).toBe(tag);
		// Keys from before root tags.
		expect(keyTag('panel:1')).toBeNull();
		expect(keyTag('cli:fix:1700000000000')).toBeNull();
		expect(keyTag('ade::t1')).toBeNull();
	});
	test("orphans are only the current folder's live keys the page does not show", () => {
		const other = rootTag('/other');
		const live = [panelKey(tag, 1), panelKey(tag, 2), cliKey(tag, 'x', 1), panelKey(other, 1), 'panel:7'];
		expect(orphanKeys(live, new Set([panelKey(tag, 2), adeKey(tag, '', 't1')]), tag)).toEqual([panelKey(tag, 1), cliKey(tag, 'x', 1)]);
		// Background: everything the window does not show, any folder.
		expect(backgroundKeys(live, new Set([panelKey(tag, 2)]))).toEqual([panelKey(tag, 1), cliKey(tag, 'x', 1), panelKey(other, 1), 'panel:7']);
	});
});

describe('persistence', () => {
	test('round-trips through storage, one list per folder', () => {
		const store = memory();
		const a = rootTag('/a');
		const b = rootTag('/b');
		const state = { list: [{ id: 2, title: 'zsh' }, { id: 5, title: 'test', run: ['go', 'test'] }], active: 5, seq: 5 };
		persist(storeName('p', a), state, store);
		expect(restore(storeName('p', a), parsePanelTerminals, store)).toEqual({ list: [{ id: 2, title: 'zsh', run: undefined }, { id: 5, title: 'test', run: ['go', 'test'] }], active: 5, seq: 5, groups: [leaf('2'), leaf('5')] });
		expect(restore(storeName('p', b), parsePanelTerminals, store)).toBeNull();
		expect(storeName('p', a)).toBe(`p:${a}`);
	});
	test('a restored terminal never re-runs its command', () => {
		expect(withoutRun({ id: 5, title: 'test', run: ['go', 'test'] })).toEqual({ id: 5, title: 'test' });
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
		expect(parsePanelTerminals({ list: [{ id: 7 }, { id: 'x' }, null, { id: 0 }], active: 99, seq: 3 })).toEqual({ list: [{ id: 7, title: 'zsh', run: undefined }], active: 7, seq: 7, groups: [leaf('7')] });
		expect(parsePanelTerminals({ list: [], active: 1, seq: 1 })).toBeNull();
		expect(parsePanelTerminals([1, 2])).toBeNull();
	});
	test('panel terminal groups (VS Code splits): kept when valid, every terminal in exactly one', () => {
		const split = splitPane(leaf('1'), '1', '3', 'vertical');
		const list = [{ id: 1 }, { id: 2 }, { id: 3 }];
		expect(parsePanelTerminals({ list, active: 3, seq: 3, groups: [split] })?.groups).toEqual([split, leaf('2')]);
		// A group naming a gone terminal, or one already grouped, is dropped.
		expect(panelGroups([split, splitPane(leaf('3'), '3', '9', 'vertical'), 'junk'], [1, 3])).toEqual([split]);
		expect(panelGroups(undefined, [4])).toEqual([leaf('4')]);
	});
	test('ADE split tabs keep their pane tree; seq covers every pane', () => {
		const layout = splitPane(leaf('t2'), 't2', 't7', 'horizontal');
		const parsed = parseAdeTerminals({ terminals: { x: [{ id: 't2', n: 1, layout, pane: 't7', expanded: 'nope' }, { id: 't3', n: 2, layout: splitPane(leaf('t3'), 't3', 't7', 'vertical') }] }, active: {}, seq: 1 });
		expect(parsed?.terminals.x).toEqual([{ id: 't2', n: 1, title: undefined, run: undefined, layout, pane: 't7' }]);
		expect(parsed?.seq).toBe(7);
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
	test('after a restart only CLI sessions with a live PTY come back', () => {
		const tag = rootTag('/repo');
		const saved = { a: { run: ['claude'], startedAt: 10, hookToken: 'tok-aaaa-1111' }, b: { run: ['codex'], startedAt: 20 } };
		const { kept, gone } = liveCliSessions(saved, tag, new Set([cliKey(tag, 'a', 10), cliKey(rootTag('/other'), 'b', 20)]));
		expect(kept).toEqual({ a: saved.a });
		expect(gone).toEqual({ b: saved.b });
	});
});
