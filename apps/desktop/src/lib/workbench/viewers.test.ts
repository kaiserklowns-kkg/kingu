import { describe, expect, test } from 'bun:test';
import { isImagePath, isMarkdownPath, isPreviewKey, previewKey, previewTarget } from './viewers';
import { renderMarkdown } from './markdown';

describe('viewers', () => {
	test('image and markdown paths', () => {
		expect(isImagePath('docs/logo.PNG')).toBe(true);
		expect(isImagePath('a.svg')).toBe(true);
		expect(isImagePath('png')).toBe(false);
		expect(isImagePath('diff:a.png')).toBe(false);
		expect(isImagePath('src.png/readme')).toBe(false);
		expect(isMarkdownPath('README.md')).toBe(true);
		expect(isMarkdownPath('preview:README.md')).toBe(false);
	});

	test('preview keys round-trip', () => {
		expect(isPreviewKey(previewKey('docs/a.md'))).toBe(true);
		expect(previewTarget(previewKey('docs/a.md'))).toBe('docs/a.md');
	});

	test('markdown renders, raw html and images stay inert', () => {
		const html = renderMarkdown('# Title\n\n<script>alert(1)</script>\n\n![logo](https://x/y.png) [docs](https://example.com)\n\n- [x] done');
		expect(html).toContain('<h1>Title</h1>');
		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;script&gt;');
		expect(html).not.toContain('<img');
		expect(html).toContain('data-href="https://example.com"');
		expect(html).not.toContain(' href=');
		expect(html).toContain('type="checkbox"');
	});
});
