<script lang="ts">
	// Provider marks for the usage item (Orca shows each agent's brand at 13px): a drawn starburst
	// in Claude's orange, Phosphor's OpenAI mark for Codex, a four-pointed spark for Gemini; Orca's
	// other providers get a lettered tile in a colour of their own.
	import { OpenAiLogoIcon } from 'phosphor-svelte';
	import type { ProviderId } from './usage';

	let { provider, size = 13 }: { provider: ProviderId; size?: number } = $props();
	const RAYS = Array.from({ length: 12 }, (_, i) => i * 30);
	const TILE: Partial<Record<ProviderId, [letter: string, color: string]>> = {
		antigravity: ['A', '#3B82F6'],
		opencode: ['O', '#71717A'],
		kimi: ['K', '#0EA5E9'],
		minimax: ['M', '#E11D48'],
		grok: ['G', '#52525B'],
		cursor: ['C', '#A1A1AA'],
		zcode: ['Z', '#2563EB']
	};
	const tile = $derived(TILE[provider]);
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
{:else if tile}
	<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" class="shrink-0">
		<rect x="1" y="1" width="22" height="22" rx="6" fill={tile[1]} />
		<text x="12" y="17" text-anchor="middle" font-size="14" font-weight="700" font-family="system-ui, sans-serif" fill="#fff">{tile[0]}</text>
	</svg>
{:else}
	<OpenAiLogoIcon {size} weight="bold" class="shrink-0" />
{/if}
