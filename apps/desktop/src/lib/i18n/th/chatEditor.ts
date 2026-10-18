import type { chatEditor as en } from '../en/chatEditor';

export const chatEditor = {
	'chatEditor.keepHunk': 'เก็บการแก้นี้ไว้',
	'chatEditor.undoHunk': 'ย้อนการแก้นี้',
	'chatEditor.keepFile': 'เก็บการแก้ของแชตในไฟล์นี้',
	'chatEditor.undoFile': 'ย้อนการแก้ของแชตในไฟล์นี้',
	'chatEditor.next': 'ไปที่การแก้ถัดไปของแชต',
	'chatEditor.previous': 'ไปที่การแก้ก่อนหน้าของแชต',
	'chatEditor.position': '{index} จาก {count}',
	'chatEditor.changes': '{count} จุดที่แก้',
	'chatEditor.overlay': 'การแก้ของ agent ในไฟล์นี้',
	'chatEditor.running': 'เก็บไว้หรือย้อนกลับได้เมื่อ agent ทำรอบนี้เสร็จ',
	'chatEditor.kept': 'เก็บการแก้นี้แล้ว',
	'chatEditor.undone': 'ย้อนการแก้นี้แล้ว'
} satisfies Record<keyof typeof en, string>;
