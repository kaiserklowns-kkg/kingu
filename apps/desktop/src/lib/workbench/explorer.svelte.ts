import { invoke } from '@tauri-apps/api/core';
import { ask, message } from '@tauri-apps/plugin-dialog';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { clientLog } from '#lib/client-log.ts';
import { enabledGlobs, isExcluded, sortEntries, type SortOrder } from '#lib/settings/mappings.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { editors } from './editors.svelte';
import { affectedBy, baseName, dirsToRefresh, isUnder, joinRel, parentOf, remapPath, validateName } from './fileTree';
import { notifications } from './notifications.svelte';
import { compactChain, compactLabel, dropTarget, moveQuestion, planTransfer, rangeSelection, topLevel } from './explorerModel';

/** `ignored`: matched by `.gitignore` (drawn dimmed). `modified`: ms since the epoch. */
export type DirEntry = { name: string; rel: string; is_dir: boolean; ignored?: boolean; modified?: number };
/** `chain`: the folders a compacted row stands for (explorer.compactFolders), outermost first. */
export type Row = DirEntry & { depth: number; expanded: boolean; chain?: string[] };
/** Files cut or copied in the Explorer (VS Code keeps its own file clipboard). */
export type FileClipboard = { paths: string[]; cut: boolean };
/** The inline input row (VS Code's explorer edit box): a new entry in `parent`, or a rename of `rel`. */
export type Editing = { kind: 'file' | 'folder'; parent: string } | { kind: 'rename'; rel: string; is_dir: boolean };

// Lazily loaded tree: a directory's children are fetched the first time it is expanded.
class Explorer {
	children = new SvelteMap<string, DirEntry[]>();
	expanded = new SvelteSet<string>();
	error = $state('');
	/** The focused row (keyboard cursor); also the single selection. */
	selected = $state<string | null>(null);
	/** Every selected row (⌘/⇧-click); always contains `selected` when that is set. */
	selection = new SvelteSet<string>();
	/** Where a ⇧-click range starts. */
	anchor: string | null = null;
	editing = $state<Editing | null>(null);
	clipboard = $state<FileClipboard | null>(null);
	/** A row the view should focus once it is rendered (Reveal in Explorer View). */
	focusRequest = $state<string | null>(null);

	async load(rel: string) {
		try {
			const entries = await invoke<DirEntry[]>('fs_list_dir', { rel });
			this.children.set(rel, entries);
			if (!rel) {
				this.error = '';
				clientLog('info', `explorer: ${entries.length} entries at workspace root`);
			}
		} catch (e) {
			if (rel) this.#forget(rel);
			else this.error = String(e);
		}
	}

	async toggle(rel: string) {
		if (this.expanded.has(rel)) this.expanded.delete(rel);
		else await this.expand(rel);
	}

	async expand(rel: string) {
		if (rel) this.expanded.add(rel);
		if (!this.children.has(rel)) await this.load(rel);
		// explorer.compactFolders: a folder whose only child is a folder opens that one too, so the
		// chain shows as one `a/b/c` row like VS Code.
		if (rel && settings.get<boolean>('explorer.compactFolders')) {
			const kids = this.visibleChildren(rel);
			if (kids.length === 1 && kids[0].is_dir && !this.expanded.has(kids[0].rel)) await this.expand(kids[0].rel);
		}
	}

	/** Collapsing a compacted row collapses its whole chain. */
	collapse(row: Pick<Row, 'rel' | 'chain'>) {
		for (const rel of row.chain ?? [row.rel]) this.expanded.delete(rel);
	}

	/** Open Folder / Close Folder: drop the whole tree. */
	reset() {
		this.children.clear();
		this.expanded.clear();
		this.error = '';
		this.selected = null;
		this.selection.clear();
		this.anchor = null;
		this.editing = null;
		this.clipboard = null;
	}

	/** File watcher batch: re-list the loaded folders the changes touch. */
	async refresh(changed: string[]) {
		await Promise.all(dirsToRefresh(changed, this.children.keys()).map((d) => this.load(d)));
	}

	collapseAll() {
		this.expanded.clear();
	}

	#forget(rel: string) {
		for (const k of [...this.children.keys()]) if (k && isUnder(k, rel)) this.children.delete(k);
		for (const k of [...this.expanded]) if (isUnder(k, rel)) this.expanded.delete(k);
	}

	/** A folder's entries as shown: files.exclude and explorer.excludeGitIgnore hide, explorer.sortOrder sorts. */
	visibleChildren(rel: string): DirEntry[] {
		const exclude = enabledGlobs(settings.get('files.exclude'));
		const gitIgnored = settings.get<boolean>('explorer.excludeGitIgnore');
		const shown = (this.children.get(rel) ?? []).filter((e) => !(gitIgnored && e.ignored) && !isExcluded(e.rel, exclude));
		return sortEntries(shown, settings.get<SortOrder>('explorer.sortOrder'));
	}

	/** Visible rows in display order, like VS Code's flattened tree. With explorer.compactFolders an
	 * expanded chain of single-folder folders is one row (`a/b/c`) standing for its last folder. */
	rows(): Row[] {
		const out: Row[] = [];
		const compact = settings.get<boolean>('explorer.compactFolders');
		const loaded = (rel: string) => (this.expanded.has(rel) && this.children.has(rel) ? this.visibleChildren(rel) : null);
		const walk = (rel: string, depth: number) => {
			for (const e of this.visibleChildren(rel)) {
				const chain = compact && e.is_dir ? compactChain(e.rel, loaded) : [e.rel];
				const last = chain[chain.length - 1];
				const entry = chain.length > 1 ? (this.children.get(parentOf(last))?.find((c) => c.rel === last) ?? e) : e;
				const expanded = e.is_dir && this.expanded.has(last);
				out.push({ ...entry, name: chain.length > 1 ? compactLabel(chain) : e.name, depth, expanded, chain: chain.length > 1 ? chain : undefined });
				if (expanded) walk(last, depth + 1);
			}
		};
		walk('', 0);
		return out;
	}

	/** explorer.autoReveal: expands the folders above `rel` and selects it. */
	async reveal(rel: string) {
		const parts = rel.split('/');
		for (let i = 0; i < parts.length; i++) await this.expand(parts.slice(0, i).join('/'));
		this.select(rel);
	}

	/** Reveal in Explorer View: selects `rel` and moves keyboard focus to its row. */
	focusRow(rel: string) {
		this.select(rel);
		this.focusRequest = rel;
	}

	// --- Selection (VS Code's list multi-select: ⌘-click toggles, ⇧-click ranges) ----------------

	/** A plain click or arrow key: `rel` alone. */
	select(rel: string | null) {
		this.selected = rel;
		this.selection.clear();
		if (rel !== null) this.selection.add(rel);
		this.anchor = rel;
	}

	/** ⌘-click: adds or removes `rel`, keeping the rest. */
	toggleSelect(rel: string) {
		if (this.selection.has(rel)) {
			this.selection.delete(rel);
			if (this.selected === rel) this.selected = [...this.selection].at(-1) ?? null;
		} else {
			this.selection.add(rel);
			this.selected = rel;
		}
		this.anchor = rel;
	}

	/** ⇧-click / ⇧-arrow: the rows from the anchor to `rel`. */
	selectRange(rel: string) {
		const rows = this.rows().map((r) => r.rel);
		this.selection.clear();
		for (const r of rangeSelection(rows, this.anchor ?? this.selected, rel)) this.selection.add(r);
		this.selected = rel;
	}

	isSelected(rel: string) {
		return this.selection.has(rel);
	}

	/** What a command acts on: the selection when `rel` is part of it (or none is given), else just `rel`. */
	targets(rel: string | null = this.selected): string[] {
		if (rel === null) return [...this.selection];
		return this.selection.has(rel) ? topLevel([...this.selection]) : [rel];
	}

	// --- Clipboard and drag and drop (VS Code fileActions.ts paste, explorerViewer.ts drop) -------

	setClipboard(paths: string[], cut: boolean) {
		this.clipboard = paths.length ? { paths: topLevel(paths), cut } : null;
	}

	isCut(rel: string) {
		return !!this.clipboard?.cut && this.clipboard.paths.some((p) => isUnder(rel, p));
	}

	/** Paste into the folder of `target` (a folder itself, or a file's folder). */
	async paste(target: string | null = this.selected) {
		const clip = this.clipboard;
		if (!clip) return;
		const dir = dropTarget(target, target !== null && this.isDir(target));
		const done = await this.transfer(clip.paths, dir, !clip.cut, false);
		// A cut is used up by its paste (VS Code); a copy can be pasted again.
		if (clip.cut && done) this.clipboard = null;
	}

	/**
	 * Moves (or copies) `paths` into the folder `dir`. Moves ask first when explorer.confirmDragAndDrop
	 * is on (`confirm`), and a move onto an existing name asks to replace it. Returns false when cancelled.
	 */
	async transfer(paths: string[], dir: string, copy: boolean, confirm: boolean): Promise<boolean> {
		const { ops, refused } = planTransfer(paths, dir, copy);
		if (refused.length) notifications.warn(`ย้ายหรือคัดลอกโฟลเดอร์เข้าไปในตัวเองไม่ได้ (Cannot move or copy a folder into itself): ${refused.join(', ')}`);
		if (!ops.length) return true;
		if (!copy && editors.allTabs().some((t) => t.dirty && ops.some((o) => remapPath(t.path, o.from, o.to) !== null))) {
			notifications.warn('มีไฟล์ที่ยังไม่บันทึกอยู่ในรายการที่จะย้าย: บันทึกก่อนย้าย (Save the files before moving them.)');
			return false;
		}
		if (!copy && confirm && settings.get<boolean>('explorer.confirmDragAndDrop')) {
			const yes = 'ย้าย (Move)';
			const always = 'ย้าย ไม่ต้องถามอีก (Do Not Ask Again)';
			const r = await message(moveQuestion(ops.map((o) => o.from), dir, baseName(this.#rootName())), { title: 'Move', kind: 'warning', buttons: { yes, no: always, cancel: 'ยกเลิก (Cancel)' } });
			if (r === always || r === 'No') await settings.set('explorer.confirmDragAndDrop', false, 'user');
			else if (r !== yes && r !== 'Yes') return false;
		}
		const created: string[] = [];
		for (const op of ops) {
			try {
				if (copy) created.push(await invoke<string>('fs_copy', { from: op.from, toDir: dir }));
				else {
					const to = await this.#moveReplacing(op.from, dir, op.to);
					if (to === null) continue;
					created.push(to);
					this.#afterMove(op.from, to);
				}
			} catch (e) {
				notifications.error(String(e));
				break;
			}
		}
		if (dir) this.expanded.add(dir);
		await this.refresh([...ops.map((o) => o.from), ...created, dir]);
		for (const d of [...this.expanded]) if (!this.children.has(d)) await this.load(d);
		if (created.length) {
			this.selection.clear();
			for (const c of created) this.selection.add(c);
			this.selected = created[created.length - 1];
			this.anchor = this.selected;
		}
		return true;
	}

	/** Rust never overwrites: a clash asks "Replace?" (VS Code), then trashes the old one first. */
	async #moveReplacing(from: string, dir: string, to: string): Promise<string | null> {
		try {
			return await invoke<string>('fs_move', { from, toDir: dir });
		} catch (e) {
			if (!/already exists/.test(String(e))) throw e;
		}
		const replace = await ask(`มี '${baseName(to)}' อยู่ในโฟลเดอร์ปลายทางแล้ว แทนที่หรือไม่? (A file or folder with the name '${baseName(to)}' already exists in the destination folder. Do you want to replace it?)\n\nของเดิมจะถูกย้ายไปถังขยะ`, {
			title: 'Replace',
			kind: 'warning',
			okLabel: 'แทนที่ (Replace)',
			cancelLabel: 'ยกเลิก'
		});
		if (!replace) return null;
		if (editors.allTabs().some((t) => t.dirty && affectedBy([t.path], to).length)) throw new Error(`${to}: มีการแก้ไขที่ยังไม่บันทึก`);
		await invoke('fs_delete', { rel: to });
		for (const t of affectedBy([...editors.openPaths()], to)) editors.closeEverywhere(t);
		this.#forget(to);
		return invoke<string>('fs_move', { from, toDir: dir });
	}

	#afterMove(from: string, to: string) {
		const wasExpanded = [...this.expanded].filter((k) => isUnder(k, from));
		this.#forget(from);
		for (const k of wasExpanded) this.expanded.add(to + k.slice(from.length));
		this.#moveTabs(from, to);
	}

	/** Files dropped from Finder: copied into `dir` (Rust only accepts the paths of the last drop). */
	async importDropped(paths: string[], dir: string) {
		try {
			const created = await invoke<string[]>('fs_import', { paths, toDir: dir });
			if (dir) this.expanded.add(dir);
			await this.refresh([...created, dir]);
			if (dir && !this.children.has(dir)) await this.load(dir);
			this.selection.clear();
			for (const c of created) this.selection.add(c);
			this.selected = created.at(-1) ?? this.selected;
		} catch (e) {
			notifications.error(`คัดลอกไฟล์เข้ามาไม่สำเร็จ (Copy failed): ${e}`);
		}
	}

	#rootName = () => '';
	/** Set by the view: the workspace folder's display name, for the move question. */
	setRootName(fn: () => string) {
		this.#rootName = fn;
	}

	isDir(rel: string): boolean {
		return rel === '' || (this.children.get(parentOf(rel))?.find((e) => e.rel === rel)?.is_dir ?? false);
	}

	// --- File operations (VS Code fileActions.ts) ------------------------------------------------

	/** New File / New Folder: in the selected folder, or next to the selected file. */
	async startCreate(kind: 'file' | 'folder', target = this.selected) {
		const parent = target === null ? '' : this.isDir(target) ? target : parentOf(target);
		await this.expand(parent);
		this.editing = { kind, parent };
	}

	startRename(rel = this.selected) {
		if (!rel) return;
		this.select(rel);
		this.editing = { kind: 'rename', rel, is_dir: this.isDir(rel) };
	}

	/** Commits the inline input; returns an error to show under it, or null when done. */
	async commit(value: string): Promise<string | null> {
		const edit = this.editing;
		if (!edit) return null;
		const name = value.trim();
		if (edit.kind === 'rename' && name === baseName(edit.rel)) {
			this.editing = null;
			return null;
		}
		const invalid = validateName(name);
		if (invalid) return invalid;
		try {
			if (edit.kind === 'rename') await this.#rename(edit.rel, joinRel(parentOf(edit.rel), name));
			else await this.#create(edit.kind, joinRel(edit.parent, name));
		} catch (e) {
			return e instanceof Error ? e.message : String(e);
		}
		return null;
	}

	cancelEdit() {
		this.editing = null;
	}

	async #create(kind: 'file' | 'folder', rel: string) {
		await invoke(kind === 'file' ? 'fs_create_file' : 'fs_create_dir', { rel });
		this.editing = null;
		// Nested names (`a/b/c.ts`) create folders on the way: show the whole chain.
		const dirs = rel.split('/').slice(0, -1);
		for (let i = 0; i < dirs.length; i++) this.expanded.add(dirs.slice(0, i + 1).join('/'));
		await this.refresh([rel, ...dirs.map((_, i) => dirs.slice(0, i + 1).join('/'))]);
		for (const d of [...this.expanded]) if (!this.children.has(d)) await this.load(d);
		this.select(rel);
		if (kind === 'file') editors.open(rel, { preview: false });
	}

	async #rename(from: string, to: string) {
		if (editors.allTabs().some((t) => t.dirty && remapPath(t.path, from, to) !== null)) throw new Error('มีไฟล์ที่ยังไม่บันทึกอยู่ข้างใน: บันทึกก่อนเปลี่ยนชื่อ');
		await invoke('fs_rename', { from, to });
		this.editing = null;
		// Keep the folder's expansion state under its new name.
		const wasExpanded = [...this.expanded].filter((k) => isUnder(k, from));
		this.#forget(from);
		for (const k of wasExpanded) this.expanded.add(to + k.slice(from.length));
		await this.refresh([from, to]);
		for (const k of wasExpanded) await this.load(to + k.slice(from.length));
		this.select(to);
		this.#moveTabs(from, to);
	}

	/** Points the renamed path's tabs (in every group) at the new name; they are clean, so nothing is lost. */
	#moveTabs(from: string, to: string) {
		editors.remap((path) => remapPath(path, from, to));
	}

	/** Delete: confirm, move to the Trash, close its tabs. Acts on the whole selection when `rel` is in it. */
	async delete(rel = this.selected) {
		if (!rel) return;
		const targets = this.targets(rel);
		if (targets.length > 1) return this.#deleteMany(targets);
		const isDir = this.isDir(rel);
		const tabs = affectedBy([...editors.openPaths()], rel);
		const dirty = new Set(editors.allTabs().filter((t) => t.dirty && tabs.includes(t.path)).map((t) => t.path)).size;
		const what = isDir ? `โฟลเดอร์ '${baseName(rel)}' และทุกอย่างข้างใน` : `'${baseName(rel)}'`;
		// explorer.confirmDelete off skips the question, except when unsaved edits would be lost.
		const confirm = settings.get<boolean>('explorer.confirmDelete') || dirty > 0;
		const ok =
			!confirm ||
			(await ask(`ย้าย ${what} ไปที่ถังขยะ?${dirty ? `\n\nมี ${dirty} ไฟล์ที่ยังไม่บันทึก การแก้ไขจะหายไป` : ''}\n\nกู้คืนได้จากถังขยะ`, {
				title: 'Delete',
				kind: 'warning',
				okLabel: 'ย้ายไปถังขยะ',
				cancelLabel: 'ยกเลิก'
			}));
		if (!ok) return;
		try {
			await invoke('fs_delete', { rel });
		} catch (e) {
			notifications.error(String(e));
			return;
		}
		for (const t of tabs) editors.closeEverywhere(t);
		this.#forget(rel);
		if (this.selected && isUnder(this.selected, rel)) this.select(null);
		await this.refresh([rel]);
	}

	/** VS Code: "Are you sure you want to delete the following N files?" then each to the Trash. */
	async #deleteMany(targets: string[]) {
		const tabs = targets.flatMap((t) => affectedBy([...editors.openPaths()], t));
		const dirty = new Set(editors.allTabs().filter((t) => t.dirty && tabs.includes(t.path)).map((t) => t.path)).size;
		const confirm = settings.get<boolean>('explorer.confirmDelete') || dirty > 0;
		const list = targets.map((t) => (this.isDir(t) ? `${baseName(t)}/` : baseName(t))).join('\n');
		const ok =
			!confirm ||
			(await ask(`ย้าย ${targets.length} รายการต่อไปนี้ไปที่ถังขยะ? (Are you sure you want to delete the following ${targets.length} files?)\n\n${list}${dirty ? `\n\nมี ${dirty} ไฟล์ที่ยังไม่บันทึก การแก้ไขจะหายไป` : ''}\n\nกู้คืนได้จากถังขยะ`, {
				title: 'Delete',
				kind: 'warning',
				okLabel: 'ย้ายไปถังขยะ',
				cancelLabel: 'ยกเลิก'
			}));
		if (!ok) return;
		for (const rel of targets) {
			try {
				await invoke('fs_delete', { rel });
			} catch (e) {
				notifications.error(String(e));
				break;
			}
			for (const t of affectedBy([...editors.openPaths()], rel)) editors.closeEverywhere(t);
			this.#forget(rel);
		}
		this.select(null);
		await this.refresh(targets);
	}
}

export const explorer = new Explorer();
