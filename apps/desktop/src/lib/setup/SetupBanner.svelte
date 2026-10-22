<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import { setup } from './setup.svelte.ts';
	import { failures, readiness } from './setup.ts';
	import { metaOf } from './setupMeta.ts';

	onMount(() => void setup.load());

	const state = $derived(readiness(setup.report));
	const blockers = $derived(failures(setup.report));
</script>

{#if state === 'blocked' || state === 'warn'}
	<section
		class={[
			'flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3',
			state === 'blocked'
				? 'border-(--vscode-inputValidation-errorBorder) bg-(--vscode-inputValidation-errorBackground)'
				: 'border-(--vscode-editorWarning-foreground)/40 bg-(--vscode-editorWarning-foreground)/5'
		]}
		aria-live="polite"
	>
		<span class={state === 'blocked' ? 'text-(--vscode-errorForeground)' : 'text-(--vscode-editorWarning-foreground)'}><Icon name={state === 'blocked' ? 'error' : 'warning'} size={18} /></span>
		<div class="min-w-0 flex-1">
			<div class="text-[13px] font-medium">
				{state === 'blocked' ? t('setup.summaryBlocked', { count: blockers.length }) : t('setup.warnBadgeHint', { count: setup.report?.checks.filter((c) => c.status === 'warn').length ?? 0 })}
			</div>
			<div class="truncate text-xs text-(--vscode-descriptionForeground)">
				{blockers.map((c) => t(metaOf(c.id).title)).join(' · ')}
			</div>
		</div>
		<button class="h-8 shrink-0 rounded-md bg-(--vscode-button-background) px-3 text-[13px] text-(--vscode-button-foreground) hover:opacity-90" onclick={() => systemSettings.showPage('setup')}>
			{t('setup.open')}
		</button>
	</section>
{/if}
