// `<language>.trace.server` (VS Code: vscode-languageclient's Tracer): every JSON-RPC message
// between Kingu and a language server, written to the server's Output channel in the client's
// format (`[Trace - 10:21:33 AM] Sending request 'textDocument/hover - (12)'.`), with the params
// and results too when `verbose`. Pure, apart from the clock passed in.

export type TraceValue = 'off' | 'messages' | 'verbose';

export const traceValue = (v: unknown): TraceValue => (v === 'messages' || v === 'verbose' ? v : 'off');

/** The trace setting of each server Kingu runs, where its VS Code extension has one. */
export const TRACE_SETTINGS: Readonly<Record<string, string>> = {
	rust: 'rust-analyzer.trace.server',
	svelte: 'svelte.trace.server',
	json: 'json.trace.server',
	css: 'css.trace.server',
	html: 'html.trace.server',
	yaml: 'yaml.trace.server'
};

export type TraceEvent =
	| { kind: 'sendRequest' | 'receiveRequest'; method: string; id: number | string; params?: unknown }
	| { kind: 'sendNotification' | 'receiveNotification'; method: string; params?: unknown }
	| { kind: 'receiveResponse' | 'sendResponse'; method: string; id: number | string; ms: number; result?: unknown; error?: { code: number; message: string } };

const json = (v: unknown) => JSON.stringify(v ?? null, null, 4);

/** `10:21:33 AM`, like the client's `new Date().toLocaleTimeString()` in an en-US VS Code. */
export const traceTime = (d: Date) => d.toLocaleTimeString('en-US');

/** The lines of one traced message (an empty line after it, like the client). */
export function formatTrace(ev: TraceEvent, verbose: boolean, at: Date): string[] {
	const head = `[Trace - ${traceTime(at)}] `;
	let title: string;
	let body: string | null = null;
	switch (ev.kind) {
		case 'sendRequest':
			title = `Sending request '${ev.method} - (${ev.id})'.`;
			if (verbose) body = ev.params === undefined ? 'No parameters provided.' : `Params: ${json(ev.params)}`;
			break;
		case 'receiveRequest':
			title = `Received request '${ev.method} - (${ev.id})'.`;
			if (verbose) body = ev.params === undefined ? 'No parameters provided.' : `Params: ${json(ev.params)}`;
			break;
		case 'sendNotification':
			title = `Sending notification '${ev.method}'.`;
			if (verbose) body = ev.params === undefined ? 'No parameters provided.' : `Params: ${json(ev.params)}`;
			break;
		case 'receiveNotification':
			title = `Received notification '${ev.method}'.`;
			if (verbose) body = ev.params === undefined ? 'No parameters provided.' : `Params: ${json(ev.params)}`;
			break;
		case 'receiveResponse':
			title = ev.error
				? `Received response '${ev.method} - (${ev.id})' in ${ev.ms}ms. Request failed: ${ev.error.message} (${ev.error.code}).`
				: `Received response '${ev.method} - (${ev.id})' in ${ev.ms}ms.`;
			if (verbose && !ev.error) body = ev.result === undefined || ev.result === null ? 'No result returned.' : `Result: ${json(ev.result)}`;
			break;
		case 'sendResponse':
			title = ev.error
				? `Sending response '${ev.method} - (${ev.id})'. Processing request failed after ${ev.ms}ms: ${ev.error.message} (${ev.error.code}).`
				: `Sending response '${ev.method} - (${ev.id})'. Processing request took ${ev.ms}ms`;
			if (verbose && !ev.error) body = ev.result === undefined || ev.result === null ? 'No result returned.' : `Result: ${json(ev.result)}`;
			break;
	}
	return [head + title, ...(body === null ? [] : body.split('\n')), ''];
}
