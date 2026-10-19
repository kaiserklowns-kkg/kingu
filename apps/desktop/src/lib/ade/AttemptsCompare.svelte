<script lang="ts">
	// Compare Attempts (Cursor's best-of-N review): the attempts of one prompt side by side, each with
	// its model, status, diff stats against the base, the files it changed (a click opens the diff)
	// and what its run cost. Pick winner keeps that attempt and offers the others to Clean Up Tasks.
	import { onMount, untrack } from 'svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import AdeDialog from './AdeDialog.svelte';
	import { adeTasks } from './tasks.svelte.ts';
	import { attempts } from './attempts.svelte.ts';
	import { compareColumns } from './attempts.ts';
	import { statusLabel } from './model.ts';
	import { BUTTON, BUTTON_SECONDARY, LETTER_COLOR, STATUS_DOT } from './ui.ts';

	let { group, onClose }: { group: string; onClose: () => void } = $props();

	const MAX_FILES = 12;
	const columns = $derived(compareColumns(adeTasks.views, group));
	let busy = $state(false);

	// Fresh diff stats once when the view opens: an agent may have worked since the last read.
	onMount(() => {
		for (const c of untrack(() => compareColumns(adeTasks.views, group))) void adeTasks.refreshStat(c.slug);
	});

	async function pick(slug: string) {
		busy = true;
		try {
			await attempts.pickWinner(slug);
		} finally {
			busy = false;
		}
	}

	function open(slug: string) {
		onClose();
		adeTasks.openTask(slug);
	}

	function diff(slug: string, path: string) {
		onClose();
		void adeTasks.openDiff(slug, path);
	}
</script>

<AdeDialog title={t('adeAttempts.compare.title', { count: columns.length })} width={Math.min(1200, 300 * Math.max(columns.length, 2) + 40)} {busy} {onClose}>
	{#if !columns.length}
		<p class="text-(--vscode-descriptionForeground)">{t('adeAttempts.compare.empty')}</p>
	{:else}
		<div class="grid gap-3" style:grid-template-columns="repeat({columns.length}, minmax(0, 1fr))">
			{#each columns as c (c.slug)}
				{@const view = adeTasks.find(c.slug)}
				<section class="flex min-w-0 flex-col rounded-lg border border-(--vscode-widget-border) p-2.5 text-xs" aria-label={t('adeAttempts.attempt', { letter: c.letter })}>
					<header class="flex items-center gap-1.5">
						<span class="grid size-5 shrink-0 place-items-center rounded bg-(--vscode-badge-background) text-[11px] font-semibold text-(--vscode-badge-foreground)">{c.letter}</span>
						<span class="min-w-0 flex-1 truncate font-mono" title={c.model ?? t('adeAttempts.defaultModel')}>{c.model ?? t('adeAttempts.defaultModel')}</span>
						{#if view}<span class={['size-2 shrink-0 rounded-full', STATUS_DOT[c.status]]} title={statusLabel(view)}></span>{/if}
					</header>
					<div class="mt-1 truncate font-mono text-[11px] text-(--vscode-descriptionForeground)" title={adeTasks.branchOf(c.slug)}>{adeTasks.branchOf(c.slug)}</div>
					<div class="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
						{#if c.totals}
							<span class="font-mono text-[13px]"><span class="text-[#73C991]">+{c.totals.added}</span> <span class="text-[#F48771]">−{c.totals.deleted}</span></span>
							<span class="text-(--vscode-descriptionForeground)">{t('adeAttempts.compare.files', { count: c.totals.files })}</span>
							{#if c.only && columns.length > 1}<span class="text-(--vscode-descriptionForeground)" title={t('adeAttempts.compare.onlyTitle')}>{t('adeAttempts.compare.only', { count: c.only })}</span>{/if}
						{:else if c.error}
							<span class="truncate text-(--vscode-errorForeground)" title={c.error}>{c.error}</span>
						{:else}
							<span class="text-(--vscode-descriptionForeground)">{t('adeAttempts.compare.loading')}</span>
						{/if}
					</div>
					{#if c.cost !== null || c.turns !== null}
						<div class="mt-0.5 text-[11px] text-(--vscode-descriptionForeground)">
							{[c.cost !== null ? `$${c.cost.toFixed(4)}` : null, c.turns !== null ? t('adeAttempts.compare.turns', { count: c.turns }) : null].filter(Boolean).join(' · ')}
						</div>
					{/if}
					<ul class="mt-2 min-h-0 flex-1 space-y-px" aria-label={t('adeAttempts.compare.changed')}>
						{#each c.files.slice(0, MAX_FILES) as f (f.path)}
							<li>
								<button class="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-(--vscode-list-hoverBackground)" title={f.path} onclick={() => diff(c.slug, f.path)}>
									<span class={['w-3 shrink-0 text-center font-mono', LETTER_COLOR[f.status] ?? '']}>{f.status}</span>
									<span class="min-w-0 flex-1 truncate">{f.path}</span>
									{#if f.added !== null}<span class="shrink-0 font-mono text-[10px]"><span class="text-[#73C991]">+{f.added}</span> <span class="text-[#F48771]">−{f.deleted}</span></span>{/if}
								</button>
							</li>
						{:else}
							{#if c.totals}<li class="px-1 text-(--vscode-descriptionForeground)">{t('adeAttempts.compare.noChanges')}</li>{/if}
						{/each}
						{#if c.files.length > MAX_FILES}<li class="px-1 text-(--vscode-descriptionForeground)">{t('adeAttempts.compare.more', { count: c.files.length - MAX_FILES })}</li>{/if}
					</ul>
					<div class="mt-2.5 flex gap-1.5">
						<button class={BUTTON_SECONDARY} onclick={() => open(c.slug)}><Icon name="openExternal" size={12} />{t('adeAttempts.compare.open')}</button>
						<button class={BUTTON} disabled={busy || !!view?.runtime?.working} title={t('adeAttempts.compare.pickTitle')} onclick={() => pick(c.slug)}><Icon name="check" size={12} />{t('adeAttempts.compare.pick')}</button>
					</div>
				</section>
			{/each}
		</div>
	{/if}
	{#snippet footer()}
		<button class={BUTTON_SECONDARY} disabled={busy} onclick={onClose}>{t('adeAttempts.compare.close')}</button>
	{/snippet}
</AdeDialog>
