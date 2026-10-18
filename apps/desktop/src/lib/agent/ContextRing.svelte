<script lang="ts">
	// The context window gauge in the chat input's footer (VS Code's chatContextUsageWidget): a
	// small ring filled to how much of the window the last turn used. Clicking it shows used / max,
	// the session's cost and a Compact button (sends `/compact`; the SDK summarizes the chat).
	import { t } from '#lib/i18n/index.ts';
	import type { ContextUsage } from './events';
	import { contextLevel, contextPercent, formatTokens, ringDash } from './contextUsage.ts';

	let { usage, cost = null, oncompact }: { usage: ContextUsage; cost?: number | null; oncompact?: () => void } = $props();

	let open = $state(false);
	let wrap: HTMLDivElement | undefined = $state();

	const percent = $derived(contextPercent(usage));
	const level = $derived(contextLevel(percent));
	const label = $derived(t('chatInput.ctx.label', { percent }));
	const COLOR = {
		ok: 'var(--vscode-descriptionForeground)',
		warn: 'var(--vscode-editorWarning-foreground)',
		full: 'var(--vscode-errorForeground)'
	} as const;
	const R = 6;

	function onwindowdown(e: PointerEvent) {
		if (open && wrap && !wrap.contains(e.target as Node)) open = false;
	}
</script>

<svelte:window onpointerdown={onwindowdown} onkeydown={(e) => open && e.key === 'Escape' && ((open = false), e.stopPropagation())} />

<div bind:this={wrap} class="relative shrink-0">
	<button
		type="button"
		class="grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)"
		aria-label={label}
		title={label}
		aria-haspopup="dialog"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="8" cy="8" r={R} fill="none" stroke="var(--vscode-widget-border)" stroke-width="2" />
			<circle cx="8" cy="8" r={R} fill="none" stroke={COLOR[level]} stroke-width="2" stroke-linecap="round" stroke-dasharray={ringDash(percent, R)} transform="rotate(-90 8 8)" />
		</svg>
	</button>
	{#if open}
		<div
			role="dialog"
			aria-label={t('chatInput.ctx.title')}
			class="absolute right-0 bottom-full z-30 mb-1 w-64 space-y-1.5 rounded-md border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background) p-2.5 text-xs text-(--vscode-foreground) shadow-lg"
		>
			<div class="font-semibold">{t('chatInput.ctx.title')}</div>
			<div class="h-1.5 overflow-hidden rounded-full bg-(--vscode-widget-border)">
				<div class="h-full rounded-full" style:width="{percent}%" style:background={COLOR[level]}></div>
			</div>
			<div>{t('chatInput.ctx.used', { used: formatTokens(usage.used), max: formatTokens(usage.max), percent })}</div>
			{#if cost != null}<div class="text-(--vscode-descriptionForeground)">{t('chatInput.ctx.cost', { cost: `$${cost.toFixed(4)}` })}</div>{/if}
			{#if level !== 'ok'}<p class="text-(--vscode-editorWarning-foreground)">{t('chatInput.ctx.warn')}</p>{/if}
			{#if oncompact}
				<button
					type="button"
					class="rounded-sm bg-(--vscode-button-secondaryBackground) px-2 py-0.5 text-(--vscode-button-secondaryForeground) hover:bg-(--vscode-button-secondaryHoverBackground)"
					title={t('chatInput.ctx.compactHint')}
					onclick={() => ((open = false), oncompact?.())}>{t('chatInput.ctx.compact')}</button
				>
			{/if}
		</div>
	{/if}
</div>
