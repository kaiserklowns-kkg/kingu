<script lang="ts">
	// An address bar over a real child webview (the Rust floating_browser_* commands), shared by the
	// floating workspace's browser tabs and the editor's. The page is a native view, so it is
	// placed, shown and hidden explicitly: CSS visibility does not reach it.
	import { onMount, untrack } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { listen } from '@tauri-apps/api/event';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { BROWSER_ZOOMS, browserTitle, browserUrl, defaultBrowserZoom, isNewTabPage, loopbackPort, onLocalPort, readHistory, recordHistory, BROWSER_ACTION, type PickedElement } from './floating';
	import { browserMemorySaver, memorySaverPolicy } from './browserMemorySaver';
	import { notifications } from './notifications.svelte';
	import { quick } from './quick.svelte';
	import { status } from './status.svelte';
	import Icon from './Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { agentBrowser } from './agentBrowser.svelte';
	import { isAgentLabel } from './agentBrowser';

	let {
		label,
		url: initial = '',
		visible,
		viewed,
		onTitle,
		onNavigate,
		onPick,
		profile = '',
		onProfile,
		onImportCookies,
		onNewTab,
		frame = 'rounded border border-(--vscode-widget-border)',
		padding = 'px-2 pb-2',
		route
	}: {
		label: string;
		url?: string;
		visible: boolean;
		/** The user has this tab in view (overlays that only cover the native view aside): what Memory Saver counts. Absent: `visible`. */
		viewed?: boolean;
		onTitle?: (title: string) => void;
		/** The page finished loading `url` (the ADE saves it, so the tab reopens there). */
		onNavigate?: (url: string) => void;
		/** Design Mode picked an element (Orca: its HTML, styles, selector and screenshot go to the agent); absent: no Design Mode button. `screenshot`: the saved PNG of it, null when none could be taken. */
		onPick?: (element: PickedElement, screenshot: string | null) => void;
		/** Orca's browser profile: its own cookies and storage (set when the tab's view opens). */
		profile?: string;
		/** Orca's toolbar profile picker; absent: no picker (the floating browser). */
		onProfile?: () => void;
		/** Orca's Import Cookies (from Chrome / Edge or a cookie file) into the profile; absent: no button. */
		onImportCookies?: () => void;
		onNewTab?: () => void;
		frame?: string;
		padding?: string;
		/** Pages on `localhost` come from a remote host (an SSH worktree): `forward` gives the local port that reaches its port. */
		route?: { via: string; forward: (port: number) => Promise<number> };
	} = $props();
	/** The address to load: a loopback page of the remote host goes to its forward here; null when that failed. */
	async function routed(raw: string): Promise<string | null> {
		const url = browserUrl(raw, settings.get('kingu.browser.searchEngine'));
		const port = route ? loopbackPort(url) : null;
		if (!route || port === null) return url;
		try {
			return onLocalPort(url, await route.forward(port));
		} catch (e) {
			status.error(`Could not reach port ${port} on ${route.via}: ${e}`);
			return null;
		}
	}
	let address = $state(untrack(() => initial));
	const viaHost = $derived(route && loopbackPort(browserUrl(address, settings.get('kingu.browser.searchEngine'))) !== null ? route.via : null);
	let opened = $state(false);
	/** Orca's Memory Saver freed the page: the native view is closed until the tab is shown again. */
	let freed = $state(false);
	/** Places (or opens) the native view; set once mounted. */
	let resync = () => {};
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
			if (r.width < 1 || r.height < 1 || freed) return;
			const at = { label, x: r.left, y: r.top, width: r.width, height: r.height };
			const first = !opened;
			// A remote host's loopback page opens blank, then loads once its forward is up.
			const later = !opened && !!route && loopbackPort(browserUrl(address, settings.get('kingu.browser.searchEngine'))) !== null;
			const call = opened ? invoke('floating_browser_bounds', at) : invoke('floating_browser_open', { ...at, url: later ? 'about:blank' : browserUrl(address, settings.get('kingu.browser.searchEngine')), profile: profile || null });
			if (later) void call.then(() => go());
			opened = true;
			// kingu.browser.defaultZoom (Orca's Default Zoom): a new page starts at it; a page Memory
			// Saver freed comes back at the zoom its tab had.
			const startZoom = restored ? zoom : baseZoom;
			restored = false;
			if (first && startZoom !== 1) void call.then(() => setZoom(startZoom));
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
			agentBrowser.surface(label, url, browserTitle(url));
			onTitle?.(browserTitle(url));
			onNavigate?.(url);
			if (url) recordHistory(url);
			// A blank tab starts in the address bar, like Orca's.
			if (isNewTabPage(e.payload.url) && !focusedOnce) {
				focusedOnce = true;
				if (visible) bar?.focus();
			}
		});
		resync = sync;
		sync();
		agentBrowser.listen();
		agentBrowser.surface(label, browserUrl(address, settings.get('kingu.browser.searchEngine')), browserTitle(address));
		return () => {
			resync = () => {};
			agentBrowser.gone(label);
			browserMemorySaver().close(label);
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

	// Orca's Memory Saver: a tab out of view for kingu.browser.memorySaverHours has its page freed
	// (the native view closes, the tab and its address stay) unless the page says it would lose
	// something; the page loads again when the tab is shown.
	let restored = false;
	/** The freed view's close, still on its way: the page opens again only after it. */
	let closing: Promise<unknown> = Promise.resolve();
	async function free(): Promise<boolean> {
		if (!opened || freed || visible || picking) return false;
		const reason = await invoke<string>('floating_browser_discardable', { label });
		// Shown, or closed, while the page was being asked.
		if (reason !== 'clean' || !opened || freed || visible || picking) return false;
		freed = true;
		opened = false;
		closing = invoke('floating_browser_close', { label }).catch(() => {});
		await closing;
		return true;
	}
	$effect(() => {
		browserMemorySaver().configure(memorySaverPolicy(settings.get('kingu.browser.memorySaver'), settings.get('kingu.browser.memorySaverHours')));
	});
	$effect(() => {
		browserMemorySaver().report(label, viewed ?? visible, free);
	});
	$effect(() => {
		if (!visible || !untrack(() => freed)) return;
		void closing.then(() => {
			if (!freed) return;
			freed = false;
			restored = true;
			resync();
		});
	});

	function go() {
		void routed(address)
			.then((url) => url && invoke('floating_browser_navigate', { label, url }))
			.catch((e) => status.error(String(e)));
	}
	function step(back: boolean) {
		void invoke('floating_browser_history', { label, back }).catch(() => {});
	}
	/** `hard`: Orca's Hard Reload (WKWebView reloadFromOrigin on macOS, a plain reload elsewhere). */
	function reload(hard = false) {
		void invoke('floating_browser_reload', { label, hard }).catch(() => {});
	}
	// Orca's BrowserReloadControl: a right-click on Reload offers Reload and Hard Reload (a native
	// menu, so it shows over the page's native view).
	function reloadMenu(e: MouseEvent) {
		e.preventDefault();
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		void invoke('floating_browser_reload_menu', { label, x: r.left, y: r.bottom + 2, reload: t('ade.browser.reload'), hardReload: t('ade.browser.hardReload') }).catch((err) => status.error(String(err)));
	}
	// Orca's browser tools: zoom (⌘= ⌘- ⌘0), find in page (⌘F), DevTools (⌥⌘I). Commands reach
	// the shown surface through a window event (BROWSER_ACTION) naming its label.
	/** kingu.browser.defaultZoom: where a page starts and where ⌘0 returns. */
	const baseZoom = $derived(defaultBrowserZoom(settings.get('kingu.browser.defaultZoom')));
	let zoom = $state(1);
	const ZOOMS = BROWSER_ZOOMS;
	function setZoom(next: number) {
		zoom = next;
		void invoke('floating_browser_zoom', { label, factor: next }).catch((e) => status.error(String(e)));
	}
	function stepZoom(dir: 1 | -1 | 0) {
		if (dir === 0) return setZoom(baseZoom);
		const i = ZOOMS.findIndex((z) => z >= zoom - 0.001);
		setZoom(ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i < 0 ? ZOOMS.length - 1 : i) + dir))]);
	}
	let finding = $state(false);
	let query = $state('');
	let findBox: HTMLInputElement | undefined = $state();
	function find(backwards = false) {
		if (!query) return;
		void invoke('floating_browser_find', { label, text: query, backwards }).catch(() => {});
	}
	function openFind() {
		finding = true;
		queueMicrotask(() => findBox?.select());
	}
	function devtools() {
		void invoke('floating_browser_devtools', { label }).catch((e) => status.error(String(e)));
	}
	$effect(() => {
		const on = (e: Event) => {
			const d = (e as CustomEvent<{ label: string; action: string }>).detail;
			if (d?.label !== label) return;
			if (d.action === 'find') openFind();
			else if (d.action === 'zoomIn') stepZoom(1);
			else if (d.action === 'zoomOut') stepZoom(-1);
			else if (d.action === 'zoomReset') stepZoom(0);
			else if (d.action === 'devtools') devtools();
			else if (d.action === 'address') bar?.focus();
			else if (d.action === 'reload') reload();
			else if (d.action === 'hardReload') reload(true);
			else if (d.action === 'back') step(true);
			else if (d.action === 'forward') step(false);
		};
		window.addEventListener(BROWSER_ACTION, on);
		return () => window.removeEventListener(BROWSER_ACTION, on);
	});

	// Orca's Design Mode: the page's picker (Rust floating_browser_pick) sends the clicked element back.
	let picking = $state(false);
	function togglePick() {
		picking = !picking;
		void invoke('floating_browser_pick', { label, on: picking }).catch((e) => ((picking = false), status.error(String(e))));
	}
	// Downloads (Orca's downloads shelf, kept to a notice): into the Downloads folder, with Show in Finder.
	$effect(() => {
		const offPick = listen<{ label: string; element: PickedElement }>('browser-pick', (e) => {
			// Only the pick this tab's Design Mode asked for (Rust takes it from an armed tab only).
			if (e.payload.label !== label || !picking) return;
			picking = false;
			// Orca's captureSelectionScreenshot: the element's box cropped from the page (the picker took
			// its outline away first). A missing screenshot is not fatal: the details go without it.
			const el = e.payload.element;
			const r = el.rect ?? { x: 0, y: 0, w: 0, h: 0 };
			void invoke<string | null>('floating_browser_snapshot', { label, x: r.x, y: r.y, width: r.w, height: r.h, viewport: typeof el.vw === 'number' ? el.vw : null })
				.catch(() => null)
				.then((shot) => onPick?.(el, shot ?? null));
		});
		const offDownload = listen<{ label: string; url: string; path: string | null; state: 'started' | 'done' | 'failed' }>('browser-download', (e) => {
			const d = e.payload;
			if (d.label !== label) return;
			const name = (d.path ?? d.url).split('/').pop() ?? d.url;
			if (d.state === 'started') status.flash(`Downloading ${name}…`, 3000);
			else if (d.state === 'failed') notifications.error(`Download failed: ${name}`);
			else notifications.info(`Downloaded ${name}`, { actions: d.path ? [{ label: 'Show in Finder', run: () => invoke('floating_browser_reveal_download', { path: d.path }).catch((err) => status.error(String(err))) }] : [] });
		});
		return () => {
			void offPick.then((f) => f());
			void offDownload.then((f) => f());
		};
	});

	/** Orca's browser history: pages the in-app browser loaded, newest first (localStorage, 300). */
	function showHistory() {
		const items = readHistory();
		void quick.choose({ placeholder: 'History: go to a page', items: items.map((h, i) => ({ id: String(i), label: h.title || h.url, description: h.url })) }).then((pick) => {
			const h = pick ? items[Number(pick.id)] : undefined;
			if (!h) return;
			address = h.url;
			go();
		});
	}

	function openExternal() {
		void invoke('floating_browser_open_external', { url: browserUrl(address, settings.get('kingu.browser.searchEngine')) }).catch((e) => status.error(String(e)));
	}

	const BTN = 'grid size-6 shrink-0 place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground)';

	// VS Code 1.147's browser use: the tab shows while agents may use it (who opened it, what the
	// agent does now) with Stop; Share with Agent hands a user's tab to agents (asked first).
	const indicator = $derived(agentBrowser.indicator(label));
	const shared = $derived(indicator !== null && indicator.kind !== 'stopped');
	function toggleShare() {
		if (shared) void agentBrowser.stop(label);
		else void agentBrowser.share(label, browserUrl(address, settings.get('kingu.browser.searchEngine')));
	}
</script>

<div class="flex h-full min-h-0 flex-col bg-(--vscode-editor-background)">
	<div class="flex h-10 shrink-0 items-center gap-1 px-2" data-floating-terminal-no-drag>
		<button class={BTN} aria-label="Back" title="Back" onclick={() => step(true)}><Icon name="arrowLeft" size={14} /></button>
		<button class={BTN} aria-label="Forward" title="Forward" onclick={() => step(false)}><Icon name="arrowRight" size={14} /></button>
		<button class={BTN} aria-label={t('ade.browser.reload')} title={t('ade.browser.reloadTitle')} onclick={() => reload()} oncontextmenu={reloadMenu}><Icon name="refresh" size={14} /></button>
		{#if onProfile}
			<button class="h-6 max-w-28 shrink-0 truncate rounded px-1.5 text-[11px] text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground)" title={`Browser profile: ${profile || 'Default'} (its own cookies and storage)`} aria-label={`Browser profile: ${profile || 'Default'}`} onclick={onProfile}>{profile || 'Default'}</button>
		{/if}
		{#if onImportCookies}
			<button class={BTN} aria-label={t('ade.cookieImport.action')} title={t('ade.cookieImport.action')} onclick={onImportCookies}><Icon name="signIn" size={14} /></button>
		{/if}
		<div class="mx-1.5 flex h-7 min-w-0 flex-1 items-center gap-2 rounded-full border border-(--vscode-input-border,transparent) bg-(--vscode-input-background) px-3 focus-within:border-(--vscode-focusBorder)">
			<Icon name="globe" size={13} />
			<input
				class="h-full min-w-0 flex-1 bg-transparent text-[12px] text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground)"
				aria-label="Address"
				bind:this={bar}
				onfocus={(e) => e.currentTarget.select()}
				placeholder="Search or enter URL"
				title={viaHost ? `Connected via ${viaHost}` : undefined}
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
		{#if zoom !== baseZoom}
			<button class="h-6 shrink-0 rounded px-1.5 text-[11px] text-(--vscode-descriptionForeground) tabular-nums hover:bg-(--vscode-toolbar-hoverBackground)" title="Reset zoom (⌘0)" onclick={() => stepZoom(0)}>{Math.round(zoom * 100)}%</button>
		{/if}
		<button class={BTN} aria-label="Zoom out" title="Zoom out (⌘-)" onclick={() => stepZoom(-1)}><Icon name="minus" size={14} /></button>
		<button class={BTN} aria-label="Zoom in" title="Zoom in (⌘=)" onclick={() => stepZoom(1)}><Icon name="plus" size={14} /></button>
		<button class={BTN} aria-label="Find in page" title="Find in page (⌘F)" onclick={openFind}><Icon name="search" size={14} /></button>
		<button class={BTN} aria-label="History" title="History" onclick={showHistory}><Icon name="clock" size={14} /></button>
		{#if onPick}
			<button class={[BTN, picking && 'bg-(--vscode-toolbar-activeBackground,var(--vscode-toolbar-hoverBackground)) text-(--vscode-focusBorder)']} aria-label="Design mode" aria-pressed={picking} title="Design mode: click an element to send it to the agent (Esc stops)" onclick={togglePick}><Icon name="crosshair" size={14} /></button>
		{/if}
		<button class={BTN} aria-label={t('agentBrowser.screenshot')} title={t('agentBrowser.screenshot')} onclick={() => void agentBrowser.screenshotToChat(label)}><Icon name="image" size={14} /></button>
		{#if agentBrowser.enabled && !isAgentLabel(label)}
			<button class={[BTN, shared && 'text-(--vscode-focusBorder)']} aria-label={shared ? t('agentBrowser.unshare') : t('agentBrowser.share')} aria-pressed={shared} title={shared ? t('agentBrowser.unshare') : t('agentBrowser.share')} onclick={toggleShare}><Icon name="robot" size={14} /></button>
		{/if}
		<button class={BTN} aria-label="Developer tools" title="Developer tools (⌥⌘I)" onclick={devtools}><Icon name="code" size={14} /></button>
		{#if onNewTab}
			<button class={BTN} aria-label="New tab" title="New tab (⇧⌘B)" onclick={onNewTab}><Icon name="plus" size={14} /></button>
		{/if}
		<button class={BTN} aria-label="Open in browser" title="Open in browser" onclick={openExternal}><Icon name="openExternal" size={14} /></button>
	</div>
	{#if finding}
		<div class="flex h-8 shrink-0 items-center gap-1 px-2" data-floating-terminal-no-drag>
			<input
				bind:this={findBox}
				class="h-6 min-w-0 flex-1 rounded border border-(--vscode-input-border,transparent) bg-(--vscode-input-background) px-2 text-[12px] text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)"
				aria-label="Find in page"
				placeholder="Find in page"
				spellcheck="false"
				bind:value={query}
				onkeydown={(e) => {
					e.stopPropagation();
					if (e.key === 'Enter') find(e.shiftKey);
					else if (e.key === 'Escape') finding = false;
				}}
			/>
			<button class={BTN} aria-label="Previous match" title="Previous match (⇧↩)" onclick={() => find(true)}><Icon name="arrowUp" size={14} /></button>
			<button class={BTN} aria-label="Next match" title="Next match (↩)" onclick={() => find(false)}><Icon name="arrowDown" size={14} /></button>
			<button class={BTN} aria-label="Close find" title="Close (Esc)" onclick={() => (finding = false)}><Icon name="close" size={14} /></button>
		</div>
	{/if}
	{#if indicator}
		<div
			class={['flex h-7 shrink-0 items-center gap-2 px-3 text-[12px]', indicator.kind === 'stopped' ? 'text-(--vscode-descriptionForeground)' : 'bg-(--vscode-inputValidation-infoBackground,var(--vscode-editorWidget-background)) text-(--vscode-foreground)']}
			role="status"
			aria-label={t('agentBrowser.statusLabel')}
			data-floating-terminal-no-drag
		>
			{#if indicator.kind === 'driving'}<span class="size-2 shrink-0 animate-pulse rounded-full bg-(--vscode-focusBorder)" aria-hidden="true"></span>{/if}
			<span class="min-w-0 flex-1 truncate">
				{indicator.kind === 'driving' ? (indicator.action ? t('agentBrowser.drivingAction', { action: indicator.action }) : t('agentBrowser.driving')) : indicator.kind === 'stopped' ? t('agentBrowser.stopped') : indicator.agentOpened ? t('agentBrowser.agentPage') : t('agentBrowser.shared')}
			</span>
			<button class="h-5 shrink-0 rounded px-1.5 hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => void agentBrowser.showLog(label)}>{t('agentBrowser.log')}</button>
			{#if indicator.kind !== 'stopped'}
				<button class="h-5 shrink-0 rounded bg-(--vscode-button-background) px-2 text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)" title={t('agentBrowser.stopTitle')} onclick={() => void agentBrowser.stop(label)}>{t('agentBrowser.stop')}</button>
			{/if}
		</div>
	{/if}
	<div class={['min-h-0 flex-1', padding, shared && 'p-[2px] outline-2 -outline-offset-2 outline-(--vscode-focusBorder)', indicator?.kind === 'driving' && 'outline-dashed']} data-agent-shared={shared ? 'true' : undefined}>
		<div class="h-full w-full {frame}" bind:this={box}></div>
	</div>
</div>
