import { describe, expect, test } from 'bun:test';
import { ompProfile, resumeArgv } from './agentsPanel';

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
		expect(resumeArgv('hermes', '20261121_ab12')).toEqual(['hermes', '--resume', '20261121_ab12']);
		expect(resumeArgv('jcode', 'j-1')).toEqual(['jcode', '--resume', 'j-1']);
		expect(resumeArgv('openclaw', 'oc-1')).toEqual(['openclaw', '--resume', 'oc-1']);
		expect(resumeArgv('zcode', 'z1')).toEqual(['zcode', '--resume', 'z1']);
		expect(resumeArgv('muse', 'm-1')).toEqual(['muse', 'resume', 'm-1']);
		expect(resumeArgv('pi', 'p-1')).toEqual(['pi', '--session', 'p-1']);
		expect(resumeArgv('opencode2', 'ses_2')).toEqual(['opencode2', '--standalone', '--session', 'ses_2']);
		expect(resumeArgv('rovo', 'r-1')).toEqual(['acli', 'rovodev', 'run', '--restore', 'r-1']);
		expect(resumeArgv('antigravity', 'a-1')).toEqual(['agy', '--conversation', 'a-1']);
		expect(resumeArgv('omp', 'o-1', '/u/.omp/agent/sessions/b/x.jsonl')).toEqual(['omp', '--resume', 'o-1']);
		expect(resumeArgv('omp', 'o-1', '/u/.omp/profiles/work/agent/sessions/b/x.jsonl')).toEqual(['omp', '--profile', 'work', '--resume', 'o-1']);
		expect(resumeArgv('grok', '019e37f4-5135-7b63-a4ab-6d13aa6bf528')).toEqual(['grok', '--resume', '019e37f4-5135-7b63-a4ab-6d13aa6bf528']);
	});
});

describe('OMP profile of a transcript', () => {
	test('reads the store folder and rejects names OMP would', () => {
		expect(ompProfile('/x/share/omp/profiles/side/sessions/b/t.jsonl')).toBe('side');
		expect(ompProfile('/u/.omp/profiles/Bad/agent/sessions/t.jsonl')).toBeNull();
		expect(ompProfile('/u/.omp/profiles/default/agent/sessions/t.jsonl')).toBeNull();
		expect(ompProfile(null)).toBeNull();
	});
});
