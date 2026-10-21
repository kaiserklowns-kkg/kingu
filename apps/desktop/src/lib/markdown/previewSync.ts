// Editor ↔ Markdown preview sync (VS Code's scrollPreviewWithEditor / scrollEditorWithPreview /
// markEditorSelection). Every code editor is attached here (editorAttach.ts); a preview listens
// for the editors of its file's model and asks them to scroll. A scroll this module causes is not
// reported back, so the two sides never chase each other.

import type * as Monaco from 'monaco-editor';

export type EditorSyncEvent = { model: Monaco.editor.ITextModel; kind: 'scroll' | 'selection'; /** 0-based; fractional for `scroll`. */ line: number };

const editors = new Set<Monaco.editor.ICodeEditor>();
const listeners = new Set<(e: EditorSyncEvent) => void>();
/** Editors scrolled by a preview, until when their scroll events are not reported. */
const quietUntil = new WeakMap<Monaco.editor.ICodeEditor, number>();
const QUIET_MS = 120;

const isMarkdown = (model: Monaco.editor.ITextModel | null): model is Monaco.editor.ITextModel => !!model && model.getLanguageId() === 'markdown';

/** The fractional 0-based line at the top of `editor`'s viewport. */
function topLine(editor: Monaco.editor.ICodeEditor): number | null {
	const first = editor.getVisibleRanges()[0];
	if (!first) return null;
	const n = first.startLineNumber;
	const top = editor.getTopForLineNumber(n);
	const next = editor.getTopForLineNumber(n + 1);
	const frac = next > top ? Math.min(1, Math.max(0, (editor.getScrollTop() - top) / (next - top))) : 0;
	return n - 1 + frac;
}

/** Called for every code editor (editorAttach.ts). */
export function attachPreviewSync(editor: Monaco.editor.ICodeEditor) {
	editors.add(editor);
	const emit = (e: EditorSyncEvent) => listeners.forEach((l) => l(e));
	editor.onDidScrollChange((e) => {
		const model = editor.getModel();
		if (!e.scrollTopChanged || !isMarkdown(model) || !listeners.size) return;
		if ((quietUntil.get(editor) ?? 0) > Date.now()) return;
		const line = topLine(editor);
		if (line !== null) emit({ model, kind: 'scroll', line });
	});
	editor.onDidChangeCursorSelection((e) => {
		const model = editor.getModel();
		if (isMarkdown(model) && listeners.size) emit({ model, kind: 'selection', line: e.selection.positionLineNumber - 1 });
	});
	editor.onDidDispose(() => editors.delete(editor));
}

/** Editor scrolls and cursor moves of Markdown models; returns the unsubscribe. */
export function onEditorSync(listener: (e: EditorSyncEvent) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** The cursor line (0-based) of an editor showing `model`, preferring the focused one. */
export function cursorLine(model: Monaco.editor.ITextModel): number | null {
	const shown = [...editors].filter((e) => e.getModel() === model);
	const ed = shown.find((e) => e.hasTextFocus()) ?? shown[0];
	const pos = ed?.getPosition();
	return pos ? pos.lineNumber - 1 : null;
}

/** The top line of an editor showing `model`, to place a newly opened preview. */
export function editorTopLine(model: Monaco.editor.ITextModel): number | null {
	const ed = [...editors].find((e) => e.getModel() === model);
	return ed ? topLine(ed) : null;
}

/** Scrolls every editor showing `model` so the fractional 0-based `line` is at its top. */
export function scrollEditorsTo(model: Monaco.editor.ITextModel, line: number) {
	for (const ed of editors) {
		if (ed.getModel() !== model) continue;
		const n = Math.max(1, Math.min(model.getLineCount(), Math.floor(line) + 1));
		const top = ed.getTopForLineNumber(n);
		const next = n < model.getLineCount() ? ed.getTopForLineNumber(n + 1) : top;
		quietUntil.set(ed, Date.now() + QUIET_MS);
		ed.setScrollTop(top + (line - (n - 1)) * (next - top));
	}
}
