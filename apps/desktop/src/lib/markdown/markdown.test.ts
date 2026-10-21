/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { parseMarkdown } from './parse.ts';
import { slugify, Slugs } from './slugify.ts';
import { documentSymbols, foldingRanges, selectionRanges } from './symbols.ts';
import { FileIndex, globMatches, relativePath, resolveHref, validateDocument, type ValidateOptions } from './links.ts';
import { findReferences, linkEditsForMoves, pathInStyle, renameEdits, renameRange } from './references.ts';
import { completionContext, contextFile, contextFolder, folderEntries } from './completions.ts';
import { createsLinks, inCode, markdownForFiles, urlPaste } from './insertLinks.ts';

const doc = (...lines: string[]) => parseMarkdown(lines.join('\n'));

describe('slugify', () => {
	test('GitHub style', () => {
		expect(slugify('Hello World!')).toBe('hello-world');
		expect(slugify('`code` and **bold**')).toBe('code-and-bold');
		expect(slugify('[Link](x.md) text')).toBe('link-text');
		expect(slugify('ภาษาไทย ก่อน')).toBe('ภาษาไทย-ก่อน');
		expect(slugify('  C++ / Rust: 2.0 ')).toBe('c--rust-20');
	});
	test('duplicates get a counter', () => {
		const s = new Slugs();
		expect([s.next('A'), s.next('A'), s.next('A'), s.next('A-1')]).toEqual(['a', 'a-1', 'a-2', 'a-1-1']);
	});
});

describe('parseMarkdown', () => {
	test('ATX and setext headers, not in code or front matter', () => {
		const d = doc('---', 'title: x', '---', '# One #', '```', '# not', '```', 'Two', '===', 'para', 'Three', '---', '  ## Four  ', '#nope');
		expect(d.headers.map((h) => [h.level, h.text, h.slug, h.line])).toEqual([
			[1, 'One', 'one', 3],
			[1, 'Two', 'two', 7],
			[2, 'Three', 'three', 10],
			[2, 'Four', 'four', 12]
		]);
		expect(d.headers[0].textRange).toEqual({ start: { line: 3, character: 2 }, end: { line: 3, character: 5 } });
		expect(d.headers[3].textRange).toEqual({ start: { line: 12, character: 5 }, end: { line: 12, character: 9 } });
		expect(d.headers[1].range.end.line).toBe(8);
		expect(d.codeLines.has(5)).toBe(true);
	});

	test('inline, image, reference, definition and autolinks with exact ranges', () => {
		const d = doc('See [a](./a.md#x "t") and ![i](<img one.png>) [r][Ref] [Ref][] <https://x.y>', '', '[ref]: https://e.com', '`[no](code.md)` \\[no](esc.md) - [ ] task');
		const l = d.links;
		expect(l.map((x) => [x.kind, x.image, x.href, x.ref ?? null])).toEqual([
			['inline', false, './a.md#x', null],
			['inline', true, 'img one.png', null],
			['reference', false, '', 'ref'],
			['reference', false, '', 'ref'],
			['autolink', false, 'https://x.y', null],
			['definition', false, 'https://e.com', 'ref']
		]);
		const line0 = d.lines[0];
		const slice = (r: { start: { character: number }; end: { character: number } }) => line0.slice(r.start.character, r.end.character);
		expect(slice(l[0].hrefRange)).toBe('./a.md#x');
		expect(slice(l[0].range)).toBe('[a](./a.md#x "t")');
		expect(slice(l[1].hrefRange)).toBe('img one.png');
		expect(slice(l[2].hrefRange)).toBe('Ref');
		expect(d.definitions.get('ref')?.length).toBe(1);
	});

	test('images inside links, parentheses in paths, shortcut references only when defined', () => {
		const d = doc('[![alt](pic.png)](page.md) [x](a_(b).md) [undefined] [def]', '', '[def]: d.md');
		expect(d.links.map((x) => x.href || x.ref)).toEqual(['page.md', 'pic.png', 'a_(b).md', 'def', 'd.md']);
	});

	test('blocks: lists with items, quotes, tables, regions', () => {
		const d = doc('- a', '  more', '- b', '  - c', '', '> q', '> q2', '', '| a | b |', '|---|---|', '| 1 | 2 |', '<!-- #region x -->', 'text', '<!-- #endregion -->');
		const kinds = d.blocks.map((b) => `${b.kind}:${b.startLine}-${b.endLine}`);
		expect(kinds).toContain('list:0-3');
		expect(kinds).toContain('listItem:0-1');
		expect(kinds).toContain('listItem:2-3');
		expect(kinds).toContain('list:3-3');
		expect(kinds).toContain('quote:5-6');
		expect(kinds).toContain('table:8-10');
		expect(kinds).toContain('region:11-13');
	});
});

describe('symbols, folding, smart select', () => {
	const d = doc('# A', 'text', '## B', '- x', '  y', '', '## C', '```', 'code', 'more', '```', '# D');
	test('document symbols nest by level and span sections', () => {
		const s = documentSymbols(d);
		expect(s.map((x) => x.name)).toEqual(['# A', '# D']);
		expect(s[0].children.map((x) => [x.name, x.range.start.line, x.range.end.line])).toEqual([
			['## B', 2, 4],
			['## C', 6, 10]
		]);
		expect(s[0].range.end.line).toBe(10);
	});
	test('folding: sections, list items, code without its closing fence', () => {
		const f = foldingRanges(d).map((x) => `${x.start}-${x.end}`);
		expect(f).toEqual(['0-10', '2-4', '3-4', '6-10', '7-9']);
	});
	test('smart select grows outward', () => {
		const r = selectionRanges(d, { line: 8, character: 1 }).map((x) => `${x.start.line}:${x.start.character}-${x.end.line}:${x.end.character}`);
		expect(r).toEqual(['8:0-8:4', '8:0-9:4', '7:0-10:3', '6:0-10:3', '1:0-10:3', '0:0-10:3', '0:0-11:3']);
		const onLink = selectionRanges(doc('a [x](y.md) b'), { line: 0, character: 7 }).map((x) => `${x.start.character}-${x.end.character}`);
		expect(onLink.slice(0, 3)).toEqual(['6-10', '2-11', '0-13']);
	});
});

describe('link resolution and validation', () => {
	const index = new FileIndex(['README.md', 'docs/a.md', 'docs/img/p.png', 'docs/sub/b.md', 'docs/with space.md']);
	test('resolveHref', () => {
		expect(resolveHref('https://x', 'docs/a.md', index)).toEqual({ kind: 'external', url: 'https://x' });
		expect(resolveHref('#Intro', 'docs/a.md', index)).toEqual({ kind: 'fragment', fragment: 'Intro' });
		expect(resolveHref('sub/b', 'docs/a.md', index)).toMatchObject({ kind: 'file', rel: 'docs/sub/b.md', exists: true });
		expect(resolveHref('../README.md#top', 'docs/a.md', index)).toMatchObject({ rel: 'README.md', fragment: 'top', exists: true });
		expect(resolveHref('/docs/img/p.png', 'docs/sub/b.md', index)).toMatchObject({ rel: 'docs/img/p.png', exists: true });
		expect(resolveHref('with%20space.md', 'docs/a.md', index)).toMatchObject({ rel: 'docs/with space.md', exists: true });
		expect(resolveHref('img', 'docs/a.md', index)).toMatchObject({ dir: true, exists: true });
		expect(resolveHref('../../x.md', 'docs/a.md', index)).toBeNull();
		expect(resolveHref('nope.md', 'docs/a.md', index)).toMatchObject({ exists: false });
	});
	test('relativePath', () => {
		expect(relativePath('docs/sub', 'docs/img/p.png')).toBe('../img/p.png');
		expect(relativePath('', 'docs/a.md')).toBe('docs/a.md');
		expect(relativePath('docs', 'docs/a.md')).toBe('a.md');
	});
	test('globs', () => {
		expect(globMatches('/assets/**/*.svg', '/assets/a/b/c.svg')).toBe(true);
		expect(globMatches('/assets/**/*.svg', '/assets/c.svg')).toBe(true);
		expect(globMatches('/about', '/about')).toBe(true);
		expect(globMatches('*.md', 'a/b.md')).toBe(false);
	});
	const opts: ValidateOptions = { referenceLinks: 'warning', fragmentLinks: 'warning', fileLinks: 'error', markdownFragmentLinks: 'warning', unusedLinkDefinitions: 'hint', duplicateLinkDefinitions: 'warning', ignoredLinks: ['/ignored/**'] };
	test('validateDocument reports each kind', async () => {
		const d = doc('# Top', '[ok](#top) [bad](#nope) [f](missing.md) [g](sub/b.md#there) [h](sub/b.md#nothere) [r][none] [i](/ignored/x.md) [L](#L10)', '', '[u]: a.md', '[dup]: a.md', '[dup]: sub/b.md', '[k][dup]');
		const other = doc('# There');
		const diags = await validateDocument(d, 'docs/a.md', index, opts, async (rel) => (rel === 'docs/sub/b.md' ? other : null));
		expect(diags.map((x) => [x.message, x.level, JSON.stringify(x.params)])).toEqual([
			['noSuchHeader', 'warning', '{"fragment":"nope"}'],
			['noSuchFile', 'error', '{"path":"missing.md"}'],
			['noSuchHeaderInFile', 'warning', '{"fragment":"nothere","path":"sub/b.md"}'],
			['noSuchReference', 'warning', '{"ref":"none"}'],
			['unusedDefinition', 'hint', '{"ref":"u"}'],
			['duplicateDefinition', 'warning', '{"ref":"dup"}'],
			['duplicateDefinition', 'warning', '{"ref":"dup"}']
		]);
		const line = d.lines[1];
		expect(line.slice(diags[0].range.start.character, diags[0].range.end.character)).toBe('nope');
		expect(line.slice(diags[1].range.start.character, diags[1].range.end.character)).toBe('missing.md');
		const off = await validateDocument(d, 'docs/a.md', index, { ...opts, fileLinks: 'ignore', fragmentLinks: 'ignore', markdownFragmentLinks: 'ignore', referenceLinks: 'ignore', unusedLinkDefinitions: 'ignore', duplicateLinkDefinitions: 'ignore' }, async () => null);
		expect(off).toEqual([]);
	});
});

describe('references and rename', () => {
	const index = new FileIndex(['a.md', 'dir/b.md', 'img.png']);
	const docs = new Map([
		['a.md', doc('# Getting Started', 'see [here](#getting-started) and [img](img.png) [web](https://x.io)')],
		['dir/b.md', doc('[a](../a.md#getting-started) [a2](../a#Getting-Started) [file](../a.md) ![p](../img.png) [w](https://x.io)', '[d]: ../a.md#getting-started')]
	]);
	test('references to a header from its line and from a link fragment', () => {
		const refs = findReferences(docs, index, 'a.md', { line: 0, character: 3 });
		expect(refs.map((r) => `${r.rel}:${r.range.start.line}:${r.range.start.character}`)).toEqual(['a.md:0:0', 'a.md:1:12', 'dir/b.md:0:12', 'dir/b.md:0:39', 'dir/b.md:1:13']);
		const fromLink = findReferences(docs, index, 'dir/b.md', { line: 0, character: 15 }, false);
		expect(fromLink.length).toBe(4);
	});
	test('references to files and external links', () => {
		expect(findReferences(docs, index, 'a.md', { line: 1, character: 40 }).map((r) => r.rel)).toEqual(['a.md', 'dir/b.md']);
		expect(findReferences(docs, index, 'a.md', { line: 1, character: 55 }).map((r) => r.rel)).toEqual(['a.md', 'dir/b.md']);
		const b = docs.get('dir/b.md')!.lines[0];
		expect(findReferences(docs, index, 'dir/b.md', { line: 0, character: b.indexOf('[file]') + 8 }).length).toBe(4);
		expect(findReferences(docs, index, 'dir/b.md', { line: 0, character: b.indexOf('https') + 2 }).map((r) => r.rel)).toEqual(['a.md', 'dir/b.md']);
	});
	test('rename a header updates every link fragment', () => {
		expect(renameRange(docs, index, 'a.md', { line: 0, character: 4 })).toEqual({ range: { start: { line: 0, character: 2 }, end: { line: 0, character: 17 } }, text: 'Getting Started' });
		const edits = renameEdits(docs, index, 'a.md', { line: 0, character: 4 }, 'Quick Start')!;
		expect(edits.get('a.md')?.map((e) => e.newText)).toEqual(['Quick Start', 'quick-start']);
		expect(edits.get('dir/b.md')?.map((e) => e.newText)).toEqual(['quick-start', 'quick-start', 'quick-start']);
		const viaLink = renameEdits(docs, index, 'dir/b.md', { line: 0, character: 20 }, 'New')!;
		expect(viaLink.get('a.md')?.[0]).toEqual({ range: { start: { line: 0, character: 2 }, end: { line: 0, character: 17 } }, newText: 'New' });
	});
	test('rename an external link everywhere', () => {
		const e = renameEdits(docs, index, 'a.md', { line: 1, character: 60 }, 'https://y.io')!;
		expect([...e.keys()]).toEqual(['a.md', 'dir/b.md']);
	});
});

describe('link updates on move', () => {
	const before = new FileIndex(['a.md', 'docs/b.md', 'docs/img/p.png', 'c.md']);
	const docs = new Map([
		['a.md', doc('[b](docs/b.md) [b2](./docs/b#x) [p](/docs/img/p.png) [c](c.md) [w](https://x)')],
		['docs/b.md', doc('[a](../a.md) ![p](img/p.png) [c](/c.md)')]
	]);
	test('a file rename', () => {
		const e = linkEditsForMoves(docs, before, [{ from: 'docs/b.md', to: 'guide/b c.md' }]);
		expect(e.get('a.md')?.map((x) => x.newText)).toEqual(['guide/b%20c.md', './guide/b%20c']);
		// The moved document's own relative links follow it (`../a.md` still resolves); root-relative ones still work.
		expect(e.get('guide/b c.md')?.map((x) => x.newText)).toEqual(['../docs/img/p.png']);
	});
	test('a folder move', () => {
		const e = linkEditsForMoves(docs, before, [{ from: 'docs', to: 'manual' }]);
		expect(e.get('a.md')?.map((x) => x.newText)).toEqual(['manual/b.md', './manual/b', '/manual/img/p.png']);
		expect(e.get('manual/b.md')).toBeUndefined();
	});
	test('pathInStyle', () => {
		expect(pathInStyle('/x/a.md', 'q/r.md', 'y/a.md')).toBe('/y/a.md');
		expect(pathInStyle('./a.md', 'r.md', 'b.md')).toBe('./b.md');
		expect(pathInStyle('a', 'r.md', 'z/b.md')).toBe('z/b');
	});
});

describe('completions', () => {
	test('contexts', () => {
		expect(completionContext('see [x](docs/im')).toEqual({ kind: 'path', dir: 'docs/', root: false, typed: 'im', from: 13 });
		expect(completionContext('[x](/')).toMatchObject({ kind: 'path', dir: '/', root: true, typed: '' });
		expect(completionContext('[x](#int')).toEqual({ kind: 'header', from: 5, typed: 'int', workspace: false });
		expect(completionContext('[x](#', 'onSingleOrDoubleHash')).toMatchObject({ kind: 'header', workspace: true });
		expect(completionContext('[x](##gs')).toEqual({ kind: 'workspaceHeader', from: 4, typed: 'gs' });
		expect(completionContext('[x](##', 'never')).toBeNull();
		expect(completionContext('[x](a.md#')).toMatchObject({ kind: 'fileHeader', path: 'a.md', from: 9 });
		expect(completionContext('[x][re')).toEqual({ kind: 'reference', from: 4, typed: 're' });
		expect(completionContext('[ref]: ./d')).toMatchObject({ kind: 'path', dir: './', typed: 'd' });
		expect(completionContext('<img src="ima')).toMatchObject({ kind: 'path', typed: 'ima' });
		expect(completionContext('[x](https://a')).toBeNull();
		expect(completionContext('plain text')).toBeNull();
	});
	test('folders and files', () => {
		const index = new FileIndex(['a.md', 'docs/b.md', 'docs/sub/c.png']);
		expect(folderEntries(index, 'docs')).toEqual([
			{ name: 'sub', dir: true },
			{ name: 'b.md', dir: false }
		]);
		expect(contextFolder({ dir: '../', root: false }, 'docs/b.md')).toBe('');
		expect(contextFolder({ dir: '../../', root: false }, 'docs/b.md')).toBeNull();
		expect(contextFile({ path: '../a', root: false }, 'docs/b.md', index)).toBe('a.md');
		expect(contextFile({ path: '', root: false }, 'docs/b.md', index)).toBe('docs/b.md');
	});
});

describe('drop and paste', () => {
	test('files become links relative to the document', () => {
		expect(markdownForFiles([{ rel: 'docs/img/a b.png' }, { rel: 'notes.md' }, { rel: 'docs/v.mp4' }], 'docs/x.md')).toBe('![a b](img/a%20b.png) [notes](../notes.md) <video controls src="v.mp4" title="v"></video>');
		expect(markdownForFiles([{ abs: '/tmp/x y.pdf' }], 'a.md')).toBe('[x y](file:///tmp/x%20y.pdf)');
	});
	test('smart modes and code', () => {
		const d = doc('```', 'code', '```', 'text `open');
		expect(inCode(d, 1, '')).toBe(true);
		expect(inCode(d, 3, 'text `open')).toBe(true);
		expect(inCode(d, 3, 'text ')).toBe(false);
		expect(createsLinks('smart', true)).toBe(false);
		expect(createsLinks('always', true)).toBe(true);
		expect(createsLinks('never', false)).toBe(false);
	});
	test('URL paste', () => {
		expect(urlPaste('https://x.io/a', 'text', 'smartWithSelection', false)).toBe('[text](https://x.io/a)');
		expect(urlPaste('https://x.io/a', '', 'smartWithSelection', false)).toBeNull();
		expect(urlPaste('https://x.io/a', '', 'smart', false)).toBe('[https://x.io/a](https://x.io/a)');
		expect(urlPaste('https://x.io/a', 'sel', 'smart', true)).toBeNull();
		expect(urlPaste('not a url', 'sel', 'always', false)).toBeNull();
		expect(urlPaste('https://x.io/(a)', 'w', 'always', false)).toBe('[w](https://x.io/%28a%29)');
	});
});
