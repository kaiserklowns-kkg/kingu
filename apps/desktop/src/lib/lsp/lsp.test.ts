import { describe, expect, test } from 'bun:test';
import { LanguageClient, type ServerStatus } from './client';
import {
	hoverContents,
	MarkerSeverity,
	mergeDiagnostics,
	relOfUri,
	symbolPath,
	toCompletionItem,
	toLspPosition,
	toMarker,
	toMonacoRange,
	toMonacoSymbols,
	toTargets,
	uriOfRel,
	uriToPath
} from './convert';
import { JsonRpc, ResponseError } from './jsonrpc';
import { EXTRA_LANGUAGES, languageFor, lspLanguageId } from '#lib/editor/languages.ts';
import { configurationValue, countDiagnostics, DiagnosticsIndex, installItems, isDisabled, parseDisabled, SERVERS, serverFor, shellWord, statusText } from './model';
import type { Diagnostic, DocumentSymbol } from './protocol';

const range = (l1: number, c1: number, l2: number, c2: number) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('range mapping', () => {
	test('LSP is 0-based, Monaco 1-based', () => {
		expect(toMonacoRange(range(0, 0, 2, 5))).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 6 });
		expect(toLspPosition({ lineNumber: 1, column: 1 })).toEqual({ line: 0, character: 0 });
	});

	test('characters are UTF-16 code units, the same unit as Monaco columns', () => {
		// "🦀" is two UTF-16 units; "ก" one. An identifier after them starts at JS index 4.
		const line = 'a🦀ก x';
		const character = line.indexOf('x'); // 5 code units: a, 🦀(2), ก, space
		expect(character).toBe(5);
		const r = toMonacoRange({ start: { line: 0, character }, end: { line: 0, character: character + 1 } });
		expect(line.slice(r.startColumn - 1, r.endColumn - 1)).toBe('x');
		expect(toLspPosition({ lineNumber: 1, column: r.startColumn })).toEqual({ line: 0, character });
	});
});

describe('diagnostics', () => {
	const d = (severity: number | undefined, line: number, message: string): Diagnostic => ({ range: range(line, 0, line, 3), severity, message });

	test('maps severity, code link and tags to Monaco markers', () => {
		const m = toMarker({ ...d(2, 4, 'unused'), source: 'rustc', code: 'E0001', codeDescription: { href: 'https://x/E0001' }, tags: [1] });
		expect(m.severity as number).toBe(MarkerSeverity.Warning);
		expect(m.startLineNumber).toBe(5);
		expect(m.code).toEqual({ value: 'E0001', target: 'https://x/E0001' as never });
		expect(m.tags as number[]).toEqual([1]);
		expect(toMarker(d(undefined, 0, 'x')).severity as number).toBe(MarkerSeverity.Error);
		expect(toMarker(d(4, 0, 'x')).severity as number).toBe(MarkerSeverity.Hint);
	});

	test('merges pushed and pulled diagnostics without duplicates, errors first', () => {
		const merged = mergeDiagnostics([d(2, 1, 'w'), d(1, 5, 'e')], [d(1, 5, 'e'), d(1, 0, 'e0')]);
		expect(merged.map((x) => x.message)).toEqual(['e0', 'e', 'w']);
	});

	test('index groups by file and counts', () => {
		const idx = new DiagnosticsIndex();
		idx.set('file:///ws/src/b.rs', 'push', [d(1, 0, 'e'), d(2, 1, 'w')]);
		idx.set('file:///ws/src/a.rs', 'pull', [d(3, 0, 'i')]);
		idx.set('file:///home/u/.rustup/lib.rs', 'push', [d(1, 0, 'ext')]);
		idx.set('file:///ws/c.rs', 'push', []);
		const files = idx.files('/ws');
		expect(files.map((f) => f.label)).toEqual(['src/a.rs', 'src/b.rs', '/home/u/.rustup/lib.rs']);
		expect(files[2].rel).toBeNull();
		expect(countDiagnostics(files)).toEqual({ errors: 2, warnings: 1, infos: 1 });
		// Clearing a server's pull leaves its push in place, and an empty file drops out.
		idx.set('file:///ws/src/a.rs', 'pull', []);
		expect(idx.files('/ws').map((f) => f.label)).toEqual(['src/b.rs', '/home/u/.rustup/lib.rs']);
		expect(idx.clear((u) => u.endsWith('lib.rs'))).toEqual(['file:///home/u/.rustup/lib.rs']);
	});
});

describe('uris', () => {
	test('round-trips workspace paths with spaces and Thai', () => {
		const uri = uriOfRel('/Users/me/my repo', 'src/ไฟล์ a.rs');
		expect(uri).toBe('file:///Users/me/my%20repo/src/%E0%B9%84%E0%B8%9F%E0%B8%A5%E0%B9%8C%20a.rs');
		expect(relOfUri('/Users/me/my repo', uri)).toBe('src/ไฟล์ a.rs');
		expect(relOfUri('/Users/me/my repo', 'file:///Users/me/my%20repository/x.rs')).toBeNull();
		expect(uriToPath('untitled:1')).toBeNull();
	});
});

describe('hover and completion', () => {
	test('hover contents in all three shapes', () => {
		expect(hoverContents({ contents: { kind: 'markdown', value: '**x**' } })).toEqual([{ value: '**x**' }]);
		expect(hoverContents({ contents: [{ language: 'rust', value: 'fn f()' }, 'doc'] })).toEqual([{ value: '```rust\nfn f()\n```' }, { value: 'doc' }]);
		expect(hoverContents({ contents: { kind: 'plaintext', value: 'a*b' } })).toEqual([{ value: 'a\\*b' }]);
	});

	const fallback = { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 7 };

	test('snippet text edit', () => {
		const item = toCompletionItem({ label: 'println!', kind: 3, insertTextFormat: 2, textEdit: { range: range(2, 4, 2, 6), newText: 'println!("$1")' } }, fallback);
		expect(item.insertText).toBe('println!("$1")');
		expect(item.insertTextRules as number).toBe(4);
		expect(item.range).toEqual({ startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 7 });
		expect(item.kind as number).toBe(1); // Function
	});

	test('insert/replace edits, defaults and plain insertText', () => {
		const ir = toCompletionItem({ label: 'len', textEdit: { newText: 'len', insert: range(0, 1, 0, 2), replace: range(0, 1, 0, 4) } }, fallback);
		expect(ir.range).toEqual({ insert: toMonacoRange(range(0, 1, 0, 2)), replace: toMonacoRange(range(0, 1, 0, 4)) });
		const plain = toCompletionItem({ label: 'foo', insertText: 'foo()', kind: 22, deprecated: true }, fallback);
		expect(plain.insertText).toBe('foo()');
		expect(plain.insertTextRules).toBeUndefined();
		expect(plain.range).toEqual(fallback);
		expect(plain.kind as number).toBe(6); // Struct
		expect(plain.tags as number[]).toEqual([1]);
		const defaulted = toCompletionItem({ label: 'x' }, fallback, { editRange: range(1, 0, 1, 1), insertTextFormat: 2 });
		expect(defaulted.range).toEqual(toMonacoRange(range(1, 0, 1, 1)));
		expect(defaulted.insertTextRules as number).toBe(4);
		expect(toCompletionItem({ label: 'y', labelDetails: { detail: '(a)', description: 'mod' } }, fallback).label).toEqual({ label: 'y', detail: '(a)', description: 'mod' });
	});
});

describe('definition and symbols', () => {
	test('locations and location links', () => {
		expect(toTargets({ uri: 'file:///a', range: range(1, 0, 1, 1) })).toEqual([{ uri: 'file:///a', range: range(1, 0, 1, 1) }]);
		expect(toTargets([{ targetUri: 'file:///b', targetRange: range(0, 0, 9, 0), targetSelectionRange: range(2, 3, 2, 6) }])).toEqual([{ uri: 'file:///b', range: range(2, 3, 2, 6) }]);
		expect(toTargets(null)).toEqual([]);
	});

	const tree: DocumentSymbol[] = [
		{
			name: 'Workspace',
			kind: 23,
			range: range(0, 0, 20, 1),
			selectionRange: range(0, 7, 0, 16),
			children: [{ name: 'resolve', kind: 6, range: range(5, 2, 10, 3), selectionRange: range(5, 5, 5, 12) }]
		},
		{ name: 'run', kind: 12, range: range(22, 0, 30, 1), selectionRange: range(22, 7, 22, 10) }
	];

	test('breadcrumb path for nested document symbols', () => {
		expect(symbolPath(tree, { line: 7, character: 0 }).map((c) => c.name)).toEqual(['Workspace', 'resolve']);
		expect(symbolPath(tree, { line: 21, character: 0 })).toEqual([]);
		const flat = [
			{ name: 'outer', kind: 5, location: { uri: 'u', range: range(0, 0, 10, 0) } },
			{ name: 'inner', kind: 6, location: { uri: 'u', range: range(2, 0, 4, 0) } }
		];
		expect(symbolPath(flat, { line: 3, character: 0 }).map((c) => c.name)).toEqual(['outer', 'inner']);
	});

	test('symbol kinds shift by one into Monaco', () => {
		const [ws] = toMonacoSymbols(tree);
		expect(ws.kind as number).toBe(22); // Struct
		expect(ws.children?.[0].kind as number).toBe(5); // Method
		expect(ws.selectionRange.startColumn).toBe(8);
	});
});

describe('JsonRpc', () => {
	test('matches responses to requests and surfaces errors', async () => {
		const sent: any[] = [];
		const rpc = new JsonRpc((j) => sent.push(JSON.parse(j)));
		const a = rpc.request('a', { x: 1 });
		const b = rpc.request('b');
		expect(sent.map((m) => [m.id, m.method])).toEqual([
			[1, 'a'],
			[2, 'b']
		]);
		rpc.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32801, message: 'modified' } }));
		rpc.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }));
		expect(await a).toBe('ok');
		const err = (await b.catch((e: unknown) => e)) as ResponseError;
		expect(err).toBeInstanceOf(ResponseError);
		expect(err.code).toBe(-32801);
	});

	test('answers server requests, rejects unknown ones, and cancels', async () => {
		const sent: any[] = [];
		const rpc = new JsonRpc((j) => sent.push(JSON.parse(j)));
		rpc.onRequest('workspace/configuration', (p) => p.items.map(() => null));
		rpc.handle(JSON.stringify({ jsonrpc: '2.0', id: 'c', method: 'workspace/configuration', params: { items: [{}, {}] } }));
		rpc.handle(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'nope/unknown' }));
		rpc.handle('not json');
		await tick();
		expect(sent).toContainEqual({ jsonrpc: '2.0', id: 'c', result: [null, null] });
		expect(sent.find((m) => m.id === 9).error.code).toBe(-32601);

		let cancel = () => {};
		const p = rpc.request('slow', {}, { isCancellationRequested: false, onCancellationRequested: (cb) => (cancel = cb) });
		cancel();
		expect(sent.at(-1)).toEqual({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 1 } });
		rpc.close('gone');
		expect(await p.catch((e) => String(e))).toContain('gone');
		expect(await rpc.request('after').catch((e) => String(e))).toContain('gone');
	});
});

/** A scripted server on the other end of a LanguageClient. */
function harness(capabilities: object) {
	const sent: any[] = [];
	const statuses: ServerStatus[] = [];
	const diags: [string, string, Diagnostic[]][] = [];
	const client = new LanguageClient('test-ls', (j) => sent.push(JSON.parse(j)), {
		diagnostics: (uri, kind, items) => diags.push([uri, kind, items]),
		status: (s) => statuses.push(s),
		log: () => {}
	});
	const reply = (id: number, result: unknown) => client.rpc.handle(JSON.stringify({ jsonrpc: '2.0', id, result }));
	const notify = (method: string, params: unknown) => client.rpc.handle(JSON.stringify({ jsonrpc: '2.0', method, params }));
	const init = async () => {
		const done = client.initialize('file:///ws');
		reply(sent[0].id, { capabilities });
		await done;
	};
	return { client, sent, statuses, diags, reply, notify, init };
}

describe('LanguageClient', () => {
	test('initialize, then document sync with full text', async () => {
		const h = harness({ textDocumentSync: { openClose: true, change: 2, save: { includeText: true } } });
		await h.init();
		expect(h.sent[0].method).toBe('initialize');
		expect(h.sent[0].params.rootUri).toBe('file:///ws');
		expect(h.sent[0].params.capabilities.general.positionEncodings).toEqual(['utf-16']);
		expect(h.sent[1].method).toBe('initialized');
		expect(h.statuses.at(-1)).toEqual({ state: 'ready', message: undefined });

		h.client.didOpen('file:///ws/a.rs', 'rust', 'fn a() {}');
		h.client.didChange('file:///ws/a.rs', 'fn b() {}');
		h.client.didSave('file:///ws/a.rs');
		h.client.didClose('file:///ws/a.rs');
		h.client.didChange('file:///ws/a.rs', 'ignored after close');
		expect(h.sent.slice(2).map((m) => m.method)).toEqual(['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didSave', 'textDocument/didClose']);
		expect(h.sent[3].params).toEqual({ textDocument: { uri: 'file:///ws/a.rs', version: 2 }, contentChanges: [{ text: 'fn b() {}' }] });
		expect(h.sent[4].params.text).toBe('fn b() {}');
	});

	test('progress drives indexing → ready, and publishDiagnostics reaches the store', async () => {
		const h = harness({ textDocumentSync: 1 });
		await h.init();
		h.notify('$/progress', { token: 't', value: { kind: 'begin', title: 'Indexing', percentage: 10 } });
		expect(h.statuses.at(-1)).toEqual({ state: 'indexing', message: 'Indexing (10%)' });
		h.notify('$/progress', { token: 't', value: { kind: 'report', message: '3/40' } });
		expect(h.statuses.at(-1)?.message).toBe('Indexing: 3/40 (10%)');
		h.notify('$/progress', { token: 't', value: { kind: 'end' } });
		expect(h.statuses.at(-1)?.state).toBe('ready');
		h.notify('experimental/serverStatus', { health: 'ok', quiescent: false });
		expect(h.statuses.at(-1)?.state).toBe('indexing');

		const d = { range: range(0, 0, 0, 1), severity: 1, message: 'boom' };
		h.notify('textDocument/publishDiagnostics', { uri: 'file:///ws/a.rs', diagnostics: [d] });
		expect(h.diags).toEqual([['file:///ws/a.rs', 'push', [d]]]);
	});

	test('pulls diagnostics after open and drops stale results', async () => {
		const h = harness({ textDocumentSync: 2, diagnosticProvider: {} });
		await h.init();
		h.client.didOpen('file:///ws/a.rs', 'rust', 'x');
		await new Promise((r) => setTimeout(r, 300));
		const pull = h.sent.find((m) => m.method === 'textDocument/diagnostic');
		expect(pull.params).toEqual({ textDocument: { uri: 'file:///ws/a.rs' } });
		h.client.didChange('file:///ws/a.rs', 'y'); // makes the in-flight pull stale
		h.reply(pull.id, { kind: 'full', items: [{ range: range(0, 0, 0, 1), message: 'old' }] });
		await tick();
		expect(h.diags).toEqual([]);
		await new Promise((r) => setTimeout(r, 300));
		const again = h.sent.filter((m) => m.method === 'textDocument/diagnostic').at(-1);
		h.reply(again.id, { kind: 'full', items: [{ range: range(0, 0, 0, 1), message: 'new' }] });
		await tick();
		expect(h.diags.map(([, kind, items]) => [kind, items[0].message])).toEqual([['pull', 'new']]);
	});

	test('answers progress-create and configuration requests', async () => {
		const h = harness({});
		await h.init();
		h.client.rpc.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'window/workDoneProgress/create', params: { token: 'x' } }));
		h.client.rpc.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'workspace/configuration', params: { items: [{ section: 'rust-analyzer' }] } }));
		await tick();
		expect(h.sent.filter((m) => 'result' in m)).toEqual([
			{ jsonrpc: '2.0', id: 0, result: null },
			{ jsonrpc: '2.0', id: 1, result: [null] }
		]);
	});

	test('a server exit fails pending requests and reports status', async () => {
		const h = harness({ hoverProvider: true });
		await h.init();
		const hover = h.client.hover('file:///ws/a.rs', { line: 0, character: 0 });
		h.client.exited(101);
		expect(await hover.catch((e) => String(e))).toContain('exited');
		expect(h.statuses.at(-1)).toEqual({ state: 'error', message: 'exited with code 101' });
	});
});

describe('server table and status text', () => {
	test('languages map to the same servers as Rust', () => {
		expect(serverFor('javascript')?.key).toBe('typescript');
		expect(serverFor('rust')?.name).toBe('rust-analyzer');
		expect(serverFor('markdown')).toBeUndefined();
	});

	test('status bar text', () => {
		const ra = serverFor('rust')!;
		expect(statusText(ra, { state: 'indexing' })).toBe('rust-analyzer: indexing…');
		expect(statusText(ra, { state: 'ready' })).toBe('rust-analyzer: ready');
		expect(statusText(serverFor('typescript')!, { state: 'not-installed', message: 'x' })).toBe('ไม่ได้ติดตั้ง TypeScript language server');
		expect(statusText(serverFor('python')!, { state: 'not-installed' })).toBe('ไม่ได้ติดตั้ง basedpyright');
	});

	test('every language a file opens as reaches its server (keys as in Rust spec_for)', () => {
		const cases: [string, string][] = [
			['src/App.svelte', 'svelte'],
			['main.py', 'python'],
			['stubs/x.pyi', 'python'],
			['package.json', 'json'],
			['a.jsonc', 'json'],
			['style.css', 'css'],
			['style.scss', 'css'],
			['theme.less', 'css'],
			['index.html', 'html'],
			['page.htm', 'html'],
			['ci.yml', 'yaml'],
			['.github/workflows/ci.yaml', 'yaml'],
			['Cargo.toml', 'toml'],
			['lib.rs', 'rust'],
			['a.ts', 'typescript'],
			['b.mjs', 'typescript'],
			['main.go', 'go']
		];
		for (const [path, key] of cases) expect([path, serverFor(languageFor(path))?.key]).toEqual([path, key]);
		for (const path of ['README.md', 'Makefile', '.gitignore', 'x.ini', 'q.sql']) expect([path, serverFor(languageFor(path))]).toEqual([path, undefined]);
		expect(new Set(SERVERS.map((s) => s.key))).toEqual(new Set(['rust', 'typescript', 'go', 'svelte', 'python', 'json', 'css', 'html', 'yaml', 'toml']));
	});

	test('language ids', () => {
		expect(languageFor('App.svelte')).toBe('svelte');
		expect(languageFor('Cargo.TOML')).toBe('toml');
		expect(languageFor('a.YML')).toBe('yaml');
		expect(languageFor('.yml')).toBe('plaintext');
		expect(languageFor('dir.d/file')).toBe('plaintext');
		expect(EXTRA_LANGUAGES.map((l) => l.id)).toEqual(['svelte', 'toml']);
		// JSON with comments is `jsonc` for the language server only (Monaco has one JSON language).
		expect(lspLanguageId('json', 'tsconfig.json')).toBe('jsonc');
		expect(lspLanguageId('json', 'tsconfig.node.json')).toBe('jsonc');
		expect(lspLanguageId('json', '.kingu/settings.json')).toBe('jsonc');
		expect(lspLanguageId('json', 'a/b.jsonc')).toBe('jsonc');
		expect(lspLanguageId('json', 'package.json')).toBe('json');
		expect(lspLanguageId('svelte', 'App.svelte')).toBe('svelte');
	});

	test('kingu.lsp.disabled', () => {
		const d = parseDisabled(' python,YAML  css ');
		expect([...d]).toEqual(['python', 'yaml', 'css']);
		expect(isDisabled(serverFor('python')!, d)).toBe(true);
		expect(isDisabled(serverFor('scss')!, d)).toBe(true);
		expect(isDisabled(serverFor('rust')!, d)).toBe(false);
		expect(isDisabled(serverFor('less')!, parseDisabled('less'))).toBe(true);
		expect(parseDisabled(undefined).size).toBe(0);
		expect(parseDisabled('').size).toBe(0);
	});

	test('install picks show the argv Rust chose', () => {
		const info = {
			server: 'Svelte language server',
			binary: 'svelteserver',
			methods: [
				{ tool: 'bun', argv: ['bun', 'add', '-g', 'svelte-language-server'] },
				{ tool: 'npm', argv: ['/Users/me/My Tools/npm', 'i', '-g', 'svelte-language-server'] }
			]
		};
		expect(installItems(info)).toEqual([
			{ id: '0', label: 'bun add -g svelte-language-server', description: 'แนะนำ' },
			{ id: '1', label: "'/Users/me/My Tools/npm' i -g svelte-language-server", description: undefined }
		]);
		expect(installItems({ ...info, methods: [] })).toEqual([]);
		expect(shellWord('golang.org/x/tools/gopls@latest')).toBe('golang.org/x/tools/gopls@latest');
		expect(shellWord("it's")).toBe(`'it'\\''s'`);
	});

	test('initialization options and settings the servers need', () => {
		const svelte = serverFor('svelte')!.initializationOptions as { configuration: Record<string, unknown> };
		for (const section of ['typescript', 'javascript', 'svelte']) expect(svelte.configuration[section]).toBeDefined();
		for (const lang of ['json', 'css', 'html']) expect(serverFor(lang)!.initializationOptions).toMatchObject({ provideFormatter: true });
		expect(configurationValue(serverFor('yaml')!.settings!, 'yaml')).toMatchObject({ validate: true, schemaStore: { enable: true } });
		expect(configurationValue(serverFor('json')!.settings!, 'json.validate.enable')).toBe(true);
		// Unknown sections are `{}`, not null: yaml reads `http.proxy`, svelte `typescript.*`.
		expect(configurationValue({}, 'http')).toEqual({});
		expect(configurationValue({}, 'basedpyright.analysis')).toEqual({});
		expect(configurationValue({ a: { b: false } }, 'a.b')).toBe(false);
	});
});
