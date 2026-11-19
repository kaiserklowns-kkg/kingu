<script lang="ts">
	// The Clean Up Tasks dialog's filter bar (Orca's WorkspaceCleanupFilterBar): search, sort, a
	// Filters panel and the applied filters as chips that each clear only their own constraint. The
	// panel offers only what Kingu knows about a task (workspaceCleanupBrowse.ts).
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { STATUS_LABEL } from './model';
	import { cleanupBrowse as browse } from './cleanupBrowse.svelte';
	import { cleanupFilterLabels } from './cleanupFilterLabels';
	import { BROWSE_AGENT_STATES, BROWSE_BLOCKERS, BROWSE_GIT_STATES, BROWSE_IDLE_SIGNALS, BROWSE_REVIEW_STATES, BROWSE_SORT_FIELDS, BROWSE_TASK_STATUSES, BROWSE_TICKET_SOURCES } from './workspaceCleanupBrowse';
	import { listAppliedWorkspaceCleanupFilters } from './workspaceCleanupAppliedFilters';
	import type { WorkspaceCleanupFilterState, WorkspaceCleanupSortField } from './workspaceCleanupFilters';

	const camel = (s: string) => s.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
	const MB = 1024 * 1024;
	const mb = (bytes: number | null) => (bytes === null ? '' : String(Math.round((bytes / MB) * 10) / 10));
	const toBytes = (v: string) => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.round(Number(v) * MB)));
	let { shown, total }: { shown: number; total: number } = $props();
	let open = $state(false);

	const f = $derived(browse.filters);
	const applied = $derived(listAppliedWorkspaceCleanupFilters(f, cleanupFilterLabels));
	const edit = (patch: (next: WorkspaceCleanupFilterState) => void) => {
		const next = structuredClone($state.snapshot(f));
		patch(next);
		browse.setFilters(next);
	};
	function toggle<T>(list: T[], v: T): T[] {
		return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
	}

	// "Has one" / "None" for the PR and ticket facets; pressing the active one goes back to "any".
	const PRESENCE = ['some', 'none'] as const;
	// "Only" / "Hide" for the archived and comment facets; pressing the active one goes back to "any".
	const TRI = ['only', 'exclude'] as const;
	const TRI_FACETS = ['archived', 'comment'] as const;
	const CHIP = 'rounded-full border px-2.5 py-0.5 text-xs transition-colors';
	const chip = (on: boolean) => [CHIP, on ? 'border-(--vscode-focusBorder) bg-(--vscode-list-inactiveSelectionBackground)' : 'border-(--vscode-widget-border) text-(--vscode-descriptionForeground) hover:bg-(--vscode-list-hoverBackground)'];
	const INPUT = 'h-7 rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) px-2 text-xs outline-none focus:border-(--vscode-focusBorder)';
	const LABEL = 'mb-1 block text-[11px] font-medium text-(--vscode-descriptionForeground)';
</script>

<div class="border-b border-(--vscode-widget-border) px-5 pb-2">
	<div class="flex items-center gap-2">
		<input class="{INPUT} min-w-0 flex-1" type="search" placeholder={t('workspaceCleanup.filter.search')} aria-label={t('workspaceCleanup.filter.search')} value={f.query} oninput={(e) => edit((n) => (n.query = e.currentTarget.value))} />
		<select class={INPUT} aria-label={t('workspaceCleanup.filter.sort')} value={browse.sort.field} onchange={(e) => browse.setSort({ ...browse.sort, field: e.currentTarget.value as WorkspaceCleanupSortField })}>
			{#each BROWSE_SORT_FIELDS as field (field)}<option value={field}>{t(`workspaceCleanup.filter.sort.${camel(field)}` as never)}</option>{/each}
		</select>
		<button
			class="h-7 rounded-md px-2 text-xs hover:bg-(--vscode-toolbar-hoverBackground)"
			title={browse.sort.direction === 'asc' ? t('workspaceCleanup.filter.sortAsc') : t('workspaceCleanup.filter.sortDesc')}
			aria-label={browse.sort.direction === 'asc' ? t('workspaceCleanup.filter.sortAsc') : t('workspaceCleanup.filter.sortDesc')}
			onclick={() => browse.setSort({ ...browse.sort, direction: browse.sort.direction === 'asc' ? 'desc' : 'asc' })}>{browse.sort.direction === 'asc' ? '↑' : '↓'}</button
		>
		<button class={['flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-(--vscode-toolbar-hoverBackground)', open && 'bg-(--vscode-toolbar-hoverBackground)']} aria-expanded={open} onclick={() => (open = !open)}>
			<Icon name="filter" size={14} />{t('workspaceCleanup.filter.filters')}{applied.length ? ` · ${applied.length}` : ''}
		</button>
	</div>

	{#if open}
		<div class="mt-2 grid gap-3 rounded-lg border border-(--vscode-widget-border) p-3 sm:grid-cols-2">
			<div>
				<span class={LABEL}>{t('workspaceCleanup.filter.idle')}</span>
				<div class="flex items-center gap-2">
					<input
						class="{INPUT} w-20"
						type="number"
						min="0"
						step="1"
						value={f.activity.idleMinDays ?? ''}
						onchange={(e) => edit((n) => (n.activity.idleMinDays = e.currentTarget.value === '' ? null : Math.max(0, Math.round(Number(e.currentTarget.value)))))}
					/>
					<select class={INPUT} aria-label={t('workspaceCleanup.filter.idleSignal')} value={f.activity.idleSignal} onchange={(e) => edit((n) => (n.activity.idleSignal = e.currentTarget.value as typeof n.activity.idleSignal))}>
						{#each BROWSE_IDLE_SIGNALS as s (s)}<option value={s}>{t(`workspaceCleanup.filter.signal.${camel(s)}` as never)}</option>{/each}
					</select>
				</div>
			</div>
			<div>
				<label class={LABEL} for="kg-cleanup-branch">{t('workspaceCleanup.filter.branch')}</label>
				<input id="kg-cleanup-branch" class="{INPUT} w-full" value={f.git.branchQuery} oninput={(e) => edit((n) => (n.git.branchQuery = e.currentTarget.value))} />
			</div>
			<div>
				<span class={LABEL}>{t('workspaceCleanup.filter.size')}</span>
				<div class="flex items-center gap-2">
					<input class="{INPUT} w-20" type="number" min="0" step="any" placeholder={t('workspaceCleanup.filter.minSize')} aria-label={t('workspaceCleanup.filter.minSize')} value={mb(f.size.minBytes)} onchange={(e) => edit((n) => (n.size.minBytes = toBytes(e.currentTarget.value)))} />
					<span class="text-xs text-(--vscode-descriptionForeground)">–</span>
					<input class="{INPUT} w-20" type="number" min="0" step="any" placeholder={t('workspaceCleanup.filter.maxSize')} aria-label={t('workspaceCleanup.filter.maxSize')} value={mb(f.size.maxBytes)} onchange={(e) => edit((n) => (n.size.maxBytes = toBytes(e.currentTarget.value)))} />
				</div>
				<label class="mt-1.5 flex items-center gap-1.5 text-xs">
					<input type="checkbox" class="size-3.5 accent-(--vscode-focusBorder)" checked={f.size.includeUnsized} onchange={(e) => edit((n) => (n.size.includeUnsized = e.currentTarget.checked))} />
					{t('workspaceCleanup.filter.includeUnsized')}
				</label>
			</div>
			<div>
				<span class={LABEL}>{t('workspaceCleanup.filter.git')}</span>
				<div class="flex flex-wrap gap-1.5">
					{#each BROWSE_GIT_STATES as s (s)}<button class={chip(f.git.states.includes(s))} aria-pressed={f.git.states.includes(s)} onclick={() => edit((n) => (n.git.states = toggle(n.git.states, s)))}>{t(`workspaceCleanup.filter.git.${s}`)}</button>{/each}
				</div>
			</div>
			<div>
				<span class={LABEL}>{t('workspaceCleanup.filter.status')}</span>
				<div class="flex flex-wrap gap-1.5">
					{#each BROWSE_TASK_STATUSES as s (s)}<button class={chip(f.status.workspaceStatuses.includes(s))} aria-pressed={f.status.workspaceStatuses.includes(s)} onclick={() => edit((n) => (n.status.workspaceStatuses = toggle(n.status.workspaceStatuses, s)))}>{STATUS_LABEL[s]}</button>{/each}
				</div>
			</div>
			<div>
				<span class={LABEL}>{t('workspaceCleanup.filter.agent')}</span>
				<div class="flex flex-wrap gap-1.5">
					{#each BROWSE_AGENT_STATES as s (s)}<button class={chip(f.agent.states.includes(s))} aria-pressed={f.agent.states.includes(s)} onclick={() => edit((n) => (n.agent.states = toggle(n.agent.states, s)))}>{t(`workspaceCleanup.filter.agent.${s}`)}</button>{/each}
				</div>
			</div>
			<div>
				<span class={LABEL}>{t('workspaceCleanup.filter.review')}</span>
				<div class="flex flex-wrap gap-1.5">
					{#each PRESENCE as p (p)}<button class={chip(f.review.presence === p)} aria-pressed={f.review.presence === p} onclick={() => edit((n) => (n.review.presence = n.review.presence === p ? 'any' : p))}>{t(`workspaceCleanup.filter.presence.${p}` as never)}</button>{/each}
					{#each BROWSE_REVIEW_STATES as s (s)}<button class={chip(f.review.states.includes(s))} aria-pressed={f.review.states.includes(s)} onclick={() => edit((n) => (n.review.states = toggle(n.review.states, s)))}>{t(`workspaceCleanup.filter.review.${s}` as never)}</button>{/each}
				</div>
			</div>
			<div>
				<span class={LABEL}>{t('workspaceCleanup.filter.ticket')}</span>
				<div class="flex flex-wrap gap-1.5">
					{#each PRESENCE as p (p)}<button class={chip(f.ticket.presence === p)} aria-pressed={f.ticket.presence === p} onclick={() => edit((n) => (n.ticket.presence = n.ticket.presence === p ? 'any' : p))}>{t(`workspaceCleanup.filter.presence.${p}` as never)}</button>{/each}
					{#each BROWSE_TICKET_SOURCES as s (s)}<button class={chip(f.ticket.sources.includes(s))} aria-pressed={f.ticket.sources.includes(s)} onclick={() => edit((n) => (n.ticket.sources = toggle(n.ticket.sources, s)))}>{t(`workspaceCleanup.filter.ticket.${s}` as never)}</button>{/each}
				</div>
			</div>
			{#each TRI_FACETS as k (k)}
				<div>
					<span class={LABEL}>{t(`workspaceCleanup.filter.${k}`)}</span>
					<div class="flex flex-wrap gap-1.5">
						{#each TRI as v (v)}<button class={chip(f.status[k] === v)} aria-pressed={f.status[k] === v} onclick={() => edit((n) => (n.status[k] = n.status[k] === v ? 'any' : v))}>{t(`workspaceCleanup.filter.triState.${v}`)}</button>{/each}
					</div>
				</div>
			{/each}
			<div class="sm:col-span-2">
				<div class="mb-1 flex items-center gap-2">
					<span class="text-[11px] font-medium text-(--vscode-descriptionForeground)">{t('workspaceCleanup.filter.blockers')}</span>
					<button class={chip(f.safety.blockerMode === 'any-of')} aria-pressed={f.safety.blockerMode === 'any-of'} onclick={() => edit((n) => (n.safety.blockerMode = n.safety.blockerMode === 'any-of' ? 'none-of' : 'any-of'))}>
						{f.safety.blockerMode === 'any-of' ? t('workspaceCleanup.filter.mode.anyOf') : t('workspaceCleanup.filter.mode.noneOf')}
					</button>
				</div>
				<div class="flex flex-wrap gap-1.5">
					{#each BROWSE_BLOCKERS as b (b)}<button class={chip(f.safety.blockers.includes(b))} aria-pressed={f.safety.blockers.includes(b)} onclick={() => edit((n) => (n.safety.blockers = toggle(n.safety.blockers, b)))}>{t(`workspaceCleanup.filter.blocker.${camel(b)}` as never)}</button>{/each}
				</div>
			</div>
		</div>
	{/if}

	{#if applied.length}
		<div class="mt-2 flex flex-wrap items-center gap-1.5">
			{#each applied as a (a.id)}
				<button class="{CHIP} flex items-center gap-1 border-(--vscode-widget-border) hover:bg-(--vscode-list-hoverBackground)" title={a.label} onclick={() => browse.setFilters(a.clear(structuredClone($state.snapshot(f))))}>
					{a.label}<Icon name="close" size={11} />
				</button>
			{/each}
			<button class="text-xs text-(--vscode-textLink-foreground) hover:underline" onclick={() => browse.clear()}>{t('workspaceCleanup.filter.clearAll')}</button>
			<span class="flex-1"></span>
			<span class="text-xs text-(--vscode-descriptionForeground)">{shown}/{total}</span>
		</div>
	{/if}
</div>
