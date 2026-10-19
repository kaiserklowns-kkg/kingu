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
	// Quick diff, blame, timeline and merge conflicts in the editor (src/lib/scm/).
	{
		id: 'scm.diffDecorations',
		group: 'Source Control',
		type: 'string',
		default: 'all',
		enum: ['all', 'gutter', 'overview', 'minimap', 'none'],
		enumDescriptions: [
			'แสดงทุกที่ (Show the diff decorations in all available locations.)',
			'แสดงเฉพาะที่ขอบซ้ายของ editor (Show the diff decorations only in the editor gutter.)',
			'แสดงเฉพาะที่แถบภาพรวมด้านขวา (Show the diff decorations only in the overview ruler.)',
			'แสดงเฉพาะใน minimap (Show the diff decorations only in the minimap.)',
			'ไม่แสดง (Do not show the diff decorations.)'
		],
		description: 'แถบบอกบรรทัดที่เพิ่ม แก้ หรือลบ เทียบกับ index ของ git (Controls diff decorations in the editor.)'
	},
	{
		id: 'scm.diffDecorationsGutterWidth',
		group: 'Source Control',
		type: 'number',
		default: 3,
		minimum: 1,
		maximum: 5,
		integer: true,
		description: 'ความกว้างเป็นพิกเซลของแถบบรรทัดที่เพิ่มและแก้ 1 ถึง 5 (Controls the width(px) of diff decorations in gutter (added & modified).)'
	},
	{
		id: 'scm.diffDecorationsGutterVisibility',
		group: 'Source Control',
		type: 'string',
		default: 'always',
		enum: ['always', 'hover'],
		enumDescriptions: ['แสดงตลอด (Show the diff decorator in the gutter at all times.)', 'แสดงเมื่อชี้เมาส์ที่ขอบซ้าย (Show the diff decorator in the gutter only on hover.)'],
		description: 'การแสดงแถบ diff ที่ขอบซ้ายของ editor (Controls the visibility of the Source Control diff decorator in the gutter.)'
	},
	{
		id: 'scm.diffDecorationsGutterAction',
		group: 'Source Control',
		type: 'string',
		default: 'diff',
		enum: ['diff', 'none'],
		enumDescriptions: ['คลิกแล้วเปิด peek ของการเปลี่ยนแปลง (Show the inline diff Peek view on click.)', 'ไม่ทำอะไร (Do nothing.)'],
		description: 'คลิกแถบ diff ที่ขอบซ้ายแล้วทำอะไร (Controls the behavior of Source Control diff gutter decorations.)'
	},
	{
		id: 'scm.diffDecorationsGutterPattern',
		group: 'Source Control',
		type: 'json',
		schema: {
			type: 'object',
			properties: { added: { type: 'boolean' }, modified: { type: 'boolean' } }
		},
		default: { added: false, modified: true },
		description: 'ใช้ลายเส้นแทนสีทึบสำหรับแถบบรรทัดที่เพิ่ม (added) หรือแก้ (modified) (Controls whether a pattern is used for the diff decorations in gutter.)'
	},
	{
		id: 'scm.diffDecorationsIgnoreTrimWhitespace',
		group: 'Source Control',
		type: 'string',
		default: 'false',
		enum: ['true', 'false', 'inherit'],
		enumDescriptions: [
			'ไม่นับช่องว่างหน้าและท้ายบรรทัด (Ignore leading and trailing whitespace.)',
			'นับช่องว่างหน้าและท้ายบรรทัด (Do not ignore leading and trailing whitespace.)',
			'ตาม diffEditor.ignoreTrimWhitespace (Inherit from `diffEditor.ignoreTrimWhitespace`.)'
		],
		description: 'ไม่นับช่องว่างหน้าและท้ายบรรทัดในแถบ diff (Controls whether leading and trailing whitespace is ignored in Source Control diff gutter decorations.)'
	},
	{
		id: 'git.blame.editorDecoration.enabled',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'แสดง commit ล่าสุดของบรรทัดที่เคอร์เซอร์อยู่ท้ายบรรทัด (Controls whether to show blame information in the editor using editor decorations.)'
	},
	{
		id: 'git.blame.editorDecoration.template',
		group: 'Git',
		type: 'string',
		default: '${subject}, ${authorName} (${authorDateAgo})',
		description: 'รูปแบบข้อความ blame ท้ายบรรทัด รองรับ ${hash}, ${hashShort}, ${subject}, ${authorName}, ${authorEmail}, ${authorDate}, ${authorDateAgo} (Template for the blame information editor decoration. Supported variables: `hash`, `hashShort` (first N characters per `#git.commitShortHashLength#`), `subject`, `authorName`, `authorEmail`, `authorDate`, `authorDateAgo`.)'
	},
	{
		id: 'git.blame.editorDecoration.disableHover',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'ไม่แสดงรายละเอียด commit เมื่อชี้ที่ข้อความ blame (Controls whether to disable the blame information editor decoration hover.)'
	},
	{
		id: 'git.blame.statusBarItem.enabled',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'แสดง blame ของบรรทัดที่เคอร์เซอร์อยู่ใน status bar (Controls whether to show blame information in the status bar.)'
	},
	{
		id: 'git.blame.statusBarItem.template',
		group: 'Git',
		type: 'string',
		default: '${authorName} (${authorDateAgo})',
		description: 'รูปแบบข้อความ blame ใน status bar รองรับ ${hash}, ${hashShort}, ${subject}, ${authorName}, ${authorEmail}, ${authorDate}, ${authorDateAgo} (Template for the blame information status bar item. Supported variables: `hash`, `hashShort` (first N characters per `#git.commitShortHashLength#`), `subject`, `authorName`, `authorEmail`, `authorDate`, `authorDateAgo`.)'
	},
	{
		id: 'git.blame.ignoreWhitespace',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'ไม่นับการเปลี่ยนช่องว่างตอนหา blame (git blame -w) (Controls whether to ignore whitespace changes when computing blame information.)'
	},
	{
		id: 'git.mergeEditor',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'คลิกไฟล์ที่มี conflict ใน Source Control แล้วเปิด merge editor (Open the merge editor for files that are currently under conflict.)'
	},
	{
		id: 'git.timeline.showAuthor',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'แสดงชื่อผู้เขียน commit ใน Timeline (Controls whether to show the commit author in the Timeline view.)'
	},
	{
		id: 'git.timeline.date',
		group: 'Git',
		type: 'string',
		default: 'committed',
		enum: ['committed', 'authored'],
		enumDescriptions: ['วันที่ commit (Use the committed date)', 'วันที่เขียน (Use the authored date)'],
		description: 'วันที่ที่ Timeline ใช้ (Controls which date to use for items in the Timeline view.)'
	},
	{
		id: 'git.timeline.showUncommitted',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'แสดงการเปลี่ยนแปลงที่ยังไม่ commit ใน Timeline (Controls whether to show uncommitted changes in the Timeline view.)'
	},
	{
		id: 'timeline.pageSize',
		group: 'Timeline',
		type: 'json',
		schema: { type: ['number', 'null'] },
		default: 50,
		description: 'จำนวนรายการที่ Timeline โหลดต่อครั้ง null = 50 (The number of items to show in the Timeline view by default and when loading more items. Setting to `null` will automatically choose a page size based on the visible area of the Timeline view.)'
	},
	{
		id: 'timeline.pageOnScroll',
		group: 'Timeline',
		type: 'boolean',
		default: true,
		description: 'โหลดรายการถัดไปเมื่อเลื่อนถึงท้าย Timeline (Controls whether the Timeline view will load the next page of items when you scroll to the end of the list.)'
	},
	{
		id: 'merge-conflict.codeLens.enabled',
		group: 'Merge Conflict',
		type: 'boolean',
		default: true,
		description: 'แสดงปุ่ม Accept Current / Incoming / Both / Compare เหนือ conflict ใน editor (Create a CodeLens for merge conflict blocks within editor.)'
	},
	{
		id: 'merge-conflict.decorators.enabled',
		group: 'Merge Conflict',
		type: 'boolean',
		default: true,
		description: 'ระบายสีบล็อก conflict ใน editor (Create decorators for merge conflict blocks within editor.)'
	},
	{
		id: 'merge-conflict.autoNavigateNextConflict.enabled',
		group: 'Merge Conflict',
		type: 'boolean',
		default: false,
		description: 'แก้ conflict แล้วไปยัง conflict ถัดไปเอง (Whether to automatically navigate to the next merge conflict after resolving a merge conflict.)'
	},
	{
		id: 'merge-conflict.diffViewPosition',
		group: 'Merge Conflict',
		type: 'string',
		default: 'Current',
		enum: ['Current', 'Beside', 'Below'],
		enumDescriptions: [
			'เปิดในกลุ่ม editor เดิม (Open the diff view in the current editor group.)',
			'เปิดข้างกลุ่ม editor เดิม (Open the diff view next to the current editor group.)',
			'เปิดใต้กลุ่ม editor เดิม (Open the diff view below the current editor group.)'
		],
		description: 'ตำแหน่งที่เปิด Compare Changes ของ conflict (Controls where the diff view should be opened when comparing changes in merge conflicts.)'
	},
	// --- Debug
	// The rest of VS Code's settings for features Kingu has, one file per area (vscode/*.ts).
	...VSCODE_SETTINGS
];
