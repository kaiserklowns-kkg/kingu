<script lang="ts">
	// Image viewer for workspace images (VS Code's image preview, Orca's ImageViewer): fit to the
	// pane on a checkerboard, click to toggle actual size, size and dimensions in the corner.
	import { invoke } from '@tauri-apps/api/core';

	let { path }: { path: string } = $props();

	let src = $state('');
	let error = $state('');
	let fit = $state(true);
	let size = $state<{ w: number; h: number } | null>(null);

	$effect(() => {
		const p = path;
		src = '';
		error = '';
		size = null;
		fit = true;
		invoke<string>('fs_read_data_url', { rel: p })
			.then((url) => p === path && (src = url))
			.catch((e) => p === path && (error = String(e)));
	});

	/** Decoded size from the base64 payload. */
	const bytes = $derived(src ? Math.floor(((src.length - src.indexOf(',') - 1) * 3) / 4) : 0);
	const kb = $derived(bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
</script>

<div class="kg-checker relative h-full w-full overflow-auto">
	{#if error}
		<p class="p-6 text-[13px] text-(--vscode-errorForeground)">เปิดรูปไม่ได้: {error}</p>
	{:else if src}
		<button
			class={['grid min-h-full min-w-full place-items-center p-6', fit ? 'cursor-zoom-in' : 'cursor-zoom-out']}
			title={fit ? 'คลิกเพื่อดูขนาดจริง' : 'คลิกเพื่อย่อให้พอดี'}
			onclick={() => (fit = !fit)}
		>
			<img
				{src}
				alt={path}
				class={['shadow-lg shadow-black/30 [image-rendering:auto]', fit && 'max-h-[calc(100vh-200px)] max-w-full object-contain']}
				onload={(e) => (size = { w: (e.currentTarget as HTMLImageElement).naturalWidth, h: (e.currentTarget as HTMLImageElement).naturalHeight })}
			/>
		</button>
		<div class="pointer-events-none absolute right-3 bottom-3 rounded-md bg-(--vscode-editor-background)/85 px-2 py-0.5 text-xs text-(--vscode-descriptionForeground) tabular-nums">
			{size ? `${size.w} × ${size.h} · ` : ''}{kb}{fit ? '' : ' · 100%'}
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
