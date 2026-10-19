import type { arkai as en } from '../en/arkai';

export const arkai = {
	'arkai.picker.label': 'โมเดลของ Arkai',
	'arkai.picker.hint': 'โมเดลที่ Arkai ใช้: ผู้ให้บริการของคุณใน kingu.arkai.providers และ Ollama บนเครื่องนี้',
	'arkai.picker.loading': 'กำลังหาโมเดล…',
	'arkai.picker.none': 'ยังไม่มีโมเดล: ตั้งค่าผู้ให้บริการก่อน',
	'arkai.picker.noKey': '{name} (ยังไม่มี API key)',
	'arkai.settings.title': 'ผู้ให้บริการโมเดล',
	'arkai.settings.hint': 'Arkai ใช้โมเดลเหล่านี้ในแชต เพิ่มผู้ให้บริการได้ใน settings.json ที่ kingu.arkai.providers ส่วน Ollama บนเครื่องนี้จะพบเอง API key เก็บไว้ในพวงกุญแจ (Keychain) ของ macOS',
	'arkai.settings.empty': 'ยังไม่มีผู้ให้บริการ เปิด Ollama หรือเพิ่มใน kingu.arkai.providers',
	'arkai.settings.refresh': 'รีเฟรช',
	'arkai.settings.models': '{count|# โมเดล|# โมเดล}',
	'arkai.settings.local': 'บนเครื่องนี้',
	'arkai.settings.found': 'พบเอง',
	'arkai.settings.hasKey': 'มี API key ในพวงกุญแจแล้ว',
	'arkai.settings.noKey': 'ยังไม่มี API key',
	'arkai.settings.keyLabel': 'API key ของ {name}',
	'arkai.settings.keyPlaceholder': 'วาง API key ที่นี่',
	'arkai.settings.saveKey': 'บันทึก Key',
	'arkai.settings.removeKey': 'ลบ Key',
	'arkai.settings.listFailed': 'ดึงรายชื่อโมเดลไม่ได้: {error}',
	'arkai.settings.keyFailed': 'เปลี่ยน API key ไม่ได้: {error}'
} satisfies Record<keyof typeof en, string>;
