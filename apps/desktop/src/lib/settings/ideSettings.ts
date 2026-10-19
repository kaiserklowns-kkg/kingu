// VS Code-derived IDE settings beyond the core set in registry.ts: text editor, files, explorer,
// search, terminal, workbench, window, git and debug. Every one here has a consumer (mappings.ts
// for the pure ones); ids, values and defaults follow VS Code so a VS Code settings.json carries over.

import { THEMES } from '../theme/themes';
import { ENCODINGS } from '../workbench/textFiles';
import type { SettingSchema } from './registry';
import { VSCODE_SETTINGS } from './vscode';

const FONT_WEIGHTS = ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'] as const;

/** VS Code's `files.exclude` default. */
export const DEFAULT_FILES_EXCLUDE = { '**/.git': true, '**/.svn': true, '**/.hg': true, '**/.jj': true, '**/.DS_Store': true, '**/Thumbs.db': true };

export const IDE_SETTINGS: SettingSchema[] = [
	// --- Text Editor (Monaco options, see mappings.editorOptionsFrom)
	// --- Diff Editor (Monaco diff options, see mappings.diffEditorOptionsFrom; Orca's diff viewer options)
	// --- Files
	{
		id: 'files.encoding',
		group: 'Files',
		type: 'string',
		default: 'utf8',
		enum: Object.keys(ENCODINGS),
		enumDescriptions: Object.values(ENCODINGS).map((e) => e.labelLong),
		description: 'encoding เริ่มต้นตอนอ่านและเขียนไฟล์ (The default character set encoding to use when reading and writing files. This setting can also be configured per language.)'
	},
	// --- Explorer
	// --- Search
	// --- Terminal (xterm options, see mappings.terminalOptionsFrom; shell settings are user-only)
	{
		id: 'terminal.integrated.shell.osx',
		group: 'Terminal',
		type: 'string',
		default: '',
		description: 'path ของ shell บน macOS เว้นว่าง = $SHELL (The path of the shell on macOS; empty uses $SHELL.)',
		scope: 'application'
	},
	{
		id: 'terminal.integrated.shell.linux',
		group: 'Terminal',
		type: 'string',
		default: '',
		description: 'path ของ shell บน Linux เว้นว่าง = $SHELL (The path of the shell on Linux; empty uses $SHELL.)',
		scope: 'application'
	},
	{
		id: 'terminal.integrated.shellArgs.osx',
		group: 'Terminal',
		type: 'array',
		items: 'string',
		default: ['-l'],
		description: 'อาร์กิวเมนต์ของ shell บน macOS (The command line arguments to use on macOS.)',
		scope: 'application'
	},
	{
		id: 'terminal.integrated.shellArgs.linux',
		group: 'Terminal',
		type: 'array',
		items: 'string',
		// Kingu always started a login shell; VS Code's Linux default is [].
		default: ['-l'],
		description: 'อาร์กิวเมนต์ของ shell บน Linux (The command line arguments to use on Linux.)',
		scope: 'application'
	},
	// --- Workbench / Window
	{
		id: 'workbench.preferredDarkColorTheme',
		group: 'Workbench',
		type: 'string',
		default: 'Dark Modern',
		enum: THEMES.map((t) => t.id),
		enumDescriptions: THEMES.map((t) => t.label),
		description: 'ธีมเมื่อระบบอยู่ในโหมดมืด ใช้เมื่อเปิด window.autoDetectColorScheme (Specifies the color theme when system color mode is dark and `#window.autoDetectColorScheme#` is enabled.)',
		scope: 'application'
	},
	{
		id: 'workbench.preferredLightColorTheme',
		group: 'Workbench',
		type: 'string',
		default: 'Light Modern',
		enum: THEMES.map((t) => t.id),
		enumDescriptions: THEMES.map((t) => t.label),
		description: 'ธีมเมื่อระบบอยู่ในโหมดสว่าง ใช้เมื่อเปิด window.autoDetectColorScheme (Specifies the color theme when system color mode is light and `#window.autoDetectColorScheme#` is enabled.)',
		scope: 'application'
	},
	{
		id: 'workbench.preferredHighContrastColorTheme',
		group: 'Workbench',
		type: 'string',
		default: 'Default High Contrast',
		enum: THEMES.map((t) => t.id),
		enumDescriptions: THEMES.map((t) => t.label),
		description: 'ธีมเมื่อระบบเปิดโหมดเพิ่มคอนทราสต์และอยู่ในโหมดมืด ใช้เมื่อเปิด window.autoDetectHighContrast (Specifies the color theme when in high contrast dark mode and `#window.autoDetectHighContrast#` is enabled.)',
		scope: 'application'
	},
	{
		id: 'workbench.preferredHighContrastLightColorTheme',
		group: 'Workbench',
		type: 'string',
		default: 'Default High Contrast Light',
		enum: THEMES.map((t) => t.id),
		enumDescriptions: THEMES.map((t) => t.label),
		description: 'ธีมเมื่อระบบเปิดโหมดเพิ่มคอนทราสต์และอยู่ในโหมดสว่าง ใช้เมื่อเปิด window.autoDetectHighContrast (Specifies the color theme when in high contrast light mode and `#window.autoDetectHighContrast#` is enabled.)',
		scope: 'application'
	},
	// --- Git / Source Control
	// --- Debug
	{
		id: 'debug.onTaskErrors',
		group: 'Debug',
		type: 'string',
		default: 'prompt',
		enum: ['debugAnyway', 'showErrors', 'prompt', 'abort'],
		enumDescriptions: [
			'ไม่สนใจ error ของ task แล้วเริ่ม debug (Ignore task errors and start debugging.)',
			'เปิด Problems แล้วไม่เริ่ม debug (Show the Problems view and do not start debugging.)',
			'ถาม (Prompt user.)',
			'ยกเลิกการ debug (Cancel debugging.)'
		],
		description: 'ทำอะไรเมื่อ preLaunchTask มี error (Controls what to do when errors are encountered after running a preLaunchTask.)'
	},
	// --- Tasks
	{
		id: 'task.autoDetect',
		group: 'Tasks',
		type: 'string',
		default: 'on',
		enum: ['on', 'off'],
		description: 'หา task จาก package.json, Cargo.toml และ go.mod เอง (Controls enablement of `provideTasks` for all task providers: npm scripts, cargo and go tasks. If the Tasks: Run Task command is slow, disabling auto detect may help.)'
	},
	{
		id: 'task.saveBeforeRun',
		group: 'Tasks',
		type: 'string',
		default: 'always',
		enum: ['always', 'never', 'prompt'],
		enumDescriptions: [
			'บันทึกทุก editor ก่อนรัน (Always saves all editors before running.)',
			'ไม่บันทึก (Never saves editors before running.)',
			'ถามก่อนบันทึก (Prompts whether to save editors before running.)'
		],
		description: 'บันทึก editor ที่ยังไม่บันทึกก่อนรัน task (Save all dirty editors before running a task.)'
	},
	{
		id: 'task.problemMatchers.neverPrompt',
		group: 'Tasks',
		type: 'json',
		schema: { oneOf: [{ type: 'boolean' }, { type: 'object', additionalProperties: { type: 'boolean' } }] },
		default: false,
		description: 'ไม่ถามหา problem matcher ตอนรัน task — true คือไม่ถามเลย หรือระบุชนิด task เช่น { "shell": true } (Configures whether to show the problem matcher prompt when running a task. Set to `true` to never prompt, or use a dictionary of task types to turn off prompting only for specific task types.)'
	},
	{
		id: 'task.quickOpen.history',
		group: 'Tasks',
		type: 'number',
		default: 30,
		minimum: 0,
		maximum: 30,
		description: 'จำนวน task ที่ใช้ล่าสุดที่แสดงใน Run Task (Controls the number of recent items tracked in task quick open dialog.)'
	},
	{
		id: 'task.quickOpen.detail',
		group: 'Tasks',
		type: 'boolean',
		default: true,
		description: 'แสดงรายละเอียด (detail) ของ task ในรายการเลือก task (Controls whether to show the task detail for tasks that have a detail in task quick picks, such as Run Task.)'
	},
	{
		id: 'task.quickOpen.skip',
		group: 'Tasks',
		type: 'boolean',
		default: false,
		description: 'ข้ามรายการเลือกเมื่อมี task ให้เลือกแค่อันเดียว (Controls whether the task quick pick is skipped when there is only one task to pick from.)'
	},
	{
		id: 'task.allowAutomaticTasks',
		group: 'Tasks',
		type: 'string',
		default: 'off',
		enum: ['on', 'off'],
		enumDescriptions: ['ได้เสมอ (Always)', 'ไม่เลย (Never)'],
		description: 'ให้ task ที่ตั้ง runOn: folderOpen รันเองเมื่อเปิดโฟลเดอร์ — Kingu ถามก่อนเสมอจนกว่าจะอนุญาต tasks.json นั้น ตั้งเป็น off ใน user settings เพื่อไม่ให้รันและไม่ถาม (Enable automatic tasks. Tasks from a folder\'s tasks.json run only after you allow exactly that file; set to `off` in your user settings to never run or ask.)',
		scope: 'application'
	},
	// The rest of VS Code's settings for features Kingu has, one file per area (vscode/*.ts).
	...VSCODE_SETTINGS
];
