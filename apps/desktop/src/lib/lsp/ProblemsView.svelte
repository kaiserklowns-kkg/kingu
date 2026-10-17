<script lang="ts">
	// Problems panel (VS Code: MarkersView): diagnostics grouped by file, errors first.
	import { SvelteSet } from 'svelte/reactivity';
	import Icon from '#lib/workbench/Icon.svelte';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { severityName } from './convert';
	import { lsp } from './lsp.svelte';

	const collapsed = new SvelteSet<string>();
	const icon = { error: 'error', warning: 'warning', info: 'info', hint: 'info' } as const;
	const color = {
		error: 'text-(--vscode-editorError-foreground)',
		warning: 'text-(--vscode-editorWarning-foreground)',
		info: 'text-(--vscode-editorInfo-foreground)',
		hint: 'text-(--vscode-descriptionForeground)'
	};

	const base = (p: string) => p.split('/').pop() ?? p;
	const dir = (p: string) => p.split('/').slice(0, -1).join('/');

	function toggle(uri: string) {
		if (collapsed.has(uri)) collapsed.delete(uri);
		else collapsed.add(uri);
	}
</script>

{#if lsp.problems.length === 0}
	<p class="px-5 py-1 text-(--vscode-descriptionForeground)">No problems have been detected in the workspace.</p>
{:else}
	<div role="tree" aria-label="Problems" class="h-full overflow-y-auto py-0.5">
		{#each lsp.problems as file (file.uri)}
			{@const open = !collapsed.has(file.uri)}
			<button
				role="treeitem"
				aria-selected="false"
				aria-expanded={open}
				title={file.label}
				class="flex h-(--kg-row-height) w-full items-center gap-1 pr-2 pl-1 text-left hover:bg-(--vscode-list-hoverBackground)"
				onclick={() => toggle(file.uri)}
			>
				<Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
				<span class="whitespace-nowrap">{base(file.label)}</span>
				<span class="truncate text-(--vscode-descriptionForeground)">{dir(file.label)}</span>
				<span class="ml-auto rounded-full bg-(--vscode-badge-background) px-1.5 text-[11px] leading-4 text-(--vscode-badge-foreground)">{file.items.length}</span>
			</button>
			{#if open}
				{#each file.items as d, i (i)}
					{@const sev = severityName(d.severity)}
					{@const line = d.range.start.line + 1}
					{@const col = d.range.start.character + 1}
					<button
						role="treeitem"
						aria-selected="false"
						disabled={file.rel === null}
						title={d.message}
						class="flex min-h-(--kg-row-height) w-full items-start gap-1.5 py-0.5 pr-2 pl-7 text-left hover:bg-(--vscode-list-hoverBackground) disabled:cursor-default"
						onclick={() => file.rel !== null && editors.openAt(file.rel, line, col, { preview: true })}
					>
						<span class={['mt-px shrink-0', color[sev]]}><Icon name={icon[sev]} size={14} /></span>
						<span class="min-w-0 flex-1">
							<span class="whitespace-pre-wrap">{d.message}</span>
							{#if d.source || d.code !== undefined}
								<span class="text-(--vscode-descriptionForeground)">{d.source ?? ''}{d.code !== undefined ? `(${d.code})` : ''}</span>
							{/if}
							<span class="whitespace-nowrap text-(--vscode-descriptionForeground)">[Ln {line}, Col {col}]</span>
						</span>
					</button>
				{/each}
			{/if}
		{/each}
	</div>
{/if}
