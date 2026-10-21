<script lang="ts">
	// Refactor Preview panel (VS Code's BulkEditPane): the pending WorkspaceEdit as change
	// categories (change annotation labels) → files → edits, each with a checkbox. Clicking a file
	// or an edit opens the file's diff with the checked edits; Apply and Discard are in the panel's
	// title bar (Panel.svelte) and the palette.
	import { SvelteSet } from 'svelte/reactivity';
	import Icon from '#lib/workbench/Icon.svelte';
	import { listWheel } from '#lib/workbench/listWheel.ts';
	import { t } from '#lib/i18n/index.ts';
	import { uriToPath } from './convert';
	import { checkState, editLine, type PreviewEdit, type PreviewFile } from './refactorPreview.ts';
	import { refactorPreview as view } from './refactorPreview.svelte.ts';
	import { listKeys } from '#lib/workbench/listKeys.ts';

	const collapsed = new SvelteSet<string>();
	const total = $derived(view.tree.reduce((n, c) => n + c.files.reduce((m, f) => m + f.edits.length, 0), 0));

	/** The file's workspace path, else its absolute path. */
	const pathOf = (uri: string) => view.keyOf(uri) ?? uriToPath(uri) ?? uri;
	const base = (p: string) => p.split('/').pop() ?? p;
	const dir = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

	/** A checkbox for a group of edits: checked, unchecked or mixed. */
	function tristate(node: HTMLInputElement, edits: () => PreviewEdit[]) {
		$effect(() => {
			const s = checkState(edits(), view.checked);
			node.checked = s === 'all';
			node.indeterminate = s === 'some';
		});
	}

	function line(file: PreviewFile, e: PreviewEdit) {
		const text = view.originals.get(file.uri);
		return text === undefined ? null : editLine(text, e.edit);
	}
</script>

{#snippet fileRows(file: PreviewFile, key: string, depth: number)}
	{@const open = !collapsed.has(key)}
	{@const path = pathOf(file.uri)}
	<div role="treeitem" aria-selected="false" aria-expanded={open} class="mx-1.5 flex h-(--kg-row-height) items-center gap-1 rounded-md pr-2 hover:bg-(--vscode-list-hoverBackground)" style:padding-left="{depth * 12 + 4}px" title={path}>
		<button class="grid size-4 place-items-center" aria-label={open ? t('refactorPreview.collapse') : t('refactorPreview.expand')} onclick={() => (open ? collapsed.add(key) : collapsed.delete(key))}>
			<Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
		</button>
		<input type="checkbox" aria-label={t('refactorPreview.toggle', { name: base(path) })} use:tristate={() => file.edits} onchange={() => view.toggle(file.edits)} />
		<button class="flex min-w-0 flex-1 items-center gap-1.5 text-left" onclick={() => view.openDiff(file.uri)}>
			<span class="whitespace-nowrap">{base(path)}</span>
			<span class="truncate text-(--vscode-descriptionForeground)">{dir(path)}</span>
		</button>
		<span class="ml-auto rounded-full bg-(--vscode-badge-background) px-1.5 text-[11px] leading-4 text-(--vscode-badge-foreground)">{file.edits.length}</span>
	</div>
	{#if open}
		{#each file.edits as e (e.id)}
			{@const l = line(file, e)}
			<div role="treeitem" aria-selected="false" class="mx-1.5 flex h-(--kg-row-height) items-center gap-1.5 rounded-md pr-2 hover:bg-(--vscode-list-hoverBackground)" style:padding-left="{depth * 12 + 24}px">
				<input type="checkbox" aria-label={t('refactorPreview.toggleEdit')} checked={view.isChecked(e.id)} onchange={() => view.toggle([e])} />
				<button class="flex min-w-0 flex-1 items-center text-left font-mono text-xs whitespace-pre" onclick={() => view.openDiff(file.uri)}>
					{#if l}
						<span class="truncate"
							>{l.before}{#if l.removed}<span class="bg-(--vscode-diffEditor-removedTextBackground) line-through">{l.removed}</span>{/if}{#if l.inserted}<span class="bg-(--vscode-diffEditor-insertedTextBackground)">{l.inserted}</span>{/if}{l.after}</span
						>
						<span class="ml-2 shrink-0 font-sans text-(--vscode-descriptionForeground)">{t('refactorPreview.line', { line: l.line })}</span>
					{:else}
						<span class="truncate">{e.edit.newText}</span>
					{/if}
				</button>
			</div>
		{/each}
	{/if}
{/snippet}

<div class="flex h-full flex-col text-[13px]">
	{#if !view.pending}
		<p class="px-4 py-2 text-(--vscode-descriptionForeground)">{t('refactorPreview.empty')}</p>
	{:else}
		<p class="truncate px-4 py-1 text-(--vscode-descriptionForeground)">
			{view.pending.label ? `${view.pending.label} · ` : ''}{t('refactorPreview.summary', { edits: total, files: new Set(view.tree.flatMap((c) => c.files.map((f) => f.uri))).size })}
		</p>
		<div role="tree" aria-label={t('refactorPreview.title')} class="min-h-0 flex-1 overflow-y-auto py-0.5" use:listWheel use:listKeys>
			{#each view.tree as cat (cat.label)}
				{#if cat.label}
					{@const key = `cat:${cat.label}`}
					{@const open = !collapsed.has(key)}
					{@const edits = cat.files.flatMap((f) => f.edits)}
					<div role="treeitem" aria-selected="false" aria-expanded={open} class="mx-1.5 flex h-(--kg-row-height) items-center gap-1 rounded-md pr-2 pl-1 hover:bg-(--vscode-list-hoverBackground)" title={cat.annotation?.description}>
						<button class="grid size-4 place-items-center" aria-label={open ? t('refactorPreview.collapse') : t('refactorPreview.expand')} onclick={() => (open ? collapsed.add(key) : collapsed.delete(key))}>
							<Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
						</button>
						<input type="checkbox" aria-label={t('refactorPreview.toggle', { name: cat.label })} use:tristate={() => edits} onchange={() => view.toggle(edits)} />
						<span class="truncate">{cat.label}</span>
						{#if cat.annotation?.description}<span class="truncate text-(--vscode-descriptionForeground)">{cat.annotation.description}</span>{/if}
					</div>
					{#if open}
						{#each cat.files as file (file.uri)}{@render fileRows(file, `${key}\0${file.uri}`, 1)}{/each}
					{/if}
				{:else}
					{#each cat.files as file (file.uri)}{@render fileRows(file, file.uri, 0)}{/each}
				{/if}
			{/each}
		</div>
	{/if}
</div>
