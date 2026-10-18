import { describe, expect, test } from 'bun:test';
import { jumpRows, worktreeActions } from './worktreeActions';

const ids = (rows: ReturnType<typeof worktreeActions>) => rows.map((r) => (r === 'separator' ? '-' : r.id));

describe('worktree actions', () => {
	test('the folder itself has no task actions', () => {
		expect(ids(worktreeActions({ slug: null }))).toEqual(['open', 'openInEditor', 'newTerminal', 'quickOpen', '-', 'reveal', 'copyPath']);
	});
	test('a task can be closed and removed, but not while its agent works', () => {
		const rows = worktreeActions({ slug: 'fix', status: 'review', running: true });
		expect(ids(rows).slice(-9)).toEqual(['copyBranch', 'rename', '-', 'markDone', 'moveStatus', 'continueSession', 'handOff', '-', 'remove']);
		const blocked = rows.filter((r) => r !== 'separator' && (r.id === 'markDone' || r.id === 'remove'));
		expect(blocked.map((r) => r !== 'separator' && r.enabled)).toEqual([false, false]);
	});
	test('sessions can be continued or handed off once the task has one and its agent is idle', () => {
		const enabled = (w: Parameters<typeof worktreeActions>[0]) =>
			worktreeActions(w)
				.filter((r) => r !== 'separator' && (r.id === 'continueSession' || r.id === 'handOff' || r.id === 'moveStatus'))
				.map((r) => r !== 'separator' && r.enabled !== false);
		expect(enabled({ slug: 'fix', status: 'review', sessions: 2 })).toEqual([true, true, true]);
		expect(enabled({ slug: 'fix', status: 'review', sessions: 0 })).toEqual([true, false, false]);
		expect(enabled({ slug: 'fix', status: 'running', sessions: 2, running: true })).toEqual([true, false, false]);
	});
	test('a done task offers to reopen', () => {
		expect(ids(worktreeActions({ slug: 'fix', status: 'done' }))).toContain('reopen');
	});
});

describe('jump rows', () => {
	test('folder first, then each group in order', () => {
		const rows = jumpRows({ name: 'demo', branch: 'main' }, [
			{ label: 'รอคุณ', tasks: [{ slug: 'a', title: 'A', status: 'รอรีวิว' }] },
			{ label: 'กำลังทำ', tasks: [{ slug: 'b', title: 'B', status: 'กำลังทำ' }] }
		]);
		expect(rows.map((r) => [r.key, r.group])).toEqual([
			['', 'Folder'],
			['a', 'รอคุณ'],
			['b', 'กำลังทำ']
		]);
		expect(rows[0].description).toBe('primary · main');
	});
});
