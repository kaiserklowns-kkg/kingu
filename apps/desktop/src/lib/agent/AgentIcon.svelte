<script lang="ts">
	// An agent's mark (agentIcons.ts), as Orca's AgentIcon draws it: monochrome glyphs in the text
	// colour, brand marks and bundled favicons in their own colours (2px corners, as Orca's <img>),
	// Kingu's Arkai mark as its codicon mask, anything else Orca's letter tile.
	import Codicon from '#lib/workbench/Codicon.svelte';
	import { agentIcon } from './agentIcons.ts';

	const FILES = import.meta.glob('../assets/agent-icons/*.{png,svg}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

	let {
		agent,
		size = 16,
		title,
		class: cls = ''
	}: {
		/** Any name for the agent: an id, a program or command, a display name (`null`: not known yet). */
		agent: string | null | undefined;
		size?: number;
		/** Tooltip. */
		title?: string;
		class?: string;
	} = $props();

	const def = $derived(agentIcon(agent));
	const height = $derived(def.kind === 'image' && def.aspect ? Math.round(size * def.aspect) : size);
</script>

<span class="kingu-agent-icon inline-flex shrink-0 items-center justify-center {cls}" style:width="{size}px" style:height="{height}px" {title} aria-hidden="true">
	{#if def.kind === 'svg'}
		<svg width={size} height={size} viewBox={def.viewBox} xmlns="http://www.w3.org/2000/svg">
			<g transform={def.transform}>
				{#each def.paths as p, i (i)}
					<path d={p.d} fill={p.fill ?? 'currentColor'} fill-opacity={p.opacity} fill-rule={p.evenOdd ? 'evenodd' : undefined} clip-rule={p.evenOdd ? 'evenodd' : undefined} />
				{/each}
			</g>
		</svg>
	{:else if def.kind === 'image'}
		<img src={FILES[`../assets/agent-icons/${def.file}`]} width={size} {height} alt="" draggable="false" class="block rounded-[2px]" />
	{:else if def.kind === 'mark'}
		<Codicon id={def.id} {size} />
	{:else}
		<svg width={size} height={size} viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg">
			<rect width="14" height="14" rx="3" fill="currentColor" fill-opacity="0.2" />
			<text x="7" y="10.5" text-anchor="middle" font-size="8.5" fill="currentColor" font-weight="700" font-family="system-ui, -apple-system, sans-serif">{def.letter}</text>
		</svg>
	{/if}
</span>
