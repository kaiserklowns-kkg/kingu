import { describe, expect, test } from 'bun:test';
import {
	basename,
	dirname,
	flattenResults,
	previewReplacement,
	rebaseMatches,
	replaceConfirmText,
	seedFromSelection,
	splitPreview,
	summarize,
	type FileMatches,
	type TextMatch
} from './searchResults';

const m = (line: number, preview: string, start: number, end: number): TextMatch => ({
	line,
	column: start + 1,
	end_column: end + 1,
	preview,
	preview_start: start,
	preview_end: end,
	text: preview.slice(start, end)
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

describe('replace', () => {
	/** A match at 1-based `line`/`column` with UTF-16 length `len`. */
	const at = (line: number, column: number, len: number): TextMatch => ({ line, column, end_column: column + len, preview: '', preview_start: 0, preview_end: 0, text: 'x'.repeat(len) });
	const pos = (ms: TextMatch[]) => ms.map((x) => [x.line, x.column, x.end_column]);

	test('later matches on the line shift by the length difference (UTF-16)', () => {
		// "foo foo foo" → replace the first with "ไทย🦀" (5 code units): +2.
		const rest = rebaseMatches([at(1, 5, 3), at(1, 9, 3), at(2, 1, 3)], [{ line: 1, column: 1, end_column: 4, text: 'ไทย🦀' }]);
		expect(pos(rest)).toEqual([
			[1, 7, 10],
			[1, 11, 14],
			[2, 1, 4]
		]);
	});

	test('earlier matches stay; several edits on one line add up', () => {
		const edits = [
			{ line: 1, column: 5, end_column: 8, text: '' },
			{ line: 1, column: 13, end_column: 16, text: 'abcdef' }
		];
		expect(pos(rebaseMatches([at(1, 1, 3), at(1, 9, 3), at(1, 17, 3)], edits))).toEqual([
			[1, 1, 4],
			[1, 6, 9],
			[1, 17, 20]
		]);
	});

	test('a replacement with line breaks moves what follows to new lines', () => {
		const edits = [{ line: 2, column: 3, end_column: 6, text: 'a\nbc' }];
		expect(pos(rebaseMatches([at(2, 8, 2), at(3, 1, 1), at(1, 4, 1)], edits))).toEqual([
			[3, 5, 7],
			[4, 1, 2],
			[1, 4, 5]
		]);
	});

	test('previews regex substitution like VS Code', () => {
		const re = { isRegex: true, matchCase: true, query: '(\\w+)=(\\d+)' };
		expect(previewReplacement('a=1', '$2=$1 $&', re)).toBe('1=a a=1');
		expect(previewReplacement('a=1', 'x\\ny', re)).toBe('x\ny');
		expect(previewReplacement('HELLO', '$1i', { isRegex: true, matchCase: false, query: '(h)ello' })).toBe('Hi');
		expect(previewReplacement('a=1', '$1', { ...re, isRegex: false })).toBe('$1');
		expect(previewReplacement('x', 'y', { ...re, query: '(' })).toBe('y');
	});

	test('confirmation text', () => {
		expect(replaceConfirmText(3, 2, 'bar')).toBe("Replace 3 occurrences across 2 files with 'bar'?");
		expect(replaceConfirmText(1, 1, '')).toBe('Replace 1 occurrence across 1 file with nothing (delete)?');
	});
});
