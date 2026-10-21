import type { markdown as en } from '../en/markdown';

export const markdown = {
	'markdown.validate.noSuchReference': "ไม่พบ link definition: '{ref}'",
	'markdown.validate.noSuchHeader': "ไม่พบหัวข้อ: '{fragment}'",
	'markdown.validate.noSuchFile': 'ไม่มีไฟล์ที่ path: {path}',
	'markdown.validate.noSuchHeaderInFile': "ไม่มีหัวข้อนี้ในไฟล์ '{path}': {fragment}",
	'markdown.validate.unusedDefinition': "ไม่มีลิงก์ใดใช้ link definition '{ref}'",
	'markdown.validate.duplicateDefinition': "มี link definition ของ '{ref}' อยู่แล้ว",
	'markdown.link.follow': 'เปิดลิงก์',
	'markdown.link.definition': 'ไปที่ link definition',
	'markdown.link.missing': 'ไม่พบไฟล์: {path}',
	'markdown.completion.header': 'หัวข้อในไฟล์นี้',
	'markdown.completion.workspaceHeader': 'หัวข้อใน {path}',
	'markdown.completion.definition': 'Link definition: {href}',
	'markdown.rename.cantRename': 'เปลี่ยนชื่อได้เฉพาะหัวข้อ ลิงก์ไปหัวข้อ หรือลิงก์ภายนอก',
	'markdown.rename.label': "เปลี่ยนชื่อ '{name}'",
	'markdown.rename.done': "เปลี่ยนชื่อเป็น '{name}' แล้ว: แก้ {edits} จุดใน {files} ไฟล์",
	'markdown.updateLinks.question': "อัปเดตลิงก์ Markdown ที่ชี้ไป '{name}' ไหม",
	'markdown.updateLinks.detail': 'มี {count} ลิงก์ใน {files} ไฟล์ที่ชี้ไป path ที่ย้าย',
	'markdown.updateLinks.update': 'อัปเดตลิงก์',
	'markdown.updateLinks.always': 'ทำเสมอ',
	'markdown.updateLinks.skip': 'ไม่อัปเดต',
	'markdown.updateLinks.label': "อัปเดตลิงก์ไป '{name}'",
	'markdown.updateLinks.done': 'อัปเดต {count} ลิงก์แล้ว',
	'markdown.updateLinks.failed': 'อัปเดตลิงก์ Markdown ไม่ได้: {reason}',
	'markdown.drop.copyFailed': 'คัดลอก {name} เข้า workspace ไม่ได้: {error}'
} satisfies Record<keyof typeof en, string>;
