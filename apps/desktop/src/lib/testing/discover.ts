// Finding tests without extensions (VS Code gets them from test controllers): the declarations in
// a test file read from its text (JavaScript/TypeScript describe/test/it, Rust #[test] functions
// and their modules, Go TestXxx functions, pytest test functions and classes), and the listings of
// `cargo test -- --list`, `go test -list .` and `pytest --collect-only -q`. Pure.

import type { Declared, Runner } from './model.ts';

// --- Text with strings and comments blanked ----------------------------------------------------

/**
 * `text` with comments turned into spaces and the contents of strings into `x`, the quotes and
 * newlines kept, so positions and line numbers stay and code patterns never match inside them.
 * `rust`: raw strings (r#"…"#), nested block comments and char literals (lifetimes stay code).
 */
export function maskCode(text: string, lang: 'js' | 'rust' | 'go' | 'python'): string {
	const out = text.split('');
	const blank = (from: number, to: number, ch = ' ') => {
		for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ch;
	};
	let i = 0;
	const n = text.length;
	while (i < n) {
		const c = text[i];
		const next = text[i + 1];
		if (lang !== 'python' && c === '/' && next === '/') {
			const end = text.indexOf('\n', i);
			const stop = end < 0 ? n : end;
			blank(i, stop);
			i = stop;
		} else if (lang !== 'python' && c === '/' && next === '*') {
			let depth = 1;
			let k = i + 2;
			while (k < n && depth > 0) {
				if (lang === 'rust' && text[k] === '/' && text[k + 1] === '*') (depth++, (k += 2));
				else if (text[k] === '*' && text[k + 1] === '/') (depth--, (k += 2));
				else k++;
			}
			blank(i, k);
			i = k;
		} else if (lang === 'python' && c === '#') {
			const end = text.indexOf('\n', i);
			const stop = end < 0 ? n : end;
			blank(i, stop);
			i = stop;
		} else if (lang === 'rust' && c === 'r' && /^r#*"/.test(text.slice(i, i + 8)) && !/\w/.test(text[i - 1] ?? '')) {
			const hashes = text.slice(i + 1).match(/^#*/)![0];
			const open = i + 1 + hashes.length;
			const close = text.indexOf(`"${hashes}`, open + 1);
			const end = close < 0 ? n : close + 1 + hashes.length;
			blank(open + 1, end - 1 - hashes.length, 'x');
			i = end;
		} else if (lang === 'rust' && c === "'") {
			// A char literal ('a', '\n', '\u{1F600}'); a lifetime ('a without a closing quote) is code.
			const m = text.slice(i).match(/^'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/);
			if (m) {
				blank(i + 1, i + m[0].length - 1, 'x');
				i += m[0].length;
			} else i++;
		} else if (lang === 'python' && (c === '"' || c === "'") && text.slice(i, i + 3) === c.repeat(3)) {
			const close = text.indexOf(c.repeat(3), i + 3);
			const end = close < 0 ? n : close + 3;
			blank(i + 3, end - 3, 'x');
			i = end;
		} else if (c === '"' || (c === "'" && lang !== 'rust' && lang !== 'go') || (c === '`' && (lang === 'js' || lang === 'go'))) {
			let k = i + 1;
			while (k < n && text[k] !== c) {
				if (text[k] === '\\' && c !== '`') k += 2;
				else if (text[k] === '\n' && c !== '`') break;
				else k++;
			}
			blank(i + 1, Math.min(k, n), 'x');
			i = k + 1;
		} else if (lang === 'go' && c === "'") {
			const m = text.slice(i).match(/^'(?:\\.[^']*|[^\\'\n])'/);
			if (m) blank(i + 1, i + m[0].length - 1, 'x');
			i += m ? m[0].length : 1;
		} else i++;
	}
	return out.join('');
}

function lineAt(text: string, index: number): number {
	let line = 1;
	for (let k = 0; k < index; k++) if (text.charCodeAt(k) === 10) line++;
	return line;
}

/** Index of the bracket closing the one at `open` in masked text, or the end. */
function matching(masked: string, open: number): number {
	const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
	const close = pairs[masked[open]];
	let depth = 0;
	for (let k = open; k < masked.length; k++) {
		const ch = masked[k];
		if (ch === masked[open]) depth++;
		else if (ch === close && --depth === 0) return k;
	}
	return masked.length;
}

// --- JavaScript / TypeScript ---------------------------------------------------------------------

const SUITES = new Set(['describe', 'suite', 'context']);
/** Modifiers that take their own arguments before the call: `test.each(table)('name', fn)`. */
const CALLED_MODIFIERS = new Set(['each', 'if', 'skipIf', 'runIf', 'for']);

/** Test files bun, vitest and jest pick up by default. */
export const isJsTestFile = (rel: string) => /(^|\/)(__tests__\/.*\.[cm]?[jt]sx?|[^/]*[._-](test|spec)\.[cm]?[jt]sx?)$/.test(rel) && !/(^|\/)node_modules\//.test(rel);

/**
 * describe/suite/context blocks and test/it calls with a literal name, nested by where they are
 * (VS Code's JS test extensions read the same). `.only`, `.skip`, `.todo`, `.each(…)` work.
 */
export function jsTests(text: string): Declared[] {
	const masked = maskCode(text, 'js');
	const call = /(?<![\w$.])(describe|suite|context|test|it)((?:\s*\.\s*[A-Za-z]+)*)\s*\(/g;
	type Found = Declared & { start: number; end: number };
	const found: Found[] = [];
	for (let m = call.exec(masked); m; m = call.exec(masked)) {
		const mods = m[2].split('.').map((s) => s.trim()).filter(Boolean);
		let open = m.index + m[0].length - 1;
		if (mods.some((x) => CALLED_MODIFIERS.has(x))) {
			// The modifier's arguments, then the real call.
			const after = matching(masked, open) + 1;
			const rest = masked.slice(after).match(/^\s*\(/);
			if (!rest) continue;
			open = after + rest[0].length - 1;
		}
		const arg = masked.slice(open + 1).match(/^\s*(['"`])/);
		if (!arg) continue;
		const q = open + 1 + arg[0].length - 1;
		const endQuote = masked.indexOf(arg[1], q + 1);
		if (endQuote < 0) continue;
		const name = text.slice(q + 1, endQuote);
		if (arg[1] === '`' && name.includes('${')) continue;
		const close = matching(masked, open);
		found.push({ name, line: lineAt(text, m.index), kind: SUITES.has(m[1]) ? 'suite' : 'test', children: [], start: open, end: close });
		call.lastIndex = endQuote + 1;
	}
	const roots: Declared[] = [];
	const stack: Found[] = [];
	for (const f of found) {
		while (stack.length && stack[stack.length - 1].end < f.start) stack.pop();
		let parent: Found | undefined;
		for (let k = stack.length - 1; k >= 0 && !parent; k--) if (stack[k].kind === 'suite') parent = stack[k];
		const node: Found = f;
		(parent ? parent.children : roots).push(node);
		stack.push(node);
	}
	const strip = (d: Declared): Declared => ({ name: d.name, line: d.line, kind: d.kind, children: d.children.map(strip) });
	return roots.map(strip);
}

/** Which runner runs a JS/TS test file: its imports first, then the package.json around it. */
export function jsRunnerFor(text: string, packageJson: string | null, hasBunLock: boolean): Runner | null {
	if (/from\s+['"]bun:test['"]|require\(\s*['"]bun:test['"]\s*\)/.test(text)) return 'bun';
	if (/from\s+['"]vitest['"]|require\(\s*['"]vitest['"]\s*\)/.test(text)) return 'vitest';
	if (/from\s+['"]@jest\/globals['"]/.test(text)) return 'jest';
	let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> } = {};
	try {
		pkg = packageJson ? JSON.parse(packageJson) : {};
	} catch {
		pkg = {};
	}
	const deps = { ...pkg.dependencies, ...pkg.devDependencies };
	const testScript = pkg.scripts?.test ?? '';
	if ('vitest' in deps || /\bvitest\b/.test(testScript)) return 'vitest';
	if ('jest' in deps || /\bjest\b/.test(testScript)) return 'jest';
	if (/\bbun\s+test\b/.test(testScript) || hasBunLock) return 'bun';
	return null;
}

// --- Rust ----------------------------------------------------------------------------------------

/** `#[test]`, `#[tokio::test]`, `#[rstest]`… but not `#[cfg(test)]`. */
const TEST_ATTRIBUTE = /^\s*(?:\w+\s*::\s*)*(?:test|rstest)\s*(?:\([\s\S]*\))?\s*$/;

/** The `#[test]` functions of a Rust file with their module path inside it (`mod tests { … }`). */
export function rustTests(text: string): { path: string[]; line: number; ignored: boolean }[] {
	const masked = maskCode(text, 'rust');
	const token = /\bmod\s+(\w+)\s*\{|#\s*!?\s*\[|\bfn\s+(\w+)|[{}]/g;
	const mods: { name: string; depth: number }[] = [];
	const out: { path: string[]; line: number; ignored: boolean }[] = [];
	let depth = 0;
	let pending: { test: boolean; ignored: boolean } = { test: false, ignored: false };
	for (let m = token.exec(masked); m; m = token.exec(masked)) {
		const t = m[0];
		if (m[1]) {
			depth++;
			mods.push({ name: m[1], depth });
			pending = { test: false, ignored: false };
		} else if (t.startsWith('#')) {
			const open = m.index + t.length - 1;
			const close = matching(masked, open);
			const attr = masked.slice(open + 1, close);
			if (TEST_ATTRIBUTE.test(attr)) pending.test = true;
			if (/^\s*ignore\b/.test(attr)) pending.ignored = true;
			token.lastIndex = close + 1;
		} else if (m[2]) {
			if (pending.test) out.push({ path: [...mods.map((x) => x.name), m[2]], line: lineAt(text, m.index), ignored: pending.ignored });
			pending = { test: false, ignored: false };
		} else if (t === '{') depth++;
		else if (t === '}') {
			while (mods.length && mods[mods.length - 1].depth >= depth) mods.pop();
			depth--;
		}
	}
	return out;
}

/** A Rust file's test target and module path inside its crate (`src/a/b.rs` → lib, `a::b`). `rel`
 * is relative to the crate (the Cargo.toml directory); null for files no target compiles as tests. */
export function rustTarget(rel: string, hasLib: boolean, packageName: string): { target: string; prefix: string[] } | null {
	const parts = rel.replace(/\.rs$/, '').split('/');
	if (parts[0] === 'tests') {
		if (parts.length === 2) return { target: `test:${parts[1]}`, prefix: [] };
		if (parts.length === 3 && parts[2] === 'main') return { target: `test:${parts[1]}`, prefix: [] };
		return null;
	}
	if (parts[0] !== 'src') return null;
	if (rel === 'src/lib.rs') return { target: 'lib', prefix: [] };
	if (rel === 'src/main.rs') return { target: `bin:${packageName}`, prefix: [] };
	if (parts[1] === 'bin') {
		if (parts.length === 3) return { target: `bin:${parts[2]}`, prefix: [] };
		if (parts.length >= 4) return { target: `bin:${parts[2]}`, prefix: parts.slice(3).filter((p) => p !== 'main' && p !== 'mod') };
		return null;
	}
	const prefix = parts.slice(1);
	if (prefix[prefix.length - 1] === 'mod') prefix.pop();
	return { target: hasLib ? 'lib' : `bin:${packageName}`, prefix };
}

/** `[package] name` from a Cargo.toml (null for a virtual workspace manifest). */
export function cargoPackageName(toml: string): string | null {
	let table = '';
	for (const raw of toml.split('\n')) {
		const line = raw.replace(/#.*$/, '').trim();
		const header = line.match(/^\[\s*([^\]]+?)\s*\]$/);
		if (header) {
			table = header[1];
			continue;
		}
		const name = line.match(/^name\s*=\s*"([^"]+)"/)?.[1];
		if (name && table === 'package') return name;
	}
	return null;
}

/**
 * `cargo test -- --list` output: per test binary (its crate name from `target/…/deps/<crate>-<hash>`
 * and the source it was built from), the test names.
 */
export function parseCargoList(output: string): { crate: string; source: string; tests: string[] }[] {
	const out: { crate: string; source: string; tests: string[] }[] = [];
	let cur: { crate: string; source: string; tests: string[] } | null = null;
	for (const line of output.split('\n')) {
		const run = line.match(/^\s*Running\s+(?:unittests\s+)?(\S+)\s+\(([^)]+)\)/);
		if (run) {
			const bin = run[2].slice(run[2].lastIndexOf('/') + 1).replace(/-[0-9a-f]+(\.exe)?$/, '');
			cur = { crate: bin, source: run[1], tests: [] };
			out.push(cur);
			continue;
		}
		const test = line.match(/^(\S+): test$/);
		if (test && cur) cur.tests.push(test[1]);
	}
	return out;
}

// --- Go ------------------------------------------------------------------------------------------

/** `func TestXxx(t *testing.T)`, `FuzzXxx` and `ExampleXxx` of a `_test.go` file (what `go test -run` matches). */
export function goTests(text: string): Declared[] {
	const masked = maskCode(text, 'go');
	const out: Declared[] = [];
	const re = /^func\s+((?:Test|Fuzz|Example)(?!\p{Ll})[\p{L}\p{N}_]*)\s*\(/gmu;
	for (let m = re.exec(masked); m; m = re.exec(masked)) out.push({ name: m[1], line: lineAt(text, m.index), kind: 'test', children: [] });
	return out;
}

/** `module` of a go.mod. */
export const goModule = (gomod: string) => gomod.match(/^\s*module\s+(\S+)/m)?.[1] ?? null;

/** `go test -list . ./...` output: test names per package import path. */
export function parseGoList(output: string): Map<string, string[]> {
	const out = new Map<string, string[]>();
	let names: string[] = [];
	for (const line of output.split('\n')) {
		const done = line.match(/^(?:ok|FAIL|\?)\s+(\S+)/);
		if (done) {
			if (names.length) out.set(done[1], names);
			names = [];
		} else if (/^(Test|Fuzz|Example|Benchmark)\w*$/.test(line.trim())) names.push(line.trim());
	}
	return out;
}

// --- pytest --------------------------------------------------------------------------------------

export const isPythonTestFile = (rel: string) => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(rel);

/** `def test_*` functions, at the top level or in `class Test*` (pytest's default collection rules). */
export function pythonTests(text: string): Declared[] {
	const masked = maskCode(text, 'python');
	const out: Declared[] = [];
	let cls: { decl: Declared; indent: number } | null = null;
	const lines = masked.split('\n');
	lines.forEach((line, i) => {
		const indent = line.match(/^\s*/)![0].length;
		if (line.trim() && cls && indent <= cls.indent) cls = null;
		const c = line.match(/^(\s*)class\s+(Test\w*)\s*[(:]/);
		if (c && c[1].length === 0) {
			const decl: Declared = { name: c[2], line: i + 1, kind: 'suite', children: [] };
			out.push(decl);
			cls = { decl, indent: 0 };
			return;
		}
		const f = line.match(/^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/);
		if (!f) return;
		const t: Declared = { name: f[2], line: i + 1, kind: 'test', children: [] };
		if (f[1].length === 0) out.push(t);
		else if (cls) cls.decl.children.push(t);
	});
	return out.filter((d) => d.kind === 'test' || d.children.length);
}

/** `pytest --collect-only -q` output: the node ids (`tests/test_a.py::TestB::test_c[1]`). */
export function parsePytestCollect(output: string): string[] {
	return output
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => /^[^\s:]+\.py::\S/.test(l));
}

/** Node ids of one file as a tree (class → function → parameter set), with lines from the text. */
export function pytestDeclared(nodeids: readonly string[], text: string | null): Declared[] {
	const lines = new Map<string, number>();
	if (text) {
		const walk = (ds: Declared[], prefix: string[]) => ds.forEach((d) => (lines.set([...prefix, d.name].join('::'), d.line), walk(d.children, [...prefix, d.name])));
		walk(pythonTests(text), []);
	}
	const roots: Declared[] = [];
	const child = (list: Declared[], name: string, kind: 'suite' | 'test', key: string) => {
		let d = list.find((x) => x.name === name);
		if (!d) {
			d = { name, line: lines.get(key) ?? lines.get(key.replace(/\[.*$/, '')) ?? 1, kind, children: [] };
			list.push(d);
		}
		return d;
	};
	for (const id of nodeids) {
		const parts = id.split('::').slice(1);
		let list = roots;
		const keyParts: string[] = [];
		parts.forEach((p, i) => {
			const last = i === parts.length - 1;
			const param = p.match(/^([^[]+)(\[.*\])$/);
			if (last && param) {
				keyParts.push(param[1]);
				const fn = child(list, param[1], 'suite', keyParts.join('::'));
				child(fn.children, p, 'test', keyParts.join('::'));
			} else {
				keyParts.push(p);
				const d = child(list, p, last ? 'test' : 'suite', keyParts.join('::'));
				list = d.children;
			}
		});
	}
	return roots;
}
