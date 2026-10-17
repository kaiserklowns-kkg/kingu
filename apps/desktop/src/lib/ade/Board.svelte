<script lang="ts">
	// Kanban board editor (`board://`): รอคุณ / กำลังทำ / เสร็จแล้ว columns of task cards.
	import Icon from '#lib/workbench/Icon.svelte';
	import NewTaskForm from './NewTaskForm.svelte';
	import TaskCard from './TaskCard.svelte';
	import { COLUMNS } from './model';
	import { adeTasks } from './tasks.svelte';
	import { BUTTON, ICON_BUTTON } from './ui';
</script>

<div class="flex h-full flex-col overflow-hidden bg-(--vscode-editor-background) text-(--vscode-foreground)">
	<header class="flex shrink-0 items-center gap-2 border-b border-(--vscode-widget-border) px-4 py-2">
		<h1 class="text-sm font-semibold">บอร์ดงาน Agents</h1>
		<span class="text-xs text-(--vscode-descriptionForeground)">{adeTasks.list.length} งาน</span>
		<span class="flex-1"></span>
		<button class={BUTTON} onclick={() => (adeTasks.composing = !adeTasks.composing)}><Icon name="plus" size={14} /> งานใหม่</button>
		<button class={ICON_BUTTON} aria-label="รีเฟรช" title="รีเฟรช" onclick={() => adeTasks.load()}><Icon name="refresh" size={16} /></button>
	</header>
	{#if adeTasks.composing}
		<div class="max-w-xl shrink-0 px-2"><NewTaskForm /></div>
	{/if}
	<div class="grid min-h-0 flex-1 grid-cols-3 gap-3 overflow-hidden p-3">
		{#each COLUMNS as col (col.id)}
			{@const list = adeTasks.groups[col.id]}
			<section aria-label={col.label} class="flex min-h-0 flex-col rounded border border-(--vscode-widget-border) bg-(--vscode-sideBar-background)">
				<h2 class="flex shrink-0 items-center gap-2 px-3 py-2 text-xs font-semibold" title={col.hint}>
					{col.label}
					<span class="rounded-full bg-(--vscode-badge-background) px-1.5 text-[10px] leading-4 font-normal text-(--vscode-badge-foreground)">{list.length}</span>
				</h2>
				<div class="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
					{#each list as view (view.meta.slug)}
						<TaskCard {view} />
					{:else}
						<p class="px-1 text-xs text-(--vscode-descriptionForeground)">ว่าง</p>
					{/each}
				</div>
			</section>
		{/each}
	</div>
</div>
