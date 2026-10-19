import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import { EXTRA_LANGUAGES, registerMonacoLanguages } from './languages.ts';
import { monacoLoaded } from './monacoConfiguration.ts';
import { captureSymbolProviders } from './symbolProviders.ts';

// Before any language loads: the Outline view asks Monaco's own symbol providers too.
captureSymbolProviders(monaco);

self.MonacoEnvironment = {
	getWorker(_id, label) {
		if (label === 'json') return new JsonWorker();
		if (label === 'typescript' || label === 'javascript') return new TsWorker();
		return new EditorWorker();
	}
};

// Language ids language servers expect. Svelte is highlighted with HTML's TextMate grammar (no
// MIT-licensed Svelte grammar is vendored yet); TSX, JSX, Makefile and Diff with VS Code's
// grammars (textmate/index.ts); TOML with the small Monarch tokenizer below.
for (const lang of EXTRA_LANGUAGES) monaco.languages.register(lang);
registerMonacoLanguages(monaco.languages.getLanguages());

monaco.languages.setLanguageConfiguration('svelte', {
	comments: { blockComment: ['<!--', '-->'] },
	brackets: [['<', '>'], ['{', '}'], ['(', ')'], ['[', ']']],
	autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }, { open: "'", close: "'" }]
});
monaco.languages.setLanguageConfiguration('toml', {
	comments: { lineComment: '#' },
	brackets: [['{', '}'], ['[', ']']],
	autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"' }, { open: "'", close: "'" }]
});
monaco.languages.setMonarchTokensProvider('toml', {
	tokenizer: {
		root: [
			[/#.*$/, 'comment'],
			[/^\s*\[\[?[^\]]*\]\]?/, 'type'],
			[/[A-Za-z0-9_.-]+(?=\s*=)/, 'variable'],
			[/"""/, 'string', '@mlstring'],
			[/'''/, 'string', '@mlliteral'],
			[/"([^"\\]|\\.)*"/, 'string'],
			[/'[^']*'/, 'string'],
			[/\b(true|false)\b/, 'keyword'],
			[/\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?/, 'number'],
			[/[+-]?(0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?|inf|nan)\b/, 'number']
		],
		mlstring: [
			[/"""/, 'string', '@pop'],
			[/./, 'string']
		],
		mlliteral: [
			[/'''/, 'string', '@pop'],
			[/./, 'string']
		]
	}
});

// From VS Code's language-configuration.json of the make, diff and javascript (JSX tags) extensions.
const brackets: monaco.languages.CharacterPair[] = [['{', '}'], ['[', ']'], ['(', ')']];
monaco.languages.setLanguageConfiguration('makefile', {
	comments: { lineComment: '#' },
	brackets,
	autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: "'", close: "'", notIn: ['string', 'comment'] }, { open: '"', close: '"', notIn: ['string', 'comment'] }]
});
monaco.languages.setLanguageConfiguration('diff', { comments: { lineComment: '#', blockComment: ['#', ' '] }, brackets });
monaco.languages.setLanguageConfiguration('jsx-tags', {
	comments: { blockComment: ['{/*', '*/}'] },
	brackets: [...brackets, ['<', '>']],
	autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: "'", close: "'" }, { open: '"', close: '"' }]
});
monaco.languages.setLanguageConfiguration('ignore', { comments: { lineComment: '#' } });
monaco.languages.setMonarchTokensProvider('ignore', {
	tokenizer: {
		root: [
			[/^\s*#.*$/, 'comment'],
			[/^!/, 'keyword']
		]
	}
});

// TSX/JSX edit like TypeScript/JavaScript; .env and .properties like INI (Monaco's definitions).
const borrowed: [string, () => Promise<{ conf: monaco.languages.LanguageConfiguration; language: monaco.languages.IMonarchLanguage }>, boolean][] = [
	['typescriptreact', () => import('monaco-editor/languages/definitions/typescript/typescript.js'), false],
	['javascriptreact', () => import('monaco-editor/languages/definitions/javascript/javascript.js'), false],
	['dotenv', () => import('monaco-editor/languages/definitions/ini/ini.js'), true],
	['properties', () => import('monaco-editor/languages/definitions/ini/ini.js'), true]
];
for (const [id, load, tokens] of borrowed) {
	monaco.languages.onLanguage(id, () => {
		void load().then(({ conf, language }) => {
			monaco.languages.setLanguageConfiguration(id, conf);
			if (tokens) monaco.languages.setMonarchTokensProvider(id, language);
		});
	});
}

// Every contribution is registered now: settings may reach Monaco's configuration service.
monacoLoaded();

export { languageFor } from './languages.ts';
export { monaco };
export { setupTextMate, THEME_ID } from './textmate';
