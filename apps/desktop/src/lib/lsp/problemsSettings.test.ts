import { describe, expect, test } from 'bun:test';
import { problemAt, problemBadge, problemDecorations, problemTable, sortProblems } from './problemsSettings';
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
		const files = [{ uri: 'file:///a', rel: 'a', label: 'a', detail: '', items }];
		expect(problemTable(files, 'position').map((r) => r.item.message)).toEqual(['1:0:2', '3:0:1', '5:0:2']);
	});
});

test('problems.decorations.enabled: counts on files, the worst color on their folders', () => {
	const d = (severity: number) => ({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'm', severity });
	const files = [
		{ uri: 'file:///w/src/a.ts', rel: 'src/a.ts', label: 'src/a.ts', detail: '', items: [d(2), d(2)] },
		{ uri: 'file:///w/src/lib/b.ts', rel: 'src/lib/b.ts', label: 'src/lib/b.ts', detail: '', items: [d(1), d(3)] },
		{ uri: 'file:///w/c.ts', rel: 'c.ts', label: 'c.ts', detail: '', items: [d(4)] },
		{ uri: 'file:///x/d.ts', rel: null, label: '/x/d.ts', detail: '', items: [d(1)] }
	];
	const map = problemDecorations(files);
	expect(map.get('src/a.ts')).toEqual({ severity: 'warning', count: 2 });
	expect(map.get('src/lib/b.ts')).toEqual({ severity: 'error', count: 1 });
	expect(map.get('src/lib')).toEqual({ severity: 'error' });
	expect(map.get('src')).toEqual({ severity: 'error' });
	// Infos and hints are not decorations; files outside the folder have no row.
	expect(map.has('c.ts')).toBe(false);
	expect(map.size).toBe(4);
	expect(problemBadge(3)).toBe('3');
	expect(problemBadge(12)).toBe('9+');
});
