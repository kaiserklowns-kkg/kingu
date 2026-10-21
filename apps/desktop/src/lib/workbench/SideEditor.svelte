<script lang="ts">
	// The second editor of Split Editor in Group (VS Code's SideBySideEditor of one document twice):
	// a Monaco editor on the same shared model as the group's own editor (EditorHost), so edits,
	// undo and dirty state are one. Focus First / Second / Other Side move between the two.
	import { onMount } from 'svelte';
	import type * as Monaco from 'monaco-editor';
	import { editors } from './editors.svelte';
	import { modelEntry } from './editorModels';
	import { editorOptions } from '#lib/settings/apply.svelte.ts';

	let { group, path }: { group: number; path: string } = $props();

	let host: HTMLDivElement;

	onMount(() => {
		let disposed = false;
		let editor: Monaco.editor.IStandaloneCodeEditor | undefined;
		Promise.all([import('#lib/editor/monaco.ts'), import('#lib/editor/editorAttach.ts')]).then(async ([m, { attachEditorFeatures }]) => {
			await m.setupTextMate();
			if (disposed) return;
			const ed = m.monaco.editor.create(host, { ...editorOptions(), theme: m.THEME_ID, automaticLayout: true });
			attachEditorFeatures(m.monaco, ed);
			ed.onDidFocusEditorText(() => editors.activateGroup(group));
			editor = ed;
			const entry = await modelEntry(m, path).catch(() => null);
			if (!disposed && entry && !entry.model.isDisposed()) ed.setModel(entry.model);
		});
		const unregister = editors.registerSideEditor(group, {
			focus: () => editor?.focus(),
			hasFocus: () => !!editor?.hasTextFocus()
		});
		return () => {
			disposed = true;
			unregister();
			// The model is shared: only the view goes.
			editor?.setModel(null);
			editor?.dispose();
		};
	});
</script>

<div bind:this={host} class="h-full w-full"></div>
