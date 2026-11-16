<script lang="ts">
	// Orca's background worktree creation: a progress row per task being created in this folder
	// (adeTasks.startCreate) with the step it is on and Cancel, until its card appears (later steps
	// — setup, the agent's start — show on the card); a failed one offers Retry and Dismiss.
	import Icon from '#lib/workbench/Icon.svelte';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { adeTasks } from './tasks.svelte';
	import { t } from '#lib/i18n/index.ts';

	const rows = $derived(adeTasks.creating.filter((c) => c.root === workspace.root));
</script>

{#each rows as c (c.id)}
	<div class="mx-1 flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px]" role="status" aria-live="polite">
		{#if c.failed}
			<span class="text-(--vscode-errorForeground)"><Icon name="error" size={12} /></span>
			<span class="min-w-0 flex-1 truncate" title={t('ade.creating.failed', { title: c.title })}>{c.title}</span>
			<button class="shrink-0 rounded px-1 text-[11px] text-(--vscode-textLink-foreground) hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => adeTasks.retryCreate(c.id)}>{t('ade.creating.retry')}</button>
			<button class="shrink-0 rounded px-1 text-[11px] opacity-70 hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={t('ade.creating.dismiss')} title={t('ade.creating.dismiss')} onclick={() => adeTasks.dismissCreate(c.id)}><Icon name="close" size={12} /></button>
		{:else}
			<span class="animate-spin opacity-70"><Icon name="sync" size={12} /></span>
			<span class="min-w-0 flex-1 truncate">{c.title}</span>
			<span class="max-w-28 shrink-0 truncate text-[10px] opacity-60">{c.cancelling ? t('ade.creating.cancelling') : c.step === 'base' ? t('ade.creating.stepBase') : c.step === 'worktree' ? t('ade.creating.stepWorktree') : t('ade.creating.progress')}</span>
			{#if !c.cancelling}
				<button class="shrink-0 rounded px-1 opacity-70 hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={t('ade.creating.cancel')} title={t('ade.creating.cancel')} onclick={() => adeTasks.cancelCreate(c.id)}><Icon name="close" size={12} /></button>
			{/if}
		{/if}
	</div>
{/each}
