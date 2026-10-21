/// <reference types="bun" />
// Kingu's JSON schemas: the same list for Monaco's JSON worker and the JSON language server.
import { describe, expect, test } from 'bun:test';
import { kinguJsonSchemas, withKinguSchemas } from './jsonSchemas.ts';

const settings = { type: 'object', properties: { 'editor.fontSize': { type: 'number' } } };

describe('Kingu JSON schemas', () => {
	test('every file of its own has one', () => {
		const list = kinguJsonSchemas(settings, ['workbench.action.files.save']);
		const match = (file: string) => list.filter((s) => s.fileMatch.some((g) => new RegExp(`^${g.replaceAll('.', '\\.').replaceAll('**/', '\0').replaceAll('*', '[^/]*').replaceAll('\0', '(.*/)?')}$`).test(file))).map((s) => s.uri);
		expect(match('/w/.vscode/settings.json')).toEqual(['kingu://schemas/settings']);
		expect(match('/u/keybindings.json')).toEqual(['kingu://schemas/keybindings']);
		expect(match('/w/.vscode/launch.json')).toEqual(['kingu://schemas/launch']);
		expect(match('/w/.vscode/tasks.json')).toEqual(['kingu://schemas/tasks']);
		expect(match('/w/.kingu/tasks.json')).toEqual(['kingu://schemas/tasks']);
		expect(match('/w/.vscode/extensions.json')).toEqual(['kingu://schemas/extensions']);
		expect(match('/w/all.code-workspace')).toEqual(['kingu://schemas/code-workspace']);
		const keys = list.find((s) => s.uri.endsWith('keybindings'))!.schema as { items: { properties: { command: { enum: string[] } } } };
		expect(keys.items.properties.command.enum).toEqual(['workbench.action.files.save', '-workbench.action.files.save']);
		// A workspace file's settings are settings.json's; its tasks and launch have theirs.
		const ws = list.find((s) => s.uri.endsWith('code-workspace'))!.schema as { properties: Record<string, unknown> };
		expect(ws.properties.settings).toBe(settings);
		expect(Object.keys(ws.properties)).toEqual(expect.arrayContaining(['folders', 'launch', 'tasks', 'extensions']));
	});

	test('the JSON server gets them after the user’s and folder’s json.schemas', () => {
		const list = kinguJsonSchemas(settings, []);
		const mine = { url: 'https://x/schema.json', fileMatch: ['/w/x.json'] };
		const json = withKinguSchemas({ validate: { enable: true }, schemas: [mine] }, list);
		expect(json.validate).toEqual({ enable: true });
		const schemas = json.schemas as { url: string; fileMatch: string[]; schema?: unknown }[];
		expect(schemas[0]).toBe(mine);
		expect(schemas.slice(1).map((s) => s.url)).toEqual(list.map((s) => s.uri));
		expect(schemas.every((s, i) => i === 0 || s.schema !== undefined)).toBe(true);
		expect((withKinguSchemas(undefined, list).schemas as unknown[]).length).toBe(list.length);
	});
});
