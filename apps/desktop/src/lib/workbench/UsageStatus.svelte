<script lang="ts">
	// The usage item of the status bar and its popup, modelled on Orca's UsageRosterPanel: Claude's
	// session and weekly limits (Detailed: every window with a bar; Compact: the most used one),
	// Kingu's own spend, then Usage details & history and Manage Accounts.
	import Icon from './Icon.svelte';
	import StatusPopover from './StatusPopover.svelte';
	import { usage } from './usage.svelte';
	import { headline, LIMIT_LABEL, percentLabel, resetIn, severity, type LimitWindow, type Severity, type UsageDisplay, type UsageMode } from './usage';
	import { timeAgo } from '#lib/ade/model.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';

	let open = $state(false);
	let anchor = $state<HTMLElement | null>(null);

	const visible = $derived(settings.get<boolean>('kingu.statusBar.usage.visible') !== false);
	const display = $derived((settings.get<string>('kingu.usage.display') ?? 'used') as UsageDisplay);
	const mode = $derived((settings.get<string>('kingu.usage.mode') ?? 'compact') as UsageMode);
	const top = $derived(headline(usage.windows));
	const spend = $derived(usage.spend);

	$effect(() => usage.start());

	const TONE: Record<Severity, string> = {
		ok: '',
		warn: 'text-(--vscode-editorWarning-foreground)',
		critical: 'text-(--vscode-errorForeground)'
	};
	const BAR: Record<Severity, string> = {
		ok: 'bg-(--vscode-textLink-foreground)',
		warn: 'bg-(--vscode-editorWarning-foreground)',
		critical: 'bg-(--vscode-errorForeground)'
	};
	const setMode = (m: UsageMode) => void settings.set('kingu.usage.mode', m === 'compact' ? undefined : m, 'user');
	const fill = (w: LimitWindow) => (display === 'used' ? w.utilization : 100 - w.utilization);
	function go(page: 'usage' | 'account') {
		open = false;
		systemSettings.showPage(page);
	}

	const ITEM = 'flex h-full items-center gap-1 px-2 tabular-nums hover:bg-(--vscode-toolbar-hoverBackground) aria-expanded:bg-(--vscode-toolbar-hoverBackground)';
	const ROW = 'flex w-full items-center justify-between px-3.5 py-2.5 text-left text-[13px] hover:bg-(--vscode-list-hoverBackground)';
	const DIVIDER = 'border-t border-(--vscode-widget-border)';
</script>

{#if visible}
	<button
		class={ITEM}
		aria-haspopup="dialog"
		aria-expanded={open}
		title={top ? `Claude ${LIMIT_LABEL[top.id]}: ${percentLabel(top.utilization, display)}${top.resetsAt ? ` · รีเซ็ตในอีก ${resetIn(top.resetsAt, usage.now)}` : ''}` : 'Usage — ยังไม่มีข้อมูลโควตา'}
		onclick={(e) => ((anchor = e.currentTarget), (open = !open))}
	>
		<Icon name="usage" size={14} />
		{#if top}
			<span class={TONE[severity(top)]}>{percentLabel(top.utilization, display)}</span>
			{#if top.resetsAt}<span class="opacity-70">{resetIn(top.resetsAt, usage.now)}</span>{/if}
		{/if}
	</button>
{/if}

{#if open && anchor}
	<StatusPopover {anchor} label="Usage" width={360} align="left" onClose={() => (open = false)}>
		<div class="flex items-center justify-between px-3.5 pt-3 pb-2">
			<span class="font-semibold">Usage</span>
			<span class="text-[11px] text-(--vscode-descriptionForeground)" title="Claude ส่งข้อมูลโควตามาระหว่างที่ agent ทำงาน">
				{usage.updatedAt ? `อัปเดต${timeAgo(usage.updatedAt, usage.now).replace(/^(\d)/, ' $1')}` : 'all agents'}
			</span>
		</div>
		<div class="px-3.5 pb-2.5">
			<div class="grid grid-cols-2 gap-0.5 rounded-lg border border-(--vscode-widget-border) p-0.5" role="radiogroup" aria-label="รูปแบบ">
				{#each [{ id: 'detailed', label: 'Detailed', tip: 'แถบ ป้ายชื่อ และเปอร์เซ็นต์ของทุกช่วงเวลา' }, { id: 'compact', label: 'Compact', tip: 'สรุปบรรทัดเดียวต่อผู้ให้บริการ' }] as m (m.id)}
					<button
						role="radio"
						aria-checked={mode === m.id}
						title={m.tip}
						class={['h-7 rounded-md text-[13px] transition-colors', mode === m.id ? 'bg-(--vscode-toolbar-activeBackground,#ffffff1f) font-medium text-(--vscode-foreground)' : 'text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)']}
						onclick={() => setMode(m.id as UsageMode)}>{m.label}</button
					>
				{/each}
			</div>
		</div>
		<div class={DIVIDER}></div>
		<button class="flex w-full flex-col gap-1.5 px-3.5 py-2.5 text-left hover:bg-(--vscode-list-hoverBackground)" onclick={() => go('usage')}>
			<span class="flex w-full items-center gap-2.5">
				<span class="grid size-6 shrink-0 place-items-center rounded-md border border-(--vscode-widget-border) bg-(--vscode-editor-background)"><Icon name="agent" size={15} /></span>
				<span class="min-w-0 shrink truncate text-[13px] font-medium">Claude<span class="font-normal text-(--vscode-descriptionForeground)">&nbsp;· Arkai</span></span>
				<span class="ml-auto flex shrink-0 items-center gap-2 text-xs">
					{#if !top}
						<span class="text-(--vscode-descriptionForeground)">ยังไม่มีข้อมูล</span>
					{:else if mode === 'compact'}
						{#if top.resetsAt}<span class="text-(--vscode-descriptionForeground)">{resetIn(top.resetsAt, usage.now)}</span>{/if}
						<span class={['font-medium tabular-nums', TONE[severity(top)]]}>{Math.round(fill(top))}%</span>
					{/if}
					<Icon name="chevronRight" size={13} />
				</span>
			</span>
			{#if top && mode === 'detailed'}
				<span class="flex flex-col gap-2 pt-0.5 pl-[34px]">
					{#each usage.windows as w (w.id)}
						<span class="flex flex-col gap-1">
							<span class="flex justify-between text-[11px] text-(--vscode-descriptionForeground)">
								<span>{LIMIT_LABEL[w.id]}</span>
								<span class="tabular-nums"><span class={TONE[severity(w)]}>{percentLabel(w.utilization, display)}</span>{w.resetsAt ? ` · ${resetIn(w.resetsAt, usage.now)}` : ''}</span>
							</span>
							<span class="h-1 overflow-hidden rounded-full bg-(--vscode-widget-border)"><span class={['block h-full rounded-full', BAR[severity(w)]]} style:width="{fill(w)}%"></span></span>
						</span>
					{/each}
				</span>
			{:else if !top}
				<span class="pl-[34px] text-[11px] leading-snug text-(--vscode-descriptionForeground)">Claude จะส่งโควตา session และรายสัปดาห์มาเมื่อ Arkai เริ่มทำงานครั้งถัดไป</span>
			{/if}
		</button>
		<div class={DIVIDER}></div>
		<div class="flex items-center gap-4 px-3.5 py-2 text-xs text-(--vscode-descriptionForeground)" title="จากรอบล่าสุดของแต่ละงานในโฟลเดอร์นี้">
			<span>Kingu วันนี้ <span class="text-(--vscode-foreground) tabular-nums">${spend.today.toFixed(2)}</span></span>
			<span>7 วัน <span class="text-(--vscode-foreground) tabular-nums">${spend.week.toFixed(2)}</span></span>
		</div>
		<div class={DIVIDER}></div>
		<button class={ROW} onclick={() => go('usage')}>Usage details & history<Icon name="chevronRight" size={14} /></button>
		<button class={ROW} onclick={() => go('account')}>Manage Accounts…<Icon name="chevronRight" size={14} /></button>
	</StatusPopover>
{/if}
