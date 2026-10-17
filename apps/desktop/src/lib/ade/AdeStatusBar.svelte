<script lang="ts">
	// Agents layout status bar (Orca's): agent activity and cost of this folder on the left, the
	// selected worktree's branch on the right. Clicking the activity opens the waiting session.
	import Icon from '#lib/workbench/Icon.svelte';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { pickSession } from './agentsMode.svelte';
	import { adeLayout } from './adeLayout.svelte';
	import { runtime } from './runtime.svelte';
	import { adeTasks } from './tasks.svelte';

	const counts = $derived(adeTasks.counts);
	const cost = $derived(adeTasks.views.reduce((sum, v) => sum + (runtime.run(v.meta.slug)?.result?.total_cost_usd ?? v.meta.last_run?.cost_usd ?? 0), 0));
	const branch = $derived(adeLayout.key ? `kingu/${adeLayout.key}` : status.branch);
	const ITEM = 'flex h-full items-center gap-1.5 px-2 hover:bg-(--vscode-toolbar-hoverBackground)';
</script>

<footer
	class="flex h-(--kg-statusbar-height) shrink-0 items-center border-t border-(--vscode-statusBar-border) bg-(--vscode-statusBar-background) text-xs text-(--vscode-statusBar-foreground)"
	aria-label="Status Bar"
>
	<button class={ITEM} title="เลือก session" onclick={pickSession}>
		<Icon name="agent" size={13} />
		{counts.inProgress} กำลังทำ
		{#if counts.needsInput}<span class="text-(--vscode-editorWarning-foreground)">· {counts.needsInput} รอคุณ</span>{/if}
	</button>
	{#if cost > 0}<span class="px-2 tabular-nums" title="ค่าใช้จ่าย agent ในโฟลเดอร์นี้">${cost.toFixed(2)}</span>{/if}
	{#if status.message}<span class="min-w-0 truncate px-2">{status.message}</span>{/if}
	<span class="flex-1"></span>
	{#if branch}<span class="flex items-center gap-1 truncate px-2 font-mono" title="branch ของ worktree ที่เลือก"><Icon name="branch" size={13} />{branch}</span>{/if}
</footer>
