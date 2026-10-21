import type { localHistory as en } from '../en/localHistory';

export const localHistory = {
	'localHistory.title': 'ประวัติในเครื่อง',
	'localHistory.gitTitle': 'ประวัติ Git',
	'localHistory.filter': 'กรอง Timeline',
	'localHistory.source.saved': 'บันทึกไฟล์',
	'localHistory.source.restored': 'กู้คืนไฟล์',
	'localHistory.source.undoRedo': 'เลิกทำ / ทำซ้ำ',

	'localHistory.compareWithFile': 'เทียบกับไฟล์',
	'localHistory.compareWithPrevious': 'เทียบกับรายการก่อนหน้า',
	'localHistory.selectForCompare': 'เลือกไว้เทียบ',
	'localHistory.compareWithSelected': 'เทียบกับที่เลือกไว้',
	'localHistory.showContents': 'แสดงเนื้อหา',
	'localHistory.restore': 'กู้คืนเนื้อหา',
	'localHistory.rename': 'เปลี่ยนชื่อ',
	'localHistory.delete': 'ลบ',
	'localHistory.findEntry': 'ประวัติในเครื่อง: หารายการที่จะกู้คืน...',

	'localHistory.restoreButton': 'กู้คืน',
	'localHistory.confirmRestore': "กู้คืนเนื้อหาของ '{name}' ไหม",
	'localHistory.confirmRestoreDetail': 'การกู้คืนจะทิ้งการแก้ไขที่ยังไม่ได้บันทึก',
	'localHistory.restoreFailed': "กู้คืน '{name}' ไม่ได้: {error}",
	'localHistory.deleteButton': 'ลบ',
	'localHistory.confirmDelete': "ลบรายการประวัติของ '{name}' เมื่อ {date} ไหม",
	'localHistory.confirmDeleteAll': 'ลบประวัติในเครื่องของทุกไฟล์ไหม',
	'localHistory.irreversible': 'ย้อนกลับไม่ได้',
	'localHistory.renamePlaceholder': 'ใส่ชื่อใหม่ของรายการประวัติ',
	'localHistory.renameHint': "เปลี่ยนชื่อเป็น '{name}'",
	'localHistory.createPlaceholder': "ใส่ชื่อของรายการประวัติใหม่ของ '{name}'",
	'localHistory.createHint': "สร้างรายการ '{name}'",
	'localHistory.notTracked': "'{name}' ไม่ถูกเก็บในประวัติ (ใหญ่เกิน ถูกยกเว้น หรือปิดประวัติในเครื่องอยู่)",
	'localHistory.noFile': 'เปิดไฟล์ในโฟลเดอร์ก่อน',
	'localHistory.none': 'ยังไม่มีประวัติในเครื่อง',
	'localHistory.pickFile': 'เลือกไฟล์ที่จะดูประวัติ',
	'localHistory.pickEntry': 'เลือกรายการประวัติที่จะเปิด'
} satisfies Record<keyof typeof en, string>;
