// MCP servers handed to agents (from trusted Snaps). The Snap store registers itself as the
// provider; agents read it when a run starts: the timeline through the agent host's
// `mcpServers`, the claude CLI through `--mcp-config` (a JSON string argument). Pure.

export type McpServer = { command: string; args: string[]; env: Record<string, string> };
export type McpServers = Record<string, McpServer>;

let provider: () => McpServers = () => ({});

export function setMcpProvider(fn: () => McpServers) {
	provider = fn;
}

export function mcpServers(): McpServers {
	return provider();
}

/** Claude Code's `--mcp-config` JSON for these servers, or null when there are none. */
export function claudeMcpConfig(servers: McpServers): string | null {
	const entries = Object.entries(servers);
	if (!entries.length) return null;
	return JSON.stringify({ mcpServers: Object.fromEntries(entries.map(([name, s]) => [name, { command: s.command, args: s.args, env: s.env }])) });
}

/**
 * The CLI argv with the servers added at the end where the CLI supports it (claude); others run
 * without them. Last on purpose: `--mcp-config` takes several values, so a prompt after it would be read as one.
 */
export function cliWithMcp(argv: string[], servers: McpServers): string[] {
	const program = argv[0]?.split('/').pop();
	const config = program === 'claude' ? claudeMcpConfig(servers) : null;
	return config ? [...argv, '--mcp-config', config] : argv;
}
