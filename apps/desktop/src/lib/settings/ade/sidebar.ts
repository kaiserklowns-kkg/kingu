// Orca's sidebar / workspace board UI preferences and worktree card options (group ADE Sidebar),
// the repository's display options (group Repository), worktree visibility and Open In (group
// Worktrees), and the hidden-workspace notification switch (group Notifications).
// Behaviour: ade/sidebarView.ts (pure), AdeSidebar.svelte, Board.svelte, worktreeMenu.svelte.ts.
import type { SettingSchema } from '../registry';

const G = 'ADE Sidebar';

export const SIDEBAR_SETTINGS: SettingSchema[] = [
	{
		id: 'kingu.sidebar.groupBy',
		group: G,
		type: 'string',
		default: 'repo',
		enum: ['repo', 'none', 'workspace-status', 'workflow', 'pr-status'],
		enumDescriptions: [
			'กลุ่มละโปรเจกต์ ทุกโปรเจกต์ที่เพิ่มไว้ (One group per added project.)',
			'รายการเดียว (One list.)',
			'แบ่งตามสถานะงาน: รอคุณ / กำลังทำ / เสร็จแล้ว (By task status.)',
			'แบ่งตามคอลัมน์ขั้นตอนงานของบอร์ด: ต้องทำ / กำลังทำ / รอรีวิว / เสร็จแล้ว (By the board\'s workflow columns.)',
			'แบ่งตามสถานะ PR: เปิด / ร่าง / merge แล้ว / ปิด / ไม่มี PR (By pull request state.)'
		],
		description: 'จัดกลุ่ม worktree ในแถบข้างของ Agents ค่าเริ่มต้นตาม Orca คือตามโปรเจกต์ (How the Agents side bar groups worktrees; Orca groups by project.)'
	},
	{
		id: 'kingu.projects.addOnOpen',
		group: G,
		type: 'boolean',
		default: true,
		description:
			'เพิ่มโฟลเดอร์ที่เปิดเป็นโปรเจกต์ในแถบข้างของ Agents อัตโนมัติ แถบข้างแสดงงานและสถานะ agent ของทุกโปรเจกต์ที่เพิ่มไว้พร้อมกัน ตาม Orca (Add every opened folder to the Agents side bar\'s projects; the side bar shows the tasks and agent status of every added project at once, like Orca.)',
		scope: 'application'
	},
	{
		id: 'kingu.sidebar.sortBy',
		group: G,
		type: 'string',
		default: 'recent',
		enum: ['smart', 'recent', 'name', 'manual'],
		enumDescriptions: [
			'งานที่รอคุณก่อน แล้วกำลังทำ แล้วเสร็จแล้ว ใหม่สุดก่อนในแต่ละส่วน (Needs you first, then working, then done; newest first in each.)',
			'มีความเคลื่อนไหวล่าสุดก่อน (Most recent activity first.)',
			'ตามชื่อ (By name.)',
			'ตามที่ลากวางไว้เอง (Where you dragged them.)'
		],
		description: 'ลำดับ worktree ในแถบข้างของ Agents ค่าเริ่มต้นตาม Orca คือล่าสุดก่อน ลากการ์ดเพื่อเปลี่ยนเป็น manual (How the Agents side bar orders worktrees; dragging a card switches to manual.)'
	},
	{
		id: 'kingu.sidebar.showActiveOnly',
		group: G,
		type: 'boolean',
		default: false,
		description: 'แสดงเฉพาะ worktree ที่ agent กำลังทำงานหรือรอคุณอนุญาต (Orca: showActiveOnly) (Show only worktrees whose agent is working or waiting on you.)'
	},
	{
		id: 'kingu.sidebar.hideDefaultBranch',
		group: G,
		type: 'boolean',
		default: false,
		description: 'ซ่อนการ์ดของโฟลเดอร์หลัก (primary) ที่อยู่บน branch ปกติ (Orca: hideDefaultBranchWorkspace) (Hide the primary checkout\'s card.)'
	},
	{
		id: 'kingu.sidebar.hideDetachedHead',
		group: G,
		type: 'boolean',
		default: false,
		description: 'ซ่อน worktree ที่ HEAD เป็น detached (ไม่อยู่บน branch) (Orca: hideDetachedHeadWorkspaces) (Hide worktrees with a detached HEAD.)'
	},
	{
		id: 'kingu.sidebar.hideSleeping',
		group: G,
		type: 'boolean',
		default: false,
		description:
			'ซ่อน worktree ที่ "หลับ": ไม่มี session ของ agent ไม่มี terminal ที่เปิดอยู่ และ agent ไม่ได้ทำงานหรือรอคุณ (Orca: hideSleepingWorkspaces) (Hide sleeping worktrees: no agent session, no open terminal, nothing working or waiting.)'
	},
	{
		id: 'kingu.sidebar.hideAutomationTasks',
		group: G,
		type: 'boolean',
		default: false,
		description: 'ซ่อนงานที่ Automations สร้าง (Orca: hideAutomationGeneratedWorkspaces) (Hide tasks that automations started.)'
	},
	{
		id: 'kingu.sidebar.cardProperties',
		group: G,
		type: 'array',
		items: 'string',
		default: ['status', 'branch', 'diff', 'activity', 'time', 'pr', 'issue', 'automation'],
		description:
			'สิ่งที่การ์ด worktree แสดง: status, branch, diff (+/−), activity (เหตุการณ์ล่าสุดของ agent), time, pr, issue, automation (Orca: worktreeCardProperties) (What worktree cards show: status, branch, diff, activity, time, pr, issue, automation.)'
	},
	{
		id: 'kingu.sidebar.compactCards',
		group: G,
		type: 'boolean',
		default: false,
		description: 'การ์ด worktree แบบกะทัดรัด: แสดงแค่สถานะและชื่อในบรรทัดเดียว (Orca: compactWorktreeCards) (Compact worktree cards: status and title on one line.)'
	},
	{
		id: 'kingu.sidebar.showAutomations',
		group: G,
		type: 'boolean',
		default: true,
		description: 'แสดงทางลัด Automations ในแถบข้าง (ยังเปิดได้จาก Command Palette) (Orca: showAutomationsButton) (Show the Automations shortcut in the side bar; still reachable from the Command Palette.)'
	},
	{
		id: 'kingu.sidebar.showIssues',
		group: G,
		type: 'boolean',
		default: true,
		description: 'แสดงทางลัด Issues (GitHub) ในแถบข้าง (Orca: showTasksButton) (Show the Issues shortcut in the side bar.)'
	},
	{
		id: 'kingu.board.columnWidth',
		group: G,
		type: 'number',
		default: 308,
		minimum: 200,
		maximum: 800,
		integer: true,
		description: 'ความกว้างของคอลัมน์ในบอร์ดงาน เป็นพิกเซล (Orca: workspaceBoardColumnWidth) (Width of each task board column, in pixels.)'
	},
	{
		id: 'kingu.board.opacity',
		group: G,
		type: 'number',
		default: 1,
		minimum: 0.3,
		maximum: 1,
		description: 'ความทึบของพื้นคอลัมน์ในบอร์ดงาน (Orca: workspaceBoardOpacity) (Opacity of the task board columns.)'
	},
	{
		id: 'kingu.board.view',
		group: G,
		type: 'string',
		default: 'workflow',
		enum: ['workflow', 'agent'],
		enumDescriptions: [
			'คอลัมน์ขั้นตอนงานที่คุณย้ายงานไปมาเอง เช่น ต้องทำ / กำลังทำ / รอรีวิว / เสร็จแล้ว (Workflow columns you move tasks between.)',
			'คอลัมน์ตามสถานะ agent: รอคุณ / กำลังทำ / เสร็จแล้ว (Columns from the agent status.)'
		],
		description: 'คอลัมน์ของบอร์ดงาน ค่าเริ่มต้นตาม Orca คือขั้นตอนงาน (Which columns the task board shows; Orca shows workflow statuses.)'
	},
	{
		id: 'kingu.board.statuses',
		group: G,
		type: 'array',
		items: 'string',
		default: ['todo', 'in-progress', 'in-review', 'completed'],
		description:
			'คอลัมน์ขั้นตอนงานของบอร์ดตามลำดับ: todo, in-progress, in-review, completed หรือชื่อคอลัมน์ของคุณเอง สูงสุด 12 คอลัมน์ (Orca: workspaceStatuses) (The board\'s workflow columns in order: the built-in ids or your own column names, at most 12.)'
	},
	{
		id: 'kingu.board.autoStatus',
		group: G,
		type: 'boolean',
		default: true,
		description:
			'ย้ายงานไปข้างหน้าตาม pull request: เปิด PR แล้วไป "รอรีวิว" merge แล้วไป "เสร็จแล้ว" ไม่ย้ายงานถอยหลัง (Move tasks forward with their pull request: open goes to In review, merged to Done; never backwards.)'
	},
	// --- Repository display (Orca: per-repo display name, badge color, icon)
	{
		id: 'kingu.repo.displayName',
		group: 'Repository',
		type: 'string',
		default: '',
		description: 'ชื่อที่แสดงของ repository นี้ในแถบข้างของ Agents เว้นว่างใช้ชื่อโฟลเดอร์ (Orca: displayName) (The repository\'s name in the Agents side bar; empty uses the folder name.)'
	},
	{
		id: 'kingu.repo.badgeColor',
		group: 'Repository',
		type: 'string',
		default: '',
		description: 'สีป้ายของ repository เป็น hex เช่น #4f8cff เว้นว่างเพื่อไม่ใช้ (Orca: badgeColor) (Badge color of the repository, as hex; empty for none.)'
	},
	{
		id: 'kingu.repo.icon',
		group: 'Repository',
		type: 'string',
		default: '',
		description: 'ไอคอนของ repository: อีโมจิหรือตัวอักษรสั้น ๆ (ไม่เกิน 2 ตัว) แทนไอคอนโฟลเดอร์ (Orca: repoIcon) (Repository icon: an emoji or up to two characters instead of the folder icon.)'
	},
	// --- Worktree visibility (Orca: external / agent worktree visibility)
	{
		id: 'kingu.worktree.externalVisibility',
		group: 'Worktrees',
		type: 'string',
		default: 'hide',
		enum: ['hide', 'show'],
		enumDescriptions: ['ไม่แสดง (Hide.)', 'แสดงเป็นการ์ดอ่านอย่างเดียว (Show as read-only cards.)'],
		description:
			'worktree ของ repository ที่ Kingu ไม่ได้สร้าง (git worktree add เอง) แสดงในแถบข้างหรือไม่ การ์ดเปิดเป็นโฟลเดอร์ เปิดใน Finder หรือแอปอื่นได้ (Orca: externalWorktreeVisibility) (Whether worktrees Kingu did not create appear in the side bar, as read-only cards.)'
	},
	{
		id: 'kingu.worktree.agentVisibility',
		group: 'Worktrees',
		type: 'string',
		default: 'hide',
		enum: ['hide', 'show'],
		enumDescriptions: ['ไม่แสดง (Hide.)', 'แสดงเป็นการ์ดอ่านอย่างเดียว (Show as read-only cards.)'],
		description:
			'worktree ชั่วคราวของ coding agent (.claude/worktrees, .codex/worktrees, .cursor/worktrees, conductor) แสดงในแถบข้างหรือไม่ (Orca: agentWorktreeVisibility) (Whether coding agents\' scratch worktrees appear in the side bar.)'
	},
	{
		id: 'kingu.worktree.visibilitySources',
		group: 'Worktrees',
		type: 'array',
		items: 'string',
		default: [],
		description:
			'โฟลเดอร์ (absolute path) ที่ worktree ข้างในแสดงในแถบข้างเสมอ ไม่ว่าตั้งค่าด้านบนเป็นอะไร (Orca: customWorktreeVisibilitySources) (Folders whose worktrees always show, whatever the settings above say.)'
	},
	{
		id: 'kingu.worktree.openIn',
		group: 'Worktrees',
		type: 'object',
		values: 'string',
		default: { 'VS Code': 'app:Visual Studio Code' },
		description:
			'แอปในเมนู "เปิดใน" ของ worktree: ชื่อ → คำสั่ง เช่น { "Cursor": "cursor" } หรือ "app:ชื่อแอป" เพื่อเปิดด้วย open -a (macOS) path ของ worktree ต่อท้ายเป็นอาร์กิวเมนต์สุดท้าย ไม่ผ่าน shell สูงสุด 8 รายการ (Orca: openInApplications) (Extra "Open in" apps for a worktree: label → command, or "app:<App Name>" for macOS open -a; the worktree path is the last argument, no shell; at most 8.)',
		// User-only: it is a program Kingu runs.
		scope: 'application'
	},
	{
		id: 'kingu.agent.notifications.hiddenWorkspaces',
		group: 'Notifications',
		type: 'boolean',
		default: true,
		description:
			'แจ้งเตือนจากงานที่ตัวกรองของแถบข้างซ่อนอยู่ด้วย ปิดเพื่อเงียบงานเหล่านั้น (Orca: notifyHiddenWorkspaces) (Notify about tasks the side bar filters hide; off silences them.)',
		scope: 'application'
	}
];
