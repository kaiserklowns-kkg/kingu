<script lang="ts">
	// The Snaps side view (VS Code's Extensions view): search, the user's snaps, this folder's repo
	// snaps, the snaps Kingu ships (Recommended) and the team's. Each row says what the snap adds
	// for you and for agents and shows the one action it needs now (Install, Trust, Set up,
	// Enable); the rest are on hover. A row opens the snap's details page (SnapsView).
	import Icon, { type IconName } from '#lib/workbench/Icon.svelte';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { team } from '#lib/team/team.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import { catalogKey, filterSnaps, isActive, isUpdatable, lockNote, missingRequirements, requirementStates, snapKey, snapStatus, type CatalogEntry, type SnapInfo } from './snapModel.ts';
	import { approvalNote, canApprove, isApprovable, missingRequired, teamSnapStatus, type TeamSnap } from './teamSnaps.ts';
	import { snaps } from './snaps.svelte.ts';
	import SnapAvatar from './SnapAvatar.svelte';

	let query = $state('');
	let open = $state({ user: true, repo: true, recommended: true, team: true });
	const get = (id: string) => settings.get(id);
	const teamItems = $derived(snaps.teamCatalog?.items ?? []);
	const teamFiltered = $derived.by(() => {
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		return teamItems.filter((t) => words.every((w) => `${t.name}\n${t.snap_id}\n${t.note ?? ''}`.toLowerCase().includes(w)));
	});
	const teamMissing = $derived(missingRequired(teamItems, snaps.list));
	const isTeamAdmin = $derived(canApprove(snaps.teamCatalog?.role));
	const filtered = $derived(filterSnaps(snaps.list, query));
	/** Shipped snaps not installed yet, or installed with a newer shipped version. */
	const recommended = $derived.by(() => {
		const ids = new Set(filterSnaps(snaps.catalog, query).map((s) => s.id));
		return snaps.recommended.filter((e) => e.state !== 'installed' && ids.has(e.snap.id));
	});
	const sections = $derived([
		{ id: 'user' as const, title: t('tools.snapsUi.installed'), list: filtered.filter((s) => s.source === 'user') },
		{ id: 'repo' as const, title: t('tools.snapsUi.thisFolder'), list: filtered.filter((s) => s.source === 'repo') }
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
		if (!s.error && (s.source === 'user' || s.trusted)) out.push(s.disabled ? { icon: 'power', label: t('tools.snapsUi.enable'), run: () => snaps.setEnabled(s.id, true) } : { icon: 'power', label: t('tools.snapsUi.disable'), run: () => snaps.setEnabled(s.id, false) });
		if (isActive(s) && s.tasks.length) out.push({ icon: 'play', label: 'Run Task…', run: () => snaps.pickTask(s) });
		if (isUpdatable(s)) out.push({ icon: 'refresh', label: 'Update', run: () => snaps.update(s.id) });
		if (isTeamAdmin && isApprovable(s)) out.push({ icon: 'account', label: 'Approve for Team…', run: () => snaps.approveForTeam(s.id) });
		if (s.source === 'user') out.push({ icon: 'trash', label: 'Uninstall', run: () => snaps.uninstall(s.id) });
		return out;
	}

	function teamActions(t: TeamSnap): Action[] {
		const st = teamSnapStatus(t, snaps.list);
		if (st.key === 'missing') return [{ icon: 'plus', label: 'Install', run: () => snaps.installTeam(t.snap_id) }];
		if (st.key === 'different') return [{ icon: 'refresh', label: 'Install Team Version', run: () => snaps.installTeam(t.snap_id) }];
		return [];
	}

	const forAgents = (s: SnapInfo) => s.mcp.length + s.skills.length + s.hooks.length;
	const forYou = (s: SnapInfo) => s.tasks.length + s.services.length;

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
			{#if sec.id === 'user' || workspace.root}
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
							{query ? t('tools.snapsUi.noMatch') : sec.id === 'user' ? t('tools.snapsUi.noneInstalled') : t('tools.snapsUi.noRepoSnaps')}
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
					ตั้งค่า <code>kingu.team.serverUrl</code> แล้วลงชื่อเข้าใช้ทีม เพื่อดู Snap ที่ทีมอนุมัติ
					<button class="text-(--vscode-textLink-foreground) hover:underline" onclick={() => systemSettings.show('Team')}>เปิดการตั้งค่าทีม</button>
				</p>
			{:else if !team.status?.signed_in}
				<p class="py-1 pr-2 pl-5 text-(--vscode-descriptionForeground)">
					ลงชื่อเข้าใช้ทีมด้วย token (kgu_…) เพื่อดู Snap ที่ทีมอนุมัติ
					<button class="text-(--vscode-textLink-foreground) hover:underline" onclick={() => team.startSignIn()}>ลงชื่อเข้าใช้ทีม</button>
				</p>
			{:else if snaps.teamError}
				<p role="alert" class="py-1 pr-2 pl-5 text-(--vscode-errorForeground)">โหลด Snap ของทีมไม่สำเร็จ: {snaps.teamError}</p>
			{:else if !snaps.teamCatalog}
				<p class="py-1 pl-5 text-(--vscode-descriptionForeground)">กำลังโหลด…</p>
			{:else}
				{#if teamMissing.length}
					<p role="status" class="mx-2 my-1 rounded-sm border border-(--vscode-widget-border) px-2 py-1 text-[0.9em] text-(--vscode-descriptionForeground)">
						<Icon name="info" size={14} />
						ทีมกำหนดให้ใช้ {teamMissing.map((t) => t.name).join(', ')} แต่เครื่องนี้ยังไม่ได้ติดตั้ง
					</p>
				{/if}
				{#each teamFiltered as t (t.snap_id)}
					{@const st = teamSnapStatus(t, snaps.list)}
					<div class="group/row flex items-center gap-2 py-1.5 pr-2 pl-3 hover:bg-(--vscode-list-hoverBackground)">
						<SnapAvatar snap={{ id: t.snap_id, name: t.name }} size={34} />
						<div class="flex min-w-0 flex-1 flex-col" title={`${t.git_url}${t.git_ref ? `#${t.git_ref}` : ''} @ ${t.commit_sha}\nอนุมัติโดย ${t.approved_by}${t.note ? `\n${t.note}` : ''}`}>
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
						{query ? 'ไม่พบ Snap ที่ตรงกับคำค้น' : isTeamAdmin ? 'ทีมยังไม่ได้อนุมัติ Snap — วางเมาส์บน Snap ที่ติดตั้งจาก git แล้วกด Approve for Team' : 'ทีมยังไม่ได้อนุมัติ Snap'}
					</p>
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
