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
