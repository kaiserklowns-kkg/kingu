// A launch configuration's `serverReadyAction` (VS Code's built-in debug-server-ready extension):
// when the program prints a line matching `pattern`, a URI is made from what it captured and is
// opened in the browser, debugged with Chrome or Edge, or another configuration is started. Pure:
// the matching and the URI are unit-tested; debug.svelte.ts watches each session's output.

export type ServerReadyActionKind = 'openExternally' | 'debugWithChrome' | 'debugWithEdge' | 'startDebugging';
export type ServerReadyAction = {
	action: ServerReadyActionKind;
	pattern: string;
	uriFormat?: string;
	webRoot?: string;
	name?: string;
	config?: Record<string, unknown>;
	killOnServerStop: boolean;
};

/** VS Code's defaults: "listening on port 3000" or "Now listening on: https://localhost:5001". */
export const DEFAULT_PATTERN = 'listening on.* (https?://\\S+|[0-9]+)';
const URI_PORT_FORMAT = 'http://localhost:%s';
const URI_FORMAT = '%s';

const ACTIONS: readonly string[] = ['openExternally', 'debugWithChrome', 'debugWithEdge', 'startDebugging'];

/** The configuration's `serverReadyAction`, or null when it has none (or it is not an object). */
export function parseServerReadyAction(raw: unknown): ServerReadyAction | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
	const action = typeof r.action === 'string' && ACTIONS.includes(r.action) ? (r.action as ServerReadyActionKind) : 'openExternally';
	return {
		action,
		pattern: str(r.pattern) ?? DEFAULT_PATTERN,
		uriFormat: str(r.uriFormat),
		webRoot: str(r.webRoot),
		name: str(r.name),
		config: r.config && typeof r.config === 'object' && !Array.isArray(r.config) ? (r.config as Record<string, unknown>) : undefined,
		killOnServerStop: r.killOnServerStop === true
	};
}

/** Terminal control sequences (colors, titles) are taken out before matching, like VS Code. */
// eslint-disable-next-line no-control-regex
const CONTROL = /(?:\x1b\[|\x9b)[=?>!]?[\d;:]*["$#'* ]?[a-zA-Z@^`{}|~]|(?:\x1b\]|\x9d).*?(?:\x1b\\|\x07|\x9c)|\x1b(?:[ #%()*+\-./]?[a-zA-Z0-9|}~@])/g;
export const stripAnsi = (s: string) => s.replace(CONTROL, '');

/** The pattern as a case-insensitive RegExp (VS Code's flags); null when it does not compile. */
export function serverReadyRegExp(action: ServerReadyAction): RegExp | null {
	try {
		return new RegExp(action.pattern, 'i');
	} catch {
		return null;
	}
}

export type ServerReadyMatch = { ok: true; uri: string } | { ok: false; error: 'noCapture' | 'placeholders'; format: string };

/**
 * The URI for a matched line (VS Code's openExternalWithString): the first capture group in
 * `uriFormat`'s `%s`; a bare port number defaults to `http://localhost:%s`, anything else to `%s`.
 * Null when the line does not match.
 */
export function serverReadyUri(action: ServerReadyAction, re: RegExp, text: string): ServerReadyMatch | null {
	const m = re.exec(stripAnsi(text));
	if (!m) return null;
	const capture = m.length > 1 ? (m[1] ?? '') : '';
	if (capture === '') {
		const format = action.uriFormat ?? '';
		if (format.includes('%s')) return { ok: false, error: 'noCapture', format };
		return { ok: true, uri: format };
	}
	const format = action.uriFormat ?? (/^[0-9]+$/.test(capture) ? URI_PORT_FORMAT : URI_FORMAT);
	if (format.split('%s').length !== 2) return { ok: false, error: 'placeholders', format };
	return { ok: true, uri: format.replace('%s', capture) };
}

/** The browser debug configuration for debugWithChrome / debugWithEdge (VS Code's "Browser Debug"). */
export function browserConfig(action: ServerReadyAction, uri: string): Record<string, unknown> & { type: string; request: string; name: string } {
	return { type: action.action === 'debugWithEdge' ? 'pwa-msedge' : 'pwa-chrome', name: 'Browser Debug', request: 'launch', url: uri, webRoot: action.webRoot ?? '${workspaceFolder}' };
}

/**
 * Watches one session's output (and its integrated terminal's): fires once, at the first match,
 * like VS Code's trigger (a child session shares its parent's trigger). Lines split across
 * output chunks are joined up to the next newline.
 */
export class ServerReadyDetector {
	fired = false;
	#re: RegExp | null;
	#pending = '';
	constructor(
		readonly action: ServerReadyAction,
		private readonly onMatch: (m: ServerReadyMatch) => void
	) {
		this.#re = serverReadyRegExp(action);
	}

	feed(chunk: string): boolean {
		if (this.fired || !this.#re) return false;
		// Whole lines only: a port printed in two chunks ("listening on 30", "00") must not match early.
		const lines = (this.#pending + chunk).split('\n');
		this.#pending = (lines.pop() ?? '').slice(-4096);
		for (const line of lines) {
			const m = serverReadyUri(this.action, this.#re, line);
			if (m) {
				this.fired = true;
				this.onMatch(m);
				return true;
			}
		}
		return false;
	}
}
