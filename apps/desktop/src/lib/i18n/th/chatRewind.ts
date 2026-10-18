import type { chatRewind as en } from '../en/chatRewind';

export const chatRewind = {
	'chatRewind.restore': 'กลับไปจุดนี้',
	'chatRewind.restoreHint': 'คืนไฟล์ในโฟลเดอร์และบทสนทนากลับไปที่จุดนี้',
	'chatRewind.startOver': 'เริ่มใหม่',
	'chatRewind.startOverHint': 'ล้างแชตนี้และย้อนการแก้ไขทั้งหมด',
	'chatRewind.confirm': 'คำขอนี้และทุกคำขอหลังจากนี้จะถูกลบ และการแก้ไข {count} ไฟล์จะถูกย้อนกลับ ต้องการทำต่อไหม',
	'chatRewind.confirmNoFiles': 'คำขอนี้และทุกคำขอหลังจากนี้จะถูกลบ ต้องการทำต่อไหม',
	'chatRewind.ok': 'ใช่',
	'chatRewind.okDontAsk': 'ใช่ และไม่ต้องถามอีก',
	'chatRewind.restored': 'กลับไปจุดนี้แล้ว',
	'chatRewind.restoredFiles': 'กลับไปจุดนี้แล้ว: ย้อน {count} ไฟล์',
	'chatRewind.redo': 'ทำซ้ำ',
	'chatRewind.redoHint': 'นำคำขอและการแก้ไฟล์ที่ถูกลบไปตอนกลับไปจุดนี้กลับมา',
	'chatRewind.redone': 'นำคำขอที่ถูกลบกลับมาแล้ว',
	'chatRewind.failed': 'กลับไปจุดนี้ไม่ได้: {error}',
	'chatRewind.redoFailed': 'ทำซ้ำไม่ได้: {error}',
	'chatRewind.stopTimeout': 'agent ไม่หยุดภายในเวลาที่กำหนด ลองอีกครั้ง',
	'chatRewind.editHint': 'แก้คำขอนี้แล้วส่งใหม่ (Enter เพื่อส่ง, Escape เพื่อยกเลิก)',
	'chatRewind.editLabel': 'แก้คำขอ',
	'chatRewind.editSend': 'ส่ง',
	'chatRewind.fork': 'แยกบทสนทนา',
	'chatRewind.forkHint': 'แยกบทสนทนาใหม่จากจุดนี้',
	'chatRewind.forkedTitle': 'แยกจาก: {title}',
	'chatRewind.forkedPrefix': 'แยกจาก: ',
	'chatRewind.forkFailed': 'แยกแชตไม่ได้: {error}'
} satisfies Record<keyof typeof en, string>;
