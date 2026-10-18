<script lang="ts">
	// One enum setting as selectable cards (Orca's settings panes), labels and help from the registry.
	import { SETTINGS } from '../registry';
	import { settings } from '../settings.svelte';

	let { id, labels = {} }: { id: string; labels?: Record<string, string> } = $props();

	const schema = $derived(SETTINGS.find((s) => s.id === id));
	const options = $derived(schema && schema.type === 'string' && schema.enum ? schema.enum.map((v, i) => ({ value: v, help: schema.enumDescriptions?.[i] ?? '' })) : []);
	const value = $derived(settings.get<string>(id));
	/** Registry texts are "ไทย (English.)": the card shows the Thai, the tooltip both. */
	const thai = (s: string) => s.replace(/\s*\([^()]*\)\.?\s*$/, '');
	const pick = (v: string) => void settings.set(id, v === schema?.default ? undefined : v, 'user');
</script>

<div class="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2" role="radiogroup" aria-label={schema?.description}>
	{#each options as o (o.value)}
		{@const on = value === o.value}
		<button
			role="radio"
			aria-checked={on}
			title={o.help}
			class={['rounded-lg border px-3.5 py-2.5 text-left transition-colors', on ? 'border-(--vscode-focusBorder) bg-(--vscode-list-inactiveSelectionBackground)' : 'border-(--vscode-widget-border) hover:bg-(--vscode-list-hoverBackground)']}
			onclick={() => pick(o.value)}
		>
			<span class="flex items-center gap-2 text-[13px] font-medium">
				<span class={['grid size-3.5 shrink-0 place-items-center rounded-full border', on ? 'border-(--vscode-focusBorder)' : 'border-(--vscode-descriptionForeground)']}>
					{#if on}<span class="size-1.5 rounded-full bg-(--vscode-focusBorder)"></span>{/if}
				</span>
				{labels[o.value] ?? o.value}
			</span>
			{#if o.help}<span class="mt-1 block pl-5.5 text-xs leading-snug text-(--vscode-descriptionForeground)">{thai(o.help)}</span>{/if}
		</button>
	{/each}
</div>
