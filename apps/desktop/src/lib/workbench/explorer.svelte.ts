import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { clientLog } from '#lib/client-log.ts';
import { enabledGlobs, isExcluded, sortEntries, type SortOrder } from '#lib/settings/mappings.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { editors } from './editors.svelte';
import { affectedBy, baseName, dirsToRefresh, isUnder, joinRel, parentOf, remapPath, validateName } from './fileTree';
import { status } from './status.svelte';

/** `ignored`: matched by `.gitignore` (drawn dimmed). */
export type DirEntry = { name: string; rel: string; is_dir: boolean; ignored?: boolean };
export type Row = DirEntry & { depth: number; expanded: boolean };
/** The inline input row (VS Code's explorer edit box): a new entry in `parent`, or a rename of `rel`. */
export type Editing = { kind: 'file' | 'folder'; parent: string } | { kind: 'rename'; rel: string; is_dir: boolean };

// Lazily loaded tree: a directory's children are fetched the first time it is expanded.
class Explorer {
	children = new SvelteMap<string, DirEntry[]>();
	expanded = new SvelteSet<string>();
	error = $state('');
	selected = $state<string | null>(null);
	editing = $state<Editing | null>(null);

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
	}

	/** Open Folder / Close Folder: drop the whole tree. */
	reset() {
		this.children.clear();
		this.expanded.clear();
		this.error = '';
		this.selected = null;
		this.editing = null;
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

	/** Visible rows in display order, like VS Code's flattened tree. */
	rows(): Row[] {
		const out: Row[] = [];
		const walk = (rel: string, depth: number) => {
			for (const e of this.visibleChildren(rel)) {
				const expanded = e.is_dir && this.expanded.has(e.rel);
				out.push({ ...e, depth, expanded });
				if (expanded) walk(e.rel, depth + 1);
			}
		};
		walk('', 0);
		return out;
	}

	/** explorer.autoReveal: expands the folders above `rel` and selects it. */
	async reveal(rel: string) {
		const parts = rel.split('/');
		for (let i = 0; i < parts.length; i++) await this.expand(parts.slice(0, i).join('/'));
		this.selected = rel;
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
		this.selected = rel;
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
		this.selected = rel;
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
		this.selected = to;
		this.#moveTabs(from, to);
	}

	/** Points the renamed path's tabs (in every group) at the new name; they are clean, so nothing is lost. */
	#moveTabs(from: string, to: string) {
		editors.remap((path) => remapPath(path, from, to));
	}

	/** Delete: confirm, move to the Trash, close its tabs. */
	async delete(rel = this.selected) {
		if (!rel) return;
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
			status.flash(String(e), 8000);
			return;
		}
		for (const t of tabs) editors.closeEverywhere(t);
		this.#forget(rel);
		if (this.selected && isUnder(this.selected, rel)) this.selected = null;
		await this.refresh([rel]);
	}
}

export const explorer = new Explorer();
