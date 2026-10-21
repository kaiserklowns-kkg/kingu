<script lang="ts">
	// The getting-started tip (VS Code's chatTipContentPart): "Tip:" and one line of text in a card
	// joined to the top of the chat input (no bottom border; the input squares its top corners).
	// Hovering or focusing it shows a small toolbar on its top edge: Previous, Next, Dismiss (✓,
	// never again) and Disable tips (chat.tips.enabled). Links run the tip's own actions.
	import Codicon from '#lib/workbench/Codicon.svelte';
	import { t, type MessageKey } from '#lib/i18n/index.ts';
	import { tipParts, type TipAction, type TipDef } from './chatTips.ts';

	let {
		tip,
		keys,
		several,
		onaction,
		onstep,
		ondismiss,
		ondisable
	}: {
		tip: TipDef;
		/** Shortcut labels for the messages' `{key}`. */
		keys: Record<NonNullable<TipDef['keyLabel']>, string>;
		/** More than one tip may show: Previous / Next are offered. */
		several: boolean;
		onaction: (action: TipAction) => void;
		onstep: (dir: 1 | -1) => void;
		ondismiss: () => void;
		ondisable: () => void;
	} = $props();

	const message = $derived(tip.keyLabel ? t(tip.key as Extract<MessageKey, 'chatTips.modelPicker'>, { key: keys[tip.keyLabel] }) : t(tip.key as Extract<MessageKey, 'chatTips.planMode'>));
	const parts = $derived(tipParts(message));
	const BTN = 'grid size-6 place-items-center rounded-[4px] text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)';
</script>

<div
	class="group/tip relative flex items-center gap-1.5 rounded-t-[8px] border border-b-0 border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) px-2 py-1.5 text-[12px] leading-[18px] text-(--vscode-descriptionForeground)"
	role="note"
	aria-roledescription={t('chatTips.label')}
>
	<p class="min-w-0 flex-1">
		<strong class="font-semibold text-(--vscode-foreground)">{t('chatTips.prefix')}</strong>
		{#each parts as p, i (i)}
			{#if p.kind === 'text'}{p.text}{:else if p.kind === 'code'}<code class="rounded-[3px] bg-(--vscode-textCodeBlock-background) px-1 font-mono text-[11px]">{p.text}</code>{:else}<button
					type="button"
					class="cursor-pointer rounded-[2px] text-(--vscode-textLink-foreground) hover:text-(--vscode-textLink-activeForeground) hover:underline focus-visible:outline focus-visible:outline-(--vscode-focusBorder)"
					onclick={() => tip.actions?.[p.action] && onaction(tip.actions[p.action])}>{p.text}</button
				>{/if}
		{/each}
	</p>
	<div
		class="pointer-events-none absolute -top-5 right-2.5 flex h-[26px] items-center gap-px rounded-[6px] border border-(--vscode-chat-requestBorder,var(--vscode-widget-border)) bg-(--vscode-editorWidget-background) px-px opacity-0 transition-opacity duration-100 group-focus-within/tip:pointer-events-auto group-focus-within/tip:opacity-100 group-hover/tip:pointer-events-auto group-hover/tip:opacity-100"
		role="toolbar"
		aria-label={t('chatTips.label')}
	>
		{#if several}
			<button type="button" class={BTN} aria-label={t('chatTips.previous')} title={t('chatTips.previous')} onclick={() => onstep(-1)}><Codicon id="chevron-left" size={14} /></button>
			<button type="button" class={BTN} aria-label={t('chatTips.next')} title={t('chatTips.next')} onclick={() => onstep(1)}><Codicon id="chevron-right" size={14} /></button>
		{/if}
		<button type="button" class={BTN} aria-label={t('chatTips.dismiss')} title={t('chatTips.dismiss')} onclick={ondismiss}><Codicon id="check" size={14} /></button>
		<button type="button" class={BTN} aria-label={t('chatTips.disable')} title={t('chatTips.disable')} onclick={ondisable}><Codicon id="bell-slash" size={14} /></button>
	</div>
</div>
