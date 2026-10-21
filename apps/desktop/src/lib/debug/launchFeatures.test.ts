/// <reference types="bun" />
// launch.json compounds, ${command:pickProcess}, js-debug's configuration defaults, Add
// Configuration's snippets and text edit, and the launch.json schema.
import { describe, expect, test } from 'bun:test';
import { parseJsonc } from '#lib/settings/jsonc.ts';
import {
	addConfigurationText,
	adapterType,
	commandVariables,
	compoundConfigs,
	CONFIG_SNIPPETS,
	generatedConfigs,
	isJsDebugType,
	parseLaunchJson,
	resolveJsDebug,
	snippetsFor,
	substitute,
	type LaunchConfig
} from './launch.ts';
import { launchSchema } from './launchSchema.ts';

describe('compounds', () => {
	const text = `{
		"configurations": [
			{ "type": "node", "request": "launch", "name": "Server", "program": "\${workspaceFolder}/server.js" },
			{ "type": "chrome", "request": "launch", "name": "Client", "url": "http://localhost:3000" }
		],
		"compounds": [
			{ "name": "Server/Client", "configurations": ["Server", { "name": "Client", "folder": "web" }], "stopAll": true, "preLaunchTask": "build" },
			{ "name": "Broken", "configurations": ["Server", "Nope"] },
			{ "name": "no configurations" },
			"junk"
		]
	}`;
	test('read with their configurations, by name or { name, folder }', () => {
		const { configs, compounds } = parseLaunchJson(text, '.vscode/launch.json');
		expect(compounds).toEqual([
			{ name: 'Server/Client', configurations: [{ name: 'Server' }, { name: 'Client', folder: 'web' }], preLaunchTask: 'build', stopAll: true },
			{ name: 'Broken', configurations: [{ name: 'Server' }, { name: 'Nope' }] }
		]);
		const origin = { folderOf: () => '/w/web', nameOf: (p: string) => p.slice(p.lastIndexOf('/') + 1) };
		expect(compoundConfigs(compounds[0], configs, origin).configs.map((c) => c.name)).toEqual(['Server', 'Client']);
		expect(compoundConfigs(compounds[1], configs, origin).missing).toEqual(['Nope']);
	});

	test('in a multi-root workspace, { name, folder } picks that folder’s configuration and a bare name must be unique', () => {
		const at = (name: string, folder: string | undefined) => ({ config: { type: 'node', request: 'launch', name }, folder });
		const list = [at('Server', '/w/api'), at('Client', '/w/web'), at('Server', '/w/web'), at('Tool', undefined)];
		const folderOf = new Map<object, string | undefined>(list.map((x) => [x.config, x.folder]));
		const compound = { name: 'All', configurations: [{ name: 'Server', folder: 'web' }, { name: 'Client' }, { name: 'Tool' }, { name: 'All' }] };
		folderOf.set(compound, '/w/api');
		const origin = { folderOf: (c: object) => folderOf.get(c), nameOf: (p: string) => p.slice(p.lastIndexOf('/') + 1) };
		const configs = list.map((x) => x.config);
		const r = compoundConfigs(compound, configs, origin);
		// The compound naming itself is skipped (VS Code).
		expect(r.configs).toEqual([list[2].config, list[1].config, list[3].config]);
		expect(r.missing).toEqual([]);
		// A bare name two folders have: the compound's own folder's, else ambiguous.
		expect(compoundConfigs({ name: 'C', configurations: [{ name: 'Server' }] }, configs, origin).ambiguous).toEqual(['Server']);
		expect(compoundConfigs(compound, configs, origin).configs[0]).toBe(list[2].config);
		const own = { name: 'Own', configurations: [{ name: 'Server' }] };
		folderOf.set(own, '/w/api');
		expect(compoundConfigs(own, configs, origin).configs).toEqual([list[0].config]);
		// A folder that has no such configuration.
		expect(compoundConfigs({ name: 'X', configurations: [{ name: 'Client', folder: 'api' }] }, configs, origin).missing).toEqual(['api/Client']);
	});
});

describe('variables', () => {
	test('${command:pickProcess} is asked for first, then substituted', () => {
		const config = { type: 'lldb', request: 'attach', name: 'a', pid: '${command:pickProcess}', other: '${command:PickProcess}' };
		expect(commandVariables(config)).toEqual(['pickProcess', 'PickProcess']);
		expect(substitute(config, { workspaceFolder: '/w', env: {}, commands: { pickProcess: '123', PickProcess: '456' } })).toMatchObject({ pid: '123', other: '456' });
		expect(() => substitute(config, { workspaceFolder: '/w', env: {} })).toThrow('${command:pickProcess}');
	});
});

describe('js-debug configurations', () => {
	test('node/chrome/msedge map to the pwa- types js-debug serves', () => {
		expect(['node', 'pwa-node', 'chrome', 'msedge', 'node-terminal'].map(adapterType)).toEqual(['pwa-node', 'pwa-node', 'pwa-chrome', 'pwa-msedge', 'node-terminal']);
		expect(adapterType('lldb')).toBe('lldb');
		expect(isJsDebugType('node') && !isJsDebugType('go')).toBe(true);
	});

	test("VS Code's resolver defaults, the user's values winning", () => {
		const launch = resolveJsDebug({ type: 'node', request: 'launch', name: 'p', program: '/w/a.js', console: 'integratedTerminal' }, '/w');
		expect(launch).toMatchObject({
			cwd: '/w',
			sourceMaps: true,
			skipFiles: ['<node_internals>/**'],
			outFiles: ['/w/**/*.(m|c|)js', '!**/node_modules/**'],
			resolveSourceMapLocations: ['/w/**', '!**/node_modules/**'],
			console: 'integratedTerminal'
		});
		// npm scripts / bun through runtimeExecutable and attach by port pass through.
		const npm = resolveJsDebug({ type: 'node', request: 'launch', name: 'npm', runtimeExecutable: 'npm', runtimeArgs: ['run-script', 'dev'] }, '/w');
		expect(npm).toMatchObject({ runtimeExecutable: 'npm', runtimeArgs: ['run-script', 'dev'], cwd: '/w' });
		expect(resolveJsDebug({ type: 'node', request: 'attach', name: 'a', port: 9229 }, '/w')).toMatchObject({ port: 9229, request: 'attach' });
		expect(resolveJsDebug({ type: 'chrome', request: 'launch', name: 'c' }, '/w')).toMatchObject({ webRoot: '/w', sourceMaps: true });
		expect(resolveJsDebug({ type: 'go', request: 'launch', name: 'g' }, '/w')).toEqual({ type: 'go', request: 'launch', name: 'g' });
	});

	test('F5 in a JavaScript or TypeScript file launches it with node', () => {
		for (const lang of ['javascript', 'typescript', 'typescriptreact']) expect(generatedConfigs(lang)[0].config).toMatchObject({ type: 'node', request: 'launch', program: '${file}' });
	});
});

describe('Add Configuration…', () => {
	const snippet: LaunchConfig = { type: 'node', request: 'attach', name: 'Attach', port: 9229 };

	test("the active file's debugger comes first; every snippet is a valid configuration", () => {
		expect(snippetsFor('go')[0].body.type).toBe('go');
		expect(snippetsFor('typescript')[0].body.type).toBe('node');
		for (const s of CONFIG_SNIPPETS) expect(typeof s.body.type === 'string' && typeof s.body.request === 'string' && typeof s.body.name === 'string').toBe(true);
	});

	test('appended to configurations, comments and other properties kept', () => {
		const text = `{
	// my launch file
	"version": "0.2.0",
	"configurations": [
		{ "type": "go", "request": "launch", "name": "pkg", "args": ["a]"] }
	],
	"compounds": []
}
`;
		const out = addConfigurationText(text, snippet);
		const parsed = parseJsonc<{ configurations: LaunchConfig[]; compounds: unknown[] }>(out.text);
		expect(parsed.configurations.map((c) => c.name)).toEqual(['pkg', 'Attach']);
		expect(parsed.compounds).toEqual([]);
		expect(out.text).toContain('// my launch file');
		expect(out.text.slice(out.offset).startsWith('{')).toBe(true);
	});

	test('an empty array, a trailing comma, no configurations, an empty file', () => {
		const names = (text: string) => parseJsonc<{ configurations: LaunchConfig[] }>(addConfigurationText(text, snippet).text).configurations.map((c) => c.name);
		expect(names('{ "configurations": [] }')).toEqual(['Attach']);
		expect(names('{ "configurations": [ { "type": "x", "request": "launch", "name": "a" }, ] }')).toEqual(['a', 'Attach']);
		expect(names('{ "version": "0.2.0", "inputs": [{ "id": "configurations" }] }')).toEqual(['Attach']);
		expect(names('')).toEqual(['Attach']);
		expect(parseJsonc<{ version: string }>(addConfigurationText('', snippet).text).version).toBe('0.2.0');
	});
});

test('the launch.json schema offers every snippet and the compound attributes', () => {
	const schema = launchSchema() as { properties: Record<string, { items: { defaultSnippets: { label: string }[]; properties: Record<string, unknown> } }> };
	const items = schema.properties.configurations.items;
	expect(items.defaultSnippets.map((s) => s.label)).toEqual(CONFIG_SNIPPETS.map((s) => s.label));
	for (const key of ['type', 'request', 'name', 'program', 'runtimeExecutable', 'port', 'processId', 'pid', 'mode', 'module', 'skipFiles', 'outFiles', 'sourceMaps']) expect(items.properties[key]).toBeDefined();
	expect(schema.properties.compounds.items.properties.stopAll).toBeDefined();
});
