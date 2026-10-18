<script lang="ts">
	// Settings › Stats & Usage (Orca's "Usage details & history"): each agent provider's limit
	// windows in full, how the status bar shows them, and what Kingu's agents spent in this folder
	// by day and by task.
	import Icon from '#lib/workbench/Icon.svelte';
	import ProviderIcon from '#lib/workbench/ProviderIcon.svelte';
	import { usage } from '#lib/workbench/usage.svelte.ts';
	import { barTone, clampPct, errorMessage, percentLabel, PROVIDER_NAME, resetsIn, rowState, shownPct, updatedLabel, windowsOf, type UsageDisplay } from '#lib/workbench/usage.ts';
	import { timeAgo } from '#lib/ade/model.ts';
	import { runWorktreeAction } from '#lib/ade/worktreeMenu.svelte.ts';
	import { settings } from '../settings.svelte';
	import { systemSettings } from '../systemSettings.svelte';
	import SettingChoice from './SettingChoice.svelte';

	const display = $derived((settings.get<string>('kingu.usage.display') ?? 'used') as UsageDisplay);
	const spend = $derived(usage.spend);
	const peak = $derived(Math.max(...spend.days.map((d) => d.cost), 0.01));
	const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
	const day = (ms: number) => new Date(ms).toLocaleDateString('th-TH', { weekday: 'short' });
	const BAR: Record<string, string> = { neutral: 'bg-(--vscode-descriptionForeground)/40', warning: 'bg-yellow-500', critical: 'bg-red-500' };
	function openTask(slug: string) {
		systemSettings.close();
		runWorktreeAction(slug, 'open');
	}

	const SECTION = 'mt-7 mb-2 text-xs font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase';
	const CARD = 'rounded-xl border border-(--vscode-widget-border)';
	const MUTED = 'text-(--vscode-descriptionForeground)';
</script>

<div class="h-full overflow-y-auto">
	<div class="mx-auto max-w-[880px] px-8 py-6">
		<div class="flex items-center gap-2">
			<h1 class="flex flex-1 items-center gap-2 text-lg font-semibold"><Icon name="usage" size={20} />Stats & Usage</h1>
			<button class="flex h-8 items-center gap-1.5 rounded-md border border-(--vscode-widget-border) px-3 text-[13px] hover:bg-(--vscode-list-hoverBackground) disabled:opacity-50" disabled={usage.refreshing} onclick={() => usage.refresh()}>
				<span class={['grid place-items-center', usage.refreshing && 'animate-spin']}><Icon name="refresh" size={14} /></span>Refresh
			</button>
		</div>
		<p class="mt-1 text-[13px] {MUTED}">โควตาของ agent แต่ละเจ้า (ดึงด้วยบัญชีที่ CLI ของเจ้านั้นลงชื่อเข้าใช้ไว้) และค่าใช้จ่ายของ agent ในโฟลเดอร์นี้</p>

		<h2 class={SECTION}>Usage limits</h2>
		<div class="space-y-2">
			{#each usage.active as id (id)}
				{@const p = usage.providers[id]}
				{@const state = rowState(p)}
				<div class="{CARD} px-4 py-3.5">
					<div class="flex items-center gap-2 text-[13px] font-medium">
						<ProviderIcon provider={id} size={15} />{PROVIDER_NAME[id]}
						<span class="ml-auto text-xs font-normal {MUTED}">{state.kind === 'usage' && p ? updatedLabel(p.updatedAt, usage.now) : state.label}</span>
					</div>
					{#if state.kind === 'usage' && p}
						<div class="mt-3 space-y-3">
							{#each windowsOf(p) as w (w.label)}
								<div>
									<div class="flex items-baseline justify-between text-[13px]"><span>{w.label}</span><span class="tabular-nums">{percentLabel(w.window.usedPercent, display)}</span></div>
									<div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-(--vscode-widget-border)">
										<div class={['h-full rounded-full', BAR[barTone(clampPct(w.window.usedPercent))]]} style:width="{shownPct(w.window.usedPercent, display)}%"></div>
									</div>
									{#if w.window.resetsAt !== null}
										<div class="mt-1 text-xs {MUTED}">{resetsIn(w.window.resetsAt - usage.now)} · {new Date(w.window.resetsAt).toLocaleString('th-TH', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</div>
									{/if}
								</div>
							{/each}
							{#if p.status === 'error'}<p class="text-xs {MUTED}">Refresh failed — showing cached data · {p.error}</p>{/if}
						</div>
					{:else if p && (state.kind === 'error' || state.kind === 'unavailable' || state.kind === 'sign-in')}
						<p class="mt-1.5 text-xs {MUTED}">{state.kind === 'unavailable' ? p.error : errorMessage(p)}</p>
					{/if}
				</div>
			{:else}
				<p class="text-[13px] {MUTED}">ไม่พบ Claude Code หรือ Codex CLI ในเครื่องนี้</p>
			{/each}
		</div>

		<h2 class={SECTION}>Usage percentages</h2>
		<SettingChoice id="kingu.usage.display" labels={{ used: 'Used', remaining: 'Remaining' }} />
		<h2 class={SECTION}>Usage footer detail</h2>
		<SettingChoice id="kingu.usage.mode" labels={{ detailed: 'Detailed', compact: 'Compact' }} />

		<h2 class={SECTION}>ค่าใช้จ่ายของ agent ในโฟลเดอร์นี้</h2>
		<div class="grid grid-cols-3 gap-2">
			{#each [{ label: 'วันนี้', value: `$${spend.today.toFixed(2)}` }, { label: '7 วันล่าสุด', value: `$${spend.week.toFixed(2)}` }, { label: 'tokens (ทุกงาน)', value: compact(spend.tokens) }] as stat (stat.label)}
				<div class="{CARD} px-4 py-3">
					<div class="text-xs {MUTED}">{stat.label}</div>
					<div class="mt-0.5 text-lg font-semibold tabular-nums">{stat.value}</div>
				</div>
			{/each}
		</div>
		<div class="{CARD} mt-2 px-4 pt-4 pb-2">
			<div class="flex h-24 items-end gap-2" role="img" aria-label="ค่าใช้จ่าย 7 วันล่าสุด">
				{#each spend.days as d (d.start)}
					<div class="flex h-full flex-1 flex-col items-center justify-end gap-1" title="{day(d.start)} · ${d.cost.toFixed(2)} · {d.runs} งาน">
						<div class="w-full max-w-10 rounded-t-md bg-(--vscode-textLink-foreground) opacity-80" style:height="{d.cost ? Math.max(4, (d.cost / peak) * 100) : 2}%"></div>
					</div>
				{/each}
			</div>
			<div class="mt-1 flex gap-2 text-center text-[11px] {MUTED}">
				{#each spend.days as d, i (d.start)}<span class="flex-1">{i === 6 ? 'วันนี้' : day(d.start)}</span>{/each}
			</div>
		</div>

		<h2 class={SECTION}>ประวัติตามงาน</h2>
		<div class="{CARD} overflow-hidden">
			{#each spend.rows as r (r.slug)}
				<button class="flex w-full items-center gap-3 border-b border-(--vscode-widget-border) px-4 py-2.5 text-left last:border-b-0 hover:bg-(--vscode-list-hoverBackground)" onclick={() => openTask(r.slug)}>
					<span class="min-w-0 flex-1">
						<span class="block truncate text-[13px]">{r.title}</span>
						<span class="block truncate text-xs {MUTED}">kingu/{r.slug} · {timeAgo(r.run.at, usage.now)}{r.run.num_turns ? ` · ${r.run.num_turns} turns` : ''}</span>
					</span>
					<span class="shrink-0 text-xs tabular-nums {MUTED}">{compact((r.run.input_tokens ?? 0) + (r.run.output_tokens ?? 0))} tokens</span>
					<span class="w-16 shrink-0 text-right text-[13px] tabular-nums">{r.run.cost_usd === null ? '—' : `$${r.run.cost_usd.toFixed(2)}`}</span>
				</button>
			{:else}
				<p class="px-4 py-3 text-[13px] {MUTED}">ยังไม่มีงานที่ agent ทำเสร็จในโฟลเดอร์นี้</p>
			{/each}
		</div>
		<p class="mt-2 text-xs {MUTED}">นับจากรอบล่าสุดของแต่ละงาน (ค่าใช้จ่ายสะสมของ session นั้น) รอบที่เก่ากว่าไม่ได้เก็บไว้ ตัวเลขจริงจึงอาจสูงกว่านี้</p>
	</div>
</div>
