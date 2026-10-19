// Every document symbol provider registered with Monaco (its bundled TypeScript/JSON/CSS/HTML
// workers and Kingu's language servers), so the Outline view and breadcrumbs can ask them the way
// VS Code's OutlineModel asks every DocumentSymbolProvider of a language. Monaco keeps its
// provider registry private; the registration function is wrapped before any language loads.

import type * as Monaco from 'monaco-editor';

type MonacoApi = typeof Monaco;
type Entry = { selector: Monaco.languages.LanguageSelector; provider: Monaco.languages.DocumentSymbolProvider };

const entries: Entry[] = [];
let installed = false;

/** Call once, before any model is created (monaco.ts). */
export function captureSymbolProviders(monaco: MonacoApi) {
	if (installed) return;
	installed = true;
	const languages = monaco.languages as { registerDocumentSymbolProvider: MonacoApi['languages']['registerDocumentSymbolProvider'] };
	const register = languages.registerDocumentSymbolProvider.bind(monaco.languages);
	languages.registerDocumentSymbolProvider = (selector, provider) => {
		const entry = { selector, provider };
		entries.push(entry);
		const d = register(selector, provider);
		return {
			dispose() {
				const i = entries.indexOf(entry);
				if (i >= 0) entries.splice(i, 1);
				d.dispose();
			}
		};
	};
}

export function selectorMatches(selector: Monaco.languages.LanguageSelector, languageId: string): boolean {
	if (Array.isArray(selector)) return selector.some((s) => selectorMatches(s, languageId));
	if (typeof selector === 'string') return selector === languageId || selector === '*';
	return !(selector as { language?: string }).language || (selector as { language?: string }).language === languageId || (selector as { language?: string }).language === '*';
}

/**
 * The document symbols of `model` from every provider of its language, most recently registered
 * first (Monaco's order); the first provider with an answer wins, as the outline shows one group.
 */
export async function monacoDocumentSymbols(model: Monaco.editor.ITextModel, token: Monaco.CancellationToken): Promise<Monaco.languages.DocumentSymbol[]> {
	const language = model.getLanguageId();
	for (const { selector, provider } of [...entries].reverse()) {
		if (!selectorMatches(selector, language)) continue;
		try {
			const result = await provider.provideDocumentSymbols(model, token);
			if (result?.length) return result;
		} catch {
			/* a worker that is not ready yet: try the next provider */
		}
	}
	return [];
}
