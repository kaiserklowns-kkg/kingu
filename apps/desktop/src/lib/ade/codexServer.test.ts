import { describe, expect, test } from 'bun:test';
import { CHECK_AFTER_MS, checkDue, isolationOn, maybeCodex, nextWatch, noDaemonProgram, programIndex, wantsSharedServer, warningOn, withNoDaemon } from './codexServer.ts';

const get = (v: Record<string, unknown>) => (k: string) => v[k];

describe('codex shared app-server', () => {
	test('isolation and the warning default on; the warning follows isolation', () => {
		expect(isolationOn(get({}))).toBe(true);
		expect(warningOn(get({}))).toBe(true);
		expect(warningOn(get({ 'kingu.codex.terminalServerIsolation': false }))).toBe(false);
		expect(warningOn(get({ 'kingu.codex.sharedServerWarning': false }))).toBe(false);
	});

	test('--no-daemon goes right after the program word, past an env prefix', () => {
		expect(withNoDaemon(['codex', '-c', 'x=1', 'fix it'])).toEqual(['codex', '--no-daemon', '-c', 'x=1', 'fix it']);
		expect(withNoDaemon(['env', 'A=1', 'B=2', '/opt/codex', 'resume', '--last'])).toEqual(['env', 'A=1', 'B=2', '/opt/codex', '--no-daemon', 'resume', '--last']);
		expect(withNoDaemon(['codex', '--no-daemon'])).toEqual(['codex', '--no-daemon']);
		expect(programIndex(['env', 'A=1'])).toBe(-1);
	});

	test('the program to probe, unless isolation is off or the arguments need the shared server', () => {
		expect(noDaemonProgram(['env', 'K=v', 'codex', 'hi'], get({}))).toBe('codex');
		expect(noDaemonProgram(['codex'], get({ 'kingu.codex.terminalServerIsolation': false }))).toBeNull();
		for (const a of ['agents', 'queue', '--no-daemon', '--remote', '--remote=ws://h']) expect(noDaemonProgram(['codex', a], get({}))).toBeNull();
		expect(wantsSharedServer(['--model', 'o3'])).toBe(false);
	});

	test('a foreground codex is checked on the ladder, starting over for a new process', () => {
		expect(maybeCodex('codex') && maybeCodex('node') && !maybeCodex('zsh')).toBe(true);
		const w = nextWatch(undefined, { pid: 7, name: 'codex' }, 0)!;
		expect(checkDue(w, CHECK_AFTER_MS[0] - 1)).toBe(false);
		expect(checkDue(w, CHECK_AFTER_MS[0])).toBe(true);
		w.checks = CHECK_AFTER_MS.length;
		expect(checkDue(w, 1e9)).toBe(false);
		expect(nextWatch(w, { pid: 7, name: 'codex' }, 5)).toBe(w);
		expect(nextWatch(w, { pid: 8, name: 'codex' }, 5)).toEqual({ pid: 8, seenAt: 5, checks: 0, done: false });
		expect(nextWatch(w, { pid: 9, name: 'vim' }, 5)).toBeUndefined();
		expect(nextWatch(w, null, 5)).toBeUndefined();
	});
});
