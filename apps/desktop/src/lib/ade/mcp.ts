// What agents get besides their own config: MCP servers and skill plugins. The Snap store
// registers itself as the provider; the MCP store (mcp/mcp.svelte.ts) composes the result with
// the servers of the user's and the folder's config files and drops the ones turned off. Agents
// read it when a run starts, passing their worktree (the folder Snap servers are confined to; see
// snapModel.sandboxedArgv): the timeline through the agent host's `mcpServers` / `plugins`, the
// claude CLI through `--mcp-config` (a JSON string argument) and `--plugin-dir` (one folder per
// flag). Pure.

/** A program over stdio. */
export type McpServer = { type?: 'stdio'; command: string; args: string[]; env: Record<string, string> };
/** A remote server (Streamable HTTP or SSE). */
export type McpRemoteServer = { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };
export type McpServerConfig = McpServer | McpRemoteServer;
export type McpServers = Record<string, McpServerConfig>;
export type StdioServers = Record<string, McpServer>;

export const isRemote = (s: McpServerConfig): s is McpRemoteServer => s.type === 'http' || s.type === 'sse';

/** The stdio servers only (CLIs that take no remote servers from Kingu). */
export function stdioOnly(servers: McpServers): StdioServers {
	return Object.fromEntries(Object.entries(servers).filter((e): e is [string, McpServer] => !isRemote(e[1])));
}

let provider: (root: string | null) => McpServers = () => ({});
let compose: (snapServers: McpServers, root: string | null) => McpServers = (s) => s;
let pluginProvider: () => Promise<string[]> = async () => [];
let builtInPlugins: () => Promise<string[]> = async () => [];
let hubPlugins: () => Promise<string[]> = async () => [];

export function setMcpProvider(fn: (root: string | null) => McpServers) {
	provider = fn;
}

/** The MCP store's step over the Snap servers: adds config servers, drops turned-off ones. */
export function setMcpComposer(fn: (snapServers: McpServers, root: string | null) => McpServers) {
	compose = fn;
}

/** The Snap servers alone (the MCP Servers view lists them with their on/off state). */
export function snapMcpServers(root: string | null): McpServers {
	return provider(root);
}

/** MCP servers for an agent working in `root`. */
export function mcpServers(root: string | null): McpServers {
	return compose(provider(root), root);
}

/** Skill plugin folders (written by Rust into the app cache) come from the Snap store too. */
export function setSkillPluginProvider(fn: () => Promise<string[]>) {
	pluginProvider = fn;
}

/** Kingu's own skill plugins (the `kingu` command's skill, cliBridge.svelte.ts), before the Snap ones. */
export function setBuiltInPluginProvider(fn: () => Promise<string[]>) {
	builtInPlugins = fn;
}

/** The skills installed through the Skills view (skills/skills.svelte.ts): one plugin folder. */
export function setHubPluginProvider(fn: () => Promise<string[]>) {
	hubPlugins = fn;
}

/** Skill plugin folders for a run starting now; never throws (an agent still starts without them). */
export async function skillPlugins(): Promise<string[]> {
	const safe = async (fn: () => Promise<string[]>) => {
		try {
			return await fn();
		} catch {
			return [];
		}
	};
	const [own, hub, snaps] = await Promise.all([safe(builtInPlugins), safe(hubPlugins), safe(pluginProvider)]);
	return [...own, ...hub, ...snaps];
}

/** Claude Code's `--mcp-config` JSON for these servers, or null when there are none. */
export function claudeMcpConfig(servers: McpServers): string | null {
	const entries = Object.entries(servers);
	if (!entries.length) return null;
	return JSON.stringify({
		mcpServers: Object.fromEntries(entries.map(([name, s]) => [name, isRemote(s) ? { type: s.type, url: s.url, ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {}) } : { command: s.command, args: s.args, env: s.env }]))
	});
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
