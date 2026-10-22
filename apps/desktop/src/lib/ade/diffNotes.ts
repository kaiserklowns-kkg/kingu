// Review notes on diff lines (Orca's diff comments): the note model, the list reducers and the
// prompt that hands them to an agent. Pure; the store (diffNotes.svelte.ts) persists each
// worktree's list in `.kingu/diff-notes.json` through Rust (agent/notes.rs, same shape).

import { t } from '#lib/i18n/index.ts';

/** Orca's DiffComment, minus the fields Kingu has no use for yet (markdown notes, sentAt, scope). */
export type DiffNote = {
	id: string;
	/** Relative to the worktree. */
	filePath: string;
	/** Inclusive range start; absent for a single line. */
	startLine?: number;
	/** The range end, or the only line; 0 is a note on the whole file. */
	lineNumber: number;
	body: string;
	createdAt: number;
	updatedAt?: number;
};

export type NoteTarget = { lineNumber: number; startLine?: number };

/** Notes of every worktree: '' is the folder itself, any other key a task slug. */
export type NotesByWorktree = Record<string, DiffNote[]>;

/** Orca's toDiffCommentLineTarget: a range is end + start; one line has no start. */
export function lineTarget(a: number, b = a): NoteTarget {
	const start = Math.min(a, b);
	const end = Math.max(a, b);
	return start === end ? { lineNumber: end } : { lineNumber: end, startLine: start };
}

/** Orca's normalizeDiffComment: a start outside 1..lineNumber is dropped. */
export function normalizeNote(n: DiffNote): DiffNote {
	const { startLine, ...rest } = n;
	return startLine !== undefined && Number.isInteger(startLine) && startLine >= 1 && startLine < n.lineNumber ? { ...rest, startLine } : rest;
}

export function parseNotes(raw: unknown): NotesByWorktree {
	if (!raw || typeof raw !== 'object') return {};
	const out: NotesByWorktree = {};
	for (const [key, list] of Object.entries(raw as Record<string, unknown>)) {
		if (!Array.isArray(list)) continue;
		const notes = list.filter(
			(n): n is DiffNote =>
				!!n && typeof n === 'object' && typeof n.id === 'string' && typeof n.filePath === 'string' && Number.isInteger(n.lineNumber) && n.lineNumber >= 0 && typeof n.body === 'string' && n.body.trim() !== ''
		);
		if (notes.length) out[key] = notes.map(normalizeNote);
	}
	return out;
}

export function addNote(list: DiffNote[], input: { id: string; filePath: string; body: string } & NoteTarget, now: number): DiffNote[] {
	const body = input.body.trim();
	if (!body) return list;
	return [...list, normalizeNote({ id: input.id, filePath: input.filePath, lineNumber: input.lineNumber, startLine: input.startLine, body, createdAt: now })];
}

/** Orca's updateDiffComment: an empty body is refused (delete the note instead). */
export function updateNote(list: DiffNote[], id: string, body: string, now: number): DiffNote[] {
	const text = body.trim();
	if (!text) return list;
	return list.map((n) => (n.id === id ? { ...n, body: text, updatedAt: now } : n));
}

export const deleteNote = (list: DiffNote[], id: string) => list.filter((n) => n.id !== id);

/**
 * Orca's clearDeliveredDiffComments: removes the notes that were sent, but only while they still
 * match what was sent, so a note edited during the send stays to be sent again.
 */
export function clearDelivered(list: DiffNote[], sent: DiffNote[]): DiffNote[] {
	const sig = (n: DiffNote) => JSON.stringify([n.id, n.filePath, n.lineNumber, n.startLine ?? null, n.body]);
	const delivered = new Set(sent.map(sig));
	return list.filter((n) => !delivered.has(sig(n)));
}

/** Lines of context around a change that also take notes (git's default hunk context). */
const CONTEXT = 3;

/** Lines of the modified side that take notes, from the diff's line changes. */
export function commentableLines(changes: readonly { modifiedStartLineNumber: number; modifiedEndLineNumber: number }[], lineCount: number): Set<number> {
	const lines = new Set<number>();
	for (const c of changes) {
		// A pure deletion has no modified lines: modifiedStart is the line before it.
		const end = c.modifiedEndLineNumber === 0 ? c.modifiedStartLineNumber : c.modifiedEndLineNumber;
		for (let l = Math.max(1, c.modifiedStartLineNumber - CONTEXT); l <= Math.min(lineCount, end + CONTEXT); l++) lines.add(l);
	}
	return lines;
}

/** Notes of one file, in line order (the order the diff shows them). */
export function notesOfFile(list: DiffNote[], filePath: string): DiffNote[] {
	return list.filter((n) => n.filePath === filePath).sort((a, b) => a.lineNumber - b.lineNumber || a.createdAt - b.createdAt);
}

/** Every note in file, then line order (the list and the prompt). */
export const sortedNotes = (list: DiffNote[]) => [...list].sort((a, b) => a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber || a.createdAt - b.createdAt);

export const locationLabel = (n: Pick<DiffNote, 'lineNumber' | 'startLine'>) =>
	n.lineNumber === 0 ? t('ade.diffNotes.wholeFile') : n.startLine !== undefined && n.startLine !== n.lineNumber ? t('ade.diffNotes.lines', { start: n.startLine, end: n.lineNumber }) : t('ade.diffNotes.line', { line: n.lineNumber });

/**
 * Orca's formatDiffComment, verbatim: the pasted format is the contract between review notes and
 * the agent that reads them, so it stays deterministic and quote-safe (English labels, as Orca).
 */
export function formatNote(c: DiffNote): string {
	const escaped = c.body.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
	const location = c.lineNumber === 0 ? 'Scope: file' : c.startLine !== undefined && c.startLine !== c.lineNumber ? `Lines: ${c.startLine}-${c.lineNumber}` : `Line: ${c.lineNumber}`;
	return [`File: ${c.filePath}`, location, `User comment: "${escaped}"`].join('\n');
}

export const formatNotes = (notes: readonly DiffNote[]) => notes.map(formatNote).join('\n\n');

/**
 * How the notes reach the task's agent: typed into its running CLI terminal (bracketed paste),
 * launched in that worktree terminal when it is not running, or copied for the root folder.
 */
export type Delivery = 'cli' | 'launch' | 'none';

export function deliveryFor(t: { isTask: boolean; cli: boolean; cliRunning: boolean }): Delivery {
	if (!t.isTask) return 'none';
	return t.cli && t.cliRunning ? 'cli' : 'launch';
}
