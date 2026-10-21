<script lang="ts">
	// The Timeline section under the Explorer (VS Code's TimelinePane): the active file's history.
	// A click opens the commit's changes as a preview, a double click pins it; the context menu
	// copies the commit hash or message (git.timeline.copyCommitId / copyCommitMessage).
	// `timeline.pageOnScroll` loads the next page at the end of the list, else "Load more".
	// Local History entries (localHistory.svelte.ts) are merged in by time, with VS Code's entry
	// actions in their context menu; the filter button hides either source.
	import { t } from '#lib/i18n/index.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import Icon from '#lib/workbench/Icon.svelte';
	import PopupMenu, { menuItem } from '#lib/workbench/PopupMenu.svelte';
	import { copyCommitId, copyCommitMessage, timeline, timelineView, type TimelineItem } from './timeline.svelte';
	import { localHistory } from './localHistory.svelte';
	import { commands } from '#lib/workbench/commands.svelte.ts';
	import { menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import type { MenuNode } from '#lib/workbench/menus.ts';
	import { listKeys } from '#lib/workbench/listKeys.ts';

	let selected = $state<string | null>(null);
	let menu = $state<{ x: number; y: number; item: TimelineItem } | null>(null);
	let filterMenu = $state<{ x: number; y: number } | null>(null);
	const keyOf = (item: TimelineItem) => (item.kind === 'commit' ? item.commit.hash : item.kind === 'local' ? `local:${item.entry.id}` : item.kind);

	function itemMenu(item: TimelineItem): MenuNode[] {
		if (item.kind === 'commit') return [menuItem('open', t('scmEditor.timeline.openChanges')), menuItem('hash', t('scmEditor.timeline.copyHash')), menuItem('message', t('scmEditor.timeline.copyMessage'))];
		if (item.kind !== 'local' || !timeline.path) return [];
		const p = timeline.path;
		return [
			menuItem('lh.compareWithFile', t('localHistory.compareWithFile')),
			menuItem('lh.compareWithPrevious', t('localHistory.compareWithPrevious')),
			menuItem('lh.selectForCompare', t('localHistory.selectForCompare')),
			menuItem('lh.compareWithSelected', t('localHistory.compareWithSelected'), { enabled: localHistory.canCompareWithSelected(p, item.entry) }),
			menuSeparator,
			menuItem('lh.show', t('localHistory.showContents')),
			menuItem('lh.restore', t('localHistory.restore')),
			menuSeparator,
			menuItem('lh.rename', t('localHistory.rename')),
			menuItem('lh.delete', t('localHistory.delete'))
		];
	}

	function runLocal(id: string, entry: Extract<TimelineItem, { kind: 'local' }>['entry']) {
		const p = timeline.path;
		if (!p) return;
		if (id === 'lh.compareWithFile') localHistory.compareWithFile(p, entry, false);
		else if (id === 'lh.compareWithPrevious') localHistory.compareWithPrevious(p, entry);
		else if (id === 'lh.selectForCompare') localHistory.selectForCompare(p, entry);
		else if (id === 'lh.compareWithSelected') localHistory.compareWithSelected(p, entry);
		else if (id === 'lh.show') localHistory.show(p, entry);
		else if (id === 'lh.restore') void localHistory.restore(p, entry);
		else if (id === 'lh.rename') void localHistory.rename(p, entry);
		else if (id === 'lh.delete') void localHistory.remove(p, entry);
	}
	const name = $derived(timeline.path ? timeline.path.slice(timeline.path.lastIndexOf('/') + 1) : '');

	function onScroll(e: Event) {
		const el = e.currentTarget as HTMLElement;
		if (settings.get<boolean>('timeline.pageOnScroll') && el.scrollTop + el.clientHeight >= el.scrollHeight - 8) void timeline.loadMore();
	}
</script>

<section class={['flex min-h-0 flex-col border-t border-(--vscode-sideBarSectionHeader-border,transparent)', timelineView.open ? 'h-[38%] shrink-0' : 'shrink-0']}>
	<div class="group flex h-(--kg-row-height) shrink-0 items-center pr-1">
		<button
			class="flex h-full min-w-0 flex-1 items-center gap-0.5 px-0.5 text-[11px] font-bold uppercase text-(--vscode-sideBarTitle-foreground)"
			aria-expanded={timelineView.open}
			onclick={() => (timelineView.open = !timelineView.open)}
		>
			<Icon name={timelineView.open ? 'chevronDown' : 'chevronRight'} size={16} />
			<span class="truncate">{t('scmEditor.timeline.title')}</span>
			{#if timelineView.open && name}<span class="truncate pl-1 font-normal normal-case text-(--vscode-descriptionForeground)">{name}</span>{/if}
		</button>
		{#if timelineView.open}
			<button
				class="kg-view-actions grid size-[22px] place-items-center rounded text-(--vscode-icon-foreground) opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-(--vscode-toolbar-hoverBackground)"
				aria-label={t('localHistory.filter')}
				title={t('localHistory.filter')}
				onclick={(e) => {
					const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
					filterMenu = { x: r.left, y: r.bottom + 2 };
				}}><span class="codicon codicon-filter" aria-hidden="true"></span></button
			>
			<button
				class="kg-view-actions grid size-[22px] place-items-center rounded text-(--vscode-icon-foreground) opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-(--vscode-toolbar-hoverBackground)"
				aria-label={t('scmEditor.timeline.refresh')}
				title={t('scmEditor.timeline.refresh')}
				onclick={() => timeline.refresh(true)}><Icon name="refresh" size={16} /></button
			>
		{/if}
	</div>
	{#if timelineView.open}
		<div class="min-h-0 flex-1 overflow-y-auto" role="list" onscroll={onScroll} use:listKeys>
			{#if !timeline.path}
				<p class="px-5 py-1 text-(--vscode-descriptionForeground)">{t('scmEditor.timeline.noFile')}</p>
			{:else if !timeline.items.length}
				<p class="px-5 py-1 text-(--vscode-descriptionForeground)">{timeline.loading ? t('scmEditor.timeline.loading') : t('scmEditor.timeline.empty')}</p>
			{:else}
				{#each timeline.items as item (keyOf(item))}
					{@const key = keyOf(item)}
					<button
												class={[
							'flex h-(--kg-row-height) w-full min-w-0 items-center gap-1.5 pr-2 pl-4 text-left',
							selected === key ? 'bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground)' : 'hover:bg-(--vscode-list-hoverBackground)'
						]}
						title={timeline.tooltip(item)}
						onclick={() => ((selected = key), timeline.open(item, true))}
						ondblclick={() => timeline.open(item, false)}
						oncontextmenu={(e) => {
							e.preventDefault();
							selected = key;
							if (item.kind === 'commit' || item.kind === 'local') menu = { x: e.clientX, y: e.clientY, item };
						}}
					>
						{#if item.kind === 'local'}
							<!-- VS Code's localHistory-icon (circle-outline). -->
							<span class="codicon codicon-circle-outline w-[14px] shrink-0 text-[14px] text-(--vscode-icon-foreground)" aria-hidden="true"></span>
						{:else}
							<span class="shrink-0 text-(--vscode-icon-foreground)"><Icon name={item.kind === 'commit' ? 'commit' : 'edit'} size={14} /></span>
						{/if}
						<span class="min-w-0 shrink truncate">{timeline.label(item)}</span>
						<span class="min-w-0 flex-1 truncate text-[0.9em] text-(--vscode-descriptionForeground)">{timeline.description(item)}</span>
						<span class="shrink-0 text-[0.9em] text-(--vscode-descriptionForeground)">{timeline.ago(item)}</span>
					</button>
				{/each}
				{#if timeline.more && !settings.get<boolean>('timeline.pageOnScroll')}
					<button class="w-full px-4 py-1 text-left text-(--vscode-textLink-foreground) hover:underline" onclick={() => timeline.loadMore()}>{t('scmEditor.timeline.loadMore')}</button>
				{/if}
			{/if}
		</div>
	{/if}
</section>

{#if menu}
	{@const item = menu.item}
	<PopupMenu
		items={itemMenu(item)}
		label={t('scmEditor.timeline.title')}
		x={menu.x}
		y={menu.y}
		onRun={(node) => {
			if (node.type !== 'item') return;
			if (item.kind === 'local') return runLocal(node.id, item.entry);
			if (item.kind !== 'commit') return;
			if (node.id === 'open') timeline.open(item, false);
			else if (node.id === 'hash') void copyCommitId(item.commit);
			else if (node.id === 'message') void copyCommitMessage(item.commit);
		}}
		onClose={() => (menu = null)}
	/>
{/if}

{#if filterMenu}
	<PopupMenu
		items={[
			menuItem('git', t('localHistory.gitTitle'), { checked: !timeline.excluded.includes('git') }),
			menuItem('local', t('localHistory.title'), { checked: !timeline.excluded.includes('local') }),
			menuSeparator,
			menuItem('find', t('localHistory.findEntry'))
		]}
		label={t('localHistory.filter')}
		x={filterMenu.x}
		y={filterMenu.y}
		onRun={(node) => {
			if (node.type !== 'item') return;
			if (node.id === 'git' || node.id === 'local') timeline.toggleSource(node.id);
			else if (node.id === 'find') void commands.run('workbench.action.localHistory.restoreViaPicker');
		}}
		onClose={() => (filterMenu = null)}
	/>
{/if}
