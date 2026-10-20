// Snippet files (VS Code snippetsFile.ts): a user `<languageId>.json` holds that language's
// snippets; a `*.code-snippets` file (user, or the folder's `.vscode/`) holds global snippets,
// each optionally limited by `scope`. `include` / `exclude` globs limit a snippet to files. Pure:
// parsing, selection for a language and file, and the completion ranges of VS Code's
// SnippetCompletionProvider.

import { parseJsonc } from '#lib/settings/jsonc.ts';
import { globToRegExp } from '#lib/settings/mappings.ts';
import { parseSnippet, rewriteUnknownVariables, serializeSnippet, snippetText, usesSelection } from './snippetSyntax.ts';

export type SnippetSource = 'user' | 'workspace';

/** Editor tab key of a user snippets file (in the profile's snippets folder, read and saved by Rust). */
export const USER_SNIPPETS_PREFIX = 'snippets://user/';
export const userSnippetsKey = (name: string) => USER_SNIPPETS_PREFIX + name;
/** The file name of a user snippets tab key, or undefined for any other key. */
export const userSnippetsName = (key: string) => (key.startsWith(USER_SNIPPETS_PREFIX) ? key.slice(USER_SNIPPETS_PREFIX.length) : undefined);
/** A workspace snippets file: `.vscode/<name>.code-snippets` (VS Code's folder snippets). */
export const isWorkspaceSnippetsPath = (rel: string) => /^\.vscode\/[^/]+\.code-snippets$/.test(rel);

export type Snippet = {
	name: string;
	/** One trigger word ('' for a snippet without a prefix: Insert Snippet and file templates only). */
	prefix: string;
	description: string;
	/** The body with unknown variables rewritten to placeholders. */
	body: string;
	/** Language ids; empty: every language. */
	scopes: string[];
	isFileTemplate: boolean;
	include?: string[];
	exclude?: string[];
	source: SnippetSource;
	/** The file it came from: `typescript.json`, `.vscode/react.code-snippets`. */
	file: string;
	/** A `<languageId>.json` user file: the snippet belongs to that language only. */
	language?: string;
	usesSelection: boolean;
};

type Raw = { prefix?: unknown; body?: unknown; description?: unknown; scope?: unknown; isFileTemplate?: unknown; include?: unknown; exclude?: unknown };

const strings = (v: unknown): string[] | undefined => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
const isGlobalFile = (file: string) => file.endsWith('.code-snippets');

/** The language a user snippet file is for (`typescript.json` → typescript), or undefined for a global file. */
export function languageOfFile(file: string): string | undefined {
	const name = file.slice(file.lastIndexOf('/') + 1);
	return !isGlobalFile(name) && name.endsWith('.json') ? name.slice(0, -'.json'.length) : undefined;
}

function toSnippets(name: string, raw: Raw, file: string, source: SnippetSource, out: Snippet[]) {
	const body = Array.isArray(raw.body) ? raw.body.filter((x) => typeof x === 'string').join('\n') : raw.body;
	if (typeof body !== 'string') return;
	const language = source === 'user' ? languageOfFile(file) : undefined;
	const scopes = language ? [language] : typeof raw.scope === 'string' ? raw.scope.split(',').map((s) => s.trim()).filter(Boolean) : [];
	const description = Array.isArray(raw.description) ? raw.description.join('\n') : typeof raw.description === 'string' ? raw.description : '';
	const { nodes, changed } = rewriteUnknownVariables(parseSnippet(body));
	const prepared = changed ? serializeSnippet(nodes) : body;
	for (const prefix of strings(raw.prefix) ?? ['']) {
		out.push({
			name,
			prefix,
			description,
			body: prepared,
			scopes,
			isFileTemplate: raw.isFileTemplate === true,
			include: strings(raw.include),
			exclude: strings(raw.exclude),
			source,
			file,
			language,
			usesSelection: usesSelection(body)
		});
	}
}

/**
 * The snippets of one file's text. A file that does not parse yields none and the error (the
 * caller reports it); an entry without a body is skipped, and one level of nesting is accepted
 * (`{ "group": { "name": { … } } }`), like VS Code.
 */
export function parseSnippetFile(text: string, file: string, source: SnippetSource): { snippets: Snippet[]; error?: string } {
	if (!text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()) return { snippets: [] };
	let data: unknown;
	try {
		data = parseJsonc(text);
	} catch (e) {
		return { snippets: [], error: e instanceof Error ? e.message : String(e) };
	}
	if (!data || typeof data !== 'object' || Array.isArray(data)) return { snippets: [], error: 'not a JSON object' };
	const out: Snippet[] = [];
	for (const [name, value] of Object.entries(data as Record<string, unknown>)) {
		if (!value || typeof value !== 'object') continue;
		if ((value as Raw).body) toSnippets(name, value as Raw, file, source, out);
		else for (const [inner, v] of Object.entries(value as Record<string, unknown>)) if (v && typeof v === 'object' && (v as Raw).body) toSnippets(inner, v as Raw, file, source, out);
	}
	return { snippets: out };
}

const matchesGlob = (pattern: string, absPath: string) => {
	const target = pattern.includes('/') ? absPath : absPath.slice(absPath.lastIndexOf('/') + 1);
	return new RegExp(globToRegExp(pattern).source, 'i').test(target);
};

/** `include` / `exclude` (VS Code Snippet.isFileIncluded): a pattern with a `/` matches the full path, else the file name. */
export function isFileIncluded(s: Pick<Snippet, 'include' | 'exclude'>, absPath: string): boolean {
	if (s.exclude?.some((p) => p && matchesGlob(p, absPath))) return false;
	if (s.include) return s.include.some((p) => p && matchesGlob(p, absPath));
	return true;
}

/** Whether a snippet applies to `languageId`; a dotted id also takes its parents' (VS Code _scopeSelect). */
function inScope(s: Snippet, languageId: string): boolean {
	if (!s.scopes.length) return true;
	for (let id = languageId; ; ) {
		if (s.scopes.includes(id)) return true;
		const dot = id.lastIndexOf('.');
		if (dot < 0) return false;
		id = id.slice(0, dot);
	}
}

export type SelectOptions = { fileTemplates?: boolean; includeNoPrefix?: boolean };

/**
 * The snippets for a file in `languageId` (undefined: every language, for Fill File with Snippet),
 * sorted by name. File templates only with `fileTemplates`; prefix-less ones only with `includeNoPrefix`.
 */
export function selectSnippets(all: readonly Snippet[], languageId: string | undefined, absPath: string, opts: SelectOptions = {}): Snippet[] {
	return all
		.filter((s) => (languageId === undefined || inScope(s, languageId)) && (opts.fileTemplates ? s.isFileTemplate : !s.isFileTemplate || !!s.prefix) && (s.prefix || opts.includeNoPrefix) && isFileIncluded(s, absPath))
		.sort((a, b) => a.name.localeCompare(b.name) || a.prefix.localeCompare(b.prefix));
}

/** VS Code's isPatternInWord: the pattern's characters in order in the word (both lower case). */
export function isPatternInWord(pattern: string, word: string): boolean {
	let w = 0;
	for (const c of pattern) {
		w = word.indexOf(c, w);
		if (w < 0) return false;
		w++;
	}
	return true;
}

export type SnippetMatch = { snippet: Snippet; startColumn: number; replaceEndColumn: number };

/**
 * Which snippets the completion list offers at `column` (1-based) of `line`, and from where they
 * replace (VS Code SnippetCompletionProvider): every word start and every character after a word
 * is an anchor; a snippet matches when the text from an anchor to the end of the word at the
 * cursor is a subsequence of its prefix. After whitespace or on an empty line, all snippets.
 * `wordAt(col)` is the word around a 1-based column ({start, end} columns), or null.
 */
export function matchSnippets(snippets: readonly Snippet[], line: string, column: number, wordAt: (col: number) => { start: number; end: number } | null, triggerCharacter?: string): SnippetMatch[] {
	const lineLow = line.toLowerCase();
	const word = wordAt(column) ?? { start: column, end: column };
	const withWord = lineLow.slice(0, word.end - 1);
	const anchors: { start: number; prefix: string }[] = [];
	for (let col = 1; col < word.start; col++) {
		const w = wordAt(col);
		anchors.push({ start: col, prefix: withWord.slice(col - 1) });
		if (w) {
			col = w.end;
			anchors.push({ start: w.end, prefix: withWord.slice(w.end - 1) });
		}
	}
	if (word.end > word.start || !anchors.length) anchors.push({ start: word.start, prefix: withWord.slice(word.start - 1) });
	const trigger = triggerCharacter?.toLowerCase() ?? '';
	const out: SnippetMatch[] = [];
	const left = new Set(snippets);
	for (const s of snippets) {
		const prefixLow = s.prefix.toLowerCase();
		if (!prefixLow) continue;
		if (trigger && !prefixLow.startsWith(trigger)) continue;
		const anchor = anchors.find((a) => !(/^\s/.test(a.prefix) && !/^\s/.test(prefixLow)) && isPatternInWord(a.prefix, prefixLow));
		if (!anchor) continue;
		// When the rest of the prefix is already typed after the cursor, the snippet replaces it too.
		const rest = prefixLow.slice(column - anchor.start);
		out.push({ snippet: s, startColumn: anchor.start, replaceEndColumn: lineLow.startsWith(rest, column - 1) ? column + rest.length : column });
		left.delete(s);
	}
	if (!trigger && (/\s/.test(lineLow[column - 2] ?? '') || !lineLow))
		for (const s of left) if (s.prefix) out.push({ snippet: s, startColumn: column, replaceEndColumn: lineLow.startsWith(s.prefix.toLowerCase(), column - 1) ? column + s.prefix.length : column });
	return out;
}

/** Labels: the prefix, with the name added where two suggestions share one (VS Code _disambiguateSnippets). */
export function snippetLabels(matches: readonly SnippetMatch[]): string[] {
	const count = new Map<string, number>();
	for (const m of matches) count.set(m.snippet.prefix, (count.get(m.snippet.prefix) ?? 0) + 1);
	return matches.map((m) => ((count.get(m.snippet.prefix) ?? 0) > 1 ? `${m.snippet.prefix}, ${m.snippet.name}` : m.snippet.prefix));
}

/** The snippets Tab expands with `editor.tabCompletion` (VS Code TabCompletionController): with an
 * empty selection, those whose prefix ends the non-whitespace text left of the cursor; with a
 * one-line selection of at most 100 characters, those whose prefix is the selected text. */
export function tabCompletionSnippets(snippets: readonly Snippet[], textBeforeCursor: string, selected: string | null): Snippet[] {
	if (selected !== null) return selected && !selected.includes('\n') && selected.length <= 100 ? snippets.filter((s) => s.prefix && s.prefix === selected) : [];
	const prefix = /\S*$/.exec(textBeforeCursor)![0];
	return prefix ? snippets.filter((s) => s.prefix && prefix.endsWith(s.prefix)) : [];
}

/** The suggestion's documentation: what the body inserts. */
export const snippetPreview = (s: Pick<Snippet, 'body'>) => snippetText(parseSnippet(s.body));

/** A starter file for Configure Snippets, with the format explained (VS Code's template, in Kingu's words). */
export function snippetFileTemplate(kind: 'language' | 'global', languageId?: string): string {
	const scope = kind === 'global' ? `\t// "scope": "javascript,typescript" จำกัดภาษา (limits the languages; leave it out for all)\n` : '';
	const lang = languageId ? ` (${languageId})` : '';
	return `{
\t// snippet ของคุณ${lang} ใส่ชื่อ snippet แล้วตามด้วย prefix, body และ description
\t// (Your snippets${lang}: each has a name, a prefix that triggers it, a body and a description.)
\t// ใน body ใช้ $1, $2 เป็นจุดกด Tab, $0 เป็นตำแหน่งสุดท้าย, \${1:label} เป็นค่าเริ่มต้น
\t// (In the body $1, $2 are tab stops, $0 the final cursor, \${1:label} a placeholder.)
${scope}\t// "Print to console": {
\t// \t"prefix": "log",
\t// \t"body": [
\t// \t\t"console.log('$1');",
\t// \t\t"$2"
\t// \t],
\t// \t"description": "Log output to console"
\t// }
}
`;
}

/** A file name the user typed for a new global snippets file: `my snippets` → `my snippets.code-snippets`. */
export function globalSnippetFileName(input: string): string | null {
	const name = input.trim().replace(/\.code-snippets$/i, '');
	if (!name || /[\\/:*?"<>|]/.test(name) || name.startsWith('.')) return null;
	return `${name}.code-snippets`;
}
