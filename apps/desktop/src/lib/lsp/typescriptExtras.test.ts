import { describe, expect, test } from 'bun:test';
import {
	chosenTsserver,
	fileReferenceLocations,
	isEmptyEdit,
	mayHaveImports,
	packageJsonOf,
	packageVersion,
	remapEditUris,
	renamedUri,
	renameSubject,
	tsserverPath,
	updateImportsMode,
	workspaceTsdk
} from './typescriptExtras.ts';
import type { SettingsReader } from './serverSettings.ts';
import { LanguageClient } from './client.ts';

const reader = (values: Record<string, unknown>, user: Record<string, unknown> = {}): SettingsReader => ({
	get: <T,>(id: string) => (id in values ? values[id] : id.includes('updateImports') ? 'prompt' : '') as T,
	isSet: (id) => id in values,
	layer: (id, scope) => (scope === 'user' ? user[id] : undefined)
});

const edit = { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 13 } }, newText: './b' };

describe('update imports on file move', () => {
	test('which renames can need import updates', () => {
		expect(mayHaveImports('src/a.ts', false)).toBe(true);
		expect(mayHaveImports('src/a.mjs', false)).toBe(true);
		expect(mayHaveImports('README.md', false)).toBe(false);
		expect(mayHaveImports('src/lib', true)).toBe(true);
	});

	test('the unified key wins, else the language’s own', () => {
		expect(updateImportsMode(reader({}), 'a.ts')).toBe('prompt');
		expect(updateImportsMode(reader({ 'typescript.updateImportsOnFileMove.enabled': 'never' }), 'a.ts')).toBe('never');
		expect(updateImportsMode(reader({ 'typescript.updateImportsOnFileMove.enabled': 'never' }), 'a.js')).toBe('prompt');
		expect(updateImportsMode(reader({ 'javascript.updateImportsOnFileMove.enabled': 'always' }), 'a.jsx')).toBe('always');
		expect(updateImportsMode(reader({ 'js/ts.updateImportsOnFileMove.enabled': 'always', 'typescript.updateImportsOnFileMove.enabled': 'never' }), 'a.ts')).toBe('always');
		expect(updateImportsMode(reader({ 'js/ts.updateImportsOnFileMove.enabled': 'bogus' }), 'a.ts')).toBe('prompt');
	});

	test('empty edits', () => {
		expect(isEmptyEdit(null)).toBe(true);
		expect(isEmptyEdit({})).toBe(true);
		expect(isEmptyEdit({ changes: { 'file:///w/a.ts': [] } })).toBe(true);
		expect(isEmptyEdit({ documentChanges: [{ textDocument: { uri: 'file:///w/a.ts', version: 1 }, edits: [] }] })).toBe(true);
		expect(isEmptyEdit({ changes: { 'file:///w/a.ts': [edit] } })).toBe(false);
	});

	test('edits computed before the move point at the moved files', () => {
		const files = [
			{ oldUri: 'file:///w/src/a.ts', newUri: 'file:///w/lib/a.ts' },
			{ oldUri: 'file:///w/old', newUri: 'file:///w/new' }
		];
		expect(renamedUri('file:///w/src/a.ts', files)).toBe('file:///w/lib/a.ts');
		expect(renamedUri('file:///w/old/x/y.ts', files)).toBe('file:///w/new/x/y.ts');
		expect(renamedUri('file:///w/older/z.ts', files)).toBe('file:///w/older/z.ts');
		const out = remapEditUris(
			{
				changes: { 'file:///w/src/a.ts': [edit], 'file:///w/c.ts': [edit] },
				documentChanges: [
					{ textDocument: { uri: 'file:///w/old/x.ts', version: 4 }, edits: [edit] },
					{ textDocument: { uri: 'file:///w/c.ts', version: 2 }, edits: [edit] },
					{ kind: 'create', uri: 'file:///w/old/n.ts' }
				]
			},
			files
		);
		expect(Object.keys(out.changes!)).toEqual(['file:///w/lib/a.ts', 'file:///w/c.ts']);
		expect(out.documentChanges![0]).toEqual({ textDocument: { uri: 'file:///w/new/x.ts', version: null }, edits: [edit] });
		// Untouched documents keep their version; resource operations stay as they are.
		expect(out.documentChanges![1]).toEqual({ textDocument: { uri: 'file:///w/c.ts', version: 2 }, edits: [edit] });
		expect(out.documentChanges![2]).toEqual({ kind: 'create', uri: 'file:///w/old/n.ts' });
	});

	test('the prompt names one file, or counts them', () => {
		expect(renameSubject([{ oldUri: 'file:///w/src/my%20file.ts', newUri: 'x' }])).toBe('my file.ts');
		expect(renameSubject([{ oldUri: 'a', newUri: 'b' }, { oldUri: 'c', newUri: 'd' }])).toBe('2');
	});
});

describe('find file references', () => {
	test('tsserver fileReferences → locations', () => {
		const toUri = (p: string) => `file://${p}`;
		const refs = { refs: [{ file: '/w/b.ts', start: { line: 1, offset: 20 }, end: { line: 1, offset: 26 }, lineText: "import a from './a'" }, { file: 3 }] };
		const expected = [{ uri: 'file:///w/b.ts', range: { start: { line: 0, character: 19 }, end: { line: 0, character: 25 } } }];
		expect(fileReferenceLocations(refs, toUri)).toEqual(expected);
		expect(fileReferenceLocations({ body: refs }, toUri)).toEqual(expected);
		expect(fileReferenceLocations(null, toUri)).toEqual([]);
		expect(fileReferenceLocations({ refs: 'x' }, toUri)).toEqual([]);
	});
});

describe('select TypeScript version', () => {
	test('the workspace lib folder', () => {
		expect(workspaceTsdk(reader({}))).toBe('node_modules/typescript/lib');
		expect(workspaceTsdk(reader({ 'typescript.tsdk': 'tools/ts/lib/' }))).toBe('tools/ts/lib');
		expect(workspaceTsdk(reader({ 'js/ts.tsdk.path': './node_modules/typescript/lib/tsserver.js', 'typescript.tsdk': 'x' }))).toBe('./node_modules/typescript/lib');
		expect(packageJsonOf('node_modules/typescript/lib')).toBe('node_modules/typescript/package.json');
	});

	test('tsserver paths', () => {
		expect(tsserverPath('/w/', 'node_modules/typescript/lib')).toBe('/w/node_modules/typescript/lib/tsserver.js');
		expect(tsserverPath('/w', './lib')).toBe('/w/lib/tsserver.js');
		expect(tsserverPath('/w', '/opt/ts/lib')).toBe('/opt/ts/lib/tsserver.js');
	});

	test('the server’s own TypeScript unless the workspace one is chosen or a user path is set', () => {
		expect(chosenTsserver(reader({}), 'bundled', '/w')).toBeNull();
		expect(chosenTsserver(reader({}), 'workspace', '/w')).toBe('/w/node_modules/typescript/lib/tsserver.js');
		expect(chosenTsserver(reader({}), 'workspace', '')).toBeNull();
		expect(chosenTsserver(reader({}, { 'js/ts.tsdk.path': '/opt/ts/lib' }), 'bundled', '/w')).toBe('/opt/ts/lib/tsserver.js');
		// A relative user path names no one workspace: ignored, like VS Code.
		expect(chosenTsserver(reader({}, { 'typescript.tsdk': 'node_modules/typescript/lib' }), 'bundled', '/w')).toBeNull();
	});

	test('package versions', () => {
		expect(packageVersion('{"name":"typescript","version":"5.6.3"}')).toBe('5.6.3');
		expect(packageVersion('{}')).toBeNull();
		expect(packageVersion('nope')).toBeNull();
	});
});

describe('file operations over LSP', () => {
	const fake = (capabilities: object) => {
		const sent: any[] = [];
		const client = new LanguageClient('fake-ts', (j) => sent.push(JSON.parse(j)), { diagnostics: () => {}, status: () => {}, log: () => {} });
		const reply = (id: number, result: unknown) => client.rpc.handle(JSON.stringify({ jsonrpc: '2.0', id, result }));
		const init = async () => {
			const done = client.initialize('file:///w');
			reply(sent[0].id, { capabilities });
			await done;
		};
		return { client, sent, reply, init };
	};
	const files = [{ oldUri: 'file:///w/a.ts', newUri: 'file:///w/b.ts' }];

	test('willRenameFiles and didRenameFiles, as the server registered them', async () => {
		const s = fake({ workspace: { fileOperations: { willRename: { filters: [] }, didRename: { filters: [] } } } });
		await s.init();
		expect(s.sent[0].params.capabilities.workspace.fileOperations).toEqual({ dynamicRegistration: false, willRename: true, didRename: true });
		expect(s.client.takesWillRename).toBe(true);
		const p = s.client.willRenameFiles(files);
		const req = s.sent.at(-1);
		expect(req.method).toBe('workspace/willRenameFiles');
		expect(req.params).toEqual({ files });
		s.reply(req.id, { changes: {} });
		expect(await p).toEqual({ changes: {} });
		s.client.didRenameFiles(files);
		expect(s.sent.at(-1)).toMatchObject({ method: 'workspace/didRenameFiles', params: { files } });
	});

	test('no didRenameFiles for a server that did not ask', async () => {
		const s = fake({});
		await s.init();
		expect(s.client.takesWillRename).toBe(false);
		const before = s.sent.length;
		s.client.didRenameFiles(files);
		expect(s.sent.length).toBe(before);
	});

	test('a command result (Go to Source Definition)', async () => {
		const s = fake({ executeCommandProvider: { commands: [] } });
		await s.init();
		const p = s.client.executeCommandResult('_typescript.goToSourceDefinition', ['file:///w/a.ts', { line: 0, character: 3 }]);
		const req = s.sent.at(-1);
		expect(req).toMatchObject({ method: 'workspace/executeCommand', params: { command: '_typescript.goToSourceDefinition' } });
		s.reply(req.id, [{ uri: 'file:///w/a.js', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } }]);
		expect(await p).toHaveLength(1);
	});
});
