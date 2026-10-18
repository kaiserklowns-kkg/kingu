import { expect, test } from 'bun:test';
import { Terminal } from '@xterm/xterm';
import { SearchAddon } from '@xterm/addon-search';
import { FIND_TERMINAL_OPTIONS, findKey, findStatus, HIGHLIGHT_LIMIT, runFind } from './find.ts';
import { terminalMenu } from './terminalMenu.ts';

const key = (k: Partial<KeyboardEvent>) => ({ key: '', code: '', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...k });

test('match count: VS Code style in the IDE, Orca style in the ADE', () => {
	expect(findStatus('ide', '', -1, 0)).toBe('');
	expect(findStatus('ide', 'x', -1, 0)).toBe('No results');
	expect(findStatus('ide', 'x', 0, 5)).toBe('1 of 5');
	expect(findStatus('ide', 'x', -1, 5)).toBe('? of 5');
	expect(findStatus('ide', 'x', 3, HIGHLIGHT_LIMIT)).toBe(`4 of ${HIGHLIGHT_LIMIT}+`);
	expect(findStatus('ade', '', -1, 0)).toBe('0/0');
	expect(findStatus('ade', 'x', -1, 0)).toBe('No results');
	expect(findStatus('ade', 'x', 1, 7)).toBe('2/7');
	expect(findStatus('ade', 'x', -1, 7)).toBe('7+');
});

test('find keys: Enter searches up in VS Code, down in Orca', () => {
	expect(findKey('ide', key({ key: 'Enter' }), true)).toBe('previous');
	expect(findKey('ide', key({ key: 'Enter', shiftKey: true }), true)).toBe('next');
	expect(findKey('ade', key({ key: 'Enter' }), true)).toBe('next');
	expect(findKey('ade', key({ key: 'Enter', shiftKey: true }), true)).toBe('previous');
	expect(findKey('ade', key({ key: 'Escape' }), true)).toBe('close');
	expect(findKey('ide', key({ key: 'F3', shiftKey: true }), false)).toBe('previous');
	expect(findKey('ide', key({ key: 'g', code: 'KeyG', metaKey: true }), true)).toBe('next');
	expect(findKey('ide', key({ key: 'ç', code: 'KeyC', altKey: true, metaKey: true }), true)).toBe('caseSensitive');
	expect(findKey('ide', key({ key: 'w', code: 'KeyW', altKey: true }), false)).toBe('wholeWord');
	expect(findKey('ide', key({ key: 'r', code: 'KeyR', altKey: true }), true)).toBeNull();
	expect(findKey('ide', key({ key: 'a', code: 'KeyA' }), true)).toBeNull();
});

test('context menu: VS Code items in the panel, Orca items in the ADE', () => {
	const ids = (nodes: ReturnType<typeof terminalMenu>) => nodes.map((n) => (n.type === 'item' ? n.id : '-'));
	expect(ids(terminalMenu('ide', { hasSelection: false }))).toEqual(['copy', 'paste', 'selectAll', '-', 'clear', '-', 'split', 'rename', '-', 'kill']);
	expect(terminalMenu('ide', { hasSelection: false })[0]).toMatchObject({ enabled: false });
	expect(ids(terminalMenu('ade', { hasSelection: true }))).toEqual(['copy', 'selectAll', 'paste', '-', 'splitRight', 'splitDown', '-', 'rename', '-', 'clear', 'reset']);
	const split = terminalMenu('ade', { hasSelection: true, split: true, expanded: true }, (id) => (id === 'splitRight' ? '⌘D' : undefined));
	expect(ids(split)).toEqual(['copy', 'selectAll', 'paste', '-', 'splitRight', 'splitDown', 'equalize', 'expand', '-', 'rename', '-', 'closePane', '-', 'clear', 'reset']);
	expect(split.find((n) => n.type === 'item' && n.id === 'expand')).toMatchObject({ text: 'Collapse Pane' });
	expect(split.find((n) => n.type === 'item' && n.id === 'splitRight')).toMatchObject({ keyLabel: '⌘D' });
	expect(ids(terminalMenu('ade', { hasSelection: false, panes: false }))).toEqual(['copy', 'selectAll', 'paste', '-', 'clear', 'reset']);
});

// A real xterm buffer (not opened: no DOM), searched through the same addon and options as Terminal.svelte.
async function bufferWith(text: string, options: object = FIND_TERMINAL_OPTIONS) {
	const term = new Terminal({ cols: 80, rows: 10, ...options });
	// select() needs the DOM selection service; the match is still reported without it.
	(term as unknown as { select: () => void }).select = () => {};
	const search = new SearchAddon({ highlightLimit: HIGHLIGHT_LIMIT });
	term.loadAddon(search);
	await new Promise<void>((done) => term.write(text, done));
	const results: { resultIndex: number; resultCount: number }[] = [];
	search.onDidChangeResults((r) => results.push(r));
	return { term, search, results };
}

const OFF = { caseSensitive: false, wholeWord: false, regex: false };

test('terminal find matches visible text and reports the count (IDE and ADE)', async () => {
	for (const flavor of ['ide', 'ade'] as const) {
		const { search, results } = await bufferWith('> echo src/App.tsx:3:10 https://example.com\r\nsrc/App.tsx:3:10 https://example.com\r\n');
		expect(runFind(search, flavor, 'App', OFF, flavor === 'ide' ? 'previous' : 'next', true)).toBe(true);
		expect(results.at(-1)?.resultCount).toBe(2);
		expect(results.at(-1)?.resultIndex).toBeGreaterThanOrEqual(0);
		expect(runFind(search, flavor, 'example', OFF, 'next')).toBe(true);
		expect(results.at(-1)?.resultCount).toBe(2);
		expect(runFind(search, flavor, 'app', { ...OFF, caseSensitive: true }, 'next')).toBe(false);
		expect(results.at(-1)?.resultCount).toBe(0);
		expect(runFind(search, flavor, 'App', { ...OFF, wholeWord: true }, 'next')).toBe(true);
		expect(runFind(search, flavor, 'ex.mple', { ...OFF, regex: true }, 'next')).toBe(true);
	}
});

test('match highlighting is a proposed xterm API: without the flag every search throws', async () => {
	const { search } = await bufferWith('App\r\n', {});
	expect(() => runFind(search, 'ide', 'App', OFF, 'next')).toThrow(/allowProposedApi/);
});
