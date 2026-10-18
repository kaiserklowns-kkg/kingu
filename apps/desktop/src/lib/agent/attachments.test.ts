import { describe, expect, test } from 'bun:test';
import { addAttachments, composeMessage, dropImagePath, fileReference, pastedImageText, promptWithAttachments, shellEscapePath, terminalDropText } from './attachments';

const B = (s: string) => `\x1b[200~${s}\x1b[201~`;

describe('composer attachments', () => {
	test('images and files, once each, absolute only', () => {
		const list = addAttachments([], ['/a/shot.PNG', '/a/notes.md', '/a/shot.PNG', 'rel.txt']);
		expect(list).toEqual([
			{ path: '/a/shot.PNG', name: 'shot.PNG', image: true },
			{ path: '/a/notes.md', name: 'notes.md', image: false }
		]);
		expect(composeMessage('ดูนี่', list)).toEqual({ text: 'ดูนี่\n\n@/a/notes.md', images: ['/a/shot.PNG'] });
		expect(composeMessage('x', [])).toEqual({ text: 'x', images: [] });
		expect(promptWithAttachments('x', list)).toBe('x\n\n@/a/shot.PNG @/a/notes.md');
	});
	test('Orca @path references', () => {
		expect(fileReference('/a/b.ts')).toBe('@/a/b.ts');
		expect(fileReference('/a b/c.ts')).toBe('@"/a b/c.ts"');
		expect(fileReference('/a"b')).toBe(`@'/a"b'`);
		expect(fileReference(`/a"b'c`)).toBe('@"/a\\"b\'c"');
	});
});

describe('terminal paste and drop', () => {
	test('a pasted image path goes in as a bracketed paste', () => {
		expect(pastedImageText('/c/kingu-paste-1.png')).toBe(B('/c/kingu-paste-1.png'));
	});
	test('escaping', () => {
		expect(shellEscapePath('/a/b.txt')).toBe('/a/b.txt');
		expect(shellEscapePath("/a b/it's.txt")).toBe(`'/a b/it'\\''s.txt'`);
		expect(dropImagePath('/a/b.png')).toBe('/a/b.png');
		expect(dropImagePath('/My Shots/a (1).png')).toBe('/My\\ Shots/a\\ \\(1\\).png');
		expect(dropImagePath('/ภาพ/รูป 1.png')).toBe('/ภาพ/รูป\\ 1.png');
	});
	test('a drop: images bracketed, files quoted with a space', () => {
		expect(terminalDropText(['/a/x.png', '/a/y.jpg'])).toBe(B('/a/x.png') + B('/a/y.jpg'));
		expect(terminalDropText(['/a/x.png', '/a/b c.txt'])).toBe(B('/a/x.png') + " '/a/b c.txt' ");
		expect(terminalDropText(['/a/b.txt', '/a/x.png'])).toBe('/a/b.txt ' + B('/a/x.png'));
		expect(terminalDropText(['/a/\x1b[31m.png'])).toBeNull();
		expect(terminalDropText([])).toBeNull();
	});
});
