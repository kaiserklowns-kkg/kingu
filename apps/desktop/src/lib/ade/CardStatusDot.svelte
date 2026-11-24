<script lang="ts">
	// One agent state as the side bar and the tab row draw it (Orca's AgentStateDot): a spinner while
	// working, a question mark when it needs you, a dot otherwise.
	import Icon from '#lib/workbench/Icon.svelte';
	import type { CardStatus } from './sidebarModel';

	let { status, size = 'size-2' }: { status: CardStatus; size?: string } = $props();
</script>

{#if status === 'working'}
	<span class="size-2.5 animate-spin rounded-full border-2 border-yellow-500 border-t-transparent"></span>
{:else if status === 'permission'}
	<span class="text-amber-400"><Icon name="question" size={12} filled /></span>
{:else if status === 'failed'}
	<span class="size-1.5 rounded-full bg-red-500"></span>
{:else if status === 'done' || status === 'active'}
	<span class={[size, 'rounded-full bg-emerald-500']}></span>
{:else}
	<span class={[size, 'rounded-full bg-neutral-500/40']}></span>
{/if}
