// The editing features on top of Monaco (VS Code's docs/editing): snippets, Emmet and the editor
// toggles. `installEditorFeatures` registers their commands with the workbench at start; each code
// editor is hooked by editorAttach.ts, which EditorHost loads with Monaco.

import { installEditingCommands } from './editingCommands.svelte.ts';
import { installEmmetCommands } from './emmet/emmetCommands.svelte.ts';
import { installSnippetCommands } from './snippets/snippets.svelte.ts';

export function installEditorFeatures(): () => void {
	const uninstall = [installSnippetCommands(), installEmmetCommands(), installEditingCommands()];
	return () => uninstall.forEach((u) => u());
}
