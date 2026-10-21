/// <reference types="bun" />
// The pure parts of the debugger extras: the Disassembly view's merging and rows, instruction
// breakpoints, the Memory view's rows and edits, Loaded Scripts' events and tree,
// serverReadyAction, auto attach's environment and inline (column) breakpoints.
import { describe, expect, test } from 'bun:test';
import { glyphs, hasInline, moveTo, parseStored, sourceBreakpoints, toggle, toggleInline } from './breakpoints.ts';
import { disassemblyRows, formatAddress, formatBytes, instructionBreakpoints, mergeInstructions, parseAddress, toggleInstructionBreakpoint } from './disassembly.ts';
import { addressAt, asciiOf, byteAt, hexByte, isRead, memoryKey, memoryRows, parseHexBytes, parseMemoryKey, putChunk } from './memory.ts';
import { applyLoadedSource, countSources, scriptTree } from './loadedScripts.ts';
import { browserConfig, parseServerReadyAction, ServerReadyDetector, serverReadyRegExp, serverReadyUri, stripAnsi, type ServerReadyMatch } from './serverReady.ts';
import { autoAttachConfig, autoAttachEnv, debugTerminalConfig, readInspectorOptions, smartPatterns } from './autoAttach.ts';
import { contributedTerminalEnv, contributeTerminalEnv, withContributedEnv } from '#lib/terminal/contributedEnv.ts';
import type { DisassembledInstruction } from './protocol.ts';

const ins = (address: string, extra: Partial<DisassembledInstruction> = {}): DisassembledInstruction => ({ address, instruction: `i ${address}`, ...extra });

describe('disassembly', () => {
	test('addresses parse as hex or decimal and format padded', () => {
		expect(parseAddress('0x10')).toBe(16n);
		expect(parseAddress('16')).toBe(16n);
		expect(parseAddress('zz')).toBeNull();
		expect(formatAddress(255n, 8)).toBe('0x000000ff');
		expect(formatBytes('4889e5')).toBe('48 89 e5');
		expect(formatBytes('48 89 E5')).toBe('48 89 e5');
	});

	test('merging keeps one instruction per address in order; an invalid one never replaces a real one', () => {
		const a = [ins('0x8'), ins('0xc')];
		const b = [ins('0x4'), ins('0x8', { presentationHint: 'invalid', instruction: '??' }), ins('0x10')];
		const merged = mergeInstructions(a, b);
		expect(merged.map((i) => i.address)).toEqual(['0x4', '0x8', '0xc', '0x10']);
		expect(merged[1].instruction).toBe('i 0x8');
		// A real instruction replaces padding.
		expect(mergeInstructions([ins('0x8', { presentationHint: 'invalid' })], [ins('0x8')])[0].presentationHint).toBeUndefined();
	});

	test('rows put a source line before the first instruction of each line; the location carries over', () => {
		const list = [ins('0x0', { location: { path: '/ws/a.c' }, line: 3 }), ins('0x4', { line: 3 }), ins('0x8', { line: 4, endLine: 5 }), ins('0xc')];
		const rows = disassemblyRows(list, '0x4', true);
		expect(rows.map((r) => (r.kind === 'source' ? `src ${r.path}:${r.line}-${r.endLine}` : `${r.ins.address}${r.current ? ' *' : ''}`))).toEqual(['src /ws/a.c:3-3', '0x0', '0x4 *', 'src /ws/a.c:4-5', '0x8', '0xc']);
		expect(disassemblyRows(list, null, false).every((r) => r.kind === 'instruction')).toBe(true);
	});

	test('instruction breakpoints toggle by address and send the enabled ones', () => {
		let bps = toggleInstructionBreakpoint([], '0x10');
		bps = toggleInstructionBreakpoint(bps, '0x20');
		expect(instructionBreakpoints(bps)).toEqual([{ instructionReference: '0x10', offset: 0 }, { instructionReference: '0x20', offset: 0 }]);
		bps = toggleInstructionBreakpoint(bps, '16');
		expect(bps.map((b) => b.address)).toEqual(['0x20']);
		expect(instructionBreakpoints(bps, false)).toEqual([]);
		expect(instructionBreakpoints([{ address: '0x30', enabled: false }])).toEqual([]);
	});
});

describe('memory', () => {
	test('rows of 16 bytes with addresses; unread bytes are null', () => {
		const chunks = [{ offset: 0, bytes: Uint8Array.from([0x41, 0x42, 0x0a]), unreadable: 0 }];
		const rows = memoryRows('0x1000', chunks, 0, 20);
		expect(rows.map((r) => r.address)).toEqual(['0x00001000', '0x00001010']);
		expect(rows[0].bytes.slice(0, 4)).toEqual([0x41, 0x42, 0x0a, null]);
		expect(asciiOf(rows[0].bytes.slice(0, 4))).toBe('AB. ');
		expect(hexByte(null)).toBe('??');
		expect(hexByte(10)).toBe('0a');
		expect(addressAt('var', 4)).toBe('var+4');
		expect(addressAt('0x10', -32)).toBe('0x00000000');
	});

	test('chunks: newer bytes win, coverage counts unreadable bytes', () => {
		let chunks = putChunk([], { offset: 0, bytes: Uint8Array.from([1, 2, 3, 4]), unreadable: 0 });
		chunks = putChunk(chunks, { offset: 4, bytes: Uint8Array.from([5]), unreadable: 3 });
		expect(isRead(chunks, 0, 8)).toBe(true);
		expect(isRead(chunks, 0, 9)).toBe(false);
		chunks = putChunk(chunks, { offset: 0, bytes: Uint8Array.from([9, 9, 9, 9]), unreadable: 0 });
		expect(byteAt(chunks, 1)).toBe(9);
		expect(byteAt(chunks, 4)).toBe(5);
		expect(byteAt(chunks, 6)).toBeNull();
	});

	test('edits parse as hex bytes', () => {
		expect([...parseHexBytes('ff')!]).toEqual([255]);
		expect([...parseHexBytes('0x1f')!]).toEqual([31]);
		expect([...parseHexBytes('de ad be ef')!]).toEqual([0xde, 0xad, 0xbe, 0xef]);
		expect([...parseHexBytes('dead')!]).toEqual([0xde, 0xad]);
		expect([...parseHexBytes('f')!]).toEqual([15]);
		expect(parseHexBytes('xyz')).toBeNull();
		expect(parseHexBytes('  ')).toBeNull();
	});

	test('editor keys round-trip', () => {
		const key = memoryKey(3, '0x7ff/abc');
		expect(parseMemoryKey(key)).toEqual({ session: 3, memoryReference: '0x7ff/abc' });
		expect(parseMemoryKey('src/a.ts')).toBeNull();
	});
});

describe('loaded scripts', () => {
	test('events add, change in place and remove', () => {
		let list = applyLoadedSource([], 'new', { name: 'a', path: '/ws/a.js' });
		list = applyLoadedSource(list, 'new', { name: 'b', path: '/ws/b.js' });
		list = applyLoadedSource(list, 'changed', { name: 'a2', path: '/ws/a.js' });
		expect(list.map((s) => s.name)).toEqual(['a2', 'b']);
		list = applyLoadedSource(list, 'removed', { path: '/ws/a.js' });
		expect(list.map((s) => s.name)).toEqual(['b']);
		expect(applyLoadedSource(list, 'changed', { name: 'c', sourceReference: 3 }).map((s) => s.name)).toEqual(['b', 'c']);
	});

	test('the tree: workspace folders first (compressed), then outside paths, filtered', () => {
		const sources = [
			{ name: 'b.js', path: '/ws/src/lib/b.js' },
			{ name: 'a.js', path: '/ws/src/lib/a.js' },
			{ name: 'index.js', path: '/ws/index.js' },
			{ name: 'fs', path: '/usr/lib/node/fs.js' },
			{ name: '<node_internals>/events', sourceReference: 4 }
		];
		const tree = scriptTree(sources, '/ws');
		const flat = (nodes: ReturnType<typeof scriptTree>, d = 0): string[] => nodes.flatMap((n) => [`${'  '.repeat(d)}${n.label}`, ...(n.kind === 'folder' ? flat(n.children, d + 1) : [])]);
		expect(flat(tree)).toEqual(['src/lib', '  a.js', '  b.js', 'index.js', '/usr/lib/node', '  fs.js', '<node_internals>', '  events']);
		expect(countSources(tree)).toBe(5);
		expect(flat(scriptTree(sources, '/ws', 'lib/a'))).toEqual(['src/lib', '  a.js']);
	});
});

describe('serverReadyAction', () => {
	test('defaults and parsing', () => {
		expect(parseServerReadyAction(undefined)).toBeNull();
		const a = parseServerReadyAction({ action: 'bogus' })!;
		expect(a.action).toBe('openExternally');
		expect(a.pattern).toBe('listening on.* (https?://\\S+|[0-9]+)');
		expect(parseServerReadyAction({ action: 'startDebugging', name: 'Chrome', killOnServerStop: true })).toMatchObject({ action: 'startDebugging', name: 'Chrome', killOnServerStop: true });
	});

	test('the URI: a port goes into http://localhost:%s, a URL as it is, uriFormat wins', () => {
		const a = parseServerReadyAction({})!;
		const re = serverReadyRegExp(a)!;
		expect(serverReadyUri(a, re, 'Listening on port 3000')).toEqual({ ok: true, uri: 'http://localhost:3000' });
		expect(serverReadyUri(a, re, 'Now listening on: https://localhost:5001')).toEqual({ ok: true, uri: 'https://localhost:5001' });
		expect(serverReadyUri(a, re, 'nothing here')).toBeNull();
		const f = parseServerReadyAction({ pattern: 'ready on ([0-9]+)', uriFormat: 'https://127.0.0.1:%s/app' })!;
		expect(serverReadyUri(f, serverReadyRegExp(f)!, '\x1b[32mready on 8080\x1b[0m')).toEqual({ ok: true, uri: 'https://127.0.0.1:8080/app' });
		const noCapture = parseServerReadyAction({ pattern: 'ready', uriFormat: 'http://x/%s' })!;
		expect(serverReadyUri(noCapture, serverReadyRegExp(noCapture)!, 'ready')).toEqual({ ok: false, error: 'noCapture', format: 'http://x/%s' });
		const two = parseServerReadyAction({ pattern: 'on ([0-9]+)', uriFormat: '%s:%s' })!;
		expect(serverReadyUri(two, serverReadyRegExp(two)!, 'on 1')).toMatchObject({ ok: false, error: 'placeholders' });
		expect(serverReadyRegExp(parseServerReadyAction({ pattern: '(' })!)).toBeNull();
		expect(stripAnsi('\x1b]0;title\x07ok')).toBe('ok');
	});

	test('the detector joins chunks into lines and fires once', () => {
		const got: ServerReadyMatch[] = [];
		const d = new ServerReadyDetector(parseServerReadyAction({})!, (m) => got.push(m));
		expect(d.feed('listening on 30')).toBe(false);
		expect(d.feed('00\nmore\n')).toBe(true);
		expect(d.feed('listening on 4000\n')).toBe(false);
		expect(got).toEqual([{ ok: true, uri: 'http://localhost:3000' }]);
	});

	test('debugWithChrome / debugWithEdge configurations', () => {
		expect(browserConfig(parseServerReadyAction({ action: 'debugWithEdge', webRoot: '/w' })!, 'http://x')).toEqual({ type: 'pwa-msedge', name: 'Browser Debug', request: 'launch', url: 'http://x', webRoot: '/w' });
		expect(browserConfig(parseServerReadyAction({ action: 'debugWithChrome' })!, 'http://x').webRoot).toBe('${workspaceFolder}');
	});
});

describe('JavaScript Debug Terminal and auto attach', () => {
	test('the debug terminal runs the shell under js-debug with child processes attached', () => {
		const c = debugTerminalConfig('/bin/zsh', '/ws', { skipFiles: ['**/vendor/**'], smartStep: true });
		expect(c).toMatchObject({ type: 'pwa-node', request: 'launch', runtimeExecutable: '/bin/zsh', runtimeArgs: ['-l'], console: 'integratedTerminal', autoAttachChildProcesses: true, cwd: '/ws', smartStep: true });
		expect(c.skipFiles).toEqual(['<node_internals>/**', '**/vendor/**']);
		expect(autoAttachConfig('/bin/zsh', '/ws').name).toBe('Auto Attach');
	});

	test('smart patterns fill in the folder and the known tools', () => {
		const p = smartPatterns(undefined, '/ws');
		expect(p[0]).toBe('/ws/**');
		expect(p[1]).toBe('!**/node_modules/**');
		expect(p[2]).toContain('mocha');
		expect(smartPatterns(['src/**'], '/ws')).toEqual(['src/**']);
	});

	test('the terminal environment carries the filter mode; disabled gives none', () => {
		const raw = { NODE_OPTIONS: '--require /js/bootloader.js', VSCODE_INSPECTOR_OPTIONS: ':::{"inspectorIpc":"/tmp/x.sock","autoAttachMode":"always","onlyEntrypoint":true}', OTHER: 'x' };
		expect(readInspectorOptions(raw.VSCODE_INSPECTOR_OPTIONS)).toMatchObject({ inspectorIpc: '/tmp/x.sock' });
		const smart = autoAttachEnv(raw, 'smart', undefined, '/ws')!;
		expect(Object.keys(smart)).toEqual(['NODE_OPTIONS', 'VSCODE_INSPECTOR_OPTIONS']);
		const opts = readInspectorOptions(smart.VSCODE_INSPECTOR_OPTIONS)!;
		expect(opts).toMatchObject({ inspectorIpc: '/tmp/x.sock', autoAttachMode: 'smart', onlyEntrypoint: false });
		expect((opts.aaPatterns as string[])[0]).toBe('/ws/**');
		expect(readInspectorOptions(autoAttachEnv(raw, 'onlyWithFlag', undefined, '/ws')!.VSCODE_INSPECTOR_OPTIONS)!.aaPatterns).toBeUndefined();
		expect(autoAttachEnv(raw, 'disabled', undefined, '/ws')).toBeNull();
		expect(autoAttachEnv({ NODE_OPTIONS: 'x' }, 'always', undefined, '/ws')).toBeNull();
	});

	test('contributed terminal variables merge over the user env; NODE_OPTIONS is joined', () => {
		contributeTerminalEnv('t', { NODE_OPTIONS: '--require b.js', VSCODE_INSPECTOR_OPTIONS: 'o' });
		const user: { env: Record<string, string | null> } = { env: { NODE_OPTIONS: '--max-old-space-size=4096', A: '1' } };
		expect(withContributedEnv(user).env).toEqual({ NODE_OPTIONS: '--require b.js --max-old-space-size=4096', A: '1', VSCODE_INSPECTOR_OPTIONS: 'o' });
		contributeTerminalEnv('t', null);
		expect(contributedTerminalEnv()).toEqual({});
		const shell = { env: { A: '1' } };
		expect(withContributedEnv(shell)).toBe(shell);
	});
});

describe('inline breakpoints', () => {
	test('Shift+F9 adds column breakpoints beside the line one; F9 on the line removes them all', () => {
		let map = toggle({}, 'a.js', 3);
		map = toggleInline(map, 'a.js', 3, 9);
		map = toggleInline(map, 'a.js', 3, 20);
		expect(map['a.js'].map((b) => `${b.line}:${b.column ?? '-'}`)).toEqual(['3:-', '3:9', '3:20']);
		expect(hasInline(map['a.js'], 3)).toBe(true);
		expect(sourceBreakpoints(map['a.js'])).toEqual([{ line: 3 }, { line: 3, column: 9 }, { line: 3, column: 20 }]);
		// Toggling the same column removes it; column 1 is the line's own breakpoint.
		expect(toggleInline(map, 'a.js', 3, 9)['a.js'].length).toBe(2);
		expect(toggleInline(map, 'a.js', 3, 1)['a.js'].map((b) => b.column ?? 0)).toEqual([9, 20]);
		expect(toggle(map, 'a.js', 3)['a.js']).toBeUndefined();
	});

	test('glyphs carry the column; moved lines keep each column; storage keeps it', () => {
		const map = toggleInline(toggle({}, 'a.js', 3), 'a.js', 3, 9);
		const g = glyphs(map['a.js'], [{ verified: true }, { verified: false }]);
		expect(g.map((x) => [x.line, x.column, x.kind])).toEqual([
			[3, undefined, 'verified'],
			[3, 9, 'unverified']
		]);
		expect(moveTo(map, 'a.js', [5, 5])['a.js'].map((b) => `${b.line}:${b.column ?? 0}`)).toEqual(['5:0', '5:9']);
		expect(parseStored(JSON.stringify(map))['a.js'][1]).toEqual({ line: 3, column: 9, enabled: true });
	});
});
