import { describe, expect, test } from 'bun:test';
import { BRANCH_CHOICES, branchPrefix, branchRemoval, defaultBaseBranch, dirtyLabel, dirtyPreview, scriptPreview, scriptRunSummary, setupCommand, setupPolicy, validBranchPrefix } from './worktreeSettings';
import { agentCommand } from './agentCli';
import { notificationSound, noticeFor, shouldNotify } from './agentNotify';

describe('worktree settings', () => {
	test('branch prefix: default, trimmed, empty allowed, bad ones refused', () => {
		expect(branchPrefix(undefined)).toBe('kingu/');
		expect(branchPrefix(' feature/ ')).toBe('feature/');
		expect(branchPrefix('')).toBe('');
		expect(branchPrefix('bright-')).toBe('bright-');
		for (const bad of ['-x/', '/x', '../', 'a//b', 'a b/', 'x~', '.hidden/', 'a/.b/', 'งาน/', 'x'.repeat(65)]) {
			expect([bad, validBranchPrefix(bad)]).toEqual([bad, false]);
			expect(branchPrefix(bad)).toBeNull();
		}
	});

	test('default base branch: the setting when it exists, else the current branch, else the first', () => {
		const branches = ['develop', 'main'];
		expect(defaultBaseBranch('develop', 'main', branches)).toBe('develop');
		expect(defaultBaseBranch(' develop ', 'main', branches)).toBe('develop');
		expect(defaultBaseBranch('release', 'main', branches)).toBe('main');
		expect(defaultBaseBranch('', 'main', branches)).toBe('main');
		expect(defaultBaseBranch(undefined, 'detached', branches)).toBe('develop');
		expect(defaultBaseBranch(undefined, null, [])).toBe('');
	});

	test('branch on remove: Orca\'s default deletes merged branches and keeps the others', () => {
		expect(branchRemoval(undefined, { merged: false })).toBe('safe');
		expect(branchRemoval('deleteMerged', { merged: false })).toBe('safe');
		// A squash-merged PR is not merged for git: Kingu knows, so -D.
		expect(branchRemoval('deleteMerged', { merged: true })).toBe('force');
		expect(branchRemoval('keep', { merged: true })).toBe('keep');
		expect(branchRemoval('delete', { merged: false })).toBe('force');
	});

	test('setup policy and archive results', () => {
		expect(setupPolicy(undefined)).toBe('auto');
		expect(setupPolicy('ask')).toBe('ask');
		expect(setupPolicy('off')).toBe('off');
		expect(setupPolicy('sometimes')).toBe('auto');
		expect(scriptRunSummary({ code: 0, timed_out: false, output: '' })).toBe('สำเร็จ');
		expect(scriptRunSummary({ code: 2, timed_out: false, output: '' })).toContain('exit code 2');
		expect(scriptRunSummary({ code: null, timed_out: true, output: '' })).toContain('นานเกิน');
	});

	test('setup command runs the trusted copy with the paths in its environment', () => {
		expect(setupCommand('/cache/worktree-scripts/ab.sh', '/r', '/r/.kingu/worktrees/t', 't')).toEqual([
			'env',
			'KINGU_ROOT_PATH=/r',
			'KINGU_WORKTREE_PATH=/r/.kingu/worktrees/t',
			'KINGU_WORKSPACE_NAME=t',
			'sh',
			'/cache/worktree-scripts/ab.sh'
		]);
		expect(scriptPreview('a\nb\n\n')).toBe('a\nb');
		expect(scriptPreview(Array.from({ length: 25 }, (_, i) => `l${i}`).join('\n'), 20).split('\n')).toHaveLength(21);
	});
});

describe('agent command', () => {
	const from = (values: Record<string, string>) => (id: string) => values[id];

	test('the CLI plus that CLI’s own extra arguments', () => {
		expect(agentCommand(from({}))).toEqual(['claude']);
		expect(agentCommand(from({ 'kingu.agent.args.claude': '--model opus' }))).toEqual(['claude', '--model', 'opus']);
		expect(agentCommand(from({ 'kingu.agent.cli': 'codex', 'kingu.agent.args.claude': '--model opus', 'kingu.agent.args.codex': '--full-auto' }))).toEqual(['codex', '--full-auto']);
		expect(agentCommand(from({ 'kingu.agent.cli': '/opt/bin/cursor-agent', 'kingu.agent.args.cursor': '-f' }))).toEqual(['/opt/bin/cursor-agent', '-f']);
	});

	test('a custom command gets no profile arguments; shell syntax is refused', () => {
		expect(agentCommand(from({ 'kingu.agent.cli': 'mycli --x', 'kingu.agent.args.claude': '--model opus' }))).toEqual(['mycli', '--x']);
		expect(agentCommand(from({ 'kingu.agent.args.claude': '--model opus; rm -rf ~' }))).toBeNull();
		expect(agentCommand(from({ 'kingu.agent.cli': 'claude $(id)' }))).toBeNull();
	});
});

describe('agent notification settings', () => {
	test('suppress while focused: only the task on screen, while the window is focused', () => {
		const on = { enabled: true, suppressWhenFocused: true };
		expect(shouldNotify(on, false, true)).toBe(true);
		expect(shouldNotify(on, true, false)).toBe(true);
		expect(shouldNotify(on, true, true)).toBe(false);
		expect(shouldNotify({ ...on, suppressWhenFocused: false }, true, true)).toBe(true);
		expect(shouldNotify({ ...on, enabled: false }, false, false)).toBe(false);
	});

	test('events: attention leaves out finished turns', () => {
		expect(noticeFor('running', 'review', { title: 'x' }, 'attention')).toBeNull();
		expect(noticeFor('running', 'failed', { title: 'x' }, 'attention')?.kind).toBe('attention');
		expect(noticeFor('running', 'waiting', { title: 'x' }, 'attention')?.kind).toBe('attention');
	});

	test('sound names', () => {
		expect(notificationSound('none')).toBeUndefined();
		expect(notificationSound(undefined)).toBeUndefined();
		expect(notificationSound('default')).toBe('NSUserNotificationDefaultSoundName');
		expect(notificationSound('Glass')).toBe('Glass');
	});
});

describe('remove dialog', () => {
	test('dirty preview: one count, the first 10 paths with letters, how many more', () => {
		const entries: { path: string; index: string | null; worktree: string | null }[] = Array.from({ length: 12 }, (_, i) => ({ path: `f${i}`, index: null, worktree: 'M' }));
		entries[0] = { path: 'new.txt', index: null, worktree: '?' };
		entries[1] = { path: 'staged.txt', index: 'A', worktree: null };
		const p = dirtyPreview(entries);
		expect([p.count, p.files.length, p.more]).toEqual([12, 10, 2]);
		expect(p.files.slice(0, 3).map((f) => f.letter)).toEqual(['U', 'A', 'M']);
		expect(dirtyPreview([{ path: 'c', index: 'U', worktree: 'U', conflict: true }]).files[0]).toEqual({ path: 'c', letter: '!', conflict: true });
		expect(dirtyPreview([])).toEqual({ count: 0, files: [], more: 0 });
	});
	test('labels and the branch choices', () => {
		expect(dirtyLabel(3)).toContain('3');
		expect(BRANCH_CHOICES.map((c) => c.id)).toEqual(['keep', 'safe', 'force']);
	});
});
