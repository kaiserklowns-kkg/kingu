// A response's markdown split into prose and code blocks (VS Code's chatMarkdownContentPart renders
// code blocks as their own editors with Copy / Insert at Cursor). Prose goes through the workbench
// Markdown renderer (raw HTML shown as text). With chat.math.enabled, `$…$` / `$$…$$` render with
// KaTeX once it is loaded (as code until then) and ```mermaid blocks become diagrams. Pure, so
// `bun test` covers it.

import { Lexer } from 'marked';
import { markdownRenderer, renderMarkdown } from '#lib/workbench/markdown.ts';
import { mathExtension, type MathRenderer } from '#lib/markdown/previewRender.ts';

export type Segment = { kind: 'markdown'; html: string } | { kind: 'code'; lang: string; code: string } | { kind: 'mermaid'; code: string };

export type SplitOptions = {
	/** chat.math.enabled: math syntax and mermaid diagrams. */
	math?: boolean;
	/** KaTeX's renderer once loaded; math shows as code without it. */
	renderMath?: MathRenderer | null;
};

/** The math renderer for `renderMath`, rebuilt when KaTeX arrives. */
let mathMarkdown: { r: MathRenderer | null; render: (source: string) => string } | null = null;
function proseRenderer(o: SplitOptions): (source: string) => string {
	if (!o.math) return renderMarkdown;
	const r = o.renderMath ?? null;
	if (!mathMarkdown || mathMarkdown.r !== r) mathMarkdown = { r, render: markdownRenderer(mathExtension(() => r)) };
	return mathMarkdown.render;
}

/** Top-level fenced/indented code blocks become `code` segments; everything in between is markdown. */
export function splitMarkdown(text: string, o: SplitOptions = {}): Segment[] {
	const render = proseRenderer(o);
	let tokens;
	try {
		tokens = Lexer.lex(text, { gfm: true });
	} catch {
		return [{ kind: 'markdown', html: render(text) }];
	}
	const out: Segment[] = [];
	let prose = '';
	const flush = () => {
		if (prose.trim()) out.push({ kind: 'markdown', html: render(prose) });
		prose = '';
	};
	for (const tok of tokens) {
		if (tok.type === 'code') {
			flush();
			const lang = (tok.lang ?? '').trim().split(/\s+/)[0] ?? '';
			out.push(o.math && lang.toLowerCase() === 'mermaid' ? { kind: 'mermaid', code: tok.text } : { kind: 'code', lang, code: tok.text });
		} else prose += tok.raw;
	}
	flush();
	return out;
}

export { mayHaveMath } from '#lib/markdown/previewRender.ts';
