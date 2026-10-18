<script lang="ts">
	// The Snaps side view (VS Code's Extensions view, compact): search, the user's snaps and this
	// folder's repo snaps, hover actions per row. A row opens its details page: SnapsView for one
	// snap in the system settings page.
	import Icon, { type IconName } from '#lib/workbench/Icon.svelte';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { filterSnaps, isActive, isUpdatable, lockNote, snapKey, snapStatus, type SnapInfo } from './snapModel.ts';
	import { snaps } from './snaps.svelte.ts';

	let query = $state('');
	let open = $state({ user: true, repo: true });
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
		if (s.source === 'user') out.push({ icon: 'trash', label: 'Uninstall', run: () => snaps.uninstall(s.id) });
		out.push({ icon: 'folder', label: 'Reveal Folder', run: () => snaps.reveal(s) });
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
	</div>
</section>
