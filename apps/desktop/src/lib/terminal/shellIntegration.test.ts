import { describe, expect, test } from 'bun:test';
import { decorationPlaces, parseOsc133, parseOsc1337, parseOsc633, parseOsc7, SHELL_INTEGRATION_OSCS, unescapeValue } from './shellIntegration.ts';

describe('OSC 633', () => {
	test('prompt, command and output marks', () => {
		expect(parseOsc633('A')).toEqual({ type: 'promptStart' });
		expect(parseOsc633('B')).toEqual({ type: 'commandStart' });
		expect(parseOsc633('C')).toEqual({ type: 'executed' });
		expect(parseOsc633('Z')).toBeNull();
	});

	test('D with and without an exit code', () => {
		expect(parseOsc633('D;0')).toEqual({ type: 'finished', exitCode: 0 });
		expect(parseOsc633('D;127')).toEqual({ type: 'finished', exitCode: 127 });
		expect(parseOsc633('D')).toEqual({ type: 'finished', exitCode: undefined });
		expect(parseOsc633('D;nope')).toEqual({ type: 'finished', exitCode: undefined });
	});

	test('E unescapes the command line and splits off a nonce', () => {
		expect(parseOsc633('E;echo hi\\x3b echo "a\\x3bb"')).toEqual({ type: 'commandLine', command: 'echo hi; echo "a;b"' });
		expect(parseOsc633('E;printf \\\\n\\x0aline2;abc123')).toEqual({ type: 'commandLine', command: 'printf \\n\nline2', nonce: 'abc123' });
		expect(parseOsc633('E;')).toEqual({ type: 'commandLine', command: '' });
		expect(parseOsc633('E')).toBeNull();
	});

	test('P: the cwd and other properties', () => {
		expect(parseOsc633('P;Cwd=/Users/me/my\\x3bdir')).toEqual({ type: 'cwd', cwd: '/Users/me/my;dir' });
		expect(parseOsc633('P;Shell=zsh')).toEqual({ type: 'property', key: 'Shell', value: 'zsh' });
		expect(parseOsc633('P;IsWindows=False')).toEqual({ type: 'property', key: 'IsWindows', value: 'False' });
		expect(parseOsc633('P;Cwd=')).toBeNull();
		expect(parseOsc633('P;novalue')).toBeNull();
	});

	test('unescaping leaves other backslashes alone', () => {
		expect(unescapeValue('a\\\\b')).toBe('a\\b');
		expect(unescapeValue('\\x41\\x1b')).toBe('A\x1b');
		expect(unescapeValue('\\n stays')).toBe('\\n stays');
		expect(unescapeValue('\\xZZ')).toBe('\\xZZ');
	});
});

describe('other sequences', () => {
	test('OSC 133 (Final Term)', () => {
		expect(parseOsc133('A')).toEqual({ type: 'promptStart' });
		expect(parseOsc133('B')).toEqual({ type: 'commandStart' });
		expect(parseOsc133('C')).toEqual({ type: 'executed' });
		expect(parseOsc133('D;1')).toEqual({ type: 'finished', exitCode: 1 });
		expect(parseOsc133('D;aid=12;2')).toEqual({ type: 'finished', exitCode: 2 });
		expect(parseOsc133('D')).toEqual({ type: 'finished', exitCode: undefined });
		expect(parseOsc133('P;k=i')).toBeNull();
	});

	test('OSC 7 file URLs', () => {
		expect(parseOsc7('file://mac.local/Users/me/My%20Projects')).toEqual({ type: 'cwd', cwd: '/Users/me/My Projects' });
		expect(parseOsc7('file:///tmp')).toEqual({ type: 'cwd', cwd: '/tmp' });
		expect(parseOsc7('kitty-shell-cwd://host/srv')).toEqual({ type: 'cwd', cwd: '/srv' });
		expect(parseOsc7('file://host/bad%zz')).toEqual({ type: 'cwd', cwd: '/bad%zz' });
		expect(parseOsc7('https://example.com/x')).toBeNull();
	});

	test('OSC 1337 CurrentDir and SetMark only', () => {
		expect(parseOsc1337('CurrentDir=/srv/app')).toEqual({ type: 'cwd', cwd: '/srv/app' });
		expect(parseOsc1337('SetMark')).toEqual({ type: 'mark' });
		expect(parseOsc1337('File=inline=1:AAAA')).toBeNull();
		expect(parseOsc1337('CurrentDir=')).toBeNull();
	});

	test('the handled OSC numbers', () => {
		expect(SHELL_INTEGRATION_OSCS.map(([n]) => n)).toEqual([633, 133, 7, 1337]);
	});
});

test('decorationsEnabled places', () => {
	expect(decorationPlaces('both')).toEqual({ gutter: true, ruler: true });
	expect(decorationPlaces('gutter')).toEqual({ gutter: true, ruler: false });
	expect(decorationPlaces('overviewRuler')).toEqual({ gutter: false, ruler: true });
	expect(decorationPlaces('never')).toEqual({ gutter: false, ruler: false });
	expect(decorationPlaces(undefined)).toEqual({ gutter: true, ruler: true });
});
