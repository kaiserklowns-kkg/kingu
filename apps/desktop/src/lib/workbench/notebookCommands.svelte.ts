// Notebook commands (VS Code: notebook/browser/controller/*Actions.ts and the Jupyter extension's
// kernel commands), with VS Code's keys. Command-mode keys (A, B, M, Y, D D…) act only while focus
// is on the cell list, never while typing in a cell; the run keys work in both modes. ⌥↑ / ⌥↓ (Move
// Cell) are the list's own keys (NotebookEditor.svelte): in the menus they are Monaco's Move Line.

import { commands } from './commands.svelte';
import { appMode } from './mode.svelte';
import { headingSymbols, isNotebookPath } from './notebook';
import { notebooks, type NotebookState } from './notebookEditors.svelte';
import { outline } from './outline.svelte';

const active = (): NotebookState | undefined => (appMode.isAgents ? undefined : notebooks.active());
const has = () => active() !== undefined;
/** Focus is in the notebook editor (VS Code's notebookEditorFocused). */
const focused = () => has() && !!document.activeElement?.closest('[data-notebook]');
/** Command mode: focus on the cell list, not in a cell editor or another input. */
const commandMode = () => {
	const el = document.activeElement;
	return focused() && !el?.closest('.monaco-editor') && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement);
};
const run = (f: (s: NotebookState) => unknown) => () => {
	const s = active();
	if (s) void f(s);
};

export function installNotebookCommands(): () => void {
	const category = 'Notebook';
	const unregister = [
		commands.register({ id: 'notebook.execute', title: 'Run All', category, when: has, run: run((s) => s.runAll()) }),
		commands.register({ id: 'notebook.cell.execute', title: 'Execute Cell', category, key: 'ctrl+enter', keyWhen: focused, when: has, run: run((s) => (s.cell?.kind === 'code' ? s.runCell() : s.stopEditing())) }),
		commands.register({ id: 'notebook.cell.executeAndSelectBelow', title: 'Execute Notebook Cell and Select Below', category, key: 'shift+enter', keyWhen: focused, when: has, run: run((s) => s.runAndAdvance(false)) }),
		commands.register({ id: 'notebook.cell.executeAndInsertBelow', title: 'Execute Notebook Cell and Insert Below', category, key: 'alt+enter', keyWhen: focused, when: has, run: run((s) => s.runAndAdvance(true)) }),
		commands.register({ id: 'notebook.cell.executeCellsAbove', title: 'Execute Above Cells', category, when: has, run: run((s) => s.runRange('above')) }),
		commands.register({ id: 'notebook.cell.executeCellAndBelow', title: 'Execute Cell and Below', category, when: has, run: run((s) => s.runRange('below')) }),
		commands.register({ id: 'notebook.cancelExecution', title: 'Interrupt', category, when: () => !!active() && active()!.status !== 'off', run: run((s) => s.interrupt()) }),
		commands.register({ id: 'jupyter.restartkernel', title: 'Restart Kernel', category, when: has, run: run((s) => s.restart()) }),
		commands.register({ id: 'notebook.selectKernel', title: 'Select Notebook Kernel', category, when: has, run: run((s) => s.pickKernel()) }),
		commands.register({ id: 'notebook.clearAllCellsOutputs', title: 'Clear All Outputs', category, when: has, run: run((s) => s.clearOutputs()) }),
		commands.register({ id: 'notebook.cell.clearOutputs', title: 'Clear Cell Outputs', category, when: has, run: run((s) => s.cell && s.clearOutputs([s.cell.key])) }),
		commands.register({ id: 'notebook.cell.insertCodeCellAbove', title: 'Insert Code Cell Above', category, key: 'a', keyWhen: commandMode, when: has, run: run((s) => s.insert('code', 'above')) }),
		commands.register({ id: 'notebook.cell.insertCodeCellBelow', title: 'Insert Code Cell Below', category, key: 'b', keyWhen: commandMode, when: has, run: run((s) => s.insert('code', 'below')) }),
		commands.register({ id: 'notebook.cell.insertMarkdownCellBelow', title: 'Insert Markdown Cell Below', category, when: has, run: run((s) => s.insert('markdown', 'below')) }),
		commands.register({ id: 'notebook.cell.insertMarkdownCellAbove', title: 'Insert Markdown Cell Above', category, when: has, run: run((s) => s.insert('markdown', 'above')) }),
		commands.register({ id: 'notebook.cell.delete', title: 'Delete Cell', category, key: 'd d', keyWhen: commandMode, when: has, run: run((s) => s.delete()) }),
		commands.register({ id: 'notebook.cell.changeToCode', title: 'Change Cell to Code', category, key: 'y', keyWhen: commandMode, when: has, run: run((s) => s.changeKind('code')) }),
		commands.register({ id: 'notebook.cell.changeToMarkdown', title: 'Change Cell to Markdown', category, key: 'm', keyWhen: commandMode, when: has, run: run((s) => s.changeKind('markdown')) }),
		commands.register({ id: 'notebook.cell.moveUp', title: 'Move Cell Up', category, when: has, run: run((s) => s.move(-1)) }),
		commands.register({ id: 'notebook.cell.moveDown', title: 'Move Cell Down', category, when: has, run: run((s) => s.move(1)) }),
		commands.register({ id: 'notebook.cell.split', title: 'Split Cell', category, when: has, run: run((s) => s.split()) }),
		commands.register({ id: 'notebook.cell.joinBelow', title: 'Join With Next Cell', category, key: 'ctrl+alt+j', keyWhen: focused, when: has, run: run((s) => s.join('below')) }),
		commands.register({ id: 'notebook.cell.joinAbove', title: 'Join With Previous Cell', category, key: 'ctrl+alt+shift+j', keyWhen: focused, when: has, run: run((s) => s.join('above')) }),
		commands.register({ id: 'notebook.focusNextEditor', title: 'Focus Next Cell', category, key: 'j', keyWhen: commandMode, when: has, palette: false, run: run((s) => s.select(s.selected + 1)) }),
		commands.register({ id: 'notebook.focusPreviousEditor', title: 'Focus Previous Cell', category, key: 'k', keyWhen: commandMode, when: has, palette: false, run: run((s) => s.select(s.selected - 1)) }),
		commands.register({ id: 'notebook.cell.toggleLineNumbers', title: 'Toggle Notebook Line Numbers', category, key: 'l', keyWhen: commandMode, when: has, run: run((s) => (s.lineNumbers = !s.lineNumbers)) }),
		commands.register({ id: 'notebook.undo', title: 'Undo', category, key: 'z', keyWhen: commandMode, when: () => !!active()?.canUndo, palette: false, run: run((s) => s.undo()) }),
		commands.register({ id: 'notebook.redo', title: 'Redo', category, key: 'shift+z', keyWhen: commandMode, when: () => !!active()?.canRedo, palette: false, run: run((s) => s.redo()) }),
		// The Outline view lists the notebook's Markdown headers; picking one selects its cell.
		outline.registerProvider({
			owns: isNotebookPath,
			symbols: (rel) => headingSymbols(notebooks.peek(rel)?.headings ?? []),
			reveal: (rel, line, focus) => {
				const s = notebooks.peek(rel);
				if (!s) return;
				s.select(line);
				s.reveal++;
				if (focus) s.focusList++;
			}
		})
	];
	return () => unregister.forEach((u) => u());
}
