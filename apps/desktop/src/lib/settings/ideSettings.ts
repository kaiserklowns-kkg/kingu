// VS Code-derived IDE settings beyond the core set in registry.ts: text editor, files, explorer,
// search, terminal, workbench, window, git and debug. Every one here has a consumer (mappings.ts
// for the pure ones); ids, values and defaults follow VS Code so a VS Code settings.json carries over.

import { allThemes } from '../theme/themes';
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
		// Snaps add themes at runtime (setSnapThemes), so the values are read when validated.
		get enum() {
			return allThemes().map((t) => t.id);
		},
		get enumDescriptions() {
			return allThemes().map((t) => t.label);
		},
		description: 'ธีมเมื่อระบบอยู่ในโหมดมืด ใช้เมื่อเปิด window.autoDetectColorScheme (Specifies the color theme when system color mode is dark and `#window.autoDetectColorScheme#` is enabled.)',
		scope: 'application'
	},
	{
		id: 'workbench.preferredLightColorTheme',
		group: 'Workbench',
		type: 'string',
		default: 'Light Modern',
		// Snaps add themes at runtime (setSnapThemes), so the values are read when validated.
		get enum() {
			return allThemes().map((t) => t.id);
		},
		get enumDescriptions() {
			return allThemes().map((t) => t.label);
		},
		description: 'ธีมเมื่อระบบอยู่ในโหมดสว่าง ใช้เมื่อเปิด window.autoDetectColorScheme (Specifies the color theme when system color mode is light and `#window.autoDetectColorScheme#` is enabled.)',
		scope: 'application'
	},
	{
		id: 'workbench.preferredHighContrastColorTheme',
		group: 'Workbench',
		type: 'string',
		default: 'Default High Contrast',
		// Snaps add themes at runtime (setSnapThemes), so the values are read when validated.
		get enum() {
			return allThemes().map((t) => t.id);
		},
		get enumDescriptions() {
			return allThemes().map((t) => t.label);
		},
		description: 'ธีมเมื่อระบบเปิดโหมดเพิ่มคอนทราสต์และอยู่ในโหมดมืด ใช้เมื่อเปิด window.autoDetectHighContrast (Specifies the color theme when in high contrast dark mode and `#window.autoDetectHighContrast#` is enabled.)',
		scope: 'application'
	},
	{
		id: 'workbench.preferredHighContrastLightColorTheme',
		group: 'Workbench',
		type: 'string',
		default: 'Default High Contrast Light',
		// Snaps add themes at runtime (setSnapThemes), so the values are read when validated.
		get enum() {
			return allThemes().map((t) => t.id);
		},
		get enumDescriptions() {
			return allThemes().map((t) => t.label);
		},
		description: 'ธีมเมื่อระบบเปิดโหมดเพิ่มคอนทราสต์และอยู่ในโหมดสว่าง ใช้เมื่อเปิด window.autoDetectHighContrast (Specifies the color theme when in high contrast light mode and `#window.autoDetectHighContrast#` is enabled.)',
		scope: 'application'
	},
	// --- Git / Source Control
	// --- Debug
	// The rest of VS Code's settings for features Kingu has, one file per area (vscode/*.ts).
	...VSCODE_SETTINGS
];
