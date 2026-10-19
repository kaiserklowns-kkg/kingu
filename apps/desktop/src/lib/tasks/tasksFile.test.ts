/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { parseJsonc } from '#lib/settings/jsonc.ts';
import { npmTask } from './detect.ts';
import { customTask, parseTasksJson } from './taskConfig.ts';
import { configureText, customizeText, setDefaultGroupText, TEMPLATE } from './tasksFile.ts';

const tasksOf = (text: string) => (parseJsonc(text) as { tasks: Record<string, unknown>[] }).tasks;

describe('writing tasks.json', () => {
	test('the template parses as a VS Code 2.0.0 file', () => {
		expect(parseTasksJson(TEMPLATE, 'osx').tasks.map((t) => t.label)).toEqual(['echo']);
	});

	test('customizing a detected task adds its identifier entry; a custom task is edited in place; comments outside stay', () => {
		const file = '{\n\t// mine\n\t"version": "2.0.0",\n\t"tasks": [\n\t\t{ "label": "b", "type": "shell", "command": "make" }\n\t]\n}\n';
		const npm = npmTask('build', '', 'bun', 'vite build');
		const out = customizeText(file, npm, { problemMatcher: ['$tsc'] });
		expect(out).toContain('// mine');
		expect(tasksOf(out)[1]).toEqual({ type: 'npm', script: 'build', problemMatcher: ['$tsc'], label: 'npm: build', detail: 'vite build' });
		const custom = customTask('b', 'shell', { command: 'make' });
		const again = customizeText(out, custom, { problemMatcher: [] });
		expect(tasksOf(again)[0]).toEqual({ label: 'b', type: 'shell', command: 'make', problemMatcher: [] });
		// The same detected task is found again by its identifier, not added twice.
		expect(tasksOf(customizeText(again, npm, { group: 'build' }))).toHaveLength(2);
	});

	test('a missing file gets the version and the entry', () => {
		const out = configureText(null, npmTask('lint', 'web', 'npm'));
		expect((parseJsonc(out) as { version: string }).version).toBe('2.0.0');
		expect(tasksOf(out)[0]).toMatchObject({ type: 'npm', script: 'lint', path: 'web', label: 'npm: lint - web', problemMatcher: [] });
	});

	test('Configure Default Build Task moves isDefault', () => {
		const file = JSON.stringify({ version: '2.0.0', tasks: [{ label: 'a', type: 'shell', command: 'x', group: { kind: 'build', isDefault: true } }, { label: 'b', type: 'shell', command: 'y' }] });
		const out = setDefaultGroupText(file, customTask('b', 'shell', { command: 'y' }), 'build');
		expect(tasksOf(out).map((t) => t.group)).toEqual(['build', { kind: 'build', isDefault: true }]);
	});
});
