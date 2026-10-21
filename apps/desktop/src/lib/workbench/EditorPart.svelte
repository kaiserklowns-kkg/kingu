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
	import Sash from './Sash.svelte';
	import { hasColumns } from './editorGroups';
	import { layout } from './layout.svelte';
	import { CENTERED_DEFAULT, centeredShown, centeredSizes, dragMargin } from './zenMode';
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

	// Centered layout (layout.centered, or Zen Mode's zenMode.centerLayout): off while the grid has
	// columns or a side-by-side diff shows, with workbench.editor.centeredLayoutAutoResize.
	let width = $state(0);
	const centered = $derived(
		width > 0 &&
			centeredShown(layout.centeredRequested, settings.get<boolean>('workbench.editor.centeredLayoutAutoResize'), {
				columns: hasColumns(editors.model),
				maximized: editors.model.maximized != null,
				complexEditor: editors.groups.some((g) => g.active !== null && isDiffKey(g.active)) && settings.get<boolean>('diffEditor.renderSideBySide')
			})
	);
	const fixedWidth = $derived(settings.get<boolean>('workbench.editor.centeredLayoutFixedWidth'));
	const sizes = $derived(centeredSizes(width, layout.centeredState, fixedWidth));
	const drag = (side: 'left' | 'right', delta: number) => (layout.centeredState = dragMargin(layout.centeredState, width, side, delta, fixedWidth));
	const resetCentered = () => (layout.centeredState = CENTERED_DEFAULT);
</script>

<!-- View: Toggle Centered Layout (VS Code's CenteredViewLayout): empty margins with sashes. The
     grid stays in the same element either way, so toggling never re-creates the editors. -->
<div class="flex h-full min-w-0 bg-(--vscode-editor-background)" bind:clientWidth={width}>
	{#if centered}
		<div class="h-full shrink-0" style:width="{sizes[0]}px"></div>
		<Sash orientation="vertical" onDrag={(d) => drag('left', d)} onReset={resetCentered} />
	{/if}
	<div class={['h-full min-w-0', centered ? 'shrink-0' : 'flex-1']} style:width={centered ? `${sizes[1]}px` : undefined}>
		{#if editors.model.maximized != null && editors.group(editors.model.maximized)}
			<EditorGroupView group={editors.model.maximized} />
		{:else}
			<EditorGrid node={editors.model.root} />
		{/if}
	</div>
	{#if centered}
		<Sash orientation="vertical" onDrag={(d) => drag('right', d)} onReset={resetCentered} />
		<div class="h-full min-w-0 flex-1"></div>
	{/if}
</div>
