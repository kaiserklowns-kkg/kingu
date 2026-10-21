// Path, header and reference completions in Markdown links (VS Code's markdown path completion
// provider, `markdown.suggest.paths.*`). Pure: what is being completed, and the entries of a folder.

import { slugify } from './slugify.ts';
import { dirOf, isMarkdownFile, joinPath, type FileIndex } from './links.ts';

export type CompletionContext =
	/** A path: `typed` up to the cursor; entries come from folder `dir` (relative to the document, or the root with `/`). `from`: the character where the replaced name starts. */
	| { kind: 'path'; dir: string; root: boolean; typed: string; from: number }
	/** `#…`: headers of the document itself (`from` is the character after the `#`); with
	 * `workspace`, also those of every Markdown file (inserted with their path). */
	| { kind: 'header'; from: number; typed: string; workspace: boolean }
	/** `##…`: headers of every Markdown file; `from` is the character of the first `#`. */
	| { kind: 'workspaceHeader'; from: number; typed: string }
	/** `file.md#…`: headers of that file. */
	| { kind: 'fileHeader'; path: string; root: boolean; from: number; typed: string }
	/** `[text][…`: link definition labels. */
	| { kind: 'reference'; from: number; typed: string };

export type HeaderMode = 'never' | 'onDoubleHash' | 'onSingleOrDoubleHash';

/** What the cursor after `prefix` (the line up to the cursor) completes, or null outside a link. */
export function completionContext(prefix: string, mode: HeaderMode = 'onDoubleHash'): CompletionContext | null {
	const ref = /\[[^\]]*\]\[([^\]\s]*)$/.exec(prefix);
	if (ref) return { kind: 'reference', from: prefix.length - ref[1].length, typed: ref[1] };
	const inline = /\]\([ \t]*<?([^\s()<>]*)$/.exec(prefix) ?? /^[ \t]{0,3}\[[^\]]+\]:[ \t]*<?(\S*)$/.exec(prefix) ?? /<(?:img|a|video|audio|source)\b[^>]*\b(?:src|href)=["']([^"'\s]*)$/i.exec(prefix);
	if (!inline) return null;
	const typed = inline[1];
	const start = prefix.length - typed.length;
	if (typed.startsWith('##')) return mode === 'never' ? null : { kind: 'workspaceHeader', from: start, typed: typed.slice(2) };
	if (typed.startsWith('#')) return { kind: 'header', from: start + 1, typed: typed.slice(1), workspace: mode === 'onSingleOrDoubleHash' };
	const hash = typed.indexOf('#');
	if (hash >= 0) {
		const path = typed.slice(0, hash);
		return { kind: 'fileHeader', path, root: path.startsWith('/'), from: start + hash + 1, typed: typed.slice(hash + 1) };
	}
	// Links to the web are not paths.
	if (/^[a-z][a-z0-9+.-]*:/i.test(typed)) return null;
	const slash = typed.lastIndexOf('/');
	return { kind: 'path', dir: slash >= 0 ? typed.slice(0, slash + 1) : '', root: typed.startsWith('/'), typed: typed.slice(slash + 1), from: start + slash + 1 };
}

export type Entry = { name: string; dir: boolean };

/** The files and folders directly in folder `dir` ('' is the root). */
export function folderEntries(index: FileIndex, dir: string): Entry[] {
	const prefix = dir ? dir + '/' : '';
	const out = new Map<string, boolean>();
	for (const f of index.files) {
		if (!f.startsWith(prefix)) continue;
		const rest = f.slice(prefix.length);
		const slash = rest.indexOf('/');
		if (slash < 0) out.set(rest, out.get(rest) ?? false);
		else out.set(rest.slice(0, slash), true);
	}
	return [...out].map(([name, isDir]) => ({ name, dir: isDir })).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

/** The folder a path context lists, relative to the workspace root; null above the root. */
export function contextFolder(ctx: { dir: string; root: boolean }, docRel: string): string | null {
	return joinPath(ctx.root ? '' : dirOf(docRel), decodeURIComponentSafe(ctx.dir));
}

/** The file a `file.md#` context names (the `.md` may be left out). */
export function contextFile(ctx: { path: string; root: boolean }, docRel: string, index: FileIndex): string | null {
	if (!ctx.path) return docRel;
	const rel = joinPath(ctx.root ? '' : dirOf(docRel), decodeURIComponentSafe(ctx.path));
	if (rel === null) return null;
	if (index.files.has(rel)) return rel;
	if (index.files.has(rel + '.md')) return rel + '.md';
	return null;
}

/** How a path to `target` (a Markdown file) is written: `markdown.preferredMdPathExtensionStyle`. */
export function withExtensionStyle(path: string, style: 'auto' | 'includeExtension' | 'removeExtension'): string {
	return style === 'removeExtension' && isMarkdownFile(path) ? path.replace(/\.[^./]+$/, '') : path;
}

export { slugify };

function decodeURIComponentSafe(s: string) {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}
