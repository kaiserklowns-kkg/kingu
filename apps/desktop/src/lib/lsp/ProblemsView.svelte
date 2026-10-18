<script lang="ts">
	// Problems panel (VS Code: MarkersView): diagnostics grouped by file (`problems.defaultViewMode:
	// tree`) or one row per problem (`table`), ordered by `problems.sortOrder`. With
	// `problems.autoReveal` the active editor's file is expanded and scrolled into view.
	import { SvelteSet } from 'svelte/reactivity';
	import { tick } from 'svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { severityName } from './convert';
	import { lsp } from './lsp.svelte';
	import { problemTable, sortProblems, type ProblemsSortOrder } from './problemsSettings';
	import type { Diagnostic } from './protocol';
	import type { ProblemFile } from './model';

	const collapsed = new SvelteSet<string>();
	const icon = { error: 'error', warning: 'warning', info: 'info', hint: 'info' } as const;
	const color = {
		error: 'text-(--vscode-editorError-foreground)',
		warning: 'text-(--vscode-editorWarning-foreground)',
		info: 'text-(--vscode-editorInfo-foreground)',
		hint: 'text-(--vscode-descriptionForeground)'
	};

	const order = $derived(settings.get<ProblemsSortOrder>('problems.sortOrder'));
	const table = $derived(settings.get<string>('problems.defaultViewMode') === 'table');
	const rows = $derived(table ? problemTable(lsp.problems, order) : []);
	let scroller: HTMLDivElement | undefined = $state();

	const base = (p: string) => p.split('/').pop() ?? p;
	const dir = (p: string) => p.split('/').slice(0, -1).join('/');

	function toggle(uri: string) {
		if (collapsed.has(uri)) collapsed.delete(uri);
		else collapsed.add(uri);
	}

	function open(file: ProblemFile, d: Diagnostic) {
		if (file.rel !== null) editors.openAt(file.rel, d.range.start.line + 1, d.range.start.character + 1, { preview: true });
	}

	// problems.autoReveal: follow the active editor.
	$effect(() => {
		const active = editors.active;
		if (!active || !settings.get<boolean>('problems.autoReveal')) return;
		const file = lsp.problems.find((f) => f.rel === active);
		if (!file) return;
		collapsed.delete(file.uri);
		void tick().then(() => scroller?.querySelector(`[data-uri="${CSS.escape(file.uri)}"]`)?.scrollIntoView({ block: 'nearest' }));
	});
</script>

{#snippet message(d: Diagnostic)}
	<span class="whitespace-pre-wrap">{d.message}</span>
	{#if d.source || d.code !== undefined}
		<span class="text-(--vscode-descriptionForeground)">{d.source ?? ''}{d.code !== undefined ? `(${d.code})` : ''}</span>
	{/if}
{/snippet}

{#if lsp.problems.length === 0}
	<p class="px-5 py-1 text-(--vscode-descriptionForeground)">No problems have been detected in the workspace.</p>
{:else if table}
	<div bind:this={scroller} role="table" aria-label="Problems" class="h-full overflow-y-auto py-0.5">
		<div role="row" class="sticky top-0 flex h-(--kg-row-height) items-center gap-2 bg-(--vscode-panel-background) pr-2 pl-2 text-[11px] text-(--vscode-descriptionForeground) uppercase">
			<span role="columnheader" class="w-4 shrink-0"></span>
			<span role="columnheader" class="min-w-0 flex-[3]">Message</span>
			<span role="columnheader" class="min-w-0 flex-1">File</span>
			<span role="columnheader" class="w-24 shrink-0">Source</span>
			<span role="columnheader" class="w-24 shrink-0">Position</span>
		</div>
		{#each rows as { file, item: d }, i (i)}
			{@const sev = severityName(d.severity)}
			<button
				role="row"
				data-uri={file.uri}
				disabled={file.rel === null}
				title={d.message}
				class="flex min-h-(--kg-row-height) w-full items-start gap-2 py-0.5 pr-2 pl-2 text-left hover:bg-(--vscode-list-hoverBackground) disabled:cursor-default"
				onclick={() => open(file, d)}
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
		{#each lsp.problems as file (file.uri)}
			{@const isOpen = !collapsed.has(file.uri)}
			<button
				role="treeitem"
				aria-selected="false"
				aria-expanded={isOpen}
				data-uri={file.uri}
				title={file.label}
				class="flex h-(--kg-row-height) w-full items-center gap-1 pr-2 pl-1 text-left hover:bg-(--vscode-list-hoverBackground)"
				onclick={() => toggle(file.uri)}
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
						aria-selected="false"
						disabled={file.rel === null}
						title={d.message}
						class="flex min-h-(--kg-row-height) w-full items-start gap-1.5 py-0.5 pr-2 pl-7 text-left hover:bg-(--vscode-list-hoverBackground) disabled:cursor-default"
						onclick={() => open(file, d)}
					>
						<span class={['mt-px shrink-0', color[sev]]}><Icon name={icon[sev]} size={14} /></span>
						<span class="min-w-0 flex-1">
							{@render message(d)}
							<span class="whitespace-nowrap text-(--vscode-descriptionForeground)">[Ln {line}, Col {col}]</span>
						</span>
					</button>
				{/each}
			{/if}
		{/each}
	</div>
{/if}
