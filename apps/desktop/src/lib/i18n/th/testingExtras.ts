import type { testingExtras as en } from '../en/testingExtras';

export const testingExtras = {
	'testingExtras.continuous.toggle': 'เปิด/ปิดการรันต่อเนื่อง',
	'testingExtras.continuous.start': 'เริ่มรันต่อเนื่อง: รันการทดสอบใหม่เมื่อไฟล์ของมันเปลี่ยน',
	'testingExtras.continuous.stop': 'หยุดรันต่อเนื่อง',
	'testingExtras.continuous.on': 'เปิดรันต่อเนื่องแล้ว: การทดสอบจะรันใหม่เมื่อไฟล์ของมันเปลี่ยน',
	'testingExtras.continuous.off': 'ปิดรันต่อเนื่องแล้ว',
	'testingExtras.continuous.watching': 'รายการนี้เปิดรันต่อเนื่องอยู่',
	'testingExtras.menu.continuousOn': 'เปิดรันต่อเนื่อง',
	'testingExtras.menu.continuousOff': 'ปิดรันต่อเนื่อง',
	'testingExtras.coverage.filter': 'กรองไฟล์',
	'testingExtras.coverage.sort': 'เรียงตาม',
	'testingExtras.coverage.sort.location': 'ตำแหน่ง',
	'testingExtras.coverage.sort.name': 'ชื่อ',
	'testingExtras.coverage.sort.coverage': 'coverage'
} satisfies Record<keyof typeof en, string>;
