// Orca's tab groups (docs model/tabs-panes-splits.mdx; renderer store/slices/tabs/tabs-drop-actions.ts,
// tabs-close-actions.ts, components/tab-group/*), in Kingu's Agents layout: a worktree's center
// splits into regions, nested any way (a tree like the terminal's pane tree), and every region is a
// tab group with its own tab strip. Each tab belongs to one group; each group shows one of its tabs.
// Dropping a tab on a region's right or bottom edge moves it into a new group there, dropping it on
// another group's strip or middle moves it into that group, and a group whose last tab leaves or
// closes goes away. The worktree's active tab is in the active group. Tab order inside a group is
// the worktree's strip order (adeLayout `order`) filtered to the group. Views move by style only,
// never remounted. Also the tab layout kept across restarts (Orca restores every tab). Pure.

import { cleanProfile, type BrowserTab, type FileTab } from './adeTabs';
import { activeAfterClose } from './adeTabs';
import { hasLeaf, leaf, leaves, parsePaneNode, removePane, splitPane, type PaneNode, type Rect } from '#lib/terminal/paneLayout.ts';

export type SplitDir = 'right' | 'down';
/** Where a dragged tab lands on a region: a new group on its right or bottom edge, or into its group. */
export type DropDir = SplitDir | 'center';
/** A binary tree of regions (leaves: group ids, or in `shownTree` the tab each group shows). */
export type TabTree = PaneNode;
/**
 * A split worktree's tab groups: the region tree (leaves `g<n>`), each tab's group (tabs not listed
 * belong to the first group) and the tab each group shows.
 */
export type TabGroups = { tree: TabTree; of: Record<string, string>; shown: Record<string, string> };

/** A tab id that can be in a group: the agent tab, terminals, browsers and file/diff tabs. */
export const splittable = (id: string) => id === 'main' || /^[tb]\d+$/.test(id) || (id.startsWith('f:') && id.length > 2);
const isGroupId = (id: string) => /^g\d+$/.test(id);

const one = (): TabGroups => ({ tree: leaf('g1'), of: {}, shown: {} });
/** Null for one group (no split). */
const split = (g: TabGroups | null): TabGroups | null => (g && g.tree.type === 'split' ? g : null);
const membersOf = (of: Record<string, string>, ids: readonly string[], gid: string) => ids.filter((id) => of[id] === gid);

/**
 * Every tab of `ids` in a group (unlisted ones in the first), closed tabs and empty groups gone, and
 * a shown tab per group (the kept one, else its most recent tab, else its first). Null when none is left.
 */
function normalize(g: TabGroups, ids: readonly string[], recent: readonly string[] = []): TabGroups | null {
	const groups = leaves(g.tree);
	const of: Record<string, string> = {};
	for (const id of ids) of[id] = groups.includes(g.of[id]) ? g.of[id] : groups[0];
	let tree: TabTree | null = g.tree;
	for (const gid of groups) if (tree && !membersOf(of, ids, gid).length) tree = removePane(tree, gid);
	if (!tree) return null;
	const shown: Record<string, string> = {};
	for (const gid of leaves(tree)) {
		const members = membersOf(of, ids, gid);
		const kept = g.shown[gid];
		shown[gid] = kept && members.includes(kept) ? kept : (recent.find((id) => members.includes(id)) ?? members[0]);
	}
	return { tree, of, shown };
}

/** The groups as they stand: closed tabs gone, `active` shown in its group; null when fewer than two groups remain. */
export function liveGroups(g: TabGroups | null | undefined, ids: readonly string[], active: string, recent: readonly string[] = []): TabGroups | null {
	const live = g ? split(normalize(g, ids, recent)) : null;
	if (!live || !(active in live.of)) return live;
	return { ...live, shown: { ...live.shown, [live.of[active]]: active } };
}

/** The tabs of group `gid`, in `ids` order. */
export const groupTabs = (g: TabGroups, ids: readonly string[], gid: string): string[] => membersOf(g.of, ids, gid);

/** The region tree with each group replaced by the tab it shows (where views are placed). */
export function shownTree(g: TabGroups): TabTree {
	const swap = (n: TabTree): TabTree => (n.type === 'leaf' ? leaf(g.shown[n.id] ?? n.id) : { ...n, first: swap(n.first), second: swap(n.second) });
	return swap(g.tree);
}

/** The group of tab `tab` (the group that holds a tab; unlisted tabs in the first). */
export const groupOf = (g: TabGroups, tab: string): string => g.of[tab] ?? leaves(g.tree)[0];

/** A new tab joins the group of `active` (Orca opens tabs in the active group); a tab already in one stays. */
export function placeTab(g: TabGroups, id: string, active: string): TabGroups {
	if (g.of[id]) return g;
	return { ...g, of: { ...g.of, [id]: groupOf(g, active) } };
}

/** Group of `tab` shows it. */
export function withShown(g: TabGroups, tab: string): TabGroups {
	const gid = g.of[tab];
	return gid && g.shown[gid] !== tab ? { ...g, shown: { ...g.shown, [gid]: tab } } : g;
}

function nextGroupId(tree: TabTree): string {
	return `g${leaves(tree).reduce((m, id) => Math.max(m, Number(id.slice(1)) || 0), 0) + 1}`;
}

/**
 * Orca's drop on a region's edge: tab `id` moves into a new group on the right or bottom of group
 * `target` (null `g`: the one group). Its old group goes when it empties. The same `g` back is a
 * no-op (a group's only tab dropped on its own edge, Orca's isPaneColumnSplitDropNoOp); null: one group.
 */
export function splitGroup(g: TabGroups | null, ids: readonly string[], target: string, id: string, dir: SplitDir, recent: readonly string[] = []): TabGroups | null {
	if (!splittable(id) || !ids.includes(id)) return g;
	const base = normalize(g ?? one(), ids, recent);
	if (!base || !hasLeaf(base.tree, target)) return g;
	const source = base.of[id];
	if (source === target && membersOf(base.of, ids, source).length < 2) return g;
	const gid = nextGroupId(base.tree);
	const tree = splitPane(base.tree, target, gid, dir === 'right' ? 'vertical' : 'horizontal');
	return split(normalize({ tree, of: { ...base.of, [id]: gid }, shown: { ...base.shown, [gid]: id } }, ids, recent));
}

/** Orca's drop on another group (its strip or middle): tab `id` moves into group `target` and shows there. */
export function moveToGroup(g: TabGroups | null, ids: readonly string[], id: string, target: string, recent: readonly string[] = []): TabGroups | null {
	const base = g && normalize(g, ids, recent);
	if (!base || !ids.includes(id) || !hasLeaf(base.tree, target) || base.of[id] === target) return g;
	return split(normalize({ ...base, of: { ...base.of, [id]: target }, shown: { ...base.shown, [target]: id } }, ids, recent));
}

/** The group next to `gid` (the first group of its sibling), where its tabs go when it closes. */
function neighbour(tree: TabTree, gid: string): string | null {
	if (tree.type === 'leaf') return null;
	if (tree.first.type === 'leaf' && tree.first.id === gid) return leaves(tree.second)[0];
	if (tree.second.type === 'leaf' && tree.second.id === gid) return leaves(tree.first)[0];
	return neighbour(hasLeaf(tree.first, gid) ? tree.first : tree.second, gid);
}

/** Closes region `gid`; its tabs stay open in the group next to it. Null: one group left. */
export function closeGroup(g: TabGroups | null, ids: readonly string[], gid: string, recent: readonly string[] = []): TabGroups | null {
	const base = g && normalize(g, ids, recent);
	if (!base || !hasLeaf(base.tree, gid)) return g;
	const to = neighbour(base.tree, gid);
	const tree = removePane(base.tree, gid);
	if (!to || !tree) return null;
	const of = Object.fromEntries(Object.entries(base.of).map(([id, x]) => [id, x === gid ? to : x]));
	return split(normalize({ tree, of, shown: base.shown }, ids, recent));
}

/**
 * The active tab after `closing` closes: its neighbour in its group's strip, or when it was the
 * group's last tab, the tab the next group shows (Orca collapses the emptied group).
 */
export function activeAfterGroupClose(g: TabGroups | null, ids: readonly string[], closing: string, active: string): string {
	if (!g) return activeAfterClose([...ids], closing, active);
	if (closing !== active) return active;
	const gid = groupOf(g, closing);
	const peers = membersOf(g.of, ids, gid);
	if (peers.length > 1) return activeAfterClose(peers, closing, active);
	const to = neighbour(g.tree, gid);
	return (to && g.shown[to]) || activeAfterClose([...ids], closing, active);
}

/** A tab renamed (a file moved): it keeps its group and place. */
export function renameTab(g: TabGroups, from: string, to: string): TabGroups {
	if (!(from in g.of) && !Object.values(g.shown).includes(from)) return g;
	const of = Object.fromEntries(Object.entries(g.of).map(([id, x]) => [id === from ? to : id, x]));
	const shown = Object.fromEntries(Object.entries(g.shown).map(([x, id]) => [x, id === from ? to : id]));
	return { tree: g.tree, of, shown };
}

/** A region's CSS (fractions of the center), 2px apart from its neighbours; `top` px are left above it (its tab strip). */
export function rectStyle(r: Rect, top = 0): string {
	const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
	const gapL = r.x > 0 ? 2 : 0;
	const gapR = r.x + r.w < 0.9999 ? 2 : 0;
	const gapT = r.y > 0 ? 2 : 0;
	const gapB = r.y + r.h < 0.9999 ? 2 : 0;
	return `left:calc(${pct(r.x)} + ${gapL}px);top:calc(${pct(r.y)} + ${gapT + top}px);width:calc(${pct(r.w)} - ${gapL + gapR}px);height:calc(${pct(r.h)} - ${gapT + gapB + top}px)`;
}

/** A region's tab strip: the top `height` px of it. */
export function stripStyle(r: Rect, height: number): string {
	const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
	const gapL = r.x > 0 ? 2 : 0;
	const gapR = r.x + r.w < 0.9999 ? 2 : 0;
	const gapT = r.y > 0 ? 2 : 0;
	return `left:calc(${pct(r.x)} + ${gapL}px);top:calc(${pct(r.y)} + ${gapT}px);width:calc(${pct(r.w)} - ${gapL + gapR}px);height:${height}px`;
}

/**
 * The region under a point (fractions) and what a drop there means: its outer 30% on the right or
 * bottom splits it; with `center`, the rest moves the tab into its group.
 */
export function dropTarget(rects: ReadonlyMap<string, Rect>, x: number, y: number, center = false): { id: string; dir: DropDir } | null {
	for (const [id, r] of rects) {
		if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
		const dir = dropEdge(x - r.x, y - r.y, r.w, r.h);
		return dir ? { id, dir } : center ? { id, dir: 'center' } : null;
	}
	return null;
}

/** Which split edge a drop at (x, y) inside a box of (w, h) means: the outer 30% on the right or bottom. */
export function dropEdge(x: number, y: number, w: number, h: number): SplitDir | null {
	if (w <= 0 || h <= 0) return null;
	const right = x / w > 0.7;
	const down = y / h > 0.7;
	if (right && down) return x / w - 0.7 >= y / h - 0.7 ? 'right' : 'down';
	return right ? 'right' : down ? 'down' : null;
}

/** What is saved per folder besides terminals (adeLayout `kingu.adeTabs`). */
export type SavedTabs = {
	browsers: Record<string, BrowserTab[]>;
	files: Record<string, FileTab[]>;
	order: Record<string, string[]>;
	pinned: Record<string, string[]>;
	colors: Record<string, string>;
	layouts: Record<string, TabGroups>;
};

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, 500) : []);
/** URLs a restored browser tab may load again (what the address bar accepts). */
const safeUrl = (u: unknown) => typeof u === 'string' && (u === '' || /^(https?:|about:blank$)/i.test(u)) && u.length <= 8192;

/**
 * Saved tabs, checked: browser tabs (`b<n>`, http(s) or blank), file tabs except untitled buffers
 * (their text is gone) and previews, string orders and pins, `#rgb`/`#rrggbb` colours, splits.
 */
export function parseSavedTabs(raw: unknown): SavedTabs {
	const out: SavedTabs = { browsers: {}, files: {}, order: {}, pinned: {}, colors: {}, layouts: {} };
	if (!obj(raw)) return out;
	for (const [k, list] of Object.entries(obj(raw.browsers) ? raw.browsers : {})) {
		const tabs = (Array.isArray(list) ? list : []).filter((b): b is BrowserTab => obj(b) && typeof b.id === 'string' && /^b\d+$/.test(b.id) && safeUrl(b.url) && typeof b.title === 'string');
		if (tabs.length) out.browsers[k] = tabs.map((b) => ({ id: b.id, url: b.url, title: b.title.slice(0, 300), ...(typeof b.profile === 'string' && cleanProfile(b.profile) ? { profile: cleanProfile(b.profile)! } : {}) }));
	}
	for (const [k, list] of Object.entries(obj(raw.files) ? raw.files : {})) {
		const tabs = (Array.isArray(list) ? list : []).filter((f): f is FileTab => obj(f) && typeof f.key === 'string' && !!f.key && !f.key.startsWith('untitled:') && f.preview !== true);
		if (tabs.length) out.files[k] = tabs.map((f) => ({ key: f.key, preview: false, ...(f.mdPreview === true ? { mdPreview: true } : {}) }));
	}
	for (const [k, v] of Object.entries(obj(raw.order) ? raw.order : {})) if (strings(v).length) out.order[k] = strings(v);
	for (const [k, v] of Object.entries(obj(raw.pinned) ? raw.pinned : {})) if (strings(v).length) out.pinned[k] = strings(v);
	for (const [k, v] of Object.entries(obj(raw.colors) ? raw.colors : {})) if (typeof v === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) out.colors[k] = v;
	for (const [k, v] of Object.entries(obj(raw.layouts) ? raw.layouts : {})) {
		const groups = parseTabGroups(v);
		if (groups) out.layouts[k] = groups;
	}
	return out;
}

/** A saved split, checked: group ids `g<n>`, tab ids that can be in a group, groups that exist. Older Kingu saved a tree of tabs (migrated). */
export function parseTabGroups(v: unknown): TabGroups | null {
	if (!obj(v)) return null;
	if (!('tree' in v)) {
		const old = parsePaneNode(v, splittable);
		return old && old.type === 'split' ? migrateRegions(old) : null;
	}
	const tree = parsePaneNode(v.tree, isGroupId);
	if (!tree || tree.type !== 'split') return null;
	const groups = new Set(leaves(tree));
	const of: Record<string, string> = {};
	for (const [id, gid] of Object.entries(obj(v.of) ? v.of : {}).slice(0, 2000)) if (splittable(id) && typeof gid === 'string' && groups.has(gid)) of[id] = gid;
	const shown: Record<string, string> = {};
	for (const [gid, id] of Object.entries(obj(v.shown) ? v.shown : {})) if (groups.has(gid) && typeof id === 'string' && splittable(id)) shown[gid] = id;
	return { tree, of, shown };
}

/** Kingu's earlier regions (a tree whose leaves were the tab each region showed): one group per region, holding that tab. */
export function migrateRegions(old: TabTree): TabGroups {
	const of: Record<string, string> = {};
	const shown: Record<string, string> = {};
	let n = 0;
	const swap = (node: TabTree): TabTree => {
		if (node.type === 'split') return { ...node, first: swap(node.first), second: swap(node.second) };
		const gid = `g${++n}`;
		of[node.id] = gid;
		shown[gid] = node.id;
		return leaf(gid);
	};
	return { tree: swap(old), of, shown };
}
