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
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import type { MenuNode } from '#lib/workbench/menus.ts';
	import { status } from '#lib/workbench/status.svelte.ts';

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

	let selected = $state<string | null>(null);
	/** Multi-selection (⌘-click toggles, Shift-click extends from `selected`). */
	let picked = $state<string[]>([]);
	function activate(r: Row, preview = true) {
		selected = r.rel;
		picked = [r.rel];
		if (r.is_dir) void toggle(r.rel);
		else adeLayout.openFile(slug, r.rel, { preview });
	}
	function click(e: MouseEvent, r: Row) {
		if (e.metaKey) {
			picked = picked.includes(r.rel) ? picked.filter((p) => p !== r.rel) : [...picked, r.rel];
			selected = r.rel;
			return;
		}
		if (e.shiftKey && selected) {
			const order = visibleRows.map((x) => x.rel);
			const [a, b] = [order.indexOf(selected), order.indexOf(r.rel)].sort((x, y) => x - y);
			if (a >= 0) picked = order.slice(a, b + 1);
			return;
		}
		activate(r);
	}
	const isPicked = (rel: string) => picked.includes(rel) || selected === rel;

	// --- Keyboard (Orca: arrows move, → / ← open and close folders, Space opens, Enter renames) ---
	let tree: HTMLDivElement | undefined = $state();
	function focusRow(rel: string) {
		selected = rel;
		queueMicrotask(() => tree?.querySelector<HTMLElement>(`[data-rel="${CSS.escape(rel)}"]`)?.scrollIntoView({ block: 'nearest' }));
	}
	async function onTreeKey(e: KeyboardEvent) {
		if (edit || (e.target as HTMLElement).tagName === 'INPUT') return;
		const order = visibleRows;
		const i = order.findIndex((r) => r.rel === selected);
		const cur = order[i];
		const go = (j: number, extend = false) => {
			const r = order[Math.max(0, Math.min(order.length - 1, j))];
			if (!r) return;
			if (extend && selected) picked = [...new Set([...picked, selected, r.rel])];
			else picked = [r.rel];
			focusRow(r.rel);
		};
		const page = Math.max(1, Math.floor(order.length / 10));
		let handled = true;
		if (e.key === 'ArrowDown') go(i < 0 ? 0 : i + 1, e.shiftKey);
		else if (e.key === 'ArrowUp') go(i < 0 ? order.length - 1 : i - 1, e.shiftKey);
		else if (e.key === 'Home') go(0);
		else if (e.key === 'End') go(order.length - 1);
		else if (e.key === 'PageDown') go(i + page);
		else if (e.key === 'PageUp') go(i - page);
		else if (e.key === 'ArrowRight' && cur?.is_dir) {
			if (!cur.open) await toggle(cur.rel);
			else go(i + 1);
		} else if (e.key === 'ArrowLeft' && cur) {
			if (cur.is_dir && cur.open) await toggle(cur.rel);
			else {
				const parent = parentOf(cur.rel);
				if (parent && parent !== base) focusRow(parent), (picked = [parent]);
			}
		} else if (e.key === ' ' && cur) activate(cur);
		else if (e.key === 'Enter' && cur) void runRow('rename', cur);
		else if ((e.key === 'Backspace' && e.metaKey) || e.key === 'Delete') void deletePicked();
		else if (e.code === 'KeyC' && e.altKey && e.metaKey) void copyPicked(!e.shiftKey);
		else if (e.code === 'KeyZ' && e.metaKey) void undo(e.shiftKey);
		else handled = false;
		if (handled) e.preventDefault();
	}
	const pickedRows = () => visibleRows.filter((r) => isPicked(r.rel));
	async function copyPicked(absolute: boolean) {
		const rows = pickedRows();
		if (!rows.length) return;
		await navigator.clipboard.writeText(rows.map((r) => (absolute ? `${workspace.root}/${r.rel}` : relInside(r.rel))).join('\n'));
		status.flash(rows.length > 1 ? 'Paths copied' : 'Path copied', 2000);
	}
	async function deletePicked() {
		// Nested selections collapse to their top-level roots; each goes to the Trash.
		const rows = pickedRows();
		const roots = rows.filter((r) => !rows.some((o) => o !== r && r.rel.startsWith(o.rel + '/')));
		for (const r of roots) await runRow('delete', r);
		picked = [];
	}

	// --- Drag to move into a folder (500 ms hover opens a closed folder) -----------------------
	let dragging = $state<string[]>([]);
	let dropDir = $state<string | null>(null);
	let hoverTimer: ReturnType<typeof setTimeout> | undefined;
	function dragStart(e: DragEvent, r: Row) {
		dragging = isPicked(r.rel) && picked.length > 1 ? [...picked] : [r.rel];
		e.dataTransfer?.setData('text/plain', dragging.join('\n'));
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
	}
	function dragOver(e: DragEvent, r: Row | null) {
		if (!dragging.length) return;
		const dir = r ? (r.is_dir ? r.rel : parentOf(r.rel)) : base;
		const bad = dragging.some((d) => dir === d || dir.startsWith(d + '/') || parentOf(d) === dir);
		if (bad) return void (dropDir = null);
		e.preventDefault();
		if (dropDir !== dir) {
			dropDir = dir;
			clearTimeout(hoverTimer);
			if (r?.is_dir && !r.open) hoverTimer = setTimeout(() => void toggle(r.rel), 500);
		}
	}
	async function dropOn(e: DragEvent) {
		e.preventDefault();
		clearTimeout(hoverTimer);
		const dir = dropDir;
		const moving = dragging;
		dragging = [];
		dropDir = null;
		if (dir === null) return;
		for (const from of moving) {
			const to = `${dir ? dir + '/' : ''}${from.split('/').pop()}`;
			try {
				await invoke('fs_rename', { from, to });
				record({ kind: 'move', from, to });
			} catch (err) {
				status.error(`Failed to move '${from.split('/').pop()}'. ${err}`);
			}
		}
		await Promise.all([...new Set([dir, ...moving.map(parentOf)])].map(load));
	}

	// --- Orca's toolbar menu: dotfiles and git-ignored files, Open in Finder ---------------------
	let showDotfiles = $state(true);
	let showIgnored = $state(true);
	const visibleRows = $derived(rows.filter((r) => (showDotfiles || !r.name.startsWith('.')) && (showIgnored || !r.ignored)));
	const anyOpen = $derived(Object.values(open).some(Boolean));
	let moreMenu = $state<{ x: number; y: number } | null>(null);
	const moreItems = $derived<MenuNode[]>([menuItem('dotfiles', 'Show Dotfiles', { checked: showDotfiles }), menuItem('ignored', 'Show Git Ignored Files', { checked: showIgnored }), menuSeparator, menuItem('finder', 'Open in Finder')]);
	function runMore(id: string) {
		if (id === 'dotfiles') showDotfiles = !showDotfiles;
		else if (id === 'ignored') showIgnored = !showIgnored;
		else void invoke('fs_reveal', { rel: base }).catch((e) => status.error(String(e)));
	}
	const refreshAll = () => Promise.all([base, ...Object.keys(open).filter((k) => open[k])].map(load));

	// --- Row menu, inline create / rename, delete to the Trash (Orca: no confirmation) ---------
	let rowMenu = $state<{ row: Row | null; x: number; y: number } | null>(null);
	const rowItems = $derived.by((): MenuNode[] => {
		const r = rowMenu?.row;
		const base: MenuNode[] = [menuItem('newFile', 'New File'), menuItem('newFolder', 'New Folder')];
		if (!r) return base;
		return [
			...base,
			menuSeparator,
			menuItem('copyPath', picked.length > 1 ? 'Copy Paths' : 'Copy Path', { keyLabel: '⌥⌘C' }),
			menuItem('copyRel', picked.length > 1 ? 'Copy Relative Paths' : 'Copy Relative Path', { keyLabel: '⌥⇧⌘C' }),
			...(r.is_dir ? [menuItem('terminal', 'Open in Terminal')] : [menuItem('view', 'View File')]),
			...(r.is_dir && r.open ? [menuItem('collapse', 'Collapse Folder')] : []),
			...(r.is_dir ? [menuItem('find', 'Find in Folder')] : []),
			menuItem('reveal', 'Reveal in Finder'),
			menuSeparator,
			menuItem('rename', 'Rename', { keyLabel: '↩' }),
			menuItem('delete', 'Delete', { keyLabel: '⌘⌫' })
		];
	});
	let edit = $state<{ kind: 'file' | 'folder' | 'rename'; parent: string; rel?: string; depth: number; value: string } | null>(null);
	const parentOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
	const relInside = (rel: string) => (base && rel.startsWith(base + '/') ? rel.slice(base.length + 1) : rel);
	async function runRow(id: string, r: Row | null) {
		const dir = r ? (r.is_dir ? r.rel : parentOf(r.rel)) : base;
		const depth = r ? (r.is_dir ? r.depth + 1 : r.depth) : 0;
		switch (id) {
			case 'newFile':
			case 'newFolder':
				if (r?.is_dir && !r.open) await toggle(r.rel);
				edit = { kind: id === 'newFile' ? 'file' : 'folder', parent: dir, depth, value: '' };
				return;
			case 'copyPath':
				return void copyPicked(true);
			case 'copyRel':
				return void copyPicked(false);
			case 'terminal':
				return void adeLayout.newTerminal(slug);
			case 'view':
				return activate(r!);
			case 'collapse':
				for (const k of Object.keys(open)) if (k === r!.rel || k.startsWith(r!.rel + '/')) open[k] = false;
				return;
			case 'find':
				by = 'contents';
				return;
			case 'reveal':
				return void invoke('fs_reveal', { rel: r!.rel }).catch((e) => status.error(String(e)));
			case 'rename':
				edit = { kind: 'rename', parent: parentOf(r!.rel), rel: r!.rel, depth: r!.depth, value: r!.name };
				return;
			case 'delete':
				try {
					await invoke('fs_delete', { rel: r!.rel });
					await load(parentOf(r!.rel));
				} catch (e) {
					status.error(`Failed to move to Trash '${r!.name}'. ${e}`);
				}
		}
	}
	// --- Undo / redo of file operations (Orca keeps 50; a new op clears redo) ----------------
	type Op = { kind: 'move'; from: string; to: string } | { kind: 'create'; rel: string; dir: boolean };
	let undoStack: Op[] = [];
	let redoStack: Op[] = [];
	function record(op: Op) {
		undoStack = [...undoStack.slice(-49), op];
		redoStack = [];
	}
	async function apply(op: Op, reverse: boolean) {
		if (op.kind === 'move') {
			const [from, to] = reverse ? [op.to, op.from] : [op.from, op.to];
			await invoke('fs_rename', { from, to });
			await Promise.all([parentOf(from), parentOf(to)].map(load));
		} else if (reverse) {
			await invoke('fs_delete', { rel: op.rel });
			await load(parentOf(op.rel));
		} else {
			await invoke(op.dir ? 'fs_create_dir' : 'fs_create_file', { rel: op.rel });
			await load(parentOf(op.rel));
		}
	}
	async function undo(redo = false) {
		const from = redo ? redoStack : undoStack;
		const op = from[from.length - 1];
		if (!op) return;
		try {
			await apply(op, !redo);
			if (redo) (redoStack = redoStack.slice(0, -1)), (undoStack = [...undoStack, op]);
			else (undoStack = undoStack.slice(0, -1)), (redoStack = [...redoStack, op]);
		} catch (e) {
			status.error(`Operation failed. ${e}`);
		}
	}

	async function submitEdit() {
		const e = edit;
		edit = null;
		const name = e?.value.trim();
		if (!e || !name || (e.kind === 'rename' && name === e.rel?.split('/').pop())) return;
		const target = e.parent ? `${e.parent}/${name}` : name;
		try {
			if (e.kind === 'rename') {
				await invoke('fs_rename', { from: e.rel, to: target });
				record({ kind: 'move', from: e.rel!, to: target });
			} else {
				await invoke(e.kind === 'file' ? 'fs_create_file' : 'fs_create_dir', { rel: target });
				record({ kind: 'create', rel: target, dir: e.kind === 'folder' });
			}
			await load(e.parent);
			if (e.kind === 'file') adeLayout.openFile(slug, target, { preview: false });
			selected = target;
		} catch (err) {
			status.error(`Failed to ${e.kind === 'rename' ? 'rename' : 'create'} '${name}'. ${err}`);
		}
	}
	const editAfter = $derived.by(() => {
		if (!edit || edit.kind === 'rename') return null;
		// New items go after the parent's visible subtree (Orca), or at the top for the root.
		if (edit.parent === base) return '';
		let last = edit.parent;
		for (const r of visibleRows) if (r.rel.startsWith(edit.parent + '/')) last = r.rel;
		return last;
	});
	const TOOL = 'grid size-6 place-items-center rounded-md text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:opacity-50';
</script>

{#snippet inlineInput(depth: number, isFolder: boolean)}
	<div class="flex h-[26px] w-full items-center gap-1 px-2" style:padding-left="{depth * 16 + 8}px">
		<span class="size-3 shrink-0"></span>
		<FileIcon icon={isFolder ? folderIcon('', false) : fileIcon(edit?.value || 'file')} />
		<!-- svelte-ignore a11y_autofocus -->
		<input
			class="min-w-0 flex-1 rounded-sm border border-(--vscode-focusBorder) bg-transparent px-1 text-xs outline-none"
			aria-label={edit?.kind === 'rename' ? 'Rename' : isFolder ? 'New folder name' : 'New file name'}
			autofocus
			spellcheck="false"
			value={edit?.value}
			oninput={(e) => edit && (edit.value = e.currentTarget.value)}
			onfocus={(e) => {
				const v = e.currentTarget.value;
				const dot = v.lastIndexOf('.');
				e.currentTarget.setSelectionRange(0, dot > 0 ? dot : v.length);
			}}
			onkeydown={(e) => (e.key === 'Enter' ? (e.preventDefault(), void submitEdit()) : e.key === 'Escape' ? (edit = null) : undefined)}
			onblur={() => setTimeout(() => edit && void submitEdit(), 150)}
		/>
	</div>
{/snippet}

<div class="flex h-full min-h-0 flex-col">
	<!-- Orca's toolbar: the worktree's name, Collapse All, Refresh, more actions. -->
	<div class="flex h-8 min-h-8 shrink-0 items-center gap-2 border-b border-(--vscode-widget-border) px-2">
		<span class="min-w-0 flex-1 truncate text-xs font-medium" title={slug ? `kingu/${slug}` : workspace.name}>{slug ? `kingu/${slug}` : workspace.name}</span>
		<button class={[TOOL, (by !== 'names' || filter || !anyOpen) && 'cursor-not-allowed opacity-50']} aria-label="Collapse All" title="Collapse All" aria-disabled={by !== 'names' || !!filter || !anyOpen} onclick={() => by === 'names' && !filter && (open = {})}><Icon name="collapseAll" size={13} /></button>
		<button class={TOOL} aria-label="Refresh Explorer" title="Refresh Explorer" disabled={by !== 'names'} onclick={refreshAll}><Icon name="refresh" size={13} /></button>
		<button
			class={TOOL}
			aria-label="More Explorer Actions"
			title="More Explorer Actions"
			onclick={(e) => {
				const rr = e.currentTarget.getBoundingClientRect();
				moreMenu = { x: rr.right - 248, y: rr.bottom + 4 };
			}}><Icon name="more" size={13} /></button
		>
	</div>
	<!-- Query block: the name filter (or content search) over the Names | Contents switch. -->
	<div class="shrink-0 border-b border-(--vscode-widget-border) px-2 py-1.5">
		<div class="flex flex-col gap-1">
			<label class="flex h-7 items-center gap-1 rounded-sm border border-(--vscode-widget-border) bg-(--vscode-input-background)/50 px-1.5 focus-within:border-(--vscode-focusBorder)">
				<span class="text-(--vscode-descriptionForeground)"><Icon name={by === 'names' ? 'menu' : 'search'} size={13} /></span>
				<input class="min-w-0 flex-1 bg-transparent py-1 text-xs outline-none placeholder:text-(--vscode-input-placeholderForeground)/50" spellcheck="false" placeholder={by === 'names' ? 'Find files' : 'Search'} aria-label={by === 'names' ? 'Find files' : 'Search file contents'} bind:value={filter} />
				{#if by === 'contents' && searching}<span class="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent opacity-60"></span>{/if}
				{#if filter}<button class="grid place-items-center rounded p-0.5 hover:bg-(--vscode-toolbar-hoverBackground)" aria-label="Clear file filter" onclick={() => (filter = '')}><Icon name="close" size={12} /></button>{/if}
			</label>
			<div class="flex h-7 w-full items-center gap-0.5 rounded-md bg-(--vscode-input-background)/40 p-0.5" role="radiogroup" aria-label="Explorer search mode">
				{#each [['names', 'Names', 'Filter files by name'], ['contents', 'Contents', 'Search file contents']] as const as [id, label, aria] (id)}
					<button
						role="radio"
						aria-checked={by === id}
						aria-label={aria}
						class={['h-full min-w-0 flex-1 rounded-sm px-2 text-[11px]', by === id ? 'bg-(--vscode-editor-background) font-medium text-(--vscode-foreground) shadow-xs' : 'text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)']}
						onclick={() => (by = id)}>{label}</button
					>
				{/each}
			</div>
		</div>
	</div>
	{#if by === 'contents' && filter.trim()}
		<div class="min-h-0 flex-1 overflow-y-auto py-2 text-xs" aria-label="Search results">
			{#each hits as h (h.path)}
				{@const name = h.path.slice(h.path.lastIndexOf('/') + 1)}
				<button class="flex h-[26px] w-full items-center gap-1.5 rounded-sm px-2 text-left hover:bg-(--vscode-list-hoverBackground)" title={h.path} onclick={() => adeLayout.openFile(slug, h.path, { preview: true })}>
					<FileIcon icon={fileIcon(name)} />
					<span class="truncate">{name}</span>
					<span class="min-w-0 flex-1 truncate text-[11px] text-(--vscode-descriptionForeground)">{h.path.slice(base ? base.length + 1 : 0, -name.length - 1)}</span>
				</button>
				{#each h.lines as l (l.line)}
					<button class="block h-[22px] w-full truncate rounded-sm pr-2 pl-8 text-left font-mono text-[11px] text-(--vscode-descriptionForeground) hover:bg-(--vscode-list-hoverBackground) hover:text-(--vscode-foreground)" onclick={() => adeLayout.openFile(slug, h.path, { preview: true })}>
						<span class="opacity-60">{l.line}</span> {l.text}
					</button>
				{/each}
			{:else}
				{#if searching}<p class="px-3 py-2 text-[11px] text-(--vscode-descriptionForeground)">Searching…</p>{/if}
			{/each}
		</div>
	{:else}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			bind:this={tree}
			class={['min-h-0 flex-1 overflow-y-auto py-2 text-xs outline-none', dropDir === base && 'bg-(--vscode-widget-border)/40']}
			role="tree"
			tabindex="0"
			aria-label="Files"
			aria-multiselectable="true"
			onkeydown={onTreeKey}
			ondragover={(e) => e.target === e.currentTarget && dragOver(e, null)}
			ondrop={dropOn}
			ondragend={() => ((dragging = []), (dropDir = null))}
			oncontextmenu={(e) => e.target === e.currentTarget && (e.preventDefault(), (rowMenu = { row: null, x: e.clientX, y: e.clientY }))}
			ondblclick={(e) => e.target === e.currentTarget && runRow('newFile', null)}
		>
			{#if error}
				<p class="px-3 text-center text-[11px] text-(--vscode-errorForeground)">Could not load files for this workspace: {error}</p>
			{/if}
			{#if editAfter === ''}{@render inlineInput(0, edit?.kind === 'folder')}{/if}
			{#each visibleRows as r (r.rel)}
				{#if edit?.kind === 'rename' && edit.rel === r.rel}
					{@render inlineInput(r.depth, r.is_dir)}
				{:else}
					{@const deco = decorations.get(r.rel)}
					<button
						role="treeitem"
						aria-selected={isPicked(r.rel)}
						aria-expanded={r.is_dir ? r.open : undefined}
						data-rel={r.rel}
						tabindex="-1"
						draggable="true"
						class={[
							'flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left transition-colors',
							dropDir !== null && (dropDir === r.rel || (!r.is_dir && parentOf(r.rel) === dropDir)) ? 'bg-(--vscode-widget-border)' : isPicked(r.rel) ? 'bg-(--vscode-list-inactiveSelectionBackground)/70' : 'hover:bg-(--vscode-list-hoverBackground)',
							dragging.includes(r.rel) && 'opacity-50'
						]}
						ondragstart={(e) => dragStart(e, r)}
						ondragover={(e) => dragOver(e, r)}
						style:padding-left="{r.depth * 16 + 8}px"
						title={r.rel}
						onclick={(e) => click(e, r)}
						ondblclick={() => !r.is_dir && activate(r, false)}
						oncontextmenu={(e) => (e.preventDefault(), !isPicked(r.rel) && ((picked = [r.rel]), (selected = r.rel)), (rowMenu = { row: r, x: e.clientX, y: e.clientY }))}
					>
						<span class={['grid size-3 shrink-0 place-items-center text-(--vscode-descriptionForeground) transition-transform', r.is_dir && r.open && 'rotate-90']}>{#if r.is_dir}<Icon name="chevronRight" size={12} />{/if}</span>
						<FileIcon icon={r.is_dir ? folderIcon(r.rel, r.open) : fileIcon(r.name)} />
						<span class={['min-w-0 flex-1 truncate', r.ignored && 'pr-0.5 italic opacity-55']} style:color={deco?.color}>{r.name}</span>
						{#if deco?.letter}<span class="mr-2 ml-auto shrink-0 text-[10px] font-semibold tracking-wide" style:color={deco.color}>{deco.letter}</span>
						{:else if r.ignored}<span class="mr-2 ml-auto shrink-0 opacity-55" aria-label="Ignored by .gitignore"><Icon name="ignored" size={12} /></span>{/if}
					</button>
					{#if editAfter === r.rel}{@render inlineInput(edit?.depth ?? 0, edit?.kind === 'folder')}{/if}
				{/if}
			{:else}
				{#if !error && !edit}<p class="px-4 text-center text-[11px] text-(--vscode-descriptionForeground)">{filter ? 'No files match this filter' : 'No files in this workspace'}</p>{/if}
			{/each}
		</div>
	{/if}
</div>

{#if moreMenu}
	<PopupMenu items={moreItems} label="More Explorer Actions" x={moreMenu.x} y={moreMenu.y} onRun={(n) => n.type === 'item' && runMore(n.id)} onClose={() => (moreMenu = null)} />
{/if}
{#if rowMenu}
	{@const r = rowMenu.row}
	<PopupMenu items={rowItems} label="File" x={rowMenu.x} y={rowMenu.y} onRun={(n) => n.type === 'item' && void (n.id === 'delete' && picked.length > 1 ? deletePicked() : runRow(n.id, r))} onClose={() => (rowMenu = null)} />
{/if}
