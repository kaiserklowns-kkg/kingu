// OpenAI-compatible chat completions, streamed (`POST {baseUrl}/chat/completions`, `stream: true`):
// OpenAI, OpenRouter, Groq, DeepSeek, Together, Mistral, LM Studio, vLLM, llama.cpp, and
// Ollama's `/v1`. Text streams as `delta.content`; thinking as `delta.reasoning_content`
// (DeepSeek, vLLM), `delta.reasoning` (Ollama, OpenRouter) or `<think>` tags in the text; tool
// calls arrive in pieces by `index` and are put together here.

import { ProviderError, providerError, sseEvents, ThinkSplitter, type ChatClient, type Completion, type CompletionRequest, type Msg, type TokenUsage, type ToolCall } from './messages.ts';
import type { ArkaiProvider } from './spec.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Our conversation as chat-completion messages. */
export function openaiMessages(system: string, messages: readonly Msg[]): Obj[] {
	const out: Obj[] = [];
	if (system) out.push({ role: 'system', content: system });
	for (const m of messages) {
		if (m.role === 'user') {
			if (m.images?.length)
				out.push({
					role: 'user',
					content: [...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.source.media_type};base64,${i.source.data}` } })), { type: 'text', text: m.text }]
				});
			else out.push({ role: 'user', content: m.text });
		} else if (m.role === 'assistant') {
			out.push({
				role: 'assistant',
				content: m.text || (m.calls.length ? null : ''),
				...(m.calls.length ? { tool_calls: m.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })) } : {})
			});
		} else out.push({ role: 'tool', tool_call_id: m.id, content: m.content || (m.isError ? 'error' : '(no output)') });
	}
	return out;
}

export function openaiUsage(u: unknown): TokenUsage | null {
	if (!isObj(u)) return null;
	const details = isObj(u.prompt_tokens_details) ? u.prompt_tokens_details : {};
	return { input: num(u.prompt_tokens), output: num(u.completion_tokens), cacheRead: num(details.cached_tokens) || num(u.prompt_cache_hit_tokens), cacheWrite: 0 };
}

type Partial = { id: string; name: string; args: string };

export class OpenAiClient implements ChatClient {
	/** The server refused `stream_options` once: not sent again. */
	private noStreamOptions = false;

	constructor(
		private provider: ArkaiProvider,
		private fetchFn: typeof fetch = fetch
	) {}

	private headers(): Record<string, string> {
		return {
			'content-type': 'application/json',
			accept: 'text/event-stream',
			...(this.provider.apiKey ? { authorization: `Bearer ${this.provider.apiKey}` } : {}),
			...this.provider.headers
		};
	}

	async complete(req: CompletionRequest): Promise<Completion> {
		const body: Obj = {
			model: req.model,
			messages: openaiMessages(req.system, req.messages),
			stream: true,
			max_tokens: req.maxTokens,
			...(req.tools.length ? { tools: req.tools.map((t) => ({ type: 'function', function: t })), tool_choice: 'auto' } : {})
		};
		const url = `${this.provider.baseUrl}/chat/completions`;
		const post = (withUsage: boolean) =>
			this.fetchFn(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(withUsage ? { ...body, stream_options: { include_usage: true } } : body), signal: req.signal });
		let res = await post(!this.noStreamOptions);
		if (res.status === 400 && !this.noStreamOptions) {
			const err = await providerError(res, this.provider.name);
			if (!/stream_options|include_usage/i.test(err.message)) throw err;
			this.noStreamOptions = true;
			res = await post(false);
		}
		if (!res.ok) throw await providerError(res, this.provider.name);
		if (!res.body) throw new ProviderError(res.status, `${this.provider.name}: empty response`);
		// A server that ignores `stream` answers with one JSON body.
		if (!(res.headers.get('content-type') ?? '').includes('event-stream')) return this.whole(await res.json().catch(() => null), req);
		return this.stream(res.body, req);
	}

	private async stream(body: ReadableStream<Uint8Array>, req: CompletionRequest): Promise<Completion> {
		let text = '';
		const split = new ThinkSplitter(
			(t) => {
				text += t;
				req.onText(t);
			},
			req.onThinking
		);
		const parts: Partial[] = [];
		let finish: string | null = null;
		let usage: TokenUsage | null = null;
		for await (const { data } of sseEvents(body)) {
			if (data === '[DONE]') break;
			let chunk: unknown;
			try {
				chunk = JSON.parse(data);
			} catch {
				continue;
			}
			if (!isObj(chunk)) continue;
			if (isObj(chunk.error)) throw new ProviderError(500, `${this.provider.name}: ${String(chunk.error.message ?? 'error').slice(0, 600)}`);
			usage = openaiUsage(chunk.usage) ?? usage;
			const choice = Array.isArray(chunk.choices) && isObj(chunk.choices[0]) ? chunk.choices[0] : null;
			if (!choice) continue;
			if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
			const delta = isObj(choice.delta) ? choice.delta : isObj(choice.message) ? choice.message : {};
			const thinking = delta.reasoning_content ?? delta.reasoning;
			if (typeof thinking === 'string' && thinking) req.onThinking(thinking);
			if (typeof delta.content === 'string' && delta.content) split.push(delta.content);
			if (Array.isArray(delta.tool_calls)) {
				for (const tc of delta.tool_calls) {
					if (!isObj(tc)) continue;
					const index = typeof tc.index === 'number' ? tc.index : indexWithout(parts, tc.id);
					const fn = isObj(tc.function) ? tc.function : {};
					const p = (parts[index] ??= { id: '', name: '', args: '' });
					if (typeof tc.id === 'string' && tc.id) p.id = tc.id;
					if (typeof fn.name === 'string') p.name += p.name && p.name === fn.name ? '' : fn.name;
					if (typeof fn.arguments === 'string') p.args += fn.arguments;
					// Some servers send the arguments as an object, whole.
					else if (isObj(fn.arguments)) p.args = JSON.stringify(fn.arguments);
				}
			}
		}
		split.end();
		const calls = toCalls(parts);
		return { text, calls, stop: calls.length ? 'tool_calls' : finish === 'length' ? 'length' : 'stop', usage };
	}

	private whole(v: unknown, req: CompletionRequest): Completion {
		const choice = isObj(v) && Array.isArray(v.choices) && isObj(v.choices[0]) ? v.choices[0] : null;
		if (!choice) throw new ProviderError(502, `${this.provider.name}: no answer in the response`);
		const msg = isObj(choice.message) ? choice.message : {};
		let text = '';
		const split = new ThinkSplitter(
			(t) => {
				text += t;
				req.onText(t);
			},
			req.onThinking
		);
		const thinking = msg.reasoning_content ?? msg.reasoning;
		if (typeof thinking === 'string' && thinking) req.onThinking(thinking);
		if (typeof msg.content === 'string') split.push(msg.content);
		split.end();
		const parts: Partial[] = (Array.isArray(msg.tool_calls) ? msg.tool_calls.filter(isObj) : []).map((tc) => {
			const fn = isObj(tc.function) ? tc.function : {};
			return { id: typeof tc.id === 'string' ? tc.id : '', name: typeof fn.name === 'string' ? fn.name : '', args: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}) };
		});
		const calls = toCalls(parts);
		return { text, calls, stop: calls.length ? 'tool_calls' : choice.finish_reason === 'length' ? 'length' : 'stop', usage: isObj(v) ? openaiUsage(v.usage) : null };
	}
}

let seq = 0;
/** An id for a call the server sent none for (Ollama sometimes does not). */
export const callId = () => `call_arkai_${Date.now().toString(36)}_${(++seq).toString(36)}`;

/** Where a piece without an `index` goes: the call with its id, a new call for a new id, else the last call. */
function indexWithout(parts: readonly (Partial | undefined)[], id: unknown): number {
	if (typeof id === 'string' && id) {
		const at = parts.findIndex((p) => p?.id === id);
		return at >= 0 ? at : parts.length;
	}
	return Math.max(0, parts.length - 1);
}

function toCalls(parts: readonly (Partial | undefined)[]): ToolCall[] {
	return parts.flatMap((p) => (p && p.name ? [{ id: p.id || callId(), name: p.name, arguments: p.args }] : []));
}
