<script lang="ts">
	// Issues page (Agents layout center, from the side bar): every connected tracker in one list
	// (the folder's GitHub issues, a GitHub Project, Linear, GitLab, Jira), filtered by source, to
	// mine or all, by label and search. A row starts a task (a small confirm with the base branch
	// and terminal agent) or opens the issue; a row that already has a task links to it.
	import { onMount } from 'svelte';
	import { t } from '#lib/i18n/index.ts';
	import Icon from '#lib/workbench/Icon.svelte';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { quick } from '#lib/workbench/quick.svelte.ts';
	import { adeLayout } from './adeLayout.svelte.ts';
	import { defaultBase } from './issues.svelte.ts';
	import { linear } from './linear.svelte.ts';
	import { timeAgo } from './model.ts';
	import { sources } from './taskSources.svelte.ts';
	import { SOURCE_NAMES, SOURCES, filterItems, isoTime, type SourceId, type SourceItem } from './taskSources.ts';
	import { adeTasks } from './tasks.svelte.ts';
	import { BUTTON, BUTTON_SECONDARY, ICON_BUTTON, INPUT } from './ui.ts';

	let label = $state(sources.filter.label);
	let search = $state(sources.filter.search);
	let base = $state('');
	let busy = $state(false);
	const cliSetting = $derived(settings.get<string>('kingu.agent.cli') ?? '');
	const enabled = $derived(sources.enabled());
	const shown = $derived(filterItems(sources.items, sources.only));
	const missing = $derived(SOURCES.filter((s) => s !== 'github' && !enabled.includes(s)));
	const errors = $derived(Object.entries(sources.errors) as [SourceId, string][]);

	onMount(() => {
		if (!sources.loaded) void sources.load();
		void adeTasks.refreshBranches();
	});

	function setMine(mine: boolean) {
		if (sources.filter.mine === mine) return;
		sources.filter.mine = mine;
		void sources.load();
	}

	function setOnly(only: SourceId | null) {
		if (sources.only === only) return;
		sources.only = only;
		void sources.load();
	}

	function apply(e: Event) {
		e.preventDefault();
		sources.filter.label = label;
		sources.filter.search = search;
		void sources.load();
	}

	function confirm(item: SourceItem) {
		sources.confirming = item;
		base = defaultBase();
	}

	async function start(item: SourceItem) {
		busy = true;
		try {
			await sources.start(item, base, 'terminal');
		} finally {
			busy = false;
		}
	}

	function connect(source: SourceId) {
		if (source === 'project') void sources.chooseProject();
		else if (source === 'linear') linear.connecting = true;
		else if (source === 'gitlab' || source === 'jira') sources.connecting = source;
	}

	async function connectMenu() {
		const picked = await quick.choose({ placeholder: t('adeSources.connectPlaceholder'), items: missing.map((s) => ({ id: s, label: SOURCE_NAMES[s] })) });
		if (picked) connect(picked.id as SourceId);
	}

	const updated = (iso: string) => {
		const at = isoTime(iso);
		return at ? timeAgo(at, adeTasks.now) : '';
	};
	const TAB = 'h-6 rounded-sm px-2 text-xs';
	const tab = (on: boolean) => [TAB, on ? 'bg-(--vscode-list-activeSelectionBackground)/40' : 'hover:bg-(--vscode-toolbar-hoverBackground)'];
</script>

<div class="flex h-full flex-col overflow-hidden bg-(--vscode-editor-background) text-(--vscode-foreground)">
	<header class="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--vscode-widget-border) px-4 py-2">
		<h1 class="text-sm font-semibold">Issues</h1>
		<div class="flex items-center gap-0.5" role="group" aria-label={t('adeSources.mineGroup')}>
			<button class={tab(sources.filter.mine)} aria-pressed={sources.filter.mine} onclick={() => setMine(true)}>{t('adeTasks.issues.assignedToMe')}</button>
			<button class={tab(!sources.filter.mine)} aria-pressed={!sources.filter.mine} onclick={() => setMine(false)}>{t('adeSources.allOpen')}</button>
		</div>
		{#if enabled.length > 1}
			<div class="flex items-center gap-0.5" role="group" aria-label={t('adeSources.sourceGroup')}>
				<button class={tab(sources.only === null)} aria-pressed={sources.only === null} onclick={() => setOnly(null)}>{t('adeSources.allSources')}</button>
				{#each enabled as s (s)}
					<button class={tab(sources.only === s)} aria-pressed={sources.only === s} onclick={() => setOnly(s)}>{SOURCE_NAMES[s]}</button>
				{/each}
			</div>
		{/if}
		<form class="flex min-w-0 flex-1 items-center gap-1.5 text-xs" onsubmit={apply}>
			<input class={[INPUT, 'max-w-36']} placeholder="label" aria-label="label" bind:value={label} />
			<input class={[INPUT, 'max-w-64']} placeholder={t('adeSources.searchPlaceholder')} aria-label={t('adeSources.search')} bind:value={search} />
			<button type="submit" class="sr-only">{t('adeSources.search')}</button>
		</form>
		{#if missing.length}
			<button class={BUTTON_SECONDARY} onclick={connectMenu}><Icon name="plus" size={12} /> {t('adeSources.connect')}</button>
		{/if}
		<button class={ICON_BUTTON} aria-label={t('adeSources.refresh')} title={t('adeSources.refresh')} disabled={sources.loading} onclick={() => sources.load()}><Icon name="refresh" size={16} /></button>
	</header>

	<div class="min-h-0 flex-1 overflow-y-auto p-4">
		{#each errors as [source, error] (source)}
			<div class="mb-3 rounded border border-(--vscode-errorForeground) px-3 py-2 text-xs" role="alert">
				<p class="text-(--vscode-errorForeground)">{t('adeSources.loadFailed', { service: SOURCE_NAMES[source], error })}</p>
			</div>
		{/each}
		{#if sources.loading && !shown.length}
			<p class="text-xs text-(--vscode-descriptionForeground)">{t('adeSources.loading')}</p>
		{:else if sources.loaded && !shown.length && !errors.length}
			<p class="text-xs text-(--vscode-descriptionForeground)">
				{sources.filter.mine ? t('adeSources.noneMine') : t('adeSources.none')}{sources.filter.label || sources.filter.search ? ` ${t('adeSources.noneFiltered')}` : ''}
			</p>
			{#if !enabled.length}<p class="mt-1 text-xs text-(--vscode-descriptionForeground)">{t('adeSources.noSources')}</p>{/if}
		{:else}
			<ul class={['space-y-1.5', sources.loading && 'opacity-60']} aria-label={t('adeSources.list')} aria-busy={sources.loading}>
				{#each shown as item (item.id)}
					{@const taskSlug = sources.tasks.get(item.id)}
					{@const task = taskSlug ? adeTasks.find(taskSlug) : undefined}
					<li class="rounded border border-(--vscode-widget-border) px-3 py-2 text-xs">
						<div class="flex items-start gap-3">
							<span class="flex shrink-0 flex-col items-start gap-0.5">
								<span class="font-mono text-(--vscode-descriptionForeground)">{item.ref}</span>
								<span class="rounded-sm bg-(--vscode-badge-background)/60 px-1 text-[10px] leading-4 text-(--vscode-badge-foreground)">{SOURCE_NAMES[item.source]}</span>
							</span>
							<div class="min-w-0 flex-1 space-y-1">
								<p class="truncate text-[13px]" title={item.title}>{item.title}</p>
								<p class="flex flex-wrap items-center gap-1.5 text-(--vscode-descriptionForeground)">
									{#each item.labels as l (l.name)}
										<span class="rounded-full border px-1.5 text-[10px] leading-4" style:border-color={/^[0-9a-f]{6}$/i.test(l.color) ? `#${l.color}` : undefined}>{l.name}</span>
									{/each}
									{#each item.facts as f, i (i)}<span>{f} ·</span>{/each}
									<span>{t('adeSources.updated', { when: updated(item.updated_at) })}</span>
									{#if item.assignees.length}<span>· {item.assignees.map((a) => (item.source === 'jira' || item.source === 'linear' ? a : `@${a}`)).join(', ')}</span>{/if}
									{#if task}
										<span>·</span>
										<button class="font-mono text-(--vscode-textLink-foreground) hover:underline" onclick={() => adeLayout.show(task.meta.slug)}>kingu/{task.meta.slug}</button>
									{/if}
								</p>
							</div>
							<div class="flex shrink-0 items-center gap-1">
								{#if task}
									<button class={BUTTON_SECONDARY} onclick={() => adeLayout.show(task.meta.slug)}>{t('adeSources.openTask')}</button>
								{:else}
									<button class={BUTTON} disabled={sources.confirming?.id === item.id} onclick={() => confirm(item)}><Icon name="play" size={12} /> {t('adeSources.startTask')}</button>
								{/if}
								<button
									class={ICON_BUTTON}
									aria-label={t('adeSources.openOn', { ref: item.ref, service: SOURCE_NAMES[item.source] })}
									title={t('adeSources.openOn', { ref: item.ref, service: SOURCE_NAMES[item.source] })}
									onclick={() => sources.open(item)}><Icon name="openExternal" size={14} /></button
								>
							</div>
						</div>
						{#if sources.confirming?.id === item.id}
							<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape from any field) -->
							<form
								class="mt-2 flex flex-wrap items-center gap-2 border-t border-(--vscode-widget-border) pt-2"
								onsubmit={(e) => (e.preventDefault(), start(item))}
								onkeydown={(e) => e.key === 'Escape' && (sources.confirming = null)}
							>
								<label class="flex items-center gap-1">
									<span class="text-(--vscode-descriptionForeground)">{t('adeSources.base')}</span>
									<select class={[INPUT, 'w-auto py-0.5']} bind:value={base} disabled={busy} aria-label="base branch">
										{#each adeTasks.branches as b (b)}<option value={b}>{b}</option>{/each}
										{#if !adeTasks.branches.length}<option value="">HEAD</option>{/if}
									</select>
								</label>
								<span class="text-(--vscode-descriptionForeground)">{t('adeSources.runAs')}: Terminal · {cliSetting || 'claude'}</span>
								<span class="flex-1"></span>
								<button type="submit" class={BUTTON} disabled={busy}>{busy ? t('adeSources.creating') : t('adeSources.createAndStart')}</button>
								<button type="button" class={BUTTON_SECONDARY} disabled={busy} onclick={() => (sources.confirming = null)}>{t('common.cancel')}</button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
