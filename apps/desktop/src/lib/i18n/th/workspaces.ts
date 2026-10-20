import type { workspaces as en } from '../en/workspaces';

export const workspaces = {
	'workspaces.openFileTitle': 'เปิดไฟล์',
	'workspaces.openFileFailed': 'เปิดไฟล์ไม่ได้: {error}',
	'workspaces.openWorkspaceTitle': 'เปิด workspace จากไฟล์',
	'workspaces.readFailed': 'อ่านไฟล์ workspace {name} ไม่ได้: {error}',
	'workspaces.noFolders': '{name} ไม่มีโฟลเดอร์ที่อยู่ในเครื่องนี้',
	'workspaces.pickFolder': '{name} มี {count} โฟลเดอร์ แต่ Kingu เปิดได้ทีละโฟลเดอร์ต่อหน้าต่าง เลือกโฟลเดอร์ที่จะเปิด',
	'workspaces.addFolder': 'Kingu เปิดได้ทีละโฟลเดอร์ต่อหน้าต่าง จึงเพิ่มโฟลเดอร์เข้ามาไม่ได้ จะเปิด {name} แทนไหม',
	'workspaces.openInstead': 'เปิดโฟลเดอร์',
	'workspaces.saveFailed': 'บันทึกไฟล์ workspace ไม่ได้: {error}',
	'workspaces.saved': 'บันทึก {name} แล้ว เปิดได้ด้วย Open Workspace from File',
	'workspaces.recentFolders': 'โฟลเดอร์และ workspace',
	'workspaces.recentFiles': 'ไฟล์',
	'workspaces.workspaceSuffix': '{name} (Workspace)',
	'workspaces.removeRecent': 'ลบออกจากรายการที่เปิดล่าสุด'
} satisfies Record<keyof typeof en, string>;
