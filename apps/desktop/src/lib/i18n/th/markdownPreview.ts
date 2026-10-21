import type { markdownPreview as en } from '../en/markdownPreview';

export const markdownPreview = {
	'markdownPreview.openFailed': 'เปิด preview ไม่ได้: {error}',
	'markdownPreview.linkCopied': 'คัดลอกลิงก์แล้ว: {url}',
	'markdownPreview.linkFailed': 'เปิดลิงก์ไม่ได้: {error}',
	'markdownPreview.linkBlocked': 'preview ไม่เปิดลิงก์แบบนี้: {url}',
	'markdownPreview.remoteImage': 'ไม่โหลดรูปจากภายนอก: {src}',
	'markdownPreview.imageFailed': 'โหลดรูปไม่ได้: {src}',
	'markdownPreview.locked': 'ล็อก preview ไว้ที่ {name}',
	'markdownPreview.unlocked': 'preview จะตาม editor Markdown ที่ใช้อยู่'
} satisfies Record<keyof typeof en, string>;
