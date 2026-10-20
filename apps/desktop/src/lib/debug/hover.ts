// The debug hover's pure parts (VS Code: debugUtils.getExactExpressionStartAndEnd and
// debugHover.findExpressionInStackFrame): the expression under the mouse, and its value looked up
// in the stopped frame's scopes when the adapter cannot evaluate for hovers.

import type { Scope, Variable } from './protocol.ts';

/**
 * The expression around 1-based columns `looseStart..looseEnd` of `line` (VS Code's rule):
 * `a.b.c` hovered on `b` is `a.b`; `obj->x`, `A::B`, `a?.b` and `...spread` work. Columns are
 * 1-based and inclusive; null when there is nothing there.
 */
export function expressionAt(line: string, looseStart: number, looseEnd = looseStart): { expression: string; start: number; end: number } | null {
	const expression = /([^()[\]{}<>\s+\-/%~#^;=|,`!]|->)+/g;
	let matching: string | undefined;
	let startOffset = 0;
	for (let m = expression.exec(line); m; m = expression.exec(line)) {
		const start = m.index + 1;
		const end = start + m[0].length;
		if (start <= looseStart && end >= looseEnd) {
			matching = m[0];
			startOffset = start;
			break;
		}
	}
	if (!matching) return null;
	const spread = matching.match(/^\.\.\.(.+)/);
	if (spread) {
		matching = spread[1];
		startOffset += 3;
	}
	// Cut after the word under the cursor.
	const sub = /(\w|\p{L}|\p{M})+/gu;
	let last: RegExpExecArray | null = null;
	for (let s = sub.exec(matching); s; s = sub.exec(matching)) {
		last = s;
		if (s.index + 1 + startOffset + s[0].length >= looseEnd) break;
	}
	if (last) matching = matching.substring(0, last.index + last[0].length);
	const trimmed = matching.replace(/[.:?]+$/, '');
	if (!trimmed || !/[\w\p{L}$]/u.test(trimmed)) return null;
	return { expression: trimmed, start: startOffset, end: startOffset + trimmed.length - 1 };
}

/**
 * VS Code's findExpressionInStackFrame: `a.b.c` split on dots, each name looked up among the
 * children of the previous one, in every non-expensive scope; shown only when every scope that
 * has it agrees on the value.
 */
export async function hoverFromVariables(expression: string, scopes: readonly Scope[], children: (ref: number) => Promise<Variable[]>): Promise<Variable | null> {
	const names = expression
		.split('.')
		.map((w) => w.trim())
		.filter(Boolean);
	if (!names.length) return null;
	const find = async (ref: number, rest: string[]): Promise<Variable | null> => {
		if (ref <= 0) return null;
		const matches = (await children(ref)).filter((v) => v.name === rest[0]);
		if (matches.length !== 1) return null;
		return rest.length === 1 ? matches[0] : find(matches[0].variablesReference, rest.slice(1));
	};
	const found = (await Promise.all(scopes.filter((s) => !s.expensive).map((s) => find(s.variablesReference, names)))).filter((v): v is Variable => !!v);
	return found.length && found.every((v) => v.value === found[0].value) ? found[0] : null;
}
