// Settings schema registry and layering (VS Code: configurationRegistry + ConfigurationModel).
// Pure, so `bun test` can exercise it: defaults < user < workspace, each value checked against
// its schema so a bad value in a file falls back instead of breaking the workbench.

import { DEFAULT_THEME, THEMES } from '../theme/themes';

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
	}
];

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
export function jsonSchema() {
	const properties: Record<string, unknown> = {};
	for (const s of SETTINGS) {
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
