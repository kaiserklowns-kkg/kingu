<script lang="ts">
	// The AI Vault side view (old Kingu's kinguVaultView): every agent CLI's past sessions on this
	// machine, grouped by project, agent or date. Typing filters the rows by title, folder, branch
	// and latest message; Enter searches every transcript's full text. A row opens the transcript
	// read-only; its hover actions continue the session here or copy its resume command.
	import { onMount } from 'svelte';
	import Icon, { type IconName } from '#lib/workbench/Icon.svelte';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { timeAgo } from '#lib/ade/model.ts';
	import { t } from '#lib/i18n/index.ts';
	import { vault } from './vault.svelte';
	import { AGENT_NAME, filterSessions, groupSessions, projectName, VAULT_AGENTS, vaultKey, type DateBucket, type Group, type GroupBy, type VaultAgent, type VaultSession } from './vault';

	let query = $state('');
	let agents = $state<VaultAgent[]>([]);
	let by = $state<GroupBy>('project');
	let scope = $state<'folder' | 'all'>('all');
	let closed = $state<Record<string, boolean>>({});
	let now = $state(Date.now());

	// The other agents write outside the folder, so no watcher sees them: read again whenever the
	// view is shown (unchanged files come from Rust's cache).
	onMount(() => {
		void vault.load();
		const tick = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(tick);
	});

	/** The full-text search ran for what is typed now: the list shows its hits. */
	const searchActive = $derived(!!vault.search && vault.searched === query.trim());
	const present = $derived(VAULT_AGENTS.filter((a) => vault.rows.some((r) => r.agent === a)));
	const rows = $derived(
		filterSessions(vault.rows, {
			agents,
			// While the search's hits are shown, the typed words matched the transcripts, not the rows.
			filter: searchActive ? '' : query,
			hits: searchActive ? vault.search!.hits : null,
			folder: scope === 'folder' ? workspace.root : null
		})
	);
	const groups = $derived(groupSessions(rows, by, now));
	const activeKey = $derived(editors.active);

	function groupLabel(g: Group): string {
		if (g.kind === 'agent') return AGENT_NAME[g.key as VaultAgent];
		if (g.kind === 'date') {
			const day = g.key as DateBucket;
			return day === 'today' ? t('vault.date.today') : day === 'yesterday' ? t('vault.date.yesterday') : day === 'week' ? t('vault.date.week') : day === 'month' ? t('vault.date.month') : t('vault.date.older');
		}
		return g.key ? projectName(g.key) : t('vault.noFolder');
	}

	function toggleAgent(a: VaultAgent) {
		agents = agents.includes(a) ? agents.filter((x) => x !== a) : [...agents, a];
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter') void vault.find(query);
		else if (e.key === 'Escape' && query) {
			e.stopPropagation();
			query = '';
			void vault.find('');
		}
	}

	type Action = { icon: IconName; label: string; run: () => unknown; enabled: boolean };
	const actions = (s: VaultSession): Action[] => [
		{ icon: 'play', label: t('vault.continue'), run: () => vault.continue(s), enabled: !!s.resume && s.cwdExists },
		{ icon: 'copy', label: t('vault.copyResume'), run: () => vault.copyResume(s), enabled: !!s.resume },
		{ icon: 'fileText', label: t('vault.copyPath'), run: () => vault.copyPath(s), enabled: true }
	];

	const MUTED = 'text-(--vscode-descriptionForeground)';
	const BUTTON = 'grid size-5 place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
	const CHIP = 'h-5 rounded-full border px-2 text-[11px] leading-[18px]';
	const INPUT = 'block h-[26px] w-full rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-1.5 text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground) focus:border-(--vscode-focusBorder)';
</script>

<section class="flex min-h-0 flex-1 flex-col">
	<div class="flex shrink-0 flex-col gap-1.5 px-2 pt-1 pb-2">
		<div class="flex items-center gap-1">
			<input type="search" aria-label={t('vault.search')} placeholder={t('vault.searchPlaceholder')} bind:value={query} onkeydown={onKey} spellcheck="false" class={INPUT} />
			<button class={BUTTON} aria-label={t('vault.searchAll')} title={t('vault.searchAll')} disabled={!query.trim() || vault.searching} onclick={() => vault.find(query)}><Icon name="search" size={16} /></button>
			<button class={BUTTON} aria-label={t('vault.refresh')} title={t('vault.refresh')} disabled={vault.loading} onclick={() => vault.load()}>
				<span class={['grid place-items-center', vault.loading && 'animate-spin']}><Icon name="refresh" size={16} /></span>
			</button>
		</div>
		{#if present.length > 1}
			<div class="flex flex-wrap gap-1" role="group" aria-label={t('vault.agents')}>
				{#each present as a (a)}
					{@const on = agents.includes(a)}
					<button
						class={[CHIP, on ? 'border-(--vscode-focusBorder) bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground)' : 'border-(--vscode-widget-border) hover:bg-(--vscode-list-hoverBackground)']}
						aria-pressed={on}
						onclick={() => toggleAgent(a)}>{AGENT_NAME[a]}</button
					>
				{/each}
			</div>
		{/if}
		<div class="flex items-center gap-1.5 text-[11px] {MUTED}">
			<label class="flex items-center gap-1"
				>{t('vault.groupBy')}
				<select bind:value={by} class="h-5 rounded-sm border border-(--vscode-dropdown-border) bg-(--vscode-dropdown-background) px-0.5 text-(--vscode-dropdown-foreground)">
					<option value="project">{t('vault.by.project')}</option>
					<option value="agent">{t('vault.by.agent')}</option>
					<option value="date">{t('vault.by.date')}</option>
				</select>
			</label>
			<label class="ml-auto flex items-center gap-1" title={workspace.root ?? ''}>
				<input type="checkbox" checked={scope === 'folder'} disabled={!workspace.root} onchange={(e) => (scope = e.currentTarget.checked ? 'folder' : 'all')} />{t('vault.thisFolder')}
			</label>
		</div>
		{#if vault.searching}
			<p class="text-xs {MUTED}">{t('vault.searching')}</p>
		{:else if searchActive && vault.search}
			<p class="text-xs {MUTED}">
				{t('vault.searchResult', { count: vault.search.hits.length, searched: vault.search.searched, total: vault.search.total })}
				{#if vault.search.stopped === 'budget' || vault.search.stopped === 'limit'}· {t('vault.searchStopped')}{/if}
				<button class="ml-1 text-(--vscode-textLink-foreground) hover:underline" onclick={() => ((query = ''), vault.find(''))}>{t('vault.clearSearch')}</button>
			</p>
		{:else if query.trim()}
			<p class="text-xs {MUTED}">{t('vault.enterToSearch')}</p>
		{/if}
		{#if vault.error}<p role="alert" class="text-xs text-(--vscode-errorForeground)">{t('vault.loadFailed', { error: vault.error })}</p>{/if}
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto" role="list">
		{#each groups as g (g.kind + g.key)}
			{@const open = !closed[g.key]}
			<div class="flex h-(--kg-row-height) shrink-0 items-center pr-2 text-[11px] font-bold text-(--vscode-sideBarTitle-foreground) uppercase hover:bg-(--vscode-list-hoverBackground)">
				<button class="flex h-full min-w-0 flex-1 items-center gap-0.5 pl-0.5 text-left" aria-expanded={open} title={g.kind === 'project' ? g.key : undefined} onclick={() => (closed[g.key] = open)}>
					<Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
					<span class="truncate">{groupLabel(g)}</span>
				</button>
				<span class="ml-1 min-w-[18px] rounded-full bg-(--vscode-badge-background) px-1.5 text-center text-[11px] leading-[18px] font-normal text-(--vscode-badge-foreground)">{g.rows.length}</span>
			</div>
			{#if open}
				{#each g.rows as s (s.path)}
					{@const excerpt = searchActive ? vault.excerpt(s.path) : null}
					<div role="listitem" class={['group/row flex items-start gap-1 py-1 pr-2', activeKey === vaultKey(s.agent, s.path) ? 'bg-(--vscode-list-inactiveSelectionBackground)' : 'hover:bg-(--vscode-list-hoverBackground)']}>
						<button class="flex min-w-0 flex-1 flex-col pl-5 text-left" title={s.cwd ?? s.path} onclick={() => vault.open(s)} ondblclick={() => vault.open(s, true)}>
							<span class="truncate">{s.title}</span>
							<span class="truncate text-[0.9em] {MUTED}">
								{[g.kind === 'agent' ? null : AGENT_NAME[s.agent], g.kind === 'project' ? null : projectName(s.cwd) || null, timeAgo(s.updated, now), s.branch].filter(Boolean).join(' · ')}
							</span>
							{#if excerpt}
								<span class="line-clamp-2 text-[0.9em] text-(--vscode-foreground)/80">{excerpt}</span>
							{:else if s.preview}
								<span class="truncate text-[0.9em] {MUTED}">{s.preview}</span>
							{/if}
						</button>
						<span class="hidden shrink-0 items-center gap-0.5 pt-0.5 group-hover/row:flex group-focus-within/row:flex">
							{#each actions(s) as a (a.label)}
								<button
									class={BUTTON}
									aria-label={a.label}
									title={a.label}
									disabled={!a.enabled}
									onclick={(e) => {
										e.stopPropagation();
										void a.run();
									}}><Icon name={a.icon} size={16} /></button
								>
							{/each}
						</span>
					</div>
				{/each}
			{/if}
		{:else}
			<p class="px-5 py-2 {MUTED}">
				{vault.loading && !vault.loaded ? t('vault.loading') : vault.rows.length ? t('vault.noMatch') : t('vault.empty')}
			</p>
		{/each}
	</div>
</section>
