/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { isLanguageOverridable, isOverrideKey, languageSchemas, languageValues, overrideLanguages } from './languageOverrides';
import { jsonSchema, resolveSettings, settingProblems, SETTINGS } from './registry';
import { matchesSchema } from './jsonSchema';

const overridable = (id: string) => {
	const s = SETTINGS.find((x) => x.id === id);
	return !!s && isLanguageOverridable(s);
};

/** What `settings.getFor(id, language)` resolves, from plain layers. */
function resolveFor(language: string, user: Record<string, unknown>, workspace: Record<string, unknown> = {}) {
	return resolveSettings(languageValues(user, language, overridable), languageValues(workspace, language, overridable), languageSchemas(SETTINGS, language));
}

describe('language blocks', () => {
	test('keys', () => {
		expect(isOverrideKey('[typescript]')).toBe(true);
		expect(isOverrideKey('[javascript][typescript]')).toBe(true);
		expect(isOverrideKey('editor.tabSize')).toBe(false);
		expect(isOverrideKey('[a b]')).toBe(false);
		expect(overrideLanguages('[javascript][typescript]')).toEqual(['javascript', 'typescript']);
	});

	test('what can be overridden', () => {
		expect(overridable('editor.tabSize')).toBe(true);
		expect(overridable('files.trimTrailingWhitespace')).toBe(true);
		expect(overridable('diffEditor.ignoreTrimWhitespace')).toBe(true);
		expect(overridable('workbench.colorTheme')).toBe(false);
		expect(overridable('files.exclude')).toBe(false);
	});

	test('a block wins over its layer; later blocks win; other languages and non-overridable keys are ignored', () => {
		const user = {
			'editor.tabSize': 4,
			'workbench.colorTheme': 'x',
			'[typescript]': { 'editor.tabSize': 2, 'workbench.colorTheme': 'y' },
			'[javascript][typescript]': { 'editor.insertSpaces': false, 'editor.tabSize': 8 },
			'[python]': { 'editor.tabSize': 3 }
		};
		const ts = languageValues(user, 'typescript', overridable);
		expect(ts['editor.tabSize']).toBe(8);
		expect(ts['editor.insertSpaces']).toBe(false);
		expect(ts['workbench.colorTheme']).toBe('x');
		expect(languageValues(user, 'rust', overridable)).toBe(user);
	});

	test('object values merge with the layer value', () => {
		const user = { 'editor.quickSuggestions': { other: 'off' }, '[markdown]': { 'editor.quickSuggestions': { strings: 'on' } } };
		expect(languageValues(user, 'markdown', overridable)['editor.quickSuggestions']).toEqual({ other: 'off', strings: 'on' });
	});

	test("precedence is VS Code's: workspace over a user block, a block over its own layer", () => {
		const user = { '[typescript]': { 'editor.tabSize': 2 } };
		expect(resolveFor('typescript', user).get('editor.tabSize')?.value).toBe(2);
		expect(resolveFor('typescript', user, { 'editor.tabSize': 6 }).get('editor.tabSize')?.value).toBe(6);
		expect(resolveFor('typescript', user, { 'editor.tabSize': 6, '[typescript]': { 'editor.tabSize': 3 } }).get('editor.tabSize')).toEqual({ value: 3, source: 'workspace' });
		// An invalid value in a block falls back like any invalid value.
		expect(resolveFor('typescript', { '[typescript]': { 'editor.tabSize': 'big' } }).get('editor.tabSize')?.value).toBe(4);
	});

	test('built-in language defaults sit under the user settings', () => {
		expect(resolveFor('makefile', {}).get('editor.insertSpaces')).toEqual({ value: false, source: 'default' });
		expect(resolveFor('markdown', {}).get('editor.wordWrap')?.value).toBe('on');
		expect(resolveFor('markdown', { '[markdown]': { 'editor.wordWrap': 'off' } }).get('editor.wordWrap')?.value).toBe('off');
		expect(resolveFor('yaml', {}).get('editor.tabSize')?.value).toBe(2);
		expect((resolveFor('json', {}).get('editor.quickSuggestions')?.value as Record<string, unknown>).strings).toBe(true);
		expect(resolveFor('typescript', {}).get('editor.wordWrap')?.value).toBe('off');
	});

	test('problems inside blocks', () => {
		const problems = settingProblems({ '[typescript]': { 'editor.tabSize': 'big', 'workbench.colorTheme': 'x', 'unknown.key': 1 } }, 'user');
		expect(problems.map((p) => p.id)).toEqual(['[typescript] editor.tabSize', '[typescript] workbench.colorTheme']);
	});

	test('settings.json schema accepts language blocks', () => {
		const schema = jsonSchema(SETTINGS) as { patternProperties: Record<string, { properties: Record<string, unknown> }> };
		const [pattern, block] = Object.entries(schema.patternProperties)[0];
		expect(new RegExp(pattern).test('[typescript]')).toBe(true);
		expect(block.properties['editor.tabSize']).toBeDefined();
		expect(block.properties['workbench.colorTheme']).toBeUndefined();
		expect(matchesSchema(schema as never, { '[typescript]': { 'editor.tabSize': 2 } })).toBe(true);
	});
});
