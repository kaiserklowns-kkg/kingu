/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { WorkspaceEdit } from './protocol';
import {
	checkState,
	editLine,
	filterWorkspaceEdit,
	initialChecked,
	isRefactorPreviewKey,
	needsPreview,
	previewEdits,
	previewText,
	previewTree,
	refactorPreviewKey,
	toggleEdits
} from './refactorPreview';

const r = (line: number, a: number, b: number) => ({ start: { line, character: a }, end: { line, character: b } });
const A = 'file:///w/a.ts';
const B = 'file:///w/b.ts';

const changes: WorkspaceEdit = {
	changes: {
		[A]: [
			{ range: r(0, 0, 3), newText: 'bar' },
			{ range: r(1, 4, 7), newText: 'bar' }
		],
		[B]: [{ range: r(2, 0, 3), newText: 'bar' }]
	}
};

const annotated: WorkspaceEdit = {
	documentChanges: [
		{ textDocument: { uri: A, version: 1 }, edits: [{ range: r(0, 0, 3), newText: 'bar', annotationId: 'decl' }, { range: r(1, 4, 7), newText: 'bar', annotationId: 'ref' }] },
		{ kind: 'create', uri: 'file:///w/c.ts' },
		{ textDocument: { uri: B, version: null }, edits: [{ range: r(2, 0, 3), newText: 'bar', annotationId: 'ref' }] }
	],
	changeAnnotations: {
		decl: { label: 'Rename declaration' },
		ref: { label: 'Update references in comments', needsConfirmation: true, description: 'textual matches' },
		unused: { label: 'Never used' }
	}
};

describe('previewEdits / previewTree', () => {
	test('ids are group:index in both forms; resource operations are skipped', () => {
		expect(previewEdits(changes).map((e) => [e.id, e.uri])).toEqual([
			['0:0', A],
			['0:1', A],
			['1:0', B]
		]);
		expect(previewEdits(annotated).map((e) => [e.id, e.uri, e.annotationId])).toEqual([
			['0:0', A, 'decl'],
			['0:1', A, 'ref'],
			['2:0', B, 'ref']
		]);
	});

	test('no annotations: one unnamed category of files', () => {
		const tree = previewTree(changes);
		expect(tree.map((c) => c.label)).toEqual(['']);
		expect(tree[0].files.map((f) => [f.uri, f.edits.length])).toEqual([
			[A, 2],
			[B, 1]
		]);
	});

	test('annotations: a category per label, in first-seen order', () => {
		const tree = previewTree(annotated);
		expect(tree.map((c) => [c.label, c.annotation?.needsConfirmation ?? false])).toEqual([
			['Rename declaration', false],
			['Update references in comments', true]
		]);
		expect(tree[1].files.map((f) => [f.uri, f.edits.map((e) => e.id)])).toEqual([
			[A, ['0:1']],
			[B, ['2:0']]
		]);
	});

	test('an annotation id the edit does not define counts as none', () => {
		const tree = previewTree({ documentChanges: [{ textDocument: { uri: A, version: null }, edits: [{ range: r(0, 0, 1), newText: 'x', annotationId: 'missing' }] }] });
		expect(tree.map((c) => c.label)).toEqual(['']);
	});
});

describe('needsPreview / initialChecked', () => {
	test('a needsConfirmation annotation in use asks for a preview', () => {
		expect(needsPreview(changes)).toBe(false);
		expect(needsPreview(annotated)).toBe(true);
		// Defined but unused: no.
		const unusedOnly: WorkspaceEdit = { ...changes, changeAnnotations: { x: { label: 'x', needsConfirmation: true } } };
		expect(needsPreview(unusedOnly)).toBe(false);
	});

	test('an explicit request previews any non-empty edit', () => {
		expect(needsPreview(changes, { preview: true })).toBe(true);
		expect(needsPreview({ changes: {} }, { preview: true })).toBe(false);
	});

	test('edits that need confirmation start unchecked', () => {
		expect([...initialChecked(annotated)]).toEqual(['0:0']);
		expect([...initialChecked(changes)]).toEqual(['0:0', '0:1', '1:0']);
	});
});

describe('checkState / toggleEdits', () => {
	const edits = previewEdits(changes);
	test('all, none, some', () => {
		expect(checkState(edits, new Set(['0:0', '0:1', '1:0']))).toBe('all');
		expect(checkState(edits, new Set())).toBe('none');
		expect(checkState(edits, new Set(['0:1']))).toBe('some');
	});
	test('toggling checks all unless all are checked', () => {
		expect([...toggleEdits(edits, new Set(['0:1']))].sort()).toEqual(['0:0', '0:1', '1:0']);
		expect([...toggleEdits(edits, new Set(['0:0', '0:1', '1:0', 'x']))]).toEqual(['x']);
	});
});

describe('filterWorkspaceEdit', () => {
	test('changes: keeps checked edits, drops emptied documents', () => {
		expect(filterWorkspaceEdit(changes, new Set(['0:1']))).toEqual({ changes: { [A]: [{ range: r(1, 4, 7), newText: 'bar' }] } });
		expect(filterWorkspaceEdit(changes, new Set())).toEqual({ changes: {} });
		expect(filterWorkspaceEdit(changes, new Set(['0:0', '0:1', '1:0']))).toEqual(changes);
	});

	test('documentChanges: keeps versions, resource operations, and only used annotations', () => {
		const out = filterWorkspaceEdit(annotated, new Set(['0:0']));
		expect(out).toEqual({
			documentChanges: [{ textDocument: { uri: A, version: 1 }, edits: [{ range: r(0, 0, 3), newText: 'bar', annotationId: 'decl' }] }, { kind: 'create', uri: 'file:///w/c.ts' }],
			changeAnnotations: { decl: { label: 'Rename declaration' } }
		});
	});

	test('documentChanges: nothing checked leaves no annotations', () => {
		const out = filterWorkspaceEdit(annotated, new Set());
		expect(out.changeAnnotations).toBeUndefined();
		expect(out.documentChanges).toEqual([{ kind: 'create', uri: 'file:///w/c.ts' }]);
	});

	test('a resource operation keeps its annotation', () => {
		const edit: WorkspaceEdit = { documentChanges: [{ kind: 'delete', uri: B, annotationId: 'del' }], changeAnnotations: { del: { label: 'Delete' } } };
		expect(filterWorkspaceEdit(edit, new Set())).toEqual(edit);
	});

	test('does not modify its input', () => {
		const copy = JSON.parse(JSON.stringify(annotated));
		filterWorkspaceEdit(annotated, new Set(['2:0']));
		expect(annotated).toEqual(copy);
	});
});

describe('previewText / editLine', () => {
	const text = 'foo();\nlet foo = 1;\nfoo\n';
	test('applies only the checked edits of that document', () => {
		expect(previewText(changes, A, text, new Set(['0:0', '0:1', '1:0']))).toBe('bar();\nlet bar = 1;\nfoo\n');
		expect(previewText(changes, A, text, new Set(['0:1']))).toBe('foo();\nlet bar = 1;\nfoo\n');
		expect(previewText(changes, B, text, new Set(['0:0']))).toBe(text);
	});

	test('several TextDocumentEdits of one document apply in order', () => {
		const edit: WorkspaceEdit = {
			documentChanges: [
				{ textDocument: { uri: A, version: null }, edits: [{ range: r(0, 0, 3), newText: 'ab' }] },
				{ textDocument: { uri: A, version: null }, edits: [{ range: r(0, 0, 2), newText: 'c' }] }
			]
		};
		expect(previewText(edit, A, text, new Set(['0:0', '1:0']))).toBe('c();\nlet foo = 1;\nfoo\n');
	});

	test('the line around an edit', () => {
		expect(editLine(text, { range: r(1, 4, 7), newText: 'bar' })).toEqual({ line: 2, before: 'let ', removed: 'foo', inserted: 'bar', after: ' = 1;' });
		expect(editLine('  x\n', { range: r(0, 3, 3), newText: 'y\nz' })).toEqual({ line: 1, before: 'x', removed: '', inserted: 'y', after: '' });
	});
});

test('diff tab keys', () => {
	expect(refactorPreviewKey('src/a.ts')).toBe('refactorpreview:src/a.ts');
	expect(isRefactorPreviewKey('refactorpreview:src/a.ts')).toBe(true);
	expect(isRefactorPreviewKey('src/a.ts')).toBe(false);
});
