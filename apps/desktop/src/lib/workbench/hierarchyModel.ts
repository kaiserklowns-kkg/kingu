// The call / type hierarchy tree (references-view's CallItem / TypeItem): rows of the expanded
// nodes and where each node opens. Pure, so `bun test` covers it.

import type { CallHierarchyItem, Range } from '#lib/lsp/protocol.ts';

export type HierarchyKind = 'call' | 'type';
export type HierarchyDirection = 'incoming' | 'outgoing' | 'supertypes' | 'subtypes';

export type HierarchyNode = {
	id: string;
	item: CallHierarchyItem;
	/** Call sites (in the caller for incoming calls, in the root's chain for outgoing ones). */
	ranges: Range[];
	/** null until loaded. */
	children: HierarchyNode[] | null;
	loading: boolean;
	expanded: boolean;
};

export type HierarchyRow = { node: HierarchyNode; depth: number };

/** The rows of the expanded tree. */
export function hierarchyRows(roots: HierarchyNode[]): HierarchyRow[] {
	const out: HierarchyRow[] = [];
	const walk = (list: HierarchyNode[], depth: number) => {
		for (const node of list) {
			out.push({ node, depth });
			if (node.expanded && node.children) walk(node.children, depth + 1);
		}
	};
	walk(roots, 0);
	return out;
}

/**
 * Where a node opens: an incoming call at its first call site in the caller, anything else at the
 * item's name (references-view: CallItem / TypeItem locations).
 */
export function nodeLocation(node: HierarchyNode, direction: HierarchyDirection): { uri: string; range: Range } {
	if (direction === 'incoming' && node.ranges.length) return { uri: node.item.uri, range: node.ranges[0] };
	return { uri: node.item.uri, range: node.item.selectionRange };
}

export const defaultDirection = (kind: HierarchyKind): HierarchyDirection => (kind === 'call' ? 'incoming' : 'subtypes');
