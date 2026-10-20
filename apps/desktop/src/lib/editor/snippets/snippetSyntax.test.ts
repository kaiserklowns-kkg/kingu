import { describe, expect, test } from 'bun:test';
import { applyTransform, parseSnippet, prepareSnippet, rewriteUnknownVariables, serializeSnippet, snippetText, usesSelection, variablesOf, type Transform } from './snippetSyntax.ts';

const roundTrip = (s: string) => serializeSnippet(parseSnippet(s));
const file = { path: '/home/me/proj/src/util/strings.test.ts', relativePath: 'src/util/strings.test.ts', workspaceFolder: '/home/me/proj' };

describe('snippet grammar', () => {
	test('tabstops, placeholders, choices and variables', () => {
		expect(parseSnippet('for (const ${2:element} of ${1:array}) {\n\t$0\n}')).toEqual([
			{ kind: 'text', value: 'for (const ' },
			{ kind: 'placeholder', index: 2, children: [{ kind: 'text', value: 'element' }] },
			{ kind: 'text', value: ' of ' },
			{ kind: 'placeholder', index: 1, children: [{ kind: 'text', value: 'array' }] },
			{ kind: 'text', value: ') {\n\t' },
			{ kind: 'tabstop', index: 0 },
			{ kind: 'text', value: '\n}' }
		]);
		expect(parseSnippet('${1|one,two,three|}')).toEqual([{ kind: 'choice', index: 1, options: ['one', 'two', 'three'] }]);
		expect(parseSnippet('$TM_FILENAME ${CLIPBOARD} ${TM_SELECTED_TEXT:none}')).toEqual([
			{ kind: 'variable', name: 'TM_FILENAME' },
			{ kind: 'text', value: ' ' },
			{ kind: 'variable', name: 'CLIPBOARD' },
			{ kind: 'text', value: ' ' },
			{ kind: 'variable', name: 'TM_SELECTED_TEXT', children: [{ kind: 'text', value: 'none' }] }
		]);
	});

	test('nested placeholders and escapes', () => {
		expect(parseSnippet('${1:a ${2:b} c}')).toEqual([{ kind: 'placeholder', index: 1, children: [{ kind: 'text', value: 'a ' }, { kind: 'placeholder', index: 2, children: [{ kind: 'text', value: 'b' }] }, { kind: 'text', value: ' c' }] }]);
		expect(parseSnippet('\\$MyVar = 2')).toEqual([{ kind: 'text', value: '$MyVar = 2' }]);
		expect(parseSnippet('a } b')).toEqual([{ kind: 'text', value: 'a } b' }]);
		// Not a construct: plain text.
		expect(parseSnippet('cost: $ 5 ${ x')).toEqual([{ kind: 'text', value: 'cost: $ 5 ${ x' }]);
		expect(parseSnippet('${1|a\\,b,c|}')).toEqual([{ kind: 'choice', index: 1, options: ['a,b', 'c'] }]);
	});

	test('transforms', () => {
		const [node] = parseSnippet('${TM_FILENAME/(.*)\\..+$/${1:/upcase}/}');
		expect(node).toEqual({ kind: 'variable', name: 'TM_FILENAME', transform: { regex: '(.*)\\..+$', format: [{ group: 1, modifier: 'upcase' }], flags: '' } });
		expect(parseSnippet('${1/(.)/${1:?yes:no}-$1/g}')[0]).toEqual({ kind: 'tabstop', index: 1, transform: { regex: '(.)', format: [{ group: 1, ifValue: 'yes', elseValue: 'no' }, '-', { group: 1 }], flags: 'g' } });
	});

	test('serializes back to the same syntax', () => {
		for (const s of ['for (const ${2:element} of ${1:array}) {\n\t$0\n}', '${1|one,two|}', '${TM_FILENAME/(.*)\\..+$/${1:/upcase}/}', '${1/(.)/${1:+x}/g}', '\\$x', '${TM_SELECTED_TEXT:${1:default}}', '${CURRENT_YEAR}']) {
			expect(serializeSnippet(parseSnippet(roundTrip(s)))).toBe(roundTrip(s));
			expect(parseSnippet(roundTrip(s))).toEqual(parseSnippet(s));
		}
		expect(roundTrip('$1 $TM_FILENAME')).toBe('$1 ${TM_FILENAME}');
	});

	test('snippetText is the insert preview', () => {
		expect(snippetText(parseSnippet('for (const ${2:element} of ${1:array}) {$0}'))).toBe('for (const element of array) {}');
		expect(snippetText(parseSnippet('${1|a,b|} ${X:dflt}'))).toBe('a dflt');
	});
});

describe('variables', () => {
	test('format strings: case modifiers and conditionals', () => {
		const t = (regex: string, format: Transform['format'], flags = '') => ({ regex, format, flags });
		expect(applyTransform('strings.test.ts', t('(.*?)\\..*', [{ group: 1, modifier: 'capitalize' }]))).toBe('Strings');
		expect(applyTransform('my-file_name', t('(.*)', [{ group: 1, modifier: 'camelcase' }]))).toBe('myFileName');
		expect(applyTransform('my-file_name', t('(.*)', [{ group: 1, modifier: 'pascalcase' }]))).toBe('MyFileName');
		expect(applyTransform('abc', t('(b)', ['<', { group: 1, modifier: 'upcase' }, '>']))).toBe('a<B>c');
		expect(applyTransform('aaa', t('a', ['b'], 'g'))).toBe('bbb');
		expect(applyTransform('x', t('(y)?x', [{ group: 1, ifValue: 'had y', elseValue: 'no y' }]))).toBe('no y');
		expect(applyTransform('nomatch', t('zzz', [{ group: 1, elseValue: 'fallback' }]))).toBe('fallback');
		expect(applyTransform('keep', t('(', ['x']))).toBe('keep');
	});

	test('file and workspace variables are resolved for Monaco, others are left to it', () => {
		expect(prepareSnippet('$TM_FILENAME|$TM_FILENAME_BASE|$TM_DIRECTORY|$TM_DIRECTORY_BASE|$TM_FILEPATH|$RELATIVE_FILEPATH|$WORKSPACE_NAME|$WORKSPACE_FOLDER', file)).toBe(
			'strings.test.ts|strings.test|/home/me/proj/src/util|util|/home/me/proj/src/util/strings.test.ts|src/util/strings.test.ts|proj|/home/me/proj'
		);
		expect(prepareSnippet('${TM_FILENAME/(.*)\\..+$/${1:/upcase}/}', file)).toBe('STRINGS.TEST');
		expect(prepareSnippet('$CURRENT_YEAR ${CLIPBOARD:x} $TM_SELECTED_TEXT', file)).toBe('${CURRENT_YEAR} ${CLIPBOARD:x} ${TM_SELECTED_TEXT}');
		// A value with snippet syntax in it is inserted literally.
		expect(prepareSnippet('$TM_FILENAME', { ...file, path: '/a/$b}.ts' })).toBe('\\$b\\}.ts');
		// No folder open: the workspace variables stay unresolved (empty, or their default).
		expect(prepareSnippet('${WORKSPACE_NAME:none}', { ...file, workspaceFolder: null })).toBe('${WORKSPACE_NAME:none}');
		expect(prepareSnippet('$TM_FILENAME', { path: '', relativePath: '', workspaceFolder: null, untitledName: 'Untitled-1' })).toBe('Untitled-1');
	});

	test('unknown variables become placeholders, one index per name', () => {
		const { nodes, changed } = rewriteUnknownVariables(parseSnippet('$1 ${foo} $bar ${foo} ${TM_FILENAME}'));
		expect(changed).toBe(true);
		expect(serializeSnippet(nodes)).toBe('$1 ${2:foo} ${3:bar} ${2:foo} ${TM_FILENAME}');
		expect(rewriteUnknownVariables(parseSnippet('${foo:default}')).changed).toBe(false);
	});

	test('selection snippets', () => {
		expect(usesSelection('<b>$TM_SELECTED_TEXT</b>')).toBe(true);
		expect(usesSelection('<b>${SELECTION}</b>')).toBe(true);
		expect(usesSelection('<b>$1</b>')).toBe(false);
		expect([...variablesOf(parseSnippet('${1:${CLIPBOARD}}'))]).toEqual(['CLIPBOARD']);
	});
});
