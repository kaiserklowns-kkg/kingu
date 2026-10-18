<script lang="ts">
	// Files of one worktree for the Agents layout's right side bar (Orca's file explorer): a lazy
	// tree with a name filter over the loaded folders. A click opens the file as a preview tab of
	// the worktree in the Agents layout's center (Orca keeps files next to the agent); a double
	// click keeps the tab. `Contents` searches inside the worktree's files instead (Orca's Names / Contents).
	import { untrack } from 'svelte';
	import { Channel, invoke } from '@tauri-apps/api/core';
	import FileIcon from '#lib/workbench/FileIcon.svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { fileIcon, folderIcon } from '#lib/workbench/fileIcons.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { worktreeDir } from './keys';
	import { adeLayout } from './adeLayout.svelte';
	import { adeTasks } from './tasks.svelte';
	import { scm } from '#lib/workbench/scm.svelte.ts';
	import { entryChanges, fileDecorations } from '#lib/workbench/scm.ts';

	type Entry = { name: string; rel: string; is_dir: boolean; ignored?: boolean };
	type Row = Entry & { depth: number; open: boolean };

	/** '' for the folder itself, else a task slug. */
	let { slug }: { slug: string } = $props();

	const base = $derived(slug ? worktreeDir(slug) : '');
	let children = $state<Record<string, Entry[]>>({});
	let open = $state<Record<string, boolean>>({});
	let error = $state('');
	let filter = $state('');
	let by = $state<'names' | 'contents'>('names');

	type Hit = { path: string; lines: { line: number; text: string }[] };
	type SearchEvent = { kind: 'file'; path: string; matches: { line: number; text: string }[] } | { kind: 'done' } | { kind: 'error'; message: string };
	let hits = $state<Hit[]>([]);
	let searching = $state(false);
	let generation = 0;

	// Contents: ripgrep (`search_text`) over this worktree. Task worktrees live under the git-ignored
	// `.kingu/`, so they skip ignore files and leave out the usual build folders instead.
	$effect(() => {
		const query = by === 'contents' ? filter.trim() : '';
		const include = slug ? `./${base}` : '';
		const run = ++generation;
		hits = [];
		if (!query) return void (searching = false);
		const timer = setTimeout(() => {
			searching = true;
			const onEvent = new Channel<SearchEvent>();
			onEvent.onmessage = (ev) => {
				if (run !== generation) return;
				if (ev.kind === 'file') hits = [...hits, { path: ev.path, lines: ev.matches.slice(0, 3) }];
				else searching = false;
			};
			const options = {
				query,
				is_regex: false,
				match_case: false,
				whole_word: false,
				include,
				exclude: slug ? 'node_modules, target, .git, .svelte-kit, dist, build' : '',
				use_ignore_files: !slug,
				max_results: 500
			};
			invoke('search_text', { options, onEvent }).catch(() => run === generation && (searching = false));
		}, 250);
		return () => clearTimeout(timer);
	});

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

	// Orca's M / U letters: the folder's own git status, or a task's changes since its fork point.
	const decorations = $derived(
		slug
			? fileDecorations((adeTasks.find(slug)?.stat?.files ?? []).map((f) => ({ path: f.path, code: f.status })), `${base}/`)
			: fileDecorations(entryChanges(scm.repo?.entries ?? []))
	);

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

	function activate(r: Row, preview = true) {
		if (r.is_dir) void toggle(r.rel);
		else adeLayout.openFile(slug, r.rel, { preview });
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
	<label class="mx-2 mb-1.5 flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) px-2 text-[13px] focus-within:border-(--vscode-focusBorder)">
		<Icon name="search" size={13} />
		<span class="sr-only">หาไฟล์</span>
		<input class="min-w-0 flex-1 bg-transparent outline-none placeholder:text-(--vscode-input-placeholderForeground)" placeholder={by === 'names' ? 'Find files (โฟลเดอร์ที่เปิดแล้ว)' : 'ค้นหาในเนื้อหาไฟล์'} bind:value={filter} />
	</label>
	<div class="mx-2 mb-2 grid shrink-0 grid-cols-2 rounded-md bg-(--vscode-input-background) p-0.5 text-xs" role="radiogroup" aria-label="ค้นหาจาก">
		{#each [['names', 'Names'], ['contents', 'Contents']] as const as [id, label] (id)}
			<button
				role="radio"
				aria-checked={by === id}
				class={['h-6 rounded-[5px]', by === id ? 'bg-(--vscode-editor-background) text-(--vscode-foreground) shadow-sm' : 'text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)']}
				onclick={() => (by = id)}>{label}</button
			>
		{/each}
	</div>
	{#if by === 'contents' && filter.trim()}
		<div class="min-h-0 flex-1 overflow-y-auto pb-2 text-[13px]" aria-label="ผลการค้นหา">
			{#each hits as h (h.path)}
				{@const name = h.path.slice(h.path.lastIndexOf('/') + 1)}
				<button class="flex h-[22px] w-full items-center gap-1.5 px-2 text-left hover:bg-(--vscode-list-hoverBackground)" title={h.path} onclick={() => adeLayout.openFile(slug, h.path, { preview: true })}>
					<FileIcon icon={fileIcon(name)} />
					<span class="truncate">{name}</span>
					<span class="min-w-0 flex-1 truncate text-xs text-(--vscode-descriptionForeground)">{h.path.slice(base ? base.length + 1 : 0, -name.length - 1)}</span>
				</button>
				{#each h.lines as l (l.line)}
					<button class="block h-[22px] w-full truncate pr-2 pl-8 text-left font-mono text-xs text-(--vscode-descriptionForeground) hover:bg-(--vscode-list-hoverBackground) hover:text-(--vscode-foreground)" onclick={() => adeLayout.openFile(slug, h.path, { preview: true })}>
						<span class="opacity-60">{l.line}</span> {l.text}
					</button>
				{/each}
			{:else}
				<p class="px-3 py-2 text-xs text-(--vscode-descriptionForeground)">{searching ? 'กำลังค้นหา…' : 'ไม่พบ'}</p>
			{/each}
		</div>
	{:else}
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
				ondblclick={() => !r.is_dir && activate(r, false)}
			>
				<span class="grid w-4 shrink-0 place-items-center text-(--vscode-icon-foreground)">
					{#if r.is_dir}<Icon name={r.open ? 'chevronDown' : 'chevronRight'} size={14} />{/if}
				</span>
				<FileIcon icon={r.is_dir ? folderIcon(r.rel, r.open) : fileIcon(r.name)} />
				<span class={['min-w-0 flex-1 truncate', r.ignored && 'italic opacity-55']} style:color={decorations.get(r.rel)?.color}>{r.name}</span>
				{#if r.ignored}<span class="shrink-0 pl-2 opacity-55" title="ถูก .gitignore"><Icon name="ignored" size={12} /></span>
				{:else if decorations.has(r.rel)}{@const deco = decorations.get(r.rel)!}<span class="shrink-0 pl-2 text-[11px] font-semibold" style:color={deco.color}>{deco.letter || '•'}</span>{/if}
			</button>
		{/each}
	</div>
	{/if}
</div>
