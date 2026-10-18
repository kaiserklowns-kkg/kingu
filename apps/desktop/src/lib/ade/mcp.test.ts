import { describe, expect, test } from 'bun:test';
import { claudeMcpConfig, cliWithMcp } from './mcp';

const servers = { 'go-gopls': { command: 'gopls', args: ['mcp'], env: { GOFLAGS: '-mod=mod' } } };

describe('MCP for agent CLIs', () => {
	test('claude gets --mcp-config as one JSON argument', () => {
		const argv = cliWithMcp(['claude'], servers);
		expect(argv.slice(0, 2)).toEqual(['claude', '--mcp-config']);
		expect(JSON.parse(argv[2])).toEqual({ mcpServers: servers });
	});
	test('the flag goes after the prompt (it takes several values)', () => {
		expect(cliWithMcp(['claude', 'แก้บั๊ก'], servers).slice(0, 3)).toEqual(['claude', 'แก้บั๊ก', '--mcp-config']);
	});
	test('claude gets one --plugin-dir per skill plugin, before the variadic --mcp-config', () => {
		const argv = cliWithMcp(['claude', 'แก้บั๊ก'], servers, ['/c/snap-plugins/go-1', '/c/snap-plugins/lint-2']);
		expect(argv.slice(0, 6)).toEqual(['claude', 'แก้บั๊ก', '--plugin-dir', '/c/snap-plugins/go-1', '--plugin-dir', '/c/snap-plugins/lint-2']);
		expect(argv[6]).toBe('--mcp-config');
		expect(argv).toHaveLength(8);
		expect(cliWithMcp(['claude', '--continue'], {}, ['/p'])).toEqual(['claude', '--continue', '--plugin-dir', '/p']);
		expect(cliWithMcp(['/usr/local/bin/codex', 'x'], servers, ['/p'])).toEqual(['/usr/local/bin/codex', 'x']);
	});
	test('no servers, or a CLI without the flag, runs unchanged', () => {
		expect(cliWithMcp(['claude'], {})).toEqual(['claude']);
		expect(cliWithMcp(['codex'], servers)).toEqual(['codex']);
		expect(claudeMcpConfig({})).toBeNull();
	});
	test('a sandboxed snap server keeps the launcher as its command in --mcp-config', () => {
		const wrapped = { 'go-gopls': { command: '/App/kingu-ptyd', args: ['snap-exec', '--network', 'off', '--fs', 'worktree', '--root', '/w', '--', 'gopls', 'mcp'], env: {} } };
		const config = JSON.parse(cliWithMcp(['claude'], wrapped)[2]);
		expect(config.mcpServers['go-gopls'].command).toBe('/App/kingu-ptyd');
		expect(config.mcpServers['go-gopls'].args.slice(-3)).toEqual(['--', 'gopls', 'mcp']);
	});
});
