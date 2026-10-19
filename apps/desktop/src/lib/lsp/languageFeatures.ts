// LSP ⇄ Monaco conversions for the editor features beyond completion/hover/navigation: inlay
// hints, semantic tokens (with full/delta decoding), folding, code lens, selection ranges, links,
// colors and linked editing. Pure (Monaco values are built by the caller where they are class
// instances) so `bun test` covers them. VS Code: vscode-languageclient's protocolConverter.

import type * as Monaco from 'monaco-editor';
import { markupToMarkdown, toMonacoRange, toMonacoTextEdits } from './convert';
import type {
	CodeLens,
	ColorInformation,
	ColorPresentation,
	Command,
	DocumentLink,
	FoldingRange,
	InlayHint,
	LinkedEditingRanges,
	Location,
	SelectionRange,
	SemanticTokensEdit
} from './protocol';

/** How a server command becomes a Monaco command (code lens, inlay hint label parts). */
export type CommandMapper = (command: Command) => Monaco.languages.Command;
/** An LSP location as Monaco's (a workspace file, or one Monaco cannot open). */
export type LocationMapper = (location: Location) => Monaco.languages.Location;

// --- Inlay hints -----------------------------------------------------------------------------

const tooltipOf = (t: string | { kind: 'markdown' | 'plaintext'; value: string } | undefined) => (typeof t === 'string' ? t : markupToMarkdown(t));

/** LSP InlayHintKind and Monaco's share values (Type 1, Parameter 2). */
export function toInlayHint(h: InlayHint, mapCommand: CommandMapper, mapLocation: LocationMapper): Monaco.languages.InlayHint {
	return {
		position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
		label:
			typeof h.label === 'string'
				? h.label
				: h.label.map((p) => ({
						label: p.value,
						tooltip: tooltipOf(p.tooltip),
						command: p.command && mapCommand(p.command),
						location: p.location && mapLocation(p.location)
					})),
		kind: h.kind === 1 || h.kind === 2 ? (h.kind as Monaco.languages.InlayHintKind) : undefined,
		tooltip: tooltipOf(h.tooltip),
		paddingLeft: h.paddingLeft,
		paddingRight: h.paddingRight,
		textEdits: h.textEdits && toMonacoTextEdits(h.textEdits)
	};
}

// --- Semantic tokens -------------------------------------------------------------------------

/**
 * Applies `full/delta` edits to the previous token data (VS Code: SemanticTokensEdits). Edits are
 * offsets into the previous array, in any order and not overlapping. Throws on an edit outside it,
 * so the caller can ask for the full set again.
 */
export function applySemanticTokensEdits(previous: readonly number[], edits: readonly SemanticTokensEdit[]): number[] {
	const sorted = [...edits].sort((a, b) => a.start - b.start);
	const out: number[] = [];
	let at = 0;
	for (const e of sorted) {
		if (e.start < at || e.start > previous.length || e.deleteCount < 0 || e.start + e.deleteCount > previous.length) throw new Error(`invalid semantic tokens edit at ${e.start}`);
		for (let i = at; i < e.start; i++) out.push(previous[i]);
		if (e.data) for (const v of e.data) out.push(v);
		at = e.start + e.deleteCount;
	}
	for (let i = at; i < previous.length; i++) out.push(previous[i]);
	return out;
}

/** One decoded token: 0-based line and start character. */
export type SemanticToken = { line: number; char: number; length: number; type: number; modifiers: number };

export function decodeSemanticTokens(data: readonly number[]): SemanticToken[] {
	const out: SemanticToken[] = [];
	let line = 0;
	let char = 0;
	for (let i = 0; i + 4 < data.length; i += 5) {
		const dl = data[i];
		line += dl;
		char = dl === 0 ? char + data[i + 1] : data[i + 1];
		out.push({ line, char, length: data[i + 2], type: data[i + 3], modifiers: data[i + 4] });
	}
	return out;
}

export function encodeSemanticTokens(tokens: readonly SemanticToken[]): Uint32Array {
	const out = new Uint32Array(tokens.length * 5);
	let line = 0;
	let char = 0;
	tokens.forEach((t, i) => {
		const dl = t.line - line;
		out[i * 5] = dl;
		out[i * 5 + 1] = dl === 0 ? t.char - char : t.char;
		out[i * 5 + 2] = t.length;
		out[i * 5 + 3] = t.type;
		out[i * 5 + 4] = 0;
		line = t.line;
		char = t.char;
	});
	return out;
}

/**
 * Re-encodes the server's tokens for Monaco with every token's style already resolved: `styleOf`
 * gives the index of a synthetic token type that carries the style (semanticStyle.ts), or -1 for
 * a token the theme leaves unstyled, which is dropped so the TextMate color shows through (VS
 * Code's "no styling"). Modifiers are folded into the type, so Monaco sees none.
 */
export function restyleSemanticTokens(data: readonly number[], styleOf: (type: number, modifiers: number) => number): Uint32Array {
	const kept: SemanticToken[] = [];
	for (const t of decodeSemanticTokens(data)) {
		const style = styleOf(t.type, t.modifiers);
		if (style >= 0) kept.push({ ...t, type: style });
	}
	return encodeSemanticTokens(kept);
}

// --- Folding ---------------------------------------------------------------------------------

/** `kindOf` builds Monaco's FoldingRangeKind (a class) for `comment`/`imports`/`region`. */
export function toFoldingRanges<K>(ranges: FoldingRange[] | null | undefined, kindOf: (kind: string) => K): { start: number; end: number; kind?: K }[] {
	const out: { start: number; end: number; kind?: K }[] = [];
	for (const r of ranges ?? []) {
		if (!(r.endLine > r.startLine) || r.startLine < 0) continue;
		out.push({ start: r.startLine + 1, end: r.endLine + 1, kind: r.kind ? kindOf(r.kind) : undefined });
	}
	return out;
}

// --- Code lens -------------------------------------------------------------------------------

export function toCodeLens(lens: CodeLens, mapCommand: CommandMapper): Monaco.languages.CodeLens {
	return { range: toMonacoRange(lens.range), command: lens.command && mapCommand(lens.command) };
}

// --- Selection ranges ------------------------------------------------------------------------

/** One chain per position, innermost range first (what Monaco's smart select expects). */
export function toSelectionRanges(list: SelectionRange[] | null | undefined): Monaco.languages.SelectionRange[][] {
	return (list ?? []).map((sel) => {
		const chain: Monaco.languages.SelectionRange[] = [];
		for (let s: SelectionRange | undefined = sel; s; s = s.parent) chain.push({ range: toMonacoRange(s.range) });
		return chain;
	});
}

// --- Links, colors, linked editing -----------------------------------------------------------

export function toLinks(list: DocumentLink[] | null | undefined): Monaco.languages.ILink[] {
	return (list ?? []).map((l) => ({ range: toMonacoRange(l.range), url: l.target, tooltip: l.tooltip }));
}

export function toColorInformation(list: ColorInformation[] | null | undefined): Monaco.languages.IColorInformation[] {
	return (list ?? []).map((c) => ({ range: toMonacoRange(c.range), color: { ...c.color } }));
}

export function toColorPresentations(list: ColorPresentation[] | null | undefined): Monaco.languages.IColorPresentation[] {
	return (list ?? []).map((p) => ({
		label: p.label,
		textEdit: p.textEdit && { range: toMonacoRange(p.textEdit.range), text: p.textEdit.newText },
		additionalTextEdits: p.additionalTextEdits && toMonacoTextEdits(p.additionalTextEdits)
	}));
}

/** An LSP word pattern is a JavaScript-style regular expression source; a bad one is ignored. */
export function toLinkedEditingRanges(r: LinkedEditingRanges | null | undefined): Monaco.languages.LinkedEditingRanges | null {
	if (!r?.ranges?.length) return null;
	let wordPattern: RegExp | undefined;
	if (r.wordPattern)
		try {
			wordPattern = new RegExp(r.wordPattern);
		} catch {
			wordPattern = undefined;
		}
	return { ranges: r.ranges.map(toMonacoRange), wordPattern };
}
