// Extracts VS Code's settings schema from a VS Code source checkout, for the settings parity test
// (apps/desktop/src/lib/settings/vscodeParity.test.ts) and for writing Kingu's VS Code settings.
//
// It evaluates VS Code's own configuration contributions (the files in sources.json, relative to
// src/vs) with Bun, so defaults, enums and descriptions are the real computed values (on this
// platform), then adds built-in extensions' contributes.configuration (Git, Merge Conflict, language features; package.json + nls).
//
//   bun add --no-save @happy-dom/global-registrator@15   # once, the DOM the browser files expect
//   cd tools/vscode-settings && bun --preload ./preload.ts --tsconfig-override ./tsconfig.json \
//     extract.ts <vscode-checkout> <full-schema-out.json>
//
// Writes the full schema to the second argument (not committed; gen.ts reads it) and the small
// parity fixture (fixture.ts: key → type, default and enum, for the setting prefixes Kingu
// implements) to apps/desktop/src/lib/settings/testdata/vscode-settings.json.

import { join } from 'node:path';
import { writeFixture } from './fixture.ts';

const [checkout, fullOut] = process.argv.slice(2);
if (!checkout || !fullOut) throw new Error('usage: extract.ts <vscode-checkout> <full-schema-out.json>');
const VS = join(checkout, 'src/vs') + '/';

// Defaults are computed for macOS (Kingu's main platform). Settings VS Code registers only on Linux
// (`window.menuBarVisibility`, `editor.selectionClipboard`, …) come from a second run as Linux,
// which this script starts itself (EXTRACT_PLATFORM=linux, schema only, no fixture).
const PLATFORM = process.env.EXTRACT_PLATFORM ?? 'darwin';

// Globals the electron-browser files read at import time.
const g = globalThis as Record<string, unknown>;
g._VSCODE_FILE_ROOT = `file://${checkout}/out/`;
const stub: unknown = new Proxy(function () {}, {
	get: (_t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => '' : stub),
	apply: () => stub
});
g.vscode = {
	ipcRenderer: stub,
	ipcMessagePort: stub,
	webFrame: stub,
	webUtils: stub,
	context: stub,
	process: { platform: PLATFORM, env: {}, versions: {}, cwd: () => '/', arch: process.arch, type: 'renderer', execPath: '/' }
};

type Schema = Record<string, unknown> & { type?: unknown; default?: unknown };

const files: string[] = JSON.parse(await Bun.file(join(import.meta.dir, 'sources.json')).text());
const { Registry } = await import(VS + 'platform/registry/common/platform.ts');
const { Extensions } = await import(VS + 'platform/configuration/common/configurationRegistry.ts');
const registry = Registry.as(Extensions.Configuration) as { getConfigurationProperties(): Record<string, Schema> };
const origin: Record<string, string> = {};
for (const f of files) {
	try {
		const m = await import(VS + f);
		if (m.registerTerminalConfiguration) await m.registerTerminalConfiguration(async () => []);
		if (m.registerTerminalPlatformConfiguration) m.registerTerminalPlatformConfiguration();
	} catch (e) {
		console.error(`skipped ${f}: ${e instanceof Error ? e.message : e}`);
	}
	for (const k of Object.keys(registry.getConfigurationProperties())) origin[k] ??= `src/vs/${f}`;
}

// Registered at runtime by workbench contributions rather than at import time.
{
	const reg = registry as unknown as { registerConfiguration(node: unknown): void };
	const codeActions = await import(VS + 'workbench/contrib/codeActions/browser/codeActionsContribution.ts');
	reg.registerConfiguration(codeActions.editorConfiguration);
	origin['editor.codeActionsOnSave'] = 'src/vs/workbench/contrib/codeActions/browser/codeActionsContribution.ts';
	// editorConfiguration.ts DynamicEditorConfigurations (local window: no remote authority).
	const { getLargeFileConfirmationLimit } = await import(VS + 'platform/files/common/files.ts');
	reg.registerConfiguration({
		id: 'workbench',
		properties: {
			'workbench.editorLargeFileConfirmation': {
				type: 'number',
				default: getLargeFileConfirmationLimit(undefined) / (1024 * 1024),
				minimum: 1,
				scope: 5,
				markdownDescription: 'Controls the minimum size of a file in MB before asking for confirmation when opening in the editor. Note that this setting may not apply to all editor types and environments.'
			}
		}
	});
	origin['workbench.editorLargeFileConfirmation'] = 'src/vs/workbench/browser/parts/editor/editorConfiguration.ts';
}

const full: Record<string, Schema> = {};
for (const [k, s] of Object.entries(registry.getConfigurationProperties())) {
	const { section: _section, defaultDefaultValue: _d, source: _s, ...rest } = s;
	full[k] = { ...rest, origin: origin[k] };
}

// Built-in extensions whose settings Kingu has (Git, Merge Conflict, and the settings sections of the language
// servers Kingu runs): contributes.configuration with %nls% placeholders.
const EXTENSIONS = ['git', 'merge-conflict', 'typescript-language-features', 'css-language-features', 'html-language-features', 'json-language-features'];
for (const ext of EXTENSIONS) {
	const dir = join(checkout, 'extensions', ext);
	const pkg = JSON.parse(await Bun.file(join(dir, 'package.json')).text());
	const nls: Record<string, string | { message: string }> = JSON.parse(await Bun.file(join(dir, 'package.nls.json')).text());
	const tr = (v: unknown): unknown => {
		if (typeof v === 'string') {
			const m = /^%([^%]+)%$/.exec(v);
			const s = m ? nls[m[1]] : undefined;
			return s === undefined ? v : typeof s === 'string' ? s : s.message;
		}
		if (Array.isArray(v)) return v.map(tr);
		if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tr(x)]));
		return v;
	};
	const conf = pkg.contributes.configuration;
	for (const c of Array.isArray(conf) ? conf : [conf]) for (const [k, s] of Object.entries(c.properties ?? {})) full[k] = { ...(tr(s) as Schema), origin: `extensions/${ext}/package.json` };
}

if (PLATFORM !== 'darwin') {
	await Bun.write(fullOut, JSON.stringify(full));
	process.exit(0);
}
const linuxOut = `${fullOut}.linux.json`;
const child = Bun.spawnSync([process.execPath, ...process.execArgv, import.meta.path, checkout, linuxOut], { env: { ...process.env, EXTRACT_PLATFORM: 'linux' }, stderr: 'inherit' });
if (child.exitCode !== 0) throw new Error('the Linux run failed');
const linux: Record<string, Schema> = JSON.parse(await Bun.file(linuxOut).text());
for (const [k, s] of Object.entries(linux)) if (!(k in full)) full[k] = { ...s, platform: 'linux' };

await Bun.write(fullOut, JSON.stringify(full, null, 1));

const fixtureCount = await writeFixture(full);
console.log(`${Object.keys(full).length} settings; fixture: ${fixtureCount}`);
process.exit(0);
