<script lang="ts">
	// Problems panel (VS Code: MarkersView): diagnostics grouped by file (tree) or one row per
	// problem (table; `problems.defaultViewMode` until View as Tree / View as Table), ordered by
	// `problems.sortOrder`, narrowed by the filter box and toggles (problemsView.svelte.ts). With
	// `problems.autoReveal` the active editor's file is expanded and scrolled into view.
	import { tick } from 'svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import { severityName } from './convert';
	import { lsp } from './lsp.svelte';
	import { problemTable, sortProblems, type ProblemsSortOrder } from './problemsSettings';
	import { problemsView as view } from './problemsViewState.svelte';
	import type { Diagnostic } from './protocol';
	import type { ProblemFile } from './model';
	import PopupMenu, { menuItem } from '#lib/workbench/PopupMenu.svelte';
	import { commands } from '#lib/workbench/commands.svelte.ts';

	const icon = { error: 'error', warning: 'warning', info: 'info', hint: 'info' } as const;
	const color = {
		error: 'text-(--vscode-editorError-foreground)',
		warning: 'text-(--vscode-editorWarning-foreground)',
		info: 'text-(--vscode-editorInfo-foreground)',
		hint: 'text-(--vscode-descriptionForeground)'
	};

	const order = $derived(settings.get<ProblemsSortOrder>('problems.sortOrder'));
	const table = $derived(view.mode === 'table');
	const files = $derived(view.result.files);
	const rows = $derived(table ? problemTable(files, order) : []);
	let scroller: HTMLDivElement | undefined = $state();

	const base = (p: string) => p.split('/').pop() ?? p;
	const dir = (p: string) => p.split('/').slice(0, -1).join('/');
	const isSelected = (file: ProblemFile, d: Diagnostic) => view.selected?.file.uri === file.uri && view.selected.item === d;

	function open(file: ProblemFile, d: Diagnostic, preview = true) {
		view.selected = { file, item: d };
		if (file.rel !== null) editors.openAt(file.rel, d.range.start.line + 1, d.range.start.character + 1, { preview });
	}

	// Right-click a problem: Copy, Copy Message (VS Code's ProblemsPanelContext menu).
	let menu = $state<{ x: number; y: number } | null>(null);
	function contextMenu(e: MouseEvent, file: ProblemFile, d: Diagnostic) {
		e.preventDefault();
		view.selected = { file, item: d };
		menu = { x: e.clientX, y: e.clientY };
	}

	// problems.autoReveal: follow the active editor.
	$effect(() => {
		const active = editors.active;
		if (!active || !settings.get<boolean>('problems.autoReveal')) return;
		const file = files.find((f) => f.rel === active);
		if (!file) return;
		view.collapsed.delete(file.uri);
		void tick().then(() => scroller?.querySelector(`[data-uri="${CSS.escape(file.uri)}"]`)?.scrollIntoView({ block: 'nearest' }));
	});
</script>

{#snippet message(d: Diagnostic)}
	<span class={view.multiline ? 'whitespace-pre-wrap' : 'truncate'}>{view.multiline ? d.message : d.message.split('\n')[0]}</span>
	{#if d.source || d.code !== undefined}
		<span class="text-(--vscode-descriptionForeground)">{d.source ?? ''}{d.code !== undefined ? `(${d.code})` : ''}</span>
	{/if}
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="h-full" data-problems-view onkeydown={(e) => view.listKeydown(e)}>
	{#if lsp.problems.length === 0}
		<p class="px-5 py-1 text-(--vscode-descriptionForeground)">{t('problems.noProblems')}</p>
	{:else if files.length === 0}
		<p class="px-5 py-1 text-(--vscode-descriptionForeground)">
			{t('problems.noResults')}
			<button class="text-(--vscode-textLink-foreground) hover:underline" onclick={() => ((view.text = ''), (view.showErrors = view.showWarnings = view.showInfos = true), (view.activeFile = view.excludedFiles = false))}>{t('problems.clearFilters')}</button>
		</p>
	{:else if table}
		<div bind:this={scroller} role="table" aria-label="Problems" class="h-full overflow-y-auto py-0.5">
			<div role="row" class="sticky top-0 flex h-(--kg-row-height) items-center gap-2 bg-(--vscode-panel-background) pr-2 pl-2 text-[11px] text-(--vscode-descriptionForeground) uppercase">
				<span role="columnheader" class="w-4 shrink-0"></span>
				<span role="columnheader" class="min-w-0 flex-[3]">{t('problems.message')}</span>
				<span role="columnheader" class="min-w-0 flex-1">{t('problems.file')}</span>
				<span role="columnheader" class="w-24 shrink-0">{t('problems.source')}</span>
				<span role="columnheader" class="w-24 shrink-0">{t('problems.position')}</span>
			</div>
			{#each rows as { file, item: d }, i (i)}
				{@const sev = severityName(d.severity)}
				<button
					role="row"
					data-uri={file.uri}
					disabled={file.rel === null}
					title={d.message}
					class={['flex min-h-(--kg-row-height) w-full items-start gap-2 py-0.5 pr-2 pl-2 text-left hover:bg-(--vscode-list-hoverBackground) disabled:cursor-default', isSelected(file, d) && 'bg-(--vscode-list-inactiveSelectionBackground)']}
					onclick={() => open(file, d)}
					ondblclick={() => open(file, d, false)}
					oncontextmenu={(e) => contextMenu(e, file, d)}
				>
					<span role="cell" class={['mt-px w-4 shrink-0', color[sev]]}><Icon name={icon[sev]} size={14} /></span>
					<span role="cell" class="min-w-0 flex-[3] truncate">{d.message}</span>
					<span role="cell" class="min-w-0 flex-1 truncate" title={file.label}>{base(file.label)}</span>
					<span role="cell" class="w-24 shrink-0 truncate text-(--vscode-descriptionForeground)">{d.source ?? ''}{d.code !== undefined ? `(${d.code})` : ''}</span>
					<span role="cell" class="w-24 shrink-0 text-(--vscode-descriptionForeground)">[Ln {d.range.start.line + 1}, Col {d.range.start.character + 1}]</span>
				</button>
			{/each}
		</div>
	{:else}
		<div bind:this={scroller} role="tree" aria-label="Problems" class="h-full overflow-y-auto py-0.5">
			{#each files as file (file.uri)}
				{@const isOpen = !view.collapsed.has(file.uri)}
				<button
					role="treeitem"
					aria-selected="false"
					aria-expanded={isOpen}
					data-uri={file.uri}
					title={file.label}
					class="mx-1.5 flex h-(--kg-row-height) w-[calc(100%-12px)] items-center gap-1 rounded-md pr-2 pl-1 text-left hover:bg-(--vscode-list-hoverBackground)"
					onclick={() => view.toggle(file.uri)}
				>
					<Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={16} />
					<span class="whitespace-nowrap">{base(file.label)}</span>
					<span class="truncate text-(--vscode-descriptionForeground)">{dir(file.label)}</span>
					<span class="ml-auto rounded-full bg-(--vscode-badge-background) px-1.5 text-[11px] leading-4 text-(--vscode-badge-foreground)">{file.items.length}</span>
				</button>
				{#if isOpen}
					{#each sortProblems(file.items, order) as d, i (i)}
						{@const sev = severityName(d.severity)}
						{@const line = d.range.start.line + 1}
						{@const col = d.range.start.character + 1}
						<button
							role="treeitem"
							aria-selected={isSelected(file, d)}
							disabled={file.rel === null}
							title={d.message}
							class={['mx-1.5 flex min-h-(--kg-row-height) w-[calc(100%-12px)] items-start gap-1.5 rounded-md py-0.5 pr-2 pl-7 text-left hover:bg-(--vscode-list-hoverBackground) disabled:cursor-default', isSelected(file, d) && 'bg-(--vscode-list-inactiveSelectionBackground)']}
							onclick={() => open(file, d)}
							ondblclick={() => open(file, d, false)}
							oncontextmenu={(e) => contextMenu(e, file, d)}
						>
							<span class={['mt-px shrink-0', color[sev]]}><Icon name={icon[sev]} size={14} /></span>
							<span class={['min-w-0 flex-1', !view.multiline && 'flex gap-1']}>
								{@render message(d)}
								<span class="whitespace-nowrap text-(--vscode-descriptionForeground)">[Ln {line}, Col {col}]</span>
							</span>
						</button>
					{/each}
				{/if}
			{/each}
		</div>
	{/if}
</div>
{#if menu}
	<PopupMenu
		items={[menuItem('problems.action.copy', t('problems.copy')), menuItem('problems.action.copyMessage', t('problems.copyMessage'))]}
		label="Problems"
		x={menu.x}
		y={menu.y}
		onRun={(node) => node.type === 'item' && void commands.run(node.id)}
		onClose={() => (menu = null)}
	/>
{/if}
