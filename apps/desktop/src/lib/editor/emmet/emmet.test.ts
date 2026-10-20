import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { abbreviationAt, emmetSyntax, expandAbbreviation, isAbbreviationValid, isExpansionNoise, isValidLocation, NO_EMMET_SETTINGS, snippetPreview, splitFilters } from './emmetConfig.ts';
import { balanceIn, balanceOut, elementAt, markupItems, matchingTag, mergeLines, parseMarkup, removeTag, splitJoinTag, stepItem, toggleMarkupComment, updateTag, type TextEdit } from './markup.ts';
import { addToNumber, cssItems, editPoint, evaluate, formatResult, mathExpressionBefore, numberAt, toggleCssComment } from './textActions.ts';

const S = NO_EMMET_SETTINGS;
const apply = (text: string, edits: TextEdit[]) => [...edits].sort((a, b) => b.start - a.start).reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text);

describe('emmet syntax and settings', () => {
	test('languages map to emmet syntaxes', () => {
		expect(emmetSyntax('html', S)).toBe('html');
		expect(emmetSyntax('typescriptreact', S)).toBe('jsx');
		expect(emmetSyntax('javascriptreact', S)).toBe('jsx');
		expect(emmetSyntax('scss', S)).toBe('scss');
		expect(emmetSyntax('php', S)).toBe('html');
		expect(emmetSyntax('pug', S)).toBe('pug');
		expect(emmetSyntax('typescript', S)).toBeUndefined();
		expect(emmetSyntax('markdown', { ...S, includeLanguages: { markdown: 'html' } })).toBeUndefined();
		expect(emmetSyntax('svelte', { ...S, includeLanguages: { svelte: 'html' } })).toBe('html');
		expect(emmetSyntax('vue', { ...S, includeLanguages: { vue: 'nonsense' } })).toBeUndefined();
		expect(emmetSyntax('html', { ...S, excludeLanguages: ['html'] })).toBeUndefined();
	});

	test('expansion as a Monaco snippet', () => {
		expect(expandAbbreviation('ul>li.item$*2', 'html', S)).toBe('<ul>\n\t<li class="item1">${1}</li>\n\t<li class="item2">${2}</li>\n</ul>');
		expect(expandAbbreviation('div.a', 'jsx', S)).toBe('<div className="a">${1}</div>');
		expect(expandAbbreviation('m10', 'css', S)).toBe('margin: 10px;');
		expect(expandAbbreviation('p{a $ b}', 'html', S)).toBe('<p>a 1 b</p>');
		expect(expandAbbreviation('img', 'html', { ...S, syntaxProfiles: { html: { self_closing_tag: 'xhtml', attr_quotes: 'single' } } })).toBe("<img src='${1}' alt='${2}' />");
		expect(expandAbbreviation('m10', 'css', { ...S, preferences: { 'css.intUnit': 'rem' } })).toBe('margin: 10rem;');
		expect(expandAbbreviation('', 'html', S)).toBeUndefined();
		expect(snippetPreview('<a href="${1}">${2:x}</a>')).toBe('<a href="">x</a>');
		expect(snippetPreview('${1:a ${2:b}} \\$')).toBe('a b $');
	});

	test('filters and wrapping', () => {
		expect(splitFilters('ul>li|bem|c')).toEqual({ abbreviation: 'ul>li', bem: true, comment: true, trim: false });
		expect(expandAbbreviation('ul>li*', 'html', S, ['one', 'two $5'])).toBe('<ul>\n\t<li>one</li>\n\t<li>two \\$5</li>\n</ul>');
		expect(expandAbbreviation('ul>li*|t', 'html', S, ['1. one', '- two'])).toBe('<ul>\n\t<li>one</li>\n\t<li>two</li>\n</ul>');
		expect(expandAbbreviation('div.x|c', 'html', S)).toContain('<!-- /.x -->');
	});

	test('the abbreviation before the cursor', () => {
		expect(abbreviationAt('  hello ul>li', 14, 'html')).toEqual({ abbreviation: 'ul>li', start: 9, end: 14 });
		expect(abbreviationAt('\tm10', 5, 'css')).toEqual({ abbreviation: 'm10', start: 2, end: 5 });
		expect(abbreviationAt('', 1, 'html')).toBeUndefined();
	});

	test('validity and noise (VS Code emmet-helper rules)', () => {
		expect(isAbbreviationValid('html', 'div')).toBe(true);
		expect(isAbbreviationValid('html', '(some text)')).toBe(false);
		expect(isAbbreviationValid('html', '(div)>p')).toBe(true);
		expect(isAbbreviationValid('jsx', '.foo')).toBe(false);
		expect(isAbbreviationValid('html', '.foo')).toBe(true);
		expect(isAbbreviationValid('css', '#fff')).toBe(true);
		expect(isAbbreviationValid('css', '#zzz')).toBe(false);
		const noise = (syntax: string, abbr: string) => isExpansionNoise(syntax, abbr, expandAbbreviation(abbr, syntax, S) ?? '', S);
		expect(noise('html', 'div')).toBe(false);
		expect(noise('html', 'foo')).toBe(true);
		expect(noise('html', 'my-el')).toBe(false);
		expect(noise('html', 'hello.')).toBe(true);
		expect(noise('html', 'div.')).toBe(false);
		expect(noise('jsx', 'MyComponent')).toBe(false);
		expect(noise('html', 'a:link')).toBe(false);
		expect(noise('css', 'm10')).toBe(false);
	});

	test('where an abbreviation may expand', () => {
		expect(isValidLocation('html', '<div>\n\t', 'ul')).toBe(true);
		expect(isValidLocation('html', '<div class="a" ', 'ul')).toBe(false);
		expect(isValidLocation('html', '', 'ul')).toBe(true);
		expect(isValidLocation('jsx', 'const f = () => ', 'div')).toBe(true);
		expect(isValidLocation('css', 'a {\n\t', 'm10')).toBe(true);
		expect(isValidLocation('css', '', 'm10')).toBe(false);
		expect(isValidLocation('css', 'a { color: ', 'red')).toBe(false);
		expect(isValidLocation('css', 'a { color: ', '#f00')).toBe(true);
		expect(isValidLocation('css', 'a { /* ', 'm10')).toBe(false);
		expect(isValidLocation('css', '', '@media')).toBe(true);
		expect(isValidLocation('sass', 'a\n\t', 'm10')).toBe(true);
	});
});

const DOC = '<ul>\n\t<li class="a b">one</li>\n\t<li>two<br><img src="x" /></li>\n</ul>';

describe('markup actions', () => {
	const m = parseMarkup(DOC);
	const at = (s: string, n = 0) => {
		let i = -1;
		for (let k = 0; k <= n; k++) i = DOC.indexOf(s, i + 1);
		return i;
	};

	test('parses elements, attributes, void and self-closing tags', () => {
		expect(m.all.map((e) => e.name)).toEqual(['ul', 'li', 'li', 'br', 'img']);
		expect(m.elements.length).toBe(1);
		const li = m.all[1];
		expect(DOC.slice(li.start, li.end)).toBe('<li class="a b">one</li>');
		expect(li.open.attributes.map((a) => [a.name, DOC.slice(a.valueStart!, a.valueEnd!)])).toEqual([['class', 'a b']]);
		expect(m.all[4].open.selfClosing).toBe(true);
		const raw = parseMarkup('<script>if (a<b) x()</script><p>');
		expect(raw.all.map((e) => e.name)).toEqual(['script', 'p']);
		const jsx = parseMarkup('<Foo {...p} onClick={() => go("<x>")}>hi</Foo>');
		expect(jsx.all.map((e) => [e.name, !!e.close])).toEqual([['Foo', true]]);
	});

	test('match tag and balance', () => {
		expect(matchingTag(m, at('<li') + 2)).toBe(at('</li>'));
		expect(matchingTag(m, at('</li>') + 2)).toBe(at('<li'));
		const one = at('one');
		expect(balanceOut(m, one + 1, one + 1)).toEqual([one, one + 3]);
		expect(balanceOut(m, one, one + 3)).toEqual([at('<li'), at('</li>') + 5]);
		expect(balanceOut(m, at('<li'), at('</li>') + 5)).toEqual([at('<ul>') + 4, at('</ul>')]);
		expect(balanceIn(m, at('<li'), at('</li>') + 5)).toEqual([one, one + 3]);
		expect(balanceIn(m, 0, DOC.length)).toEqual([4, at('</ul>')]);
		expect(balanceIn(m, 4, at('</ul>'))).toEqual([at('<li'), at('</li>') + 5]);
		expect(elementAt(m, at('<br') + 1)?.name).toBe('br');
	});

	test('remove, update and split/join tags', () => {
		const html = '<div>\n\t<p>x</p>\n</div>';
		expect(apply(html, removeTag(html, parseMarkup(html), 1))).toBe('<p>x</p>\n');
		expect(apply(DOC, updateTag(DOC, m, at('one'), 'span'))).toContain('<span class="a b">one</span>');
		expect(apply('<b>x</b>', removeTag('<b>x</b>', parseMarkup('<b>x</b>'), 4))).toBe('x');
		expect(apply('<div></div>', splitJoinTag('<div></div>', parseMarkup('<div></div>'), 1, 'html'))).toBe('<div/>');
		expect(apply('<div></div>', splitJoinTag('<div></div>', parseMarkup('<div></div>'), 1, 'jsx'))).toBe('<div />');
		expect(apply('<div />', splitJoinTag('<div />', parseMarkup('<div />'), 1, 'html'))).toBe('<div></div>');
	});

	test('toggle comment, items, merge lines', () => {
		const html = '<p>a</p><b>c</b>';
		const commented = apply(html, toggleMarkupComment(html, parseMarkup(html), 1, 1));
		expect(commented).toBe('<!-- <p>a</p> --><b>c</b>');
		expect(apply(commented, toggleMarkupComment(commented, parseMarkup(commented), 6, 6))).toBe(html);
		const items = markupItems(DOC, m);
		const cls = at('class');
		expect(stepItem(items, at('li') , at('li') + 2, 1)).toEqual([cls, cls + 'class="a b"'.length]);
		expect(stepItem(items, cls, cls + 'class="a b"'.length, 1)).toEqual([cls + 7, cls + 10]);
		expect(stepItem(items, cls + 7, cls + 10, 1)).toEqual([cls + 7, cls + 8]);
		const merged = mergeLines(DOC, m, 1, 1)!;
		expect(apply(DOC, [merged])).toBe('<ul><li class="a b">one</li><li>two<br><img src="x" /></li></ul>');
	});
});

describe('text actions', () => {
	test('increment and decrement numbers like VS Code', () => {
		expect(numberAt('width: 10px', 9)).toEqual([7, 9]);
		expect(numberAt('x -1.5 y', 4)).toEqual([2, 6]);
		expect(numberAt('none', 2)).toBeUndefined();
		expect(addToNumber('10', 1)).toBe('11');
		expect(addToNumber('1.5', 0.1)).toBe('1.6');
		expect(addToNumber('0.9', 0.1)).toBe('1');
		expect(addToNumber('007', 1)).toBe('008');
		expect(addToNumber('.5', 0.1)).toBe('.6');
		expect(addToNumber('-1', 10)).toBe('9');
	});

	test('math expressions', () => {
		expect(evaluate('2 + 3 * 4')).toBe(14);
		expect(evaluate('(2 + 3) * 4')).toBe(20);
		expect(evaluate('2 ^ 3 ^ 2')).toBe(512);
		expect(evaluate('10 \\ 3')).toBe(3);
		expect(evaluate('-3 + 1')).toBe(-2);
		expect(evaluate('2 +')).toBeUndefined();
		expect(evaluate('alert(1)')).toBeUndefined();
		expect(mathExpressionBefore('width: 100/3', 12)).toEqual([7, 12]);
		expect(mathExpressionBefore('foo(2*3', 7)).toEqual([4, 7]);
		expect(mathExpressionBefore('abc', 3)).toBeUndefined();
		expect(formatResult(100 / 3)).toBe('33.3333333333');
		expect(formatResult(0.1 + 0.2)).toBe('0.3');
	});

	test('edit points', () => {
		const lines = ['<a href="">', '', '  ', '<p></p>'];
		expect(editPoint(lines, 0, 0, 1)).toEqual([0, 9]);
		expect(editPoint(lines, 0, 9, 1)).toEqual([2, 2]);
		expect(editPoint(lines, 3, 7, -1)).toEqual([3, 3]);
		expect(editPoint(lines, 3, 3, -1)).toEqual([2, 2]);
	});

	test('stylesheet comments and items', () => {
		const css = 'a {\n\tcolor: red;\n\tmargin: 0 auto;\n}';
		const edit = toggleCssComment(css, css.indexOf('red'), css.indexOf('red'))!;
		expect(css.slice(0, edit.start) + edit.text + css.slice(edit.end)).toBe('a {\n\t/* color: red; */\n\tmargin: 0 auto;\n}');
		const commented = 'a { /* color: red; */ }';
		const off = toggleCssComment(commented, 8, 8)!;
		expect(commented.slice(0, off.start) + off.text + commented.slice(off.end)).toBe('a { color: red; }');
		const items = cssItems(css).map(([s, e]) => css.slice(s, e));
		expect(items).toEqual(['a', 'color: red', 'red', 'margin: 0 auto', '0 auto', '0', 'auto']);
	});
});

describe('commands', () => {
	test('every registered Emmet command has an action, and every action a command', () => {
		const registered = [...readFileSync(join(import.meta.dir, 'emmetCommands.svelte.ts'), 'utf8').matchAll(/id: '(editor\.emmet\.action\.\w+)', [^\n]*run: run\('([^']+)'\)/g)];
		for (const [, id, runs] of registered) expect(runs).toBe(id);
		const actions = [...readFileSync(join(import.meta.dir, 'emmet.svelte.ts'), 'utf8').matchAll(/^\t'(editor\.emmet\.action\.\w+)':/gm)].map((m) => m[1]);
		expect(registered.map((m) => m[1]).sort()).toEqual(actions.sort());
		expect(actions.length).toBe(21);
	});
});
