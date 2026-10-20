/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
	defaultSearchConfig,
	deleteFileResults,
	extractSearchQueryFromLines,
	initialConfig,
	InvalidQueryError,
	isSearchEditorKey,
	locationAt,
	modifyContextLines,
	parseSerializedSearchEditor,
	searchEditorDirty,
	searchEditorName,
	serializeForDisk,
	serializeSearchConfiguration,
	serializeSearchResults,
	suggestedSearchFileName,
	type EditorFile
} from './searchEditor';
import type { TextMatch } from './searchResults';

const match = (line: number, column: number, end_column: number, preview = ''): TextMatch => ({ line, column, end_column, preview, preview_start: 0, preview_end: 0, text: '' });

describe('.code-search header', () => {
	test('serializes like VS Code', () => {
		expect(serializeSearchConfiguration({ query: 'foo' })).toBe('# Query: foo\n');
		expect(
			serializeSearchConfiguration({ query: 'a\\b\nc', isCaseSensitive: true, matchWholeWord: true, isRegexp: true, useExcludeSettingsAndIgnoreFiles: false, filesToInclude: 'src', filesToExclude: '*.md', contextLines: 2 })
		).toBe('# Query: a\\\\b\\nc\n# Flags: CaseSensitive WordMatch RegExp IgnoreExcludeSettings\n# Including: src\n# Excluding: *.md\n# ContextLines: 2\n');
	});

	test('round-trips through the parser', () => {
		const config = { ...defaultSearchConfig(), query: 'x\\y\nz', isRegexp: true, filesToInclude: 'lib', contextLines: 3 };
		const parsed = extractSearchQueryFromLines(serializeSearchConfiguration(config).split('\n'));
		expect(parsed).toEqual({ ...config, showIncludesExcludes: true });
	});

	test('a lone backslash in the query is an error', () => {
		expect(() => extractSearchQueryFromLines(['# Query: a\\b'])).toThrow(InvalidQueryError);
	});

	test('a saved file splits at the first blank line', () => {
		const file = serializeForDisk({ query: 'q', contextLines: 1 }, '1 result - 1 file\n\na.ts:\n  1: q\n');
		const { config, text } = parseSerializedSearchEditor(file);
		expect(config.query).toBe('q');
		expect(config.contextLines).toBe(1);
		expect(text).toBe('1 result - 1 file\n\na.ts:\n  1: q\n');
	});
});

describe('results text', () => {
	const file: EditorFile = {
		path: 'src/a.ts',
		matches: [match(9, 3, 6), match(10, 1, 4), match(10, 6, 9)],
		lines: [
			{ line: 8, text: 'before', is_match: false },
			{ line: 9, text: '  foo', is_match: true },
			{ line: 10, text: 'foo foo', is_match: true },
			{ line: 11, text: 'after', is_match: false }
		]
	};

	test('file blocks with context, padded line numbers and match ranges', () => {
		const { text, matchRanges } = serializeSearchResults([file, { path: 'b.md', matches: [match(1, 1, 2)], lines: [{ line: 1, text: 'x', is_match: true }] }]);
		expect(text.split('\n')).toEqual(['4 results - 2 files', '', 'src/a.ts:', '   8  before', '   9:   foo', '  10: foo foo', '  11  after', '', 'b.md:', '  1: x', '']);
		// `   9: ` is 6 characters: the match at column 3 starts at 9.
		expect(matchRanges[0]).toEqual({ startLineNumber: 5, startColumn: 9, endLineNumber: 5, endColumn: 12 });
		expect(matchRanges.slice(1, 3).map((r) => [r.startLineNumber, r.startColumn])).toEqual([
			[6, 7],
			[6, 12]
		]);
		expect(matchRanges[3]).toEqual({ startLineNumber: 10, startColumn: 6, endLineNumber: 10, endColumn: 7 });
	});

	test('a gap between context lines is a blank line', () => {
		const f: EditorFile = {
			path: 'a',
			matches: [match(2, 1, 2), match(9, 1, 2)],
			lines: [
				{ line: 2, text: 'm', is_match: true },
				{ line: 3, text: 'c', is_match: false },
				{ line: 8, text: 'c', is_match: false },
				{ line: 9, text: 'm', is_match: true }
			]
		};
		expect(serializeSearchResults([f]).text.split('\n').slice(2)).toEqual(['a:', '  2: m', '  3  c', '', '  8  c', '  9: m', '']);
	});

	test('no results, and the limit warning', () => {
		expect(serializeSearchResults([]).text).toBe('No Results\n');
		expect(serializeSearchResults([], { limitHit: true }).text.split('\n')[1]).toContain('subset of all matches');
		const one = serializeSearchResults([{ path: 'a', matches: [match(1, 1, 2)], lines: [] }]);
		expect(one.text.split('\n')[0]).toBe('1 result - 1 file');
	});
});

describe('locations in the results', () => {
	const lines = ['2 results - 1 file', '', 'src/a.ts:', '   8  before', '   9:   foo', '  10: foo', ''];
	test('a result line points at its file line and column', () => {
		expect(locationAt(lines, 5, 10)).toEqual({ kind: 'line', path: 'src/a.ts', line: 9, column: 4, isMatch: true });
		expect(locationAt(lines, 4, 1)).toEqual({ kind: 'line', path: 'src/a.ts', line: 8, column: 1, isMatch: false });
		expect(locationAt(lines, 3)).toEqual({ kind: 'file', path: 'src/a.ts' });
		expect(locationAt(lines, 1)).toBeNull();
		expect(locationAt(lines, 2)).toBeNull();
	});
	test('a click past an elision stops before it', () => {
		const l = ['a:', `  1: ${'x'.repeat(5)} ⟪ 3 characters skipped ⟫`];
		expect(locationAt(l, 2, 60)).toMatchObject({ line: 1, column: 7 });
	});
});

test('Delete File Results removes the whole block of each selection', () => {
	const lines = ['2 results - 2 files', '', 'a.ts:', '  1: x', '  2  y', '', 'b.ts:', '  3: z', ''];
	const ranges = [
		{ startLineNumber: 4, startColumn: 6, endLineNumber: 4, endColumn: 7 },
		{ startLineNumber: 8, startColumn: 6, endLineNumber: 8, endColumn: 7 }
	];
	const out = deleteFileResults(lines, [{ startLineNumber: 5, endLineNumber: 5 }], ranges);
	expect(out.lines).toEqual(['2 results - 2 files', '', 'b.ts:', '  3: z', '']);
	expect(out.ranges).toEqual([{ startLineNumber: 4, startColumn: 6, endLineNumber: 4, endColumn: 7 }]);
});

test('keys, names and file names', () => {
	expect(isSearchEditorKey('search-editor:1')).toBe(true);
	expect(isSearchEditorKey('dir/q.code-search')).toBe(true);
	expect(isSearchEditorKey('diff:q.code-search')).toBe(false);
	expect(searchEditorName('search-editor:1', '')).toBe('Search');
	expect(searchEditorName('search-editor:1', 'short')).toBe('Search: short');
	expect(searchEditorName('search-editor:1', 'a very long query')).toBe('Search: a very lo...');
	expect(searchEditorName('x/todo.code-search', 'q')).toBe('Search: todo');
	expect(suggestedSearchFileName('a/b: c')).toBe('a b c.code-search');
	expect(suggestedSearchFileName('  ')).toBe('Search.code-search');
	expect(modifyContextLines(0, false)).toBe(0);
	expect(modifyContextLines(1, true)).toBe(2);
});

test('a new editor: defaults, the prior editor (reusePriorSearchConfiguration), the context lines setting', () => {
	const prior = { query: 'old', isRegexp: true, filesToInclude: 'src', contextLines: 4 };
	expect(initialConfig({}, prior, false, 1)).toEqual({ ...defaultSearchConfig(), contextLines: 1 });
	expect(initialConfig({ query: 'q' }, prior, true, 1)).toMatchObject({ query: 'q', isRegexp: true, filesToInclude: 'src', contextLines: 1 });
	// null keeps the prior editor's count.
	expect(initialConfig({}, prior, true, null)).toMatchObject({ query: '', contextLines: 4 });
	expect(initialConfig({ contextLines: 0 }, null, false, 2).contextLines).toBe(0);
});

test('a Search Editor is dirty when its query or edited results differ from what it saved', () => {
	const config = { ...defaultSearchConfig(), query: 'foo' };
	const saved = serializeForDisk(config, 'a.ts:\n  1: foo {');
	expect(searchEditorDirty(saved, config, 'a.ts:\n  1: foo {')).toBe(false);
	// Typing in the results.
	expect(searchEditorDirty(saved, config, 'a.ts:\n  1: foo { bar')).toBe(true);
	// Changing the query.
	expect(searchEditorDirty(saved, { ...config, query: 'bar' }, 'a.ts:\n  1: foo {')).toBe(true);
	// A file read back from disk is clean.
	expect(searchEditorDirty(saved, parseSerializedSearchEditor(saved).config, parseSerializedSearchEditor(saved).text)).toBe(false);
});
