/// <reference types="bun" />
// The debug hover's expression under the mouse (VS Code's getExactExpressionStartAndEnd), its
// lookup in the scopes, and Debug Console completions.
import { describe, expect, test } from 'bun:test';
import { expressionAt, hoverFromVariables } from './hover.ts';
import type { Variable } from './protocol.ts';
import { applyCompletion, rankCompletions, wordBefore } from './replCompletion.ts';

describe('expressionAt', () => {
	const line = '  const total = order.items[0].price * qty; // ok';
	const at = (col: number) => expressionAt(line, col)?.expression;
	test('dotted paths are cut after the hovered word', () => {
		expect(at(line.indexOf('order') + 2)).toBe('order');
		expect(at(line.indexOf('items') + 2)).toBe('order.items');
		expect(at(line.indexOf('qty') + 1)).toBe('qty');
		expect(at(line.indexOf('total') + 1)).toBe('total');
		expect(at(line.indexOf('=') + 1)).toBeUndefined();
	});
	test('VS Code examples: ->, ::, ?., spread and columns', () => {
		expect(expressionAt('p->next->val', 10)?.expression).toBe('p->next->val');
		expect(expressionAt('Foo::BAR + 1', 7)?.expression).toBe('Foo::BAR');
		expect(expressionAt('a?.b', 4)?.expression).toBe('a?.b');
		expect(expressionAt('f(...args)', 8)).toEqual({ expression: 'args', start: 6, end: 9 });
		expect(expressionAt('self.ชื่อ', 7)?.expression).toBe('self.ชื่อ');
	});
});

describe('hoverFromVariables', () => {
	const tree: Record<number, Variable[]> = {
		1: [
			{ name: 'cfg', value: 'Config', variablesReference: 2 },
			{ name: 'n', value: '1', variablesReference: 0 }
		],
		2: [{ name: 'port', value: '8080', variablesReference: 0 }],
		3: [{ name: 'n', value: '2', variablesReference: 0 }]
	};
	const children = async (ref: number) => tree[ref] ?? [];
	test('walks a.b through the children', async () => {
		expect((await hoverFromVariables('cfg.port', [{ name: 'Locals', variablesReference: 1, expensive: false }], children))?.value).toBe('8080');
		expect(await hoverFromVariables('cfg.host', [{ name: 'Locals', variablesReference: 1, expensive: false }], children)).toBeNull();
	});
	test('scopes that disagree show nothing; expensive scopes are not read', async () => {
		const scopes = [
			{ name: 'Locals', variablesReference: 1, expensive: false },
			{ name: 'Globals', variablesReference: 3, expensive: false }
		];
		expect(await hoverFromVariables('n', scopes, children)).toBeNull();
		const read: number[] = [];
		await hoverFromVariables('n', [{ name: 'Locals', variablesReference: 1, expensive: false }, { name: 'Registers', variablesReference: 3, expensive: true }], async (r) => (read.push(r), children(r)));
		expect(read).toEqual([1]);
	});
});

describe('Debug Console completions', () => {
	test('the word before the caret is replaced, or the adapter says what', () => {
		expect(wordBefore('console.lo', 10)).toEqual({ start: 8, word: 'lo' });
		expect(applyCompletion('console.lo', 10, { label: 'log' })).toEqual({ text: 'console.log', cursor: 11 });
		expect(applyCompletion('x = obj.', 8, { label: 'length', text: 'length' })).toEqual({ text: 'x = obj.length', cursor: 14 });
		// 1-based start with a length (columnsStartAt1), overwriting part of the input.
		expect(applyCompletion('pri(1)', 3, { label: 'print', start: 1, length: 3 })).toEqual({ text: 'print(1)', cursor: 5 });
	});
	test('ranked by sortText and filtered by the typed prefix', () => {
		const items = [{ label: 'log' }, { label: 'Length', sortText: '0' }, { label: 'map' }];
		expect(rankCompletions(items, 'l').map((i) => i.label)).toEqual(['Length', 'log']);
		expect(rankCompletions(items, '').map((i) => i.label)).toEqual(['Length', 'log', 'map']);
	});
});
