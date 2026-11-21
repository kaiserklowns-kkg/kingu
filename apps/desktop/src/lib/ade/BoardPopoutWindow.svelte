<script lang="ts">
	// The task board's pop-out window (route /board-popout; Orca's DashboardPopoutRoot +
	// AgentKanbanBoard): the agent columns of every project, mirrored from the window that opened
	// it (boardPopout.svelte.ts publishes, windows.rs relays). It has no workspace, watchers or
	// terminals: it draws the latest snapshot, with its own search and Project filter. A card click
	// opens its terminal preview (Orca's AgentTerminalDialog: the agent's terminal, header with its
	// state, "Open worktree"), whose rows the feeding window adds to its snapshots while it is
	// open; Open task there brings that window to the front to open the task.
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import AgentIcon from '#lib/agent/AgentIcon.svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { listenWindow } from '#lib/workbench/windowEvents.ts';
	import { resolveUiLanguage, t, useLocaleSource, type Locale } from '#lib/i18n/index.ts';
	import { clientLog } from '#lib/client-log.ts';
	import { boardMatches, inProjects, projectOptions, toggleFilter } from './boardSearch';
	import { cssVariables, type PopoutCard, type PopoutSnapshot } from './boardPopout';
	import { timeAgo } from './model';

	const COLUMN_DOT: Record<string, string> = {
		attention: 'bg-(--vscode-editorWarning-foreground)',
		active: 'bg-(--vscode-editorInfo-foreground)',
		done: 'bg-[#73C991]'
	};

	let snapshot = $state<PopoutSnapshot | null>(null);
	let lang = $state<Locale>(resolveUiLanguage('en', typeof navigator !== 'undefined' ? navigator.language : null));
	useLocaleSource(() => lang);
	let now = $state(Date.now());
	let query = $state('');
	let projectFilter = $state<string[]>([]);
	let projectMenu = $state(false);
	let searchBox: HTMLInputElement | undefined = $state();
	/** The card whose terminal preview is open (its key). */
	let previewKey = $state<string | null>(null);
	let previewBox: HTMLDivElement | undefined = $state();
	/** Whether the preview follows its last row (it does until scrolled up). */
	let previewPinned = true;
	let previewAsked = 0;
	function askPreview(c: PopoutCard | null) {
		previewAsked = Date.now();
		invoke('board_popout_preview', { card: c && { root: c.root, slug: c.slug } }).catch((e) => clientLog('error', `board_popout_preview: ${e}`));
	}

	/** The theme variables last written, so another theme's own colors do not outlive it. */
	let written = new Set<string>();
	function apply(next: PopoutSnapshot | null) {
		if (!next) return;
		snapshot = next;
		now = Date.now();
		lang = next.locale;
		const root = document.documentElement;
		for (const name of written) if (!(name in next.theme.vars)) root.style.removeProperty(name);
		for (const [name, value] of Object.entries(next.theme.vars)) root.style.setProperty(name, value);
		written = new Set(Object.keys(next.theme.vars));
		root.style.colorScheme = next.theme.dark ? 'dark' : 'light';
		root.dataset.themeType = next.theme.dark ? 'dark' : 'light';
		root.lang = next.locale;
		// A feeding window that reloaded (or took over) without hearing which card is open: ask again, at most once a second.
		if (previewKey && next.preview?.key !== previewKey && Date.now() - previewAsked > 1000) askPreview(allCardsOf(next).find((c) => c.key === previewKey) ?? null);
	}
	const allCardsOf = (s: PopoutSnapshot) => s.lanes.flatMap((l) => l.cards);

	onMount(() => {
		// Before the first snapshot: whatever the page itself has on <html>.
		written = new Set(Object.keys(cssVariables(document.documentElement.style)));
		const tick = setInterval(() => (now = Date.now()), 30_000);
		const off = listenWindow<PopoutSnapshot>('board-popout:snapshot', (e) => apply(e.payload));
		void off.then(() => invoke<PopoutSnapshot | null>('board_popout_request')).then(apply, (e) => clientLog('error', `board_popout_request: ${e}`));
		return () => {
			clearInterval(tick);
			void off.then((f) => f());
		};
	});

	// The window title and its native light/dark frame follow the language and theme.
	$effect(() => {
		const title = t('adeWorkflow.popout.windowTitle');
		document.title = title;
		const dark = snapshot?.theme.dark;
		void import('@tauri-apps/api/window')
			.then(({ getCurrentWindow }) => {
				const w = getCurrentWindow();
				void w.setTitle(title);
				if (dark !== undefined) void w.setTheme(dark ? 'dark' : 'light');
			})
			.catch(() => {});
	});

	const here = $derived(snapshot?.here ?? '');
	const allCards = $derived(snapshot ? allCardsOf(snapshot) : []);
	const projectChoices = $derived(projectOptions(snapshot?.projects ?? [], allCards));
	// A project that left the feeding window's side bar leaves the filter too.
	$effect(() => {
		const ids = new Set(projectChoices.map((p) => p.id));
		if (projectFilter.some((p) => !ids.has(p))) projectFilter = projectFilter.filter((p) => ids.has(p));
	});
	const narrowed = $derived(!!query.trim() || projectFilter.length > 0);
	const hit = (c: PopoutCard) => boardMatches({ title: c.title, slug: c.slug, agent: c.agent, branch: c.branch, project: c.project }, query) && inProjects(projectFilter, c.root);
	const lanes = $derived((snapshot?.lanes ?? []).map((l) => (narrowed ? { ...l, cards: l.cards.filter(hit) } : l)));
	const shownCount = $derived(lanes.reduce((n, l) => n + l.cards.length, 0));

	const reveal = (c: PopoutCard) => invoke('board_popout_reveal', { root: c.root, slug: c.slug }).catch((e) => clientLog('error', `board_popout_reveal: ${e}`));

	// Orca keeps the dialog open while its card moves between columns; it closes when the card is gone.
	const previewCard = $derived(previewKey ? (allCards.find((c) => c.key === previewKey) ?? null) : null);
	const preview = $derived(previewKey && snapshot?.preview?.key === previewKey ? snapshot.preview : null);
	$effect(() => {
		if (previewKey && snapshot && !previewCard) closePreview();
	});
	function openPreview(c: PopoutCard) {
		previewKey = c.key;
		previewPinned = true;
		askPreview(c);
	}
	function closePreview() {
		if (!previewKey) return;
		previewKey = null;
		askPreview(null);
	}
	// New rows keep the preview at its end unless it was scrolled up.
	$effect(() => {
		void preview?.lines;
		if (previewBox && previewPinned) previewBox.scrollTop = previewBox.scrollHeight;
	});

	// ⌘F (Ctrl+F) focuses the search.
	function onKey(e: KeyboardEvent) {
		if (previewKey && e.key === 'Escape') {
			e.preventDefault();
			closePreview();
			return;
		}
		if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
			e.preventDefault();
			searchBox?.focus();
		}
	}
</script>

<svelte:window onkeydown={onKey} />

<div class="flex h-screen flex-col overflow-hidden bg-(--vscode-editor-background) text-(--vscode-foreground)">
	<header class="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--vscode-widget-border) px-4 py-2 whitespace-nowrap">
		<h1 class="flex items-center gap-2 text-sm font-semibold"><Icon name="tasks" size={16} />{t('adeWorkflow.popout.title')}</h1>
		{#if snapshot}
			<span class="text-xs text-(--vscode-descriptionForeground)">{narrowed ? t('adeWorkflow.board.shown', { shown: shownCount, count: allCards.length }) : t('adeWorkflow.board.count', { count: allCards.length })}</span>
		{/if}
		<span class="flex-1"></span>
		{#if projectChoices.length > 1}
			<!-- Orca's Project filter: multi-select with counts; removable chips; none chosen = all. -->
			<div class="relative">
				<button
					class={['flex h-6 items-center gap-1 rounded-md border px-1.5 text-xs', projectFilter.length ? 'border-(--vscode-focusBorder)' : 'border-(--vscode-input-border,var(--vscode-widget-border))', 'bg-(--vscode-input-background) text-(--vscode-input-foreground)']}
					aria-haspopup="true"
					aria-expanded={projectMenu}
					onclick={() => (projectMenu = !projectMenu)}
				>
					<Icon name="filter" size={12} />{projectFilter.length ? t('adeWorkflow.board.projectsChosen', { count: projectFilter.length }) : t('adeWorkflow.board.projectsAll')}
				</button>
				{#if projectMenu}
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<div
						class="absolute top-full right-0 z-20 mt-1 max-h-72 w-60 overflow-y-auto rounded-md border border-(--vscode-widget-border) bg-(--vscode-menu-background,var(--vscode-editorWidget-background)) p-1 text-xs shadow-lg"
						role="group"
						aria-label={t('adeWorkflow.board.projectFilter')}
						onkeydown={(e) => e.key === 'Escape' && (projectMenu = false)}
						onfocusout={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && (projectMenu = false)}
					>
						{#each projectChoices as p (p.id)}
							<label class="flex items-center gap-2 rounded px-2 py-1 hover:bg-(--vscode-list-hoverBackground)" title={p.id}>
								<input type="checkbox" checked={projectFilter.includes(p.id)} onchange={() => (projectFilter = toggleFilter(projectFilter, p.id))} />
								<span class="min-w-0 flex-1 truncate">{p.label}{p.id === here ? ` · ${t('adeWorkflow.board.openProject')}` : ''}</span>
								<span class="text-(--vscode-descriptionForeground)">{p.count}</span>
							</label>
						{/each}
						{#if projectFilter.length}
							<button class="mt-1 w-full rounded px-2 py-1 text-left text-(--vscode-textLink-foreground) hover:bg-(--vscode-list-hoverBackground)" onclick={() => (projectFilter = [])}>{t('adeWorkflow.board.clearFilters')}</button>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
		<label class="flex h-6 w-48 items-center gap-1 rounded-md border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) px-1.5 focus-within:border-(--vscode-focusBorder)">
			<Icon name="search" size={12} />
			<input bind:this={searchBox} class="min-w-0 flex-1 bg-transparent text-xs text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground)" placeholder={t('adeWorkflow.board.search')} aria-label={t('adeWorkflow.board.search')} bind:value={query} onkeydown={(e) => e.key === 'Escape' && (query = '')} />
		</label>
	</header>
	{#if projectFilter.length}
		<div class="flex shrink-0 flex-wrap items-center gap-1 px-4 pt-2 text-xs">
			{#each projectFilter as id (id)}
				{@const name = projectChoices.find((p) => p.id === id)?.label ?? id}
				<span class="flex items-center gap-1 rounded-full bg-(--vscode-badge-background) py-0.5 pr-1 pl-2 text-(--vscode-badge-foreground)">
					{name}
					<button class="grid size-4 place-items-center rounded-full hover:bg-black/20" aria-label={t('adeWorkflow.board.removeFilter', { name })} onclick={() => (projectFilter = toggleFilter(projectFilter, id))}><Icon name="close" size={10} /></button>
				</span>
			{/each}
			<button class="text-(--vscode-textLink-foreground) hover:underline" onclick={() => (projectFilter = [])}>{t('adeWorkflow.board.clearFilters')}</button>
		</div>
	{/if}
	{#if !snapshot}
		<p class="m-auto px-6 text-center text-xs text-(--vscode-descriptionForeground)">{t('adeWorkflow.popout.waiting')}</p>
	{:else}
		<div class="grid min-h-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden p-4" style:grid-template-columns="repeat({lanes.length}, {snapshot.width}px)">
			{#each lanes as lane (lane.id)}
				<section aria-label={lane.label} class="flex min-h-0 flex-col rounded-xl border border-(--vscode-widget-border)" style:background="color-mix(in srgb, var(--vscode-sideBar-background) {snapshot.opacity}%, transparent)">
					<h2 class="flex shrink-0 items-center gap-2 px-3.5 py-2.5 text-xs font-semibold" title={lane.hint}>
						<span class={['size-2 rounded-full', COLUMN_DOT[lane.id] ?? 'bg-(--vscode-descriptionForeground)']}></span>
						{lane.label}
						<span class="rounded-full bg-(--vscode-badge-background) px-1.5 text-[10px] leading-4 font-normal text-(--vscode-badge-foreground)">{lane.cards.length}</span>
					</h2>
					<div class="min-h-0 flex-1 space-y-2 overflow-y-auto px-2.5 pb-2.5">
						{#each lane.cards as c (c.key)}
							<div
								role="button"
								tabindex="0"
								aria-label="{c.title} — {c.status} — {c.project}"
								title={t('adeWorkflow.popout.previewTask', { title: c.title })}
								class="group relative cursor-pointer rounded-lg border border-(--vscode-widget-border) bg-(--vscode-editor-background) p-2.5 text-xs outline-none transition-[border-color,box-shadow] hover:border-(--vscode-focusBorder)/60 hover:shadow-md hover:shadow-black/25 focus-visible:border-(--vscode-focusBorder)"
								style:margin-left={c.depth ? `${Math.min(c.depth, 3) * 12}px` : undefined}
								onclick={() => openPreview(c)}
								onkeydown={(e) => e.target === e.currentTarget && e.key === 'Enter' && (e.preventDefault(), openPreview(c))}
							>
								<div class="flex items-center gap-1.5">
									<span class={['size-2 shrink-0 rounded-full', c.dot]} title={c.status}></span>
									<span class="min-w-0 flex-1 truncate font-medium text-(--vscode-foreground)" title={c.title}>{c.title}</span>
									<span class="shrink-0 text-(--vscode-descriptionForeground)">{timeAgo(c.when, now)}</span>
								</div>
								{#if c.summary}<p class="mt-1 line-clamp-2 text-(--vscode-descriptionForeground)">{c.summary}</p>{/if}
								<div class="mt-1.5 flex items-center gap-1.5 text-[11px] text-(--vscode-descriptionForeground)">
									{#if c.agent}<AgentIcon agent={c.agent} size={12} /><span class="truncate">{c.agent}</span><span aria-hidden="true">·</span>{/if}
									<span class="truncate rounded-sm bg-(--vscode-badge-background)/60 px-1 text-(--vscode-badge-foreground)">{c.project}</span>
									<span class="truncate font-mono">{c.slug}</span>
								</div>
							</div>
						{:else}
							<p class="rounded-lg border border-dashed border-(--vscode-widget-border) px-3 py-6 text-center text-xs text-(--vscode-descriptionForeground)">{t('adeWorkflow.board.empty')}</p>
						{/each}
					</div>
				</section>
			{/each}
		</div>
	{/if}
	{#if previewCard}
		{@const c = previewCard}
		<!-- Orca's AgentTerminalDialog: outside clicks and Escape close it. -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div class="fixed inset-0 z-30 flex items-center justify-center bg-black/50" onclick={(e) => e.target === e.currentTarget && closePreview()}>
			<div role="dialog" aria-modal="true" aria-labelledby="board-preview-title" class="flex w-[calc(100vw-40px)] flex-col overflow-hidden rounded-lg border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background,var(--vscode-editor-background)) shadow-xl shadow-black/40">
				<header class="flex shrink-0 items-center gap-1.5 px-2.5 py-2 text-xs">
					{#if c.agent}<AgentIcon agent={c.agent} size={13} />{/if}
					<h2 id="board-preview-title" class="min-w-0 truncate text-[12px] font-semibold">{c.title}</h2>
					<span class="shrink-0 text-[11px] text-(--vscode-descriptionForeground)">{c.agent ? `${c.agent} · ` : ''}{c.status}</span>
					<button class="ml-auto grid size-6 place-items-center rounded opacity-70 hover:bg-(--vscode-toolbar-hoverBackground) hover:opacity-100" aria-label={t('adeWorkflow.popout.close')} title={t('adeWorkflow.popout.close')} onclick={closePreview}><Icon name="close" size={14} /></button>
				</header>
				{#if preview?.lines}
					<div
						bind:this={previewBox}
						role="log"
						aria-label={t('adeWorkflow.popout.preview')}
						tabindex="-1"
						class="flex h-[calc(100vh-140px)] flex-col overflow-auto bg-(--vscode-terminal-background,var(--vscode-panel-background)) p-1.5 text-(--vscode-terminal-foreground,var(--vscode-foreground))"
						onscroll={(e) => (previewPinned = e.currentTarget.scrollTop + e.currentTarget.clientHeight >= e.currentTarget.scrollHeight - 4)}
					>
						<pre class="mt-auto font-mono text-xs leading-[1.35] whitespace-pre select-text">{preview.lines.join('\n')}</pre>
					</div>
				{:else if preview}
					<div class="max-h-[calc(100vh-140px)] min-h-0 flex-1 overflow-y-auto px-2.5 pb-2 text-[11px]">
						<p class="text-(--vscode-descriptionForeground)">{t('adeWorkflow.popout.previewUnavailable')}</p>
						{#if c.summary}<p class="mt-2 break-words whitespace-pre-wrap">{c.summary}</p>{/if}
					</div>
				{:else}
					<div class="h-[calc(100vh-140px)] bg-(--vscode-terminal-background,var(--vscode-panel-background))"></div>
				{/if}
				<footer class="flex shrink-0 items-center px-2.5 py-1.5">
					<button
						class="ml-auto flex h-6 items-center gap-1 rounded-md border border-(--vscode-button-border,var(--vscode-widget-border)) px-2 text-xs hover:bg-(--vscode-toolbar-hoverBackground)"
						title={t('adeWorkflow.popout.openTask', { title: c.title })}
						onclick={() => {
							reveal(c);
							closePreview();
						}}><Icon name="openExternal" size={12} />{t('adeWorkflow.popout.openInWindow')}</button
					>
				</footer>
			</div>
		</div>
	{/if}
</div>
