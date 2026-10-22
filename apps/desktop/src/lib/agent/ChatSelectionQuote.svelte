<script lang="ts">
	// Selected transcript text gets a small floating bar above it (Orca's selection quote, VS Code's
	// Ask in Side Chat): Quote puts it in the chat input as a `>` block, Ask in Side Chat asks about
	// it in a side chat. Only a selection with both ends in the list counts (not in an input).
	import { onMount } from 'svelte';
	import Codicon from '#lib/workbench/Codicon.svelte';
	import { t } from '#lib/i18n/index.ts';

	let {
		host,
		scroller,
		onquote,
		onside
	}: {
		/** The positioned element the bar is placed in. */
		host: () => HTMLElement | null;
		scroller: () => HTMLElement | null;
		onquote: (text: string) => void;
		onside?: (text: string) => void;
	} = $props();

	let at = $state<{ x: number; y: number; text: string } | null>(null);

	function selected(): { text: string; rect: DOMRect } | null {
		const el = scroller();
		const sel = getSelection();
		if (!el || !sel || sel.isCollapsed || sel.rangeCount !== 1) return null;
		if (!el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) return null;
		const inField = (n: Node | null) => !!(n instanceof Element ? n : n?.parentElement)?.closest('textarea, input, [contenteditable="true"]');
		if (inField(sel.anchorNode) || inField(sel.focusNode)) return null;
		const text = sel.toString().trim();
		if (!text) return null;
		const rects = sel.getRangeAt(0).getClientRects();
		const rect = rects[0] ?? sel.getRangeAt(0).getBoundingClientRect();
		return { text, rect };
	}

	function update() {
		const box = host()?.getBoundingClientRect();
		const s = selected();
		if (!box || !s) return void (at = null);
		// Above the selection's first line, kept inside the host.
		const x = Math.max(4, Math.min(s.rect.left - box.left, box.width - 220));
		const y = Math.max(4, s.rect.top - box.top - 30);
		at = { x, y, text: s.text };
	}

	onMount(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const later = () => {
			clearTimeout(timer);
			timer = setTimeout(update, 120);
		};
		document.addEventListener('selectionchange', later);
		const el = scroller();
		const hide = () => (at = null);
		el?.addEventListener('scroll', later, { passive: true });
		window.addEventListener('blur', hide);
		return () => {
			clearTimeout(timer);
			document.removeEventListener('selectionchange', later);
			el?.removeEventListener('scroll', later);
			window.removeEventListener('blur', hide);
		};
	});

	function run(fn: (text: string) => void) {
		if (!at) return;
		const text = at.text;
		at = null;
		getSelection()?.removeAllRanges();
		fn(text);
	}

	const BTN = 'flex h-[22px] items-center gap-1 rounded px-1.5 whitespace-nowrap hover:bg-(--vscode-toolbar-hoverBackground)';
</script>

{#if at}
	<!-- mousedown keeps the selection while a button is pressed. -->
	<div
		class="absolute z-30 flex items-center gap-0.5 rounded-md border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background) p-0.5 text-xs text-(--vscode-editorWidget-foreground) shadow-[0_2px_8px_var(--vscode-widget-shadow)]"
		style:left="{at.x}px"
		style:top="{at.y}px"
		role="toolbar"
		tabindex="-1"
		aria-label={t('chatTranscript.quote.actions')}
		data-chat-find-skip
		onmousedown={(e) => e.preventDefault()}
	>
		<button type="button" class={BTN} title={t('chatTranscript.quote.quoteHint')} onclick={() => run(onquote)}><Codicon id="note" size={12} />{t('chatTranscript.quote.quote')}</button>
		{#if onside}
			<button type="button" class={BTN} title={t('chatTranscript.quote.sideHint')} onclick={() => onside && run(onside)}><Codicon id="comment-discussion" size={12} />{t('chatTranscript.quote.side')}</button>
		{/if}
	</div>
{/if}
