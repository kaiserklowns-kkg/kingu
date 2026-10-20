// Writes the settings parity fixture (apps/desktop/src/lib/settings/testdata/vscode-settings.json)
// from VS Code's full extracted schema (extract.ts): key → type, default and enum, for the setting
// prefixes of the areas Kingu has. One line per key, sorted, so a VS Code update shows as a
// readable diff.
//
//   bun tools/vscode-settings/fixture.ts <full-schema.json>

import { join } from 'node:path';
import { schemaTypes, type JsonSchema } from '../../apps/desktop/src/lib/settings/jsonSchema.ts';

/** Setting prefixes of the areas Kingu has (the fixture keeps only these). */
export const PREFIXES = ['editor.', 'diffEditor.', 'workbench.', 'window.', 'files.', 'explorer.', 'search.', 'scm.', 'git.', 'terminal.', 'debug.', 'breadcrumbs.', 'problems.', 'keyboard.', 'application.', 'http.', 'timeline.', 'merge-conflict.', 'task.', 'outline.', 'typescript.', 'javascript.', 'js/ts.', 'css.', 'scss.', 'less.', 'html.', 'json.', 'output.', 'zenMode.'];

type Schema = Record<string, unknown> & { default?: unknown; enum?: unknown[] };

export async function writeFixture(full: Record<string, Schema>): Promise<number> {
	const keys = Object.keys(full)
		.filter((k) => PREFIXES.some((p) => k.startsWith(p)))
		.sort();
	// `type`: the sorted top-level type(s) (from `type`, else `enum` or `anyOf`), a string when one.
	const typeOf = (s: Schema) => {
		const t = schemaTypes(s as JsonSchema);
		return t && t.length === 1 ? t[0] : t;
	};
	const lines = keys.map((k) => {
		const s = full[k];
		const entry: Record<string, unknown> = { type: typeOf(s), default: s.default ?? null };
		// Theme pickers list the installed themes at runtime: their schema enum is empty.
		if (Array.isArray(s.enum) && s.enum.length) entry.enum = s.enum;
		return `\t${JSON.stringify(k)}: ${JSON.stringify(entry)}`;
	});
	await Bun.write(join(import.meta.dir, '../../apps/desktop/src/lib/settings/testdata/vscode-settings.json'), `{\n${lines.join(',\n')}\n}\n`);
	return keys.length;
}

if (import.meta.main) {
	const [fullPath] = process.argv.slice(2);
	if (!fullPath) throw new Error('usage: fixture.ts <full-schema.json>');
	console.log(`fixture: ${await writeFixture(JSON.parse(await Bun.file(fullPath).text()))} settings`);
}
