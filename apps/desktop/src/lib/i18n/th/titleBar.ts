// Thai for ../en/titleBar.ts (ช่องค้นหา สถานะ agent และปุ่มแชต Arkai ในแถบชื่อเรื่อง).
import type { titleBar as en } from '../en/titleBar';

export const titleBar = {
	'titleBar.search': 'ค้นหา',
	'titleBar.searchFilesAndCommands': 'ค้นหาไฟล์และคำสั่ง',
	'titleBar.openQuickAccess': 'เปิด Quick Access',
	'titleBar.switchProject': 'สลับโปรเจกต์',
	'titleBar.switchBranch': 'สลับ branch',
	'titleBar.working.one': '{name} กำลังทำงาน',
	'titleBar.working.many': '{count} กำลังทำงาน',
	'titleBar.waiting.one': '{name} รอคุณอยู่',
	'titleBar.waiting.many': '{count} รอคุณอยู่',
	'titleBar.filterHint': 'คลิกเพื่อแสดงเฉพาะ session กลุ่มนี้ คลิกอีกครั้งเพื่อล้างตัวกรอง',
	'titleBar.chat.hover': 'เปิด/ปิดแชต (Arkai) — คลิกขวาเพื่อดูคำสั่งเพิ่ม',
	'titleBar.chat.aria': 'เปิด/ปิดแชต คลิกขวาเพื่อดูคำสั่งแชตเพิ่ม',
	'titleBar.chat.menu': 'แชต'
} satisfies Record<keyof typeof en, string>;
