<script lang="ts">
	// Files of one worktree for the Agents layout's right side bar (Orca's file explorer): a lazy
	// tree with a name filter over the loaded folders. A click opens the file in the editor.
	import { untrack } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import FileIcon from '#lib/workbench/FileIcon.svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { fileIcon, folderIcon } from '#lib/workbench/fileIcons.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { worktreeDir } from './keys';

	type Entry = { name: string; rel: string; is_dir: boolean };
	type Row = Entry & { depth: number; open: boolean };

	/** '' for the folder itself, else a task slug. */
	let { slug }: { slug: string } = $props();

	const base = $derived(slug ? worktreeDir(slug) : '');
	let children = $state<Record<string, Entry[]>>({});
	let open = $state<Record<string, boolean>>({});
	let error = $state('');
	let filter = $state('');

	async function load(rel: string) {
		try {
			children[rel] = await invoke<Entry[]>('fs_list_dir', { rel });
			if (rel === base) error = '';
		} catch (e) {
			if (rel === base) error = String(e);
		}
	}

	// Only `base` is a dependency: `load` reads and writes `children`.
	$effect(() => {
		const b = base;
		untrack(() => {
			children = {};
			open = {};
			void load(b);
		});
	});

	async function toggle(rel: string) {
		open[rel] = !open[rel];
		if (open[rel] && !children[rel]) await load(rel);
	}

	const rows = $derived.by(() => {
		const out: Row[] = [];
		const q = filter.trim().toLowerCase();
		const walk = (rel: string, depth: number) => {
			for (const e of children[rel] ?? []) {
				// The folder's own worktrees live under .kingu: they show as their own cards instead.
				if (!slug && e.rel === '.kingu') continue;
				const isOpen = !!open[e.rel];
				if (!q || e.is_dir || e.name.toLowerCase().includes(q)) out.push({ ...e, depth, open: isOpen });
				if (e.is_dir && (isOpen || q)) walk(e.rel, depth + 1);
			}
		};
		walk(base, 0);
		return out;
	});

	function activate(r: Row) {
		if (r.is_dir) void toggle(r.rel);
		else editors.open(r.rel, { preview: true });
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="flex h-9 shrink-0 items-center gap-1 pr-1 pl-3">
		<span class="min-w-0 flex-1 truncate text-[13px] font-medium">{slug ? `kingu/${slug}` : workspace.name}</span>
		<button class="grid size-6 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground)" aria-label="รีเฟรช" title="รีเฟรช" onclick={() => Promise.all([base, ...Object.keys(open).filter((k) => open[k])].map(load))}>
			<Icon name="refresh" size={15} />
		</button>
		<button class="grid size-6 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground)" aria-label="ยุบทั้งหมด" title="ยุบทั้งหมด" onclick={() => (open = {})}>
			<Icon name="collapseAll" size={15} />
		</button>
	</div>
	<label class="mx-2 mb-2 flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) px-2 text-[13px] focus-within:border-(--vscode-focusBorder)">
		<Icon name="search" size={13} />
		<span class="sr-only">หาไฟล์</span>
		<input class="min-w-0 flex-1 bg-transparent outline-none placeholder:text-(--vscode-input-placeholderForeground)" placeholder="Find files (โฟลเดอร์ที่เปิดแล้ว)" bind:value={filter} />
	</label>
	<div class="min-h-0 flex-1 overflow-y-auto pb-2 text-[13px]" role="tree" aria-label="Files">
		{#if error}
			<p class="px-3 text-xs text-(--vscode-errorForeground)">{error}</p>
		{/if}
		{#each rows as r (r.rel)}
			<button
				role="treeitem"
				aria-selected="false"
				aria-expanded={r.is_dir ? r.open : undefined}
				class="flex h-[22px] w-full items-center gap-1 pr-2 text-left hover:bg-(--vscode-list-hoverBackground)"
				style:padding-left="{8 + r.depth * 12}px"
				title={r.rel}
				onclick={() => activate(r)}
			>
				<span class="grid w-4 shrink-0 place-items-center text-(--vscode-icon-foreground)">
					{#if r.is_dir}<Icon name={r.open ? 'chevronDown' : 'chevronRight'} size={14} />{/if}
				</span>
				<FileIcon icon={r.is_dir ? folderIcon(r.rel, r.open) : fileIcon(r.name)} />
				<span class="truncate">{r.name}</span>
			</button>
		{/each}
	</div>
</div>
