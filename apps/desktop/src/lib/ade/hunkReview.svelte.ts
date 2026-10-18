// Per-hunk review of task diffs (`taskdiff://` tabs, in the IDE or the Agents layout): the hunks
// Rust reads for the shown file, accept / reject of the hunk at the cursor, and keyboard steps
// between hunks and changed files (VS Code's chat editing review keys, hunkReview.ts). The diff
// views (DiffHost) attach themselves so the commands can move their cursor and draw the hunk
// toolbars.

import { invoke } from '@tauri-apps/api/core';
import { clientLog } from '#lib/client-log.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { isTaskDiffKey, parseTaskDiffKey, taskDiffKey } from '#lib/workbench/scm.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
import { adeLayout } from './adeLayout.svelte';
import { adeTasks } from './tasks.svelte';
import { acceptHunk, afterRemoval, HUNK_SHORTCUTS as K, hunkAt, isHunkAccepted, openHunks, stepFile, stepFrom, toggleHunk, type FileHunks, type Hunk } from './hunkReview.ts';
import { t } from '#lib/i18n/index.ts';

/** A diff view showing (maybe) a task diff. */
export type HunkView = {
	/** The diff key whose models the view shows. */
	key(): string | null;
	/** Puts the cursor on the hunk and scrolls to it. */
	reveal(h: Hunk): void;
	/** The cursor line of the modified side, null before the user placed it. */
	cursorLine(): number | null;
	/** Focus is inside the view. */
	focused(): boolean;
	/** The hunks or their marks changed: redraw the toolbars. */
	refresh(): void;
};

type Landing = 'first' | 'last' | number;

/** The task diff the window shows in front: the Agents layout's active tab, else the active editor. */
export function activeTaskDiff(): string | null {
	if (systemSettings.visible) return null;
	const key = appMode.isAgents ? adeLayout.activeFile() : editors.active;
	return key && isTaskDiffKey(key) ? key : null;
}

class HunkReview {
	/** Hunks of the shown task diffs, by diff key. */
	files = $state<Record<string, FileHunks>>({});
	#views = new Set<HunkView>();
	/** Where to put the cursor once a diff's hunks are read (after opening it or rejecting a hunk). */
	#landing: Record<string, Landing> = {};
	#seq: Record<string, number> = {};

	attach(view: HunkView): () => void {
		this.#views.add(view);
		return () => this.#views.delete(view);
	}

	#view(key: string): HunkView | undefined {
		for (const v of this.#views) if (v.key() === key) return v;
	}

	/** Focus is inside a view showing `key`. */
	focusedOn(key: string): boolean {
		return [...this.#views].some((v) => v.key() === key && v.focused());
	}

	meta(key: string) {
		const k = parseTaskDiffKey(key);
		return k ? adeTasks.list.find((t) => t.slug === k.slug) : undefined;
	}

	accepted(key: string, id: string): boolean {
		const k = parseTaskDiffKey(key);
		const meta = this.meta(key);
		return !!k && !!meta && isHunkAccepted(meta, k.rel, id);
	}

	/** Reads the hunks of a task diff (the view calls it whenever it shows the file again). */
	async load(key: string): Promise<FileHunks | undefined> {
		const k = parseTaskDiffKey(key);
		const meta = this.meta(key);
		if (!k || !meta) return;
		const my = (this.#seq[key] = (this.#seq[key] ?? 0) + 1);
		const base = adeTasks.stats[k.slug]?.base ?? meta.base;
		let fh: FileHunks;
		try {
			fh = await invoke<FileHunks>('worktree_hunks', { slug: k.slug, base, path: k.rel });
		} catch (e) {
			clientLog('info', `hunks ${key}: ${e}`);
			return;
		}
		if (my !== this.#seq[key]) return;
		this.files[key] = fh;
		void adeTasks.pruneHunkMarks(k.slug, k.rel, fh.hunks.map((h) => h.id));
		const land = this.#landing[key];
		const view = this.#view(key);
		view?.refresh();
		if (land !== undefined && view && fh.hunks.length) {
			delete this.#landing[key];
			const i = land === 'first' ? 0 : land === 'last' ? fh.hunks.length - 1 : afterRemoval(land, fh.hunks.length);
			view.reveal(fh.hunks[i]);
		}
		return fh;
	}

	/** The hunk at the cursor of the active task diff (else the first one below it). */
	#current(): { key: string; fh: FileHunks; i: number } | null {
		const key = activeTaskDiff();
		const fh = key ? this.files[key] : undefined;
		if (!key || !fh?.hunks.length) return null;
		const line = this.#view(key)?.cursorLine() ?? null;
		return { key, fh, i: line === null ? 0 : hunkAt(fh.hunks, line) };
	}

	/** Shows the diff of another changed file of the task, landing on its first or last hunk. */
	openFile(slug: string, rel: string, land: Landing) {
		const key = taskDiffKey(slug, rel);
		this.#landing[key] = land;
		if (appMode.isAgents) adeLayout.openFile(slug, key);
		else editors.open(key, { preview: true });
		// Already shown: the view will not read it again by itself.
		if (this.#view(key)) void this.load(key);
	}

	/** Steps to the next / previous changed file of the active task diff; false when there is none. */
	stepFile(dir: 1 | -1, land: Landing = dir === 1 ? 'first' : 'last'): boolean {
		const key = activeTaskDiff();
		const k = key ? parseTaskDiffKey(key) : null;
		const files = k ? adeTasks.stats[k.slug]?.files : undefined;
		if (!k || !files) return false;
		const next = stepFile(files, k.rel, dir);
		if (!next) {
			status.flash(t('ade.hunks.noOtherFiles'));
			return false;
		}
		this.openFile(k.slug, next, land);
		return true;
	}

	/** Next / previous hunk; past the last (first) one, the next (previous) file. */
	step(dir: 1 | -1) {
		const key = activeTaskDiff();
		if (!key) return;
		const fh = this.files[key];
		const view = this.#view(key);
		const i = fh ? stepFrom(fh.hunks, view?.cursorLine() ?? null, dir) : null;
		if (fh && view && i !== null) view.reveal(fh.hunks[i]);
		else this.stepFile(dir);
	}

	/** After a hunk is done: the next open hunk of the file, else the next file. */
	#advance(key: string, fh: FileHunks, from: number) {
		const view = this.#view(key);
		const next = fh.hunks.findIndex((h, j) => j > from && !this.accepted(key, h.id));
		if (next >= 0 && view) view.reveal(fh.hunks[next]);
		else this.stepFile(1);
	}

	/** Accepts the hunk `i` (the one at the cursor by default) and moves on (Keep this Change). */
	accept(key?: string, i?: number) {
		const at = key !== undefined && i !== undefined ? { key, fh: this.files[key], i } : this.#current();
		const k = at ? parseTaskDiffKey(at.key) : null;
		const meta = at ? this.meta(at.key) : undefined;
		if (!at?.fh || !k || !meta) return;
		const h = at.fh.hunks[at.i];
		if (!h) return;
		const marks = acceptHunk(meta, k.rel, h.id, at.fh.hunks.map((x) => x.id));
		if (marks) void adeTasks.setReviewMarks(k.slug, marks).then(() => this.#view(at.key)?.refresh());
		this.#advance(at.key, at.fh, at.i);
	}

	/** Toggles the accepted mark of hunk `i` (a click on its toolbar). */
	toggle(key: string, i: number) {
		const fh = this.files[key];
		const k = parseTaskDiffKey(key);
		const meta = this.meta(key);
		const h = fh?.hunks[i];
		if (!fh || !k || !meta || !h) return;
		void adeTasks.setReviewMarks(k.slug, toggleHunk(meta, k.rel, h.id, fh.hunks.map((x) => x.id))).then(() => this.#view(key)?.refresh());
	}

	/** Takes back hunk `i` (at the cursor by default): a whole new or deleted file asks first. */
	async reject(key?: string, i?: number) {
		const at = key !== undefined && i !== undefined ? { key, fh: this.files[key], i } : this.#current();
		const k = at ? parseTaskDiffKey(at.key) : null;
		if (!at?.fh || !k) return;
		const h = at.fh.hunks[at.i];
		if (!h) return;
		if (at.fh.whole_file) {
			if (await this.#rejectFile(k.slug, k.rel)) this.stepFile(1);
			return;
		}
		this.#landing[at.key] = at.i;
		if (await adeTasks.rejectHunks(k.slug, k.rel, [h.id])) {
			status.flash(t('ade.hunks.rejected'));
			const fh = await this.load(at.key);
			if (fh && !fh.hunks.length) {
				delete this.#landing[at.key];
				this.stepFile(1);
			}
		} else delete this.#landing[at.key];
	}

	#rejectFile(slug: string, rel: string): Promise<boolean> {
		const f = adeTasks.stats[slug]?.files.find((x) => x.path === rel);
		const paths = f?.orig_path ? [rel, f.orig_path] : [rel];
		return adeTasks.reject(slug, paths, rel);
	}

	/** Accept File: every hunk of the active diff, then the next file. */
	acceptFile() {
		const key = activeTaskDiff();
		const k = key ? parseTaskDiffKey(key) : null;
		const meta = key ? this.meta(key) : undefined;
		if (!k || !meta) return;
		if (!meta.accepted.includes(k.rel)) {
			const marks = { ...(meta.accepted_hunks ?? {}) };
			delete marks[k.rel];
			void adeTasks.setReviewMarks(k.slug, { accepted: [...meta.accepted, k.rel].sort(), accepted_hunks: marks }).then(() => this.#view(key!)?.refresh());
		}
		this.stepFile(1);
	}

	/** Reject File: the active diff's file back to the base (asks first), then the next file. */
	async rejectFile() {
		const key = activeTaskDiff();
		const k = key ? parseTaskDiffKey(key) : null;
		if (!k) return;
		const files = adeTasks.stats[k.slug]?.files ?? [];
		const next = stepFile(files, k.rel, 1);
		if ((await this.#rejectFile(k.slug, k.rel)) && next) this.openFile(k.slug, next, 'first');
	}

	/**
	 * The review's "reject what is not accepted": unaccepted files go back to the base, and files
	 * with some accepted hunks lose only their other hunks. One confirmation for all of it.
	 */
	async rejectUnaccepted(slug: string) {
		const meta = adeTasks.list.find((t) => t.slug === slug);
		const stat = adeTasks.stats[slug];
		if (!meta || !stat) return;
		const open = stat.files.filter((f) => !meta.accepted.includes(f.path));
		const partial = open.filter((f) => (meta.accepted_hunks?.[f.path]?.length ?? 0) > 0);
		const full = open.filter((f) => !partial.includes(f));
		const label = partial.length ? t('ade.hunks.rejectFilesAndParts', { count: full.length, partial: partial.length }) : t('ade.hunks.rejectFiles', { count: full.length });
		const paths = full.flatMap((f) => (f.orig_path ? [f.path, f.orig_path] : [f.path]));
		if (!(await adeTasks.reject(slug, paths, label, partial.length > 0))) return;
		for (const f of partial) {
			const fh = await invoke<FileHunks>('worktree_hunks', { slug, base: stat.base, path: f.path }).catch((e) => {
				status.flash(t('ade.hunks.readFailed', { path: f.path, error: String(e) }));
				return null;
			});
			const now = adeTasks.list.find((t) => t.slug === slug) ?? meta;
			const ids = fh && !fh.whole_file ? openHunks(now, fh) : [];
			if (ids.length) await adeTasks.rejectHunks(slug, f.path, ids);
		}
	}
}

export const hunkReview = new HunkReview();

/** Focus is in a text field outside the diff editors (the commit box, a terminal…): keys stay there. */
function typingElsewhere(): boolean {
	const el = document.activeElement;
	if (!(el instanceof HTMLElement) || el.closest('.monaco-diff-editor')) return false;
	return el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.closest('.xterm') !== null;
}

/** The review commands (palette, keybindings.json). They act on the task diff in front. */
export function installHunkCommands(): () => void {
	const on = () => activeTaskDiff() !== null;
	const inView = () => {
		const key = activeTaskDiff();
		return !!key && hunkReview.focusedOn(key);
	};
	// Over New File (⌘N) and the like while a task diff is in front, as VS Code's chat edits do.
	const cmd = (s: { id: string; title: string; key: string }, run: () => unknown, keyWhen: () => boolean = () => !typingElsewhere()) =>
		commands.register({ ...s, category: 'Review', when: on, keyWhen, weight: 100, run });
	const unregister = [
		cmd(K.nextHunk, () => hunkReview.step(1)),
		cmd(K.previousHunk, () => hunkReview.step(-1)),
		cmd(K.acceptHunk, () => hunkReview.accept()),
		// Destructive keys only from inside the diff.
		cmd(K.rejectHunk, () => hunkReview.reject(), inView),
		cmd(K.acceptFile, () => hunkReview.acceptFile()),
		cmd(K.rejectFile, () => hunkReview.rejectFile(), inView),
		cmd(K.nextFile, () => hunkReview.stepFile(1)),
		cmd(K.previousFile, () => hunkReview.stepFile(-1))
	];
	return () => unregister.forEach((u) => u());
}
