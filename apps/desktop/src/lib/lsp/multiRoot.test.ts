/// <reference types="bun" />
// Language servers in a multi-root workspace: URI ⇄ workbench key, the folder list a server is
// given, and `workspace/didChangeWorkspaceFolders` when folders are added or removed.
import { describe, expect, test } from 'bun:test';
import { LanguageClient } from './client';
import { folderChanges, keyOfModelPath, keyOfUri, lspFolders, modelPathOf, uriOfRel } from './convert';
import { DiagnosticsIndex } from './model';

const FOLDERS = [
	{ path: '/w/app', name: 'app' },
	{ path: '/w/my lib', name: 'Lib' },
	{ path: '/w/app/pkg', name: 'pkg' }
];

describe('workbench keys of LSP URIs', () => {
	test('relative in the first folder, absolute in another, null outside', () => {
		expect(keyOfUri(FOLDERS, 'file:///w/app/src/a.ts')).toBe('src/a.ts');
		expect(keyOfUri(FOLDERS, 'file:///w/my%20lib/src/b.ts')).toBe('/w/my lib/src/b.ts');
		// A root folder nested in the first one owns its files.
		expect(keyOfUri(FOLDERS, 'file:///w/app/pkg/c.ts')).toBe('/w/app/pkg/c.ts');
		expect(keyOfUri(FOLDERS, 'file:///elsewhere/x.ts')).toBeNull();
		expect(keyOfUri(FOLDERS, 'file:///w/app')).toBeNull();
		expect(keyOfUri(FOLDERS, 'untitled:1')).toBeNull();
		expect(keyOfUri([], 'file:///w/app/a.ts')).toBeNull();
	});

	test('keys round-trip through URIs and Monaco model paths', () => {
		for (const key of ['src/a.ts', '/w/my lib/src/b.ts', '/w/app/pkg/c.ts']) {
			expect(keyOfUri(FOLDERS, uriOfRel(FOLDERS[0].path, key))).toBe(key);
			expect(keyOfModelPath(modelPathOf(key), FOLDERS)).toBe(key);
		}
		expect(modelPathOf('src/a.ts')).toBe('/src/a.ts');
	});

	test('problems of every root folder are workspace files', () => {
		const idx = new DiagnosticsIndex();
		const d = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'x', severity: 1 };
		idx.set('file:///w/app/a.ts', 'push', [d]);
		idx.set('file:///w/my%20lib/b.ts', 'push', [d]);
		idx.set('file:///tmp/c.ts', 'push', [d]);
		expect(idx.files(FOLDERS).map((f) => f.rel)).toEqual(['/w/my lib/b.ts', 'a.ts', null]);
		// One folder given as a path (the single-folder form) still works.
		expect(idx.files('/w/app').map((f) => f.rel)).toEqual(['a.ts', null, null]);
	});
});

describe('workspace folders', () => {
	test('LSP folders carry each folder name', () => {
		expect(lspFolders(FOLDERS.slice(0, 2))).toEqual([
			{ uri: 'file:///w/app', name: 'app' },
			{ uri: 'file:///w/my%20lib', name: 'Lib' }
		]);
	});

	test('changes between folder lists', () => {
		const [a, b, c] = lspFolders(FOLDERS);
		expect(folderChanges([a, b], [a, b])).toEqual({ added: [], removed: [] });
		expect(folderChanges([a], [a, b, c])).toEqual({ added: [b, c], removed: [] });
		expect(folderChanges([a, b, c], [a, c])).toEqual({ added: [], removed: [b] });
		const renamed = { ...b, name: 'Other' };
		expect(folderChanges([a, b], [a, renamed])).toEqual({ added: [renamed], removed: [b] });
	});

	test('initialize sends every folder; changes are notified only to a server that takes them', async () => {
		const run = async (capabilities: object) => {
			const sent: any[] = [];
			const client = new LanguageClient('test', (j) => sent.push(JSON.parse(j)), { diagnostics: () => {}, status: () => {}, log: () => {} });
			const folders = lspFolders(FOLDERS.slice(0, 2));
			const done = client.initialize(folders[0].uri, undefined, 'off', folders);
			client.rpc.handle(JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, result: { capabilities } }));
			await done;
			return { client, sent, folders };
		};
		const { client, sent, folders } = await run({ workspace: { workspaceFolders: { supported: true, changeNotifications: true } } });
		expect(sent[0].params.rootUri).toBe('file:///w/app');
		expect(sent[0].params.workspaceFolders).toEqual(folders);
		expect(client.takesFolderChanges).toBe(true);
		// workspace/workspaceFolders answers with all of them.
		client.rpc.handle(JSON.stringify({ jsonrpc: '2.0', id: 'f', method: 'workspace/workspaceFolders' }));
		await new Promise((r) => setTimeout(r, 0));
		expect(sent.find((m) => m.id === 'f').result).toEqual(folders);

		const pkg = lspFolders(FOLDERS)[2];
		expect(client.changeWorkspaceFolders([folders[0], pkg])).toBe(true);
		expect(sent.at(-1)).toEqual({ jsonrpc: '2.0', method: 'workspace/didChangeWorkspaceFolders', params: { event: { added: [pkg], removed: [folders[1]] } } });
		const count = sent.length;
		expect(client.changeWorkspaceFolders([folders[0], pkg])).toBe(false);
		expect(sent.length).toBe(count);

		const plain = await run({});
		expect(plain.client.takesFolderChanges).toBe(false);
	});

	test('a server started with only a root URI knows that one folder', async () => {
		const sent: any[] = [];
		const client = new LanguageClient('test', (j) => sent.push(JSON.parse(j)), { diagnostics: () => {}, status: () => {}, log: () => {} });
		const done = client.initialize('file:///ws');
		client.rpc.handle(JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, result: { capabilities: {} } }));
		await done;
		expect(sent[0].params.workspaceFolders).toEqual([{ uri: 'file:///ws', name: 'ws' }]);
	});
});
