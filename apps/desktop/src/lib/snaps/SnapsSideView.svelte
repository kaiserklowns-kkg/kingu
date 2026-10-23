<script lang="ts">
	// The Snaps side view (VS Code's Extensions view): search, the user's snaps, this folder's repo
	// snaps, the built-in ones (collapsed), the snaps Kingu ships (Recommended) and the team's
	// (approved snaps and the Team Library). Each row says what the snap adds for you and for
	// agents and shows the one action it needs now (Install, Trust, Set up, Enable); the rest are
	// on hover. A row opens the snap's details page (SnapsView).
	import Icon, { type IconName } from '#lib/workbench/Icon.svelte';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { team } from '#lib/team/team.svelte.ts';
	import { t, t as tr } from '#lib/i18n/index.ts';
	import { catalogKey, filterSnaps, isActive, isUpdatable, lockNote, missingRequirements, requirementStates, snapKey, snapStatus, type CatalogEntry, type SnapInfo } from './snapModel.ts';
	import { approvalNote, canApprove, isApprovable, missingRequired, teamSnapStatus, type TeamSnap } from './teamSnaps.ts';
	import { snaps } from './snaps.svelte.ts';
	import { isPublishable, libraryStatus, librarySnaps, type LibrarySnap } from './teamLibrary.ts';
	import SnapAvatar from './SnapAvatar.svelte';

	let query = $state('');
	let open = $state({ user: true, repo: true, builtin: false, recommended: true, team: true });
	const get = (id: string) => settings.get(id);
	const teamItems = $derived(snaps.teamCatalog?.items ?? []);
	const teamFiltered = $derived.by(() => {
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		return teamItems.filter((t) => words.every((w) => `${t.name}\n${t.snap_id}\n${t.note ?? ''}`.toLowerCase().includes(w)));
	});
	const teamMissing = $derived(missingRequired(teamItems, snaps.list));
	const isTeamAdmin = $derived(canApprove(snaps.teamCatalog?.role));
	const library = $derived(librarySnaps(snaps.library?.items ?? []));
	const libraryFiltered = $derived.by(() => {
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		return library.filter((l) => words.every((w) => `${l.latest?.name ?? ''}\n${l.id}\n${l.latest?.description ?? ''}`.toLowerCase().includes(w)));
	});
	const filtered = $derived(filterSnaps(snaps.all, query));
	/** Shipped snaps not installed yet, or installed with a newer shipped version. */
	const recommended = $derived.by(() => {
		const ids = new Set(filterSnaps(snaps.catalog, query).map((s) => s.id));
		return snaps.recommended.filter((e) => e.state !== 'installed' && ids.has(e.snap.id));
	});
	const sections = $derived([
		{ id: 'user' as const, title: t('tools.snapsUi.installed'), list: filtered.filter((s) => s.source === 'user') },
		{ id: 'repo' as const, title: t('tools.snapsUi.thisFolder'), list: filtered.filter((s) => s.source === 'repo') },
		// VS Code's "Built-in" extensions: shipped with the app, collapsed at first.
		{ id: 'builtin' as const, title: t('snapContrib.section.builtin'), list: filtered.filter((s) => s.source === 'builtin') }
	]);
	const selectedKey = $derived(systemSettings.visible && systemSettings.snaps ? systemSettings.snapKey : null);

	type Action = { icon: IconName; label: string; run: () => unknown };
	type Primary = { label: string; tone: 'primary' | 'warn' | 'secondary'; run: () => unknown };

	const toolbar: Action[] = [
		{ icon: 'plus', label: 'Install from Git…', run: () => snaps.install() },
		{ icon: 'folder', label: 'Install from Folder…', run: () => snaps.installFromFolder() },
		{ icon: 'newFile', label: 'New Snap…', run: () => snaps.newSnap() },
		{ icon: 'check', label: 'Write .kingu/snaps.lock', run: () => snaps.lock() },
		{ icon: 'refresh', label: 'Reload Snaps', run: () => snaps.load() }
	];

	const missing = (s: SnapInfo) => missingRequirements(requirementStates(s, get, snaps.found));
	const crashed = (s: SnapInfo) => snaps.services.filter((st) => st.snapId === s.id && !st.running && !st.stopped);
	const running = (s: SnapInfo) => snaps.services.filter((st) => st.snapId === s.id && st.running);

	/** The one thing the snap needs from you now, shown as a button on the row. */
	function primary(s: SnapInfo): Primary | null {
		if (s.error) return null;
		if (s.source === 'repo' && !s.trusted) return { label: t('tools.snapsUi.trust'), tone: 'warn', run: () => snaps.confirmTrust(s) };
		if (s.disabled) return { label: t('tools.snapsUi.enable'), tone: 'secondary', run: () => snaps.setEnabled(s.id, true) };
		const need = missing(s)[0];
		if (need) return { label: t('tools.snapsUi.setUp'), tone: 'warn', run: () => systemSettings.showSnaps(snapKey(s)) };
		return null;
	}

	function rowActions(s: SnapInfo): Action[] {
		const out: Action[] = [];
		if (s.source === 'repo' && !s.error && s.trusted) out.push({ icon: 'close', label: 'Untrust', run: () => snaps.trust(s.id, false) });
		if (!s.error && s.source !== 'builtin' && (s.source === 'user' || s.trusted)) out.push(s.disabled ? { icon: 'power', label: t('tools.snapsUi.enable'), run: () => snaps.setEnabled(s.id, true) } : { icon: 'power', label: t('tools.snapsUi.disable'), run: () => snaps.setEnabled(s.id, false) });
		if (isActive(s) && s.tasks.length) out.push({ icon: 'play', label: 'Run Task…', run: () => snaps.pickTask(s) });
		if (isUpdatable(s)) out.push({ icon: 'refresh', label: 'Update', run: () => snaps.update(s.id) });
		if (isTeamAdmin && isApprovable(s)) out.push({ icon: 'account', label: 'Approve for Team…', run: () => snaps.approveForTeam(s.id) });
		if (isTeamAdmin && snaps.library && s.source !== 'builtin' && isPublishable(s, snaps.library.items)) { const source = s.source; out.push({ icon: 'publish', label: 'Publish to Team Library…', run: () => snaps.publishToLibrary(s.id, source) }); }
		if (s.source === 'user') out.push({ icon: 'trash', label: 'Uninstall', run: () => snaps.uninstall(s.id) });
		if (s.source !== 'builtin') out.push({ icon: 'folder', label: 'Reveal Folder', run: () => snaps.reveal(s) });
		return out;
	}

	function teamActions(t: TeamSnap): Action[] {
		const st = teamSnapStatus(t, snaps.list);
		if (st.key === 'missing') return [{ icon: 'plus', label: 'Install', run: () => snaps.installTeam(t.snap_id) }];
		if (st.key === 'different') return [{ icon: 'refresh', label: 'Install Team Version', run: () => snaps.installTeam(t.snap_id) }];
		return [];
	}

	function libraryActions(l: LibrarySnap): Action[] {
		const st = libraryStatus(l, snaps.list, snaps.library?.server ?? '');
		const out: Action[] = [];
		if (l.latest && (st.key === 'missing' || st.key === 'update' || st.key === 'yanked')) out.push({ icon: st.key === 'missing' ? 'plus' : 'refresh', label: st.key === 'missing' ? 'Install' : 'Update', run: () => snaps.installFromLibrary(l.id) });
		if (isTeamAdmin) out.push({ icon: 'close', label: 'Yank Version…', run: () => snaps.yankVersion(l.id) });
		return out;
	}

	const forAgents = (s: SnapInfo) => s.mcp.length + s.skills.length + s.hooks.length;
	const forYou = (s: SnapInfo) => {
		const c = s.contributes;
		const contributed = c ? c.languages.length + c.lsp.length + c.themes.length + c.iconThemes.length + c.views.length : 0;
		return s.tasks.length + s.services.length + contributed;
	};

	const TONE = {
		ok: 'text-(--vscode-testing-iconPassed,var(--vscode-charts-green))',
		warn: 'text-(--vscode-editorWarning-foreground)',
		error: 'text-(--vscode-errorForeground)',
		muted: 'text-(--vscode-descriptionForeground)'
	};
	const BUTTON = 'grid size-5 place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-50';
	const PRIMARY = {
		primary: 'bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)',
		warn: 'bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)',
		secondary: 'border border-(--vscode-button-border,var(--vscode-widget-border)) bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground) hover:bg-(--vscode-button-secondaryHoverBackground)'
	};
	const SECTION = 'flex h-(--kg-row-height) shrink-0 items-center pr-2 text-[11px] font-bold text-(--vscode-sideBarTitle-foreground) uppercase hover:bg-(--vscode-list-hoverBackground)';
	const COUNT = 'ml-1 min-w-[18px] rounded-full bg-(--vscode-badge-background) px-1.5 text-center text-[11px] leading-[18px] font-normal text-(--vscode-badge-foreground)';
	const ROW_BUTTON = 'h-[20px] shrink-0 rounded-sm px-2 text-[11px] leading-[20px] disabled:opacity-50';
</script>

{#snippet actionButtons(actions: Action[])}
	{#each actions as a (a.label)}
		<button
			aria-label={a.label}
			title={a.label}
			disabled={!!snaps.busy}
			class={BUTTON}
			onclick={(e) => {
				e.stopPropagation();
				void a.run();
			}}
		>
			<Icon name={a.icon} size={16} />
		</button>
	{/each}
{/snippet}

{#snippet sectionHeader(id: keyof typeof open, title: string, count: number | null)}
	<div class={SECTION}>
		<button class="flex h-full min-w-0 flex-1 items-center gap-0.5 pl-0.5 text-left" aria-expanded={open[id]} onclick={() => (open[id] = !open[id])}>
			<Icon name={open[id] ? 'chevronDown' : 'chevronRight'} size={16} />
			<span class="truncate">{title}</span>
		</button>
		{#if count !== null}<span class={COUNT}>{count}</span>{/if}
	</div>
{/snippet}

<!-- What the snap adds, compactly: confined, for agents, for you, its services. -->
{#snippet meta(s: SnapInfo)}
	{@const agents = forAgents(s)}
	{@const you = forYou(s)}
	{@const up = running(s).length}
	{@const down = crashed(s).length}
	<span class="flex min-w-0 items-center gap-2 text-[11px] text-(--vscode-descriptionForeground)">
		{#if snaps.sandbox.kind === 'enforce'}<span class="flex items-center gap-0.5" title={t('tools.snapsUi.sandboxedHint')}><Icon name="shield" size={12} /></span>{/if}
		{#if agents}<span class="flex items-center gap-0.5" title={t('tools.snapsUi.forAgentsHint', { count: agents })}><Icon name="robot" size={12} />{agents}</span>{/if}
		{#if you}<span class="flex items-center gap-0.5" title={t('tools.snapsUi.forYouHint', { count: you })}><Icon name="desktop" size={12} />{you}</span>{/if}
		{#if down}<span class={['flex items-center gap-0.5', TONE.error]}><span class="size-1.5 rounded-full bg-current"></span>{t('tools.snapsUi.serviceStopped')}</span>
		{:else if up}<span class={['flex items-center gap-0.5', TONE.ok]}><span class="size-1.5 rounded-full bg-current"></span>{t('tools.snapsUi.serviceRunning')}</span>{/if}
	</span>
{/snippet}

<section class="flex min-h-0 flex-1 flex-col">
	<div class="flex shrink-0 flex-col gap-1.5 px-2 pt-1 pb-2">
		<div class="flex items-center justify-end gap-0.5">{@render actionButtons(toolbar)}</div>
		<input
			type="search"
			aria-label="Search Snaps"
			placeholder={t('tools.snapsUi.search')}
			bind:value={query}
			class="block h-[26px] w-full rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-1.5 text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground) focus:border-(--vscode-focusBorder)"
		/>
		{#if snaps.busy}<p class="text-xs text-(--vscode-descriptionForeground)">{snaps.busy}</p>{/if}
		{#if snaps.error}<p role="alert" class="text-xs text-(--vscode-errorForeground)">{t('tools.snaps.loadFailed', { error: snaps.error })}</p>{/if}
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto">
		{#each sections as sec (sec.id)}
			{#if sec.id !== 'repo' || workspace.root}
				{@render sectionHeader(sec.id, sec.title, sec.list.length)}
				{#if open[sec.id]}
					{#each sec.list as s (snapKey(s))}
						{@const st = snapStatus(s)}
						{@const lock = lockNote(s)}
						{@const approved = approvalNote(s, teamItems)}
						{@const action = primary(s)}
						<div
							class={[
								'group/row flex items-start gap-2 py-1.5 pr-2 pl-3',
								selectedKey === snapKey(s) ? 'bg-(--vscode-list-inactiveSelectionBackground)' : 'hover:bg-(--vscode-list-hoverBackground)'
							]}
						>
							<button class="flex min-w-0 flex-1 items-start gap-2 text-left" title={s.dir} onclick={() => systemSettings.showSnaps(snapKey(s))}>
								<span class="mt-0.5"><SnapAvatar snap={s} size={34} muted={!!s.disabled || !!s.error} /></span>
								<span class="flex min-w-0 flex-1 flex-col gap-px">
									<span class="flex min-w-0 items-center gap-1.5">
										<span class={['truncate font-semibold', s.disabled && 'text-(--vscode-disabledForeground)']}>{s.name}</span>
										{#if s.version}<span class="shrink-0 text-[0.9em] text-(--vscode-descriptionForeground)">v{s.version}</span>{/if}
										{#if st.key !== 'active'}<span class={['shrink-0 text-[0.9em]', TONE[st.tone]]}>{st.label}</span>{/if}
										{#if lock}<span class="shrink-0 text-[0.9em] text-(--vscode-editorWarning-foreground)" title=".kingu/snaps.lock">{lock}</span>{/if}
										{#if approved}<span class="shrink-0 text-[0.9em] text-(--vscode-descriptionForeground)">{approved}</span>{/if}
									</span>
									<span class="truncate text-[0.9em] text-(--vscode-descriptionForeground)">{s.error ?? (s.description || s.id)}</span>
									{#if !s.error}{@render meta(s)}{/if}
								</span>
							</button>
							<span class="flex shrink-0 flex-col items-end gap-1">
								{#if action}
									<button class={[ROW_BUTTON, PRIMARY[action.tone]]} disabled={!!snaps.busy} onclick={() => void action.run()}>{action.label}</button>
								{/if}
								<span class="hidden items-center gap-0.5 group-hover/row:flex group-focus-within/row:flex">{@render actionButtons(rowActions(s))}</span>
							</span>
						</div>
					{:else}
						<p class="py-1 pr-2 pl-5 text-(--vscode-descriptionForeground)">
							{query ? t('tools.snapsUi.noMatch') : sec.id === 'user' ? t('tools.snapsUi.noneInstalled') : sec.id === 'builtin' ? '—' : t('tools.snapsUi.noRepoSnaps')}
						</p>
					{/each}
				{/if}
			{/if}
		{/each}

		{#if snaps.catalog.length}
			{@render sectionHeader('recommended', t('tools.snapsUi.recommended'), recommended.length)}
			{#if open.recommended}
				{#each recommended as e (e.snap.id)}
					{@render catalogRow(e)}
				{:else}
					<p class="py-1 pr-2 pl-5 text-(--vscode-descriptionForeground)">{query ? t('tools.snapsUi.noMatch') : t('tools.snapsUi.allInstalled')}</p>
				{/each}
			{/if}
		{/if}

		{@render sectionHeader('team', t('tools.snapsUi.team'), snaps.teamCatalog ? teamItems.length : null)}
		{#if open.team}
			{#if !team.serverUrl}
				<p class="py-1 pr-2 pl-5 text-(--vscode-descriptionForeground)">
					{t('legacySettings.snapsSideView.teamServerHint')}
					<button class="text-(--vscode-textLink-foreground) hover:underline" onclick={() => systemSettings.show('Team')}>{t('legacySettings.snapsSideView.openTeamSettings')}</button>
				</p>
			{:else if !team.status?.signed_in}
				<p class="py-1 pr-2 pl-5 text-(--vscode-descriptionForeground)">
					{t('legacySettings.snapsSideView.teamSignInHint')}
					<button class="text-(--vscode-textLink-foreground) hover:underline" onclick={() => team.startSignIn()}>{t('legacySettings.snapsSideView.teamSignIn')}</button>
				</p>
			{:else if snaps.teamError}
				<p role="alert" class="py-1 pr-2 pl-5 text-(--vscode-errorForeground)">{t('legacySettings.snapsSideView.teamLoadFailed', { error: snaps.teamError })}</p>
			{:else if !snaps.teamCatalog}
				<p class="py-1 pl-5 text-(--vscode-descriptionForeground)">{t('legacySettings.snapsSideView.loading')}</p>
			{:else}
				{#if teamMissing.length}
					<p role="status" class="mx-2 my-1 rounded-sm border border-(--vscode-widget-border) px-2 py-1 text-[0.9em] text-(--vscode-descriptionForeground)">
						<Icon name="info" size={14} />
						{t('legacySettings.snapsSideView.teamMissing', { names: teamMissing.map((t) => t.name).join(', ') })}
					</p>
				{/if}
				{#each teamFiltered as t (t.snap_id)}
					{@const st = teamSnapStatus(t, snaps.list)}
					<div class="group/row flex items-center gap-2 py-1.5 pr-2 pl-3 hover:bg-(--vscode-list-hoverBackground)">
						<SnapAvatar snap={{ id: t.snap_id, name: t.name }} size={34} />
						<div class="flex min-w-0 flex-1 flex-col" title={tr('legacySettings.snapsSideView.teamSnapTitle', { url: t.git_url, ref: t.git_ref ? `#${t.git_ref}` : '', commit: t.commit_sha, by: t.approved_by, note: t.note ? `\n${t.note}` : '' })}>
							<span class="flex min-w-0 items-center gap-1.5">
								<span class="truncate font-semibold">{t.name}</span>
								<span class="shrink-0 text-[0.9em] text-(--vscode-descriptionForeground)">v{t.version}</span>
								{#if t.required}<span class="shrink-0 rounded-full bg-(--vscode-badge-background) px-1.5 text-[10px] leading-4 text-(--vscode-badge-foreground)">required</span>{/if}
								<span class={['shrink-0 text-[0.9em]', TONE[st.tone]]}>{st.label}</span>
							</span>
							<span class="truncate text-[0.9em] text-(--vscode-descriptionForeground)">{t.note ?? st.detail}</span>
						</div>
						<span class="hidden shrink-0 items-center gap-0.5 group-hover/row:flex group-focus-within/row:flex">{@render actionButtons(teamActions(t))}</span>
					</div>
				{:else}
					<p class="py-1 pl-5 text-(--vscode-descriptionForeground)">
						{query ? tr('legacySettings.snapsSideView.noSearchResults') : isTeamAdmin ? tr('legacySettings.snapsSideView.noTeamApprovalsAdmin') : tr('legacySettings.snapsSideView.noTeamApprovals')}
					</p>
				{/each}
				<p class="pt-1 pl-5 text-[11px] font-bold text-(--vscode-sideBarTitle-foreground) uppercase">{tr('snapPlatform.library.title')}</p>
				{#if snaps.libraryError}
					<p role="alert" class="py-1 pr-2 pl-5 text-(--vscode-errorForeground)">{tr('snapPlatform.library.failed', { error: snaps.libraryError })}</p>
				{/if}
				{#each libraryFiltered as l (l.id)}
					{@const st = libraryStatus(l, snaps.list, snaps.library?.server ?? '')}
					{@const shown = l.latest ?? l.versions[0]}
					<div class="group/row flex items-center gap-1 py-1 pr-2 hover:bg-(--vscode-list-hoverBackground)">
						<div class="flex min-w-0 flex-1 flex-col pl-5" title={`${shown.snap_id} v${shown.version}\n${shown.published_by} · ${shown.published_at.slice(0, 10)}\nSHA-256 ${shown.sha256}`}>
							<span class="flex min-w-0 items-center gap-1.5">
								<span class="truncate font-semibold">{shown.name}</span>
								<span class="shrink-0 text-[0.9em] text-(--vscode-descriptionForeground)">v{shown.version}</span>
								<span class={['shrink-0 text-[0.9em]', TONE[st.tone]]}>{st.label}</span>
							</span>
							<span class="truncate text-[0.9em] text-(--vscode-descriptionForeground)">{l.latest ? shown.description || shown.snap_id : tr('snapPlatform.library.allYanked')}</span>
						</div>
						<span class="hidden shrink-0 items-center gap-0.5 group-hover/row:flex group-focus-within/row:flex">{@render actionButtons(libraryActions(l))}</span>
					</div>
				{:else}
					{#if !snaps.libraryError}<p class="py-1 pl-5 text-(--vscode-descriptionForeground)">{tr('snapPlatform.library.empty')}</p>{/if}
				{/each}
			{/if}
		{/if}
	</div>
</section>

{#snippet catalogRow(e: CatalogEntry)}
	{@const key = e.state === 'update' && e.installed ? snapKey(e.installed) : catalogKey(e.snap.id)}
	<div class={['flex items-start gap-2 py-1.5 pr-2 pl-3', selectedKey === key ? 'bg-(--vscode-list-inactiveSelectionBackground)' : 'hover:bg-(--vscode-list-hoverBackground)']}>
		<button class="flex min-w-0 flex-1 items-start gap-2 text-left" onclick={() => systemSettings.showSnaps(key)}>
			<span class="mt-0.5"><SnapAvatar snap={e.snap} size={34} /></span>
			<span class="flex min-w-0 flex-1 flex-col gap-px">
				<span class="flex min-w-0 items-center gap-1.5">
					<span class="truncate font-semibold">{e.snap.name}</span>
					<span class="shrink-0 text-[0.9em] text-(--vscode-descriptionForeground)">v{e.snap.version}</span>
					<span class="shrink-0 rounded-full bg-(--vscode-badge-background) px-1.5 text-[10px] leading-4 text-(--vscode-badge-foreground)">Kingu</span>
				</span>
				<span class="line-clamp-2 text-[0.9em] text-(--vscode-descriptionForeground)">{e.snap.description || e.snap.id}</span>
				{@render meta(e.snap)}
			</span>
		</button>
		<button class={[ROW_BUTTON, PRIMARY.primary]} disabled={!!snaps.busy} onclick={() => void snaps.installBuiltin(e.snap.id)}>
			{e.state === 'update' ? t('tools.snapsUi.update') : t('tools.snapsUi.install')}
		</button>
	</div>
{/snippet}
