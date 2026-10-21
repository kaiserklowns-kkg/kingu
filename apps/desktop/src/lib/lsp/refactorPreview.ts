// Refactor Preview (VS Code's bulkEditPreview): a WorkspaceEdit as a checkable tree of change
// categories (change annotation labels), files and edits; the edit with only the checked edits;
// and the diff tab key of one file's preview. Pure, so `bun test` covers it.
//
// An edit's id is `<group>:<index>`: the group is the TextDocumentEdit's index in
// `documentChanges` (or the entry's index in `changes`), the index its place in that group.

import type { AnnotatedTextEdit, ChangeAnnotation, TextDocumentEdit, TextEdit, WorkspaceEdit } from './protocol';
import { applyTextEdits, lineStarts, offsetAt } from './workspaceEdit';

export type PreviewEdit = { id: string; group: number; uri: string; edit: TextEdit; annotationId?: string };
export type PreviewFile = { uri: string; edits: PreviewEdit[] };
/** `label` '' (and no annotation) for edits without a change annotation. */
export type PreviewCategory = { label: string; annotation?: ChangeAnnotation; files: PreviewFile[] };

const editId = (group: number, index: number) => `${group}:${index}`;
const annotationOf = (e: TextEdit) => (e as Partial<AnnotatedTextEdit>).annotationId;

/** Every text edit of `edit`, in order. Resource operations are not text edits and are left out. */
export function previewEdits(edit: WorkspaceEdit): PreviewEdit[] {
	const out: PreviewEdit[] = [];
	if (edit.documentChanges) {
		edit.documentChanges.forEach((c, g) => {
			if ('kind' in c) return;
			const d = c as TextDocumentEdit;
			(d.edits ?? []).forEach((e, i) => out.push({ id: editId(g, i), group: g, uri: d.textDocument.uri, edit: e, annotationId: annotationOf(e) }));
		});
		return out;
	}
	Object.entries(edit.changes ?? {}).forEach(([uri, edits], g) => (edits ?? []).forEach((e, i) => out.push({ id: editId(g, i), group: g, uri, edit: e })));
	return out;
}

/** The annotation of an edit, when the edit names one the WorkspaceEdit defines. */
const annotation = (edit: WorkspaceEdit, e: PreviewEdit) => (e.annotationId !== undefined ? edit.changeAnnotations?.[e.annotationId] : undefined);

/** VS Code's preview: one category per annotation label (in first-seen order), each with its files. */
export function previewTree(edit: WorkspaceEdit): PreviewCategory[] {
	const cats = new Map<string, PreviewCategory>();
	for (const e of previewEdits(edit)) {
		const a = annotation(edit, e);
		const label = a?.label ?? '';
		let cat = cats.get(label);
		if (!cat) cats.set(label, (cat = { label, annotation: a, files: [] }));
		let file = cat.files.find((f) => f.uri === e.uri);
		if (!file) cat.files.push((file = { uri: e.uri, edits: [] }));
		file.edits.push(e);
	}
	return [...cats.values()];
}

/** Whether `edit` should be shown before it is applied: asked for, or an edit needs confirmation. */
export function needsPreview(edit: WorkspaceEdit, opts: { preview?: boolean } = {}): boolean {
	if (opts.preview) return previewEdits(edit).length > 0;
	return previewEdits(edit).some((e) => annotation(edit, e)?.needsConfirmation === true);
}

/** The ids checked at first: everything but edits that need confirmation (VS Code leaves those unchecked). */
export function initialChecked(edit: WorkspaceEdit): Set<string> {
	return new Set(previewEdits(edit).filter((e) => annotation(edit, e)?.needsConfirmation !== true).map((e) => e.id));
}

/** A file's (or category's) checkbox: every edit checked, none, or some. */
export function checkState(edits: PreviewEdit[], checked: ReadonlySet<string>): 'all' | 'none' | 'some' {
	const n = edits.filter((e) => checked.has(e.id)).length;
	return n === 0 ? 'none' : n === edits.length ? 'all' : 'some';
}

/** Toggling a parent checks all its edits unless all are checked already. */
export function toggleEdits(edits: PreviewEdit[], checked: ReadonlySet<string>): Set<string> {
	const next = new Set(checked);
	const on = checkState(edits, checked) !== 'all';
	for (const e of edits) {
		if (on) next.add(e.id);
		else next.delete(e.id);
	}
	return next;
}

/** `edit` with only the checked text edits: documents left without edits and annotations no longer
 * used are dropped; resource operations stay as they are. */
export function filterWorkspaceEdit(edit: WorkspaceEdit, checked: ReadonlySet<string>): WorkspaceEdit {
	const used = new Set<string>();
	const keep = (g: number, edits: TextEdit[]) =>
		edits.filter((e, i) => {
			if (!checked.has(editId(g, i))) return false;
			const a = annotationOf(e);
			if (a !== undefined) used.add(a);
			return true;
		});
	const out: WorkspaceEdit = {};
	if (edit.documentChanges) {
		out.documentChanges = [];
		edit.documentChanges.forEach((c, g) => {
			if ('kind' in c) {
				const a = (c as { annotationId?: unknown }).annotationId;
				if (typeof a === 'string') used.add(a);
				return void out.documentChanges!.push(c);
			}
			const d = c as TextDocumentEdit;
			const edits = keep(g, d.edits ?? []);
			if (edits.length) out.documentChanges!.push({ textDocument: d.textDocument, edits });
		});
	} else if (edit.changes) {
		out.changes = {};
		Object.entries(edit.changes).forEach(([uri, edits], g) => {
			const kept = keep(g, edits ?? []);
			if (kept.length) out.changes![uri] = kept;
		});
	}
	if (edit.changeAnnotations) {
		const anns = Object.fromEntries(Object.entries(edit.changeAnnotations).filter(([id]) => used.has(id)));
		if (Object.keys(anns).length) out.changeAnnotations = anns;
	}
	return out;
}

/** `original` (the document `uri` before the edit) with the checked edits of `uri` applied, one
 * TextDocumentEdit after another, as applyWorkspaceEdit would. */
export function previewText(edit: WorkspaceEdit, uri: string, original: string, checked: ReadonlySet<string>): string {
	const groups = new Map<number, TextEdit[]>();
	for (const e of previewEdits(edit)) if (e.uri === uri && checked.has(e.id)) groups.set(e.group, [...(groups.get(e.group) ?? []), e.edit]);
	let text = original;
	for (const g of [...groups.keys()].sort((a, b) => a - b)) text = applyTextEdits(text, groups.get(g)!);
	return text;
}

/** One line of an edit for the tree: the line it starts on (1-based), the text around it, what it removes and inserts. */
export function editLine(text: string, e: TextEdit): { line: number; before: string; removed: string; inserted: string; after: string } {
	const starts = lineStarts(text);
	const start = offsetAt(text, starts, e.range.start);
	const end = Math.max(start, offsetAt(text, starts, e.range.end));
	const line = Math.min(e.range.start.line, starts.length - 1);
	const lineStart = starts[Math.max(0, line)];
	const lineEnd = text.slice(end).search(/\r?\n|\r|$/) + end;
	const firstLine = (s: string) => s.split(/\r?\n|\r/)[0];
	return {
		line: line + 1,
		before: text.slice(lineStart, start).trimStart(),
		removed: firstLine(text.slice(start, end)),
		inserted: firstLine(e.newText),
		after: text.slice(end, lineEnd)
	};
}

/** The diff tab of a file's preview: `refactorpreview:<rel>` (the file ↔ the file with the checked edits). */
export const REFACTOR_PREVIEW_PREFIX = 'refactorpreview:';
export const refactorPreviewKey = (rel: string) => REFACTOR_PREVIEW_PREFIX + rel;
export const isRefactorPreviewKey = (key: string) => key.startsWith(REFACTOR_PREVIEW_PREFIX);
