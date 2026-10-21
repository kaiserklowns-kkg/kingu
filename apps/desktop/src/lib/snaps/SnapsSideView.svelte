<script lang="ts">
	// The Snaps side view (VS Code's Extensions view, compact): search, the user's snaps and this
	// folder's repo snaps, hover actions per row. A row opens its details page: SnapsView for one
	// snap in the system settings page.
	import Icon, { type IconName } from '#lib/workbench/Icon.svelte';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { team } from '#lib/team/team.svelte.ts';
	import { filterSnaps, isActive, isUpdatable, lockNote, snapKey, snapStatus, type SnapInfo } from './snapModel.ts';
	import { approvalNote, canApprove, isApprovable, missingRequired, teamSnapStatus, type TeamSnap } from './teamSnaps.ts';
	import { snaps } from './snaps.svelte.ts';
	import { isPublishable, libraryStatus, librarySnaps, type LibrarySnap } from './teamLibrary.ts';
	import { t as tr } from '#lib/i18n/index.ts';

	let query = $state('');
	let open = $state({ user: true, repo: true, team: true });
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
	const filtered = $derived(filterSnaps(snaps.list, query));
	const sections = $derived([
		{ id: 'user' as const, title: 'Installed (user)', list: filtered.filter((s) => s.source === 'user') },
		{ id: 'repo' as const, title: 'This folder (repo)', list: filtered.filter((s) => s.source === 'repo') }
	]);
	const selectedKey = $derived(systemSettings.visible && systemSettings.snaps ? systemSettings.snapKey : null);

	type Action = { icon: IconName; label: string; run: () => unknown };

	const toolbar: Action[] = [
		{ icon: 'plus', label: 'Install from Git…', run: () => snaps.install() },
		{ icon: 'folder', label: 'Install from Folder…', run: () => snaps.installFromFolder() },
		{ icon: 'newFile', label: 'New Snap…', run: () => snaps.newSnap() },
		{ icon: 'check', label: 'Write .kingu/snaps.lock', run: () => snaps.lock() },
		{ icon: 'refresh', label: 'Reload Snaps', run: () => snaps.load() }
	];

	function rowActions(s: SnapInfo): Action[] {
		const out: Action[] = [];
		if (s.source === 'repo' && !s.error) out.push(s.trusted ? { icon: 'close', label: 'Untrust', run: () => snaps.trust(s.id, false) } : { icon: 'check', label: 'Trust…', run: () => snaps.confirmTrust(s) });
		if (isActive(s) && s.tasks.length) out.push({ icon: 'play', label: 'Run Task…', run: () => snaps.pickTask(s) });
		if (isUpdatable(s)) out.push({ icon: 'refresh', label: 'Update', run: () => snaps.update(s.id) });
		if (isTeamAdmin && isApprovable(s)) out.push({ icon: 'account', label: 'Approve for Team…', run: () => snaps.approveForTeam(s.id) });
		if (isTeamAdmin && snaps.library && isPublishable(s, snaps.library.items)) out.push({ icon: 'publish', label: 'Publish to Team Library…', run: () => snaps.publishToLibrary(s.id, s.source) });
		if (s.source === 'user') out.push({ icon: 'trash', label: 'Uninstall', run: () => snaps.uninstall(s.id) });
		out.push({ icon: 'folder', label: 'Reveal Folder', run: () => snaps.reveal(s) });
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

	const TONE = {
		ok: 'text-(--vscode-testing-iconPassed,var(--vscode-charts-green))',
		warn: 'text-(--vscode-editorWarning-foreground)',
		error: 'text-(--vscode-errorForeground)',
		muted: 'text-(--vscode-descriptionForeground)'
	};
	const BUTTON = 'grid size-5 place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-50';
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

<section class="flex min-h-0 flex-1 flex-col">
	<div class="flex shrink-0 flex-col gap-1.5 px-2 pt-1 pb-2">
		<div class="flex items-center justify-end gap-0.5">{@render actionButtons(toolbar)}</div>
		<input
			type="search"
			aria-label="Search Snaps"
			placeholder="ค้นหา Snaps"
			bind:value={query}
			class="block h-[26px] w-full rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-1.5 text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground) focus:border-(--vscode-focusBorder)"
		/>
		{#if snaps.busy}<p class="text-xs text-(--vscode-descriptionForeground)">{snaps.busy}</p>{/if}
		{#if snaps.error}<p role="alert" class="text-xs text-(--vscode-errorForeground)">โหลด Snaps ไม่สำเร็จ: {snaps.error}</p>{/if}
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto">
		{#each sections as sec (sec.id)}
			{#if sec.id === 'user' || workspace.root}
				<div class="flex h-(--kg-row-height) shrink-0 items-center pr-2 text-[11px] font-bold text-(--vscode-sideBarTitle-foreground) uppercase hover:bg-(--vscode-list-hoverBackground)">
					<button class="flex h-full min-w-0 flex-1 items-center gap-0.5 pl-0.5 text-left" aria-expanded={open[sec.id]} onclick={() => (open[sec.id] = !open[sec.id])}>
						<Icon name={open[sec.id] ? 'chevronDown' : 'chevronRight'} size={16} />
						<span class="truncate">{sec.title}</span>
					</button>
					<span class="ml-1 min-w-[18px] rounded-full bg-(--vscode-badge-background) px-1.5 text-center text-[11px] leading-[18px] font-normal text-(--vscode-badge-foreground)">{sec.list.length}</span>
				</div>
				{#if open[sec.id]}
					{#each sec.list as s (snapKey(s))}
						{@const st = snapStatus(s)}
						{@const lock = lockNote(s)}
						{@const approved = approvalNote(s, teamItems)}
						<div
							class={[
								'group/row flex items-center gap-1 py-1 pr-2',
								selectedKey === snapKey(s) ? 'bg-(--vscode-list-inactiveSelectionBackground)' : 'hover:bg-(--vscode-list-hoverBackground)'
							]}
						>
							<button class="flex min-w-0 flex-1 flex-col pl-5 text-left" title={s.dir} onclick={() => systemSettings.showSnaps(snapKey(s))}>
								<span class="flex min-w-0 items-center gap-1.5">
									<span class="truncate font-semibold">{s.name}</span>
									{#if s.version}<span class="shrink-0 text-[0.9em] text-(--vscode-descriptionForeground)">v{s.version}</span>{/if}
									<span class="shrink-0 rounded-full bg-(--vscode-badge-background) px-1.5 text-[10px] leading-4 text-(--vscode-badge-foreground)">{s.source}</span>
									<span class={['shrink-0 text-[0.9em]', TONE[st.tone]]}>{st.label}</span>
									{#if lock}<span class="shrink-0 text-[0.9em] text-(--vscode-editorWarning-foreground)" title=".kingu/snaps.lock">{lock}</span>{/if}
									{#if approved}<span class="shrink-0 text-[0.9em] text-(--vscode-descriptionForeground)">{approved}</span>{/if}
								</span>
								<span class="truncate text-[0.9em] text-(--vscode-descriptionForeground)">{s.error ?? (s.description || s.id)}</span>
							</button>
							<span class="hidden shrink-0 items-center gap-0.5 group-hover/row:flex group-focus-within/row:flex">{@render actionButtons(rowActions(s))}</span>
						</div>
					{:else}
						<p class="py-1 pl-5 text-(--vscode-descriptionForeground)">
							{query ? 'ไม่พบ Snap ที่ตรงกับคำค้น' : sec.id === 'user' ? 'ยังไม่มี — ติดตั้งจาก git, จากโฟลเดอร์ หรือสร้างใหม่' : 'โฟลเดอร์นี้ไม่มี .kingu/snaps'}
						</p>
					{/each}
				{/if}
			{/if}
		{/each}

		<div class="flex h-(--kg-row-height) shrink-0 items-center pr-2 text-[11px] font-bold text-(--vscode-sideBarTitle-foreground) uppercase hover:bg-(--vscode-list-hoverBackground)">
			<button class="flex h-full min-w-0 flex-1 items-center gap-0.5 pl-0.5 text-left" aria-expanded={open.team} onclick={() => (open.team = !open.team)}>
				<Icon name={open.team ? 'chevronDown' : 'chevronRight'} size={16} />
				<span class="truncate">Team (ทีม)</span>
			</button>
			{#if snaps.teamCatalog}<span class="ml-1 min-w-[18px] rounded-full bg-(--vscode-badge-background) px-1.5 text-center text-[11px] leading-[18px] font-normal text-(--vscode-badge-foreground)">{teamItems.length}</span>{/if}
		</div>
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
					<div class="group/row flex items-center gap-1 py-1 pr-2 hover:bg-(--vscode-list-hoverBackground)">
						<div class="flex min-w-0 flex-1 flex-col pl-5" title={`${t.git_url}${t.git_ref ? `#${t.git_ref}` : ''} @ ${t.commit_sha}\nอนุมัติโดย ${t.approved_by}${t.note ? `\n${t.note}` : ''}`}>
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
