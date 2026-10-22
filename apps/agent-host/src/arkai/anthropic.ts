// The Anthropic Messages API, streamed (`POST {baseUrl}/v1/messages`, `stream: true`), for a
// provider with `api: "anthropic"` (Anthropic itself, or a server that speaks its API). Events:
// `message_start` (input usage), `content_block_start` / `_delta` / `_stop` (text, thinking, and
// tool_use whose input comes as `partial_json`), `message_delta` (stop reason, output usage).

import { ProviderError, providerError, sseEvents, type ChatClient, type Completion, type CompletionRequest, type Msg, type ThinkingBlock, type TokenUsage, type ToolCall } from './messages.ts';
import type { ArkaiProvider } from './spec.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const ANTHROPIC_VERSION = '2023-06-01';

/** Tool-use ids the API takes. */
const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'call';

function parseInput(args: string): Obj {
	try {
		const v: unknown = JSON.parse(args || '{}');
		return isObj(v) ? v : {};
	} catch {
		return {};
	}
}

/**
 * Our conversation as Messages API messages: tool results go in the next user message. With
 * `keepThinking` (thinking on), an answer's thinking blocks go back first, as the API wants.
 */
export function anthropicMessages(messages: readonly Msg[], keepThinking = false): Obj[] {
	const out: { role: 'user' | 'assistant'; content: Obj[] }[] = [];
	const push = (role: 'user' | 'assistant', blocks: Obj[]) => {
		const last = out[out.length - 1];
		if (last && last.role === role) last.content.push(...blocks);
		else out.push({ role, content: blocks });
	};
	for (const m of messages) {
		if (m.role === 'user') push('user', [...(m.images ?? []), { type: 'text', text: m.text || '.' }]);
		else if (m.role === 'assistant') {
			const thinking: Obj[] = keepThinking ? (m.thinking ?? []).map((b) => ({ ...b })) : [];
			const blocks: Obj[] = [...thinking, ...(m.text ? [{ type: 'text', text: m.text }] : []), ...m.calls.map((c) => ({ type: 'tool_use', id: safeId(c.id), name: c.name, input: parseInput(c.arguments) }))];
			push('assistant', blocks.length ? blocks : [{ type: 'text', text: '…' }]);
		} else push('user', [{ type: 'tool_result', tool_use_id: safeId(m.id), content: m.content || '(no output)', ...(m.isError ? { is_error: true } : {}) }]);
	}
	// The API wants the conversation to start with the user.
	if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: '(earlier conversation)' }] });
	return out;
}

export class AnthropicClient implements ChatClient {
	constructor(
		private provider: ArkaiProvider,
		private fetchFn: typeof fetch = fetch
	) {}

	async complete(req: CompletionRequest): Promise<Completion> {
		const base = this.provider.baseUrl.replace(/\/v1$/, '');
		const res = await this.fetchFn(`${base}/v1/messages`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'anthropic-version': ANTHROPIC_VERSION,
				...(this.provider.apiKey ? { 'x-api-key': this.provider.apiKey } : {}),
				...this.provider.headers
			},
			body: JSON.stringify({
				model: req.model,
				max_tokens: req.maxTokens,
				stream: true,
				...(req.system ? { system: req.system } : {}),
				messages: anthropicMessages(req.messages, req.keepThinking),
				...(req.tools.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
				...req.extra
			}),
			signal: req.signal
		});
		if (!res.ok) throw await providerError(res, this.provider.name);
		if (!res.body) throw new ProviderError(res.status, `${this.provider.name}: empty response`);
		let text = '';
		const blocks = new Map<number, { type: string; id: string; name: string; json: string; thinking: string; signature: string; data: string }>();
		const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		let stop: string | null = null;
		for await (const { data } of sseEvents(res.body)) {
			let ev: unknown;
			try {
				ev = JSON.parse(data);
			} catch {
				continue;
			}
			if (!isObj(ev)) continue;
			switch (ev.type) {
				case 'message_start': {
					const u = isObj(ev.message) && isObj(ev.message.usage) ? ev.message.usage : {};
					usage.input = num(u.input_tokens);
					usage.cacheRead = num(u.cache_read_input_tokens);
					usage.cacheWrite = num(u.cache_creation_input_tokens);
					usage.output = num(u.output_tokens);
					break;
				}
				case 'content_block_start': {
					const b = isObj(ev.content_block) ? ev.content_block : {};
					blocks.set(num(ev.index), {
						type: String(b.type ?? ''),
						id: typeof b.id === 'string' ? b.id : '',
						name: typeof b.name === 'string' ? b.name : '',
						json: '',
						thinking: typeof b.thinking === 'string' ? b.thinking : '',
						signature: typeof b.signature === 'string' ? b.signature : '',
						data: typeof b.data === 'string' ? b.data : ''
					});
					if (b.type === 'text' && typeof b.text === 'string' && b.text) {
						text += b.text;
						req.onText(b.text);
					}
					break;
				}
				case 'content_block_delta': {
					const d = isObj(ev.delta) ? ev.delta : {};
					if (d.type === 'text_delta' && typeof d.text === 'string') {
						text += d.text;
						req.onText(d.text);
					} else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
						const b = blocks.get(num(ev.index));
						if (b) b.thinking += d.thinking;
						req.onThinking(d.thinking);
					} else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
						const b = blocks.get(num(ev.index));
						if (b) b.signature += d.signature;
					} else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
						const b = blocks.get(num(ev.index));
						if (b) b.json += d.partial_json;
					}
					break;
				}
				case 'message_delta': {
					if (isObj(ev.delta) && typeof ev.delta.stop_reason === 'string') stop = ev.delta.stop_reason;
					if (isObj(ev.usage)) usage.output = num(ev.usage.output_tokens) || usage.output;
					break;
				}
				case 'error': {
					const e = isObj(ev.error) ? ev.error : {};
					const overloaded = e.type === 'overloaded_error';
					throw new ProviderError(overloaded ? 529 : 500, `${this.provider.name}: ${String(e.message ?? 'error').slice(0, 600)}`);
				}
			}
		}
		const calls: ToolCall[] = [...blocks.entries()]
			.sort(([a], [b]) => a - b)
			.flatMap(([, b]) => (b.type === 'tool_use' && b.name ? [{ id: b.id || `toolu_${Math.random().toString(36).slice(2)}`, name: b.name, arguments: b.json || '{}' }] : []));
		const thinking = [...blocks.entries()]
			.sort(([a], [b]) => a - b)
			.flatMap(([, b]): ThinkingBlock[] =>
				b.type === 'thinking' && b.signature ? [{ type: 'thinking', thinking: b.thinking, signature: b.signature }] : b.type === 'redacted_thinking' && b.data ? [{ type: 'redacted_thinking', data: b.data }] : []
			);
		return { text, calls, stop: calls.length ? 'tool_calls' : stop === 'max_tokens' ? 'length' : 'stop', usage, ...(thinking.length ? { thinking } : {}) };
	}
}
