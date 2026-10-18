// Writes one of Kingu's VS Code settings files (apps/desktop/src/lib/settings/vscode/<area>.ts)
// from VS Code's extracted schema (extract.ts, the full output) and a small spec that says which
// keys Kingu registers, in which settings group, with Kingu's Thai text:
//
//   bun tools/vscode-settings/gen.ts <full-schema.json> <spec.json>   (or genAll.ts for every spec)
//
//   spec: {
//     "out": "apps/desktop/src/lib/settings/vscode/terminal.ts",   (relative to the repository root)
//     "export": "TERMINAL_SETTINGS",
//     "what": "terminal.*",
//     "entries": [{ "id": "terminal.integrated.bellDuration", "group": "Terminal", "th": "…",
//                   "enumTh": ["…"], "default": <only for a listed deviation>, "scope": "application" }]
//   }
//
// Key, type, enum, range, default, scope and the English description come from VS Code; the
// description becomes `<Thai> (<English>)`. Types Kingu's editor has controls for stay simple
// (boolean, number, string enum, string/number arrays, glob maps); anything else (unions, nullable
// values, objects with fixed properties) becomes `type: 'json'` with VS Code's schema.

import { join } from 'node:path';

const [schemaPath, specPath] = process.argv.slice(2);
if (!schemaPath || !specPath) throw new Error('usage: gen.ts <full-schema.json> <spec.json>');

type Schema = Record<string, any>;
const full: Record<string, Schema> = JSON.parse(await Bun.file(schemaPath).text());
const spec = JSON.parse(await Bun.file(specPath).text()) as {
	out: string;
	export: string;
	what: string;
	entries: { id: string; group: string; th: string; en?: string; enumTh?: string[]; enumOnly?: string[]; default?: unknown; schema?: unknown; scope?: string; note?: string; objectValues?: 'boolean' | 'string' | 'boolean|when' }[];
};

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
function lit(v: unknown, indent = ''): string {
	if (v === null) return 'null';
	if (typeof v === 'string') return q(v);
	if (typeof v !== 'object') return JSON.stringify(v);
	if (Array.isArray(v)) {
		const parts = v.map((x) => lit(x, indent + '\t'));
		const one = `[${parts.join(', ')}]`;
		return one.length < 100 && !one.includes('\n') ? one : `[\n${parts.map((p) => indent + '\t' + p).join(',\n')}\n${indent}]`;
	}
	const ents = Object.entries(v as object).map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : q(k)}: ${lit(x, indent + '\t')}`);
	if (!ents.length) return '{}';
	const one = `{ ${ents.join(', ')} }`;
	return one.length < 100 && !one.includes('\n') ? one : `{\n${ents.map((p) => indent + '\t' + p).join(',\n')}\n${indent}}`;
}

/** The JSON Schema keywords Kingu's validator understands (jsonSchema.ts). */
const KEEP = ['type', 'enum', 'const', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'items', 'properties', 'patternProperties', 'additionalProperties', 'anyOf', 'oneOf', 'pattern'];
function prune(s: any): any {
	if (Array.isArray(s)) return s.map(prune);
	if (!s || typeof s !== 'object') return s;
	const out: any = {};
	for (const k of KEEP) {
		if (!(k in s)) continue;
		const v = s[k];
		if (k === 'properties' || k === 'patternProperties') out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, prune(pv)]));
		else if (k === 'items' || k === 'additionalProperties' || k === 'anyOf' || k === 'oneOf') out[k] = typeof v === 'boolean' ? v : prune(v);
		else out[k] = v;
	}
	return out;
}

// VS Code's ConfigurationScope: APPLICATION 1, MACHINE 2, WINDOW 3, RESOURCE 4, LANGUAGE_OVERRIDABLE 5,
// MACHINE_OVERRIDABLE 6, APPLICATION_MACHINE 7. Application and machine settings, and `restricted` ones
// (they run programs or pick paths), stay user-only.
const USER_ONLY = new Set([1, 2, 7, 'application', 'machine', 'application-machine']);
const warn: string[] = [];

function entry(e: (typeof spec.entries)[number]): string {
	const s = full[e.id];
	if (!s) throw new Error(`not in VS Code's schema: ${e.id}`);
	if (s.deprecationMessage || s.markdownDeprecationMessage) warn.push(`deprecated in VS Code: ${e.id}`);
	// `en`: Kingu's English only where VS Code registers the key without a description.
	const en: string = (s.markdownDescription ?? s.description ?? '').trim() || (e.en ?? '');
	if (!en) warn.push(`no English description (VS Code has none; give "en"): ${e.id}`);
	if (!e.th) warn.push(`no Thai text: ${e.id}`);
	if (/\(/.test(e.th)) warn.push(`Thai text has a parenthesis: ${e.id}`);
	const o: Record<string, unknown> = { id: e.id, group: e.group };
	const t = s.type;
	const def = 'default' in e ? e.default : s.default;
	const items = s.items;
	const ap = s.additionalProperties;
	const enumDescs: string[] | undefined = s.markdownEnumDescriptions ?? s.enumDescriptions;
	if (t === 'boolean' && !s.anyOf) Object.assign(o, { type: 'boolean', default: def });
	else if ((t === 'number' || t === 'integer') && !s.enum && !s.anyOf) {
		Object.assign(o, { type: 'number', default: def });
		if (s.minimum !== undefined) o.minimum = s.minimum;
		if (s.maximum !== undefined) o.maximum = s.maximum;
		if (t === 'integer') o.integer = true;
	} else if ((t === 'string' || (t === undefined && s.enum?.length)) && !s.anyOf && !s.oneOf && (!s.enum || s.enum.every((x: unknown) => typeof x === 'string'))) {
		Object.assign(o, { type: 'string', default: def });
		// VS Code's `pattern` (e.g. http.proxy's URL form): a value that doesn't match is ignored.
		if (s.pattern && !s.enum) o.pattern = s.pattern;
		if (s.enum) {
			// `enumOnly`: the values Kingu supports (an ENUM_SUBSETS entry); `enumTh` follows VS Code's full enum.
			const keep = (v: string) => !e.enumOnly || e.enumOnly.includes(v);
			o.enum = s.enum.filter(keep);
			if (enumDescs || e.enumTh)
				o.enumDescriptions = s.enum
					.map((_: string, i: number) => {
						const d = (enumDescs?.[i] ?? '').trim();
						const th = e.enumTh?.[i];
						return th ? (d ? `${th} (${d})` : th) : d;
					})
					.filter((_: string, i: number) => keep(s.enum[i]));
		}
	} else if (
		t === 'array' &&
		items &&
		!Array.isArray(items) &&
		(items.type === 'string' || items.type === 'number') &&
		Object.keys(prune(items)).every((k) => k === 'type' || k === 'enum') &&
		!s.minItems &&
		!s.maxItems &&
		!s.uniqueItems
	) {
		Object.assign(o, { type: 'array', items: items.type, default: def });
		if (items.enum) o.itemEnum = items.enum;
	} else if (e.objectValues && t === 'object') {
		// `objectValues`: a glob map kept a plain map so the layers merge key by key; `boolean|when`
		// also takes VS Code's sibling clauses (`{ "when": "$(basename).ts" }`).
		Object.assign(o, { type: 'object', values: e.objectValues, default: def });
	} else if (
		t === 'object' &&
		!s.properties &&
		!s.anyOf &&
		!s.patternProperties &&
		ap &&
		typeof ap === 'object' &&
		!ap.anyOf &&
		!ap.enum &&
		(ap.type === 'boolean' || ap.type === 'string' || JSON.stringify(ap.type) === '["boolean","string"]')
	) {
		Object.assign(o, { type: 'object', values: Array.isArray(ap.type) ? 'boolean|string' : ap.type, default: def });
	} else {
		// `schema`: only where VS Code's own schema contradicts the values it accepts (with a note why).
		Object.assign(o, { type: 'json', schema: e.schema ?? prune(s), default: def });
	}
	o.description = e.th ? `${e.th} (${en})` : en;
	const scope = e.scope ?? (USER_ONLY.has(s.scope) || s.restricted ? 'application' : undefined);
	if (scope && scope !== 'window') o.scope = scope;
	const note = e.note ? `\t// ${e.note}\n` : '';
	return note + '\t' + lit(o, '\t');
}

const text = `// VS Code settings: ${spec.what}. Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const ${spec.export}: SettingSchema[] = [
${spec.entries.map(entry).join(',\n')}
];
`;
await Bun.write(spec.out.startsWith('/') ? spec.out : join(import.meta.dir, '../..', spec.out), text);
console.log(`${spec.entries.length} settings -> ${spec.out}`);
if (warn.length) console.log(warn.join('\n'));
