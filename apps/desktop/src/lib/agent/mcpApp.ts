// An MCP App in the chat (SEP-1865, the ext-apps postMessage bridge), the host's side of one app
// frame, as VS Code's ChatMcpAppModel does it (src/vs/workbench/contrib/chat/browser/widget/
// chatContentParts/toolInvocationParts/chatMcpAppModel.ts, `_handleWebviewMessage`):
//
//   app → host   ui/initialize (answered with VS Code's capabilities and host context; then
//                ui/notifications/tool-input, and tool-result once the call returned),
//                ui/notifications/initialized, notifications/tools/list_changed (the app's
//                tools listed again), tools/call, resources/read, sampling/createMessage (to the
//                server, through the chat's run: arkai/mcpApps.ts), ping, ui/open-link (http(s)
//                only), ui/message (into an empty composer), ui/notifications/size-changed,
//                ui/notifications/sandbox-wheel, notifications/message (dropped), and
//                ui/update-model-context, ui/download-file and ui/request-display-mode (see below)
//   host → app   tools/list and tools/call for the tools the app registered, notifications/cancelled
//
// Kingu differs where it has no counterpart: an app stays inline (`availableDisplayModes`:
// inline; VS Code also opens it in an editor), and `ui/download-file` and
// `ui/update-model-context` are not offered (VS Code adds files or context chips to its input).
// Pure apart from what `HostDeps` does, so `bun test` covers it.

export const LATEST_PROTOCOL_VERSION = '2026-01-26';
/** VS Code's app frame height: 300 px at first, at least 100, at most 75% of the window. */
export const INITIAL_HEIGHT = 300;
export const MIN_HEIGHT = 100;
export const MAX_HEIGHT_PCT = 0.75;
/** VS Code's limits on listing an app's tools. */
const TOOLS_PAGES = 100;
const TOOLS_TIMEOUT_MS = 30_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
type Id = string | number;

/** An app-registered tool as its `tools/list` gives it. */
export type AppTool = { name: string; description?: string; inputSchema?: Obj; title?: string; annotations?: Obj };

/** What the host does for the app (the frame component wires it up). */
export type HostDeps = {
	/** Posts a message to the app's frame. */
	post(msg: Obj): void;
	/** `tools/call`, `resources/read` or `sampling/createMessage` to the app's server (through the run). */
	serverRequest(method: 'tools/call' | 'resources/read' | 'sampling/createMessage', params: Obj): Promise<unknown>;
	/** Opens an http(s) link in the browser; false when it could not. */
	openLink(url: string): Promise<boolean>;
	/** `ui/message`: the text into the chat's input; false when the input is not empty (VS Code's rule). */
	message(text: string): boolean;
	/** The app asked for this height (px). */
	setHeight(height: number): void;
	/** A wheel the app could not scroll further: scroll the chat. */
	wheel(deltaX: number, deltaY: number): void;
	/** The tools the app provides now (none once it reloads or goes). */
	toolsChanged(tools: AppTool[]): void;
	/** Kingu's name and version (`hostInfo`). */
	hostInfo: { name: string; version: string };
};

export type HostContext = Obj;

/**
 * VS Code's style variables (mcpToolCallUI.ts `hostContext`), each from the workbench color it
 * names; `read` gives a CSS variable's current value (the frame cannot see the chat's variables).
 */
export const STYLE_VARIABLES: Record<string, string> = {
	'--color-background-primary': '--vscode-editor-background',
	'--color-background-secondary': '--vscode-sideBar-background',
	'--color-background-tertiary': '--vscode-activityBar-background',
	'--color-background-inverse': '--vscode-editor-foreground',
	'--color-background-info': '--vscode-inputValidation-infoBackground',
	'--color-background-danger': '--vscode-inputValidation-errorBackground',
	'--color-background-success': '--vscode-diffEditor-insertedTextBackground',
	'--color-background-warning': '--vscode-inputValidation-warningBackground',
	'--color-background-disabled': '--vscode-editor-inactiveSelectionBackground',
	'--color-text-primary': '--vscode-foreground',
	'--color-text-secondary': '--vscode-descriptionForeground',
	'--color-text-tertiary': '--vscode-disabledForeground',
	'--color-text-inverse': '--vscode-editor-background',
	'--color-text-info': '--vscode-textLink-foreground',
	'--color-text-danger': '--vscode-errorForeground',
	'--color-text-success': '--vscode-testing-iconPassed',
	'--color-text-warning': '--vscode-editorWarning-foreground',
	'--color-text-disabled': '--vscode-disabledForeground',
	'--color-text-ghost': '--vscode-descriptionForeground',
	'--color-border-primary': '--vscode-widget-border',
	'--color-border-secondary': '--vscode-editorWidget-border',
	'--color-border-tertiary': '--vscode-panel-border',
	'--color-border-inverse': '--vscode-foreground',
	'--color-border-info': '--vscode-inputValidation-infoBorder',
	'--color-border-danger': '--vscode-inputValidation-errorBorder',
	'--color-border-success': '--vscode-testing-iconPassed',
	'--color-border-warning': '--vscode-inputValidation-warningBorder',
	'--color-border-disabled': '--vscode-disabledForeground',
	'--color-ring-primary': '--vscode-focusBorder',
	'--color-ring-secondary': '--vscode-focusBorder',
	'--color-ring-inverse': '--vscode-focusBorder',
	'--color-ring-info': '--vscode-inputValidation-infoBorder',
	'--color-ring-danger': '--vscode-inputValidation-errorBorder',
	'--color-ring-success': '--vscode-testing-iconPassed',
	'--color-ring-warning': '--vscode-inputValidation-warningBorder',
	'--font-sans': '--vscode-font-family',
	'--font-mono': '--vscode-editor-font-family'
};
/** VS Code's fixed values (sizes, weights, radii, line heights). */
const FIXED_VARIABLES: Record<string, string> = {
	'--color-background-ghost': 'transparent',
	'--color-border-ghost': 'transparent',
	'--font-weight-normal': 'normal',
	'--font-weight-medium': '500',
	'--font-weight-semibold': '600',
	'--font-weight-bold': 'bold',
	'--font-text-xs-size': '10px',
	'--font-text-sm-size': '11px',
	'--font-text-md-size': '13px',
	'--font-text-lg-size': '14px',
	'--font-heading-xs-size': '16px',
	'--font-heading-sm-size': '18px',
	'--font-heading-md-size': '20px',
	'--font-heading-lg-size': '24px',
	'--font-heading-xl-size': '32px',
	'--font-heading-2xl-size': '40px',
	'--font-heading-3xl-size': '48px',
	'--border-radius-xs': '2px',
	'--border-radius-sm': '3px',
	'--border-radius-md': '4px',
	'--border-radius-lg': '6px',
	'--border-radius-xl': '8px',
	'--border-radius-full': '9999px',
	'--border-width-regular': '1px',
	'--font-text-xs-line-height': '1.5',
	'--font-text-sm-line-height': '1.5',
	'--font-text-md-line-height': '1.5',
	'--font-text-lg-line-height': '1.5',
	'--font-heading-xs-line-height': '1.25',
	'--font-heading-sm-line-height': '1.25',
	'--font-heading-md-line-height': '1.25',
	'--font-heading-lg-line-height': '1.25',
	'--font-heading-xl-line-height': '1.25',
	'--font-heading-2xl-line-height': '1.25',
	'--font-heading-3xl-line-height': '1.25'
};

/** The style variables with this window's values (shadows from `--vscode-widget-shadow`, as VS Code's). */
export function styleVariables(read: (cssVar: string) => string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, from] of Object.entries(STYLE_VARIABLES)) {
		const v = read(from).trim();
		if (v) out[name] = v;
	}
	Object.assign(out, FIXED_VARIABLES);
	const shadow = read('--vscode-widget-shadow').trim() || 'rgba(0, 0, 0, 0.36)';
	out['--shadow-hairline'] = `0 0 0 1px ${shadow}`;
	out['--shadow-sm'] = `0 1px 2px 0 ${shadow}`;
	out['--shadow-md'] = `0 4px 6px -1px ${shadow}`;
	out['--shadow-lg'] = `0 10px 15px -3px ${shadow}`;
	return out;
}

/** VS Code's host context for an inline app (`hostContext`), from what the chat knows now. */
export function hostContext(o: { theme: 'light' | 'dark'; variables: Record<string, string>; locale: string; width: number; maxHeight: number; toolCallId: string; toolName: string }): HostContext {
	return {
		theme: o.theme,
		styles: { variables: o.variables },
		displayMode: 'inline',
		availableDisplayModes: ['inline'],
		locale: o.locale,
		platform: 'desktop',
		deviceCapabilities: { touch: false, hover: true },
		containerDimensions: { width: Math.round(o.width), maxHeight: Math.round(o.maxHeight) },
		toolCall: { toolCallId: o.toolCallId, toolName: o.toolName }
	};
}

/** The height the frame gets for what the app asked (VS Code: at least 100, at most 75% of the window). */
export const clampHeight = (asked: number, windowHeight: number) => Math.max(MIN_HEIGHT, Math.min(Math.round(asked), Math.round(windowHeight * MAX_HEIGHT_PCT)));

/** Only http and https links leave the app (VS Code's `_handleOpenLink`). */
export function openableLink(url: unknown): string | null {
	if (typeof url !== 'string') return null;
	try {
		const u = new URL(url);
		return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
	} catch {
		return null;
	}
}

class Cancelled extends Error {
	constructor() {
		super('Canceled');
	}
}

/** One app instance's host: the frame's messages in, answers and notifications out. */
export class McpAppHost {
	/** ui/initialize was answered (notifications may go out). */
	private announced = false;
	/** ui/notifications/initialized came after that. */
	private initialized = false;
	private providesTools = false;
	private toolsGeneration = 0;
	private nextId = 0;
	private pending = new Map<Id, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private inputSent = false;
	private result: Obj | null = null;
	private resultSent = false;
	private timers = new Set<ReturnType<typeof setTimeout>>();
	private disposed = false;
	/** The app's title (`appInfo`), once it initialized. */
	title: string | null = null;
	tools: AppTool[] = [];

	constructor(
		private deps: HostDeps,
		private o: { input: Obj; csp: unknown; context: () => HostContext }
	) {}

	/** The tool's result arrived (VS Code: on completion); sent at once if the app already has the input. */
	setResult(result: Obj | null | undefined) {
		if (!isObj(result)) return;
		this.result = result;
		if (this.inputSent) this.sendResult();
	}

	/** The chat's theme, size or language changed. */
	contextChanged() {
		if (this.announced) this.notify('ui/notifications/host-context-changed', this.o.context());
	}

	/** A message from the app's frame (the caller checked it came from that frame). */
	async handle(message: unknown): Promise<void> {
		if (this.disposed || !isObj(message)) return;
		if (typeof message.method !== 'string') {
			const id = message.id as Id | undefined;
			const p = id === undefined ? undefined : this.pending.get(id);
			if (!p) return;
			this.pending.delete(id!);
			if (isObj(message.error)) p.reject(new Error(String(message.error.message ?? 'error')));
			else p.resolve(message.result);
			return;
		}
		const { method } = message;
		const params = isObj(message.params) ? message.params : {};
		const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined;
		try {
			let result: unknown = {};
			switch (method) {
				case 'ui/initialize':
					this.reset();
					result = this.initialize(params);
					break;
				case 'tools/call':
					if (typeof params.name !== 'string' || !params.name) throw new Error('Missing tool name in tools/call request');
					result = await this.deps.serverRequest('tools/call', params);
					break;
				case 'resources/read':
					if (typeof params.uri !== 'string' || !params.uri) throw new Error('Missing uri in resources/read request');
					result = await this.deps.serverRequest('resources/read', params);
					break;
				case 'sampling/createMessage':
					result = await this.deps.serverRequest('sampling/createMessage', params);
					break;
				case 'ping':
					break;
				case 'ui/notifications/size-changed':
					if (typeof params.height === 'number' && Number.isFinite(params.height)) this.deps.setHeight(params.height);
					break;
				case 'ui/open-link': {
					const url = openableLink(params.url);
					result = { isError: !url || !(await this.deps.openLink(url)) };
					break;
				}
				case 'ui/message': {
					const text = (Array.isArray(params.content) ? params.content : [])
						.filter((c): c is Obj => isObj(c) && c.type === 'text' && typeof c.text === 'string')
						.map((c) => c.text as string)
						.join('\n\n');
					result = { isError: !text.trim() || !this.deps.message(text) };
					break;
				}
				case 'ui/request-display-mode':
					result = { mode: 'inline' };
					break;
				case 'ui/download-file':
				case 'ui/update-model-context':
					// Not offered at ui/initialize (see the file comment).
					result = { isError: true };
					break;
				case 'ui/notifications/initialized':
					this.initialized = this.announced;
					await this.refreshTools();
					break;
				case 'notifications/tools/list_changed':
					await this.refreshTools();
					break;
				case 'notifications/message':
					// The app's log line: not kept (it may hold anything).
					break;
				case 'ui/notifications/sandbox-wheel':
					if (typeof params.deltaY === 'number') this.deps.wheel(Number(params.deltaX) || 0, params.deltaY);
					break;
				default:
					if (id !== undefined) this.deps.post({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
					return;
			}
			if (id !== undefined && !this.disposed) this.deps.post({ jsonrpc: '2.0', id, result: result ?? {} });
		} catch (e) {
			if (id !== undefined && !this.disposed) this.deps.post({ jsonrpc: '2.0', id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } });
		}
	}

	private initialize(params: Obj) {
		const appInfo = isObj(params.appInfo) ? params.appInfo : {};
		const caps = isObj(params.appCapabilities) ? params.appCapabilities : {};
		this.title = typeof appInfo.title === 'string' ? appInfo.title : typeof appInfo.name === 'string' ? appInfo.name : null;
		this.announced = true;
		this.providesTools = caps.tools !== undefined;
		// "Host MUST send this notification with the complete tool arguments after the Guest UI's initialize request completes."
		this.later(() => {
			this.inputSent = true;
			this.notify('ui/notifications/tool-input', { arguments: this.o.input });
			if (this.result) this.sendResult();
		});
		return {
			protocolVersion: LATEST_PROTOCOL_VERSION,
			hostInfo: this.deps.hostInfo,
			hostCapabilities: {
				openLinks: {},
				serverTools: {},
				serverResources: {},
				logging: {},
				sandbox: { ...(isObj(this.o.csp) ? { csp: this.o.csp } : {}), permissions: { clipboardWrite: {} } }
			},
			hostContext: this.o.context()
		};
	}

	private sendResult() {
		if (this.resultSent || !this.result) return;
		this.resultSent = true;
		this.notify('ui/notifications/tool-result', this.result);
	}

	private notify(method: string, params: unknown) {
		if (!this.disposed) this.deps.post({ jsonrpc: '2.0', method, params });
	}

	private later(fn: () => void) {
		const t = setTimeout(() => {
			this.timers.delete(t);
			if (!this.disposed) fn();
		}, 0);
		this.timers.add(t);
	}

	/** A request to the app (`tools/list`, `tools/call`); `signal` cancels it with `notifications/cancelled`. */
	private request(method: 'tools/list' | 'tools/call', params: Obj, signal?: AbortSignal, timeoutMs = 0): Promise<unknown> {
		if (this.disposed || signal?.aborted) return Promise.reject(new Cancelled());
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | null = null;
			const cleanup = () => {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				this.pending.delete(id);
			};
			const onAbort = () => {
				if (!this.pending.has(id)) return;
				cleanup();
				this.notify('notifications/cancelled', { requestId: id, reason: 'MCP App tool call cancelled' });
				reject(new Cancelled());
			};
			this.pending.set(id, {
				resolve: (v) => (cleanup(), resolve(v)),
				reject: (e) => (cleanup(), reject(e))
			});
			signal?.addEventListener('abort', onAbort, { once: true });
			if (timeoutMs) timer = setTimeout(onAbort, timeoutMs);
			this.deps.post({ jsonrpc: '2.0', id, method, params });
		});
	}

	/** Calls a tool the app registered (the model's call, through the run). */
	async callTool(name: string, args: Obj, signal?: AbortSignal): Promise<Obj> {
		if (!this.initialized || !this.providesTools) throw new Error('The MCP App is not initialized or does not provide tools.');
		const r = await this.request('tools/call', { name, arguments: args }, signal);
		if (!isObj(r)) throw new Error('The MCP App returned no result.');
		return r;
	}

	/** Every page of the app's tools; a newer listing wins (VS Code's `_refreshTools`). */
	private async refreshTools() {
		if (!this.initialized || !this.providesTools || this.disposed) return;
		const generation = ++this.toolsGeneration;
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), TOOLS_TIMEOUT_MS);
		const tools: AppTool[] = [];
		let cursor: string | undefined;
		try {
			for (let page = 0; page < TOOLS_PAGES; page++) {
				const r = await this.request('tools/list', cursor === undefined ? {} : { cursor }, ctrl.signal);
				if (generation !== this.toolsGeneration) return;
				for (const t of isObj(r) && Array.isArray(r.tools) ? r.tools : []) if (isObj(t) && typeof t.name === 'string') tools.push(t as AppTool);
				cursor = isObj(r) && typeof r.nextCursor === 'string' ? r.nextCursor : undefined;
				if (cursor === undefined) {
					this.tools = tools;
					this.deps.toolsChanged(tools);
					return;
				}
			}
		} catch {
			// A failed listing leaves the tools as they were (VS Code logs it).
		} finally {
			clearTimeout(timer);
		}
	}

	/** A new app instance (it loaded again): earlier requests and tools are void (VS Code's `_resetApp`). */
	private reset() {
		for (const t of this.timers) clearTimeout(t);
		this.timers.clear();
		this.announced = false;
		this.initialized = false;
		this.providesTools = false;
		this.toolsGeneration++;
		this.inputSent = false;
		this.resultSent = false;
		this.title = null;
		for (const p of [...this.pending.values()]) p.reject(new Cancelled());
		this.pending.clear();
		if (this.tools.length) {
			this.tools = [];
			this.deps.toolsChanged([]);
		}
	}

	dispose() {
		if (this.disposed) return;
		this.reset();
		this.disposed = true;
	}
}
