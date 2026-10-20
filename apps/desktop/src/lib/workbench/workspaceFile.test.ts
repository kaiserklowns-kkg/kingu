/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { normalizePath, parseCodeWorkspace, workspaceName, isWorkspaceFile } from './workspaceFile';
import { editorKeyFor, externalCrumbs, externalDescription, externalKey, externalPath, isExternalKey, relativeTo, tildify } from './externalFiles';

describe('.code-workspace files', () => {
	test('folders resolve against the file, with names and settings', () => {
		const text = `{
			// VS Code writes comments and trailing commas
			"folders": [
				{ "path": "." },
				{ "path": "../api", "name": "API" },
				{ "path": "/abs/web" },
				{ "uri": "file:///srv/with%20space" },
				{ "uri": "vscode-remote://ssh-remote+box/home/x" },
				{ "path": "./" },
			],
			"settings": { "editor.tabSize": 2, "files.exclude": { "**/dist": true } },
		}`;
		const w = parseCodeWorkspace(text, '/home/me/proj/proj.code-workspace');
		expect(w.folders).toEqual([
			{ path: '/home/me/proj', name: 'proj' },
			{ path: '/home/me/api', name: 'API' },
			{ path: '/abs/web', name: 'web' },
			{ path: '/srv/with space', name: 'with space' }
		]);
		expect(w.settings).toEqual({ 'editor.tabSize': 2, 'files.exclude': { '**/dist': true } });
	});

	test('a file without a folders list is not a workspace', () => {
		expect(() => parseCodeWorkspace('{"settings": {}}', '/a/b.code-workspace')).toThrow();
		expect(() => parseCodeWorkspace('not json', '/a/b.code-workspace')).toThrow();
		expect(parseCodeWorkspace('{"folders": [1, null, {"path": ""}]}', '/a/b.code-workspace')).toEqual({ folders: [], settings: {} });
	});

	test('paths and names', () => {
		expect(normalizePath('/a/b/../c/./d/')).toBe('/a/c/d');
		expect(normalizePath('/../x')).toBe('/x');
		expect(normalizePath('a/../../b')).toBe('../b');
		expect(workspaceName('/x/My App.code-workspace')).toBe('My App');
		expect(isWorkspaceFile('/x/a.CODE-WORKSPACE')).toBe(true);
		expect(isWorkspaceFile('/x/a.json')).toBe(false);
	});
});

describe('files outside the folder', () => {
	test('a picked file inside the folder opens as a workspace file, else as external', () => {
		expect(relativeTo('/w/src/a.ts', '/w')).toBe('src/a.ts');
		expect(relativeTo('/w/src/a.ts', '/w/')).toBe('src/a.ts');
		expect(relativeTo('/wx/a.ts', '/w')).toBeNull();
		expect(relativeTo('/w', '/w')).toBeNull();
		expect(relativeTo('/w/a.ts', null)).toBeNull();
		expect(editorKeyFor('/w/a.ts', '/w')).toBe('a.ts');
		expect(editorKeyFor('/etc/hosts', '/w')).toBe('external:/etc/hosts');
	});

	test('keys, labels and breadcrumbs', () => {
		const key = externalKey('/Users/me/notes/todo.md');
		expect(isExternalKey(key)).toBe(true);
		expect(isExternalKey('src/a.ts')).toBe(false);
		expect(externalPath(key)).toBe('/Users/me/notes/todo.md');
		expect(externalDescription(key, '/Users/me')).toBe('~/notes');
		expect(externalDescription(externalKey('/hosts'), '/Users/me')).toBe('/');
		expect(externalCrumbs(key)).toEqual(['Users', 'me', 'notes', 'todo.md']);
		expect(tildify('/Users/meow/x', '/Users/me')).toBe('/Users/meow/x');
		expect(tildify('/Users/me', '/Users/me')).toBe('~');
	});
});
