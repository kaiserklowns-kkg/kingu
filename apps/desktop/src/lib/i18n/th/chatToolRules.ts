import type { chatToolRules as en } from '../en/chatToolRules';

export const chatToolRules = {
	'chatToolRules.ask.editRule': 'จะแก้ไฟล์ที่ตั้งให้ถามก่อนแก้ (chat.tools.edits.autoApprove)',
	'chatToolRules.allow.commands': 'อนุญาต {commands} เสมอ',
	'chatToolRules.allow.commandsHint': 'เพิ่ม {keys} ลงใน chat.tools.terminal.autoApprove ของการตั้งค่าผู้ใช้ แล้วรันคำสั่งนี้',
	'chatToolRules.allow.domain': 'อนุญาต {domain} เสมอ',
	'chatToolRules.allow.domainHint': 'เพิ่ม {keys} ลงใน chat.tools.urls.autoApprove ของการตั้งค่าผู้ใช้ แล้วดึงหน้านี้',
	'chatToolRules.saveFailed': 'บันทึกกฎไม่สำเร็จ: {error}',
	'chatToolRules.approvedBy': 'อนุมัติเองตามกฎ {rules}',
	'chatToolRules.assistedApproved': 'Assisted permissions อนุมัติ: {reason}',
	'chatToolRules.assistedAsked': 'Assisted permissions ขอให้คุณตัดสิน: {reason}',
	'chatToolRules.assistedUnavailable': 'ตัวตรวจ Assisted ตัดสินไม่ได้ จึงถามคุณ: {reason}',
	'chatToolRules.approvedByMany': 'อนุมัติเองตามกฎ {rules}',
	'chatToolRules.ask.sandboxRetry': 'sandbox บล็อกคำสั่งนี้ และรันใหม่ได้เมื่อคุณอนุญาตสิ่งที่คำสั่งต้องใช้',
	'chatToolRules.sandbox.session': 'อนุญาตในเซสชันนี้',
	'chatToolRules.sandbox.sessionHint': 'เพิ่มเข้า sandbox ของการรันแชตนี้เท่านั้น แล้วรันคำสั่งใหม่ใน sandbox',
	'chatToolRules.sandbox.user': 'อนุญาตสำหรับผู้ใช้นี้',
	'chatToolRules.sandbox.userHint': 'บันทึกลง {setting} ใน user settings แล้วรันคำสั่งใหม่ใน sandbox',
	'chatToolRules.sandbox.skip': 'ข้าม',
	'chatToolRules.sandbox.skipHint': 'ไม่เปลี่ยน sandbox และบอก agent ว่าคำสั่งยังถูกบล็อก',
	'chatToolRules.sandbox.blockedBy': 'ถูกบล็อกโดย',
	'chatToolRules.sandbox.saveFailed': 'บันทึกลง settings ไม่ได้: {error}'
} satisfies Record<keyof typeof en, string>;
