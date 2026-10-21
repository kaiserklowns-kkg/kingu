// Per-change Keep / Undo of agent chat edits in the code editor (VS Code's
// ChatEditingCodeEditorIntegration and ChatEditorOverlayWidget): types mirroring Rust
// `agent::chat_edits::hunks` and pure helpers for the decorations, the overlay and the commands.
// No runes, no Tauri.

import { hunkLines } from '#lib/ade/hunkReview.ts';
import { workspacePath, type EditsView, type WorkingFile } from './chatEdits.ts';

/** Mirrors Rust `EditHunk`. Lines are 1-based; a count of 0 is an insertion (old) or a deletion
 * (new) placed after line `start` (git's -U0 numbering, as the task diff hunks). */
export type EditHunk = { id: string; old_start: number; old_lines: number; new_start: number; new_lines: number; removed: string[] };

/** Mirrors Rust `FileEditHunks`; `path` is relative to the chat's cwd. */
export type FileEditHunks = { path: string; whole_file: boolean; binary: boolean; hunks: EditHunk[] };

/** The VS Code ids, titles and default keys of the chat editing editor actions. */
export const CHAT_EDITOR_SHORTCUTS = {
	acceptHunk: { id: 'chatEditor.action.acceptHunk', title: 'Keep this Change', key: 'cmd+y' },
	undoHunk: { id: 'chatEditor.action.undoHunk', title: 'Undo this Change', key: 'cmd+n' },
	acceptFile: { id: 'chatEditor.action.accept', title: 'Keep Chat Edits in this File', key: 'cmd+shift+y' },
	undoFile: { id: 'chatEditor.action.reject', title: 'Undo Chat Edits in this File', key: 'cmd+shift+n' },
	next: { id: 'chatEditor.action.navigateNext', title: 'Go to Next Chat Edit', key: 'alt+f5' },
	previous: { id: 'chatEditor.action.navigatePrevious', title: 'Go to Previous Chat Edit', key: 'shift+alt+f5' },
	acceptAll: { id: 'chatEditor.action.acceptAllEdits', title: 'Keep All Chat Edits', key: 'cmd+alt+y' }
} as const;

/** A working-set file shown in an editor: its chat, its path in that chat and the view's row. */
export type EditTarget = { chatId: string; rel: string; prefix: string; file: WorkingFile };

/**
 * The chat whose working set has the editor file `path` (workspace-relative), with a saved copy
 * to diff against and still on disk; the most recent change wins when several chats have it.
 */
export function findTarget(views: Record<string, EditsView>, path: string): EditTarget | null {
	let best: EditTarget | null = null;
	for (const [chatId, v] of Object.entries(views)) {
		for (const file of v.files) {
			if (!file.restorable || file.deleted || workspacePath(v.prefix, file.path) !== path) continue;
			if (!best || file.request > best.file.request) best = { chatId, rel: file.path, prefix: v.prefix, file };
		}
	}
	return best;
}

/** What the loaded hunks of a target were read for: a new value means read them again. */
export function targetKey(t: EditTarget, generation: number): string {
	return `${t.chatId}|${t.rel}|${t.file.request}|${t.file.added}|${t.file.removed}|${generation}`;
}

/** The lines of the editor a hunk added or changed, `[first, last]`; null for a pure deletion. */
export function addedLines(h: EditHunk): [number, number] | null {
	return h.new_lines === 0 ? null : [h.new_start, h.new_start + h.new_lines - 1];
}

/** The line the deleted-lines zone of a hunk goes after (0: above the first line). */
export function zoneAfter(h: EditHunk): number {
	return h.new_lines === 0 ? h.new_start : h.new_start - 1;
}

/** The hunk whose lines hold the cursor on `line` (VS Code's ctxCursorInChangeRange), else -1. */
export function hunkAtCursor(hunks: readonly EditHunk[], line: number): number {
	return hunks.findIndex((h) => {
		const [a, b] = hunkLines(h);
		return line >= a && line <= b;
	});
}

/** The first line a hunk's toolbar and a reveal point at. */
export const firstLine = (h: EditHunk) => hunkLines(h)[0];

/** After Keep or Undo of hunk `i`, the one to reveal in the new list (the next one, else the last). */
export function afterResolve(i: number, remaining: number): number | null {
	return remaining ? Math.min(i, remaining - 1) : null;
}

/** The working-set file `dir` steps to from `rel` (restorable, still on disk), wrapping; null when there is no other. */
export function stepTargetFile(view: EditsView, rel: string, dir: 1 | -1): string | null {
	const files = view.files.filter((f) => f.restorable && !f.deleted);
	if (files.length < 2) return null;
	const i = files.findIndex((f) => f.path === rel);
	if (i < 0) return files[0].path;
	return files[(i + dir + files.length) % files.length].path;
}

/** `line` kept inside a model of `lineCount` lines (a dirty model may be shorter than the file on disk). */
export function clampLine(line: number, lineCount: number): number {
	return Math.max(1, Math.min(line, lineCount));
}
