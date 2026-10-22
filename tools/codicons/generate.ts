// Writes apps/desktop/src/lib/workbench/codiconData.ts from a kingu-old (VS Code fork) checkout:
//
// - CODICON_CHARS: every codicon id and its code point in codicon.ttf (src/vs/base/common/
//   codiconsLibrary.ts and the derived ids of codicons.ts), what VS Code registers first.
// - ICON_DEFAULTS: the icons the workbench registers on top (`registerIcon('chat-view-icon',
//   Codicon.chatSparkle, …)`), each with the icon it defaults to. A product icon theme that has no
//   glyph for an id follows this chain, as VS Code's ProductIconThemeData.getIcon does.
//
// Given the captured old window (old-dom.json, its `--vscode-icon-*` variables), it checks every
// id the window resolved against what Kingu resolves and stops on a mismatch; ids registered by
// extensions there (no source in src/vs) are taken from it.
//
//   bun tools/codicons/generate.ts /path/to/kingu-old [/path/to/old-dom.json]

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OLD = process.argv[2];
const DOM = process.argv[3];
if (!OLD) throw new Error('usage: bun tools/codicons/generate.ts <kingu-old> [old-dom.json]');
const OUT = join(import.meta.dir, '../../apps/desktop/src/lib/workbench/codiconData.ts');
const THEME = join(import.meta.dir, '../../apps/desktop/src/lib/assets/icons/kingu-lucide-icon-theme.json');

// --- Codicons: `name: register('id', 0xea60)` or `register('id', 'other-id')`.
const chars: Record<string, number> = {};
const camel: Record<string, string> = {};
for (const file of ['codiconsLibrary.ts', 'codicons.ts']) {
	const src = readFileSync(join(OLD, 'src/vs/base/common', file), 'utf8');
	for (const m of src.matchAll(/(\w+):\s*register\('([\w-]+)',\s*(0x[0-9a-fA-F]+|'[\w-]+')\)/g)) {
		const [, name, id, ch] = m;
		const cp = ch.startsWith('0x') ? parseInt(ch, 16) : chars[ch.slice(1, -1)];
		if (cp === undefined) throw new Error(`${id} references an unknown codicon ${ch}`);
		chars[id] = cp;
		camel[name] = id;
	}
}

// --- Registered icons: `[export] const v = registerIcon('id', Codicon.x | v2, …)`.
const files: string[] = [];
const walk = (dir: string) => {
	for (const n of readdirSync(dir)) {
		const p = join(dir, n);
		if (statSync(p).isDirectory()) walk(p);
		else if (n.endsWith('.ts') && !n.endsWith('.test.ts') && !n.endsWith('.d.ts')) files.push(p);
	}
};
walk(join(OLD, 'src/vs'));
const vars: Record<string, string> = {};
const raw: [string, string][] = [];
for (const f of files) {
	const src = readFileSync(f, 'utf8');
	if (!src.includes('registerIcon(')) continue;
	for (const m of src.matchAll(/(?:const\s+(\w+)\s*=\s*)?registerIcon\(\s*'([\w-]+)',\s*([\w.]+)/g)) {
		const [, v, id, def] = m;
		if (v) vars[v] = id;
		raw.push([id, def]);
	}
}
// A codicon's id is registered first, so registering it again changes nothing; an id registered
// twice keeps the registration that loaded first, which only the old window tells (see below).
const candidates: Record<string, string[]> = {};
const unresolved: string[] = [];
for (const [id, def] of raw) {
	const target = def.startsWith('Codicon.') ? camel[def.slice(8)] : vars[def];
	if (id in chars || target === id) continue;
	if (target) (candidates[id] ??= []).includes(target) || candidates[id].push(target);
	else unresolved.push(`${id} → ${def}`);
}
const defaults: Record<string, string> = Object.fromEntries(Object.entries(candidates).map(([id, c]) => [id, c[0]]));

// --- Check against the captured window.
type Theme = { fonts: { id: string }[]; iconDefinitions: Record<string, { fontCharacter: string; fontId?: string }> };
const theme = JSON.parse(readFileSync(THEME, 'utf8')) as Theme;
const themeChar = (id: string) => {
	const d = theme.iconDefinitions[id];
	return d && parseInt(d.fontCharacter.replace(/^\\/, ''), 16);
};
const resolve = (id: string): [string, number] | undefined => {
	for (let cur: string | undefined = id, n = 0; cur && n < 16; cur = defaults[cur], n++) {
		const t = themeChar(cur);
		if (t) return ['pi-kingu-lucide', t];
		if (!(cur in defaults) && cur in chars) return ['codicon', chars[cur]];
	}
	return undefined;
};
if (DOM) {
	const dom = JSON.parse(readFileSync(DOM, 'utf8')) as { vars: Record<string, string> };
	const seen: Record<string, { c?: number; f?: string }> = {};
	for (const [k, v] of Object.entries(dom.vars)) {
		const m = /^--vscode-icon-(.+)-(content|font-family)$/.exec(k);
		if (!m) continue;
		const e = (seen[m[1]] ??= {});
		if (m[2] === 'content') e.c = parseInt(v.replace(/['"\\]/g, ''), 16);
		else e.f = v.replace(/['"]/g, '');
	}
	const bad: string[] = [];
	for (const [id, e] of Object.entries(seen)) {
		const matches = () => {
			const r = resolve(id);
			return !!r && r[0] === e.f && r[1] === e.c;
		};
		if (matches() || (candidates[id] ?? []).some((c) => ((defaults[id] = c), matches()))) continue;
		const r = resolve(id);
		// Contributed by an extension in the old window: no source here; a codicon glyph is the same in both themes.
		if (!r && e.f === 'codicon' && e.c !== undefined && !(id in defaults)) {
			chars[id] = e.c;
			continue;
		}
		bad.push(`${id}: old ${e.f} ${e.c?.toString(16)}, ours ${r?.[0]} ${r?.[1]?.toString(16)}`);
	}
	if (bad.length) throw new Error(`resolution differs from the old window:\n${bad.join('\n')}`);
	console.log(`checked ${Object.keys(seen).length} icons against ${DOM}`);
}
if (unresolved.length) console.log(`unresolved registerIcon defaults (skipped):\n${unresolved.join('\n')}`);

const hex = (n: number) => `0x${n.toString(16)}`;
const sortObj = <T>(o: Record<string, T>) => Object.keys(o).sort().map((k) => [k, o[k]] as const);
const out = `// Generated by tools/codicons/generate.ts from kingu-old's codicon sources and registered icons; do not edit.
// The ids and code points of codicon.ttf (@vscode/codicons: the font CC BY 4.0, the ids MIT) and the workbench's registered icons.

/** Codicon id → code point in codicon.ttf (VS Code's codiconsLibrary.ts and derived codicons). */
export const CODICON_CHARS: Record<string, number> = {
${sortObj(chars).map(([k, v]) => `\t'${k}': ${hex(v)},`).join('\n')}
};

/** Registered icon id → the icon it defaults to (VS Code's \`registerIcon(id, Codicon.x)\`). */
export const ICON_DEFAULTS: Record<string, string> = {
${sortObj(defaults).map(([k, v]) => `\t'${k}': '${v}',`).join('\n')}
};
`;
writeFileSync(OUT, out);
console.log(`wrote ${OUT}: ${Object.keys(chars).length} codicons, ${Object.keys(defaults).length} registered icons`);
