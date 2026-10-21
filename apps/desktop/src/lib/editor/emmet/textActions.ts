// Emmet actions that work on plain text (VS Code emmet: incrementDecrement.ts, evaluateMathExpression.ts,
// editPoint.ts, and the stylesheet halves of toggleComment / selectItem). Pure; offsets are
// 0-based into the line or the text.

/** The number around `pos` in `line` (a `-` sign and one `.` included), as [start, end), or undefined. */
export function numberAt(line: string, pos: number): [number, number] | undefined {
	let start = pos;
	let end = pos;
	let dot = false;
	let minus = false;
	while (start > 0) {
		const c = line[start - 1];
		if (c === '-') {
			minus = true;
			start--;
			break;
		}
		if (c === '.' && !dot) dot = true;
		else if (!/\d/.test(c)) break;
		start--;
	}
	if (line[end] === '-' && !minus) end++;
	while (end < line.length) {
		const c = line[end];
		if (c === '.' && !dot && /\d/.test(line[end + 1] ?? '')) dot = true;
		else if (!/\d/.test(c)) break;
		end++;
	}
	if (start === end || Number.isNaN(parseFloat(line.slice(start, end)))) return undefined;
	return [start, end];
}

/** The number text after adding `delta`: its decimals and leading zeros kept (VS Code update()). */
export function addToNumber(text: string, delta: number): string {
	const decimals = /\.(\d+)$/.exec(text)?.[1].length ?? 1;
	let out = (parseFloat(text) + delta).toFixed(decimals).replace(/\.0+$/, '');
	const zeros = /^-?(0\d+)/.exec(text);
	if (zeros) out = out.replace(/^(-?)(\d+)/, (_, sign: string, digits: string) => sign + '0'.repeat(Math.max(0, zeros[1].length - digits.length)) + digits);
	// `.5` stays without a leading zero.
	if (/^-?\./.test(text)) out = out.replace(/^(-?)0+/, '$1');
	return out;
}

/** A safe arithmetic evaluator: + - * / % ** ^ (power), parentheses, unary minus, decimals. */
export function evaluate(expr: string): number | undefined {
	let i = 0;
	const s = expr.replace(/\s+/g, '');
	const peek = () => s[i];
	const num = (): number | undefined => {
		if (peek() === '(') {
			i++;
			const v = add();
			if (peek() !== ')') return undefined;
			i++;
			return v;
		}
		if (peek() === '-') {
			i++;
			const v = power();
			return v === undefined ? undefined : -v;
		}
		if (peek() === '+') {
			i++;
			return power();
		}
		const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
		if (!m) return undefined;
		i += m[0].length;
		return parseFloat(m[0]);
	};
	const power = (): number | undefined => {
		const base = num();
		if (base === undefined) return undefined;
		if (peek() === '^' || (peek() === '*' && s[i + 1] === '*')) {
			i += peek() === '^' ? 1 : 2;
			const exp = power();
			return exp === undefined ? undefined : base ** exp;
		}
		return base;
	};
	const mul = (): number | undefined => {
		let v = power();
		while (v !== undefined && (peek() === '*' || peek() === '/' || peek() === '%' || peek() === '\\')) {
			const op = s[i++];
			const r = power();
			if (r === undefined) return undefined;
			v = op === '*' ? v * r : op === '/' ? v / r : op === '%' ? v % r : Math.floor(v / r);
		}
		return v;
	};
	const add = (): number | undefined => {
		let v = mul();
		while (v !== undefined && (peek() === '+' || peek() === '-')) {
			const op = s[i++];
			const r = mul();
			if (r === undefined) return undefined;
			v = op === '+' ? v + r : v - r;
		}
		return v;
	};
	const v = add();
	return v !== undefined && i === s.length && Number.isFinite(v) ? v : undefined;
}

/** The math expression ending at `pos` in `line` (VS Code's extract, backwards from the cursor), as [start, end). */
export function mathExpressionBefore(line: string, pos: number): [number, number] | undefined {
	let start = pos;
	let depth = 0;
	while (start > 0) {
		const c = line[start - 1];
		if (c === ')') depth++;
		else if (c === '(') {
			if (depth === 0) break;
			depth--;
		} else if (!/[\d.+\-*/%^\\ ]/.test(c)) break;
		start--;
	}
	// Leading spaces and operators are not part of it.
	while (start < pos && /[ +*/%^\\]/.test(line[start])) start++;
	for (let s = start; s < pos; s++) {
		if (line[s] === ' ') continue;
		if (evaluate(line.slice(s, pos)) !== undefined && /\d/.test(line.slice(s, pos))) return [s, pos];
	}
	return undefined;
}

/** How Evaluate Math Expression writes a result: integers plain, others to at most 10 decimals. */
export const formatResult = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(10))));

/** Next/previous edit point (VS Code editPoint.ts): an empty attribute value `""`, the gap between
 * `><`, or an empty (whitespace-only) line. `lines`, the cursor's line and column; the result is
 * a [line, column] position, 0-based. */
export function editPoint(lines: readonly string[], line: number, column: number, direction: 1 | -1): [number, number] | undefined {
	for (let n = line; n >= 0 && n < lines.length; n += direction) {
		let content = lines[n];
		if (n !== line && content.length && !content.trim()) return [n, content.length];
		if (n === line && direction < 0) content = content.slice(0, column);
		const from = n === line ? column : 0;
		const attr = direction > 0 ? content.indexOf('""', from) : content.lastIndexOf('""');
		const tag = direction > 0 ? content.indexOf('><', from) : content.lastIndexOf('><');
		const found = attr > -1 && tag > -1 ? (direction > 0 ? Math.min(attr, tag) : Math.max(attr, tag)) : attr > -1 ? attr : tag;
		if (found > -1) return [n, found + 1];
	}
	return undefined;
}

export type CssEdit = { start: number; end: number; text: string };

/** Toggle Comment (stylesheet): uncomment the comment around the cursor, else comment the
 * selection or the declaration (or rule) at the cursor. */
export function toggleCssComment(text: string, s: number, e: number): CssEdit | undefined {
	for (const m of text.matchAll(/\/\*[\s\S]*?(?:\*\/|$)/g)) {
		const start = m.index;
		const end = start + m[0].length;
		if (start <= s && e <= end) return { start, end, text: m[0].replace(/^\/\*\s?/, '').replace(/\s?\*\/$/, '') };
	}
	let [start, end] = [s, e];
	if (s === e) {
		// The declaration around the cursor: from after `{`/`;`/`}` to its `;` (or the line's end).
		const before = Math.max(text.lastIndexOf('{', s - 1), text.lastIndexOf(';', s - 1), text.lastIndexOf('}', s - 1), text.lastIndexOf('\n', s - 1));
		start = before + 1;
		while (/\s/.test(text[start] ?? '') && start < s) start++;
		const semi = text.indexOf(';', s);
		const nl = text.indexOf('\n', s);
		const brace = text.indexOf('}', s);
		const stops = [semi >= 0 ? semi + 1 : -1, nl, brace].filter((x) => x >= 0);
		end = stops.length ? Math.min(...stops) : text.length;
		if (text.slice(start, end).trim().endsWith('{')) {
			// On a selector: the whole rule.
			let depth = 0;
			for (let i = start; i < text.length; i++) {
				if (text[i] === '{') depth++;
				else if (text[i] === '}' && --depth === 0) {
					end = i + 1;
					break;
				}
			}
		}
		while (end > start && /\s/.test(text[end - 1])) end--;
		if (end <= start) return undefined;
	}
	return { start, end, text: `/* ${text.slice(start, end)} */` };
}

/** The ranges Select Next/Previous Item steps through in a stylesheet: selectors, declarations, values, value parts. */
export function cssItems(text: string): [number, number][] {
	const out: [number, number][] = [];
	const clean = text.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
	let segStart = 0;
	for (let i = 0; i <= clean.length; i++) {
		const c = clean[i];
		if (c !== '{' && c !== ';' && c !== '}' && i < clean.length) continue;
		const seg = clean.slice(segStart, i);
		const lead = seg.length - seg.trimStart().length;
		const body = seg.trim();
		if (body) {
			const start = segStart + lead;
			const end = start + body.length;
			if (c === '{') out.push([start, end]);
			else {
				const colon = body.indexOf(':');
				out.push([start, end]);
				if (colon > 0) {
					const raw = body.slice(colon + 1);
					const vStart = start + colon + 1 + (raw.length - raw.trimStart().length);
					const value = raw.trim();
					if (value) {
						out.push([vStart, vStart + value.length]);
						const parts = [...value.matchAll(/[^\s,()]+(?:\([^)]*\))?/g)];
						if (parts.length > 1) for (const p of parts) out.push([vStart + p.index, vStart + p.index + p[0].length]);
					}
				}
			}
		}
		segStart = i + 1;
	}
	return out.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
}
