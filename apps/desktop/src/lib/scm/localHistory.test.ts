/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { setLocale } from '#lib/i18n/index.ts';
import { fileOf, isDiffKey, tabLabel } from '#lib/workbench/scm.ts';
import {
	RESTORE_SOURCE,
	SavedVersions,
	entryLabels,
	historySettingsFrom,
	localHistoryDiffKey,
	localHistoryKey,
	mergeByTime,
	parseLocalHistoryDiffKey,
	parseLocalHistoryKey,
	previousEntry,
	sourceLabel,
	type HistoryEntry
} from './localHistory';

const entry = (id: string, timestamp: number, source: string | null = null): HistoryEntry => ({ id, source, sourceDescription: null, timestamp });

describe('local history', () => {
	test('settings: VS Code defaults, minimums and enabled exclude globs', () => {
		expect(historySettingsFrom(() => undefined)).toEqual({ maxEntries: 50, maxFileSizeKb: 256, mergeWindowSecs: 10, exclude: [] });
		const values: Record<string, unknown> = {
			'workbench.localHistory.maxFileEntries': 0,
			'workbench.localHistory.maxFileSize': 0,
			'workbench.localHistory.mergeWindow': 2.7,
			'workbench.localHistory.exclude': { '**/dist/**': true, '**/off': false }
		};
		expect(historySettingsFrom((id) => values[id])).toEqual({ maxEntries: 0, maxFileSizeKb: 1, mergeWindowSecs: 2, exclude: ['**/dist/**'] });
	});

	test('source labels: registered sources, else the given name', () => {
		setLocale('en');
		expect(sourceLabel(null)).toBe('File Saved');
		expect(sourceLabel(RESTORE_SOURCE)).toBe('File Restored');
		expect(sourceLabel('Before refactor')).toBe('Before refactor');
	});

	test('editor keys round-trip and route like the file', () => {
		const show = localHistoryKey('Ab12.ts', 'src/a b.ts');
		expect(parseLocalHistoryKey(show)).toEqual({ id: 'Ab12.ts', rel: 'src/a b.ts' });
		expect(parseLocalHistoryKey('localhistory://x/')).toBeNull();
		const withFile = localHistoryDiffKey('Ab12.ts', null, 'src/a.ts');
		expect(parseLocalHistoryDiffKey(withFile)).toEqual({ left: 'Ab12.ts', right: null, rel: 'src/a.ts' });
		expect(parseLocalHistoryDiffKey(localHistoryDiffKey('a', 'b', 'x/y.ts'))).toEqual({ left: 'a', right: 'b', rel: 'x/y.ts' });
		expect(isDiffKey(withFile)).toBe(true);
		expect(isDiffKey(show)).toBe(false);
		expect(fileOf(withFile)).toBe('src/a.ts');
		expect(fileOf(show)).toBe('src/a b.ts');
	});

	test('tab labels like VS Code (entry label from the loaded entries)', () => {
		setLocale('en');
		entryLabels.of = (_rel, id) => (id === 'a' ? 'File Saved • Oct 1' : null);
		expect(tabLabel(localHistoryKey('a', 'src/x.ts'))).toBe('x.ts (File Saved • Oct 1)');
		expect(tabLabel(localHistoryDiffKey('a', null, 'src/x.ts'))).toBe('x.ts (File Saved • Oct 1) ↔ x.ts');
		expect(tabLabel(localHistoryDiffKey('a', 'b', 'src/x.ts'))).toBe('x.ts (File Saved • Oct 1) ↔ x.ts (Local History)');
		entryLabels.of = () => null;
	});

	test('previous entry and merging two timeline sources newest first', () => {
		const list = [entry('a', 1), entry('b', 2), entry('c', 3)];
		expect(previousEntry(list, 'c')?.id).toBe('b');
		expect(previousEntry(list, 'a')).toBeNull();
		const merged = mergeByTime([30, 10], (x) => x, [40, 20, 5], (x) => x);
		expect(merged.map((m) => `${m.from}${m.item}`)).toEqual(['b40', 'a30', 'b20', 'a10', 'b5']);
	});

	test('a save without a content change adds no entry', () => {
		const v = new SavedVersions();
		expect(v.isNew('a.ts', 3)).toBe(true);
		expect(v.isNew('a.ts', 3)).toBe(false);
		expect(v.isNew('a.ts', 4)).toBe(true);
		v.forget('a.ts');
		expect(v.isNew('a.ts', 4)).toBe(true);
	});
});
