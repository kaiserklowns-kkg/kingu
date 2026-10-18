import { describe, expect, test } from 'bun:test';
import { cellText, cleanPath, detectLinks, linkHint, linkModifierDown, MAX_LINE, type FileLink } from './links.ts';

const files = (line: string) => detectLinks(line).filter((l): l is FileLink => l.kind === 'file');
const one = (line: string) => {
	const [l] = detectLinks(line);
	return l && { ...l, text: line.slice(l.start, l.end) };
};

describe('web links', () => {
	test('http and https URLs, trailing punctuation trimmed', () => {
		expect(one('see https://example.com/a?b=1.')).toMatchObject({ kind: 'url', url: 'https://example.com/a?b=1', text: 'https://example.com/a?b=1' });
		expect(one('(http://localhost:5173/)')).toMatchObject({ url: 'http://localhost:5173/' });
		expect(one('https://en.wikipedia.org/wiki/Foo_(bar) done')).toMatchObject({ url: 'https://en.wikipedia.org/wiki/Foo_(bar)' });
		expect(one('"https://kingu.dev/ไทย"')).toMatchObject({ url: 'https://kingu.dev/ไทย' });
		expect(detectLinks('xhttps://nope.com').filter((l) => l.kind === 'url')).toEqual([]);
		expect(detectLinks('ftp://host/x javascript:alert(1)').filter((l) => l.kind === 'url')).toEqual([]);
	});
});

describe('file links', () => {
	test('path, path:line, path:line:col', () => {
		expect(one('src/main.rs')).toEqual({ kind: 'file', start: 0, end: 11, path: 'src/main.rs', text: 'src/main.rs' });
		expect(one('src/main.rs:12')).toMatchObject({ path: 'src/main.rs', line: 12, text: 'src/main.rs:12' });
		expect(files('src/main.rs:12')[0]?.column).toBeUndefined();
		expect(one('  --> src/lib.rs:40:9')).toMatchObject({ path: 'src/lib.rs', line: 40, column: 9, text: 'src/lib.rs:40:9' });
		expect(one('main.go:7:2: undefined: x')).toMatchObject({ path: 'main.go', line: 7, column: 2 });
		expect(one('/Users/me/app/a.ts:3')).toMatchObject({ path: '/Users/me/app/a.ts', line: 3 });
		expect(one('./a.ts')).toMatchObject({ path: './a.ts' });
		expect(one('~/notes/x.md')).toMatchObject({ path: '~/notes/x.md' });
	});

	test("VS Code's other suffixes", () => {
		expect(one('a/b.ts(12,5): error TS2304')).toMatchObject({ path: 'a/b.ts', line: 12, column: 5 });
		expect(one('a/b.ts (12, 5)')).toMatchObject({ path: 'a/b.ts', line: 12, column: 5 });
		expect(one('  File "app/main.py", line 33, in <module>')).toMatchObject({ path: 'app/main.py', line: 33 });
		expect(one('a.c:10.4')).toMatchObject({ path: 'a.c', line: 10, column: 4 });
		expect(one('x.ts#42')).toMatchObject({ path: 'x.ts', line: 42 });
	});

	test('Thai paths', () => {
		expect(one('เอกสาร/บันทึก.md:3:1')).toMatchObject({ path: 'เอกสาร/บันทึก.md', line: 3, column: 1, text: 'เอกสาร/บันทึก.md:3:1' });
		expect(files('แก้ไข src/งาน/หน้าแรก.svelte')).toMatchObject([{ path: 'src/งาน/หน้าแรก.svelte' }]);
	});

	test('bare file names (Orca)', () => {
		expect(files('modified: package.json and README')).toMatchObject([{ path: 'package.json' }, { path: 'README' }]);
		// Dotted numbers are no file names; `took 5` is VS Code's `file 5` suffix form, a candidate Rust then rejects.
		expect(files('version 1.2.3 took 5 ms').filter((l) => l.line === undefined)).toEqual([]);
	});

	test('git diff prefixes and file URIs', () => {
		expect(files('+++ b/src/app.ts')[0]).toMatchObject({ path: 'src/app.ts' });
		expect(files('diff --git a/x/y.rs b/x/y.rs').map((l) => l.path)).toEqual(['x/y.rs', 'x/y.rs']);
		expect(files('cat b/src/app.ts')[0]).toMatchObject({ path: 'b/src/app.ts' });
		expect(files('file:///tmp/%E0%B8%81.txt')[0]).toMatchObject({ path: '/tmp/ก.txt' });
	});

	test('quotes and trailing punctuation are not part of the path', () => {
		expect(one("'src/a.ts'")).toMatchObject({ path: 'src/a.ts', text: 'src/a.ts' });
		expect(one('see src/a.ts.')).toMatchObject({ path: 'src/a.ts', text: 'src/a.ts' });
		expect(cleanPath('"x/y"')).toEqual({ path: 'x/y', offset: 1 });
		expect(cleanPath('123').path).toBe('');
	});

	test('URLs win over paths inside them; long lines are skipped; at most 10 per line', () => {
		expect(detectLinks('https://a.com/src/x.ts:3')).toHaveLength(1);
		expect(detectLinks('a/b '.repeat(MAX_LINE))).toEqual([]);
		expect(detectLinks(Array.from({ length: 20 }, (_, i) => `d/f${i}.ts`).join(' '))).toHaveLength(10);
	});
});

test('cell positions with Thai combining marks and wide characters', () => {
	// "ที่" = ท + ี + ่ in one cell; "日" takes two cells (the second is empty).
	const { text, cellAt } = cellText(['ที่', 'a', '日', '', '/', 'x']);
	expect(text).toBe('ที่a日/x');
	expect(cellAt).toEqual([0, 0, 0, 1, 2, 4, 5]);
});

test('link hint and modifier follow VS Code', () => {
	expect(linkHint('url', true, false)).toBe('Follow link (cmd + click)');
	expect(linkHint('file', false, true)).toBe('Open file in editor (alt + click)');
	const e = { metaKey: true, ctrlKey: false, altKey: false };
	expect(linkModifierDown(e, true, false)).toBe(true);
	expect(linkModifierDown(e, false, false)).toBe(false);
	expect(linkModifierDown({ ...e, altKey: true }, true, true)).toBe(true);
});
