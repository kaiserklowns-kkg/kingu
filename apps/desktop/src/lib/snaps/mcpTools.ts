// MCP tools from the IDE ("MCP: Run Tool…"), pure parts: the argument form built from a tool's
// JSON Schema, turning what was typed into arguments, and the result as text for the output
// channel. Rust (mcp_tools.rs) starts the server and speaks the protocol.

import { isRemote, type McpServers, type StdioServers } from '#lib/ade/mcp.ts';
import { t } from '#lib/i18n/index.ts';

/** A `tools/list` entry (only the parts the form uses). */
export type ToolInfo = { name: string; title?: string; description?: string; inputSchema?: JsonSchema };
type JsonSchema = { type?: string | string[]; properties?: Record<string, JsonSchema>; required?: string[]; description?: string; enum?: unknown[]; default?: unknown };

export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'json';
/** One argument of the form. */
export type Field = { name: string; type: FieldType; required: boolean; description: string; choices: string[] | null; default: unknown };

/** The stdio servers a tool can be run from (remote ones are the agent's business). */
export function runnableServers(servers: McpServers): StdioServers {
	return Object.fromEntries(Object.entries(servers).filter(([, s]) => !isRemote(s))) as StdioServers;
}

/** The form for a tool: required arguments first, then the rest, in schema order. */
export function schemaFields(schema: JsonSchema | undefined): Field[] {
	const props = schema?.properties ?? {};
	const required = new Set(schema?.required ?? []);
	const fields = Object.entries(props).map(([name, p]): Field => {
		const raw = Array.isArray(p.type) ? p.type.find((x) => x !== 'null') : p.type;
		const type: FieldType = raw === 'string' || raw === 'number' || raw === 'integer' || raw === 'boolean' ? raw : 'json';
		const choices = Array.isArray(p.enum) && p.enum.every((x) => typeof x === 'string') ? (p.enum as string[]) : null;
		return { name, type, required: required.has(name), description: p.description ?? '', choices, default: p.default };
	});
	return [...fields.filter((f) => f.required), ...fields.filter((f) => !f.required)];
}

/** What was typed for `field` as a JSON value; `undefined` leaves an optional argument out. */
export function parseField(field: Field, text: string): { value: unknown } | { error: string } {
	const v = text.trim();
	if (!v) return field.required ? { error: t('snapPlatform.tools.required', { name: field.name }) } : { value: undefined };
	if (field.choices && !field.choices.includes(v)) return { error: t('snapPlatform.tools.oneOf', { list: field.choices.join(', ') }) };
	switch (field.type) {
		case 'string':
			return { value: text };
		case 'number':
		case 'integer': {
			const n = Number(v);
			if (!Number.isFinite(n) || (field.type === 'integer' && !Number.isInteger(n))) return { error: t('snapPlatform.tools.notNumber', { type: field.type }) };
			return { value: n };
		}
		case 'boolean':
			if (/^(true|yes|y|1)$/i.test(v)) return { value: true };
			if (/^(false|no|n|0)$/i.test(v)) return { value: false };
			return { error: t('snapPlatform.tools.notBoolean') };
		default:
			try {
				return { value: JSON.parse(v) };
			} catch {
				return { error: t('snapPlatform.tools.notJson') };
			}
	}
}

/** The hint under the input of a field: its type, whether it is needed, its description. */
export function fieldHint(field: Field, text: string): string {
	const parsed = parseField(field, text);
	if ('error' in parsed && text.trim()) return parsed.error;
	const kind = field.choices ? field.choices.join(' | ') : field.type;
	const need = field.required ? t('snapPlatform.tools.requiredMark') : t('snapPlatform.tools.optionalMark');
	return `${field.name} (${kind}, ${need})${field.description ? ` — ${field.description}` : ''}`;
}

/** Arguments typed as one JSON object (the "JSON…" path of the form). */
export function parseArgsJson(text: string): { value: Record<string, unknown> } | { error: string } {
	try {
		const v = JSON.parse(text.trim() || '{}');
		if (v && typeof v === 'object' && !Array.isArray(v)) return { value: v as Record<string, unknown> };
	} catch {
		// Falls through to the error.
	}
	return { error: t('snapPlatform.tools.notObject') };
}

/** A starting JSON object for the JSON path: each field's default, or an empty value of its type. */
export function argsTemplate(fields: readonly Field[]): string {
	const empty = (f: Field) => (f.default !== undefined ? f.default : f.type === 'string' ? '' : f.type === 'boolean' ? false : f.type === 'json' ? null : 0);
	return JSON.stringify(Object.fromEntries(fields.map((f) => [f.name, empty(f)])));
}

type Content = { type: string; text?: string; mimeType?: string; data?: string; uri?: string; resource?: { uri?: string; text?: string; mimeType?: string } };

/** A `tools/call` result as lines for the output channel. */
export function resultText(server: string, tool: string, args: unknown, result: { content?: Content[]; structuredContent?: unknown; isError?: boolean }): string[] {
	const lines = [`▶ ${server} · ${tool} ${JSON.stringify(args)}`];
	if (result.isError) lines.push(t('snapPlatform.tools.toolError'));
	for (const c of result.content ?? []) {
		if (c.type === 'text') lines.push(c.text ?? '');
		else if (c.type === 'image' || c.type === 'audio') lines.push(`[${c.type} ${c.mimeType ?? ''}, ${Math.floor(((c.data?.length ?? 0) * 3) / 4)} bytes]`);
		else if (c.type === 'resource') lines.push(`[resource ${c.resource?.uri ?? ''}]`, ...(c.resource?.text ? [c.resource.text] : []));
		else if (c.type === 'resource_link') lines.push(`[link ${c.uri ?? ''}]`);
		else lines.push(JSON.stringify(c));
	}
	if (result.structuredContent !== undefined) lines.push(JSON.stringify(result.structuredContent, null, 2));
	lines.push('');
	return lines;
}
