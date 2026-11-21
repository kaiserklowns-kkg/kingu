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
	'chatToolRules.approvedByMany': 'อนุมัติเองตามกฎ {rules}'
} satisfies Record<keyof typeof en, string>;
