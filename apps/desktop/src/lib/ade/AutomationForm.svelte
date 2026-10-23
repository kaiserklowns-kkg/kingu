<script lang="ts">
	// Automation editor: name, prompt, schedule (with a live preview of the next 3 runs), base
	// branch. Automations always launch the configured terminal agent; a new automation is saved
	// off and enabling it is a separate, confirmed step.
	import { onMount, untrack } from 'svelte';
	import { keyLabel } from '#lib/workbench/keys.ts';
	import { t } from '#lib/i18n/index.ts';
	import { automations } from './automations.svelte.ts';
	import { formatWhen } from './automations.ts';
	import { nextRuns, parseSchedule } from './schedule.ts';
	import { adeTasks } from './tasks.svelte.ts';
	import { BUTTON, BUTTON_SECONDARY, INPUT } from './ui.ts';

	let { id }: { id: string | null } = $props();

	// The page remounts the form per automation (`{#key}`), so the initial values are enough.
	const existing = untrack(() => (id ? automations.find(id) : undefined));
	let name = $state(existing?.name ?? '');
	let prompt = $state(existing?.prompt ?? '');
	let schedule = $state(existing?.schedule ?? 'weekdays 09:00');
	let base = $state(existing?.base ?? '');
	let catchUp = $state(existing?.catch_up ?? true);
	let busy = $state(false);
	let input: HTMLInputElement | undefined = $state();
	const mac = keyLabel('cmd+a').startsWith('⌘');

	const parsed = $derived(parseSchedule(schedule));
	const preview = $derived(parsed.ok ? nextRuns(parsed.schedule, new Date(automations.now), 3) : []);
	const error = $derived(automations.validate({ name, prompt, schedule, base: base || null, mode: 'terminal', catch_up: catchUp }));

	onMount(() => {
		void adeTasks.refreshBranches();
		input?.focus();
	});

	async function submit(e?: Event) {
		e?.preventDefault();
		if (error || busy) return;
		busy = true;
		try {
			if (await automations.save(id, { name, prompt, schedule, base: base || null, mode: 'terminal', catch_up: catchUp })) automations.editing = null;
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
	<label class="block space-y-1">
		<span class="text-(--vscode-descriptionForeground)">{t('legacyAde.automationForm.scheduleLabel')}</span>
		<input class={[INPUT, 'font-mono']} placeholder="weekdays 09:00" aria-label={t('legacyAde.automationForm.scheduleAria')} aria-invalid={!parsed.ok} bind:value={schedule} disabled={busy} />
	</label>
	{#if parsed.ok}
		<p class="text-(--vscode-descriptionForeground)" aria-live="polite">{t('legacyAde.automationForm.nextRuns')} {preview.map((d) => formatWhen(d.getTime(), automations.now)).join(' · ') || '—'}</p>
	{:else}
		<p class="text-(--vscode-errorForeground)" aria-live="polite">{parsed.error}</p>
	{/if}
	<div class="flex flex-wrap items-center gap-3">
		<label class="flex items-center gap-1.5">
			<span class="shrink-0 text-(--vscode-descriptionForeground)">{t('legacyAde.automationForm.branchFrom')}</span>
			<select class={[INPUT, 'w-auto py-0.5']} bind:value={base} aria-label="base branch" disabled={busy}>
				<option value="">{t('legacyAde.automationForm.currentBranch')}</option>
				{#each adeTasks.branches as b (b)}<option value={b}>{b}</option>{/each}
			</select>
		</label>
		<span class="text-(--vscode-descriptionForeground)">{t('legacyAde.automationForm.runsViaTerminal')}</span>
		<label class="flex items-center gap-1.5" title={t('legacyAde.automationForm.catchUpTitle')}>
			<input type="checkbox" bind:checked={catchUp} disabled={busy} />
			<span>{t('legacyAde.automationForm.catchUpLabel')}</span>
		</label>
	</div>
	<div class="flex items-center gap-1.5">
		<button type="submit" class={BUTTON} disabled={!!error || busy} title={error ?? t('legacyAde.automationForm.saveWithShortcut', { shortcut: `${mac ? '⌘' : 'Ctrl+'}Enter` })}>{busy ? t('legacyAde.automationForm.saving') : t('legacyAde.automationForm.save')}</button>
		<button type="button" class={BUTTON_SECONDARY} onclick={() => (automations.editing = null)}>{t('legacyAde.automationForm.cancel')}</button>
		{#if !id}<span class="text-(--vscode-descriptionForeground)">{t('legacyAde.automationForm.createdDisabled')}</span>{/if}
	</div>
</form>
