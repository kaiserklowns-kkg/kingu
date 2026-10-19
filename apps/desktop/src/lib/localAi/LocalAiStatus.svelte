<script lang="ts">
	// The Local AI status item: completions off (dimmed), on, asking the model (spinning) or failed
	// (warning colour, the error in the tooltip); the semantic index's progress while it builds.
	// Click opens the Local AI menu.
	import Icon from '#lib/workbench/Icon.svelte';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import { localAi } from './localAi.svelte';

	const model = $derived(settings.get<string>('kingu.completions.model')?.trim() || t('localAi.status.autoModel'));
	const indexing = $derived(localAi.semantic?.state === 'building' && localAi.semantic.total > 0 ? localAi.semantic : null);
	const title = $derived(
		[
			localAi.state === 'off'
				? t('localAi.status.off')
				: localAi.state === 'loading'
					? t('localAi.status.loading')
					: localAi.state === 'error'
						? t('localAi.status.error', { error: localAi.error })
						: t('localAi.status.idle', { model }),
			indexing ? t('localAi.status.indexing', { done: indexing.done, total: indexing.total }) : ''
		]
			.filter(Boolean)
			.join('\n')
	);
</script>

<button
	class={[
		'flex h-full items-center gap-1 px-2 hover:bg-(--vscode-toolbar-hoverBackground)',
		localAi.state === 'off' && 'opacity-60',
		localAi.state === 'error' && 'text-(--vscode-editorWarning-foreground)'
	]}
	{title}
	aria-label={t('localAi.status.label')}
	onclick={() => void localAi.menu()}
>
	{#if localAi.state === 'loading'}
		<span class="inline-block size-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent"></span>
	{:else}
		<Icon name={localAi.state === 'error' ? 'warning' : 'sparkle'} size={14} />
	{/if}
	{#if indexing}<span class="tabular-nums">{indexing.done}/{indexing.total}</span>{/if}
</button>
