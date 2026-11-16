<script lang="ts">
	// Link previews (Orca's linkPreview card): rest the pointer on a web link anywhere in the window
	// (chat answers, Markdown preview, PR comments, issues) and a card shows the page's title,
	// description, site, picture and icon. Rust link_preview.rs fetches it under Orca's rules
	// (public http(s) only, 5 s, cached); nothing shows when the page has no title or description.
	import { invoke } from '@tauri-apps/api/core';
	import { cardPlacement, linkTarget, HOVER_DELAY_MS, type Preview } from './linkPreview';

	let preview = $state<Preview | null>(null);
	let pos = $state<{ left: number; top: number } | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let current: HTMLAnchorElement | null = null;
	let overCard = false;

	function hide() {
		clearTimeout(timer);
		current = null;
		preview = null;
		pos = null;
	}

	function onOver(e: PointerEvent) {
		const a = linkTarget(e.target);
		if (!a || a === current) return;
		hide();
		current = a;
		const url = a.href;
		timer = setTimeout(async () => {
			const p = await invoke<Preview | null>('link_preview_get', { url }).catch(() => null);
			if (current !== a || !p) return;
			const r = a.getBoundingClientRect();
			pos = cardPlacement(r, { width: window.innerWidth, height: window.innerHeight });
			preview = p;
		}, HOVER_DELAY_MS);
	}

	function onOut(e: PointerEvent) {
		if (!current) return;
		const to = e.relatedTarget as Node | null;
		if (to && current.contains(to)) return;
		// Leaving the link for the card keeps it; leaving both closes it.
		setTimeout(() => {
			if (!overCard) hide();
		}, 120);
	}
</script>

<svelte:document onpointerover={onOver} onpointerout={onOut} onscrollcapture={hide} onkeydown={hide} onpointerdown={(e) => !(e.target as Element)?.closest?.('[data-link-preview]') && hide()} />

{#if preview && pos}
	<a
		data-link-preview
		href={preview.url}
		target="_blank"
		rel="noreferrer"
		class="fixed z-[80] flex w-80 flex-col overflow-hidden rounded-lg border border-(--vscode-widget-border) bg-(--vscode-editorHoverWidget-background,var(--vscode-quickInput-background)) text-(--vscode-foreground) no-underline shadow-xl shadow-black/40"
		style:left="{pos.left}px"
		style:top="{pos.top}px"
		onpointerenter={() => (overCard = true)}
		onpointerleave={() => ((overCard = false), hide())}
	>
		{#if preview.imageDataUrl}<img src={preview.imageDataUrl} alt="" class="h-36 w-full object-cover" />{/if}
		<div class="space-y-1 px-3 py-2">
			<div class="flex items-center gap-1.5 text-[11px] text-(--vscode-descriptionForeground)">
				{#if preview.faviconDataUrl}<img src={preview.faviconDataUrl} alt="" class="size-3.5 shrink-0 rounded-sm" />{/if}
				<span class="truncate">{preview.siteName ?? new URL(preview.url).hostname}</span>
			</div>
			{#if preview.title}<div class="line-clamp-2 text-[13px] leading-snug font-semibold">{preview.title}</div>{/if}
			{#if preview.description}<div class="line-clamp-3 text-[12px] leading-snug text-(--vscode-descriptionForeground)">{preview.description}</div>{/if}
		</div>
	</a>
{/if}
