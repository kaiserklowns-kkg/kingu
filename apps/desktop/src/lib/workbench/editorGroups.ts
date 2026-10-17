// Editor groups (VS Code: EditorPart's grid of EditorGroupViews, each backed by an
// EditorGroupModel). Pure functions over a plain object so they are unit-testable; the runes
// wrapper in editors.svelte.ts keeps the object in `$state`, which makes these mutations reactive.
//
// A tab's `path` is a workspace file, or `diff:<file>` for a HEAD ↔ working tree diff (scm.ts).
// Each group has at most one preview tab (italic); opening another file unpinned replaces it.
// The grid is a nested split: a split node lays its children out in a row (side by side) or a
// column (stacked), with `sizes` as fractions that sum to 1.

export type EditorTab = { path: string; preview: boolean; dirty: boolean };
export type EditorGroup = { id: number; tabs: EditorTab[]; active: string | null };
export type GroupLeaf = { type: 'group'; id: number };
export type GroupSplit = { type: 'split'; id: number; direction: 'row' | 'column'; children: GridNode[]; sizes: number[] };
export type GridNode = GroupLeaf | GroupSplit;
export type GroupsModel = {
	groups: EditorGroup[];
	root: GridNode;
	activeGroup: number;
	/** Next id for a group or split node. */
	nextId: number;
};
export type SplitDirection = 'right' | 'down';

export const MAX_GROUPS = 8;
/** Smallest fraction a sash may shrink a grid cell to. */
export const MIN_SIZE = 0.1;

export function createGroupsModel(): GroupsModel {
	return { groups: [{ id: 1, tabs: [], active: null }], root: { type: 'group', id: 1 }, activeGroup: 1, nextId: 2 };
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

export function activateGroup(m: GroupsModel, id: number) {
	if (getGroup(m, id)) m.activeGroup = id;
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
		if (previewIdx >= 0) g.tabs[previewIdx] = tab;
		else {
			const at = g.active ? g.tabs.findIndex((t) => t.path === g.active) + 1 : g.tabs.length;
			g.tabs.splice(at, 0, tab);
		}
	}
	g.active = path;
	m.activeGroup = g.id;
}

export function setActiveEditor(m: GroupsModel, group: number, path: string) {
	const g = getGroup(m, group);
	if (g?.tabs.some((t) => t.path === path)) g.active = path;
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
	g.tabs.splice(i, 1);
	if (g.active === path) g.active = g.tabs[Math.min(i, g.tabs.length - 1)]?.path ?? null;
	if (!g.tabs.length && m.groups.length > 1) removeGroup(m, group);
	return true;
}

/** Closes every tab of the group it may; returns the dirty paths it kept. */
export function closeAllInGroup(m: GroupsModel, group: number, { force = false } = {}): string[] {
	const g = getGroup(m, group);
	if (!g) return [];
	const kept: string[] = [];
	for (const tab of [...g.tabs]) if (!closeEditor(m, group, tab.path, { force })) kept.push(tab.path);
	// The last close may already have removed the group.
	const still = getGroup(m, group);
	if (still && !still.tabs.length && m.groups.length > 1) removeGroup(m, group);
	return kept;
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
	m.groups.push({ id, tabs: [], active: null });
	const leaf: GroupLeaf = { type: 'group', id };
	const orientation = direction === 'right' ? 'row' : 'column';
	if (at.parent && at.parent.direction === orientation) {
		const half = at.parent.sizes[at.index] / 2;
		at.parent.sizes[at.index] = half;
		at.parent.children.splice(at.index + 1, 0, leaf);
		at.parent.sizes.splice(at.index + 1, 0, half);
	} else {
		const split: GroupSplit = { type: 'split', id: m.nextId++, direction: orientation, children: [{ type: 'group', id: reference }, leaf], sizes: [0.5, 0.5] };
		replaceNode(m, at, split);
	}
	return id;
}

export function removeGroup(m: GroupsModel, id: number) {
	if (m.groups.length <= 1) return;
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
		m.activeGroup = src.id;
		return;
	}
	const existing = dst.tabs.find((t) => t.path === path);
	if (existing) existing.preview = false;
	else {
		const moved: EditorTab = { path, preview: false, dirty: tab.dirty };
		const at = index ?? (dst.active ? dst.tabs.findIndex((t) => t.path === dst.active) + 1 : dst.tabs.length);
		dst.tabs.splice(Math.max(0, Math.min(at, dst.tabs.length)), 0, moved);
	}
	dst.active = path;
	m.activeGroup = dst.id;
	closeEditor(m, from, path, { force: true });
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
