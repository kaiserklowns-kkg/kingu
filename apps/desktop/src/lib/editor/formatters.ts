// Default formatter (VS Code: editor.defaultFormatter and formatActionsMultiple.ts). Pure: which
// formatter of a document runs. Kingu's formatters are its language servers (named by the server)
// and Monaco's bundled TypeScript/JSON/CSS/HTML ones (no name: "built-in"); a VS Code
// settings.json names extensions, so the bundled VS Code extension ids map to the formatter that
// does their job here.

export type FormatterLike = { displayName?: string };

export const BUILTIN_FORMATTER = 'Kingu (built-in)';

/** VS Code extension ids → the Kingu formatters that stand in for them (language server names). */
const VSCODE_FORMATTERS: Readonly<Record<string, readonly string[]>> = {
	'vscode.typescript-language-features': ['TypeScript language server', BUILTIN_FORMATTER],
	'vscode.json-language-features': ['JSON language server', BUILTIN_FORMATTER],
	'vscode.css-language-features': ['CSS language server', BUILTIN_FORMATTER],
	'vscode.html-language-features': ['HTML language server', BUILTIN_FORMATTER],
	'rust-lang.rust-analyzer': ['rust-analyzer'],
	'golang.go': ['gopls'],
	'svelte.svelte-vscode': ['Svelte language server'],
	'redhat.vscode-yaml': ['YAML language server'],
	'tamasfe.even-better-toml': ['Taplo'],
	'detachhead.basedpyright': ['basedpyright']
};

export const formatterName = (f: FormatterLike) => f.displayName || BUILTIN_FORMATTER;

/** Whether `id` (editor.defaultFormatter) names `f`: its own name, or a VS Code id it stands in for. */
export function matchesFormatterId(f: FormatterLike, id: string): boolean {
	const name = formatterName(f);
	const want = id.trim().toLowerCase();
	return name.toLowerCase() === want || (VSCODE_FORMATTERS[want] ?? []).includes(name);
}

/** What Configure Default Formatter writes: the VS Code id when there is one (so the file means the same in VS Code), else the name. */
export function formatterSettingValue(f: FormatterLike, languageId: string): string {
	const name = formatterName(f);
	const ids = Object.entries(VSCODE_FORMATTERS).filter(([, names]) => names.includes(name)).map(([id]) => id);
	// The built-in one stands in for several extensions: the one for this language.
	const byLanguage: Record<string, string> = { json: 'vscode.json-language-features', jsonc: 'vscode.json-language-features', css: 'vscode.css-language-features', scss: 'vscode.css-language-features', less: 'vscode.css-language-features', html: 'vscode.html-language-features' };
	if (ids.length > 1) return byLanguage[languageId] ?? 'vscode.typescript-language-features';
	return ids[0] ?? name;
}

/**
 * The formatters that count: Monaco's built-in one steps aside when a language server formats the
 * document (it was only the fallback), and one entry per name (a server's document and range
 * formatters are one formatter).
 */
export function formatterCandidates<T extends FormatterLike>(list: readonly T[]): T[] {
	const named = list.some((f) => !!f.displayName);
	const seen = new Set<string>();
	return list.filter((f) => {
		if (named && !f.displayName) return false;
		const name = formatterName(f);
		if (seen.has(name)) return false;
		seen.add(name);
		return true;
	});
}

export type FormatterChoice<T> = { formatter: T } | { problem: 'multiple' | 'unavailable' };

/** VS Code's _analyzeFormatter: the configured default, the only formatter, or why neither. */
export function chooseFormatter<T extends FormatterLike>(list: readonly T[], defaultId: string | null | undefined): FormatterChoice<T> {
	const candidates = formatterCandidates(list);
	if (defaultId?.trim()) {
		// The configured one may be the built-in fallback that formatterCandidates set aside.
		const found = candidates.find((f) => matchesFormatterId(f, defaultId)) ?? list.find((f) => matchesFormatterId(f, defaultId));
		if (found) return { formatter: found };
		// A formatter Kingu has that cannot format this document (VS Code then formats nothing).
		if (isKnownFormatter(defaultId, list)) return { problem: 'unavailable' };
		// An extension Kingu does not have (a VS Code settings.json's esbenp.prettier-vscode): as if unset.
	}
	if (candidates.length === 1) return { formatter: candidates[0] };
	return { problem: 'multiple' };
}

/** A default formatter id Kingu has: a VS Code id it maps, a language server name, or a formatter of this document. */
function isKnownFormatter(id: string, list: readonly FormatterLike[]): boolean {
	const want = id.trim().toLowerCase();
	return want in VSCODE_FORMATTERS || Object.values(VSCODE_FORMATTERS).some((n) => n.some((x) => x.toLowerCase() === want)) || list.some((f) => formatterName(f).toLowerCase() === want);
}
