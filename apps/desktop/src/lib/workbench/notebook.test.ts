import { describe, expect, test } from 'bun:test';
import {
	changeKindOps,
	clearOutputsOps,
	deleteCellOps,
	detectIndent,
	insertCellOps,
	isNotebookPath,
	joinCellOps,
	moveCellOps,
	newCell,
	NotebookHistory,
	notebookHeadings,
	notebookLanguage,
	parseNotebookDocument,
	serializeNotebook,
	splitCellOps,
	splitLines,
	type NbDocument
} from './notebook';

const sample = {
	metadata: { language_info: { name: 'python' }, kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
	nbformat: 4,
	nbformat_minor: 5,
	cells: [
		{ cell_type: 'markdown', id: 'm1', metadata: {}, source: ['# Title\n', 'text'], attachments: { 'a.png': { 'image/png': 'iVBO' } } },
		{
			cell_type: 'code',
			id: 'c1',
			execution_count: 3,
			metadata: { tags: ['x'] },
			source: 'print(1)',
			outputs: [
				{ output_type: 'stream', name: 'stdout', text: ['1\n'] },
				{ output_type: 'display_data', data: { 'image/png': 'iVBO\nRw==', 'text/plain': ['<Figure>'] }, metadata: {} }
			]
		},
		{ cell_type: 'raw', id: 'r1', metadata: {}, source: [] }
	]
};

const doc = (): NbDocument => parseNotebookDocument(JSON.stringify(sample, null, 1));
const sources = (d: NbDocument) => d.cells.map((c) => `${c.kind}:${c.source}`);

describe('parse', () => {
	test('cells keep their ids, metadata and other fields', () => {
		const d = doc();
		expect(notebookLanguage(d)).toBe('python');
		expect(d.minor).toBe(5);
		expect(d.cells.map((c) => c.key)).toEqual(['m1', 'c1', 'r1']);
		expect(d.cells[0]).toMatchObject({ kind: 'markdown', source: '# Title\ntext', outputs: [], count: null, rest: { attachments: { 'a.png': { 'image/png': 'iVBO' } } } });
		expect(d.cells[1]).toMatchObject({ count: 3, metadata: { tags: ['x'] } });
		expect(d.cells[1].outputs).toHaveLength(2);
	});

	test('empty files, duplicate ids, not a notebook', () => {
		expect(parseNotebookDocument('').cells).toHaveLength(1);
		const dup = parseNotebookDocument(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'code', id: 'a', source: '' }, { cell_type: 'code', id: 'a', source: '' }] }));
		expect(new Set(dup.cells.map((c) => c.key)).size).toBe(2);
		expect(() => parseNotebookDocument('{"a":1}')).toThrow();
		expect(isNotebookPath('a/b.IPYNB')).toBe(true);
		expect(isNotebookPath('preview:a.ipynb')).toBe(false);
	});
});

describe('serialize', () => {
	test('round trip is stable: sorted keys, lines, indent, trailing newline', () => {
		const text = serializeNotebook(doc());
		expect(text.endsWith('}\n')).toBe(true);
		expect(serializeNotebook(parseNotebookDocument(text))).toBe(text);
		const json = JSON.parse(text);
		expect(Object.keys(json)).toEqual(['cells', 'metadata', 'nbformat', 'nbformat_minor']);
		expect(Object.keys(json.cells[1])).toEqual(['cell_type', 'execution_count', 'id', 'metadata', 'outputs', 'source']);
		expect(json.cells[0].source).toEqual(['# Title\n', 'text']);
		expect(json.cells[0].attachments).toEqual({ 'a.png': { 'image/png': 'iVBO' } });
		expect(json.cells[2].source).toEqual([]);
		// Text mimes as lines; base64 images stay one string.
		expect(json.cells[1].outputs[1].data).toEqual({ 'image/png': 'iVBO\nRw==', 'text/plain': ['<Figure>'] });
		expect(text.split('\n')[1]).toBe(' "cells": [');
	});

	test('the file indent is kept; no ids before nbformat 4.5', () => {
		const old = { ...sample, nbformat_minor: 2 };
		const text = serializeNotebook(parseNotebookDocument(JSON.stringify(old, null, 2)));
		expect(text.split('\n')[1]).toBe('  "cells": [');
		expect(JSON.parse(text).cells[0].id).toBeUndefined();
		expect(detectIndent('{\n\t"a": 1}')).toBe('\t');
		expect(splitLines('a\nb\n')).toEqual(['a\n', 'b\n']);
		expect(splitLines('')).toEqual([]);
	});

	test('kernel outputs are written as nbformat lines', () => {
		const d = doc();
		d.cells[1].outputs = [{ output_type: 'stream', name: 'stdout', text: 'a\nb' }, { output_type: 'execute_result', execution_count: 1, data: { 'text/html': '<b>\n</b>', 'application/json': { a: 1 } }, metadata: {} }];
		const out = JSON.parse(serializeNotebook(d)).cells[1].outputs;
		expect(out[0].text).toEqual(['a\n', 'b']);
		expect(out[1].data).toEqual({ 'application/json': { a: 1 }, 'text/html': ['<b>\n', '</b>'] });
	});
});

describe('edits and undo', () => {
	test('insert, delete, move with undo / redo', () => {
		const d = doc();
		const h = new NotebookHistory();
		h.apply(d, insertCellOps(1, newCell('code', 'x = 1')));
		expect(sources(d)).toEqual(['markdown:# Title\ntext', 'code:x = 1', 'code:print(1)', 'raw:']);
		h.apply(d, moveCellOps(d, 1, 1)!);
		expect(sources(d)[2]).toBe('code:x = 1');
		h.apply(d, deleteCellOps(d, 0)!);
		expect(d.cells).toHaveLength(3);
		expect(h.undo(d) && h.undo(d) && h.undo(d)).toBe(true);
		expect(sources(d)).toEqual(sources(doc()));
		expect(h.version).toBe(0);
		expect(h.redo(d)).toBe(true);
		expect(d.cells).toHaveLength(4);
		expect(moveCellOps(d, 0, -1)).toBeNull();
		expect(moveCellOps(d, 3, 1)).toBeNull();
	});

	test('change type keeps the source and drops outputs off code', () => {
		const d = doc();
		const h = new NotebookHistory();
		h.apply(d, changeKindOps(d, 1, 'markdown')!);
		expect(d.cells[1]).toMatchObject({ kind: 'markdown', source: 'print(1)', outputs: [], count: null, key: 'c1' });
		h.apply(d, changeKindOps(d, 0, 'code')!);
		expect(d.cells[0].rest.attachments).toBeUndefined();
		expect(changeKindOps(d, 0, 'code')).toBeNull();
		h.undo(d);
		h.undo(d);
		expect(d.cells[1].outputs).toHaveLength(2);
		expect(d.cells[0].rest.attachments).toBeDefined();
	});

	test('split at the cursor and join back', () => {
		const d = parseNotebookDocument(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'code', id: 'a', source: 'a = 1\nb = 2\nc = 3', outputs: [], metadata: {} }] }));
		const h = new NotebookHistory();
		h.apply(d, splitCellOps(d, 0, [6, 12])!);
		expect(sources(d)).toEqual(['code:a = 1', 'code:b = 2', 'code:c = 3']);
		expect(d.cells[0].key).toBe('a');
		h.apply(d, joinCellOps(d, 0)!);
		expect(sources(d)).toEqual(['code:a = 1\nb = 2', 'code:c = 3']);
		h.undo(d);
		h.undo(d);
		expect(sources(d)).toEqual(['code:a = 1\nb = 2\nc = 3']);
		expect(splitCellOps(d, 0, [0])).toBeNull();
	});

	test('join needs two cells of one kind; outputs follow each other', () => {
		const d = doc();
		expect(joinCellOps(d, 0)).toBeNull();
		expect(joinCellOps(d, 2)).toBeNull();
		d.cells.splice(2, 0, newCell('code', 'y'));
		d.cells[2].outputs = [{ output_type: 'stream', name: 'stdout', text: 'y' }];
		new NotebookHistory().apply(d, joinCellOps(d, 1)!);
		expect(d.cells[1].outputs).toHaveLength(3);
	});

	test('clear outputs is one undoable step', () => {
		const d = doc();
		const h = new NotebookHistory();
		h.apply(d, clearOutputsOps(d));
		expect(d.cells[1]).toMatchObject({ outputs: [], count: null });
		expect(clearOutputsOps(d)).toEqual([]);
		h.undo(d);
		expect(d.cells[1].count).toBe(3);
	});

	test('changes outside the stack move the version on', () => {
		const h = new NotebookHistory();
		const v = h.version;
		h.touch();
		expect(h.version).not.toBe(v);
	});
});

describe('outline', () => {
	test('markdown headers as a tree, not inside code fences or code cells', () => {
		const cells = [
			{ kind: 'markdown' as const, source: '# Intro\ntext\n## Setup\n```\n# not a header\n```' },
			{ kind: 'code' as const, source: '# comment' },
			{ kind: 'markdown' as const, source: 'Results\n=======\n### Detail ###' },
			{ kind: 'markdown' as const, source: '## Appendix' }
		];
		const tree = notebookHeadings(cells);
		expect(tree.map((h) => [h.text, h.level, h.cell])).toEqual([
			['Intro', 1, 0],
			['Results', 1, 2]
		]);
		expect(tree[0].children.map((h) => h.text)).toEqual(['Setup']);
		expect(tree[1].children.map((h) => h.text)).toEqual(['Detail', 'Appendix']);
	});
});
