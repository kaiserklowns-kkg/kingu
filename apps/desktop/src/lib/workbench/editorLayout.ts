// The editor area of a workspace as it is kept between sessions (VS Code's EditorPart state and
// its editors' serializers): the groups and their grid (orientation and sizes), each group's
// editors in order with their pinned (sticky) and preview state, its active editor and most
// recently used order, the active group, and each editor's view state (scroll, cursor, folding).
// Pure, so bun tests cover it; editorRestore.svelte.ts reads and writes it per workspace.

import type { EditorGroup, GridNode, GroupsModel } from './editorGroups';
import { DIFF_PREFIX } from './scm';
import { isExternalKey } from './externalFiles';
import { isUntitled } from './untitled';

/** A view state (Monaco's ICodeEditorViewState, plain JSON) per `group\0path`. */
export type ViewStates = Record<string, unknown>;
export type SavedTab = { path: string; preview?: boolean; sticky?: boolean };
export type SavedGroup = { id: number; tabs: SavedTab[]; active: string | null; mru: string[] };
export type SavedLayout = { groups: SavedGroup[]; root: GridNode; activeGroup: number; views?: ViewStates };

/** View states kept per workspace at most (the open editors' come first). */
export const MAX_SAVED_VIEWS = 200;

/**
 * Editors that come back: workspace files, files outside it (Rust remembers which may be read),
 * Source Control diffs, and untitled editors while hot exit keeps their text (VS Code serializes
 * them only then). Settings, previews, chats and the like are not restored.
 */
export function isRestorableKey(key: string, hotExit: boolean): boolean {
	if (!key.trim()) return false;
	if (isUntitled(key)) return hotExit;
	// A working tree diff (`diff:<file>`); the other diffs are of a moment (a commit, a chat edit…).
	return !key.includes(':') || isExternalKey(key) || (key.startsWith(DIFF_PREFIX) && !key.slice(DIFF_PREFIX.length).includes(':'));
}

export const viewKey = (group: number, path: string) => `${group}\u0000${path}`;

/** What to keep of `model`: the restorable editors of every group, and the view states of the open ones first. */
export function serializeLayout(model: GroupsModel, keep: (key: string) => boolean, views: ViewStates = {}): SavedLayout {
	const groups = model.groups.map((g) => {
		const tabs = g.tabs.filter((t) => keep(t.path)).map((t) => ({ path: t.path, ...(t.preview ? { preview: true } : {}), ...(t.sticky ? { sticky: true } : {}) }));
		const paths = new Set(tabs.map((t) => t.path));
		return { id: g.id, tabs, active: g.active && paths.has(g.active) ? g.active : (tabs.at(-1)?.path ?? null), mru: (g.mru ?? []).filter((p) => paths.has(p)) };
	});
	const open = new Set(groups.flatMap((g) => g.tabs.map((t) => viewKey(g.id, t.path))));
	const live = new Set(groups.map((g) => String(g.id)));
	const entries = Object.entries(views).filter(([k, v]) => v && live.has(k.split('\u0000')[0]) && keep(k.slice(k.indexOf('\u0000') + 1)));
	// The open editors' first, then the most recent of the closed ones (last in insertion order).
	const kept = [...entries.filter(([k]) => open.has(k)), ...entries.filter(([k]) => !open.has(k)).reverse()].slice(0, MAX_SAVED_VIEWS);
	return { groups, root: JSON.parse(JSON.stringify(model.root)) as GridNode, activeGroup: model.activeGroup, views: Object.fromEntries(kept) };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/** A grid read back, its every leaf one of `ids` once; sizes that do not add up are evened out. */
function parseGrid(raw: unknown, ids: Set<number>, seen: Set<number>, nodeIds: Set<number>): GridNode | null {
	if (!isObject(raw) || !isId(raw.id)) return null;
	if (raw.type === 'group') {
		if (!ids.has(raw.id) || seen.has(raw.id)) return null;
		seen.add(raw.id);
		return { type: 'group', id: raw.id };
	}
	if (raw.type !== 'split' || (raw.direction !== 'row' && raw.direction !== 'column') || !Array.isArray(raw.children) || !raw.children.length) return null;
	if (nodeIds.has(raw.id) || ids.has(raw.id)) return null;
	nodeIds.add(raw.id);
	const children: GridNode[] = [];
	for (const c of raw.children) {
		const node = parseGrid(c, ids, seen, nodeIds);
		if (!node) return null;
		children.push(node);
	}
	const sizes = Array.isArray(raw.sizes) ? raw.sizes : [];
	const ok = sizes.length === children.length && sizes.every((s) => typeof s === 'number' && Number.isFinite(s) && s > 0);
	const total = ok ? (sizes as number[]).reduce((a, b) => a + b, 0) : 0;
	return { type: 'split', id: raw.id, direction: raw.direction, children, sizes: ok ? (sizes as number[]).map((s) => s / total) : children.map(() => 1 / children.length) };
}

function parseGroup(raw: unknown, keep: (key: string) => boolean): EditorGroup | null {
	if (!isObject(raw) || !isId(raw.id) || !Array.isArray(raw.tabs)) return null;
	const tabs: EditorGroup['tabs'] = [];
	for (const t of raw.tabs) {
		if (!isObject(t) || typeof t.path !== 'string' || !keep(t.path) || tabs.some((x) => x.path === t.path)) continue;
		tabs.push({ path: t.path, preview: t.preview === true, dirty: false, ...(t.sticky === true ? { sticky: true } : {}) });
	}
	// Pinned (sticky) tabs stay first, and at most one preview tab per group.
	tabs.sort((a, b) => Number(!!b.sticky) - Number(!!a.sticky));
	let preview = false;
	for (const t of tabs) {
		if (t.preview && (preview || t.sticky)) t.preview = false;
		preview ||= t.preview;
	}
	const paths = new Set(tabs.map((t) => t.path));
	const active = typeof raw.active === 'string' && paths.has(raw.active) ? raw.active : (tabs.at(-1)?.path ?? null);
	const mru = Array.isArray(raw.mru) ? raw.mru.filter((p): p is string => typeof p === 'string' && paths.has(p)) : [];
	for (const t of tabs) if (!mru.includes(t.path)) mru.push(t.path);
	const order = [...new Set(mru)];
	return { id: raw.id, tabs, active, mru: active ? [active, ...order.filter((p) => p !== active)] : order };
}

/** A saved layout read back as a groups model (null when it is not one), with its view states. */
export function parseLayout(raw: unknown, keep: (key: string) => boolean): { model: GroupsModel; views: ViewStates } | null {
	if (!isObject(raw) || !Array.isArray(raw.groups) || !raw.groups.length) return null;
	const groups: EditorGroup[] = [];
	for (const g of raw.groups) {
		const group = parseGroup(g, keep);
		if (!group || groups.some((x) => x.id === group.id)) return null;
		groups.push(group);
	}
	const ids = new Set(groups.map((g) => g.id));
	const seen = new Set<number>();
	const nodeIds = new Set<number>();
	const root = parseGrid(raw.root, ids, seen, nodeIds);
	if (!root || seen.size !== ids.size) return null;
	const activeGroup = isId(raw.activeGroup) && ids.has(raw.activeGroup) ? raw.activeGroup : groups[0].id;
	const nextId = Math.max(...ids, ...nodeIds) + 1;
	const views: ViewStates = {};
	if (isObject(raw.views)) for (const [k, v] of Object.entries(raw.views)) if (isObject(v) && ids.has(Number(k.split('\u0000')[0]))) views[k] = v;
	return { model: { groups, root, activeGroup, nextId, closed: [], maximized: null, expanded: null }, views };
}

/** What an older build kept (the open files, one group): the same as a layout of one group. */
export function fromOpenEditors(paths: readonly string[], active: string | null): SavedLayout {
	return { groups: [{ id: 1, tabs: paths.map((path) => ({ path })), active, mru: active ? [active] : [] }], root: { type: 'group', id: 1 }, activeGroup: 1 };
}

/**
 * Restoring into a model that already has editors (a file opened at launch, a backup restored
 * first): those stay, added to the restored active group after its own.
 */
export function withOpen(restored: GroupsModel, current: GroupsModel): GroupsModel {
	const have = new Set(restored.groups.flatMap((g) => g.tabs.map((t) => t.path)));
	const extra = current.groups.flatMap((g) => g.tabs).filter((t) => !have.has(t.path) && (have.add(t.path), true));
	if (!extra.length) return restored;
	const target = restored.groups.find((g) => g.id === restored.activeGroup) ?? restored.groups[0];
	for (const t of extra) target.tabs.push({ ...t, preview: false });
	const active = current.groups.find((g) => g.id === current.activeGroup)?.active;
	if (active && target.tabs.some((t) => t.path === active)) {
		target.active = active;
		target.mru = [active, ...target.mru.filter((p) => p !== active)];
	}
	for (const t of extra) if (!target.mru.includes(t.path)) target.mru.push(t.path);
	return restored;
}
