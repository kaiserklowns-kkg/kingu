// JSON-RPC 2.0 over an already-framed message stream (Rust does the Content-Length framing).

import { ErrorCodes } from './protocol';
import type { TraceEvent } from './trace.ts';

export class ResponseError extends Error {
	readonly code: number;
	readonly data?: unknown;
	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.code = code;
		this.data = data;
	}
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; method: string; at: number };
type RequestHandler = (params: any) => unknown | Promise<unknown>;
type NotificationHandler = (params: any) => void;

/** Something that can be cancelled, like Monaco's CancellationToken. */
export type Cancellation = { isCancellationRequested: boolean; onCancellationRequested: (cb: () => void) => unknown };

export class JsonRpc {
	#nextId = 1;
	#pending = new Map<number, Pending>();
	#requests = new Map<string, RequestHandler>();
	#notifications = new Map<string, NotificationHandler>();
	#closed: Error | null = null;

	readonly #write: (json: string) => void;
	/** `<language>.trace.server`: every message in and out, when set (lsp/trace.ts formats them). */
	tracer: ((ev: TraceEvent) => void) | null = null;

	constructor(write: (json: string) => void) {
		this.#write = write;
	}

	request<T>(method: string, params?: unknown, token?: Cancellation): Promise<T> {
		if (this.#closed) return Promise.reject(this.#closed);
		const id = this.#nextId++;
		return new Promise<T>((resolve, reject) => {
			this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method, at: Date.now() });
			this.tracer?.({ kind: 'sendRequest', method, id, params });
			this.#send({ jsonrpc: '2.0', id, method, params });
			token?.onCancellationRequested(() => {
				if (this.#pending.has(id)) this.notify('$/cancelRequest', { id });
			});
		});
	}

	notify(method: string, params?: unknown) {
		if (this.#closed) return;
		this.tracer?.({ kind: 'sendNotification', method, params });
		this.#send({ jsonrpc: '2.0', method, params });
	}

	onRequest(method: string, handler: RequestHandler) {
		this.#requests.set(method, handler);
	}

	onNotification(method: string, handler: NotificationHandler) {
		this.#notifications.set(method, handler);
	}

	get pendingCount() {
		return this.#pending.size;
	}

	/** Feeds one message from the server. */
	handle(json: string) {
		let msg: any;
		try {
			msg = JSON.parse(json);
		} catch {
			return;
		}
		if (msg === null || typeof msg !== 'object') return;
		if ('method' in msg && 'id' in msg) void this.#answer(msg);
		else if ('method' in msg) {
			this.tracer?.({ kind: 'receiveNotification', method: msg.method, params: msg.params });
			this.#notifications.get(msg.method)?.(msg.params);
		} else if ('id' in msg) {
			const p = this.#pending.get(msg.id);
			if (!p) return;
			this.#pending.delete(msg.id);
			this.tracer?.({ kind: 'receiveResponse', method: p.method, id: msg.id, ms: Date.now() - p.at, result: msg.result, error: msg.error });
			if (msg.error) p.reject(new ResponseError(msg.error.code, msg.error.message, msg.error.data));
			else p.resolve(msg.result ?? null);
		}
	}

	/** The server is gone: fail everything in flight. */
	close(reason: string) {
		this.#closed = new Error(reason);
		for (const p of this.#pending.values()) p.reject(this.#closed);
		this.#pending.clear();
	}

	async #answer(msg: { id: number | string; method: string; params?: unknown }) {
		const at = Date.now();
		this.tracer?.({ kind: 'receiveRequest', method: msg.method, id: msg.id, params: msg.params });
		const fail = (error: { code: number; message: string }) => {
			this.tracer?.({ kind: 'sendResponse', method: msg.method, id: msg.id, ms: Date.now() - at, error });
			this.#send({ jsonrpc: '2.0', id: msg.id, error });
		};
		const handler = this.#requests.get(msg.method);
		if (!handler) return fail({ code: ErrorCodes.MethodNotFound, message: `Unhandled method ${msg.method}` });
		try {
			const result = (await handler(msg.params)) ?? null;
			this.tracer?.({ kind: 'sendResponse', method: msg.method, id: msg.id, ms: Date.now() - at, result });
			this.#send({ jsonrpc: '2.0', id: msg.id, result });
		} catch (e) {
			fail({ code: -32603, message: String(e) });
		}
	}

	#send(msg: object) {
		this.#write(JSON.stringify(msg));
	}
}
