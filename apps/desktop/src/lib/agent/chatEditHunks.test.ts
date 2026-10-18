import { describe, expect, test } from 'bun:test';
import { addedLines, afterResolve, clampLine, findTarget, firstLine, hunkAtCursor, stepTargetFile, targetKey, zoneAfter, type EditHunk } from './chatEditHunks.ts';
import type { EditsView, WorkingFile } from './chatEdits.ts';

const file = (path: string, over: Partial<WorkingFile> = {}): WorkingFile => ({
	path,
	request: 0,
	source: 'tool',
	restorable: true,
	reason: null,
	created: false,
	deleted: false,
	from_head: false,
	added: 1,
	removed: 1,
	...over
});
const view = (prefix: string, files: WorkingFile[]): EditsView => ({ prefix, running: false, files, requests: [] });
const hunk = (new_start: number, new_lines: number, removed: string[] = []): EditHunk => ({
	id: `h${new_start}`,
	old_start: new_start,
	old_lines: removed.length,
	new_start,
	new_lines,
	removed
});

describe('findTarget', () => {
	test('maps the editor path through the chat prefix and skips files without a copy', () => {
		const views = {
			a: view('', [file('src/x.ts'), file('gone.ts', { deleted: true }), file('big.bin', { restorable: false })]),
			b: view('.kingu/worktrees/fix', [file('src/x.ts', { request: 3 })])
		};
		expect(findTarget(views, 'src/x.ts')?.chatId).toBe('a');
		expect(findTarget(views, '.kingu/worktrees/fix/src/x.ts')).toMatchObject({ chatId: 'b', rel: 'src/x.ts', prefix: '.kingu/worktrees/fix' });
		expect(findTarget(views, 'gone.ts')).toBeNull();
		expect(findTarget(views, 'big.bin')).toBeNull();
	});

	test('the most recent change wins when two chats changed the file', () => {
		const views = { a: view('', [file('x.ts', { request: 1 })]), b: view('', [file('x.ts', { request: 4 })]) };
		expect(findTarget(views, 'x.ts')?.chatId).toBe('b');
	});

	test('the key changes with the counts and the generation', () => {
		const t = findTarget({ a: view('', [file('x.ts')]) }, 'x.ts')!;
		expect(targetKey(t, 0)).not.toBe(targetKey(t, 1));
		expect(targetKey(t, 0)).not.toBe(targetKey({ ...t, file: { ...t.file, added: 2 } }, 0));
	});
});

describe('hunk geometry', () => {
	test('added lines, deleted-line zones and cursor hits', () => {
		const changed = hunk(3, 2, ['old']);
		const deleted = hunk(7, 0, ['a', 'b']);
		const top = hunk(0, 0, ['first']);
		expect(addedLines(changed)).toEqual([3, 4]);
		expect(addedLines(deleted)).toBeNull();
		expect(zoneAfter(changed)).toBe(2);
		expect(zoneAfter(deleted)).toBe(7);
		expect(zoneAfter(top)).toBe(0);
		expect(firstLine(top)).toBe(1);
		const all = [changed, deleted];
		expect(hunkAtCursor(all, 4)).toBe(0);
		expect(hunkAtCursor(all, 7)).toBe(1);
		expect(hunkAtCursor(all, 5)).toBe(-1);
		expect(clampLine(12, 10)).toBe(10);
		expect(clampLine(0, 10)).toBe(1);
	});

	test('after a resolve the next hunk takes the place, else the last one', () => {
		expect(afterResolve(1, 3)).toBe(1);
		expect(afterResolve(2, 2)).toBe(1);
		expect(afterResolve(0, 0)).toBeNull();
	});
});

test('stepTargetFile wraps over files that can be shown', () => {
	const v = view('', [file('a.ts'), file('b.ts', { deleted: true }), file('c.ts'), file('d.bin', { restorable: false })]);
	expect(stepTargetFile(v, 'a.ts', 1)).toBe('c.ts');
	expect(stepTargetFile(v, 'c.ts', 1)).toBe('a.ts');
	expect(stepTargetFile(v, 'a.ts', -1)).toBe('c.ts');
	expect(stepTargetFile(view('', [file('a.ts')]), 'a.ts', 1)).toBeNull();
});
