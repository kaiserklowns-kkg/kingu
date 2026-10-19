/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { conflictCompareKey, diffKey, fileOf, historyDiffKey, indexDiffKey, isDiffKey, isMergeKey, mergeKey, parseHistoryDiffKey, parseIndexDiffKey, tabLabel } from '../workbench/scm';

describe('Source Control editor keys', () => {
	test('staged, history, compare and merge keys name their file', () => {
		expect(fileOf(indexDiffKey('src/a.ts'))).toBe('src/a.ts');
		expect(parseIndexDiffKey(indexDiffKey('src/a.ts'))).toBe('src/a.ts');
		expect(parseIndexDiffKey(diffKey('src/a.ts'))).toBeNull();
		expect(tabLabel(indexDiffKey('src/a.ts'))).toBe('a.ts (Index)');
		expect(tabLabel(diffKey('src/a.ts'))).toBe('a.ts (Working Tree)');
		expect(fileOf(conflictCompareKey('x/b.ts'))).toBe('x/b.ts');
		expect(isMergeKey(mergeKey('x/b.ts')) && fileOf(mergeKey('x/b.ts'))).toBe('x/b.ts');
		expect(isDiffKey(mergeKey('x/b.ts'))).toBe(false);
		for (const k of [indexDiffKey('a'), conflictCompareKey('a'), historyDiffKey('abc', 'a')]) expect(isDiffKey(k)).toBe(true);
	});

	test('a history diff keeps the path before a rename', () => {
		const k = historyDiffKey('0123456789', 'new dir/a.ts', 'old/a b.ts');
		expect(parseHistoryDiffKey(k)).toEqual({ hash: '0123456789', rel: 'new dir/a.ts', before: 'old/a b.ts' });
		expect(parseHistoryDiffKey(historyDiffKey('abc', 'a/b.ts'))).toEqual({ hash: 'abc', rel: 'a/b.ts', before: 'a/b.ts' });
		expect(tabLabel(k)).toBe('a.ts (0123456)');
		expect(fileOf(k)).toBe('new dir/a.ts');
	});
});
