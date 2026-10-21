/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { compareKey, compareLabel, isCompareKey, parseCompareKey } from './compare';
import { editorKind } from './editorKind';
import { fileOf, isDiffKey } from './scm';

const WORDS = { saved: 'Saved', clipboard: 'Clipboard' };

describe('compare editors', () => {
	test('keys round-trip paths with slashes, spaces and schemes', () => {
		const key = compareKey({ kind: 'resource', key: 'src/a b.ts' }, 'external:/tmp/x/b.ts');
		expect(isCompareKey(key)).toBe(true);
		expect(parseCompareKey(key)).toEqual({ left: { kind: 'resource', key: 'src/a b.ts' }, right: 'external:/tmp/x/b.ts' });
		expect(parseCompareKey(compareKey({ kind: 'saved', key: 'a.ts' }, 'a.ts'))).toEqual({ left: { kind: 'saved', key: 'a.ts' }, right: 'a.ts' });
		expect(parseCompareKey(compareKey({ kind: 'clipboard', id: '3' }, 'a.ts'))).toEqual({ left: { kind: 'clipboard', id: '3' }, right: 'a.ts' });
		expect(parseCompareKey('compare://a')).toBeNull();
		expect(parseCompareKey('compare://a/b/c')).toBeNull();
		expect(parseCompareKey('compare://a/clipboard%3A1')).toBeNull();
	});

	test("labels like VS Code's", () => {
		expect(compareLabel({ kind: 'resource', key: 'src/a.ts' }, 'lib/b.ts', WORDS)).toBe('a.ts ↔ b.ts');
		expect(compareLabel({ kind: 'saved', key: 'src/a.ts' }, 'src/a.ts', WORDS)).toBe('a.ts (Saved) ↔ a.ts');
		expect(compareLabel({ kind: 'clipboard', id: '1' }, 'external:/tmp/c.md', WORDS)).toBe('Clipboard ↔ c.md');
	});

	test('is a diff of the right-hand file', () => {
		const key = compareKey({ kind: 'resource', key: 'a.ts' }, 'src/b.ts');
		expect(isDiffKey(key)).toBe(true);
		expect(fileOf(key)).toBe('src/b.ts');
		expect(editorKind(key)).toBe('file');
	});
});
