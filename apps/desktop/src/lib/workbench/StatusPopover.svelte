<script lang="ts">
	// A popup that opens above a status bar item, right-aligned to it (Orca's status bar popovers).
	// Closes on Escape, a click outside, or the window losing focus.
	import type { Snippet } from 'svelte';

	type Props = { anchor: HTMLElement; label: string; width?: number; onClose: () => void; children: Snippet };
	let { anchor, label, width = 300, onClose, children }: Props = $props();

	const rect = $derived(anchor.getBoundingClientRect());
	const right = $derived(Math.max(4, Math.min(window.innerWidth - rect.right, window.innerWidth - width - 4)));
	const bottom = $derived(window.innerHeight - rect.top + 6);
	let panel: HTMLDivElement | undefined = $state();

	$effect(() => {
		panel?.querySelector<HTMLElement>('[data-autofocus], button:not([disabled])')?.focus();
	});

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
			anchor.focus();
		}
	}
</script>

<svelte:window {onkeydown} onblur={onClose} />

<div class="fixed inset-0 z-40" role="presentation" onpointerdown={onClose}></div>
<div
	bind:this={panel}
	role="dialog"
	aria-label={label}
	class="fixed z-50 flex max-h-[70vh] flex-col overflow-hidden rounded-lg border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) text-[13px] text-(--vscode-foreground) shadow-xl shadow-black/40"
	style:right="{right}px"
	style:bottom="{bottom}px"
	style:width="{width}px"
>
	{@render children()}
</div>
