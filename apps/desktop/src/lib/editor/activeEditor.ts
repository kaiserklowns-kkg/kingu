// The code editor the editing commands act on (VS Code: ICodeEditorService.getFocusedCodeEditor /
// getActiveCodeEditor). A command run from the palette or a menu has focus in the quick input,
// so the last editor that had text focus counts, then the one showing the active file.

import type * as Monaco from 'monaco-editor';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { getEntry } from '#lib/workbench/editorModels.ts';

let api: typeof Monaco | undefined;
let lastFocused: Monaco.editor.ICodeEditor | undefined;

/** Called for every code editor once Monaco is loaded. */
export function trackEditor(monaco: typeof Monaco, editor: Monaco.editor.ICodeEditor) {
	api = monaco;
	editor.onDidFocusEditorText(() => (lastFocused = editor));
	editor.onDidDispose(() => {
		if (lastFocused === editor) lastFocused = undefined;
	});
}

/** Monaco once an editor exists. */
export const monacoApi = () => api;

/** The focused code editor, else the last focused one, else one showing the active file. */
export function activeCodeEditor(): Monaco.editor.ICodeEditor | undefined {
	if (!api) return undefined;
	const all = api.editor.getEditors();
	const focused = all.find((e) => e.hasTextFocus() || e.hasWidgetFocus());
	if (focused?.getModel()) return focused;
	const model = editors.focusedFile ? getEntry(editors.focusedFile)?.model : undefined;
	if (lastFocused && all.includes(lastFocused) && lastFocused.getModel() && (!model || lastFocused.getModel() === model)) return lastFocused;
	return model ? all.find((e) => e.getModel() === model) : undefined;
}

/** The active code editor when it has a model and accepts edits. */
export function writableEditor(): Monaco.editor.ICodeEditor | undefined {
	const ed = activeCodeEditor();
	if (!ed?.getModel() || !api || ed.getOption(api.editor.EditorOption.readOnly)) return undefined;
	return ed;
}
