import { describe, expect, test } from 'bun:test';
import { ADE_SECTION_GROUPS, AI_SECTION_GROUPS } from './ade';
import { isPane, ORCA_NAV, ORCA_SECTION_IDS, PAGE_GROUPS, paneLabel, paneText, PANES, PROJECT_GROUPS } from './panes';
import { SETTINGS, SETTINGS_SECTIONS } from './registry';
import { ORCA_PANES, PANE_REST_GROUPS, PANE_SETTING_IDS, paneSettingIds, PROJECT } from './orcaPane';
import { allowedIn } from './registry';
import { en } from '../i18n/en';

describe('settings panes', () => {
	test('every AI Capabilities and ADE group is an Orca pane with a description', () => {
		for (const g of [...AI_SECTION_GROUPS, ...ADE_SECTION_GROUPS]) {
			expect(isPane(g)).toBe(true);
			expect(Object.hasOwn(en, PANES[g].description)).toBe(true);
		}
	});

	test('IDE and system groups stay in the VS Code editor', () => {
		for (const sec of SETTINGS_SECTIONS.filter((s) => s.id === 'ide' || s.id === 'system')) for (const g of sec.groups) expect(isPane(g)).toBe(false);
	});

	test('the project pane lists ADE groups that have repository settings', () => {
		for (const g of PROJECT_GROUPS) {
			expect(ADE_SECTION_GROUPS).toContain(g);
			expect(SETTINGS.some((s) => s.group === g && s.scope !== 'application')).toBe(true);
		}
	});

	test("Orca's part of the table of contents lists every AI and ADE group and each page once", () => {
		const items = ORCA_NAV.flatMap((sec) => sec.items).map((it) => ('page' in it ? `page:${it.page}` : 'pane' in it ? `pane:${it.pane}` : it.group));
		expect(new Set(items).size).toBe(items.length);
		const groups = SETTINGS_SECTIONS.filter((s) => ORCA_SECTION_IDS.has(s.id)).flatMap((s) => s.groups);
		// A group is a pane of its own, or the "More" part of an Orca pane, and never both.
		const own = items.filter((i) => !i.includes(':'));
		expect([...own, ...PANE_REST_GROUPS, ...PAGE_GROUPS].toSorted()).toEqual(groups.toSorted());
		for (const item of items.filter((i) => i.startsWith('pane:'))) expect(ORCA_PANES[item.slice(5)]).toBeDefined();
		for (const page of SETTINGS_SECTIONS.flatMap((s) => s.pages ?? [])) expect(items).toContain(`page:${page}`);
	});

	test('pane rows say a description once, in the UI language, without source references', () => {
		const text = 'ถามก่อนลบไฟล์ (VS Code: chat.tools.confirm) (Ask before deleting files.)';
		expect(paneText(text, 'th')).toBe('ถามก่อนลบไฟล์');
		expect(paneText(text, 'en')).toBe('Ask before deleting files.');
		expect(paneText('Only English (with a note).', 'th')).toBe('Only English (with a note).');
		expect(paneText('แสดงปุ่ม Artifacts (หน้าที่ agent เผยแพร่) ใน activity bar (Show the Artifacts view.)', 'th')).toBe('แสดงปุ่ม Artifacts (หน้าที่ agent เผยแพร่) ใน activity bar');
		expect(paneLabel('Mcp Tools')).toBe('MCP Tools');
	});

	test('Orca pane rows name real settings, once', () => {
		for (const id of PANE_SETTING_IDS) expect(SETTINGS.some((s) => s.id === id)).toBe(true);
		expect(new Set(PANE_SETTING_IDS).size).toBe(PANE_SETTING_IDS.length);
	});

	test('the project pane only edits settings the repository scope may hold', () => {
		for (const id of paneSettingIds(PROJECT)) {
			const s = SETTINGS.find((x) => x.id === id);
			expect(s && allowedIn(s, 'repo')).toBe(true);
		}
	});
});
