// How a notebook cell's outputs show (VS Code's notebook output renderers): the richest mime type
// of each output that Kingu can show safely, stream text with carriage returns applied, tracebacks
// without terminal colors. HTML outputs are sanitized (sanitizeHtml): no script, styles, frames,
// forms or event handlers, images only as data: URLs, links opened through link protection.

import { joinSource, type Json } from './notebook';

export type NotebookOutput =
	| { kind: 'stream'; name: string; text: string }
	| { kind: 'text'; text: string }
	| { kind: 'image'; src: string; mime: string }
	| { kind: 'html'; html: string }
	| { kind: 'markdown'; source: string }
	| { kind: 'error'; ename: string; evalue: string; text: string }
	| { kind: 'unsupported'; mimes: string[] };

/** Terminal colors in tracebacks are escape codes, not text. */
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/**
 * What a terminal would show for `text`: `\r` returns to the start of the line (progress bars
 * redraw over themselves), `\b` steps back one character.
 */
export function applyCarriageReturns(text: string): string {
	if (!/[\r\b]/.test(text)) return text;
	return text
		.replace(/\r\n/g, '\n')
		.split('\n')
		.map((line) => {
			const buf: string[] = [];
			let col = 0;
			for (const ch of line) {
				if (ch === '\r') col = 0;
				else if (ch === '\b') col = Math.max(0, col - 1);
				else buf[col++] = ch;
			}
			return buf.join('');
		})
		.join('\n');
}

const RASTER = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** Richest first, like Jupyter's display order. */
const ORDER = ['text/html', 'image/svg+xml', ...RASTER, 'text/markdown', 'application/json', 'text/latex', 'text/plain'];

export function displayOutput(o: Json): NotebookOutput {
	if (o.output_type === 'stream') return { kind: 'stream', name: String(o.name ?? 'stdout'), text: stripAnsi(applyCarriageReturns(joinSource(o.text))) };
	if (o.output_type === 'error') {
		const tb = Array.isArray(o.traceback) ? o.traceback.map(String).join('\n') : '';
		return { kind: 'error', ename: String(o.ename ?? ''), evalue: String(o.evalue ?? ''), text: stripAnsi(tb || `${o.ename}: ${o.evalue}`) };
	}
	const data = (typeof o.data === 'object' && o.data !== null ? o.data : {}) as Json;
	const mime = ORDER.find((m) => data[m] !== undefined);
	const value = mime ? data[mime] : undefined;
	switch (mime) {
		case 'text/html':
			return { kind: 'html', html: sanitizeHtml(joinSource(value)) };
		case 'image/svg+xml':
			// As an <img>, an SVG cannot run script or load anything.
			return { kind: 'image', mime, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(joinSource(value))}` };
		case 'text/markdown':
			return { kind: 'markdown', source: joinSource(value) };
		case 'application/json':
			return { kind: 'text', text: JSON.stringify(value, null, 2) };
		case 'text/latex':
		case 'text/plain':
			return { kind: 'text', text: stripAnsi(joinSource(value)) };
		case undefined:
			return { kind: 'unsupported', mimes: Object.keys(data) };
		default:
			// Base64 payloads may be split into lines.
			return { kind: 'image', mime, src: `data:${mime};base64,${joinSource(value).replace(/\s/g, '')}` };
	}
}

/** The plain text of an output, for copying and the Accessible View. */
export function outputText(o: NotebookOutput): string {
	switch (o.kind) {
		case 'stream':
		case 'text':
		case 'error':
			return o.text;
		case 'markdown':
			return o.source;
		case 'html':
			return decodeEntities(o.html.replace(/<[^>]*>/g, ''));
		case 'image':
			return `[${o.mime}]`;
		case 'unsupported':
			return `[${o.mimes.join(', ')}]`;
	}
}

// --- HTML sanitizer ------------------------------------------------------------------------------

const ALLOWED_TAGS = new Set(
	(
		'a abbr b bdi bdo blockquote br caption center cite code col colgroup dd del details dfn div dl dt em figcaption figure font h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q rp rt ruby s samp small span strong sub summary sup table tbody td tfoot th thead time tr tt u ul var wbr'
	).split(' ')
);
/** Dropped with everything inside them. */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'textarea', 'title', 'head', 'select', 'svg', 'math', 'frameset', 'noembed', 'xmp', 'plaintext']);
const VOID = new Set(['br', 'col', 'hr', 'img', 'wbr']);
const ALLOWED_ATTRS = new Set(['title', 'class', 'align', 'valign', 'colspan', 'rowspan', 'span', 'border', 'cellpadding', 'cellspacing', 'width', 'height', 'alt', 'src', 'href', 'style', 'start', 'type', 'reversed', 'open', 'scope', 'abbr', 'datetime', 'dir', 'lang', 'color', 'face', 'size', 'headers', 'bgcolor']);
/** Inline styles that could reach the network, run anything or cover the app's UI. */
const UNSAFE_STYLE = /url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:|-moz-binding|position\s*:\s*(fixed|absolute|sticky)|\\/i;

export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e: string) => {
		if (e[0] === '#') {
			const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
		}
		return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', tab: '\t', newline: '\n' } as Record<string, string>)[e.toLowerCase()] ?? m;
	});
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A URL with whitespace and control characters taken out (as browsers do before reading the scheme). */
const bareUrl = (s: string) => decodeEntities(s).replace(/[\u0000- \u007f-\u009f]/g, '');

function safeAttr(tag: string, name: string, value: string): string | null {
	if (!ALLOWED_ATTRS.has(name)) return null;
	if (name === 'src') {
		const url = bareUrl(value);
		return tag === 'img' && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(url) ? ` src="${escapeAttr(url)}"` : null;
	}
	if (name === 'href') {
		const url = bareUrl(value);
		// Clicks go through the editor (outgoing link protection), never straight to the webview.
		return tag === 'a' && /^(https?:|mailto:)/i.test(url) ? ` data-href="${escapeAttr(url)}"` : null;
	}
	if (name === 'class') {
		// Prefixed, so an output's classes never pick up the app's own styles (`fixed inset-0`…).
		const classes = decodeEntities(value).split(/\s+/).filter((c) => /^[\w-]+$/.test(c));
		return classes.length ? ` class="${classes.map((c) => `nb-${c}`).join(' ')}"` : null;
	}
	if (name === 'style') {
		const css = decodeEntities(value);
		return UNSAFE_STYLE.test(css) ? null : ` style="${escapeAttr(css)}"`;
	}
	return ` ${name}="${escapeAttr(decodeEntities(value))}"`;
}

const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Keeps a safe subset of `html` (see the file comment); everything else is dropped or escaped. */
export function sanitizeHtml(html: string): string {
	let out = '';
	let i = 0;
	const open: string[] = [];
	while (i < html.length) {
		const lt = html.indexOf('<', i);
		if (lt < 0) {
			out += html.slice(i).replace(/>/g, '&gt;');
			break;
		}
		out += html.slice(i, lt).replace(/>/g, '&gt;');
		i = lt;
		if (html.startsWith('<!--', i)) {
			const end = html.indexOf('-->', i + 4);
			i = end < 0 ? html.length : end + 3;
			continue;
		}
		if (/^<[!?]/.test(html.slice(i, i + 2))) {
			const end = html.indexOf('>', i);
			i = end < 0 ? html.length : end + 1;
			continue;
		}
		const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(html.slice(i));
		if (!m) {
			out += '&lt;';
			i++;
			continue;
		}
		i += m[0].length;
		const closing = m[1] === '/';
		const tag = m[2].toLowerCase();
		if (DROP_WITH_CONTENT.has(tag)) {
			if (!closing && !/\/\s*$/.test(m[3])) {
				const close = new RegExp(`</${tag}\\s*>`, 'i').exec(html.slice(i));
				i = close ? i + close.index + close[0].length : html.length;
			}
			continue;
		}
		if (!ALLOWED_TAGS.has(tag)) continue;
		if (closing) {
			const at = open.lastIndexOf(tag);
			if (at < 0) continue;
			// Closes what was left open inside it too.
			for (const t of open.splice(at).reverse()) out += `</${t}>`;
			continue;
		}
		let attrs = '';
		for (const a of m[3].matchAll(ATTR)) {
			const name = a[1].toLowerCase();
			const safe = safeAttr(tag, name, a[2] ?? a[3] ?? a[4] ?? '');
			if (safe) attrs += safe;
		}
		out += `<${tag}${attrs}>`;
		if (!VOID.has(tag)) open.push(tag);
	}
	for (const t of open.reverse()) out += `</${t}>`;
	return out;
}
