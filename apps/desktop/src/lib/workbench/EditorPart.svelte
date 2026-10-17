<script lang="ts">
	// The editor area (VS Code: EditorPart): a grid of editor groups. Owns what is shared between
	// groups: the text models (disposed once no group shows their file) and the editor commands
	// that act on the active group's editor.
	import { onMount } from 'svelte';
	import { lsp } from '#lib/lsp/lsp.svelte.ts';
	import EditorGrid from './EditorGrid.svelte';
	import { commands } from './commands.svelte';
	import { editors } from './editors.svelte';
	import { disposeAll, disposeClosed, reloadClean, saveFile } from './editorModels';
	import { EDITOR_ACTIONS } from './menus';
	import { quick } from './quick.svelte';
	import { isDiffKey } from './scm';
	import { workspace } from './workspace.svelte';

	onMount(() => {
		const unregister = [
			commands.register({
				id: 'workbench.action.files.save',
				title: 'Save',
				category: 'File',
				key: 'cmd+s',
				when: () => editors.active !== null,
				run: () => editors.active && !isDiffKey(editors.active) && saveFile(editors.active)
			}),
			commands.register({
				id: 'workbench.action.files.saveAll',
				title: 'Save All',
				category: 'File',
				key: 'cmd+alt+s',
				when: () => editors.hasDirty(),
				run: () => Promise.all([...new Set(editors.allTabs().filter((t) => t.dirty && !isDiffKey(t.path)).map((t) => t.path))].map(saveFile))
			}),
			// Monaco owns these keys (⌘F, F12…); the commands exist for the menus and the palette.
			...Object.entries(EDITOR_ACTIONS).map(([id, title]) =>
				commands.register({ id, title, category: 'Editor', when: () => editors.active !== null, run: () => editors.trigger(id) })
			),
			commands.register({
				id: 'workbench.action.gotoLine',
				title: 'Go to Line/Column...',
				key: 'ctrl+g',
				when: () => editors.active !== null,
				run: () => quick.show(':')
			}),
			commands.register({
				id: 'kingu.lsp.restart',
				title: 'Restart Language Server',
				category: 'Developer',
				when: () => lsp.hasServer(editors.language),
				run: () => lsp.restart(editors.language)
			})
		];
		// File watcher: clean open models follow the file on disk.
		const unwatch = workspace.onFilesChanged(reloadClean);
		return () => {
			unwatch();
			unregister.forEach((u) => u());
			disposeAll();
		};
	});

	// Dispose models of files no group has open.
	$effect(() => {
		disposeClosed(editors.openPaths(), editors.order());
	});
</script>

<div class="h-full min-w-0 bg-(--vscode-editor-background)">
	<EditorGrid node={editors.model.root} />
</div>
