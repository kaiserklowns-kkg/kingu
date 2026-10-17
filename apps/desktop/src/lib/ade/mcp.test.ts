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
	test('no servers, or a CLI without the flag, runs unchanged', () => {
		expect(cliWithMcp(['claude'], {})).toEqual(['claude']);
		expect(cliWithMcp(['codex'], servers)).toEqual(['codex']);
		expect(claudeMcpConfig({})).toBeNull();
	});
});
