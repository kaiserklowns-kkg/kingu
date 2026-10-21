import type { chatParts as en } from '../en/chatParts';

export const chatParts = {
	'chatParts.todos.label': 'รายการสิ่งที่ต้องทำของแชต',
	'chatParts.todos.title': 'สิ่งที่ต้องทำ',
	'chatParts.todos.titleCount': 'สิ่งที่ต้องทำ ({n}/{total})',
	'chatParts.todos.current': '{title} ({n}/{total})',
	'chatParts.todos.expand': 'แสดงสิ่งที่ต้องทำ',
	'chatParts.todos.collapse': 'ย่อสิ่งที่ต้องทำ',
	'chatParts.todos.item': '{title}, {status}',
	'chatParts.todos.completed': 'เสร็จแล้ว',
	'chatParts.todos.inProgress': 'กำลังทำ',
	'chatParts.todos.notStarted': 'ยังไม่เริ่ม',
	'chatParts.todos.updating': 'กำลังอัปเดตสิ่งที่ต้องทำ',
	'chatParts.todos.updated': 'อัปเดตสิ่งที่ต้องทำแล้ว',
	'chatParts.plan.title': 'แผนงาน',
	'chatParts.edit.open': 'เปิดดูการแก้ {path}',
	'chatParts.changes.files': 'เปลี่ยน {count} ไฟล์',
	'chatParts.changes.viewAll': 'ดูการเปลี่ยนแปลงทุกไฟล์',
	'chatParts.changes.toggle': 'แสดงหรือซ่อนไฟล์ที่เปลี่ยน',
	'chatParts.subagent.tools': 'เรียกเครื่องมือ {count} ครั้ง',
	'chatParts.subagent.pending': 'รออนุญาต {count} รายการ',
	'chatParts.subagent.prompt': 'คำสั่ง',
	'chatParts.subagent.result': 'ผลลัพธ์',
	'chatParts.code.newFile': 'ใส่ในไฟล์ใหม่',
	'chatParts.code.terminal': 'ใส่ใน terminal',
	'chatParts.code.noTerminal': 'เปิดโฟลเดอร์ก่อนจึงจะใช้ terminal ได้',
	'chatParts.code.newFileFailed': 'ใส่โค้ดในไฟล์ใหม่ไม่ได้'
} satisfies Record<keyof typeof en, string>;
