// MCP servers asking something of the user, whatever agent runs the chat: a form to fill in
// (`elicitation/create`, MCP 2025-06-18) or leave to make a model call (`sampling/createMessage`).
// They come from Arkai's own MCP client (arkai/mcp.ts), from `codex app-server`
// (`mcpServer/elicitation/request`) and from the Claude Agent SDK (`onElicitation`).
//
// Each ask is an `mcp_request` event the chat shows as a card; the app answers with
// `mcp_answer`, and `mcp_request_resolved` follows. An ask nobody answers is cancelled after
// `ASK_TIMEOUT_MS`, and every waiting one when the turn is interrupted or the run ends.
//
// Sampling (VS Code's `chat.mcp.serverSampling`, `allowedDuringChat`): a server the user allowed
// or refused for good (Rust passes the setting at the start) is not asked about; "this session"
// answers last for the run. Arkai routes an allowed request to its own provider (arkai/session.ts).
//
// Never log what a server asks or what the user typed: forms may hold secrets.

import type { AgentEvent, McpAnswerParams } from './protocol.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An ask nobody answers is cancelled after this. */
export const ASK_TIMEOUT_MS = 10 * 60_000;
const MAX_MESSAGE = 4000;
const MAX_SCHEMA = 64 * 1024;
const MAX_FIELDS = 50;
/** What a sampling card shows of the request: the last messages, each cut. */
const PREVIEW_MESSAGES = 20;
const PREVIEW_CHARS = 2000;

export type ElicitAction = 'accept' | 'decline' | 'cancel';
export const ELICIT_ACTIONS: readonly ElicitAction[] = ['accept', 'decline', 'cancel'];
export type FieldValue = string | number | boolean;
export type ElicitResult = { action: ElicitAction; content?: Record<string, FieldValue> };
/** What a server asks the user (form: `schema`; url: a page to open, e.g. a sign-in). */
export type ElicitAsk = { server: string; message: string; mode: 'form' | 'url'; schema: Obj | null; url: string | null };
export type SampleMessage = { role: string; text: string };
export type SampleAsk = { server: string; messages: SampleMessage[]; systemPrompt: string | null; maxTokens: number | null };
export type Remember = 'session' | 'always' | 'never';

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// ---------------------------------------------------------------------------------------------
// Forms

/** One field of a form, as the spec's restricted schema allows (flat, primitive). */
export type Field = { name: string; type: 'string' | 'number' | 'integer' | 'boolean'; required: boolean; options: string[] | null; min: number | null; max: number | null };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A single-select's values: `enum`, or `oneOf` / `anyOf` of `{ const }`. */
function optionsOf(p: Obj): string[] | null {
	if (Array.isArray(p.enum)) return p.enum.filter((x): x is string => typeof x === 'string');
	const alts = Array.isArray(p.oneOf) ? p.oneOf : Array.isArray(p.anyOf) ? p.anyOf : null;
	if (alts) return alts.filter(isObj).map((a) => a.const).filter((x): x is string => typeof x === 'string');
	return null;
}

/** The fields of a requested schema; throws when it is not one the spec allows. */
export function formFields(schema: unknown): Field[] {
	if (!isObj(schema) || (schema.type !== undefined && schema.type !== 'object')) throw new Error('the requested schema is not an object');
	const props = isObj(schema.properties) ? schema.properties : {};
	const required = new Set(Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === 'string') : []);
	const out: Field[] = [];
	for (const [name, p] of Object.entries(props)) {
		if (!isObj(p)) throw new Error(`field ${name} has no schema`);
		const options = optionsOf(p);
		const type = p.type ?? (options ? 'string' : undefined);
		if (type !== 'string' && type !== 'number' && type !== 'integer' && type !== 'boolean') throw new Error(`field ${name}: unsupported type ${String(type)}`);
		if (options && (type !== 'string' || !options.length)) throw new Error(`field ${name}: an enum must list strings`);
		const strings = type === 'string';
		out.push({ name, type, required: required.has(name), options, min: num(strings ? p.minLength : p.minimum), max: num(strings ? p.maxLength : p.maximum) });
	}
	if (out.length > MAX_FIELDS) throw new Error('the form has too many fields');
	return out;
}

/** The user's answer checked against the form: only its fields, each of its type, the required ones there. */
export function checkContent(schema: unknown, content: unknown): Record<string, FieldValue> {
	const fields = formFields(schema);
	if (!isObj(content)) throw new Error('content must map fields to values');
	const known = new Map(fields.map((f) => [f.name, f]));
	for (const key of Object.keys(content)) if (!known.has(key)) throw new Error(`no field ${key}`);
	const out: Record<string, FieldValue> = {};
	for (const f of fields) {
		const v = content[f.name];
		if (v === undefined || v === null || v === '') {
			if (f.required) throw new Error(`${f.name} is required`);
			continue;
		}
		if (f.type === 'boolean') {
			if (typeof v !== 'boolean') throw new Error(`${f.name} must be true or false`);
		} else if (f.type === 'string') {
			if (typeof v !== 'string') throw new Error(`${f.name} must be text`);
			if (f.options && !f.options.includes(v)) throw new Error(`${f.name} must be one of the options`);
			if ((f.min !== null && v.length < f.min) || (f.max !== null && v.length > f.max)) throw new Error(`${f.name} has the wrong length`);
		} else {
			if (typeof v !== 'number' || !Number.isFinite(v) || (f.type === 'integer' && !Number.isInteger(v))) throw new Error(`${f.name} must be a number`);
			if ((f.min !== null && v < f.min) || (f.max !== null && v > f.max)) throw new Error(`${f.name} is out of range`);
		}
		out[f.name] = v;
	}
	return out;
}

/** An elicitation's params (MCP `elicitation/create`, the SDK's request, codex's) as an ask; null when unusable. */
export function elicitAsk(server: string, p: unknown): ElicitAsk | null {
	if (!isObj(p)) return null;
	const message = typeof p.message === 'string' ? cut(p.message, MAX_MESSAGE) : '';
	if (p.mode === 'url') {
		const url = typeof p.url === 'string' && /^https?:\/\//i.test(p.url) ? p.url : null;
		return url ? { server, message, mode: 'url', schema: null, url } : null;
	}
	const schema = isObj(p.requestedSchema) ? p.requestedSchema : null;
	if (!schema || JSON.stringify(schema).length > MAX_SCHEMA) return null;
	return { server, message, mode: 'form', schema, url: null };
}

/** A sampling request's messages as text the card shows (images and audio named). */
export function sampleAsk(server: string, p: unknown): SampleAsk {
	const o = isObj(p) ? p : {};
	const messages = (Array.isArray(o.messages) ? o.messages : []).filter(isObj).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: contentText(m.content) }));
	return {
		server,
		messages,
		systemPrompt: typeof o.systemPrompt === 'string' ? o.systemPrompt : null,
		maxTokens: typeof o.maxTokens === 'number' && o.maxTokens > 0 ? Math.floor(o.maxTokens) : null
	};
}

/** A message's content (one part or a list) as text. */
export function contentText(c: unknown): string {
	const parts = Array.isArray(c) ? c : [c];
	return parts
		.filter(isObj)
		.map((x) => (x.type === 'text' && typeof x.text === 'string' ? x.text : x.type === 'image' || x.type === 'audio' ? `[${x.type}]` : ''))
		.filter(Boolean)
		.join('\n');
}

// ---------------------------------------------------------------------------------------------
// The asks of one run

type Waiting = { type: 'elicitation' | 'sampling'; server: string; schema: Obj | null; resolve: (r: { action: ElicitAction; content?: Record<string, FieldValue>; remember?: Remember | null }) => void; timer: ReturnType<typeof setTimeout> };

export type AsksOptions = {
	emit: (ev: AgentEvent) => void;
	newId: () => string;
	log: (line: string) => void;
	/** `chat.mcp.serverSampling`: server → allowed during chat (absent: ask). */
	sampling?: Record<string, boolean> | null;
	timeoutMs?: number;
};

export class McpAsks {
	private waiting = new Map<string, Waiting>();
	/** Sampling answers that last for this run. */
	private sessionSampling = new Map<string, boolean>();
	closed = false;

	constructor(private o: AsksOptions) {}

	get size() {
		return this.waiting.size;
	}

	private ask(type: Waiting['type'], server: string, schema: Obj | null, event: Omit<Extract<AgentEvent, { kind: 'mcp_request' }>, 'kind' | 'request_id' | 'type' | 'server' | 'timeout_ms'>, signal?: AbortSignal) {
		return new Promise<{ action: ElicitAction; content?: Record<string, FieldValue>; remember?: Remember | null }>((resolve) => {
			if (this.closed || signal?.aborted) return resolve({ action: 'cancel' });
			const id = this.o.newId();
			const ms = this.o.timeoutMs ?? ASK_TIMEOUT_MS;
			const timer = setTimeout(() => this.settle(id, { action: 'cancel' }, 'timed out'), ms);
			(timer as { unref?: () => void }).unref?.();
			this.waiting.set(id, { type, server, schema, resolve, timer });
			signal?.addEventListener('abort', () => this.settle(id, { action: 'cancel' }), { once: true });
			this.o.emit({ kind: 'mcp_request', request_id: id, type, server, timeout_ms: ms, ...event });
		});
	}

	private settle(id: string, r: { action: ElicitAction; content?: Record<string, FieldValue>; remember?: Remember | null }, why?: string) {
		const w = this.waiting.get(id);
		if (!w) return false;
		this.waiting.delete(id);
		clearTimeout(w.timer);
		w.resolve(r);
		this.o.emit({ kind: 'mcp_request_resolved', request_id: id, action: r.action });
		this.o.log(`mcp ${w.server}: ${w.type} ${r.action}${why ? ` (${why})` : ''}`);
		return true;
	}

	/** Asks the user to fill in a server's form (or open its page); cancelled when unanswered. */
	async elicit(ask: ElicitAsk, signal?: AbortSignal): Promise<ElicitResult> {
		if (ask.mode === 'form') {
			try {
				formFields(ask.schema);
			} catch (e) {
				// A form Kingu cannot show is declined, so the server can go on without it.
				this.o.log(`mcp ${ask.server}: elicitation declined (${e instanceof Error ? e.message : 'bad schema'})`);
				return { action: 'decline' };
			}
		}
		const r = await this.ask('elicitation', ask.server, ask.schema, { message: ask.message, mode: ask.mode, schema: ask.schema, url: ask.url, sampling: null }, signal);
		return r.action === 'accept' && ask.mode === 'form' ? { action: 'accept', content: r.content ?? {} } : { action: r.action };
	}

	/** Whether the server may make this model call: the setting, this run's answer, else the user's. */
	async allowSampling(ask: SampleAsk, signal?: AbortSignal): Promise<boolean> {
		const set = this.o.sampling?.[ask.server];
		if (typeof set === 'boolean') return set;
		const kept = this.sessionSampling.get(ask.server);
		if (kept !== undefined) return kept;
		const messages = ask.messages.slice(-PREVIEW_MESSAGES).map((m) => ({ role: m.role, text: cut(m.text, PREVIEW_CHARS) }));
		const r = await this.ask(
			'sampling',
			ask.server,
			null,
			{ message: '', mode: null, schema: null, url: null, sampling: { messages, system_prompt: ask.systemPrompt ? cut(ask.systemPrompt, PREVIEW_CHARS) : null, max_tokens: ask.maxTokens } },
			signal
		);
		const allowed = r.action === 'accept';
		if (r.remember) this.sessionSampling.set(ask.server, allowed);
		return allowed;
	}

	/** The app's answer; a bad one throws and leaves the ask waiting. */
	answer(p: McpAnswerParams) {
		const w = this.waiting.get(p.requestId);
		if (!w) throw new Error(`no pending MCP request ${p.requestId}`);
		if (!ELICIT_ACTIONS.includes(p.action)) throw new Error(`bad action ${String(p.action)}`);
		const remember = p.remember ?? null;
		if (remember !== null && !(w.type === 'sampling' && ['session', 'always', 'never'].includes(remember))) throw new Error('only a sampling answer is remembered');
		let content: Record<string, FieldValue> | undefined;
		if (p.action === 'accept' && w.type === 'elicitation' && w.schema) content = checkContent(w.schema, p.content ?? {});
		this.settle(p.requestId, { action: p.action, content, remember });
		return null;
	}

	/** Every waiting ask cancelled (the turn was interrupted). */
	cancelAll() {
		for (const id of [...this.waiting.keys()]) this.settle(id, { action: 'cancel' });
	}

	/** The run ended: everything cancelled, nothing asked again. */
	close() {
		this.cancelAll();
		this.closed = true;
	}
}
