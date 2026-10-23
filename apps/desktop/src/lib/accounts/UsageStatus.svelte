<script lang="ts">
	// Footer usage meter (Orca's): `[logo] 71% used 3d 6h` per provider agents use now, coloured from
	// 60% / 80%, plus a refresh button. Click: the Usage popover (rows per account, details,
	// Manage Accounts…). Shown in the IDE and the Agents layout alike.
	import Icon from '#lib/workbench/Icon.svelte';
	import AgentIcon from '#lib/agent/AgentIcon.svelte';
	import StatusPopover from '#lib/workbench/StatusPopover.svelte';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { accounts } from './accounts.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { chipText, footerRows, headline, level, pct, PROVIDER_TITLE, resetLabel, rowLevel, updatedAgo, windows, windowTitle, type Level, type Provider, type UsageRow } from './usage';

	const visible = $derived(settings.get<boolean>('kingu.statusBar.usage.visible') !== false);
	const mode = $derived(settings.get<string>('kingu.statusBar.usage.mode') === 'detailed' ? 'detailed' : 'compact');
	const display = $derived(settings.get<string>('kingu.statusBar.usage.display') === 'remaining' ? 'remaining' : 'used');
	const shown = $derived(footerRows(accounts.rows));
	const listed = $derived(accounts.rows.filter((r) => r.status !== 'unavailable').sort((a, b) => Number(b.active) - Number(a.active)));

	$effect(() => {
		if (visible) return accounts.start();
	});

	let open = $state(false);
	let anchor = $state<HTMLElement | null>(null);
	let expanded = $state<string | null>(null);

	const TONE: Record<Level, string> = { normal: '', warning: 'text-(--vscode-editorWarning-foreground)', urgent: 'text-(--vscode-errorForeground)' };
	const BAR: Record<Level, string> = {
		normal: 'bg-(--vscode-progressBar-background)',
		warning: 'bg-(--vscode-editorWarning-foreground)',
		urgent: 'bg-(--vscode-errorForeground)'
	};

	function tooltip(r: UsageRow): string {
		const email = r.email ? ` (${r.email})` : '';
		const who = r.account_id ? `${r.label}${email}` : t('legacySettings.usageStatus.yourAccount', { email });
		const lines = [`${PROVIDER_TITLE[r.provider]}: ${who}`];
		for (const w of windows(r.usage)) lines.push(t('legacySettings.usageStatus.windowReset', { name: windowTitle(w.name), pct: pct(w.window.used_percent), reset: resetLabel(w.window, accounts.now) }));
		if (r.error) lines.push(r.error);
		lines.push(updatedAgo(r.updated_at, accounts.now));
		return lines.join('\n');
	}

	function toggle(e: MouseEvent) {
		anchor = e.currentTarget as HTMLElement;
		open = !open;
		if (open) void accounts.refresh();
	}
	const close = () => (open = false);
	const setMode = (m: 'compact' | 'detailed') => settings.set('kingu.statusBar.usage.mode', m === 'compact' ? undefined : m, 'user');

	const ITEM = 'flex h-full items-center gap-1.5 px-2 tabular-nums hover:bg-(--vscode-toolbar-hoverBackground) aria-expanded:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-50';
	const HEAD = 'flex h-9 shrink-0 items-center gap-2 border-b border-(--vscode-widget-border) px-3';
	const ROW_BTN = 'grid size-6 shrink-0 place-items-center rounded-md text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:opacity-40';
	const LINK = 'flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-(--vscode-list-hoverBackground)';
</script>

{#if visible}
	{#if shown.length}
		<button class={ITEM} aria-haspopup="dialog" aria-expanded={open} aria-label="Usage" title={shown.map(tooltip).join('\n\n')} onclick={toggle}>
			{#each shown as r (r.key)}
				<span class={['flex items-center gap-1', TONE[rowLevel(r)]]}>
					<AgentIcon agent={r.provider} size={13} />{chipText(r, accounts.now, mode, display)}
					{#if r.status === 'stale' || r.status === 'error'}<span class="text-(--vscode-editorWarning-foreground)"><Icon name="warning" size={12} /></span>{/if}
				</span>
			{/each}
		</button>
		<button class="{ITEM} px-1" aria-label={t('legacySettings.usageStatus.refreshUsage')} title={t('legacySettings.usageStatus.refreshUsage')} disabled={accounts.refreshing} onclick={() => accounts.refresh(true)}>
			<span class={accounts.refreshing ? 'animate-spin' : ''}><Icon name="refresh" size={13} /></span>
		</button>
	{:else if accounts.rows.length}
		<!-- Rows came back, none signed in: a way in (Orca's empty-state CTA). -->
		<button class={ITEM} title={t('legacySettings.usageStatus.signInHint')} onclick={() => accounts.manage()}>
			<Icon name="signIn" size={14} />{t('legacySettings.usageStatus.aiAccounts')}
		</button>
	{/if}
{/if}

{#if open && anchor}
	<StatusPopover {anchor} label="Usage" width={360} align="left" onClose={close}>
		<div class={HEAD}>
			<span class="font-medium">Usage</span>
			<span class="text-xs text-(--vscode-descriptionForeground)">all agents</span>
			<span class="flex-1"></span>
			<button class={ROW_BTN} aria-label={t('legacySettings.usageStatus.refresh')} title={t('legacySettings.usageStatus.refresh')} disabled={accounts.refreshing} onclick={() => accounts.refresh(true)}>
				<span class={accounts.refreshing ? 'animate-spin' : ''}><Icon name="refresh" size={14} /></span>
			</button>
		</div>
		<div class="flex gap-1 border-b border-(--vscode-widget-border) px-3 py-2" role="radiogroup" aria-label={t('legacySettings.usageStatus.showInStatusBar')}>
			{#each [['detailed', 'Detailed'], ['compact', 'Compact']] as [id, label] (id)}
				<button
					role="radio"
					aria-checked={mode === id}
					class={['h-6 flex-1 rounded-md text-xs', mode === id ? 'bg-(--vscode-list-inactiveSelectionBackground) font-medium' : 'text-(--vscode-descriptionForeground) hover:bg-(--vscode-list-hoverBackground)']}
					onclick={() => setMode(id as 'compact' | 'detailed')}>{label}</button
				>
			{/each}
		</div>
		<div class="min-h-0 flex-1 overflow-y-auto py-1">
			{#each listed as r (r.key)}
				{@const h = headline(r.usage)}
				<button class="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-(--vscode-list-hoverBackground)" aria-expanded={expanded === r.key} onclick={() => (expanded = expanded === r.key ? null : r.key)}>
					<AgentIcon agent={r.provider} size={14} />
					<span class="min-w-0 flex-1 truncate">
						{PROVIDER_TITLE[r.provider]}
						{#if r.account_id}<span class="text-(--vscode-descriptionForeground)"> · {r.label}</span>{/if}
						{#if r.active}<span class="ml-1 text-[11px] text-(--vscode-descriptionForeground)">{t('legacySettings.usageStatus.inUse')}</span>{/if}
					</span>
					{#if h}
						<span class="text-xs text-(--vscode-descriptionForeground) tabular-nums">{resetLabel(h.window, accounts.now)}</span>
						<span class={['w-10 text-right tabular-nums', TONE[level(h.window.used_percent)]]}>{pct(h.window.used_percent)}%</span>
					{:else}
						<span class="text-xs text-(--vscode-descriptionForeground)">{r.status === 'api_key' ? 'API key' : r.status === 'idle' ? '···' : '—'}</span>
					{/if}
					<Icon name={expanded === r.key ? 'chevronDown' : 'chevronRight'} size={12} />
				</button>
				{#if expanded === r.key}
					<div class="space-y-1.5 px-3 pt-1 pb-2.5 pl-9 text-xs">
						{#each windows(r.usage) as w (w.name)}
							{@const l = level(w.window.used_percent)}
							<div class="flex items-center gap-2">
								<span class="w-24 shrink-0 text-(--vscode-descriptionForeground)">{windowTitle(w.name)}</span>
								<span class="h-1.5 flex-1 overflow-hidden rounded-full bg-(--vscode-widget-border)">
									<span class={['block h-full rounded-full', BAR[l]]} style:width="{pct(w.window.used_percent)}%"></span>
								</span>
								<span class={['w-9 text-right tabular-nums', TONE[l]]}>{pct(w.window.used_percent)}%</span>
								<span class="w-14 text-right text-(--vscode-descriptionForeground) tabular-nums">{resetLabel(w.window, accounts.now)}</span>
							</div>
						{/each}
						<div class="text-(--vscode-descriptionForeground)">
							{r.email ?? (r.account_id ? r.label : t('legacySettings.usageStatus.yourAccount', { email: '' }))}{#if r.usage?.plan}{t('legacySettings.usageStatus.plan', { plan: r.usage.plan })}{/if} · {updatedAgo(r.updated_at, accounts.now)}
						</div>
						{#if r.error}<div class="text-(--vscode-editorWarning-foreground)">{r.error}</div>{/if}
					</div>
				{/if}
			{:else}
				<p class="px-3 py-2 text-xs text-(--vscode-descriptionForeground)">{t('legacySettings.usageStatus.noAccounts')}</p>
			{/each}
		</div>
		<div class="border-t border-(--vscode-widget-border) py-1">
			<button class={LINK} onclick={() => (close(), accounts.manage())}><Icon name="clock" size={14} />Usage details & history</button>
			<button class={LINK} onclick={() => (close(), accounts.manage())}><Icon name="account" size={14} />Manage Accounts…</button>
		</div>
	</StatusPopover>
{/if}
