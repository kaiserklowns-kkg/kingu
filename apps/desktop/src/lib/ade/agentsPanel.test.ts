import { describe, expect, test } from 'bun:test';
import { resumeArgv } from './agentsPanel';

describe('session history resume commands', () => {
	test('each CLI resumes its own way', () => {
		expect(resumeArgv('claude', 's')).toEqual(['claude', '--resume', 's']);
		expect(resumeArgv('codex', 's')).toEqual(['codex', 'resume', 's']);
		expect(resumeArgv('gemini', 's')).toEqual(['gemini', '--resume', 's']);
	});
});
