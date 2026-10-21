<script lang="ts">
	// Provider marks for the usage item (Orca shows each agent's brand at 13px): a drawn starburst
	// in Claude's orange, Phosphor's OpenAI mark for Codex, a four-pointed spark for Gemini.
	import { OpenAiLogoIcon } from 'phosphor-svelte';
	import type { ProviderId } from './usage';

	let { provider, size = 13 }: { provider: ProviderId; size?: number } = $props();
	const RAYS = Array.from({ length: 12 }, (_, i) => i * 30);
</script>

{#if provider === 'claude'}
	<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" class="shrink-0">
		{#each RAYS as deg, i (deg)}
			<rect x="10.9" y={i % 2 ? 2.6 : 1} width="2.2" height={i % 2 ? 9.4 : 11} rx="1.1" fill="#D97757" transform="rotate({deg} 12 12)" />
		{/each}
	</svg>
{:else if provider === 'gemini'}
	<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" class="shrink-0">
		<path d="M12 1.5C12.6 7.4 16.6 11.4 22.5 12 16.6 12.6 12.6 16.6 12 22.5 11.4 16.6 7.4 12.6 1.5 12 7.4 11.4 11.4 7.4 12 1.5Z" fill="#4C8DF6" />
	</svg>
{:else}
	<OpenAiLogoIcon {size} weight="bold" class="shrink-0" />
{/if}
