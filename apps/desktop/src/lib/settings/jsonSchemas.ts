// The JSON schemas of Kingu's own files (VS Code: the schemas its core and built-in extensions
// register for settings.json, keybindings.json, launch.json, tasks.json, `.code-workspace` files
// and extensions.json). Monaco's JSON worker and the JSON language server get the same list, so
// completion and validation stay when the server takes over from the worker. Pure.

import { LAUNCH_FILE_MATCH, LAUNCH_SCHEMA_URI, launchSchema } from '#lib/debug/launchSchema.ts';

export const SETTINGS_SCHEMA_URI = 'kingu://schemas/settings';
export const KEYBINDINGS_SCHEMA_URI = 'kingu://schemas/keybindings';
export const TASKS_SCHEMA_URI = 'kingu://schemas/tasks';
export const WORKSPACE_SCHEMA_URI = 'kingu://schemas/code-workspace';
export const EXTENSIONS_SCHEMA_URI = 'kingu://schemas/extensions';

export type KinguSchema = { uri: string; fileMatch: string[]; schema: unknown };

type Prop = Record<string, unknown>;
const str = (description: string): Prop => ({ type: 'string', description });
const strings = (description: string): Prop => ({ type: 'array', items: { type: 'string' }, description });

/** keybindings.json: command ids (and their removal form `-id`) to complete. */
export function keybindingsSchema(commandIds: readonly string[]): unknown {
	const ids = [...commandIds].sort();
	return {
		type: 'array',
		items: {
			type: 'object',
			required: ['key', 'command'],
			properties: {
				key: { type: 'string', description: 'คีย์ เช่น cmd+shift+p หรือ cmd+k cmd+t (The key or key sequence.)' },
				command: { type: 'string', enum: [...ids, ...ids.map((id) => `-${id}`)] },
				when: { type: 'string', description: 'เงื่อนไขที่คีย์นี้ทำงาน เช่น editorTextFocus && !editorReadonly (Condition when the key is active.)' },
				args: { description: 'อาร์กิวเมนต์ที่ส่งให้คำสั่ง เช่น { "snippet": "console.log($1)" } ของ editor.action.insertSnippet (Arguments passed to the command.)' }
			}
		}
	};
}

const commandLine: Prop = { anyOf: [{ type: 'string' }, { type: 'object', properties: { value: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, quoting: { enum: ['escape', 'strong', 'weak'] } } }] };
const taskBody: Prop = {
	label: str('The task’s label, shown in the task pickers. (ชื่อ task)'),
	type: { type: 'string', enum: ['shell', 'process', 'npm'], description: 'The task’s type. (ชนิดของ task)' },
	command: commandLine,
	args: { type: 'array', items: commandLine, description: 'Arguments passed to the command. (อาร์กิวเมนต์)' },
	options: { type: 'object', properties: { cwd: str('The folder the task runs in. (โฟลเดอร์ที่รัน)'), env: { type: 'object', additionalProperties: { type: 'string' } }, shell: { type: 'object', properties: { executable: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } } } } },
	group: { anyOf: [{ enum: ['build', 'test', 'none'] }, { type: 'object', properties: { kind: { enum: ['build', 'test', 'none'] }, isDefault: { anyOf: [{ type: 'boolean' }, { type: 'string' }] } } }] },
	dependsOn: { anyOf: [{ type: 'string' }, { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object' }] } }, { type: 'object' }], description: 'Tasks to run first. (task ที่ต้องรันก่อน)' },
	dependsOrder: { enum: ['parallel', 'sequence'] },
	isBackground: { type: 'boolean', description: 'Whether the task keeps running in the background (a watcher). (รันค้างเป็นพื้นหลัง)' },
	problemMatcher: { anyOf: [{ type: 'string' }, { type: 'object' }, { type: 'array' }], description: 'Problem matchers, such as $tsc. (ตัวจับปัญหา)' },
	presentation: { type: 'object', properties: { reveal: { enum: ['always', 'silent', 'never'] }, revealProblems: { enum: ['always', 'onProblem', 'never'] }, echo: { type: 'boolean' }, focus: { type: 'boolean' }, panel: { enum: ['shared', 'dedicated', 'new'] }, showReuseMessage: { type: 'boolean' }, clear: { type: 'boolean' }, close: { type: 'boolean' }, group: { type: 'string' } } },
	runOptions: { type: 'object', properties: { runOn: { enum: ['default', 'folderOpen'] }, reevaluateOnRerun: { type: 'boolean' }, instanceLimit: { type: 'number' }, instancePolicy: { enum: ['prompt', 'silent', 'terminateNewest', 'terminateOldest', 'warn'] } } },
	detail: str('A description shown beside the task. (คำอธิบาย)'),
	hide: { type: 'boolean' },
	script: str('The npm script. (สคริปต์ npm)')
};

/** tasks.json (VS Code: the tasks schema of `workbench.contrib.tasks`), the parts Kingu runs. */
export function tasksSchema(): unknown {
	const task = { type: 'object', properties: { ...taskBody, windows: { type: 'object', properties: taskBody }, osx: { type: 'object', properties: taskBody }, linux: { type: 'object', properties: taskBody } } };
	return {
		type: 'object',
		properties: {
			version: { enum: ['2.0.0'], description: 'The configuration’s version number. (เวอร์ชัน)' },
			tasks: { type: 'array', items: task },
			inputs: { type: 'array', items: { type: 'object', required: ['id', 'type'], properties: { id: { type: 'string' }, type: { enum: ['promptString', 'pickString', 'command'] }, description: { type: 'string' }, default: { type: 'string' }, options: { type: 'array' }, password: { type: 'boolean' }, command: { type: 'string' }, args: {} } } },
			...taskBody
		}
	};
}

/** extensions.json: recommended extensions (VS Code's ExtensionsConfigurationSchema). */
export function extensionsSchema(): unknown {
	return { type: 'object', properties: { recommendations: strings('Extensions to recommend. (ส่วนขยายที่แนะนำ)'), unwantedRecommendations: strings('Extensions never to recommend. (ส่วนขยายที่ไม่ต้องแนะนำ)') } };
}

/** A `.code-workspace` file: its folders, and settings / launch / tasks / extensions for the whole workspace. */
export function workspaceFileSchema(settings: unknown): unknown {
	return {
		type: 'object',
		properties: {
			folders: { type: 'array', items: { type: 'object', required: ['path'], properties: { path: str('A folder, relative to the workspace file or absolute. (พาธโฟลเดอร์)'), name: str('The name the Explorer shows. (ชื่อที่แสดง)') } } },
			settings,
			launch: launchSchema(),
			tasks: tasksSchema(),
			extensions: extensionsSchema(),
			remoteAuthority: { type: 'string' }
		}
	};
}

/** Every schema Kingu gives a JSON editor: `settings` is the settings.json schema (registry.ts jsonSchema). */
export function kinguJsonSchemas(settings: unknown, commandIds: readonly string[]): KinguSchema[] {
	return [
		{ uri: SETTINGS_SCHEMA_URI, fileMatch: ['**/settings.json'], schema: settings },
		{ uri: KEYBINDINGS_SCHEMA_URI, fileMatch: ['**/keybindings.json'], schema: keybindingsSchema(commandIds) },
		// launch.json: configuration attributes and Add Configuration's snippets (VS Code: launchSchema).
		{ uri: LAUNCH_SCHEMA_URI, fileMatch: LAUNCH_FILE_MATCH, schema: launchSchema() },
		{ uri: TASKS_SCHEMA_URI, fileMatch: ['**/.vscode/tasks.json', '**/.kingu/tasks.json'], schema: tasksSchema() },
		{ uri: EXTENSIONS_SCHEMA_URI, fileMatch: ['**/.vscode/extensions.json'], schema: extensionsSchema() },
		{ uri: WORKSPACE_SCHEMA_URI, fileMatch: ['**/*.code-workspace'], schema: workspaceFileSchema(settings) }
	];
}

/** The JSON language server's `json` settings section with Kingu's schemas after the user's and
 * the folder's `json.schemas` (entries as VS Code's jsonClient sends them: `url`, `fileMatch`, `schema`). */
export function withKinguSchemas(json: unknown, schemas: readonly KinguSchema[]): Record<string, unknown> {
	const section = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
	const own = Array.isArray(section.schemas) ? section.schemas : [];
	return { ...section, schemas: [...own, ...schemas.map((s) => ({ url: s.uri, fileMatch: s.fileMatch, schema: s.schema }))] };
}
