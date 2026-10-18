/// <reference types="bun" />
// editor.* and diffEditor.* settings reach Monaco: each one has a place (editorOptionMap.ts), every
// value the setting allows survives Monaco's own option validation, and defaults agree.
import { describe, expect, test } from 'bun:test';
import { EditorOptions } from 'monaco-editor/editor/common/config/editorOptions.js';
import 'monaco-editor/editor/common/config/editorConfigurationSchema.js';
import { Registry } from 'monaco-editor/platform/registry/common/platform.js';
import { Extensions } from 'monaco-editor/platform/configuration/common/configurationRegistry.js';
import { DIFF_EDITOR_OPTION_PATHS, EDITOR_CONFIG_SETTINGS, EDITOR_KINGU_SETTINGS, EDITOR_OPTION_PATHS } from './editorOptionMap';
import { diffEditorOptionsFrom, editorConfigurationFrom, editorOptionsFrom, indentFrom, modelOptionsFrom, type Get } from './mappings';
import { SETTINGS, type SettingSchema } from './registry';

type Option = { name: string; defaultValue: unknown; validate(input: unknown): unknown };
const OPTIONS = new Map(Object.values(EditorOptions as unknown as Record<string, Option>).map((o) => [o.name, o]));
const byId = new Map(SETTINGS.map((s) => [s.id, s]));
const defaults: Get = <T>(id: string) => byId.get(id)?.default as T;
const withValue =
	(id: string, value: unknown): Get =>
	<T>(k: string) =>
		(k === id ? value : defaults(k)) as T;

/** The value at `a.b` in an object. */
const at = (o: unknown, path: string) => path.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], o);
/** Monaco's validated value of a setting, given the options object Kingu builds. */
function validated(options: Record<string, unknown>, path: string): unknown {
	const [head, ...rest] = path.split('.');
	const option = OPTIONS.get(head);
	if (!option) return at(options, path);
	const v = option.validate(options[head]);
	return rest.length ? at(v, rest.join('.')) : v;
}

/** Values to try for a setting other than its default: every enum value, the other boolean, a number in range. */
function candidates(s: SettingSchema): unknown[] {
	switch (s.type) {
		case 'boolean':
			return [!s.default];
		case 'string':
			return s.enum ? [...s.enum] : [];
		case 'number': {
			const up = s.default + 1;
			return [s.maximum === undefined || up <= s.maximum ? up : s.default - 1];
		}
		case 'json':
			return s.schema.enum ? [...s.schema.enum] : [];
		default:
			return [];
	}
}

const editorSettings = SETTINGS.filter((s) => s.id.startsWith('editor.'));
const diffSettings = SETTINGS.filter((s) => s.id.startsWith('diffEditor.'));

describe('editor settings → Monaco', () => {
	test('every editor.* setting has exactly one place: an option, Monaco’s configuration, or Kingu', () => {
		const places = (id: string) =>
			[id in EDITOR_OPTION_PATHS, (EDITOR_CONFIG_SETTINGS as readonly string[]).includes(id), (EDITOR_KINGU_SETTINGS as readonly string[]).includes(id)].filter(Boolean).length;
		for (const s of editorSettings) expect([s.id, places(s.id)]).toEqual([s.id, 1]);
		for (const id of [...Object.keys(EDITOR_OPTION_PATHS), ...EDITOR_CONFIG_SETTINGS, ...EDITOR_KINGU_SETTINGS]) expect([id, byId.has(id)]).toEqual([id, true]);
		for (const s of diffSettings) expect([s.id, s.id in DIFF_EDITOR_OPTION_PATHS]).toEqual([s.id, true]);
	});

	test('Monaco knows every key (its editor configuration registers it)', () => {
		const registry = Registry.as<{ getConfigurationProperties(): Record<string, unknown> }>(Extensions.Configuration);
		const known = new Set(Object.keys(registry.getConfigurationProperties()));
		// Read by Monaco's code action contribution; editor.selectionClipboard is registered on Linux only.
		const extra = ['editor.codeActionWidget.includeNearbyQuickFixes', 'editor.codeActionWidget.showHeaders', 'editor.selectionClipboard'];
		for (const id of [...Object.keys(EDITOR_OPTION_PATHS), ...Object.keys(DIFF_EDITOR_OPTION_PATHS)]) expect([id, known.has(id) || extra.includes(id)]).toEqual([id, true]);
		for (const id of EDITOR_CONFIG_SETTINGS) expect([id, known.has(id) || extra.includes(id)]).toEqual([id, true]);
	});

	test('defaults give Monaco’s defaults', () => {
		const options = editorOptionsFrom(defaults) as Record<string, unknown>;
		const mismatches: string[] = [];
		for (const [id, path] of Object.entries(EDITOR_OPTION_PATHS)) {
			const option = OPTIONS.get(path.split('.')[0]);
			if (!option || id === 'editor.fontFamily') continue;
			const expected = path.includes('.') ? at(option.defaultValue, path.slice(path.indexOf('.') + 1)) : option.defaultValue;
			const got = validated(options, path);
			if (JSON.stringify(got) !== JSON.stringify(expected)) mismatches.push(`${id}: ${JSON.stringify(got)} vs Monaco ${JSON.stringify(expected)}`);
		}
		expect(mismatches).toEqual([]);
	});

	test('every allowed value takes effect in Monaco’s validated options', () => {
		const ignored: string[] = [];
		for (const [id, path] of Object.entries(EDITOR_OPTION_PATHS)) {
			const s = byId.get(id)!;
			const base = JSON.stringify(validated(editorOptionsFrom(defaults) as Record<string, unknown>, path));
			for (const value of candidates(s)) {
				if (JSON.stringify(value) === JSON.stringify(s.default)) continue;
				const got = JSON.stringify(validated(editorOptionsFrom(withValue(id, value)) as Record<string, unknown>, path));
				if (got === base) ignored.push(`${id}=${JSON.stringify(value)}`);
			}
		}
		expect(ignored).toEqual([]);
	});

	test('diff editor options carry every diffEditor.* setting; the view toggle wins', () => {
		for (const [id, path] of Object.entries(DIFF_EDITOR_OPTION_PATHS)) {
			for (const value of candidates(byId.get(id)!)) expect([id, at(diffEditorOptionsFrom(withValue(id, value)), path)]).toEqual([id, value]);
		}
		expect(diffEditorOptionsFrom(defaults, false).renderSideBySide).toBe(false);
		expect(diffEditorOptionsFrom(withValue('diffEditor.wordWrap', 'on')).diffWordWrap).toBe('on');
		expect(diffEditorOptionsFrom(defaults).hideUnchangedRegions).toEqual({ contextLineCount: 3, enabled: false, minimumLineCount: 3, revealLineCount: 20 });
	});

	test('Monaco’s configuration gets every editor and diff setting', () => {
		const config = new Map(editorConfigurationFrom(defaults));
		for (const s of [...editorSettings, ...diffSettings]) expect([s.id, config.has(s.id)]).toEqual([s.id, true]);
		expect(config.get('editor.codeActionWidget.showHeaders')).toBe(true);
		expect(config.get('editor.largeFileOptimizations')).toBe(true);
	});

	test('editor.maxTokenizationLineLength: the TextMate tokenizer gives long lines Monaco’s plain tokens', async () => {
		const { nullTokenizeEncoded } = await import('monaco-editor/editor/common/languages/nullTokenize.js');
		const { plainLineTokens, setMaxTokenizationLineLength, skipsTokenization } = await import('#lib/editor/tokenizationLimit.ts');
		expect([...plainLineTokens(7)]).toEqual([...nullTokenizeEncoded(7, null).tokens]);
		expect([skipsTokenization(19999), skipsTokenization(20000)]).toEqual([false, true]);
		setMaxTokenizationLineLength(100);
		expect(skipsTokenization(100)).toBe(true);
		setMaxTokenizationLineLength(20000);
	});

	test('model options: indentSize follows tabSize unless set; detection wins', () => {
		expect(modelOptionsFrom(indentFrom(defaults))).toEqual({ tabSize: 4, indentSize: 4, insertSpaces: true, trimAutoWhitespace: true });
		expect(modelOptionsFrom(indentFrom(withValue('editor.indentSize', 2)))).toMatchObject({ tabSize: 4, indentSize: 2 });
		expect(modelOptionsFrom(indentFrom(withValue('editor.trimAutoWhitespace', false)))).toMatchObject({ trimAutoWhitespace: false });
		expect(modelOptionsFrom(indentFrom(withValue('editor.indentSize', 2)), { tabSize: 8, insertSpaces: false })).toMatchObject({ tabSize: 8, indentSize: 8, insertSpaces: false });
	});
});

