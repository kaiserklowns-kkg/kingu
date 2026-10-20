// File → language id, the way VS Code's languagesAssociations.ts resolves it: `files.associations`
// first, then the registered associations (exact file name, else the longest matching file name
// pattern, else the longest matching extension; among equals the last registered wins), then the
// first line (shebangs, `<?xml`). Ids are Monaco's (what lsp.rs and Monaco's tokenizers use).
// Pure so `bun test` covers it; monaco.ts registers the ids and adds Monaco's own languages.

import { globToRegExp } from '#lib/settings/mappings.ts';
import { VSCODE_ASSOCIATIONS, type LanguageAssociation } from './languageAssociations.ts';

export type { LanguageAssociation };

/** Languages Kingu registers with Monaco on top of the ones Monaco ships. */
export const EXTRA_LANGUAGES: { id: string; aliases: string[]; extensions?: string[] }[] = [
	{ id: 'svelte', aliases: ['Svelte', 'svelte'], extensions: ['.svelte'] },
	{ id: 'toml', aliases: ['TOML', 'toml'], extensions: ['.toml'] },
	{ id: 'typescriptreact', aliases: ['TypeScript JSX', 'TypeScript React', 'tsx'], extensions: ['.tsx'] },
	{ id: 'javascriptreact', aliases: ['JavaScript JSX', 'JavaScript React', 'jsx'], extensions: ['.jsx'] },
	{ id: 'jsx-tags', aliases: [] },
	{ id: 'makefile', aliases: ['Makefile', 'makefile'] },
	{ id: 'diff', aliases: ['Diff', 'diff'] },
	{ id: 'dotenv', aliases: ['Dotenv', 'dotenv'] },
	{ id: 'properties', aliases: ['Properties', 'properties'] },
	{ id: 'ignore', aliases: ['Ignore', 'ignore'] },
	// The Search Editor's results (VS Code's search-result extension).
	{ id: 'search-result', aliases: ['Search Result', 'search-result'], extensions: ['.code-search'] }
];

/** Associations for Kingu's own languages (VS Code gets these from marketplace extensions). */
const KINGU_ASSOCIATIONS: LanguageAssociation[] = [
	{ id: 'svelte', extensions: ['.svelte'] },
	{ id: 'toml', extensions: ['.toml'], filenames: ['Cargo.lock', 'Pipfile', 'uv.lock', 'poetry.lock'] }
];

/** VS Code's names where they differ from Monaco's first alias (the status bar and pickers show them). */
const VSCODE_NAMES: Record<string, string> = {
	shell: 'Shell Script',
	plaintext: 'Plain Text',
	ini: 'Ini',
	cpp: 'C++',
	csharp: 'C#',
	fsharp: 'F#',
	bat: 'Batch',
	coffee: 'CoffeeScript',
	dockerfile: 'Docker',
	pug: 'Pug',
	vb: 'Visual Basic',
	restructuredtext: 'reStructuredText',
	'objective-c': 'Objective-C'
};

type Item = {
	id: string;
	filename?: string;
	pattern?: string;
	matches?: (target: string) => boolean;
	patternOnPath?: boolean;
	extension?: string;
	firstLine?: RegExp;
};

function itemsOf(list: LanguageAssociation[]): Item[] {
	const items: Item[] = [];
	for (const a of list) {
		for (const e of a.extensions ?? []) items.push({ id: a.id, extension: e.toLowerCase() });
		for (const f of a.filenames ?? []) items.push({ id: a.id, filename: f.toLowerCase() });
		for (const p of a.filenamePatterns ?? []) items.push(patternItem(a.id, p));
		if (a.firstLine) {
			try {
				items.push({ id: a.id, firstLine: new RegExp(a.firstLine) });
			} catch {
				// a pattern JavaScript cannot compile is skipped, as VS Code does
			}
		}
	}
	return items;
}

function patternItem(id: string, pattern: string): Item {
	const lower = pattern.toLowerCase();
	const re = globToRegExp(lower);
	return { id, pattern: lower, matches: (t) => re.test(t), patternOnPath: lower.includes('/') };
}

let registered: Item[] = itemsOf([...VSCODE_ASSOCIATIONS, ...KINGU_ASSOCIATIONS]);
const names = new Map<string, string>();
for (const l of EXTRA_LANGUAGES) if (l.aliases[0]) names.set(l.id, l.aliases[0]);

const knownIds = () => new Set(registered.map((i) => i.id));

/**
 * Adds the languages Monaco registers itself (Kotlin, GraphQL, HCL…) that VS Code has no built-in
 * association for, below VS Code's own (so `.tsx` stays `typescriptreact`), and their names.
 */
export function registerMonacoLanguages(list: { id: string; aliases?: string[]; extensions?: string[]; filenames?: string[] }[]) {
	const known = knownIds();
	const extra = list.filter((l) => !known.has(l.id) && l.id !== 'plaintext');
	registered = [...itemsOf(extra.map((l) => ({ id: l.id, extensions: l.extensions, filenames: l.filenames }))), ...registered];
	for (const l of list) if (!names.has(l.id) && l.aliases?.[0]) names.set(l.id, l.aliases[0]);
}

/** The name VS Code shows for a language id (status bar, Change Language Mode). */
export function languageName(id: string): string {
	return VSCODE_NAMES[id] ?? names.get(id) ?? id;
}

/** Every named language, sorted by name (VS Code: getSortedRegisteredLanguageNames). */
export function languageNames(ids: string[]): { id: string; name: string }[] {
	return [...new Set(ids)]
		.filter((id) => id !== 'jsx-tags')
		.map((id) => ({ id, name: languageName(id) }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

function byPath(path: string, filename: string, items: Item[]): Item | undefined {
	let filenameMatch: Item | undefined;
	let patternMatch: Item | undefined;
	let extensionMatch: Item | undefined;
	for (let i = items.length - 1; i >= 0; i--) {
		const a = items[i];
		if (a.filename !== undefined && a.filename === filename) {
			filenameMatch = a;
			break;
		}
		if (a.pattern && (!patternMatch || a.pattern.length > patternMatch.pattern!.length) && a.matches!(a.patternOnPath ? path : filename)) patternMatch = a;
		if (a.extension && (!extensionMatch || a.extension.length > extensionMatch.extension!.length) && filename.endsWith(a.extension)) extensionMatch = a;
	}
	return filenameMatch ?? patternMatch ?? extensionMatch;
}

export type LanguageOptions = {
	/** `files.associations` (glob → language id). */
	associations?: Readonly<Record<string, string>>;
	/** The file's first line, for shebangs and the like. */
	firstLine?: string;
	/** Whether a language id exists; an association to an unknown id is ignored. */
	known?: (id: string) => boolean;
};

/** VS Code's guessLanguageIdByFilepathOrFirstLine; `plaintext` when nothing matches. */
export function languageFor(path: string, { associations, firstLine, known }: LanguageOptions = {}): string {
	const lowerPath = path.toLowerCase();
	const filename = lowerPath.split('/').pop() ?? lowerPath;
	if (associations) {
		const user = Object.entries(associations)
			.filter(([, id]) => typeof id === 'string' && (!known || known(id)))
			.map(([glob, id]) => patternItem(id, glob));
		const hit = byPath(lowerPath, filename, user);
		if (hit) return hit.id;
	}
	const hit = byPath(lowerPath, filename, registered);
	if (hit) return hit.id;
	const line = firstLine?.replace(/^﻿/, '');
	if (line) {
		for (let i = registered.length - 1; i >= 0; i--) {
			const re = registered[i].firstLine;
			if (re?.test(line)) return registered[i].id;
		}
	}
	return 'plaintext';
}

// JSON files that allow comments (VS Code's `jsonc` files). Monaco has one JSON language (its
// worker allows comments everywhere here), but the JSON language server reports comments as
// errors unless the document's LSP languageId is `jsonc`.
const JSONC_NAME = /^(?:[tj]sconfig(?:\.[^/]*)?\.json|\.eslintrc\.json|\.babelrc|\.?devcontainer\.json|settings\.json|keybindings\.json|tasks\.json|launch\.json|extensions\.json)$/;

/** Monaco ids whose VS Code (LSP) language id differs. */
const LSP_IDS: Record<string, string> = { shell: 'shellscript', coffee: 'coffeescript', pug: 'jade' };

/** The `languageId` a language server is told for a document (`textDocument/didOpen`). */
export function lspLanguageId(languageId: string, path: string): string {
	if (languageId !== 'json') return LSP_IDS[languageId] ?? languageId;
	const name = path.split('/').pop() ?? '';
	return name.toLowerCase().endsWith('.jsonc') || JSONC_NAME.test(name) ? 'jsonc' : 'json';
}
