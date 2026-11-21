import { describe, expect, test } from 'bun:test';
import { resumeArgv } from './agentsPanel';

describe('session history resume commands', () => {
	test('each CLI resumes its own way', () => {
		expect(resumeArgv('claude', 's')).toEqual(['claude', '--resume', 's']);
		expect(resumeArgv('codex', 's')).toEqual(['codex', 'resume', 's']);
		expect(resumeArgv('gemini', 's')).toEqual(['gemini', '--resume', 's']);
		expect(resumeArgv('opencode', 'ses_1')).toEqual(['opencode', '--session', 'ses_1']);
		expect(resumeArgv('copilot', 'cp-1')).toEqual(['copilot', '--resume=cp-1']);
		expect(resumeArgv('cursor', 'u-1')).toEqual(['cursor-agent', '--resume', 'u-1']);
		expect(resumeArgv('qoder', 'q')).toEqual(['qodercli', '--resume', 'q']);
		expect(resumeArgv('codebuddy', 'c')).toEqual(['codebuddy', '--resume', 'c']);
		expect(resumeArgv('droid', 'd')).toEqual(['droid', '--resume', 'd']);
		expect(resumeArgv('kiro', 'k')).toEqual(['kiro-cli', 'chat', '--tui', '--resume-id', 'k']);
		expect(resumeArgv('kimi', 'session_1')).toEqual(['kimi', '--session', 'session_1']);
		expect(resumeArgv('cline', 'cl-1')).toEqual(['cline', '--id', 'cl-1']);
		expect(resumeArgv('devin', 'dv')).toEqual(['devin', '--resume', 'dv']);
		expect(resumeArgv('grok', '019e37f4-5135-7b63-a4ab-6d13aa6bf528')).toEqual(['grok', '--resume', '019e37f4-5135-7b63-a4ab-6d13aa6bf528']);
	});
});
