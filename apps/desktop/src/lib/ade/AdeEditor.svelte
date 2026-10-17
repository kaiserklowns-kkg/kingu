<script lang="ts" module>
	import type * as MonacoTypes from 'monaco-editor';
	/** Scroll and cursor per file, so a tab shown again (or the worktree switched back) resumes where it was. */
	const views = new Map<string, MonacoTypes.editor.ICodeEditorViewState | null>();
</script>

<script lang="ts">
	// A file tab of the Agents layout: one Monaco editor on the IDE's shared text model of `path`
	// (editorModels.ts), so edits, undo and dirty state are the same file in both layouts, and ⌘S
	// goes through the IDE's Save command (it saves the ADE's active file while the ADE is in
	// front). Editor settings and the theme reach it through installEditorSettings' Monaco hooks.
	// Mounted only while its tab is shown; the model outlives it and the view state is kept here.
	import { onMount } from 'svelte';
	import { clientLog } from '#lib/client-log.ts';
	import { installEditorSettings } from '#lib/settings/apply.svelte.ts';
	import { modelEntry } from '#lib/workbench/editorModels.ts';

	let { path, onedit, onfail }: { path: string; onedit: () => void; onfail: (error: unknown) => void } = $props();

	let host: HTMLDivElement;

	onMount(() => {
		let disposed = false;
		let editor: MonacoTypes.editor.IStandaloneCodeEditor | undefined;
		const file = path;
		import('#lib/editor/monaco.ts')
			.then(async (m) => {
				await m.setupTextMate();
				if (disposed) return;
				installEditorSettings(m.monaco);
				const entry = await modelEntry(m, file);
				if (disposed || entry.model.isDisposed()) return;
				editor = m.monaco.editor.create(host, {
					model: entry.model,
					theme: m.THEME_ID,
					automaticLayout: true,
					fontFamily: "Menlo, Monaco, 'Courier New', 'IBM Plex Sans Thai', monospace",
					fontSize: 12,
					lineHeight: 18,
					minimap: { enabled: true },
					scrollBeyondLastLine: true,
					renderLineHighlight: 'all'
				});
				const view = views.get(file);
				if (view) editor.restoreViewState(view);
				// A reload from disk (the agent changed the file) is not the user's edit.
				editor.onDidChangeModelContent(() => entry.reloading || onedit());
				editor.focus();
			})
			.catch((e) => {
				clientLog('error', `open ${file} in the Agents layout: ${e}`);
				if (!disposed) onfail(e);
			});
		return () => {
			disposed = true;
			if (editor) views.set(file, editor.saveViewState());
			// The model is shared and outlives this editor; only detach.
			editor?.setModel(null);
			editor?.dispose();
		};
	});
</script>

<div bind:this={host} class="h-full w-full"></div>
