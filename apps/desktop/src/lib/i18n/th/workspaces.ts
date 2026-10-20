import type { workspaces as en } from '../en/workspaces';

export const workspaces = {
	'workspaces.openFileTitle': 'เปิดไฟล์',
	'workspaces.openFileFailed': 'เปิดไฟล์ไม่ได้: {error}',
	'workspaces.openWorkspaceTitle': 'เปิด workspace จากไฟล์',
	'workspaces.readFailed': 'อ่านไฟล์ workspace {name} ไม่ได้: {error}',
	'workspaces.noFolders': '{name} ไม่มีโฟลเดอร์ที่อยู่ในเครื่องนี้',
	'workspaces.missingFolders': '{name}: มี {count} โฟลเดอร์ที่ไม่อยู่ในเครื่องนี้ จึงไม่ได้เปิด',
	'workspaces.openFolderTitle': 'เปิดโฟลเดอร์',
	'workspaces.addFolderTitle': 'เพิ่มโฟลเดอร์เข้า workspace',
	'workspaces.addFailed': 'เพิ่มโฟลเดอร์ไม่ได้: {error}',
	'workspaces.removeFailed': 'เอาโฟลเดอร์ออกจาก workspace ไม่ได้: {error}',
	'workspaces.newWindowFailed': 'เปิดหน้าต่างใหม่ไม่ได้: {error}',
	'workspaces.untitled': 'ไม่มีชื่อ (Workspace)',
	'workspaces.saveFailed': 'บันทึกไฟล์ workspace ไม่ได้: {error}',
	'workspaces.saved': 'บันทึก {name} แล้ว เปิดได้ด้วย Open Workspace from File',
	'workspaces.recentFolders': 'โฟลเดอร์และ workspace',
	'workspaces.recentFiles': 'ไฟล์',
	'workspaces.workspaceSuffix': '{name} (Workspace)',
	'workspaces.removeRecent': 'ลบออกจากรายการที่เปิดล่าสุด'
} satisfies Record<keyof typeof en, string>;
