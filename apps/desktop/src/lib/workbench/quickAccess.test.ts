/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { flattenSymbols, parseQuickInput, pickSymbols, pushHistory, rankFiles, splitFileAndPosition } from './quickAccess';

describe('quick access prefixes', () => {
	test('each prefix picks its provider', () => {
		expect(parseQuickInput('>git: commit')).toEqual({ kind: 'commands', query: 'git: commit' });
		expect(parseQuickInput(':42')).toEqual({ kind: 'line', line: 42, column: undefined });
		expect(parseQuickInput(':42:7')).toEqual({ kind: 'line', line: 42, column: 7 });
		expect(parseQuickInput(':42,7')).toEqual({ kind: 'line', line: 42, column: 7 });
		expect(parseQuickInput(':')).toEqual({ kind: 'line', line: undefined, column: undefined });
		expect(parseQuickInput('@')).toEqual({ kind: 'symbol', query: '', byKind: false });
		expect(parseQuickInput('@:render')).toEqual({ kind: 'symbol', query: 'render', byKind: true });
		expect(parseQuickInput('#Workspace')).toEqual({ kind: 'workspaceSymbol', query: 'Workspace' });
		expect(parseQuickInput('?')).toEqual({ kind: 'help', query: '' });
		expect(parseQuickInput('view term')).toEqual({ kind: 'view', query: 'term' });
		expect(parseQuickInput('edt mru a')).toEqual({ kind: 'editors', query: 'a', mru: true });
		expect(parseQuickInput('edt ')).toEqual({ kind: 'editors', query: '', mru: false });
		expect(parseQuickInput('src/main')).toEqual({ kind: 'files', query: 'src/main' });
		// `viewer` is a file name, not the `view ` prefix.
		expect(parseQuickInput('viewer.ts').kind).toBe('files');
	});

	test('file:line[:col] like VS Code extractRangeFromFilter', () => {
		expect(splitFileAndPosition('main.rs:42')).toEqual({ query: 'main.rs', line: 42, column: undefined });
		expect(splitFileAndPosition('src/a.ts:42:5')).toEqual({ query: 'src/a.ts', line: 42, column: 5 });
		expect(splitFileAndPosition('a.ts#12')).toEqual({ query: 'a.ts', line: 12, column: undefined });
		expect(splitFileAndPosition('a.ts(3,9)')).toEqual({ query: 'a.ts', line: 3, column: 9 });
		expect(splitFileAndPosition('a.ts')).toEqual({ query: 'a.ts' });
		expect(splitFileAndPosition(':12')).toEqual({ query: ':12' });
		expect(parseQuickInput('lib.rs:10')).toEqual({ kind: 'files', query: 'lib.rs', line: 10, column: undefined });
	});
});

describe('quick open ranking', () => {
	const files = ['src/app.ts', 'src/apply.ts', 'docs/api.md', 'README.md'];

	test('no query: the editor history only', () => {
		expect(rankFiles('', files, ['README.md', 'src/app.ts', 'gone.ts'])).toEqual([
			{ path: 'README.md', recent: true },
			{ path: 'src/app.ts', recent: true }
		]);
	});

	test('recently opened matches come before other file results', () => {
		const ranked = rankFiles('ap', files, ['src/apply.ts']);
		expect(ranked[0]).toMatchObject({ path: 'src/apply.ts', recent: true });
		expect(ranked.slice(1).every((r) => !r.recent)).toBe(true);
		expect(ranked.map((r) => r.path)).toContain('src/app.ts');
		expect(new Set(ranked.map((r) => r.path)).size).toBe(ranked.length);
	});

	test('history while the file list is still loading', () => {
		expect(rankFiles('', [], ['a.ts']).map((r) => r.path)).toEqual(['a.ts']);
	});

	test('history is most recent first, without duplicates', () => {
		expect(pushHistory(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
		expect(pushHistory(['a', 'b'], 'x', 2)).toEqual(['x', 'a']);
	});
});

describe('symbols', () => {
	const pos = (line: number, character = 0) => ({ start: { line, character }, end: { line, character } });
	const tree = [
		{ name: 'Editor', kind: 5, range: pos(0), selectionRange: pos(0, 6), children: [{ name: 'open', kind: 6, range: pos(3), selectionRange: pos(3, 2) }, { name: 'close', kind: 6, range: pos(9), selectionRange: pos(9, 2) }] },
		{ name: 'helper', kind: 12, range: pos(20), selectionRange: pos(20, 9) },
		{ name: 'MAX', kind: 14, range: pos(1), selectionRange: pos(1, 6) }
	];

	test('flattens document symbols in document order with containers', () => {
		expect(flattenSymbols(tree).map((s) => [s.name, s.line, s.column, s.container])).toEqual([
			['Editor', 1, 7, undefined],
			['MAX', 2, 7, undefined],
			['open', 4, 3, 'Editor'],
			['close', 10, 3, 'Editor'],
			['helper', 21, 10, undefined]
		]);
		const info = [{ name: 'x', kind: 13, containerName: 'mod', location: { uri: 'file:///a', range: pos(4, 1) } }];
		expect(flattenSymbols(info)).toEqual([{ name: 'x', kind: 13, container: 'mod', line: 5, column: 2 }]);
	});

	test('@ lists symbols with a count; @: groups them by kind', () => {
		const flat = flattenSymbols(tree);
		const plain = pickSymbols(flat, '', false);
		expect(plain[0].separator).toBe('symbols (5)');
		expect(plain.map((p) => p.symbol.name)).toEqual(['Editor', 'MAX', 'open', 'close', 'helper']);
		const grouped = pickSymbols(flat, '', true);
		expect(grouped.map((p) => [p.symbol.name, p.separator])).toEqual([
			['Editor', 'classes (1)'],
			['open', 'methods (2)'],
			['close', undefined],
			['helper', 'functions (1)'],
			['MAX', 'constants (1)']
		]);
		expect(pickSymbols(flat, 'clo', false).map((p) => p.symbol.name)).toEqual(['close']);
	});
});
