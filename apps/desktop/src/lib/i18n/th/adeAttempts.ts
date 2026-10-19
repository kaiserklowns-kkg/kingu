import type { adeAttempts as en } from '../en/adeAttempts';

export const adeAttempts = {
	'adeAttempts.attempt': 'รอบ {letter}',
	'adeAttempts.attemptModel': 'รอบ {letter} · {model}',
	'adeAttempts.defaultModel': 'โมเดลเริ่มต้น',
	'adeAttempts.badModel': '"{model}" ไม่ใช่ชื่อโมเดล ใช้ได้แค่ตัวอักษร ตัวเลข และ . _ - / : @',
	'adeAttempts.started': 'เริ่ม "{title}" แล้ว {count} รอบ',
	'adeAttempts.winner': 'เก็บ "{title}" ไว้เป็นผู้ชนะแล้ว',
	'adeAttempts.parentDirty': '"{title}" มีการแก้ไขที่ยังไม่ commit งานใหม่จะเริ่มจาก commit ล่าสุดโดยไม่มีการแก้ไขเหล่านั้น',
	// NewTaskForm.svelte
	'adeAttempts.form.attempts': 'จำนวนรอบ',
	'adeAttempts.form.attemptsTitle': 'รันคำสั่งเดียวกันหลายรอบ แต่ละรอบมี worktree และโมเดลของตัวเอง แล้วค่อยเทียบผลกัน',
	'adeAttempts.form.model': 'โมเดล',
	'adeAttempts.form.modelOf': 'โมเดลของรอบ {letter}',
	'adeAttempts.form.modelPlaceholder': 'โมเดลเริ่มต้นของ agent',
	'adeAttempts.form.stackedOn': 'ต่อจากงาน "{title}"',
	'adeAttempts.form.stackedTitle': 'branch ใหม่จะเริ่มจาก branch ของงานนี้ และ pull request จะ merge เข้า branch นั้น',
	'adeAttempts.form.unstack': 'เริ่มจาก base branch แทน',
	// AttemptsCompare.svelte
	'adeAttempts.compare.title': 'เทียบผล {count} รอบ',
	'adeAttempts.compare.empty': 'ไม่มีรอบของกลุ่มนี้เหลืออยู่แล้ว',
	'adeAttempts.compare.files': '{count} ไฟล์',
	'adeAttempts.compare.only': 'มีแค่รอบนี้ {count} ไฟล์',
	'adeAttempts.compare.onlyTitle': 'ไฟล์ที่รอบอื่นไม่ได้แก้',
	'adeAttempts.compare.loading': 'กำลังอ่านการเปลี่ยนแปลง…',
	'adeAttempts.compare.turns': '{count} รอบคุย',
	'adeAttempts.compare.changed': 'ไฟล์ที่เปลี่ยน',
	'adeAttempts.compare.noChanges': 'ยังไม่มีการเปลี่ยนแปลง',
	'adeAttempts.compare.more': 'และอีก {count} ไฟล์',
	'adeAttempts.compare.open': 'เปิด',
	'adeAttempts.compare.pick': 'เลือกผู้ชนะ',
	'adeAttempts.compare.pickTitle': 'เก็บรอบนี้ไว้ แล้วล้างรอบอื่นออก',
	'adeAttempts.compare.close': 'ปิด',
	// CleanupDialog.svelte
	'adeAttempts.cleanup.title': 'ล้างงาน',
	'adeAttempts.cleanup.titleLosers': 'ล้างรอบที่เหลือ',
	'adeAttempts.cleanup.onlyDone': 'เลือกเฉพาะที่เสร็จแล้ว',
	'adeAttempts.cleanup.hint': 'ลบ worktree และนำงานออกจากรายการ งานที่ agent กำลังทำอยู่เลือกไม่ได้',
	'adeAttempts.cleanup.hintLosers': 'รอบที่ไม่ได้เลือก การลบจะลบ worktree ของรอบเหล่านี้ ส่วน branch ยังอยู่ ยกเว้นติ๊กช่องด้านล่าง',
	'adeAttempts.cleanup.empty': 'ไม่มีงาน',
	'adeAttempts.cleanup.deleteBranches': 'ลบ branch ที่ merge แล้วด้วย',
	'adeAttempts.cleanup.deleteBranchesLosers': 'ลบ branch ของรอบเหล่านี้ด้วย (งานในนั้นจะหายไป)',
	'adeAttempts.cleanup.progress': 'กำลังลบ {done}/{total}…',
	'adeAttempts.cleanup.remove': 'ลบ {count} งาน',
	// worktreeActions.ts, the side bar and the board
	'adeAttempts.action.newFromTask': 'งานใหม่ต่อจากงานนี้',
	'adeAttempts.action.compare': 'เทียบผลแต่ละรอบ…',
	'adeAttempts.badge.stacked': 'ต่อจาก {parent} pull request จะ merge เข้า branch นั้น',
	'adeAttempts.badge.hibernated': 'agent พักไว้เมื่อ {ago} กดทำงานต่อเพื่อใช้ session เดิม',
	'adeAttempts.badge.resume': 'ให้ agent ทำงานต่อ',
	// AgentsLayout.svelte
	'adeAttempts.hibernated.text': 'agent ว่างอยู่นาน Kingu จึงปิดไว้เมื่อ {ago} เพื่อคืนหน่วยความจำ session ยังเก็บไว้อยู่'
} satisfies Record<keyof typeof en, string>;
