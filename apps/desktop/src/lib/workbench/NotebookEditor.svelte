<script lang="ts">
	// The notebook editor (VS Code's NotebookEditor for .ipynb): a toolbar (add cells, Run All,
	// Clear All Outputs, Interrupt, Restart, the kernel picker), then the cells. Code cells are Monaco
	// editors with an execution count and their outputs; Markdown cells render until edited.
	// Command mode (focus on the list) takes VS Code's keys (notebookCommands.svelte.ts and here:
	// ↑/↓, Enter, ⌘Z); edit mode is a cell's editor with focus.
	import { tick, untrack } from 'svelte';
	import { t } from '#lib/i18n/index.ts';
	import { openEditorLink } from '#lib/editor/linkOpener.ts';
	import Icon from './Icon.svelte';
	import { editors } from './editors.svelte';
	import { keyLabel } from './keys';
	import { renderMarkdown } from './markdown';
	import { notebookLanguage, type CellKind, type NbCell } from './notebook';
	import { notebooks } from './notebookEditors.svelte';
	import NotebookCellEditor from './NotebookCellEditor.svelte';
	import NotebookOutputs from './NotebookOutputs.svelte';
	import type { KernelStatus } from './notebookKernel';

	let { path, group }: { path: string; group: number } = $props();

	// The group re-mounts this view per path (`{#key}`), so the state is read once.
	const nb = untrack(() => notebooks.get(path));
	const language = $derived(notebookLanguage(nb.doc));
	let list: HTMLDivElement | undefined = $state();

	const STATUS: Record<KernelStatus, () => string> = {
		off: () => t('notebook.kernelStatus.off'),
		starting: () => t('notebook.kernelStatus.starting'),
		idle: () => t('notebook.kernelStatus.idle'),
		busy: () => t('notebook.kernelStatus.busy'),
		restarting: () => t('notebook.kernelStatus.restarting'),
		dead: () => t('notebook.kernelStatus.dead')
	};
	const KIND: Record<CellKind, () => string> = { code: () => t('notebook.kind.code'), markdown: () => t('notebook.kind.markdown'), raw: () => t('notebook.kind.raw') };

	const cellLanguage = (c: NbCell) => (c.kind === 'markdown' ? 'markdown' : c.kind === 'raw' ? 'plaintext' : language);

	// Command mode: the list takes focus (after Escape, a delete, an Outline pick).
	$effect(() => {
		if (nb.focusList) void tick().then(() => list?.focus({ preventScroll: true }));
	});
	// The selected cell stays in view.
	$effect(() => {
		void nb.reveal;
		const index = nb.selected;
		void tick().then(() => list?.querySelector(`[data-cell-index="${index}"]`)?.scrollIntoView({ block: 'nearest' }));
	});

	function onListKey(e: KeyboardEvent) {
		if (e.target !== list) return;
		const mod = e.metaKey || e.ctrlKey;
		if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) nb.move(e.key === 'ArrowUp' ? -1 : 1);
		else if (e.key === 'ArrowDown' && !e.altKey && !mod) nb.select(nb.selected + 1);
		else if (e.key === 'ArrowUp' && !e.altKey && !mod) nb.select(nb.selected - 1);
		else if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !mod && nb.cell) nb.edit(nb.cell.key);
		else if (mod && e.key.toLowerCase() === 'z') e.shiftKey ? nb.redo() : nb.undo();
		else if (e.key === 'Home') nb.select(0);
		else if (e.key === 'End') nb.select(nb.doc.cells.length - 1);
		else return;
		e.preventDefault();
	}

	function onCellMouseDown(index: number, e: MouseEvent) {
		editors.activateGroup(group);
		nb.select(index);
		// A click outside the cell's editor is command mode on that cell.
		if (!(e.target as Element).closest('.monaco-editor, button, a, .nb-outputs')) {
			nb.editing = null;
			void tick().then(() => list?.focus({ preventScroll: true }));
		}
	}

	function onMarkdownClick(e: MouseEvent) {
		const a = (e.target as Element).closest('a[data-href]');
		if (!a) return;
		e.preventDefault();
		openEditorLink(a.getAttribute('data-href') ?? '');
	}

	const toolButton = 'flex h-[22px] items-center gap-1 rounded px-1.5 text-[12px] text-(--vscode-foreground) hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
	const cellButton = 'grid size-[22px] place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
</script>

{#snippet adder(index: number)}
	<div class="group/add flex h-4 items-center justify-center gap-2 opacity-0 hover:opacity-100 focus-within:opacity-100">
		<button class={toolButton} title={t('notebook.addCodeTitle')} onclick={() => nb.insert('code', 'above', index)}><Icon name="plus" size={12} />{t('notebook.addCode')}</button>
		<button class={toolButton} title={t('notebook.addMarkdownTitle')} onclick={() => nb.insert('markdown', 'above', index)}><Icon name="plus" size={12} />{t('notebook.addMarkdown')}</button>
	</div>
{/snippet}

<div class="flex h-full flex-col bg-(--vscode-editor-background)" data-notebook>
	<div class="flex h-[30px] shrink-0 items-center gap-0.5 border-b border-(--vscode-editorGroupHeader-tabsBorder,transparent) px-2" role="toolbar" aria-label={t('notebook.listLabel')}>
		<button class={toolButton} title={t('notebook.addCodeTitle')} onclick={() => nb.insert('code', 'below')}><Icon name="plus" size={13} />{t('notebook.addCode')}</button>
		<button class={toolButton} title={t('notebook.addMarkdownTitle')} onclick={() => nb.insert('markdown', 'below')}><Icon name="plus" size={13} />{t('notebook.addMarkdown')}</button>
		<span class="mx-1 h-4 w-px bg-(--vscode-widget-border)"></span>
		<button class={toolButton} onclick={() => nb.runAll()}><Icon name="play" size={13} />{t('notebook.runAll')}</button>
		<button class={toolButton} onclick={() => nb.clearOutputs()}><Icon name="clearAll" size={13} />{t('notebook.clearAll')}</button>
		<span class="mx-1 h-4 w-px bg-(--vscode-widget-border)"></span>
		<button class={toolButton} disabled={nb.status !== 'busy'} onclick={() => nb.interrupt()}><Icon name="stop" size={13} />{t('notebook.interrupt')}</button>
		<button class={toolButton} disabled={nb.status === 'off'} onclick={() => nb.restart()}><Icon name="refresh" size={13} />{t('notebook.restart')}</button>
		<span class="flex-1"></span>
		<button class={toolButton} title={t('notebook.selectKernel')} onclick={() => nb.pickKernel()}>
			<span
				class={[
					'size-2 rounded-full',
					nb.status === 'busy' || nb.status === 'starting' || nb.status === 'restarting' ? 'bg-(--vscode-charts-yellow)' : nb.status === 'idle' ? 'bg-(--vscode-charts-green)' : nb.status === 'dead' ? 'bg-(--vscode-errorForeground)' : 'bg-(--vscode-descriptionForeground)'
				]}
				aria-hidden="true"
			></span>
			{nb.kernel?.spec.displayName ?? t('notebook.selectKernel')}
			<span class="text-(--vscode-descriptionForeground)">· {STATUS[nb.status]()}</span>
		</button>
	</div>

	{#if nb.status === 'dead' && nb.kernelError}
		<p class="shrink-0 border-b border-(--vscode-widget-border) px-4 py-1.5 text-[12px] text-(--vscode-errorForeground)">{t('notebook.kernelDied', { error: nb.kernelError })}</p>
	{/if}

	{#if nb.error}
		<p class="p-6 text-[13px] text-(--vscode-errorForeground)">{t('notebook.openFailed', { error: nb.error })}</p>
	{:else if nb.loaded}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<div
			bind:this={list}
			class="min-h-0 flex-1 overflow-y-auto outline-none"
			role="list"
			aria-label={t('notebook.listLabel')}
			tabindex="0"
			onkeydown={onListKey}
		>
			<div class="mx-auto flex max-w-[1100px] flex-col px-4 py-3 text-[13px]">
				{#each nb.doc.cells as cell, i (cell.key)}
					{@const selected = nb.selected === i}
					{@const editing = nb.editing === cell.key}
					{@const run = nb.runs[cell.key]}
					{@render adder(i)}
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<div
						role="listitem"
						aria-label={t('notebook.cellLabel', { kind: KIND[cell.kind](), index: i + 1 })}
						aria-current={selected ? 'true' : undefined}
						data-cell-index={i}
						class={[
							'group/cell relative flex gap-2 rounded-md border-l-[3px] py-1 pr-1',
							selected ? 'border-l-(--vscode-focusBorder) bg-(--vscode-list-inactiveSelectionBackground,transparent)' : 'border-l-transparent hover:bg-(--vscode-list-hoverBackground)'
						]}
						onmousedown={(e) => onCellMouseDown(i, e)}
					>
						<div class="flex w-12 shrink-0 flex-col items-end gap-0.5 pt-1.5">
							{#if cell.kind === 'code'}
								<button
									class={cellButton}
									title="{run === 'running' ? t('notebook.interrupt') : t('notebook.runCell')} ({keyLabel('ctrl+enter')})"
									aria-label={run === 'running' ? t('notebook.interrupt') : t('notebook.runCell')}
									onclick={() => (run ? nb.interrupt() : nb.runCell(i))}
								>
									<Icon name={run ? 'stop' : 'play'} size={13} />
								</button>
								<span class="font-mono text-[11px] text-(--vscode-descriptionForeground)" title={run === 'queued' ? t('notebook.queued') : run === 'running' ? t('notebook.running') : undefined}
									>[{run === 'running' ? '*' : run === 'queued' ? '-' : (cell.count ?? ' ')}]</span
								>
							{/if}
						</div>
						<div class="min-w-0 flex-1">
							{#if cell.kind === 'markdown' && !editing}
								<!-- Safe: renderMarkdown escapes raw HTML and drops images and hrefs. -->
								<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
								<div class="markdown-cell kg-selectable min-h-6 px-2 py-1" ondblclick={() => nb.edit(cell.key)} onclick={onMarkdownClick}>
									{#if cell.source.trim()}
										{@html renderMarkdown(cell.source)}
									{:else}
										<p class="text-(--vscode-descriptionForeground) italic">{t('notebook.emptyMarkdown')}</p>
									{/if}
								</div>
							{:else}
								<div class={['overflow-hidden rounded-md border', editing ? 'border-(--vscode-focusBorder)' : 'border-(--vscode-widget-border)', 'bg-(--vscode-input-background)']}>
									<NotebookCellEditor {nb} {cell} language={cellLanguage(cell)} label={t('notebook.cellLabel', { kind: KIND[cell.kind](), index: i + 1 })} />
								</div>
							{/if}
							{#if cell.kind === 'code' && cell.outputs.length}
								<NotebookOutputs outputs={cell.outputs} />
							{/if}
						</div>
						<div class={['absolute -top-3 right-2 z-10 items-center gap-0.5 rounded-md border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background) px-0.5 shadow-sm', selected ? 'flex' : 'hidden group-hover/cell:flex']}>
							{#if cell.kind === 'markdown' && editing}
								<button class={cellButton} title={t('notebook.stopEditing')} aria-label={t('notebook.stopEditing')} onclick={() => nb.stopEditing()}><Icon name="check" size={13} /></button>
							{/if}
							<button class={cellButton} title={cell.kind === 'code' ? t('notebook.toMarkdown') : t('notebook.toCode')} aria-label={cell.kind === 'code' ? t('notebook.toMarkdown') : t('notebook.toCode')} onclick={() => nb.changeKind(cell.kind === 'code' ? 'markdown' : 'code', i)}
								><Icon name={cell.kind === 'code' ? 'fileText' : 'code'} size={13} /></button
							>
							<button class={cellButton} title="{t('notebook.moveUp')} ({keyLabel('alt+up')})" aria-label={t('notebook.moveUp')} disabled={i === 0} onclick={() => nb.move(-1, i)}><Icon name="arrowUp" size={13} /></button>
							<button class={cellButton} title="{t('notebook.moveDown')} ({keyLabel('alt+down')})" aria-label={t('notebook.moveDown')} disabled={i === nb.doc.cells.length - 1} onclick={() => nb.move(1, i)}
								><Icon name="arrowDown" size={13} /></button
							>
							<button class={cellButton} title={t('notebook.split')} aria-label={t('notebook.split')} onclick={() => nb.split(i)}><Icon name="rows" size={13} /></button>
							<button class={cellButton} title="{t('notebook.joinBelow')} ({keyLabel('ctrl+alt+j')})" aria-label={t('notebook.joinBelow')} disabled={nb.doc.cells[i + 1]?.kind !== cell.kind} onclick={() => nb.join('below', i)}
								><Icon name="merge" size={13} /></button
							>
							{#if cell.kind === 'code' && cell.outputs.length}
								<button class={cellButton} title={t('notebook.clearCell')} aria-label={t('notebook.clearCell')} onclick={() => nb.clearOutputs([cell.key])}><Icon name="clearAll" size={13} /></button>
							{/if}
							<button class={cellButton} title={t('notebook.delete')} aria-label={t('notebook.delete')} onclick={() => nb.delete(i)}><Icon name="trash" size={13} /></button>
						</div>
					</div>
				{/each}
				{@render adder(nb.doc.cells.length)}
			</div>
		</div>
	{/if}
</div>

<style>
	.markdown-cell :global(h1) {
		font-size: 1.6em;
		font-weight: 600;
		margin: 0.3em 0;
	}
	.markdown-cell :global(h2) {
		font-size: 1.3em;
		font-weight: 600;
		margin: 0.3em 0;
	}
	.markdown-cell :global(h3) {
		font-weight: 600;
	}
	.markdown-cell :global(p) {
		margin: 0.3em 0;
		line-height: 1.6;
	}
	.markdown-cell :global(ul) {
		list-style: disc;
		padding-left: 1.4em;
	}
	.markdown-cell :global(ol) {
		list-style: decimal;
		padding-left: 1.4em;
	}
	.markdown-cell :global(code) {
		font-family: Menlo, monospace;
		padding: 0.1em 0.3em;
		border-radius: 4px;
		background: rgb(128 128 128 / 0.16);
	}
	.markdown-cell :global(a) {
		color: var(--vscode-textLink-foreground);
		cursor: pointer;
	}
</style>
