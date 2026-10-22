// Thai for ../en/titleBar.ts (ช่องค้นหา สถานะ agent และปุ่มแชต Arkai ในแถบชื่อเรื่อง).
import type { titleBar as en } from '../en/titleBar';

export const titleBar = {
	'titleBar.search': 'ค้นหา',
	'titleBar.openQuickAccess': 'เปิด Quick Access',
	'titleBar.switchProject': 'สลับโปรเจกต์',
	'titleBar.switchBranch': 'สลับ branch',
	'titleBar.worktreeBranch': 'branch ของ worktree ที่เลือก',
	'titleBar.detached': '(detached HEAD)',
	'titleBar.dirty': 'มีการเปลี่ยนแปลงที่ยังไม่ commit',
	'titleBar.openInAgents': 'เปิดใน Agents',
	'titleBar.openInEditor': 'เปิดใน Editor',
	'titleBar.openInAgents.label': 'Agents',
	'titleBar.openInEditor.label': 'Editor',
	'titleBar.openInAgents.detail': 'สลับไปเลย์เอาต์ Agents (ADE): งาน worktree และ session',
	'titleBar.openInEditor.detail': 'สลับกลับไปเลย์เอาต์ editor (IDE)',
	'titleBar.working.one': '{name} กำลังทำงาน',
	'titleBar.working.many': '{count} กำลังทำงาน',
	'titleBar.waiting.one': '{name} รอคุณอยู่',
	'titleBar.waiting.many': '{count} รอคุณอยู่',
	'titleBar.filterHint': 'คลิกเพื่อแสดงเฉพาะ session กลุ่มนี้ คลิกอีกครั้งเพื่อล้างตัวกรอง',
	'titleBar.chat.hover': 'เปิด/ปิดแชต (Arkai) — คลิกขวาเพื่อดูคำสั่งเพิ่ม',
	'titleBar.chat.aria': 'เปิด/ปิดแชต คลิกขวาเพื่อดูคำสั่งแชตเพิ่ม',
	'titleBar.chat.menu': 'แชต'
} satisfies Record<keyof typeof en, string>;
