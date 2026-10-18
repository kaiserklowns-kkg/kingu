// The agent chat's file edits (VS Code's chat editing session): types mirroring
// src-tauri/src/agent/chat_edits.rs and the pure working-set reducer the store and the bar use.
//
// Paths in a view are relative to the chat's cwd; `prefix` is that cwd relative to the open folder
// ('' or '.kingu/worktrees/<slug>'), so `workspacePath` gives the editor's path of a file.

import type { AgentEvent } from './events';

export type Skip = 'too_large' | 'budget' | 'outside' | 'symlink' | 'unreadable' | 'untracked' | 'dirty_before' | 'head_moved';

export type WorkingFile = {
	path: string;
	request: number;
	source: 'tool' | 'shell';
	restorable: boolean;
	reason: Skip | null;
	created: boolean;
	deleted: boolean;
	from_head: boolean;
	added: number | null;
	removed: number | null;
};

/** `paths`: the files the request changed (relative to the chat's cwd), reverted ones aside. */
export type RequestView = { index: number; at: number; reverted: boolean; head_moved: boolean; paths: string[] };

export type EditsView = { prefix: string; running: boolean; files: WorkingFile[]; requests: RequestView[] };

export type Report = { restored: string[]; deleted: string[]; skipped: [string, Skip][] };

export const emptyView = (): EditsView => ({ prefix: '', running: false, files: [], requests: [] });

/** The editor's (workspace-relative) path of a file of the view. */
export function workspacePath(prefix: string, rel: string): string {
	return prefix ? `${prefix.replace(/\/+$/, '')}/${rel}` : rel;
}

/** "N files changed" with the summed line counts (files without counts add nothing). */
export function summary(view: Pick<EditsView, 'files'>): { files: number; added: number; removed: number; restorable: number } {
	let added = 0;
	let removed = 0;
	for (const f of view.files) {
		added += f.added ?? 0;
		removed += f.removed ?? 0;
	}
	return { files: view.files.length, added, removed, restorable: view.files.filter((f) => f.restorable).length };
}

/** Keep (`paths`, all when null): those files leave the working set. */
export function applyKeep(view: EditsView, paths: readonly string[] | null): EditsView {
	return { ...view, files: view.files.filter((f) => paths !== null && !paths.includes(f.path)) };
}

/** Undo's result: what was put back or deleted leaves the working set; skipped files stay. */
export function applyUndo(view: EditsView, report: Report): EditsView {
	const gone = new Set([...report.restored, ...report.deleted]);
	return { ...view, files: view.files.filter((f) => !gone.has(f.path)) };
}

/** Restore checkpoint `index`: the requests from it on are reverted and their files leave the working set. */
export function applyRestore(view: EditsView, index: number): EditsView {
	return {
		...view,
		files: view.files.filter((f) => f.request < index),
		requests: view.requests.map((r) => (r.index >= index ? { ...r, reverted: true } : r))
	};
}

/** The files Undo of `paths` (all when null) would write, as editor paths. */
export function undoTargets(view: EditsView, paths: readonly string[] | null): string[] {
	return view.files.filter((f) => f.restorable && (paths === null || paths.includes(f.path))).map((f) => workspacePath(view.prefix, f.path));
}

/** Editor paths of the files Restore checkpoint `index` would put back (requests from it on, not yet reverted). */
export function restoreTargets(view: EditsView, index: number): string[] {
	const paths = new Set<string>();
	for (const r of view.requests) if (r.index >= index && !r.reverted) for (const p of r.paths) paths.add(workspacePath(view.prefix, p));
	return [...paths];
}

/** Those of `targets` with unsaved editor changes (Undo asks before writing over them). */
export function dirtyOf(targets: readonly string[], isDirty: (path: string) => boolean): string[] {
	return targets.filter(isDirty);
}

/** The request of each timeline item: from a `checkpoint` on, until the next one (`null` before any). */
export function requestsOfItems(items: readonly Pick<AgentEvent, 'kind'>[]): (number | null)[] {
	let current: number | null = null;
	return items.map((ev) => {
		if (ev.kind === 'checkpoint') current = (ev as Extract<AgentEvent, { kind: 'checkpoint' }>).request;
		return current;
	});
}

/** Diff tab of a working-set file: `chatedit://<chat id>/<workspace path>`. */
export const CHAT_EDIT_PREFIX = 'chatedit://';
export const chatEditKey = (chatId: string, workspaceRel: string) => `${CHAT_EDIT_PREFIX}${chatId}/${workspaceRel}`;
export const isChatEditKey = (key: string) => key.startsWith(CHAT_EDIT_PREFIX);
export function parseChatEditKey(key: string): { chatId: string; rel: string } | null {
	if (!isChatEditKey(key)) return null;
	const rest = key.slice(CHAT_EDIT_PREFIX.length);
	const i = rest.indexOf('/');
	return i <= 0 || i === rest.length - 1 ? null : { chatId: rest.slice(0, i), rel: rest.slice(i + 1) };
}

/** A path relative to the chat's cwd from a workspace path, or null when it is not under it. */
export function cwdRelative(prefix: string, workspaceRel: string): string | null {
	if (!prefix) return workspaceRel;
	const p = `${prefix.replace(/\/+$/, '')}/`;
	return workspaceRel.startsWith(p) ? workspaceRel.slice(p.length) : null;
}
