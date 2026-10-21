// MCP client features of the chat, the pure part (bun tests cover it): the form an MCP server
// asks for (elicitation, MCP 2025-06-18's restricted schema: flat string / number / integer /
// boolean / enum fields), the `chat.mcp.serverSampling` entry an "Always" / "Never" answer
// writes, the `/mcp.<server>.<prompt>` commands (VS Code's mcpPromptPrefix) and their arguments,
// a rendered prompt as the composer's text, resource templates (RFC 6570, simple expansion) and
// a resource's content as attached context. The cards and pickers are mcpChat.svelte.ts and
// McpRequestCard.svelte.

import type { ContextText } from './chatPrompt.ts';
import { cutText } from './chatPrompt.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---------------------------------------------------------------------------------------------
// Forms (elicitation)

export type FormOption = { value: string; label: string };
export type FormField = {
	name: string;
	label: string;
	description: string;
	type: 'string' | 'number' | 'integer' | 'boolean';
	required: boolean;
	/** A single-select's values (`enum` with `enumNames`, or `oneOf` of `{ const, title }`). */
	options: FormOption[] | null;
	/** `email`, `uri`, `date`, `date-time` (strings). */
	format: string | null;
	/** minLength / maximum…: lengths for strings, values for numbers. */
	min: number | null;
	max: number | null;
	default: string | number | boolean | null;
};

/** What the inputs hold: text for text, number and select fields; true / false for checkboxes. */
export type FormValues = Record<string, string | boolean>;
export type FieldError = 'required' | 'number' | 'integer' | 'min' | 'max' | 'minLength' | 'maxLength' | 'email' | 'uri' | 'date';

function optionsOf(p: Obj): FormOption[] | null {
	if (Array.isArray(p.enum)) {
		const names = Array.isArray(p.enumNames) ? p.enumNames : [];
		return p.enum.filter((x): x is string => typeof x === 'string').map((value, i) => ({ value, label: str(names[i]) ?? value }));
	}
	const alts = Array.isArray(p.oneOf) ? p.oneOf : Array.isArray(p.anyOf) ? p.anyOf : null;
	if (!alts) return null;
	return alts.filter(isObj).flatMap((a) => (typeof a.const === 'string' ? [{ value: a.const, label: str(a.title) ?? a.const }] : []));
}

/** The form's fields in order; null when the schema has a field the card cannot show (then only Decline / Cancel). */
export function formFields(schema: unknown): FormField[] | null {
	if (!isObj(schema)) return null;
	const props = isObj(schema.properties) ? schema.properties : {};
	const required = new Set(Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === 'string') : []);
	const out: FormField[] = [];
	for (const [name, p] of Object.entries(props)) {
		if (!isObj(p)) return null;
		const options = optionsOf(p);
		const type = p.type ?? (options ? 'string' : undefined);
		if (type !== 'string' && type !== 'number' && type !== 'integer' && type !== 'boolean') return null;
		if (options && (type !== 'string' || !options.length)) return null;
		const strings = type === 'string';
		const d = p.default;
		out.push({
			name,
			label: str(p.title) ?? name,
			description: str(p.description) ?? '',
			type,
			required: required.has(name),
			options,
			format: strings ? str(p.format) : null,
			min: num(strings ? p.minLength : p.minimum),
			max: num(strings ? p.maxLength : p.maximum),
			default: typeof d === 'string' || typeof d === 'number' || typeof d === 'boolean' ? d : null
		});
	}
	return out;
}

/** The inputs' first values: each field's default, else empty (a checkbox: off). */
export function initialValues(fields: readonly FormField[]): FormValues {
	return Object.fromEntries(fields.map((f) => [f.name, f.type === 'boolean' ? f.default === true : f.default === null ? '' : String(f.default)]));
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function fieldError(f: FormField, raw: string | boolean): FieldError | null {
	if (f.type === 'boolean') return null;
	const text = String(raw).trim();
	if (!text) return f.required ? 'required' : null;
	if (f.type === 'string') {
		if (f.min !== null && text.length < f.min) return 'minLength';
		if (f.max !== null && text.length > f.max) return 'maxLength';
		if (f.format === 'email' && !EMAIL.test(text)) return 'email';
		if (f.format === 'uri' && !/^[a-z][a-z0-9+.-]*:\S+$/i.test(text)) return 'uri';
		if (f.format === 'date' && !DATE.test(text)) return 'date';
		if (f.format === 'date-time' && Number.isNaN(Date.parse(text))) return 'date';
		return null;
	}
	const n = Number(text);
	if (!Number.isFinite(n)) return 'number';
	if (f.type === 'integer' && !Number.isInteger(n)) return 'integer';
	if (f.min !== null && n < f.min) return 'min';
	if (f.max !== null && n > f.max) return 'max';
	return null;
}

/** The inputs as the answer's `content` (numbers as numbers, empty optional fields left out), or each field's error. */
export function formContent(fields: readonly FormField[], values: FormValues): { content: Record<string, string | number | boolean> } | { errors: Record<string, FieldError> } {
	const errors: Record<string, FieldError> = {};
	const content: Record<string, string | number | boolean> = {};
	for (const f of fields) {
		const raw = values[f.name] ?? (f.type === 'boolean' ? false : '');
		const e = fieldError(f, raw);
		if (e) {
			errors[f.name] = e;
			continue;
		}
		if (f.type === 'boolean') content[f.name] = raw === true;
		else if (String(raw).trim()) content[f.name] = f.type === 'string' ? String(raw).trim() : Number(String(raw).trim());
	}
	return Object.keys(errors).length ? { errors } : { content };
}

// ---------------------------------------------------------------------------------------------
// Sampling

export const SAMPLING_SETTING = 'chat.mcp.serverSampling';
export type SamplingEntry = { allowedDuringChat?: boolean; allowedOutsideChat?: boolean; allowedModels?: string[] };

/** `chat.mcp.serverSampling` with server `name` allowed or refused during chat (its other keys kept). */
export function samplingWith(current: unknown, name: string, allowed: boolean): Record<string, SamplingEntry> {
	const map = isObj(current) ? (current as Record<string, SamplingEntry>) : {};
	const entry = isObj(map[name]) ? map[name] : {};
	return { ...map, [name]: { ...entry, allowedDuringChat: allowed } };
}

// ---------------------------------------------------------------------------------------------
// Prompts as `/` commands

export type PromptArg = { name: string; description: string; required: boolean };
export type McpPromptInfo = { name: string; title: string | null; description: string; arguments: PromptArg[] };
export type McpResourceInfo = { uri: string; name: string; description: string; mimeType: string | null; size: number | null };
export type McpTemplateInfo = { uriTemplate: string; name: string; description: string; mimeType: string | null };
/** One server's lists (`agent_mcp_query` `list`). */
export type McpCatalog = { resources: McpResourceInfo[]; templates: McpTemplateInfo[]; prompts: McpPromptInfo[] };
export type McpContent = { uri: string; mimeType: string | null; text: string | null; bytes: number; truncated: boolean };
export type McpPromptResult = { description: string; messages: { role: string; text: string }[]; resources: McpContent[]; images: number };

/** VS Code's `mcpPromptReplaceSpecialChars`: anything but letters, digits, `_ . -` becomes `_`. */
const clean = (s: string) => s.replace(/[^a-z0-9_.-]/gi, '_');

/** The command a server's prompt is (`mcp.<server>.<prompt>`, typed after `/`). */
export const promptCommand = (server: string, prompt: string) => `mcp.${clean(server)}.${clean(prompt)}`;

/** `/mcp.<server>.<prompt> args`: which of `known` it names, and the rest. */
export function findPromptCommand<T extends { command: string }>(text: string, known: readonly T[]): { item: T; args: string } | null {
	const m = /^\/(mcp\.\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	const item = m ? known.find((k) => k.command === m[1]) : undefined;
	return item && m ? { item, args: (m[2] ?? '').trim() } : null;
}

/**
 * What was typed after the command as the prompt's arguments: `name=value` pairs (quotes allowed),
 * else words in the arguments' order, the last one taking the rest. Unknown names are left out.
 */
export function parsePromptArgs(text: string, args: readonly PromptArg[]): Record<string, string> {
	const out: Record<string, string> = {};
	const t = text.trim();
	if (!t || !args.length) return out;
	const names = new Set(args.map((a) => a.name));
	const pair = /([\w.-]+)=(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/g;
	let named = false;
	for (const m of t.matchAll(pair)) {
		if (!names.has(m[1]!)) continue;
		named = true;
		out[m[1]!] = (m[2]?.replace(/\\(.)/g, '$1') ?? m[3] ?? m[4] ?? '').trim();
	}
	if (named) return out;
	const words = t.split(/\s+/);
	args.forEach((a, i) => {
		const value = i === args.length - 1 ? words.slice(i).join(' ') : words[i];
		if (value) out[a.name] = value;
	});
	return out;
}

/** The arguments still to ask for: required ones first, then the optional ones, those not given. */
export const missingArgs = (args: readonly PromptArg[], given: Record<string, string>) => args.filter((a) => !(a.name in given));

/**
 * A rendered prompt as the composer's text (VS Code's: messages joined, each headed `--ROLE`
 * when roles differ) and its embedded resources as attached context.
 */
export function promptText(r: McpPromptResult, label: (uri: string) => string): { text: string; context: ContextText[] } {
	const multi = r.messages.some((m) => m.role !== r.messages[0]?.role);
	const text = r.messages.map((m) => (multi ? `--${m.role.toUpperCase()}\n${m.text}` : m.text)).join('\n\n');
	const context = r.resources.flatMap((c) => {
		const ctx = resourceContext(c, label(c.uri));
		return ctx ? [ctx] : [];
	});
	return { text, context };
}

// ---------------------------------------------------------------------------------------------
// Resources

/** A resource's content as attached context (cut like other attached text); null for binary content. */
export function resourceContext(c: McpContent, label: string): ContextText | null {
	// The host cut it at 512 KB already; what is attached is cut far shorter, and marked.
	return c.text === null ? null : { kind: 'mcp-resource', label, text: cutText(c.text) };
}

/** The `{name}` variables of a URI template (RFC 6570 operators `+ # . / ; ? &` too), in order. */
export function templateVars(template: string): string[] {
	const out: string[] = [];
	for (const m of template.matchAll(/\{([+#./;?&]?)([^}]+)\}/g)) for (const v of m[2]!.split(',')) if (!out.includes(v.trim())) out.push(v.trim());
	return out;
}

/** The template with its variables filled in (simple and reserved expansion; `?` / `&` as query pairs). */
export function expandTemplate(template: string, values: Record<string, string>): string {
	return template.replace(/\{([+#./;?&]?)([^}]+)\}/g, (_, op: string, list: string) => {
		const vars = list.split(',').map((v) => v.trim());
		const enc = (v: string) => (op === '+' || op === '#' ? encodeURI(v) : encodeURIComponent(v));
		const vals = vars.filter((v) => values[v] !== undefined && values[v] !== '');
		if (!vals.length) return '';
		if (op === '?' || op === '&') return `${op}${vals.map((v) => `${v}=${enc(values[v]!)}`).join('&')}`;
		if (op === ';') return vals.map((v) => `;${v}=${enc(values[v]!)}`).join('');
		const sep = op === '.' ? '.' : op === '/' ? '/' : ',';
		const prefix = op === '#' ? '#' : op === '.' ? '.' : op === '/' ? '/' : '';
		return prefix + vals.map((v) => enc(values[v]!)).join(sep);
	});
}

/** "12 KB" for a size line. */
export function sizeLabel(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}
