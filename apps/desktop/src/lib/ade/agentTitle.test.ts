import { describe, expect, test } from 'bun:test';
import { applyTitle, titleAgent, titleStatus } from './agentTitle';

describe('titleStatus (Orca title corpus)', () => {
	test('plain shell and path titles are no agent', () => {
		for (const t of ['', 'zsh', 'bash', 'user@mac: ~/kingu', 'npm run dev', 'opencode-blinker', 'openclaude-scratch', 'claude-scratch', '~/codex/ready', 'review-14600-codex', 'timestamp ready', 'android build running', '~/hermes/working', '/usr/local/bin/claude/notes', 'claude agents', '"/usr/local/bin/claude" agents', 'cursor agent'])
			expect([t, titleStatus(t)]).toEqual([t, null]);
	});

	test('claude: ✳ is idle, a spinner frame (braille or quarter circle) is working', () => {
		expect(titleStatus('✳')).toBe('idle');
		expect(titleStatus('✳ Claude Code')).toBe('idle');
		expect(titleStatus('✳ Fix the login bug')).toBe('idle');
		expect(titleStatus('⠂ Fix the login bug')).toBe('working');
		expect(titleStatus('◐ Fix the login bug')).toBe('working');
		expect(titleStatus('claude - action required')).toBe('permission');
		expect(titleStatus('. building the parser')).toBe(null);
		expect(titleStatus('Claude Code')).toBe('idle');
	});

	test('gemini glyphs', () => {
		expect(titleStatus('✦ gemini')).toBe('working');
		expect(titleStatus('⏲ Gemini CLI')).toBe('working');
		expect(titleStatus('◇ Gemini CLI')).toBe('idle');
		expect(titleStatus('✋ Gemini CLI')).toBe('permission');
	});

	test('a named agent with a status word', () => {
		expect(titleStatus('codex working')).toBe('working');
		expect(titleStatus('codex ready')).toBe('idle');
		expect(titleStatus('copilot waiting')).toBe('permission');
		expect(titleStatus('aider running')).toBe('working');
		expect(titleStatus('codex.exe')).toBe('idle');
		expect(titleStatus('droid.exe')).toBe(null);
		expect(titleStatus('tmux | claude - action required')).toBe('permission');
	});

	test('opencode native title', () => {
		expect(titleStatus('OC | refactor parser')).toBe('idle');
		expect(titleStatus('⠋ OC | refactor parser')).toBe('working');
	});
});

describe('titleAgent', () => {
	test('names the agent', () => {
		expect(titleAgent('✳ Fix it')).toBe('claude');
		expect(titleAgent('◇ Gemini CLI')).toBe('gemini');
		expect(titleAgent('OC | x')).toBe('opencode');
		expect(titleAgent('Codex working')).toBe('codex');
		expect(titleAgent('zsh')).toBe(null);
	});
});

describe('applyTitle', () => {
	test('idle then a shell title means the agent exited; a shell title while working does not', () => {
		let t = applyTitle(undefined, '⠂ Working on it', 1);
		expect(t.status).toBe('working');
		t = applyTitle(t, 'zsh', 2);
		expect(t.status).toBe('working');
		expect(t.exited).toBe(false);
		t = applyTitle(t, '✳ Done', 3);
		expect(t).toMatchObject({ status: 'idle', agent: 'claude', exited: false, at: 3 });
		t = applyTitle(t, 'user@mac: ~/repo', 4);
		expect(t).toMatchObject({ status: null, exited: true });
		t = applyTitle(t, '◇ Gemini CLI', 5);
		expect(t).toMatchObject({ status: 'idle', agent: 'gemini', exited: false });
	});

	test('keeps the time the status began', () => {
		const a = applyTitle(undefined, '⠂ a', 10);
		const b = applyTitle(a, '⠄ a', 20);
		expect(b.at).toBe(10);
	});
});
