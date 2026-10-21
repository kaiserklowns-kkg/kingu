import { t } from '#lib/i18n/index.ts';
import type { DocumentSymbol } from '#lib/lsp/protocol.ts';
// Jupyter notebooks (.ipynb, nbformat 4) for the notebook editor (VS Code's ipynb extension:
// deserializers.ts / serializers.ts). A document keeps every field it does not edit (notebook and
// cell metadata, attachments, unknown keys), so saving changes only what was edited. Saved JSON is
// VS Code's: keys sorted at every level, the file's own indent (one space by default), sources and
// text outputs split into lines, a trailing newline.
//
// Cell edits are operations with an inverse, so the editor can undo them (VS Code's notebook undo:
// insert, delete, move, split, join, change type, clear outputs). Typing inside a cell is the cell
// editor's own undo.

export type Json = Record<string, unknown>;
export type CellKind = 'code' | 'markdown' | 'raw';

export type NbCell = {
	/** Stable within the editor; also the nbformat 4.5 `id` when the notebook has cell ids. */
	key: string;
	kind: CellKind;
	source: string;
	/** nbformat outputs as saved (code cells). */
	outputs: Json[];
	count: number | null;
	metadata: Json;
	/** Other cell fields (attachments, unknown keys), written back untouched. */
	rest: Json;
};

export type NbDocument = {
	cells: NbCell[];
	metadata: Json;
	nbformat: number;
	minor: number;
	/** The file's JSON indent, kept on save. */
	indent: string;
	/** Other top-level fields. */
	rest: Json;
};

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
/** nbformat's multiline strings: a string or a list of lines. */
export const joinSource = (v: unknown): string => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '');

/** A string as nbformat lines, each keeping its newline (`'a\nb'` → `['a\n', 'b']`). */
export function splitLines(s: string): string[] {
	const out: string[] = [];
	let start = 0;
	for (let i = 0; i < s.length; i++) {
		if (s[i] === '\n') {
			out.push(s.slice(start, i + 1));
			start = i + 1;
		}
	}
	if (start < s.length) out.push(s.slice(start));
	return out;
}

let seq = 0;
/** A new cell id (nbformat 4.5: 1–64 of `[a-zA-Z0-9-_]`). */
export function newCellId(): string {
	const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '').slice(0, 12) : Math.random().toString(16).slice(2, 14);
	return `${rand}${(seq++).toString(36)}`;
}

/** Cell ids are saved from nbformat 4.5 on. */
export const hasCellIds = (doc: Pick<NbDocument, 'nbformat' | 'minor'>) => doc.nbformat > 4 || (doc.nbformat === 4 && doc.minor >= 5);

/** The leading whitespace of the first indented line (VS Code's detectIndent on the first 1000 characters). */
export function detectIndent(text: string): string {
	const m = /\n([ \t]+)\S/.exec(text.slice(0, 1000));
	return m ? m[1] : ' ';
}

export function newCell(kind: CellKind, source = ''): NbCell {
	return { key: newCellId(), kind, source, outputs: [], count: null, metadata: {}, rest: {} };
}

/** An empty notebook (an empty `.ipynb` file opens as one, with a code cell). */
export function emptyNotebook(): NbDocument {
	return { cells: [newCell('code')], metadata: {}, nbformat: 4, minor: 5, indent: ' ', rest: {} };
}

export function parseNotebookDocument(text: string): NbDocument {
	if (!text.trim()) return emptyNotebook();
	const nb = JSON.parse(text) as unknown;
	if (!isObj(nb) || !Array.isArray(nb.cells)) throw new Error(t('workbench.notebook.notV4'));
	const { cells, metadata, nbformat, nbformat_minor, ...rest } = nb;
	const doc: NbDocument = {
		cells: [],
		metadata: isObj(metadata) ? metadata : {},
		nbformat: typeof nbformat === 'number' ? nbformat : 4,
		minor: typeof nbformat_minor === 'number' ? nbformat_minor : 0,
		indent: detectIndent(text),
		rest
	};
	const seen = new Set<string>();
	for (const raw of cells as unknown[]) {
		if (!isObj(raw)) continue;
		const { cell_type, source, outputs, execution_count, metadata: cm, id, ...cellRest } = raw;
		const kind: CellKind = cell_type === 'markdown' ? 'markdown' : cell_type === 'raw' ? 'raw' : 'code';
		// Duplicate or missing ids get a fresh one (nbformat's validator does the same).
		let key = typeof id === 'string' && id && !seen.has(id) ? id : newCellId();
		while (seen.has(key)) key = newCellId();
		seen.add(key);
		doc.cells.push({
			key,
			kind,
			source: joinSource(source),
			outputs: kind === 'code' && Array.isArray(outputs) ? outputs.filter(isObj) : [],
			count: typeof execution_count === 'number' ? execution_count : null,
			metadata: isObj(cm) ? cm : {},
			rest: cellRest
		});
	}
	return doc;
}

/** Mime types nbformat stores as lines (nbformat.v4 `_split_mime`): text, JavaScript and SVG. */
const splitsMime = (mime: string) => (mime.startsWith('text/') || mime === 'application/javascript' || mime === 'image/svg+xml') && !mime.endsWith('json');

function outputForDisk(o: Json): Json {
	const out: Json = { ...o };
	if (o.output_type === 'stream') out.text = splitLines(joinSource(o.text));
	if (isObj(o.data)) {
		const data: Json = {};
		for (const [mime, v] of Object.entries(o.data)) data[mime] = splitsMime(mime) && (typeof v === 'string' || Array.isArray(v)) ? splitLines(joinSource(v)) : v;
		out.data = data;
	}
	return out;
}

function cellForDisk(c: NbCell, ids: boolean): Json {
	const out: Json = { ...c.rest, cell_type: c.kind, metadata: c.metadata, source: splitLines(c.source) };
	if (ids) out.id = c.key;
	if (c.kind === 'code') {
		out.execution_count = c.count;
		out.outputs = c.outputs.map(outputForDisk);
	}
	return out;
}

/** VS Code's sortObjectPropertiesRecursively. */
export function sortKeys(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(sortKeys);
	if (isObj(v)) {
		const out: Json = {};
		for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
		return out;
	}
	return v;
}

/** The notebook as `.ipynb` text (see the file comment for the format). */
export function serializeNotebook(doc: NbDocument): string {
	const ids = hasCellIds(doc);
	const nb = { ...doc.rest, cells: doc.cells.map((c) => cellForDisk(c, ids)), metadata: doc.metadata, nbformat: doc.nbformat, nbformat_minor: doc.minor };
	return JSON.stringify(sortKeys(nb), undefined, doc.indent) + '\n';
}

/** The notebook's language: `language_info.name`, else the kernelspec's, else python. */
export function notebookLanguage(doc: Pick<NbDocument, 'metadata'>): string {
	const meta = doc.metadata;
	const info = isObj(meta.language_info) ? meta.language_info : {};
	const spec = isObj(meta.kernelspec) ? meta.kernelspec : {};
	return String(info.name ?? spec.language ?? 'python');
}

export const isNotebookPath = (key: string) => !key.includes(':') && /\.ipynb$/i.test(key);

// --- Edits ---------------------------------------------------------------------------------------

export type NotebookOp =
	| { op: 'insert'; index: number; cells: NbCell[] }
	| { op: 'delete'; index: number; count: number }
	/** Moves `count` cells at `from` so the first lands at `to` (an index after the move). */
	| { op: 'move'; from: number; count: number; to: number }
	| { op: 'replace'; index: number; cell: NbCell }
	| { op: 'outputs'; key: string; outputs: Json[]; count: number | null };

/** Applies `op` and returns the op that undoes it. */
export function applyOp(doc: NbDocument, o: NotebookOp): NotebookOp {
	switch (o.op) {
		case 'insert':
			doc.cells.splice(o.index, 0, ...o.cells);
			return { op: 'delete', index: o.index, count: o.cells.length };
		case 'delete': {
			const cells = doc.cells.splice(o.index, o.count);
			return { op: 'insert', index: o.index, cells };
		}
		case 'move': {
			const moved = doc.cells.splice(o.from, o.count);
			doc.cells.splice(o.to, 0, ...moved);
			return { op: 'move', from: o.to, count: o.count, to: o.from };
		}
		case 'replace': {
			const old = doc.cells[o.index];
			doc.cells[o.index] = o.cell;
			return { op: 'replace', index: o.index, cell: old };
		}
		case 'outputs': {
			const cell = doc.cells.find((c) => c.key === o.key);
			if (!cell) return o;
			const undo: NotebookOp = { op: 'outputs', key: o.key, outputs: cell.outputs, count: cell.count };
			cell.outputs = o.outputs;
			cell.count = o.count;
			return undo;
		}
	}
}

/** Notebook-level undo / redo of cell operations. `version` changes with every applied change. */
export class NotebookHistory {
	#undo: { ops: NotebookOp[]; before: number; after: number }[] = [];
	#redo: { ops: NotebookOp[]; before: number; after: number }[] = [];
	version = 0;
	#next = 1;

	/** Applies `ops` in order as one undoable step. */
	apply(doc: NbDocument, ops: NotebookOp[]) {
		if (!ops.length) return;
		const inverse = ops.map((o) => applyOp(doc, o)).reverse();
		const before = this.version;
		this.version = this.#next++;
		this.#undo.push({ ops: inverse, before, after: this.version });
		this.#redo = [];
	}

	/** A change outside the undo stack (typing in a cell, kernel outputs). */
	touch() {
		this.version = this.#next++;
	}

	get canUndo() {
		return this.#undo.length > 0;
	}
	get canRedo() {
		return this.#redo.length > 0;
	}

	undo(doc: NbDocument): boolean {
		const step = this.#undo.pop();
		if (!step) return false;
		const inverse = step.ops.map((o) => applyOp(doc, o)).reverse();
		this.#redo.push({ ops: inverse, before: step.before, after: step.after });
		this.version = step.before;
		return true;
	}

	redo(doc: NbDocument): boolean {
		const step = this.#redo.pop();
		if (!step) return false;
		const inverse = step.ops.map((o) => applyOp(doc, o)).reverse();
		this.#undo.push({ ops: inverse, before: step.before, after: step.after });
		this.version = step.after;
		return true;
	}
}

// The edits the editor offers, as ops (null when there is nothing to do).

export const insertCellOps = (index: number, cell: NbCell): NotebookOp[] => [{ op: 'insert', index, cells: [cell] }];

export function deleteCellOps(doc: NbDocument, index: number, count = 1): NotebookOp[] | null {
	if (index < 0 || index >= doc.cells.length) return null;
	return [{ op: 'delete', index, count: Math.min(count, doc.cells.length - index) }];
}

/** Moves cells `[index, index + count)` one place up (-1) or down (1). */
export function moveCellOps(doc: NbDocument, index: number, delta: -1 | 1, count = 1): NotebookOp[] | null {
	const to = index + delta;
	if (to < 0 || to + count > doc.cells.length) return null;
	return [{ op: 'move', from: index, count, to }];
}

/** Code ↔ Markdown ↔ Raw: the source stays; outputs and the execution count only on code cells. */
export function changeKindOps(doc: NbDocument, index: number, kind: CellKind): NotebookOp[] | null {
	const cell = doc.cells[index];
	if (!cell || cell.kind === kind) return null;
	const next: NbCell = { ...cell, kind, outputs: kind === 'code' ? cell.outputs : [], count: kind === 'code' ? cell.count : null };
	// Markdown cells may carry attachments; code cells may not (nbformat).
	if (kind === 'code' && 'attachments' in next.rest) {
		const { attachments: _, ...rest } = next.rest;
		next.rest = rest;
	}
	return [{ op: 'replace', index, cell: next }];
}

/**
 * Split Cell at character `offsets` of its source (VS Code's notebook.cell.split at the cursors):
 * the first part keeps the cell (its id, metadata, outputs); each split point drops the line break
 * it falls on, and empty parts are left out.
 */
export function splitCellOps(doc: NbDocument, index: number, offsets: number[]): NotebookOp[] | null {
	const cell = doc.cells[index];
	if (!cell) return null;
	const cuts = [...new Set(offsets.filter((o) => o > 0 && o < cell.source.length))].sort((a, b) => a - b);
	if (!cuts.length) return null;
	const parts: string[] = [];
	let start = 0;
	for (const cut of [...cuts, cell.source.length]) {
		parts.push(cell.source.slice(start, cut));
		start = cut;
	}
	const pieces = parts.map((p, i) => (i < parts.length - 1 ? p.replace(/\r?\n$/, '') : p)).map((p, i) => (i > 0 ? p.replace(/^\r?\n/, '') : p));
	const kept = pieces.filter((p, i) => i === 0 || p.trim() !== '');
	if (kept.length < 2) return null;
	return [
		{ op: 'replace', index, cell: { ...cell, source: kept[0] } },
		{ op: 'insert', index: index + 1, cells: kept.slice(1).map((s) => newCell(cell.kind, s)) }
	];
}

/** Join With Next / Previous Cell (VS Code's joinBelow / joinAbove): cells of one kind, sources
 * joined by a line break, code outputs one after the other. `index` is the upper cell. */
export function joinCellOps(doc: NbDocument, index: number): NotebookOp[] | null {
	const a = doc.cells[index];
	const b = doc.cells[index + 1];
	if (!a || !b || a.kind !== b.kind) return null;
	const merged: NbCell = { ...a, source: `${a.source}\n${b.source}`, outputs: [...a.outputs, ...b.outputs] };
	return [
		{ op: 'replace', index, cell: merged },
		{ op: 'delete', index: index + 1, count: 1 }
	];
}

/** Clear Outputs of the given cells (all code cells when `keys` is omitted). */
export function clearOutputsOps(doc: NbDocument, keys?: string[]): NotebookOp[] {
	return doc.cells
		.filter((c) => c.kind === 'code' && (!keys || keys.includes(c.key)) && (c.outputs.length || c.count !== null))
		.map((c) => ({ op: 'outputs', key: c.key, outputs: [], count: null }) satisfies NotebookOp);
}

// --- Outline -------------------------------------------------------------------------------------

export type NotebookHeading = { level: number; text: string; cell: number; children: NotebookHeading[] };

/** Markdown headers of the notebook as a tree (VS Code's notebook outline with
 * `notebook.outline.showMarkdownHeadersOnly`). Headings inside code fences are not headers. */
export function notebookHeadings(cells: Pick<NbCell, 'kind' | 'source'>[]): NotebookHeading[] {
	const flat: NotebookHeading[] = [];
	cells.forEach((c, cell) => {
		if (c.kind !== 'markdown') return;
		let fence: string | null = null;
		const lines = c.source.split(/\r?\n/);
		lines.forEach((line, i) => {
			const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
			if (f) {
				if (!fence) fence = f[1][0];
				else if (f[1][0] === fence) fence = null;
				return;
			}
			if (fence) return;
			const atx = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
			if (atx && atx[2]) return void flat.push({ level: atx[1].length, text: atx[2], cell, children: [] });
			// Setext: a line of = or - under text.
			const next = lines[i + 1];
			if (line.trim() && next !== undefined && /^\s{0,3}(=+|-+)\s*$/.test(next) && !/^\s{0,3}([-*+]|\d+\.)\s/.test(line)) flat.push({ level: next.trim()[0] === '=' ? 1 : 2, text: line.trim(), cell, children: [] });
		});
	});
	const roots: NotebookHeading[] = [];
	const stack: NotebookHeading[] = [];
	for (const h of flat) {
		while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
		(stack.length ? stack[stack.length - 1].children : roots).push(h);
		stack.push(h);
	}
	return roots;
}

/** The headers as Outline symbols (VS Code shows Markdown headers as strings); a symbol's line is its cell's index. */
export function headingSymbols(headings: NotebookHeading[]): DocumentSymbol[] {
	return headings.map((h) => {
		const range = { start: { line: h.cell, character: 0 }, end: { line: h.cell, character: 0 } };
		return { name: h.text, kind: 15, range, selectionRange: range, children: headingSymbols(h.children) };
	});
}
