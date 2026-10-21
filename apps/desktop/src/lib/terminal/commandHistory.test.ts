import { describe, expect, test } from 'bun:test';
import { cdCommand, commandInput, recentCommandItems, recentDirectoryItems, remember, shellQuote, shellType, TerminalHistory } from './commandHistory.ts';

function memory() {
	const data = new Map<string, string>();
	return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

describe('history per shell type', () => {
	test('shell types', () => {
		expect(shellType('/bin/zsh')).toBe('zsh');
		expect(shellType('-bash')).toBe('bash');
		expect(shellType('pwsh.exe')).toBe('pwsh');
		expect(shellType('')).toBe('default');
		expect(shellType(undefined)).toBe('default');
		expect(shellType('/weird path/sh ell')).toBe('default');
	});

	test('remember moves a repeat to the end and caps the list', () => {
		expect(remember(['a', 'b', 'c'], 'a', 10)).toEqual(['b', 'c', 'a']);
		expect(remember(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd']);
		expect(remember(['a'], '   ', 3)).toEqual(['a']);
		expect(remember(['a'], 'b  ', 3)).toEqual(['a', 'b']);
		// terminal.integrated.shellIntegration.history: 0 keeps nothing.
		expect(remember(['a'], 'b', 0)).toEqual([]);
	});

	test('kept per shell type across instances', () => {
		const store = memory();
		const h = new TerminalHistory(store);
		h.addCommand('/bin/zsh', 'make', 100);
		h.addCommand('zsh', 'make test', 100);
		h.addCommand('/opt/homebrew/bin/fish', 'ls', 100);
		h.addDirectory('zsh', '/repo', 100);
		const again = new TerminalHistory(store);
		expect(again.commands('/usr/bin/zsh')).toEqual(['make', 'make test']);
		expect(again.commands('fish')).toEqual(['ls']);
		expect(again.commands('bash')).toEqual([]);
		expect(again.directories('zsh')).toEqual(['/repo']);
		again.clear();
		expect(again.commands('zsh')).toEqual([]);
	});

	test('broken or missing storage reads as empty', () => {
		const store = memory();
		store.data.set('kingu.terminal.history.commands', '{"zsh": [1, "ok"], "bash": "nope"}');
		expect(new TerminalHistory(store).commands('zsh')).toEqual(['ok']);
		expect(new TerminalHistory(store).commands('bash')).toEqual([]);
		store.data.set('kingu.terminal.history.commands', 'not json');
		expect(new TerminalHistory(store).commands('zsh')).toEqual([]);
		const none = new TerminalHistory(undefined);
		none.addCommand('zsh', 'x', 10);
		expect(none.commands('zsh')).toEqual([]);
	});
});

describe('Run Recent Command list', () => {
	const labels = { session: 'current session', previous: 'previous sessions', shellFile: 'shell history' };

	test('sections most recent first, each command once', () => {
		const { items, entries } = recentCommandItems({ session: ['ls', 'make'], previous: ['git status', 'make', 'npm i'], shellFile: ['ls', 'cargo test'] }, labels);
		expect(items.map((i) => [i.label, i.separator])).toEqual([
			['make', 'current session'],
			['ls', undefined],
			['npm i', 'previous sessions'],
			['git status', undefined],
			['cargo test', 'shell history']
		]);
		expect(entries.get(items[2].id)).toBe('npm i');
	});

	test('a multi-line command shows on one row and runs as typed', () => {
		const { items, entries } = recentCommandItems({ session: ['for f in *; do\n  echo $f\ndone'], previous: [], shellFile: [] }, labels);
		expect(items[0].label).toBe('for f in *; do ⏎ echo $f ⏎ done');
		expect(entries.get(items[0].id)).toBe('for f in *; do\n  echo $f\ndone');
	});

	test('empty sources make an empty list', () => {
		expect(recentCommandItems({ session: [], previous: [' '], shellFile: [] }, labels).items).toEqual([]);
	});

	test('directories, with the home folder as ~', () => {
		const items = recentDirectoryItems(['/Users/me/a', '/tmp'], ['/tmp', '/Users/me'], { session: 'current session', previous: 'previous sessions' }, '/Users/me');
		expect(items.map((i) => [i.id, i.label, i.separator])).toEqual([
			['/tmp', '/tmp', 'current session'],
			['/Users/me/a', '~/a', undefined],
			['/Users/me', '~', 'previous sessions']
		]);
	});
});

describe('typing into the shell', () => {
	test('cd quoting per shell', () => {
		expect(cdCommand('/Users/me/src')).toBe('cd /Users/me/src');
		expect(cdCommand("/Users/me/it's here", 'zsh')).toBe(`cd '/Users/me/it'\\''s here'`);
		expect(cdCommand("/a b/c'd", 'fish')).toBe(`cd '/a b/c\\'d'`);
		expect(cdCommand("/a b/c'd", '/usr/local/bin/pwsh')).toBe(`cd '/a b/c''d'`);
		expect(shellQuote('$HOME', 'bash')).toBe(`'$HOME'`);
	});

	test('run or only type; multi-line as a bracketed paste when asked', () => {
		expect(commandInput('ls', true, false)).toBe('ls\r');
		expect(commandInput('ls', false, true)).toBe('ls');
		expect(commandInput('a\nb', true, true)).toBe('\x1b[200~a\nb\x1b[201~\r');
		expect(commandInput('a\nb', true, false)).toBe('a\rb\r');
	});
});
