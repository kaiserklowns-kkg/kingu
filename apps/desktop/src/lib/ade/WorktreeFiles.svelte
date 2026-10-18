<script lang="ts">
	// Explorer tab of the ADE's right side bar (Orca's FileExplorer) for one worktree: header with
	// Collapse All, Refresh and a "…" menu (Show Dotfiles, Show Git Ignored Files, Reveal, Open in
	// Editor / Terminal); the "Find files" box with Names (every space-separated part in the path,
	// over the whole worktree) or Contents (ripgrep in the worktree, case / word / regex, include and
	// exclude, results per file, a click opens at the match); and the lazy tree with git letters,
	// ignored entries dimmed, a context menu, inline new / rename, delete to Trash, drag to move,
	// keyboard navigation, and the active file revealed. Rows click open as a preview tab of this
	// worktree in the center; a double click keeps the tab. The watcher re-lists changed folders.
	import { untrack } from 'svelte';
	import { Channel, invoke } from '@tauri-apps/api/core';
	import { ask } from '@tauri-apps/plugin-dialog';
	import FileIcon from '#lib/workbench/FileIcon.svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import type { MenuNode } from '#lib/workbench/menus.ts';
	import { fileIcon, folderIcon } from '#lib/workbench/fileIcons.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { scm } from '#lib/workbench/scm.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { keyLabel } from '#lib/workbench/keys.ts';
	import { entryChanges, fileDecorations, fileOf, isDiffKey } from '#lib/workbench/scm.ts';
	import { affectedBy, baseName, dirsToRefresh, isUnder, joinRel, parentOf, remapPath, stemLength, validateName } from '#lib/workbench/fileTree.ts';
	import { splitPreview, type FileMatches, type SearchEvent } from '#lib/workbench/searchResults.ts';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { worktreeDir } from './keys.ts';
	import { adeLayout } from './adeLayout.svelte.ts';
	import { openEditor } from './agentsMode.svelte.ts';
	import { rightSidebar } from './rightSidebar.svelte.ts';
	import { contentRows, contentSummary, filesOf, nameMatches, rowLook, touchesWorktree, type NameRow } from './rightSidebar.ts';

	type Entry = { name: string; rel: string; is_dir: boolean; ignored?: boolean; untracked?: boolean };
	type Row = Entry & { depth: number; open: boolean };
	type Editing = { kind: 'file' | 'folder'; parent: string } | { kind: 'rename'; rel: string; is_dir: boolean };

	/** '' for the folder itself, else a task slug. */
	let { slug }: { slug: string } = $props();

	const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');
	const base = $derived(slug ? worktreeDir(slug) : '');
	const find = $derived(rightSidebar.find(slug));
	/** Worktree-relative path (Names / Contents results) → workspace-relative. */
	const full = (rel: string) => (base ? `${base}/${rel}` : rel);
	/** Workspace-relative → worktree-relative (Copy Relative Path, Find in Folder). */
	const local = (rel: string) => (base && isUnder(rel, base) ? rel.slice(base.length + 1) : rel);
	const abs = (rel: string) => (rel ? `${workspace.root}/${rel}` : (workspace.root ?? ''));

	let children = $state<Record<string, Entry[]>>({});
	let open = $state<Record<string, boolean>>({});
	let error = $state('');
	let refreshing = $state(false);
	let selected = $state<string | null>(null);
	let editing = $state<Editing | null>(null);
	let inputError = $state('');
	let dropTarget = $state<string | null>(null);
	let menu = $state<{ x: number; y: number; items: MenuNode[]; run: (id: string) => void; label: string } | null>(null);
	let tree: HTMLDivElement | undefined = $state();
	let findInput: HTMLInputElement | undefined = $state();

	// --- Tree -----------------------------------------------------------------------------------

	async function load(rel: string) {
		try {
			children[rel] = await invoke<Entry[]>('fs_list_dir', { rel });
			if (rel === base) error = '';
		} catch (e) {
			if (rel === base) error = String(e);
			else {
				delete children[rel];
				delete open[rel];
			}
		}
	}

	// Only `base` is a dependency: `load` reads and writes `children`.
	$effect(() => {
		const b = base;
		untrack(() => {
			children = {};
			open = {};
			selected = null;
			editing = null;
			void load(b);
		});
	});

	async function refresh() {
		refreshing = true;
		allFiles = null;
		try {
			await Promise.all([base, ...Object.keys(open).filter((k) => open[k])].map(load));
			if (slug) await rightSidebar.repo(slug).refresh();
			else await scm.refresh();
		} finally {
			refreshing = false;
		}
	}

	// Watcher: re-list the loaded folders a batch touches; the Names list is read again when used.
	$effect(() => {
		const s = slug;
		return workspace.onAnyChange((paths) => {
			if (!touchesWorktree(paths, s)) return;
			allFiles = null;
			const changed = filesOf(paths, s);
			const dirs = changed.includes('') ? Object.keys(children) : dirsToRefresh(changed, Object.keys(children));
			for (const d of dirs) void load(d);
		});
	});

	async function expand(rel: string) {
		if (rel !== base) open[rel] = true;
		if (!children[rel]) await load(rel);
	}

	async function toggle(rel: string) {
		if (open[rel]) open[rel] = false;
		else await expand(rel);
	}

	const isDir = (rel: string) => rel === base || (children[parentOf(rel)]?.find((e) => e.rel === rel)?.is_dir ?? false);

	const decorations = $derived(
		slug ? fileDecorations(entryChanges(rightSidebar.repo(slug).repo?.entries ?? []), `${base}/`) : fileDecorations(entryChanges(scm.repo?.entries ?? []))
	);

	$effect(() => {
		if (slug) untrack(() => void rightSidebar.repo(slug).refresh());
	});

	const shown = (e: Entry) => (rightSidebar.showDotfiles || !e.name.startsWith('.')) && (rightSidebar.showIgnored || !e.ignored);

	const rows = $derived.by(() => {
		const out: Row[] = [];
		const walk = (rel: string, depth: number) => {
			for (const e of children[rel] ?? []) {
				// The folder's own worktrees live under .kingu: they show as their own cards instead.
				if (!slug && e.rel === '.kingu') continue;
				if (!shown(e)) continue;
				const isOpen = e.is_dir && !!open[e.rel];
				out.push({ ...e, depth, open: isOpen });
				if (isOpen) walk(e.rel, depth + 1);
			}
		};
		walk(base, 0);
		return out;
	});
	const ignoredDirs = $derived(new Set(Object.values(children).flatMap((list) => list.filter((e) => e.is_dir && e.ignored).map((e) => e.rel))));

	type Item = { type: 'row'; row: Row } | { type: 'input'; depth: number; is_dir: boolean; value: string; key: string };
	/** Rows plus the inline edit box: first in the target folder for New, in place for Rename. */
	const items = $derived.by((): Item[] => {
		const edit = editing;
		const out: Item[] = [];
		const input = (depth: number, is_dir: boolean, value: string): Item => ({ type: 'input', depth, is_dir, value, key: '\0input' });
		if (edit && edit.kind !== 'rename' && edit.parent === base) out.push(input(0, edit.kind === 'folder', ''));
		for (const row of rows) {
			if (edit?.kind === 'rename' && edit.rel === row.rel) {
				out.push(input(row.depth, row.is_dir, row.name));
				continue;
			}
			out.push({ type: 'row', row });
			if (edit && edit.kind !== 'rename' && edit.parent === row.rel && row.open) out.push(input(row.depth + 1, edit.kind === 'folder', ''));
		}
		return out;
	});

	function activate(r: { rel: string; is_dir: boolean }, preview = true) {
		selected = r.rel;
		if (r.is_dir) void toggle(r.rel);
		else adeLayout.openFile(slug, r.rel, { preview });
	}

	// Orca: the active editor's file is selected and scrolled into view when it is in this worktree.
	const activeFile = $derived.by(() => {
		const f = adeLayout.activeFile();
		if (!f) return null;
		const file = isDiffKey(f) ? fileOf(f) : f;
		if (slug ? !file.startsWith(base + '/') : file.startsWith('.kingu/')) return null;
		return file;
	});
	$effect(() => {
		const file = activeFile;
		if (!file) return;
		untrack(async () => {
			const dirs: string[] = [];
			for (let d = parentOf(file); d && d !== base; d = parentOf(d)) dirs.unshift(d);
			for (const d of dirs) await expand(d);
			selected = file;
			queueMicrotask(() => tree?.querySelector<HTMLElement>(`[data-rel="${CSS.escape(file)}"]`)?.scrollIntoView({ block: 'nearest' }));
		});
	});

	// --- File operations (the IDE explorer's commands, on this worktree) --------------------------

	async function copy(text: string, what = 'path') {
		try {
			await navigator.clipboard.writeText(text);
			status.flash(`คัดลอก ${what} แล้ว`);
		} catch (e) {
			status.flash(`คัดลอกไม่ได้: ${e}`);
		}
	}

	const reveal = (rel: string) => invoke('fs_reveal', { rel }).catch((e) => status.flash(String(e), 8000));

	async function startCreate(kind: 'file' | 'folder', target: string | null = selected) {
		const parent = target === null ? base : isDir(target) ? target : parentOf(target);
		await expand(parent);
		editing = { kind, parent };
	}

	function startRename(rel: string | null = selected) {
		if (!rel || rel === base) return;
		selected = rel;
		editing = { kind: 'rename', rel, is_dir: isDir(rel) };
	}

	async function commitEdit(value: string): Promise<string | null> {
		const edit = editing;
		if (!edit) return null;
		const name = value.trim();
		if (edit.kind === 'rename' && name === baseName(edit.rel)) {
			editing = null;
			return null;
		}
		if (!name && edit.kind !== 'rename') {
			editing = null;
			return null;
		}
		const invalid = validateName(name);
		if (invalid) return invalid;
		try {
			if (edit.kind === 'rename') await move(edit.rel, joinRel(parentOf(edit.rel), name));
			else {
				const rel = joinRel(edit.parent, name);
				await invoke(edit.kind === 'file' ? 'fs_create_file' : 'fs_create_dir', { rel });
				editing = null;
				for (let d = parentOf(rel); d && d !== base; d = parentOf(d)) open[d] = true;
				await Promise.all([edit.parent, ...rel.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))].filter((d) => isUnder(d, base)).map(load));
				selected = rel;
				if (edit.kind === 'file') adeLayout.openFile(slug, rel, { preview: false });
			}
		} catch (e) {
			return e instanceof Error ? e.message : String(e);
		}
		return null;
	}

	/** Rename or drag-move: open tabs (here and in the IDE) follow; unsaved edits block it. */
	async function move(from: string, to: string) {
		if (editors.allTabs().some((t) => t.dirty && remapPath(t.path, from, to) !== null)) throw new Error('มีไฟล์ที่ยังไม่บันทึกอยู่ข้างใน: บันทึกก่อนย้ายหรือเปลี่ยนชื่อ');
		await invoke('fs_rename', { from, to });
		editing = null;
		const wasOpen = Object.keys(open).filter((k) => open[k] && isUnder(k, from));
		for (const k of Object.keys(children)) if (isUnder(k, from)) delete children[k];
		for (const k of wasOpen) {
			delete open[k];
			open[to + k.slice(from.length)] = true;
		}
		await Promise.all([parentOf(from), parentOf(to), ...wasOpen.map((k) => to + k.slice(from.length))].map(load));
		selected = to;
		const remap = (path: string) => remapPath(path, from, to);
		editors.remap(remap);
		adeLayout.remapFiles(remap);
	}

	async function remove(rel: string | null = selected) {
		if (!rel || rel === base) return;
		const folder = isDir(rel);
		const what = folder ? `โฟลเดอร์ '${baseName(rel)}' และทุกอย่างข้างใน` : `'${baseName(rel)}'`;
		const tabs = affectedBy([...editors.openPaths(), ...adeLayout.openFiles()], rel);
		const dirty = new Set(editors.allTabs().filter((t) => t.dirty && tabs.includes(t.path)).map((t) => t.path)).size;
		const ok = await ask(`ย้าย ${what} ไปที่ถังขยะ?${dirty ? `\n\nมี ${dirty} ไฟล์ที่ยังไม่บันทึก การแก้ไขจะหายไป` : ''}\n\nกู้คืนได้จากถังขยะ`, {
			title: 'Delete',
			kind: 'warning',
			okLabel: 'ย้ายไปถังขยะ',
			cancelLabel: 'ยกเลิก'
		});
		if (!ok) return;
		try {
			await invoke('fs_delete', { rel });
		} catch (e) {
			status.flash(String(e), 8000);
			return;
		}
		for (const t of tabs) editors.closeEverywhere(t);
		adeLayout.dropFiles(Object.values(adeLayout.files).flatMap((list) => list.map((f) => f.key)).filter((k) => isUnder(fileOf(k), rel)));
		if (selected && isUnder(selected, rel)) selected = null;
		await load(parentOf(rel));
	}

	function openTerminalAt(rel: string) {
		const dir = isDir(rel) ? rel : parentOf(rel);
		const id = adeLayout.newTerminal(slug, { title: baseName(dir) || undefined, run: dir === base ? undefined : ['cd', abs(dir)] });
		adeLayout.select(slug, id);
	}

	function findInFolder(rel: string) {
		rightSidebar.searchContents(rel === base ? '' : `./${local(rel)}`);
	}

	// --- Menus ----------------------------------------------------------------------------------

	const REVEAL = isMac ? 'Reveal in Finder' : 'Reveal in File Explorer';

	function rowMenu(e: MouseEvent, target: string | null) {
		e.preventDefault();
		e.stopPropagation();
		const rel = target ?? base;
		selected = target;
		const dir = isDir(rel);
		const items: MenuNode[] = [
			menuItem('newFile', 'New File...'),
			menuItem('newFolder', 'New Folder...'),
			menuSeparator,
			menuItem('copyPath', 'Copy Path', { keyLabel: keyLabel('alt+cmd+c') }),
			menuItem('copyRel', 'Copy Relative Path', { keyLabel: keyLabel('alt+shift+cmd+c') }),
			menuSeparator
		];
		if (dir) items.push(menuItem('terminal', 'Open in Terminal'), menuItem('findIn', 'Find in Folder...'));
		if (dir && target && open[rel]) items.push(menuItem('collapse', 'Collapse Folder'));
		items.push(menuItem('reveal', REVEAL, { keyLabel: keyLabel('alt+cmd+r') }));
		if (target) items.push(menuSeparator, menuItem('rename', 'Rename...', { keyLabel: isMac ? '↵' : 'F2' }), menuItem('delete', 'Delete', { keyLabel: isMac ? '⌘⌫' : 'Delete' }));
		const run = (id: string) => {
			if (id === 'newFile') void startCreate('file', target);
			else if (id === 'newFolder') void startCreate('folder', target);
			else if (id === 'copyPath') void copy(abs(rel));
			else if (id === 'copyRel') void copy(local(rel) || '.', 'relative path');
			else if (id === 'terminal') openTerminalAt(rel);
			else if (id === 'findIn') findInFolder(rel);
			else if (id === 'collapse') open[rel] = false;
			else if (id === 'reveal') void reveal(rel);
			else if (id === 'rename') startRename(rel);
			else if (id === 'delete') void remove(rel);
		};
		menu = { x: e.clientX, y: e.clientY, items, run, label: target ? baseName(target) : title };
	}

	function moreMenu(e: MouseEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const items: MenuNode[] = [
			menuItem('dotfiles', 'Show Dotfiles', { checked: rightSidebar.showDotfiles }),
			menuItem('ignored', 'Show Git Ignored Files', { checked: rightSidebar.showIgnored }),
			menuSeparator,
			menuItem('newFile', 'New File...'),
			menuItem('newFolder', 'New Folder...'),
			menuSeparator,
			menuItem('reveal', REVEAL),
			menuItem('terminal', 'Open in Terminal'),
			menuItem('editor', 'Open in Editor (IDE)')
		];
		const run = (id: string) => {
			if (id === 'dotfiles') rightSidebar.showDotfiles = !rightSidebar.showDotfiles;
			else if (id === 'ignored') rightSidebar.showIgnored = !rightSidebar.showIgnored;
			else if (id === 'newFile') void startCreate('file', null);
			else if (id === 'newFolder') void startCreate('folder', null);
			else if (id === 'reveal') void reveal(base);
			else if (id === 'terminal') openTerminalAt(base);
			else if (id === 'editor') openEditor();
		};
		menu = { x: r.left, y: r.bottom + 2, items, run, label: 'More Explorer Actions' };
	}

	// --- Inline edit box ------------------------------------------------------------------------

	function editBox(el: HTMLInputElement, init: { value: string; is_dir: boolean }) {
		inputError = '';
		el.value = init.value;
		queueMicrotask(() => {
			el.focus();
			el.setSelectionRange(0, stemLength(init.value, init.is_dir));
		});
	}

	let committing = false;
	async function commitBox(el: HTMLInputElement) {
		if (committing || !editing) return;
		committing = true;
		try {
			const err = await commitEdit(el.value);
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
			void commitBox(e.currentTarget as HTMLInputElement);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			editing = null;
			tree?.focus();
		}
	}

	// Orca: blur cancels the edit (Enter commits).
	const onInputBlur = () => {
		if (!committing) editing = null;
	};

	// --- Keyboard (Orca's tree keys) --------------------------------------------------------------

	function focusRow(rel: string) {
		selected = rel;
		tree?.querySelector<HTMLElement>(`[data-rel="${CSS.escape(rel)}"]`)?.focus();
	}

	function onTreeKey(e: KeyboardEvent) {
		const list = rows;
		const i = list.findIndex((r) => r.rel === selected);
		const row = i >= 0 ? list[i] : undefined;
		const mod = isMac ? e.metaKey : e.ctrlKey;
		const page = Math.max(1, Math.round(list.length / 10));
		const go = (n: number) => list.length && focusRow(list[Math.max(0, Math.min(list.length - 1, n))].rel);
		if (e.key === 'ArrowDown') go(i + 1);
		else if (e.key === 'ArrowUp') go(i < 0 ? 0 : i - 1);
		else if (e.key === 'Home') go(0);
		else if (e.key === 'End') go(list.length - 1);
		else if (e.key === 'PageDown') go(i + page);
		else if (e.key === 'PageUp') go(i - page);
		else if (e.key === 'ArrowRight' && row?.is_dir) {
			if (!row.open) void expand(row.rel);
			else if (list[i + 1]?.depth === row.depth + 1) go(i + 1);
		} else if (e.key === 'ArrowLeft' && row) {
			if (row.is_dir && row.open) open[row.rel] = false;
			else if (parentOf(row.rel) !== base && parentOf(row.rel)) focusRow(parentOf(row.rel));
		} else if (e.key === ' ' && row) activate(row);
		else if ((e.key === 'Enter' && isMac && !mod) || e.key === 'F2') startRename();
		else if (e.key === 'Enter' && row) activate(row, false);
		else if ((isMac && mod && e.key === 'Backspace') || (!isMac && e.key === 'Delete')) void remove();
		else if (mod && e.altKey && e.code === 'KeyC') void (e.shiftKey ? copy(local(selected ?? base) || '.', 'relative path') : copy(abs(selected ?? base)));
		else if (mod && e.altKey && e.code === 'KeyR') void reveal(selected ?? base);
		else return;
		e.preventDefault();
		e.stopPropagation();
	}

	// --- Drag and drop: onto a folder moves into it; hovering a closed folder opens it ------------

	let hoverTimer: ReturnType<typeof setTimeout> | undefined;
	function onDragStart(e: DragEvent, r: Row) {
		e.dataTransfer?.setData('application/x-kingu-rel', r.rel);
		e.dataTransfer?.setData('text/plain', abs(r.rel));
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove';
	}
	function dropDir(r: Row | null) {
		return r === null ? base : r.is_dir ? r.rel : parentOf(r.rel);
	}
	function onDragOver(e: DragEvent, r: Row | null) {
		if (!e.dataTransfer?.types.includes('application/x-kingu-rel')) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		const dir = dropDir(r);
		if (dropTarget !== dir) {
			dropTarget = dir;
			clearTimeout(hoverTimer);
			if (r?.is_dir && !r.open) hoverTimer = setTimeout(() => void expand(r.rel), 600);
		}
	}
	async function onDrop(e: DragEvent, r: Row | null) {
		const from = e.dataTransfer?.getData('application/x-kingu-rel');
		const dir = dropDir(r);
		dropTarget = null;
		clearTimeout(hoverTimer);
		if (!from) return;
		e.preventDefault();
		if (from === dir || parentOf(from) === dir || isUnder(dir, from)) return;
		try {
			await move(from, joinRel(dir, baseName(from)));
		} catch (err) {
			status.flash(err instanceof Error ? err.message : String(err), 8000);
		}
	}

	// --- Names ----------------------------------------------------------------------------------

	let allFiles = $state<string[] | null>(null);
	let loadingFiles = false;
	$effect(() => {
		if (find.view !== 'names' || !find.query.trim() || allFiles || loadingFiles) return;
		const s = slug;
		loadingFiles = true;
		(s ? invoke<string[]>('worktree_list_files', { slug: s }) : invoke<string[]>('fs_list_files'))
			.then((list) => s === slug && (allFiles = list))
			.catch((e) => status.flash(String(e), 8000))
			.finally(() => (loadingFiles = false));
	});
	const names = $derived.by(() => {
		if (find.view !== 'names' || !find.query.trim() || !allFiles) return null;
		const visible = rightSidebar.showDotfiles ? allFiles : allFiles.filter((f) => !f.split('/').some((p) => p.startsWith('.')));
		return nameMatches(visible, find.query);
	});

	// --- Contents -------------------------------------------------------------------------------

	let results = $state<FileMatches[]>([]);
	let searching = $state(false);
	let limitHit = $state(false);
	let searchError = $state('');
	let collapsed = $state(new Set<string>());
	let generation = 0;
	let runNow = $state(0);

	$effect(() => {
		const q = find.view === 'contents' ? find.query : '';
		const o = $state.snapshot(find.options);
		const s = slug;
		const immediate = runNow;
		const run = ++generation;
		results = [];
		limitHit = false;
		searchError = '';
		collapsed = new Set();
		if (!q.trim()) {
			searching = false;
			void invoke('worktree_search_cancel');
			return;
		}
		const timer = setTimeout(
			() => {
				searching = true;
				const onEvent = new Channel<SearchEvent>();
				onEvent.onmessage = (ev) => {
					if (run !== generation) return;
					if (ev.kind === 'file') results = [...results, { path: ev.path, matches: ev.matches }];
					else if (ev.kind === 'done') {
						searching = false;
						limitHit = ev.limit_hit;
					} else {
						searching = false;
						searchError = ev.message;
					}
				};
				const exclude = [o.exclude, s ? '' : './.kingu'].filter(Boolean).join(', ');
				const options = { query: q, is_regex: o.regex, match_case: o.matchCase, whole_word: o.wholeWord, include: o.include, exclude, use_ignore_files: true, max_results: 2000 };
				invoke('worktree_search', { slug: s || null, options, onEvent }).catch((e) => {
					if (run !== generation) return;
					searching = false;
					searchError = String(e);
				});
			},
			immediate ? 0 : 300
		);
		return () => clearTimeout(timer);
	});

	const contents = $derived(contentRows(results, collapsed));

	function toggleCollapsed(path: string) {
		const next = new Set(collapsed);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		collapsed = next;
	}

	function resultMenu(e: MouseEvent, path: string, line?: number) {
		e.preventDefault();
		const items = line === undefined ? [menuItem('copyPath', 'Copy Path')] : [menuItem('copyLine', 'Copy Line Path')];
		menu = { x: e.clientX, y: e.clientY, items, label: baseName(path), run: (id) => void copy(id === 'copyPath' ? abs(full(path)) : `${local(full(path))}#L${line}`) };
	}

	function onFindKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			find.query = '';
			findInput?.blur();
		} else if (e.key === 'Enter' && find.view === 'contents') runNow++;
		else if (e.key === 'ArrowDown' && find.view === 'names' && names?.rows.length) {
			e.preventDefault();
			(document.querySelector('[data-names-first]') as HTMLElement | null)?.focus();
		}
	}

	// ⌘⇧F (and Find in Folder) focus the box.
	let lastFocus = rightSidebar.focusFind;
	$effect(() => {
		const n = rightSidebar.focusFind;
		if (n !== lastFocus) {
			lastFocus = n;
			queueMicrotask(() => findInput?.select());
		}
	});

	const title = $derived(slug ? `kingu/${slug}` : workspace.name);
	const OPTION = 'grid size-5 place-items-center rounded-sm text-[11px] font-semibold';
	const HEADER_ACTION = 'grid size-6 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
</script>

{#snippet nameRow(r: NameRow, first: boolean)}
	{@const rel = full(r.rel)}
	<button
		class="flex h-[22px] w-full items-center gap-1 pr-2 text-left hover:bg-(--vscode-list-hoverBackground) focus:bg-(--vscode-list-activeSelectionBackground) focus:outline-none"
		style:padding-left="{8 + r.depth * 12}px"
		title={r.rel}
		data-names-first={first ? '' : undefined}
		onclick={() => !r.is_dir && adeLayout.openFile(slug, rel, { preview: true })}
		ondblclick={() => !r.is_dir && adeLayout.openFile(slug, rel, { preview: false })}
		onkeydown={(e) => {
			const el = e.currentTarget as HTMLElement;
			if (e.key === 'ArrowDown') (el.nextElementSibling as HTMLElement | null)?.focus();
			else if (e.key === 'ArrowUp') ((el.previousElementSibling as HTMLElement | null) ?? findInput)?.focus();
			else return;
			e.preventDefault();
		}}
	>
		<span class="w-4 shrink-0 text-(--vscode-icon-foreground)">{#if r.is_dir}<Icon name="chevronDown" size={14} />{/if}</span>
		<FileIcon icon={r.is_dir ? folderIcon(rel, true) : fileIcon(r.name)} />
		<span class={['min-w-0 flex-1 truncate', r.is_dir && 'text-(--vscode-descriptionForeground)']} style:color={decorations.get(rel)?.color}>{r.name}</span>
		{#if !r.is_dir && decorations.get(rel)?.letter}<span class="shrink-0 pl-2 text-[11px] font-semibold" style:color={decorations.get(rel)?.color}>{decorations.get(rel)?.letter}</span>{/if}
	</button>
{/snippet}

<div class="flex h-full min-h-0 flex-col">
	<div class="flex h-8 shrink-0 items-center gap-0.5 pr-1 pl-3">
		<span class="min-w-0 flex-1 truncate text-[13px] font-medium" title={abs(base)}>{title}</span>
		<button class={HEADER_ACTION} aria-label="Collapse All" title="Collapse All" onclick={() => (open = {})}><Icon name="collapseAll" size={15} /></button>
		<button class={HEADER_ACTION} aria-label="Refresh Explorer" title="Refresh Explorer" disabled={refreshing} onclick={refresh}>
			<span class={refreshing ? 'animate-spin' : ''}><Icon name="refresh" size={15} /></span>
		</button>
		<button class={HEADER_ACTION} aria-label="More Explorer Actions" title="More Explorer Actions" onclick={moreMenu}><Icon name="menu" size={15} /></button>
	</div>
	<label class="mx-2 mb-1.5 flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) px-2 text-[13px] focus-within:border-(--vscode-focusBorder)">
		<Icon name="search" size={13} />
		<span class="sr-only">{find.view === 'names' ? 'Filter files by name' : 'Search file contents'}</span>
		<input
			bind:this={findInput}
			class="min-w-0 flex-1 bg-transparent outline-none placeholder:text-(--vscode-input-placeholderForeground)"
			placeholder={find.view === 'names' ? 'Find files' : 'Search'}
			spellcheck="false"
			bind:value={find.query}
			onkeydown={onFindKey}
		/>
		{#if find.view === 'contents'}
			{#each [['matchCase', 'Aa', 'Match Case'], ['wholeWord', 'ab', 'Match Whole Word'], ['regex', '.*', 'Use Regular Expression']] as const as [k, text, label] (k)}
				<button
					type="button"
					class={[OPTION, find.options[k] ? 'bg-(--vscode-inputOption-activeBackground,#24557780) text-(--vscode-foreground) outline outline-1 outline-(--vscode-inputOption-activeBorder,#007ACC)' : 'text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground)']}
					aria-label={label}
					aria-pressed={find.options[k]}
					title={label}
					onclick={() => (find.options[k] = !find.options[k])}>{text}</button
				>
			{/each}
			<button type="button" class={[OPTION, 'text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground)']} aria-label="Toggle Search Details" aria-expanded={find.options.details} title="Toggle Search Details" onclick={() => (find.options.details = !find.options.details)}>…</button>
		{/if}
	</label>
	{#if find.view === 'contents' && find.options.details}
		<div class="mx-2 mb-1.5 flex shrink-0 flex-col gap-1 text-xs">
			<input class="h-6 rounded-md border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) px-2 outline-none focus:border-(--vscode-focusBorder)" placeholder="files to include (e.g. *.ts, src/**)" aria-label="Files To Include" spellcheck="false" bind:value={find.options.include} />
			<input class="h-6 rounded-md border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) px-2 outline-none focus:border-(--vscode-focusBorder)" placeholder="files to exclude (e.g. *.min.js, dist/**)" aria-label="Files To Exclude" spellcheck="false" bind:value={find.options.exclude} />
		</div>
	{/if}
	<div class="mx-2 mb-2 grid shrink-0 grid-cols-2 rounded-md bg-(--vscode-input-background) p-0.5 text-xs" role="radiogroup" aria-label="Explorer search mode">
		{#each [['names', 'Names'], ['contents', 'Contents']] as const as [id, label] (id)}
			<button
				role="radio"
				aria-checked={find.view === id}
				class={['h-6 rounded-[5px]', find.view === id ? 'bg-(--vscode-editor-background) text-(--vscode-foreground) shadow-sm' : 'text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)']}
				onclick={() => ((find.view = id), findInput?.focus())}>{label}</button
			>
		{/each}
	</div>

	{#if find.view === 'contents' && find.query.trim()}
		<div class="min-h-0 flex-1 overflow-y-auto pb-2 text-[13px]" aria-label="ผลการค้นหา">
			<p class="px-3 pb-1 text-xs text-(--vscode-descriptionForeground)">
				{#if searchError}<span class="text-(--vscode-errorForeground)">{searchError}</span>{:else if searching && !results.length}กำลังค้นหา…{:else}{contentSummary(results, limitHit)}{/if}
			</p>
			{#each contents as r (r.key)}
				{#if r.kind === 'file'}
					<button class="flex h-[22px] w-full items-center gap-1 pr-2 pl-1 text-left hover:bg-(--vscode-list-hoverBackground)" title={r.path} aria-expanded={!r.collapsed} onclick={() => toggleCollapsed(r.path)} oncontextmenu={(e) => resultMenu(e, r.path)}>
						<span class="w-4 shrink-0 text-(--vscode-icon-foreground)"><Icon name={r.collapsed ? 'chevronRight' : 'chevronDown'} size={14} /></span>
						<FileIcon icon={fileIcon(r.name)} />
						<span class="shrink-0 truncate">{r.name}</span>
						<span class="min-w-0 flex-1 truncate text-xs text-(--vscode-descriptionForeground)">{r.dir}</span>
						<span class="shrink-0 rounded-full bg-(--vscode-badge-background) px-1.5 text-[11px] leading-4 text-(--vscode-badge-foreground)">{r.count}</span>
					</button>
				{:else}
					{@const p = splitPreview(r.match)}
					<button
						class="flex h-[22px] w-full items-baseline gap-1.5 pr-2 pl-7 text-left text-xs hover:bg-(--vscode-list-hoverBackground)"
						title="{r.path}:{r.match.line}"
						onclick={() => adeLayout.openFile(slug, full(r.path), { preview: true, reveal: { line: r.match.line, column: r.match.column, endColumn: r.match.end_column, focus: true } })}
						ondblclick={() => adeLayout.pin(slug, full(r.path))}
						oncontextmenu={(e) => resultMenu(e, r.path, r.match.line)}
					>
						<span class="w-7 shrink-0 text-right font-mono text-[11px] text-(--vscode-descriptionForeground)">{r.match.line}</span>
						<span class="min-w-0 flex-1 truncate font-mono">{p.before}<span class="rounded-sm bg-(--vscode-editor-findMatchHighlightBackground,#EA5C0055)">{p.match}</span>{p.after}</span>
					</button>
				{/if}
			{/each}
		</div>
	{:else if find.view === 'names' && find.query.trim()}
		<div class="min-h-0 flex-1 overflow-y-auto pb-2 text-[13px]" aria-label="ไฟล์ที่ตรงกับชื่อ">
			{#if !names}
				<p class="px-3 py-1 text-xs text-(--vscode-descriptionForeground)">กำลังอ่านรายชื่อไฟล์…</p>
			{:else if !names.rows.length}
				<p class="px-3 py-1 text-xs text-(--vscode-descriptionForeground)">No files match this filter</p>
			{:else}
				{#each names.rows as r, i (r.rel)}{@render nameRow(r, i === 0)}{/each}
				{#if names.total > names.rows.filter((r) => !r.is_dir).length}
					<p class="px-3 py-1 text-xs text-(--vscode-descriptionForeground)">แสดง {names.rows.filter((r) => !r.is_dir).length} จาก {names.total} ไฟล์ พิมพ์ให้เจาะจงขึ้น</p>
				{/if}
			{/if}
		</div>
	{:else}
		<div
			bind:this={tree}
			class="min-h-0 flex-1 overflow-y-auto pb-2 text-[13px] outline-none"
			role="tree"
			tabindex="-1"
			aria-label="Files"
			onkeydown={onTreeKey}
			oncontextmenu={(e) => rowMenu(e, null)}
			ondragover={(e) => onDragOver(e, null)}
			ondragleave={(e) => e.currentTarget === e.target && (dropTarget = null)}
			ondrop={(e) => onDrop(e, null)}
		>
			{#if error}
				<p class="px-3 text-xs text-(--vscode-errorForeground)">{error}</p>
			{/if}
			{#each items as item (item.type === 'row' ? item.row.rel : item.key)}
				{#if item.type === 'input'}
					<div class="relative" style:padding-left="{8 + item.depth * 12}px">
						<div class="flex h-[22px] items-center gap-1 pr-2">
							<span class="w-4 shrink-0"></span>
							<FileIcon icon={item.is_dir ? folderIcon(item.value, false) : fileIcon(item.value)} />
							<input
								use:editBox={{ value: item.value, is_dir: item.is_dir }}
								aria-label={editing?.kind === 'rename' ? 'ชื่อใหม่' : item.is_dir ? 'ชื่อโฟลเดอร์ใหม่' : 'ชื่อไฟล์ใหม่'}
								aria-invalid={inputError !== ''}
								spellcheck="false"
								class={['h-[20px] min-w-0 flex-1 border bg-(--vscode-input-background) px-1 text-(--vscode-input-foreground) outline-none', inputError ? 'border-[color:var(--vscode-inputValidation-errorBorder,#BE1100)]' : 'border-(--vscode-focusBorder)']}
								oninput={() => (inputError = '')}
								onkeydown={onInputKey}
								onblur={onInputBlur}
							/>
						</div>
						{#if inputError}
							<p role="alert" class="mx-2 border border-[color:var(--vscode-inputValidation-errorBorder,#BE1100)] bg-[var(--vscode-inputValidation-errorBackground,#5A1D1D)] px-1 py-0.5 text-xs whitespace-normal">{inputError}</p>
						{/if}
					</div>
				{:else}
					{@const r = item.row}
					{@const look = rowLook(r.rel, r.ignored, decorations, ignoredDirs, r.untracked)}
					<button
						role="treeitem"
						data-rel={r.rel}
						aria-selected={selected === r.rel}
						aria-expanded={r.is_dir ? r.open : undefined}
						draggable="true"
						class={[
							'flex h-[22px] w-full items-center gap-1 pr-2 text-left outline-offset-[-1px]',
							selected === r.rel ? 'bg-(--vscode-list-inactiveSelectionBackground) focus:bg-(--vscode-list-activeSelectionBackground) focus:outline focus:outline-1 focus:outline-(--vscode-focusBorder)' : 'hover:bg-(--vscode-list-hoverBackground)',
							r.is_dir && dropTarget === r.rel && 'bg-(--vscode-list-dropBackground,#383B3D)'
						]}
						style:padding-left="{8 + r.depth * 12}px"
						title={r.rel}
						onclick={() => activate(r)}
						ondblclick={() => !r.is_dir && activate(r, false)}
						oncontextmenu={(e) => rowMenu(e, r.rel)}
						ondragstart={(e) => onDragStart(e, r)}
						ondragover={(e) => (e.stopPropagation(), onDragOver(e, r))}
						ondrop={(e) => (e.stopPropagation(), onDrop(e, r))}
						ondragend={() => (dropTarget = null)}
					>
						<span class="grid w-4 shrink-0 place-items-center text-(--vscode-icon-foreground)">
							{#if r.is_dir}<Icon name={r.open ? 'chevronDown' : 'chevronRight'} size={14} />{/if}
						</span>
						<FileIcon icon={r.is_dir ? folderIcon(r.rel, r.open) : fileIcon(r.name)} />
						{#if look.ignored}
							<span class="min-w-0 flex-1 truncate italic opacity-55">{r.name}</span>
							<span class="shrink-0 pl-2 opacity-55" title="Ignored by .gitignore"><Icon name="ignored" size={12} /></span>
						{:else}
							<span class="min-w-0 flex-1 truncate" style:color={look.deco?.color}>{r.name}</span>
							{#if look.deco}<span class="shrink-0 pl-2 text-[11px] font-semibold" style:color={look.deco.color}>{look.deco.letter || '•'}</span>{/if}
						{/if}
					</button>
				{/if}
			{/each}
		</div>
	{/if}
</div>

{#if menu}
	{@const m = menu}
	<PopupMenu items={m.items} label={m.label} x={m.x} y={m.y} onRun={(node) => node.type === 'item' && m.run(node.id)} onClose={() => (menu = null)} />
{/if}
