import { describe, expect, test } from 'bun:test';
import {
	ampMcpConfig,
	codexMcpArgs,
	codexNotifyArgs,
	copilotMcpConfig,
	CUSTOM,
	CUSTOM_PICK,
	cliResume,
	KNOWN_BINS,
	opencodeConfig,
	pasteText,
	pickerItems,
	PROFILES,
	profileOf,
	programOf,
	promptDue,
	type LaunchContext
} from './agentProfiles';
import { applyHook, initialHookState } from './agentHooks';

const servers = { 'go-gopls': { command: 'gopls', args: ['mcp', '--flag=a b'], env: { GOFLAGS: '-mod=mod' } } };
const none: LaunchContext = { servers: {}, plugins: [] };
const withMcp: LaunchContext = { servers, plugins: ['/c/snap-plugins/go-1'] };
const tricky = `แก้ "บั๊ก" $(rm -rf ~) \`id\` 'x'\nบรรทัดสอง`;
const profile = (id: string) => PROFILES.find((p) => p.id === id)!;

/** A minimal TOML value reader for the shapes codex `-c` gets: strings, string arrays, inline string tables. */
function tomlValue(v: string): unknown {
	if (v.startsWith('{')) return Object.fromEntries([...v.matchAll(/("(?:[^"\\]|\\.)*")\s*=\s*("(?:[^"\\]|\\.)*")/g)].map((m) => [JSON.parse(m[1]), JSON.parse(m[2])]));
	return JSON.parse(v);
}

describe('profile detection', () => {
	test('by program name, past a path and an env prefix', () => {
		expect(profileOf(['claude', '--model', 'opus']).id).toBe('claude');
		expect(profileOf(['/opt/homebrew/bin/codex']).id).toBe('codex');
		expect(profileOf(['cursor-agent']).id).toBe('cursor');
		expect(profileOf(['env', 'OPENCODE_CONFIG_CONTENT={}', 'opencode']).id).toBe('opencode');
		expect(profileOf(['mycli', '--x'])).toBe(CUSTOM);
		expect(programOf(['env', 'A=1', 'B=2', '/usr/bin/qwen'])).toBe('qwen');
	});
	test('account env only for claude and codex', () => {
		expect(PROFILES.filter((p) => p.account).map((p) => [p.id, p.account])).toEqual([
			['claude', 'claude'],
			['codex', 'codex']
		]);
	});
	test('the picker lists found CLIs in profile order, then Custom', () => {
		const rows = pickerItems(['codex', 'claude'], 'claude --model opus');
		expect(rows.map((r) => r.id)).toEqual(['claude', 'codex', CUSTOM_PICK]);
		expect(rows[0].description).toContain('hooks');
		expect(rows[2].description).toContain('claude --model opus');
		expect(KNOWN_BINS).toContain('cursor-agent');
	});
});

describe('claude (unchanged behaviour)', () => {
	const ctx: LaunchContext = { ...withMcp, sessionId: 'sid', hookSettings: '{"hooks":{}}' };
	test('start: session id and hooks before the prompt, plugins and --mcp-config after it', () => {
		const { argv, typePrompt } = profile('claude').launch(['claude'], { prompt: tricky }, ctx);
		expect(typePrompt).toBeUndefined();
		expect(argv.slice(0, 6)).toEqual(['claude', '--session-id', 'sid', '--settings', '{"hooks":{}}', tricky]);
		expect(argv.slice(6, 9)).toEqual(['--plugin-dir', '/c/snap-plugins/go-1', '--mcp-config']);
		expect(JSON.parse(argv[9])).toEqual({ mcpServers: servers });
		expect(argv).toHaveLength(10);
	});
	test('resume by id, else --continue; fresh gets a new id', () => {
		expect(profile('claude').launch(['claude'], { resume: 'sid' }, { servers: {}, plugins: [], hookSettings: 'S' }).argv).toEqual(['claude', '--resume', 'sid', '--settings', 'S']);
		expect(profile('claude').launch(['claude'], { resume: null }, none).argv).toEqual(['claude', '--continue']);
		expect(profile('claude').launch(['claude'], { fresh: true }, { servers: {}, plugins: [], sessionId: 'n' }).argv).toEqual(['claude', '--session-id', 'n']);
	});
});

describe('codex', () => {
	const codex = profile('codex');
	test('the prompt is one positional argument after the -c overrides', () => {
		expect(codex.launch(['codex', '--full-auto'], { prompt: tricky }, none).argv).toEqual(['codex', '--full-auto', tricky]);
		expect(codex.launch(['codex'], { prompt: '-v อธิบาย' }, none).argv).toEqual(['codex', '--', '-v อธิบาย']);
	});
	test('MCP servers as -c mcp_servers.<name>.command/args/env TOML values', () => {
		const args = codexMcpArgs(servers);
		expect(args.filter((_, i) => i % 2 === 0)).toEqual(['-c', '-c', '-c']);
		const kv = Object.fromEntries(args.filter((_, i) => i % 2 === 1).map((a) => [a.slice(0, a.indexOf('=')), tomlValue(a.slice(a.indexOf('=') + 1))]));
		expect(kv).toEqual({
			'mcp_servers.go-gopls.command': 'gopls',
			'mcp_servers.go-gopls.args': ['mcp', '--flag=a b'],
			'mcp_servers.go-gopls.env': { GOFLAGS: '-mod=mod' }
		});
		expect(codexMcpArgs({ 'a.b c': { command: 'x', args: [], env: {} } })).toEqual(['-c', 'mcp_servers.a_b_c.command="x"', '-c', 'mcp_servers.a_b_c.args=[]']);
		expect(codexMcpArgs({ q: { command: 'say "hi"\\', args: ['$(x)'], env: {} } })[1]).toBe('mcp_servers.q.command="say \\"hi\\"\\\\"');
	});
	test('notify appends the turn JSON ($1) to the hook file', () => {
		const [flag, value] = codexNotifyArgs('/c/agent-hooks/t.jsonl');
		expect(flag).toBe('-c');
		expect(value.startsWith('notify=')).toBe(true);
		expect(tomlValue(value.slice('notify='.length))).toEqual(['sh', '-c', `printf '%s\\n' "$1" >> '/c/agent-hooks/t.jsonl'`, 'kingu-notify']);
		expect(codexNotifyArgs("/it's/t.jsonl")).toEqual([]);
	});
	test('overrides go before the prompt and before resume', () => {
		const ctx: LaunchContext = { ...withMcp, hookFile: '/h.jsonl' };
		const start = codex.launch(['codex'], { prompt: 'งาน' }, ctx).argv;
		expect(start.at(-1)).toBe('งาน');
		expect(start.filter((a) => a === '-c')).toHaveLength(4);
		const resume = codex.launch(['codex'], { resume: 'th-1' }, ctx).argv;
		expect(resume.slice(-2)).toEqual(['resume', 'th-1']);
		expect(codex.launch(['codex'], { resume: null }, none).argv).toEqual(['codex', 'resume', '--last']);
		expect(codex.skills).toBe(false);
	});
});

describe('other CLIs', () => {
	test('gemini: --prompt-interactive, resume latest', () => {
		const g = profile('gemini');
		expect(g.launch(['gemini'], { prompt: tricky }, withMcp).argv).toEqual(['gemini', '--prompt-interactive', tricky]);
		expect(g.launch(['gemini'], { prompt: '-x' }, none).argv).toEqual(['gemini', '--prompt-interactive=-x']);
		expect(g.launch(['gemini'], { resume: null }, none).argv).toEqual(['gemini', '--resume', 'latest']);
	});
	test('opencode: --prompt, MCP through OPENCODE_CONFIG_CONTENT', () => {
		const o = profile('opencode');
		const argv = o.launch(['opencode'], { prompt: tricky }, withMcp).argv;
		expect(argv[0]).toBe('env');
		expect(argv[1].startsWith('OPENCODE_CONFIG_CONTENT=')).toBe(true);
		expect(JSON.parse(argv[1].slice('OPENCODE_CONFIG_CONTENT='.length))).toEqual({
			mcp: { 'go-gopls': { type: 'local', command: ['gopls', 'mcp', '--flag=a b'], environment: { GOFLAGS: '-mod=mod' }, enabled: true } }
		});
		expect(argv.slice(2)).toEqual(['opencode', '--prompt', tricky]);
		expect(o.launch(['opencode'], { resume: 'ses_1' }, none).argv).toEqual(['opencode', '--session', 'ses_1']);
		expect(o.launch(['opencode'], { resume: null }, none).argv).toEqual(['opencode', '--continue']);
		expect(opencodeConfig({})).toBeNull();
	});
	test('cursor-agent: positional prompt, resume', () => {
		const c = profile('cursor');
		expect(c.launch(['cursor-agent'], { prompt: tricky }, withMcp).argv).toEqual(['cursor-agent', tricky]);
		expect(c.launch(['cursor-agent'], { resume: null }, none).argv).toEqual(['cursor-agent', 'resume']);
		expect(c.launch(['cursor-agent'], { resume: 'chat-1' }, none).argv).toEqual(['cursor-agent', '--resume', 'chat-1']);
	});
	test('copilot: --interactive, --additional-mcp-config before it', () => {
		const argv = profile('copilot').launch(['copilot'], { prompt: tricky }, withMcp).argv;
		expect(argv.slice(0, 2)).toEqual(['copilot', '--additional-mcp-config']);
		expect(JSON.parse(argv[2]).mcpServers['go-gopls']).toEqual({ type: 'local', command: 'gopls', args: ['mcp', '--flag=a b'], env: { GOFLAGS: '-mod=mod' }, tools: ['*'] });
		expect(argv.slice(3)).toEqual(['--interactive', tricky]);
		expect(profile('copilot').launch(['copilot'], { resume: 's1' }, none).argv).toEqual(['copilot', '--resume=s1']);
		expect(copilotMcpConfig({})).toBeNull();
	});
	test('amp, qwen, aider: the prompt is pasted once the TUI is up', () => {
		const amp = profile('amp').launch(['amp'], { prompt: tricky }, withMcp);
		expect(amp.typePrompt).toBe(tricky);
		expect(amp.argv.slice(0, 2)).toEqual(['amp', '--mcp-config']);
		expect(JSON.parse(amp.argv[2])).toEqual(JSON.parse(ampMcpConfig(servers)!));
		expect(amp.argv).toHaveLength(3);
		expect(profile('qwen').launch(['qwen'], { prompt: 'x' }, none)).toEqual({ argv: ['qwen'], typePrompt: 'x' });
		expect(profile('aider').launch(['aider'], { resume: null }, none).argv).toEqual(['aider', '--restore-chat-history']);
	});
	test('droid: positional prompt, --resume', () => {
		expect(profile('droid').launch(['droid'], { prompt: tricky }, none).argv).toEqual(['droid', tricky]);
		expect(profile('droid').launch(['droid'], { resume: null }, none).argv).toEqual(['droid', '--resume']);
	});
	test('a custom command: prompt last, no resume, no MCP', () => {
		expect(CUSTOM.launch(['mycli', '-q'], { prompt: tricky }, withMcp).argv).toEqual(['mycli', '-q', tricky]);
		expect(cliResume(['mycli'])).toBeNull();
		expect(CUSTOM.launch(['mycli'], { resume: 'x' }, none).argv).toEqual(['mycli']);
	});
	test('only claude takes skill plugins', () => {
		expect(PROFILES.filter((p) => p.skills).map((p) => p.id)).toEqual(['claude']);
		for (const p of PROFILES.filter((p) => !p.skills)) expect(p.launch(['x'], { fresh: true }, { servers: {}, plugins: ['/p'] }).argv.join(' ')).not.toContain('/p');
	});
});

describe('pasted prompts and codex notify', () => {
	test('paste after output then quiet, or after the deadline', () => {
		expect(promptDue(0, false, 0, 5000)).toBe(false);
		expect(promptDue(0, true, 2000, 3000)).toBe(false);
		expect(promptDue(0, true, 2000, 3600)).toBe(true);
		expect(promptDue(0, true, 1000, 2900)).toBe(false);
		expect(promptDue(0, false, undefined, 20000)).toBe(true);
	});
	test('bracketed paste cannot be closed early by the prompt', () => {
		expect(pasteText('a\nb')).toBe('\x1b[200~a\nb\x1b[201~');
		expect(pasteText('x\x1b[201~y')).toBe('\x1b[200~xy\x1b[201~');
	});
	test('a codex turn-complete payload: idle, its thread id is the session', () => {
		const s = applyHook(initialHookState(0), { type: 'agent-turn-complete', 'thread-id': 'th-1', 'turn-id': '1', 'last-assistant-message': 'แก้แล้ว\nรายละเอียด' } as object, 5);
		expect(s).toMatchObject({ phase: 'idle', sessionId: 'th-1', message: 'แก้แล้ว', at: 5 });
		expect(applyHook(s, { type: 'agent-turn-complete' }, 6)).toMatchObject({ sessionId: 'th-1', message: 'จบรอบ รอคุณ' });
	});
});
