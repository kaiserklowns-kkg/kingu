<script lang="ts">
	// The editor area (VS Code: EditorPart): a grid of editor groups. Owns what is shared between
	// groups: the text models (disposed once no group shows their file) and the editor commands
	// that act on the active group's editor.
	import { onMount, untrack } from 'svelte';
	import { lsp } from '#lib/lsp/lsp.svelte.ts';
	import EditorGrid from './EditorGrid.svelte';
	import EditorGroupView from './EditorGroupView.svelte';
	import { navigation } from './navigation.svelte';
	import { commands } from './commands.svelte';
	import { editors } from './editors.svelte';
	import { disposeAll, disposeClosed, pruneViewStates, reloadClean, saveFile } from './editorModels';
	import { EDITOR_ACTIONS } from './menus';
	import { quick } from './quick.svelte';
	import { fileOf, isDiffKey, isMergeKey } from './scm';
	import { workspace } from './workspace.svelte';
	import { textFiles } from './textFileService.svelte';
	import { isSearchEditorKey } from './searchEditor';
	import { searchEditors } from './searchEditor.svelte.ts';
	import { adeLayout } from '#lib/ade/adeLayout.svelte.ts';
	import { settings, USER_SETTINGS_KEY, WORKSPACE_SETTINGS_PATH } from '#lib/settings/settings.svelte.ts';

	onMount(() => {
		const unregister = [
			commands.register({
				id: 'workbench.action.files.save',
				title: 'Save',
				category: 'File',
				key: 'cmd+s',
				when: () => editors.focusedFile !== null,
				run: () => {
					const path = editors.focusedFile;
					// A Search Editor writes its `.code-search` file (Save As when untitled).
					if (path && isSearchEditorKey(path)) return searchEditors.save(path);
					if (path && !isDiffKey(path)) return saveFile(path);
				}
			}),
			commands.register({
				id: 'workbench.action.files.saveAll',
				title: 'Save All',
				category: 'File',
				key: 'cmd+alt+s',
				when: () => editors.hasDirty(),
				run: () => Promise.all(editors.dirtyPaths().filter((p) => !isDiffKey(p)).map((p) => saveFile(p)))
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
				title: 'Restart',
				category: 'Language Server',
				when: () => lsp.hasServer(editors.language),
				run: () => lsp.restart(editors.language)
			}),
			commands.register({
				id: 'kingu.lsp.installMissing',
				title: 'Install Missing…',
				category: 'Language Server',
				when: () => lsp.missing().length > 0,
				run: () => lsp.installMissing(editors.language)
			})
		];
		// File watcher: clean open models follow the file on disk.
		const unwatch = workspace.onFilesChanged(reloadClean);
		// The settings UI wrote a settings file: an open (clean) settings.json tab follows it.
		const unwritten = settings.onDidWrite((scope) => reloadClean([scope === 'user' ? USER_SETTINGS_KEY : WORKSPACE_SETTINGS_PATH]));
		// workbench.editor.mouseBackForwardToNavigate: mouse buttons 4 and 5 are Go Back / Go Forward.
		const onMouseUp = (e: MouseEvent) => {
			if ((e.button !== 3 && e.button !== 4) || !settings.get<boolean>('workbench.editor.mouseBackForwardToNavigate')) return;
			e.preventDefault();
			if (e.button === 3) navigation.back();
			else navigation.forward();
		};
		window.addEventListener('mouseup', onMouseUp);
		return () => {
			window.removeEventListener('mouseup', onMouseUp);
			unwatch();
			unwritten();
			unregister.forEach((u) => u());
			disposeAll();
		};
	});

	// workbench.editor.limit.*: a lower limit (or turning it on) closes editors at once, like VS Code.
	$effect(() => {
		void [settings.get('workbench.editor.limit.enabled'), settings.get('workbench.editor.limit.value'), settings.get('workbench.editor.limit.perEditorGroup'), settings.get('workbench.editor.limit.excludeDirty')];
		untrack(() => editors.enforceLimit());
	});

	// Dispose models of files no group has open (files open in the Agents layout share them too).
	$effect(() => {
		const paths = editors.openPaths();
		// A merge editor (`merge://`) edits its file's own model.
		const open = new Set([...paths, ...[...paths].filter(isMergeKey).map(fileOf), ...adeLayout.openFiles()]);
		disposeClosed(open, editors.order());
		const byGroup = new Map(editors.groups.map((g) => [g.id, new Set(g.tabs.map((t) => t.path))]));
		void settings.get('workbench.editor.restoreViewState');
		// After the editor hosts have saved the view state of the tab they stopped showing.
		queueMicrotask(() => pruneViewStates(byGroup));
		untrack(() => textFiles.prune(open));
		untrack(() => searchEditors.prune(open));
	});
</script>

<div class="h-full min-w-0 bg-(--vscode-editor-background)">
	{#if editors.model.maximized != null && editors.group(editors.model.maximized)}
		<EditorGroupView group={editors.model.maximized} />
	{:else}
		<EditorGrid node={editors.model.root} />
	{/if}
</div>
