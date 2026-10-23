<script lang="ts">
	// Agents side-bar view: every task at a glance, grouped รอคุณ / กำลังทำ / เสร็จแล้ว.
	import Icon from '#lib/workbench/Icon.svelte';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import NewTaskForm from './NewTaskForm.svelte';
	import TaskCard from './TaskCard.svelte';
	import { COLUMNS, type Column } from './model';
	import { adeTasks } from './tasks.svelte';
	import { ICON_BUTTON } from './ui';
	import type { AgentsFilter } from '#lib/workbench/titlebar.ts';
	import { t } from '#lib/i18n/index.ts';

	/** The Agents layout shows one status group after a click on an agents status section. */
	let { filter = 'all', onClearFilter }: { filter?: AgentsFilter; onClearFilter?: () => void } = $props();
	const FILTER_LABEL: Record<AgentsFilter, string> = $derived({
		all: t('legacyAde.agentsView.filterAll'),
		needsInput: t('legacyAde.agentsView.filterNeedsInput'),
		inProgress: t('legacyAde.agentsView.filterInProgress'),
		unread: t('legacyAde.agentsView.filterUnread')
	});
	const filtered = $derived(filter === 'all' ? [] : adeTasks.filtered(filter));

	let collapsed = $state<Record<Column, boolean>>({ attention: false, active: false, done: true });
</script>

<div class="flex min-h-0 flex-1 flex-col">
	{#if !workspace.root}
		<p class="p-4 text-xs text-(--vscode-descriptionForeground)">{t('legacyAde.agentsView.openGitRepo')}</p>
	{:else}
		<div class="flex shrink-0 items-center gap-1 px-2 pb-1">
			<button
				class="inline-flex h-6 flex-1 items-center justify-center gap-1 rounded-sm border border-(--vscode-widget-border) text-xs hover:bg-(--vscode-toolbar-hoverBackground)"
				onclick={() => (adeTasks.composing = !adeTasks.composing)}
				aria-expanded={adeTasks.composing}
			>
				<Icon name="plus" size={14} /> {t('legacyAde.agentsView.newTask')}
			</button>
			<button class={ICON_BUTTON} aria-label={t('legacyAde.agentsView.openBoard')} title={t('legacyAde.agentsView.openBoardTip')} onclick={() => adeTasks.openBoard()}><Icon name="tasks" size={16} /></button>
			<button class={ICON_BUTTON} aria-label={t('legacyAde.agentsView.refresh')} title={t('legacyAde.agentsView.refresh')} onclick={() => adeTasks.load()}><Icon name="refresh" size={16} /></button>
		</div>
		{#if adeTasks.composing}<NewTaskForm />{/if}

		<div class="min-h-0 flex-1 overflow-y-auto">
			{#if filter !== 'all'}
				<div class="flex h-(--kg-row-height) items-center gap-1 px-2 text-[11px] font-bold uppercase">
					<span class="flex-1 truncate">{FILTER_LABEL[filter]}</span>
					<span class="rounded-full bg-(--vscode-badge-background) px-1.5 text-[10px] leading-4 font-normal text-(--vscode-badge-foreground)">{filtered.length}</span>
					<button class={ICON_BUTTON} aria-label={t('legacyAde.agentsView.showAll')} title={t('legacyAde.agentsView.showAllTip')} onclick={() => onClearFilter?.()}><Icon name="close" size={14} /></button>
				</div>
				<div class="space-y-1.5 px-2 pb-2">
					{#each filtered as view (view.meta.slug)}
						<TaskCard {view} />
					{:else}
						<p class="px-1 text-xs text-(--vscode-descriptionForeground)">{t('legacyAde.agentsView.noTasksInGroup')}</p>
					{/each}
				</div>
			{:else}
			{#each COLUMNS as col (col.id)}
				{@const list = adeTasks.groups[col.id]}
				<section aria-label={col.label}>
					<button
						class="flex h-(--kg-row-height) w-full items-center gap-1 px-1 text-[11px] font-bold uppercase hover:bg-(--vscode-list-hoverBackground)"
						aria-expanded={!collapsed[col.id]}
						title={col.hint}
						onclick={() => (collapsed[col.id] = !collapsed[col.id])}
					>
						<Icon name={collapsed[col.id] ? 'chevronRight' : 'chevronDown'} size={14} />
						<span class="flex-1 text-left">{col.label}</span>
						{#if list.length}<span class="rounded-full bg-(--vscode-badge-background) px-1.5 text-[10px] leading-4 font-normal text-(--vscode-badge-foreground)">{list.length}</span>{/if}
					</button>
					{#if !collapsed[col.id]}
						<div class="space-y-1.5 px-2 pb-2">
							{#each list as view (view.meta.slug)}
								<TaskCard {view} />
							{:else}
								<p class="px-1 text-xs text-(--vscode-descriptionForeground)">
									{col.id === 'attention' ? t('legacyAde.agentsView.emptyAttention') : col.id === 'active' ? t('legacyAde.agentsView.emptyActive') : t('legacyAde.agentsView.emptyDone')}
								</p>
							{/each}
						</div>
					{/if}
				</section>
			{/each}
			{/if}
			{#if adeTasks.loaded && !adeTasks.list.length && !adeTasks.composing}
				<p class="px-3 py-2 text-xs text-(--vscode-descriptionForeground)">
					{t('legacyAde.agentsView.eachTaskPrefix')} <code>.kingu/worktrees/</code> {t('legacyAde.agentsView.onBranch')} <code>kingu/…</code> {t('legacyAde.agentsView.startHint')}
				</p>
			{/if}
		</div>
	{/if}
</div>
