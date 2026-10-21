// Language-specific settings (VS Code: `"[typescript]": { "editor.tabSize": 2 }`, also
// `"[javascript][typescript]"`). Pure: which keys are overrides, which settings may be overridden
// (VS Code's ConfigurationScope.LANGUAGE_OVERRIDABLE: every editor option and the save and
// encoding settings of files.*), the built-in language defaults the bundled VS Code extensions
// contribute, and each layer's values for one language.

import type { SettingSchema } from './registry';

/** A `[language]` key, as a JSON schema `patternProperties` pattern (VS Code: OVERRIDE_PROPERTY_PATTERN). */
export const LANGUAGE_BLOCK_PATTERN = '^(\\[[^\\]\\s]+\\])+$';
const OVERRIDE_KEY = new RegExp(LANGUAGE_BLOCK_PATTERN);

/** `[typescript]` or `[javascript][typescript]`. */
export const isOverrideKey = (key: string) => OVERRIDE_KEY.test(key);

/** The language ids of an override key: `[a][b]` → ['a', 'b']. */
export const overrideLanguages = (key: string): string[] => (isOverrideKey(key) ? key.slice(1, -1).split('][') : []);

/** files.* settings VS Code registers as language-overridable (files.contribution.ts). */
const FILES_OVERRIDABLE = new Set([
	'files.autoGuessEncoding',
	'files.autoSave',
	'files.autoSaveDelay',
	'files.autoSaveWhenNoErrors',
	'files.autoSaveWorkspaceFilesOnly',
	'files.candidateGuessEncodings',
	'files.encoding',
	'files.eol',
	'files.insertFinalNewline',
	'files.saveConflictResolution',
	'files.trimFinalNewlines',
	'files.trimTrailingWhitespace',
	'files.trimTrailingWhitespaceInRegexAndStrings'
]);

/** Settings a `[language]` block may set: editor options (diff editor included) and FILES_OVERRIDABLE. */
export const isLanguageOverridable = (s: Pick<SettingSchema, 'id' | 'scope'>) =>
	s.scope !== 'application' && (s.id.startsWith('editor.') || s.id.startsWith('diffEditor.') || FILES_OVERRIDABLE.has(s.id));

/** The `configurationDefaults` of VS Code's built-in language extensions, for the languages Kingu has. */
export const DEFAULT_LANGUAGE_OVERRIDES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
	'[go]': { 'editor.insertSpaces': false },
	'[json]': { 'editor.quickSuggestions': { strings: true }, 'editor.suggest.insertMode': 'replace' },
	'[jsonc]': { 'editor.quickSuggestions': { strings: true }, 'editor.suggest.insertMode': 'replace' },
	'[makefile]': { 'editor.insertSpaces': false },
	'[markdown]': {
		'editor.wordWrap': 'on',
		'editor.quickSuggestions': { comments: 'off', strings: 'off', other: 'off' },
		'editor.unicodeHighlight.ambiguousCharacters': false,
		'editor.unicodeHighlight.invisibleCharacters': false,
		'diffEditor.ignoreTrimWhitespace': false
	},
	'[python]': { 'diffEditor.ignoreTrimWhitespace': false, 'editor.defaultColorDecorators': 'never' },
	'[yaml]': {
		'editor.insertSpaces': true,
		'editor.tabSize': 2,
		'editor.autoIndent': 'advanced',
		'diffEditor.ignoreTrimWhitespace': false,
		'editor.defaultColorDecorators': 'never',
		'editor.quickSuggestions': { strings: 'on' }
	}
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Whether a layer has any `[language]` block (so most windows skip the per-language resolution). */
export const hasOverrides = (values: Record<string, unknown>) => Object.keys(values).some(isOverrideKey);

/**
 * A layer's values for `language`: its own values, then every block that names the language in
 * file order (a later block wins). Object values merge key by key with the layer's own, like VS
 * Code's ConfigurationModel.override; keys outside `overridable` are ignored in a block.
 */
export function languageValues(values: Record<string, unknown>, language: string, overridable: (id: string) => boolean): Record<string, unknown> {
	let out: Record<string, unknown> | null = null;
	for (const [key, block] of Object.entries(values)) {
		if (!isPlainObject(block) || !overrideLanguages(key).includes(language)) continue;
		out ??= { ...values };
		for (const [id, v] of Object.entries(block)) {
			if (!overridable(id)) continue;
			out[id] = isPlainObject(v) && isPlainObject(out[id]) ? { ...(out[id] as object), ...v } : v;
		}
	}
	return out ?? values;
}

/**
 * The overridable schemas with their defaults for `language` (DEFAULT_LANGUAGE_OVERRIDES), so the
 * built-in language defaults sit under the user's settings; an object default merges key by key.
 */
export function languageSchemas(schemas: readonly SettingSchema[], language: string): SettingSchema[] {
	const defaults = languageValues(DEFAULT_LANGUAGE_OVERRIDES, language, () => true);
	return schemas.filter(isLanguageOverridable).map((s) => {
		if (!(s.id in defaults) || defaults === DEFAULT_LANGUAGE_OVERRIDES) return s;
		const v = defaults[s.id];
		return { ...s, default: isPlainObject(v) && isPlainObject(s.default) ? { ...s.default, ...v } : v } as SettingSchema;
	});
}

/** The values a layer sets in its `[language]` blocks, for problems and the settings JSON schema. */
export function overrideBlocks(values: Record<string, unknown>): [key: string, block: Record<string, unknown>][] {
	return Object.entries(values).filter((e): e is [string, Record<string, unknown>] => isOverrideKey(e[0]) && isPlainObject(e[1]));
}
