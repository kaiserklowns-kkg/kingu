// Monaco's per-language Monarch definitions ship without type declarations.
declare module 'monaco-editor/languages/definitions/*.js' {
	import type { languages } from 'monaco-editor';
	export const conf: languages.LanguageConfiguration;
	export const language: languages.IMonarchLanguage;
}
