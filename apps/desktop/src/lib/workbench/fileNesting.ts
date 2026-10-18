// explorer.fileNesting (VS Code: contrib/files/common/explorerFileNestingTrie.ts): related files
// in a folder show under one parent file (`a.ts` → `a.js`, `a.d.ts`). A parent pattern holds at
// most one `*`, which `${capture}` in the child patterns refers to; `${basename}`, `${extname}`
// and `${dirname}` describe the parent. Nesting is flattened to two levels: a file nested under a
// nested file goes to the root parent. Pure.

type Pattern = { re: RegExp; star: boolean };
type Rule = { parent: Pattern; children: string[] };

const SUBSTITUTION = /\$[({](capture|basename|dirname|extname)[)}]/g;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A key with at most one `*` (VS Code's tries do not support more; extra stars are literal). */
function compile(pattern: string): Pattern {
	const i = pattern.indexOf('*');
	if (i < 0) return { re: new RegExp(`^${escape(pattern)}$`), star: false };
	return { re: new RegExp(`^${escape(pattern.slice(0, i))}([\\s\\S]*)${escape(pattern.slice(i + 1))}$`), star: true };
}

function attributes(name: string, dirname: string) {
	const dot = name.lastIndexOf('.');
	return dot < 1 ? { basename: name, extname: '', dirname } : { basename: name.slice(0, dot), extname: name.slice(dot + 1), dirname };
}

/** `explorer.fileNesting.patterns` as rules (empty keys and values are skipped, like VS Code). */
export function nestingRules(patterns: Readonly<Record<string, unknown>>, caseSensitive: boolean): Rule[] {
	const fold = (s: string) => (caseSensitive ? s : s.toLowerCase());
	return Object.entries(patterns)
		.filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[0] && !!e[1])
		.map(([parent, children]) => ({
			parent: compile(fold(parent.trim())),
			children: children
				.split(',')
				.map((c) => fold(c.replace(/​/g, '').trim()))
				.filter(Boolean)
		}));
}

/**
 * Nests the file `names` of the folder `dirname`: parent name → its nested names. Only parents
 * with at least one nested file are listed; names are compared case-insensitively unless
 * `caseSensitive` (macOS file systems are not).
 */
export function nestFiles(names: readonly string[], dirname: string, patterns: Readonly<Record<string, unknown>>, caseSensitive: boolean): Map<string, string[]> {
	const rules = nestingRules(patterns, caseSensitive);
	const fold = (s: string) => (caseSensitive ? s : s.toLowerCase());
	const keyOf = new Map(names.map((n) => [fold(n), n]));
	const dir = fold(dirname);
	// child pattern (substituted for one parent) → that parent
	const childPatterns: { pattern: Pattern; parent: string }[] = [];
	for (const name of keyOf.keys()) {
		const attrs = attributes(name, dir);
		for (const rule of rules) {
			const m = rule.parent.re.exec(name);
			if (!m) continue;
			const capture = rule.parent.star ? m[1] : '';
			for (const child of rule.children) {
				const substituted = child.replace(SUBSTITUTION, (_, kind: 'capture' | 'basename' | 'dirname' | 'extname') => (kind === 'capture' ? capture : attrs[kind]));
				childPatterns.push({ pattern: compile(substituted), parent: name });
			}
		}
	}
	const parentsOf = (name: string) => new Set(childPatterns.filter((c) => c.parent !== name && c.pattern.re.test(name)).map((c) => c.parent));
	const roots = (name: string, seen = new Set<string>()): string[] => {
		if (seen.has(name)) return [];
		seen.add(name);
		const parents = parentsOf(name);
		return parents.size ? [...parents].flatMap((p) => roots(p, seen)) : [name];
	};
	const out = new Map<string, string[]>();
	for (const name of keyOf.keys()) {
		for (const root of roots(name).length ? roots(name) : [name]) {
			if (root === name) continue;
			const parent = keyOf.get(root)!;
			out.set(parent, [...(out.get(parent) ?? []), keyOf.get(name)!]);
		}
	}
	return out;
}
