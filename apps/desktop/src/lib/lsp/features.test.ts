import { describe, expect, test } from 'bun:test';
import { LanguageClient, type ClientHooks } from './client';
import { markerToDiagnostic, toDocumentHighlights, toMarker, toMonacoTextEdits, toRenameLocation, toSignatureHelp, fromSignatureHelp } from './convert';
import { configSection, progressText, serverFor } from './model';
import type { Diagnostic, ServerCapabilities, TextEdit, WorkspaceEdit } from './protocol';
import { applyTextEdits, applyWorkspaceEdit, editGroups, lineStarts, offsetAt, type EditTarget } from './workspaceEdit';

const range = (l1: number, c1: number, l2: number, c2: number) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
const edit = (l1: number, c1: number, l2: number, c2: number, newText: string): TextEdit => ({ range: range(l1, c1, l2, c2), newText });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('applyTextEdits', () => {
	test('edits refer to the original text, in any order', () => {
		const text = 'let a = 1;\nlet b = a + a;\n';
		const out = applyTextEdits(text, [edit(1, 12, 1, 13, 'x'), edit(0, 4, 0, 5, 'x'), edit(1, 8, 1, 9, 'x')]);
		expect(out).toBe('let x = 1;\nlet b = x + x;\n');
	});

	test('inserts at the same position keep array order; an insert before a replace at its start', () => {
		expect(applyTextEdits('ab', [edit(0, 1, 0, 1, '1'), edit(0, 1, 0, 1, '2'), edit(0, 1, 0, 2, 'X')])).toBe('a12X');
		expect(applyTextEdits('ab', [edit(0, 1, 0, 2, 'X'), edit(0, 1, 0, 1, '1')])).toBe('a1X');
	});

	test('ranges are UTF-16 code units: Thai and emoji', () => {
		// "🦀" is 2 code units, each Thai character 1 (combining vowels included).
		const text = 'const สวัสดี = "🦀";\nสวัสดี + 1';
		const name = 'const '.length;
		const end = name + 'สวัสดี'.length; // 6 + 6
		const crab = text.indexOf('🦀');
		const out = applyTextEdits(text, [edit(0, name, 0, end, 'hello'), edit(0, crab, 0, crab + 2, '😀🦀'), edit(1, 0, 1, 6, 'hello')]);
		expect(out).toBe('const hello = "😀🦀";\nhello + 1');
	});

	test('CRLF and CR line breaks, positions past the line end clamp to it', () => {
		const text = 'ab\r\ncd\ref\n';
		expect(lineStarts(text)).toEqual([0, 4, 7, 10]);
		expect(offsetAt(text, lineStarts(text), { line: 0, character: 99 })).toBe(2);
		expect(offsetAt(text, lineStarts(text), { line: 9, character: 0 })).toBe(text.length);
		expect(applyTextEdits(text, [edit(0, 99, 1, 0, '-'), edit(2, 1, 2, 2, 'F')])).toBe('ab-cd\reF\n');
	});

	test('overlapping edits are refused', () => {
		expect(() => applyTextEdits('abcdef', [edit(0, 0, 0, 3, 'x'), edit(0, 2, 0, 4, 'y')])).toThrow('overlapping');
	});
});

describe('applyWorkspaceEdit', () => {
	type Fake = EditTarget & { text: string; commits: (TextEdit[] | null)[] };
	function fakes(files: Record<string, string>, versions: Record<string, number> = {}) {
		const targets = new Map<string, Fake>();
		for (const [uri, text] of Object.entries(files)) {
			const t: Fake = {
				text,
				commits: [],
				version: versions[uri],
				read: () => t.text,
				commit(newText, edits) {
					t.text = newText;
					t.commits.push(edits);
				}
			};
			targets.set(uri, t);
		}
		const resolve = (uri: string) => targets.get(uri) ?? `${uri} is outside the workspace`;
		return { targets, resolve };
	}

	test('applies `changes` across files', async () => {
		const f = fakes({ 'file:///ws/a.rs': 'fn foo() {}\nfoo(); foo();', 'file:///ws/b.rs': 'use a::foo;' });
		const r = await applyWorkspaceEdit(
			{
				changes: {
					'file:///ws/a.rs': [edit(1, 7, 1, 10, 'bar'), edit(0, 3, 0, 6, 'bar'), edit(1, 0, 1, 3, 'bar')],
					'file:///ws/b.rs': [edit(0, 7, 0, 10, 'bar')]
				}
			},
			f.resolve
		);
		expect(r).toEqual({ applied: true, uris: ['file:///ws/a.rs', 'file:///ws/b.rs'], edits: 4 });
		expect(f.targets.get('file:///ws/a.rs')!.text).toBe('fn bar() {}\nbar(); bar();');
		expect(f.targets.get('file:///ws/b.rs')!.text).toBe('use a::bar;');
		// One group: the original edits are handed over (a model applies them as operations).
		expect(f.targets.get('file:///ws/b.rs')!.commits).toEqual([[edit(0, 7, 0, 10, 'bar')]]);
	});

	test('documentChanges win over changes; several edits of one document apply in sequence', async () => {
		const f = fakes({ 'file:///ws/a.ts': 'x' }, { 'file:///ws/a.ts': 3 });
		const we: WorkspaceEdit = {
			changes: { 'file:///ws/a.ts': [edit(0, 0, 0, 1, 'ignored')] },
			documentChanges: [
				{ textDocument: { uri: 'file:///ws/a.ts', version: 3 }, edits: [edit(0, 0, 0, 1, 'ก🦀')] },
				// Refers to the text after the first edit: "ก🦀" is 3 code units.
				{ textDocument: { uri: 'file:///ws/a.ts', version: null }, edits: [edit(0, 3, 0, 3, '!')] }
			]
		};
		expect(editGroups(we).length).toBe(2);
		const r = await applyWorkspaceEdit(we, f.resolve);
		expect(r.applied).toBe(true);
		const t = f.targets.get('file:///ws/a.ts')!;
		expect(t.text).toBe('ก🦀!');
		expect(t.commits).toEqual([null]); // not one group: the whole new text is used
	});

	test('nothing is written when any document fails', async () => {
		const files = { 'file:///ws/a.rs': 'aaa', 'file:///ws/b.rs': 'bbb' };
		const stale = fakes(files, { 'file:///ws/b.rs': 7 });
		const r = await applyWorkspaceEdit(
			{
				documentChanges: [
					{ textDocument: { uri: 'file:///ws/a.rs', version: null }, edits: [edit(0, 0, 0, 1, 'x')] },
					{ textDocument: { uri: 'file:///ws/b.rs', version: 6 }, edits: [edit(0, 0, 0, 1, 'x')] }
				]
			},
			stale.resolve
		);
		expect(r.applied).toBe(false);
		expect(r.failureReason).toContain('changed');
		expect(stale.targets.get('file:///ws/a.rs')!.commits).toEqual([]);

		const outside = fakes(files);
		const r2 = await applyWorkspaceEdit({ changes: { 'file:///ws/a.rs': [edit(0, 0, 0, 1, 'x')], 'file:///etc/hosts': [edit(0, 0, 0, 0, 'x')] } }, outside.resolve);
		expect(r2.failureReason).toContain('outside the workspace');
		expect(outside.targets.get('file:///ws/a.rs')!.text).toBe('aaa');

		const overlap = await applyWorkspaceEdit({ changes: { 'file:///ws/a.rs': [edit(0, 0, 0, 2, 'x'), edit(0, 1, 0, 3, 'y')] } }, fakes(files).resolve);
		expect(overlap.failureReason).toContain('overlapping');

		const create = await applyWorkspaceEdit({ documentChanges: [{ kind: 'create', uri: 'file:///ws/new.rs' }] }, fakes(files).resolve);
		expect(create).toMatchObject({ applied: false, failureReason: 'file create operations are not supported' });
	});

	test('a failing write is reported', async () => {
		const r = await applyWorkspaceEdit({ changes: { 'file:///ws/a': [edit(0, 0, 0, 0, 'x')] } }, () => ({
			read: () => '',
			commit: () => Promise.reject(new Error('disk full'))
		}));
		expect(r).toMatchObject({ applied: false, failureReason: 'disk full' });
	});
});

describe('feature conversions', () => {
	test('formatting edits map to Monaco ranges that slice the same UTF-16 text', () => {
		const line = 'let ไทย🦀=1;';
		const eq = line.indexOf('=');
		const [e] = toMonacoTextEdits([edit(0, eq, 0, eq + 1, ' = ')]);
		expect(e).toEqual({ range: { startLineNumber: 1, startColumn: eq + 1, endLineNumber: 1, endColumn: eq + 2 }, text: ' = ' });
		expect(line.slice(e.range.startColumn - 1, e.range.endColumn - 1)).toBe('=');
		expect(toMonacoTextEdits(null)).toEqual([]);
	});

	test('prepareRename results', () => {
		const word = { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }, text: 'foo' };
		const textIn = () => 'สวัสดี';
		expect(toRenameLocation(undefined, word, textIn)).toBe(word); // no prepare support
		expect(toRenameLocation(null, word, textIn)).toBeNull();
		expect(toRenameLocation({ defaultBehavior: true }, word, textIn)).toBe(word);
		expect(toRenameLocation({ range: range(0, 2, 0, 8), placeholder: 'p' }, word, textIn)).toEqual({ range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 9 }, text: 'p' });
		expect(toRenameLocation(range(1, 0, 1, 6), word, textIn)?.text).toBe('สวัสดี');
	});

	test('signature help and highlights', () => {
		const help = toSignatureHelp({
			signatures: [{ label: 'fn f(a: i32, b: &str)', documentation: { kind: 'markdown', value: '**f**' }, parameters: [{ label: [5, 11] }, { label: 'b: &str' }] }],
			activeSignature: 4,
			activeParameter: 1
		});
		expect(help.activeSignature).toBe(0); // clamped
		expect(help.activeParameter).toBe(1);
		expect(help.signatures[0].parameters[0].label).toEqual([5, 11]);
		expect(help.signatures[0].documentation).toEqual({ value: '**f**' });
		expect(fromSignatureHelp(help).signatures[0].parameters![1].label).toBe('b: &str');
		expect(toDocumentHighlights([{ range: range(0, 0, 0, 1) }, { range: range(0, 0, 0, 1), kind: 3 }]).map((h) => h.kind)).toEqual([0, 2]);
	});

	test('markers round-trip to diagnostics for code actions', () => {
		const d: Diagnostic = { range: range(2, 1, 2, 5), severity: 2, message: 'unused', source: 'rustc', code: 'E1', tags: [1] };
		expect(markerToDiagnostic(toMarker(d))).toEqual(d);
		expect(markerToDiagnostic(toMarker({ range: range(0, 0, 0, 1), severity: 4, message: 'h' })).severity).toBe(4);
	});

	test('configuration sections and progress text', () => {
		const settings = { 'rust-analyzer': { check: { command: 'clippy' } }, gopls: { gofumpt: true } };
		expect(configSection(settings, 'rust-analyzer')).toEqual({ check: { command: 'clippy' } });
		expect(configSection(settings, 'rust-analyzer.check.command')).toBe('clippy');
		expect(configSection(settings, 'typescript.format')).toBeNull();
		expect(configSection(settings)).toBe(settings);
		const ra = serverFor('rust')!;
		expect(progressText(ra, { state: 'indexing', message: 'Indexing (40%)' })).toBe('rust-analyzer: Indexing (40%)…');
		expect(progressText(ra, { state: 'ready' })).toBeNull();
	});
});

describe('LanguageClient language features', () => {
	function harness(capabilities: ServerCapabilities, hooks: Partial<ClientHooks> = {}) {
		const sent: any[] = [];
		const messages: [number, string][] = [];
		const client = new LanguageClient('test-ls', (j) => sent.push(JSON.parse(j)), {
			diagnostics: () => {},
			status: () => {},
			log: () => {},
			showMessage: (type, message) => messages.push([type, message]),
			...hooks
		});
		const reply = (id: number, result: unknown) => client.rpc.handle(JSON.stringify({ jsonrpc: '2.0', id, result }));
		const request = (id: number, method: string, params: unknown) => client.rpc.handle(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
		const init = async () => {
			const done = client.initialize('file:///ws');
			reply(sent[0].id, { capabilities });
			await done;
		};
		return { client, sent, messages, reply, request, init };
	}

	test('advertises the new capabilities', async () => {
		const h = harness({});
		await h.init();
		const caps = h.sent[0].params.capabilities;
		expect(caps.workspace).toMatchObject({ applyEdit: true, configuration: true, workspaceEdit: { documentChanges: true, resourceOperations: [] } });
		expect(caps.textDocument.rename.prepareSupport).toBe(true);
		expect(caps.textDocument.codeAction.resolveSupport.properties).toEqual(['edit']);
		expect(caps.textDocument.signatureHelp.signatureInformation.parameterInformation.labelOffsetSupport).toBe(true);
	});

	test('features the server lacks are not requested', async () => {
		const h = harness({});
		await h.init();
		const at = { line: 0, character: 0 };
		expect(await h.client.rename('file:///ws/a', at, 'x')).toBeNull();
		expect(await h.client.formatting('file:///ws/a', { tabSize: 4, insertSpaces: true })).toBeNull();
		expect(await h.client.references('file:///ws/a', at, true)).toBeNull();
		expect(await h.client.executeCommand({ title: 't', command: 'x.y' })).toBe(false);
		expect(h.client.canPrepareRename).toBe(false);
		expect(h.sent.length).toBe(2); // initialize, initialized
	});

	test('rename, code actions and commands go to the server', async () => {
		const h = harness({ renameProvider: { prepareProvider: true }, codeActionProvider: { resolveProvider: true }, executeCommandProvider: { commands: ['ra.run'] } });
		await h.init();
		expect(h.client.canPrepareRename && h.client.canResolveCodeAction).toBe(true);
		const renamed = h.client.rename('file:///ws/a.rs', { line: 1, character: 2 }, 'bar');
		const req = h.sent.at(-1);
		expect(req).toMatchObject({ method: 'textDocument/rename', params: { textDocument: { uri: 'file:///ws/a.rs' }, position: { line: 1, character: 2 }, newName: 'bar' } });
		h.reply(req.id, { changes: {} });
		expect(await renamed).toEqual({ changes: {} });

		const ran = h.client.executeCommand({ title: 'Run', command: 'ra.run', arguments: [1] });
		h.reply(h.sent.at(-1).id, null);
		expect(await ran).toBe(true);
		expect(h.sent.at(-1).params).toEqual({ command: 'ra.run', arguments: [1] });
	});

	test('workspace/applyEdit and workspace/configuration reach the hooks', async () => {
		const edits: WorkspaceEdit[] = [];
		const h = harness(
			{},
			{
				applyEdit: async (e) => (edits.push(e), e.changes ? { applied: true } : { applied: false, failureReason: 'nope' }),
				configuration: (section) => (section === 'gopls' ? { gofumpt: true } : null)
			}
		);
		await h.init();
		h.request(10, 'workspace/applyEdit', { edit: { changes: { 'file:///ws/a': [] } } });
		h.request(11, 'workspace/applyEdit', { edit: { documentChanges: [] } });
		h.request(12, 'workspace/configuration', { items: [{ section: 'gopls' }, { section: 'other' }] });
		h.request(13, 'window/showMessageRequest', { type: 2, message: 'Reload?', actions: [{ title: 'Yes' }] });
		await tick();
		await tick();
		const results = Object.fromEntries(h.sent.filter((m) => 'result' in m).map((m) => [m.id, m.result]));
		expect(results[10]).toEqual({ applied: true });
		expect(results[11]).toEqual({ applied: false, failureReason: 'nope' });
		expect(results[12]).toEqual([{ gofumpt: true }, null]);
		expect(results[13]).toBeNull();
		expect(h.messages).toEqual([[2, 'Reload?']]);
		expect(edits.length).toBe(2);
	});
});
