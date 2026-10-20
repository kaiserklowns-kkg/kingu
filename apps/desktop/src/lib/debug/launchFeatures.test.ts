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
			{ name: 'Server/Client', configurations: ['Server', 'Client'], preLaunchTask: 'build', stopAll: true },
			{ name: 'Broken', configurations: ['Server', 'Nope'] }
		]);
		expect(compoundConfigs(compounds[0], configs).configs.map((c) => c.name)).toEqual(['Server', 'Client']);
		expect(compoundConfigs(compounds[1], configs).missing).toEqual(['Nope']);
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
