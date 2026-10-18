// Runs the save participants on a model before it is written (VS Code: TextFileSaveParticipant):
// editor.codeActionsOnSave, editor.formatOnSave, files.trimTrailingWhitespace,
// files.insertFinalNewline and files.trimFinalNewlines, as one undoable step per participant.

import type * as Monaco from 'monaco-editor';
import { lsp } from '#lib/lsp/lsp.svelte.ts';
import { codeActionsOnSave, formatsOnSave, type SaveReason } from '#lib/settings/mappings.ts';
import { insertFinalNewlineEdit, trimFinalNewlinesEdit, trimTrailingWhitespaceEdits, type LineEdit } from '#lib/settings/saveParticipants.ts';
import { settings } from '#lib/settings/settings.svelte.ts';

/** A slow language server must not block the save (VS Code: editor.formatOnSaveTimeout). */
const PARTICIPANT_TIMEOUT_MS = 2000;

const withTimeout = (p: Promise<unknown>) => Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, PARTICIPANT_TIMEOUT_MS))]);

function apply(model: Monaco.editor.ITextModel, edits: (LineEdit | null)[]) {
	const ops = edits.filter((e): e is LineEdit => e !== null).map(({ text, ...range }) => ({ range, text }));
	if (!ops.length) return;
	model.pushStackElement();
	model.pushEditOperations([], ops, () => null);
	model.pushStackElement();
}

export async function runSaveParticipants(monaco: typeof Monaco, model: Monaco.editor.ITextModel, reason: SaveReason) {
	const shown = monaco.editor.getEditors().filter((e) => e.getModel() === model);
	const editor = shown.find((e) => e.hasTextFocus()) ?? shown[0];

	const kinds = codeActionsOnSave(settings.get('editor.codeActionsOnSave'), reason);
	if (kinds.length) await withTimeout(lsp.codeActionsOnSave(model, kinds));

	if (editor && formatsOnSave(settings.get<boolean>('editor.formatOnSave'), reason)) {
		const format = editor.getAction('editor.action.formatDocument');
		if (format?.isSupported()) await withTimeout(format.run());
	}
	if (model.isDisposed()) return;

	const selections = shown.map((e) => [e, e.getSelections()] as const);
	// On auto save the lines being typed on keep their whitespace, like VS Code.
	const keep = new Set(reason === 'explicit' ? [] : selections.flatMap(([, sel]) => (sel ?? []).map((s) => s.positionLineNumber)));
	if (settings.get<boolean>('files.trimTrailingWhitespace')) apply(model, trimTrailingWhitespaceEdits(model.getLinesContent(), keep));
	if (settings.get<boolean>('files.trimFinalNewlines')) apply(model, [trimFinalNewlinesEdit(model.getLinesContent())]);
	if (settings.get<boolean>('files.insertFinalNewline')) apply(model, [insertFinalNewlineEdit(model.getLinesContent(), model.getEOL())]);
	// A newline inserted at the cursor must not carry the cursor along.
	for (const [e, sel] of selections) if (sel && e.getModel() === model) e.setSelections(sel);
}
