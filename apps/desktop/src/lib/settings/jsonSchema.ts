// The subset of JSON Schema that VS Code's configuration schemas use (type, enum, const, ranges,
// items, properties, additionalProperties, anyOf/oneOf), so settings with union or nested types
// (`editor.quickSuggestions`, `git.path`, `explorer.fileNesting.patterns`) validate like VS Code.

export type JsonType = 'boolean' | 'number' | 'integer' | 'string' | 'array' | 'object' | 'null';

export type JsonSchema = {
	type?: JsonType | readonly JsonType[];
	enum?: readonly unknown[];
	const?: unknown;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	minItems?: number;
	maxItems?: number;
	items?: JsonSchema | readonly JsonSchema[];
	properties?: Readonly<Record<string, JsonSchema>>;
	patternProperties?: Readonly<Record<string, JsonSchema>>;
	additionalProperties?: boolean | JsonSchema;
	anyOf?: readonly JsonSchema[];
	oneOf?: readonly JsonSchema[];
	pattern?: string;
};

function typeOf(v: unknown): JsonType {
	if (v === null) return 'null';
	if (Array.isArray(v)) return 'array';
	if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
	return typeof v as JsonType;
}

function typeMatches(want: JsonType, v: unknown): boolean {
	const t = typeOf(v);
	if (want === 'number') return t === 'number' || t === 'integer';
	return t === want;
}

const deepEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const patterns = new Map<string, RegExp>();
/** A schema `pattern` (an ECMAScript regex, like VS Code's); an unparsable one accepts anything. */
function patternOf(source: string): RegExp {
	let re = patterns.get(source);
	if (!re) {
		try {
			re = new RegExp(source, 'u');
		} catch {
			re = /[\s\S]*/;
		}
		patterns.set(source, re);
	}
	return re;
}

/** Whether `value` fits `schema` (unknown keywords are ignored, like a lenient validator). */
export function matchesSchema(schema: JsonSchema, value: unknown): boolean {
	if (schema.anyOf && !schema.anyOf.some((s) => matchesSchema(s, value))) return false;
	if (schema.oneOf && !schema.oneOf.some((s) => matchesSchema(s, value))) return false;
	if (schema.type !== undefined) {
		const types = typeof schema.type === 'string' ? [schema.type] : schema.type;
		if (!types.some((t) => typeMatches(t, value))) return false;
	}
	if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) return false;
	if ('const' in schema && !deepEqual(schema.const, value)) return false;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) return false;
		if (schema.minimum !== undefined && value < schema.minimum) return false;
		if (schema.maximum !== undefined && value > schema.maximum) return false;
	}
	if (typeof value === 'string') {
		if (schema.minLength !== undefined && value.length < schema.minLength) return false;
		if (schema.maxLength !== undefined && value.length > schema.maxLength) return false;
		if (schema.pattern !== undefined && !patternOf(schema.pattern).test(value)) return false;
	}
	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) return false;
		if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
		const items = schema.items;
		if (Array.isArray(items)) {
			if (!items.every((s, i) => i >= value.length || matchesSchema(s, value[i]))) return false;
		} else if (items && !value.every((v) => matchesSchema(items as JsonSchema, v))) return false;
	}
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const props = schema.properties ?? {};
		const patterns = Object.entries(schema.patternProperties ?? {}).map(([re, s]) => [new RegExp(re, 'u'), s] as const);
		for (const [k, v] of Object.entries(value)) {
			const own = props[k];
			const byPattern = patterns.filter(([re]) => re.test(k));
			if (own || byPattern.length) {
				if (own && !matchesSchema(own, v)) return false;
				if (!byPattern.every(([, s]) => matchesSchema(s, v))) return false;
			} else if (schema.additionalProperties === false) return false;
			else if (typeof schema.additionalProperties === 'object' && !matchesSchema(schema.additionalProperties, v)) return false;
		}
	}
	return true;
}

/**
 * The top-level type(s) a schema accepts, sorted: its `type`, else what its `enum` values or
 * `anyOf`/`oneOf` alternatives are. `null` when it says nothing (any value).
 */
export function schemaTypes(schema: JsonSchema): JsonType[] | null {
	let out: JsonType[] | null = null;
	if (schema.type !== undefined) out = typeof schema.type === 'string' ? [schema.type] : [...schema.type];
	else if (schema.enum) out = schema.enum.map((v) => (typeOf(v) === 'integer' ? 'number' : typeOf(v)));
	else if (schema.anyOf || schema.oneOf) {
		const alts = (schema.anyOf ?? schema.oneOf)!.map(schemaTypes);
		out = alts.some((a) => a === null) ? null : (alts.flat() as JsonType[]);
	}
	return out && [...new Set(out)].sort();
}

/**
 * The finite set of values a schema allows (`true | "active" | false`, `boolean | "all"`, a number
 * enum), for a dropdown in the settings editor; `null` when the values are open-ended.
 */
export function schemaChoices(schema: JsonSchema): unknown[] | null {
	if (schema.enum) return [...schema.enum];
	if ('const' in schema) return [schema.const];
	const alts = schema.anyOf ?? schema.oneOf;
	if (alts) {
		const parts = alts.map(schemaChoices);
		return parts.some((p) => p === null) ? null : [...new Map(parts.flat().map((v) => [JSON.stringify(v), v])).values()];
	}
	const types = schema.type === undefined ? [] : typeof schema.type === 'string' ? [schema.type] : schema.type;
	if (types.length && types.every((t) => t === 'boolean' || t === 'null')) return types.flatMap((t) => (t === 'boolean' ? [true, false] : [null]));
	return null;
}

/** A short type description for problem messages: `boolean or string`, `object`. */
export function describeSchema(schema: JsonSchema): string {
	if (schema.enum) return `one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`;
	const alts = schema.anyOf ?? schema.oneOf;
	if (alts) return alts.map(describeSchema).join(' or ');
	if (schema.type === undefined) return 'any value';
	return (typeof schema.type === 'string' ? [schema.type] : schema.type).join(' or ');
}
