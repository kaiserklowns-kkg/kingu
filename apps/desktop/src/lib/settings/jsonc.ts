// JSONC (JSON with comments and trailing commas), as VS Code reads settings.json and theme files.
// Pure, so `bun test` can exercise it. `setProperty` edits one top-level property in place and
// keeps the rest of the text, comments included (VS Code: jsonc-parser `modify`, simplified).

/** Parses JSONC: drops // and block comments and trailing commas, leaving strings untouched. */
export function parseJsonc<T = unknown>(text: string): T {
	let out = '';
	let i = 0;
	const n = text.length;
	while (i < n) {
		const ch = text[i];
		if (ch === '"') {
			const start = i++;
			while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
			out += text.slice(start, ++i);
		} else if (ch === '/' && text[i + 1] === '/') {
			while (i < n && text[i] !== '\n') i++;
		} else if (ch === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end < 0 ? n : end + 2;
		} else {
			out += ch;
			i++;
		}
	}
	// Trailing commas: a comma followed only by whitespace before } or ].
	// Safe now that comments are gone; strings are skipped by matching them first.
	out = out.replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (m, str, close) => str ?? close);
	return JSON.parse(out) as T;
}

/** A settings file: empty or whitespace-only text is `{}`; anything but an object is an error. */
export function parseSettingsText(text: string): Record<string, unknown> {
	if (!text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()) return {};
	const value = parseJsonc<unknown>(text);
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('settings must be a JSON object');
	return value as Record<string, unknown>;
}

type Token = { kind: 'string' | 'punct' | 'value'; start: number; end: number; text: string };

/** Significant tokens (comments and whitespace skipped). */
function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	const n = text.length;
	while (i < n) {
		const ch = text[i];
		if (/\s/.test(ch)) i++;
		else if (ch === '/' && text[i + 1] === '/') {
			while (i < n && text[i] !== '\n') i++;
		} else if (ch === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end < 0 ? n : end + 2;
		} else if (ch === '"') {
			const start = i++;
			while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
			i = Math.min(i + 1, n);
			tokens.push({ kind: 'string', start, end: i, text: text.slice(start, i) });
		} else if ('{}[]:,'.includes(ch)) {
			tokens.push({ kind: 'punct', start: i, end: i + 1, text: ch });
			i++;
		} else {
			const start = i;
			while (i < n && !/[\s{}[\]:,"/]/.test(text[i])) i++;
			if (i === start) i++;
			tokens.push({ kind: 'value', start, end: i, text: text.slice(start, i) });
		}
	}
	return tokens;
}

type Property = { key: string; keyStart: number; valueStart: number; valueEnd: number; commaEnd: number | null };

/** Top-level properties of the root object, or null when the text has no root object. */
function topLevel(text: string): { open: number; close: number; props: Property[] } | null {
	const tokens = tokenize(text);
	if (tokens[0]?.text !== '{') return null;
	const props: Property[] = [];
	let i = 1;
	while (i < tokens.length) {
		const t = tokens[i];
		if (t.text === '}') return { open: tokens[0].start, close: t.start, props };
		if (t.kind !== 'string' || tokens[i + 1]?.text !== ':') return null;
		const key = JSON.parse(t.text) as string;
		let j = i + 2;
		let depth = 0;
		const valueStart = tokens[j]?.start ?? text.length;
		let valueEnd = valueStart;
		for (; j < tokens.length; j++) {
			const v = tokens[j];
			if (depth === 0 && (v.text === ',' || v.text === '}')) break;
			if (v.text === '{' || v.text === '[') depth++;
			else if (v.text === '}' || v.text === ']') depth--;
			valueEnd = v.end;
		}
		const comma = tokens[j]?.text === ',' ? tokens[j] : null;
		props.push({ key, keyStart: t.start, valueStart, valueEnd, commaEnd: comma ? comma.end : null });
		i = comma ? j + 1 : j;
	}
	return null;
}

function lineStart(text: string, at: number): number {
	let i = at;
	while (i > 0 && (text[i - 1] === ' ' || text[i - 1] === '\t')) i--;
	return i;
}

/**
 * Sets (or with `undefined`, removes) a top-level property, keeping comments and formatting
 * elsewhere. Text that is not an object is replaced by a new object.
 */
export function setProperty(text: string, key: string, value: unknown): string {
	const root = topLevel(text);
	const entry = (indent: string) => `${indent}${JSON.stringify(key)}: ${JSON.stringify(value)}`;
	if (!root) return value === undefined ? text : `{\n${entry('\t')}\n}\n`;
	const { props } = root;
	const idx = props.findIndex((p) => p.key === key);

	if (value === undefined) {
		if (idx < 0) return text;
		const p = props[idx];
		if (p.commaEnd !== null) {
			// Remove through the comma and the rest of that line's whitespace.
			let end = p.commaEnd;
			while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
			if (text[end] === '\n') end++;
			const start = lineStart(text, p.keyStart);
			const from = start > 0 && text[start - 1] === '\n' ? start : p.keyStart;
			return text.slice(0, from) + text.slice(end);
		}
		// Last property without a trailing comma: drop the previous property's comma too.
		const prev = props[idx - 1];
		if (prev) return text.slice(0, prev.valueEnd) + text.slice(p.valueEnd);
		return text.slice(0, root.open + 1) + '\n' + text.slice(p.valueEnd).replace(/^\s*/, '');
	}

	if (idx >= 0) {
		const p = props[idx];
		return text.slice(0, p.valueStart) + JSON.stringify(value) + text.slice(p.valueEnd);
	}

	const first = props[0];
	const indent = first ? text.slice(lineStart(text, first.keyStart), first.keyStart) || '\t' : '\t';
	const last = props[props.length - 1];
	if (!last) {
		const inner = text.slice(root.open + 1, root.close);
		const body = inner.trim() ? inner.replace(/\s*$/, '') + '\n' : '\n';
		return text.slice(0, root.open + 1) + body + entry(indent) + '\n' + text.slice(root.close);
	}
	const at = last.commaEnd ?? last.valueEnd;
	return text.slice(0, at) + (last.commaEnd === null ? ',' : '') + '\n' + entry(indent) + text.slice(at);
}
