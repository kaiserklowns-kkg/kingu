<script lang="ts">
	// The Agents layout side bar, built like Orca's worktree sidebar: Search (the worktree jump
	// palette) and Tasks (the board) on top, a "Projects" header with the activity view, workspace
	// options, add project and new workspace, then the folder as a project group with a card per
	// worktree (status slot, title, branch, the agent row with its last message and time), and a
	// footer with Settings, Help, Reveal active workspace and the board.
	import { untrack } from 'svelte';
	import Icon, { type IconName } from '#lib/workbench/Icon.svelte';
	import ProviderIcon from '#lib/workbench/ProviderIcon.svelte';
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import type { MenuNode } from '#lib/workbench/menus.ts';
	import { commands } from '#lib/workbench/commands.svelte.ts';
	import { appMode } from '#lib/workbench/mode.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import { invoke } from '@tauri-apps/api/core';
	import { adeLayout, PRIMARY } from './adeLayout.svelte';
	import { worktreeDir } from './keys';
	import { COLUMNS, STATUS_LABEL, type TaskView } from './model';
	import { adeTasks } from './tasks.svelte';
	import { cleanup } from './cleanup.svelte';
	import { newSession } from './agentsMode.svelte';
	import { jumpToWorktree, renameTask } from './worktreeMenu.svelte';
	import { activeFilterCount, cardStatus, CARD_STATUS_LABEL, reorder, shortAgo, SORT_LABEL, sortItems, statusColumn, type CardStatus, type GroupBy, type SortBy } from './sidebarModel';
	import { sidebarPrefs as prefs } from './sidebarPrefs.svelte';

	const root = $derived(workspace.root ?? '');
	const now = $derived(adeTasks.now);
	const selectedKey = $derived(adeLayout.board ? null : adeLayout.key);

	// --- Rows ---------------------------------------------------------------------------------
	type Row = { key: string; title: string; branch: string; view?: TaskView; created: number; activity: number };
	const lastActivity = (v: TaskView) => Math.max(v.meta.updated_at, v.runtime?.updatedAt ?? 0, v.meta.last_run?.at ?? 0);
	const primaryRow = $derived<Row>({ key: PRIMARY, title: workspace.name ?? '', branch: status.branch || 'HEAD', created: 0, activity: 0 });
	const taskRows = $derived<Row[]>(
		adeTasks.views
			.filter((v) => !(prefs.filters.hideSleeping && v.status === 'done'))
			.map((v) => ({ key: v.meta.slug, title: v.meta.title, branch: `kingu/${v.meta.slug}`, view: v, created: v.meta.created_at, activity: lastActivity(v) }))
	);
	const sorted = $derived(
		sortItems(
			taskRows.map((r) => ({ ...r, slug: r.key, status: r.view!.status, createdAt: r.created, lastActivityAt: r.activity })),
			prefs.sortBy,
			now,
			prefs.manual(root)
		)
	);
	const showPrimary = $derived(!prefs.filters.hideDefault && !(prefs.filters.hideSleeping && !prefs.filters.exceptDefault && !(adeLayout.terminals[PRIMARY]?.length ?? 0)));
	const pinned = $derived(prefs.pinned(root).map((k) => (k === PRIMARY ? primaryRow : sorted.find((r) => r.key === k))).filter((r): r is Row => !!r));

	type Group = { id: string; label: string; icon: IconName; tone?: string; rows: Row[]; repo?: boolean };
	const groups = $derived.by((): Group[] => {
		const out: Group[] = [];
		if (pinned.length) out.push({ id: 'pinned', label: 'Pinned', icon: 'pin', rows: pinned });
		const all = [...(showPrimary ? [primaryRow] : []), ...sorted];
		if (prefs.groupBy === 'repo') out.push({ id: `repo:${root}`, label: workspace.name ?? '', icon: 'folder', rows: all, repo: true });
		else if (prefs.groupBy === 'status')
			for (const c of COLUMNS) {
				const rows = all.filter((r) => (r.view ? statusColumn(r.view.status) : 'active') === c.id);
				if (rows.length) out.push({ id: `status:${c.id}`, label: c.label, icon: c.id === 'attention' ? 'bell' : c.id === 'active' ? 'activity' : 'checkCircle', rows });
			}
		else out.push({ id: 'all', label: '', icon: 'menu', rows: all });
		return out;
	});
	/** Every card in display order, for arrow-key navigation. */
	const order = $derived(groups.flatMap((g) => (prefs.isCollapsed(g.id) ? [] : g.rows.map((r) => r.key))).filter((k, i, a) => a.indexOf(k) === i));

	// --- State per card ------------------------------------------------------------------------
	function stateOf(r: Row): CardStatus {
		const tabs = (adeLayout.terminals[r.key]?.length ?? 0) > 0;
		return r.view ? cardStatus(r.view.status, !!r.view.runtime?.working, tabs) : tabs ? 'active' : 'inactive';
	}
	function isUnread(r: Row): boolean {
		if (prefs.markedUnread(root).includes(r.key)) return true;
		if (!r.view) return false;
		const s = adeTasks.stateOf(r.view);
		return !!s.finishedAt && s.finishedAt > (s.viewedAt ?? 0);
	}
	function setUnread(key: string, on: boolean) {
		prefs.setMarkedUnread(root, key, on);
		if (!on) appMode.markViewed(key);
		else if (appMode.viewedAt[key]) delete appMode.viewedAt[key];
	}
	function activate(key: string) {
		adeLayout.board = false;
		adeLayout.show(key);
		if (prefs.markedUnread(root).includes(key)) prefs.setMarkedUnread(root, key, false);
	}
	const agentText = (v: TaskView) => v.runtime?.lastEvent ?? v.meta.last_run?.summary ?? STATUS_LABEL[v.status];
	const agentName = (v: TaskView) => (v.meta.agent ? v.meta.agent.charAt(0).toUpperCase() + v.meta.agent.slice(1) : 'Agent');

	// --- Alt held: the quick delete button (Orca) --------------------------------------------
	let altHeld = $state(false);
	const onKey = (e: KeyboardEvent) => (altHeld = e.altKey);

	// --- Inline rename --------------------------------------------------------------------------
	let renaming = $state<string | null>(null);
	let renameValue = $state('');
	function beginRename(r: Row) {
		if (!r.view) return;
		renaming = r.key;
		renameValue = r.title;
	}
	async function commitRename(key: string) {
		const v = renameValue.trim();
		const current = adeTasks.find(key)?.meta.title;
		renaming = null;
		if (!v || v === current) return;
		try {
			await adeTasks.rename(key, v);
		} catch {
			status.error('Failed to rename workspace.');
		}
	}

	// --- Context menu -------------------------------------------------------------------------
	let menu = $state<{ key: string; x: number; y: number } | null>(null);
	const menuItems = $derived.by((): MenuNode[] => {
		if (!menu) return [];
		const key = menu.key;
		const v = adeTasks.find(key);
		const isPinned = prefs.pinned(root).includes(key);
		const unread = isUnread(key === PRIMARY ? primaryRow : (sorted.find((r) => r.key === key) ?? primaryRow));
		const hasPanels = (adeLayout.terminals[key]?.length ?? 0) + (adeLayout.files[key]?.length ?? 0) > 0;
		return [
			menuItem('label', 'Workspace', { enabled: false }),
			menuItem('update', 'Update', { enabled: !!v }),
			{ type: 'submenu', id: 'status', text: 'Move to Status', items: v ? [menuItem('status:done', 'เสร็จแล้ว (Done)', { checked: v.status === 'done', enabled: v.status !== 'done' }), menuItem('status:reopen', 'เปิดใหม่ (Reopen)', { enabled: v.status === 'done' })] : [menuItem('none', 'ไม่มีสถานะ', { enabled: false })] },
			menuSeparator,
			{ type: 'submenu', id: 'openIn', text: 'Open in', items: [menuItem('finder', 'Finder')] },
			menuItem('copyPath', 'Copy Path'),
			menuItem('copyName', 'Copy Worktree Name'),
			menuSeparator,
			menuItem(isPinned ? 'unpin' : 'pin', isPinned ? 'Unpin' : 'Pin'),
			menuItem(unread ? 'markRead' : 'markUnread', unread ? 'Mark Read' : 'Mark Unread'),
			menuSeparator,
			menuItem('sleep', 'Sleep', { enabled: hasPanels }),
			key === PRIMARY ? menuItem('noDelete', 'Delete Worktree', { enabled: false }) : menuItem('delete', 'Delete', { keyLabel: '⇧⌘⌫' })
		];
	});
	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
		status.flash('คัดลอกแล้ว', 2000);
	}
	const pathOf = (key: string) => (key === PRIMARY ? root : `${root}/${worktreeDir(key)}`);
	function runMenu(id: string, key: string) {
		switch (id) {
			case 'update':
				return void renameTask(key);
			case 'status:done':
				return void adeTasks.markDone(key);
			case 'status:reopen':
				return void adeTasks.markDone(key, false);
			case 'finder':
				return void invoke('fs_reveal', { rel: key === PRIMARY ? '' : worktreeDir(key) }).catch((e) => status.error(String(e)));
			case 'copyPath':
				return void copy(pathOf(key));
			case 'copyName':
				return void copy(key === PRIMARY ? (status.branch ?? '') : `kingu/${key}`);
			case 'pin':
			case 'unpin':
				return prefs.setPinned(root, key, id === 'pin');
			case 'markRead':
			case 'markUnread':
				return setUnread(key, id === 'markUnread');
			case 'sleep':
				// Closes the worktree's terminals and tabs; its folder, branch and agent session stay.
				return adeLayout.drop(key);
			case 'delete':
				return void adeTasks.remove(key);
		}
	}
	function openMenu(key: string, e: MouseEvent) {
		e.preventDefault();
		menu = { key, x: e.clientX, y: e.clientY };
	}

	// --- Drag to reorder (Orca switches the sort to Manual) ------------------------------------
	let dragging = $state<string | null>(null);
	let dropBefore = $state<string | null>(null);
	function drop(before: string | null) {
		const slug = dragging;
		dragging = dropBefore = null;
		if (!slug || slug === PRIMARY || slug === before) return;
		const visible = sorted.map((r) => r.key);
		prefs.setManual(root, reorder(visible, slug, before === PRIMARY ? (visible[0] ?? null) : before));
		if (prefs.sortBy !== 'manual') {
			const previous = prefs.sortBy;
			prefs.sortBy = 'manual';
			status.flash(`Sort changed to Manual · Manual keeps workspaces where you drop them. (เดิม: ${SORT_LABEL[previous]})`, 8000);
		}
	}

	// --- Keyboard: arrows move and activate (Orca's listbox) -----------------------------------
	let list: HTMLDivElement | undefined = $state();
	function move(delta: number) {
		if (!order.length) return;
		const i = selectedKey ? order.indexOf(selectedKey) : -1;
		const next = order[Math.max(0, Math.min(order.length - 1, i < 0 ? 0 : i + delta))];
		activate(next);
		queueMicrotask(() => list?.querySelector(`[data-worktree-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' }));
	}
	function onListKey(e: KeyboardEvent) {
		if (e.target !== e.currentTarget) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			move(e.key === 'ArrowDown' ? 1 : -1);
		}
	}
	// Registered once (register reads and writes the command list, so not tracked).
	$effect(() => {
		const off = untrack(() => [
			commands.register({ id: 'kingu.agents.worktreeDown', title: 'Next Worktree', category: 'Agents', key: 'cmd+shift+down', when: () => appMode.isAgents, run: () => move(1) }),
			commands.register({ id: 'kingu.agents.worktreeUp', title: 'Previous Worktree', category: 'Agents', key: 'cmd+shift+up', when: () => appMode.isAgents, run: () => move(-1) }),
			commands.register({
				id: 'kingu.agents.deleteWorkspace',
				title: 'Delete Workspace',
				category: 'Agents',
				key: 'cmd+shift+backspace',
				when: () => appMode.isAgents && !!selectedKey && selectedKey !== PRIMARY,
				run: () => selectedKey && void adeTasks.remove(selectedKey)
			}),
			commands.register({ id: 'kingu.agents.focusWorktreeList', title: 'Focus Worktree List', category: 'Agents', key: 'cmd+shift+0', when: () => appMode.isAgents, run: () => list?.focus() })
		]);
		return () => off.forEach((u) => u());
	});

	// --- Reveal active workspace ---------------------------------------------------------------
	let revealed = $state<string | null>(null);
	function reveal() {
		const key = selectedKey ?? PRIMARY;
		const g = groups.find((g) => g.rows.some((r) => r.key === key));
		if (g && prefs.isCollapsed(g.id)) prefs.toggleCollapsed(g.id);
		revealed = key;
		queueMicrotask(() => list?.querySelector(`[data-worktree-id="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'center' }));
		setTimeout(() => (revealed = null), 1500);
	}

	// --- Header, options and footer menus ------------------------------------------------------
	let options = $state<{ x: number; y: number } | null>(null);
	let repoMenu = $state<{ x: number; y: number } | null>(null);
	let help = $state<{ x: number; y: number } | null>(null);
	const filterCount = $derived(activeFilterCount(prefs.filters));
	const repoItems: MenuNode[] = [menuItem('settings', 'Project Settings'), menuItem('reveal', 'Reveal in Finder'), menuSeparator, menuItem('remove', 'Remove Project')];
	function runRepo(id: string) {
		if (id === 'settings') systemSettings.show();
		else if (id === 'reveal') void invoke('fs_reveal', { rel: '' }).catch((e) => status.error(String(e)));
		else if (id === 'remove') commands.run('workbench.action.closeFolder');
	}
	const helpItems: MenuNode[] = [menuItem('shortcuts', 'Keyboard Shortcuts'), menuSeparator, menuItem('about', 'About Kingu')];
	function newWorkspace() {
		adeLayout.show(PRIMARY);
		adeLayout.select(PRIMARY, 'main');
		newSession();
	}
	$effect(() => {
		// Keep the selection's group open when the selection changes from outside (palette, board).
		const key = selectedKey;
		if (!key) return;
		untrack(() => {
			const g = groups.find((g) => g.rows.some((r) => r.key === key));
			if (g && prefs.isCollapsed(g.id)) prefs.toggleCollapsed(g.id);
		});
	});

	const NAV = 'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors';
	const NAV_OFF = 'text-(--vscode-sideBar-foreground)/60 hover:bg-(--vscode-sideBar-foreground)/8';
	const NAV_ON = 'bg-(--vscode-list-inactiveSelectionBackground) text-(--vscode-foreground)';
	const HEADER_BTN = 'grid size-6 place-items-center rounded-md text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:opacity-40';
	const REVEAL = 'grid size-5 max-w-0 -ml-1.5 place-items-center overflow-hidden rounded-md text-(--vscode-descriptionForeground) opacity-0 transition-all group-hover/header:ml-0 group-hover/header:max-w-5 group-hover/header:opacity-100 hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) focus-visible:ml-0 focus-visible:max-w-5 focus-visible:opacity-100';
	const MUTED = 'text-(--vscode-descriptionForeground)';
	const SEG = 'h-6 grow basis-0 rounded px-1 text-[10px]';
</script>

<svelte:window onkeydown={onKey} onkeyup={onKey} onblur={() => (altHeld = false)} />

{#snippet statusDot(s: CardStatus, size = 'size-2')}
	{#if s === 'working'}
		<span class="size-2.5 animate-spin rounded-full border-2 border-yellow-500 border-t-transparent"></span>
	{:else if s === 'permission'}
		<span class="text-violet-400"><Icon name="question" size={12} filled /></span>
	{:else if s === 'failed'}
		<span class="size-1.5 rounded-full bg-red-500"></span>
	{:else if s === 'done' || s === 'active'}
		<span class={[size, 'rounded-full bg-emerald-500']}></span>
	{:else}
		<span class={[size, 'rounded-full bg-neutral-500/40']}></span>
	{/if}
{/snippet}

{#snippet card(r: Row, groupId: string)}
	{@const s = stateOf(r)}
	{@const active = selectedKey === r.key}
	{@const unread = isUnread(r)}
	{@const secondary = active && groupId !== 'pinned' && prefs.pinned(root).includes(r.key)}
	<div role="option" aria-selected={active} aria-current={active ? 'page' : undefined} data-worktree-id={r.key} class={['relative px-1 pb-1', dragging === r.key && 'opacity-0']}>
		{#if dropBefore === r.key}<div class="absolute inset-x-2 -top-px h-0.5 rounded-full bg-(--vscode-focusBorder)"></div>{/if}
		<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
		<div
			draggable={renaming !== r.key && r.key !== PRIMARY}
			class={[
				'group/worktree-card relative ml-1 flex cursor-pointer flex-col rounded-lg border pr-1.5 pl-1.5 transition-[background-color,border-color,box-shadow] duration-200 select-none',
				prefs.compact ? 'py-2' : 'pt-1.25 pb-1.5',
				active && !secondary
					? 'border-(--vscode-foreground)/18 bg-(--vscode-foreground)/10 shadow-[0_1px_2px_rgb(255_255_255/0.03)]'
					: secondary
						? 'border-(--vscode-focusBorder)/25 bg-(--vscode-list-inactiveSelectionBackground)/45'
						: 'border-transparent hover:bg-(--vscode-list-hoverBackground)/60',
				revealed === r.key && 'ring-[1.5px] ring-(--vscode-focusBorder)/70'
			]}
			onclick={() => activate(r.key)}
			ondblclick={() => r.view && void renameTask(r.key)}
			oncontextmenu={(e) => openMenu(r.key, e)}
			ondragstart={(e) => ((dragging = r.key), e.dataTransfer?.setData('text/plain', r.key))}
			ondragend={() => (dragging = dropBefore = null)}
			ondragover={(e) => dragging && dragging !== r.key && (e.preventDefault(), (dropBefore = r.key))}
			ondrop={(e) => (e.preventDefault(), drop(r.key))}
		>
			<div class={['flex w-full min-w-0 gap-0.5', prefs.compact ? 'items-center' : 'items-start']}>
				<!-- Status slot: the unread bell, else the status dot (hover shows a faint bell to mark unread). -->
				<button
					class="group/status mt-[2px] grid size-4 shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground) active:scale-95"
					aria-label={unread ? 'Mark as read' : 'Mark as unread'}
					title="{CARD_STATUS_LABEL[s] ? `${CARD_STATUS_LABEL[s]} · ` : ''}{unread ? 'Mark read' : 'Mark unread'}"
					onclick={(e) => (e.stopPropagation(), setUnread(r.key, !unread))}
					ondblclick={(e) => e.stopPropagation()}
				>
					{#if unread}
						<span class="text-amber-400 drop-shadow-sm"><Icon name="bell" size={13} filled /></span>
					{:else}
						<span class="grid place-items-center group-hover/status:hidden">{@render statusDot(s)}</span>
						<span class="hidden text-(--vscode-descriptionForeground)/40 group-hover/status:block"><Icon name="bell" size={12} /></span>
					{/if}
				</button>
				<div class="flex min-w-0 flex-1 flex-col gap-1.5 pl-1">
					<div class="flex min-w-0 items-center justify-between gap-2">
						<div class="flex min-w-0 flex-1 items-center gap-1.5">
							{#if groupId === 'pinned' || prefs.groupBy !== 'repo'}
								<span class="grid size-4 shrink-0 place-items-center rounded-[4px] border border-(--vscode-widget-border) bg-(--vscode-list-inactiveSelectionBackground)/55" title={workspace.name}><Icon name="folder" size={11} /></span>
							{/if}
							{#if renaming === r.key}
								<!-- svelte-ignore a11y_autofocus -->
								<input
									class="h-5 min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] leading-5 outline-none"
									aria-label="Rename workspace"
									autofocus
									bind:value={renameValue}
									onclick={(e) => e.stopPropagation()}
									onkeydown={(e) => (e.key === 'Enter' ? void commitRename(r.key) : e.key === 'Escape' ? (renaming = null) : undefined)}
									onblur={() => void commitRename(r.key)}
									onfocus={(e) => e.currentTarget.select()}
								/>
							{:else}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<span class={['truncate text-[13px] leading-5', unread ? 'font-semibold text-(--vscode-foreground)' : 'font-normal text-(--vscode-foreground)']} title={r.title} ondblclick={(e) => (e.stopPropagation(), beginRename(r))}>
									{#if unread}<span class="sr-only">Unread: </span>{/if}{r.title}
								</span>
							{/if}
							{#if r.key === PRIMARY && !prefs.compact}
								<span class="h-4 shrink-0 rounded border border-(--vscode-foreground)/20 bg-(--vscode-foreground)/[0.06] px-1.5 text-[10px] leading-[14px] font-medium text-(--vscode-foreground)/70" title="Primary worktree (original clone directory)">primary</span>
							{/if}
						</div>
						<div class="ml-auto flex shrink-0 items-center gap-1">
							{#if r.key === PRIMARY && prefs.compact}
								<span class="text-amber-400" aria-label="Primary worktree"><Icon name="kingu" size={12} /></span>
							{/if}
							{#if altHeld && r.key !== PRIMARY}
								<button
									class="grid size-4 place-items-center rounded opacity-0 group-focus-within/worktree-card:opacity-100 group-hover/worktree-card:opacity-100 hover:bg-red-500/10 hover:text-red-400"
									aria-label="Delete workspace"
									title="Delete workspace"
									onclick={(e) => (e.stopPropagation(), void adeTasks.remove(r.key))}><Icon name="trash" size={13} /></button
								>
							{/if}
						</div>
					</div>
					{#if !prefs.compact}
						<div class="flex min-w-0 items-center gap-1.5">
							<span class="truncate text-[11px] leading-none {MUTED}" title={r.branch}>{r.branch}</span>
						</div>
						{#if r.view && (r.view.runtime || r.view.meta.last_run)}
							{@const v = r.view}
							<!-- Orca's inline agent row: state, agent, "agent - last message", model, time. -->
							<div class="flex h-6 items-center gap-1 rounded-sm px-1 text-[11px] leading-none {MUTED} hover:bg-(--vscode-list-hoverBackground)">
								<span class="grid size-3 shrink-0 place-items-center">{@render statusDot(s, 'size-1.5')}</span>
								<span class="shrink-0">{#if v.meta.agent === 'codex'}<ProviderIcon provider="codex" />{:else}<ProviderIcon provider="claude" />{/if}</span>
								<span class={['min-w-0 flex-1 truncate', unread ? 'font-semibold text-(--vscode-foreground)' : 'text-(--vscode-descriptionForeground)/90']}>
									{agentName(v)}<span class="opacity-65"> - {agentText(v)}</span>
								</span>
								{#if v.runtime?.model ?? v.meta.model}<span class="max-w-24 shrink-0 truncate font-mono text-[10px] opacity-80">{v.runtime?.model ?? v.meta.model}</span>{/if}
								<span class="shrink-0 text-[10px] tabular-nums opacity-60">{shortAgo(r.activity, now)}</span>
							</div>
						{/if}
					{/if}
				</div>
			</div>
		</div>
	</div>
{/snippet}

<div class="flex h-full min-h-0 flex-col bg-(--vscode-sideBar-background) text-(--vscode-sideBar-foreground)">
	<!-- Top nav: Search (the worktree palette) and Tasks (the board). -->
	<nav class="flex flex-col gap-0.5 px-2 pt-2 pb-1">
		<button class="{NAV} bg-(--vscode-sideBar-foreground)/5 {NAV_OFF}" aria-label="Search worktrees" onclick={jumpToWorktree}>
			<span class="text-(--vscode-sideBar-foreground)/30"><Icon name="search" size={16} /></span>
			<span class="flex-1">Search</span>
			<span class="hidden gap-0.5 group-hover:flex group-focus-visible:flex">
				{#each ['⇧', '⌘', 'J'] as k (k)}<kbd class="min-w-4 rounded border border-(--vscode-widget-border) bg-(--vscode-sideBar-foreground)/8 px-1 py-px text-center font-sans text-[9px] text-(--vscode-sideBar-foreground)/55">{k}</kbd>{/each}
			</span>
		</button>
		<button class="{NAV} {adeLayout.board ? NAV_ON : NAV_OFF}" aria-current={adeLayout.board ? 'page' : undefined} onclick={() => (adeLayout.board = true)}>
			<span class={adeLayout.board ? '' : 'text-(--vscode-sideBar-foreground)/30'}><Icon name="menu" size={16} /></span>
			<span class="flex-1">Tasks</span>
		</button>
	</nav>

	<!-- Section header: "Projects" with the activity view, options, add project, new workspace. -->
	<div class="mt-2 flex h-8 min-w-0 shrink-0 items-center justify-between gap-1.5 px-2">
		<span class="min-w-0 truncate pr-0.5 pl-2 text-xs font-semibold select-none {MUTED}">{prefs.groupBy === 'repo' ? 'Projects' : 'Workspaces'}</span>
		<div class="flex shrink-0 items-center gap-1">
			<button class={[HEADER_BTN, prefs.activity && 'bg-(--vscode-focusBorder)/15 text-(--vscode-focusBorder)']} aria-label={prefs.activity ? 'Turn off activity view' : 'View activity'} title={prefs.activity ? 'Turn off activity view' : 'View activity'} onclick={() => (prefs.activity = !prefs.activity)}>
				<Icon name="bell" size={14} />
			</button>
			{#if !prefs.activity}
				<button
					class="{HEADER_BTN} relative"
					aria-label={filterCount ? `Workspace options (${filterCount} active)` : 'Workspace options'}
					title={filterCount ? `Workspace options (${filterCount} active)` : 'Workspace options'}
					onclick={(e) => {
						const r = e.currentTarget.getBoundingClientRect();
						options = options ? null : { x: r.right + 8, y: r.top };
					}}
				>
					<Icon name="sliders" size={14} />
					{#if filterCount}<span class="absolute -top-0.5 -right-0.5 grid size-3 place-items-center rounded-full bg-(--vscode-focusBorder) text-[8px] font-semibold text-white">{filterCount}</span>{/if}
				</button>
			{/if}
			<button class={HEADER_BTN} aria-label="Add project" title="Add project" onclick={() => commands.run('workbench.action.files.openFolder')}><Icon name="newFolder" size={14} /></button>
			<button class={HEADER_BTN} aria-label="New workspace" title="New workspace" disabled={!workspace.root} onclick={newWorkspace}><Icon name="plus" size={15} /></button>
		</div>
	</div>

	<div
		bind:this={list}
		role="listbox"
		aria-label="Worktrees"
		tabindex="0"
		class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-px pl-1 outline-none focus-visible:ring-1 focus-visible:ring-(--vscode-focusBorder) focus-visible:ring-inset"
		onkeydown={onListKey}
		ondragover={(e) => dragging && e.preventDefault()}
		ondrop={(e) => (e.preventDefault(), drop(null))}
	>
		{#if !workspace.root}
			<div class="space-y-2 px-4 py-6 text-center text-[11px] {MUTED}">
				<p>No workspaces found</p>
				<button class="text-(--vscode-textLink-foreground) hover:underline" onclick={() => commands.run('workbench.action.files.openFolder')}>Add project</button>
			</div>
		{:else if prefs.activity}
			<!-- Activity view: every agent session, the ones that need you first. -->
			{#each sortItems(taskRows.map((r) => ({ ...r, slug: r.key, status: r.view!.status, createdAt: r.created, lastActivityAt: r.activity })), 'smart', now) as r (r.key)}
				{@const s = stateOf(r)}
				<button class={['flex h-7 w-[calc(100%-8px)] items-center gap-1.5 rounded-md px-2 text-left text-[12px] hover:bg-(--vscode-list-hoverBackground)', selectedKey === r.key && 'bg-(--vscode-foreground)/10']} onclick={() => activate(r.key)}>
					<span class="grid size-3 shrink-0 place-items-center">{@render statusDot(s, 'size-1.5')}</span>
					<span class="min-w-0 flex-1 truncate">{r.title}<span class="opacity-60"> - {agentText(r.view!)}</span></span>
					<span class="shrink-0 text-[10px] opacity-60">{shortAgo(r.activity, now)}</span>
				</button>
			{:else}
				<p class="px-4 py-6 text-center text-[11px] {MUTED}">No agent activity yet</p>
			{/each}
		{:else}
			{#each groups as g, gi (g.id)}
				{@const collapsed = prefs.isCollapsed(g.id)}
				{#if g.id !== 'all'}
					<div class={['sticky -top-px z-20 bg-(--vscode-sideBar-background)', gi > 0 && 'pt-1']}>
						<div
							role="button"
							tabindex="0"
							aria-expanded={!collapsed}
							class="group/header relative flex h-7 w-full cursor-pointer items-center gap-1.5 pr-2 pl-2.5 text-left"
							onclick={() => prefs.toggleCollapsed(g.id)}
							onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), prefs.toggleCollapsed(g.id))}
						>
							<span class={['grid size-4 shrink-0 place-items-center rounded-[4px]', g.repo ? 'bg-amber-500/15 text-amber-400' : MUTED]}><Icon name={g.icon} size={12} /></span>
							<span class="truncate text-[13px] leading-none font-semibold">{g.label}</span>
							<span class="ml-auto flex items-center">
								{#if g.repo}
									<button
										class={REVEAL}
										aria-label="Project actions for {g.label}"
										title="Project actions"
										onclick={(e) => {
											e.stopPropagation();
											const rr = e.currentTarget.getBoundingClientRect();
											repoMenu = { x: rr.right - 248, y: rr.bottom + 6 };
										}}><Icon name="more" size={14} /></button
									>
									<button class={REVEAL} aria-label="Create workspace for {g.label}" title="Create workspace for {g.label}" onclick={(e) => (e.stopPropagation(), newWorkspace())}><Icon name="plus" size={12} /></button>
								{/if}
								<span class={['grid size-5 place-items-center rounded-md transition-transform hover:bg-(--vscode-toolbar-hoverBackground)', collapsed && '-rotate-90']}><Icon name="chevronDown" size={14} /></span>
							</span>
						</div>
					</div>
				{/if}
				{#if !collapsed}
					{#each g.rows as r (r.key)}{@render card(r, g.id)}{/each}
				{/if}
			{/each}
			{#if !order.length && !groups.some((g) => g.rows.length)}
				<div class="px-4 py-6 text-center text-[11px] {MUTED}">
					<p>No workspaces found</p>
					{#if filterCount}<button class="mt-2 inline-flex items-center gap-1 rounded-md bg-(--vscode-button-secondaryBackground) px-2 py-1 text-(--vscode-button-secondaryForeground)" onclick={() => prefs.clearFilters()}><Icon name="error" size={12} />Clear Filters</button>{/if}
				</div>
			{/if}
		{/if}
	</div>

	<!-- Footer: Settings and Help on the left; Reveal active workspace and the board on the right. -->
	<div class="flex shrink-0 items-center justify-between border-t border-(--vscode-widget-border) px-2 py-1.5">
		<div class="flex items-center gap-1">
			<button class={HEADER_BTN} aria-label="Settings" title="Settings (⌘,)" onclick={() => systemSettings.show()}><Icon name="settings" size={14} /></button>
			<button
				class={HEADER_BTN}
				aria-label="Help"
				title="Help"
				onclick={(e) => {
					const rr = e.currentTarget.getBoundingClientRect();
					help = { x: rr.left, y: rr.top - 8 - 22 * 3 - 12 };
				}}><Icon name="help" size={14} /></button
			>
		</div>
		<div class="flex items-center gap-1">
			<button class={HEADER_BTN} aria-label="Reveal active workspace" title="Reveal active workspace" onclick={reveal}><Icon name="crosshair" size={14} /></button>
			<button class={[HEADER_BTN, adeLayout.board && 'bg-(--vscode-toolbar-activeBackground,#ffffff1f) text-(--vscode-foreground)']} aria-pressed={adeLayout.board} aria-label="Workspace board" title={adeLayout.board ? 'Close workspace board' : 'Workspace board'} onclick={() => (adeLayout.board = !adeLayout.board)}>
				<Icon name="tasks" size={14} />
			</button>
		</div>
	</div>
</div>

{#if menu}
	{@const key = menu.key}
	<PopupMenu items={menuItems} label="Workspace" x={menu.x} y={menu.y} onRun={(node) => node.type === 'item' && runMenu(node.id, key)} onClose={() => (menu = null)} />
{/if}
{#if repoMenu}
	<PopupMenu items={repoItems} label="Project actions" x={repoMenu.x} y={repoMenu.y} onRun={(node) => node.type === 'item' && runRepo(node.id)} onClose={() => (repoMenu = null)} />
{/if}
{#if help}
	<PopupMenu items={helpItems} label="Help" x={help.x} y={help.y} onRun={(node) => node.type === 'item' && systemSettings.showPage(node.id === 'shortcuts' ? 'shortcuts' : 'about')} onClose={() => (help = null)} />
{/if}
{#if options}
	<div class="fixed inset-0 z-40" role="presentation" onpointerdown={() => (options = null)}></div>
	<div
		role="menu"
		aria-label="Workspace options"
		tabindex="-1"
		class="fixed z-50 w-72 rounded-lg border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) pb-2 text-xs text-(--vscode-foreground) shadow-xl shadow-black/40"
		style:left="{Math.min(options.x, window.innerWidth - 296)}px"
		style:top="{Math.min(options.y, window.innerHeight - 420)}px"
		onkeydown={(e) => e.key === 'Escape' && (options = null)}
	>
		<div class="px-3 pt-2.5 pb-1 text-sm">Workspace options</div>
		<div class="px-3 pt-2 pb-1 text-[11px] {MUTED}">Group by</div>
		<div class="mx-3 flex h-6 rounded-md bg-(--vscode-editor-background)/50 p-px">
			{#each [['none', 'None'], ['status', 'Status'], ['repo', 'Project']] as [id, label] (id)}
				<button class={[SEG, prefs.groupBy === id ? 'bg-(--vscode-foreground)/10 font-semibold' : MUTED]} onclick={() => (prefs.groupBy = id as GroupBy)}>{label}</button>
			{/each}
		</div>
		<div class="my-2 border-t border-(--vscode-widget-border)"></div>
		<div class="flex items-center justify-between px-3 pb-1 text-[11px] {MUTED}">Sort by<span>{SORT_LABEL[prefs.sortBy]}</span></div>
		{#each Object.entries(SORT_LABEL) as [id, label] (id)}
			<button
				role="menuitemradio"
				aria-checked={prefs.sortBy === id}
				class="flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] hover:bg-(--vscode-list-hoverBackground)"
				title={id === 'smart' ? 'Agents that need attention, then most recent activity.' : id === 'manual' ? 'Drag workspaces to arrange them within each group.' : undefined}
				onclick={() => (prefs.sortBy = id as SortBy)}
			>
				<span class="grid size-3.5 place-items-center">{#if prefs.sortBy === id}<span class="size-1.5 rounded-full bg-current"></span>{/if}</span>{label}
			</button>
		{/each}
		<div class="my-2 border-t border-(--vscode-widget-border)"></div>
		<div class="px-3 pb-1 text-[11px] {MUTED}">Card layout</div>
		{#each [[false, 'Detailed'], [true, 'Compact']] as [v, label] (label)}
			<button role="menuitemradio" aria-checked={prefs.compact === v} class="flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] hover:bg-(--vscode-list-hoverBackground)" onclick={() => (prefs.compact = v as boolean)}>
				<span class="grid size-3.5 place-items-center">{#if prefs.compact === v}<span class="size-1.5 rounded-full bg-current"></span>{/if}</span>{label}
			</button>
		{/each}
		<div class="my-2 border-t border-(--vscode-widget-border)"></div>
		<div class="px-3 pb-1 text-[11px] font-semibold {MUTED}">Filters</div>
		{#each [{ key: 'hideSleeping', label: 'Hide sleeping', icon: 'sleep', indent: false, show: true }, { key: 'exceptDefault', label: 'Except default branch', icon: 'git', indent: true, show: prefs.filters.hideSleeping }, { key: 'hideDefault', label: 'Hide default branch', icon: 'git', indent: false, show: true }] as f (f.key)}
			{#if f.show}
				{@const on = prefs.filters[f.key as 'hideSleeping']}
				<button role="switch" aria-checked={on} class={['mx-1 flex w-[calc(100%-8px)] items-center gap-2 rounded-[5px] py-1.5 pr-2 text-[12px] font-medium hover:bg-(--vscode-list-hoverBackground)', f.indent ? 'pl-7' : 'pl-2']} onclick={() => prefs.setFilter(f.key as 'hideSleeping', !on)}>
					<Icon name={f.icon as IconName} size={13} /><span class="flex-1 text-left">{f.label}</span>
					<span class={['relative h-3.5 w-6 rounded-full transition-colors', on ? 'bg-(--vscode-focusBorder)' : 'bg-(--vscode-widget-border)']}><span class={['absolute top-0.5 size-2.5 rounded-full bg-white transition-all', on ? 'left-3' : 'left-0.5']}></span></span>
				</button>
			{/if}
		{/each}
	</div>
{/if}
