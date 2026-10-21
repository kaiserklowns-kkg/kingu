import type { scmRepos as en } from '../en/scmRepos';

export const scmRepos = {
	'scmRepos.repositories': 'Repository ทั้งหมด (Repositories)',
	'scmRepos.pickRepository': 'เลือก repository',
	'scmRepos.pickInitFolder': 'เลือกโฟลเดอร์ใน workspace ที่จะสร้าง git repository',
	'scmRepos.parentFound': 'พบ git repository ในโฟลเดอร์ที่อยู่เหนือ {folder}: {repository} เปิดใช้ไหม?',
	'scmRepos.parentOpen': 'เปิด',
	'scmRepos.parentAlways': 'เปิดทุกครั้ง',
	'scmRepos.parentNever': 'ไม่ต้องเปิดอีก',
	'scmRepos.changes': 'เปลี่ยน {count} ไฟล์',
	'scmRepos.sync': 'Sync การเปลี่ยนแปลง (Synchronize Changes)',
	'scmRepos.publish': 'Publish branch',
	'scmRepos.checkout': 'สลับ branch/tag...',
	'scmRepos.commitOn': 'ข้อความ ({key} เพื่อ commit บน \'{branch}\')',
	'scmRepos.commitOnIn': 'ข้อความ ({key} เพื่อ commit บน \'{branch}\' ใน {repository})',
	'scmRepos.noRepositories': 'โฟลเดอร์ที่เปิดอยู่ไม่มี git repository',
	'scmRepos.toggle': 'แสดงการเปลี่ยนแปลงของ {name}',
} satisfies Record<keyof typeof en, string>;
