/// <reference types="bun" />
// End-to-end check of the vendored grammars + Dark Modern theme through
// vscode-textmate and the oniguruma WASM, without Monaco.
import { beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';
import { INITIAL, Registry, parseRawGrammar, type IGrammar } from 'vscode-textmate';
import { flattenTheme, textMateRules } from './theme';

const dir = import.meta.dir;
const theme = flattenTheme('dark_modern.json', (p) => readFileSync(join(dir, 'themes', p), 'utf8'));
const files: Record<string, string> = {
	'source.ts': 'TypeScript.tmLanguage.json',
	'source.rust': 'rust.tmLanguage.json',
	'source.go': 'go.tmLanguage.json',
	'source.tsx': 'TypeScriptReact.tmLanguage.json',
	'source.makefile': 'make.tmLanguage.json'
};
let registry: Registry;

beforeAll(async () => {
	const wasm = readFileSync(createRequire(import.meta.url).resolve('vscode-oniguruma/release/onig.wasm'));
	await loadWASM({ data: wasm });
	registry = new Registry({
		onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
		theme: { name: theme.name, settings: textMateRules(theme) },
		loadGrammar: async (scope) =>
			files[scope]
				? parseRawGrammar(readFileSync(join(dir, 'grammars', files[scope]), 'utf8'), files[scope])
				: null
	});
});

/** Returns [text, foreground] per token, decoding the binary metadata like Monaco does. */
function colors(grammar: IGrammar, line: string): Record<string, string> {
	const map = registry.getColorMap();
	const { tokens } = grammar.tokenizeLine2(line, INITIAL);
	const out: Record<string, string> = {};
	for (let i = 0; i < tokens.length; i += 2) {
		const end = i + 2 < tokens.length ? tokens[i + 2] : line.length;
		const fg = (tokens[i + 1] & 0x00ff8000) >>> 15; // FOREGROUND_MASK / OFFSET
		const text = line.slice(tokens[i], end).trim();
		if (text) out[text] = map[fg];
	}
	return out;
}

test('TypeScript tokens get Dark Modern colors', async () => {
	const ts = (await registry.loadGrammar('source.ts'))!;
	const got = colors(ts, 'export const answer: number = 42; // done');
	expect(got['export']).toBe('#C586C0'); // keyword.control
	expect(got['const']).toBe('#569CD6'); // storage.type
	expect(got['answer']).toBe('#4FC1FF'); // variable.other.constant
	expect(got['number']).toBe('#4EC9B0'); // support.type.primitive
	expect(got['42']).toBe('#B5CEA8'); // constant.numeric
	expect(got['// done']).toBe('#6A9955'); // comment
});

test('Rust and Go grammars load and color keywords and functions', async () => {
	const rust = (await registry.loadGrammar('source.rust'))!;
	const r = colors(rust, 'fn main() { let s = "hi"; }');
	expect(r['fn']).toBe('#569CD6');
	expect(r['main']).toBe('#DCDCAA'); // entity.name.function
	const go = (await registry.loadGrammar('source.go'))!;
	const g = colors(go, 'func main() { return }');
	expect(g['func']).toBe('#569CD6');
	expect(g['return']).toBe('#C586C0');
});

test('TSX tags and Makefile targets are highlighted', async () => {
	const tsx = (await registry.loadGrammar('source.tsx'))!;
	const got = colors(tsx, 'const el = <Button disabled>ok</Button>;');
	expect(got['const']).toBe('#569CD6');
	expect(got['Button']).toBe('#4EC9B0'); // support.class.component.tsx
	const make = (await registry.loadGrammar('source.makefile'))!;
	const m = colors(make, 'build: deps # compile');
	expect(m['build']).toBe('#DCDCAA'); // entity.name.function.target
	expect(m['# compile']).toBe('#6A9955');
});
