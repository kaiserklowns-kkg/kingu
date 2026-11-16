import { expect, test } from 'bun:test';
import { baseChoices, groupChanges, joinRel, parseFolders, remoteAgentHooks, remoteAgentStatus, remoteAgentTitle, type RemoteAgent } from './sshRemote.ts';

test('git letters split into Staged and Changes; conflicts and untracked go to Changes', () => {
	const g = groupChanges([
		{ path: 'b.ts', orig: null, x: 'M', y: 'M' },
		{ path: 'a.ts', orig: null, x: ' ', y: 'D' },
		{ path: 'n.ts', orig: null, x: '?', y: '?' },
		{ path: 'c.ts', orig: null, x: 'U', y: 'U' },
		{ path: 'new.ts', orig: 'old.ts', x: 'R', y: ' ' }
	]);
	expect(g.staged.map((r) => `${r.letter} ${r.path}`)).toEqual(['M b.ts', 'R new.ts']);
	expect(g.unstaged.map((r) => `${r.letter} ${r.path}`)).toEqual(['D a.ts', 'M b.ts', '! c.ts', 'U n.ts']);
	expect(g.staged[1]!.orig).toBe('old.ts');
});

test('paths, folders and base branches', () => {
	expect(joinRel('', 'a')).toBe('a');
	expect(joinRel('a/b', 'c')).toBe('a/b/c');
	expect(parseFolders(' web, /packages/ui/ ,\nweb,, ')).toEqual(['web', 'packages/ui']);
	expect(baseChoices({ branches: ['dev', 'main', 'origin/main'], default: 'origin/main' })).toEqual(['origin/main', 'dev', 'main']);
	expect(baseChoices({ branches: ['main'], default: null })).toEqual(['main']);
});

test("an SSH agent's status comes from its terminal title, else its output timing", () => {
	const start: RemoteAgent = { startedAt: 0 };
	expect(remoteAgentStatus(start, 1000)).toBe('running');
	expect(remoteAgentStatus(start, 60_000)).toBe('review');
	expect(remoteAgentStatus({ ...start, lastOutput: 59_000 }, 60_000)).toBe('running');
	let a = remoteAgentTitle(start, '⠋ Fixing login', 1);
	expect(remoteAgentStatus(a, 60_000)).toBe('running');
	a = remoteAgentTitle(a, '✳ Claude Code', 2);
	expect(remoteAgentStatus(a, 60_000)).toBe('review');
	a = remoteAgentTitle(a, 'gemini ✋ waiting', 3);
	expect(remoteAgentStatus(a, 60_000)).toBe('waiting');
	a = remoteAgentTitle(remoteAgentTitle(start, '✳ Claude Code', 1), 'bright@box: ~/app', 2);
	expect(remoteAgentStatus(a, 3)).toBeNull();
	expect(remoteAgentStatus({ ...start, closed: true }, 1)).toBeNull();
});

test('hooks from the host win over the title; their end ends the agent', () => {
	const ev = (name: string, extra: object = {}) => ({ hook_event_name: name, ...extra });
	let a = remoteAgentTitle({ startedAt: 0 }, '✳ Claude Code', 1);
	a = remoteAgentHooks(a, [ev('SessionStart'), ev('UserPromptSubmit', { prompt: 'fix' })], 50, 2);
	expect(a.hookOffset).toBe(50);
	expect(remoteAgentStatus(a, 3)).toBe('running');
	a = remoteAgentHooks(a, [ev('Stop')], 80, 4);
	expect(remoteAgentStatus(a, 5)).toBe('review');
	a = remoteAgentHooks(a, [ev('SessionEnd')], 99, 6);
	expect(remoteAgentStatus(a, 7)).toBeNull();
});
