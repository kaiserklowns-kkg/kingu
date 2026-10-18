import type { common as en } from '../en/common';

export const common = {
	'common.ok': 'ตกลง',
	'common.cancel': 'ยกเลิก',
	'common.close': 'ปิด',
	'common.delete': 'ลบ',
	'common.remove': 'เอาออก',
	'common.save': 'บันทึก',
	'common.dontSave': 'ไม่บันทึก',
	'common.open': 'เปิด',
	'common.retry': 'ลองอีกครั้ง',
	'common.yes': 'ใช่',
	'common.no': 'ไม่',
	'common.continue': 'ทำต่อ',
	'common.run': 'รัน',
	'common.stop': 'หยุด',
	'common.copy': 'คัดลอก',
	'common.copied': 'คัดลอกแล้ว',
	'common.loading': 'กำลังโหลด…'
} satisfies Record<keyof typeof en, string>;
