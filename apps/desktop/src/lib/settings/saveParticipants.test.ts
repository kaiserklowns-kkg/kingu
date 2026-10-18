/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { insertFinalNewlineEdit, trimFinalNewlinesEdit, trimTrailingWhitespaceEdits, type LineEdit } from './saveParticipants';

/** Applies non-overlapping edits to text the way a Monaco model would. */
function apply(text: string, edits: (LineEdit | null)[]): string {
	const lines = text.split('\n');
	const offset = (line: number, col: number) => lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + col - 1;
	const sorted = edits.filter((e): e is LineEdit => e !== null).sort((a, b) => offset(b.startLineNumber, b.startColumn) - offset(a.startLineNumber, a.startColumn));
	let out = text;
	for (const e of sorted) out = out.slice(0, offset(e.startLineNumber, e.startColumn)) + e.text + out.slice(offset(e.endLineNumber, e.endColumn));
	return out;
}
const run = (text: string, fn: (lines: string[]) => LineEdit[] | LineEdit | null) => {
	const r = fn(text.split('\n'));
	return apply(text, Array.isArray(r) ? r : [r]);
};

describe('files.trimTrailingWhitespace', () => {
	test('trims spaces and tabs at line ends only', () => {
		expect(run('a  \n\tb\t\n  \nc', (l) => trimTrailingWhitespaceEdits(l))).toBe('a\n\tb\n\nc');
		expect(trimTrailingWhitespaceEdits(['clean', ''])).toEqual([]);
	});
	test('auto save keeps the lines being typed on', () => {
		expect(run('a  \nb  \nc  ', (l) => trimTrailingWhitespaceEdits(l, new Set([2])))).toBe('a\nb  \nc');
	});
});

describe('files.trimFinalNewlines', () => {
	test('keeps exactly one final newline', () => {
		expect(run('a\n\n\n', trimFinalNewlinesEdit)).toBe('a\n');
		expect(run('a\n  \n\t\n', trimFinalNewlinesEdit)).toBe('a\n');
		expect(run('a\n  ', trimFinalNewlinesEdit)).toBe('a\n');
	});
	test('nothing to do', () => {
		expect(trimFinalNewlinesEdit(['a', ''])).toBeNull();
		expect(trimFinalNewlinesEdit(['a'])).toBeNull();
		expect(trimFinalNewlinesEdit(['', ''])).toBeNull();
	});
});

describe('files.insertFinalNewline', () => {
	test('adds the model EOL once', () => {
		expect(run('a\nb', (l) => insertFinalNewlineEdit(l, '\n'))).toBe('a\nb\n');
		expect(insertFinalNewlineEdit(['a', ''], '\n')).toBeNull();
		expect(insertFinalNewlineEdit([''], '\n')).toBeNull();
		expect(insertFinalNewlineEdit(['x'], '\r\n')?.text).toBe('\r\n');
	});
});
