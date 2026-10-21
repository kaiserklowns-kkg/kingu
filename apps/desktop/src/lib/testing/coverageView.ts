// The Test Coverage view's filter and sort (VS Code: the coverage view's filter box and its Sort by
// Location / Name / Coverage action). Pure.

import type { CoverageNode, FileCoverage } from './coverage.ts';

export type CoverageSort = 'location' | 'name' | 'coverage';
export const COVERAGE_SORTS: readonly CoverageSort[] = ['location', 'name', 'coverage'];

/** Files whose path contains the filter (case-insensitive; space-separated words must all match). */
export function filterCoverageFiles(files: readonly FileCoverage[], query: string): FileCoverage[] {
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return [...files];
	return files.filter((f) => words.every((w) => f.rel.toLowerCase().includes(w)));
}

/**
 * The tree in an order: `location` keeps the tree's own (folders first, by path), `name` sorts
 * each level by label, `coverage` puts the least covered first (ties by label). Folders stay
 * above files at every level.
 */
export function sortCoverageNodes(nodes: readonly CoverageNode[], by: CoverageSort, percentOf: (n: CoverageNode) => number): CoverageNode[] {
	if (by === 'location') return [...nodes];
	const cmp = (a: CoverageNode, b: CoverageNode) => {
		if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
		if (by === 'coverage') {
			const d = percentOf(a) - percentOf(b);
			if (d) return d;
		}
		return a.label.localeCompare(b.label);
	};
	return [...nodes].sort(cmp).map((n) => (n.kind === 'folder' ? { ...n, children: sortCoverageNodes(n.children, by, percentOf) } : n));
}
