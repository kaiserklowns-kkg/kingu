// VS Code's per-language settings, delivered to the language servers Kingu runs the way each
// server's VS Code client does (`workspace/configuration` answers and
// `workspace/didChangeConfiguration` pushes; extensions/*-language-features):
//
// - typescript-language-server: `[typescript|javascript].{inlayHints,format,referencesCodeLens,
//   implementationsCodeLens}`, `completions`, `implicitProjectConfiguration` pushed, and tsserver
//   preferences in `initializationOptions.preferences` (it reads them only at startup). The unified
//   `js/ts.*` keys win when set, else `typescript.*` / `javascript.*` (VS Code's readUnifiedConfig).
// - vscode-css-language-server: the `css`, `scss` and `less` sections.
// - vscode-html-language-server: `html`, plus `css` and `javascript` for embedded code.
// - vscode-json-language-server: `json` (validate, format, schemas, limits) and `http`.
//
// Pure: the reader gives a setting's effective value, whether a file sets it, and one file's value.

export type SettingsReader = {
	get: <T = unknown>(id: string) => T;
	/** Whether a settings file sets `id` (VS Code: inspect() has a user or folder value). */
	isSet: (id: string) => boolean;
	/** The value one settings file sets (`folder`: the folder's file or Kingu's per-repository store). */
	layer?: (id: string, scope: 'user' | 'folder') => unknown;
};
type Lang = 'typescript' | 'javascript';

/** [unified, TypeScript, JavaScript] keys of one TS/JS setting (null where VS Code has none). */
type Keys = readonly [string, string, string | null];

function readUnified<T>(r: SettingsReader, keys: Keys, lang: Lang): T {
	const [unified, ts, js] = keys;
	if (r.isSet(unified)) return r.get<T>(unified);
	const own = lang === 'typescript' ? ts : js;
	return r.get<T>(own ?? unified);
}

const INLAY_HINTS: [string, Keys, (v: unknown) => unknown][] = [
	['includeInlayParameterNameHints', ['js/ts.inlayHints.parameterNames.enabled', 'typescript.inlayHints.parameterNames.enabled', 'javascript.inlayHints.parameterNames.enabled'], (v) => (v === 'literals' || v === 'all' ? v : 'none')],
	['includeInlayParameterNameHintsWhenArgumentMatchesName', ['js/ts.inlayHints.parameterNames.suppressWhenArgumentMatchesName', 'typescript.inlayHints.parameterNames.suppressWhenArgumentMatchesName', 'javascript.inlayHints.parameterNames.suppressWhenArgumentMatchesName'], (v) => !v],
	['includeInlayFunctionParameterTypeHints', ['js/ts.inlayHints.parameterTypes.enabled', 'typescript.inlayHints.parameterTypes.enabled', 'javascript.inlayHints.parameterTypes.enabled'], Boolean],
	['includeInlayVariableTypeHints', ['js/ts.inlayHints.variableTypes.enabled', 'typescript.inlayHints.variableTypes.enabled', 'javascript.inlayHints.variableTypes.enabled'], Boolean],
	['includeInlayVariableTypeHintsWhenTypeMatchesName', ['js/ts.inlayHints.variableTypes.suppressWhenTypeMatchesName', 'typescript.inlayHints.variableTypes.suppressWhenTypeMatchesName', 'javascript.inlayHints.variableTypes.suppressWhenTypeMatchesName'], (v) => !v],
	['includeInlayPropertyDeclarationTypeHints', ['js/ts.inlayHints.propertyDeclarationTypes.enabled', 'typescript.inlayHints.propertyDeclarationTypes.enabled', 'javascript.inlayHints.propertyDeclarationTypes.enabled'], Boolean],
	['includeInlayFunctionLikeReturnTypeHints', ['js/ts.inlayHints.functionLikeReturnTypes.enabled', 'typescript.inlayHints.functionLikeReturnTypes.enabled', 'javascript.inlayHints.functionLikeReturnTypes.enabled'], Boolean],
	['includeInlayEnumMemberValueHints', ['js/ts.inlayHints.enumMemberValues.enabled', 'typescript.inlayHints.enumMemberValues.enabled', null], Boolean]
];

/** tsserver FormatCodeSettings: the same names as VS Code's `format.*`. */
const FORMAT: [string, Keys][] = [
	['insertSpaceAfterCommaDelimiter', ['js/ts.format.insertSpaceAfterCommaDelimiter', 'typescript.format.insertSpaceAfterCommaDelimiter', 'javascript.format.insertSpaceAfterCommaDelimiter']],
	['insertSpaceAfterConstructor', ['js/ts.format.insertSpaceAfterConstructor', 'typescript.format.insertSpaceAfterConstructor', 'javascript.format.insertSpaceAfterConstructor']],
	['insertSpaceAfterSemicolonInForStatements', ['js/ts.format.insertSpaceAfterSemicolonInForStatements', 'typescript.format.insertSpaceAfterSemicolonInForStatements', 'javascript.format.insertSpaceAfterSemicolonInForStatements']],
	['insertSpaceBeforeAndAfterBinaryOperators', ['js/ts.format.insertSpaceBeforeAndAfterBinaryOperators', 'typescript.format.insertSpaceBeforeAndAfterBinaryOperators', 'javascript.format.insertSpaceBeforeAndAfterBinaryOperators']],
	['insertSpaceAfterKeywordsInControlFlowStatements', ['js/ts.format.insertSpaceAfterKeywordsInControlFlowStatements', 'typescript.format.insertSpaceAfterKeywordsInControlFlowStatements', 'javascript.format.insertSpaceAfterKeywordsInControlFlowStatements']],
	['insertSpaceAfterFunctionKeywordForAnonymousFunctions', ['js/ts.format.insertSpaceAfterFunctionKeywordForAnonymousFunctions', 'typescript.format.insertSpaceAfterFunctionKeywordForAnonymousFunctions', 'javascript.format.insertSpaceAfterFunctionKeywordForAnonymousFunctions']],
	['insertSpaceBeforeFunctionParenthesis', ['js/ts.format.insertSpaceBeforeFunctionParenthesis', 'typescript.format.insertSpaceBeforeFunctionParenthesis', 'javascript.format.insertSpaceBeforeFunctionParenthesis']],
	['insertSpaceAfterOpeningAndBeforeClosingEmptyBraces', ['js/ts.format.insertSpaceAfterOpeningAndBeforeClosingEmptyBraces', 'typescript.format.insertSpaceAfterOpeningAndBeforeClosingEmptyBraces', 'javascript.format.insertSpaceAfterOpeningAndBeforeClosingEmptyBraces']],
	['insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis', ['js/ts.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis', 'typescript.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis', 'javascript.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis']],
	['insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets', ['js/ts.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets', 'typescript.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets', 'javascript.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets']],
	['insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces', ['js/ts.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces', 'typescript.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces', 'javascript.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces']],
	['insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces', ['js/ts.format.insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces', 'typescript.format.insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces', 'javascript.format.insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces']],
	['insertSpaceAfterOpeningAndBeforeClosingJsxExpressionBraces', ['js/ts.format.insertSpaceAfterOpeningAndBeforeClosingJsxExpressionBraces', 'typescript.format.insertSpaceAfterOpeningAndBeforeClosingJsxExpressionBraces', 'javascript.format.insertSpaceAfterOpeningAndBeforeClosingJsxExpressionBraces']],
	['insertSpaceAfterTypeAssertion', ['js/ts.format.insertSpaceAfterTypeAssertion', 'typescript.format.insertSpaceAfterTypeAssertion', null]],
	['placeOpenBraceOnNewLineForFunctions', ['js/ts.format.placeOpenBraceOnNewLineForFunctions', 'typescript.format.placeOpenBraceOnNewLineForFunctions', 'javascript.format.placeOpenBraceOnNewLineForFunctions']],
	['placeOpenBraceOnNewLineForControlBlocks', ['js/ts.format.placeOpenBraceOnNewLineForControlBlocks', 'typescript.format.placeOpenBraceOnNewLineForControlBlocks', 'javascript.format.placeOpenBraceOnNewLineForControlBlocks']],
	['semicolons', ['js/ts.format.semicolons', 'typescript.format.semicolons', 'javascript.format.semicolons']],
	['indentSwitchCase', ['js/ts.format.indentSwitchCase', 'typescript.format.indentSwitchCase', 'javascript.format.indentSwitchCase']]
];

const REFERENCES_CODE_LENS: Keys = ['js/ts.referencesCodeLens.enabled', 'typescript.referencesCodeLens.enabled', 'javascript.referencesCodeLens.enabled'];
const REFERENCES_ON_ALL_FUNCTIONS: Keys = ['js/ts.referencesCodeLens.showOnAllFunctions', 'typescript.referencesCodeLens.showOnAllFunctions', 'javascript.referencesCodeLens.showOnAllFunctions'];
const IMPLEMENTATIONS_CODE_LENS: Keys = ['js/ts.implementationsCodeLens.enabled', 'typescript.implementationsCodeLens.enabled', null];
const COMPLETE_FUNCTION_CALLS: Keys = ['js/ts.suggest.completeFunctionCalls', 'typescript.suggest.completeFunctionCalls', null];

/** tsserver UserPreferences from the TypeScript (or unified) keys; they apply to every file. */
const PREFERENCES: [string, Keys, ((v: unknown) => unknown)?][] = [
	['quotePreference', ['js/ts.preferences.quoteStyle', 'typescript.preferences.quoteStyle', null]],
	['importModuleSpecifierPreference', ['js/ts.preferences.importModuleSpecifier', 'typescript.preferences.importModuleSpecifier', null]],
	['importModuleSpecifierEnding', ['js/ts.preferences.importModuleSpecifierEnding', 'typescript.preferences.importModuleSpecifierEnding', null]],
	['jsxAttributeCompletionStyle', ['js/ts.preferences.jsxAttributeCompletionStyle', 'typescript.preferences.jsxAttributeCompletionStyle', null]],
	['includePackageJsonAutoImports', ['js/ts.preferences.includePackageJsonAutoImports', 'typescript.preferences.includePackageJsonAutoImports', null]],
	['preferTypeOnlyAutoImports', ['js/ts.preferences.preferTypeOnlyAutoImports', 'typescript.preferences.preferTypeOnlyAutoImports', null]],
	['autoImportFileExcludePatterns', ['js/ts.preferences.autoImportFileExcludePatterns', 'typescript.preferences.autoImportFileExcludePatterns', null]],
	['autoImportSpecifierExcludeRegexes', ['js/ts.preferences.autoImportSpecifierExcludeRegexes', 'typescript.preferences.autoImportSpecifierExcludeRegexes', null]],
	['providePrefixAndSuffixTextForRename', ['js/ts.preferences.useAliasesForRenames', 'typescript.preferences.useAliasesForRenames', null]],
	['includeCompletionsForModuleExports', ['js/ts.suggest.autoImports', 'typescript.suggest.autoImports', null]],
	['includeAutomaticOptionalChainCompletions', ['js/ts.suggest.includeAutomaticOptionalChainCompletions', 'typescript.suggest.includeAutomaticOptionalChainCompletions', null]],
	['includeCompletionsForImportStatements', ['js/ts.suggest.includeCompletionsForImportStatements', 'typescript.suggest.includeCompletionsForImportStatements', null]],
	['includeCompletionsWithClassMemberSnippets', ['js/ts.suggest.classMemberSnippets.enabled', 'typescript.suggest.classMemberSnippets.enabled', null]],
	['includeCompletionsWithObjectLiteralMethodSnippets', ['js/ts.suggest.objectLiteralMethodSnippets.enabled', 'typescript.suggest.objectLiteralMethodSnippets.enabled', null]],
	['generateReturnInDocTemplate', ['js/ts.suggest.jsdoc.generateReturns', 'typescript.suggest.jsdoc.generateReturns', null]],
	// VS Code: a bad value falls back to 500 (fileConfigurationManager.ts getMaximumHoverLength).
	['maximumHoverLength', ['js/ts.hover.maximumLength', 'js/ts.hover.maximumLength', null], (v) => (Number.isSafeInteger(v) && (v as number) > 0 ? v : 500)]
];

/** `js/ts.implicitProjectConfig.*` → typescript-language-server's `implicitProjectConfiguration`. */
const IMPLICIT_PROJECT: [string, string][] = [
	['checkJs', 'js/ts.implicitProjectConfig.checkJs'],
	['experimentalDecorators', 'js/ts.implicitProjectConfig.experimentalDecorators'],
	['module', 'js/ts.implicitProjectConfig.module'],
	['strict', 'js/ts.implicitProjectConfig.strict'],
	['strictFunctionTypes', 'js/ts.implicitProjectConfig.strictFunctionTypes'],
	['strictNullChecks', 'js/ts.implicitProjectConfig.strictNullChecks'],
	['target', 'js/ts.implicitProjectConfig.target']
];

function languageOptions(r: SettingsReader, lang: Lang) {
	return {
		inlayHints: Object.fromEntries(INLAY_HINTS.map(([name, keys, map]) => [name, map(readUnified(r, keys, lang))])),
		format: Object.fromEntries(FORMAT.map(([name, keys]) => [name, readUnified(r, keys, lang)])),
		referencesCodeLens: { enabled: readUnified<boolean>(r, REFERENCES_CODE_LENS, lang), showOnAllFunctions: readUnified<boolean>(r, REFERENCES_ON_ALL_FUNCTIONS, lang) },
		implementationsCodeLens: { enabled: readUnified<boolean>(r, IMPLEMENTATIONS_CODE_LENS, lang) }
	};
}

/** typescript-language-server's workspace configuration (pushed with didChangeConfiguration). */
export function typescriptSettings(r: SettingsReader): Record<string, unknown> {
	return {
		typescript: languageOptions(r, 'typescript'),
		javascript: languageOptions(r, 'javascript'),
		completions: { completeFunctionCalls: readUnified<boolean>(r, COMPLETE_FUNCTION_CALLS, 'typescript') },
		implicitProjectConfiguration: Object.fromEntries(IMPLICIT_PROJECT.map(([name, id]) => [name, r.get(id)]))
	};
}

/** tsserver preferences for typescript-language-server's `initializationOptions.preferences`. */
export function typescriptPreferences(r: SettingsReader): Record<string, unknown> {
	return Object.fromEntries(PREFERENCES.map(([name, keys, map]) => [name, (map ?? ((v) => v))(readUnified(r, keys, 'typescript'))]));
}

// --- CSS, HTML ---------------------------------------------------------------------------------

/** The `css`/`scss`/`less` settings the CSS server reads (VS Code sends these sections whole). */
export const CSS_SETTING_IDS = [
	'css.validate', 'css.completion.triggerPropertyValueCompletion', 'css.completion.completePropertyWithSemicolon', 'css.hover.documentation', 'css.hover.references',
	'css.format.enable', 'css.format.newlineBetweenSelectors', 'css.format.newlineBetweenRules', 'css.format.spaceAroundSelectorSeparator', 'css.format.braceStyle',
	'css.format.preserveNewLines', 'css.format.maxPreserveNewLines', 'css.lint.compatibleVendorPrefixes', 'css.lint.vendorPrefix', 'css.lint.duplicateProperties',
	'css.lint.emptyRules', 'css.lint.importStatement', 'css.lint.boxModel', 'css.lint.universalSelector', 'css.lint.zeroUnits', 'css.lint.fontFaceProperties',
	'css.lint.hexColorLength', 'css.lint.argumentsInColorFunction', 'css.lint.unknownProperties', 'css.lint.validProperties', 'css.lint.ieHack',
	'css.lint.unknownVendorSpecificProperties', 'css.lint.propertyIgnoredDueToDisplay', 'css.lint.important', 'css.lint.float', 'css.lint.idSelector', 'css.lint.unknownAtRules',
	'scss.validate', 'scss.completion.triggerPropertyValueCompletion', 'scss.completion.completePropertyWithSemicolon', 'scss.hover.documentation', 'scss.hover.references',
	'scss.format.enable', 'scss.format.newlineBetweenSelectors', 'scss.format.newlineBetweenRules', 'scss.format.spaceAroundSelectorSeparator', 'scss.format.braceStyle',
	'scss.format.preserveNewLines', 'scss.format.maxPreserveNewLines', 'scss.lint.compatibleVendorPrefixes', 'scss.lint.vendorPrefix', 'scss.lint.duplicateProperties',
	'scss.lint.emptyRules', 'scss.lint.importStatement', 'scss.lint.boxModel', 'scss.lint.universalSelector', 'scss.lint.zeroUnits', 'scss.lint.fontFaceProperties',
	'scss.lint.hexColorLength', 'scss.lint.argumentsInColorFunction', 'scss.lint.unknownProperties', 'scss.lint.validProperties', 'scss.lint.ieHack',
	'scss.lint.unknownVendorSpecificProperties', 'scss.lint.propertyIgnoredDueToDisplay', 'scss.lint.important', 'scss.lint.float', 'scss.lint.idSelector', 'scss.lint.unknownAtRules',
	'less.validate', 'less.completion.triggerPropertyValueCompletion', 'less.completion.completePropertyWithSemicolon', 'less.hover.documentation', 'less.hover.references',
	'less.format.enable', 'less.format.newlineBetweenSelectors', 'less.format.newlineBetweenRules', 'less.format.spaceAroundSelectorSeparator', 'less.format.braceStyle',
	'less.format.preserveNewLines', 'less.format.maxPreserveNewLines', 'less.lint.compatibleVendorPrefixes', 'less.lint.vendorPrefix', 'less.lint.duplicateProperties',
	'less.lint.emptyRules', 'less.lint.importStatement', 'less.lint.boxModel', 'less.lint.universalSelector', 'less.lint.zeroUnits', 'less.lint.fontFaceProperties',
	'less.lint.hexColorLength', 'less.lint.argumentsInColorFunction', 'less.lint.unknownProperties', 'less.lint.validProperties', 'less.lint.ieHack',
	'less.lint.unknownVendorSpecificProperties', 'less.lint.propertyIgnoredDueToDisplay', 'less.lint.important', 'less.lint.float', 'less.lint.idSelector', 'less.lint.unknownAtRules'
] as const;

export const HTML_SETTING_IDS = [
	'html.format.enable', 'html.format.wrapLineLength', 'html.format.unformatted', 'html.format.contentUnformatted', 'html.format.indentInnerHtml',
	'html.format.preserveNewLines', 'html.format.maxPreserveNewLines', 'html.format.indentHandlebars', 'html.format.extraLiners', 'html.format.wrapAttributes',
	'html.format.wrapAttributesIndentSize', 'html.format.templating', 'html.format.unformattedContentDelimiter', 'html.suggest.html5', 'html.suggest.hideEndTagSuggestions',
	'html.validate.scripts', 'html.validate.styles', 'html.hover.documentation', 'html.hover.references', 'html.autoCreateQuotes', 'html.completion.attributeDefaultValue'
] as const;

/** Flat `a.b.c` setting ids → `{ a: { b: { c } } }`, like VS Code's `getConfiguration()` sections. */
export function nest(ids: readonly string[], get: (id: string) => unknown): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const id of ids) {
		const parts = id.split('.');
		let at = out;
		for (const p of parts.slice(0, -1)) at = (at[p] ??= {}) as Record<string, unknown>;
		at[parts[parts.length - 1]] = get(id);
	}
	return out;
}

export function cssSettings(r: SettingsReader): Record<string, unknown> {
	return nest(CSS_SETTING_IDS, (id) => r.get(id));
}

/** The HTML server reads `html`, and `css` / `javascript` for `<style>` and `<script>`. */
export function htmlSettings(r: SettingsReader): Record<string, unknown> {
	const css = cssSettings(r).css;
	const javascript = { format: languageOptions(r, 'javascript').format };
	return { ...nest(HTML_SETTING_IDS, (id) => r.get(id)), css, javascript };
}

// --- JSON --------------------------------------------------------------------------------------

export type JsonSchemaSetting = { fileMatch?: string[]; url?: string; schema?: unknown };
type SchemaAssociation = { url: string; fileMatch?: string[]; schema?: unknown };

const normalizeLimit = (v: unknown) => Math.trunc(Math.max(0, Number(v))) || 5000;
const FOLDER_VAR = '${workspaceFolder}/';

/**
 * `json.schemas` as VS Code's JSON client sends them (jsonClient.ts collectSchemaSettings): an
 * entry without `url` gets its inline schema's id or a `vscode://schemas/custom/` one; in the
 * folder's settings a relative `url` (`./x.json`, `/x.json`) is a file of the folder and a leading
 * `${workspaceFolder}/` in `fileMatch` is the folder path. User settings stay as written.
 */
export function jsonSchemaAssociations(user: unknown, folder: unknown, rootUri: string): SchemaAssociation[] {
	const out: SchemaAssociation[] = [];
	const root = rootUri.replace(/\/$/, '');
	const folderPath = decodeURIComponent(root.replace(/^file:\/\//, ''));
	const collect = (list: unknown, inFolder: boolean) => {
		if (!Array.isArray(list)) return;
		list.forEach((s: JsonSchemaSetting) => {
			if (!s || typeof s !== 'object') return;
			let url = typeof s.url === 'string' && s.url ? s.url : undefined;
			if (!url && s.schema && typeof s.schema === 'object') url = (s.schema as { id?: string }).id ?? `vscode://schemas/custom/${out.length}`;
			else if (url && inFolder && (url[0] === '.' || url[0] === '/')) url = `${root}/${url.replace(/^\.?\//, '')}`;
			if (!url) return;
			const fileMatch = Array.isArray(s.fileMatch)
				? s.fileMatch.map((fm) => {
						if (!inFolder || typeof fm !== 'string') return fm;
						const not = fm.startsWith('!') ? '!' : '';
						const rest = fm.slice(not.length);
						return rest.startsWith(FOLDER_VAR) ? `${not}${folderPath}/${rest.slice(FOLDER_VAR.length)}` : fm;
					})
				: undefined;
			out.push({ url, fileMatch, schema: s.schema });
		});
	};
	collect(user, false);
	collect(folder, true);
	return out;
}

/** What VS Code's JSON client pushes (jsonClient.ts computeSettings); limits ask for one more. */
export function jsonSettings(r: SettingsReader, rootUri: string): Record<string, unknown> {
	return {
		http: { proxy: r.get('http.proxy'), proxyStrictSSL: r.get('http.proxyStrictSSL') },
		json: {
			validate: { enable: r.get('json.validate.enable') },
			format: { enable: r.get('json.format.enable') },
			keepLines: { enable: r.get('json.format.keepLines') },
			schemas: jsonSchemaAssociations(r.layer?.('json.schemas', 'user'), r.layer?.('json.schemas', 'folder'), rootUri),
			resultLimit: normalizeLimit(r.get('json.maxItemsComputed')) + 1,
			jsonFoldingLimit: normalizeLimit(r.get('editor.foldingMaximumRegions')) + 1,
			jsonColorDecoratorLimit: normalizeLimit(r.get('editor.colorDecoratorsLimit')) + 1
		}
	};
}

/** The VS Code-settings part of a server's configuration, by server key (none for the others). */
export function serverSettings(key: string, r: SettingsReader, rootUri: string): Record<string, unknown> {
	switch (key) {
		case 'typescript':
			return typescriptSettings(r);
		case 'css':
			return cssSettings(r);
		case 'html':
			return htmlSettings(r);
		case 'json':
			return jsonSettings(r, rootUri);
		default:
			return {};
	}
}
