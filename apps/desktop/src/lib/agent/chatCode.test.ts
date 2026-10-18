/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { fenceLanguage, terminalInput } from './chatCode';

const LANGS = [
	{ id: 'typescript', aliases: ['TypeScript', 'ts'], extensions: ['.ts'] },
	{ id: 'python', aliases: ['Python', 'py'], extensions: ['.py'] },
	{ id: 'shell', aliases: ['Shell Script', 'sh'], extensions: ['.sh', '.bash'] },
	{ id: 'rust', aliases: ['Rust'], extensions: ['.rs'] },
	{ id: 'csharp', aliases: ['C#'], extensions: ['.cs'] },
	{ id: 'plaintext', extensions: ['.txt'] }
];

describe('fenceLanguage', () => {
	test('ids, aliases, extensions and common fence names', () => {
		expect(fenceLanguage('typescript', LANGS)).toBe('typescript');
		expect(fenceLanguage('Python', LANGS)).toBe('python');
		expect(fenceLanguage('ts', LANGS)).toBe('typescript');
		expect(fenceLanguage('bash', LANGS)).toBe('shell');
		expect(fenceLanguage('zsh', LANGS)).toBe('shell');
		expect(fenceLanguage('rs', LANGS)).toBe('rust');
		expect(fenceLanguage('.rs', LANGS)).toBe('rust');
		expect(fenceLanguage('c#', LANGS)).toBe('csharp');
		expect(fenceLanguage('text', LANGS)).toBe('plaintext');
	});

	test('unknown or empty fences have no language', () => {
		expect(fenceLanguage('', LANGS)).toBeNull();
		expect(fenceLanguage('cobol', LANGS)).toBeNull();
		// A mapped name whose language is not registered.
		expect(fenceLanguage('yml', LANGS)).toBeNull();
	});
});

describe('terminalInput', () => {
	test('one line goes in as typed, without the line break that would run it', () => {
		expect(terminalInput('npm test\n')).toBe('npm test');
	});
	test('several lines go in as one bracketed paste', () => {
		expect(terminalInput('cd app\r\nbun test\n\n')).toBe('\x1b[200~cd app\nbun test\x1b[201~');
	});
});
