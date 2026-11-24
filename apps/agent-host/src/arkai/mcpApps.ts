// MCP Apps in an Arkai chat (SEP-1865, the ext-apps postMessage protocol), the run's side. VS Code's
// pieces are chatMcpAppModel.ts and mcpToolCallUI.ts (the app's requests to its server) and
// agentHostMcpAppToolsService.ts (tools an app registers); the chat renders the app in a sandboxed
// frame (desktop agent/McpAppFrame.svelte, Rust mcp_app.rs). Here:
//
// - A model call of a tool whose `_meta.ui.resourceUri` is a `ui://` resource emits `mcp_app`
//   once allowed and again with the server's `CallToolResult` (`appResult`), so the chat can load
//   the app and send it `ui/notifications/tool-input` and `tool-result`.
// - The app's own requests come back as `mcp_app` host requests (`checkAppRequest`):
//   `resources/read`, `tools/call` of a tool of the same server whose visibility has `app`
//   (app-only ones too: VS Code's `McpToolVisibility.App` check), and `sampling/createMessage`.
//   Unlike VS Code, which calls the tool straight away, a call goes through the run's permission
//   rules (session.ts `gate`) like the model's would.
// - Tools an app registers (`App.registerTool()`) arrive as `mcp_app_tools`; the model is offered
//   them from its next request (`AppToolRegistry`; the app registered last wins a name, as in VS
//   Code). The model's call goes out as `mcp_app_tool_call` and comes back as `mcp_app_tool_result`
//   (`AppToolCalls`).
//
// Never log arguments, results or resource contents.

import type { AgentEvent, McpAppParams, McpAppToolResultParams } from '../protocol.ts';
import type { ToolDef } from './messages.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A `CallToolResult` larger than this (as JSON) reaches the app as `null`. */
export const MAX_APP_RESULT = 1024 * 1024;
/** Tools one app may register, and the description length the model gets. */
export const MAX_APP_TOOLS = 100;
const MAX_DESCRIPTION = 2000;
/** Function names providers take. */
export const APP_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** What an app may ask of its server through the run. */
export const APP_METHODS = ['resources/read', 'tools/call', 'sampling/createMessage'] as const;
export type AppMethod = (typeof APP_METHODS)[number];
/** An app tool call may take this long (VS Code has no limit; the turn's interrupt ends it sooner). */
export const APP_CALL_TIMEOUT_MS = 10 * 60_000;

/** The result sent to the app: the server's own, or null when it is too large to pass along. */
export function appResult(raw: Obj | null, fallback: { content: string; isError: boolean }): Obj | null {
	const r = raw ?? { content: [{ type: 'text', text: fallback.content }], isError: fallback.isError };
	try {
		return JSON.stringify(r).length <= MAX_APP_RESULT ? r : null;
	} catch {
		return null;
	}
}

/** The checked request of an app: its method and params; throws with why not. */
export function checkAppRequest(p: McpAppParams): { server: string; method: AppMethod; params: Obj } {
	if (typeof p.server !== 'string' || !p.server || p.server.length > 200) throw new Error('server is empty');
	if (!(APP_METHODS as readonly string[]).includes(p.method)) throw new Error(`Method not found: ${String(p.method)}`);
	const params = p.params ?? {};
	if (!isObj(params)) throw new Error('params must be an object');
	const method = p.method as AppMethod;
	if (method === 'resources/read' && (typeof params.uri !== 'string' || !params.uri || params.uri.length > 8192)) throw new Error('Missing uri in resources/read request');
	if (method === 'tools/call') {
		if (typeof params.name !== 'string' || !params.name) throw new Error('Missing tool name in tools/call request');
		if (params.arguments !== undefined && params.arguments !== null && !isObj(params.arguments)) throw new Error('tools/call arguments must be an object');
		if (params._meta !== undefined && !isObj(params._meta)) throw new Error('tools/call _meta must be an object');
	}
	return { server: p.server, method, params };
}

/** An app's `tools/list` entries as tools for the model: valid names only, at most MAX_APP_TOOLS. */
export function appToolDefs(tools: unknown): ToolDef[] {
	if (!Array.isArray(tools)) throw new Error('tools must be a list');
	const out: ToolDef[] = [];
	const seen = new Set<string>();
	for (const t of tools.filter(isObj)) {
		if (typeof t.name !== 'string' || !APP_TOOL_NAME.test(t.name) || seen.has(t.name)) continue;
		seen.add(t.name);
		const schema = isObj(t.inputSchema) ? t.inputSchema : {};
		const annotations = isObj(t.annotations) ? t.annotations : {};
		// VS Code: displayName is title, annotations.title or the name; the description falls back to it.
		const title = typeof t.title === 'string' ? t.title : typeof annotations.title === 'string' ? annotations.title : t.name;
		const description = typeof t.description === 'string' && t.description ? t.description : title;
		out.push({ name: t.name, description: `${description} (MCP App tool)`.slice(0, MAX_DESCRIPTION), parameters: { ...schema, type: 'object', properties: isObj(schema.properties) ? schema.properties : {} } });
		if (out.length >= MAX_APP_TOOLS) break;
	}
	return out;
}

/** The tools of the chat's live apps; the app registered last wins a name. */
export class AppToolRegistry {
	private apps = new Map<string, ToolDef[]>();

	/** Replaces app `appId`'s tools (none: the app is gone). */
	set(appId: string, defs: ToolDef[]) {
		this.apps.delete(appId);
		if (defs.length) this.apps.set(appId, defs);
	}

	private effective(): Map<string, { appId: string; def: ToolDef }> {
		const out = new Map<string, { appId: string; def: ToolDef }>();
		for (const [appId, defs] of this.apps) for (const def of defs) out.set(def.name, { appId, def });
		return out;
	}

	defs(): ToolDef[] {
		return [...this.effective().values()].map((t) => t.def);
	}

	/** The app that answers tool `name`, or null. */
	owner(name: string): string | null {
		return this.effective().get(name)?.appId ?? null;
	}

	clear() {
		this.apps.clear();
	}
}

/** An app tool call's outcome: the app's `CallToolResult`, or why there is none. */
export type AppCallResult = { result: Obj | null; error: string | null; cancelled?: boolean };

/** The model's calls of app tools waiting for the chat's answer. */
export class AppToolCalls {
	private pending = new Map<string, (r: AppCallResult) => void>();

	constructor(
		private emit: (ev: AgentEvent) => void,
		private newId: () => string
	) {}

	/** Sends the call to the chat and waits for the app's `CallToolResult` (an error result when it fails). */
	call(appId: string, name: string, args: Obj, signal: AbortSignal, timeoutMs = APP_CALL_TIMEOUT_MS): Promise<AppCallResult> {
		const requestId = this.newId();
		return new Promise((resolve) => {
			const done = (r: AppCallResult) => {
				clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
				this.pending.delete(requestId);
				resolve(r);
			};
			const onAbort = () => {
				this.emit({ kind: 'mcp_app_tool_cancel', request_id: requestId });
				done({ result: null, error: 'interrupted', cancelled: true });
			};
			const timer = setTimeout(() => {
				this.emit({ kind: 'mcp_app_tool_cancel', request_id: requestId });
				done({ result: null, error: `MCP app tool "${name}" did not answer in time.` });
			}, timeoutMs);
			(timer as { unref?: () => void }).unref?.();
			if (signal.aborted) return onAbort();
			signal.addEventListener('abort', onAbort, { once: true });
			this.pending.set(requestId, done);
			this.emit({ kind: 'mcp_app_tool_call', request_id: requestId, app_id: appId, name, arguments: args });
		});
	}

	/** The chat's answer; throws for an unknown request. */
	answer(p: McpAppToolResultParams) {
		const done = this.pending.get(p.requestId);
		if (!done) throw new Error(`no pending MCP app tool call ${String(p.requestId)}`);
		if (p.result !== undefined && p.result !== null && !isObj(p.result)) throw new Error('result must be an object');
		done({ result: isObj(p.result) ? p.result : null, error: typeof p.error === 'string' && p.error ? p.error.slice(0, 4000) : p.result ? null : 'The MCP app tool returned no result.' });
		return null;
	}

	/** Every waiting call ends (the run is over). */
	cancelAll() {
		for (const done of [...this.pending.values()]) done({ result: null, error: 'The chat has ended.', cancelled: true });
		this.pending.clear();
	}
}
