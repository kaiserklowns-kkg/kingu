// JSON-RPC 2.0 over an already-framed message stream (Rust does the Content-Length framing).

import { ErrorCodes } from './protocol';

export class ResponseError extends Error {
	readonly code: number;
	readonly data?: unknown;
	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.code = code;
		this.data = data;
	}
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; method: string };
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

	constructor(write: (json: string) => void) {
		this.#write = write;
	}

	request<T>(method: string, params?: unknown, token?: Cancellation): Promise<T> {
		if (this.#closed) return Promise.reject(this.#closed);
		const id = this.#nextId++;
		return new Promise<T>((resolve, reject) => {
			this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
			this.#send({ jsonrpc: '2.0', id, method, params });
			token?.onCancellationRequested(() => {
				if (this.#pending.has(id)) this.notify('$/cancelRequest', { id });
			});
		});
	}

	notify(method: string, params?: unknown) {
		if (!this.#closed) this.#send({ jsonrpc: '2.0', method, params });
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
		else if ('method' in msg) this.#notifications.get(msg.method)?.(msg.params);
		else if ('id' in msg) {
			const p = this.#pending.get(msg.id);
			if (!p) return;
			this.#pending.delete(msg.id);
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
		const handler = this.#requests.get(msg.method);
		if (!handler) {
			this.#send({ jsonrpc: '2.0', id: msg.id, error: { code: ErrorCodes.MethodNotFound, message: `Unhandled method ${msg.method}` } });
			return;
		}
		try {
			const result = await handler(msg.params);
			this.#send({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
		} catch (e) {
			this.#send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e) } });
		}
	}

	#send(msg: object) {
		this.#write(JSON.stringify(msg));
	}
}
