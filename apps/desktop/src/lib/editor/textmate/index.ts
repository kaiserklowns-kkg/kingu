// TextMate tokenization for Monaco, the way VS Code does it: vscode-textmate
// (with the oniguruma WASM regex engine) tokenizes each line against the real
// VS Code grammars, and resolves scopes against a VS Code theme into encoded
// tokens whose color ids index the theme's color map. Monaco's encoded token
// layout is the same as vscode-textmate's, so tokens pass through unchanged.
import * as monaco from 'monaco-editor';
import { loadWASM, createOnigScanner, createOnigString } from 'vscode-oniguruma';
import onigWasmUrl from 'vscode-oniguruma/release/onig.wasm?url';
import {
	INITIAL,
	Registry,
	parseRawGrammar,
	type IGrammar,
	type IGrammarConfiguration,
	type StateStack
} from 'vscode-textmate';
import { onActiveTheme, type ActiveTheme } from '../../theme/current';
import { monacoBase } from '../../theme/themes';
import { editorColors, textMateRules } from './theme';

/** One Monaco theme id, redefined on every color theme change (editors pass it at creation). */
export const THEME_ID = 'kingu-color-theme';

// Grammars are split into lazy chunks; a language's grammar loads on first use.
const grammarFiles = import.meta.glob<string>('./grammars/*', { query: '?raw', import: 'default' });

const scopeFiles: Record<string, string> = {
	'source.ts': 'TypeScript.tmLanguage.json',
	'source.js': 'JavaScript.tmLanguage.json',
	'source.tsx': 'TypeScriptReact.tmLanguage.json',
	'source.js.jsx': 'JavaScriptReact.tmLanguage.json',
	'source.makefile': 'make.tmLanguage.json',
	'source.diff': 'diff.tmLanguage.json',
	'source.js.regexp': 'RegularExpressionsJavaScript.tmLanguage',
	'documentation.injection.ts': 'jsdoc.ts.injection.tmLanguage.json',
	'documentation.injection.js.jsx': 'jsdoc.js.injection.tmLanguage.json',
	'source.rust': 'rust.tmLanguage.json',
	'source.go': 'go.tmLanguage.json',
	'source.json': 'JSON.tmLanguage.json',
	'text.html.markdown': 'markdown.tmLanguage.json',
	'source.css': 'css.tmLanguage.json',
	'text.html.basic': 'html.tmLanguage.json',
	'text.html.derivative': 'html-derivative.tmLanguage.json'
};

const injections: Record<string, string[]> = {
	'source.ts': ['documentation.injection.ts'],
	'source.tsx': ['documentation.injection.ts'],
	'source.js': ['documentation.injection.js.jsx'],
	'source.js.jsx': ['documentation.injection.js.jsx']
};

// From each language's `contributes.grammars` in microsoft/vscode extensions/*/package.json.
const OTHER = 0; // StandardTokenType.Other
const jsTokenTypes = {
	'punctuation.definition.template-expression': OTHER,
	'entity.name.type.instance.jsdoc': OTHER,
	'entity.name.function.tagged-template': OTHER,
	'meta.import string.quoted': OTHER,
	'variable.other.jsdoc': OTHER
};
const htmlEmbedded = { 'text.html': 'html', 'source.css': 'css', 'source.js': 'javascript' };
const markdownEmbedded: Record<string, string> = {
	'meta.embedded.block.html': 'html',
	'source.js': 'javascript',
	'source.css': 'css',
	'meta.embedded.block.frontmatter': 'yaml'
};
for (const lang of ['css', 'go', 'html', 'javascript', 'json', 'rust', 'typescript', 'yaml', 'python', 'shell'])
	markdownEmbedded[`meta.embedded.block.${lang === 'shell' ? 'shellscript' : lang}`] = lang;

interface LanguageGrammar {
	scopeName: string;
	embedded?: Record<string, string>;
	tokenTypes?: IGrammarConfiguration['tokenTypes'];
	unbalancedBracketSelectors?: string[];
}

const languages: Record<string, LanguageGrammar> = {
	typescript: {
		scopeName: 'source.ts',
		tokenTypes: jsTokenTypes,
		unbalancedBracketSelectors: [
			'keyword.operator.relational',
			'storage.type.function.arrow',
			'keyword.operator.bitwise.shift',
			'meta.brace.angle',
			'punctuation.definition.tag',
			'keyword.operator.assignment.compound.bitwise.ts'
		]
	},
	javascript: {
		scopeName: 'source.js',
		embedded: { 'meta.tag.js': 'jsx-tags', 'meta.tag.without-attributes.js': 'jsx-tags', 'meta.tag.attributes.js': 'javascript', 'meta.embedded.expression.js': 'javascript' },
		tokenTypes: jsTokenTypes
	},
	typescriptreact: {
		scopeName: 'source.tsx',
		embedded: { 'meta.tag.tsx': 'jsx-tags', 'meta.tag.without-attributes.tsx': 'jsx-tags', 'meta.tag.attributes.tsx': 'typescriptreact', 'meta.embedded.expression.tsx': 'typescriptreact' },
		tokenTypes: jsTokenTypes,
		unbalancedBracketSelectors: ['keyword.operator.relational', 'storage.type.function.arrow', 'keyword.operator.bitwise.shift', 'punctuation.definition.tag', 'keyword.operator.assignment.compound.bitwise.ts']
	},
	javascriptreact: {
		scopeName: 'source.js.jsx',
		embedded: { 'meta.tag.js': 'jsx-tags', 'meta.tag.without-attributes.js': 'jsx-tags', 'meta.tag.attributes.js.jsx': 'javascriptreact', 'meta.embedded.expression.js': 'javascriptreact' },
		tokenTypes: jsTokenTypes
	},
	makefile: { scopeName: 'source.makefile', tokenTypes: { 'string.interpolated': OTHER } },
	diff: { scopeName: 'source.diff' },
	rust: { scopeName: 'source.rust' },
	go: { scopeName: 'source.go' },
	json: { scopeName: 'source.json' },
	markdown: { scopeName: 'text.html.markdown', embedded: markdownEmbedded },
	css: { scopeName: 'source.css', tokenTypes: { 'meta.function.url string.quoted': OTHER } },
	html: {
		scopeName: 'text.html.derivative',
		embedded: htmlEmbedded,
		tokenTypes: { 'meta.tag string.quoted': OTHER }
	}
};
// Until a Svelte grammar is vendored: markup, <script> and <style> highlight as in HTML.
languages.svelte = languages.html;

class TextMateState implements monaco.languages.IState {
	constructor(readonly stack: StateStack) {}
	clone() {
		return this; // StateStack is immutable
	}
	equals(other: monaco.languages.IState) {
		return other instanceof TextMateState && other.stack.equals(this.stack);
	}
}

/** Lines longer than this are left untokenized after this many ms, like VS Code's tokenization time limit. */
const TIME_LIMIT_MS = 500;

function encodedLanguageMap(map: Record<string, string> | undefined) {
	const out: Record<string, number> = {};
	for (const [scope, lang] of Object.entries(map ?? {})) {
		const id = monaco.languages.getEncodedLanguageId(lang);
		if (id) out[scope] = id;
	}
	return out;
}

let setup: Promise<void> | undefined;

/** Installs the VS Code theme and TextMate tokenizers. Call before creating models. */
export function setupTextMate(): Promise<void> {
	return (setup ??= init());
}

async function init() {
	const onigLib = fetch(onigWasmUrl)
		.then((r) => r.arrayBuffer())
		.then((data) => loadWASM({ data }))
		.then(() => ({ createOnigScanner, createOnigString }));

	const registry = new Registry({
		onigLib,
		loadGrammar: async (scopeName) => {
			const file = scopeFiles[scopeName];
			const load = file && grammarFiles[`./grammars/${file}`];
			if (!load) return null; // e.g. a fenced code block in a language we do not ship
			return parseRawGrammar(await load(), file);
		},
		getInjections: (scopeName) => injections[scopeName]
	});

	// Until the workbench theme service has loaded the selected theme (normally already done).
	monaco.editor.defineTheme(THEME_ID, { base: 'vs-dark', inherit: true, rules: [], colors: {} });

	// Follows `workbench.colorTheme`, like VS Code's TextMateTokenizationFeature on theme change.
	onActiveTheme(({ info, flat }: ActiveTheme) => {
		registry.setTheme({ name: flat.name, settings: textMateRules(flat, info.type) });
		monaco.editor.defineTheme(THEME_ID, { base: monacoBase(info.type), inherit: true, rules: [], colors: editorColors(flat) });
		monaco.editor.setTheme(THEME_ID);
		// Token colors come from the TextMate theme's color map, not Monaco's rules. Setting it
		// also fires a tokenization change for every language, so open models re-tokenize.
		monaco.languages.setColorMap(registry.getColorMap());
	});

	for (const [languageId, def] of Object.entries(languages)) {
		// Replaces the Monarch tokenizer factory that monaco-editor registers per language.
		monaco.languages.registerTokensProviderFactory(languageId, {
			create: async () => {
				const grammar: IGrammar | null = await registry.loadGrammarWithConfiguration(
					def.scopeName,
					monaco.languages.getEncodedLanguageId(languageId),
					{
						embeddedLanguages: encodedLanguageMap(def.embedded),
						tokenTypes: def.tokenTypes,
						unbalancedBracketSelectors: def.unbalancedBracketSelectors
					}
				);
				if (!grammar) throw new Error(`no grammar for ${def.scopeName}`);
				const provider: monaco.languages.EncodedTokensProvider = {
					getInitialState: () => new TextMateState(INITIAL),
					tokenizeEncoded(line, state) {
						const prev = state as TextMateState;
						const result = grammar.tokenizeLine2(line, prev.stack, TIME_LIMIT_MS);
						// A line that hit the time limit keeps the previous state, as VS Code does.
						const endState = result.stoppedEarly ? prev : new TextMateState(result.ruleStack);
						return { tokens: result.tokens, endState };
					}
				};
				return provider;
			}
		});
	}

	await onigLib;
}
