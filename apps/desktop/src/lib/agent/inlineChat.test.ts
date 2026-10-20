import { describe, expect, test } from 'bun:test';
import { around, codeFromAnswer, commandFromAnswer, editorPrompt, terminalPrompt } from './inlineChat';

describe('inline chat', () => {
	test('the editor prompt carries the instruction and the code around it', () => {
		const p = editorPrompt({ instruction: 'add types', path: 'src/a.ts', language: 'typescript', before: 'const x = 1;', selection: 'function f(a) {}', after: 'f(x);' });
		expect(p).toContain('src/a.ts (typescript)');
		expect(p).toContain('Instruction: add types');
		expect(p).toContain('<selection>\nfunction f(a) {}\n</selection>');
		expect(editorPrompt({ instruction: 'x', path: 'a', language: 'go', before: '', selection: '', after: '' })).toContain('<cursor/>');
	});

	test('the terminal prompt asks for one command, with the last output', () => {
		const p = terminalPrompt('list big files', 'zsh', 'macOS', '$ ls\nREADME.md');
		expect(p).toContain('ONE shell command for zsh on macOS');
		expect(p).toContain('Request: list big files');
		expect(p).toContain('README.md');
		expect(terminalPrompt('x', 'bash', 'Linux', '  ')).not.toContain('terminal shows');
	});

	test('code and commands out of an answer', () => {
		expect(codeFromAnswer('Here:\n```ts\n  const a: number = 1;\n```\nDone')).toBe('  const a: number = 1;');
		expect(codeFromAnswer('plain answer\n\n')).toBe('plain answer');
		expect(commandFromAnswer('```sh\n$ du -sh * | sort -h\n```')).toBe('du -sh * | sort -h');
		expect(commandFromAnswer('```bash\n# find them\nfind . -size +10M\n```')).toBe('find . -size +10M');
	});

	test('lines around a selection', () => {
		const text = ['1', '2', '3', '4', '5', '6'].join('\n');
		expect(around(text, 3, 4, 1)).toEqual({ before: '2', after: '5' });
		expect(around(text, 1, 1, 5)).toEqual({ before: '', after: '2\n3\n4\n5\n6' });
	});
});
