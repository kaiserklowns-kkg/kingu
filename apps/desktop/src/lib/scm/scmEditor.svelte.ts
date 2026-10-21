// Source Control in the code editor, wired from EditorHost (one per editor group) and Workbench
// (the commands): the quick diff and its peek (quickDiff.svelte.ts), git blame
// (blame.svelte.ts) and merge conflicts (mergeConflicts.svelte.ts). The gutter width and
// visibility settings are one stylesheet, like VS Code's QuickDiffWorkbenchController.

import type * as Monaco from 'monaco-editor';
import { settings } from '#lib/settings/settings.svelte.ts';
import { locale } from '#lib/i18n/index.ts';
import { attachBlame, installBlameCommands, installBlameMonacoCommands } from './blame.svelte';
import { attachConflicts, installConflictCommands, installConflictLenses, refreshConflictLenses } from './mergeConflicts.svelte';
import { attachQuickDiff, installQuickDiffCommands } from './quickDiff.svelte';
import { addView, type MonacoApi } from './scmViews.svelte';
import './scmEditor.css';

export type ScmEditorDecorations = { render(): void; dispose(): void };

/** Draws Source Control into `ed`, which shows the file `path()`; `render` from an effect follows the stores. */
export function attachScmEditor(monaco: MonacoApi, ed: Monaco.editor.IStandaloneCodeEditor, path: () => string | null): ScmEditorDecorations {
	installConflictLenses(monaco);
	installBlameMonacoCommands(monaco);
	const view = { monaco, ed, path };
	const remove = addView(view);
	const parts = [attachQuickDiff(view), attachBlame(view), attachConflicts(view)];
	return {
		render: () => parts.forEach((p) => p.render()),
		dispose() {
			parts.forEach((p) => p.dispose());
			remove();
		}
	};
}

/** The commands and the window-wide gutter style. */
export function installScmEditor(): () => void {
	const style = document.createElement('style');
	style.dataset.kingu = 'quick-diff';
	document.head.append(style);
	const stop = $effect.root(() => {
		// scm.diffDecorationsGutterWidth / scm.diffDecorationsGutterVisibility (VS Code's setViewState).
		$effect(() => {
			let width = settings.get<number>('scm.diffDecorationsGutterWidth');
			if (!Number.isFinite(width) || width <= 0 || width > 5) width = 3;
			const hover = settings.get<string>('scm.diffDecorationsGutterVisibility') === 'hover';
			style.textContent = `
				.monaco-editor .kg-qd-added, .monaco-editor .kg-qd-modified { border-left-width: ${width}px; }
				.monaco-editor .kg-qd-pattern, .monaco-editor .kg-qd-pattern:before { background-size: ${width}px ${width}px; }
				.monaco-editor .kg-qd { opacity: ${hover ? 0 : 1}; }
			`;
		});
		$effect(() => {
			void settings.get('merge-conflict.codeLens.enabled');
			void locale();
			refreshConflictLenses();
		});
	});
	const off = [installQuickDiffCommands(), installBlameCommands(), installConflictCommands()];
	return () => {
		stop();
		off.forEach((u) => u());
		style.remove();
	};
}
