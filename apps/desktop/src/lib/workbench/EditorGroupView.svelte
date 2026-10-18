<script lang="ts">
	// One editor group (VS Code: EditorGroupView): its tab strip, breadcrumbs, a Monaco editor for
	// file tabs and a diff editor while it has a diff tab. Inactive groups dim their tabs.
	import { lsp } from '#lib/lsp/lsp.svelte.ts';
	import DiffHost from './DiffHost.svelte';
	import EditorHost from './EditorHost.svelte';
	import ImageViewer from './ImageViewer.svelte';
	import MarkdownPreview from './MarkdownPreview.svelte';
	import { hasPreview, isChangesKey, isCsvPath, isImagePath, isPreviewKey, previewTarget } from './viewers';
	import CombinedDiff from './CombinedDiff.svelte';
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
	import { editorLabel } from './editorLabel';
	import { fileIcon } from './fileIcons';
	import { keyLabel } from './keys';
	import { fileOf, isDiffKey } from './scm';
	import SettingsEditor from '#lib/settings/SettingsEditor.svelte';
	import { settings, SETTINGS_EDITOR_KEY, USER_SETTINGS_KEY } from '#lib/settings/settings.svelte.ts';
	import Board from '#lib/ade/Board.svelte';
	import TaskPage from '#lib/ade/TaskPage.svelte';
	import { isAdeEditor, isBoardKey, slugOfTaskKey } from '#lib/ade/keys.ts';
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

	let { group }: { group: number } = $props();

	const TAB_MIME = 'application/x-kingu-editor';

	const g = $derived(editors.group(group));
	const tabs = $derived(g?.tabs ?? []);
	const activePath = $derived(g?.active ?? null);
	const focused = $derived(editors.activeGroupId === group);
	const settingsActive = $derived(activePath === SETTINGS_EDITOR_KEY);
	const adeActive = $derived(activePath !== null && isAdeEditor(activePath));
	const taskSlug = $derived(activePath ? slugOfTaskKey(activePath) : null);
	const crumbs = $derived(!activePath || settingsActive || adeActive || isChangesKey(activePath) ? [] : activePath === USER_SETTINGS_KEY
					? ['User', 'settings.json']
					: activePath === USER_KEYBINDINGS_KEY
						? ['User', 'keybindings.json']
					: activePath.startsWith('snap://user/')
						? ['User Snaps', ...activePath.slice('snap://user/'.length).split('/')]
						: fileOf(activePath).split('/'));
	const label = editorLabel;
	const iconOf = (key: string) =>
		fileIcon(key === SETTINGS_EDITOR_KEY || key === USER_SETTINGS_KEY ? 'settings.json' : isAdeEditor(key) ? 'tasks.md' : fileOf(key));
	/** Breadcrumbs of a workspace file are clickable (not the Settings editor's or user settings'). */
	const crumbsAreFiles = $derived(!!activePath && activePath !== USER_SETTINGS_KEY && !isChangesKey(activePath) && crumbs.length > 0);
	const diffActive = $derived(activePath !== null && isDiffKey(activePath));
	/** Images and Markdown previews have their own viewers instead of Monaco. */
	const viewerActive = $derived(activePath !== null && (isImagePath(activePath) || isPreviewKey(activePath) || isNotebookPath(activePath) || isChangesKey(activePath)));
	// The diff editor exists only while this group has a diff tab.
	const hasDiff = $derived(tabs.some((t) => isDiffKey(t.path)));
	// Enclosing symbols from the language server's document symbols, like VS Code's outline crumbs.
	// The cursor is tracked for the active group only, so other groups show just the path.
	const symbolCrumbs = $derived(activePath && !diffActive && !settingsActive && !adeActive && focused ? lsp.crumbs(activePath, editors.cursor.line, editors.cursor.column) : []);
	let dropTarget = $state<number | null>(null);
	// workbench.editor.showTabs / tabSizing / highlightModifiedTabs
	const showTabs = $derived(settings.get<'multiple' | 'single' | 'none'>('workbench.editor.showTabs'));
	const shownTabs = $derived(showTabs === 'single' ? tabs.filter((t) => t.path === activePath) : tabs);
	const tabSizing = $derived(settings.get<'fit' | 'shrink' | 'fixed'>('workbench.editor.tabSizing'));
	const highlightModified = $derived(settings.get<boolean>('workbench.editor.highlightModifiedTabs'));

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
	let crumbMenu = $state<{ x: number; y: number; rel: string; entries: Entry[] } | null>(null);
	async function openCrumb(rel: string, x: number, y: number) {
		try {
			const entries = await invoke<Entry[]>('fs_list_dir', { rel });
			crumbMenu = { x, y, rel, entries };
		} catch (e) {
			status.error(String(e));
		}
	}
	const crumbItems = $derived(
		crumbMenu ? (crumbMenu.entries.length ? crumbMenu.entries.map((e) => menuItem(e.rel, e.is_dir ? `${e.name}/` : e.name)) : [menuItem('', '(ว่าง)', { enabled: false })]) : []
	);
	function runCrumb(rel: string) {
		const entry = crumbMenu?.entries.find((e) => e.rel === rel);
		const at = crumbMenu;
		crumbMenu = null;
		if (!entry || !at) return;
		if (entry.is_dir) void openCrumb(entry.rel, at.x, at.y);
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
			class="flex h-(--kg-tab-height) shrink-0 items-end gap-0.5 overflow-x-auto bg-(--vscode-editorGroupHeader-tabsBackground) px-1 [scrollbar-width:none]"
			ondragover={(e) => dragOver(e, tabs.length)}
			ondragleave={() => (dropTarget = null)}
			ondrop={(e) => drop(e, tabs.length)}
		>
			{#each shownTabs as tab (tab.path)}
				{@const active = tab.path === activePath}
				{@const i = tabs.indexOf(tab)}
				<div
					role="presentation"
					draggable="true"
					ondragstart={(e) => dragStart(e, tab.path)}
					ondragover={(e) => dragOver(e, i)}
					ondrop={(e) => drop(e, i)}
					ondragend={() => (dropTarget = null)}
					oncontextmenu={(e) => openTabMenu(e, tab.path)}
					class={[
						'group relative flex h-[calc(100%-5px)] items-center gap-1.5 rounded-t-lg pl-2.5 transition-colors',
						tabSizing === 'fit' ? 'shrink-0' : tabSizing === 'shrink' ? 'min-w-[80px] shrink' : 'w-[160px] min-w-[80px] shrink',
						active ? 'bg-(--vscode-tab-activeBackground)' : 'hover:bg-(--vscode-tab-hoverBackground)',
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
					<span class={['flex', !focused && 'opacity-60']}><FileIcon icon={iconOf(tab.path)} /></span>
					{#if tab.sticky}<span class="flex text-(--vscode-icon-foreground) opacity-80" title="Pinned"><Icon name="pin" size={12} /></span>{/if}
					<button
						role="tab"
						aria-selected={active}
						title={isUntitled(tab.path) ? label(tab.path) : tab.path}
						class={['h-full min-w-0 truncate pr-1 whitespace-nowrap', tabSizing !== 'fit' && 'flex-1 text-left', tab.preview && 'italic']}
						onclick={() => editors.open(tab.path, { preview: tab.preview, group })}
						ondblclick={() => editors.pin(tab.path, group)}
						onauxclick={(e) => e.button === 1 && close(tab.path, false)}
					>
						{label(tab.path)}
					</button>
					<button
						aria-label={tab.dirty ? `${label(tab.path)} ยังไม่บันทึก: ปิด` : `ปิด ${label(tab.path)}`}
						class={['mr-1 grid size-5 shrink-0 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground)', !active && !tab.dirty && 'invisible group-hover:visible']}
						onclick={(e) => close(tab.path, e.altKey)}
					>
						{#if tab.dirty}
							<span class="size-2 rounded-full bg-current group-hover:hidden"></span>
							<span class="hidden group-hover:block"><Icon name="close" size={14} /></span>
						{:else}
							<Icon name="close" size={14} />
						{/if}
					</button>
				</div>
			{/each}
			{#if dropTarget === tabs.length}<span class="h-full w-0.5 shrink-0 bg-(--vscode-focusBorder)"></span>{/if}
		</div>
	{/if}
	{#if activePath && !adeActive}
		<nav aria-label="Breadcrumbs" class="flex h-(--kg-breadcrumbs-height) shrink-0 items-center gap-0.5 overflow-hidden px-3 text-(--vscode-breadcrumb-foreground)">
			{#each crumbs as c, i (i)}
				{#if i > 0}<Icon name="chevronRight" size={14} />{/if}
				{#if crumbsAreFiles}
					<button
						class="rounded px-0.5 whitespace-nowrap hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)"
						title={i < crumbs.length - 1 ? 'ไฟล์ในโฟลเดอร์นี้' : 'ไฟล์ข้างเคียง'}
						onclick={(e) => {
							const r = e.currentTarget.getBoundingClientRect();
							// A folder lists itself; the file name lists its folder (its siblings).
							void openCrumb(crumbs.slice(0, i < crumbs.length - 1 ? i + 1 : i).join('/'), r.left, r.bottom + 2);
						}}>{c}</button
					>
				{:else}
					<span class="whitespace-nowrap">{c}</span>
				{/if}
			{/each}
			{#each symbolCrumbs as s, i (i)}
				<Icon name="chevronRight" size={14} />
				<button class="whitespace-nowrap hover:text-(--vscode-foreground)" onclick={() => editors.gotoLine(s.range.start.line + 1, s.range.start.character + 1)}>{s.name}</button>
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
		{#if activePath && isImagePath(activePath)}
			<div class="absolute inset-0">{#key activePath}<ImageViewer path={activePath} />{/key}</div>
		{:else if activePath && isChangesKey(activePath)}
			<div class="absolute inset-0">{#key activePath}<CombinedDiff changesKey={activePath} />{/key}</div>
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
		{/if}
		{#if !activePath && editors.groups.length === 1}
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

{#if tabMenu}
	{@const m = tabMenu}
	<PopupMenu items={tabMenuItems(m.path)} label="Editor tab" x={m.x} y={m.y} onRun={(node) => node.type === 'item' && runTabMenu(node.id, m.path)} onClose={() => (tabMenu = null)} />
{/if}
{#if crumbMenu}
	<PopupMenu items={crumbItems} label="Breadcrumb" x={crumbMenu.x} y={crumbMenu.y} focusFirst onRun={(node) => node.type === 'item' && runCrumb(node.id)} onClose={() => (crumbMenu = null)} />
{/if}
