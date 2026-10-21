// Markdown → HTML for the Markdown preview (VS Code's markdown-it engine, here `marked`), with the
// `markdown.preview.*` options, source line numbers on blocks (`data-line`, 0-based, for scroll
// sync and double-click to source), GitHub-style heading ids and `$…$` / `$$…$$` math.
//
// Raw HTML in the Markdown is shown as text, never parsed: the preview runs in the app's webview,
// so embedded markup must not run script or load anything. Links keep their URL in `data-href`
// and images theirs in `data-src`; the preview decides what a click does and which images load.
import { Marked, Renderer, type MarkedExtension, type Token, type Tokens, type TokensList } from 'marked';
import { Slugs } from './slugify.ts';

export type PreviewOptions = {
	/** markdown.preview.breaks: a newline inside a paragraph is a `<br>`. */
	breaks: boolean;
	/** markdown.preview.linkify: bare URLs (`www.x.com`, `https://…`) become links. */
	linkify: boolean;
	/** markdown.preview.typographer: smart quotes, dashes, ellipsis, (c) (r) (tm). */
	typographer: boolean;
	/** markdown.math.enabled */
	math: boolean;
};

/** KaTeX's renderToString, once it is loaded (the preview loads it only for documents with math). */
export type MathRenderer = (tex: string, displayMode: boolean) => string;

export const DEFAULT_PREVIEW_OPTIONS: PreviewOptions = { breaks: false, linkify: true, typographer: false, math: true };

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type MathToken = { type: 'mathBlock' | 'mathInline'; raw: string; text: string };
/** Token fields this module adds: the 0-based source line of a block. */
type Lined = { line?: number };

// --- Math ----------------------------------------------------------------------------------------

/** `$$…$$` blocks and `$…$` inline math (the markdown-math extension's syntax). */
function mathExtension(render: () => MathRenderer | null): MarkedExtension {
	const out = (text: string, display: boolean) => {
		const r = render();
		if (r) return r(text, display);
		return display ? `<pre class="md-math"><code>${escapeHtml(text)}</code></pre>` : `<code class="md-math">${escapeHtml(text)}</code>`;
	};
	return {
		extensions: [
			{
				name: 'mathBlock',
				level: 'block',
				start: (src) => src.match(/^ {0,3}\$\$/m)?.index,
				tokenizer(src) {
					const m = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n+|$)/.exec(src);
					if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
				},
				renderer: (t) => `<div class="md-math-block">${out((t as unknown as MathToken).text, true)}</div>\n`
			},
			{
				name: 'mathInline',
				level: 'inline',
				start: (src) => src.indexOf('$') >= 0 ? src.indexOf('$') : undefined,
				tokenizer(src) {
					// `$$…$$` inline is display math; `$…$` needs no space inside its delimiters and no digit
					// after (so "$5 and $6" stays text).
					const m = /^\$\$([^$]+?)\$\$/.exec(src) ?? /^\$(?![\s$])((?:\\\$|[^$\n])+?)(?<![\s\\])\$(?!\d)/.exec(src);
					if (m) return { type: 'mathInline', raw: m[0], text: m[1].trim(), display: m[0].startsWith('$$') } as Tokens.Generic;
				},
				renderer: (t) => out((t as unknown as MathToken).text, !!(t as { display?: boolean }).display)
			}
		]
	};
}

/** Whether `source` may hold math, so the preview knows to load KaTeX first. */
export const mayHaveMath = (source: string) => /\$[^$\n]+\$|^ {0,3}\$\$/m.test(source);

// --- Typographer ---------------------------------------------------------------------------------

/** markdown-it's typographer replacements plus smart quotes. `before`: the character before the text. */
export function typographer(text: string, before = ''): string {
	let s = text
		.replace(/\((c|C)\)/g, '©')
		.replace(/\((r|R)\)/g, '®')
		.replace(/\((tm|TM)\)/g, '™')
		.replace(/\.\.\./g, '…')
		.replace(/(^|[^-])---(?=[^-]|$)/gm, '$1—')
		.replace(/(^|[^-])--(?=[^-]|$)/gm, '$1–')
		.replace(/\+-/g, '±');
	let out = '';
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		const prev = i ? s[i - 1] : before;
		// An opening quote follows the start, whitespace or an opening bracket; anything else closes.
		const opening = !prev || /[\s([{—–-]/.test(prev);
		if (c === '"') out += opening ? '“' : '”';
		else if (c === "'") out += opening ? '‘' : '’';
		else out += c;
	}
	s = out;
	return s;
}

// --- Source lines --------------------------------------------------------------------------------

const lineAt = (src: string, offset: number) => {
	let n = 0;
	for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
	return n;
};

/**
 * Sets `line` (0-based source line) on every top-level block token and every list item, nested
 * ones included. A token's raw text is found from where the previous one ended; a token whose raw
 * text is not found verbatim (marked strips list indentation) is looked up by its first line.
 */
export function assignLines(src: string, tokens: Token[], startLine = 0): void {
	let at = 0;
	for (const t of tokens) {
		if (!t.raw) continue;
		let i = src.indexOf(t.raw, at);
		if (i < 0) {
			const first = t.raw.split('\n')[0].trim();
			i = first ? src.indexOf(first, at) : -1;
		}
		if (i < 0) continue;
		const line = startLine + lineAt(src, i);
		(t as Lined).line = line;
		if (t.type === 'list') {
			const sub = src.slice(i);
			let itemAt = 0;
			for (const item of (t as Tokens.List).items) {
				const first = item.raw.split('\n')[0].trim();
				const j = sub.indexOf(first, itemAt);
				if (j < 0) continue;
				(item as Lined).line = line + lineAt(sub, j);
				// The item's nested lists come after its first line.
				assignLines(sub.slice(j + first.length), item.tokens.filter((x) => x.type === 'list'), (item as Lined).line);
				itemAt = j + first.length;
			}
		}
		at = i + t.raw.length;
	}
}

/** Adds `data-line` to the first tag of `html`. */
const withLine = (html: string, line: number | undefined) => (line === undefined ? html : html.replace(/^(\s*<[a-zA-Z][a-zA-Z0-9]*)/, `$1 data-line="${line}"`));

// --- Rendering -----------------------------------------------------------------------------------

/** Walks inline tokens: linkify off turns bare URLs back into text; the typographer rewrites text. */
function adjustInline(tokens: Token[] | undefined, opts: PreviewOptions, state: { last: string }) {
	if (!tokens) return;
	for (const t of tokens) {
		if (!opts.linkify && t.type === 'link' && (t as Tokens.Link & { autolink?: boolean }).autolink && !t.raw.startsWith('<')) {
			const text = t as unknown as Tokens.Text;
			Object.assign(t, { type: 'text', text: t.raw, escaped: false });
			delete (text as { tokens?: Token[] }).tokens;
		}
		if (t.type === 'codespan' || t.type === 'code' || t.type === 'html' || t.type === 'mathInline' || t.type === 'mathBlock') {
			state.last = 'x';
			continue;
		}
		if (t.type === 'text' && !(t as Tokens.Text).tokens) {
			const text = t as Tokens.Text;
			if (opts.typographer && !text.escaped) text.text = typographer(text.text, state.last);
			if (text.text) state.last = text.text[text.text.length - 1];
			continue;
		}
		const nested = t as { tokens?: Token[]; items?: Token[] };
		adjustInline(nested.tokens, opts, state);
		adjustInline(nested.items, opts, state);
	}
}

/** The preview's HTML for `source`. `math`: KaTeX when loaded (else math shows as code). */
export function renderPreview(source: string, opts: PreviewOptions = DEFAULT_PREVIEW_OPTIONS, math: MathRenderer | null = null): string {
	const src = source.replace(/\r\n?/g, '\n');
	const slugs = new Slugs();
	const marked = new Marked({
		gfm: true,
		breaks: opts.breaks,
		renderer: {
			html: ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text),
			image: ({ text, href, title }: Tokens.Image) =>
				`<img class="md-image" alt="${escapeHtml(text)}" data-src="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''}>`,
			link({ href, title, tokens }: Tokens.Link) {
				const inner = this.parser.parseInline(tokens);
				return `<a tabindex="0" data-href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${inner}</a>`;
			},
			heading({ tokens, depth, text }: Tokens.Heading) {
				return `<h${depth} id="${escapeHtml(slugs.next(text))}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
			},
			listitem(item: Tokens.ListItem) {
				return withLine(Renderer.prototype.listitem.call(this, item) as string, (item as Lined).line);
			}
		}
	});
	if (opts.math) marked.use(mathExtension(() => math));
	const tokens: TokensList = marked.lexer(src);
	assignLines(src, tokens);
	const state = { last: '' };
	for (const t of tokens) adjustInline([t], opts, state);
	let html = '';
	for (const t of tokens) {
		if (t.type === 'space' || t.type === 'def') continue;
		const one = Object.assign([t], { links: tokens.links }) as TokensList;
		html += withLine(marked.parser(one) as string, (t as Lined).line);
	}
	return html;
}
