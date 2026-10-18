import { describe, expect, test } from 'bun:test';
import { flattenSymbols, symbolKind } from './symbols';

const r = (line: number, character: number) => ({ start: { line, character }, end: { line, character: character + 1 } });

describe('flattenSymbols', () => {
	test('nested document symbols keep their container, in file order', () => {
		const flat = flattenSymbols([
			{ name: 'App', kind: 5, range: r(0, 0), selectionRange: r(0, 6), children: [{ name: 'run', kind: 6, range: r(2, 2), selectionRange: r(2, 2) }] },
			{ name: 'main', kind: 12, range: r(9, 0), selectionRange: r(9, 9) }
		]);
		expect(flat).toEqual([
			{ name: 'App', kind: 'class', container: '', line: 1, column: 7 },
			{ name: 'run', kind: 'method', container: 'App', line: 3, column: 3 },
			{ name: 'main', kind: 'function', container: '', line: 10, column: 10 }
		]);
	});
	test('symbol information lists use their container name', () => {
		const flat = flattenSymbols([{ name: 'x', kind: 13, containerName: 'mod', location: { uri: 'file:///a', range: r(4, 1) } }]);
		expect(flat).toEqual([{ name: 'x', kind: 'variable', container: 'mod', line: 5, column: 2 }]);
		expect(symbolKind(999)).toBe('symbol');
	});
});
