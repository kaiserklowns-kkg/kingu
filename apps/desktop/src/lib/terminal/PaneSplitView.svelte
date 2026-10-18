<script lang="ts">
	// Panes of one terminal tab (or IDE terminal group) laid out from their split tree. Every pane is
	// absolutely placed from paneLayout's rects and keyed by id, so a split or close moves panes
	// without remounting their terminals; the sashes between them drag the split ratios.
	import type { Snippet } from 'svelte';
	import Sash from '#lib/workbench/Sash.svelte';
	import { dividers, paneRects, type PaneNode, type PanePath } from './paneLayout.ts';

	let {
		tree,
		expanded = null,
		onresize,
		pane
	}: { tree: PaneNode; expanded?: string | null; onresize: (path: PanePath, ratio: number) => void; pane: Snippet<[string]> } = $props();

	let width = $state(0);
	let height = $state(0);
	const rects = $derived(paneRects(tree));
	const lines = $derived(expanded ? [] : dividers(tree));
	const pct = (v: number) => `${v * 100}%`;
	/** Sorted so a pane keeps its place in the DOM (and its terminal) whatever the tree does. */
	const ids = $derived([...rects.keys()].sort());
</script>

<div class="relative h-full w-full" bind:clientWidth={width} bind:clientHeight={height}>
	{#each ids as id (id)}
		{@const r = expanded === id ? { x: 0, y: 0, w: 1, h: 1 } : rects.get(id)!}
		<div
			class={['absolute', r.x > 0 && 'border-l', r.y > 0 && 'border-t', 'border-(--vscode-terminal-border,var(--vscode-panel-border))', expanded && expanded !== id && 'invisible']}
			style:left={pct(r.x)}
			style:top={pct(r.y)}
			style:width={pct(r.w)}
			style:height={pct(r.h)}
		>
			{@render pane(id)}
		</div>
	{/each}
	{#each lines as d (d.path.join('.'))}
		{@const vertical = d.direction === 'vertical'}
		<div
			class={['absolute flex', vertical ? 'flex-row' : 'flex-col']}
			style:left={vertical ? `calc(${pct(d.area.x + d.area.w * d.ratio)} - 1px)` : pct(d.area.x)}
			style:top={vertical ? pct(d.area.y) : `calc(${pct(d.area.y + d.area.h * d.ratio)} - 1px)`}
			style:width={vertical ? '2px' : pct(d.area.w)}
			style:height={vertical ? pct(d.area.h) : '2px'}
		>
			<Sash
				orientation={vertical ? 'vertical' : 'horizontal'}
				onDrag={(delta) => {
					const size = vertical ? d.area.w * width : d.area.h * height;
					if (size > 0) onresize(d.path, d.ratio + delta / size);
				}}
				onReset={() => onresize(d.path, 0.5)}
			/>
		</div>
	{/each}
</div>
