// Arkai's conversation, independent of the provider's wire format: user messages, the model's
// answers with their tool calls, and tool results. openai.ts and anthropic.ts turn it into their
// API's messages; history.ts rebuilds it from a chat's transcript.

import type { ImageBlock } from '../host.ts';

/** A tool call as the model made it: `arguments` is JSON text (it may be malformed: coach.ts). */
export type ToolCall = { id: string; name: string; arguments: string };

/**
 * An Anthropic thinking block as the model sent it (its `signature`, or a redacted one's `data`):
 * sent back with the answer it came with while thinking is on (anthropic.ts).
 */
export type ThinkingBlock = { type: 'thinking'; thinking: string; signature: string } | { type: 'redacted_thinking'; data: string };

export type Msg =
	| { role: 'user'; text: string; images?: ImageBlock[] }
	| { role: 'assistant'; text: string; calls: ToolCall[]; thinking?: ThinkingBlock[] }
	| { role: 'tool'; id: string; name: string; content: string; isError: boolean };

/** A tool offered to the model: JSON-schema parameters. */
export type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };

export type TokenUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type CompletionRequest = {
	model: string;
	system: string;
	messages: Msg[];
	tools: ToolDef[];
	maxTokens: number;
	/** The provider's reasoning fields for the chat's effort (../effort.ts `arkaiReasoning`), merged into the body. */
	extra?: Record<string, unknown>;
	/** Thinking is on (Anthropic): earlier thinking blocks go back with their answers. */
	keepThinking?: boolean;
	signal: AbortSignal;
	onText: (text: string) => void;
	onThinking: (text: string) => void;
};

export type Completion = {
	text: string;
	calls: ToolCall[];
	/** `length`: the answer was cut at `maxTokens`. */
	stop: 'stop' | 'tool_calls' | 'length';
	usage: TokenUsage | null;
	/** Anthropic's thinking blocks of this answer, in order. */
	thinking?: ThinkingBlock[];
};

/** One provider's API. */
export type ChatClient = { complete(req: CompletionRequest): Promise<Completion> };

/** An HTTP error from the provider: `status`, and a short excerpt of its body (never the request). */
export class ProviderError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}

	/** The request was too large for the model's context window. */
	get contextOverflow() {
		return this.status === 400 || this.status === 413 ? /context|too long|too many tokens|maximum.*tokens|prompt is too long|reduce the length/i.test(this.message) : false;
	}

	/** Worth asking again after a pause (rate limit, overloaded, a server error). */
	get retryable() {
		return this.status === 408 || this.status === 429 || this.status >= 500;
	}
}

/** At most this much of an error body is kept. */
const MAX_ERROR = 600;

export async function providerError(res: Response, provider: string): Promise<ProviderError> {
	let body = '';
	try {
		body = (await res.text()).slice(0, 4000);
	} catch {
		// No body.
	}
	let detail = body;
	try {
		const j = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
		detail = typeof j.error === 'string' ? j.error : typeof j.error?.message === 'string' ? j.error.message : typeof j.message === 'string' ? j.message : body;
	} catch {
		// Not JSON: the text itself.
	}
	detail = detail.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR);
	return new ProviderError(res.status, `${provider}: HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
}

/** The `data:` payloads of a server-sent event stream, as they arrive (`event:` names alongside). */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string | null; data: string }> {
	const decoder = new TextDecoder();
	let buf = '';
	let event: string | null = null;
	let data: string[] = [];
	const reader = body.getReader();
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, nl).replace(/\r$/, '');
				buf = buf.slice(nl + 1);
				if (line === '') {
					if (data.length) yield { event, data: data.join('\n') };
					event = null;
					data = [];
				} else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
				else if (line.startsWith('event:')) event = line.slice(6).trim();
				// `id:`, `retry:` and `:` comments are not used.
			}
		}
		buf += decoder.decode();
		if (buf.startsWith('data:')) data.push(buf.slice(5).replace(/^ /, ''));
		if (data.length) yield { event, data: data.join('\n') };
	} finally {
		reader.releaseLock();
	}
}

/**
 * Splits `<think>…</think>` out of streamed text (Qwen3, DeepSeek-R1 and others served without a
 * reasoning parser write their thinking into the answer). Tags may be cut across chunks.
 */
export class ThinkSplitter {
	private inThink = false;
	private held = '';
	private started = false;

	constructor(
		private onText: (t: string) => void,
		private onThinking: (t: string) => void
	) {}

	push(chunk: string) {
		let s = this.held + chunk;
		this.held = '';
		while (s) {
			const tag = this.inThink ? '</think>' : '<think>';
			const at = s.indexOf(tag);
			if (at >= 0) {
				this.out(s.slice(0, at));
				s = s.slice(at + tag.length);
				this.inThink = !this.inThink;
				continue;
			}
			// Keep a tail that may be the start of a tag.
			let keep = 0;
			for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) {
				if (tag.startsWith(s.slice(-k))) {
					keep = k;
					break;
				}
			}
			this.out(s.slice(0, s.length - keep));
			this.held = s.slice(s.length - keep);
			s = '';
		}
	}

	end() {
		if (this.held) this.out(this.held);
		this.held = '';
	}

	private out(t: string) {
		if (!t) return;
		if (this.inThink) this.onThinking(t);
		else {
			// The answer after a thinking block starts on its own.
			const text = this.started ? t : t.replace(/^\s+/, '');
			if (!text) return;
			this.started = true;
			this.onText(text);
		}
	}
}
