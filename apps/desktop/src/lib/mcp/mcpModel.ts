// The MCP Servers view's model (VS Code's MCP server list, Cursor's Tools & MCP): every server an
// agent of this folder can get, where it comes from, whether it is on, trusted and running. Pure.
//
// Sources (the `<source>:<name>` ids of `kingu.mcp.disabled`): `snap` (trusted Snaps),
// `user` (Kingu's mcp.json), `project` (.mcp.json, which Claude Code starts itself; Rust tells it
// which may), `vscode` / `cursor` (the folder's .vscode/mcp.json and .cursor/mcp.json, read only)
// and `claude` (a server only the live session reports: the user's own Claude Code settings).
// Name clashes: the first of snap, user, vscode, cursor wins (Rust keeps a .mcp.json server of a
// passed name from starting too).

import { isRemote, type McpServerConfig, type McpServers } from '#lib/ade/mcp.ts';

export type McpSource = 'snap' | 'user' | 'project' | 'vscode' | 'cursor' | 'claude';
export const MCP_SOURCES: readonly McpSource[] = ['snap', 'user', 'project', 'vscode', 'cursor', 'claude'];
/** Passed by Kingu, in this order of precedence. */
const PASSED: readonly McpSource[] = ['user', 'vscode', 'cursor'];

/** A config file's server (Rust `agent::mcp::McpEntry`). */
export type McpEntry = {
	name: string;
	source: 'user' | 'project' | 'vscode' | 'cursor';
	file: string;
	rel: string | null;
	server: McpServerConfig | null;
	hash: string;
	trusted: boolean;
	error: string | null;
};

/** One server of a live session (the `mcp_status` event). */
export type McpLive = { name: string; status: string; error: string | null; source: string | null; tools: string[] };

export type McpRow = {
	id: string;
	name: string;
	source: McpSource;
	transport: 'stdio' | 'http' | 'sse' | null;
	/** The command line or the URL. */
	detail: string;
	file: string | null;
	rel: string | null;
	hash: string | null;
	enabled: boolean;
	/** Comes with the folder and is not trusted yet (it does not run). */
	needsTrust: boolean;
	/** A server of the same name earlier in precedence is used instead. */
	shadowed: boolean;
	error: string | null;
	live: McpLive | null;
};

export const mcpId = (source: McpSource, name: string) => `${source}:${name}`;

/** Server names Claude Code accepts as tool name parts (`mcp__<name>__<tool>`). */
export const validServerName = (name: string) => /^[A-Za-z0-9_-]{1,81}$/.test(name);

const quoteArg = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

/** What the row shows under the name: the command line, or the URL. */
export function describe(s: McpServerConfig | null): string {
	if (!s) return '';
	return isRemote(s) ? s.url : [s.command, ...s.args].map(quoteArg).join(' ');
}

const transportOf = (s: McpServerConfig | null): McpRow['transport'] => (s ? (isRemote(s) ? s.type : 'stdio') : null);

/**
 * The servers a run gets: the Snap servers that are on, then the user's, VS Code's and Cursor's
 * servers that are on, valid and (for the folder's) trusted, under names not taken yet.
 * `.mcp.json` servers are left to Claude Code.
 */
export function composeServers(snapServers: McpServers, entries: readonly McpEntry[], disabled: ReadonlySet<string>): McpServers {
	const out: McpServers = {};
	for (const [name, s] of Object.entries(snapServers)) if (!disabled.has(mcpId('snap', name))) out[name] = s;
	for (const source of PASSED) {
		for (const e of entries) {
			if (e.source !== source || !e.server || e.error || !e.trusted || disabled.has(mcpId(source, e.name)) || !validServerName(e.name)) continue;
			if (!(e.name in out)) out[e.name] = e.server;
		}
	}
	return out;
}

/** Rows for the view: Snap servers, config entries, then servers only the live session knows. */
export function mcpRows(snapServers: McpServers, entries: readonly McpEntry[], disabled: ReadonlySet<string>, live: Readonly<Record<string, McpLive>>): McpRow[] {
	const rows: McpRow[] = [];
	const taken = new Set<string>();
	const used = composeServers(snapServers, entries, disabled);
	for (const [name, s] of Object.entries(snapServers)) {
		const id = mcpId('snap', name);
		rows.push({ id, name, source: 'snap', transport: transportOf(s), detail: describe(s), file: null, rel: null, hash: null, enabled: !disabled.has(id), needsTrust: false, shadowed: false, error: null, live: null });
	}
	for (const source of ['user', 'project', 'vscode', 'cursor'] as const) {
		for (const e of entries) {
			if (e.source !== source) continue;
			const id = mcpId(source, e.name);
			const enabled = !disabled.has(id);
			// A passed source that lost its name to an earlier one, or a .mcp.json server Kingu passes under its name.
			const shadowed = enabled && !!e.name && (source === 'project' ? e.name in used : e.trusted && !e.error && e.name in used && used[e.name] !== e.server);
			rows.push({
				id,
				name: e.name,
				source,
				transport: transportOf(e.server),
				detail: describe(e.server),
				file: e.file,
				rel: e.rel,
				hash: e.hash || null,
				enabled,
				needsTrust: source !== 'user' && !e.trusted && !e.error,
				shadowed,
				error: e.error,
				live: null
			});
		}
	}
	// Live status by name: the row that actually runs under that name.
	for (const row of rows) {
		if (row.shadowed || !row.enabled || row.needsTrust || row.error || taken.has(row.name)) continue;
		if (live[row.name]) {
			row.live = live[row.name];
			taken.add(row.name);
		}
	}
	for (const l of Object.values(live)) {
		if (taken.has(l.name) || rows.some((r) => r.name === l.name)) continue;
		const id = mcpId('claude', l.name);
		rows.push({ id, name: l.name, source: 'claude', transport: null, detail: '', file: null, rel: null, hash: null, enabled: !disabled.has(id), needsTrust: false, shadowed: false, error: null, live: l });
	}
	return rows;
}

export type McpState = 'running' | 'starting' | 'failed' | 'needsAuth' | 'off' | 'untrusted' | 'invalid' | 'idle';

/** One word for the status dot and label. `idle`: on, but no session has reported it yet. */
export function rowState(r: McpRow): McpState {
	if (r.error) return 'invalid';
	if (!r.enabled) return 'off';
	if (r.needsTrust) return 'untrusted';
	switch (r.live?.status) {
		case 'connected':
			return 'running';
		case 'pending':
			return 'starting';
		case 'failed':
			return 'failed';
		case 'needs-auth':
			return 'needsAuth';
		case 'disabled':
			return 'off';
		default:
			return 'idle';
	}
}

/** The disabled list with `id` turned on or off (sorted, so the setting stays stable). */
export function withEnabled(disabled: readonly string[], id: string, on: boolean): string[] {
	const set = new Set(disabled);
	if (on) set.delete(id);
	else set.add(id);
	return [...set].sort();
}

/** Latest status per server name across a folder's sessions: the newest report wins. */
export function mergeLive(prev: Readonly<Record<string, McpLive>>, servers: readonly McpLive[]): Record<string, McpLive> {
	const next = { ...prev };
	for (const s of servers) next[s.name] = s;
	return next;
}

/** Claude Code's tool name prefix of a server (`mcp__<name>__`). */
export const toolPrefix = (name: string) => `mcp__${name.replace(/[^A-Za-z0-9_-]/g, '_')}__`;

/**
 * The session start's view (`session_info`): names and status, tools from the session's tool
 * list. Servers a later `mcp_status` already reported keep that report.
 */
export function liveFromSessionInfo(prev: Readonly<Record<string, McpLive>>, servers: readonly { name: string; status: string }[], tools: readonly string[]): Record<string, McpLive> {
	const next = { ...prev };
	for (const s of servers) {
		const prefix = toolPrefix(s.name);
		next[s.name] = { name: s.name, status: s.status, error: null, source: prev[s.name]?.source ?? null, tools: tools.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length)) };
	}
	return next;
}

/**
 * A command line split like a shell would (quotes and backslashes, no expansion), for "Add
 * Server…". Null when a quote is left open.
 */
export function splitCommandLine(text: string): string[] | null {
	const out: string[] = [];
	let cur = '';
	let has = false;
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote === "'") {
			if (c === "'") quote = null;
			else cur += c;
		} else if (quote === '"') {
			if (c === '"') quote = null;
			else if (c === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) cur += text[++i];
			else cur += c;
		} else if (c === "'" || c === '"') {
			quote = c;
			has = true;
		} else if (c === '\\' && i + 1 < text.length) {
			cur += text[++i];
			has = true;
		} else if (/\s/.test(c)) {
			if (has || cur) out.push(cur);
			cur = '';
			has = false;
		} else {
			cur += c;
			has = true;
		}
	}
	if (quote) return null;
	if (has || cur) out.push(cur);
	return out;
}

/** A name for a new server from its command or URL (`npx -y @scope/server-github` → `server-github`). */
export function suggestName(input: string, taken: ReadonlySet<string>): string {
	let base = '';
	try {
		if (/^https?:\/\//.test(input)) base = new URL(input).hostname.split('.').filter((p) => !['www', 'mcp', 'api'].includes(p))[0] ?? '';
	} catch {
		base = '';
	}
	if (!base) {
		const words = splitCommandLine(input) ?? [];
		const pkg = words.filter((w) => !w.startsWith('-')).at(-1) ?? words[0] ?? '';
		base = pkg.split('/').pop()?.replace(/@[^@]*$/, '') ?? '';
	}
	base = base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'server';
	let name = base;
	for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
	return name;
}

/** The server "Add Server…" writes, or a message key for what is wrong with the input. */
export function newServer(kind: 'stdio' | 'http' | 'sse', input: string): { server: McpServerConfig } | { error: 'mcp.add.emptyCommand' | 'mcp.add.openQuote' | 'mcp.add.badUrl' } {
	const text = input.trim();
	if (kind === 'stdio') {
		const words = splitCommandLine(text);
		if (!words) return { error: 'mcp.add.openQuote' };
		if (!words.length || !words[0]) return { error: 'mcp.add.emptyCommand' };
		return { server: { command: words[0], args: words.slice(1), env: {} } };
	}
	if (!/^https?:\/\/\S+$/.test(text)) return { error: 'mcp.add.badUrl' };
	return { server: { type: kind, url: text } };
}
