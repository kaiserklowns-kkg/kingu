// Drop and paste into a Markdown editor (VS Code's markdown drop/paste providers,
// `markdown.editor.drop.*`, `markdown.editor.filePaste.*`, `markdown.editor.pasteUrlAsFormattedLink.*`):
// the Markdown inserted for files and URLs. Pure.

import { baseOf, dirOf, relativePath } from './links.ts';
import type { MdDocument } from './parse.ts';

const IMAGE = /\.(png|jpe?g|jpe|gif|bmp|webp|avif|svg|ico|tiff?)$/i;
const VIDEO = /\.(mp4|webm|ogv|mov|m4v)$/i;
const AUDIO = /\.(mp3|wav|ogg|oga|m4a|aac|flac)$/i;

export const isImage = (p: string) => IMAGE.test(p);
export const isMedia = (p: string) => IMAGE.test(p) || VIDEO.test(p) || AUDIO.test(p);

const pct = (c: string) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');

/** A path as written in a link: spaces and other characters that end a link are encoded. */
export const linkPath = (p: string) => p.replace(/[ ()<>%[\]]/g, pct);

const escapeText = (s: string) => s.replace(/[[\]\\]/g, '\\$&');
const escapeAttr = (s: string) => s.replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]!);
const title = (p: string) => baseOf(p).replace(/\.[^.]+$/, '');

/**
 * The Markdown for files dropped or pasted into `docRel`: images as `![name](path)`, video and
 * audio as HTML elements, anything else as `[name](path)`. `rel` paths are workspace files
 * (written relative to the document); `abs` ones lie outside it (written as file URLs).
 */
export function markdownForFiles(files: ({ rel: string } | { abs: string })[], docRel: string): string {
	return files
		.map((f) => {
			const path = 'rel' in f ? linkPath(relativePath(dirOf(docRel), f.rel)) : 'file://' + f.abs.split('/').map(encodeURIComponent).join('/');
			const name = 'rel' in f ? f.rel : f.abs;
			if (VIDEO.test(name)) return `<video controls src="${escapeAttr(path)}" title="${escapeAttr(title(name))}"></video>`;
			if (AUDIO.test(name)) return `<audio controls src="${escapeAttr(path)}" title="${escapeAttr(title(name))}"></audio>`;
			return `${IMAGE.test(name) ? '!' : ''}[${escapeText(title(name))}](${path})`;
		})
		.join(' ');
}

export type SmartMode = 'always' | 'smart' | 'never';

/** Inside fenced code, or an open code span on the line before the cursor. */
export function inCode(doc: MdDocument, line: number, prefix: string): boolean {
	if (doc.codeLines.has(line)) return true;
	return ((prefix.match(/`+/g) ?? []).length & 1) === 1;
}

export const createsLinks = (mode: SmartMode, code: boolean) => mode === 'always' || (mode === 'smart' && !code);

const URL_RE = /^(https?|mailto|ftp):\/?\/?[^\s]+$/i;

/**
 * Pasting text: a lone URL becomes `[selection](url)` per `markdown.editor.pasteUrlAsFormattedLink.enabled`;
 * null pastes the text as is. Without a selection the link text is the URL itself.
 */
export function urlPaste(text: string, selection: string, mode: 'always' | 'smart' | 'smartWithSelection' | 'never', code: boolean): string | null {
	const url = text.trim();
	if (!URL_RE.test(url) || mode === 'never') return null;
	if (mode !== 'always' && code) return null;
	if (mode === 'smartWithSelection' && (!selection || selection.includes('\n'))) return null;
	// A selection that is itself a URL is being replaced, not linked.
	if (URL_RE.test(selection.trim())) return null;
	return `[${escapeText(selection || url)}](${url.replace(/[()<>]/g, pct)})`;
}
