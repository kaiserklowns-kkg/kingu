import type { chatInput as en } from '../en/chatInput';

export const chatInput = {
	'chatInput.slash.list': 'คำสั่ง',
	'chatInput.slash.hint': '↑↓ เลือก · Enter หรือ Tab เติมคำสั่ง · Esc ปิด',
	'chatInput.slash.clear': 'เริ่มแชตใหม่',
	'chatInput.slash.model': 'เลือกโมเดล',
	'chatInput.slash.fork': 'แยกแชตนี้ออกเป็นแชตใหม่',
	'chatInput.slash.source.kingu': 'Kingu',
	'chatInput.slash.source.session': 'Claude Code',
	'chatInput.slash.source.project': 'โฟลเดอร์นี้',
	'chatInput.slash.source.user': 'ของคุณ',
	'chatInput.slash.source.projectSkill': 'Skill · โฟลเดอร์นี้',
	'chatInput.slash.source.userSkill': 'Skill · ของคุณ',

	'chatInput.send.queue': 'เข้าคิว',
	'chatInput.send.queueHint': 'ต่อคิวข้อความนี้ไว้ ส่งเมื่อรอบปัจจุบันจบ',
	'chatInput.send.steer': 'ส่งไปปรับทิศทาง',
	'chatInput.send.steerHint': 'ส่งข้อความนี้เดี๋ยวนี้ agent จะอ่านเมื่อมีจังหวะถัดไป',
	'chatInput.send.stop': 'หยุดแล้วส่ง',
	'chatInput.send.stopHint': 'หยุดรอบปัจจุบัน แล้วส่งข้อความนี้',
	'chatInput.send.more': 'วิธีส่งอื่น ๆ',

	'chatInput.queue.edit': 'แก้ไข',
	'chatInput.queue.editHint': 'ย้ายข้อความนี้กลับไปที่ช่องพิมพ์',
	'chatInput.queue.sendNow': 'ส่งทันที',
	'chatInput.queue.sendNowHint': 'ส่งข้อความนี้เดี๋ยวนี้ เพื่อปรับทิศทางรอบที่กำลังทำงาน',

	'chatInput.perm.allowOnce': 'อนุญาตครั้งนี้',
	'chatInput.perm.more': 'วิธีอนุญาตอื่น ๆ',
	'chatInput.perm.session': 'อนุญาตใน session นี้',
	'chatInput.perm.sessionHint': 'จนกว่า session ของแชตนี้จะจบ',
	'chatInput.perm.workspace': 'อนุญาตใน workspace นี้',
	'chatInput.perm.workspaceHint': 'บันทึกใน .claude/settings.local.json ของโฟลเดอร์นี้ (ไม่ถูก commit)',
	'chatInput.perm.user': 'อนุญาตเสมอ',
	'chatInput.perm.userHint': 'ทุกโฟลเดอร์ บันทึกในการตั้งค่า Claude ของคุณ (~/.claude/settings.json)',
	'chatInput.perm.rules': 'กฎ: {rules}',
	'chatInput.perm.wholeTool': 'กฎ: {tool} ทุกครั้ง',
	'chatInput.perm.command': 'คำสั่ง',

	'chatInput.allowAll': 'อนุญาตทั้งหมด',
	'chatInput.allowAllConfirm':
		'อนุญาตทั้งหมดจะให้ agent ใช้เครื่องมือทุกอย่างโดยไม่ถาม รวมถึงคำสั่ง shell และการแก้ไฟล์ จนกว่าคุณจะเลือกระดับอื่น ใช้กับแชตนี้จนกว่าจะปิด Kingu ทำต่อไหม?',
	'chatInput.allowAllNote': 'อนุญาตทั้งหมด: เครื่องมือทำงานโดยไม่ถาม',

	'chatInput.ctx.label': 'context window: ใช้ไป {percent}%',
	'chatInput.ctx.title': 'Context Window',
	'chatInput.ctx.used': '{used} / {max} token ({percent}%)',
	'chatInput.ctx.cost': 'ค่าใช้จ่ายของ session: {cost}',
	'chatInput.ctx.warn': 'คุณภาพอาจลดลงเมื่อใกล้เต็ม ใช้ Compact เพื่อสรุปบทสนทนาที่ผ่านมา',
	'chatInput.ctx.compact': 'Compact',
	'chatInput.ctx.compactHint': 'ส่ง /compact ให้ agent สรุปบทสนทนา เพื่อคืนพื้นที่ใน context window'
} satisfies Record<keyof typeof en, string>;
