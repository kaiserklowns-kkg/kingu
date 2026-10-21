import { describe, expect, test } from 'bun:test';
import { globalSnippetFileName, isFileIncluded, isPatternInWord, languageOfFile, matchSnippets, parseSnippetFile, selectSnippets, snippetFileTemplate, snippetLabels, snippetPreview, tabCompletionSnippets, type Snippet } from './snippetFiles.ts';

const JS = `{
	// comments are fine
	"For Loop": {
		"prefix": ["for", "for-const"],
		"body": ["for (const \${2:element} of \${1:array}) {", "\\t$0", "}"],
		"description": "A for loop.",
	},
	"Bogus": { "prefix": "bog", "body": "\${foo} $1" },
	"No body": { "prefix": "nb" },
}`;

/** The word around a 1-based column of `line` ([A-Za-z0-9_-] runs), like Monaco's getWordAtPosition. */
const wordsOf = (line: string) => (col: number) => {
	const re = /[\w-]+/g;
	for (let m; (m = re.exec(line)); ) if (col >= m.index + 1 && col <= m.index + m[0].length + 1) return { start: m.index + 1, end: m.index + m[0].length + 1 };
	return null;
};

describe('snippet files', () => {
	test('a language file: one snippet per prefix, bodies joined, unknown variables rewritten', () => {
		const { snippets, error } = parseSnippetFile(JS, 'javascript.json', 'user');
		expect(error).toBeUndefined();
		expect(snippets.map((s) => [s.name, s.prefix, s.scopes])).toEqual([
			['For Loop', 'for', ['javascript']],
			['For Loop', 'for-const', ['javascript']],
			['Bogus', 'bog', ['javascript']]
		]);
		expect(snippets[0].body).toBe('for (const ${2:element} of ${1:array}) {\n\t$0\n}');
		expect(snippets[0].description).toBe('A for loop.');
		expect(snippets[2].body).toBe('${2:foo} $1');
		expect(snippetPreview(snippets[0])).toBe('for (const element of array) {\n\t\n}');
	});

	test('a global file: scope, include/exclude, file templates, nesting', () => {
		const text = JSON.stringify({
			log: { prefix: 'log', body: 'console.log($1)', scope: 'javascript, typescript', exclude: ['**/dist/**'] },
			test: { prefix: 'test', body: "test('$1')", scope: 'typescript', include: '*.test.ts' },
			group: { wrap: { prefix: 'b', body: '<b>$TM_SELECTED_TEXT</b>' } },
			license: { body: 'MIT $CURRENT_YEAR', isFileTemplate: true, description: 'License header' }
		});
		const { snippets } = parseSnippetFile(text, '.vscode/proj.code-snippets', 'workspace');
		expect(snippets.map((s) => s.name)).toEqual(['log', 'test', 'wrap', 'license']);
		expect(snippets[0].scopes).toEqual(['javascript', 'typescript']);
		expect(snippets[2].scopes).toEqual([]);
		expect(snippets[2].usesSelection).toBe(true);
		const ts = (path: string) => selectSnippets(snippets, 'typescript', path).map((s) => s.name);
		expect(ts('/p/src/a.ts')).toEqual(['log', 'wrap']);
		expect(ts('/p/src/a.test.ts')).toEqual(['log', 'test', 'wrap']);
		expect(ts('/p/dist/a.test.ts')).toEqual(['test', 'wrap']);
		expect(selectSnippets(snippets, 'css', '/p/a.css').map((s) => s.name)).toEqual(['wrap']);
		expect(selectSnippets(snippets, undefined, '/p/a.txt', { fileTemplates: true, includeNoPrefix: true }).map((s) => s.name)).toEqual(['license']);
		expect(selectSnippets(snippets, 'css', '/p/a.css', { includeNoPrefix: true }).map((s) => s.name)).toEqual(['wrap']);
	});

	test('errors and odd files', () => {
		expect(parseSnippetFile('', 'a.json', 'user')).toEqual({ snippets: [] });
		expect(parseSnippetFile('// only a comment', 'a.json', 'user')).toEqual({ snippets: [] });
		expect(parseSnippetFile('{ "a": ', 'a.json', 'user').error).toBeTruthy();
		expect(parseSnippetFile('[]', 'a.json', 'user').error).toBeTruthy();
		expect(languageOfFile('typescript.json')).toBe('typescript');
		expect(languageOfFile('mine.code-snippets')).toBeUndefined();
	});

	test('include/exclude match the file name or, with a slash, the path; case-insensitively', () => {
		expect(isFileIncluded({ include: ['travis.yml'] }, '/p/ci/Travis.yml')).toBe(true);
		expect(isFileIncluded({ include: ['travis.yml'] }, '/p/ci/other.yml')).toBe(false);
		expect(isFileIncluded({ include: ['*.ts'], exclude: ['**/gen/**'] }, '/p/gen/a.ts')).toBe(false);
		expect(isFileIncluded({}, '/anything')).toBe(true);
	});

	test('templates and file names for Configure Snippets', () => {
		expect(() => JSON.parse(snippetFileTemplate('global').replace(/\/\/[^\n]*/g, ''))).not.toThrow();
		expect(snippetFileTemplate('language', 'rust')).toContain('(rust)');
		expect(globalSnippetFileName(' my snippets ')).toBe('my snippets.code-snippets');
		expect(globalSnippetFileName('x.code-snippets')).toBe('x.code-snippets');
		expect(globalSnippetFileName('../evil')).toBeNull();
		expect(globalSnippetFileName('')).toBeNull();
	});
});

const snip = (prefix: string, name = prefix): Snippet => ({ name, prefix, description: '', body: prefix, scopes: [], isFileTemplate: false, source: 'user', file: 'x.code-snippets', usesSelection: false });

describe('completion', () => {
	test('substring (subsequence) matching on prefixes', () => {
		expect(isPatternInWord('fc', 'for-const')).toBe(true);
		expect(isPatternInWord('cf', 'for-const')).toBe(false);
		const line = '  fc';
		const m = matchSnippets([snip('for'), snip('for-const'), snip('log')], line, 5, wordsOf(line));
		expect(m.map((x) => [x.snippet.prefix, x.startColumn, x.replaceEndColumn])).toEqual([['for-const', 3, 5]]);
	});

	test('the rest of the prefix already after the cursor is replaced too', () => {
		const line = 'forach';
		// cursor after "for", "ach" follows: "foreach" does not end with it, so only the typed part is replaced.
		expect(matchSnippets([snip('foreach')], line, 4, wordsOf(line)).map((x) => x.replaceEndColumn)).toEqual([4]);
		const line2 = 'fo';
		expect(matchSnippets([snip('foo')], line2, 3, wordsOf(line2)).map((x) => [x.startColumn, x.replaceEndColumn])).toEqual([[1, 3]]);
	});

	test('after whitespace or on an empty line every snippet is offered', () => {
		expect(matchSnippets([snip('a'), snip('b')], '', 1, () => null).map((x) => x.snippet.prefix)).toEqual(['a', 'b']);
		expect(matchSnippets([snip('a'), snip('b')], 'x ', 3, wordsOf('x ')).map((x) => x.snippet.prefix)).toEqual(['a', 'b']);
		// A trigger character: only prefixes starting with it.
		expect(matchSnippets([snip('.a'), snip('b')], '', 1, () => null, '.').map((x) => x.snippet.prefix)).toEqual(['.a']);
	});

	test('two snippets with one prefix get their names in the label', () => {
		const m = matchSnippets([snip('log', 'Log'), snip('log', 'Log error'), snip('if')], '', 1, () => null);
		expect(snippetLabels(m)).toEqual(['log, Log', 'log, Log error', 'if']);
	});

	test('tab completion', () => {
		const all = [snip('for'), snip('or'), snip('if')];
		expect(tabCompletionSnippets(all, '  x = for', null).map((s) => s.prefix)).toEqual(['for', 'or']);
		expect(tabCompletionSnippets(all, '  ', null)).toEqual([]);
		expect(tabCompletionSnippets(all, 'x', 'if').map((s) => s.prefix)).toEqual(['if']);
		expect(tabCompletionSnippets(all, 'x', 'if\nelse')).toEqual([]);
	});
});
