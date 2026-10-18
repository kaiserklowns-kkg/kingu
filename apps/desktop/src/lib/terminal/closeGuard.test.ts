import { expect, test } from 'bun:test';
import { asksOnKill, closePrompt, runningJobs } from './closeGuard.ts';

test("terminal.integrated.confirmOnKill: VS Code's values per location", () => {
	expect(asksOnKill('never', 'editor')).toBe(false);
	expect(asksOnKill('never', 'panel')).toBe(false);
	expect(asksOnKill('editor', 'editor')).toBe(true);
	expect(asksOnKill('editor', 'panel')).toBe(false);
	expect(asksOnKill('panel', 'panel')).toBe(true);
	expect(asksOnKill('panel', 'editor')).toBe(false);
	expect(asksOnKill('always', 'panel')).toBe(true);
	// Unknown or missing: VS Code's default, 'editor'.
	expect(asksOnKill(undefined, 'editor')).toBe(true);
	expect(asksOnKill('bogus', 'panel')).toBe(false);
});

test('only a job other than an idle shell counts as running', () => {
	const jobs = { a: { pid: 10, name: 'sleep' }, b: { pid: 11, name: 'zsh' }, c: { pid: 12, name: '-bash' }, d: { pid: 13, name: 'node' } };
	expect(runningJobs(jobs)).toEqual([
		{ key: 'a', name: 'sleep' },
		{ key: 'd', name: 'node' }
	]);
	expect(runningJobs({})).toEqual([]);
});

test('the prompt: VS Code wording in the panel, Orca wording (agent or command) in the ADE', () => {
	expect(closePrompt('panel', ['sleep'], ['claude'], 'zsh')).toMatchObject({ title: 'Kill Terminal', ok: 'หยุด (Terminate)' });
	expect(closePrompt('editor', ['claude'], ['claude'], 'Terminal 2')).toMatchObject({ title: 'หยุด agent นี้?', ok: 'หยุด Agent' });
	const cmd = closePrompt('editor', ['npm', 'npm'], ['claude'], 'Terminal 1');
	expect(cmd).toMatchObject({ title: 'หยุดคำสั่งที่กำลังรัน?', ok: 'หยุดและปิด' });
	expect(cmd.message).toContain('(npm)');
	expect(cmd.message).toContain('Terminal 1');
});
