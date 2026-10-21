/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { DEFAULT_PREVIEW_OPTIONS, mayHaveMath, renderPreview, typographer } from './previewRender.ts';
import { blockIndexForLine, lineForScrollTop, normalizeBlocks, scrollTopForLine } from './previewScroll.ts';
import { followRemap, imageRel, linkTarget, resolvePath } from './previewModel.ts';

const opts = (o: Partial<typeof DEFAULT_PREVIEW_OPTIONS> = {}) => ({ ...DEFAULT_PREVIEW_OPTIONS, ...o });
const lines = (html: string) => [...html.matchAll(/<(\w+) data-line="(\d+)"/g)].map((m) => `${m[1]}:${m[2]}`);

describe('renderPreview', () => {
	test('source lines on top-level blocks and list items, nested ones too', () => {
		const src = '# Title\n\nPara one\nstill para\n\n- a\n- b\n  - c\n\n> quote\n\n```js\nx\n```\n\n| a |\n| - |\n| 1 |\n';
		expect(lines(renderPreview(src))).toEqual(['h1:0', 'p:2', 'ul:5', 'li:5', 'li:6', 'li:7', 'blockquote:9', 'pre:11', 'table:15']);
	});

	test('CRLF and link definitions do not shift lines', () => {
		expect(lines(renderPreview('[a]: http://x\r\n\r\ntext [a]\r\n'))).toEqual(['p:2']);
	});

	test('heading ids are GitHub slugs, repeated ones numbered', () => {
		const html = renderPreview('# Hello *World*\n\n## Hello World\n\n## ภาษาไทย ครับ');
		expect(html).toContain('<h1 data-line="0" id="hello-world">');
		expect(html).toContain('id="hello-world-1"');
		expect(html).toContain('id="ภาษาไทย-ครับ"');
	});

	test('raw HTML is escaped; images and links keep their URL in data attributes', () => {
		const html = renderPreview('<script>alert(1)</script>\n\n![logo](img/a%20b.png "t") [x](javascript:alert(1))');
		expect(html).not.toContain('<script');
		expect(html).toContain('&lt;script&gt;');
		expect(html).toContain('<img class="md-image" alt="logo" data-src="img/a%20b.png" title="t">');
		expect(html).toContain('data-href="javascript:alert(1)"');
		expect(html).not.toMatch(/ (href|src)=/);
	});

	test('breaks', () => {
		expect(renderPreview('a\nb', opts({ breaks: true }))).toContain('a<br>b');
		expect(renderPreview('a\nb', opts({ breaks: false }))).not.toContain('<br>');
	});

	test('linkify off keeps bare URLs as text, <autolinks> stay links', () => {
		const on = renderPreview('see www.x.com and <https://y.z>');
		expect(on).toContain('data-href="http://www.x.com"');
		const off = renderPreview('see www.x.com and <https://y.z>', opts({ linkify: false }));
		expect(off).not.toContain('www.x.com"');
		expect(off).toContain('see www.x.com and');
		expect(off).toContain('data-href="https://y.z"');
	});

	test('typographer rewrites text, not code', () => {
		const html = renderPreview('"Hi" -- it\'s (c)... `"code" --`', opts({ typographer: true }));
		expect(html).toContain('“Hi” – it’s ©…');
		expect(html).toContain('<code>&quot;code&quot; --</code>');
		expect(renderPreview('"Hi"')).toContain('&quot;Hi&quot;');
	});

	test('math: KaTeX when loaded, code otherwise, plain text when disabled', () => {
		const src = 'Inline $x^2$ costs $5 and $6.\n\n$$\n\\sum_i i\n$$\n';
		const fake = (tex: string, display: boolean) => `[${display ? 'D' : 'I'}:${tex}]`;
		const html = renderPreview(src, opts(), fake);
		expect(html).toContain('[I:x^2]');
		expect(html).toContain('costs $5 and $6.');
		expect(html).toContain('<div data-line="2" class="md-math-block">[D:\\sum_i i]</div>');
		expect(renderPreview(src)).toContain('<code class="md-math">x^2</code>');
		expect(renderPreview(src, opts({ math: false }), fake)).not.toContain('[I:');
		expect(mayHaveMath(src)).toBe(true);
		expect(mayHaveMath('costs 5 dollars')).toBe(false);
	});
});

describe('typographer', () => {
	test('quotes open after space or start, close otherwise', () => {
		expect(typographer('"a" \'b\' don\'t')).toBe('“a” ‘b’ don’t');
		expect(typographer('" end', 'x')).toBe('” end');
		expect(typographer('a---b (tm) (r) +-')).toBe('a—b ™ ® ±');
	});
});

describe('scroll sync', () => {
	const blocks = normalizeBlocks([
		{ line: 0, top: 0 },
		{ line: 4, top: 100 },
		{ line: 4, top: 120 },
		{ line: 10, top: 400 }
	]);
	test('normalize keeps the first block of a line', () => {
		expect(blocks).toEqual([
			{ line: 0, top: 0 },
			{ line: 4, top: 100 },
			{ line: 10, top: 400 }
		]);
	});
	test('line ↔ scroll top interpolate between blocks and invert', () => {
		expect(scrollTopForLine(blocks, 2)).toBe(50);
		expect(scrollTopForLine(blocks, 7)).toBe(250);
		expect(scrollTopForLine(blocks, 50)).toBe(400);
		expect(lineForScrollTop(blocks, 50)).toBe(2);
		expect(lineForScrollTop(blocks, 250)).toBe(7);
		expect(lineForScrollTop(blocks, 999)).toBe(10);
		expect(scrollTopForLine([], 3)).toBe(0);
	});
	test('the block holding a line', () => {
		expect(blockIndexForLine([0, 5, 6, 9], 7)).toBe(2);
		expect(blockIndexForLine([2, 5], 0)).toBe(-1);
		// A list and its first item start on one line: the item (later, inner) wins.
		expect(blockIndexForLine([0, 5, 5], 5)).toBe(2);
	});
});

describe('links and images', () => {
	test('resolvePath stays inside the root', () => {
		expect(resolvePath('docs/a.md', './b.md')).toBe('docs/b.md');
		expect(resolvePath('docs/a.md', '../README.md')).toBe('README.md');
		expect(resolvePath('docs/a.md', '/src/x.ts')).toBe('src/x.ts');
		expect(resolvePath('docs/a.md', '../../etc/passwd')).toBeNull();
		expect(resolvePath('/other/root/a.md', '/x.md')).toBeNull();
		expect(resolvePath('/other/root/a.md', '/x.md', '/other/root')).toBe('/other/root/x.md');
		expect(resolvePath('/other/root/a.md', '../../x', '/other/root')).toBeNull();
	});

	test('linkTarget', () => {
		expect(linkTarget('a.md', '#Some%20Header')).toEqual({ kind: 'fragment', fragment: 'Some Header' });
		expect(linkTarget('d/a.md', 'b%20c.md#x')).toEqual({ kind: 'file', rel: 'd/b c.md', fragment: 'x' });
		expect(linkTarget('a.md', 'http://localhost:5173/x')).toEqual({ kind: 'local', url: 'http://localhost:5173/x' });
		expect(linkTarget('a.md', 'https://example.com')).toEqual({ kind: 'external', url: 'https://example.com' });
		expect(linkTarget('a.md', 'mailto:a@b.c').kind).toBe('external');
		expect(linkTarget('a.md', 'javascript:alert(1)').kind).toBe('blocked');
		expect(linkTarget('a.md', 'file:///etc/passwd').kind).toBe('blocked');
		expect(linkTarget('a.md', '//evil.com/x').kind).toBe('blocked');
		expect(linkTarget('a.md', '../x.md').kind).toBe('blocked');
	});

	test('imageRel loads workspace images only', () => {
		expect(imageRel('docs/a.md', 'img/x.png')).toBe('docs/img/x.png');
		expect(imageRel('docs/a.md', '../img/x%20y.png?v=1')).toBe('img/x y.png');
		expect(imageRel('docs/a.md', 'https://x/y.png')).toBeNull();
		expect(imageRel('docs/a.md', 'data:image/png;base64,AAA')).toBeNull();
		expect(imageRel('a.md', '../../x.png')).toBeNull();
	});
});

describe('followRemap', () => {
	const md = (p: string) => p.endsWith('.md');
	test('unlocked Markdown previews in other groups follow the active Markdown editor', () => {
		const shown = [
			{ group: 1, key: 'b.md' },
			{ group: 2, key: 'preview:a.md' },
			{ group: 3, key: 'preview:c.md' },
			{ group: 4, key: 'preview:t.csv' }
		];
		expect([...followRemap(shown, 1, 'b.md', new Set(['preview:c.md']), 'preview:', md)]).toEqual([['preview:a.md', 'preview:b.md']]);
		expect(followRemap(shown, 1, 'x.ts', new Set(), 'preview:', md).size).toBe(0);
		expect(followRemap([{ group: 1, key: 'preview:a.md' }], 1, 'b.md', new Set(), 'preview:', md).size).toBe(0);
	});
});
