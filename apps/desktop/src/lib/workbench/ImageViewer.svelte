<script lang="ts">
	// Image viewer for workspace images (VS Code's image preview, Orca's ImageViewer): fit to the
	// pane on a checkerboard; click zooms in, ⌥-click (Ctrl-click off macOS) zooms out, pinch or
	// ⌃-wheel zooms smoothly, and Image Preview: Zoom In / Zoom Out and the status bar's zoom entry
	// do the same (imageZoom.svelte.ts). Size and dimensions in the corner.
	import { invoke } from '@tauri-apps/api/core';
	import { imageZoom } from './imageZoom.svelte';
	import { clickZoomsOut, PIXELATION_THRESHOLD, zoomByWheel, zoomLabel } from './imageZoom';
	import { isMac } from './keys';
	import { t } from '#lib/i18n/index.ts';

	let { path }: { path: string } = $props();

	let src = $state('');
	let error = $state('');
	let size = $state<{ w: number; h: number } | null>(null);
	let img = $state<HTMLImageElement | null>(null);

	const scale = $derived(imageZoom.scaleOf(path));
	const fit = $derived(scale === 'fit');

	$effect(() => {
		const p = path;
		src = '';
		error = '';
		size = null;
		invoke<string>('fs_read_data_url', { rel: p })
			.then((url) => p === path && (src = url))
			.catch((e) => p === path && (error = String(e)));
	});

	/** While the image fits, its scale then: zooming in from "Whole Image" starts from there. */
	function reportFit() {
		if (img && fit && size?.w) imageZoom.fitted(path, img.clientWidth / size.w);
	}
	$effect(() => {
		if (!img) return;
		const ro = new ResizeObserver(reportFit);
		ro.observe(img);
		return () => ro.disconnect();
	});

	function onClick(e: MouseEvent) {
		reportFit();
		if (clickZoomsOut(e, isMac)) imageZoom.zoomOut(path);
		else imageZoom.zoomIn(path);
	}

	function onWheel(e: WheelEvent) {
		// A pinch arrives as a ctrl+wheel; ⌥-wheel (Ctrl-wheel off macOS) zooms too, like VS Code.
		if (!(e.ctrlKey || (isMac ? e.altKey : false))) return;
		e.preventDefault();
		reportFit();
		imageZoom.set(path, zoomByWheel(scale, imageZoom.fittedOf(path), e.deltaY));
	}

	/** Decoded size from the base64 payload. */
	const bytes = $derived(src ? Math.floor(((src.length - src.indexOf(',') - 1) * 3) / 4) : 0);
	const kb = $derived(bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
</script>

<div class="kg-checker relative h-full w-full overflow-auto" onwheel={onWheel}>
	{#if error}
		<p class="p-6 text-[13px] text-(--vscode-errorForeground)">เปิดรูปไม่ได้: {error}</p>
	{:else if src}
		<button
			class="grid min-h-full min-w-full cursor-zoom-in place-items-center p-6"
			title={t('workbench.imageZoom.clickHint')}
			onclick={onClick}
		>
			<img
				bind:this={img}
				{src}
				alt={path}
				class={['shadow-lg shadow-black/30', fit ? 'max-h-[calc(100vh-200px)] max-w-full object-contain' : 'max-w-none']}
				style:width={!fit && size ? `${size.w * (scale as number)}px` : null}
				style:image-rendering={!fit && (scale as number) >= PIXELATION_THRESHOLD ? 'pixelated' : 'auto'}
				onload={(e) => {
					size = { w: (e.currentTarget as HTMLImageElement).naturalWidth, h: (e.currentTarget as HTMLImageElement).naturalHeight };
					reportFit();
				}}
			/>
		</button>
		<div class="pointer-events-none absolute right-3 bottom-3 rounded-md bg-(--vscode-editor-background)/85 px-2 py-0.5 text-xs text-(--vscode-descriptionForeground) tabular-nums">
			{size ? `${size.w} × ${size.h} · ` : ''}{kb} · {zoomLabel(scale, t('workbench.imageZoom.whole'))}
		</div>
	{/if}
</div>

<style>
	/* Transparent pixels show on a soft checkerboard, like VS Code's image preview. */
	.kg-checker {
		background-color: var(--vscode-editor-background);
		background-image:
			linear-gradient(45deg, rgb(128 128 128 / 0.12) 25%, transparent 25%),
			linear-gradient(-45deg, rgb(128 128 128 / 0.12) 25%, transparent 25%),
			linear-gradient(45deg, transparent 75%, rgb(128 128 128 / 0.12) 75%),
			linear-gradient(-45deg, transparent 75%, rgb(128 128 128 / 0.12) 75%);
		background-size: 16px 16px;
		background-position: 0 0, 0 8px, 8px -8px, -8px 0;
	}
</style>
