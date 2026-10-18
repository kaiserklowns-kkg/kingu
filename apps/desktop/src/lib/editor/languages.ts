// File → Monaco language id (VS Code: each language's `contributes.languages`). Pure so `bun test`
// can cover it; monaco.ts registers the ids Monaco does not ship.

const byExtension: Record<string, string> = {
	ts: 'typescript',
	mts: 'typescript',
	cts: 'typescript',
	js: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	svelte: 'svelte',
	rs: 'rust',
	go: 'go',
	json: 'json',
	jsonc: 'json',
	toml: 'toml',
	md: 'markdown',
	css: 'css',
	scss: 'scss',
	less: 'less',
	html: 'html',
	htm: 'html',
	py: 'python',
	pyi: 'python',
	yaml: 'yaml',
	yml: 'yaml'
};

export function languageFor(path: string): string {
	const name = path.split('/').pop() ?? '';
	const dot = name.lastIndexOf('.');
	return (dot > 0 && byExtension[name.slice(dot + 1).toLowerCase()]) || 'plaintext';
}

/** Ids Kingu adds to Monaco (it ships `python`, `yaml`, `scss`, `less`, … itself). */
export const EXTRA_LANGUAGES = [
	{ id: 'svelte', extensions: ['.svelte'], aliases: ['Svelte', 'svelte'] },
	{ id: 'toml', extensions: ['.toml'], aliases: ['TOML', 'toml'] }
];

// JSON files that allow comments (VS Code's `jsonc` files). Monaco has one JSON language (its
// worker allows comments everywhere here), but the JSON language server reports comments as
// errors unless the document's LSP languageId is `jsonc`.
const JSONC_NAME = /^(?:[tj]sconfig(?:\.[^/]*)?\.json|\.eslintrc\.json|\.babelrc|\.?devcontainer\.json|settings\.json|keybindings\.json|tasks\.json|launch\.json|extensions\.json)$/;

/** The `languageId` a language server is told for a document (`textDocument/didOpen`). */
export function lspLanguageId(languageId: string, path: string): string {
	if (languageId !== 'json') return languageId;
	const name = path.split('/').pop() ?? '';
	return name.toLowerCase().endsWith('.jsonc') || JSONC_NAME.test(name) ? 'jsonc' : 'json';
}
