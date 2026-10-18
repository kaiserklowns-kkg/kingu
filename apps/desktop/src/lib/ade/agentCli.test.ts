import { describe, expect, test } from 'bun:test';
import { cliAgent, cliOf, cliResume, cliStart, isWorking, parseCliCommand } from './agentCli';

describe('agent CLI', () => {
	test('parses a plain command and refuses shell syntax', () => {
		expect(parseCliCommand(' codex  --full-auto ')).toEqual(['codex', '--full-auto']);
		expect(parseCliCommand('claude; rm -rf ~')).toBeNull();
		expect(parseCliCommand('claude $(whoami)')).toBeNull();
		expect(parseCliCommand('')).toBeNull();
	});
	test('the prompt is the last argument, one argument even with newlines', () => {
		expect(cliStart(['claude'], 'แก้บั๊ก\nหน้า login')).toEqual(['claude', 'แก้บั๊ก\nหน้า login']);
	});
	test('a task stores its command as its agent', () => {
		expect(cliOf(cliAgent(['claude', '--model', 'opus']))).toEqual(['claude', '--model', 'opus']);
		expect(cliOf('claude-code')).toBeNull();
	});
	test('resume the latest session where the CLI can', () => {
		expect(cliResume(['claude'])).toEqual(['claude', '--continue']);
		expect(cliResume(['/opt/bin/codex'])).toEqual(['/opt/bin/codex', 'resume', '--last']);
		expect(cliResume(['mycli'])).toBeNull();
	});
	test('working while output keeps coming', () => {
		expect(isWorking(1000, 2000)).toBe(true);
		expect(isWorking(1000, 5000)).toBe(false);
		expect(isWorking(undefined, 5000)).toBe(false);
	});
});
