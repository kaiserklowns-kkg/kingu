import type { adeWorkflow as en } from '../en/adeWorkflow';

export const adeWorkflow = {
	// workflow.ts
	'adeWorkflow.todo': 'ต้องทำ',
	'adeWorkflow.inProgress': 'กำลังทำ',
	'adeWorkflow.inReview': 'รอรีวิว',
	'adeWorkflow.done': 'เสร็จแล้ว',
	// Board.svelte
	'adeWorkflow.board.title': 'บอร์ดงาน',
	'adeWorkflow.board.count': '{count} งาน',
	'adeWorkflow.board.newTask': 'งานใหม่',
	'adeWorkflow.board.cleanUp': 'ล้างงาน',
	'adeWorkflow.board.cleanUpTitle': 'ล้างงานที่เสร็จแล้ว (Clean Up Tasks)',
	'adeWorkflow.board.refresh': 'รีเฟรช',
	'adeWorkflow.board.empty': 'ไม่มีงาน',
	'adeWorkflow.board.dropHere': 'วางที่นี่',
	'adeWorkflow.board.columns': 'คอลัมน์',
	'adeWorkflow.board.byWorkflow': 'ขั้นตอนงาน',
	'adeWorkflow.board.byWorkflowTitle': 'คอลัมน์ที่คุณย้ายงานไปมาเอง: ต้องทำ กำลังทำ รอรีวิว เสร็จแล้ว (kingu.board.statuses)',
	'adeWorkflow.board.byAgent': 'สถานะ agent',
	'adeWorkflow.board.byAgentTitle': 'คอลัมน์ตามสิ่งที่ agent ทำอยู่: รอคุณ กำลังทำ เสร็จแล้ว',
	'adeWorkflow.board.cardTitle': '{title}: ลากไปคอลัมน์อื่นเพื่อเปลี่ยนสถานะ',
	// AdeSidebar.svelte
	'adeWorkflow.groupBy': 'ขั้นตอน',
	// worktreeActions.ts / worktreeMenu.svelte.ts
	'adeWorkflow.action.moveStatus': 'ย้ายไปสถานะ…',
	'adeWorkflow.action.continueSession': 'ทำต่อจาก session…',
	'adeWorkflow.action.handOff': 'ส่งต่อให้ agent อื่น…',
	'adeWorkflow.pick.status': 'สถานะของ {title}',
	'adeWorkflow.pick.statusCurrent': 'ปัจจุบัน',
	'adeWorkflow.pick.session': 'session ของ {title} ที่จะทำต่อ',
	'adeWorkflow.pick.sessionLatest': 'ล่าสุด',
	'adeWorkflow.pick.sessionResume': 'ทำต่อด้วย {agent}',
	'adeWorkflow.pick.sessionHandOff': '{agent} ทำต่อ session นี้เองไม่ได้ จะส่งต่อพร้อม transcript แทน',
	'adeWorkflow.pick.noSessions': '{title} ยังไม่มี session ของ agent ที่บันทึกไว้',
	'adeWorkflow.pick.handOffSession': 'session ของ {title} ที่จะส่งต่อ',
	'adeWorkflow.pick.agent': 'agent ที่จะทำ session นี้ต่อ',
	'adeWorkflow.pick.agentCurrent': 'agent ของงานนี้',
	'adeWorkflow.pick.noAgents': 'ไม่พบ agent CLI ใน PATH (Agent: Choose CLI…)',
	// tasks.svelte.ts
	'adeWorkflow.moved': 'ย้าย {title} ไปที่ {status} แล้ว',
	'adeWorkflow.nextMessageResumes': 'ข้อความถัดไปจะทำต่อจาก session {id}',
	'adeWorkflow.resuming': 'กำลังทำต่อจาก session {id} ด้วย {agent}',
	'adeWorkflow.handedOff': 'ส่งต่อ {title} ให้ {agent} แล้ว',
	'adeWorkflow.stopFirst': 'หยุด agent ของ {title} ก่อน',
	'adeWorkflow.removing': 'กำลังลบ…',
	'adeWorkflow.alreadyRemoving': '{slug} กำลังถูกลบอยู่แล้ว',
	'adeWorkflow.orphanAsk': 'git ไม่รู้จักโฟลเดอร์ worktree {path} แล้ว แต่โฟลเดอร์ยังอยู่ (การลบค้างกลางทาง หรือ git หาไม่เจอ) ลบโฟลเดอร์และทุกอย่างข้างในเลยไหม',
	'adeWorkflow.orphanTitle': 'โฟลเดอร์ worktree ที่ค้างอยู่',
	'adeWorkflow.orphanOk': 'ลบโฟลเดอร์',
	// chatResume.svelte.ts
	'adeWorkflow.chatsResumed': 'ทำต่อ {count} แชตที่กำลังทำงานอยู่ตอน Kingu ปิดไป'
} satisfies Record<keyof typeof en, string>;
