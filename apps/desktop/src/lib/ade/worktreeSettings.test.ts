import { describe, expect, test } from 'bun:test';
import { branchPrefix, defaultBaseBranch, deleteBranchOnRemove, scriptPreview, setupCommand, validBranchPrefix } from './worktreeSettings';
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

	test('branch on remove', () => {
		expect(deleteBranchOnRemove(undefined, { merged: true })).toBe(false);
		expect(deleteBranchOnRemove('keep', { merged: true })).toBe(false);
		expect(deleteBranchOnRemove('deleteMerged', { merged: false })).toBe(false);
		expect(deleteBranchOnRemove('deleteMerged', { merged: true })).toBe(true);
		expect(deleteBranchOnRemove('delete', { merged: false })).toBe(true);
	});

	test('setup command runs the trusted copy with the paths in its environment', () => {
		expect(setupCommand('/cache/worktree-setup/ab.sh', '/r', '/r/.kingu/worktrees/t')).toEqual([
			'env',
			'KINGU_ROOT_PATH=/r',
			'KINGU_WORKTREE_PATH=/r/.kingu/worktrees/t',
			'sh',
			'/cache/worktree-setup/ab.sh'
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
	test('when: unfocused only, or always except the task on screen', () => {
		const on = { enabled: true, when: 'unfocused' };
		expect(shouldNotify(on, false, false)).toBe(true);
		expect(shouldNotify(on, true, false)).toBe(false);
		expect(shouldNotify({ ...on, when: 'always' }, true, false)).toBe(true);
		expect(shouldNotify({ ...on, when: 'always' }, true, true)).toBe(false);
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
