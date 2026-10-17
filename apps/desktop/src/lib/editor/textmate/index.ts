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
import darkModern from './themes/dark_modern.json?raw';
import darkPlus from './themes/dark_plus.json?raw';
import darkVs from './themes/dark_vs.json?raw';
import { editorColors, flattenTheme, textMateRules } from './theme';

export const THEME_ID = 'vscode-dark-modern';

// Grammars are split into lazy chunks; a language's grammar loads on first use.
const grammarFiles = import.meta.glob<string>('./grammars/*', { query: '?raw', import: 'default' });

const scopeFiles: Record<string, string> = {
	'source.ts': 'TypeScript.tmLanguage.json',
	'source.js': 'JavaScript.tmLanguage.json',
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
	'source.js': ['documentation.injection.js.jsx']
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
		embedded: { 'meta.tag.attributes.js': 'javascript', 'meta.embedded.expression.js': 'javascript' },
		tokenTypes: jsTokenTypes
	},
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

	const themeSources: Record<string, string> = {
		'dark_modern.json': darkModern,
		'dark_plus.json': darkPlus,
		'dark_vs.json': darkVs
	};
	const theme = flattenTheme('dark_modern.json', (p) => {
		const src = themeSources[p];
		if (src === undefined) throw new Error(`theme file not vendored: ${p}`);
		return src;
	});

	const registry = new Registry({
		onigLib,
		theme: { name: theme.name, settings: textMateRules(theme) },
		loadGrammar: async (scopeName) => {
			const file = scopeFiles[scopeName];
			const load = file && grammarFiles[`./grammars/${file}`];
			if (!load) return null; // e.g. a fenced code block in a language we do not ship
			return parseRawGrammar(await load(), file);
		},
		getInjections: (scopeName) => injections[scopeName]
	});

	monaco.editor.defineTheme(THEME_ID, {
		base: 'vs-dark',
		inherit: true,
		rules: [],
		colors: editorColors(theme)
	});
	// Token colors come from the TextMate theme's color map, not Monaco's rules.
	monaco.languages.setColorMap(registry.getColorMap());

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
