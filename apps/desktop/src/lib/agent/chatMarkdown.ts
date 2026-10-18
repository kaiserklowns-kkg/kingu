// A response's markdown split into prose and code blocks (VS Code's chatMarkdownContentPart renders
// code blocks as their own editors with Copy / Insert at Cursor). Prose goes through the workbench
// Markdown renderer (raw HTML shown as text). Pure, so `bun test` covers it.

import { Lexer } from 'marked';
import { renderMarkdown } from '#lib/workbench/markdown.ts';

export type Segment = { kind: 'markdown'; html: string } | { kind: 'code'; lang: string; code: string };

/** Top-level fenced/indented code blocks become `code` segments; everything in between is markdown. */
export function splitMarkdown(text: string): Segment[] {
	let tokens;
	try {
		tokens = Lexer.lex(text, { gfm: true });
	} catch {
		return [{ kind: 'markdown', html: renderMarkdown(text) }];
	}
	const out: Segment[] = [];
	let prose = '';
	const flush = () => {
		if (prose.trim()) out.push({ kind: 'markdown', html: renderMarkdown(prose) });
		prose = '';
	};
	for (const tok of tokens) {
		if (tok.type === 'code') {
			flush();
			out.push({ kind: 'code', lang: (tok.lang ?? '').trim().split(/\s+/)[0] ?? '', code: tok.text });
		} else prose += tok.raw;
	}
	flush();
	return out;
}
