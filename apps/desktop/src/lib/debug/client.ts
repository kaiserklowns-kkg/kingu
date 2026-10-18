// DAP message layer over an already-framed stream (Rust does the Content-Length framing):
// requests with `seq`/`request_seq` matching, events, and reverse requests (runInTerminal).

import type { Event, ProtocolMessage, Request } from './protocol.ts';

export class DapError extends Error {
	readonly command: string;
	constructor(command: string, message: string) {
		super(message);
		this.command = command;
	}
}

type Pending = { resolve: (body: any) => void; reject: (e: unknown) => void; command: string };
type ReverseHandler = (args: any) => unknown | Promise<unknown>;

export class DapClient {
	#seq = 1;
	#pending = new Map<number, Pending>();
	#reverse = new Map<string, ReverseHandler>();
	#closed: Error | null = null;
	readonly #write: (json: string) => void;
	onEvent: (event: Event) => void = () => {};

	constructor(write: (json: string) => void) {
		this.#write = write;
	}

	/** The response body; rejects with the adapter's message when `success` is false. */
	request<T = any>(command: string, args?: unknown): Promise<T> {
		if (this.#closed) return Promise.reject(this.#closed);
		const seq = this.#seq++;
		return new Promise<T>((resolve, reject) => {
			this.#pending.set(seq, { resolve, reject, command });
			this.#send({ seq, type: 'request', command, arguments: args });
		});
	}

	onReverseRequest(command: string, handler: ReverseHandler) {
		this.#reverse.set(command, handler);
	}

	get pendingCount() {
		return this.#pending.size;
	}

	handle(json: string) {
		let msg: ProtocolMessage;
		try {
			msg = JSON.parse(json);
		} catch {
			return;
		}
		if (!msg || typeof msg !== 'object') return;
		if (msg.type === 'response') {
			const p = this.#pending.get(msg.request_seq);
			if (!p) return;
			this.#pending.delete(msg.request_seq);
			if (msg.success) p.resolve(msg.body ?? {});
			else p.reject(new DapError(msg.command, msg.body?.error?.format ?? msg.message ?? `${msg.command} failed`));
		} else if (msg.type === 'event') this.onEvent(msg);
		else if (msg.type === 'request') void this.#answer(msg);
	}

	/** The adapter is gone: fail everything in flight. */
	close(reason: string) {
		this.#closed = new Error(reason);
		for (const p of this.#pending.values()) p.reject(this.#closed);
		this.#pending.clear();
	}

	async #answer(req: Request) {
		const reply = (success: boolean, body?: unknown, message?: string) =>
			this.#send({ seq: this.#seq++, type: 'response', request_seq: req.seq, command: req.command, success, body, message });
		const handler = this.#reverse.get(req.command);
		if (!handler) return reply(false, undefined, `Kingu ไม่รองรับ ${req.command}`);
		try {
			reply(true, (await handler(req.arguments)) ?? {});
		} catch (e) {
			reply(false, undefined, e instanceof Error ? e.message : String(e));
		}
	}

	#send(msg: ProtocolMessage) {
		if (!this.#closed) this.#write(JSON.stringify(msg));
	}
}
