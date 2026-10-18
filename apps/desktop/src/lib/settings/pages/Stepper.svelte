<script lang="ts">
	// A number setting as − value + (Orca's size controls), within the schema's bounds.
	import Icon from '#lib/workbench/Icon.svelte';
	import { SETTINGS } from '../registry';
	import { settings } from '../settings.svelte';

	let { id, label, hint }: { id: string; label: string; hint?: string } = $props();
	const schema = $derived(SETTINGS.find((s) => s.id === id));
	const min = $derived(schema?.type === 'number' ? (schema.minimum ?? -Infinity) : -Infinity);
	const max = $derived(schema?.type === 'number' ? (schema.maximum ?? Infinity) : Infinity);
	const value = $derived(settings.get<number>(id) ?? 0);
	const set = (v: number) => void settings.set(id, v === schema?.default ? undefined : v, 'user');
	const BTN = 'grid size-8 place-items-center rounded-md border border-(--vscode-widget-border) hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
</script>

<div class="flex items-center gap-3 px-4 py-3">
	<div class="min-w-0 flex-1">
		<div class="text-[13px]">{label}</div>
		{#if hint}<div class="text-xs text-(--vscode-descriptionForeground)">{hint}</div>{/if}
	</div>
	<button class={BTN} aria-label="ลด {label}" disabled={value - 1 < min} onclick={() => set(value - 1)}><Icon name="minus" size={14} /></button>
	<span class="w-10 text-center font-mono text-[13px] tabular-nums">{value}</span>
	<button class={BTN} aria-label="เพิ่ม {label}" disabled={value + 1 > max} onclick={() => set(value + 1)}><Icon name="plus" size={14} /></button>
</div>
