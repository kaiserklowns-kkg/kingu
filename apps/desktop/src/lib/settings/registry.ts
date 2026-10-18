// Settings schema registry and layering (VS Code: configurationRegistry + ConfigurationModel).
// Pure, so `bun test` can exercise it: defaults < user < workspace, each value checked against
// its schema so a bad value in a file falls back instead of breaking the workbench.

import { DEFAULT_THEME, THEMES } from '../theme/themes';
import { defaultTitleTemplate } from '../workbench/title';

const MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');

export type SettingScope = 'user' | 'workspace';

type Base = {
	id: string;
	/** Settings editor group, e.g. "Text Editor". */
	group: string;
	description: string;
	/** `application` settings are user-only, like VS Code's ConfigurationScope.APPLICATION. */
	scope?: 'application' | 'window' | 'resource';
};

export type SettingSchema =
	| (Base & { type: 'boolean'; default: boolean })
	| (Base & { type: 'number'; default: number; minimum?: number; maximum?: number; integer?: boolean })
	| (Base & { type: 'string'; default: string; enum?: readonly string[]; enumDescriptions?: readonly string[] });

export const DEFAULT_FONT_FAMILY = "Menlo, Monaco, 'Courier New', 'IBM Plex Sans Thai', monospace";

export const SETTINGS: SettingSchema[] = [
	{
		id: 'workbench.colorTheme',
		group: 'Workbench',
		type: 'string',
		default: DEFAULT_THEME,
		enum: THEMES.map((t) => t.id),
		enumDescriptions: THEMES.map((t) => t.label),
		description: 'ธีมสีของ workbench และ editor (Specifies the color theme used in the workbench.)',
		scope: 'application'
	},
	{
		id: 'workbench.editor.enablePreview',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'เปิดไฟล์เป็นแท็บพรีวิว (ตัวเอียง) จนกว่าจะแก้ไขหรือดับเบิลคลิก (Controls whether opened editors show as preview editors.)'
	},
	{
		id: 'window.zoomLevel',
		group: 'Window',
		type: 'number',
		default: 0,
		minimum: -8,
		maximum: 8,
		description: 'ระดับการซูมของหน้าต่าง แต่ละขั้นคือ 20% (Adjust the zoom level of the window; each step is 20% larger or smaller.)',
		scope: 'application'
	},
	{
		id: 'editor.fontSize',
		group: 'Text Editor',
		type: 'number',
		default: 12,
		minimum: 6,
		maximum: 100,
		description: 'ขนาดตัวอักษรเป็นพิกเซล (Controls the font size in pixels.)'
	},
	{
		id: 'editor.fontFamily',
		group: 'Text Editor',
		type: 'string',
		default: DEFAULT_FONT_FAMILY,
		description: 'ฟอนต์ของ editor (Controls the font family.)'
	},
	{
		id: 'editor.tabSize',
		group: 'Text Editor',
		type: 'number',
		default: 4,
		minimum: 1,
		maximum: 32,
		integer: true,
		description: 'จำนวนช่องว่างต่อหนึ่งแท็บ (The number of spaces a tab is equal to.)',
		scope: 'resource'
	},
	{
		id: 'editor.insertSpaces',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แทรกช่องว่างเมื่อกด Tab (Insert spaces when pressing Tab.)',
		scope: 'resource'
	},
	{
		id: 'editor.detectIndentation',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ตรวจหาการเยื้องจากเนื้อหาไฟล์ แทน tabSize/insertSpaces (Detect tab size and insert spaces from the file content.)',
		scope: 'resource'
	},
	{
		id: 'editor.wordWrap',
		group: 'Text Editor',
		type: 'string',
		default: 'off',
		enum: ['off', 'on', 'wordWrapColumn', 'bounded'],
		enumDescriptions: ['ไม่ตัดบรรทัด', 'ตัดบรรทัดตามความกว้าง viewport', 'ตัดที่ editor.wordWrapColumn', 'ตัดที่ค่าที่น้อยกว่าระหว่าง viewport กับ wordWrapColumn'],
		description: 'การตัดบรรทัด (Controls how lines should wrap.)'
	},
	{
		id: 'editor.minimap.enabled',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดง minimap (Controls whether the minimap is shown.)'
	},
	{
		id: 'editor.renderWhitespace',
		group: 'Text Editor',
		type: 'string',
		default: 'selection',
		enum: ['none', 'boundary', 'selection', 'trailing', 'all'],
		description: 'การแสดงอักขระช่องว่าง (Controls how the editor should render whitespace characters.)'
	},
	{
		id: 'files.autoSave',
		group: 'Files',
		type: 'string',
		default: 'off',
		enum: ['off', 'afterDelay', 'onFocusChange'],
		enumDescriptions: ['ไม่บันทึกอัตโนมัติ', 'บันทึกหลังหยุดพิมพ์ตาม files.autoSaveDelay', 'บันทึกเมื่อ editor เสียโฟกัส'],
		description: 'บันทึกไฟล์อัตโนมัติ (Controls auto save of editors that have unsaved changes.)'
	},
	{
		id: 'files.autoSaveDelay',
		group: 'Files',
		type: 'number',
		default: 1000,
		minimum: 0,
		integer: true,
		description: 'หน่วงเวลา (ms) ก่อนบันทึกอัตโนมัติ เมื่อ files.autoSave เป็น afterDelay (Delay in milliseconds after which an editor is saved.)'
	},
	{
		id: 'terminal.integrated.fontSize',
		group: 'Terminal',
		type: 'number',
		default: 12,
		minimum: 6,
		maximum: 100,
		description: 'ขนาดตัวอักษรของ terminal (Controls the font size in pixels of the terminal.)'
	},
	{
		id: 'terminal.integrated.fontFamily',
		group: 'Terminal',
		type: 'string',
		default: '',
		description: 'ฟอนต์ของ terminal เว้นว่างเพื่อใช้ editor.fontFamily (Defaults to editor.fontFamily when empty.)'
	},
	{
		id: 'kingu.agent.model',
		group: 'Agent',
		type: 'string',
		default: 'claude-opus-5-5',
		description: 'โมเดลที่ agent ใช้ (The Claude model agent runs use.)'
	},
	{
		id: 'kingu.agent.permissionMode',
		group: 'Agent',
		type: 'string',
		default: 'default',
		enum: ['default', 'acceptEdits', 'plan'],
		enumDescriptions: [
			'ถามก่อนใช้เครื่องมือที่ต้องขออนุญาต (Ask before tools that need approval.)',
			'แก้ไขไฟล์ใน worktree ได้เลย ถามเฉพาะคำสั่งอื่น (Accept file edits automatically.)',
			'วางแผนเท่านั้น ไม่แก้ไขไฟล์ (Plan only; no edits or commands.)'
		],
		description: 'โหมดการขออนุญาตของ agent (How the agent asks for permission to use tools.)'
	},
	{
		id: 'kingu.agent.runMode',
		group: 'Agent',
		type: 'string',
		default: 'terminal',
		enum: ['terminal', 'timeline'],
		enumDescriptions: [
			'รัน agent CLI ใน terminal ของ worktree แบบ Orca (Run the agent CLI in a terminal of the worktree, like Orca.)',
			'รันผ่าน agent host แสดงเป็น timeline พร้อมการ์ดขออนุญาต (Run through the agent host as a timeline with permission cards.)'
		],
		description: 'วิธีรัน agent ของงานใหม่ใน Agents เลือกต่องานได้ตอนสร้าง (How new tasks run their agent; each task can pick when it is created.)'
	},
	{
		id: 'kingu.agent.notifications',
		group: 'Agent',
		type: 'boolean',
		default: true,
		description:
			'แจ้งเตือนของระบบเมื่อ agent รอคุณอนุญาต เสร็จรอบ หรือล้มเหลว ขณะที่คุณไม่ได้ดูหน้าต่าง Kingu (Show a system notification when an agent needs you while the window is not focused.)'
	},
	{
		id: 'kingu.agent.cli',
		group: 'Agent',
		type: 'string',
		default: 'claude',
		description:
			'คำสั่ง agent CLI สำหรับโหมด terminal เช่น claude, codex หรือ claude --model opus — prompt จะต่อท้ายเป็นอาร์กิวเมนต์สุดท้าย ห้ามมีอักขระของ shell (The agent CLI for the terminal mode; the prompt is appended as its last argument.)'
	},
	{
		id: 'kingu.team.serverUrl',
		group: 'Team',
		type: 'string',
		default: '',
		description:
			'URL ของเซิร์ฟเวอร์ทีม Kingu (ต้องเป็น HTTPS ยกเว้น http://localhost) ส่งเฉพาะ metadata ของงาน ไม่ส่งโค้ดหรือความลับ token เก็บใน Keychain เท่านั้น (Kingu team server URL. Only task metadata is synced; the token lives in the macOS Keychain.)',
		// User-only: a repository's workspace settings must not redirect task metadata elsewhere.
		scope: 'application'
	},
	{
		id: 'kingu.team.project',
		group: 'Team',
		type: 'string',
		default: '',
		description: 'Project id (uuid) บนเซิร์ฟเวอร์ทีมที่งานของ workspace นี้จะถูกซิงก์ไป เว้นว่างเพื่อปิดการซิงก์ (Team server project id for this workspace; empty disables sync.)'
	},
	// --- Title bar and layout (VS Code: window.*, workbench.layoutControl.*, workbench.activityBar.location …)
	{
		id: 'window.title',
		group: 'Window',
		type: 'string',
		default: defaultTitleTemplate(MAC),
		description:
			'ชื่อหน้าต่างจากตัวแปร: ${activeEditorShort} ${activeEditorMedium} ${activeEditorLong} ${activeFolderShort} ${folderName} ${folderPath} ${rootName} ${rootPath} ${activeRepositoryBranchName} ${dirty} ${appName} ${separator} (Controls the window title based on the current context; the variables are substituted.)',
		scope: 'application'
	},
	{
		id: 'window.titleSeparator',
		group: 'Window',
		type: 'string',
		default: ' — ',
		description: 'ตัวคั่นที่ใช้แทน ${separator} ใน window.title (Separator used by window.title.)',
		scope: 'application'
	},
	{
		id: 'window.commandCenter',
		group: 'Window',
		type: 'boolean',
		default: true,
		description: 'แสดง command center (ช่องค้นหา) กลางแถบชื่อเรื่อง แถบจะสูง 30px เมื่อปิด (Show the command center in the title bar.)',
		scope: 'application'
	},
	{
		id: 'window.menuBarVisibility',
		group: 'Window',
		type: 'string',
		default: 'classic',
		enum: ['classic', 'compact', 'hidden'],
		enumDescriptions: [
			'แสดงเมนูเต็มในแถบชื่อเรื่อง (The menu is displayed at the top of the window.)',
			'รวมเมนูไว้ในปุ่มแฮมเบอร์เกอร์ (The menu is displayed as a compact button.)',
			'ซ่อนเมนู (The menu is hidden.)'
		],
		description: 'การแสดงเมนูในหน้าต่างบน Windows/Linux (macOS ใช้เมนูของระบบ) (Controls the visibility of the in-window menu bar on Windows and Linux.)',
		scope: 'application'
	},
	{
		id: 'workbench.navigationControl.enabled',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงปุ่มย้อนกลับ/ไปข้างหน้าใน command center (Controls whether the navigation controls are shown in the command center.)',
		scope: 'application'
	},
	{
		id: 'workbench.layoutControl.enabled',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงปุ่มควบคุมเลย์เอาต์ในแถบชื่อเรื่อง (Controls whether the layout controls in the title bar are shown.)',
		scope: 'application'
	},
	{
		id: 'workbench.layoutControl.type',
		group: 'Workbench',
		type: 'string',
		default: 'both',
		enum: ['toggles', 'menu', 'both'],
		enumDescriptions: [
			'ปุ่มเปิด/ปิด side bar, panel และ secondary side bar (Shows toggles for the side bars and panel.)',
			'ปุ่มเดียวที่เปิดเมนูเลย์เอาต์ (Shows a single button with a dropdown of layout options.)',
			'แสดงทั้งปุ่มเปิด/ปิดและเมนู (Shows both the toggles and the menu.)'
		],
		description: 'รูปแบบของปุ่มควบคุมเลย์เอาต์ในแถบชื่อเรื่อง (Controls whether the layout control is a single menu button, toggles, or both.)',
		scope: 'application'
	},
	{
		id: 'workbench.activityBar.location',
		group: 'Workbench',
		type: 'string',
		default: 'default',
		enum: ['default', 'top', 'hidden'],
		enumDescriptions: [
			'แถบแนวตั้งข้าง side bar (Show the activity bar to the side of the primary side bar.)',
			'ไอคอนอยู่บนหัว side bar บัญชีและการตั้งค่าย้ายไปแถบชื่อเรื่อง (Show the activity bar at the top of the primary side bar; Accounts and Manage move to the title bar.)',
			'ซ่อน บัญชีและการตั้งค่าย้ายไปแถบชื่อเรื่อง (Hide the activity bar.)'
		],
		description: 'ตำแหน่งของ activity bar (Controls the location of the activity bar.)'
	},
	{
		id: 'workbench.sideBar.location',
		group: 'Workbench',
		type: 'string',
		default: 'left',
		enum: ['left', 'right'],
		description: 'ตำแหน่งของ primary side bar ซ้ายหรือขวา secondary side bar จะอยู่ฝั่งตรงข้าม (Controls the location of the primary side bar.)'
	},
	{
		id: 'workbench.panel.defaultLocation',
		group: 'Workbench',
		type: 'string',
		default: 'bottom',
		enum: ['bottom', 'top', 'left', 'right'],
		description: 'ตำแหน่งของ panel (terminal, problems, output) (Controls where the panel is shown.)'
	},
	{
		id: 'workbench.panel.alignment',
		group: 'Workbench',
		type: 'string',
		default: 'center',
		enum: ['center', 'justify', 'left', 'right'],
		enumDescriptions: [
			'panel กว้างเท่า editor (The panel spans the editor area only.)',
			'panel กว้างเต็มหน้าต่างระหว่าง side bar ทั้งสอง (The panel spans the full width.)',
			'panel ยื่นไปถึงขอบซ้าย (The panel extends to the left edge.)',
			'panel ยื่นไปถึงขอบขวา (The panel extends to the right edge.)'
		],
		description: 'การจัดแนวของ panel เมื่ออยู่ด้านล่างหรือด้านบน (Controls the alignment of the panel when it is at the bottom or top.)'
	},
	{
		id: 'kingu.agentsControl.enabled',
		group: 'Agent',
		type: 'string',
		default: 'compact',
		enum: ['hidden', 'badge', 'compact'],
		enumDescriptions: [
			'ไม่แสดงสถานะ agent ในแถบชื่อเรื่อง (Hide the agents status.)',
			'ป้ายสถานะแยกถัดจากช่องค้นหา (Show the agents status as a separate badge next to the search box.)',
			'รวมช่องค้นหากับสถานะ agent เป็นปุ่มเดียว (Merge the search box and the agents status into one pill.)'
		],
		description: 'การแสดงสถานะ agent (รอคุณ / กำลังทำ / ยังไม่อ่าน) ใน command center (Controls the agents status widget in the command center.)',
		scope: 'application'
	},
	{
		id: 'kingu.titleBar.openInAgents.enabled',
		group: 'Agent',
		type: 'boolean',
		default: true,
		description: 'แสดงปุ่ม "Open in Agents" ในแถบชื่อเรื่อง (Show the Open in Agents button in the title bar.)',
		scope: 'application'
	}
];

export type SettingsSection = { id: string; label: string; groups: string[] };

/**
 * The system settings page's table of contents: one settings system for the IDE and the ADE,
 * grouped by what they affect. Every group in `SETTINGS` belongs to exactly one section.
 */
export const SETTINGS_SECTIONS: SettingsSection[] = [
	{ id: 'system', label: 'ระบบ (System)', groups: ['Workbench', 'Window', 'Team'] },
	{ id: 'ide', label: 'IDE', groups: ['Text Editor', 'Files', 'Terminal'] },
	{ id: 'ade', label: 'ADE (Agents)', groups: ['Agent'] }
];

export const SNAPS_SECTION_ID = 'snaps';

/**
 * The table of contents for `schemas` (the static ones plus contributed ones): the static
 * sections, then "Snaps" holding every contributed group (one per snap, `Snap: <name>`). The
 * Snaps section is always there, for the Snap management view.
 */
export function settingsSections(schemas: SettingSchema[] = SETTINGS): SettingsSection[] {
	const known = new Set(SETTINGS_SECTIONS.flatMap((s) => s.groups));
	const contributed = [...new Set(schemas.map((s) => s.group).filter((g) => !known.has(g)))];
	return [...SETTINGS_SECTIONS, { id: SNAPS_SECTION_ID, label: 'Snaps', groups: contributed }];
}

/** Settings shown for a TOC selection (`null` = all) and a search query (searching spans every group). */
export function settingsInView(query: string, group: string | null, schemas: SettingSchema[] = SETTINGS): SettingSchema[] {
	return schemas.filter((s) => (query.trim() ? matchesQuery(s, query) : group === null || s.group === group));
}

export const SCHEMA = new Map(SETTINGS.map((s) => [s.id, s]));

/** The value if it fits the schema, else undefined (so the next layer down applies). */
export function validate(schema: SettingSchema, value: unknown): unknown {
	switch (schema.type) {
		case 'boolean':
			return typeof value === 'boolean' ? value : undefined;
		case 'number': {
			if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
			if (schema.integer && !Number.isInteger(value)) return undefined;
			if (schema.minimum !== undefined && value < schema.minimum) return undefined;
			if (schema.maximum !== undefined && value > schema.maximum) return undefined;
			return value;
		}
		case 'string':
			if (typeof value !== 'string') return undefined;
			return schema.enum && !schema.enum.includes(value) && schema.id !== 'workbench.colorTheme' ? undefined : value;
	}
}

/** Whether `scope` may set this setting (application settings are user-only). */
export const allowedIn = (schema: SettingSchema, scope: SettingScope) => scope === 'user' || schema.scope !== 'application';

export type Resolved = { value: unknown; source: 'default' | SettingScope };

/** Workspace over user over default, per setting. Unknown keys are ignored. */
export function resolveSettings(user: Record<string, unknown>, workspace: Record<string, unknown>, schemas: SettingSchema[] = SETTINGS): Map<string, Resolved> {
	const out = new Map<string, Resolved>();
	for (const s of schemas) {
		const ws = allowedIn(s, 'workspace') ? validate(s, workspace[s.id]) : undefined;
		const us = validate(s, user[s.id]);
		if (ws !== undefined) out.set(s.id, { value: ws, source: 'workspace' });
		else if (us !== undefined) out.set(s.id, { value: us, source: 'user' });
		else out.set(s.id, { value: s.default, source: 'default' });
	}
	return out;
}

/** Settings editor search: every word must appear in the id, its readable title, or the description. */
export function matchesQuery(schema: SettingSchema, query: string): boolean {
	const { category, label } = settingTitle(schema);
	const hay = `${schema.id} ${category} ${label} ${schema.group} ${schema.description}`.toLowerCase();
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((w) => hay.includes(w));
}

/** VS Code's settings editor title: `editor.minimap.enabled` → "Editor › Minimap" + "Enabled". */
export function settingTitle(schema: SettingSchema): { category: string; label: string } {
	const parts = schema.id.split('.');
	const words = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
	return { category: parts.slice(0, -1).map(words).join(' › '), label: words(parts[parts.length - 1]) };
}

/** A JSON schema for settings.json, so Monaco's JSON support completes and validates it. */
export function jsonSchema(schemas: SettingSchema[] = SETTINGS) {
	const properties: Record<string, unknown> = {};
	for (const s of schemas) {
		const base: Record<string, unknown> = { type: s.type, default: s.default, description: s.description };
		if (s.type === 'string' && s.enum) {
			base.enum = s.enum;
			if (s.enumDescriptions) base.enumDescriptions = s.enumDescriptions;
		}
		if (s.type === 'number') {
			if (s.integer) base.type = 'integer';
			if (s.minimum !== undefined) base.minimum = s.minimum;
			if (s.maximum !== undefined) base.maximum = s.maximum;
		}
		properties[s.id] = base;
	}
	return { type: 'object', properties };
}
