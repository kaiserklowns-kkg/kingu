// Monaco's standalone service registry and the configuration service id (monacoConfiguration.ts).
declare module 'monaco-editor/editor/standalone/browser/standaloneServices.js' {
	export const StandaloneServices: { get<T>(id: unknown): T };
}
declare module 'monaco-editor/platform/configuration/common/configuration.js' {
	export const IConfigurationService: unknown;
}

// Monaco's per-language Monarch definitions ship without type declarations.
declare module 'monaco-editor/languages/definitions/*.js' {
	import type { languages } from 'monaco-editor';
	export const conf: languages.LanguageConfiguration;
	export const language: languages.IMonarchLanguage;
}

// Monaco internals the settings tests check against (editorOptions.test.ts).
declare module 'monaco-editor/editor/common/config/editorOptions.js' {
	export const EditorOptions: Record<string, { name: string; defaultValue: unknown; validate(input: unknown): unknown }>;
}
declare module 'monaco-editor/editor/common/config/editorConfigurationSchema.js' {}
declare module 'monaco-editor/editor/common/languages/nullTokenize.js' {
	export function nullTokenizeEncoded(languageId: number, state: unknown): { tokens: Uint32Array };
}
declare module 'monaco-editor/platform/registry/common/platform.js' {
	export const Registry: { as<T>(id: string): T };
}
declare module 'monaco-editor/platform/configuration/common/configurationRegistry.js' {
	export const Extensions: { Configuration: string };
}
