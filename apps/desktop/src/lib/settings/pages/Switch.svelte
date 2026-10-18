<script lang="ts">
	// A boolean setting as a row with a switch (Orca's settings toggles).
	import { SETTINGS } from '../registry';
	import { settings } from '../settings.svelte';

	let { id, label, hint }: { id: string; label: string; hint?: string } = $props();
	const def = $derived(SETTINGS.find((s) => s.id === id)?.default);
	const on = $derived(settings.get<boolean>(id) !== false);
	const toggle = () => void settings.set(id, !on === def ? undefined : !on, 'user');
</script>

<div class="flex items-center gap-3 px-4 py-3">
	<div class="min-w-0 flex-1">
		<div class="text-[13px]">{label}</div>
		{#if hint}<div class="text-xs text-(--vscode-descriptionForeground)">{hint}</div>{/if}
	</div>
	<button
		role="switch"
		aria-checked={on}
		aria-label={label}
		class={['relative h-5 w-9 shrink-0 rounded-full transition-colors', on ? 'bg-(--vscode-button-background)' : 'bg-(--vscode-widget-border)']}
		onclick={toggle}
	>
		<span class={['absolute top-0.5 size-4 rounded-full bg-(--vscode-button-foreground) shadow transition-[left]', on ? 'left-[18px]' : 'left-0.5']}></span>
	</button>
</div>
