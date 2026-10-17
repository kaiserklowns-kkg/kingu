<script lang="ts" module>
	// Glyphs of Kingu's own file icon theme (16×16, see fileIcons.ts for the name → glyph mapping).
	const paths: Record<string, string> = {
		braces: 'M6 3.5c-1.5 0-2 .6-2 1.8v1.4c0 .8-.4 1.3-1.2 1.3.8 0 1.2.5 1.2 1.3v1.4c0 1.2.5 1.8 2 1.8M10 3.5c1.5 0 2 .6 2 1.8v1.4c0 .8.4 1.3 1.2 1.3-.8 0-1.2.5-1.2 1.3v1.4c0 1.2-.5 1.8-2 1.8',
		doc: 'M4 2.5h5.5L12 5v8.5H4zM6 7h4M6 9h4M6 11h2.5',
		book: 'M2.5 3.5c2 0 4 .3 5.5 1.3v8.7c-1.5-1-3.5-1.3-5.5-1.3zM13.5 3.5c-2 0-4 .3-5.5 1.3v8.7c1.5-1 3.5-1.3 5.5-1.3z',
		image: 'M2.5 3.5h11v9h-11zM2.5 11l3.5-3.5 3 3 1.5-1.5 3 3M10.5 5.5a1 1 0 1 0 .01 0',
		lock: 'M4 7.5h8v6H4zM5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2M8 10v1.5',
		gear: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M3.8 12.2l1.4-1.4M10.8 5.2l1.4-1.4',
		package: 'M8 2l5.5 3v6L8 14l-5.5-3V5zM2.5 5L8 8l5.5-3M8 8v6',
		git: 'M8 2l6 6-6 6-6-6zM8 5.5v5M8 5.5a.4.4 0 1 0 .01 0M8 10.5a.4.4 0 1 0 .01 0',
		terminal: 'M2.5 3.5h11v9h-11zM5 6.5l2 1.5-2 1.5M8.5 10h2.5',
		file: 'M4 2.5h5.5L12 5v8.5H4zM9.5 2.5V5H12',
		folder: 'M1.5 4h4.5l1.5 1.5h7v7.5h-13z',
		folderOpen: 'M1.5 13V4h4.5l1.5 1.5h5.5V7.5M1.5 13l2-5.5h11L12.5 13z'
	};
</script>

<script lang="ts">
	import type { FileIconSpec } from './fileIcons';

	let { icon, size = 16 }: { icon: FileIconSpec; size?: number } = $props();
</script>

<svg class="shrink-0" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" style:color={icon.color}>
	{#if icon.glyph === 'badge'}
		<rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-width="1" />
		<text
			x="8"
			y="8.4"
			text-anchor="middle"
			dominant-baseline="middle"
			fill="currentColor"
			font-family="system-ui, sans-serif"
			font-weight="700"
			font-size={(icon.label?.length ?? 0) > 1 ? 6.4 : 8}
			letter-spacing="-0.2">{icon.label}</text
		>
	{:else}
		<path
			d={paths[icon.glyph] ?? paths.file}
			fill={icon.glyph === 'folder' ? 'currentColor' : 'none'}
			fill-opacity="0.25"
			stroke="currentColor"
			stroke-width="1.2"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	{/if}
</svg>
