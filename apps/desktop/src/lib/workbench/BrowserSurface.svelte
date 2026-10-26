<script lang="ts">
	// An address bar over a real child webview (the Rust floating_browser_* commands), shared by the
	// floating workspace's browser tabs and the editor's. The page is a native view, so it is
	// placed, shown and hidden explicitly: CSS visibility does not reach it.
	import { onMount, untrack } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { listen } from '@tauri-apps/api/event';
	import { browserTitle, browserUrl, isNewTabPage } from './floating';
	import { status } from './status.svelte';
	import Icon from './Icon.svelte';

	let {
		label,
		url: initial = '',
		visible,
		onTitle,
		onNewTab,
		frame = 'rounded border border-(--vscode-widget-border)',
		padding = 'px-2 pb-2'
	}: {
		label: string;
		url?: string;
		visible: boolean;
		onTitle?: (title: string) => void;
		onNewTab?: () => void;
		frame?: string;
		padding?: string;
	} = $props();
	let address = $state(untrack(() => initial));
	let opened = $state(false);
	/** Focused once on the new-tab page: the page load takes the keyboard after showing. */
	let focusedOnce = false;
	let box: HTMLDivElement;
	let bar: HTMLInputElement;

	onMount(() => {
		const el = box;
		let frameId = 0;
		const send = () => {
			frameId = 0;
			const r = el.getBoundingClientRect();
			if (r.width < 1 || r.height < 1) return;
			const at = { label, x: r.left, y: r.top, width: r.width, height: r.height };
			const call = opened ? invoke('floating_browser_bounds', at) : invoke('floating_browser_open', { ...at, url: browserUrl(address) });
			opened = true;
			void call.catch((e) => status.error(String(e)));
		};
		const sync = () => {
			if (!frameId) frameId = requestAnimationFrame(send);
		};
		const observer = new ResizeObserver(sync);
		observer.observe(el);
		// Moving or resizing the floating panel changes its style, not this box's size.
		const panel = el.closest('[data-floating-terminal-panel]');
		const style = new MutationObserver(sync);
		if (panel) style.observe(panel, { attributes: true, attributeFilter: ['style'] });
		window.addEventListener('resize', sync);
		const un = listen<{ label: string; url: string }>('floating-browser', (e) => {
			if (e.payload.label !== label) return;
			// The app serves the new-tab page; the address bar stays blank for it.
			const url = isNewTabPage(e.payload.url) ? '' : e.payload.url;
			address = url;
			onTitle?.(browserTitle(url));
			// A blank tab starts in the address bar, like Orca's.
			if (isNewTabPage(e.payload.url) && !focusedOnce) {
				focusedOnce = true;
				if (visible) bar?.focus();
			}
		});
		sync();
		return () => {
			observer.disconnect();
			style.disconnect();
			window.removeEventListener('resize', sync);
			cancelAnimationFrame(frameId);
			void un.then((f) => f());
			void invoke('floating_browser_close', { label }).catch(() => {});
		};
	});

	$effect(() => {
		// A native view ignores CSS stacking: hide it under the full-window overlays it would punch through.
		// shortcut: only Settings and Quick Input hide it; other dialogs are small enough to miss it.
		if (!opened) return;
		void invoke('floating_browser_show', { label, visible }).catch(() => {});
	});

	function go() {
		void invoke('floating_browser_navigate', { label, url: browserUrl(address) }).catch((e) => status.error(String(e)));
	}
	function step(back: boolean) {
		void invoke('floating_browser_history', { label, back }).catch(() => {});
	}
	function reload() {
		void invoke('floating_browser_reload', { label }).catch(() => {});
	}
	function openExternal() {
		void invoke('floating_browser_open_external', { url: browserUrl(address) }).catch((e) => status.error(String(e)));
	}

	const BTN = 'grid size-6 shrink-0 place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground)';
</script>

<div class="flex h-full min-h-0 flex-col bg-(--vscode-editor-background)">
	<div class="flex h-10 shrink-0 items-center gap-1 px-2" data-floating-terminal-no-drag>
		<button class={BTN} aria-label="Back" title="Back" onclick={() => step(true)}><Icon name="arrowLeft" size={14} /></button>
		<button class={BTN} aria-label="Forward" title="Forward" onclick={() => step(false)}><Icon name="arrowRight" size={14} /></button>
		<button class={BTN} aria-label="Reload" title="Reload" onclick={reload}><Icon name="refresh" size={14} /></button>
		<div class="mx-1.5 flex h-7 min-w-0 flex-1 items-center gap-2 rounded-full border border-(--vscode-input-border,transparent) bg-(--vscode-input-background) px-3 focus-within:border-(--vscode-focusBorder)">
			<Icon name="globe" size={13} />
			<input
				class="h-full min-w-0 flex-1 bg-transparent text-[12px] text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground)"
				aria-label="Address"
				bind:this={bar}
				onfocus={(e) => e.currentTarget.select()}
				placeholder="Search or enter URL"
				spellcheck="false"
				bind:value={address}
				onkeydown={(e) => {
					if (e.key === 'Enter') {
						e.stopPropagation();
						go();
					}
				}}
			/>
		</div>
		{#if onNewTab}
			<button class={BTN} aria-label="New tab" title="New tab (⇧⌘B)" onclick={onNewTab}><Icon name="plus" size={14} /></button>
		{/if}
		<button class={BTN} aria-label="Open in browser" title="Open in browser" onclick={openExternal}><Icon name="openExternal" size={14} /></button>
	</div>
	<div class="min-h-0 flex-1 {padding}">
		<div class="h-full w-full {frame}" bind:this={box}></div>
	</div>
</div>
