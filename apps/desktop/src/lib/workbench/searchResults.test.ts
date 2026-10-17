import { describe, expect, test } from 'bun:test';
import { basename, dirname, flattenResults, seedFromSelection, splitPreview, summarize, type FileMatches, type TextMatch } from './searchResults';

const m = (line: number, preview: string, start: number, end: number): TextMatch => ({
	line,
	column: start + 1,
	end_column: end + 1,
	preview,
	preview_start: start,
	preview_end: end
});

const files: FileMatches[] = [
	{ path: 'src/a.ts', matches: [m(1, 'const foo = 1', 6, 9), m(4, 'foo()', 0, 3)] },
	{ path: 'b.md', matches: [m(2, 'a foo', 2, 5)] }
];

describe('flattenResults', () => {
	test('lists each file followed by its matches', () => {
		const rows = flattenResults(files, new Set());
		expect(rows.map((r) => r.kind)).toEqual(['file', 'match', 'match', 'file', 'match']);
		expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
	});

	test('hides the matches of collapsed files', () => {
		const rows = flattenResults(files, new Set(['src/a.ts']));
		expect(rows.map((r) => r.kind)).toEqual(['file', 'file', 'match']);
		expect(rows[0]).toMatchObject({ kind: 'file', collapsed: true });
	});
});

describe('summarize', () => {
	test('pluralizes like VS Code', () => {
		expect(summarize(1, 1)).toBe('1 result in 1 file');
		expect(summarize(3, 2)).toBe('3 results in 2 files');
	});
});

describe('splitPreview', () => {
	test('splits on UTF-16 offsets', () => {
		// "𝄞" is two UTF-16 units, as Rust counts them.
		expect(splitPreview(m(1, '𝄞 hello!', 3, 8))).toEqual({ before: '𝄞 ', match: 'hello', after: '!' });
	});
});

describe('paths and seeding', () => {
	test('splits workspace-relative paths', () => {
		expect(basename('src/lib/a.ts')).toBe('a.ts');
		expect(dirname('src/lib/a.ts')).toBe('src/lib');
		expect(dirname('a.ts')).toBe('');
	});

	test('seeds only from a single-line selection', () => {
		expect(seedFromSelection('foo')).toBe('foo');
		expect(seedFromSelection('a\nb')).toBeNull();
		expect(seedFromSelection('')).toBeNull();
	});
});
