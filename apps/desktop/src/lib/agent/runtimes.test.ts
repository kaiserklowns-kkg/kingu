import { describe, expect, test } from 'bun:test';
import { CLAUDE, featuresOf, parseRuntimes, runtimeChoices, runtimeOf, type RuntimeInfo } from './runtimes';

const gemini: RuntimeInfo = { id: 'gemini', name: 'Gemini CLI', protocol: 'acp', features: { rewind: false, models: false }, custom: false };

describe('chat runtimes', () => {
	test('a chat without a runtime runs on Claude', () => {
		expect(runtimeOf(null)).toBe('claude');
		expect(runtimeOf({})).toBe('claude');
		expect(runtimeOf({ runtime: 'gemini' })).toBe('gemini');
	});

	test('features: Claude has them all, others by their entry, a missing one none', () => {
		expect(featuresOf([], 'claude')).toEqual({ rewind: true, models: true });
		expect(featuresOf([CLAUDE, gemini], 'gemini')).toEqual({ rewind: false, models: false });
		expect(featuresOf([CLAUDE], 'gone')).toEqual({ rewind: false, models: false });
	});

	test('the picker keeps an uninstalled current runtime, marked missing', () => {
		expect(runtimeChoices([CLAUDE, gemini], 'gemini').map((r) => r.id)).toEqual(['claude', 'gemini']);
		expect(runtimeChoices([CLAUDE], 'gemini')).toEqual([
			{ id: 'claude', name: 'Claude Code', missing: false },
			{ id: 'gemini', name: 'gemini', missing: true }
		]);
	});

	test('the Rust list is checked; Claude stays first', () => {
		expect(parseRuntimes(null)).toEqual([CLAUDE]);
		expect(parseRuntimes([{ ...CLAUDE, name: 'x' }, gemini, { id: 'bad', protocol: 'other' }]).map((r) => r.id)).toEqual(['claude', 'gemini']);
	});
});
