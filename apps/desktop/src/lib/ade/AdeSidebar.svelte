<script lang="ts">
	// The Agents layout side bar, built like Orca's worktree sidebar: Search (the worktree jump
	// palette), Now (Kingu's decision inbox), Tasks (the board), Automations and Issues on top, a "Projects" header with the activity view, workspace
	// options, add project and new workspace, then the folder as a project group with a card per
	// worktree (status slot, title, branch, the agent row with its last message and time). Every
	// other added project follows as its own group (projects.svelte.ts): lighter cards with the
	// status, unread state and agent row; opening one switches the folder. Orca's
	// footer is left out: Settings, Help and the board already live elsewhere in Kingu (title bar
	// gear, Settings, the Tasks row); Reveal active workspace is on the project header.
	import { untrack } from 'svelte';
	import Icon, { type IconName } from '#lib/workbench/Icon.svelte';
	import AgentIcon from '#lib/agent/AgentIcon.svelte';
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
	import { COLUMNS, MAX_TITLE, STATUS_LABEL, type TaskView } from './model';
	import { automations } from './automations.svelte.ts';
	import { repoDialog } from '#lib/workbench/repoDialog.svelte.ts';
	import { scm } from '#lib/workbench/scm.svelte.ts';
	import { adeTasks } from './tasks.svelte';
	import { cleanup } from './cleanup.svelte';
	import { newSession } from './agentsMode.svelte';
	import { jumpToWorktree } from './worktreeMenu.svelte';
	import { rowCardStatus, rowText } from './agentPresence';
	import { activeFilterCount, cardStatus, CARD_STATUS_LABEL, reorder, shortAgo, SORT_LABEL, sortItems, statusColumn, type CardStatus, type GroupBy, type SortBy } from './sidebarModel';
	import { sidebarPrefs as prefs } from './sidebarPrefs.svelte';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { aggregateStats } from './model';
	import { baseName, cardProperties, externalWorktrees, hexColor, hiddenBy, PR_GROUPS, prGroupOf, type Visibility } from './sidebarView';
	import { sidebarPrefs as sidebarFilters, sidebarTask } from './sidebarState.svelte';
	import { prStatuses } from './prStatus.svelte';
	import { issueRef } from './issues.ts';
	import { sourceName } from './taskSources.ts';
	import { actionsFor, openWorktreeIn, runWorktreeAction } from './worktreeMenu.svelte';
	import type { WorktreeAction } from './worktreeActions';
	import { projects } from './projects.svelte';
	import { aroundOpen, projectName, projectSidebarTask, type SidebarProject } from './projects';
	import { defaultWorkflowId, workflowOf, workflowStatuses } from './workflow.ts';
	import { t } from '#lib/i18n/index.ts';
	import { nestTasks } from './attempts.ts';
	import { childAgentRows, childAgentsKey, childAgentToggle } from './childAgents.ts';
	import TaskBadges from './TaskBadges.svelte';

	const root = $derived(workspace.root ?? '');
	const now = $derived(adeTasks.now);
	const selectedKey = $derived(adeLayout.board ? null : adeLayout.key);

	// Card properties (kingu.sidebar.cardProperties; compact cards show only the status and title).
	const props = $derived(cardProperties(settings.get<unknown[]>('kingu.sidebar.cardProperties'), prefs.compact));
	// Repository display (Orca's per-repo display name, badge color and icon).
	const repoName = $derived((settings.get<string>('kingu.repo.displayName') ?? '').trim() || (workspace.name ?? ''));
	const repoBadge = $derived(hexColor(settings.get<string>('kingu.repo.badgeColor')));
	const repoIcon = $derived([...(settings.get<string>('kingu.repo.icon') ?? '').trim()].slice(0, 2).join(''));
	// Worktrees Kingu did not make (Orca's external / agent worktree visibility): read-only cards.
	const externals = $derived(
		workspace.root
			? externalWorktrees(adeTasks.listed, workspace.root, {
					external: settings.get<Visibility>('kingu.worktree.externalVisibility'),
					agent: settings.get<Visibility>('kingu.worktree.agentVisibility'),
					custom: settings.get<string[]>('kingu.worktree.visibilitySources')
				})
			: []
	);
	let externalMenu = $state<{ path: string; x: number; y: number } | null>(null);

	// PR state for grouping and the card's PR property: read once per task (gh) when either needs it.
	const askedPr = new Set<string>();
	$effect(() => {
		if (prefs.groupBy !== 'pr-status' && !props.has('pr')) return;
		for (const v of adeTasks.views) {
			const slug = v.meta.slug;
			if (askedPr.has(slug) || prStatuses.bySlug[slug]) continue;
			askedPr.add(slug);
			void prStatuses.refresh(slug, { threads: false });
		}
	});

	// --- Rows ---------------------------------------------------------------------------------
	type Row = { key: string; title: string; branch: string; view?: TaskView; created: number; activity: number };
	const lastActivity = (v: TaskView) => Math.max(v.meta.updated_at, v.runtime?.updatedAt ?? 0, v.meta.last_run?.at ?? 0);
	const primaryRow = $derived<Row>({ key: PRIMARY, title: workspace.name ?? '', branch: status.branch || 'HEAD', created: 0, activity: 0 });
	const taskRows = $derived<Row[]>(
		adeTasks.views
			.filter((v) => !hiddenBy(sidebarTask(v), sidebarFilters()))
			.map((v) => ({ key: v.meta.slug, title: v.meta.title, branch: adeTasks.branchOf(v.meta.slug), view: v, created: v.meta.created_at, activity: lastActivity(v) }))
	);
	const sorted = $derived(
		sortItems(
			taskRows.map((r) => ({ ...r, slug: r.key, status: r.view!.status, createdAt: r.created, lastActivityAt: r.activity })),
			prefs.sortBy,
			now,
			prefs.manual(root)
		)
	);
	// Tasks an agent dispatched (kingu task create) under the dispatching card, or hidden, per
	// kingu.sidebar.showChildAgents and each card's fold (childAgents.ts).
	const childOpts = $derived({ show: settings.get<boolean>('kingu.sidebar.showChildAgents') === true, collapsed: (s: string) => prefs.isCollapsed(childAgentsKey(s)), selected: selectedKey });
	const childRows = $derived(childAgentRows(sorted.map((r) => ({ ...r, parent: r.view?.meta.parent, group: r.view?.meta.group, dispatchedBy: r.view?.meta.dispatched_by })), childOpts));
	// Stacked tasks right under their parent, a best-of-N group's attempts together (attempts.ts).
	const nested = $derived(nestTasks(childRows.rows));
	// Indented under its parent only where the parent is listed with it (not split by status, PR or workflow).
	const depthOf = $derived(new Map(nested.map((n) => [n.item.key, n.depth])));
	const showPrimary = $derived(!prefs.filters.hideDefault && !prefs.filters.showActiveOnly && !(prefs.filters.hideSleeping && !prefs.filters.exceptDefault && !(adeLayout.terminals[PRIMARY]?.length ?? 0)));
	const pinned = $derived(prefs.pinned(root).map((k) => (k === PRIMARY ? primaryRow : sorted.find((r) => r.key === k))).filter((r): r is Row => !!r));

	type Group = { id: string; label: string; icon: IconName; tone?: string; rows: Row[]; repo?: boolean };
	const groups = $derived.by((): Group[] => {
		const out: Group[] = [];
		// No folder open: only the other added projects show (their own groups).
		if (!workspace.root) return out;
		if (pinned.length) out.push({ id: 'pinned', label: 'Pinned', icon: 'pin', rows: pinned });
		const all = [...(showPrimary ? [primaryRow] : []), ...nested.map((n) => n.item)];
		if (prefs.groupBy === 'repo') out.push({ id: `repo:${root}`, label: repoName, icon: 'folder', rows: all, repo: true });
		else if (prefs.groupBy === 'pr-status')
			for (const pg of PR_GROUPS) {
				const rows = all.filter((r) => (r.view ? prGroupOf(sidebarTask(r.view)) : 'none') === pg.id);
				if (rows.length) out.push({ id: `pr:${pg.id}`, label: pg.label, icon: 'pullRequest', rows });
			}
		else if (prefs.groupBy === 'workspace-status')
			for (const c of COLUMNS) {
				const rows = all.filter((r) => (r.view ? statusColumn(r.view.status) : 'active') === c.id);
				if (rows.length) out.push({ id: `status:${c.id}`, label: c.label, icon: c.id === 'attention' ? 'bell' : c.id === 'active' ? 'activity' : 'checkCircle', rows });
			}
		else if (prefs.groupBy === 'workflow') {
			// The board's workflow columns (workflow.ts); the folder itself sits with the default one.
			const statuses = workflowStatuses(settings.get('kingu.board.statuses'));
			for (const s of statuses) {
				const rows = all.filter((r) => (r.view ? workflowOf(r.view.meta, statuses) : defaultWorkflowId(statuses)) === s.id);
				if (rows.length) out.push({ id: `workflow:${s.id}`, label: s.label, icon: s.id === 'completed' ? 'checkCircle' : s.id === 'in-review' ? 'pullRequest' : 'tasks', rows });
			}
		} else out.push({ id: 'all', label: '', icon: 'menu', rows: all });
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

	// --- Inline rename (Orca's WorktreeTitleInlineRename) -------------------------------------
	// adeTasks.renaming says which card edits (the menu, the palette and double-click start it).
	// Enter or leaving the box saves, Escape cancels; empty or unchanged keeps the old name.
	let renameValue = $state('');
	let saving = false;
	$effect(() => {
		const slug = adeTasks.renaming;
		if (slug) renameValue = adeTasks.find(slug)?.meta.title ?? '';
	});
	async function commitRename(slug: string) {
		if (saving || adeTasks.renaming !== slug) return;
		saving = true;
		try {
			await adeTasks.rename(slug, renameValue);
		} finally {
			saving = false;
			if (adeTasks.renaming === slug) adeTasks.renaming = null;
		}
	}
	function onRenameKey(e: KeyboardEvent, slug: string) {
		if (e.isComposing) return;
		if (e.key === 'Enter') {
			e.preventDefault();
			void commitRename(slug);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			adeTasks.renaming = null;
		}
	}

	// --- Projects: the folder must be a git repository; add a project (open, clone, create) -----
	/** The open folder is not a git repository: tasks need one (Orca adds only git projects). */
	const notGit = $derived(!!workspace.root && scm.loaded && scm.repo === null);
	async function initGit() {
		if (await scm.init(true)) await adeTasks.load();
	}
	let addMenu = $state<{ x: number; y: number } | null>(null);
	const ADD_ITEMS: MenuNode[] = $derived([
		menuItem('add', t('adeProjects.add')),
		menuSeparator,
		menuItem('open', t('legacyAde.adeSidebar.openFolder')),
		menuItem('clone', 'Clone repository…'),
		menuItem('create', t('legacyAde.adeSidebar.newProject'))
	]);
	function runAdd(id: string) {
		if (id === 'add') void projects.pickAndAdd();
		else if (id === 'open') void commands.run('workbench.action.files.openFolder');
		else void repoDialog.show(id === 'clone' ? 'clone' : 'create');
	}

	// --- Context menu -------------------------------------------------------------------------
	let menu = $state<{ key: string; x: number; y: number } | null>(null);
	const SIDEBAR_IDS = ['pin', 'unpin', 'markRead', 'markUnread', 'sleep'];
	const menuItems = $derived.by((): MenuNode[] => {
		if (!menu) return [];
		const key = menu.key;
		const isPinned = prefs.pinned(root).includes(key);
		const unread = isUnread(key === PRIMARY ? primaryRow : (sorted.find((r) => r.key === key) ?? primaryRow));
		const hasPanels = (adeLayout.terminals[key]?.length ?? 0) + (adeLayout.files[key]?.length ?? 0) > 0;
		return [
			...actionsFor(key).map((r) => (r === 'separator' ? menuSeparator : menuItem(r.id, r.label, { enabled: r.enabled ?? true }))),
			menuSeparator,
			menuItem(isPinned ? 'unpin' : 'pin', isPinned ? 'Unpin' : 'Pin'),
			menuItem(unread ? 'markRead' : 'markUnread', unread ? 'Mark Read' : 'Mark Unread'),
			menuItem('sleep', 'Sleep', { enabled: hasPanels })
		];
	});
	function runMenu(id: string, key: string) {
		if (!SIDEBAR_IDS.includes(id)) return runWorktreeAction(key, id as WorktreeAction);
		if (id === 'pin' || id === 'unpin') return prefs.setPinned(root, key, id === 'pin');
		if (id === 'markRead' || id === 'markUnread') return setUnread(key, id === 'markUnread');
		// Sleep closes the worktree's terminals and tabs; its folder, branch and agent session stay.
		adeLayout.drop(key);
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
			status.flash(t('legacyAde.adeSidebar.sortManualFlash', { previous: SORT_LABEL[previous] }), 8000);
		}
	}

	// --- Drag to reorder projects (Orca's manual project order) --------------------------------
	let draggingProject = $state<string | null>(null);
	let dropProject = $state<string | null>(null);
	function dragProject(e: DragEvent, path: string) {
		draggingProject = path;
		e.dataTransfer?.setData('text/plain', path);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
	}
	function overProject(e: DragEvent, path: string) {
		if (!draggingProject || draggingProject === path) return;
		e.preventDefault();
		e.stopPropagation();
		dropProject = path;
	}
	function dropProjectOn(before: string | null) {
		const path = draggingProject;
		draggingProject = dropProject = null;
		if (!path || path === before) return;
		if (settings.get<string>('kingu.projects.orderBy') === 'recent') void settings.set('kingu.projects.orderBy', 'manual', 'user');
		void projects.move(path, before);
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
				run: () => selectedKey && runWorktreeAction(selectedKey, 'remove')
			}),
			commands.register({ id: 'kingu.agents.revealActiveWorkspace', title: 'Reveal Active Workspace', category: 'Agents', when: () => appMode.isAgents, run: () => reveal() }),
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
	const filterCount = $derived(activeFilterCount(prefs.filters));
	const repoItems: MenuNode[] = [menuItem('settings', 'Project Settings'), menuItem('reveal', 'Reveal in Finder'), menuSeparator, menuItem('remove', 'Remove Project')];
	function runRepo(id: string) {
		if (id === 'settings') systemSettings.show();
		else if (id === 'reveal') void invoke('fs_reveal', { rel: '' }).catch((e) => status.error(String(e)));
		else if (id === 'remove') void removeOpen();
	}
	/** Remove Project on the open folder: closes it (as before) and takes it out of the added projects. */
	async function removeOpen() {
		const open = workspace.root;
		if (!open) return;
		await workspace.closeFolder();
		if (workspace.root !== open && projects.added.has(open)) await projects.remove(open);
	}

	// --- Other added projects: lighter groups (status, unread); a card opens by switching folders --
	type ProjectRow = { root: string; key: string; title: string; branch: string; view: TaskView; created: number; activity: number };
	function projectRows(root: string): ProjectRow[] {
		const wts = projects.worktrees(root);
		const rows = projects
			.views(root)
			.filter((v) => !hiddenBy(projectSidebarTask(v, wts.find((w) => w.slug === v.meta.slug)?.detached ?? false), sidebarFilters()))
			.map((v) => ({ root, key: v.meta.slug, title: v.meta.title, branch: wts.find((w) => w.slug === v.meta.slug)?.branch ?? `kingu/${v.meta.slug}`, view: v, created: v.meta.created_at, activity: lastActivity(v) }));
		return sortItems(
			rows.map((r) => ({ ...r, slug: r.key, status: r.view.status, createdAt: r.created, lastActivityAt: r.activity })),
			prefs.sortBy,
			now,
			prefs.manual(root)
		);
	}
	// Grouped by project, the projects keep the order they were added around the open folder; otherwise they follow it.
	const around = $derived(aroundOpen(projects.items));
	const beforeProjects = $derived(prefs.groupBy === 'repo' ? around.before : []);
	const afterProjects = $derived(prefs.groupBy === 'repo' ? around.after : [...around.before, ...around.after]);
	function projectUnread(r: ProjectRow): boolean {
		if (prefs.markedUnread(r.root).includes(r.key)) return true;
		const s = adeTasks.stateOf(r.view);
		return !!s.finishedAt && s.finishedAt > (s.viewedAt ?? 0);
	}
	function openProjectTask(r: ProjectRow) {
		if (prefs.markedUnread(r.root).includes(r.key)) prefs.setMarkedUnread(r.root, r.key, false);
		void projects.open(r.root, r.key);
	}
	let projectMenu = $state<{ root: string; x: number; y: number } | null>(null);
	const projectItems = $derived<MenuNode[]>([menuItem('open', t('adeProjects.open')), menuSeparator, menuItem('remove', t('adeProjects.remove'))]);
	function runProject(id: string, root: string) {
		if (id === 'open') void projects.open(root);
		else if (id === 'remove') void projects.remove(root);
	}
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
	{@const depth = groupId === 'all' || groupId.startsWith('repo:') ? (depthOf.get(r.key) ?? 0) : 0}
	{@const kids = r.view ? childAgentToggle(r.key, childRows, childOpts) : null}
	<div role="option" aria-selected={active} aria-current={active ? 'page' : undefined} data-worktree-id={r.key} class={['relative px-1 pb-1', dragging === r.key && 'opacity-0']} style:padding-left={depth ? `${4 + Math.min(depth, 4) * 12}px` : undefined}>
		{#if dropBefore === r.key}<div class="absolute inset-x-2 -top-px h-0.5 rounded-full bg-(--vscode-focusBorder)"></div>{/if}
		<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
		<div
			draggable={adeTasks.renaming !== r.key && r.key !== PRIMARY}
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
			ondblclick={() => r.view && adeTasks.startRename(r.key)}
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
						<span class="grid place-items-center group-hover/status:hidden">{#if props.has('status')}{@render statusDot(s)}{/if}</span>
						<span class="hidden text-(--vscode-descriptionForeground)/40 group-hover/status:block"><Icon name="bell" size={12} /></span>
					{/if}
				</button>
				<div class="flex min-w-0 flex-1 flex-col gap-1.5 pl-1">
					<div class="flex min-w-0 items-center justify-between gap-2">
						<div class="flex min-w-0 flex-1 items-center gap-1.5">
							{#if groupId === 'pinned' || prefs.groupBy !== 'repo'}
								<span class="grid size-4 shrink-0 place-items-center rounded-[4px] border border-(--vscode-widget-border) bg-(--vscode-list-inactiveSelectionBackground)/55" title={workspace.name}><Icon name="folder" size={11} /></span>
							{/if}
							{#if adeTasks.renaming === r.key}
								<!-- svelte-ignore a11y_autofocus -->
								<input
									class="h-5 min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] leading-5 outline-none"
									aria-label="Rename workspace"
									autofocus
									maxlength={MAX_TITLE}
									bind:value={renameValue}
									onclick={(e) => e.stopPropagation()}
									onkeydown={(e) => onRenameKey(e, r.key)}
									onblur={() => void commitRename(r.key)}
									onfocus={(e) => e.currentTarget.select()}
								/>
							{:else}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<span class={['truncate text-[13px] leading-5', unread ? 'font-semibold text-(--vscode-foreground)' : 'font-normal text-(--vscode-foreground)']} title={r.title} ondblclick={(e) => (e.stopPropagation(), r.view && adeTasks.startRename(r.key))}>
									{#if unread}<span class="sr-only">Unread: </span>{/if}{r.title}
								</span>
							{/if}
							{#if r.view}<TaskBadges meta={r.view.meta} parentTitle={depth ? adeTasks.find(r.view.meta.parent ?? '')?.meta.title : undefined} />{/if}
							{#if kids && childOpts.show}
								<button
									class="flex h-4 shrink-0 items-center gap-0.5 rounded px-0.5 text-[10px] text-(--vscode-descriptionForeground) tabular-nums hover:bg-(--vscode-toolbar-hoverBackground)"
									aria-expanded={kids.expanded}
									aria-label={kids.expanded ? t('ade.sidebar.childAgentsHide', { count: kids.count }) : t('ade.sidebar.childAgentsShow', { count: kids.count })}
									title={kids.expanded ? t('ade.sidebar.childAgentsHide', { count: kids.count }) : t('ade.sidebar.childAgentsShow', { count: kids.count })}
									onclick={(e) => (e.stopPropagation(), prefs.toggleCollapsed(childAgentsKey(r.key)))}
									ondblclick={(e) => e.stopPropagation()}
								>
									<span class={['grid place-items-center transition-transform', !kids.expanded && '-rotate-90']}><Icon name="chevronDown" size={11} /></span>{#if !kids.expanded}+{kids.count}{/if}
								</button>
							{:else if kids}
								<span class="shrink-0 text-[10px] text-(--vscode-descriptionForeground) tabular-nums" title={t('ade.sidebar.childAgentsHidden', { count: kids.count })}>+{kids.count}</span>
							{/if}
							{#if r.key === PRIMARY && !prefs.compact}
								<span class="h-4 shrink-0 rounded border border-(--vscode-foreground)/20 bg-(--vscode-foreground)/[0.06] px-1.5 text-[10px] leading-[14px] font-medium text-(--vscode-foreground)/70" title="Primary worktree (original clone directory)">primary</span>
							{/if}
						</div>
						<div class="ml-auto flex shrink-0 items-center gap-1">
							{#if adeTasks.busy[r.key]}<span class="max-w-24 truncate text-[10px] {MUTED}" title={adeTasks.busy[r.key]}>{adeTasks.busy[r.key]}</span>{/if}
							{#if r.key === PRIMARY && prefs.compact}
								<span class="text-amber-400" aria-label="Primary worktree"><Icon name="kingu" size={12} /></span>
							{/if}
							{#if altHeld && r.key !== PRIMARY}
								<button
									class="grid size-4 place-items-center rounded opacity-0 group-focus-within/worktree-card:opacity-100 group-hover/worktree-card:opacity-100 hover:bg-red-500/10 hover:text-red-400"
									aria-label="Delete workspace"
									title="Delete workspace"
									onclick={(e) => (e.stopPropagation(), runWorktreeAction(r.key, 'remove'))}><Icon name="trash" size={13} /></button
								>
							{/if}
						</div>
					</div>
					{#if !prefs.compact}
						{@const pr = r.view && props.has('pr') ? prStatuses.bySlug[r.key]?.pr : null}
						{@const totals = r.view?.stat && props.has('diff') ? aggregateStats(r.view.stat.files) : null}
						{@const issue = props.has('issue') ? r.view?.meta.issue : null}
						{@const auto = props.has('automation') && r.view?.meta.origin === 'automation'}
						{#if props.has('branch') || pr || issue || auto || (totals && (totals.added || totals.deleted))}
							<div class="flex min-w-0 items-center gap-1.5 text-[11px] leading-none {MUTED}">
								{#if props.has('branch')}<span class="min-w-0 flex-1 truncate" title={r.branch}>{r.branch}</span>{:else}<span class="flex-1"></span>{/if}
								{#if auto}<span class="shrink-0 rounded border border-(--vscode-widget-border) px-1 text-[10px] leading-[14px]" title={t('legacyAde.adeSidebar.automationTask')}>auto</span>{/if}
								{#if issue}<span class="shrink-0 font-mono" title="{sourceName(issue)}: {issue.title}">{issueRef(issue)}</span>{/if}
								{#if pr}<span class="shrink-0 font-mono" title="PR #{pr.number}: {pr.title} ({pr.draft ? 'DRAFT' : pr.state})">PR #{pr.number}</span>{/if}
								{#if totals && (totals.added || totals.deleted)}<span class="shrink-0 font-mono"><span class="text-[#73C991]">+{totals.added}</span> <span class="text-[#F48771]">−{totals.deleted}</span></span>{/if}
							</div>
						{/if}
						{#if props.has('activity') && r.view && (r.view.runtime || r.view.meta.last_run)}
							{@const v = r.view}
							<!-- Orca's inline agent row: state, agent, "agent - last message", model, time. -->
							<div class="flex h-6 items-center gap-1 rounded-sm px-1 text-[11px] leading-none {MUTED} hover:bg-(--vscode-list-hoverBackground)">
								<span class="grid size-3 shrink-0 place-items-center">{@render statusDot(s, 'size-1.5')}</span>
								<span class="shrink-0"><AgentIcon agent={v.meta.agent || 'claude'} size={13} /></span>
								<span class={['min-w-0 flex-1 truncate', unread ? 'font-semibold text-(--vscode-foreground)' : 'text-(--vscode-descriptionForeground)/90']}>
									{agentName(v)}<span class="opacity-65"> - {agentText(v)}</span>
								</span>
								{#if v.runtime?.model ?? v.meta.model}<span class="max-w-24 shrink-0 truncate font-mono text-[10px] opacity-80">{v.runtime?.model ?? v.meta.model}</span>{/if}
								{#if props.has('time')}<span class="shrink-0 text-[10px] tabular-nums opacity-60">{shortAgo(r.activity, now)}</span>{/if}
							</div>
							<!-- Agents in the worktree's other terminal panes (Orca: one row per agent). -->
							{#each v.runtime?.agents ?? [] as a (a.id)}
								<div class="flex h-6 items-center gap-1 rounded-sm px-1 pl-3 text-[11px] leading-none {MUTED}">
									<span class="grid size-3 shrink-0 place-items-center">{@render statusDot(rowCardStatus(a), 'size-1.5')}</span>
									<span class="min-w-0 flex-1 truncate text-(--vscode-descriptionForeground)/90">{rowText(a)}</span>
									{#if props.has('time')}<span class="shrink-0 text-[10px] tabular-nums opacity-60">{shortAgo(a.at, now)}</span>{/if}
								</div>
							{/each}
						{/if}
					{/if}
				</div>
			</div>
		</div>
	</div>
{/snippet}

<!-- Another added project's card: status slot, title, branch, the agent row; a click switches to that folder and opens the task. -->
{#snippet projectCard(r: ProjectRow, name: string)}
	{@const s = cardStatus(r.view.status, !!r.view.runtime?.working, false)}
	{@const unread = projectUnread(r)}
	<div role="option" aria-selected="false" class="relative px-1 pb-1">
		<button
			class={['ml-1 flex w-[calc(100%-4px)] flex-col rounded-lg border border-transparent pr-1.5 pl-1.5 text-left hover:bg-(--vscode-list-hoverBackground)/60', prefs.compact ? 'py-2' : 'pt-1.25 pb-1.5']}
			title={t('adeProjects.openTask', { task: r.title, project: name })}
			onclick={() => openProjectTask(r)}
		>
			<span class="flex w-full min-w-0 items-center gap-1.5">
				<span class="grid size-4 shrink-0 place-items-center">
					{#if unread}<span class="text-amber-400 drop-shadow-sm"><Icon name="bell" size={13} filled /></span>{:else if props.has('status')}{@render statusDot(s)}{/if}
				</span>
				<span class={['min-w-0 flex-1 truncate text-[13px] leading-5 text-(--vscode-foreground)', unread ? 'font-semibold' : 'font-normal']}>{r.title}</span>
			</span>
			{#if !prefs.compact}
				{#if props.has('branch')}<span class="mt-1 truncate pl-5.5 text-[11px] leading-none {MUTED}">{r.branch}</span>{/if}
				{#if props.has('activity') && (r.view.runtime || r.view.meta.last_run)}
					<span class="mt-1 flex h-5 min-w-0 items-center gap-1 pl-5 text-[11px] leading-none {MUTED}">
						<span class={['min-w-0 flex-1 truncate', unread ? 'font-semibold text-(--vscode-foreground)' : 'text-(--vscode-descriptionForeground)/90']}>{agentName(r.view)}<span class="opacity-65"> - {agentText(r.view)}</span></span>
						{#if props.has('time')}<span class="shrink-0 text-[10px] tabular-nums opacity-60">{shortAgo(r.activity, now)}</span>{/if}
					</span>
					{#each r.view.runtime?.agents ?? [] as a (a.id)}
						<span class="flex h-5 min-w-0 items-center gap-1 pl-7 text-[11px] leading-none {MUTED}">
							<span class="grid size-3 shrink-0 place-items-center">{@render statusDot(rowCardStatus(a), 'size-1.5')}</span>
							<span class="min-w-0 flex-1 truncate">{rowText(a)}</span>
						</span>
					{/each}
				{/if}
			{/if}
		</button>
	</div>
{/snippet}

<!-- Another added project's group: its header (collapse, actions, right-click menu) and its task cards. -->
{#snippet projectGroup(p: SidebarProject)}
	{@const id = `repo:${p.path}`}
	{@const collapsed = prefs.isCollapsed(id)}
	{@const rows = projectRows(p.path)}
	{@const listing = projects.listings[p.path]}
	{@const waiting = rows.filter((r) => r.view.status === 'waiting').length}
	<div class="sticky -top-px z-20 bg-(--vscode-sideBar-background) pt-1">
		<div
			role="button"
			tabindex="0"
			aria-expanded={!collapsed}
			draggable="true"
			class={['group/header relative flex h-7 w-full cursor-pointer items-center gap-1.5 pr-2 pl-2.5 text-left', dropProject === p.path && 'shadow-[inset_0_2px_0_var(--vscode-focusBorder)]']}
			title={p.path}
			onclick={() => prefs.toggleCollapsed(id)}
			onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), prefs.toggleCollapsed(id))}
			oncontextmenu={(e) => (e.preventDefault(), (projectMenu = { root: p.path, x: e.clientX, y: e.clientY }))}
			ondragstart={(e) => dragProject(e, p.path)}
			ondragend={() => (draggingProject = dropProject = null)}
			ondragover={(e) => overProject(e, p.path)}
			ondrop={(e) => (e.preventDefault(), e.stopPropagation(), dropProjectOn(p.path))}
		>
			<span class="grid size-4 shrink-0 place-items-center rounded-[4px] bg-amber-500/15 text-amber-400"><Icon name="folder" size={12} /></span>
			<span class="truncate text-[13px] leading-none font-semibold">{p.name}</span>
			{#if waiting}<span class="rounded-full bg-(--vscode-editorWarning-foreground) px-1.5 text-[10px] leading-4 font-semibold text-black">{waiting}</span>{/if}
			<span class="ml-auto flex items-center">
				<button
					class={REVEAL}
					aria-label={t('adeProjects.actionsFor', { name: p.name })}
					title={t('adeProjects.menu')}
					onclick={(e) => {
						e.stopPropagation();
						const rr = e.currentTarget.getBoundingClientRect();
						projectMenu = { root: p.path, x: rr.right - 248, y: rr.bottom + 6 };
					}}><Icon name="more" size={14} /></button
				>
				<span class={['grid size-5 place-items-center rounded-md transition-transform hover:bg-(--vscode-toolbar-hoverBackground)', collapsed && '-rotate-90']}><Icon name="chevronDown" size={14} /></span>
			</span>
		</div>
	</div>
	{#if !collapsed}
		{#if listing?.error}
			<p class="px-4 pb-1 text-[11px] break-words {MUTED}">{t('adeProjects.loadFailed', { error: listing.error })}</p>
		{:else if listing && !rows.length}
			<p class="px-4 pb-1 text-[11px] {MUTED}">{t('adeProjects.noTasks')}</p>
		{/if}
		{#each rows as r (r.key)}{@render projectCard(r, p.name)}{/each}
	{/if}
{/snippet}

<div class="flex h-full min-h-0 flex-col bg-(--vscode-sideBar-background) text-(--vscode-sideBar-foreground)">
	<!-- Top nav: Search, then Kingu Now (the decision inbox), Board, Automations and Issues. -->
	<nav class="flex flex-col gap-0.5 px-2 pt-2 pb-1">
		<button class="{NAV} bg-(--vscode-sideBar-foreground)/5 {NAV_OFF}" aria-label="Search worktrees" onclick={jumpToWorktree}>
			<span class="text-(--vscode-sideBar-foreground)/30"><Icon name="search" size={16} /></span>
			<span class="flex-1">Search</span>
			<span class="hidden gap-0.5 group-hover:flex group-focus-visible:flex">
				{#each ['⇧', '⌘', 'J'] as k (k)}<kbd class="min-w-4 rounded border border-(--vscode-widget-border) bg-(--vscode-sideBar-foreground)/8 px-1 py-px text-center font-sans text-[9px] text-(--vscode-sideBar-foreground)/55">{k}</kbd>{/each}
			</span>
		</button>
		{#each ([{ page: 'now', icon: 'agent', label: 'Now' }, { page: 'board', icon: 'menu', label: 'Tasks' }, { page: 'automations', icon: 'clock', label: 'Automations' }, { page: 'issues', icon: 'bug', label: 'Issues' }] as const).filter((n) => settings.get<boolean>(n.page === 'automations' ? 'kingu.sidebar.showAutomations' : n.page === 'issues' ? 'kingu.sidebar.showIssues' : '') !== false) as n (n.page)}
			{@const on = adeLayout.page === n.page}
			<button class="{NAV} {on ? NAV_ON : NAV_OFF}" aria-current={on ? 'page' : undefined} disabled={n.page !== 'board' && !workspace.root} onclick={() => adeLayout.togglePage(n.page)}>
				<span class={on ? '' : 'text-(--vscode-sideBar-foreground)/30'}><Icon name={n.icon} size={16} /></span>
				<span class="flex-1">{n.label}</span>
				{#if n.page === 'now' && adeTasks.counts.needsInput}
					<span class="rounded-full bg-(--vscode-editorWarning-foreground) px-1.5 text-[10px] leading-4 font-semibold text-black" title={t('legacyAde.adeSidebar.waitingForYou')}>{adeTasks.counts.needsInput}</span>
				{:else if n.page === 'automations' && automations.activeCount}
					<span class="text-[11px] {MUTED}" title={automations.globalEnabled ? t('legacyAde.adeSidebar.automationEnabled') : t('legacyAde.adeSidebar.automationsStopped')}>{automations.globalEnabled ? automations.activeCount : t('legacyAde.adeSidebar.stopped')}</span>
				{/if}
			</button>
		{/each}
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
			<button
				class={HEADER_BTN}
				aria-label="Add project"
				title="Add project (open, clone or create)"
				aria-haspopup="menu"
				onclick={(e) => {
					const r = e.currentTarget.getBoundingClientRect();
					addMenu = { x: r.right - 220, y: r.bottom + 2 };
				}}><Icon name="newFolder" size={14} /></button
			>
			<button class={HEADER_BTN} aria-label="New workspace" title="New workspace" disabled={!workspace.root || notGit} onclick={newWorkspace}><Icon name="plus" size={15} /></button>
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
		{#if !workspace.root && !projects.others.length}
			<div class="space-y-2 px-4 py-6 text-center text-[11px] {MUTED}">
				<p>No workspaces found</p>
				<button class="block w-full text-(--vscode-textLink-foreground) hover:underline" onclick={() => commands.run('workbench.action.files.openFolder')}>Add project</button>
				<button class="block w-full text-(--vscode-textLink-foreground) hover:underline" onclick={() => repoDialog.show('clone')}>Clone repository…</button>
				<button class="block w-full text-(--vscode-textLink-foreground) hover:underline" onclick={() => repoDialog.show('create')}>{t('legacyAde.adeSidebar.newProject')}</button>
			</div>
		{:else if prefs.activity}
			<!-- Activity view: every agent session of every project, the ones that need you first. -->
			{#each sortItems([...taskRows.map((r) => ({ ...r, root: null as string | null, view: r.view! })), ...projects.others.flatMap(projectRows)].map((r) => ({ ...r, slug: r.key, status: r.view.status, createdAt: r.created, lastActivityAt: r.activity })), 'smart', now) as r (`${r.root ?? ''}:${r.key}`)}
				{@const s = r.root ? cardStatus(r.view.status, !!r.view.runtime?.working, false) : stateOf(r)}
				<button
					class={['flex h-7 w-[calc(100%-8px)] items-center gap-1.5 rounded-md px-2 text-left text-[12px] hover:bg-(--vscode-list-hoverBackground)', !r.root && selectedKey === r.key && 'bg-(--vscode-foreground)/10']}
					title={r.root ? t('adeProjects.openTask', { task: r.title, project: projectName(r.root) }) : undefined}
					onclick={() => (r.root ? void projects.open(r.root, r.key) : activate(r.key))}
				>
					<span class="grid size-3 shrink-0 place-items-center">{@render statusDot(s, 'size-1.5')}</span>
					<span class="min-w-0 flex-1 truncate">{r.title}<span class="opacity-60"> - {agentText(r.view)}</span></span>
					{#if r.root}<span class="max-w-20 shrink-0 truncate text-[10px] opacity-60">{projectName(r.root)}</span>{/if}
					<span class="shrink-0 text-[10px] opacity-60">{shortAgo(r.activity, now)}</span>
				</button>
			{:else}
				<p class="px-4 py-6 text-center text-[11px] {MUTED}">No agent activity yet</p>
			{/each}
		{:else}
			{#if notGit}
				<div class="mx-2 mb-2 space-y-1.5 rounded-lg border border-(--vscode-widget-border) px-2.5 py-2 text-xs">
					<p class={MUTED}>{t('legacyAde.adeSidebar.notGitText')}</p>
					<button class="text-(--vscode-textLink-foreground) hover:underline disabled:opacity-50" disabled={scm.busy} onclick={initGit}>{t('legacyAde.adeSidebar.initGit')}</button>
				</div>
			{/if}
			{#each groups as g, gi (g.id)}
				{@const collapsed = prefs.isCollapsed(g.id)}
				{#if g.repo}{#each beforeProjects as p (p.path)}{@render projectGroup(p)}{/each}{/if}
				{#if g.id !== 'all'}
					<div class={['sticky -top-px z-20 bg-(--vscode-sideBar-background)', gi > 0 && 'pt-1']}>
						<div
							role="button"
							tabindex="0"
							aria-expanded={!collapsed}
							class="group/header relative flex h-7 w-full cursor-pointer items-center gap-1.5 pr-2 pl-2.5 text-left"
							onclick={() => prefs.toggleCollapsed(g.id)}
							onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), prefs.toggleCollapsed(g.id))}
							oncontextmenu={(e) => g.repo && (e.preventDefault(), (repoMenu = { x: e.clientX, y: e.clientY }))}
						>
							{#if g.repo && repoIcon}
								<span class="grid size-4 shrink-0 place-items-center text-[12px] leading-none">{repoIcon}</span>
							{:else}
								<span class={['grid size-4 shrink-0 place-items-center rounded-[4px]', g.repo ? 'bg-amber-500/15 text-amber-400' : MUTED]}><Icon name={g.icon} size={12} /></span>
							{/if}
							<span class="truncate text-[13px] leading-none font-semibold">{g.label}</span>
							{#if g.repo && repoBadge}<span class="size-2 shrink-0 rounded-full" style:background={repoBadge} aria-hidden="true"></span>{/if}
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
									<button class={REVEAL} aria-label="Reveal active workspace" title="Reveal active workspace" onclick={(e) => (e.stopPropagation(), reveal())}><Icon name="crosshair" size={13} /></button>
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
			{#each externals as w (w.path)}
				<!-- Not made by Kingu (Orca's external / agent worktrees): a read-only card that opens the folder elsewhere. -->
				<div class="relative px-1 pb-1">
					<button
						class="ml-1 flex w-[calc(100%-4px)] flex-col rounded-lg border border-transparent py-1.5 pr-1.5 pl-1.5 text-left hover:bg-(--vscode-list-hoverBackground)/60"
						title={t('legacyAde.adeSidebar.externalWorktreeTitle', { path: w.path, kind: w.kind === 'agent' ? t('legacyAde.adeSidebar.externalKindAgent') : t('legacyAde.adeSidebar.externalKindExternal') })}
						onclick={(e) => {
							const rr = e.currentTarget.getBoundingClientRect();
							externalMenu = { path: w.path, x: rr.left + 16, y: rr.bottom + 2 };
						}}
						oncontextmenu={(e) => (e.preventDefault(), (externalMenu = { path: w.path, x: e.clientX, y: e.clientY }))}
					>
						<span class="flex min-w-0 items-center gap-1.5">
							<span class="size-2 shrink-0 rounded-full border border-(--vscode-descriptionForeground)"></span>
							<span class="min-w-0 flex-1 truncate text-[13px]">{baseName(w.path)}</span>
							<span class="shrink-0 rounded border border-(--vscode-foreground)/20 px-1.5 text-[10px] leading-[14px] {MUTED}">{w.kind === 'agent' ? 'agent' : 'external'}</span>
						</span>
						<span class="mt-1 truncate pl-3.5 text-[11px] leading-none {MUTED}">{w.branch ?? (w.detached ? 'detached HEAD' : '')}</span>
					</button>
				</div>
			{/each}
			{#if workspace.root && !order.length && !groups.some((g) => g.rows.length)}
				<div class="px-4 py-6 text-center text-[11px] {MUTED}">
					<p>No workspaces found</p>
					{#if filterCount}<button class="mt-2 inline-flex items-center gap-1 rounded-md bg-(--vscode-button-secondaryBackground) px-2 py-1 text-(--vscode-button-secondaryForeground)" onclick={() => prefs.clearFilters()}><Icon name="error" size={12} />Clear Filters</button>{/if}
				</div>
			{/if}
			{#each afterProjects as p (p.path)}{@render projectGroup(p)}{/each}
			{#if draggingProject}
				<!-- Dropping below the last project moves it to the end (Orca's manual project order). -->
				<div class="h-6 shrink-0" role="presentation" ondragover={(e) => (e.preventDefault(), e.stopPropagation())} ondrop={(e) => (e.preventDefault(), e.stopPropagation(), dropProjectOn(null))}></div>
			{/if}
		{/if}
	</div>

</div>

{#if menu}
	{@const key = menu.key}
	<PopupMenu items={menuItems} label="Workspace" x={menu.x} y={menu.y} onRun={(node) => node.type === 'item' && runMenu(node.id, key)} onClose={() => (menu = null)} />
{/if}
{#if externalMenu}
	{@const path = externalMenu.path}
	{@const openIn = actionsFor('').flatMap((r) => (r !== 'separator' && r.id.startsWith('openIn:') ? [r] : []))}
	<PopupMenu
		items={[menuItem('open', t('legacyAde.adeSidebar.openInKingu')), menuSeparator, ...openIn.map((r) => menuItem(r.id, r.label)), ...(openIn.length ? [menuSeparator] : []), menuItem('copyPath', t('legacyAde.adeSidebar.copyPath'))]}
		label="Worktree"
		x={externalMenu.x}
		y={externalMenu.y}
		onRun={(node) => {
			if (node.type !== 'item') return;
			if (node.id === 'open') void workspace.openFolder(path);
			else if (node.id.startsWith('openIn:')) openWorktreeIn(node.id.slice(7), path);
			else void navigator.clipboard.writeText(path).then(() => status.flash(t('legacyAde.adeSidebar.copiedPath')));
		}}
		onClose={() => (externalMenu = null)}
	/>
{/if}
{#if projectMenu}
	{@const root = projectMenu.root}
	<PopupMenu items={projectItems} label={t('adeProjects.menu')} x={projectMenu.x} y={projectMenu.y} onRun={(node) => node.type === 'item' && runProject(node.id, root)} onClose={() => (projectMenu = null)} />
{/if}
{#if addMenu}
	<PopupMenu items={ADD_ITEMS} label="Add project" x={addMenu.x} y={addMenu.y} onRun={(node) => node.type === 'item' && runAdd(node.id)} onClose={() => (addMenu = null)} />
{/if}
{#if repoMenu}
	<PopupMenu items={repoItems} label="Project actions" x={repoMenu.x} y={repoMenu.y} onRun={(node) => node.type === 'item' && runRepo(node.id)} onClose={() => (repoMenu = null)} />
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
			{#each [['none', 'None'], ['workspace-status', 'Status'], ['workflow', t('adeWorkflow.groupBy')], ['pr-status', 'PR'], ['repo', 'Project']] as [id, label] (id)}
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
		{#each [{ key: 'showActiveOnly', label: 'Show active only', icon: 'activity', indent: false, show: true }, { key: 'hideSleeping', label: 'Hide sleeping', icon: 'sleep', indent: false, show: true }, { key: 'exceptDefault', label: 'Except default branch', icon: 'git', indent: true, show: prefs.filters.hideSleeping }, { key: 'hideDefault', label: 'Hide default branch', icon: 'git', indent: false, show: true }, { key: 'hideAutomation', label: 'Hide automation workspaces', icon: 'clock', indent: false, show: true }, { key: 'hideDetached', label: 'Hide detached HEAD', icon: 'git', indent: false, show: true }] as f (f.key)}
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
