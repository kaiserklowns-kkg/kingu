<script lang="ts">
	// Kanban board editor (`board://`), Orca's workspace board: the workflow columns you move tasks
	// between (Todo / In progress / In review / Done, or `kingu.board.statuses`; drag a card to
	// another column), or with `kingu.board.view` = agent the agent-status columns
	// (needs you / working / done).
	import Icon from '#lib/workbench/Icon.svelte';
	import NewTaskForm from './NewTaskForm.svelte';
	import TaskCard from './TaskCard.svelte';
	import { COLUMNS, type TaskView } from './model';
	import { adeTasks } from './tasks.svelte';
	import { BUTTON, ICON_BUTTON } from './ui';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { cleanup } from './cleanup.svelte';
	import { workflowColumns, workflowStatuses } from './workflow.ts';
	import { t } from '#lib/i18n/index.ts';

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

	type Lane = { id: string; label: string; hint?: string; tasks: TaskView[]; drop: boolean };
	const lanes = $derived<Lane[]>(
		byAgent
			? COLUMNS.map((c) => ({ id: c.id, label: c.label, hint: c.hint, tasks: adeTasks.groups[c.id], drop: false }))
			: workflowColumns(adeTasks.views, statuses).map((c) => ({ id: c.status.id, label: c.status.label, tasks: c.tasks, drop: true }))
	);

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

<div class="flex h-full flex-col overflow-hidden bg-(--vscode-editor-background) text-(--vscode-foreground)">
	<header class="flex shrink-0 items-center gap-2 border-b border-(--vscode-widget-border) px-4 py-2">
		<h1 class="flex items-center gap-2 text-sm font-semibold"><Icon name="tasks" size={16} />{t('adeWorkflow.board.title')}</h1>
		<span class="text-xs text-(--vscode-descriptionForeground)">{t('adeWorkflow.board.count', { count: adeTasks.list.length })}</span>
		<span class="flex-1"></span>
		<div class="flex h-6 rounded-md bg-(--vscode-input-background) p-px text-xs" role="group" aria-label={t('adeWorkflow.board.columns')}>
			<button class={['rounded px-2', !byAgent ? 'bg-(--vscode-foreground)/10 font-semibold' : 'text-(--vscode-descriptionForeground)']} aria-pressed={!byAgent} title={t('adeWorkflow.board.byWorkflowTitle')} onclick={() => setView(false)}>{t('adeWorkflow.board.byWorkflow')}</button>
			<button class={['rounded px-2', byAgent ? 'bg-(--vscode-foreground)/10 font-semibold' : 'text-(--vscode-descriptionForeground)']} aria-pressed={byAgent} title={t('adeWorkflow.board.byAgentTitle')} onclick={() => setView(true)}>{t('adeWorkflow.board.byAgent')}</button>
		</div>
		<button class={BUTTON} onclick={() => (adeTasks.composing = !adeTasks.composing)}><Icon name="plus" size={14} /> {t('adeWorkflow.board.newTask')}</button>
		<button class={ICON_BUTTON} aria-label={t('adeWorkflow.board.cleanUp')} title={t('adeWorkflow.board.cleanUpTitle')} disabled={!adeTasks.views.length} onclick={() => (cleanup.open = true)}><Icon name="trash" size={16} /></button>
		<button class={ICON_BUTTON} aria-label={t('adeWorkflow.board.refresh')} title={t('adeWorkflow.board.refresh')} onclick={() => adeTasks.load()}><Icon name="refresh" size={16} /></button>
	</header>
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
					{#each lane.tasks as view (view.meta.slug)}
						{#if lane.drop}
							<div
								role="listitem"
								draggable="true"
								class={dragging === view.meta.slug ? 'opacity-50' : ''}
								title={t('adeWorkflow.board.cardTitle', { title: view.meta.title })}
								ondragstart={(e) => ((dragging = view.meta.slug), e.dataTransfer?.setData(DRAG_TYPE, view.meta.slug), e.dataTransfer && (e.dataTransfer.effectAllowed = 'move'))}
								ondragend={() => (dragging = over = null)}
							>
								<TaskCard {view} />
							</div>
						{:else}
							<TaskCard {view} />
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
