// A JSON-RPC 2.0 peer over a child process's stdio, one message per line: what ACP agents and
// `codex app-server` both speak. Either side sends requests; the agent's requests (permission
// prompts) go to `onRequest`, its notifications (session updates) to `onNotification`.
//
// Never log message contents: they hold prompts, file contents and tool inputs.

export type RpcFailure = { code: number; message: string; data?: unknown };

export class RpcCallError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: unknown
	) {
		super(message);
	}
}

/** Where the peer writes (a child's stdin) and reads (its stdout). */
export type Pipes = {
	write(line: string): void;
	lines: AsyncIterable<string>;
};

type Waiter = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null };

export type PeerOptions = {
	/** `codex app-server` leaves the `"jsonrpc": "2.0"` member out; ACP keeps it. */
	header?: boolean;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
	onNotification?: (method: string, params: unknown) => void;
	/** A line that is not JSON-RPC (some agents print banners on stdout). */
	onJunk?: (line: string) => void;
};

export class JsonRpcPeer {
	private next = 0;
	private waiting = new Map<number, Waiter>();
	closed = false;
	/** Resolves when the agent's stdout ends. */
	readonly ended: Promise<void>;

	constructor(
		private pipes: Pipes,
		private opts: PeerOptions = {}
	) {
		this.ended = this.read();
	}

	private send(msg: Record<string, unknown>) {
		if (this.closed) return;
		this.pipes.write(`${JSON.stringify(this.opts.header === false ? msg : { jsonrpc: '2.0', ...msg })}\n`);
	}

	/** A request; rejects with `RpcCallError` on an error answer, after `timeoutMs`, or when the peer closes. */
	request<T = unknown>(method: string, params: unknown, timeoutMs = 0): Promise<T> {
		if (this.closed) return Promise.reject(new RpcCallError(-32000, 'agent has exited'));
		const id = ++this.next;
		return new Promise<T>((resolve, reject) => {
			const timer = timeoutMs > 0 ? setTimeout(() => this.settle(id, { code: -32000, message: `${method} timed out` }), timeoutMs) : null;
			(timer as { unref?: () => void } | null)?.unref?.();
			this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
			this.send({ id, method, params });
		});
	}

	notify(method: string, params?: unknown) {
		this.send(params === undefined ? { method } : { method, params });
	}

	private settle(id: number, error: RpcFailure | null, result?: unknown) {
		const w = this.waiting.get(id);
		if (!w) return;
		this.waiting.delete(id);
		if (w.timer) clearTimeout(w.timer);
		if (error) w.reject(new RpcCallError(error.code, error.message, error.data));
		else w.resolve(result);
	}

	/** Rejects every open request (the agent is gone). */
	close(reason = 'agent has exited') {
		this.closed = true;
		for (const id of [...this.waiting.keys()]) this.settle(id, { code: -32000, message: reason });
	}

	private async read() {
		try {
			for await (const line of this.pipes.lines) this.handle(line);
		} catch {
			// The pipe broke: same as the agent exiting.
		}
		this.close();
	}

	private handle(line: string) {
		if (!line.trim()) return;
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(line);
		} catch {
			this.opts.onJunk?.(line);
			return;
		}
		if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return this.opts.onJunk?.(line);
		const method = typeof msg.method === 'string' ? msg.method : null;
		const hasId = typeof msg.id === 'number' || typeof msg.id === 'string';
		if (method && hasId) return void this.answer(msg.id as number | string, method, msg.params);
		if (method) return this.opts.onNotification?.(method, msg.params);
		if (typeof msg.id === 'number') {
			const err = msg.error as RpcFailure | undefined;
			this.settle(msg.id, err && typeof err === 'object' ? { code: Number(err.code) || -32000, message: String(err.message ?? 'error'), data: err.data } : null, msg.result);
			return;
		}
		this.opts.onJunk?.(line);
	}

	private async answer(id: number | string, method: string, params: unknown) {
		if (!this.opts.onRequest) return this.send({ id, error: { code: -32601, message: `method not found: ${method}` } });
		try {
			const result = await this.opts.onRequest(method, params);
			this.send({ id, result: result ?? null });
		} catch (e) {
			const code = e instanceof RpcCallError ? e.code : -32603;
			this.send({ id, error: { code, message: e instanceof Error ? e.message : String(e) } });
		}
	}
}

/** Splits a byte stream into lines (UTF-8, `\n`; a trailing `\r` is dropped). */
export async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
	const decoder = new TextDecoder();
	let buffered = '';
	for await (const chunk of stream) {
		buffered += decoder.decode(chunk, { stream: true });
		let nl: number;
		while ((nl = buffered.indexOf('\n')) >= 0) {
			yield buffered.slice(0, nl).replace(/\r$/, '');
			buffered = buffered.slice(nl + 1);
		}
	}
	buffered += decoder.decode();
	if (buffered) yield buffered;
}
