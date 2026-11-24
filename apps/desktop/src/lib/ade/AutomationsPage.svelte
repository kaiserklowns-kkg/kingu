<script lang="ts">
	// Automations page (Agents layout center, from the side bar): each automation with its switch,
	// next and last run (a link to the task it created), Run now, Edit and Delete; the editor form
	// on top while open. As in VS Code 1.145, disabled automations sit in a collapsed "Disabled
	// automations" section below the active ones, and the schedule shows as its description.
	import Icon from '#lib/workbench/Icon.svelte';
	import AutomationForm from './AutomationForm.svelte';
	import { automations } from './automations.svelte.ts';
	import { formatWhen, scheduleLabel, zoneOf, type Automation } from './automations.ts';
	import { parseSchedule } from './schedule.ts';
	import { cronError } from './automationCron.ts';
	import { adeLayout } from './adeLayout.svelte.ts';
	import { adeTasks } from './tasks.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import { BUTTON, BUTTON_SECONDARY, ICON_BUTTON } from './ui.ts';

	function openTask(slug: string) {
		adeLayout.show(slug);
	}

	let showDisabled = $state(false);
	const activeList = $derived(automations.list.filter((a) => a.enabled));
	const disabledList = $derived(automations.list.filter((a) => !a.enabled));

	/** The schedule's problem, or null (Manual has none). */
	function problemOf(a: Automation): string | null {
		if (a.trigger === 'manual') return null;
		if (a.trigger) return cronError(a.schedule, zoneOf(a)) ?? (a.schedule.trim() ? null : '—');
		const p = parseSchedule(a.schedule);
		return p.ok ? null : p.error;
	}

	/** A declined confirm leaves the switch as it was. */
	async function toggle(id: string, box: HTMLInputElement) {
		await automations.setEnabled(id, box.checked);
		const a = automations.find(id);
		box.checked = !!a && automations.isActive(a);
	}
</script>

<div class="flex h-full flex-col overflow-hidden bg-(--vscode-editor-background) text-(--vscode-foreground)">
	<header class="flex shrink-0 items-center gap-2 border-b border-(--vscode-widget-border) px-4 py-2">
		<h1 class="text-sm font-semibold">Automations</h1>
		<span class="text-xs text-(--vscode-descriptionForeground)">{t('legacyAde.automationsPage.summary', { count: automations.list.length })}</span>
		<span class="flex-1"></span>
		{#if automations.globalEnabled}
			<button class={BUTTON_SECONDARY} disabled={!automations.activeCount} onclick={() => automations.pauseAll()}><Icon name="stop" size={13} /> {t('legacyAde.automationsPage.pauseAll')}</button>
		{/if}
		<button class={BUTTON} onclick={() => (automations.editing = { id: null })}><Icon name="plus" size={14} /> {t('legacyAde.automationsPage.new')}</button>
		<button class={ICON_BUTTON} aria-label={t('legacyAde.automationsPage.refresh')} title={t('legacyAde.automationsPage.refresh')} onclick={() => automations.load()}><Icon name="refresh" size={16} /></button>
	</header>

	<div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
		{#if !automations.featureEnabled}
			<div class="rounded border border-(--vscode-editorWarning-foreground) px-3 py-2 text-xs" role="status">{t('cron.page.featureOff')}</div>
		{/if}
		{#if !automations.globalEnabled}
			<div class="flex items-center gap-2 rounded border border-(--vscode-editorWarning-foreground) px-3 py-2 text-xs" role="status">
				<span class="flex-1">{t('legacyAde.automationsPage.allPaused')}</span>
				<button class={BUTTON_SECONDARY} onclick={() => automations.resumeAll()}>{t('legacyAde.automationsPage.reEnable')}</button>
			</div>
		{/if}

		{#if automations.editing}
			{#key automations.editing.id}<div class="max-w-2xl"><AutomationForm id={automations.editing.id} /></div>{/key}
		{/if}

		{#if !automations.loaded}
			<p class="text-xs text-(--vscode-descriptionForeground)">{t('legacyAde.automationsPage.loading')}</p>
		{:else if !automations.list.length && !automations.editing}
			<div class="max-w-md space-y-2 text-xs text-(--vscode-descriptionForeground)">
				<p>{t('legacyAde.automationsPage.emptyIntro')} <span class="font-mono">kingu/…</span></p>
				<button class="text-(--vscode-textLink-foreground) hover:underline" onclick={() => (automations.editing = { id: null })}>{t('legacyAde.automationsPage.createFirst')}</button>
			</div>
		{:else}
			<ul class="space-y-2" aria-label={t('legacyAde.automationsPage.listLabel')}>
				{#each activeList as a (a.id)}{@render card(a)}{/each}
			</ul>
			{#if disabledList.length}
				<section aria-label={t('cron.page.disabled')}>
					<button class="flex items-center gap-1 py-1 text-xs font-semibold" aria-expanded={showDisabled} onclick={() => (showDisabled = !showDisabled)}>
						<Icon name={showDisabled ? 'chevronDown' : 'chevronRight'} size={12} />
						{t('cron.page.disabled')}
						<span class="font-normal text-(--vscode-descriptionForeground)">{disabledList.length}</span>
					</button>
					{#if showDisabled}
						<ul class="space-y-2">
							{#each disabledList as a (a.id)}{@render card(a)}{/each}
						</ul>
					{/if}
				</section>
			{/if}
		{/if}
	</div>
</div>

{#snippet card(a: Automation)}
					{@const active = automations.isActive(a)}
					{@const needsConfirm = a.enabled && !automations.consented(a)}
					{@const next = automations.nextRun(a)}
					{@const problem = problemOf(a)}
					{@const lastTask = a.last_task_slug ? adeTasks.find(a.last_task_slug) : undefined}
					<li class="flex items-start gap-3 rounded border border-(--vscode-widget-border) px-3 py-2 text-xs">
						<label class="mt-0.5 flex shrink-0 items-center" title={active ? t('legacyAde.automationsPage.turnOff') : t('legacyAde.automationsPage.turnOn')}>
							<span class="sr-only">{t('legacyAde.automationsPage.enableName', { name: a.name })}</span>
							<input type="checkbox" role="switch" checked={active} disabled={!!problem || a.trigger === 'manual'} onchange={(e) => toggle(a.id, e.currentTarget)} />
						</label>
						<div class="min-w-0 flex-1 space-y-0.5">
							<div class="flex items-center gap-2">
								<span class="truncate text-[13px] font-medium" title={a.name}>{a.name}</span>
								<span class={['shrink-0 text-(--vscode-descriptionForeground)', !a.trigger && 'font-mono']} title={a.trigger && a.trigger !== 'manual' ? a.schedule : undefined}>{scheduleLabel(a)}</span>
							</div>
							<p class="truncate text-(--vscode-descriptionForeground)" title={a.prompt}>{a.prompt}</p>
							<p class="text-(--vscode-descriptionForeground)">
								{t('legacyAde.automationsPage.nextRun')} {active && automations.globalEnabled ? formatWhen(next, automations.now) : t('legacyAde.automationsPage.off')}
								{t('legacyAde.automationsPage.lastRun')}
								{#if a.last_run_at}
									{formatWhen(a.last_run_at, automations.now)}
									{#if a.last_task_slug}
										{#if lastTask}
											<button class="font-mono text-(--vscode-textLink-foreground) hover:underline" onclick={() => openTask(a.last_task_slug!)}>{adeTasks.branchOf(a.last_task_slug!)}</button>
										{:else}
											<span class="font-mono">kingu/{a.last_task_slug}</span> {t('legacyAde.automationsPage.deleted')}
										{/if}
									{/if}
								{:else}
									{t('legacyAde.automationsPage.neverRun')}
								{/if}
							</p>
							{#if problem}
								<p class="text-(--vscode-errorForeground)">{t('legacyAde.automationsPage.invalidSchedule', { error: problem })}</p>
							{:else if needsConfirm}
								<p class="text-(--vscode-editorWarning-foreground)">{t('legacyAde.automationsPage.needsConfirm')}</p>
							{/if}
							{#if a.last_skip}
								<p class="text-(--vscode-editorWarning-foreground)">{t('legacyAde.automationsPage.skipped', { at: formatWhen(a.last_skip.at, automations.now), reason: a.last_skip.reason })}</p>
							{/if}
						</div>
						<div class="flex shrink-0 items-center gap-1">
							<button class={BUTTON_SECONDARY} title={t('legacyAde.automationsPage.runNowTitle')} onclick={() => automations.runNow(a.id)}><Icon name="play" size={12} /> Run now</button>
							<button class={BUTTON_SECONDARY} onclick={() => (automations.editing = { id: a.id })}>Edit</button>
							<button class={ICON_BUTTON} aria-label={t('legacyAde.automationsPage.deleteName', { name: a.name })} title={t('legacyAde.automationsPage.delete')} onclick={() => automations.remove(a.id)}><Icon name="trash" size={14} /></button>
						</div>
					</li>
{/snippet}
