// Tool calls a model wrote as text (old Kingu's Arkai: chyle-gateway/src/toolText.ts and
// extensions/src/leftover-calls.ts). Small and mid-size local models (Qwen3-Coder among them)
// often write a call into the answer instead of the API's tool calls: Qwen's XML
// (`<function=Write><parameter=file_path>a.js</parameter>…</function>`), a `<tool_call>` block, a
// JSON object with `name` and `arguments`, or tokenized markers (`<|tool_call_begin|>`). Such a
// call never runs, and the turn ends as if the model were done.
//
// - `recoverToolCalls`: turns such calls into real ones (only tools that were offered), as the
//   gateway did in front of Ollama.
// - `hasLeftoverToolCall` / `NUDGE`: markup that could not be recovered sends the model back to
//   make the call through the tool interface, at most `MAX_NUDGES` times per user message.
// - `stripToolMarkup`: the markup is taken out of the model's earlier answers before each request,
//   so it does not copy it (goose's `sanitize_residual_markers`).
// Markup inside a fenced code block is left alone: the model may be showing the format.
//
// The parsing is ported from goose (crates/goose-local-inference/src/native_tool_parsing.rs and
// crates/goose/src/providers/toolshim.rs) by way of Arkai. Copyright (c) Block, Inc. and
// contributors. Licensed under the Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0);
// modified for Kingu: TypeScript, Kingu's tool names. See NOTICE.

/** A tool the request offered: its name and JSON-schema parameters. */
export type OfferedTool = { readonly name: string; readonly parameters?: { readonly properties?: Readonly<Record<string, { readonly type?: string | readonly string[] }>> } };

export type RecoveredCall = { readonly name: string; /** JSON text, as the APIs carry arguments. */ readonly arguments: string };

export type Recovered = { /** What the model said besides the calls. */ readonly text: string; readonly calls: readonly RecoveredCall[] };

/** How many times per user message the model is sent back to make its call. */
export const MAX_NUDGES = 2;

/** What the model is told when its call was written as text. */
export const NUDGE = 'Your tool call was written as text and did not run. Call the tool through the tool interface.';

/** Put in place of an answer that held nothing but a written-out call. */
export const STRIPPED_PLACEHOLDER = '(A tool call written as text was removed here; it did not run.)';

const FUNCTION = /<function=([^>\s]+)\s*>([\s\S]*?)<\/function>/g;
const PARAMETER = /<parameter=([^>\s]+)\s*>([\s\S]*?)<\/parameter>/g;
/** Wrappers some templates put around a call, left in the text when the call is taken out. */
const WRAPPERS = /<\/?tool_call>|<\|tool_call_(begin|end)\|>|<\|tool_calls_section_(begin|end)\|>/g;

/** A parameter's value as its schema wants it: XML carries every value as text. */
function typedValue(raw: string, type: string | readonly string[] | undefined): unknown {
	const value = raw.replace(/^\n/, '').replace(/\n$/, '');
	const types = type === undefined ? [] : Array.isArray(type) ? type : [type];
	if (types.length === 0 || types.includes('string')) return value;
	try {
		return JSON.parse(value.trim());
	} catch {
		return value;
	}
}

function parseXml(text: string, offered: ReadonlyMap<string, OfferedTool>): RecoveredCall[] {
	const calls: RecoveredCall[] = [];
	for (const match of text.matchAll(FUNCTION)) {
		const tool = offered.get(match[1]!.trim());
		if (!tool) continue;
		const args: Record<string, unknown> = {};
		for (const p of match[2]!.matchAll(PARAMETER)) {
			const key = p[1]!.trim();
			args[key] = typedValue(p[2]!, tool.parameters?.properties?.[key]?.type);
		}
		calls.push({ name: tool.name, arguments: JSON.stringify(args) });
	}
	return calls;
}

/** Every balanced `{…}` in the text that parses as JSON. */
function jsonObjects(text: string): { value: unknown; start: number; end: number }[] {
	const found: { value: unknown; start: number; end: number }[] = [];
	for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let i = start; i < text.length; i++) {
			const ch = text[i];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === '\\' && inString) {
				escaped = true;
				continue;
			}
			if (ch === '"') {
				inString = !inString;
				continue;
			}
			if (inString) continue;
			if (ch === '{') depth++;
			else if (ch === '}' && --depth === 0) {
				try {
					found.push({ value: JSON.parse(text.slice(start, i + 1)), start, end: i + 1 });
				} catch {
					// Not JSON; keep looking.
				}
				break;
			}
		}
	}
	return found;
}

function asCall(value: unknown, offered: ReadonlyMap<string, OfferedTool>): RecoveredCall | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const inner = record.function && typeof record.function === 'object' ? (record.function as Record<string, unknown>) : record;
	const name = typeof inner.name === 'string' ? inner.name : undefined;
	const args = inner.arguments ?? inner.parameters ?? inner.input;
	const tool = name ? offered.get(name) : undefined;
	if (!tool || args === undefined || (typeof args !== 'object' && typeof args !== 'string')) return undefined;
	return { name: tool.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) };
}

/**
 * The tool calls written into `text`, keeping only tools that were offered (a model inventing a
 * tool gets nothing), or `undefined` when there are none. JSON objects inside a code fence are not
 * taken: a model showing a config file is not calling a tool.
 */
export function recoverToolCalls(text: string, tools: readonly OfferedTool[]): Recovered | undefined {
	if (!text || tools.length === 0) return undefined;
	const offered = new Map(tools.map((t) => [t.name, t]));
	if (text.includes('<function=')) {
		const calls = parseXml(outsideFences(text), offered);
		if (calls.length) return { text: stripToolMarkup(text), calls };
	}
	const prose = blankFences(text);
	const calls: RecoveredCall[] = [];
	let rest = text;
	for (const object of jsonObjects(prose).reverse()) {
		const call = asCall(object.value, offered);
		if (call) {
			calls.unshift(call);
			rest = rest.slice(0, object.start) + rest.slice(object.end);
		}
	}
	return calls.length ? { text: rest.replace(WRAPPERS, '').trim(), calls } : undefined;
}

const MARKERS = [/<function=[\w.:\-]+\s*>/, /<tool_call>/i, /<\|tool_calls?(_section)?_(begin|end)\|>/, /<\|tool_call_argument_(begin|end)\|>/];

const FENCE = /```[\s\S]*?(```|$)/g;

/** The text with fenced code blocks taken out. */
function outsideFences(text: string): string {
	return text.replace(FENCE, '');
}

/** The text with fenced code blocks blanked (same length, so offsets still match the original). */
function blankFences(text: string): string {
	return text.replace(FENCE, (m) => ' '.repeat(m.length));
}

/** Whether the text holds a tool call written out as text (outside code fences). */
export function hasLeftoverToolCall(text: string): boolean {
	const prose = outsideFences(text);
	return MARKERS.some((m) => m.test(prose));
}

/** Blocks removed whole, each up to its closer or, when unclosed, the end of the text. */
const BLOCKS = [
	/<\|tool_calls_section_begin\|>[\s\S]*?(<\|tool_calls_section_end\|>|$)/g,
	/<\|tool_call_begin\|>[\s\S]*?(<\|tool_call_end\|>|$)/g,
	/<tool_call>[\s\S]*?(<\/tool_call>|$)/gi,
	/<function=[\w.:\-]+\s*>[\s\S]*?(<\/function>|$)/g
];

/** Stray markers left after the blocks are gone. */
const STRAY = /<\|tool_[a-z_]+\|>|<\/?tool_call>|<\/function>|<\/?parameter(=[^>]*)?>/gi;

/** Removes tool-call markup from text outside code fences; text without a call marker is returned as is. */
export function stripToolMarkup(text: string): string {
	if (!hasLeftoverToolCall(text) && !/<\|tool_[a-z_]+\|>|<\/tool_call>/i.test(outsideFences(text))) return text;
	let result = '';
	let last = 0;
	for (const match of text.matchAll(FENCE)) {
		result += stripProse(text.slice(last, match.index)) + match[0];
		last = (match.index ?? 0) + match[0].length;
	}
	result += stripProse(text.slice(last));
	return result.replace(/\n{3,}/g, '\n\n').trim();
}

function stripProse(prose: string): string {
	let out = prose;
	for (const block of BLOCKS) out = out.replace(block, '');
	return out.replace(STRAY, '');
}
