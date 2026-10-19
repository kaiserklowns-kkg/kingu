import type { cli as en } from '../en/cli';

export const cli = {
	'cli.installAsk': 'ติดตั้งคำสั่ง kingu ไว้ใน {dir} เพื่อให้ terminal และ agent นอก Kingu สั่งงานแอปได้ (เริ่มงาน เปิดไฟล์ แจ้งเตือน) ไหม',
	'cli.installOk': 'ติดตั้ง',
	'cli.installed': 'ติดตั้งคำสั่ง kingu แล้ว: {path}',
	'cli.installedNotOnPath': 'ติดตั้งคำสั่ง kingu แล้ว: {path} แต่ {dir} ยังไม่อยู่ใน PATH ของ shell ให้เพิ่มเข้าไปเพื่อใช้ kingu นอก Kingu',
	'cli.installFailed': 'ติดตั้งคำสั่ง kingu ไม่สำเร็จ: {error}',
	'cli.uninstalled': 'ลบคำสั่ง kingu แล้ว: {paths}',
	'cli.notInstalled': 'ยังไม่ได้ติดตั้งคำสั่ง kingu ไว้ใน PATH',
	'cli.uninstallFailed': 'ลบคำสั่ง kingu ไม่สำเร็จ: {error}',
	'cli.noFolder': 'ยังไม่ได้เปิดโฟลเดอร์ใน Kingu',
	'cli.outsideFolder': '{path} ไม่ได้อยู่ในโฟลเดอร์ที่เปิดใน Kingu ให้เปิดโฟลเดอร์ของมันก่อน (kingu open <โฟลเดอร์>)',
	'cli.folderNotOpened': 'Kingu ไม่ได้เปิด {path}',
	'cli.taskNotCreated': 'ไม่ได้สร้างงาน (ดูการแจ้งเตือนใน Kingu)',
	'cli.unknownRequest': 'ไม่รู้จักคำขอ: {method}'
} satisfies Record<keyof typeof en, string>;
