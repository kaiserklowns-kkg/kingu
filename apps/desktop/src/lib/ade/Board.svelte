<script lang="ts">
	// Kanban board editor (`board://`), Orca's workspace board: the workflow columns you move tasks
	// between (Todo / In progress / In review / Done, or `kingu.board.statuses`; drag a card to
	// another column), or with `kingu.board.view` = agent the agent-status columns
	// (needs you / working / done). The agent columns cover every added project, as Orca's Agent
	// Dashboard covers every repo, with its multi-select Project filter; the workflow columns are the
	// open folder's (its statuses and drag targets are that folder's).
	import Icon from '#lib/workbench/Icon.svelte';
	import NewTaskForm from './NewTaskForm.svelte';
	import TaskCard from './TaskCard.svelte';
	import { COLUMNS, groupTasks, type TaskView } from './model';
	import ProjectTaskCard from './ProjectTaskCard.svelte';
	import { projects } from './projects.svelte';
	import { projectName } from './projects';
	import { adeTasks } from './tasks.svelte';
	import { BUTTON, ICON_BUTTON } from './ui';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { cleanup } from './cleanup.svelte';
	import { workspaceSpace } from './workspaceSpace.svelte';
	import { workflowColumns, workflowStatuses } from './workflow.ts';
	import { nestTasks } from './attempts.ts';
	import { t } from '#lib/i18n/index.ts';
	import { boardMatches, inProjects, projectOptions, splitIdle, toggleFilter } from './boardSearch';
	import { agentInbox } from './agentInbox.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { PR_GROUPS, prGroupOf } from './sidebarView';
	import { sidebarTask } from './sidebarState.svelte';
	import { prStatuses } from './prStatus.svelte';
	import { boardPopout } from './boardPopout.svelte.ts';
	import { onMount } from 'svelte';

	// Orca's Agent Dashboard "Open as Pop-out": the agent columns in their own window, fed by this
	// one (boardPopout.svelte.ts); after a reload with the pop-out open, the feed picks up again.
	onMount(() => void boardPopout.resume());

	// Orca's workspace board look: column width (px) and column opacity.
	const width = $derived(settings.get<number>('kingu.board.columnWidth'));
	const opacity = $derived(Math.round(settings.get<number>('kingu.board.opacity') * 100));
	const byAgent = $derived(settings.get<string>('kingu.board.view') === 'agent');
	const statuses = $derived(workflowStatuses(settings.get('kingu.board.statuses')));

	const COLUMN_DOT: Record<string, string> = {
		attention: 'bg-(--vscode-editorWarning-foreground)',
		active: 'bg-(--vscode-editorInfo-foreground)',
		done: 'bg-[#73C991]',
		todo: 'bg-(--vscode-descriptionForeground)',
		'in-progress': 'bg-(--vscode-editorInfo-foreground)',
		'in-review': 'bg-[#B180D7]',
		completed: 'bg-[#73C991]'
	};

	// Orca's board search: title, worktree, branch or agent; the count shows while it narrows.
	let query = $state('');
	let searchBox: HTMLInputElement | undefined = $state();
	// Orca's PR / MR status filter: '' = every task.
	let prFilter = $state('');
	const askedPr = new Set<string>();
	$effect(() => {
		if (!prFilter) return;
		for (const v of adeTasks.views) {
			const slug = v.meta.slug;
			if (askedPr.has(slug) || prStatuses.bySlug[slug]) continue;
			askedPr.add(slug);
			void prStatuses.refresh(slug, { threads: false });
		}
	});
	// Orca's Project filter (agent columns only): none chosen = every project.
	let projectFilter = $state<string[]>([]);
	const here = $derived(workspace.root ?? '');
	/** Which project each card belongs to (another project's tasks come from projects.svelte.ts). */
	const rootOf = $derived(new Map<TaskView, string>([...adeTasks.views.map((v) => [v, here] as const), ...(byAgent ? projects.all.map((e) => [e.view, e.root] as const) : [])]));
	const cardKey = (v: TaskView) => `${rootOf.get(v) ?? here}\u0000${v.meta.slug}`;
	const projectChoices = $derived(
		projectOptions(
			[here, ...projects.others].filter(Boolean).map((r) => ({ id: r, label: projectName(r) })),
			[...rootOf.values()].map((root) => ({ root }))
		)
	);
	// A project that left the side bar leaves the filter too.
	$effect(() => {
		const ids = new Set(projectChoices.map((p) => p.id));
		if (projectFilter.some((p) => !ids.has(p))) projectFilter = projectFilter.filter((p) => ids.has(p));
	});
	const filteringProjects = $derived(byAgent && projectFilter.length > 0);
	const narrowed = $derived(!!query.trim() || !!prFilter || filteringProjects);
	const hit = (v: TaskView) => {
		const root = rootOf.get(v) ?? here;
		const own = root === here;
		const searchable = { title: v.meta.title, slug: v.meta.slug, agent: v.meta.agent, branch: own ? adeTasks.branchOf(v.meta.slug) : projects.worktrees(root).find((w) => w.slug === v.meta.slug)?.branch, project: projectName(root) };
		return (
			boardMatches(searchable, query) &&
			// PR status is known for the open folder's tasks only.
			(!prFilter || (own && prGroupOf(sidebarTask(v)) === prFilter)) &&
			(!byAgent || inProjects(projectFilter, root))
		);
	};
	// Orca's Idle column: finished and seen. Shown only with kingu.board.showIdle (Orca hides it by default).
	const showIdle = $derived(settings.get<boolean>('kingu.board.showIdle') === true);
	const groups = $derived(byAgent ? groupTasks([...rootOf.keys()]) : adeTasks.groups);
	const unread = $derived(new Set(agentInbox.items.filter((i) => !i.read).map((i) => `${i.root ?? here}\u0000${i.slug}`)));
	const finished = $derived.by(() => {
		const keyed = splitIdle(groups.done.map((v) => ({ meta: { slug: cardKey(v) }, v })), unread);
		return { done: keyed.done.map((x) => x.v), idle: keyed.idle.map((x) => x.v) };
	});
	type Lane = { id: string; label: string; hint?: string; tasks: TaskView[]; drop: boolean };
	const lanes = $derived<Lane[]>(
		(byAgent
			? [
					...COLUMNS.map((c) => ({ id: c.id, label: c.label, hint: c.hint, tasks: c.id === 'done' ? finished.done : groups[c.id], drop: false })),
					...(showIdle ? [{ id: 'idle', label: t('adeWorkflow.board.idle'), hint: t('adeWorkflow.board.idleHint'), tasks: finished.idle, drop: false }] : [])
				]
			: workflowColumns(adeTasks.views, statuses).map((c) => ({ id: c.status.id, label: c.status.label, tasks: c.tasks, drop: true }))
		).map((l) => (narrowed ? { ...l, tasks: l.tasks.filter(hit) } : l))
	);
	const shownCount = $derived(lanes.reduce((n, l) => n + l.tasks.length, 0));
	const totalCount = $derived(byAgent ? rootOf.size : adeTasks.list.length);
	let projectMenu = $state(false);
	// ⌘F (Ctrl+F) focuses the search while the board is shown (a terminal keeps its own).
	function onKey(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f' && searchBox?.isConnected && !(e.target as HTMLElement | null)?.closest('.xterm, .monaco-editor')) {
			e.preventDefault();
			searchBox.focus();
		}
	}

	/** Drag a card to another workflow column (Orca's use-workspace-status-drop). */
	const DRAG_TYPE = 'application/x-kingu-task';
	let dragging = $state<string | null>(null);
	let over = $state<string | null>(null);

	function onDrop(e: DragEvent, column: string) {
		e.preventDefault();
		const slug = e.dataTransfer?.getData(DRAG_TYPE) || dragging;
		dragging = over = null;
		if (slug) void adeTasks.setWorkflowStatus(slug, column);
	}

	function setView(agent: boolean) {
		void settings.set('kingu.board.view', agent ? 'agent' : 'workflow', 'user');
	}
</script>

<svelte:window onkeydown={onKey} />

<div class="flex h-full flex-col overflow-hidden bg-(--vscode-editor-background) text-(--vscode-foreground)">
	<header class="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--vscode-widget-border) px-4 py-2 whitespace-nowrap">
		<h1 class="flex items-center gap-2 text-sm font-semibold"><Icon name="tasks" size={16} />{t('adeWorkflow.board.title')}</h1>
		<span class="text-xs text-(--vscode-descriptionForeground)">{narrowed ? t('adeWorkflow.board.shown', { shown: shownCount, count: totalCount }) : t('adeWorkflow.board.count', { count: totalCount })}</span>
		<span class="flex-1"></span>
		{#if byAgent}
			<label class="flex items-center gap-1 text-xs text-(--vscode-descriptionForeground)" title={t('adeWorkflow.board.idleHint')}>
				<input type="checkbox" checked={showIdle} onchange={(e) => void settings.set('kingu.board.showIdle', e.currentTarget.checked, 'user')} />{t('adeWorkflow.board.showIdle')}
			</label>
		{/if}
		{#if byAgent && projectChoices.length > 1}
			<!-- Orca's Project filter: multi-select with counts; removable chips; none chosen = all. -->
			<div class="relative">
				<button
					class={['flex h-6 items-center gap-1 rounded-md border px-1.5 text-xs', projectFilter.length ? 'border-(--vscode-focusBorder)' : 'border-(--vscode-input-border,var(--vscode-widget-border))', 'bg-(--vscode-input-background) text-(--vscode-input-foreground)']}
					aria-haspopup="true"
					aria-expanded={projectMenu}
					onclick={() => (projectMenu = !projectMenu)}
				>
					<Icon name="filter" size={12} />{projectFilter.length ? t('adeWorkflow.board.projectsChosen', { count: projectFilter.length }) : t('adeWorkflow.board.projectsAll')}
				</button>
				{#if projectMenu}
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<div
						class="absolute top-full right-0 z-20 mt-1 max-h-72 w-60 overflow-y-auto rounded-md border border-(--vscode-widget-border) bg-(--vscode-menu-background,var(--vscode-editorWidget-background)) p-1 text-xs shadow-lg"
						role="group"
						aria-label={t('adeWorkflow.board.projectFilter')}
						onkeydown={(e) => e.key === 'Escape' && (projectMenu = false)}
						onfocusout={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && (projectMenu = false)}
					>
						{#each projectChoices as p (p.id)}
							<label class="flex items-center gap-2 rounded px-2 py-1 hover:bg-(--vscode-list-hoverBackground)" title={p.id}>
								<input type="checkbox" checked={projectFilter.includes(p.id)} onchange={() => (projectFilter = toggleFilter(projectFilter, p.id))} />
								<span class="min-w-0 flex-1 truncate">{p.label}{p.id === here ? ` · ${t('adeWorkflow.board.openProject')}` : ''}</span>
								<span class="text-(--vscode-descriptionForeground)">{p.count}</span>
							</label>
						{/each}
						{#if projectFilter.length}
							<button class="mt-1 w-full rounded px-2 py-1 text-left text-(--vscode-textLink-foreground) hover:bg-(--vscode-list-hoverBackground)" onclick={() => (projectFilter = [])}>{t('adeWorkflow.board.clearFilters')}</button>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
		<select class="h-6 rounded-md border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) px-1 text-xs text-(--vscode-input-foreground)" aria-label={t('adeWorkflow.board.prFilter')} bind:value={prFilter}>
			<option value="">{t('adeWorkflow.board.prAll')}</option>
			{#each PR_GROUPS as g (g.id)}<option value={g.id}>{g.label}</option>{/each}
		</select>
		<label class="flex h-6 w-48 items-center gap-1 rounded-md border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) px-1.5 focus-within:border-(--vscode-focusBorder)">
			<Icon name="search" size={12} />
			<input bind:this={searchBox} class="min-w-0 flex-1 bg-transparent text-xs text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground)" placeholder={t('adeWorkflow.board.search')} aria-label={t('adeWorkflow.board.search')} bind:value={query} onkeydown={(e) => e.key === 'Escape' && (query = '')} />
		</label>
		<div class="flex h-6 rounded-md bg-(--vscode-input-background) p-px text-xs" role="group" aria-label={t('adeWorkflow.board.columns')}>
			<button class={['rounded px-2', !byAgent ? 'bg-(--vscode-foreground)/10 font-semibold' : 'text-(--vscode-descriptionForeground)']} aria-pressed={!byAgent} title={t('adeWorkflow.board.byWorkflowTitle')} onclick={() => setView(false)}>{t('adeWorkflow.board.byWorkflow')}</button>
			<button class={['rounded px-2', byAgent ? 'bg-(--vscode-foreground)/10 font-semibold' : 'text-(--vscode-descriptionForeground)']} aria-pressed={byAgent} title={t('adeWorkflow.board.byAgentTitle')} onclick={() => setView(true)}>{t('adeWorkflow.board.byAgent')}</button>
		</div>
		<button class={ICON_BUTTON} aria-label={t('adeWorkflow.board.popOut')} title={t('adeWorkflow.board.popOutTitle')} aria-pressed={boardPopout.mine} onclick={() => void boardPopout.popOut()}><Icon name="openExternal" size={16} /></button>
		<button class={BUTTON} onclick={() => (adeTasks.composing = !adeTasks.composing)}><Icon name="plus" size={14} /> {t('adeWorkflow.board.newTask')}</button>
		<button class={ICON_BUTTON} aria-label={t('adeWorkflow.board.cleanUp')} title={t('adeWorkflow.board.cleanUpTitle')} disabled={!adeTasks.views.length} onclick={() => (cleanup.open = true)}><Icon name="trash" size={16} /></button>
		<button class={ICON_BUTTON} aria-label="Workspace Space" title="Workspace Space: disk used by each task's worktree" onclick={() => workspaceSpace.show()}><Icon name="chartBar" size={16} /></button>
		<button class={ICON_BUTTON} aria-label={t('adeWorkflow.board.refresh')} title={t('adeWorkflow.board.refresh')} onclick={() => adeTasks.load()}><Icon name="refresh" size={16} /></button>
	</header>
	{#if filteringProjects}
		<div class="flex shrink-0 flex-wrap items-center gap-1 px-4 pt-2 text-xs">
			{#each projectFilter as id (id)}
				<span class="flex items-center gap-1 rounded-full bg-(--vscode-badge-background) py-0.5 pr-1 pl-2 text-(--vscode-badge-foreground)">
					{projectName(id)}
					<button class="grid size-4 place-items-center rounded-full hover:bg-black/20" aria-label={t('adeWorkflow.board.removeFilter', { name: projectName(id) })} onclick={() => (projectFilter = toggleFilter(projectFilter, id))}><Icon name="close" size={10} /></button>
				</span>
			{/each}
			<button class="text-(--vscode-textLink-foreground) hover:underline" onclick={() => (projectFilter = [])}>{t('adeWorkflow.board.clearFilters')}</button>
		</div>
	{/if}
	{#if adeTasks.composing}
		<div class="max-w-xl shrink-0 px-2"><NewTaskForm /></div>
	{/if}
	<div class="grid min-h-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden p-4" style:grid-template-columns="repeat({lanes.length}, {width}px)">
		{#each lanes as lane (lane.id)}
			<section
				aria-label={lane.label}
				class={['flex min-h-0 flex-col rounded-xl border', lane.drop && over === lane.id ? 'border-(--vscode-focusBorder)' : 'border-(--vscode-widget-border)']}
				style:background="color-mix(in srgb, var(--vscode-sideBar-background) {opacity}%, transparent)"
				ondragover={lane.drop ? (e) => (e.preventDefault(), (over = lane.id)) : undefined}
				ondragleave={lane.drop ? (e) => e.currentTarget === e.target && over === lane.id && (over = null) : undefined}
				ondrop={lane.drop ? (e) => onDrop(e, lane.id) : undefined}
			>
				<h2 class="flex shrink-0 items-center gap-2 px-3.5 py-2.5 text-xs font-semibold" title={lane.hint}>
					<span class={['size-2 rounded-full', COLUMN_DOT[lane.id] ?? 'bg-(--vscode-descriptionForeground)']}></span>
					{lane.label}
					<span class="rounded-full bg-(--vscode-badge-background) px-1.5 text-[10px] leading-4 font-normal text-(--vscode-badge-foreground)">{lane.tasks.length}</span>
				</h2>
				<div class="min-h-0 flex-1 space-y-2 overflow-y-auto px-2.5 pb-2.5">
					<!-- Attempts of one prompt together, a stacked task under its parent (attempts.ts). -->
					{#each nestTasks(lane.tasks.map((v) => {
						// Slugs and attempt groups are per project: keyed by project so two never meet.
						const p = `${rootOf.get(v) ?? here}\u0000`;
						return { slug: p + v.meta.slug, parent: v.meta.parent ? p + v.meta.parent : v.meta.parent, group: v.meta.group ? p + v.meta.group : v.meta.group, view: v };
					})) as { item: { view, slug: key }, depth } (key)}
						{#if lane.drop}
							<div
								role="listitem"
								draggable="true"
								class={dragging === view.meta.slug ? 'opacity-50' : ''}
								style:margin-left={depth ? `${Math.min(depth, 3) * 12}px` : undefined}
								title={t('adeWorkflow.board.cardTitle', { title: view.meta.title })}
								ondragstart={(e) => ((dragging = view.meta.slug), e.dataTransfer?.setData(DRAG_TYPE, view.meta.slug), e.dataTransfer && (e.dataTransfer.effectAllowed = 'move'))}
								ondragend={() => (dragging = over = null)}
							>
								<TaskCard {view} />
							</div>
						{:else if (rootOf.get(view) ?? here) !== here}
							<div style:margin-left={depth ? `${Math.min(depth, 3) * 12}px` : undefined}><ProjectTaskCard {view} root={rootOf.get(view) ?? here} /></div>
						{:else}
							<div style:margin-left={depth ? `${Math.min(depth, 3) * 12}px` : undefined}><TaskCard {view} /></div>
						{/if}
					{:else}
						<p class="rounded-lg border border-dashed border-(--vscode-widget-border) px-3 py-6 text-center text-xs text-(--vscode-descriptionForeground)">
							{lane.drop && dragging ? t('adeWorkflow.board.dropHere') : t('adeWorkflow.board.empty')}
						</p>
					{/each}
				</div>
			</section>
		{/each}
	</div>
</div>
