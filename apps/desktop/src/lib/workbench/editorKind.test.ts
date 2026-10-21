import { describe, expect, test } from 'bun:test';
import { editorKind, providesOutline, showsEditorStatus } from './editorKind.ts';

describe('editorKind', () => {
	test('files, untitled, external files and diffs are documents', () => {
		for (const key of ['src/a.ts', 'untitled:Untitled-1', 'external:/etc/hosts', 'diff:src/a.ts']) expect(editorKind(key)).toBe('file');
	});
	test('the Search Editor (untitled and .code-search) is its own text model', () => {
		expect(editorKind('search-editor:1')).toBe('search');
		expect(editorKind('notes/find.code-search')).toBe('search');
	});
	test('outline is only for documents; the status bar items for any text model', () => {
		expect(providesOutline('search-editor:1')).toBe(false);
		expect(providesOutline('output:tasks')).toBe(false);
		expect(providesOutline('src/a.ts')).toBe(true);
		expect(showsEditorStatus('search-editor:1')).toBe(true);
		expect(showsEditorStatus('output:tasks')).toBe(true);
		expect(showsEditorStatus('settings://user')).toBe(false);
		expect(showsEditorStatus(null)).toBe(false);
	});
});
