import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import { EXTRA_LANGUAGES } from './languages.ts';

self.MonacoEnvironment = {
	getWorker(_id, label) {
		if (label === 'json') return new JsonWorker();
		if (label === 'typescript' || label === 'javascript') return new TsWorker();
		return new EditorWorker();
	}
};

// Language ids language servers expect. Svelte is highlighted with HTML's TextMate grammar (no
// MIT-licensed Svelte grammar is vendored yet); TOML with the small Monarch tokenizer below.
for (const lang of EXTRA_LANGUAGES) monaco.languages.register(lang);
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

export { languageFor } from './languages.ts';
export { monaco };
export { setupTextMate, THEME_ID } from './textmate';
