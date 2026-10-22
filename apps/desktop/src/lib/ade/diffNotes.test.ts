import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	addNote,
	clearDelivered,
	commentableLines,
	deleteNote,
	deliveryFor,
	formatNote,
	formatNotes,
	lineTarget,
	locationLabel,
	notesOfFile,
	parseNotes,
	sortedNotes,
	updateNote,
	type DiffNote
} from './diffNotes';
import { setLocale } from '#lib/i18n/index.ts';

// These tests check the Thai UI text.
beforeAll(() => setLocale('th'));
afterAll(() => setLocale('en'));

const note = (over: Partial<DiffNote> = {}): DiffNote => ({ id: 'n1', filePath: 'src/a.ts', lineNumber: 3, body: 'fix', createdAt: 1, ...over });

describe('prompt format (Orca formatDiffComment, verbatim)', () => {
	test('single line, range and whole file', () => {
		expect(formatNote(note())).toBe('File: src/a.ts\nLine: 3\nUser comment: "fix"');
		expect(formatNote(note({ startLine: 10, lineNumber: 14 }))).toBe('File: src/a.ts\nLines: 10-14\nUser comment: "fix"');
		expect(formatNote(note({ startLine: 3, lineNumber: 3 }))).toBe('File: src/a.ts\nLine: 3\nUser comment: "fix"');
		expect(formatNote(note({ lineNumber: 0 }))).toBe('File: src/a.ts\nScope: file\nUser comment: "fix"');
	});

	test('the body is quote-safe on one line', () => {
		expect(formatNote(note({ body: 'why "any"?\r\nแก้ C:\\path' }))).toBe('File: src/a.ts\nLine: 3\nUser comment: "why \\"any\\"?\\r\\nแก้ C:\\\\path"');
	});

	test('notes are separated by a blank line', () => {
		const text = formatNotes([note({ startLine: 10, lineNumber: 14, body: 'rename this\nand add a test' }), note({ id: 'n2', filePath: 'src/b.ts', body: 'why "any"?' })]);
		expect(text).toBe('File: src/a.ts\nLines: 10-14\nUser comment: "rename this\\nand add a test"\n\nFile: src/b.ts\nLine: 3\nUser comment: "why \\"any\\"?"');
	});
});

describe('note list', () => {
	test('add trims, refuses empty, normalizes the range', () => {
		const list = addNote([], { id: 'a', filePath: 'x.ts', body: '  ok  ', ...lineTarget(9, 4) }, 5);
		expect(list).toEqual([{ id: 'a', filePath: 'x.ts', startLine: 4, lineNumber: 9, body: 'ok', createdAt: 5 }]);
		expect(addNote(list, { id: 'b', filePath: 'x.ts', body: '  ', lineNumber: 1 }, 6)).toBe(list);
		expect(lineTarget(7)).toEqual({ lineNumber: 7 });
	});

	test('update keeps the old body for an empty edit; delete removes', () => {
		const list = [note()];
		expect(updateNote(list, 'n1', ' new ', 9)).toEqual([{ ...note(), body: 'new', updatedAt: 9 }]);
		expect(updateNote(list, 'n1', '  ', 9)).toBe(list);
		expect(deleteNote(list, 'n1')).toEqual([]);
	});

	test('delivered notes go, a note edited during the send stays', () => {
		const a = note({ id: 'a' });
		const b = note({ id: 'b', body: 'two' });
		const c = note({ id: 'c', body: 'three' });
		const list = [a, { ...b, body: 'two (edited)' }, c];
		expect(clearDelivered(list, [a, b])).toEqual([{ ...b, body: 'two (edited)' }, c]);
	});

	test('order: file then line', () => {
		const list = [note({ id: '1', filePath: 'b.ts', lineNumber: 1 }), note({ id: '2', lineNumber: 9 }), note({ id: '3', lineNumber: 2 })];
		expect(sortedNotes(list).map((n) => n.id)).toEqual(['1', '3', '2']);
		expect(notesOfFile(list, 'src/a.ts').map((n) => n.id)).toEqual(['3', '2']);
		expect(locationLabel({ lineNumber: 4, startLine: 2 })).toBe('บรรทัด 2-4');
	});

	test('the stored file (Rust agent/notes.rs shape) parses; junk is dropped', () => {
		const raw = { t: [{ id: 'a', filePath: 'x.rs', lineNumber: 2, startLine: 5, body: 'b', createdAt: 1 }, { id: 'bad' }], '': [], x: 'no' };
		expect(parseNotes(raw)).toEqual({ t: [{ id: 'a', filePath: 'x.rs', lineNumber: 2, body: 'b', createdAt: 1 }] });
		expect(parseNotes(null)).toEqual({});
	});
});

describe('commentable lines', () => {
	test('changed lines plus three lines of context, clamped to the file', () => {
		const lines = commentableLines([{ modifiedStartLineNumber: 5, modifiedEndLineNumber: 6 }], 20);
		expect([...lines].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
		expect([...commentableLines([{ modifiedStartLineNumber: 1, modifiedEndLineNumber: 1 }], 2)]).toEqual([1, 2]);
	});
	test('a pure deletion takes the lines around it', () => {
		expect([...commentableLines([{ modifiedStartLineNumber: 4, modifiedEndLineNumber: 0 }], 10)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
	});
});

describe('delivery', () => {
	test('running CLI types, idle or legacy tasks launch a terminal agent, the folder copies', () => {
		expect(deliveryFor({ isTask: true, cli: true, cliRunning: true })).toBe('cli');
		expect(deliveryFor({ isTask: true, cli: true, cliRunning: false })).toBe('launch');
		expect(deliveryFor({ isTask: true, cli: false, cliRunning: false })).toBe('launch');
		expect(deliveryFor({ isTask: false, cli: false, cliRunning: false })).toBe('none');
	});
});
