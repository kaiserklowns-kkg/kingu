// What the problems.* settings decide (VS Code: markers.contribution.ts, markersView.ts,
// markerNavigationService.ts). Pure, so the ordering and picking are unit-tested.

import type { Diagnostic, Position } from './protocol.ts';
import type { ProblemFile } from './model.ts';

export type ProblemsSortOrder = 'severity' | 'position';

const sev = (d: Diagnostic) => d.severity ?? 1;
const byPos = (a: Position, b: Position) => a.line - b.line || a.character - b.character;

/** `problems.sortOrder`: severity then position, or position then severity (VS Code's MarkerList compare). */
export function sortProblems(items: readonly Diagnostic[], order: ProblemsSortOrder): Diagnostic[] {
	const bySeverity = (a: Diagnostic, b: Diagnostic) => sev(a) - sev(b);
	const byPosition = (a: Diagnostic, b: Diagnostic) => byPos(a.range.start, b.range.start) || byPos(a.range.end, b.range.end);
	return [...items].sort(order === 'position' ? (a, b) => byPosition(a, b) || bySeverity(a, b) : (a, b) => bySeverity(a, b) || byPosition(a, b));
}

const contains = (d: Diagnostic, p: Position) => byPos(d.range.start, p) <= 0 && byPos(p, d.range.end) <= 0;

/**
 * `problems.showCurrentInStatus`: the problem at the cursor (0-based position) — one whose range
 * holds it, else one on its line — the most severe first, like VS Code's status bar entry.
 */
export function problemAt(items: readonly Diagnostic[], pos: Position): Diagnostic | null {
	const pick = (list: Diagnostic[]) => list.sort((a, b) => sev(a) - sev(b) || byPos(a.range.start, b.range.start))[0] ?? null;
	return pick(items.filter((d) => contains(d, pos))) ?? pick(items.filter((d) => d.range.start.line <= pos.line && pos.line <= d.range.end.line));
}

export type ProblemRow = { file: ProblemFile; item: Diagnostic };

/** `problems.defaultViewMode: table`: one row per problem, files in the tree's order, items sorted. */
export function problemTable(files: readonly ProblemFile[], order: ProblemsSortOrder): ProblemRow[] {
	return files.flatMap((file) => sortProblems(file.items, order).map((item) => ({ file, item })));
}

/** A file's (or, bubbled up, a folder's) Problems decoration in the Explorer. */
export type ProblemDecoration = { severity: 'error' | 'warning'; /** Errors and warnings in the file; none on a folder. */ count?: number };

/**
 * `problems.decorations.enabled` (VS Code: MarkersDecorationsProvider): each workspace file with
 * errors or warnings gets their count and the worst one's color; its folders take the color.
 */
export function problemDecorations(files: readonly ProblemFile[]): Map<string, ProblemDecoration> {
	const out = new Map<string, ProblemDecoration>();
	for (const f of files) {
		if (f.rel === null) continue;
		const marked = f.items.filter((d) => sev(d) <= 2);
		if (!marked.length) continue;
		const severity = marked.some((d) => sev(d) === 1) ? 'error' : 'warning';
		out.set(f.rel, { severity, count: marked.length });
		const parts = f.rel.split('/');
		for (let i = 1; i < parts.length; i++) {
			const dir = parts.slice(0, i).join('/');
			const prev = out.get(dir);
			if (!prev || (prev.severity === 'warning' && severity === 'error')) out.set(dir, { severity });
		}
	}
	return out;
}

/** The badge VS Code shows: the count, `9+` from ten. */
export const problemBadge = (count: number) => (count < 10 ? String(count) : '9+');
