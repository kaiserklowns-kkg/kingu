// Markdown → HTML for chat, notes, notebooks and checks (the editor's Markdown preview renders with
// lib/markdown/previewRender.ts, which adds source lines, heading ids, images and math).
import { Marked, type Tokens } from 'marked';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// Raw HTML in the Markdown is shown as text, never parsed: the preview runs in the app's webview,
// so embedded markup must not run script or load anything. Images only show their alt text
// (the CSP blocks remote images anyway); links keep their URL in `data-href` and the preview
// decides what a click does.
const marked = new Marked({
	gfm: true,
	renderer: {
		html: ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text),
		image: ({ text, href }: Tokens.Image) => `<span class="md-image" title="${escapeHtml(href)}">🖼 ${escapeHtml(text || href)}</span>`,
		link({ href, title, tokens }: Tokens.Link) {
			const inner = this.parser.parseInline(tokens);
			return `<a tabindex="0" data-href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${inner}</a>`;
		}
	}
});

export function renderMarkdown(source: string): string {
	return marked.parse(source, { async: false }) as string;
}
