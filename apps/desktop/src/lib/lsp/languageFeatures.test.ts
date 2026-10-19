import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LanguageClient, type RefreshKind } from './client';
import {
	applySemanticTokensEdits,
	decodeSemanticTokens,
	encodeSemanticTokens,
	restyleSemanticTokens,
	toCodeLens,
	toColorPresentations,
	toFoldingRanges,
	toInlayHint,
	toLinkedEditingRanges,
	toSelectionRanges
} from './languageFeatures';
import { monacoThemeColors, parseSelector, resolveScopes, scopeScore, selectorScore, SemanticStyler } from './semanticStyle';
import { cssSettings, htmlSettings, jsonSchemaAssociations, jsonSettings, nest, serverSettings, typescriptPreferences, typescriptSettings, type SettingsReader } from './serverSettings';
import type { ServerCapabilities } from './protocol';
import { flattenTheme } from '../editor/textmate/theme';
import { semanticHighlightingFrom } from '../settings/mappings';
import { SETTINGS } from '../settings/registry';

const range = (l1: number, c1: number, l2: number, c2: number) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A fake transport: what the client sends, and a way to answer as the server. */
function fakeServer(capabilities: ServerCapabilities, refresh?: (k: RefreshKind) => void) {
	const sent: any[] = [];
	const client = new LanguageClient('fake-ls', (j) => sent.push(JSON.parse(j)), { diagnostics: () => {}, status: () => {}, log: () => {}, refresh });
	const reply = (id: number, result: unknown) => client.rpc.handle(JSON.stringify({ jsonrpc: '2.0', id, result }));
	const fail = (id: number, code: number) => client.rpc.handle(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: 'x' } }));
	const request = (id: number, method: string, params?: unknown) => client.rpc.handle(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
	const init = async () => {
		const done = client.initialize('file:///ws');
		reply(sent[0].id, { capabilities });
		await done;
	};
	/** Starts a request, answers it with `result`, returns [what was sent, the client's result]. */
	const roundTrip = async <T>(call: () => Promise<T>, result: unknown): Promise<[any, T]> => {
		const p = call();
		const req = sent.at(-1);
		reply(req.id, result);
		return [req, await p];
	};
	return { client, sent, reply, fail, request, init, roundTrip };
}

describe('client capabilities and gating', () => {
	test('advertises every new feature, refresh support and rust-analyzer client commands', async () => {
		const s = fakeServer({});
		await s.init();
		const caps = s.sent[0].params.capabilities;
		for (const f of ['declaration', 'typeDefinition', 'implementation']) expect(caps.textDocument[f]).toEqual({ linkSupport: true });
		expect(caps.textDocument.semanticTokens.requests).toEqual({ range: true, full: { delta: true } });
		expect(caps.textDocument.semanticTokens.formats).toEqual(['relative']);
		expect(caps.textDocument.semanticTokens.tokenTypes).toContain('enumMember');
		expect(caps.textDocument.foldingRange.lineFoldingOnly).toBe(true);
		for (const f of ['inlayHint', 'codeLens', 'callHierarchy', 'typeHierarchy', 'linkedEditingRange', 'onTypeFormatting', 'selectionRange', 'documentLink', 'colorProvider']) expect(caps.textDocument[f]).toBeDefined();
		expect(caps.workspace).toMatchObject({ semanticTokens: { refreshSupport: true }, inlayHint: { refreshSupport: true }, codeLens: { refreshSupport: true } });
		expect(caps.experimental.commands.commands).toContain('rust-analyzer.showReferences');
	});

	test('nothing is requested for features the server does not advertise', async () => {
		const s = fakeServer({});
		await s.init();
		const at = { line: 0, character: 0 };
		const u = 'file:///ws/a.ts';
		const results = await Promise.all([
			s.client.declaration(u, at),
			s.client.typeDefinition(u, at),
			s.client.implementation(u, at),
			s.client.inlayHints(u, range(0, 0, 1, 0)),
			s.client.semanticTokens(u),
			s.client.semanticTokensEdits(u, '1'),
			s.client.semanticTokensInRange(u, range(0, 0, 1, 0)),
			s.client.foldingRanges(u),
			s.client.codeLenses(u),
			s.client.prepareCallHierarchy(u, at),
			s.client.prepareTypeHierarchy(u, at),
			s.client.linkedEditingRange(u, at),
			s.client.onTypeFormatting(u, at, '}', { tabSize: 2, insertSpaces: true }),
			s.client.selectionRanges(u, [at]),
			s.client.documentLinks(u),
			s.client.documentColors(u)
		]);
		expect(results.every((r) => r === null)).toBe(true);
		expect(s.sent.length).toBe(2); // initialize, initialized
		expect(s.client.canResolveInlayHint || s.client.canResolveCodeLens || s.client.canResolveDocumentLink).toBe(false);
		expect(s.client.semanticTokensLegend).toBeNull();
	});

	test('semantic token capabilities: full only, delta, range', async () => {
		const legend = { tokenTypes: ['variable'], tokenModifiers: [] };
		const full = fakeServer({ semanticTokensProvider: { legend, full: true } });
		await full.init();
		expect([full.client.semanticTokensFull, full.client.semanticTokensDelta, full.client.semanticTokensRange]).toEqual([true, false, false]);
		expect(await full.client.semanticTokensEdits('file:///ws/a', '1')).toBeNull();
		const delta = fakeServer({ semanticTokensProvider: { legend, full: { delta: true }, range: true } });
		await delta.init();
		expect([delta.client.semanticTokensFull, delta.client.semanticTokensDelta, delta.client.semanticTokensRange]).toEqual([true, true, true]);
		expect(delta.client.semanticTokensLegend).toEqual(legend);
	});

	test('requests carry the LSP shapes, results come back as sent', async () => {
		const s = fakeServer({
			implementationProvider: true,
			inlayHintProvider: { resolveProvider: true },
			semanticTokensProvider: { legend: { tokenTypes: [], tokenModifiers: [] }, full: { delta: true } },
			codeLensProvider: { resolveProvider: true },
			callHierarchyProvider: true,
			typeHierarchyProvider: true,
			documentOnTypeFormattingProvider: { firstTriggerCharacter: '}', moreTriggerCharacter: [';'] },
			selectionRangeProvider: true,
			colorProvider: true
		});
		await s.init();
		const u = 'file:///ws/a.ts';
		const at = { line: 3, character: 4 };
		let [req] = await s.roundTrip(() => s.client.implementation(u, at), []);
		expect(req).toMatchObject({ method: 'textDocument/implementation', params: { textDocument: { uri: u }, position: at } });
		[req] = await s.roundTrip(() => s.client.inlayHints(u, range(0, 0, 9, 0)), []);
		expect(req).toMatchObject({ method: 'textDocument/inlayHint', params: { range: range(0, 0, 9, 0) } });
		[req] = await s.roundTrip(() => s.client.semanticTokensEdits(u, '7'), { edits: [] });
		expect(req).toMatchObject({ method: 'textDocument/semanticTokens/full/delta', params: { previousResultId: '7' } });
		[req] = await s.roundTrip(() => s.client.onTypeFormatting(u, at, '}', { tabSize: 2, insertSpaces: true }), []);
		expect(req.params).toEqual({ textDocument: { uri: u }, position: at, ch: '}', options: { tabSize: 2, insertSpaces: true } });
		[req] = await s.roundTrip(() => s.client.selectionRanges(u, [at, { line: 0, character: 0 }]), []);
		expect(req.params.positions.length).toBe(2);
		const item = { name: 'f', kind: 12, uri: u, range: range(0, 0, 2, 1), selectionRange: range(0, 9, 0, 10) };
		let incoming;
		[req, incoming] = await s.roundTrip(() => s.client.incomingCalls(item), [{ from: item, fromRanges: [range(5, 2, 5, 3)] }]);
		expect(req).toMatchObject({ method: 'callHierarchy/incomingCalls', params: { item } });
		expect(incoming?.[0].fromRanges.length).toBe(1);
		[req] = await s.roundTrip(() => s.client.subtypes(item), []);
		expect(req.method).toBe('typeHierarchy/subtypes');
		[req] = await s.roundTrip(() => s.client.colorPresentations(u, { red: 1, green: 0, blue: 0, alpha: 1 }, range(0, 0, 0, 7)), []);
		expect(req).toMatchObject({ method: 'textDocument/colorPresentation', params: { color: { red: 1 } } });
	});

	test('cancellation reaches the server as $/cancelRequest', async () => {
		const s = fakeServer({ foldingRangeProvider: true });
		await s.init();
		let cancel: () => void = () => {};
		const token = { isCancellationRequested: false, onCancellationRequested: (cb: () => void) => (cancel = cb) };
		const p = s.client.foldingRanges('file:///ws/a.ts', token);
		const id = s.sent.at(-1).id;
		cancel();
		expect(s.sent.at(-1)).toMatchObject({ method: '$/cancelRequest', params: { id } });
		s.fail(id, -32800);
		await expect(p).rejects.toThrow();
	});

	test('refresh requests reach the hook and are answered', async () => {
		const kinds: RefreshKind[] = [];
		const s = fakeServer({}, (k) => kinds.push(k));
		await s.init();
		s.request(20, 'workspace/semanticTokens/refresh');
		s.request(21, 'workspace/inlayHint/refresh');
		s.request(22, 'workspace/codeLens/refresh');
		await tick();
		expect(kinds).toEqual(['semanticTokens', 'inlayHint', 'codeLens']);
		expect(s.sent.filter((m) => m.id >= 20 && 'result' in m).length).toBe(3);
	});

	test('didChangeConfiguration pushes the settings once the server is up', async () => {
		const s = fakeServer({});
		s.client.didChangeConfiguration({ a: 1 }); // before initialize: dropped
		await s.init();
		s.client.didChangeConfiguration({ css: { validate: false } });
		expect(s.sent.at(-1)).toEqual({ jsonrpc: '2.0', method: 'workspace/didChangeConfiguration', params: { settings: { css: { validate: false } } } });
		expect(s.sent.filter((m) => m.method === 'workspace/didChangeConfiguration').length).toBe(1);
	});
});

describe('semantic tokens', () => {
	test('delta edits apply to the previous data in any order', () => {
		const prev = [0, 0, 3, 1, 0, 1, 2, 4, 2, 1, 0, 6, 2, 0, 0];
		// Replace token 2's type (index 8), delete token 3, insert one at the start.
		const next = applySemanticTokensEdits(prev, [
			{ start: 10, deleteCount: 5 },
			{ start: 8, deleteCount: 1, data: [9] },
			{ start: 0, deleteCount: 0, data: [0, 0, 1, 3, 0] }
		]);
		expect(next).toEqual([0, 0, 1, 3, 0, 0, 0, 3, 1, 0, 1, 2, 4, 9, 1]);
		expect(applySemanticTokensEdits(prev, [])).toEqual(prev);
		expect(() => applySemanticTokensEdits(prev, [{ start: 14, deleteCount: 5 }])).toThrow();
		expect(() => applySemanticTokensEdits(prev, [{ start: 0, deleteCount: 6 }, { start: 5, deleteCount: 0 }])).toThrow();
	});

	test('relative encoding round-trips', () => {
		const data = [1, 4, 3, 0, 1, 0, 6, 2, 1, 0, 3, 0, 5, 2, 3];
		const tokens = decodeSemanticTokens(data);
		expect(tokens.map((t) => [t.line, t.char])).toEqual([[1, 4], [1, 10], [4, 0]]);
		expect([...encodeSemanticTokens(tokens.map((t) => ({ ...t, modifiers: 0 })))]).toEqual(data.map((v, i) => (i % 5 === 4 ? 0 : v)));
	});

	test('restyling drops unstyled tokens and keeps positions right', () => {
		// Three tokens on line 0 (cols 0, 4, 9); the middle one has no style.
		const data = [0, 0, 3, 0, 0, 0, 4, 3, 1, 0, 0, 5, 2, 2, 1];
		const out = restyleSemanticTokens(data, (type, mods) => (type === 1 ? -1 : 10 + type + mods));
		expect([...out]).toEqual([0, 0, 3, 10, 0, 0, 9, 2, 13, 0]);
	});
});

describe('semantic styling like VS Code', () => {
	const read = (p: string) => readFileSync(join(import.meta.dir, '../editor/textmate/themes', p), 'utf8');
	const dark = flattenTheme('dark_plus.json', read);

	test('the theme chain carries semanticHighlighting and semanticTokenColors', () => {
		expect(dark.semanticHighlighting).toBe(true); // from dark_vs.json
		expect(dark.semanticTokenColors?.numberLiteral).toBe('#b5cea8');
		expect(flattenTheme('dark_modern.json', read).semanticHighlighting).toBe(true);
	});

	test('selector scoring: type hierarchy, modifiers, language', () => {
		const sel = (s: string) => parseSelector(s)!;
		expect(selectorScore(sel('variable'), 'variable', [], 'ts')).toBe(100);
		expect(selectorScore(sel('variable.readonly'), 'variable', ['readonly', 'declaration'], 'ts')).toBe(200);
		expect(selectorScore(sel('variable.readonly'), 'variable', [], 'ts')).toBe(-1);
		expect(selectorScore(sel('method'), 'member', [], 'ts')).toBe(99);
		expect(selectorScore(sel('*.deprecated'), 'class', ['deprecated'], 'ts')).toBe(100);
		expect(selectorScore(sel('variable:rust'), 'variable', [], 'ts')).toBe(-1);
		expect(selectorScore(sel('variable:rust'), 'variable', [], 'rust')).toBe(110);
	});

	test('TextMate scope probes: prefix match, longest selector wins, descendant selectors never match', () => {
		expect(scopeScore('variable', 'variable.other.constant')).toBe(0x10000 + 8);
		expect(scopeScore(['variable.other.constant', 'foo'], 'variable.other.constant')).toBe(0x10000 + 23);
		expect(scopeScore('variable.other', 'variable')).toBe(-1);
		expect(scopeScore('meta.block variable', 'variable')).toBe(-1);
		expect(scopeScore('variable.other - meta', 'variable.other.readwrite')).toBe(0x10000 + 14);
		const rules = [
			{ scope: 'variable', settings: { foreground: '#111111' } },
			{ scope: 'variable.other.constant', settings: { foreground: '#222222', fontStyle: 'italic' } }
		];
		expect(resolveScopes(rules, ['variable.other.constant'])).toEqual({ foreground: '#222222', italic: true, bold: false, underline: false, strikethrough: false });
		expect(resolveScopes(rules, ['nothing', 'variable.other.readwrite'])).toEqual({ foreground: '#111111' });
		expect(resolveScopes(rules, ['comment'])).toBeUndefined();
	});

	test('Dark+ colors: theme rules first, then the scope fallbacks; unstyled tokens stay TextMate', () => {
		const theme = { ...dark, semanticTokenColors: { ...dark.semanticTokenColors, 'variable.readonly:typescript': '#ABCDEF', 'property.deprecated': { strikethrough: true } } };
		const styler = new SemanticStyler(theme, 'dark', ['', '#D4D4D4', '#1E1E1E', '#4FC1FF', '#9CDCFE', '#DCDCAA']);
		// `variable.readonly` → variable.other.constant (Dark+: #4FC1FF).
		expect(styler.styleOf('variable', ['readonly'], 'rust')?.foreground).toBe('#4FC1FF');
		expect(styler.styleOf('variable', ['readonly'], 'typescript')?.foreground).toBe('#ABCDEF');
		expect(styler.styleOf('function', [], 'rust')?.foreground).toBe('#DCDCAA');
		expect(styler.styleOf('label', [], 'rust')).toBeUndefined();
		const deprecated = styler.styleOf('property', ['deprecated'], 'rust');
		expect(deprecated?.strikethrough).toBe(true);
		expect(deprecated?.foreground).toBe('#9CDCFE');
		// The synthetic type carries id and font bits; colors no rule uses have none.
		expect(styler.tokenName(styler.styleOf('variable', ['readonly'], 'rust'))).toBe('kg_3_0');
		expect(styler.tokenName({ foreground: '#123456' })).toBeNull();
		expect(styler.tokenName({ bold: true })).toBeNull();
		expect(styler.colorMap.at(-1)).toBe('#ABCDEF'); // a semantic-only color is appended
	});

	test("Monaco's color ids line up with the color map, alpha duplicates included", () => {
		const styler = new SemanticStyler({ colors: {}, tokenColors: [], semanticTokenColors: { comment: '#FE0000' } }, 'dark', [undefined, '#D4D4D4', '#1E1E1E', '#D4D4D480', '#FE0001']);
		const { seed, rules } = monacoThemeColors(styler);
		expect(styler.colorMap).toEqual(['', '#D4D4D4', '#1E1E1E', '#D4D4D480', '#FE0001', '#FE0000']);
		expect(seed.length).toBe(5);
		expect(new Set(seed).size).toBe(5); // distinct, so Monaco gives ids 1…5 in order
		expect(seed[0]).toBe('#D4D4D4');
		expect(seed[2]).not.toBe('#D4D4D4'); // the alpha twin gets a placeholder
		expect(seed.slice(3)).toEqual(['#FE0001', '#FE0000']);
		expect(rules.length).toBe(5 * 16);
		expect(rules.find((r) => r.token === 'kg_5_3')).toEqual({ token: 'kg_5_3', foreground: '#FE0000', fontStyle: 'italic bold' });
	});

	test('editor.semanticHighlighting.enabled: configuredByTheme follows the theme', () => {
		expect(semanticHighlightingFrom('configuredByTheme', true)).toBe(true);
		expect(semanticHighlightingFrom('configuredByTheme', false)).toBe(false);
		expect(semanticHighlightingFrom(true, false)).toBe(true);
		expect(semanticHighlightingFrom(false, true)).toBe(false);
		expect(semanticHighlightingFrom(undefined, true)).toBeUndefined();
	});
});

describe('LSP → Monaco shapes', () => {
	const mapCommand = (c: { title: string; command: string }) => ({ id: 'run', title: c.title, arguments: [c.command] });
	const mapLocation = (l: { uri: string; range: ReturnType<typeof range> }) => ({ uri: l.uri as never, range: { startLineNumber: l.range.start.line + 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } });

	test('inlay hints: position, label parts, kind, padding, edits', () => {
		const h = toInlayHint(
			{
				position: { line: 2, character: 5 },
				label: [{ value: 'x', tooltip: { kind: 'markdown', value: '**x**' }, location: { uri: 'file:///ws/a.ts', range: range(0, 0, 0, 1) }, command: { title: 'Go', command: 'go' } }, { value: ':' }],
				kind: 2,
				paddingRight: true,
				textEdits: [{ range: range(2, 5, 2, 5), newText: 'x: ' }]
			},
			mapCommand,
			mapLocation
		);
		expect(h.position).toEqual({ lineNumber: 3, column: 6 });
		expect(h.kind as number).toBe(2);
		expect(h.paddingRight).toBe(true);
		const parts = h.label as { label: string; tooltip?: unknown; command?: unknown; location?: unknown }[];
		expect(parts.map((p) => p.label)).toEqual(['x', ':']);
		expect(parts[0].tooltip).toEqual({ value: '**x**' });
		expect(parts[0].command).toEqual({ id: 'run', title: 'Go', arguments: ['go'] });
		expect(parts[0].location).toBeDefined();
		expect(h.textEdits?.[0].text).toBe('x: ');
		expect(toInlayHint({ position: { line: 0, character: 0 }, label: ': i32', kind: 7 }, mapCommand, mapLocation).kind).toBeUndefined();
	});

	test('folding ranges: 1-based lines, kinds, empty ones dropped', () => {
		const out = toFoldingRanges([{ startLine: 0, endLine: 4, kind: 'imports' }, { startLine: 3, endLine: 3 }, { startLine: 5, endLine: 9, kind: 'custom' }], (k) => `K:${k}`);
		expect(out).toEqual([{ start: 1, end: 5, kind: 'K:imports' }, { start: 6, end: 10, kind: 'K:custom' }]);
		expect(toFoldingRanges(null, (k) => k)).toEqual([]);
	});

	test('selection ranges: innermost first per position', () => {
		const out = toSelectionRanges([{ range: range(0, 4, 0, 7), parent: { range: range(0, 0, 0, 12), parent: { range: range(0, 0, 3, 0) } } }]);
		expect(out.length).toBe(1);
		expect(out[0].map((s) => [s.range.startColumn, s.range.endColumn])).toEqual([[5, 8], [1, 13], [1, 1]]);
	});

	test('code lens, colors, linked editing', () => {
		expect(toCodeLens({ range: range(1, 0, 1, 3), command: { title: '2 references', command: 'x' } }, mapCommand)).toEqual({
			range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 4 },
			command: { id: 'run', title: '2 references', arguments: ['x'] }
		});
		expect(toCodeLens({ range: range(0, 0, 0, 1) }, mapCommand).command).toBeUndefined();
		expect(toColorPresentations([{ label: 'rgb(255, 0, 0)', textEdit: { range: range(0, 0, 0, 4), newText: 'red' } }])[0].textEdit?.text).toBe('red');
		const linked = toLinkedEditingRanges({ ranges: [range(0, 1, 0, 4), range(0, 10, 0, 13)], wordPattern: '[a-z]+' });
		expect(linked?.ranges.length).toBe(2);
		expect(linked?.wordPattern?.test('div')).toBe(true);
		expect(toLinkedEditingRanges({ ranges: [range(0, 0, 0, 1)], wordPattern: '(' })?.wordPattern).toBeUndefined();
		expect(toLinkedEditingRanges({ ranges: [] })).toBeNull();
	});
});

describe('VS Code settings to the servers', () => {
	const reader = (values: Record<string, unknown>, folder: Record<string, unknown> = {}): SettingsReader => {
		const defaults = Object.fromEntries(SETTINGS.map((s) => [s.id, s.default]));
		return {
			get: <T>(id: string) => (id in folder ? folder[id] : id in values ? values[id] : defaults[id]) as T,
			isSet: (id) => id in values || id in folder,
			layer: (id, scope) => (scope === 'user' ? values[id] : folder[id])
		};
	};

	test('every delivered setting is registered (no typos in the tables)', () => {
		const known = new Set(SETTINGS.map((s) => s.id));
		const source = readFileSync(join(import.meta.dir, 'serverSettings.ts'), 'utf8');
		const ids = [...source.matchAll(/'((?:js\/ts|typescript|javascript|css|scss|less|html|json|http|editor)\.[\w.]+)'/g)].map((m) => m[1]);
		expect(ids.length).toBeGreaterThan(150);
		expect(ids.filter((id) => !known.has(id))).toEqual([]);
	});

	test('TypeScript: inlay hints per language, unified js/ts keys win when set', () => {
		const ts = typescriptSettings(reader({ 'typescript.inlayHints.parameterNames.enabled': 'all', 'javascript.inlayHints.variableTypes.enabled': true, 'js/ts.inlayHints.functionLikeReturnTypes.enabled': true }));
		const t = ts.typescript as any;
		const j = ts.javascript as any;
		expect(t.inlayHints.includeInlayParameterNameHints).toBe('all');
		expect(j.inlayHints.includeInlayParameterNameHints).toBe('none');
		expect(j.inlayHints.includeInlayVariableTypeHints).toBe(true);
		expect(t.inlayHints.includeInlayVariableTypeHints).toBe(false);
		expect(t.inlayHints.includeInlayFunctionLikeReturnTypeHints && j.inlayHints.includeInlayFunctionLikeReturnTypeHints).toBe(true);
		// VS Code's "suppress when it matches" is tsserver's "include when it matches", inverted.
		expect(t.inlayHints.includeInlayParameterNameHintsWhenArgumentMatchesName).toBe(false);
		expect(t.format.semicolons).toBe('ignore');
		expect(t.referencesCodeLens).toEqual({ enabled: false, showOnAllFunctions: false });
		const unified = typescriptSettings(reader({ 'typescript.inlayHints.parameterNames.enabled': 'all', 'js/ts.inlayHints.parameterNames.enabled': 'literals' }));
		expect((unified.typescript as any).inlayHints.includeInlayParameterNameHints).toBe('literals');
		expect(ts.implicitProjectConfiguration).toMatchObject({ strict: true, target: 'ES2024', module: 'ESNext' });
	});

	test('TypeScript preferences for initializationOptions', () => {
		const p = typescriptPreferences(reader({ 'typescript.preferences.quoteStyle': 'single', 'js/ts.suggest.autoImports': false, 'js/ts.hover.maximumLength': -3 }));
		expect(p).toMatchObject({ quotePreference: 'single', includeCompletionsForModuleExports: false, importModuleSpecifierPreference: 'shortest', maximumHoverLength: 500, autoImportFileExcludePatterns: [] });
	});

	test('CSS and HTML sections are VS Code’s nested configuration', () => {
		const css = cssSettings(reader({ 'scss.lint.zeroUnits': 'warning', 'css.validate': false }));
		expect((css.css as any).validate).toBe(false);
		expect((css.scss as any).lint.zeroUnits).toBe('warning');
		expect((css.less as any).format.braceStyle).toBe('collapse');
		const html = htmlSettings(reader({ 'html.format.wrapLineLength': 80 }));
		expect((html.html as any).format.wrapLineLength).toBe(80);
		expect((html.css as any).lint).toBeDefined();
		expect((html.javascript as any).format.insertSpaceAfterCommaDelimiter).toBe(true);
		expect(nest(['a.b.c', 'a.d'], (id) => id)).toEqual({ a: { b: { c: 'a.b.c' }, d: 'a.d' } });
		expect(serverSettings('rust', reader({}), 'file:///ws')).toEqual({});
	});

	test('JSON: limits ask for one more, schemas resolve like VS Code’s client', () => {
		const j = jsonSettings(reader({ 'json.maxItemsComputed': 100, 'json.format.keepLines': true }), 'file:///ws') as any;
		expect(j.json).toMatchObject({ validate: { enable: true }, keepLines: { enable: true }, resultLimit: 101, jsonFoldingLimit: 5001, jsonColorDecoratorLimit: 501 });
		const schemas = jsonSchemaAssociations(
			[{ fileMatch: ['a.json'], url: './user.json' }, { fileMatch: ['b.json'], schema: { type: 'object' } }],
			[{ fileMatch: ['${workspaceFolder}/c.json', '!${workspaceFolder}/d.json'], url: './schemas/c.json' }, { url: 'https://x/s.json' }, { fileMatch: ['e'] }],
			'file:///ws/my%20app'
		);
		expect(schemas).toEqual([
			{ url: './user.json', fileMatch: ['a.json'], schema: undefined },
			{ url: 'vscode://schemas/custom/1', fileMatch: ['b.json'], schema: { type: 'object' } },
			{ url: 'file:///ws/my%20app/schemas/c.json', fileMatch: ['/ws/my app/c.json', '!/ws/my app/d.json'], schema: undefined },
			{ url: 'https://x/s.json', fileMatch: undefined, schema: undefined }
		]);
	});
});
