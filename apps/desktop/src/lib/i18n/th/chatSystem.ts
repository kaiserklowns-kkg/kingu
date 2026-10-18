// ข้อความของระบบในแชต: การตรวจความปลอดภัย กฎของโปรเจกต์ ชื่อแชตจาก AI การแจ้งเตือน และกลุ่มวันที่ในประวัติ
// (คีย์และ {params} เดียวกับ ../en/chatSystem.ts)
import type { chatSystem as en } from '../en/chatSystem';

export const chatSystem = {
	'chat.guard.blocked': 'ถูกบล็อกโดยการตรวจความปลอดภัยของ Kingu: {reason}',
	'chat.guard.repetition': 'เรียกเครื่องมือเดิมด้วยค่าเดิมเป็นครั้งที่สามติดกัน',
	'chat.guard.threat.rmRfRootBare': 'ลบทั้งระบบไฟล์',
	'chat.guard.threat.rmRfHomeOrRoot': 'ลบโฟลเดอร์ home หรือ root',
	'chat.guard.threat.ddDestruction': 'เขียนทับดิสก์ด้วย dd',
	'chat.guard.threat.formatDrive': 'ฟอร์แมตไดรฟ์ของระบบ',
	'chat.guard.threat.curlBashExecution': 'รันสคริปต์ที่ดาวน์โหลดมาใน shell',
	'chat.guard.threat.reverseShell': 'เปิด reverse shell',
	'chat.guard.threat.sudoWithoutPassword': 'ให้สิทธิ์ sudo โดยไม่ต้องใช้รหัสผ่าน',
	'chat.guard.threat.kernelModuleManipulation': 'โหลดหรือถอด kernel module',
	'chat.rules.chip': 'กฎ {count} ข้อ',
	'chat.rules.hint': 'ไฟล์กฎที่ agent ทำตามในแชตนี้ (AGENTS.md, .cursor/rules, คำแนะนำของ Copilot) คลิกเพื่อเปิดไฟล์',
	'chat.rules.pick': 'กฎของแชตนี้: เลือกไฟล์ที่จะเปิด',
	'chat.rules.kind.agents': 'AGENTS.md',
	'chat.rules.kind.cursor': 'กฎของ Cursor',
	'chat.rules.kind.copilot': 'คำแนะนำของ Copilot',
	'chat.rules.always': 'ใช้เสมอ',
	'chat.rules.matched': 'ตรงกับไฟล์ที่แนบ',
	'chat.notify.approvalTitle': 'แชตรอการอนุญาต: {title}',
	'chat.notify.approvalBody': 'ต้องอนุญาตก่อนจึงจะทำงานต่อได้',
	'chat.notify.questionTitle': 'แชตมีคำถาม: {title}',
	'chat.notify.questionBody': 'มีคำถามรอคำตอบจากคุณ',
	'chat.notify.finishedTitle': 'แชตเสร็จแล้ว: {title}',
	'chat.notify.finishedBody': 'agent ทำรอบนี้เสร็จแล้ว',
	'chat.notify.failedTitle': 'แชตล้มเหลว: {title}',
	'chat.notify.failedBody': 'agent หยุดเพราะเกิดข้อผิดพลาด',
	'chat.history.today': 'วันนี้',
	'chat.history.yesterday': 'เมื่อวาน',
	'chat.history.week': '7 วันที่ผ่านมา',
	'chat.history.older': 'เก่ากว่านั้น'
} satisfies Record<keyof typeof en, string>;
