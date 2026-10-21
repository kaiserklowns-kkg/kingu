<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { getCurrentWebview } from '@tauri-apps/api/webview';
	import FileIcon from './FileIcon.svelte';
	import { scm } from './scm.svelte';
	import { entryChanges, fileDecorations } from './scm';
	import Icon from './Icon.svelte';
	import { fileIcon, folderIcon } from './fileIcons';
	import { explorer, type Row } from './explorer.svelte';
	import { editors } from './editors.svelte';
	import { baseName, recentLabel, stemLength } from './fileTree';
	import { keyLabel } from './keys';
	import { workspace } from './workspace.svelte';
	import { repoDialog } from './repoDialog.svelte.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { testing } from '#lib/testing/testing.svelte.ts';
	import { lsp } from '#lib/lsp/lsp.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import { problemBadge, problemDecorations } from '#lib/lsp/problemsSettings.ts';
	import { coverageColor, displayedPercent, displayPercent, explorerCoverage, type Thresholds } from '#lib/testing/coverage.ts';
	import { isNonTextEditor } from '#lib/settings/resources.ts';
	import { isDiffKey } from './scm';
	import { isUntitled } from './untitled';
	import { notifications } from './notifications.svelte';
	import { autoRevealOf, dropTarget, withPathSeparator } from './explorerModel';
	import { enabledGlobs, hiddenBySibling, isExcluded, siblingClauses } from '#lib/settings/mappings.ts';
	import { relativeInFolder } from '#lib/workbench/workspaceFolders.ts';

	let { workspaceName }: { workspaceName: string } = $props();

	const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');
	// git.decorations.enabled: git's colors and letters in the explorer.
	const decorations = $derived(fileDecorations(settings.get<boolean>('git.decorations.enabled') ? entryChanges(scm.entries) : []));
	/** explorer.decorations.colors / explorer.decorations.badges. */
	const decoColors = $derived(settings.get<boolean>('explorer.decorations.colors'));
	const decoBadges = $derived(settings.get<boolean>('explorer.decorations.badges'));
	// problems.decorations.enabled (off with problems.visibility): errors and warnings on files, their color on folders.
	const problems = $derived(settings.get<boolean>('problems.visibility') !== false && settings.get<boolean>('problems.decorations.enabled') !== false ? problemDecorations(lsp.problems) : null);
	const PROBLEM_COLORS = { error: 'var(--vscode-list-errorForeground,#f88070)', warning: 'var(--vscode-list-warningForeground,#cca700)' };
	/** The name's color: a problem's over git's (VS Code weighs problems higher). */
	const nameColor = (rel: string) => {
		const p = problems?.get(rel);
		return p ? PROBLEM_COLORS[p.severity] : decorations.get(rel)?.color;
	};
	// testing.showCoverageInExplorer: each covered file's (and folder's) percentage while coverage is open.
	const coverage = $derived(testing.coverage && settings.get<boolean>('testing.showCoverageInExplorer') !== false ? explorerCoverage([...testing.coverage.values()]) : null);
	const COVERAGE_COLORS = { red: 'var(--vscode-charts-red,#f14c4c)', yellow: 'var(--vscode-charts-yellow,#cca700)', green: 'var(--vscode-charts-green,#89d185)' };
	function coverageBadge(rel: string): { text: string; color: string } | null {
		const c = coverage?.get(rel);
		if (!c) return null;
		const pct = displayedPercent(c, settings.get<string>('testing.displayedCoveragePercent'));
		return { text: displayPercent(pct, 0), color: COVERAGE_COLORS[coverageColor(pct, settings.get<Thresholds>('testing.coverageBarThresholds'))] };
	}

	let open = $state(true);
	let inputError = $state('');
	let menu = $state<{ x: number; y: number; target: string | null } | null>(null);
	let tree: HTMLDivElement | undefined = $state();

	// Multi-root: every root folder is a row of the tree (the first one's files keep relative paths).
	explorer.setRoots(() => (workspace.isMultiRoot ? workspace.folders.map((f, i) => ({ key: i === 0 ? '' : f.path, name: f.name, path: f.path })) : []));

	$effect(() => {
		if (workspace.root && !explorer.children.has('')) explorer.load('');
		for (const r of explorer.roots()) if (r.key && !explorer.children.has(r.key)) void explorer.load(r.key);
	});

	explorer.setRootName(() => workspaceName);

	// Reveal in Explorer View: focus the row once it is rendered.
	$effect(() => {
		const rel = explorer.focusRequest;
		if (!rel || !tree) return;
		queueMicrotask(() => {
			const el = tree?.querySelector<HTMLElement>(`[data-rel="${CSS.escape(rel)}"]`);
			if (!el) return;
			explorer.focusRequest = null;
			el.scrollIntoView({ block: 'nearest' });
			el.focus();
		});
	});

	// --- Drag and drop (VS Code explorerViewer.ts FileDragAndDrop) --------------------------------

	const DRAG_MIME = 'application/x-kingu-explorer';
	/** The folder a drag would drop into ('' is the root), highlighted with its rows. */
	let dragTarget = $state<string | null>(null);
	const dndEnabled = $derived(settings.get<boolean>('explorer.enableDragAndDrop') !== false);

	function onDragStart(e: DragEvent, row: Row) {
		// A root folder stays where it is (reordering root folders is not supported).
		if (!e.dataTransfer || !dndEnabled || row.root) return;
		if (!explorer.isSelected(row.rel)) explorer.select(row.rel);
		const paths = explorer.targets(row.rel);
		e.dataTransfer.setData(DRAG_MIME, JSON.stringify(paths));
		e.dataTransfer.setData('text/plain', paths.map(absPath).join('\n'));
		e.dataTransfer.effectAllowed = 'copyMove';
	}

	function onDragOver(e: DragEvent, row: Row | null) {
		if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
		e.preventDefault();
		e.stopPropagation();
		// ⌥ copies, like VS Code (Ctrl on Windows/Linux).
		e.dataTransfer.dropEffect = (isMac ? e.altKey : e.ctrlKey) ? 'copy' : 'move';
		dragTarget = dropTarget(row?.rel ?? null, row?.is_dir ?? true);
	}

	function onDrop(e: DragEvent, row: Row | null) {
		const raw = e.dataTransfer?.getData(DRAG_MIME);
		dragTarget = null;
		if (!raw) return;
		e.preventDefault();
		e.stopPropagation();
		const copy = isMac ? e.altKey : e.ctrlKey;
		void explorer.transfer(JSON.parse(raw) as string[], dropTarget(row?.rel ?? null, row?.is_dir ?? true), copy, true);
	}

	/** In the drop target folder (it and its rows are highlighted). */
	const inDragTarget = (rel: string) => dragTarget !== null && (dragTarget === '' ? false : rel === dragTarget || rel.startsWith(dragTarget + '/'));

	// Files dragged in from Finder arrive as Tauri drag-drop events (window coordinates in physical px).
	onMount(() => {
		let unlisten: (() => void) | undefined;
		let gone = false;
		const targetAt = (pos: { x: number; y: number }): string | null => {
			const ratio = window.devicePixelRatio || 1;
			const el = document.elementFromPoint(pos.x / ratio, pos.y / ratio);
			if (!el || !tree?.contains(el)) return null;
			const rowEl = el.closest<HTMLElement>('[data-rel]');
			if (!rowEl) return '';
			const rel = rowEl.dataset.rel!;
			return dropTarget(rel, explorer.isDir(rel));
		};
		getCurrentWebview()
			.onDragDropEvent((ev) => {
				const p = ev.payload;
				if (p.type === 'over' || p.type === 'enter') dragTarget = targetAt(p.position);
				else if (p.type === 'drop') {
					const target = targetAt(p.position);
					dragTarget = null;
					if (target !== null && p.paths.length && workspace.root) void explorer.importDropped(p.paths, target);
				} else dragTarget = null;
			})
			.then((u) => (gone ? u() : (unlisten = u)))
			.catch(() => {});
		return () => {
			gone = true;
			unlisten?.();
		};
	});

	/** workbench.tree.indent */
	const indent = $derived(settings.get<number>('workbench.tree.indent'));

	// explorer.autoReveal: the active editor's file is expanded to, selected and scrolled into view
	// (`focusNoScroll`: not scrolled); explorer.autoRevealExclude leaves matching files alone.
	$effect(() => {
		const active = editors.active;
		if (!active || !workspace.root || isDiffKey(active) || isUntitled(active) || isNonTextEditor(active) || active.includes('://')) return;
		const autoRevealExclude = settings.get<Record<string, unknown>>('explorer.autoRevealExclude');
		// Sibling clauses (`{ "when": "$(basename).ts" }`) look at the folder's listed entries.
		const listed = (p: string) => !!explorer.children.get(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')?.some((e) => e.rel === p);
		const excluded = isExcluded(active, enabledGlobs(autoRevealExclude)) || hiddenBySibling(active, siblingClauses(autoRevealExclude), listed);
		const { reveal, scroll } = autoRevealOf(settings.get('explorer.autoReveal'), excluded);
		if (!reveal) return;
		// Untracked: the tree loading folders on the way must not re-run this (and re-select the file).
		untrack(() =>
			explorer.reveal(active).then(() => {
				if (scroll && editors.active === active) queueMicrotask(() => tree?.querySelector<HTMLElement>(`[data-rel="${CSS.escape(active)}"]`)?.scrollIntoView({ block: 'nearest' }));
			})
		);
	});

	type Item = { type: 'row'; row: Row } | { type: 'input'; depth: number; is_dir: boolean; value: string; key: string };

	/** Rows plus VS Code's inline edit box: first in the target folder for New, in place for Rename. */
	const items = $derived.by((): Item[] => {
		const rows = explorer.rows();
		const edit = explorer.editing;
		const out: Item[] = [];
		const input = (depth: number, is_dir: boolean, value: string): Item => ({ type: 'input', depth, is_dir, value, key: `\0input:${edit?.kind === 'rename' ? edit.rel : (edit?.parent ?? '') + edit?.kind}` });
		if (edit && edit.kind !== 'rename' && edit.parent === '') out.push(input(0, edit.kind === 'folder', ''));
		for (const row of rows) {
			if (edit?.kind === 'rename' && edit.rel === row.rel) {
				out.push(input(row.depth, row.is_dir, row.name));
				continue;
			}
			out.push({ type: 'row', row });
			if (edit && edit.kind !== 'rename' && edit.parent === row.rel && row.expanded) out.push(input(row.depth + 1, edit.kind === 'folder', ''));
		}
		return out;
	});

	function select(rel: string | null) {
		explorer.select(rel);
	}

	/** Row click: ⌘ toggles, ⇧ extends, a plain click selects and opens (VS Code's list). The
	 * twistie of a file with nested files (explorer.fileNesting) opens or closes the nest. */
	function onRowClick(e: MouseEvent, row: Row) {
		if (isMac ? e.metaKey : e.ctrlKey) return explorer.toggleSelect(row.rel);
		if (e.shiftKey) return explorer.selectRange(row.rel);
		select(row.rel);
		if (row.is_dir) void (row.expanded ? explorer.collapse(row) : explorer.expand(row.rel));
		else if (row.nests && (e.target as HTMLElement).closest('[data-twistie]')) explorer.toggleNest(row.rel);
		else editors.open(row.rel, { preview: true });
	}

	/** Mounts the edit box focused, with the name (minus extension) selected like VS Code. */
	function editBox(el: HTMLInputElement, init: { value: string; is_dir: boolean }) {
		inputError = '';
		el.value = init.value;
		queueMicrotask(() => {
			el.focus();
			el.setSelectionRange(0, stemLength(init.value, init.is_dir));
		});
	}

	let committing = false;
	async function commit(el: HTMLInputElement) {
		if (committing || !explorer.editing) return;
		committing = true;
		try {
			// VS Code: an empty New box just goes away.
			if (!el.value.trim() && explorer.editing.kind !== 'rename') {
				explorer.cancelEdit();
				return;
			}
			const err = await explorer.commit(el.value);
			inputError = err ?? '';
			if (!err) tree?.focus();
		} finally {
			committing = false;
		}
	}

	function onInputKey(e: KeyboardEvent) {
		e.stopPropagation();
		if (e.key === 'Enter') {
			e.preventDefault();
			void commit(e.currentTarget as HTMLInputElement);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			explorer.cancelEdit();
			tree?.focus();
		}
	}

	function onInputBlur(e: FocusEvent) {
		// Blur commits a valid name and drops an invalid one, like VS Code.
		const el = e.currentTarget as HTMLInputElement;
		if (!explorer.editing) return;
		void commit(el).then(() => {
			if (inputError) {
				inputError = '';
				explorer.cancelEdit();
			}
		});
	}

	// --- Commands on the selection (VS Code explorer keybindings) -------------------------------

	const absPath = (rel: string) => (rel.startsWith('/') ? rel : rel ? `${workspace.root}/${rel}` : (workspace.root ?? ''));
	/** Copy Path / Copy Relative Path with explorer.copyPathSeparator / explorer.copyRelativePathSeparator. */
	const copyAbs = (rels: string[]) => copy(rels.map((r) => withPathSeparator(absPath(r), settings.get<string>('explorer.copyPathSeparator'))).join('\n'));
	const copyRel = (rels: string[]) => copy(rels.map((r) => withPathSeparator(relativeInFolder(r, workspace.folders) || '.', settings.get<string>('explorer.copyRelativePathSeparator'))).join('\n'));

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
		} catch (e) {
			notifications.error(`คัดลอกไม่ได้ (Copy failed): ${e}`);
		}
	}

	function reveal(rel: string | null) {
		invoke('fs_reveal', { rel: rel ?? '' }).catch((e) => notifications.error(String(e)));
	}

	type MenuItem = { label: string; key?: string; enabled?: boolean; run: () => unknown } | 'sep';

	function menuItems(target: string | null): MenuItem[] {
		const many = target !== null && explorer.targets(target).length > 1;
		const items: MenuItem[] = [
			{ label: 'New File...', run: () => explorer.startCreate('file', target) },
			{ label: 'New Folder...', run: () => explorer.startCreate('folder', target) },
			'sep',
			{ label: isMac ? 'Reveal in Finder' : 'Reveal in File Explorer', key: keyLabel('alt+cmd+r'), run: () => reveal(target) },
			'sep'
		];
		if (target) items.push({ label: 'Cut', key: keyLabel('cmd+x'), run: () => explorer.setClipboard(explorer.targets(target), true) }, { label: 'Copy', key: keyLabel('cmd+c'), run: () => explorer.setClipboard(explorer.targets(target), false) });
		items.push(
			{ label: 'Paste', key: keyLabel('cmd+v'), enabled: explorer.clipboard !== null, run: () => explorer.paste(target) },
			'sep',
			{ label: 'Copy Path', key: keyLabel('alt+cmd+c'), run: () => copyAbs(target ? explorer.targets(target) : ['']) },
			{ label: 'Copy Relative Path', key: keyLabel('alt+shift+cmd+c'), run: () => copyRel(target ? explorer.targets(target) : ['']) }
		);
		if (target !== null && explorer.isRoot(target)) {
			// A root folder of a multi-root workspace (VS Code's root folder context menu).
			const folder = explorer.roots().find((r) => r.key === target);
			items.push('sep', { label: 'Add Folder to Workspace...', run: () => workspace.addFolderToWorkspace() });
			if (folder) items.push({ label: 'Remove Folder from Workspace', run: () => workspace.removeFolder(folder.path) });
			return items;
		}
		if (target) {
			items.push('sep');
			if (!many) items.push({ label: 'Rename...', key: isMac ? '↵' : 'F2', run: () => explorer.startRename(target) });
			items.push({ label: 'Delete', key: isMac ? '⌘⌫' : 'Delete', run: () => explorer.delete(target) });
		}
		return items;
	}

	function openMenu(e: MouseEvent, target: string | null) {
		e.preventDefault();
		e.stopPropagation();
		// Right-click inside the selection keeps it (the menu acts on all of it), like VS Code.
		if (target === null || !explorer.isSelected(target)) select(target);
		// Keep the menu inside the window.
		const x = Math.min(e.clientX, window.innerWidth - 240);
		const y = Math.min(e.clientY, window.innerHeight - 260);
		menu = { x, y, target };
	}

	function onTreeKey(e: KeyboardEvent) {
		const sel = explorer.selected;
		const mod = isMac ? e.metaKey : e.ctrlKey;
		const plainMod = mod && !e.altKey && !e.shiftKey;
		if (plainMod && (e.code === 'KeyC' || e.code === 'KeyX')) {
			if (!sel) return;
			explorer.setClipboard(explorer.targets(sel), e.code === 'KeyX');
		} else if (plainMod && e.code === 'KeyV') {
			void explorer.paste(sel);
		} else if (plainMod && e.code === 'KeyA') {
			for (const r of explorer.rows()) explorer.selection.add(r.rel);
		} else if (e.key === 'Escape' && (explorer.selection.size > 1 || explorer.clipboard)) {
			explorer.clipboard = null;
			if (sel) select(sel);
		} else if (e.key === 'F2' || (isMac && e.key === 'Enter' && !mod && !e.altKey && !e.shiftKey)) {
			if (!sel || explorer.isRoot(sel)) return;
			explorer.startRename(sel);
		} else if ((isMac && mod && e.key === 'Backspace') || (!isMac && e.key === 'Delete')) {
			if (!sel || explorer.isRoot(sel)) return;
			void explorer.delete(sel);
		} else if (mod && e.altKey && e.code === 'KeyC') {
			void (e.shiftKey ? copyRel([sel ?? '']) : copyAbs([sel ?? '']));
		} else if (mod && e.altKey && e.code === 'KeyR') {
			reveal(sel);
		} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			const rows = explorer.rows();
			const i = rows.findIndex((r) => r.rel === sel);
			const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
			if (next) {
				if (e.shiftKey) explorer.selectRange(next.rel);
				else select(next.rel);
				tree?.querySelector<HTMLElement>(`[data-rel="${CSS.escape(next.rel)}"]`)?.focus();
			}
		} else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && sel && !e.shiftKey && !mod) {
			const row = explorer.rows().find((r) => r.rel === sel);
			if (!row) return;
			if (e.key === 'ArrowRight' && row.is_dir && !row.expanded) void explorer.expand(row.rel);
			else if (e.key === 'ArrowLeft' && row.is_dir && row.expanded) explorer.collapse(row);
			else if (row.nests && (e.key === 'ArrowRight') !== row.expanded) explorer.toggleNest(row.rel);
			else if (e.key === 'ArrowLeft') {
				const parent = sel.includes('/') ? sel.slice(0, sel.lastIndexOf('/')) : null;
				const up = parent && explorer.rows().find((r) => r.rel === parent || r.chain?.includes(parent));
				if (up) {
					select(up.rel);
					tree?.querySelector<HTMLElement>(`[data-rel="${CSS.escape(up.rel)}"]`)?.focus();
				}
			} else return;
		} else return;
		e.preventDefault();
		e.stopPropagation();
	}
</script>

<svelte:window onkeydown={(e) => menu && e.key === 'Escape' && (menu = null)} onblur={() => (menu = null)} />

{#if !workspace.ready}
	<div></div>
{:else if !workspace.root}
	<!-- VS Code's explorer welcome view (no folder opened). -->
	<section class="flex min-h-0 flex-1 flex-col">
		<div class="flex h-(--kg-row-height) shrink-0 items-center gap-0.5 px-0.5 text-[11px] font-bold uppercase text-(--vscode-sideBarTitle-foreground)">
			<Icon name="chevronDown" size={16} />
			No Folder Opened
		</div>
		<div class="flex flex-col gap-3 px-5 py-2 leading-normal">
			<p>ยังไม่ได้เปิดโฟลเดอร์</p>
			<button
				class="flex h-8 w-full items-center justify-center gap-2 rounded-md bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:bg-[var(--vscode-button-hoverBackground,#026EC1)]"
				onclick={() => workspace.pickFolder()}
			>
				<Icon name="folder" size={15} />Open Folder
			</button>
			<button
				class="h-[26px] w-full rounded-sm bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:bg-[var(--vscode-button-hoverBackground,#026EC1)]"
				onclick={() => repoDialog.show('clone')}
			>
				Clone Repository
			</button>
			<button class="h-[26px] w-full rounded-sm border border-(--vscode-widget-border) hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => repoDialog.show('create')}>New Project</button>
			{#if workspace.recent.length}
				<div>
					<p class="mb-1 text-[11px] font-medium text-(--vscode-descriptionForeground) uppercase">Recent</p>
					<ul class="-mx-2">
						{#each workspace.recent.slice(0, 5) as path (path)}
							{@const r = recentLabel(path)}
							<li>
								<button class="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-(--vscode-list-hoverBackground)" title={path} onclick={() => workspace.openFolder(path)}>
									<span class="shrink-0 text-(--vscode-descriptionForeground)"><Icon name="folder" size={14} /></span>
									<span class="truncate text-(--vscode-textLink-foreground)">{r.label}</span>
									<span class="min-w-0 truncate text-xs text-(--vscode-descriptionForeground)">{r.detail}</span>
								</button>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
			<p class="text-(--vscode-descriptionForeground)">เปิดโฟลเดอร์ ({keyLabel('cmd+o')}) หรือโฟลเดอร์ล่าสุด ({keyLabel('ctrl+r')})</p>
		</div>
	</section>
{:else}
	<section class="flex min-h-0 flex-1 flex-col">
		<!-- Section header; its actions show on hover or focus, like VS Code's Explorer. -->
		<div class="group flex h-(--kg-row-height) shrink-0 items-center pr-1">
			<button
				class="flex h-full min-w-0 flex-1 items-center gap-0.5 px-0.5 text-[11px] font-bold uppercase text-(--vscode-sideBarTitle-foreground)"
				aria-expanded={open}
				title={workspace.root}
				onclick={() => (open = !open)}
				oncontextmenu={(e) => openMenu(e, null)}
			>
				<Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
				<span class="truncate">{workspaceName}</span>
			</button>
			<div class="flex items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
				{#each [
					{ label: 'New File...', icon: 'newFile', run: () => explorer.startCreate('file') },
					{ label: 'New Folder...', icon: 'newFolder', run: () => explorer.startCreate('folder') },
					{ label: 'Refresh Explorer', icon: 'refresh', run: () => explorer.refresh(['', ...explorer.expanded]) },
					{ label: 'Collapse Folders in Explorer', icon: 'collapseAll', run: () => explorer.collapseAll() }
				] as const as a (a.label)}
					<button
						class="grid size-[22px] place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground)"
						aria-label={a.label}
						title={a.label}
						onclick={() => {
							open = true;
							void a.run();
						}}><Icon name={a.icon} size={16} /></button
					>
				{/each}
			</div>
		</div>

		{#if open}
			<div
				bind:this={tree}
				role="tree"
				tabindex="-1"
				aria-label="ไฟล์ใน workspace"
				aria-multiselectable="true"
				data-context="explorer"
				class={['min-h-0 flex-1 overflow-y-auto outline-none', dragTarget === '' && 'bg-(--vscode-list-dropBackground)']}
				style:scroll-behavior="var(--kg-list-scroll-behavior, auto)"
				onkeydown={onTreeKey}
				oncontextmenu={(e) => openMenu(e, null)}
				onclick={(e) => e.target === e.currentTarget && select(null)}
				ondragover={(e) => onDragOver(e, null)}
				ondragleave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && (dragTarget = null)}
				ondrop={(e) => onDrop(e, null)}
			>
				{#each items as item (item.type === 'row' ? item.row.rel : item.key)}
					{#if item.type === 'input'}
						<div class="relative" style:padding-left="{8 + item.depth * indent}px">
							<div class="flex h-(--kg-row-height) items-center gap-1 pr-2">
								<span class="flex w-4 shrink-0 justify-center text-(--vscode-icon-foreground)">
									{#if item.is_dir}<Icon name="chevronRight" size={16} />{/if}
								</span>
								<FileIcon icon={item.is_dir ? folderIcon(item.value, false) : fileIcon(item.value)} />
								<input
									use:editBox={{ value: item.value, is_dir: item.is_dir }}
									aria-label={explorer.editing?.kind === 'rename' ? 'ชื่อใหม่' : item.is_dir ? 'ชื่อโฟลเดอร์ใหม่' : 'ชื่อไฟล์ใหม่'}
									aria-invalid={inputError !== ''}
									spellcheck="false"
									class={[
										'h-[20px] min-w-0 flex-1 border bg-(--vscode-input-background) px-1 text-(--vscode-input-foreground) outline-none',
										inputError ? 'border-[color:var(--vscode-inputValidation-errorBorder,#BE1100)]' : 'border-(--vscode-focusBorder)'
									]}
									oninput={() => (inputError = '')}
									onkeydown={onInputKey}
									onblur={onInputBlur}
								/>
							</div>
							{#if inputError}
								<p
									role="alert"
									class="absolute right-2 left-[calc(var(--pad)+20px)] z-10 border border-[color:var(--vscode-inputValidation-errorBorder,#BE1100)] bg-[var(--vscode-inputValidation-errorBackground,#5A1D1D)] px-1 py-0.5 text-xs whitespace-normal"
									style:--pad="{8 + item.depth * indent}px"
								>
									{inputError}
								</p>
							{/if}
						</div>
					{:else}
						{@const row = item.row}
						{@const picked = explorer.isSelected(row.rel)}
						<button
							role="treeitem"
							data-rel={row.rel}
							aria-selected={picked}
							aria-expanded={row.is_dir ? row.expanded : undefined}
							draggable={dndEnabled}
							class={[
								'mx-1.5 flex h-(--kg-row-height) w-[calc(100%-12px)] items-center gap-1 rounded-md pr-2 text-left leading-(--kg-row-height) outline-offset-[-1px]',
								picked
									? 'bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground) outline outline-1 outline-(--vscode-focusBorder)'
									: inDragTarget(row.rel)
										? 'bg-(--vscode-list-dropBackground)'
										: 'hover:bg-(--vscode-list-hoverBackground)',
								explorer.selected === row.rel && 'outline outline-1 outline-(--vscode-focusBorder)',
								editors.active === row.rel && !picked && 'bg-(--vscode-list-inactiveSelectionBackground)',
								menu?.target === row.rel && 'outline outline-1 outline-(--vscode-focusBorder)',
								explorer.isCut(row.rel) && 'opacity-50'
							]}
							style:padding-left="{8 + row.depth * indent}px"
							title={row.root ? explorer.roots().find((r) => r.key === row.rel)?.path : row.rel}
							onclick={(e) => onRowClick(e, row)}
							ondblclick={(e) => {
								if (!row.is_dir && !e.shiftKey && !(isMac ? e.metaKey : e.ctrlKey)) editors.open(row.rel, { preview: false });
							}}
							oncontextmenu={(e) => openMenu(e, row.rel)}
							ondragstart={(e) => onDragStart(e, row)}
							ondragover={(e) => onDragOver(e, row)}
							ondrop={(e) => onDrop(e, row)}
							ondragend={() => (dragTarget = null)}
						>
							<span class="flex w-4 shrink-0 justify-center text-(--vscode-icon-foreground)" data-twistie>
								{#if row.is_dir || row.nests}<Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} size={16} />{/if}
							</span>
							<FileIcon icon={row.is_dir ? folderIcon(row.rel, row.expanded) : fileIcon(row.name)} />
							<span class={['min-w-0 flex-1 truncate', row.ignored && 'italic opacity-55', row.root && 'font-semibold']} style:color={decoColors ? nameColor(row.rel) : undefined}>{row.name}</span>
							{#if decoBadges && problems?.get(row.rel)?.count}{@const p = problems.get(row.rel)!}<span class="shrink-0 pl-2 text-[11px] font-semibold" style:color={decoColors ? PROBLEM_COLORS[p.severity] : undefined} title={p.count === 1 ? t('problems.decoration.one') : t('problems.decoration.many', { count: p.count! })}>{problemBadge(p.count!)}</span>{/if}
							{#if coverage}{@const cov = coverageBadge(row.rel)}{#if cov}<span class="shrink-0 pl-2 text-[11px] tabular-nums" style:color={cov.color}>{cov.text}</span>{/if}{/if}
							{#if row.ignored}<span class="shrink-0 pr-3 pl-2 opacity-55" title="ถูก .gitignore"><Icon name="ignored" size={12} /></span>
							{:else if decoBadges && decorations.has(row.rel)}{@const deco = decorations.get(row.rel)!}<span class="shrink-0 pr-3 pl-2 text-[11px] font-semibold" style:color={decoColors ? deco.color : undefined}>{deco.letter || '•'}</span>{/if}
						</button>
					{/if}
				{/each}
				{#if explorer.error}<p class="px-4 py-1 text-(--vscode-errorForeground)">{explorer.error}</p>{/if}
			</div>
		{/if}
	</section>
{/if}

{#if menu}
	{@const m = menu}
	<!-- VS Code's context menu: closes on any click outside, Escape or window blur. -->
	<div
		class="fixed inset-0 z-40"
		role="presentation"
		onpointerdown={() => (menu = null)}
		oncontextmenu={(e) => {
			e.preventDefault();
			menu = null;
		}}
	></div>
	<div
		role="menu"
		aria-label={m.target ? baseName(m.target) : workspaceName}
		class="fixed z-50 min-w-[220px] rounded-md border border-[color:var(--vscode-menu-border,#454545)] bg-[var(--vscode-menu-background,#1F1F1F)] py-1 text-[color:var(--vscode-menu-foreground,#CCCCCC)] shadow-[0_2px_8px_rgba(0,0,0,0.36)]"
		style:left="{m.x}px"
		style:top="{m.y}px"
	>
		{#each menuItems(m.target) as it, i (i)}
			{#if it === 'sep'}
				<div role="separator" class="mx-2 my-1 h-px bg-[var(--vscode-menu-separatorBackground,#454545)]"></div>
			{:else}
				<button
					role="menuitem"
					disabled={it.enabled === false}
					class="mx-1 flex h-6 w-[calc(100%-8px)] items-center justify-between gap-6 rounded px-3 text-left hover:bg-[var(--vscode-menu-selectionBackground,#0078D4)] hover:text-[color:var(--vscode-menu-selectionForeground,#FFFFFF)] disabled:opacity-40 disabled:hover:bg-transparent"
					onclick={() => {
						menu = null;
						void it.run();
					}}
				>
					<span>{it.label}</span>
					{#if it.key}<span class="text-xs opacity-80">{it.key}</span>{/if}
				</button>
			{/if}
		{/each}
	</div>
{/if}
