// Where Markdown links point and whether they resolve (VS Code's markdown link resolution and
// `markdown.validate.*` diagnostics). Pure: the workspace's files and the parsed documents are
// passed in. Paths are workspace-relative (`docs/a.md`); `/x` in a link means the workspace root.

import { normalizeRef, type Link, type MdDocument, type Range } from './parse.ts';

export const MD_EXT = /\.(md|mkd|mdwn|mdown|markdown|markdn|mdtxt|mdtext|workbook)$/i;
export const isMarkdownFile = (rel: string) => MD_EXT.test(rel);

export const dirOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
export const baseOf = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);

/** Joins and normalizes `a/b/../c`; null when it climbs above the root. */
export function joinPath(dir: string, path: string): string | null {
	const parts: string[] = [];
	for (const seg of `${dir}/${path}`.split('/')) {
		if (!seg || seg === '.') continue;
		if (seg === '..') {
			if (!parts.length) return null;
			parts.pop();
		} else parts.push(seg);
	}
	return parts.join('/');
}

/** The relative path from folder `fromDir` to `to` (`../img/a.png`). */
export function relativePath(fromDir: string, to: string): string {
	const a = fromDir ? fromDir.split('/') : [];
	const b = to.split('/');
	let i = 0;
	while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
	return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

/** The workspace's files, and the folders that hold them. */
export class FileIndex {
	readonly files: Set<string>;
	readonly dirs = new Set<string>(['']);
	constructor(files: Iterable<string>) {
		this.files = new Set(files);
		for (const f of this.files) for (let d = dirOf(f); d && !this.dirs.has(d); d = dirOf(d)) this.dirs.add(d);
	}
}

export type Target =
	| { kind: 'external'; url: string }
	| { kind: 'fragment'; fragment: string }
	/** `rel`: the file (a Markdown file found without its extension too), `dir`: a folder link. */
	| { kind: 'file'; rel: string; path: string; fragment: string | null; exists: boolean; dir: boolean };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const decode = (s: string) => {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
};

/** Resolves a link target written in `fromRel`. Null for an empty or unusable target. */
export function resolveHref(href: string, fromRel: string, index: FileIndex | null): Target | null {
	const h = href.trim();
	if (!h) return null;
	if (SCHEME.test(h)) return { kind: 'external', url: h };
	if (h.startsWith('#')) return { kind: 'fragment', fragment: decode(h.slice(1)) };
	const hash = h.indexOf('#');
	const fragment = hash >= 0 ? decode(h.slice(hash + 1)) : null;
	const pathPart = decode((hash >= 0 ? h.slice(0, hash) : h).replace(/\?.*$/, ''));
	const rel = pathPart.startsWith('/') ? joinPath('', pathPart) : joinPath(dirOf(fromRel), pathPart);
	if (rel === null) return null;
	if (!index) return { kind: 'file', rel, path: pathPart, fragment, exists: false, dir: false };
	if (index.files.has(rel)) return { kind: 'file', rel, path: pathPart, fragment, exists: true, dir: false };
	if (index.dirs.has(rel)) return { kind: 'file', rel, path: pathPart, fragment, exists: true, dir: true };
	// `[x](./other)` for `other.md`.
	if (!/\.[^/]+$/.test(rel) && index.files.has(`${rel}.md`)) return { kind: 'file', rel: `${rel}.md`, path: pathPart, fragment, exists: true, dir: false };
	return { kind: 'file', rel, path: pathPart, fragment, exists: false, dir: false };
}

/** The target of any link: a reference link through its definition. */
export function linkHref(doc: MdDocument, link: Link): string | null {
	if (link.kind !== 'reference') return link.href;
	return doc.definitions.get(link.ref!)?.[0]?.href ?? null;
}

/** Where the fragment (after `#`) sits in a link's href, or null without one. */
export function fragmentRange(link: Link): Range | null {
	const at = link.href.indexOf('#');
	if (at < 0 || link.hrefRange.start.line !== link.hrefRange.end.line) return null;
	const s = link.hrefRange.start.character + at + 1;
	return { start: { line: link.hrefRange.start.line, character: s }, end: { line: link.hrefRange.start.line, character: link.hrefRange.end.character } };
}

/** Where the path (before `#`/`?`) sits in a link's href. */
export function pathRange(link: Link): Range {
	const cut = link.href.search(/[#?]/);
	const len = cut < 0 ? link.href.length : cut;
	return { start: link.hrefRange.start, end: { line: link.hrefRange.start.line, character: link.hrefRange.start.character + len } };
}

export const slugMatches = (doc: MdDocument, fragment: string) => {
	const f = fragment.toLowerCase();
	// GitHub's line anchors (`#L10`) are not header links.
	return /^l\d+(-l?\d+)?$/.test(f) || doc.headers.some((h) => h.slug.toLowerCase() === f);
};

// --- Validation ----------------------------------------------------------------------------------

export type Level = 'ignore' | 'hint' | 'warning' | 'error';
export type ValidateOptions = {
	referenceLinks: Level;
	fragmentLinks: Level;
	fileLinks: Level;
	/** `inherit` already resolved to fragmentLinks' level. */
	markdownFragmentLinks: Level;
	unusedLinkDefinitions: Level;
	duplicateLinkDefinitions: Level;
	ignoredLinks: string[];
};

export type MdDiagnostic = {
	range: Range;
	level: Exclude<Level, 'ignore'>;
	/** i18n key under `markdown.validate.*` and its parameters. */
	message: 'noSuchReference' | 'noSuchHeader' | 'noSuchFile' | 'noSuchHeaderInFile' | 'unusedDefinition' | 'duplicateDefinition';
	params: Record<string, string>;
	code: string;
};

/** A glob of `markdown.validate.ignoredLinks`: `*` within a segment, `**` across, `?` one char. */
export function globMatches(glob: string, path: string): boolean {
	let re = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*' && glob[i + 1] === '*') {
			re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
			i += glob[i + 2] === '/' ? 2 : 1;
		} else if (c === '*') re += '[^/]*';
		else if (c === '?') re += '[^/]';
		else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${re}$`).test(path);
}

const ignored = (opts: ValidateOptions, href: string) => {
	const noFragment = href.replace(/#.*$/, '');
	return opts.ignoredLinks.some((g) => g === href || g === noFragment || globMatches(g, href) || globMatches(g, noFragment));
};

/**
 * Problems of one document. `docOf` gives other Markdown documents (for `file.md#header`
 * links); it may return null when the file can't be read.
 */
export async function validateDocument(doc: MdDocument, rel: string, index: FileIndex, opts: ValidateOptions, docOf: (rel: string) => Promise<MdDocument | null>): Promise<MdDiagnostic[]> {
	const out: MdDiagnostic[] = [];
	const add = (level: Level, d: Omit<MdDiagnostic, 'level'>) => level !== 'ignore' && out.push({ ...d, level });
	for (const link of doc.links) {
		if (link.kind === 'reference') {
			if (!doc.definitions.has(link.ref!)) add(opts.referenceLinks, { range: link.hrefRange, message: 'noSuchReference', params: { ref: link.ref! }, code: 'link.no-such-reference' });
			continue;
		}
		if (link.kind === 'autolink' || ignored(opts, link.href)) continue;
		const target = resolveHref(link.href, rel, index);
		if (!target || target.kind === 'external') continue;
		if (target.kind === 'fragment') {
			if (!slugMatches(doc, target.fragment)) add(opts.fragmentLinks, { range: fragmentRange(link) ?? link.hrefRange, message: 'noSuchHeader', params: { fragment: target.fragment }, code: 'link.no-such-header' });
			continue;
		}
		if (!target.exists) {
			add(opts.fileLinks, { range: pathRange(link), message: 'noSuchFile', params: { path: target.path }, code: 'link.no-such-file' });
			continue;
		}
		if (target.fragment && !target.dir && isMarkdownFile(target.rel) && opts.markdownFragmentLinks !== 'ignore') {
			const other = target.rel === rel ? doc : await docOf(target.rel);
			if (other && !slugMatches(other, target.fragment))
				add(opts.markdownFragmentLinks, { range: fragmentRange(link) ?? link.hrefRange, message: 'noSuchHeaderInFile', params: { fragment: target.fragment, path: target.path }, code: 'link.no-such-header-in-file' });
		}
	}
	const used = new Set(doc.links.filter((l) => l.kind === 'reference').map((l) => l.ref!));
	for (const [ref, defs] of doc.definitions) {
		if (!used.has(ref)) for (const d of defs) add(opts.unusedLinkDefinitions, { range: d.range, message: 'unusedDefinition', params: { ref }, code: 'link.unused-definition' });
		if (defs.length > 1) for (const d of defs) add(opts.duplicateLinkDefinitions, { range: d.range, message: 'duplicateDefinition', params: { ref }, code: 'link.duplicate-definition' });
	}
	return out;
}

export { normalizeRef };
