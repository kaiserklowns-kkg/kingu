<script lang="ts">
	// Chat-style input like VS Code's chat input: a rounded box with an auto-growing text area and
	// a footer row (context chips + send). Enter sends, Shift+Enter adds a line (IME-safe).
	import type { Snippet } from 'svelte';
	import Icon from '#lib/workbench/Icon.svelte';

	let {
		value = $bindable(''),
		placeholder,
		disabled = false,
		busy = false,
		size = 'sm',
		autofocus = false,
		onsubmit,
		chips
	}: {
		value?: string;
		placeholder: string;
		disabled?: boolean;
		busy?: boolean;
		size?: 'sm' | 'lg';
		autofocus?: boolean;
		onsubmit: (text: string) => void;
		chips?: Snippet;
	} = $props();

	let area: HTMLTextAreaElement | undefined = $state();
	const maxRows = $derived(size === 'lg' ? 12 : 8);

	// Grow with the content up to `maxRows`, then scroll.
	$effect(() => {
		void value;
		if (!area) return;
		// Not rendered (a hidden layout): keep the `rows` height instead of measuring 0.
		if (!area.getClientRects().length) {
			area.style.height = '';
			return;
		}
		area.style.height = 'auto';
		const line = parseFloat(getComputedStyle(area).lineHeight) || 20;
		area.style.height = `${Math.min(area.scrollHeight, line * maxRows + 8)}px`;
	});

	$effect(() => {
		if (autofocus) area?.focus();
	});

	function send() {
		const text = value.trim();
		if (!text || disabled || busy) return;
		onsubmit(text);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			send();
		}
	}
</script>

<div
	class={[
		'flex flex-col rounded-md border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) focus-within:border-(--vscode-focusBorder)',
		size === 'lg' ? 'p-2.5 shadow-[0_2px_12px_rgba(0,0,0,0.25)]' : 'p-1.5'
	]}
>
	<textarea
		bind:this={area}
		bind:value
		{placeholder}
		{disabled}
		rows={size === 'lg' ? 3 : 2}
		aria-label={placeholder}
		{onkeydown}
		style="outline: none; box-shadow: none"
		class={[
			'w-full resize-none bg-transparent px-1 text-(--vscode-input-foreground) outline-none focus-visible:outline-none placeholder:text-(--vscode-input-placeholderForeground)',
			size === 'lg' ? 'text-[14px] leading-6' : 'text-[13px] leading-5'
		]}
	></textarea>
	<div class="flex min-h-6 items-center gap-1.5 pt-1">
		<div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-xs text-(--vscode-descriptionForeground)">
			{@render chips?.()}
		</div>
		<button
			type="button"
			aria-label="ส่ง (Enter)"
			title="ส่ง (Enter) · ขึ้นบรรทัดใหม่ (Shift+Enter)"
			class="grid size-6 shrink-0 place-items-center rounded bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:opacity-90 disabled:bg-transparent disabled:text-(--vscode-descriptionForeground) disabled:opacity-60"
			disabled={!value.trim() || disabled || busy}
			onclick={send}
		>
			{#if busy}<span class="size-3 animate-spin rounded-full border-2 border-current border-t-transparent"></span>{:else}<Icon name="send" size={14} />{/if}
		</button>
	</div>
</div>
