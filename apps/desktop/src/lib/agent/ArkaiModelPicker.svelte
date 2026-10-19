<script lang="ts">
	// The chat's model picker when the chat runs on Arkai: the models of each provider (Rust
	// `arkai_providers`), grouped by provider; a remote provider without an API key says so.
	import { t } from '#lib/i18n/index.ts';
	import { arkaiProviders } from './arkai.svelte.ts';
	import { arkaiGroups, needsKey } from './arkai.ts';

	let {
		value,
		class: cls = '',
		select = $bindable(),
		onchange
	}: { value: string | null; class?: string; select?: HTMLSelectElement; onchange: (model: string) => void } = $props();

	$effect(() => {
		void arkaiProviders.load();
	});

	const groups = $derived(arkaiGroups(arkaiProviders.list, value));
	const byId = $derived(new Map(arkaiProviders.list.map((p) => [p.id, p])));
</script>

<select
	bind:this={select}
	class={cls}
	aria-label={t('arkai.picker.label')}
	title={t('arkai.picker.hint')}
	value={value ?? ''}
	onchange={(e) => e.currentTarget.value && onchange(e.currentTarget.value)}
>
	{#if !groups.length}
		<option value="" disabled>{arkaiProviders.loading ? t('arkai.picker.loading') : t('arkai.picker.none')}</option>
	{/if}
	{#each groups as g (g.provider)}
		{@const p = byId.get(g.provider)}
		<optgroup label={p && needsKey(p) ? t('arkai.picker.noKey', { name: g.label }) : g.label}>
			{#each g.models as m (m.value)}<option value={m.value} title={m.description}>{m.label}</option>{/each}
		</optgroup>
	{/each}
</select>
