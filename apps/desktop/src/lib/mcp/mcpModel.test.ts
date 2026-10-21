import { describe, expect, test } from 'bun:test';
import { claudeMcpConfig, stdioOnly, type McpServers } from '#lib/ade/mcp.ts';
import { codexMcpArgs } from '#lib/ade/agentProfiles.ts';
import { composeServers, describe as describeServer, liveFromSessionInfo, mcpRows, mergeLive, newServer, rowState, splitCommandLine, suggestName, withEnabled, type McpEntry } from './mcpModel.ts';

const entry = (over: Partial<McpEntry> & Pick<McpEntry, 'name' | 'source'>): McpEntry => ({
	file: `/repo/${over.source}.json`,
	rel: over.source === 'user' ? null : `${over.source}.json`,
	server: { command: over.name, args: [], env: {} },
	hash: `h-${over.name}`,
	trusted: over.source === 'user',
	error: null,
	...over
});

const snap: McpServers = { 'go-gopls': { command: 'gopls', args: ['mcp'], env: {} } };

describe('MCP servers for a run', () => {
	test('Snap, user, VS Code and Cursor servers that are on and trusted, first name wins; .mcp.json is left to Claude Code', () => {
		const entries = [
			entry({ name: 'gh', source: 'user' }),
			entry({ name: 'docs', source: 'vscode', trusted: true, server: { type: 'http', url: 'https://d.dev/mcp' } }),
			entry({ name: 'gh', source: 'cursor', trusted: true, server: { command: 'other-gh', args: [], env: {} } }),
			entry({ name: 'db', source: 'project', trusted: true }),
			entry({ name: 'evil', source: 'cursor', trusted: false }),
			entry({ name: 'broken', source: 'user', server: null, error: 'bad' }),
			entry({ name: 'off', source: 'user' })
		];
		const out = composeServers(snap, entries, new Set(['user:off']));
		expect(Object.keys(out).sort()).toEqual(['docs', 'gh', 'go-gopls']);
		expect(out.gh).toEqual({ command: 'gh', args: [], env: {} });
		expect(composeServers(snap, [], new Set(['snap:go-gopls']))).toEqual({});
	});

	test('the claude CLI gets remote servers too; other CLIs only stdio ones', () => {
		const servers: McpServers = { ...snap, docs: { type: 'http', url: 'https://d.dev/mcp', headers: { A: 'b' } } };
		expect(JSON.parse(claudeMcpConfig(servers)!).mcpServers.docs).toEqual({ type: 'http', url: 'https://d.dev/mcp', headers: { A: 'b' } });
		expect(Object.keys(stdioOnly(servers))).toEqual(['go-gopls']);
		expect(codexMcpArgs(servers).join(' ')).not.toContain('docs');
	});
});

describe('MCP Servers view rows', () => {
	test('each source with its state; live status goes to the server that runs under that name', () => {
		const entries = [
			entry({ name: 'gh', source: 'user' }),
			entry({ name: 'gh', source: 'cursor', trusted: true, server: { command: 'x', args: [], env: {} } }),
			entry({ name: 'db', source: 'project' }),
			entry({ name: 'key', source: 'vscode', server: null, error: 'needs input' })
		];
		const live = mergeLive({}, [
			{ name: 'gh', status: 'connected', error: null, source: 'dynamic', tools: ['search', 'create_issue'] },
			{ name: 'go-gopls', status: 'failed', error: 'spawn gopls ENOENT', source: 'dynamic', tools: [] },
			{ name: 'notion', status: 'needs-auth', error: null, source: 'user', tools: [] }
		]);
		const rows = mcpRows(snap, entries, new Set(['claude:notion']), live);
		const by = (id: string) => rows.find((r) => r.id === id)!;
		expect(rows.map((r) => r.id)).toEqual(['snap:go-gopls', 'user:gh', 'project:db', 'vscode:key', 'cursor:gh', 'claude:notion']);
		expect(rowState(by('snap:go-gopls'))).toBe('failed');
		expect([rowState(by('user:gh')), by('user:gh').live?.tools.length]).toEqual(['running', 2]);
		expect([by('cursor:gh').shadowed, by('cursor:gh').live]).toEqual([true, null]);
		expect([rowState(by('project:db')), by('project:db').needsTrust]).toEqual(['untrusted', true]);
		expect(rowState(by('vscode:key'))).toBe('invalid');
		expect(rowState(by('claude:notion'))).toBe('off');
		expect(describeServer({ command: 'npx', args: ['-y', 'my server'], env: {} })).toBe("npx -y 'my server'");
	});

	test('a .mcp.json server is shadowed when Kingu passes a server of its name', () => {
		const rows = mcpRows({}, [entry({ name: 'gh', source: 'user' }), entry({ name: 'gh', source: 'project', trusted: true })], new Set(), {});
		expect(rows.find((r) => r.source === 'project')?.shadowed).toBe(true);
		expect(rowState(rows[0])).toBe('idle');
	});

	test('session start statuses carry the tools of the session list', () => {
		const live = liveFromSessionInfo({}, [{ name: 'gh', status: 'pending' }, { name: 'my.srv', status: 'connected' }], ['Bash', 'mcp__gh__search', 'mcp__my_srv__q', 'mcp__ghx__no']);
		expect(live.gh.tools).toEqual(['search']);
		expect(live['my.srv'].tools).toEqual(['q']);
	});

	test('the disabled list stays sorted and unique', () => {
		expect(withEnabled(['user:b'], 'project:a', false)).toEqual(['project:a', 'user:b']);
		expect(withEnabled(['project:a', 'user:b'], 'project:a', true)).toEqual(['user:b']);
		expect(withEnabled(['user:b'], 'user:b', false)).toEqual(['user:b']);
	});
});

describe('Add Server…', () => {
	test('splits a command line like a shell', () => {
		expect(splitCommandLine(`npx -y "@scope/server x" 'a b' c\\ d ""`)).toEqual(['npx', '-y', '@scope/server x', 'a b', 'c d', '']);
		expect(splitCommandLine('echo "open')).toBeNull();
		expect(splitCommandLine('   ')).toEqual([]);
	});

	test('makes stdio and remote servers, or says what is wrong', () => {
		expect(newServer('stdio', ' uvx mcp-server-git --repo . ')).toEqual({ server: { command: 'uvx', args: ['mcp-server-git', '--repo', '.'], env: {} } });
		expect(newServer('stdio', '')).toEqual({ error: 'mcp.add.emptyCommand' });
		expect(newServer('stdio', 'x "y')).toEqual({ error: 'mcp.add.openQuote' });
		expect(newServer('http', 'https://mcp.example.com/mcp')).toEqual({ server: { type: 'http', url: 'https://mcp.example.com/mcp' } });
		expect(newServer('sse', 'file:///x')).toEqual({ error: 'mcp.add.badUrl' });
	});

	test('suggests a free name from the package or host', () => {
		expect(suggestName('npx -y @modelcontextprotocol/server-github', new Set())).toBe('server-github');
		expect(suggestName('npx -y @playwright/mcp@latest', new Set())).toBe('mcp');
		expect(suggestName('https://mcp.linear.app/sse', new Set(['linear']))).toBe('linear-2');
		expect(suggestName('', new Set())).toBe('server');
	});
});
