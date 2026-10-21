import type { refactorPreview as en } from '../en/refactorPreview';

export const refactorPreview = {
	'refactorPreview.title': 'Refactor Preview',
	'refactorPreview.apply': 'นำไปใช้',
	'refactorPreview.discard': 'ยกเลิก',
	'refactorPreview.empty': 'ไม่มีการ refactor ที่รอนำไปใช้',
	'refactorPreview.summary': 'เปลี่ยน {edits} จุดใน {files} ไฟล์',
	'refactorPreview.toggle': 'รวมการเปลี่ยนแปลงของ {name}',
	'refactorPreview.toggleEdit': 'รวมการเปลี่ยนแปลงนี้',
	'refactorPreview.line': 'บรรทัด {line}',
	'refactorPreview.collapse': 'ยุบ',
	'refactorPreview.expand': 'ขยาย',
	'refactorPreview.diffLabel': '{name} (Refactor Preview)',
	'refactorPreview.renameLabel': "เปลี่ยนชื่อเป็น '{name}'"
} satisfies Record<keyof typeof en, string>;
