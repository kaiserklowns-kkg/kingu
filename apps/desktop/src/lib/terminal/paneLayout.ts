// Split terminal panes (pure, so `bun test` covers it). One tree per terminal tab, like Orca's
// TerminalPaneLayoutNode: a leaf is a pane (its id is also its PTY's id), a split holds two
// children side by side ('vertical', Orca's split right) or stacked ('horizontal', split down)
// with `ratio` the first child's share. The IDE panel uses the same tree for VS Code's terminal
// groups, equalized after every split and close the way VS Code distributes its split view.

export type SplitDirection = 'vertical' | 'horizontal';
export type PaneNode = { type: 'leaf'; id: string } | { type: 'split'; direction: SplitDirection; first: PaneNode; second: PaneNode; ratio?: number };
/** Fractions of the tab's area (0..1). */
export type Rect = { x: number; y: number; w: number; h: number };
/** Child path from the root: 0 = first, 1 = second. */
export type PanePath = (0 | 1)[];

export const leaf = (id: string): PaneNode => ({ type: 'leaf', id });

/** Pane ids in tree order (left to right, top to bottom). */
export function leaves(node: PaneNode): string[] {
	return node.type === 'leaf' ? [node.id] : [...leaves(node.first), ...leaves(node.second)];
}

export function hasLeaf(node: PaneNode, id: string): boolean {
	return node.type === 'leaf' ? node.id === id : hasLeaf(node.first, id) || hasLeaf(node.second, id);
}

/** Splits pane `target`: it and the new pane `id` share its place (the new one second, unless `newFirst`). */
export function splitPane(node: PaneNode, target: string, id: string, direction: SplitDirection, newFirst = false): PaneNode {
	if (node.type === 'leaf') {
		if (node.id !== target) return node;
		const added = leaf(id);
		return { type: 'split', direction, first: newFirst ? added : node, second: newFirst ? node : added };
	}
	return { ...node, first: splitPane(node.first, target, id, direction, newFirst), second: splitPane(node.second, target, id, direction, newFirst) };
}

/** Removes pane `id`; its sibling takes the parent split's place. Null when it was the only pane. */
export function removePane(node: PaneNode, id: string): PaneNode | null {
	if (node.type === 'leaf') return node.id === id ? null : node;
	const first = removePane(node.first, id);
	const second = removePane(node.second, id);
	if (!first) return second;
	if (!second) return first;
	return first === node.first && second === node.second ? node : { ...node, first, second };
}

/** Sets the ratio of the split at `path` (kept between 5% and 95%). */
export function setRatio(node: PaneNode, path: PanePath, ratio: number): PaneNode {
	if (node.type === 'leaf') return node;
	if (!path.length) return { ...node, ratio: Math.min(0.95, Math.max(0.05, ratio)) };
	const [head, ...rest] = path;
	return head === 0 ? { ...node, first: setRatio(node.first, rest, ratio) } : { ...node, second: setRatio(node.second, rest, ratio) };
}

/** Orca's equalize: a child's weight is 1, or its pane count along the same axis, so three panes side by side get a third each. */
export function equalize(node: PaneNode): PaneNode {
	if (node.type === 'leaf') return node;
	const first = equalize(node.first);
	const second = equalize(node.second);
	const a = weight(first, node.direction);
	const b = weight(second, node.direction);
	return { type: 'split', direction: node.direction, first, second, ratio: a / (a + b) };
}

function weight(node: PaneNode, axis: SplitDirection): number {
	if (node.type === 'leaf' || node.direction !== axis) return 1;
	return Math.max(1, weight(node.first, axis) + weight(node.second, axis));
}

/** Where each pane sits. */
export function paneRects(node: PaneNode, rect: Rect = { x: 0, y: 0, w: 1, h: 1 }, out = new Map<string, Rect>()): Map<string, Rect> {
	if (node.type === 'leaf') {
		out.set(node.id, rect);
		return out;
	}
	const [a, b] = splitRect(rect, node.direction, node.ratio ?? 0.5);
	paneRects(node.first, a, out);
	paneRects(node.second, b, out);
	return out;
}

function splitRect(r: Rect, direction: SplitDirection, ratio: number): [Rect, Rect] {
	if (direction === 'vertical') {
		const w = r.w * ratio;
		return [{ ...r, w }, { ...r, x: r.x + w, w: r.w - w }];
	}
	const h = r.h * ratio;
	return [{ ...r, h }, { ...r, y: r.y + h, h: r.h - h }];
}

/** A divider between the two children of the split at `path`; `area` is that split's rect. */
export type Divider = { path: PanePath; direction: SplitDirection; area: Rect; ratio: number };

export function dividers(node: PaneNode, rect: Rect = { x: 0, y: 0, w: 1, h: 1 }, path: PanePath = []): Divider[] {
	if (node.type === 'leaf') return [];
	const ratio = node.ratio ?? 0.5;
	const [a, b] = splitRect(rect, node.direction, ratio);
	return [{ path, direction: node.direction, area: rect, ratio }, ...dividers(node.first, a, [...path, 0]), ...dividers(node.second, b, [...path, 1])];
}

/** The pane after (`step` 1) or before (-1) `current` in `order`, wrapping around. */
export function cyclePane(order: string[], current: string, step: 1 | -1): string {
	if (!order.length) return current;
	const i = order.indexOf(current);
	return order[(Math.max(i, 0) + step + order.length) % order.length];
}

/** A persisted tree, or null when it is not one (anything unexpected starts the tab over). */
export function parsePaneNode(raw: unknown, validId: (id: string) => boolean, depth = 0): PaneNode | null {
	if (depth > 16 || typeof raw !== 'object' || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (r.type === 'leaf') return typeof r.id === 'string' && validId(r.id) ? leaf(r.id) : null;
	if (r.type !== 'split' || (r.direction !== 'vertical' && r.direction !== 'horizontal')) return null;
	const first = parsePaneNode(r.first, validId, depth + 1);
	const second = parsePaneNode(r.second, validId, depth + 1);
	if (!first || !second) return null;
	const ratio = typeof r.ratio === 'number' && r.ratio > 0 && r.ratio < 1 ? r.ratio : undefined;
	const ids = [...leaves(first), ...leaves(second)];
	if (new Set(ids).size !== ids.length) return null;
	return { type: 'split', direction: r.direction, first, second, ...(ratio !== undefined ? { ratio } : {}) };
}
