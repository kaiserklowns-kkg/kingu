// Text save participants (VS Code: TrimWhitespaceParticipant, FinalNewLineParticipant,
// TrimFinalNewLinesParticipant). Pure: each returns Monaco-style edits (1-based) for the model's
// lines, applied one participant at a time so the ranges never overlap.

export type LineEdit = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number; text: string };

/**
 * `files.trimTrailingWhitespace`. Lines in `keep` (the cursors' lines on auto save) are left alone,
 * like VS Code. `skip(line, column)` says whitespace starting there must stay
 * (files.trimTrailingWhitespaceInRegexAndStrings off: it is inside a string or a regex).
 */
export function trimTrailingWhitespaceEdits(lines: readonly string[], keep: ReadonlySet<number> = new Set(), skip?: (line: number, column: number) => boolean): LineEdit[] {
	const edits: LineEdit[] = [];
	lines.forEach((line, i) => {
		const n = i + 1;
		if (keep.has(n)) return;
		const m = /[ \t]+$/.exec(line);
		if (m && !skip?.(n, m.index + 1)) edits.push({ startLineNumber: n, startColumn: m.index + 1, endLineNumber: n, endColumn: line.length + 1, text: '' });
	});
	return edits;
}

/** `files.trimFinalNewlines`: blank lines after the last line with content, keeping one final newline. */
export function trimFinalNewlinesEdit(lines: readonly string[]): LineEdit | null {
	let last = lines.length - 1;
	while (last >= 0 && lines[last].trim() === '') last--;
	// Line `last + 2` (1-based) is the one after the final newline; everything from there goes.
	const from = last + 2;
	const to = lines.length;
	if (last < 0 || from > to) return null;
	if (from === to && lines[to - 1] === '') return null;
	return { startLineNumber: from, startColumn: 1, endLineNumber: to, endColumn: lines[to - 1].length + 1, text: '' };
}

/** `files.insertFinalNewline`: a newline after the last line, unless the file is empty or already ends with one. */
export function insertFinalNewlineEdit(lines: readonly string[], eol: string): LineEdit | null {
	const n = lines.length;
	const last = lines[n - 1] ?? '';
	if (last === '') return null;
	return { startLineNumber: n, startColumn: last.length + 1, endLineNumber: n, endColumn: last.length + 1, text: eol };
}
