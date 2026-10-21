import type { settings as en } from '../en/settings';

export const settings = {
	'settings.apply.autoSaveFailed': 'บันทึกอัตโนมัติไม่สำเร็จ: {error}',
	'settings.contributions.saveFailed': 'บันทึกการตั้งค่าไม่สำเร็จ: {error}',
	'settings.contributions.themePlaceholder': 'เลือกธีมสี (ลูกศรขึ้น/ลงเพื่อดูตัวอย่าง)',
	'settings.contributions.lightThemes': 'ธีมสว่าง',
	'settings.contributions.darkThemes': 'ธีมมืด',
	'settings.contributions.highContrastThemes': 'ธีมคอนทราสต์สูง',
	'settings.registry.invalidValue': 'ค่า {value} ไม่ถูกต้อง จึงใช้ค่าจากชั้นถัดไปแทน (ต้องเป็น {expected})',
	'settings.registry.userOrRepoOnly': 'ตั้งได้เฉพาะใน User หรือ Repository (ที่ Kingu เก็บไว้เอง) ไม่ใช่ไฟล์ของ repository',
	'settings.registry.userOnly': 'ตั้งได้เฉพาะใน User จึงถูกละไว้',
	'settings.sections.aiCapabilities': 'ความสามารถ AI (AI Capabilities)',
	'settings.sections.system': 'ระบบ (System)',
	'settings.sections.ide': 'IDE',
	'settings.sections.ade': 'ADE (Agents)',
	'settings.sections.snaps': 'Snaps',
	'settings.page.searchResults': 'ผลการค้นหา',
	'settings.page.allSettings': 'การตั้งค่าทั้งหมด (IDE + ADE)'
} satisfies Record<keyof typeof en, string>;
