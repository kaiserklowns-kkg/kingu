import type { composer as en } from '../en/composer';

export const composer = {
	'composer.placeholder.agent': 'วางแผน ค้นหา สร้างได้ทุกอย่าง',
	'composer.placeholder.followUp': 'ถามหรือสั่งต่อ',
	'composer.placeholder.ask': 'ถาม เรียนรู้ ระดมความคิด',
	'composer.placeholder.askFollowUp': 'ถามต่อ',
	'composer.placeholder.plan': 'วางแผนการแก้ไข',
	'composer.placeholder.planFollowUp': 'ปรับแผนให้ดีขึ้น',
	'composer.placeholder.custom': 'ส่งข้อความถึง {name}',
	'composer.placeholder.customFollowUp': 'สั่ง {name} ต่อ',
	'composer.placeholder.running': 'ต่อคิวข้อความ (ส่งเมื่อรอบนี้จบ)',
	'composer.placeholder.pending': 'ปฏิเสธ แนะนำ หรือสั่งต่อ?',
	'composer.placeholder.editingQueued': 'กำลังแก้ข้อความในคิว…',

	'composer.mode.label': 'โหมด: {mode}',
	'composer.mode.hint': 'เปลี่ยนโหมด ({key} หรือ ⇧Tab)',
	'composer.mode.footer': '{key} หรือ ⇧Tab เปลี่ยนไปโหมดถัดไป',
	'composer.mode.agentHint': 'วางแผน ค้นหา แก้ไฟล์ และรันคำสั่ง',
	'composer.mode.askHint': 'ตอบคำถามโดยไม่แก้ไฟล์',
	'composer.mode.planHint': 'อ่านโค้ดแล้วเสนอแผนก่อน',

	'composer.model.label': 'โมเดล: {model}',
	'composer.model.hint': 'โมเดล: {model} ({key})',
	'composer.model.search': 'ค้นหาโมเดล',
	'composer.model.default': 'ค่าเริ่มต้น',

	'composer.options.label': 'ตัวเลือกแชต',
	'composer.options.hint': 'รันด้วย {runtime} ใน {where} · {run}',

	'composer.run.title': 'โหมดการรัน',
	'composer.run.ask': 'ถามทุกครั้ง',
	'composer.run.askHint': 'ถามก่อนใช้เครื่องมือที่ไม่อยู่ในรายการที่อนุญาต',
	'composer.run.edits': 'ยอมรับการแก้ไฟล์อัตโนมัติ',
	'composer.run.editsHint': 'แก้ไฟล์ได้เลย ส่วนคำสั่งยังถามก่อน',
	'composer.run.all': 'รันทุกอย่าง',
	'composer.run.allHint': 'ทุกเครื่องมือรันโดยไม่ถาม รวมถึงคำสั่ง',
	'composer.run.global': 'เปิดอนุมัติอัตโนมัติทั้งหมดอยู่',

	'composer.menu.search': 'ค้นหา',
	'composer.menu.none': 'ไม่พบรายการ',

	'composer.slash.skills': 'Skill',
	'composer.slash.commands': 'คำสั่ง',
	'composer.slash.modes': 'โหมด',
	'composer.slash.actions': 'การทำงาน',
	'composer.slash.source.mode': 'โหมด',
	'composer.slash.modeSwitch': 'เปลี่ยนเป็น {mode}',

	'composer.mention.recent': 'ไฟล์ล่าสุด',
	'composer.mention.context': 'บริบท',
	'composer.mention.files': 'ไฟล์และโฟลเดอร์',
	'composer.mention.back': 'กลับไปที่บริบททั้งหมด',

	'composer.send.queueTitle': '{action} (⏎) · {alt} อีกแบบ · {stop} หยุดแล้วส่ง · คลิกขวาดูเพิ่ม',
	'composer.drop': 'วางไฟล์เพื่อแนบ',

	'composer.status.label': 'สถานะ agent',
	'composer.status.running': 'กำลังสร้างคำตอบ',
	'composer.status.waiting': 'รอการอนุมัติ',
	'composer.status.edited': 'แก้ไข {count} ไฟล์',

	'composer.review.review': 'ตรวจดู',
	'composer.review.reviewHint': 'เปิด diff ของทุกไฟล์ที่เปลี่ยน',
	'composer.review.confirm': 'ยืนยัน',
	'composer.review.confirmHint': 'คลิกอีกครั้งเพื่อยืนยันการย้อน',

	'composer.queue.title': 'ในคิว {count} ข้อความ',
	'composer.queue.edit': 'แก้ข้อความในคิว',
	'composer.queue.steer': 'ส่งไปปรับทิศทาง',
	'composer.queue.steerHint': 'ส่งไปปรับทิศทาง: ส่งเดี๋ยวนี้โดยไม่ขัดจังหวะ agent',
	'composer.queue.sendNow': 'ส่งเดี๋ยวนี้',
	'composer.queue.sendNowHint': 'ส่งเดี๋ยวนี้: หยุด agent แล้วส่งข้อความนี้',
	'composer.queue.interrupt': 'ขัดจังหวะ: หยุด agent แล้วส่ง',
	'composer.queue.remove': 'เอาออกจากคิว',
	'composer.queue.more': 'การทำงานเพิ่มเติม',
	'composer.queue.moveUp': 'เลื่อนขึ้น',
	'composer.queue.moveDown': 'เลื่อนลง',
	'composer.queue.drag': 'ลากเพื่อเรียงลำดับ',
	'composer.editingQueued': 'กำลังแก้ข้อความในคิว',

	'composer.approve.run': 'รัน',
	'composer.approve.skip': 'ข้าม',
	'composer.approve.skipHint': 'ข้ามการเรียกนี้ (ปฏิเสธ) และแจ้ง agent',
	'composer.approve.reason': 'ข้ามพร้อมเหตุผล…',
	'composer.approve.reasonHint': 'บอก agent ว่าทำไมจึงข้ามการเรียกนี้',
	'composer.approve.allowlistTool': 'อนุญาต {tool} เสมอ',
	'composer.approve.allowlistMany': 'เพิ่ม {count} กฎในรายการที่อนุญาต'
} satisfies Record<keyof typeof en, string>;
