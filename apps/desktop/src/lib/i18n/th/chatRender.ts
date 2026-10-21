import type { chatRender as en } from '../en/chatRender';

export const chatRender = {
	'chatRender.pasted': 'ข้อความที่วาง ({count} บรรทัด)',
	'chatRender.references': 'ใช้ {count} แหล่งอ้างอิง',
	'chatRender.referencesList': 'แหล่งอ้างอิง',
	'chatRender.referenceOpen': 'เปิด {path}',
	'chatRender.mermaid.label': 'แผนภาพ Mermaid',
	'chatRender.mermaid.source': 'แสดงโค้ด',
	'chatRender.mermaid.diagram': 'แสดงแผนภาพ',
	'chatRender.mermaid.drawing': 'กำลังวาดแผนภาพ…',
	'chatRender.mermaid.failed': 'วาดแผนภาพไม่ได้: {error}',
	'chatRender.thinking.expand': 'แสดงสิ่งที่คิดทั้งหมด',
	'chatRender.voice.start': 'พูดเป็นข้อความ',
	'chatRender.voice.stop': 'หยุดพูด',
	'chatRender.voice.listening': 'กำลังฟัง… {time}',
	'chatRender.voice.transcribing': 'กำลังถอดเสียง…',
	'chatRender.badge': 'แชตของ agent กำลังทำงาน'
} satisfies Record<keyof typeof en, string>;
