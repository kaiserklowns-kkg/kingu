<script lang="ts">
	// The usage item at the left of the status bar, as Orca builds it: one chip per agent provider
	// (or "Configure usage tracking" when none is set up), a refresh button, and the Usage popup
	// (UsageRosterPanel) with Detailed / Compact, a row per provider opening its details and
	// account submenu, then Usage details & history and Manage Accounts.
	import Icon from './Icon.svelte';
	import ProviderIcon from './ProviderIcon.svelte';
	import StatusPopover from './StatusPopover.svelte';
	import { usage } from './usage.svelte';
	import {
		barTone,
		clampPct,
		errorLabel,
		errorMessage,
		hasValue,
		headline,
		isWaiting,
		maxUsed,
		percentLabel,
		planName,
		PROVIDER_NAME,
		resetsIn,
		rowState,
		shownPct,
		soonestReset,
		textTone,
		updatedLabel,
		windowLength,
		windowsOf,
		windowWhen,
		type ProviderId,
		type ProviderState,
		type UsageDisplay,
		type UsageMode,
		type Window
	} from './usage';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { systemSettings, type SettingsPageId } from '#lib/settings/systemSettings.svelte.ts';

	/** Density from the status bar: `compact` drops labels and bars, `tightest` forces Compact chips. */
	let { compact = false, tightest = false }: { compact?: boolean; tightest?: boolean } = $props();

	const display = $derived((settings.get<string>('kingu.usage.display') ?? 'used') as UsageDisplay);
	const mode = $derived((settings.get<string>('kingu.usage.mode') ?? 'compact') as UsageMode);
	const chipMode = $derived(tightest ? 'compact' : mode);
	const itemOn = (p: ProviderId) => settings.get<boolean>(`kingu.statusBar.${p}Usage.visible`) !== false;
	/** Orca's `vi`: has a value, the item is on, and the agent is installed. */
	const visible = $derived(usage.active.filter((p) => hasValue(usage.providers[p]) && itemOn(p)));
	const loading = $derived(usage.active.some((p) => !usage.providers[p] || usage.providers[p]?.status === 'fetching' || usage.providers[p]?.status === 'idle'));
	let dismissed = $state(readDismissed());
	const emptyState = $derived(!visible.length && !loading && usage.detected !== null);
	/** Popup rows: every installed provider, most used first. */
	const rows = $derived([...usage.active].sort((a, b) => maxUsed(usage.providers[b]) - maxUsed(usage.providers[a])));

	$effect(() => usage.start());

	let open = $state(false);
	let anchor = $state<HTMLElement | null>(null);
	let sub = $state<{ provider: ProviderId; top: number; left: number } | null>(null);
	let expanded = $state(false);
	let hoverCard = $state(false);
	let cta: HTMLButtonElement | undefined = $state();

	function readDismissed() {
		try {
			return localStorage.getItem('kingu.usage.emptyStateDismissed') === '1';
		} catch {
			return false;
		}
	}
	function dismissEmpty() {
		dismissed = true;
		hoverCard = false;
		try {
			localStorage.setItem('kingu.usage.emptyStateDismissed', '1');
		} catch {
			// Not remembered across restarts.
		}
	}
	function close() {
		open = false;
		sub = null;
		expanded = false;
	}
	function go(page: SettingsPageId) {
		close();
		hoverCard = false;
		systemSettings.showPage(page);
	}
	function openSub(provider: ProviderId, row: HTMLElement) {
		if (sub?.provider === provider) return;
		const r = row.getBoundingClientRect();
		const width = 300;
		const left = r.right + width + 8 <= window.innerWidth ? r.right + 4 : Math.max(8, r.left - width - 4);
		sub = { provider, top: Math.max(8, Math.min(r.top, window.innerHeight - 32 - 360)), left };
		expanded = false;
	}
	const setMode = (m: UsageMode) => ((sub = null), void settings.set('kingu.usage.mode', m === 'compact' ? undefined : m, 'user'));

	const BAR: Record<string, string> = { neutral: 'bg-(--vscode-descriptionForeground)/40', warning: 'bg-yellow-500', critical: 'bg-red-500' };
	const TEXT: Record<string, string> = { normal: 'text-(--vscode-foreground)', warning: 'text-yellow-500', critical: 'text-red-500' };
	const MUTED = 'text-(--vscode-descriptionForeground)';
	const DIVIDER = 'border-t border-(--vscode-widget-border)/70';
	const MENU_ROW =
		'flex w-full items-center justify-between px-3.5 py-2.5 text-left text-[13px] text-(--vscode-foreground) outline-none hover:bg-(--vscode-list-hoverBackground) focus-visible:bg-(--vscode-list-hoverBackground)';
</script>

{#snippet chip(p: ProviderState | null, id: ProviderId)}
	{@const top = headline(p)}
	{#if !p || p.status === 'idle' || (p.status === 'fetching' && !top)}
		<span class="inline-flex items-center gap-1 {MUTED}"><ProviderIcon provider={id} /><span class="animate-pulse">···</span></span>
	{:else if p.status === 'unavailable'}
		<span class="inline-flex items-center gap-1 opacity-50 {MUTED}"><ProviderIcon provider={id} /> --</span>
	{:else if !top}
		<span class="inline-flex items-center gap-1 {MUTED}">
			<ProviderIcon provider={id} />
			{#if !isWaiting(p)}<span class="opacity-80"><Icon name="warning" size={11} /></span>{/if}
			{#if !compact}<span class="text-[11px] font-medium">{errorLabel(p)}</span>{/if}
		</span>
	{:else}
		<span class="inline-flex items-center gap-1.5">
			<ProviderIcon provider={id} />
			{#if chipMode === 'detailed'}
				{#if !compact}
					<span class="h-[6px] w-[48px] shrink-0 overflow-hidden rounded-full bg-(--vscode-widget-border)">
						<span class="block h-full rounded-full bg-(--vscode-descriptionForeground)/40 transition-all duration-300" style:width="{shownPct(top.window.usedPercent, display)}%"></span>
					</span>
				{/if}
				{#each windowsOf(p) as w, i (w.label)}
					{#if i}<span class={MUTED}>·</span>{/if}
					<span class="tabular-nums">{percentLabel(w.window.usedPercent, display)} {windowWhen(w.window, usage.now)}</span>
				{/each}
			{:else}
				<span class="tabular-nums">{percentLabel(top.window.usedPercent, display)}{compact ? '' : ` ${windowWhen(top.window, usage.now)}`}</span>
			{/if}
			{#if p.status === 'error' && !isWaiting(p)}<span class="opacity-80 {MUTED}"><Icon name="warning" size={11} /></span>{/if}
		</span>
	{/if}
{/snippet}

{#snippet meter(label: string, w: Window, bar: boolean)}
	{@const used = clampPct(w.usedPercent)}
	<span data-usage-window class="flex shrink-0 items-center gap-1.5">
		<span class="text-[10px] {MUTED}">{label}</span>
		{#if bar}<span class="h-[5px] w-7 overflow-hidden rounded-full bg-(--vscode-widget-border)"><span class={['block h-full rounded-full', BAR[barTone(used)]]} style:width="{shownPct(w.usedPercent, display)}%"></span></span>{/if}
		<span class={['text-[11px] tabular-nums', TEXT[textTone(used)]]}>{shownPct(w.usedPercent, display)}%</span>
	</span>
{/snippet}

{#if emptyState && !dismissed}
	<button
		bind:this={cta}
		class="ml-1 inline-flex h-5 items-center gap-1.5 rounded px-1.5 text-xs {MUTED} transition-colors hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)"
		aria-label="Configure usage tracking"
		onclick={() => go('account')}
		onpointerenter={() => (hoverCard = true)}
		onpointerleave={() => (hoverCard = false)}
	>
		<Icon name="chartBar" size={14} />Configure usage tracking
	</button>
	{#if hoverCard && cta}
		<div
			role="dialog"
			aria-label="Agent usage limits"
			tabindex="-1"
			class="fixed z-50 w-[260px] space-y-2 rounded-lg border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) p-2.5 text-xs leading-[1.45] shadow-xl shadow-black/40"
			style:left="{cta.getBoundingClientRect().left}px"
			style:bottom="{window.innerHeight - cta.getBoundingClientRect().top + 8}px"
			onpointerenter={() => (hoverCard = true)}
			onpointerleave={() => (hoverCard = false)}
		>
			<div class="flex items-center justify-between">
				<span class="font-semibold">Agent usage limits</span>
				<button class="grid size-5 place-items-center rounded {MUTED} hover:bg-(--vscode-toolbar-hoverBackground)" title="Hide from status bar" aria-label="Hide from status bar" onclick={dismissEmpty}><Icon name="eyeOff" size={13} /></button>
			</div>
			<p class={MUTED}>Connect your AI provider accounts to see their usage in real time and easily switch between accounts.</p>
			<div class="flex items-center gap-1.5 {MUTED}">Supports: <ProviderIcon provider="claude" /><ProviderIcon provider="codex" /></div>
			<button class="mt-0.5 h-7 w-full rounded-md bg-(--vscode-button-background) text-xs text-(--vscode-button-foreground) hover:opacity-90" onclick={() => go('account')}>Connect an account</button>
		</div>
	{/if}
{:else if visible.length}
	<button
		class="ml-1 inline-flex items-center gap-3 rounded px-1 py-0.5 hover:bg-(--vscode-toolbar-hoverBackground) aria-expanded:bg-(--vscode-toolbar-hoverBackground)"
		aria-label="Usage"
		aria-haspopup="menu"
		aria-expanded={open}
		onclick={(e) => ((anchor = e.currentTarget), open ? close() : (open = true))}
	>
		{#each visible as id (id)}<span data-usage-chip={id} class="inline-flex">{@render chip(usage.providers[id], id)}</span>{/each}
	</button>
{/if}
{#if !(emptyState && !dismissed) && (visible.length || settings.get<boolean>('kingu.statusBar.resources.visible') !== false)}
	<button
		class="mx-1 grid place-items-center rounded p-0.5 {MUTED} transition-colors hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:opacity-40"
		aria-label="Refresh rate limits"
		title="Refresh usage data"
		disabled={usage.refreshing}
		onclick={() => usage.refresh()}
	>
		<span class={['grid place-items-center', (usage.refreshing || usage.anyFetching) && 'animate-spin']}><Icon name="refresh" size={11} /></span>
	</button>
{/if}

{#if open && anchor}
	<StatusPopover {anchor} label="Usage" width={360} align="left" onClose={close}>
		<div class="w-[360px] text-xs">
			<div class="flex items-center justify-between px-3.5 pt-3 pb-2">
				<span class="text-[13px] font-semibold">Usage</span>
				<span class="flex items-center gap-2 {MUTED}">
					<span class="text-[11px]">all agents</span>
					<button class="grid size-5 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" aria-label="Refresh rate limits" onclick={() => usage.refresh()}>
						<span class={['grid place-items-center', (usage.refreshing || usage.anyFetching) && 'animate-spin']}><Icon name="refresh" size={12} /></span>
					</button>
				</span>
			</div>
			<div class="px-3.5 pb-2.5">
				<div class="inline-flex w-full items-center rounded-md border border-(--vscode-widget-border) bg-(--vscode-editor-background)/50 p-0.5" role="radiogroup" aria-label="Usage footer detail">
					{#each [{ id: 'detailed', label: 'Detailed', tip: 'Full usage with bars, labels, and percentages' }, { id: 'compact', label: 'Compact', tip: 'Condensed usage: one summary per provider' }] as m (m.id)}
						<button
							role="radio"
							aria-checked={mode === m.id}
							title={m.tip}
							class={['flex-1 rounded-sm px-2.5 py-0.5 text-xs', mode === m.id ? 'bg-(--vscode-toolbar-activeBackground,#ffffff1f) font-medium text-(--vscode-foreground)' : `${MUTED} hover:text-(--vscode-foreground)`]}
							onclick={() => setMode(m.id as UsageMode)}>{m.label}</button
						>
					{/each}
				</div>
			</div>
			<div class={DIVIDER}></div>
			{#each rows as id (id)}
				{@const p = usage.providers[id]}
				{@const state = rowState(p)}
				{@const top = headline(p)}
				{@const reset = soonestReset(p)}
				<button
					class="flex w-full flex-col gap-1 px-3.5 py-2.5 text-left outline-none hover:bg-(--vscode-list-hoverBackground) focus-visible:bg-(--vscode-list-hoverBackground) aria-expanded:bg-(--vscode-list-hoverBackground)"
					data-usage-mode={mode}
					aria-haspopup={state.kind === 'sign-in' ? undefined : 'menu'}
					aria-expanded={state.kind === 'sign-in' ? undefined : sub?.provider === id}
					aria-label={state.kind === 'sign-in' ? `Sign in to ${PROVIDER_NAME[id]}` : 'Open usage details'}
					onclick={(e) => (state.kind === 'sign-in' ? go('account') : openSub(id, e.currentTarget))}
					onpointerenter={(e) => (state.kind === 'sign-in' ? (sub = null) : openSub(id, e.currentTarget))}
					onkeydown={(e) => e.key === 'ArrowRight' && state.kind !== 'sign-in' && openSub(id, e.currentTarget)}
				>
					<span class="flex w-full items-center gap-2.5">
						<span class="flex size-5 shrink-0 items-center justify-center rounded-md border border-(--vscode-widget-border) bg-(--vscode-editor-background)"><ProviderIcon provider={id} /></span>
						<span class="min-w-0 shrink truncate text-[13px] font-medium">{PROVIDER_NAME[id]}{#if p?.planType}<span class="font-normal {MUTED}">&nbsp;· {planName(p.planType)}</span>{/if}</span>
						{#if state.kind === 'usage' && top}
							{#if mode === 'compact'}
								<span class="ml-auto">{@render meter(windowWhen(top.window, usage.now), top.window, false)}</span>
							{:else if reset !== null}
								<span class="ml-auto shrink-0 text-[11px] {MUTED}">{resetsIn(reset - usage.now)}</span>
							{/if}
						{:else}
							<span class={['min-w-0 truncate text-[11px]', MUTED, state.kind !== 'sign-in' && 'ml-auto']}>{state.label}</span>
							{#if state.kind === 'sign-in'}<span class="ml-auto shrink-0 rounded-md border border-(--vscode-widget-border) bg-(--vscode-editor-background) px-2.5 py-0.5 text-xs">Sign in</span>{/if}
						{/if}
						{#if state.kind !== 'sign-in'}<span class={MUTED}><Icon name="chevronRight" size={13} /></span>{/if}
					</span>
					{#if state.kind === 'usage' && mode === 'detailed'}
						<span class="flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-[30px]">
							{#each windowsOf(p) as w (w.label)}{@render meter(windowLength(w.window.windowMinutes), w.window, true)}{/each}
						</span>
					{/if}
				</button>
			{/each}
			<div class={DIVIDER}></div>
			<button class={MENU_ROW} onpointerenter={() => (sub = null)} onclick={() => go('usage')}>Usage details & history<span class={MUTED}><Icon name="chevronRight" size={14} /></span></button>
			<button class={MENU_ROW} onpointerenter={() => (sub = null)} onclick={() => go('account')}>Manage Accounts…<span class={MUTED}><Icon name="chevronRight" size={14} /></span></button>
		</div>
	</StatusPopover>

	{#if sub}
		{@const p = usage.providers[sub.provider]}
		{@const id = sub.provider}
		<div
			role="menu"
			aria-label="{PROVIDER_NAME[id]} usage"
			tabindex="-1"
			class="fixed z-50 max-h-[calc(100vh-40px)] w-[300px] overflow-y-auto rounded-lg border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) text-xs text-(--vscode-foreground) shadow-xl shadow-black/40"
			style:left="{sub.left}px"
			style:top="{sub.top}px"
			onpointerdown={(e) => e.stopPropagation()}
			oncontextmenu={(e) => (e.preventDefault(), e.stopPropagation())}
		>
			<div class="p-2">
				{#if !p}
					<p class={MUTED}>No data available</p>
				{:else if p.status === 'unavailable'}
					<div class="flex items-center gap-1.5 font-medium"><ProviderIcon provider={id} />{PROVIDER_NAME[id]}</div>
					<p class="mt-1 {MUTED}">{p.error || 'Unavailable'}</p>
				{:else if p.status === 'error' && !windowsOf(p).length}
					<div class="flex items-center gap-1.5 font-medium"><ProviderIcon provider={id} />{PROVIDER_NAME[id]}</div>
					<div class="mt-2">
						<div class="text-[11px] font-medium opacity-85">{errorLabel(p)}</div>
						<div class={MUTED}>{errorMessage(p)}</div>
					</div>
				{:else}
					<div class="w-full space-y-3">
						<div>
							<div class="flex items-center gap-1.5 text-[13px] font-medium"><ProviderIcon provider={id} />{PROVIDER_NAME[id]}</div>
							<div class="opacity-80 {MUTED}">{windowsOf(p).length ? updatedLabel(p.updatedAt, usage.now) : 'Not yet updated'}</div>
						</div>
						<div class={DIVIDER}></div>
						{#each windowsOf(p) as w (w.label)}
							{@const used = clampPct(w.window.usedPercent)}
							<div class="space-y-1">
								<div class="font-medium">{w.label}</div>
								<div class="h-[6px] w-full overflow-hidden rounded-full bg-(--vscode-widget-border)">
									<div class={['h-full rounded-full transition-all duration-300', BAR[barTone(used)]]} style:width="{shownPct(w.window.usedPercent, display)}%"></div>
								</div>
								<div class="flex justify-between {MUTED}">
									<span>{percentLabel(w.window.usedPercent, display)}</span>
									{#if w.window.resetsAt !== null}<span>{resetsIn(w.window.resetsAt - usage.now)}</span>{/if}
								</div>
							</div>
						{/each}
						{#if p.status === 'error'}
							<div>
								<div class="text-[11px] font-medium opacity-85">{windowsOf(p).length ? 'Refresh failed — showing cached data' : 'Refresh failed'}</div>
								<div class={MUTED}>{p.error}</div>
							</div>
						{/if}
					</div>
				{/if}
			</div>
			<div class={DIVIDER}></div>
			<div class="p-1">
				<div class="px-2 py-1.5 text-[11px] font-medium {MUTED}">{PROVIDER_NAME[id]} Account</div>
				<button class="flex w-full items-center rounded px-2 py-1.5 text-left hover:bg-(--vscode-list-hoverBackground)" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
					<span class="max-w-[180px] truncate text-[12px]">System default</span>
					<span class="ml-auto opacity-85 {MUTED}"><Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} /></span>
				</button>
				{#if expanded}
					<div class="px-1 pb-1">
						{#if id === 'claude'}<div class="px-2 py-1 text-[10px] font-medium tracking-[0.08em] uppercase {MUTED}">Switch to</div>{/if}
						<div class="max-h-[220px] overflow-y-auto rounded-md border border-(--vscode-widget-border)/60 p-1">
							<div class="flex w-full items-center rounded px-2 py-1.5">
								<span class="truncate">System default</span>
								<span class="ml-auto text-[10px] font-medium {MUTED}">Active</span>
							</div>
						</div>
						{#if id === 'claude'}<p class="px-2 py-1.5 text-[10px] leading-4 {MUTED}">Switching applies to the next Claude you start in any tab. Running sessions keep their account.</p>{/if}
					</div>
				{/if}
				<div class="my-1 {DIVIDER}"></div>
				<button class="w-full rounded px-2 py-1.5 text-left hover:bg-(--vscode-list-hoverBackground)" onclick={() => go('account')}>Manage Accounts…</button>
			</div>
		</div>
	{/if}
{/if}
