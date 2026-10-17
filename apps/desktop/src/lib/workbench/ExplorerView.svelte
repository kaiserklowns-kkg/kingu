<script lang="ts">
	import FileIcon from './FileIcon.svelte';
	import Icon from './Icon.svelte';
	import { fileIcon, folderIcon } from './fileIcons';
	import { explorer } from './explorer.svelte';
	import { editors } from './editors.svelte';

	let { workspaceName }: { workspaceName: string } = $props();

	let open = $state(true);
	let selected = $state<string | null>(null);

	$effect(() => {
		if (!explorer.children.has('')) explorer.load('');
	});

	const rows = $derived(explorer.rows());
</script>

<section class="flex min-h-0 flex-1 flex-col">
	<button
		class="flex h-(--kg-row-height) shrink-0 items-center gap-0.5 px-0.5 text-[11px] font-bold uppercase text-(--vscode-sideBarTitle-foreground)"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		<Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
		{workspaceName}
	</button>

	{#if open}
		<div role="tree" aria-label="ไฟล์ใน workspace" class="min-h-0 flex-1 overflow-y-auto">
			{#each rows as row (row.rel)}
				<button
					role="treeitem"
					aria-selected={selected === row.rel}
					aria-expanded={row.is_dir ? row.expanded : undefined}
					class={[
						'flex h-(--kg-row-height) w-full items-center gap-1 pr-2 text-left leading-(--kg-row-height) outline-offset-[-1px]',
						selected === row.rel
							? 'bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground) outline outline-1 outline-(--vscode-focusBorder)'
							: 'hover:bg-(--vscode-list-hoverBackground)',
						editors.active === row.rel && selected !== row.rel && 'bg-(--vscode-list-inactiveSelectionBackground)'
					]}
					style:padding-left="{8 + row.depth * 8}px"
					onclick={() => {
						selected = row.rel;
						if (row.is_dir) explorer.toggle(row.rel);
						else editors.open(row.rel, { preview: true });
					}}
					ondblclick={() => {
						if (!row.is_dir) editors.open(row.rel, { preview: false });
					}}
				>
					<span class="flex w-4 shrink-0 justify-center text-(--vscode-icon-foreground)">
						{#if row.is_dir}<Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} size={16} />{/if}
					</span>
					<FileIcon icon={row.is_dir ? folderIcon(row.rel, row.expanded) : fileIcon(row.name)} />
					<span class="truncate">{row.name}</span>
				</button>
			{/each}
			{#if explorer.error}<p class="px-4 py-1 text-(--vscode-errorForeground)">{explorer.error}</p>{/if}
		</div>
	{/if}
</section>
