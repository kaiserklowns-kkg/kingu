<script lang="ts">
	// Kanban board editor (`board://`): รอคุณ / กำลังทำ / เสร็จแล้ว columns of task cards.
	import Icon from '#lib/workbench/Icon.svelte';
	import NewTaskForm from './NewTaskForm.svelte';
	import TaskCard from './TaskCard.svelte';
	import { COLUMNS } from './model';
	import { adeTasks } from './tasks.svelte';
	import { BUTTON, ICON_BUTTON } from './ui';
	import { settings } from '#lib/settings/settings.svelte.ts';

	// Orca's workspace board look: column width (px) and column opacity.
	const width = $derived(settings.get<number>('kingu.board.columnWidth'));
	const opacity = $derived(Math.round(settings.get<number>('kingu.board.opacity') * 100));
	import { cleanup } from './cleanup.svelte';

	const COLUMN_DOT = { attention: 'bg-(--vscode-editorWarning-foreground)', active: 'bg-(--vscode-editorInfo-foreground)', done: 'bg-[#73C991]' };
</script>

<div class="flex h-full flex-col overflow-hidden bg-(--vscode-editor-background) text-(--vscode-foreground)">
	<header class="flex shrink-0 items-center gap-2 border-b border-(--vscode-widget-border) px-4 py-2">
		<h1 class="flex items-center gap-2 text-sm font-semibold"><Icon name="tasks" size={16} />บอร์ดงาน</h1>
		<span class="text-xs text-(--vscode-descriptionForeground)">{adeTasks.list.length} งาน</span>
		<span class="flex-1"></span>
		<button class={BUTTON} onclick={() => (adeTasks.composing = !adeTasks.composing)}><Icon name="plus" size={14} /> งานใหม่</button>
		<button class={ICON_BUTTON} aria-label="ล้างงาน" title="ล้างงานที่เสร็จแล้ว (Clean Up Tasks)" disabled={!adeTasks.views.length} onclick={() => (cleanup.open = true)}><Icon name="trash" size={16} /></button>
		<button class={ICON_BUTTON} aria-label="รีเฟรช" title="รีเฟรช" onclick={() => adeTasks.load()}><Icon name="refresh" size={16} /></button>
	</header>
	{#if adeTasks.composing}
		<div class="max-w-xl shrink-0 px-2"><NewTaskForm /></div>
	{/if}
	<div class="grid min-h-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden p-4" style:grid-template-columns="repeat(3, {width}px)">
		{#each COLUMNS as col (col.id)}
			{@const list = adeTasks.groups[col.id]}
			<section
				aria-label={col.label}
				class="flex min-h-0 flex-col rounded-xl border border-(--vscode-widget-border)"
				style:background="color-mix(in srgb, var(--vscode-sideBar-background) {opacity}%, transparent)"
			>
				<h2 class="flex shrink-0 items-center gap-2 px-3.5 py-2.5 text-xs font-semibold" title={col.hint}>
					<span class={['size-2 rounded-full', COLUMN_DOT[col.id]]}></span>
					{col.label}
					<span class="rounded-full bg-(--vscode-badge-background) px-1.5 text-[10px] leading-4 font-normal text-(--vscode-badge-foreground)">{list.length}</span>
				</h2>
				<div class="min-h-0 flex-1 space-y-2 overflow-y-auto px-2.5 pb-2.5">
					{#each list as view (view.meta.slug)}
						<TaskCard {view} />
					{:else}
						<p class="rounded-lg border border-dashed border-(--vscode-widget-border) px-3 py-6 text-center text-xs text-(--vscode-descriptionForeground)">ไม่มีงาน</p>
					{/each}
				</div>
			</section>
		{/each}
	</div>
</div>
