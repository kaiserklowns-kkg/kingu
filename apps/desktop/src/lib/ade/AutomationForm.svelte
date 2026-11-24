<script lang="ts">
	// Automation editor, laid out like VS Code 1.145's New Automation dialog (agents/run/automations.md;
	// src/vs/sessions/contrib/automations/browser/automationDialog.ts, automationCronInput.ts): Name,
	// Prompt, Trigger (Manual, Hourly, Daily, Weekdays, Weekly, Cron), the Cron editor's five fields
	// (a pasted expression fills them all) with the time zone and the schedule's description, and
	// Enabled, cleared by default. Kingu keeps its base branch, catch-up switch and the next runs
	// preview, and "Custom" for its own schedule text (schedule.ts). Automations always launch the
	// configured terminal agent; turning one on is confirmed (automations.svelte.ts).
	import { onMount, untrack } from 'svelte';
	import { keyLabel } from '#lib/workbench/keys.ts';
	import { t, locale } from '#lib/i18n/index.ts';
	import { automations } from './automations.svelte.ts';
	import { formatWhen } from './automations.ts';
	import { cronError, describeCron, localTimeZone, nextCronOccurrences, presetExpression, presetFields, splitCron, type TriggerKind } from './automationCron.ts';
	import { nextRuns, parseSchedule } from './schedule.ts';
	import { adeTasks } from './tasks.svelte.ts';
	import { BUTTON, BUTTON_SECONDARY, INPUT } from './ui.ts';

	let { id }: { id: string | null } = $props();

	type FormTrigger = TriggerKind | 'custom';
	const TRIGGERS: FormTrigger[] = ['manual', 'hourly', 'daily', 'weekdays', 'weekly', 'cron', 'custom'];
	const CRON_FIELDS = [
		{ key: 'minute', hint: 'cron.hint.minute' },
		{ key: 'hour', hint: 'cron.hint.hour' },
		{ key: 'dayOfMonth', hint: 'cron.hint.dayOfMonth' },
		{ key: 'month', hint: 'cron.hint.month' },
		{ key: 'dayOfWeek', hint: 'cron.hint.dayOfWeek' }
	] as const;

	// The page remounts the form per automation (`{#key}`), so the initial values are enough.
	const existing = untrack(() => (id ? automations.find(id) : undefined));
	const preset = existing?.trigger && existing.trigger !== 'cron' && existing.trigger !== 'manual' ? presetFields(existing.schedule) : null;
	const p2 = (n: number) => String(n).padStart(2, '0');
	let name = $state(existing?.name ?? '');
	let prompt = $state(existing?.prompt ?? '');
	let trigger = $state<FormTrigger>(existing ? (existing.trigger ?? 'custom') : 'manual');
	let time = $state(preset ? `${p2(preset.hour)}:${p2(preset.minute)}` : '09:00');
	let day = $state(preset?.day ?? 1);
	// VS Code's Hourly fires every hour from creation or update: the minute it was saved at.
	const hourlyMinute = preset && existing?.trigger === 'hourly' ? preset.minute : new Date().getMinutes();
	let cron = $state<string[]>(existing?.trigger === 'cron' ? (splitCron(existing.schedule) ?? ['', '', '', '', '']) : ['', '', '', '', '']);
	// New cron schedules use the local zone; an edited one keeps its saved zone.
	const timeZone = existing?.trigger ? (existing.time_zone ?? localTimeZone()) : localTimeZone();
	let custom = $state(existing && !existing.trigger ? existing.schedule : 'weekdays 09:00');
	let base = $state(existing?.base ?? '');
	let catchUp = $state(existing?.catch_up ?? true);
	let enabled = $state(existing ? automations.isActive(existing) : false);
	let busy = $state(false);
	let input: HTMLInputElement | undefined = $state();
	const mac = keyLabel('cmd+a').startsWith('⌘');

	const clock = $derived.by(() => {
		const m = /^(\d{1,2}):(\d{2})$/.exec(time);
		return m ? { hour: Math.min(23, Number(m[1])), minute: Math.min(59, Number(m[2])) } : { hour: 9, minute: 0 };
	});
	/** The five-field expression the trigger saves ('' while a Cron field is empty). */
	const expression = $derived(
		trigger === 'cron'
			? cron.every((f) => f.trim()) ? cron.map((f) => f.trim()).join(' ') : ''
			: trigger === 'hourly'
				? presetExpression('hourly', { hour: 0, minute: hourlyMinute, day: 0 })!
				: trigger === 'manual' || trigger === 'custom'
					? ''
					: presetExpression(trigger, { ...clock, day })!
	);
	const schedule = $derived(trigger === 'custom' ? custom : expression);
	const formInput = $derived({
		name,
		prompt,
		schedule,
		base: base || null,
		mode: 'terminal' as const,
		catch_up: catchUp,
		trigger: trigger === 'custom' ? null : trigger,
		time_zone: trigger === 'custom' || trigger === 'manual' ? null : timeZone,
		enabled
	});
	const error = $derived(automations.validate(formInput));
	const cronProblem = $derived(trigger === 'cron' ? cronError(expression, timeZone) : null);
	const description = $derived(trigger !== 'custom' && trigger !== 'manual' && expression && !cronProblem ? describeCron(expression) : null);
	const legacy = $derived(trigger === 'custom' ? parseSchedule(custom) : null);
	const preview = $derived(
		trigger === 'custom'
			? legacy?.ok
				? nextRuns(legacy.schedule, new Date(automations.now), 3).map((d) => d.getTime())
				: []
			: trigger === 'manual' || !description
				? []
				: nextCronOccurrences(expression, timeZone, automations.now, 3)
	);
	const weekdays = $derived.by(() => {
		const fmt = new Intl.DateTimeFormat(locale() === 'th' ? 'th-TH' : 'en-US', { weekday: 'long', timeZone: 'UTC' });
		return [0, 1, 2, 3, 4, 5, 6].map((d) => ({ d, label: fmt.format(new Date(Date.UTC(2024, 0, 7 + d))) }));
	});

	onMount(() => {
		void adeTasks.refreshBranches();
		input?.focus();
	});

	/** A whole expression pasted into one field fills all five (VS Code's cron input). */
	function onPaste(e: ClipboardEvent) {
		const fields = splitCron(e.clipboardData?.getData('text') ?? '');
		if (!fields) return;
		e.preventDefault();
		cron = fields;
	}

	async function submit(e?: Event) {
		e?.preventDefault();
		if (error || busy) return;
		busy = true;
		try {
			if (await automations.save(id, formInput)) automations.editing = null;
		} finally {
			busy = false;
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			automations.editing = null;
		} else if (e.key === 'Enter' && (mac ? e.metaKey : e.ctrlKey)) void submit(e);
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape / ⌘Enter from any field) -->
<form class="space-y-2 rounded border border-(--vscode-widget-border) p-3 text-xs" onsubmit={submit} onkeydown={onKey} aria-label={id ? t('legacyAde.automationForm.editTitle') : t('legacyAde.automationForm.newTitle')}>
	<input bind:this={input} class={INPUT} placeholder={t('legacyAde.automationForm.namePlaceholder')} aria-label={t('legacyAde.automationForm.nameLabel')} bind:value={name} disabled={busy} />
	<textarea class={[INPUT, 'h-24 resize-y']} placeholder={t('legacyAde.automationForm.promptPlaceholder')} aria-label={t('legacyAde.automationForm.promptLabel')} bind:value={prompt} disabled={busy}></textarea>

	<div class="flex flex-wrap items-center gap-2">
		<label class="flex items-center gap-1.5">
			<span class="text-(--vscode-descriptionForeground)">{t('cron.form.trigger')}</span>
			<select class={[INPUT, 'w-auto py-0.5']} bind:value={trigger} aria-label={t('cron.form.trigger')} disabled={busy}>
				{#each TRIGGERS as k (k)}<option value={k}>{t(`cron.trigger.${k}`)}</option>{/each}
			</select>
		</label>
		{#if trigger === 'daily' || trigger === 'weekdays' || trigger === 'weekly'}
			{#if trigger === 'weekly'}
				<label class="flex items-center gap-1.5">
					<span class="text-(--vscode-descriptionForeground)">{t('cron.form.day')}</span>
					<select class={[INPUT, 'w-auto py-0.5']} bind:value={day} aria-label={t('cron.form.day')} disabled={busy}>
						{#each weekdays as w (w.d)}<option value={w.d}>{w.label}</option>{/each}
					</select>
				</label>
			{/if}
			<label class="flex items-center gap-1.5">
				<span class="text-(--vscode-descriptionForeground)">{t('cron.form.time')}</span>
				<input type="time" class={[INPUT, 'w-auto py-0.5']} bind:value={time} aria-label={t('cron.form.time')} disabled={busy} />
			</label>
		{/if}
	</div>

	{#if trigger === 'cron'}
		<fieldset class="space-y-1">
			<legend class="flex w-full items-center gap-2">
				<span class="text-(--vscode-descriptionForeground)">{t('cron.form.expression')}</span>
				<span class="text-[11px] text-(--vscode-descriptionForeground)/80">{timeZone === localTimeZone() ? t('cron.form.localTime') : t('cron.form.inZone', { zone: timeZone })}</span>
			</legend>
			<div class="grid grid-cols-5 gap-1.5" role="group" aria-label={t('cron.form.expression')}>
				{#each CRON_FIELDS as f, i (f.key)}
					<label class="space-y-0.5" title={t(f.hint)}>
						<input class={[INPUT, 'text-center font-mono']} placeholder="*" aria-label={t(`cron.field.${f.key}`)} bind:value={cron[i]} onpaste={onPaste} disabled={busy} />
						<span class="block truncate text-center text-[10px] text-(--vscode-descriptionForeground)">{t(`cron.field.${f.key}`)}</span>
					</label>
				{/each}
			</div>
		</fieldset>
	{:else if trigger === 'custom'}
		<label class="block space-y-1">
			<span class="text-(--vscode-descriptionForeground)">{t('legacyAde.automationForm.scheduleLabel')}</span>
			<input class={[INPUT, 'font-mono']} placeholder="weekdays 09:00" aria-label={t('legacyAde.automationForm.scheduleAria')} aria-invalid={!legacy?.ok} bind:value={custom} disabled={busy} />
		</label>
	{/if}

	<p class="text-(--vscode-descriptionForeground)" aria-live="polite">
		{#if trigger === 'manual'}
			{t('cron.form.manualHint')}
		{:else if trigger === 'custom'}
			{#if legacy?.ok}{t('legacyAde.automationForm.nextRuns')} {preview.map((d) => formatWhen(d, automations.now)).join(' · ') || '—'}{:else}<span class="text-(--vscode-errorForeground)">{legacy?.error}</span>{/if}
		{:else if cronProblem}
			<span class="text-(--vscode-errorForeground)">{cronProblem}</span>
		{:else if description}
			<span data-testid="cron-description">{description}</span>
			<span class="block">{t('legacyAde.automationForm.nextRuns')} {preview.map((d) => formatWhen(d, automations.now)).join(' · ') || '—'}</span>
		{:else}
			{t('cron.form.incomplete')}
		{/if}
	</p>

	<div class="flex flex-wrap items-center gap-3">
		<label class="flex items-center gap-1.5">
			<span class="shrink-0 text-(--vscode-descriptionForeground)">{t('legacyAde.automationForm.branchFrom')}</span>
			<select class={[INPUT, 'w-auto py-0.5']} bind:value={base} aria-label="base branch" disabled={busy}>
				<option value="">{t('legacyAde.automationForm.currentBranch')}</option>
				{#each adeTasks.branches as b (b)}<option value={b}>{b}</option>{/each}
			</select>
		</label>
		<span class="text-(--vscode-descriptionForeground)">{t('legacyAde.automationForm.runsViaTerminal')}</span>
		{#if trigger !== 'manual'}
			<label class="flex items-center gap-1.5" title={t('legacyAde.automationForm.catchUpTitle')}>
				<input type="checkbox" bind:checked={catchUp} disabled={busy} />
				<span>{t('legacyAde.automationForm.catchUpLabel')}</span>
			</label>
			<label class="flex items-center gap-1.5" title={t('cron.form.enabledTitle')}>
				<input type="checkbox" bind:checked={enabled} disabled={busy} />
				<span>{t('cron.form.enabled')}</span>
			</label>
		{/if}
	</div>
	<div class="flex items-center gap-1.5">
		<button type="submit" class={BUTTON} disabled={!!error || busy} title={error ?? t('legacyAde.automationForm.saveWithShortcut', { shortcut: `${mac ? '⌘' : 'Ctrl+'}Enter` })}>{busy ? t('legacyAde.automationForm.saving') : id ? t('legacyAde.automationForm.save') : t('cron.form.create')}</button>
		<button type="button" class={BUTTON_SECONDARY} onclick={() => (automations.editing = null)}>{t('legacyAde.automationForm.cancel')}</button>
		{#if !id && !enabled}<span class="text-(--vscode-descriptionForeground)">{t('legacyAde.automationForm.createdDisabled')}</span>{/if}
	</div>
</form>
