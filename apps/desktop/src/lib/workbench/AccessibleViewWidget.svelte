<script lang="ts">
	// The Accessible View / Accessibility Help (VS Code's accessible view widget): the text in a
	// read-only box that takes focus, so a screen reader reads it line by line; Escape closes and
	// focus goes back. Next / Previous (⌥] / ⌥[) walk notifications and chat responses.
	import { tick } from 'svelte';
	import { t } from '#lib/i18n/index.ts';
	import { accessibleView } from './accessibleView.svelte.ts';
	import { kindLabel } from './accessibleView';
	import { keyLabel } from './keys';

	let box: HTMLTextAreaElement | undefined = $state();
	const c = $derived(accessibleView.content);
	const text = $derived(accessibleView.mode === 'help' || !c ? accessibleView.help : (c.items[c.index] ?? ''));
	const title = $derived(accessibleView.mode === 'help' ? t('accessibility.help.title') : c ? `${t('accessibility.view.title')}: ${kindLabel(c.kind)}` : t('accessibility.view.title'));

	$effect(() => {
		void text;
		if (accessibleView.open)
			void tick().then(() => {
				box?.focus();
				box?.setSelectionRange(0, 0);
				if (box) box.scrollTop = 0;
			});
	});

	function onkeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		e.preventDefault();
		e.stopPropagation();
		accessibleView.close();
	}
</script>

{#if accessibleView.open}
	<div
		role="dialog"
		aria-modal="true"
		aria-label={title}
		tabindex="-1"
		class="fixed top-[12vh] left-1/2 z-50 flex w-[min(720px,80vw)] -translate-x-1/2 flex-col gap-1.5 rounded-xl border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) p-2 text-(--vscode-quickInput-foreground) shadow-2xl shadow-black/50"
		{onkeydown}
	>
		<div class="flex items-center gap-2 px-1 text-[12px]">
			<span class="font-semibold">{title}</span>
			{#if c && c.items.length > 1}
				<span class="text-(--vscode-descriptionForeground)">{t('accessibility.view.position', { index: c.index + 1, count: c.items.length })}</span>
				<button class="rounded px-1.5 hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40" disabled={c.index === 0} onclick={() => accessibleView.step(-1)}>{t('accessibility.view.previous')}</button>
				<button class="rounded px-1.5 hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40" disabled={c.index === c.items.length - 1} onclick={() => accessibleView.step(1)}>{t('accessibility.view.next')}</button>
			{/if}
			<span class="flex-1"></span>
			<button class="rounded px-1.5 hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => accessibleView.close()}>{t('accessibility.view.close')}</button>
		</div>
		<textarea
			bind:this={box}
			readonly
			value={text}
			aria-label={title}
			spellcheck="false"
			class="h-[50vh] w-full resize-none rounded-lg border border-(--vscode-focusBorder) bg-(--vscode-input-background) p-2 font-mono text-[13px] text-(--vscode-input-foreground) outline-none"
		></textarea>
		<p class="px-1 text-[11px] text-(--vscode-descriptionForeground)">{t('accessibility.view.hint', { next: keyLabel('alt+]'), previous: keyLabel('alt+[') })}</p>
	</div>
{/if}
