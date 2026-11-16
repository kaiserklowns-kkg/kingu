// Orca's "drag a tab to a pane edge to split it" (docs model/tabs-panes-splits.mdx), in Kingu's
// Agents layout: a worktree's center splits into regions, nested any way (a tree like the
// terminal's pane tree), each showing one tab — the agent, a terminal, a browser or a file. The
// active tab is one region; clicking a region makes its tab active, and picking another tab in
// the strip shows it in the active region. Views move by style only, never remounted. Also the tab layout kept across restarts
// (Orca restores every tab, not only terminals). Pure.

import type { BrowserTab, FileTab } from './adeTabs';
import { hasLeaf, leaf, leaves, parsePaneNode, removePane, splitPane, type PaneNode, type Rect } from '#lib/terminal/paneLayout.ts';

export type SplitDir = 'right' | 'down';
/** A worktree's regions: a binary tree whose leaves are tab ids (Orca's tab groups), or none. */
export type TabTree = PaneNode;

/** A tab id that can be a region: the agent tab, terminals, browsers and file/diff tabs. */
export const splittable = (id: string) => id === 'main' || /^[tb]\d+$/.test(id) || (id.startsWith('f:') && id.length > 2);

/** Orca's drop on a region's edge: `id` gets the right or bottom part of region `target`. */
export function splitTab(tree: TabTree | null, target: string, id: string, dir: SplitDir): TabTree | null {
	if (!splittable(id) || id === target) return tree;
	const base = tree && hasLeaf(tree, target) ? tree : leaf(target);
	const without = hasLeaf(base, id) ? removePane(base, id) : base;
	if (!without || !hasLeaf(without, target)) return tree;
	return splitPane(without, target, id, dir === 'right' ? 'vertical' : 'horizontal');
}

/** Showing tab `next` in the region that showed `prev` (a tab already in a region just takes focus). */
export function showIn(tree: TabTree | null, prev: string, next: string): TabTree | null {
	if (!tree || hasLeaf(tree, next) || !hasLeaf(tree, prev)) return tree;
	if (!splittable(next)) return null;
	const swap = (n: TabTree): TabTree => (n.type === 'leaf' ? (n.id === prev ? leaf(next) : n) : { ...n, first: swap(n.first), second: swap(n.second) });
	return swap(tree);
}

/** Closes region `id` (its tab stays open); one region left is no split. */
export function closeRegion(tree: TabTree | null, id: string): TabTree | null {
	const rest = tree ? removePane(tree, id) : null;
	return rest && rest.type === 'split' ? rest : null;
}

/** The tree with closed tabs' regions gone; null when fewer than two remain or `active` is not shown. */
export function liveTree(tree: TabTree | null, open: ReadonlySet<string>, active: string): TabTree | null {
	let t: TabTree | null = tree;
	for (const id of tree ? leaves(tree) : []) if (t && !open.has(id)) t = removePane(t, id);
	return t && t.type === 'split' && hasLeaf(t, active) ? t : null;
}

/** A region's CSS (fractions of the center), 2px apart from its neighbours. */
export function rectStyle(r: Rect): string {
	const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
	const gapL = r.x > 0 ? 2 : 0;
	const gapR = r.x + r.w < 0.9999 ? 2 : 0;
	const gapT = r.y > 0 ? 2 : 0;
	const gapB = r.y + r.h < 0.9999 ? 2 : 0;
	return `left:calc(${pct(r.x)} + ${gapL}px);top:calc(${pct(r.y)} + ${gapT}px);width:calc(${pct(r.w)} - ${gapL + gapR}px);height:calc(${pct(r.h)} - ${gapT + gapB}px)`;
}

/** The region under a point (fractions) and the edge of it a drop there means (its outer 30%, right or bottom). */
export function dropTarget(rects: ReadonlyMap<string, Rect>, x: number, y: number): { id: string; dir: SplitDir } | null {
	for (const [id, r] of rects) {
		if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
		const dir = dropEdge(x - r.x, y - r.y, r.w, r.h);
		return dir ? { id, dir } : null;
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
	layouts: Record<string, TabTree>;
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
		if (tabs.length) out.browsers[k] = tabs.map((b) => ({ id: b.id, url: b.url, title: b.title.slice(0, 300) }));
	}
	for (const [k, list] of Object.entries(obj(raw.files) ? raw.files : {})) {
		const tabs = (Array.isArray(list) ? list : []).filter((f): f is FileTab => obj(f) && typeof f.key === 'string' && !!f.key && !f.key.startsWith('untitled:') && f.preview !== true);
		if (tabs.length) out.files[k] = tabs.map((f) => ({ key: f.key, preview: false, ...(f.mdPreview === true ? { mdPreview: true } : {}) }));
	}
	for (const [k, v] of Object.entries(obj(raw.order) ? raw.order : {})) if (strings(v).length) out.order[k] = strings(v);
	for (const [k, v] of Object.entries(obj(raw.pinned) ? raw.pinned : {})) if (strings(v).length) out.pinned[k] = strings(v);
	for (const [k, v] of Object.entries(obj(raw.colors) ? raw.colors : {})) if (typeof v === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) out.colors[k] = v;
	for (const [k, v] of Object.entries(obj(raw.layouts) ? raw.layouts : {})) {
		const tree = parsePaneNode(v, splittable);
		if (tree && tree.type === 'split') out.layouts[k] = tree;
	}
	return out;
}
