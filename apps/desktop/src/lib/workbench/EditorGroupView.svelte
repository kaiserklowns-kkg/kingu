<script lang="ts">
	// One editor group (VS Code: EditorGroupView): its tab strip, breadcrumbs, a Monaco editor for
	// file tabs and a diff editor while it has a diff tab. Inactive groups dim their tabs.
	import DiffHost from './DiffHost.svelte';
	import EditorHost from './EditorHost.svelte';
	import ImageViewer from './ImageViewer.svelte';
	import MarkdownPreview from './MarkdownPreview.svelte';
	import { hasPreview, isChangesKey, isCsvPath, isImagePath, isPreviewKey, previewTarget } from './viewers';
	import CombinedDiff from './CombinedDiff.svelte';
	import MergeEditor from '#lib/scm/MergeEditor.svelte';
	import VaultTranscript from '#lib/vault/VaultTranscript.svelte';
	import { isVaultKey } from '#lib/vault/vault.ts';
	import { isArtifactKey } from '#lib/artifacts/artifacts.ts';
	import ArtifactViewer from '#lib/artifacts/ArtifactViewer.svelte';
	import CsvPreview from './CsvPreview.svelte';
	import NotebookViewer from './NotebookViewer.svelte';
	import { isNotebookPath } from './notebook';
	import { invoke } from '@tauri-apps/api/core';
	import { status } from './status.svelte';
	import { workspace } from './workspace.svelte';
	import { isNonTextEditor } from '#lib/settings/resources.ts';
	import FileIcon from './FileIcon.svelte';
	import KinguMark from './KinguMark.svelte';
	import Icon from './Icon.svelte';
	import { editors } from './editors.svelte';
	import { layout } from './layout.svelte';
	import { externalCrumbs, externalDescription, isExternalKey } from './externalFiles';
	import { editorLabel } from './editorLabel';
	import { fileIcon } from './fileIcons';
	import { keyLabel } from './keys';
	import { entryChanges, fileDecorations, fileOf, isDiffKey, isMergeKey } from './scm';
	import { scm } from './scm.svelte';
	import { tabDescription, type LabelFormat } from './tabLabels';
	import { emptyUntitled } from './editorModels';
	import type { EditorTab } from './editorGroups';
	import SettingsEditor from '#lib/settings/SettingsEditor.svelte';
	import { settings, SETTINGS_EDITOR_KEY, USER_SETTINGS_KEY } from '#lib/settings/settings.svelte.ts';
	import Board from '#lib/ade/Board.svelte';
	import TaskPage from '#lib/ade/TaskPage.svelte';
	import { isAdeEditor, isBoardKey, slugOfTaskKey } from '#lib/ade/keys.ts';
	import AgentPanel from '#lib/agent/AgentPanel.svelte';
	import { chatIdOfEditorKey, isChatEditorKey } from '#lib/agent/chatExtras.ts';
	import { USER_KEYBINDINGS_KEY } from './keybindings.svelte';
	import FilePlaceholder from './FilePlaceholder.svelte';
	import SaveConflictCompare from './SaveConflictCompare.svelte';
	import { textFiles } from './textFileService.svelte';
	import PopupMenu, { menuItem, menuSeparator } from './PopupMenu.svelte';
	import type { MenuNode } from './menus';
	import { commands, keyOf } from './commands.svelte';
	import { isMac } from './keys';
	import * as cmd from './editorCommands.svelte';
	import { isUntitled } from './untitled';
	import { filePathCrumbs, sortSymbols, symbolCodicon, symbolSiblings, visibleSymbols, type PathMode, type SymbolSortOrder } from './breadcrumbs';
	import { symbolPath, type Crumb } from '#lib/lsp/convert.ts';
	import { outline } from './outline.svelte';

	let { group }: { group: number } = $props();

	const TAB_MIME = 'application/x-kingu-editor';

	const g = $derived(editors.group(group));
	const tabs = $derived(g?.tabs ?? []);
	const activePath = $derived(g?.active ?? null);
	const focused = $derived(editors.activeGroupId === group);
	const settingsActive = $derived(activePath === SETTINGS_EDITOR_KEY);
	/** A chat opened in the editor (Open Chat in Editor), rendered like the ADE editors. */
	const chatEditorId = $derived(activePath ? chatIdOfEditorKey(activePath) : null);
	const adeActive = $derived(activePath !== null && (isAdeEditor(activePath) || isChatEditorKey(activePath)));
	const taskSlug = $derived(activePath ? slugOfTaskKey(activePath) : null);
	const crumbs = $derived(!activePath || settingsActive || adeActive || isChangesKey(activePath) || isVaultKey(activePath) || isArtifactKey(activePath) ? [] : activePath === USER_SETTINGS_KEY
					? ['User', 'settings.json']
					: activePath === USER_KEYBINDINGS_KEY
						? ['User', 'keybindings.json']
					: activePath.startsWith('snap://user/')
						? ['User Snaps', ...activePath.slice('snap://user/'.length).split('/')]
						: isExternalKey(activePath)
							? externalCrumbs(activePath)
							: fileOf(activePath).split('/'));
	const label = editorLabel;
	const iconOf = (key: string) =>
		fileIcon(key === SETTINGS_EDITOR_KEY || key === USER_SETTINGS_KEY ? 'settings.json' : isAdeEditor(key) || isChatEditorKey(key) ? 'tasks.md' : fileOf(key));
	/** Breadcrumbs of a workspace file are clickable (not the Settings editor's or user settings'). */
	const crumbsAreFiles = $derived(!!activePath && activePath !== USER_SETTINGS_KEY && !isChangesKey(activePath) && !isExternalKey(activePath) && crumbs.length > 0);
	const diffActive = $derived(activePath !== null && isDiffKey(activePath));
	/** Images and Markdown previews have their own viewers instead of Monaco. */
	const viewerActive = $derived(activePath !== null && (isMergeKey(activePath) || isImagePath(activePath) || isPreviewKey(activePath) || isNotebookPath(activePath) || isChangesKey(activePath) || isVaultKey(activePath) || isArtifactKey(activePath)));
	// The diff editor exists only while this group has a diff tab.
	const hasDiff = $derived(tabs.some((t) => isDiffKey(t.path)));
	// Enclosing symbols from the language server's document symbols, like VS Code's outline crumbs.
	// The cursor is tracked for the active group only, so other groups show just the path.
	const rawSymbolCrumbs = $derived(activePath && !diffActive && !settingsActive && !adeActive && focused ? symbolPath(outline.symbolsOf(activePath), { line: editors.cursor.line - 1, character: editors.cursor.column - 1 }) : []);
	// breadcrumbs.enabled / filePath / symbolPath / icons / show* / symbolSortOrder (breadcrumbs.ts).
	const getSetting = <T,>(id: string) => settings.get<T>(id);
	const breadcrumbsOn = $derived(settings.get<boolean>('breadcrumbs.enabled'));
	const crumbIcons = $derived(settings.get<boolean>('breadcrumbs.icons'));
	const shownCrumbs = $derived(filePathCrumbs(crumbs, settings.get<PathMode>('breadcrumbs.filePath')));
	const allSymbolCrumbs = $derived(visibleSymbols(rawSymbolCrumbs, getSetting, 'on'));
	const symbolCrumbs = $derived(visibleSymbols(rawSymbolCrumbs, getSetting));
	let crumbMenu = $state<{ x: number; y: number; items: Crumb[] } | null>(null);
	function openSymbolPicker(e: MouseEvent, crumb: Crumb) {
		if (!activePath) return;
		const level = allSymbolCrumbs.indexOf(crumb);
		const siblings = symbolSiblings(outline.symbolsOf(activePath), { line: editors.cursor.line - 1, character: editors.cursor.column - 1 }, getSetting)[level] ?? [crumb];
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		crumbMenu = { x: rect.left, y: rect.bottom + 2, items: sortSymbols(siblings, settings.get<SymbolSortOrder>('breadcrumbs.symbolSortOrder')) };
	}
	let dropTarget = $state<number | null>(null);
	// The tab strip follows VS Code's editor part options (multiEditorTabsControl.ts).
	// Zen Mode shows the tabs as zenMode.showTabs says (VS Code's enforcePartOptions).
	const showTabs = $derived(layout.zenParts?.showTabs ?? settings.get<'multiple' | 'single' | 'none'>('workbench.editor.showTabs'));
	const shownTabs = $derived(showTabs === 'single' ? tabs.filter((t) => t.path === activePath) : tabs);
	const tabSizing = $derived(settings.get<'fit' | 'shrink' | 'fixed'>('workbench.editor.tabSizing'));
	const fixedMin = $derived(settings.get<number>('workbench.editor.tabSizingFixedMinWidth'));
	const fixedMax = $derived(settings.get<number>('workbench.editor.tabSizingFixedMaxWidth'));
	const pinnedSizing = $derived(settings.get<'normal' | 'compact' | 'shrink'>('workbench.editor.pinnedTabSizing'));
	const highlightModified = $derived(settings.get<boolean>('workbench.editor.highlightModifiedTabs'));
	const wrapTabs = $derived(showTabs === 'multiple' && settings.get<boolean>('workbench.editor.wrapTabs'));
	const showIcons = $derived(settings.get<boolean>('workbench.editor.showIcons'));
	const showTabIndex = $derived(showTabs === 'multiple' && settings.get<boolean>('workbench.editor.showTabIndex'));
	const labelFormat = $derived(settings.get<LabelFormat>('workbench.editor.labelFormat'));
	const actionsLeft = $derived(showTabs === 'multiple' && settings.get<'left' | 'right'>('workbench.editor.tabActionLocation') === 'left');
	const closeVisible = $derived(settings.get<boolean>('workbench.editor.tabActionCloseVisibility'));
	const unpinVisible = $derived(settings.get<boolean>('workbench.editor.tabActionUnpinVisibility'));
	const reserveSpace = $derived(settings.get<boolean>('workbench.editor.tabActionReserveSpace'));
	const decoColors = $derived(settings.get<boolean>('workbench.editor.decorations.colors'));
	const decoBadges = $derived(settings.get<boolean>('workbench.editor.decorations.badges'));
	const scrollbar = $derived(settings.get<'auto' | 'visible' | 'hidden'>('workbench.editor.titleScrollbarVisibility'));
	const scrollbarSize = $derived(settings.get<'default' | 'large'>('workbench.editor.titleScrollbarSizing') === 'large' ? 10 : 3);
	// workbench.editor.pinnedTabsOnSeparateRow: pinned tabs get a row of their own above the others.
	const pinnedRow = $derived(showTabs === 'multiple' && settings.get<boolean>('workbench.editor.pinnedTabsOnSeparateRow') && tabs.some((t) => t.sticky) && tabs.some((t) => !t.sticky));
	const rows = $derived(pinnedRow ? [shownTabs.filter((t) => t.sticky), shownTabs.filter((t) => !t.sticky)] : [shownTabs]);
	// Git decorations of the tabs' files (workbench.editor.decorations.*), like the Explorer's.
	const decorations = $derived(decoColors || decoBadges ? fileDecorations(entryChanges(scm.repo?.entries ?? [])) : null);
	const tabFiles = $derived(tabs.map((t) => t.path).filter((p) => !p.includes(':')));
	/** The description after a tab's name (workbench.editor.labelFormat); workspace files only. */
	const descriptionOf = (path: string) => (isExternalKey(path) ? externalDescription(path, workspace.home) : path.includes(':') || !workspace.root ? '' : tabDescription(path, tabFiles, labelFormat, workspace.root));

	/** Tab width classes and style: workbench.editor.tabSizing (+ fixed widths) and pinnedTabSizing. */
	function sizing(tab: EditorTab): { cls: string; style: string } {
		if (tab.sticky && pinnedSizing === 'compact') return { cls: 'shrink-0 w-[38px] justify-center pr-0', style: '' };
		if (tab.sticky && pinnedSizing === 'shrink') return { cls: 'shrink-0 w-[80px]', style: '' };
		if (tabSizing === 'fixed') return { cls: 'shrink grow-0 basis-auto', style: `width:${Math.max(fixedMin, fixedMax)}px;min-width:${fixedMin}px;max-width:${Math.max(fixedMin, fixedMax)}px` };
		return { cls: tabSizing === 'fit' ? 'shrink-0' : 'min-w-[80px] shrink', style: '' };
	}

	/** workbench.editor.doubleClickTabToToggleEditorGroupSizes: a preview tab is kept open, a kept one resizes the group. */
	function onTabDoubleClick(tab: EditorTab) {
		if (tab.preview) return editors.pin(tab.path, group);
		const mode = settings.get<'maximize' | 'expand' | 'off'>('workbench.editor.doubleClickTabToToggleEditorGroupSizes');
		if (mode === 'maximize') editors.toggleMaximizeGroup(group);
		else if (mode === 'expand') editors.toggleExpandGroup(group);
	}

	/** workbench.editor.scrollToSwitchTabs: the wheel over the tabs opens the next or previous one (Shift inverts it). */
	let lastWheel = 0;
	function onTabsWheel(e: WheelEvent) {
		if (tabs.length < 2 || !activePath) return;
		if (settings.get<boolean>('workbench.editor.scrollToSwitchTabs') === e.shiftKey) return;
		const now = Date.now();
		if (now - lastWheel < 50 - 2 * (Math.abs(e.deltaX) + Math.abs(e.deltaY))) return;
		lastWheel = now;
		const delta = e.deltaX + e.deltaY;
		if (!delta) return;
		e.preventDefault();
		const next = tabs[tabs.findIndex((t) => t.path === activePath) + (delta > 0 ? 1 : -1)];
		if (next) editors.open(next.path, { preview: next.preview, group });
	}

	// A dirty file asks Save / Don't Save / Cancel (⌥-click discards); one also open in another
	// group or the Agents layout keeps its model (and unsaved edits) there and closes at once.
	function close(path: string, discard: boolean) {
		void textFiles.closeEditors([path], group, { discard });
	}
	const placeholder = $derived(textFiles.placeholder(activePath));
	const comparing = $derived(activePath !== null && textFiles.compare?.path === activePath ? textFiles.compare : null);

	function dragStart(e: DragEvent, path: string) {
		if (!e.dataTransfer) return;
		e.dataTransfer.setData(TAB_MIME, JSON.stringify({ group, path }));
		e.dataTransfer.effectAllowed = 'move';
	}

	function dragOver(e: DragEvent, index: number) {
		if (!e.dataTransfer?.types.includes(TAB_MIME)) return;
		e.preventDefault();
		e.stopPropagation();
		e.dataTransfer.dropEffect = 'move';
		dropTarget = index;
	}

	function drop(e: DragEvent, index: number) {
		const raw = e.dataTransfer?.getData(TAB_MIME);
		dropTarget = null;
		if (!raw) return;
		e.preventDefault();
		e.stopPropagation();
		const from = JSON.parse(raw) as { group: number; path: string };
		editors.moveEditor(from.group, from.path, group, index);
	}

	// --- Tab context menu (VS Code: MenuId.EditorTitleContext, editorTabsControl.ts) -------------

	let tabMenu = $state<{ x: number; y: number; path: string } | null>(null);

	/** The key of a workbench command for the menu's right column. */
	const keyFor = (id: string) => {
		const c = commands.get(id);
		const k = c && keyOf(c);
		return k ? keyLabel(k) : undefined;
	};

	function tabMenuItems(path: string): MenuNode[] {
		const tab = tabs.find((t) => t.path === path);
		const i = tabs.findIndex((t) => t.path === path);
		const file = cmd.isFileEditor(path);
		const item = (id: string, text: string, opts: { enabled?: boolean; key?: string } = {}) => menuItem(id, text, { enabled: opts.enabled, keyLabel: opts.key ?? keyFor(id) });
		return [
			item('close', 'Close', { key: keyFor('workbench.action.closeActiveEditor') }),
			item('closeOthers', 'Close Others', { enabled: tabs.length > 1, key: keyFor('workbench.action.closeOtherEditors') }),
			item('closeRight', 'Close to the Right', { enabled: i < tabs.length - 1, key: keyFor('workbench.action.closeEditorsToTheRight') }),
			item('closeSaved', 'Close Saved', { enabled: tabs.some((t) => !t.dirty), key: keyFor('workbench.action.closeUnmodifiedEditors') }),
			item('closeAll', 'Close All', { key: keyFor('workbench.action.closeEditorsInGroup') }),
			menuSeparator,
			item('copyPath', 'Copy Path', { enabled: file, key: keyFor('copyFilePath') }),
			item('copyRelativePath', 'Copy Relative Path', { enabled: file, key: keyFor('copyRelativeFilePath') }),
			menuSeparator,
			item('revealOS', isMac ? 'Reveal in Finder' : 'Reveal in File Explorer', { enabled: file, key: keyFor('revealFileInOS') }),
			item('revealExplorer', 'Reveal in Explorer View', { enabled: file }),
			menuSeparator,
			...(tab?.preview ? [item('keep', 'Keep Open', { key: keyFor('workbench.action.keepEditor') })] : []),
			item('pin', tab?.sticky ? 'Unpin' : 'Pin', { key: keyFor(tab?.sticky ? 'workbench.action.unpinEditor' : 'workbench.action.pinEditor') }),
			menuSeparator,
			menuItem('splitUp', 'Split Up'),
			menuItem('splitDown', 'Split Down'),
			menuItem('splitLeft', 'Split Left'),
			menuItem('splitRight', 'Split Right')
		];
	}

	/** Runs a tab menu item on `path` (captured when the menu opened: PopupMenu closes before it runs). */
	function runTabMenu(id: string, path: string) {
		switch (id) {
			case 'close':
				return close(path, false);
			case 'closeOthers':
				return cmd.closeOthers(group, path);
			case 'closeRight':
				return cmd.closeToRight(group, path);
			case 'closeSaved':
				return cmd.closeSaved(group);
			case 'closeAll':
				return cmd.closeAllInGroup(group);
			case 'copyPath':
				return cmd.copyPath(path);
			case 'copyRelativePath':
				return cmd.copyRelativePath(path);
			case 'revealOS':
				return cmd.revealInOS(path);
			case 'revealExplorer':
				return cmd.revealInExplorer(path);
			case 'keep':
				return editors.pin(path, group);
			case 'pin':
				return cmd.togglePinned(group, path);
			case 'splitUp':
				return cmd.splitFrom(group, path, 'up');
			case 'splitDown':
				return cmd.splitFrom(group, path, 'down');
			case 'splitLeft':
				return cmd.splitFrom(group, path, 'left');
			case 'splitRight':
				return cmd.splitFrom(group, path, 'right');
		}
	}

	function openTabMenu(e: MouseEvent, path: string) {
		e.preventDefault();
		editors.activateGroup(group);
		tabMenu = { x: e.clientX, y: Math.min(e.clientY, window.innerHeight - 20 * 22), path };
	}

	const watermark = [
		['Show All Commands', 'cmd+shift+p'],
		['Go to File', 'cmd+p'],
		['Split Editor', 'cmd+\\'],
		['Toggle Terminal', 'ctrl+`'],
		['Toggle Arkai', 'cmd+alt+b'],
		['Zen Mode', 'cmd+k z']
	];

	// Breadcrumb folders open a list of their entries (VS Code's breadcrumb picker).
	type Entry = { name: string; rel: string; is_dir: boolean };
	let folderMenu = $state<{ x: number; y: number; rel: string; entries: Entry[] } | null>(null);
	async function openFolderCrumb(rel: string, x: number, y: number) {
		try {
			const entries = await invoke<Entry[]>('fs_list_dir', { rel });
			folderMenu = { x, y, rel, entries };
		} catch (e) {
			status.error(String(e));
		}
	}
	const folderItems = $derived(
		folderMenu ? (folderMenu.entries.length ? folderMenu.entries.map((e) => menuItem(e.rel, e.is_dir ? `${e.name}/` : e.name)) : [menuItem('', '(ว่าง)', { enabled: false })]) : []
	);
	function runFolderCrumb(rel: string) {
		const entry = folderMenu?.entries.find((e) => e.rel === rel);
		const at = folderMenu;
		folderMenu = null;
		if (!entry || !at) return;
		if (entry.is_dir) void openFolderCrumb(entry.rel, at.x, at.y);
		else editors.open(entry.rel, { preview: true, group });
	}
</script>

<section
	aria-label="Editor group {editors.order().indexOf(group) + 1}"
	class="flex h-full min-w-0 flex-col bg-(--vscode-editor-background)"
	onpointerdowncapture={() => editors.activateGroup(group)}
>
	{#if showTabs !== 'none' && (tabs.length || editors.groups.length > 1)}
		<div
			role="tablist"
			tabindex="-1"
			aria-label="Editor tabs"
			class="flex shrink-0 flex-col bg-(--vscode-editorGroupHeader-tabsBackground)"
			ondragover={(e) => dragOver(e, tabs.length)}
			ondragleave={() => (dropTarget = null)}
			ondrop={(e) => drop(e, tabs.length)}
			onwheel={onTabsWheel}
		>
			{#each rows as row, r (r)}
				<div
					class={[
						'kg-tab-row flex min-h-(--kg-tab-height) items-end gap-0.5 px-1',
						wrapTabs ? 'flex-wrap' : 'overflow-x-auto overflow-y-hidden',
						`kg-tab-scroll-${scrollbar}`,
						pinnedRow && r === 0 && 'border-b border-(--vscode-editorGroupHeader-tabsBorder,var(--vscode-tab-border))'
					]}
					style:--kg-tab-scrollbar="{scrollbarSize}px"
				>
					{#each row as tab (tab.path)}
						{@const active = tab.path === activePath}
						{@const i = tabs.indexOf(tab)}
						{@const size = sizing(tab)}
						{@const compact = tab.sticky && pinnedSizing === 'compact'}
						{@const action = tab.sticky && unpinVisible ? 'unpin' : !compact && closeVisible ? 'close' : null}
						{@const deco = decorations?.get(fileOf(tab.path))}
						{@const description = compact ? '' : descriptionOf(tab.path)}
						<div
							role="presentation"
							draggable="true"
							ondragstart={(e) => dragStart(e, tab.path)}
							ondragover={(e) => dragOver(e, i)}
							ondrop={(e) => drop(e, i)}
							ondragend={() => (dropTarget = null)}
							oncontextmenu={(e) => openTabMenu(e, tab.path)}
							style={size.style}
							class={[
								'group relative flex h-[calc(var(--kg-tab-height)-5px)] items-center gap-1.5 rounded-t-lg transition-colors',
								actionsLeft ? 'pr-2.5 pl-1' : 'pl-2.5',
								size.cls,
								active ? 'bg-(--vscode-tab-activeBackground)' : 'bg-(--vscode-tab-inactiveBackground) hover:bg-(--vscode-tab-hoverBackground)',
								active
									? focused
										? 'text-(--vscode-tab-activeForeground)'
										: 'text-[var(--vscode-tab-unfocusedActiveForeground,#ffffff80)]'
									: focused
										? 'text-(--vscode-tab-inactiveForeground)'
										: 'text-[var(--vscode-tab-unfocusedInactiveForeground,#9d9d9d80)]'
							]}
						>
							{#if highlightModified && tab.dirty}<span class="absolute inset-x-2.5 top-0 h-0.5 rounded-b-full bg-(--vscode-tab-activeModifiedBorder,#3399cc)"></span>
							{:else if active && focused}<span class="absolute inset-x-2.5 top-0 h-0.5 rounded-b-full bg-(--vscode-tab-activeBorderTop)"></span>{/if}
							{#if dropTarget === i}<span class="absolute inset-y-0 left-0 w-0.5 bg-(--vscode-focusBorder)"></span>{/if}
							{#if showIcons || compact}<span class={['flex', !focused && 'opacity-60']}><FileIcon icon={iconOf(tab.path)} /></span>{/if}
							{#if !compact}
								<button
									role="tab"
									aria-selected={active}
									title={isUntitled(tab.path) ? label(tab.path) : tab.path}
									class={['flex h-full min-w-0 items-baseline gap-1.5 pr-1 whitespace-nowrap', tabSizing !== 'fit' || (tab.sticky && pinnedSizing === 'shrink') ? 'flex-1 text-left' : '', tab.preview && 'italic']}
									onclick={() => editors.open(tab.path, { preview: tab.preview, group })}
									ondblclick={() => onTabDoubleClick(tab)}
									onauxclick={(e) => e.button === 1 && editors.mayMiddleClickClose(tab.path, group) && close(tab.path, false)}
								>
									{#if showTabIndex}<span class="shrink-0 text-xs opacity-70">{i + 1}</span>{/if}
									<span class="truncate" style:color={decoColors ? deco?.color : undefined}>{label(tab.path)}</span>
									{#if description}<span class="truncate text-xs text-(--vscode-descriptionForeground) not-italic">{description}</span>{/if}
								</button>
								{#if decoBadges && deco}<span class="shrink-0 text-[11px] font-semibold" style:color={deco.color}>{deco.letter || '•'}</span>{/if}
							{:else}
								<button
									role="tab"
									aria-selected={active}
									aria-label={label(tab.path)}
									title={tab.path}
									class="absolute inset-0"
									onclick={() => editors.open(tab.path, { preview: tab.preview, group })}
									ondblclick={() => onTabDoubleClick(tab)}
									onauxclick={(e) => e.button === 1 && editors.mayMiddleClickClose(tab.path, group) && close(tab.path, false)}
								></button>
							{/if}
							{#if action === 'unpin'}
								<button
									aria-label="Unpin {label(tab.path)}"
									title="Unpin"
									class={['grid size-5 shrink-0 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground)', actionsLeft ? 'order-first' : 'mr-1']}
									onclick={() => editors.unstick(tab.path, group)}
								>
									{#if tab.dirty}
										<span class="size-2 rounded-full bg-current group-hover:hidden"></span>
										<span class="hidden group-hover:block"><Icon name="pin" size={12} /></span>
									{:else}
										<Icon name="pin" size={12} />
									{/if}
								</button>
							{:else if action === 'close'}
								<button
									aria-label={tab.dirty ? `${label(tab.path)} ยังไม่บันทึก: ปิด` : `ปิด ${label(tab.path)}`}
									class={[
										'size-5 shrink-0 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground)',
										actionsLeft ? 'order-first' : 'mr-1',
										// workbench.editor.tabActionReserveSpace: a clean inactive tab keeps (or drops) the button's space.
										active || tab.dirty ? 'grid' : reserveSpace ? 'invisible grid group-hover:visible' : 'hidden group-hover:grid'
									]}
									onclick={(e) => close(tab.path, e.altKey)}
								>
									{#if tab.dirty}
										<span class="size-2 rounded-full bg-current group-hover:hidden"></span>
										<span class="hidden group-hover:block"><Icon name="close" size={14} /></span>
									{:else}
										<Icon name="close" size={14} />
									{/if}
								</button>
							{:else if tab.dirty && !compact}
								<span class={['grid size-5 shrink-0 place-items-center', actionsLeft ? 'order-first' : 'mr-1']} aria-label="ยังไม่บันทึก"><span class="size-2 rounded-full bg-current"></span></span>
							{/if}
						</div>
					{/each}
					{#if dropTarget === tabs.length && r === rows.length - 1}<span class="h-(--kg-tab-height) w-0.5 shrink-0 bg-(--vscode-focusBorder)"></span>{/if}
				</div>
			{/each}
		</div>
	{/if}
	{#if activePath && !adeActive && breadcrumbsOn}
		<nav aria-label="Breadcrumbs" class="flex h-(--kg-breadcrumbs-height) shrink-0 items-center gap-0.5 overflow-hidden px-3 text-(--vscode-breadcrumb-foreground)">
			{#each shownCrumbs as c, i (i)}
				{#if i > 0}<Icon name="chevronRight" size={14} />{/if}
				{#if crumbIcons && i === shownCrumbs.length - 1}<span class="flex shrink-0"><FileIcon icon={iconOf(activePath)} /></span>{/if}
				{#if crumbsAreFiles}
					{@const at = crumbs.length - shownCrumbs.length + i}
					<button
						class="rounded px-0.5 whitespace-nowrap hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)"
						title={at < crumbs.length - 1 ? 'ไฟล์ในโฟลเดอร์นี้' : 'ไฟล์ข้างเคียง'}
						onclick={(e) => {
							const r = e.currentTarget.getBoundingClientRect();
							// A folder lists itself; the file name lists its folder (its siblings).
							void openFolderCrumb(crumbs.slice(0, at < crumbs.length - 1 ? at + 1 : at).join('/'), r.left, r.bottom + 2);
						}}>{c}</button
					>
				{:else}
					<span class="whitespace-nowrap">{c}</span>
				{/if}
			{/each}
			{#each symbolCrumbs as s, i (i)}
				{#if shownCrumbs.length || i > 0}<Icon name="chevronRight" size={14} />{/if}
				<button class="flex items-center gap-1 whitespace-nowrap hover:text-(--vscode-foreground)" onclick={(e) => openSymbolPicker(e, s)}>
					{#if crumbIcons}<span class={['codicon', symbolCodicon(s.kind)]} aria-hidden="true"></span>{/if}{s.name}
				</button>
			{/each}
			{#if hasPreview(activePath)}
				<!-- VS Code's "Open Preview to the Side" in the editor title of a Markdown file (and CSV, like Orca). -->
				<button
					class="ml-auto flex shrink-0 items-center gap-1 rounded-md px-1.5 text-xs hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)"
					title="เปิด preview ด้านข้าง (⌘K V)"
					onclick={() => (editors.focusGroup(group), commands.run('markdown.showPreviewToSide'))}
				>
					<Icon name="openExternal" size={13} />Preview
				</button>
			{/if}
		</nav>
	{/if}

	<div class="relative min-h-0 flex-1">
		<div class={['absolute inset-0', (!activePath || diffActive || settingsActive || adeActive || viewerActive || placeholder) && 'invisible']}>
			<EditorHost {group} />
		</div>
		{#if activePath && emptyUntitled.has(activePath) && settings.get('workbench.editor.empty.hint') === 'text'}
			<!-- workbench.editor.empty.hint (VS Code's EmptyTextEditorHintContribution) -->
			<div class="pointer-events-none absolute top-0 left-[64px] z-10 text-[13px] leading-[19px] text-(--vscode-editorGhostText-foreground,var(--vscode-descriptionForeground)) italic">
				<button class="pointer-events-auto text-(--vscode-textLink-foreground) not-italic hover:underline" onclick={() => commands.run('workbench.action.editor.changeLanguageMode')}>เลือกภาษา</button>
				หรือเริ่มพิมพ์ (Select a language, or start typing to dismiss.)
			</div>
		{/if}
		{#if activePath && placeholder}
			<div class="absolute inset-0"><FilePlaceholder path={activePath} {placeholder} /></div>
		{/if}
		{#if comparing && focused}
			<div class="absolute inset-0">{#key comparing}<SaveConflictCompare path={comparing.path} disk={comparing.disk} />{/key}</div>
		{/if}
		{#if hasDiff}
			<div class={['absolute inset-0', !diffActive && 'invisible']}>
				<DiffHost active={activePath} onfail={(key) => editors.close(key, { force: true, group })} reportLanguage={focused} />
			</div>
		{/if}
		{#if activePath && isMergeKey(activePath)}
			<div class="absolute inset-0">{#key activePath}<MergeEditor mergeKey={activePath} />{/key}</div>
		{:else if activePath && isImagePath(activePath)}
			<div class="absolute inset-0">{#key activePath}<ImageViewer path={activePath} />{/key}</div>
		{:else if activePath && isChangesKey(activePath)}
			<div class="absolute inset-0">{#key activePath}<CombinedDiff changesKey={activePath} />{/key}</div>
		{:else if activePath && isVaultKey(activePath)}
			<div class="absolute inset-0">{#key activePath}<VaultTranscript vaultKey={activePath} />{/key}</div>
		{:else if activePath && isArtifactKey(activePath)}
			<div class="absolute inset-0">{#key activePath}<ArtifactViewer artifactKey={activePath} />{/key}</div>
		{:else if activePath && isNotebookPath(activePath)}
			<div class="absolute inset-0">{#key activePath}<NotebookViewer path={activePath} />{/key}</div>
		{:else if activePath && isPreviewKey(activePath)}
			<div class="absolute inset-0">
				{#key activePath}{#if isCsvPath(previewTarget(activePath))}<CsvPreview previewKey={activePath} />{:else}<MarkdownPreview previewKey={activePath} />{/if}{/key}
			</div>
		{/if}
		{#if settingsActive}
			<div class="absolute inset-0"><SettingsEditor /></div>
		{/if}
		{#if taskSlug}
			<div class="absolute inset-0">{#key taskSlug}<TaskPage slug={taskSlug} />{/key}</div>
		{:else if activePath && isBoardKey(activePath)}
			<div class="absolute inset-0"><Board /></div>
		{:else if chatEditorId}
			<div class="absolute inset-0 bg-(--vscode-editor-background)">{#key chatEditorId}<AgentPanel editorChatId={chatEditorId} />{/key}</div>
		{/if}
		<!-- workbench.tips.enabled: the shortcut watermark of an empty editor area. -->
		{#if !activePath && editors.groups.length === 1 && settings.get<boolean>('workbench.tips.enabled')}
			<div class="absolute inset-0 grid place-items-center">
				<div class="flex flex-col items-center gap-6">
					<span class="text-(--vscode-foreground) opacity-15"><KinguMark size={88} /></span>
					<dl class="grid grid-cols-[auto_auto] items-center gap-x-4 gap-y-2.5 text-(--vscode-descriptionForeground)">
						{#each watermark as [label, key] (label)}
							<dt class="text-right">{label}</dt>
							<dd class="flex gap-1">
								{#each keyLabel(key).split(' ') as chord, ci (ci)}
									<kbd class="rounded-md border border-(--vscode-widget-border) bg-(--vscode-editorGroupHeader-tabsBackground) px-1.5 py-0.5 font-sans text-xs tracking-wider">{chord}</kbd>
								{/each}
							</dd>
						{/each}
					</dl>
				</div>
			</div>
		{/if}
	</div>
</section>

{#if crumbMenu}
	{@const cm = crumbMenu}
	<PopupMenu
		items={cm.items.map((s, i) => menuItem(String(i), s.name))}
		label="Breadcrumbs"
		x={cm.x}
		y={cm.y}
		focusFirst
		onRun={(node) => {
			const s = node.type === 'item' ? cm.items[Number(node.id)] : undefined;
			if (s) editors.gotoLine(s.range.start.line + 1, s.range.start.character + 1);
		}}
		onClose={() => (crumbMenu = null)}
	/>
{/if}

{#if tabMenu}
	{@const m = tabMenu}
	<PopupMenu items={tabMenuItems(m.path)} label="Editor tab" x={m.x} y={m.y} onRun={(node) => node.type === 'item' && runTabMenu(node.id, m.path)} onClose={() => (tabMenu = null)} />
{/if}
{#if folderMenu}
	<PopupMenu items={folderItems} label="Breadcrumb" x={folderMenu.x} y={folderMenu.y} focusFirst onRun={(node) => node.type === 'item' && runFolderCrumb(node.id)} onClose={() => (folderMenu = null)} />
{/if}

<style>
	/* workbench.editor.titleScrollbarVisibility / titleScrollbarSizing: the tab strip's scrollbar. */
	:global(.kg-tab-row)::-webkit-scrollbar {
		height: var(--kg-tab-scrollbar, 3px);
	}
	:global(.kg-tab-row)::-webkit-scrollbar-track {
		background: transparent;
	}
	:global(.kg-tab-row)::-webkit-scrollbar-thumb {
		background: transparent;
	}
	:global(.kg-tab-scroll-visible)::-webkit-scrollbar-thumb,
	:global(.kg-tab-scroll-auto:hover)::-webkit-scrollbar-thumb {
		background: var(--vscode-scrollbarSlider-background, #79797966);
	}
	:global(.kg-tab-scroll-visible)::-webkit-scrollbar-thumb:hover,
	:global(.kg-tab-scroll-auto:hover)::-webkit-scrollbar-thumb:hover {
		background: var(--vscode-scrollbarSlider-hoverBackground, #646464b3);
	}
	:global(.kg-tab-scroll-hidden) {
		scrollbar-width: none;
	}
	:global(.kg-tab-scroll-hidden)::-webkit-scrollbar {
		display: none;
	}
</style>
