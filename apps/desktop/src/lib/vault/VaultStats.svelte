<script lang="ts">
	// Settings › Stats & Usage: what every agent on this machine spent (old Kingu's usage overview),
	// summed from their own transcripts by Rust (vault_stats) and priced with a hand-kept table, so
	// costs are estimates and a model the table does not know shows as unpriced, never $0.
	import { invoke } from '@tauri-apps/api/core';
	import { locale, t } from '#lib/i18n/index.ts';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import { vault } from './vault.svelte';
	import { AGENT_NAME, compactTokens, formatUsd, freshTokens, projectName, summarizeStats, type Sum, type VaultStats } from './vault';

	const RANGES = [7, 30, 90, 0] as const;
	let range = $state<(typeof RANGES)[number]>(30);
	let stats = $state<VaultStats | null>(null);
	let loading = $state(false);
	let error = $state('');
	let seq = 0;

	async function load(days: number) {
		const n = ++seq;
		loading = true;
		try {
			const s = await invoke<VaultStats>('vault_stats', { tzOffsetMin: -new Date().getTimezoneOffset(), days: days || null });
			if (n !== seq) return;
			stats = s;
			error = '';
		} catch (e) {
			if (n === seq) error = String(e);
		} finally {
			if (n === seq) loading = false;
		}
	}
	$effect(() => void load(range));

	const summary = $derived(stats ? summarizeStats(stats, range || 30) : null);
	const peak = $derived(Math.max(0.01, ...(summary?.days.map((d) => d.sum.cost) ?? [])));
	const cost = (s: Sum) => `${formatUsd(s.cost)}${s.unpriced ? '+' : ''}`;
	const rangeLabel = (r: number) => (r ? t('vault.stats.lastDays', { count: r }) : t('vault.stats.allTime'));
	const dayLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(locale() === 'th' ? 'th-TH' : 'en-US', { month: 'short', day: 'numeric' });

	function openSession(path: string) {
		const s = vault.byPath(path);
		systemSettings.close();
		if (s) vault.open(s, true);
	}
	$effect(() => {
		if (!vault.loaded && !vault.loading) void vault.load();
	});

	const SECTION = 'mt-7 mb-2 text-xs font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase';
	const CARD = 'rounded-xl border border-(--vscode-widget-border)';
	const MUTED = 'text-(--vscode-descriptionForeground)';
	const ROW = 'flex items-center gap-3 border-b border-(--vscode-widget-border) px-4 py-2 text-[13px] last:border-b-0';
</script>

<h2 class={SECTION}>{t('vault.stats.title')}</h2>
<p class="-mt-1 mb-2 text-[13px] {MUTED}">{t('vault.stats.description')}</p>
<div class="mb-2 flex items-center gap-1" role="radiogroup" aria-label={t('vault.stats.range')}>
	{#each RANGES as r (r)}
		<button
			role="radio"
			aria-checked={range === r}
			class={['h-7 rounded-md border px-2.5 text-[12px]', range === r ? 'border-(--vscode-focusBorder) bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground)' : 'border-(--vscode-widget-border) hover:bg-(--vscode-list-hoverBackground)']}
			onclick={() => (range = r)}>{rangeLabel(r)}</button
		>
	{/each}
	{#if loading}<span class="ml-2 text-xs {MUTED}">{t('vault.stats.reading')}</span>{/if}
</div>

{#if error}
	<p role="alert" class="text-[13px] text-(--vscode-errorForeground)">{t('vault.stats.failed', { error })}</p>
{:else if summary && stats}
	<div class="grid grid-cols-3 gap-2">
		{#each [{ label: t('vault.stats.cost'), value: cost(summary.total) }, { label: t('vault.stats.fresh'), value: compactTokens(freshTokens(summary.total.tokens)) }, { label: t('vault.stats.cacheReads'), value: compactTokens(summary.total.tokens.cacheRead) }] as card (card.label)}
			<div class="{CARD} px-4 py-3">
				<div class="text-xs {MUTED}">{card.label}</div>
				<div class="mt-0.5 text-lg font-semibold tabular-nums">{card.value}</div>
			</div>
		{/each}
	</div>

	<div class="{CARD} mt-2 px-4 pt-4 pb-2">
		<div class="flex h-24 items-end gap-px" role="img" aria-label={t('vault.stats.chart')}>
			{#each summary.days as d (d.day)}
				<div class="flex h-full flex-1 flex-col justify-end" title="{dayLabel(d.day)} · {cost(d.sum)} · {compactTokens(freshTokens(d.sum.tokens))}">
					<div class="w-full rounded-t-sm bg-(--vscode-textLink-foreground) opacity-80" style:height="{d.sum.cost ? Math.max(3, (d.sum.cost / peak) * 100) : freshTokens(d.sum.tokens) ? 3 : 1}%"></div>
				</div>
			{/each}
		</div>
		<div class="mt-1 flex justify-between text-[11px] {MUTED}">
			<span>{dayLabel(summary.days[0].day)}</span><span>{dayLabel(summary.days[summary.days.length - 1].day)}</span>
		</div>
	</div>

	<h3 class="mt-4 mb-1.5 text-xs font-medium {MUTED}">{t('vault.stats.byAgent')}</h3>
	<div class="{CARD} overflow-hidden">
		{#each summary.byAgent as a (a.agent)}
			<div class={ROW}>
				<span class="min-w-0 flex-1 truncate">{AGENT_NAME[a.agent]}</span>
				<span class="shrink-0 text-xs tabular-nums {MUTED}">{t('vault.stats.tokens', { tokens: compactTokens(freshTokens(a.sum.tokens)) })}</span>
				<span class="w-20 shrink-0 text-right tabular-nums">{cost(a.sum)}</span>
			</div>
		{:else}
			<p class="px-4 py-3 text-[13px] {MUTED}">{t('vault.stats.none')}</p>
		{/each}
	</div>

	{#if summary.byModel.length}
		<h3 class="mt-4 mb-1.5 text-xs font-medium {MUTED}">{t('vault.stats.byModel')}</h3>
		<div class="{CARD} overflow-hidden">
			{#each summary.byModel.slice(0, 12) as m (m.agent + m.model)}
				<div class={ROW}>
					<span class="min-w-0 flex-1 truncate font-mono text-[12px]">{m.model || t('vault.stats.unknownModel')}</span>
					<span class="shrink-0 text-xs {MUTED}">{AGENT_NAME[m.agent]}</span>
					<span class="shrink-0 text-xs tabular-nums {MUTED}">{t('vault.stats.tokens', { tokens: compactTokens(freshTokens(m.sum.tokens)) })}</span>
					<span class="w-20 shrink-0 text-right tabular-nums">{m.sum.unpriced && !m.sum.cost ? t('vault.stats.unpriced') : cost(m.sum)}</span>
				</div>
			{/each}
		</div>
	{/if}

	{#if stats.top.length}
		<h3 class="mt-4 mb-1.5 text-xs font-medium {MUTED}">{t('vault.stats.top')}</h3>
		<div class="{CARD} overflow-hidden">
			{#each stats.top as s (s.path)}
				<button class="{ROW} w-full text-left hover:bg-(--vscode-list-hoverBackground)" onclick={() => openSession(s.path)}>
					<span class="min-w-0 flex-1">
						<span class="block truncate">{s.title}</span>
						<span class="block truncate text-xs {MUTED}">{[AGENT_NAME[s.agent], projectName(s.cwd)].filter(Boolean).join(' · ')}</span>
					</span>
					<span class="shrink-0 text-xs tabular-nums {MUTED}">{t('vault.stats.tokens', { tokens: compactTokens(freshTokens(s.tokens)) })}</span>
					<span class="w-20 shrink-0 text-right tabular-nums">{formatUsd(s.cost)}{s.partial ? '+' : ''}</span>
				</button>
			{/each}
		</div>
	{/if}

	<p class="mt-2 text-xs {MUTED}">
		{t('vault.stats.footnote', { sessions: stats.sessionsWithUsage, total: stats.sessionsTotal })}
		{#if stats.unpriced.length}{t('vault.stats.unpricedModels', { models: stats.unpriced.map((m) => m || t('vault.stats.unknownModel')).join(', ') })}{/if}
	</p>
{/if}
