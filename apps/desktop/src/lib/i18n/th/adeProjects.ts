import type { adeProjects as en } from '../en/adeProjects';

export const adeProjects = {
	'adeProjects.add': 'เพิ่มโปรเจกต์…',
	'adeProjects.pickTitle': 'เพิ่มโปรเจกต์',
	'adeProjects.added': 'เพิ่ม {name} ในแถบข้างแล้ว',
	'adeProjects.already': '{name} อยู่ในแถบข้างแล้ว',
	'adeProjects.addFailed': 'เพิ่มโปรเจกต์ไม่ได้: {error}',
	'adeProjects.removed': 'เอา {name} ออกจากแถบข้างแล้ว',
	'adeProjects.removeFailed': 'เอาโปรเจกต์ออกไม่ได้: {error}',
	'adeProjects.moveFailed': 'สลับลำดับโปรเจกต์ไม่ได้: {error}',
	'adeProjects.loadFailed': 'อ่านโปรเจกต์นี้ไม่ได้: {error}',
	'adeProjects.open': 'เปิดโปรเจกต์',
	'adeProjects.remove': 'เอาโปรเจกต์ออก',
	'adeProjects.menu': 'การทำงานของโปรเจกต์',
	'adeProjects.actionsFor': 'การทำงานของโปรเจกต์ {name}',
	'adeProjects.openTask': 'เปิด {task} (สลับไปที่ {project})',
	'adeProjects.noTasks': 'ยังไม่มีงาน',
	'adeProjects.noticeTask': '{task} · {project}'
} satisfies Record<keyof typeof en, string>;
