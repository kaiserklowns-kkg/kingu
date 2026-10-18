import { describe, expect, test } from 'bun:test';
import { problemAt, problemTable, sortProblems } from './problemsSettings';
import type { Diagnostic } from './protocol';

const d = (line: number, ch: number, severity: number, message = `${line}:${ch}:${severity}`): Diagnostic => ({
	range: { start: { line, character: ch }, end: { line, character: ch + 3 } },
	severity,
	message
});

describe('problems settings', () => {
	const items = [d(5, 0, 2), d(1, 0, 2), d(3, 0, 1)];

	test('problems.sortOrder', () => {
		expect(sortProblems(items, 'severity').map((x) => x.message)).toEqual(['3:0:1', '1:0:2', '5:0:2']);
		expect(sortProblems(items, 'position').map((x) => x.message)).toEqual(['1:0:2', '3:0:1', '5:0:2']);
	});

	test('problems.showCurrentInStatus: the problem under the cursor, else on its line, most severe first', () => {
		const list = [d(2, 0, 2, 'warn'), d(2, 10, 1, 'err')];
		expect(problemAt(list, { line: 2, character: 1 })?.message).toBe('warn');
		expect(problemAt(list, { line: 2, character: 6 })?.message).toBe('err');
		expect(problemAt(list, { line: 4, character: 0 })).toBeNull();
	});

	test('problems.defaultViewMode: table rows', () => {
		const files = [{ uri: 'file:///a', rel: 'a', label: 'a', items }];
		expect(problemTable(files, 'position').map((r) => r.item.message)).toEqual(['1:0:2', '3:0:1', '5:0:2']);
	});
});
