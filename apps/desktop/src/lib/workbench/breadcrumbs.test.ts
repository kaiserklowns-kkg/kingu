import { describe, expect, test } from 'bun:test';
import { filePathCrumbs, KIND_SETTINGS, sortSymbols, symbolCodicon, symbolPathText, symbolSiblings, visibleSymbols } from './breadcrumbs';
import type { DocumentSymbol } from '#lib/lsp/protocol.ts';

const r = (sl: number, el: number) => ({ start: { line: sl, character: 0 }, end: { line: el, character: 0 } });
const sym = (name: string, kind: number, sl: number, el: number, children: DocumentSymbol[] = []): DocumentSymbol =>
	({ name, kind, range: r(sl, el), selectionRange: r(sl, sl), children }) as DocumentSymbol;

describe('breadcrumbs settings', () => {
	const settingsWith = (values: Record<string, unknown>) => <T,>(id: string) => (id in values ? values[id] : id.startsWith('breadcrumbs.show') ? true : undefined) as T;

	test('breadcrumbs.filePath', () => {
		expect(filePathCrumbs(['src', 'lib', 'a.ts'], 'on')).toEqual(['src', 'lib', 'a.ts']);
		expect(filePathCrumbs(['src', 'lib', 'a.ts'], 'last')).toEqual(['a.ts']);
		expect(filePathCrumbs(['src', 'lib', 'a.ts'], 'off')).toEqual([]);
	});

	test('breadcrumbs.symbolPath and show*: the path stops at the first hidden kind', () => {
		const crumbs = [
			{ name: 'Mod', kind: 2, range: r(0, 0) },
			{ name: 'Class', kind: 5, range: r(1, 1) },
			{ name: 'method', kind: 6, range: r(2, 2) }
		];
		expect(visibleSymbols(crumbs, settingsWith({ 'breadcrumbs.symbolPath': 'on' })).map((c) => c.name)).toEqual(['Mod', 'Class', 'method']);
		expect(visibleSymbols(crumbs, settingsWith({ 'breadcrumbs.symbolPath': 'last' })).map((c) => c.name)).toEqual(['method']);
		expect(visibleSymbols(crumbs, settingsWith({ 'breadcrumbs.symbolPath': 'off' }))).toEqual([]);
		expect(visibleSymbols(crumbs, settingsWith({ 'breadcrumbs.symbolPath': 'on', 'breadcrumbs.showClasses': false })).map((c) => c.name)).toEqual(['Mod']);
		expect(symbolPathText(crumbs, settingsWith({ 'breadcrumbs.symbolPathSeparator': '::' }))).toBe('Mod::Class::method');
	});

	test('a setting per LSP symbol kind, and an icon per kind', () => {
		expect(Object.keys(KIND_SETTINGS)).toHaveLength(26);
		expect(KIND_SETTINGS[22]).toBe('breadcrumbs.showEnumMembers');
		expect(symbolCodicon(6)).toBe('codicon-symbol-method');
		expect(symbolCodicon(26)).toBe('codicon-symbol-type-parameter');
	});

	test('breadcrumbs.symbolSortOrder sorts the picker', () => {
		const tree = [sym('b', 12, 0, 10, [sym('zeta', 13, 1, 1), sym('alpha', 14, 2, 2)]), sym('a', 5, 11, 20)];
		const levels = symbolSiblings(tree, { line: 2, character: 0 }, settingsWith({}));
		expect(levels.map((l) => l.map((s) => s.name))).toEqual([['b', 'a'], ['zeta', 'alpha']]);
		expect(sortSymbols(levels[0], 'position').map((s) => s.name)).toEqual(['b', 'a']);
		expect(sortSymbols(levels[0], 'name').map((s) => s.name)).toEqual(['a', 'b']);
		expect(sortSymbols(levels[1], 'type').map((s) => s.name)).toEqual(['zeta', 'alpha']);
		expect(symbolSiblings(tree, { line: 2, character: 0 }, settingsWith({ 'breadcrumbs.showVariables': false }))[1].map((s) => s.name)).toEqual(['alpha']);
	});
});
