<script lang="ts">
	// The Artifacts side view (old Kingu's / Orca's Artifacts page): the open folder's artifacts —
	// pages agents published with the artifact_publish tool or `kingu artifact publish` — newest
	// first, each with its versions; and, when signed in to a team server, the pages teammates
	// shared. A row opens the page in an editor tab (ArtifactViewer.svelte).
	import { onMount } from 'svelte';
	import Icon, { type IconName } from '#lib/workbench/Icon.svelte';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { timeAgo } from '#lib/ade/model.ts';
	import { t } from '#lib/i18n/index.ts';
	import { artifacts } from './artifacts.svelte';
	import { artifactKey, filterArtifacts, latest, teamArtifactKey, type ArtifactMeta } from './artifacts';

	let query = $state('');
	let now = $state(Date.now());
	let teamOpen = $state(true);

	onMount(() => {
		void artifacts.load();
		void artifacts.loadTeam();
		const tick = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(tick);
	});

	// Another folder: its artifacts.
	$effect(() => {
		if (workspace.root !== artifacts.loadedRoot) void artifacts.load();
	});

	const rows = $derived(filterArtifacts(artifacts.list, query));
	const teamRows = $derived(artifacts.team.filter((a) => `${a.title} ${a.shared_by}`.toLowerCase().includes(query.trim().toLowerCase())));
	const activeKey = $derived(editors.active);
	const root = $derived(workspace.root);

	type Action = { icon: IconName; label: string; run: () => unknown };
	const actions = (r: string, m: ArtifactMeta): Action[] => [
		{ icon: 'publish', label: t('artifacts.export'), run: () => artifacts.exportVersion(r, m, latest(m).version) },
		{ icon: 'sync', label: t('artifacts.share'), run: () => artifacts.share(r, m, latest(m).version) },
		{ icon: 'trash', label: t('artifacts.delete'), run: () => artifacts.remove(r, m) }
	];

	const MUTED = 'text-(--vscode-descriptionForeground)';
	const BUTTON = 'grid size-5 place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
	const INPUT = 'block h-[26px] w-full rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-1.5 text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground) focus:border-(--vscode-focusBorder)';
	const HEADER = 'flex h-(--kg-row-height) shrink-0 items-center pr-2 text-[11px] font-bold text-(--vscode-sideBarTitle-foreground) uppercase hover:bg-(--vscode-list-hoverBackground)';
</script>

<section class="flex min-h-0 flex-1 flex-col">
	<div class="flex shrink-0 items-center gap-1 px-2 pt-1 pb-2">
		<input type="search" aria-label={t('artifacts.filter')} placeholder={t('artifacts.filter')} bind:value={query} spellcheck="false" class={INPUT} />
		<button class={BUTTON} aria-label={t('artifacts.refresh')} title={t('artifacts.refresh')} disabled={artifacts.loading} onclick={() => (artifacts.load(), artifacts.loadTeam())}>
			<span class={['grid place-items-center', artifacts.loading && 'animate-spin']}><Icon name="refresh" size={16} /></span>
		</button>
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto" role="list">
		{#if !root}
			<p class="px-5 py-2 {MUTED}">{t('artifacts.noFolder')}</p>
		{:else}
			{#if artifacts.error}<p role="alert" class="px-5 py-1 text-xs text-(--vscode-errorForeground)">{t('artifacts.loadFailed', { error: artifacts.error })}</p>{/if}
			{#each rows as m (m.id)}
				{@const v = latest(m)}
				<div role="listitem" class={['group/row flex items-start gap-1 py-1 pr-2', activeKey === artifactKey(root, m.id) ? 'bg-(--vscode-list-inactiveSelectionBackground)' : 'hover:bg-(--vscode-list-hoverBackground)']}>
					<button class="flex min-w-0 flex-1 items-start gap-1.5 pl-3 text-left" title={m.description ?? m.title} onclick={() => artifacts.open(root, m.id, undefined, false)} ondblclick={() => artifacts.open(root, m.id)}>
						<span class="mt-0.5 shrink-0 {MUTED}"><Icon name={v.format === 'markdown' ? 'fileText' : 'code'} size={14} /></span>
						<span class="flex min-w-0 flex-col">
							<span class="truncate">{m.title}</span>
							<span class="truncate text-[0.9em] {MUTED}">
								{[`v${v.version}`, timeAgo(m.updated_at, now), v.source === 'agent' ? t('artifacts.byAgent') : t('artifacts.byCli'), m.shared ? t('artifacts.sharedShort') : null].filter(Boolean).join(' · ')}
							</span>
						</span>
					</button>
					<span class="hidden shrink-0 items-center gap-0.5 pt-0.5 group-hover/row:flex group-focus-within/row:flex">
						{#each actions(root, m) as a (a.label)}
							<button
								class={BUTTON}
								aria-label={a.label}
								title={a.label}
								onclick={(e) => {
									e.stopPropagation();
									void a.run();
								}}><Icon name={a.icon} size={16} /></button
							>
						{/each}
					</span>
				</div>
			{:else}
				<p class="px-5 py-2 {MUTED}">{artifacts.loading && artifacts.loadedRoot !== root ? t('artifacts.loading') : artifacts.list.length ? t('artifacts.noMatch') : t('artifacts.empty')}</p>
			{/each}
		{/if}

		{#if artifacts.teamReady}
			<div class={[HEADER, 'mt-2']}>
				<button class="flex h-full min-w-0 flex-1 items-center gap-0.5 pl-0.5 text-left" aria-expanded={teamOpen} onclick={() => (teamOpen = !teamOpen)}>
					<Icon name={teamOpen ? 'chevronDown' : 'chevronRight'} size={16} />
					<span class="truncate">{t('artifacts.team')}</span>
				</button>
				<span class="ml-1 min-w-[18px] rounded-full bg-(--vscode-badge-background) px-1.5 text-center text-[11px] leading-[18px] font-normal text-(--vscode-badge-foreground)">{artifacts.team.length}</span>
			</div>
			{#if teamOpen}
				{#if artifacts.teamError}<p role="alert" class="px-5 py-1 text-xs text-(--vscode-errorForeground)">{t('artifacts.teamFailed', { error: artifacts.teamError })}</p>{/if}
				{#each teamRows as a (a.artifact_id)}
					<div role="listitem" class={['group/row flex items-start gap-1 py-1 pr-2', activeKey === teamArtifactKey(a.artifact_id) ? 'bg-(--vscode-list-inactiveSelectionBackground)' : 'hover:bg-(--vscode-list-hoverBackground)']}>
						<button class="flex min-w-0 flex-1 items-start gap-1.5 pl-3 text-left" title={a.description ?? a.title} onclick={() => artifacts.openTeam(a.artifact_id, false)} ondblclick={() => artifacts.openTeam(a.artifact_id)}>
							<span class="mt-0.5 shrink-0 {MUTED}"><Icon name="account" size={14} /></span>
							<span class="flex min-w-0 flex-col">
								<span class="truncate">{a.title}</span>
								<span class="truncate text-[0.9em] {MUTED}">{[a.shared_by, `v${a.version}`, timeAgo(Date.parse(a.updated_at) || 0, now)].join(' · ')}</span>
							</span>
						</button>
						<span class="hidden shrink-0 items-center gap-0.5 pt-0.5 group-hover/row:flex group-focus-within/row:flex">
							<button
								class={BUTTON}
								aria-label={t('artifacts.unshare')}
								title={t('artifacts.unshare')}
								onclick={(e) => {
									e.stopPropagation();
									void artifacts.removeShared(a);
								}}><Icon name="trash" size={16} /></button
							>
						</span>
					</div>
				{:else}
					<p class="px-5 py-2 {MUTED}">{artifacts.teamLoading ? t('artifacts.loading') : t('artifacts.teamEmpty')}</p>
				{/each}
			{/if}
		{/if}
	</div>
</section>
