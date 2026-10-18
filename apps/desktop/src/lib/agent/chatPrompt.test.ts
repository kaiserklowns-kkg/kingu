/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
	assemblePrompt,
	CONTEXT_CLOSE,
	CONTEXT_OPEN,
	contextLabel,
	inlineContent,
	isFileKey,
	linesOf,
	MAX_INLINE_BYTES,
	parseRequest,
	promptPath,
	relativeTo,
	resolveContext,
	withoutImagesLine
} from './chatPrompt';

describe('prompt assembly', () => {
	test('no files: just the text', () => {
		expect(assemblePrompt('  hello  ', [])).toBe('hello');
	});

	test('files go in one delimited block: path, selected lines, content of small files', () => {
		const p = assemblePrompt('fix it', [
			{ path: 'src/a.ts', range: { startLine: 2, endLine: 4 }, content: 'b\nc\nd', implicit: true },
			{ path: 'big.json' },
			{ path: 'src/a.ts', range: { startLine: 2, endLine: 4 }, content: 'dup' }
		]);
		expect(p.startsWith('fix it\n\n<attached-context>\n')).toBe(true);
		expect(p.endsWith(CONTEXT_CLOSE)).toBe(true);
		expect(p).toContain('<file path="src/a.ts" lines="2-4">\nb\nc\nd\n</file>');
		expect(p).toContain('<file path="big.json" />');
		expect(p).not.toContain('dup');
	});

	test('the block parses back into the typed text and chips', () => {
		const p = assemblePrompt('why "this"?', [{ path: 'dir/q"x.ts', content: 'x' }, { path: 'b.ts', range: { startLine: 7, endLine: 7 } }]);
		expect(parseRequest(p)).toEqual({ text: 'why "this"?', files: [{ path: 'dir/q"x.ts' }, { path: 'b.ts', range: { startLine: 7, endLine: 7 } }], images: [] });
		expect(parseRequest(`${p}\n\n[แนบรูป: a.png, b.png]`).images).toEqual(['a.png', 'b.png']);
		expect(withoutImagesLine(`${p}\n\n[แนบรูป: a.png]`)).toBe(p);
		// A user typing the tag themselves is left alone unless it is the closing block.
		expect(parseRequest(`about ${CONTEXT_OPEN} tags`).text).toBe(`about ${CONTEXT_OPEN} tags`);
	});

	test('only files up to 32 KB are inlined', () => {
		expect(inlineContent('a'.repeat(MAX_INLINE_BYTES))).toBeDefined();
		expect(inlineContent('a'.repeat(MAX_INLINE_BYTES + 1))).toBeUndefined();
		// Thai is 3 bytes a character.
		expect(inlineContent('ก'.repeat(11_000))).toBeUndefined();
	});

	test('resolveContext reads workspace files, slices selections, references the rest', async () => {
		const files: Record<string, string> = { 'a.ts': 'l1\nl2\nl3\nl4', 'big.txt': 'x'.repeat(MAX_INLINE_BYTES + 10) };
		const read = async (rel: string) => {
			if (!(rel in files)) throw new Error('missing');
			return files[rel];
		};
		const out = await resolveContext(
			[{ path: 'a.ts', range: { startLine: 2, endLine: 3 }, implicit: true }, { path: 'big.txt' }, { path: '/abs/out.ts' }, { path: 'gone.ts' }],
			read,
			(rel) => promptPath(rel, '/root', false)
		);
		expect(out).toEqual([
			{ path: '/root/a.ts', range: { startLine: 2, endLine: 3 }, implicit: true, content: 'l2\nl3' },
			{ path: '/root/big.txt' },
			{ path: '/abs/out.ts' },
			{ path: '/root/gone.ts' }
		]);
	});

	test('helpers', () => {
		expect(linesOf('a\nb\nc', { startLine: 3, endLine: 3 })).toBe('c');
		expect(contextLabel({ path: 'src/x.ts', range: { startLine: 3, endLine: 9 } })).toBe('x.ts:3-9');
		expect(contextLabel({ path: 'src/x.ts', range: { startLine: 3, endLine: 3 } })).toBe('x.ts:3');
		expect(promptPath('src/x.ts', '/r', true)).toBe('src/x.ts');
		expect(relativeTo('/r', '/r/src/x.ts')).toBe('src/x.ts');
		expect(relativeTo('/r', '/other/x.ts')).toBe('/other/x.ts');
		expect(isFileKey('src/x.ts')).toBe(true);
		for (const k of ['diff:src/x.ts', 'preview:a.md', 'untitled:1', 'task://fix', null]) expect(isFileKey(k)).toBe(false);
	});
});
