// Find All References and Rename for Markdown (VS Code's markdown language service): headers and
// the links to them, links to files, external links; and the link edits a file move needs
// (`markdown.updateLinksOnFileMove.*`). Pure: every Markdown document of the workspace is passed in.

import { linkPath } from './insertLinks.ts';
import { slugify } from './slugify.ts';
import { headerAt, linkAt, type Header, type Link, type MdDocument, type Pos, type Range } from './parse.ts';
import { baseOf, dirOf, fragmentRange, isMarkdownFile, pathRange, relativePath, resolveHref, type FileIndex } from './links.ts';

export type Docs = ReadonlyMap<string, MdDocument>;
export type Location = { rel: string; range: Range };
export type TextEdit = { range: Range; newText: string };
export type FileEdits = Map<string, TextEdit[]>;

const sameSlug = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Links in every document that resolve to file `rel` (and to `fragment` in it, when given). */
function linksTo(docs: Docs, index: FileIndex | null, rel: string, fragment: string | null): Location[] {
	const out: Location[] = [];
	for (const [from, doc] of docs) {
		for (const link of doc.links) {
			if (link.kind === 'reference' || link.kind === 'autolink') continue;
			const t = resolveHref(link.href, from, index);
			if (!t) continue;
			if (t.kind === 'fragment') {
				if (from === rel && fragment !== null && sameSlug(t.fragment, fragment)) out.push({ rel: from, range: fragmentRange(link) ?? link.hrefRange });
			} else if (t.kind === 'file' && t.rel === rel) {
				if (fragment === null) out.push({ rel: from, range: link.hrefRange });
				else if (t.fragment !== null && sameSlug(t.fragment, fragment)) out.push({ rel: from, range: fragmentRange(link) ?? link.hrefRange });
			}
		}
	}
	return out;
}

/** What is under a position: a header, a link's fragment (meaning a header in its target), a
 * link's file path, or an external link. */
export type Subject =
	| { kind: 'header'; rel: string; header: Header }
	| { kind: 'file'; rel: string; link: Link; range: Range }
	| { kind: 'external'; url: string; link: Link };

export function subjectAt(docs: Docs, index: FileIndex | null, rel: string, p: Pos): Subject | null {
	const doc = docs.get(rel);
	if (!doc) return null;
	const h = headerAt(doc, p.line);
	if (h) return { kind: 'header', rel, header: h };
	const link = linkAt(doc, p);
	if (!link || link.kind === 'reference') return null;
	const t = resolveHref(link.href, rel, index);
	if (!t) return null;
	if (t.kind === 'external') return { kind: 'external', url: t.url, link };
	const frag = fragmentRange(link);
	const onFragment = frag !== null && p.character >= frag.start.character - 1;
	const targetRel = t.kind === 'fragment' ? rel : t.rel;
	const fragment = t.kind === 'fragment' ? t.fragment : t.fragment;
	if ((onFragment || t.kind === 'fragment') && fragment !== null) {
		const target = docs.get(targetRel);
		const header = target?.headers.find((x) => sameSlug(x.slug, fragment));
		return header ? { kind: 'header', rel: targetRel, header } : null;
	}
	if (t.kind === 'file') return { kind: 'file', rel: t.rel, link, range: pathRange(link) };
	return null;
}

/** Find All References at a position. `includeDeclaration` adds the header itself. */
export function findReferences(docs: Docs, index: FileIndex | null, rel: string, p: Pos, includeDeclaration = true): Location[] {
	const s = subjectAt(docs, index, rel, p);
	if (!s) return [];
	if (s.kind === 'header') {
		const refs = linksTo(docs, index, s.rel, s.header.slug);
		return includeDeclaration ? [{ rel: s.rel, range: s.header.range }, ...refs] : refs;
	}
	if (s.kind === 'file') return linksTo(docs, index, s.rel, null);
	const out: Location[] = [];
	for (const [from, doc] of docs) for (const l of doc.links) if (l.kind !== 'reference' && l.href === s.url) out.push({ rel: from, range: l.hrefRange });
	return out;
}

/** The range Rename starts with at `p` (the header text, or the link's href), or null. */
export function renameRange(docs: Docs, index: FileIndex | null, rel: string, p: Pos): { range: Range; text: string } | null {
	const doc = docs.get(rel);
	const s = subjectAt(docs, index, rel, p);
	if (!doc || !s) return null;
	if (s.kind === 'header') {
		if (s.rel === rel && headerAt(doc, p.line) === s.header) return { range: s.header.textRange, text: doc.lines[s.header.line].slice(s.header.textRange.start.character, s.header.textRange.end.character) };
		const link = linkAt(doc, p)!;
		const r = fragmentRange(link) ?? link.hrefRange;
		return { range: r, text: doc.lines[r.start.line].slice(r.start.character, r.end.character) };
	}
	if (s.kind === 'external') return { range: s.link.hrefRange, text: s.url };
	return null;
}

const push = (edits: FileEdits, rel: string, e: TextEdit) => edits.set(rel, [...(edits.get(rel) ?? []), e]);

/**
 * Rename at `p`: a header (or a link's fragment naming one) gets new text, and every link to it
 * the new slug; an external link is replaced everywhere. Renaming a header from a link takes the
 * new text as the header's text.
 */
export function renameEdits(docs: Docs, index: FileIndex | null, rel: string, p: Pos, newName: string): FileEdits | null {
	const s = subjectAt(docs, index, rel, p);
	if (!s) return null;
	const edits: FileEdits = new Map();
	if (s.kind === 'header') {
		push(edits, s.rel, { range: s.header.textRange, newText: newName });
		const slug = slugify(newName);
		for (const loc of linksTo(docs, index, s.rel, s.header.slug)) push(edits, loc.rel, { range: loc.range, newText: slug });
		return edits;
	}
	if (s.kind === 'external') {
		for (const [from, doc] of docs) for (const l of doc.links) if (l.kind !== 'reference' && l.href === s.url) push(edits, from, { range: l.hrefRange, newText: newName });
		return edits;
	}
	return null;
}

// --- Link updates on file move ---------------------------------------------------------------

export type Move = { from: string; to: string };

/** Where `rel` is after the moves (a file under a moved folder moves with it), or null if unmoved. */
export function movedPath(rel: string, moves: readonly Move[]): string | null {
	for (const m of moves) {
		if (rel === m.from) return m.to;
		if (rel.startsWith(m.from + '/')) return m.to + rel.slice(m.from.length);
	}
	return null;
}

const encodePath = (p: string) => p.split('/').map((s) => encodeURIComponent(s).replace(/%2B/g, '+').replace(/%40/g, '@')).join('/');

/**
 * The text of a link path to `target` written in `fromRel`, in the style of the old path:
 * root-relative (`/x`) stays so, `./` stays, a dropped `.md` extension stays dropped, and an
 * encoded path (`a%20b`) stays encoded.
 */
export function pathInStyle(oldPath: string, fromRel: string, target: string): string {
	let p = oldPath.startsWith('/') ? '/' + target : relativePath(dirOf(fromRel), target);
	if (!oldPath.startsWith('/') && oldPath.startsWith('./') && !p.startsWith('.')) p = './' + p;
	const lastOld = baseOf(oldPath.replace(/[#?].*$/, ''));
	if (isMarkdownFile(target) && !/\.[^/]+$/.test(lastOld) && lastOld) p = p.replace(/\.[^./]+$/, '');
	return /%[0-9a-f]{2}/i.test(oldPath) ? encodePath(p) : linkPath(p);
}

/**
 * Edits that keep links working after `moves` (already done on disk). `docs` are keyed by the
 * documents' paths before the move; the returned edits by their paths after it.
 */
export function linkEditsForMoves(docs: Docs, before: FileIndex, moves: readonly Move[]): FileEdits {
	const edits: FileEdits = new Map();
	for (const [oldRel, doc] of docs) {
		const newRel = movedPath(oldRel, moves) ?? oldRel;
		for (const link of doc.links) {
			if (link.kind === 'reference' || link.kind === 'autolink') continue;
			const t = resolveHref(link.href, oldRel, before);
			if (!t || t.kind !== 'file') continue;
			const targetNew = movedPath(t.rel, moves);
			// Links in an unmoved document to an unmoved file need nothing.
			if (targetNew === null && newRel === oldRel) continue;
			// A root-relative link from a moved document to an unmoved file still works.
			if (targetNew === null && t.path.startsWith('/')) continue;
			const pr = pathRange(link);
			const oldPath = doc.lines[pr.start.line].slice(pr.start.character, pr.end.character);
			const next = pathInStyle(oldPath, newRel, targetNew ?? t.rel);
			if (next !== oldPath) push(edits, newRel, { range: pr, newText: next });
		}
	}
	return edits;
}
