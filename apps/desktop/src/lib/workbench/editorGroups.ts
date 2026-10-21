// Editor groups (VS Code: EditorPart's grid of EditorGroupViews, each backed by an
// EditorGroupModel). Pure functions over a plain object so they are unit-testable; the runes
// wrapper in editors.svelte.ts keeps the object in `$state`, which makes these mutations reactive.
//
// A tab's `path` is a workspace file, or `diff:<file>` for a HEAD ↔ working tree diff (scm.ts).
// Each group has at most one preview tab (italic); opening another file unpinned replaces it.
// The grid is a nested split: a split node lays its children out in a row (side by side) or a
// column (stacked), with `sizes` as fractions that sum to 1.

/** `sticky`: pinned with Pin Editor (VS Code's sticky tabs), kept first in the strip. */
export type EditorTab = { path: string; preview: boolean; dirty: boolean; sticky?: boolean };
/** `mru`: the group's editors, most recently active first (VS Code's EditorGroupModel.mru). */
/**
 * `locked`: VS Code's locked editor group, which new editors skip unless it already shows them.
 * `splitIn`: editors shown twice side by side in the group (Split Editor in Group).
 */
export type EditorGroup = { id: number; tabs: EditorTab[]; active: string | null; mru: string[]; used?: Record<string, number>; locked?: boolean; splitIn?: string[] };
/** A closed editor, for Reopen Closed Editor (⇧⌘T). */
export type ClosedEditor = { path: string; group: number; index: number; sticky: boolean };
export type GroupLeaf = { type: 'group'; id: number };
export type GroupSplit = { type: 'split'; id: number; direction: 'row' | 'column'; children: GridNode[]; sizes: number[] };
export type GridNode = GroupLeaf | GroupSplit;
export type GroupsModel = {
	groups: EditorGroup[];
	root: GridNode;
	activeGroup: number;
	/** A group shown alone in the editor area (VS Code's Maximize Editor Group); null otherwise. */
	maximized?: number | null;
	/** A group expanded to most of the grid (VS Code's toggleExpandGroup); null otherwise. */
	expanded?: number | null;
	/** Next id for a group or split node. */
	nextId: number;
	/** Recently closed editors, newest last. */
	closed: ClosedEditor[];
};
export type SplitDirection = 'right' | 'down' | 'left' | 'up';

/** `workbench.editor.openPositioning`. */
export type OpenPositioning = 'left' | 'right' | 'first' | 'last';
/** `workbench.editor.splitSizing`. */
export type SplitSizing = 'auto' | 'distribute' | 'split';
/** `workbench.editor.limit.*`, as one value (null when the limit is off). */
export type EditorLimit = { value: number; perEditorGroup: boolean; excludeDirty: boolean };

/** `autoLock`: whether opening `path` as the first editor of a group locks it (`workbench.editor.autoLockGroups`). */
export type Behaviour = { closeEmptyGroups: boolean; focusRecentEditorAfterClose: boolean; openPositioning: OpenPositioning; splitSizing: SplitSizing; autoLock?: (path: string) => boolean };

/** VS Code's defaults of the editor management settings the model follows (IEditorPartOptions). */
export const DEFAULT_BEHAVIOUR: Behaviour = { closeEmptyGroups: true, focusRecentEditorAfterClose: true, openPositioning: 'right', splitSizing: 'auto' };

let behaviourOf: () => Behaviour = () => DEFAULT_BEHAVIOUR;
const behaviour = () => behaviourOf();

/** Where the model reads those settings from (editors.svelte.ts: the settings; tests: a fixed value). */
export function setBehaviour(source: (() => Behaviour) | null) {
	behaviourOf = source ?? (() => DEFAULT_BEHAVIOUR);
}

/** Global use order of `group\0path`, for the editor limit across groups (VS Code's EditorsObserver). */
let clock = 0;

/** VS Code keeps this many recently closed editors. */
export const MAX_CLOSED = 20;

export const MAX_GROUPS = 8;
/** Smallest fraction a sash may shrink a grid cell to. */
export const MIN_SIZE = 0.1;

export function createGroupsModel(): GroupsModel {
	return { groups: [{ id: 1, tabs: [], active: null, mru: [] }], root: { type: 'group', id: 1 }, activeGroup: 1, nextId: 2, closed: [] };
}

export function getGroup(m: GroupsModel, id: number): EditorGroup | undefined {
	return m.groups.find((g) => g.id === id);
}

export function activeGroupOf(m: GroupsModel): EditorGroup {
	return getGroup(m, m.activeGroup) ?? m.groups[0];
}

/** Group ids in grid appearance order (VS Code's GroupsOrder.GRID_APPEARANCE): left→right, top→bottom. */
export function groupOrder(m: GroupsModel): number[] {
	const out: number[] = [];
	const walk = (n: GridNode) => (n.type === 'group' ? out.push(n.id) : n.children.forEach(walk));
	walk(m.root);
	return out;
}

/** Every path open in any group. */
export function openPaths(m: GroupsModel): Set<string> {
	return new Set(m.groups.flatMap((g) => g.tabs.map((t) => t.path)));
}

function touch(g: EditorGroup, path: string) {
	g.mru = [path, ...(g.mru ?? []).filter((p) => p !== path)];
	(g.used ??= {})[path] = ++clock;
}

function forget(g: EditorGroup, path: string) {
	g.mru = (g.mru ?? []).filter((p) => p !== path);
}

/** Number of sticky tabs; they always come first. */
const stickyCount = (g: EditorGroup) => g.tabs.filter((t) => t.sticky).length;

export function activateGroup(m: GroupsModel, id: number) {
	if (!getGroup(m, id)) return;
	m.activeGroup = id;
	// Working in another group leaves the maximized one (VS Code restores the grid).
	if (m.maximized != null && m.maximized !== id) m.maximized = null;
}

/** Where a new tab goes in `g` (`workbench.editor.openPositioning`); pinned tabs always stay first. */
export function insertIndex(g: EditorGroup, positioning: OpenPositioning = behaviour().openPositioning): number {
	const sticky = stickyCount(g);
	const active = g.active ? g.tabs.findIndex((t) => t.path === g.active) : -1;
	switch (positioning) {
		case 'first':
			return sticky;
		case 'last':
			return g.tabs.length;
		case 'left':
			return Math.max(sticky, active < 0 ? 0 : active);
		default:
			return Math.max(sticky, active < 0 ? g.tabs.length : active + 1);
	}
}

export function openEditor(m: GroupsModel, path: string, { preview = true, group = m.activeGroup }: { preview?: boolean; group?: number } = {}) {
	const g = getGroup(m, group) ?? activeGroupOf(m);
	const existing = g.tabs.find((t) => t.path === path);
	if (existing) {
		if (!preview) existing.preview = false;
	} else {
		const dirty = m.groups.some((o) => o.tabs.some((t) => t.path === path && t.dirty));
		const tab: EditorTab = { path, preview: preview && !dirty, dirty };
		const previewIdx = tab.preview ? g.tabs.findIndex((t) => t.preview && !t.dirty) : -1;
		if (previewIdx >= 0) {
			forget(g, g.tabs[previewIdx].path);
			dropSplit(g, g.tabs[previewIdx].path);
			g.tabs[previewIdx] = tab;
		} else g.tabs.splice(insertIndex(g), 0, tab);
		// workbench.editor.autoLockGroups: the first editor of a group, with other groups open (VS Code's editorGroupView).
		if (g.tabs.length === 1 && m.groups.length > 1 && behaviour().autoLock?.(path)) g.locked = true;
	}
	g.active = path;
	touch(g, path);
	m.activeGroup = g.id;
}

/** `workbench.editor.revealIfOpen`: a group (the active one first) that already shows `path`. */
export function groupShowing(m: GroupsModel, path: string): number | null {
	if (activeGroupOf(m).tabs.some((t) => t.path === path)) return m.activeGroup;
	for (const id of groupOrder(m)) if (getGroup(m, id)?.tabs.some((t) => t.path === path)) return id;
	return null;
}

/**
 * `workbench.editor.limit.*`: closes the least recently used editors beyond the limit, in the
 * group or across all groups. Dirty and pinned (sticky) editors and `keep` never close; with
 * `excludeDirty` dirty editors do not count either. Returns the closed [group, path] pairs.
 */
export function enforceLimit(m: GroupsModel, limit: EditorLimit, keep?: { group: number; path: string }): [number, string][] {
	if (!(limit.value > 0)) return [];
	const pools = limit.perEditorGroup ? m.groups.map((g) => [g]) : [m.groups];
	const closed: [number, string][] = [];
	for (const pool of pools) {
		const all = pool
			.flatMap((g) => g.tabs.map((t) => ({ g, t, used: g.used?.[t.path] ?? 0 })))
			.filter(({ t }) => !(limit.excludeDirty && t.dirty))
			.sort((a, b) => a.used - b.used);
		let excess = all.length - limit.value;
		for (const { g, t } of all) {
			if (excess <= 0) break;
			if (t.dirty || t.sticky || (keep && keep.group === g.id && keep.path === t.path)) continue;
			if (closeEditor(m, g.id, t.path)) {
				closed.push([g.id, t.path]);
				excess--;
			}
		}
	}
	return closed;
}

export function setActiveEditor(m: GroupsModel, group: number, path: string) {
	const g = getGroup(m, group);
	if (g?.tabs.some((t) => t.path === path)) {
		g.active = path;
		touch(g, path);
	}
}

export function pinEditor(m: GroupsModel, group: number, path: string) {
	const tab = getGroup(m, group)?.tabs.find((t) => t.path === path);
	if (tab) tab.preview = false;
}

/** Dirty state belongs to the file (its shared model), so it is set on its tab in every group. */
export function setDirty(m: GroupsModel, path: string, dirty: boolean) {
	for (const g of m.groups)
		for (const tab of g.tabs) {
			if (tab.path !== path || tab.dirty === dirty) continue;
			tab.dirty = dirty;
			if (dirty) tab.preview = false;
		}
}

function openElsewhere(m: GroupsModel, group: number, path: string) {
	return m.groups.some((g) => g.id !== group && g.tabs.some((t) => t.path === path));
}

/**
 * Returns false when the tab is dirty and no other group shows the file (the caller asks before
 * discarding). Closing the last tab of a group removes the group unless it is the only one
 * (VS Code's `workbench.editor.closeEmptyGroups`).
 */
export function closeEditor(m: GroupsModel, group: number, path: string, { force = false } = {}): boolean {
	const g = getGroup(m, group);
	const i = g ? g.tabs.findIndex((t) => t.path === path) : -1;
	if (!g || i < 0) return true;
	if (g.tabs[i].dirty && !force && !openElsewhere(m, group, path)) return false;
	const [tab] = g.tabs.splice(i, 1);
	if (!path.startsWith('untitled:')) {
		m.closed = [...(m.closed ?? []).filter((c) => c.path !== path), { path, group, index: i, sticky: !!tab.sticky }].slice(-MAX_CLOSED);
	}
	forget(g, path);
	dropSplit(g, path);
	if (g.used) delete g.used[path];
	// workbench.editor.focusRecentEditorAfterClose: the most recently used editor, else the one that took its place.
	if (g.active === path) {
		const recent = behaviour().focusRecentEditorAfterClose ? g.mru.find((p) => g.tabs.some((t) => t.path === p)) : undefined;
		g.active = recent ?? g.tabs[Math.min(i, g.tabs.length - 1)]?.path ?? null;
	}
	if (g.active) touch(g, g.active);
	// workbench.editor.closeEmptyGroups
	if (!g.tabs.length && m.groups.length > 1 && behaviour().closeEmptyGroups) removeGroup(m, group);
	return true;
}

/** Closes the tabs of `group` that `pick` selects; returns the dirty paths it kept. */
function closeWhere(m: GroupsModel, group: number, pick: (tab: EditorTab, index: number) => boolean, force = false): string[] {
	const g = getGroup(m, group);
	if (!g) return [];
	const kept: string[] = [];
	const doomed = g.tabs.filter(pick);
	for (const tab of doomed) if (!closeEditor(m, group, tab.path, { force })) kept.push(tab.path);
	return kept;
}

/** Close Others: everything in the group except `path` (sticky tabs too, like VS Code's tab menu). */
export function closeOthers(m: GroupsModel, group: number, path: string, { force = false } = {}): string[] {
	const kept = closeWhere(m, group, (t) => t.path !== path, force);
	setActiveEditor(m, group, path);
	return kept;
}

/** Close to the Right: the tabs after `path`. */
export function closeToRight(m: GroupsModel, group: number, path: string, { force = false } = {}): string[] {
	const g = getGroup(m, group);
	const at = g ? g.tabs.findIndex((t) => t.path === path) : -1;
	if (at < 0) return [];
	if (g && g.active && g.tabs.findIndex((t) => t.path === g.active) > at) setActiveEditor(m, group, path);
	return closeWhere(m, group, (_t, i) => i > at, force);
}

/** Close Saved (VS Code's closeUnmodifiedEditors): every tab without unsaved changes. */
export function closeSaved(m: GroupsModel, group: number) {
	closeWhere(m, group, (t) => !t.dirty && !t.sticky);
}

/** Close All Editors (every group); returns the dirty paths it kept. */
export function closeAllEditors(m: GroupsModel, { force = false } = {}): string[] {
	const kept: string[] = [];
	for (const g of [...m.groups]) kept.push(...closeAllInGroup(m, g.id, { force }));
	return [...new Set(kept)];
}

/**
 * Reopen Closed Editor: the newest closed editor that is not open in its group again, back at its
 * index (its group, or the active one when that group is gone). `exists` filters out deleted files.
 */
export function reopenClosed(m: GroupsModel, exists: (path: string) => boolean = () => true): string | null {
	while (m.closed?.length) {
		const c = m.closed.pop()!;
		if (!exists(c.path)) continue;
		const g = getGroup(m, c.group) ?? activeGroupOf(m);
		if (g.tabs.some((t) => t.path === c.path)) continue;
		const sticky = stickyCount(g);
		const at = c.sticky ? Math.min(c.index, sticky) : Math.max(sticky, Math.min(c.index, g.tabs.length));
		const dirty = m.groups.some((o) => o.tabs.some((t) => t.path === c.path && t.dirty));
		g.tabs.splice(at, 0, { path: c.path, preview: false, dirty, sticky: c.sticky || undefined });
		g.active = c.path;
		touch(g, c.path);
		m.activeGroup = g.id;
		return c.path;
	}
	return null;
}

/** The group's editors by most recent use (⌃Tab). */
export function mruOf(m: GroupsModel, group: number): string[] {
	const g = getGroup(m, group);
	if (!g) return [];
	const open = new Set(g.tabs.map((t) => t.path));
	const seen = (g.mru ?? []).filter((p) => open.has(p));
	return [...seen, ...g.tabs.map((t) => t.path).filter((p) => !seen.includes(p))];
}

/**
 * Next/Previous Editor (⌥⌘→/←): the neighbouring tab; past either end it continues in the next or
 * previous group in grid order, wrapping around (VS Code's `workbench.action.nextEditor`).
 * `inGroup` stays in the active group (nextEditorInGroup). Returns [group, path] or null.
 */
export function neighbourEditor(m: GroupsModel, delta: 1 | -1, { inGroup = false } = {}): [number, string] | null {
	const g = activeGroupOf(m);
	const i = g.active ? g.tabs.findIndex((t) => t.path === g.active) : -1;
	const j = i + delta;
	if (g.tabs[j]) return [g.id, g.tabs[j].path];
	if (inGroup || m.groups.length === 1) {
		const wrap = delta > 0 ? g.tabs[0] : g.tabs[g.tabs.length - 1];
		return wrap ? [g.id, wrap.path] : null;
	}
	const order = groupOrder(m);
	for (let k = 1; k <= order.length; k++) {
		const other = getGroup(m, order[(order.indexOf(g.id) + delta * k + order.length * k) % order.length]);
		if (other?.tabs.length) return [other.id, (delta > 0 ? other.tabs[0] : other.tabs[other.tabs.length - 1]).path];
	}
	return null;
}

/** Pin Editor (VS Code's sticky tabs): pinned, moved to the end of the sticky tabs. */
export function stickEditor(m: GroupsModel, group: number, path: string) {
	const g = getGroup(m, group);
	const i = g ? g.tabs.findIndex((t) => t.path === path) : -1;
	if (!g || i < 0 || g.tabs[i].sticky) return;
	const [tab] = g.tabs.splice(i, 1);
	tab.sticky = true;
	tab.preview = false;
	g.tabs.splice(stickyCount(g), 0, tab);
}

/** Unpin Editor: moved to just after the remaining sticky tabs. */
export function unstickEditor(m: GroupsModel, group: number, path: string) {
	const g = getGroup(m, group);
	const i = g ? g.tabs.findIndex((t) => t.path === path) : -1;
	if (!g || i < 0 || !g.tabs[i].sticky) return;
	const [tab] = g.tabs.splice(i, 1);
	delete tab.sticky;
	g.tabs.splice(stickyCount(g), 0, tab);
}

/** Closes every tab of the group it may; returns the dirty paths it kept. */
export function closeAllInGroup(m: GroupsModel, group: number, { force = false } = {}): string[] {
	const g = getGroup(m, group);
	if (!g) return [];
	const kept: string[] = [];
	for (const tab of [...g.tabs]) if (!closeEditor(m, group, tab.path, { force })) kept.push(tab.path);
	// The last close may already have removed the group.
	const still = getGroup(m, group);
	if (still && !still.tabs.length && m.groups.length > 1 && behaviour().closeEmptyGroups) removeGroup(m, group);
	return kept;
}

/**
 * Points tabs at new paths in every group, in place (a file or folder was renamed): groups, tab
 * order, preview and active state are kept. `remap` returns null for tabs it leaves alone; a tab
 * whose new path the group already shows is dropped.
 */
export function remapEditors(m: GroupsModel, remap: (path: string) => string | null) {
	for (const g of m.groups) {
		const seen = new Set<string>();
		const tabs: EditorTab[] = [];
		for (const tab of g.tabs) {
			const next = remap(tab.path) ?? tab.path;
			if (seen.has(next)) continue;
			seen.add(next);
			tabs.push(next === tab.path ? tab : { ...tab, path: next });
		}
		g.tabs = tabs;
		if (g.splitIn) g.splitIn = [...new Set(g.splitIn.map((p) => remap(p) ?? p))];
		if (g.active) g.active = remap(g.active) ?? g.active;
		g.mru = [...new Set((g.mru ?? []).map((p) => remap(p) ?? p))];
	}
}

/** Force-closes every tab in every group, leaving one empty group (the folder was switched). */
export function closeAllGroups(m: GroupsModel) {
	for (const g of [...m.groups]) closeAllInGroup(m, g.id, { force: true });
	// Even with workbench.editor.closeEmptyGroups off, a new folder starts with one group.
	for (const g of [...m.groups]) if (m.groups.length > 1) removeGroup(m, g.id);
}

type Located = { node: GridNode; parent: GroupSplit | null; index: number };

function locate(m: GroupsModel, pred: (n: GridNode) => boolean): Located | null {
	const walk = (node: GridNode, parent: GroupSplit | null, index: number): Located | null => {
		if (pred(node)) return { node, parent, index };
		if (node.type === 'split')
			for (let i = 0; i < node.children.length; i++) {
				const hit = walk(node.children[i], node, i);
				if (hit) return hit;
			}
		return null;
	};
	return walk(m.root, null, 0);
}

function replaceNode(m: GroupsModel, at: Located, next: GridNode) {
	if (at.parent) at.parent.children[at.index] = next;
	else m.root = next;
}

/** Adds an empty group beside `reference`. Returns its id, or null at MAX_GROUPS. */
export function addGroup(m: GroupsModel, reference: number, direction: SplitDirection): number | null {
	if (m.groups.length >= MAX_GROUPS) return null;
	const at = locate(m, (n) => n.type === 'group' && n.id === reference);
	if (!at) return null;
	const id = m.nextId++;
	m.groups.push({ id, tabs: [], active: null, mru: [] });
	const leaf: GroupLeaf = { type: 'group', id };
	const orientation = direction === 'right' || direction === 'left' ? 'row' : 'column';
	const before = direction === 'left' || direction === 'up';
	m.maximized = null;
	if (at.parent && at.parent.direction === orientation) {
		const sizes = at.parent.sizes;
		// workbench.editor.splitSizing: `split` halves the group, `distribute` evens the row, and
		// `auto` (VS Code's Sizing.Auto) distributes when the row is already even, else splits.
		const even = sizes.every((s) => Math.abs(s - sizes[0]) < 1e-6);
		const distribute = behaviour().splitSizing === 'distribute' || (behaviour().splitSizing === 'auto' && even);
		const half = sizes[at.index] / 2;
		sizes[at.index] = half;
		const pos = before ? at.index : at.index + 1;
		at.parent.children.splice(pos, 0, leaf);
		sizes.splice(pos, 0, half);
		if (distribute) at.parent.sizes = sizes.map(() => 1 / sizes.length);
	} else {
		const ref: GroupLeaf = { type: 'group', id: reference };
		const split: GroupSplit = { type: 'split', id: m.nextId++, direction: orientation, children: before ? [leaf, ref] : [ref, leaf], sizes: [0.5, 0.5] };
		replaceNode(m, at, split);
	}
	return id;
}

export function removeGroup(m: GroupsModel, id: number) {
	if (m.groups.length <= 1) return;
	if (m.maximized === id) m.maximized = null;
	if (m.expanded === id) m.expanded = null;
	const order = groupOrder(m);
	const at = locate(m, (n) => n.type === 'group' && n.id === id);
	if (!at?.parent) return;
	const parent = at.parent;
	const freed = parent.sizes[at.index];
	parent.children.splice(at.index, 1);
	parent.sizes.splice(at.index, 1);
	parent.sizes[Math.max(0, at.index - 1)] += freed;
	if (parent.children.length === 1) collapse(m, parent);
	m.groups = m.groups.filter((g) => g.id !== id);
	if (m.activeGroup === id) {
		const pos = order.indexOf(id);
		const rest = order.filter((g) => g !== id);
		m.activeGroup = rest[Math.max(0, pos - 1)] ?? m.groups[0].id;
	}
}

/** Replaces a one-child split with its child, merging a same-direction split into its parent. */
function collapse(m: GroupsModel, split: GroupSplit) {
	const at = locate(m, (n) => n === split);
	if (!at) return;
	const child = split.children[0];
	const grand = at.parent;
	if (grand && child.type === 'split' && child.direction === grand.direction) {
		const share = grand.sizes[at.index];
		grand.children.splice(at.index, 1, ...child.children);
		grand.sizes.splice(at.index, 1, ...child.sizes.map((s) => s * share));
	} else replaceNode(m, at, child);
}

/** VS Code `splitEditor`: a new group beside the active one, showing the active editor. */
export function splitEditor(m: GroupsModel, direction: SplitDirection): number | null {
	const source = activeGroupOf(m);
	const id = addGroup(m, source.id, direction);
	if (id === null) return null;
	if (source.active) openEditor(m, source.active, { preview: false, group: id });
	m.activeGroup = id;
	return id;
}

/**
 * VS Code `focusFirstEditorGroup`…: focuses the group at `index` (grid order). One past the last
 * group creates a new empty group to the right of the last one, like VS Code.
 */
export function focusGroupAt(m: GroupsModel, index: number): number | null {
	const order = groupOrder(m);
	if (index < order.length) {
		m.activeGroup = order[index];
		return order[index];
	}
	if (index > order.length) return null;
	const id = addGroup(m, order[order.length - 1], 'right');
	if (id !== null) m.activeGroup = id;
	return id;
}

/**
 * Moves `path` from group `from` to group `to` (before `index`, default after the active tab).
 * Within one group it reorders. The moved tab is pinned, so the target keeps a single preview.
 */
export function moveEditor(m: GroupsModel, from: number, path: string, to: number, index?: number) {
	const src = getGroup(m, from);
	const dst = getGroup(m, to);
	const tab = src?.tabs.find((t) => t.path === path);
	if (!src || !dst || !tab) return;
	if (src === dst) {
		const i = src.tabs.indexOf(tab);
		const target = Math.max(0, Math.min(index ?? src.tabs.length, src.tabs.length));
		src.tabs.splice(i, 1);
		src.tabs.splice(target > i ? target - 1 : target, 0, tab);
		src.active = path;
		touch(src, path);
		m.activeGroup = src.id;
		return;
	}
	const existing = dst.tabs.find((t) => t.path === path);
	if (existing) existing.preview = false;
	else {
		const moved: EditorTab = { path, preview: false, dirty: tab.dirty };
		const at = index ?? (dst.active ? dst.tabs.findIndex((t) => t.path === dst.active) + 1 : dst.tabs.length);
		dst.tabs.splice(Math.max(stickyCount(dst), Math.min(at, dst.tabs.length)), 0, moved);
	}
	dst.active = path;
	touch(dst, path);
	m.activeGroup = dst.id;
	closeEditor(m, from, path, { force: true });
	// A move is not a close: Reopen Closed Editor must not bring it back in the old group.
	m.closed = (m.closed ?? []).filter((c) => !(c.path === path && c.group === from));
	// closeEditor may have removed `from`; keep the focus on the target either way.
	m.activeGroup = dst.id;
}

/** VS Code `moveEditorToNextGroup`: the next group in grid order, created to the right if none. */
export function moveActiveEditorToNextGroup(m: GroupsModel): boolean {
	const src = activeGroupOf(m);
	if (!src.active) return false;
	const order = groupOrder(m);
	let next: number | null | undefined = order[order.indexOf(src.id) + 1];
	if (next === undefined) {
		if (src.tabs.length === 1) return false; // would just recreate the same layout
		next = addGroup(m, src.id, 'right');
	}
	if (next === null) return false;
	moveEditor(m, src.id, src.active, next);
	return true;
}

/** Sash drag between `split.children[i]` and `[i + 1]`, `delta` as a fraction of the split. */
export function resizeSplit(m: GroupsModel, splitId: number, i: number, delta: number) {
	const at = locate(m, (n) => n.type === 'split' && n.id === splitId);
	const split = at?.node as GroupSplit | undefined;
	if (!split || i < 0 || i + 1 >= split.sizes.length) return;
	const total = split.sizes[i] + split.sizes[i + 1];
	const a = Math.max(MIN_SIZE, Math.min(total - MIN_SIZE, split.sizes[i] + delta));
	split.sizes[i] = a;
	split.sizes[i + 1] = total - a;
}

export function evenSplit(m: GroupsModel, splitId: number) {
	const node = locate(m, (n) => n.type === 'split' && n.id === splitId)?.node;
	if (node?.type === 'split') node.sizes = node.children.map(() => 1 / node.children.length);
}

/** Evens every split of the grid (VS Code's arrangeGroups EVEN). */
export function evenAll(m: GroupsModel) {
	const walk = (n: GridNode) => {
		if (n.type !== 'split') return;
		n.sizes = n.children.map(() => 1 / n.children.length);
		n.children.forEach(walk);
	};
	walk(m.root);
	m.expanded = null;
}

/**
 * VS Code's toggleExpandGroup (a double click on a pinned tab with
 * `workbench.editor.doubleClickTabToToggleEditorGroupSizes: expand`): the group takes most of the
 * grid, its siblings shrink to the minimum; again evens the grid.
 */
export function toggleExpandGroup(m: GroupsModel, id: number) {
	if (m.expanded === id) return evenAll(m);
	let target = locate(m, (n) => n.type === 'group' && n.id === id);
	if (!target) return;
	while (target?.parent) {
		const split = target.parent;
		const others = split.children.length - 1;
		split.sizes = split.children.map((_, i) => (i === target!.index ? 1 - others * MIN_SIZE : MIN_SIZE));
		const node: GridNode = split;
		target = locate(m, (n) => n === node);
	}
	m.expanded = id;
}

/**
 * ⌘W on a pinned (sticky) editor with `workbench.editor.preventPinnedEditorClose` keyboard: the
 * most recently used unpinned editor of the active group, else of any group, to show instead.
 */
export function nextUnpinned(m: GroupsModel): [number, string] | null {
	const g = activeGroupOf(m);
	const unpinned = (gr: EditorGroup) => mruOf(m, gr.id).filter((p) => !gr.tabs.find((t) => t.path === p)?.sticky);
	const own = unpinned(g)[0];
	if (own) return [g.id, own];
	let best: [number, string, number] | null = null;
	for (const gr of m.groups)
		for (const p of unpinned(gr)) {
			const used = gr.used?.[p] ?? 0;
			if (!best || used > best[2]) best = [gr.id, p, used];
		}
	return best && [best[0], best[1]];
}

/**
 * The group beside group `id` in `direction` in the grid, or null (VS Code's findGroup by
 * direction, e.g. the SIDE_GROUP lookup for `workbench.editor.openSideBySideDirection`). Going
 * left or up lands on the nearest group of the neighbouring cell.
 */
export function neighbourGroup(m: GroupsModel, id: number, direction: SplitDirection): number | null {
	const orientation = direction === 'right' || direction === 'left' ? 'row' : 'column';
	const step = direction === 'right' || direction === 'down' ? 1 : -1;
	let at = locate(m, (n) => n.type === 'group' && n.id === id);
	while (at?.parent) {
		const split = at.parent;
		const next = split.children[at.index + step];
		if (split.direction === orientation && next) {
			let node = next;
			while (node.type === 'split') node = step < 0 && node.direction === orientation ? node.children[node.children.length - 1] : node.children[0];
			return node.id;
		}
		const node: GridNode = split;
		at = locate(m, (n) => n === node);
	}
	return null;
}

/** Expand Editor Group (VS Code's minimizeOtherEditors, arrangeGroups EXPAND): the group takes most of the grid. */
export function expandGroup(m: GroupsModel, id: number) {
	if (m.expanded === id || m.groups.length < 2) return;
	toggleExpandGroup(m, id);
}

/** VS Code's toggleMaximizeGroup: the group alone in the editor area until toggled or another group is used. */
export function toggleMaximizeGroup(m: GroupsModel, id: number) {
	if (m.groups.length < 2 && m.maximized == null) return;
	m.maximized = m.maximized === id ? null : id;
	if (m.maximized != null) m.activeGroup = id;
}

// --- Locked groups (VS Code: Lock Editor Group, workbench.editor.autoLockGroups) ---------------

/** Lock or unlock a group (VS Code's lockEditorGroup / unlockEditorGroup). */
export function setGroupLocked(m: GroupsModel, id: number, locked: boolean) {
	const g = getGroup(m, id);
	if (!g) return;
	if (locked) g.locked = true;
	else delete g.locked;
}

/** A locked group is skipped for `path` unless it already shows it (VS Code's isGroupLockedForEditor). */
export const isLockedFor = (g: EditorGroup, path: string) => !!g.locked && !g.tabs.some((t) => t.path === path);

/** When a group was last used: its most recently used editor's turn of the global clock. */
const lastUsed = (g: EditorGroup) => Math.max(0, ...Object.values(g.used ?? {}));

/**
 * The group a new editor opens in when no group is named (VS Code's editorGroupFinder fallback):
 * the active group, or, when that one is locked, the most recently used unlocked group. Null when
 * every group is locked for `path`: the caller adds a group beside the active one.
 */
export function unlockedGroupFor(m: GroupsModel, path: string): number | null {
	const active = activeGroupOf(m);
	if (!isLockedFor(active, path)) return active.id;
	const recent = m.groups.filter((g) => g !== active).sort((a, b) => lastUsed(b) - lastUsed(a));
	return recent.find((g) => !isLockedFor(g, path))?.id ?? null;
}

// --- Split Editor in Group (VS Code's SideBySideEditorInput of one editor twice) ----------------

function dropSplit(g: EditorGroup, path: string) {
	if (!g.splitIn?.includes(path)) return;
	g.splitIn = g.splitIn.filter((p) => p !== path);
	if (!g.splitIn.length) delete g.splitIn;
}

/** Whether the group shows `path` split in two. */
export const isSplitInGroup = (g: EditorGroup | undefined, path: string | null) => !!g && !!path && !!g.splitIn?.includes(path);

/** Split Editor in Group / Join Editor in Group: `path` (a tab of the group) shown twice, or once again. */
export function setSplitInGroup(m: GroupsModel, id: number, path: string, split: boolean) {
	const g = getGroup(m, id);
	if (!g || !g.tabs.some((t) => t.path === path)) return;
	if (!split) return dropSplit(g, path);
	if (!g.splitIn?.includes(path)) g.splitIn = [...(g.splitIn ?? []), path];
	pinEditor(m, id, path);
}

/**
 * VS Code's Join Editor Group with Next Group (joinTwoGroups): the group's editors move into the
 * group to its right, else below, left or above. Returns the group that received them.
 */
export function joinWithNextGroup(m: GroupsModel, id = m.activeGroup): number | null {
	for (const direction of ['right', 'down', 'left', 'up'] as const) {
		const target = neighbourGroup(m, id, direction);
		if (target !== null && target !== id) {
			mergeGroup(m, id, target);
			return target;
		}
	}
	return null;
}

// --- Editor layouts (VS Code: View > Editor Layout, IEditorGroupsService.applyLayout) ------------

/** A cell of an editor layout: a group, or (with `groups`) a nested split across the parent. */
export type LayoutCell = { readonly groups?: readonly LayoutCell[]; readonly size?: number };
/** VS Code's EditorGroupLayout: `row` = GroupOrientation.HORIZONTAL (side by side). */
export type EditorGroupLayout = { readonly orientation: 'row' | 'column'; readonly groups: readonly LayoutCell[] };

/** VS Code's layout commands (`workbench.action.editorLayout*`) and their layouts. */
export const EDITOR_LAYOUTS = {
	editorLayoutSingle: { orientation: 'row', groups: [{}] },
	editorLayoutTwoColumns: { orientation: 'row', groups: [{}, {}] },
	editorLayoutThreeColumns: { orientation: 'row', groups: [{}, {}, {}] },
	editorLayoutTwoRows: { orientation: 'column', groups: [{}, {}] },
	editorLayoutThreeRows: { orientation: 'column', groups: [{}, {}, {}] },
	editorLayoutTwoByTwoGrid: { orientation: 'row', groups: [{ groups: [{}, {}] }, { groups: [{}, {}] }] },
	editorLayoutTwoColumnsBottom: { orientation: 'column', groups: [{}, { groups: [{}, {}] }] },
	editorLayoutTwoRowsRight: { orientation: 'row', groups: [{}, { groups: [{}, {}] }] }
} as const satisfies Record<string, EditorGroupLayout>;

const countCells = (cells: readonly LayoutCell[]): number => cells.reduce((n, c) => n + (c.groups ? countCells(c.groups) : 1), 0);

/** Moves every editor of group `from` into `to` (VS Code's mergeGroup), then removes `from`. */
export function mergeGroup(m: GroupsModel, from: number, to: number) {
	const source = getGroup(m, from);
	const target = getGroup(m, to);
	if (!source || !target || from === to) return;
	for (const tab of source.tabs) {
		if (target.tabs.some((t) => t.path === tab.path)) continue;
		// A preview tab arriving next to the target's own preview becomes a normal tab.
		target.tabs.push({ ...tab, preview: tab.preview && !target.tabs.some((t) => t.preview) });
		target.mru = [...(target.mru ?? []), tab.path];
	}
	target.active ??= source.active;
	source.tabs = [];
	if (m.activeGroup === from) m.activeGroup = to;
	removeGroup(m, from);
}

/**
 * Lays the editor area out as `layout` (VS Code's applyLayout): groups that do not fit merge into
 * the last cell, existing groups keep their order (grid appearance) and new cells get empty groups.
 */
export function applyLayout(m: GroupsModel, layout: EditorGroupLayout) {
	const cells = Math.max(1, Math.min(MAX_GROUPS, countCells(layout.groups)));
	let order = groupOrder(m);
	if (cells < order.length) {
		const last = order[cells - 1];
		for (const id of order.slice(cells)) mergeGroup(m, id, last);
		order = groupOrder(m);
	}
	const ids = [...order];
	const nextGroup = (): number => {
		const reuse = ids.shift();
		if (reuse !== undefined) return reuse;
		const id = m.nextId++;
		m.groups.push({ id, tabs: [], active: null, mru: [] });
		return id;
	};
	const build = (list: readonly LayoutCell[], direction: 'row' | 'column'): GridNode => {
		const children = list.map((c): GridNode => (c.groups?.length ? build(c.groups, direction === 'row' ? 'column' : 'row') : { type: 'group', id: nextGroup() }));
		if (children.length === 1) return children[0];
		const given = list.map((c) => (typeof c.size === 'number' && c.size > 0 ? c.size : 0));
		const total = given.reduce((a, b) => a + b, 0);
		const sizes = given.every((s) => s > 0) ? given.map((s) => s / total) : children.map(() => 1 / children.length);
		return { type: 'split', id: m.nextId++, direction, children, sizes };
	};
	m.root = build(layout.groups.length ? layout.groups : [{}], layout.orientation);
	m.maximized = null;
	m.expanded = null;
	if (!getGroup(m, m.activeGroup)) m.activeGroup = groupOrder(m)[0];
}

/** VS Code's Toggle Vertical/Horizontal Editor Layout (⌥⌘0): every split turns the other way. */
export function flipLayout(m: GroupsModel) {
	const walk = (n: GridNode) => {
		if (n.type !== 'split') return;
		n.direction = n.direction === 'row' ? 'column' : 'row';
		n.children.forEach(walk);
	};
	walk(m.root);
}

/** VS Code's Join All Editor Groups: every editor in the active group, the only one left. */
export function joinAllGroups(m: GroupsModel) {
	const target = m.activeGroup;
	for (const id of groupOrder(m)) if (id !== target) mergeGroup(m, id, target);
}

/** More than one column of groups side by side (VS Code's centerMainEditorLayout check). */
export function hasColumns(m: GroupsModel): boolean {
	const root = m.root;
	if (root.type !== 'split') return false;
	if (root.direction === 'row') return root.children.length > 1;
	return root.children.some((c) => c.type === 'split' && c.direction === 'row' && c.children.length > 1);
}
