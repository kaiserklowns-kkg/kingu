<script lang="ts">
	// One editor group (VS Code: EditorGroupView): its tab strip, breadcrumbs, a Monaco editor for
	// file tabs and a diff editor while it has a diff tab. Inactive groups dim their tabs.
	import { lsp } from '#lib/lsp/lsp.svelte.ts';
	import DiffHost from './DiffHost.svelte';
	import EditorHost from './EditorHost.svelte';
	import FileIcon from './FileIcon.svelte';
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
	const crumbs = $derived(!activePath || settingsActive || adeActive ? [] : activePath === USER_SETTINGS_KEY ? ['User', 'settings.json'] : fileOf(activePath).split('/'));
	const label = editorLabel;
	const iconOf = (key: string) =>
		fileIcon(key === SETTINGS_EDITOR_KEY || key === USER_SETTINGS_KEY ? 'settings.json' : isAdeEditor(key) ? 'tasks.md' : fileOf(key));
	const diffActive = $derived(activePath !== null && isDiffKey(activePath));
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
		['Toggle Agent', 'cmd+alt+b']
	];
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
			class="flex h-(--kg-tab-height) shrink-0 overflow-x-auto bg-(--vscode-editorGroupHeader-tabsBackground) [scrollbar-width:none]"
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
					class={[
						'group relative flex h-full shrink-0 items-center gap-1.5 border-r border-(--vscode-tab-border) pl-2.5',
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
					{#if active && focused}<span class="absolute inset-x-0 top-0 h-px bg-(--vscode-tab-activeBorderTop)"></span>{/if}
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
						class={['mr-1 grid size-5 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)', !active && !tab.dirty && 'invisible group-hover:visible']}
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
				<span class="whitespace-nowrap">{c}</span>
			{/each}
			{#each symbolCrumbs as s, i (i)}
				<Icon name="chevronRight" size={14} />
				<button class="whitespace-nowrap hover:text-(--vscode-foreground)" onclick={() => editors.gotoLine(s.range.start.line + 1, s.range.start.character + 1)}>{s.name}</button>
			{/each}
		</nav>
	{/if}

	<div class="relative min-h-0 flex-1">
		<div class={['absolute inset-0', (!activePath || diffActive || settingsActive || adeActive) && 'invisible']}>
			<EditorHost {group} />
		</div>
		{#if hasDiff}
			<div class={['absolute inset-0', !diffActive && 'invisible']}>
				<DiffHost active={activePath} onfail={(key) => editors.close(key, { force: true, group })} reportLanguage={focused} />
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
				<dl class="grid grid-cols-[auto_auto] gap-x-4 gap-y-2 text-(--vscode-descriptionForeground)">
					{#each watermark as [label, key] (label)}
						<dt class="text-right">{label}</dt>
						<dd class="font-mono tracking-widest">{keyLabel(key)}</dd>
					{/each}
				</dl>
			</div>
		{/if}
	</div>
</section>
