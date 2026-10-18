// `when` clauses (VS Code: platform/contextkey/common/contextkey.ts). keybindings.json entries
// carry them as strings, so they are parsed here and evaluated against the live context keys
// (contextKeys.svelte.ts). Pure, so it is unit-testable.
//
// Grammar, loosest first: `a || b`, `a && b`, `!a`, `(a)`, and comparisons `key == value`,
// `key != value`, `key =~ /re/i`, `key in list`, `key not in list`, `key < n` (also <=, >, >=).
// Bare keys are truthy checks. `true` and `false` are constants.

export type Context = Readonly<Record<string, unknown>>;
export type WhenExpr = (ctx: Context) => boolean;

type Token = { kind: 'op'; value: string } | { kind: 'word'; value: string } | { kind: 'string'; value: string } | { kind: 'regex'; value: RegExp };

function tokenize(src: string): Token[] {
	const out: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		const two = src.slice(i, i + 3);
		const op = ['===', '!==', '&&', '||', '==', '!=', '=~', '<=', '>='].find((o) => two.startsWith(o));
		if (op) {
			out.push({ kind: 'op', value: op === '===' ? '==' : op === '!==' ? '!=' : op });
			i += op.length;
			// A regex literal follows `=~`.
			if (op === '=~') {
				while (/\s/.test(src[i] ?? '')) i++;
				if (src[i] !== '/') throw new Error(`expected /regex/ after =~ at ${i}`);
				let j = i + 1;
				let body = '';
				while (j < src.length && src[j] !== '/') {
					if (src[j] === '\\' && j + 1 < src.length) {
						body += src[j] + src[j + 1];
						j += 2;
					} else body += src[j++];
				}
				if (src[j] !== '/') throw new Error('unterminated regex');
				j++;
				let flags = '';
				while (/[gimsuy]/.test(src[j] ?? '')) flags += src[j++];
				out.push({ kind: 'regex', value: new RegExp(body, flags) });
				i = j;
			}
			continue;
		}
		if ('!()<>'.includes(c)) {
			out.push({ kind: 'op', value: c });
			i++;
			continue;
		}
		if (c === "'" || c === '"') {
			const end = src.indexOf(c, i + 1);
			if (end < 0) throw new Error('unterminated string');
			out.push({ kind: 'string', value: src.slice(i + 1, end) });
			i = end + 1;
			continue;
		}
		let j = i;
		while (j < src.length && !/[\s!()<>=&|'"]/.test(src[j])) j++;
		// `!=` and `==` inside a word end it; a lone `=` is part of nothing VS Code accepts.
		if (j === i) throw new Error(`unexpected "${c}" at ${i}`);
		out.push({ kind: 'word', value: src.slice(i, j) });
		i = j;
	}
	return out;
}

function literal(text: string): unknown {
	if (text === 'true') return true;
	if (text === 'false') return false;
	return text;
}

/** Parses a `when` clause. Throws on syntax errors; an empty clause is always true. */
export function parseWhen(src: string): WhenExpr {
	const tokens = tokenize(src);
	let pos = 0;
	const peek = () => tokens[pos];
	const isOp = (v: string) => peek()?.kind === 'op' && peek()!.value === v;
	const take = () => tokens[pos++];

	const value = (): unknown => {
		const t = take();
		if (!t || t.kind === 'op' || t.kind === 'regex') throw new Error('expected a value');
		return t.kind === 'string' ? t.value : literal(t.value);
	};

	const primary = (): WhenExpr => {
		if (isOp('!')) {
			take();
			const inner = primary();
			return (ctx) => !inner(ctx);
		}
		if (isOp('(')) {
			take();
			const inner = or();
			if (!isOp(')')) throw new Error('expected )');
			take();
			return inner;
		}
		const t = take();
		if (!t || t.kind !== 'word') throw new Error('expected a context key');
		if (t.value === 'true') return () => true;
		if (t.value === 'false') return () => false;
		const key = t.value;
		const next = peek();
		if (next?.kind === 'op' && (next.value === '==' || next.value === '!=')) {
			take();
			const v = value();
			const eq = (ctx: Context) => ctx[key] === v || (typeof v === 'string' && ctx[key] !== undefined && String(ctx[key]) === v);
			return next.value === '==' ? eq : (ctx) => !eq(ctx);
		}
		if (next?.kind === 'op' && next.value === '=~') {
			take();
			const re = take();
			if (re?.kind !== 'regex') throw new Error('expected a regex');
			return (ctx) => typeof ctx[key] === 'string' && re.value.test(ctx[key] as string);
		}
		if (next?.kind === 'op' && ['<', '<=', '>', '>='].includes(next.value)) {
			take();
			const n = Number(value());
			return (ctx) => {
				const v = Number(ctx[key]);
				if (!Number.isFinite(v)) return false;
				return next.value === '<' ? v < n : next.value === '<=' ? v <= n : next.value === '>' ? v > n : v >= n;
			};
		}
		const notIn = next?.kind === 'word' && next.value === 'not' && tokens[pos + 1]?.kind === 'word' && tokens[pos + 1].value === 'in';
		if ((next?.kind === 'word' && next.value === 'in') || notIn) {
			pos += notIn ? 2 : 1;
			const listKey = take();
			if (!listKey || listKey.kind !== 'word') throw new Error('expected a context key after in');
			const has = (ctx: Context) => {
				const list = ctx[listKey.value];
				const v = ctx[key];
				if (Array.isArray(list)) return list.includes(v);
				if (list && typeof list === 'object' && typeof v === 'string') return v in list;
				return false;
			};
			return notIn ? (ctx) => !has(ctx) : has;
		}
		return (ctx) => !!ctx[key];
	};

	const and = (): WhenExpr => {
		let left = primary();
		while (isOp('&&')) {
			take();
			const l = left;
			const r = primary();
			left = (ctx) => l(ctx) && r(ctx);
		}
		return left;
	};

	const or = (): WhenExpr => {
		let left = and();
		while (isOp('||')) {
			take();
			const l = left;
			const r = and();
			left = (ctx) => l(ctx) || r(ctx);
		}
		return left;
	};

	if (!tokens.length) return () => true;
	const expr = or();
	if (pos < tokens.length) throw new Error(`unexpected "${String(tokens[pos].value)}"`);
	return expr;
}

const cache = new Map<string, WhenExpr | null>();

/** Evaluates `when` against `ctx`. A clause that does not parse never matches (VS Code ignores the binding). */
export function evaluateWhen(when: string | undefined, ctx: Context): boolean {
	if (!when?.trim()) return true;
	let expr = cache.get(when);
	if (expr === undefined) {
		try {
			expr = parseWhen(when);
		} catch {
			expr = null;
		}
		cache.set(when, expr);
	}
	return expr ? expr(ctx) : false;
}
