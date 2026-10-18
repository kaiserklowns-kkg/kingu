// Regenerates every apps/desktop/src/lib/settings/vscode/<area>.ts from its spec in specs/ (which
// keys Kingu registers, their settings group and Kingu's Thai text) and VS Code's full extracted
// schema (extract.ts), then the editor option map:
//
//   bun tools/vscode-settings/genAll.ts <full-schema.json> [area …]

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const [schema, ...only] = process.argv.slice(2);
if (!schema) throw new Error('usage: genAll.ts <full-schema.json> [area …]');
const specs = join(import.meta.dir, 'specs');
const areas = only.length ? only : readdirSync(specs).map((f) => f.replace(/\.json$/, ''));
for (const area of areas) {
	const r = Bun.spawnSync([process.execPath, join(import.meta.dir, 'gen.ts'), schema, join(specs, `${area}.json`)], { stdout: 'inherit', stderr: 'inherit' });
	if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
}
const map = Bun.spawnSync([process.execPath, join(import.meta.dir, 'editorMap.ts')], { stdout: 'inherit', stderr: 'inherit' });
process.exit(map.exitCode ?? 0);
