// The tools a chat may use (VS Code's Configure Tools picker, chatToolPicker.ts, and its tool
// sets, toolSetsContribution.ts): what the picker lists (tool sets, the runtime's own tools, each
// MCP server's tools), the chat's off list (`ChatMeta.disabled_tools`, which Rust passes as
// `disallowedTools`) and `#set` references in a prompt, which turn a set's tools back on. Kingu only
// ever takes tools away: an SDK `allowedTools` would approve them without asking. Pure, so
// `bun test` covers it; chatTools.svelte.ts keeps the state.

/** Mirrors Rust `tool_sets::ToolSet`. */
export type ToolSet = {
	name: string;
	description: string;
	icon: string | null;
	tools: string[];
	/** The Claude tool names the set stands for. */
	resolved: string[];
	unknown: string[];
	path: string;
	rel: string;
	user: boolean;
};

/** Claude Code's own tools (Rust `tool_sets::CLAUDE_TOOLS`), before a session reports its list. */
export const CLAUDE_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'Skill', 'ExitPlanMode'] as const;
/** Arkai's tools (agent-host arkai/tools.ts `TOOL_NAMES`). */
export const ARKAI_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'TodoWrite'] as const;
/** Rust `chats::MAX_DISABLED_TOOLS`. */
export const MAX_DISABLED = 500;

/** A tool name Rust takes (`chats::valid_tool_name`). */
export const validToolName = (t: string) => t.length > 0 && t.length <= 200 && /^[A-Za-z0-9_.*-]+$/.test(t);

export const mcpServerKey = (server: string) => `mcp__${server}`;
export const mcpToolKey = (server: string, tool: string) => `mcp__${server}__${tool}`;

/** Whether `name` is off by `disabled` (the SDK's rules: its name, `mcp__<server>`, `mcp__<server>__*`, `mcp__*`). */
export function isOff(name: string, disabled: readonly string[]): boolean {
	for (const d of disabled) {
		if (d === name) return true;
		if (!name.startsWith('mcp__') || !d.startsWith('mcp__')) continue;
		if (d === 'mcp__*') return true;
		const server = d.endsWith('__*') ? d.slice(0, -3) : d;
		if (server.split('__').length === 2 && name.startsWith(`${server}__`)) return true;
	}
	return false;
}

export type Check = 'on' | 'off' | 'mixed';

/** How a group of tools stands: all on, all off, or some of each. An empty group is on. */
export function checkOf(tools: readonly string[], disabled: readonly string[]): Check {
	const off = tools.filter((t) => isOff(t, disabled)).length;
	return off === 0 ? 'on' : off === tools.length ? 'off' : 'mixed';
}

/** An MCP server and its tools (names as the server reports them). */
export type ToolServer = { name: string; tools: readonly string[] };

/**
 * The off list with `tools` turned on or off. Turning a tool on whose server is off as a whole
 * (`mcp__<server>`) keeps the server's other tools off one by one (`servers` knows them).
 */
export function setTools(disabled: readonly string[], tools: readonly string[], on: boolean, servers: readonly ToolServer[] = []): string[] {
	let next = [...disabled];
	if (!on) {
		for (const t of tools) if (validToolName(t) && !isOff(t, next)) next.push(t);
		return next.slice(0, MAX_DISABLED);
	}
	for (const t of tools) {
		next = next.filter((d) => d !== t);
		if (!isOff(t, next)) continue;
		// Off through its server: the server's other tools stay off by name.
		const s = servers.find((x) => t.startsWith(`${mcpServerKey(x.name)}__`));
		const key = s ? mcpServerKey(s.name) : null;
		if (!s || !key || !next.includes(key)) continue;
		next = next.filter((d) => d !== key && d !== `${key}__*`);
		for (const other of s.tools.map((x) => mcpToolKey(s.name, x))) if (other !== t && !tools.includes(other) && !next.includes(other)) next.push(other);
	}
	return next.slice(0, MAX_DISABLED);
}

export type ToolRow = { id: string; label: string; description: string; tools: string[] };
export type ToolGroup = { id: string; label: string; description: string; tools: string[]; rows: ToolRow[] };

/**
 * What the picker lists: the tool sets, the runtime's own tools, then each MCP server with its
 * tools (the server row toggles `mcp__<server>`, all of them).
 */
export function toolGroups(input: { sets: readonly ToolSet[]; builtins: readonly string[]; servers: readonly ToolServer[] }, labels: { sets: string; builtin: string }): ToolGroup[] {
	const out: ToolGroup[] = [];
	const sets = input.sets.filter((s) => s.resolved.length);
	if (sets.length)
		out.push({
			id: 'sets',
			label: labels.sets,
			description: '',
			tools: [...new Set(sets.flatMap((s) => s.resolved))],
			rows: sets.map((s) => ({ id: `set:${s.name}`, label: `#${s.name}`, description: s.description || s.resolved.join(', '), tools: s.resolved }))
		});
	const builtins = [...new Set(input.builtins)].filter((b) => !b.startsWith('mcp__') && validToolName(b));
	if (builtins.length) out.push({ id: 'builtin', label: labels.builtin, description: '', tools: builtins, rows: builtins.map((b) => ({ id: `tool:${b}`, label: b, description: '', tools: [b] })) });
	for (const s of input.servers) {
		const key = mcpServerKey(s.name);
		if (!validToolName(key)) continue;
		const tools = s.tools.map((x) => mcpToolKey(s.name, x)).filter(validToolName);
		out.push({ id: `mcp:${s.name}`, label: s.name, description: 'MCP', tools: [key], rows: tools.map((x, i) => ({ id: `tool:${x}`, label: s.tools[i], description: '', tools: [x] })) });
	}
	return out;
}

/** The tool names a session reports (`session_info.tools`): its own and `mcp__<server>__<tool>`, by server. */
export function splitSessionTools(tools: readonly string[]): { builtins: string[]; servers: ToolServer[] } {
	const builtins: string[] = [];
	const byServer = new Map<string, string[]>();
	for (const t of tools) {
		const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(t);
		if (!m) builtins.push(t);
		else byServer.set(m[1], [...(byServer.get(m[1]) ?? []), m[2]]);
	}
	return { builtins, servers: [...byServer].map(([name, list]) => ({ name, tools: list })) };
}

/** The tool sets `#name` in `text` refers to (VS Code: `#reader` in a prompt), once each. */
export function toolSetRefs(text: string, sets: readonly ToolSet[]): ToolSet[] {
	const out: ToolSet[] = [];
	for (const m of text.matchAll(/(?:^|\s)#([A-Za-z0-9][A-Za-z0-9_.-]*?)(?=$|[\s,;:!?)]|\.(?:\s|$))/g)) {
		const set = sets.find((s) => s.name.toLowerCase() === m[1].toLowerCase());
		if (set && !out.includes(set)) out.push(set);
	}
	return out;
}

/** What the agent is told about the sets a prompt names (the prompt itself only says `#reader`). */
export function toolSetContext(refs: readonly ToolSet[]): string {
	return refs.map((s) => `#${s.name}: ${s.resolved.join(', ')}${s.description ? ` (${s.description})` : ''}`).join('\n');
}
