// A fake model server for Arkai's tests (Bun.serve on a free port): OpenAI-compatible
// `/v1/chat/completions` and Anthropic `/v1/messages`, answering each request with the next
// scripted reply and recording what it was asked. Never a real model.

export type OpenAiReply = {
	text?: string[];
	reasoning?: string[];
	calls?: { id?: string; name: string; args: string; pieces?: number }[];
	usage?: { prompt_tokens: number; completion_tokens: number };
	finish?: string;
	/** An HTTP error instead (`status`, body). */
	status?: number;
	body?: string;
	/** Answer with one JSON body, not a stream. */
	whole?: boolean;
};

export type Recorded = { path: string; headers: Record<string, string>; body: any };

export function openAiStream(r: OpenAiReply): string {
	const frames: unknown[] = [];
	const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'fake' };
	for (const t of r.reasoning ?? []) frames.push({ ...base, choices: [{ index: 0, delta: { reasoning_content: t }, finish_reason: null }] });
	for (const t of r.text ?? []) frames.push({ ...base, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
	(r.calls ?? []).forEach((c, index) => {
		const n = c.pieces ?? 2;
		const size = Math.ceil(c.args.length / n) || 1;
		frames.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, id: c.id ?? `call_${index}`, type: 'function', function: { name: c.name, arguments: '' } }] }, finish_reason: null }] });
		for (let i = 0; i < c.args.length; i += size) frames.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: c.args.slice(i, i + size) } }] }, finish_reason: null }] });
	});
	frames.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: r.finish ?? (r.calls?.length ? 'tool_calls' : 'stop') }] });
	if (r.usage) frames.push({ ...base, choices: [], usage: r.usage });
	return `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`;
}

function openAiWhole(r: OpenAiReply): string {
	return JSON.stringify({
		id: 'chatcmpl-1',
		object: 'chat.completion',
		choices: [
			{
				index: 0,
				message: { role: 'assistant', content: (r.text ?? []).join(''), ...(r.calls?.length ? { tool_calls: r.calls.map((c, i) => ({ id: c.id ?? `call_${i}`, type: 'function', function: { name: c.name, arguments: c.args } })) } : {}) },
				finish_reason: r.calls?.length ? 'tool_calls' : 'stop'
			}
		],
		...(r.usage ? { usage: r.usage } : {})
	});
}

/** `signature`: the thinking block's (sent as a `signature_delta`, as the API does). */
export type AnthropicReply = { text?: string[]; thinking?: string[]; signature?: string; calls?: { id: string; name: string; args: string }[]; usage?: { input: number; output: number } };

export function anthropicStream(r: AnthropicReply): string {
	const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
	let out = ev('message_start', { message: { id: 'msg_1', usage: { input_tokens: r.usage?.input ?? 10, output_tokens: 1 } } });
	let i = 0;
	if (r.thinking?.length) {
		out += ev('content_block_start', { index: i, content_block: { type: 'thinking', thinking: '' } });
		for (const t of r.thinking) out += ev('content_block_delta', { index: i, delta: { type: 'thinking_delta', thinking: t } });
		if (r.signature) out += ev('content_block_delta', { index: i, delta: { type: 'signature_delta', signature: r.signature } });
		out += ev('content_block_stop', { index: i++ });
	}
	if (r.text?.length) {
		out += ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
		for (const t of r.text) out += ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: t } });
		out += ev('content_block_stop', { index: i++ });
	}
	for (const c of r.calls ?? []) {
		out += ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } });
		const half = Math.ceil(c.args.length / 2);
		out += ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: c.args.slice(0, half) } });
		out += ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: c.args.slice(half) } });
		out += ev('content_block_stop', { index: i++ });
	}
	out += ev('message_delta', { delta: { stop_reason: r.calls?.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: r.usage?.output ?? 5 } });
	out += ev('message_stop', {});
	return out;
}

export class FakeLlm {
	readonly requests: Recorded[] = [];
	private replies: (OpenAiReply | AnthropicReply)[] = [];
	private waiters: (() => void)[] = [];
	/** Holds every reply until `release()` (a request in flight, for interrupt tests). */
	hold = false;
	private server: ReturnType<typeof Bun.serve>;

	constructor() {
		this.server = Bun.serve({
			port: 0,
			fetch: async (req) => {
				const url = new URL(req.url);
				const body = await req.json().catch(() => null);
				this.requests.push({ path: url.pathname, headers: Object.fromEntries(req.headers.entries()), body });
				while (this.hold) await new Promise<void>((r) => this.waiters.push(r));
				const reply = this.replies.shift() ?? { text: ['(no more scripted replies)'] };
				if (url.pathname.endsWith('/messages')) return new Response(anthropicStream(reply as AnthropicReply), { headers: { 'content-type': 'text/event-stream' } });
				const r = reply as OpenAiReply;
				if (r.status) return new Response(r.body ?? '', { status: r.status, headers: { 'content-type': 'application/json' } });
				if (r.whole) return new Response(openAiWhole(r), { headers: { 'content-type': 'application/json' } });
				return new Response(openAiStream(r), { headers: { 'content-type': 'text/event-stream' } });
			}
		});
	}

	get url() {
		return `http://127.0.0.1:${this.server.port}`;
	}

	reply(...r: (OpenAiReply | AnthropicReply)[]) {
		this.replies.push(...r);
		return this;
	}

	release() {
		this.hold = false;
		for (const w of this.waiters.splice(0)) w();
	}

	stop() {
		this.release();
		this.server.stop(true);
	}
}
