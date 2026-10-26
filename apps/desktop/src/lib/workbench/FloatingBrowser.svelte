<script lang="ts">
	// A browser tab of the floating workspace: an address bar over a real child webview (the Rust
	// floating_browser_* commands). The page is a native view, so it is placed, shown and hidden
	// explicitly: CSS visibility does not reach it. The 8px gutter keeps the panel's resize
	// handles reachable, since the view sits above the page's HTML.
	import { onMount, untrack } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { listen } from '@tauri-apps/api/event';
	import { floating } from './floating.svelte';
	import { browserUrl } from './floating';
	import { status } from './status.svelte';
	import { quick } from './quick.svelte';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import Icon from './Icon.svelte';

	let { id, url: initial = 'about:blank' }: { id: string; url?: string } = $props();
	const label = untrack(() => floating.browserLabel(id));
	let address = $state(untrack(() => initial));
	let opened = $state(false);
	let box: HTMLDivElement;
	let bar: HTMLInputElement;

	onMount(() => {
		const el = box;
		let frame = 0;
		const send = () => {
			frame = 0;
			const r = el.getBoundingClientRect();
			if (r.width < 1 || r.height < 1) return;
			const at = { label, x: r.left, y: r.top, width: r.width, height: r.height };
			const first = !opened;
			const call = opened ? invoke('floating_browser_bounds', at) : invoke('floating_browser_open', { ...at, url: browserUrl(address) });
			opened = true;
			void call.then(() => first && address === 'about:blank' && bar?.focus()).catch((e) => status.error(String(e)));
		};
		const sync = () => {
			if (!frame) frame = requestAnimationFrame(send);
		};
		const observer = new ResizeObserver(sync);
		observer.observe(el);
		// Moving or resizing the panel changes its style, not this box's size.
		const panel = el.closest('[data-floating-terminal-panel]');
		const style = new MutationObserver(sync);
		if (panel) style.observe(panel, { attributes: true, attributeFilter: ['style'] });
		window.addEventListener('resize', sync);
		const un = listen<{ label: string; url: string }>('floating-browser', (e) => {
			if (e.payload.label === label) address = e.payload.url;
		});
		sync();
		return () => {
			observer.disconnect();
			style.disconnect();
			window.removeEventListener('resize', sync);
			cancelAnimationFrame(frame);
			void un.then((f) => f());
			void invoke('floating_browser_close', { label }).catch(() => {});
		};
	});

	$effect(() => {
		// A native view ignores CSS stacking: hide it under the full-window overlays it would punch through.
		// shortcut: only Settings and Quick Input hide it; other dialogs are small enough to miss the panel.
		const visible = floating.open && floating.active === id && !quick.visible && !systemSettings.visible;
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
	<div class="flex h-8 shrink-0 items-center gap-1 px-2" data-floating-terminal-no-drag>
		<button class={BTN} aria-label="Back" title="Back" onclick={() => step(true)}><Icon name="arrowLeft" size={13} /></button>
		<button class={BTN} aria-label="Forward" title="Forward" onclick={() => step(false)}><Icon name="arrowRight" size={13} /></button>
		<button class={BTN} aria-label="Reload" title="Reload" onclick={reload}><Icon name="refresh" size={13} /></button>
		<input
			class="mx-1 h-6 min-w-0 flex-1 rounded border border-(--vscode-input-border,transparent) bg-(--vscode-input-background) px-2 text-[12px] text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder) placeholder:text-(--vscode-input-placeholderForeground)"
			aria-label="Address"
			bind:this={bar}
			onfocus={(e) => e.currentTarget.select()}
			placeholder="Enter a URL"
			spellcheck="false"
			bind:value={address}
			onkeydown={(e) => {
				if (e.key === 'Enter') {
					e.stopPropagation();
					go();
				}
			}}
		/>
		<button class={BTN} aria-label="Open in browser" title="Open in browser" onclick={openExternal}><Icon name="openExternal" size={13} /></button>
	</div>
	<div class="min-h-0 flex-1 px-2 pb-2">
		<div class="h-full w-full rounded border border-(--vscode-widget-border) bg-white" bind:this={box}></div>
	</div>
</div>
