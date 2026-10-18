<script lang="ts">
	// A modal over the window for the ADE's forms (create PR, remove task), in the quick input's
	// look. Escape or a click on the backdrop closes it (unless `busy`); focus starts on the
	// `data-autofocus` element, else the first field, and stays inside while it is open.
	import type { Snippet } from 'svelte';

	type Props = { title: string; width?: number; busy?: boolean; onClose: () => void; children: Snippet; footer: Snippet };
	let { title, width = 520, busy = false, onClose, children, footer }: Props = $props();

	let panel: HTMLDivElement | undefined = $state();
	const previous = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null);

	$effect(() => {
		const el = panel?.querySelector<HTMLElement>('[data-autofocus]') ?? panel?.querySelector<HTMLElement>('input, textarea, select, button:not([disabled])');
		el?.focus();
		return () => previous?.focus?.();
	});

	function close() {
		if (!busy) onClose();
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			close();
		} else if (e.key === 'Tab' && panel) {
			const items = [...panel.querySelectorAll<HTMLElement>('input, textarea, select, button, [tabindex="0"]')].filter((el) => !el.hasAttribute('disabled'));
			const first = items[0];
			const last = items.at(-1);
			if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last?.focus());
			else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first?.focus());
		}
	}
</script>

<div class="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && close()}>
	<div
		bind:this={panel}
		role="dialog"
		aria-modal="true"
		aria-label={title}
		tabindex="-1"
		{onkeydown}
		class="flex max-h-[85vh] w-full flex-col overflow-hidden rounded-lg border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) text-[13px] text-(--vscode-foreground) shadow-xl shadow-black/40"
		style:max-width="{width}px"
	>
		<h2 class="shrink-0 px-4 pt-3.5 pb-1 text-sm font-semibold">{title}</h2>
		<div class="min-h-0 flex-1 overflow-y-auto px-4 py-2">{@render children()}</div>
		<div class="flex shrink-0 items-center justify-end gap-2 border-t border-(--vscode-widget-border) px-4 py-2.5">{@render footer()}</div>
	</div>
</div>
