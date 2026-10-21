// What trusted Snaps hand to agents: MCP servers and skill plugins. The Snap store registers
// itself as the provider; agents read it when a run starts, passing their worktree (the folder
// the servers are confined to; see snapModel.sandboxedArgv): the timeline through the agent
// host's `mcpServers` / `plugins`, the claude CLI through `--mcp-config` (a JSON string
// argument) and `--plugin-dir` (one folder per flag). Pure.

export type McpServer = { command: string; args: string[]; env: Record<string, string> };
export type McpServers = Record<string, McpServer>;

let provider: (root: string | null) => McpServers = () => ({});
let pluginProvider: (root: string | null) => Promise<string[]> = async () => [];

export function setMcpProvider(fn: (root: string | null) => McpServers) {
	provider = fn;
}

/** MCP servers for an agent working in `root`. */
export function mcpServers(root: string | null): McpServers {
	return provider(root);
}

/** Skill plugin folders (written by Rust into the app cache, with the snaps' hooks) come from the Snap store too. */
export function setSkillPluginProvider(fn: (root: string | null) => Promise<string[]>) {
	pluginProvider = fn;
}

/** Skill plugin folders for a run starting now in `root` (the worktree hooks are confined to); never throws (an agent still starts without them). */
export async function skillPlugins(root: string | null): Promise<string[]> {
	try {
		return await pluginProvider(root);
	} catch {
		return [];
	}
}

/** Claude Code's `--mcp-config` JSON for these servers, or null when there are none. */
export function claudeMcpConfig(servers: McpServers): string | null {
	const entries = Object.entries(servers);
	if (!entries.length) return null;
	return JSON.stringify({ mcpServers: Object.fromEntries(entries.map(([name, s]) => [name, { command: s.command, args: s.args, env: s.env }])) });
}

/**
 * The CLI argv with the Snap contributions added at the end where the CLI supports them
 * (claude); others run without them. `--plugin-dir` takes one value per flag; `--mcp-config`
 * takes several, so it goes last: a prompt or another flag value after it would be read as a config.
 */
export function cliWithMcp(argv: string[], servers: McpServers, plugins: readonly string[] = []): string[] {
	const program = argv[0]?.split('/').pop();
	if (program !== 'claude') return argv;
	const config = claudeMcpConfig(servers);
	return [...argv, ...plugins.flatMap((dir) => ['--plugin-dir', dir]), ...(config ? ['--mcp-config', config] : [])];
}
