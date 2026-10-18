// Per-hunk review of a task diff (VS Code's chat editing Keep / Undo per change): pure helpers for
// the hunks Rust reads (`agent/hunks.rs`), the accepted marks in tasks.json and keyboard
// navigation between hunks and files. No runes, no Tauri.

import type { FileChange, TaskMeta } from './model';

/** Mirrors Rust `agent::hunks::Hunk`. Lines are 1-based; a count of 0 is an insertion (old) or a
 * deletion (new) placed after line `start`. */
export type Hunk = { id: string; old_start: number; old_lines: number; new_start: number; new_lines: number };

/** Mirrors Rust `agent::hunks::FileHunks`. */
export type FileHunks = { path: string; whole_file: boolean; binary: boolean; hunks: Hunk[] };

export type AcceptedHunks = Record<string, string[]>;

/** Keys of the hunk review commands (VS Code's chatEditor.action.* defaults). */
export const HUNK_SHORTCUTS = {
	nextHunk: { id: 'kingu.review.nextHunk', title: 'Go to Next Change', key: 'alt+f5' },
	previousHunk: { id: 'kingu.review.previousHunk', title: 'Go to Previous Change', key: 'shift+alt+f5' },
	acceptHunk: { id: 'kingu.review.acceptHunk', title: 'Accept this Change', key: 'cmd+y' },
	rejectHunk: { id: 'kingu.review.rejectHunk', title: 'Reject this Change', key: 'cmd+n' },
	acceptFile: { id: 'kingu.review.acceptFile', title: 'Accept File', key: 'cmd+shift+y' },
	rejectFile: { id: 'kingu.review.rejectFile', title: 'Reject File', key: 'cmd+shift+n' },
	nextFile: { id: 'kingu.review.nextFile', title: 'Go to Next Changed File', key: 'alt+f6' },
	previousFile: { id: 'kingu.review.previousFile', title: 'Go to Previous Changed File', key: 'shift+alt+f6' }
} as const;

export function isHunkAccepted(meta: Pick<TaskMeta, 'accepted' | 'accepted_hunks'>, path: string, id: string): boolean {
	return meta.accepted.includes(path) || (meta.accepted_hunks?.[path]?.includes(id) ?? false);
}

/**
 * Accepts or un-accepts one hunk of `path`. Accepting the last open hunk accepts the file (its
 * hunk marks are then covered by the file mark); un-accepting a hunk of an accepted file keeps
 * the file's other hunks accepted.
 */
export function toggleHunk(meta: Pick<TaskMeta, 'accepted' | 'accepted_hunks'>, path: string, id: string, all: string[]): Pick<TaskMeta, 'accepted' | 'accepted_hunks'> {
	const marks: AcceptedHunks = { ...(meta.accepted_hunks ?? {}) };
	const fileOk = meta.accepted.includes(path);
	let ids = fileOk ? [...all] : [...(marks[path] ?? [])];
	ids = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
	const done = all.length > 0 && all.every((x) => ids.includes(x));
	if (done || !ids.length) delete marks[path];
	else marks[path] = ids.filter((x) => all.includes(x)).sort();
	const others = meta.accepted.filter((p) => p !== path);
	return { accepted: done ? [...others, path].sort() : others, accepted_hunks: marks };
}

/** Accepts hunk `id` of `path`; null when it already is. */
export function acceptHunk(meta: Pick<TaskMeta, 'accepted' | 'accepted_hunks'>, path: string, id: string, all: string[]) {
	return isHunkAccepted(meta, path, id) ? null : toggleHunk(meta, path, id, all);
}

/** Drops hunk marks of files that are no longer changed and, for `path`, ids no longer in it. */
export function pruneAcceptedHunks(marks: AcceptedHunks | undefined, files: FileChange[], path?: string, live?: string[]): AcceptedHunks {
	const changed = new Set(files.map((f) => f.path));
	const out: AcceptedHunks = {};
	for (const [p, ids] of Object.entries(marks ?? {})) {
		if (!changed.has(p)) continue;
		const kept = p === path && live ? ids.filter((id) => live.includes(id)) : ids;
		if (kept.length) out[p] = kept;
	}
	return out;
}

export const sameMarks = (a: AcceptedHunks | undefined, b: AcceptedHunks) => JSON.stringify(a ?? {}) === JSON.stringify(b);

/** Ids of the hunks of a file that are not accepted (what "reject unaccepted" takes back). */
export function openHunks(meta: Pick<TaskMeta, 'accepted' | 'accepted_hunks'>, fh: FileHunks): string[] {
	return fh.hunks.filter((h) => !isHunkAccepted(meta, fh.path, h.id)).map((h) => h.id);
}

/** The lines of the modified side a hunk covers, `[first, last]`; a deletion is the line it follows (at least 1). */
export function hunkLines(h: Hunk): [number, number] {
	if (h.new_lines === 0) {
		const at = Math.max(1, h.new_start);
		return [at, at];
	}
	return [h.new_start, h.new_start + h.new_lines - 1];
}

/** The hunk the cursor is in, else the first one below it, else the last; -1 without hunks. */
export function hunkAt(hunks: Hunk[], line: number): number {
	if (!hunks.length) return -1;
	const i = hunks.findIndex((h) => hunkLines(h)[1] >= line);
	return i < 0 ? hunks.length - 1 : i;
}

/**
 * The hunk `dir` steps to from the cursor on `line` (null: no cursor yet, start at an end), or
 * null past either end (the next file takes over): from inside a hunk to its neighbour, else to
 * the first hunk below (or the last above) the cursor.
 */
export function stepFrom(hunks: Hunk[], line: number | null, dir: 1 | -1): number | null {
	if (!hunks.length) return null;
	if (line === null) return dir === 1 ? 0 : hunks.length - 1;
	const inside = hunks.findIndex((h) => {
		const [a, b] = hunkLines(h);
		return line >= a && line <= b;
	});
	if (inside >= 0) {
		const next = inside + dir;
		return next < 0 || next >= hunks.length ? null : next;
	}
	if (dir === 1) {
		const i = hunks.findIndex((h) => hunkLines(h)[0] > line);
		return i < 0 ? null : i;
	}
	for (let i = hunks.length - 1; i >= 0; i--) if (hunkLines(hunks[i])[1] < line) return i;
	return null;
}

/** The changed file `dir` steps from `path` in the review list, wrapping; null when there is no other. */
export function stepFile(files: { path: string }[], path: string, dir: 1 | -1): string | null {
	if (!files.length) return null;
	const i = files.findIndex((f) => f.path === path);
	if (i < 0) return files[dir === 1 ? 0 : files.length - 1].path;
	if (files.length === 1) return null;
	return files[(i + dir + files.length) % files.length].path;
}

/** After rejecting hunk `i`, the hunk to land on among what is left (`count` of them). */
export const afterRemoval = (i: number, count: number) => (count ? Math.min(i, count - 1) : -1);
