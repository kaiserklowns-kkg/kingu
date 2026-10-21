// Pure helpers the other runtimes share: an ACP / Codex tool call as the Claude-shaped tool row
// the chat already renders (Bash, Edit, Write, Read, Grep, WebFetch, TodoWrite), Kingu's
// permission modes as a client-side policy, and ACP's permission options as our decisions.

import { isAbsolute, join, normalize } from 'node:path';
import { truncate, MAX_TOOL_RESULT_CHARS } from '../normalize.ts';
import type { Decision, McpServerParams, PermissionMode } from '../protocol.ts';

type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** ACP's tool kinds (`ToolKind`); Codex items are mapped onto the same ones. */
export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
const KINDS: readonly string[] = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'];
export const toolKind = (v: unknown): ToolKind => (typeof v === 'string' && KINDS.includes(v) ? (v as ToolKind) : 'other');

/** A tool row: the chat's tool name, its input, and the files it writes (snapshotted first). */
export type ToolView = { name: string; input: Obj; kind: ToolKind; paths: string[] };

/** Agent session ids Rust keeps (tasks.rs `valid_session_id`); any other id is not reported. */
export const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

const MAX_NAME = 80;

/** An absolute path for `p` (relative ones are taken from `cwd`); null when it is not a usable path. */
export function absPath(p: unknown, cwd: string): string | null {
	if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return null;
	return normalize(isAbsolute(p) ? p : join(cwd, p));
}

/** An ACP tool call (`tool_call` / `tool_call_update` fields merged so far) as a chat tool row. */
export function acpToolView(call: Obj, cwd: string): ToolView {
	const kind = toolKind(call.kind);
	const raw = isObj(call.rawInput) ? call.rawInput : {};
	const title = str(call.title)?.trim() ?? '';
	const content = Array.isArray(call.content) ? call.content.filter(isObj) : [];
	const diffs = content.filter((c) => c.type === 'diff');
	const locations = Array.isArray(call.locations) ? call.locations.filter(isObj) : [];
	const firstPath = absPath(diffs[0]?.path, cwd) ?? absPath(locations[0]?.path, cwd) ?? absPath(raw.file_path ?? raw.path ?? raw.absolute_path, cwd);
	const paths = [...new Set([...diffs.map((d) => absPath(d.path, cwd)), ...locations.map((l) => absPath(l.path, cwd))].filter((p): p is string => !!p))];
	switch (kind) {
		case 'execute':
			return { name: 'Bash', kind, paths: [], input: { ...raw, command: str(raw.command) ?? title, ...(str(raw.description) ? { description: raw.description } : {}) } };
		case 'edit': {
			const d = diffs[0];
			if (d && firstPath) {
				const oldText = str(d.oldText);
				if (oldText === null || oldText === '') return { name: 'Write', kind, paths, input: { file_path: firstPath, content: str(d.newText) ?? '' } };
				return { name: 'Edit', kind, paths, input: { file_path: firstPath, old_string: oldText, new_string: str(d.newText) ?? '' } };
			}
			return { name: 'Edit', kind, paths, input: { ...raw, ...(firstPath ? { file_path: firstPath } : {}), ...(title ? { description: title } : {}) } };
		}
		case 'read':
			return firstPath ? { name: 'Read', kind, paths: [], input: { ...raw, file_path: firstPath } } : other(title, kind, raw);
		case 'search':
			return { name: 'Grep', kind, paths: [], input: { ...raw, pattern: str(raw.pattern) ?? str(raw.query) ?? title } };
		case 'fetch':
			return str(raw.url) ? { name: 'WebFetch', kind, paths: [], input: raw } : { name: 'WebSearch', kind, paths: [], input: { ...raw, query: str(raw.query) ?? title } };
		default:
			return other(title, kind, raw, paths);
	}
}

/** A tool the chat has no row of its own for: its title is the name (one line, cut). */
function other(title: string, kind: ToolKind, raw: Obj, paths: string[] = []): ToolView {
	const name = truncate(title.replace(/\s+/g, ' ') || kind, MAX_NAME);
	return { name, kind, paths: kind === 'delete' || kind === 'move' ? paths : [], input: raw };
}

/** A tool call's output for its `tool_result`: text content, diffs as `path`, else the raw output. */
export function acpToolOutput(call: Obj): string {
	const parts: string[] = [];
	for (const c of Array.isArray(call.content) ? call.content.filter(isObj) : []) {
		if (c.type === 'content' && isObj(c.content) && typeof c.content.text === 'string') parts.push(c.content.text);
		else if (c.type === 'diff' && typeof c.path === 'string') parts.push(c.path);
	}
	if (!parts.length) {
		const out = call.rawOutput;
		if (typeof out === 'string') parts.push(out);
		else if (isObj(out)) parts.push(str(out.output) ?? str(out.stdout) ?? JSON.stringify(out));
	}
	return truncate(parts.join('\n'), MAX_TOOL_RESULT_CHARS);
}

/** An ACP `plan` (or Codex's plan steps) as a TodoWrite input, so the chat's todo bar shows it. */
export function planTodos(entries: unknown): { todos: { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }[] } {
	const list = Array.isArray(entries) ? entries.filter(isObj) : [];
	return {
		todos: list.flatMap((e) => {
			const content = (str(e.content) ?? str(e.step) ?? '').trim();
			if (!content) return [];
			const s = e.status;
			const status = s === 'completed' ? 'completed' : s === 'in_progress' || s === 'inProgress' ? 'in_progress' : 'pending';
			return [{ content, status, activeForm: content }];
		})
	};
}

/**
 * What Kingu answers by itself in a permission mode, before asking the user: "Allow all" allows
 * everything, "Accept edits" allows file edits and reads, plan mode refuses anything that changes
 * files or runs commands. `null`: ask.
 */
export function autoDecision(mode: PermissionMode, kind: ToolKind): 'allow' | 'deny' | null {
	switch (mode) {
		case 'bypassPermissions':
			return 'allow';
		case 'acceptEdits':
			return kind === 'edit' || kind === 'read' || kind === 'search' || kind === 'think' ? 'allow' : null;
		case 'plan':
			return kind === 'edit' || kind === 'delete' || kind === 'move' || kind === 'execute' ? 'deny' : null;
		default:
			return null;
	}
}

export type AcpOption = { optionId: string; name: string; kind: string };

export function acpOptions(v: unknown): AcpOption[] {
	return (Array.isArray(v) ? v.filter(isObj) : []).flatMap((o) => (typeof o.optionId === 'string' && typeof o.kind === 'string' ? [{ optionId: o.optionId, name: str(o.name) ?? o.optionId, kind: o.kind }] : []));
}

/**
 * Our decision as the agent's own option: `allow` → allow once, the "always" answers → allow
 * always (the agent keeps it for its session), `deny` → reject once. Null when it offers none of
 * those (the request is then cancelled).
 */
export function acpOptionFor(decision: Decision, options: readonly AcpOption[]): string | null {
	const find = (...kinds: string[]) => kinds.map((k) => options.find((o) => o.kind === k)).find((o) => o)?.optionId ?? null;
	switch (decision) {
		case 'allow':
			return find('allow_once', 'allow_always');
		case 'deny':
			return find('reject_once', 'reject_always');
		default:
			return find('allow_always', 'allow_once');
	}
}

/** Kingu's permission modes as an agent's own session modes, when it has one by these ids. */
const MODE_IDS: Record<PermissionMode, readonly string[]> = {
	default: ['default'],
	acceptEdits: ['acceptEdits', 'autoEdit', 'auto_edit', 'auto-edit'],
	plan: ['plan'],
	bypassPermissions: ['bypassPermissions', 'yolo']
};
export function agentModeFor(mode: PermissionMode, available: unknown): string | null {
	const ids = new Set((Array.isArray(available) ? available.filter(isObj) : []).map((m) => str(m.id)).filter(Boolean));
	return MODE_IDS[mode].find((id) => ids.has(id)) ?? null;
}

/** Our MCP servers as ACP's `McpServer` list: stdio always, http / sse only when the agent takes them. */
export function acpMcpServers(servers: Record<string, McpServerParams>, caps: unknown): unknown[] {
	const c = isObj(caps) ? caps : {};
	const pairs = (o: Record<string, string> | undefined) => Object.entries(o ?? {}).map(([name, value]) => ({ name, value }));
	return Object.entries(servers).flatMap(([name, s]): unknown[] => {
		const type = s.type ?? 'stdio';
		if (type === 'stdio' && s.command) return [{ name, command: s.command, args: s.args ?? [], env: pairs(s.env) }];
		if ((type === 'http' || type === 'sse') && s.url && c[type] === true) return [{ type, name, url: s.url, headers: pairs(s.headers) }];
		return [];
	});
}

/**
 * Codex's approval policy and sandbox for a permission mode, stated in full on every thread start
 * and resume (a resume inherits anything left out). Like old Kingu: "Allow all" never asks and
 * runs without the sandbox.
 */
export function codexPolicy(mode: PermissionMode): { approvalPolicy: string; sandbox: string } {
	switch (mode) {
		case 'bypassPermissions':
			return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
		case 'acceptEdits':
			return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
		case 'plan':
			return { approvalPolicy: 'untrusted', sandbox: 'read-only' };
		default:
			return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
	}
}

/** Our decision as Codex's approval answer. */
export function codexDecision(decision: Decision | 'cancelled'): string {
	switch (decision) {
		case 'allow':
			return 'accept';
		case 'deny':
			return 'decline';
		case 'cancelled':
			return 'cancel';
		default:
			return 'acceptForSession';
	}
}

/** A Codex thread item (`commandExecution`, `fileChange`, `mcpToolCall`, `webSearch`) as a chat tool row; null for the rest. */
export function codexToolView(item: Obj, cwd: string): ToolView | null {
	switch (item.type) {
		case 'commandExecution': {
			const command = Array.isArray(item.command) ? item.command.map(String).join(' ') : (str(item.command) ?? '');
			return { name: 'Bash', kind: 'execute', paths: [], input: { command, ...(str(item.cwd) ? { cwd: item.cwd } : {}) } };
		}
		case 'fileChange': {
			const changes = Array.isArray(item.changes) ? item.changes.filter(isObj) : [];
			const paths = [...new Set(changes.map((c) => absPath(c.path, cwd)).filter((p): p is string => !!p))];
			const added = changes.length === 1 && isObj(changes[0]!.kind) && changes[0]!.kind.type === 'add';
			const diff = changes.map((c) => str(c.diff) ?? '').join('\n');
			return { name: added ? 'Write' : 'Edit', kind: 'edit', paths, input: { file_path: paths[0] ?? '', ...(paths.length > 1 ? { files: paths } : {}), ...(diff ? { diff: truncate(diff, MAX_TOOL_RESULT_CHARS) } : {}) } };
		}
		case 'mcpToolCall':
			return { name: `mcp__${str(item.server) ?? 'mcp'}__${str(item.tool) ?? 'tool'}`, kind: 'other', paths: [], input: isObj(item.arguments) ? item.arguments : {} };
		case 'webSearch':
			return { name: 'WebSearch', kind: 'fetch', paths: [], input: { query: str(item.query) ?? '' } };
		default:
			return null;
	}
}

/** A finished Codex tool item's `tool_result`. */
export function codexToolResult(item: Obj): { content: string; is_error: boolean } {
	const status = str(item.status) ?? 'completed';
	const failed = status === 'failed' || status === 'declined';
	switch (item.type) {
		case 'commandExecution': {
			const code = num(item.exitCode);
			return { content: truncate(str(item.aggregatedOutput) ?? '', MAX_TOOL_RESULT_CHARS), is_error: failed || (code !== null && code !== 0) };
		}
		case 'mcpToolCall': {
			const err = isObj(item.error) ? str(item.error.message) : str(item.error);
			const result = item.result === undefined || item.result === null ? '' : typeof item.result === 'string' ? item.result : JSON.stringify(item.result);
			return { content: truncate(err ?? result, MAX_TOOL_RESULT_CHARS), is_error: failed || !!err };
		}
		default:
			return { content: status, is_error: failed };
	}
}
