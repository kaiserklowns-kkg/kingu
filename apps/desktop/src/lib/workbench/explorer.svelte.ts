import { invoke } from '@tauri-apps/api/core';
import { ask, cancelLabel, choose } from '#lib/workbench/messageBox.ts';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { clientLog } from '#lib/client-log.ts';
import { enabledGlobs, hiddenBySibling, isExcluded, siblingClauses, sortEntries, type LexicographicOrder, type SortOrder } from '#lib/settings/mappings.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { editors } from './editors.svelte';
import { affectedBy, baseName, dirsToRefresh, isUnder, joinRel, parentOf, remapPath, validateName } from './fileTree';
import { notifications } from './notifications.svelte';
import { compactChain, compactLabel, dropTarget, moveQuestion, planTransfer, rangeSelection, topLevel } from './explorerModel';
import { nestFiles } from './fileNesting';
import { t } from '#lib/i18n/index.ts';
import { isRustError } from '#lib/i18n/rustErrors.ts';

/** macOS file systems ignore case, so file nesting does too (VS Code's PathCaseSensitive check). */
const CASE_SENSITIVE_FS = !(typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac'));

/** `ignored`: matched by `.gitignore` (drawn dimmed). `modified`: ms since the epoch. */
export type DirEntry = { name: string; rel: string; is_dir: boolean; ignored?: boolean; modified?: number };
/**
 * `chain`: the folders a compacted row stands for (explorer.compactFolders), outermost first.
 * `nests`: how many files are nested under this file (explorer.fileNesting); `expanded` is then
 * whether they show.
 */
export type Row = DirEntry & { depth: number; expanded: boolean; chain?: string[]; nests?: number };
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
	/** Nested files' parents whose expansion differs from explorer.fileNesting.expand. */
	nestToggled = new SvelteSet<string>();

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
		this.nestToggled.clear();
		if (settings.get<boolean>('explorer.fileNesting.expand')) for (const parent of this.#nestParents()) this.nestToggled.add(parent);
	}

	// --- File nesting (explorer.fileNesting.*) ---------------------------------------------------

	/** The nests of a loaded folder: a parent file's rel → the entries nested under it. */
	nestsOf(rel: string): Map<string, DirEntry[]> {
		const out = new Map<string, DirEntry[]>();
		if (!settings.get<boolean>('explorer.fileNesting.enabled')) return out;
		const files = this.#shownEntries(rel).filter((e) => !e.is_dir);
		const byName = new Map(files.map((e) => [e.name, e]));
		const nested = nestFiles(
			files.map((e) => e.name),
			baseName(rel),
			settings.get<Record<string, unknown>>('explorer.fileNesting.patterns'),
			CASE_SENSITIVE_FS
		);
		for (const [parent, children] of nested) out.set(byName.get(parent)!.rel, children.map((n) => byName.get(n)!));
		return out;
	}

	isNestExpanded(rel: string): boolean {
		return settings.get<boolean>('explorer.fileNesting.expand') !== this.nestToggled.has(rel);
	}

	toggleNest(rel: string, open = !this.isNestExpanded(rel)) {
		if (open === this.isNestExpanded(rel)) return;
		if (this.nestToggled.has(rel)) this.nestToggled.delete(rel);
		else this.nestToggled.add(rel);
	}

	*#nestParents() {
		for (const dir of this.children.keys()) yield* this.nestsOf(dir).keys();
	}

	/** explorer.sortOrder, explorer.sortOrderLexicographicOptions and explorer.sortOrderReverse. */
	#sort<T extends DirEntry & { hasNests?: boolean }>(entries: T[]): T[] {
		return sortEntries(
			entries,
			settings.get<SortOrder>('explorer.sortOrder'),
			settings.get<LexicographicOrder>('explorer.sortOrderLexicographicOptions'),
			settings.get<boolean>('explorer.sortOrderReverse')
		);
	}

	#forget(rel: string) {
		for (const k of [...this.children.keys()]) if (k && isUnder(k, rel)) this.children.delete(k);
		for (const k of [...this.expanded]) if (isUnder(k, rel)) this.expanded.delete(k);
	}

	/** A folder's entries that files.exclude and explorer.excludeGitIgnore leave. */
	#shownEntries(rel: string): DirEntry[] {
		const exclude = enabledGlobs(settings.get('files.exclude'));
		const gitIgnored = settings.get<boolean>('explorer.excludeGitIgnore');
		const entries = this.children.get(rel) ?? [];
		// files.exclude sibling clauses (`"**/*.js": { "when": "$(basename).ts" }`) look at this folder.
		const clauses = siblingClauses(settings.get('files.exclude'));
		const here = new Set(entries.map((e) => e.rel));
		return entries.filter((e) => !(gitIgnored && e.ignored) && !isExcluded(e.rel, exclude) && !hiddenBySibling(e.rel, clauses, (p) => here.has(p)));
	}

	/** A folder's entries as shown, sorted; files nested under another file (explorer.fileNesting) are left out. */
	visibleChildren(rel: string): (DirEntry & { hasNests?: boolean })[] {
		const nests = this.nestsOf(rel);
		const nested = new Set([...nests.values()].flat().map((e) => e.rel));
		return this.#sort(this.#shownEntries(rel).filter((e) => !nested.has(e.rel)).map((e) => (nests.has(e.rel) ? { ...e, hasNests: true } : e)));
	}

	/** Visible rows in display order, like VS Code's flattened tree. With explorer.compactFolders an
	 * expanded chain of single-folder folders is one row (`a/b/c`) standing for its last folder. */
	rows(): Row[] {
		const out: Row[] = [];
		const compact = settings.get<boolean>('explorer.compactFolders');
		const loaded = (rel: string) => (this.expanded.has(rel) && this.children.has(rel) ? this.visibleChildren(rel) : null);
		const walk = (rel: string, depth: number) => {
			const nests = this.nestsOf(rel);
			for (const e of this.visibleChildren(rel)) {
				const nestedFiles = nests.get(e.rel);
				if (nestedFiles) {
					const open = this.isNestExpanded(e.rel);
					out.push({ ...e, depth, expanded: open, nests: nestedFiles.length });
					if (open) for (const child of this.#sort(nestedFiles)) out.push({ ...child, depth: depth + 1, expanded: false });
					continue;
				}
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
		// A file nested under another one (explorer.fileNesting): open its nest.
		for (const [parent, nested] of this.nestsOf(parentOf(rel))) if (nested.some((e) => e.rel === rel)) this.toggleNest(parent, true);
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
		if (refused.length) notifications.warn(t('workbench.explorer.intoItself', { paths: refused.join(', ') }));
		if (!ops.length) return true;
		if (!copy && editors.allTabs().some((t) => t.dirty && ops.some((o) => remapPath(t.path, o.from, o.to) !== null))) {
			notifications.warn(t('workbench.explorer.saveBeforeMove'));
			return false;
		}
		if (!copy && confirm && settings.get<boolean>('explorer.confirmDragAndDrop')) {
			const yes = t('workbench.explorer.move');
			const always = t('workbench.explorer.moveDontAsk');
			const r = await choose(moveQuestion(ops.map((o) => o.from), dir, baseName(this.#rootName())), { title: t('workbench.explorer.move'), kind: 'warning', buttons: [yes, always, cancelLabel()], cancelId: 2 });
			if (r === always) await settings.set('explorer.confirmDragAndDrop', false, 'user');
			else if (r !== yes) return false;
		}
		const created: string[] = [];
		for (const op of ops) {
			try {
				if (copy) {
					const to = await this.#copyReplacing(op.from, dir, op.to);
					if (to === null) continue;
					created.push(to);
				}
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

	/**
	 * Copy (paste, ⌥-drag): a clash gets a new name by explorer.incrementalNaming; with naming
	 * `disabled` it asks "Replace?" like a move, then copies over the old one.
	 */
	async #copyReplacing(from: string, dir: string, to: string): Promise<string | null> {
		const naming = settings.get<string>('explorer.incrementalNaming');
		try {
			return await invoke<string>('fs_copy', { from, toDir: dir, naming });
		} catch (e) {
			if (!isRustError(e, 'fileExists')) throw e;
		}
		if (from === to) throw new Error(t('workbench.explorer.exists', { name: baseName(from) }));
		if (!(await this.#replaceExisting(to))) return null;
		return invoke<string>('fs_copy', { from, toDir: dir, naming });
	}

	/** Rust never overwrites: a clash asks "Replace?" (VS Code), then deletes the old one first. */
	async #moveReplacing(from: string, dir: string, to: string): Promise<string | null> {
		let moved: string;
		try {
			moved = await invoke<string>('fs_move', { from, toDir: dir });
		} catch (e) {
			if (!isRustError(e, 'fileExists')) throw e;
			if (!(await this.#replaceExisting(to))) return null;
			moved = await invoke<string>('fs_move', { from, toDir: dir });
		}
		moveLocalHistory(from, moved);
		return moved;
	}

	/** Asks to replace `to`, then deletes it (files.enableTrash) and closes its tabs. */
	async #replaceExisting(to: string): Promise<boolean> {
		const replace = await ask(
			`${t('workbench.explorer.replaceQuestion', { name: baseName(to) })}\n\n${this.#useTrash() ? t('workbench.explorer.replaceTrash') : t('workbench.explorer.replacePermanent')}`,
			{ title: t('workbench.explorer.replace'), kind: 'warning', okLabel: t('workbench.explorer.replace'), cancelLabel: t('common.cancel') }
		);
		if (!replace) return false;
		if (editors.allTabs().some((t) => t.dirty && affectedBy([t.path], to).length)) throw new Error(t('workbench.explorer.targetDirty', { path: to }));
		await invoke('fs_delete', { rel: to, useTrash: this.#useTrash() });
		for (const t of affectedBy([...editors.openPaths()], to)) editors.closeEverywhere(t);
		this.#forget(to);
		return true;
	}

	/** files.enableTrash: deletes go to the Trash, or are permanent. */
	#useTrash = () => settings.get<boolean>('files.enableTrash');

	#afterMove(from: string, to: string) {
		const wasExpanded = [...this.expanded].filter((k) => isUnder(k, from));
		this.#forget(from);
		for (const k of wasExpanded) this.expanded.add(to + k.slice(from.length));
		this.#moveTabs(from, to);
	}

	/** Files dropped from Finder: copied into `dir` (Rust only accepts the paths of the last drop). */
	async importDropped(paths: string[], dir: string) {
		try {
			const created = await invoke<string[]>('fs_import', { paths, toDir: dir, naming: settings.get<string>('explorer.incrementalNaming') });
			if (dir) this.expanded.add(dir);
			await this.refresh([...created, dir]);
			if (dir && !this.children.has(dir)) await this.load(dir);
			this.selection.clear();
			for (const c of created) this.selection.add(c);
			this.selected = created.at(-1) ?? this.selected;
			// explorer.autoOpenDroppedFile: one dropped file opens in the editor.
			if (created.length === 1 && !this.isDir(created[0]) && settings.get<boolean>('explorer.autoOpenDroppedFile')) editors.open(created[0], { preview: true });
		} catch (e) {
			notifications.error(t('workbench.explorer.copyFailed', { error: String(e) }));
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
		if (editors.allTabs().some((t) => t.dirty && remapPath(t.path, from, to) !== null)) throw new Error(t('workbench.explorer.saveBeforeRename'));
		await invoke('fs_rename', { from, to });
		moveLocalHistory(from, to);
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

	/** Delete: confirm, move to the Trash (or delete for good: files.enableTrash), close its tabs. Acts on the whole selection when `rel` is in it. */
	async delete(rel = this.selected) {
		if (!rel) return;
		const targets = this.targets(rel);
		if (targets.length > 1) return this.#deleteMany(targets);
		const isDir = this.isDir(rel);
		const tabs = affectedBy([...editors.openPaths()], rel);
		const dirty = new Set(editors.allTabs().filter((t) => t.dirty && tabs.includes(t.path)).map((t) => t.path)).size;
		const name = baseName(rel);
		// explorer.confirmDelete off skips the question, except when unsaved edits would be lost or
		// the delete is permanent (files.enableTrash off), like VS Code.
		const useTrash = this.#useTrash();
		const confirm = settings.get<boolean>('explorer.confirmDelete') || dirty > 0 || !useTrash;
		const unsaved = dirty ? `\n\n${t('workbench.explorer.unsavedLost', { count: dirty })}` : '';
		const ok =
			!confirm ||
			(await ask(
				useTrash
					? `${isDir ? t('workbench.explorer.trashFolder', { name }) : t('workbench.explorer.trashFile', { name })}${unsaved}\n\n${t('workbench.explorer.restoreFromTrash')}`
					: `${isDir ? t('workbench.explorer.deleteFolder', { name }) : t('workbench.explorer.deleteFile', { name })}${unsaved}\n\n${t('workbench.explorer.irreversible')}`,
				{ title: t('common.delete'), kind: 'warning', okLabel: useTrash ? t('workbench.explorer.moveToTrash') : t('common.delete'), cancelLabel: t('common.cancel') }
			));
		if (!ok) return;
		try {
			await invoke('fs_delete', { rel, useTrash });
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
		const useTrash = this.#useTrash();
		const confirm = settings.get<boolean>('explorer.confirmDelete') || dirty > 0 || !useTrash;
		const list = targets.map((t) => (this.isDir(t) ? `${baseName(t)}/` : baseName(t))).join('\n');
		const unsaved = dirty ? `\n\n${t('workbench.explorer.unsavedLost', { count: dirty })}` : '';
		const ok =
			!confirm ||
			(await ask(
				useTrash
					? `${t('workbench.explorer.trashMany', { count: targets.length })}\n\n${list}${unsaved}\n\n${t('workbench.explorer.restoreFromTrash')}`
					: `${t('workbench.explorer.deleteMany', { count: targets.length })}\n\n${list}${unsaved}\n\n${t('workbench.explorer.irreversible')}`,
				{ title: t('common.delete'), kind: 'warning', okLabel: useTrash ? t('workbench.explorer.moveToTrash') : t('common.delete'), cancelLabel: t('common.cancel') }
			));
		if (!ok) return;
		for (const rel of targets) {
			try {
				await invoke('fs_delete', { rel, useTrash });
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

/** A file's local history follows a rename or move (VS Code's tracker moves the entries); for a folder, every file's under it. */
function moveLocalHistory(from: string, to: string) {
	invoke('local_history_move', { from, to }).catch((e) => clientLog('info', `local history move ${from}: ${e}`));
}
