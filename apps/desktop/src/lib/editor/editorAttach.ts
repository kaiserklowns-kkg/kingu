// Hooks a new code editor into the editing features (snippets, Emmet, the word wrap toggle).
// Loaded with Monaco (EditorHost), so the Emmet code stays out of the first paint.

import type * as Monaco from 'monaco-editor';
import { trackEditor } from './activeEditor.ts';
import { attachEditingModes } from './editingCommands.svelte.ts';
import { attachEmmet } from './emmet/emmet.svelte.ts';
import { attachSnippets } from './snippets/snippets.svelte.ts';

export function attachEditorFeatures(monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor) {
	trackEditor(monaco, editor);
	attachSnippets(monaco, editor);
	attachEmmet(monaco, editor);
	attachEditingModes(editor);
}
