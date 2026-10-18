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
	import { commands } from './commands.svelte';
	import PopupMenu, { menuItem, menuSeparator } from './PopupMenu.svelte';
	import type { MenuNode } from './menus';
	import { tabsToClose, type TabClose } from './tabMenu';
	import { invoke } from '@tauri-apps/api/core';
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
	import { status } from './status.svelte';
	import SettingsEditor from '#lib/settings/SettingsEditor.svelte';
	import { SETTINGS_EDITOR_KEY, USER_SETTINGS_KEY } from '#lib/settings/settings.svelte.ts';
	import Board from '#lib/ade/Board.svelte';
	import TaskPage from '#lib/ade/TaskPage.svelte';
	import { isAdeEditor, isBoardKey, slugOfTaskKey } from '#lib/ade/keys.ts';
	import { adeLayout } from '#lib/ade/adeLayout.svelte.ts';

	let { group }: { group: number } = $props();

	const TAB_MIME = 'application/x-kingu-editor';

	const g = $derived(editors.group(group));
	const tabs = $derived(g?.tabs ?? []);
	const activePath = $derived(g?.active ?? null);
	const focused = $derived(editors.activeGroupId === group);
	const settingsActive = $derived(activePath === SETTINGS_EDITOR_KEY);
	const adeActive = $derived(activePath !== null && isAdeEditor(activePath));
	const taskSlug = $derived(activePath ? slugOfTaskKey(activePath) : null);
	const crumbs = $derived(!activePath || settingsActive || adeActive || isChangesKey(activePath) ? [] : activePath === USER_SETTINGS_KEY ? ['User', 'settings.json'] : fileOf(activePath).split('/'));
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

	function close(path: string, force: boolean) {
		// A file also open in the Agents layout keeps its model (and unsaved edits) there.
		if (!editors.close(path, { force: force || adeLayout.openFiles().includes(path), group })) status.flash('มีการแก้ไขที่ยังไม่บันทึก: กด ⌘S ก่อน หรือกด ⌥ ค้างแล้วคลิก × เพื่อทิ้งการแก้ไข');
	}

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

	const watermark = [
		['Show All Commands', 'cmd+shift+p'],
		['Go to File', 'cmd+p'],
		['Split Editor', 'cmd+\\'],
		['Toggle Terminal', 'ctrl+`'],
		['Toggle Arkai', 'cmd+alt+b'],
		['Zen Mode', 'cmd+k z']
	];

	// Tab context menu (VS Code's editor tab menu).
	let tabMenu = $state<{ path: string; x: number; y: number } | null>(null);
	const isFileTab = (path: string) => !isNonTextEditor(path) || isPreviewKey(path) || isImagePath(path);
	const tabMenuItems = $derived.by((): MenuNode[] => {
		if (!tabMenu) return [];
		const path = tabMenu.path;
		const tab = tabs.find((t) => t.path === path);
		const file = isFileTab(path);
		return [
			menuItem('close', 'Close', { keyLabel: '⌘W' }),
			menuItem('others', 'Close Others', { enabled: tabs.length > 1 }),
			menuItem('right', 'Close to the Right', { enabled: tabsToClose('right', tabs, path).length > 0 }),
			menuItem('saved', 'Close Saved'),
			menuItem('all', 'Close All'),
			menuSeparator,
			menuItem('copyPath', 'Copy Path', { enabled: file }),
			menuItem('copyRelative', 'Copy Relative Path', { enabled: file }),
			menuItem('reveal', 'Reveal in Finder', { enabled: file }),
			menuSeparator,
			menuItem('keep', 'Keep Open', { enabled: !!tab?.preview }),
			menuItem('split', 'Split Right')
		];
	});
	async function runTabMenu(id: string, path: string) {
		const rel = fileOf(path);
		switch (id) {
			case 'close':
				return close(path, false);
			case 'others':
			case 'right':
			case 'saved':
			case 'all': {
				const dirtySkipped = tabsToClose(id as TabClose, tabs, path).filter((p) => !editors.close(p, { group })).length;
				if (dirtySkipped) status.flash(`ข้าม ${dirtySkipped} แท็บที่ยังไม่บันทึก`);
				return;
			}
			case 'copyPath':
			case 'copyRelative': {
				const text = id === 'copyPath' && workspace.root ? `${workspace.root}/${rel}` : rel;
				await navigator.clipboard.writeText(text);
				return status.flash(`คัดลอก ${text} แล้ว`, 3000);
			}
			case 'reveal':
				return invoke('fs_reveal', { rel }).catch((e) => status.error(String(e)));
			case 'keep':
				return editors.pin(path, group);
			case 'split': {
				const side = editors.split('right');
				if (side !== null) editors.open(path, { preview: false, group: side });
				return;
			}
		}
	}

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
	{#if tabs.length || editors.groups.length > 1}
		<div
			role="tablist"
			tabindex="-1"
			aria-label="Editor tabs"
			class="flex h-(--kg-tab-height) shrink-0 items-end gap-0.5 overflow-x-auto bg-(--vscode-editorGroupHeader-tabsBackground) px-1 [scrollbar-width:none]"
			ondragover={(e) => dragOver(e, tabs.length)}
			ondragleave={() => (dropTarget = null)}
			ondrop={(e) => drop(e, tabs.length)}
		>
			{#each tabs as tab, i (tab.path)}
				{@const active = tab.path === activePath}
				<div
					role="presentation"
					draggable="true"
					ondragstart={(e) => dragStart(e, tab.path)}
					ondragover={(e) => dragOver(e, i)}
					ondrop={(e) => drop(e, i)}
					ondragend={() => (dropTarget = null)}
					oncontextmenu={(e) => (e.preventDefault(), (tabMenu = { path: tab.path, x: e.clientX, y: e.clientY }))}
					class={[
						'group relative flex h-[calc(100%-5px)] shrink-0 items-center gap-1.5 rounded-t-lg pl-2.5 transition-colors',
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
					{#if active && focused}<span class="absolute inset-x-2.5 top-0 h-0.5 rounded-b-full bg-(--vscode-tab-activeBorderTop)"></span>{/if}
					{#if dropTarget === i}<span class="absolute inset-y-0 left-0 w-0.5 bg-(--vscode-focusBorder)"></span>{/if}
					<span class={['flex', !focused && 'opacity-60']}><FileIcon icon={iconOf(tab.path)} /></span>
					<button
						role="tab"
						aria-selected={active}
						title={tab.path}
						class={['h-full pr-1 whitespace-nowrap', tab.preview && 'italic']}
						onclick={() => editors.open(tab.path, { preview: tab.preview, group })}
						ondblclick={() => editors.pin(tab.path, group)}
						onauxclick={(e) => e.button === 1 && close(tab.path, false)}
					>
						{label(tab.path)}
					</button>
					<button
						aria-label={tab.dirty ? `${label(tab.path)} ยังไม่บันทึก: ปิด` : `ปิด ${label(tab.path)}`}
						class={['mr-1 grid size-5 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground)', !active && !tab.dirty && 'invisible group-hover:visible']}
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
		<div class={['absolute inset-0', (!activePath || diffActive || settingsActive || adeActive || viewerActive) && 'invisible']}>
			<EditorHost {group} />
		</div>
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
	{@const target = tabMenu.path}
	<PopupMenu items={tabMenuItems} label="Editor Tab" x={tabMenu.x} y={tabMenu.y} onRun={(node) => node.type === 'item' && runTabMenu(node.id, target)} onClose={() => (tabMenu = null)} />
{/if}
{#if crumbMenu}
	<PopupMenu items={crumbItems} label="Breadcrumb" x={crumbMenu.x} y={crumbMenu.y} focusFirst onRun={(node) => node.type === 'item' && runCrumb(node.id)} onClose={() => (crumbMenu = null)} />
{/if}

