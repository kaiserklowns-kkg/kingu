<script lang="ts" module>
	import {
		BookOpenIcon,
		BracketsCurlyIcon,
		FileIcon,
		FileTextIcon,
		FolderIcon,
		FolderOpenIcon,
		GearSixIcon,
		GitBranchIcon,
		ImageIcon,
		LockIcon,
		PackageIcon,
		TerminalIcon
	} from 'phosphor-svelte';
	import type { FileGlyph } from './fileIcons';

	// Glyphs of Kingu's file icon theme (see fileIcons.ts for the name → glyph mapping); `badge` is drawn below.
	const glyphs: Record<Exclude<FileGlyph, 'badge'>, typeof FileIcon> = {
		braces: BracketsCurlyIcon,
		doc: FileTextIcon,
		book: BookOpenIcon,
		image: ImageIcon,
		lock: LockIcon,
		gear: GearSixIcon,
		package: PackageIcon,
		git: GitBranchIcon,
		terminal: TerminalIcon,
		file: FileIcon,
		folder: FolderIcon,
		folderOpen: FolderOpenIcon
	};
</script>

<script lang="ts">
	import type { FileIconSpec } from './fileIcons';

	let { icon, size = 16 }: { icon: FileIconSpec; size?: number } = $props();

	const Glyph = $derived(icon.glyph === 'badge' ? null : (glyphs[icon.glyph] ?? FileIcon));
	const folder = $derived(icon.glyph === 'folder' || icon.glyph === 'folderOpen');
</script>

{#if Glyph}
	<Glyph {size} weight={folder ? 'fill' : 'duotone'} color={icon.color} class="shrink-0" aria-hidden="true" />
{:else}
	<svg class="shrink-0" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" style:color={icon.color}>
		<rect x="1.5" y="2.5" width="13" height="11" rx="3.5" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-width="1" />
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
	</svg>
{/if}
