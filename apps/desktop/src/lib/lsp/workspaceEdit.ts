// Applying an LSP WorkspaceEdit (VS Code: BulkTextEdits). Pure and I/O-injected so `bun test`
// covers it: callers resolve each URI to a target (an open editor model or a file on disk).
//
// Semantics follow the spec: all edits of one TextDocumentEdit (or one `changes` entry) refer to
// the document as it was before any of them; they must not overlap; inserts at the same position
// apply in array order. Several TextDocumentEdits for one document apply one after another.
// Nothing is written unless every document validates (a failed edit leaves everything as it was).

import type { Position, TextDocumentEdit, TextEdit, WorkspaceEdit } from './protocol';

export type EditGroup = { uri: string; version: number | null; edits: TextEdit[] };

/** `documentChanges` wins over `changes` when both are present (as in VS Code). Resource
 * operations are refused: Kingu advertises `resourceOperations: []`. */
export function editGroups(edit: WorkspaceEdit): EditGroup[] {
	if (edit.documentChanges) {
		return edit.documentChanges.map((c) => {
			if ('kind' in c) throw new Error(`file ${c.kind} operations are not supported`);
			const d = c as TextDocumentEdit;
			return { uri: d.textDocument.uri, version: d.textDocument.version ?? null, edits: d.edits ?? [] };
		});
	}
	return Object.entries(edit.changes ?? {}).map(([uri, edits]) => ({ uri, version: null, edits: edits ?? [] }));
}

/** Offsets where each line starts; a line break is `\n`, `\r\n` or `\r` (LSP's definition). */
export function lineStarts(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c === 13 /* \r */) {
			if (text.charCodeAt(i + 1) === 10) i++;
			starts.push(i + 1);
		} else if (c === 10) starts.push(i + 1);
	}
	return starts;
}

/** UTF-16 offset of an LSP position. A character past the line end means the line end, a line
 * past the last line the end of the text (the spec's clamping rules). */
export function offsetAt(text: string, starts: number[], p: Position): number {
	if (p.line < 0) return 0;
	if (p.line >= starts.length) return text.length;
	const start = starts[p.line];
	let end = p.line + 1 < starts.length ? starts[p.line + 1] : text.length;
	// The line's content stops before its break.
	if (end > start && text.charCodeAt(end - 1) === 10) end--;
	if (end > start && text.charCodeAt(end - 1) === 13) end--;
	return start + Math.max(0, Math.min(p.character, end - start));
}

/** Applies edits that all refer to `text` as given. Throws on overlapping ranges. */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
	const starts = lineStarts(text);
	const spans = edits
		.map((e, i) => ({ start: offsetAt(text, starts, e.range.start), end: offsetAt(text, starts, e.range.end), text: e.newText, i }))
		.sort((a, b) => a.start - b.start || a.end - b.end || a.i - b.i);
	let out = '';
	let at = 0;
	for (const s of spans) {
		if (s.end < s.start) throw new Error('edit range ends before it starts');
		if (s.start < at) throw new Error('overlapping edits');
		out += text.slice(at, s.start) + s.text;
		at = s.end;
	}
	return out + text.slice(at);
}

/** Where one document's edits go. */
export type EditTarget = {
	/** The LSP version of the document when the server knows it as open; checked against
	 * TextDocumentEdit versions. */
	version?: number;
	read(): string | Promise<string>;
	/** `edits` are the original-coordinate edits when exactly one group applied (so a model can
	 * apply them as edit operations, keeping cursor and undo), else null. */
	commit(text: string, edits: TextEdit[] | null): void | Promise<void>;
};

export type ApplyResult = { applied: boolean; failureReason?: string; uris: string[]; edits: number };

/** `resolve` returns a target, or a reason the document cannot be edited (outside the workspace). */
export async function applyWorkspaceEdit(edit: WorkspaceEdit, resolve: (uri: string) => EditTarget | string): Promise<ApplyResult> {
	const fail = (failureReason: string): ApplyResult => ({ applied: false, failureReason, uris: [], edits: 0 });
	let groups: EditGroup[];
	try {
		groups = editGroups(edit);
	} catch (e) {
		return fail(e instanceof Error ? e.message : String(e));
	}
	const byUri = new Map<string, EditGroup[]>();
	for (const g of groups) {
		if (!g.edits.length) continue;
		byUri.set(g.uri, [...(byUri.get(g.uri) ?? []), g]);
	}
	const planned: { target: EditTarget; text: string; edits: TextEdit[] | null }[] = [];
	let count = 0;
	for (const [uri, list] of byUri) {
		const target = resolve(uri);
		if (typeof target === 'string') return fail(target);
		const stale = list.find((g) => g.version !== null && target.version !== undefined && g.version !== target.version);
		if (stale) return fail(`${uri} changed (version ${target.version}, edit for ${stale.version})`);
		try {
			let text = await target.read();
			for (const g of list) text = applyTextEdits(text, g.edits);
			planned.push({ target, text, edits: list.length === 1 ? list[0].edits : null });
			count += list.reduce((n, g) => n + g.edits.length, 0);
		} catch (e) {
			return fail(`${uri}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	for (const [i, p] of planned.entries()) {
		try {
			await p.target.commit(p.text, p.edits);
		} catch (e) {
			const done = i ? ` (${i} of ${planned.length} documents were already changed)` : '';
			return fail(`${e instanceof Error ? e.message : String(e)}${done}`);
		}
	}
	return { applied: true, uris: [...byUri.keys()], edits: count };
}
