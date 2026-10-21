import type { home as en } from '../en/home';

export const home = {
	'home.label': 'หน้าแรก',
	'home.continue': 'ทำต่อ',
	'home.startChat': 'เริ่มแชตกับ agent ของคุณ',
	'home.chatDetail': '{agent} · {when}',
	'home.projects': 'โปรเจกต์ล่าสุด',
	'home.openFolder': 'เปิดโฟลเดอร์…',
	'home.openFailed': 'เปิดแชตไม่ได้: {error}',
	'home.shortcut.openChat': 'เปิดแชต',
	'home.shortcut.showCommands': 'แสดงคำสั่งทั้งหมด',
	'home.shortcut.goToFile': 'ไปที่ไฟล์',
	'home.shortcut.openFile': 'เปิดไฟล์',
	'home.shortcut.openFolder': 'เปิดโฟลเดอร์',
	'home.shortcut.openFileFolder': 'เปิดไฟล์หรือโฟลเดอร์',
	'home.shortcut.openRecent': 'เปิดล่าสุด',
	'home.shortcut.newUntitledFile': 'ไฟล์ข้อความใหม่ที่ไม่มีชื่อ',
	'home.shortcut.findInFiles': 'ค้นหาในไฟล์',
	'home.shortcut.toggleTerminal': 'เปิด/ปิด Terminal',
	'home.shortcut.startDebugging': 'เริ่มดีบัก',
	'home.shortcut.openSettings': 'เปิดการตั้งค่า'
} satisfies Record<keyof typeof en, string>;
