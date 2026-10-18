// Orca's Repository page (per-repo hook settings) and the worktree-creation options that go with
// the repo config file `kingu.yaml` (Orca's orca.yaml). The per-repo values live in Kingu's own
// per-repository store (settings scope `repo`), so they are the user's, never the repository's:
// anything that runs a command is `local` (user or per-repo store, never `.kingu/settings.json`).
import type { SettingSchema } from '../registry';

export const REPO_SETTINGS: SettingSchema[] = [
	{
		id: 'kingu.repo.setupScript',
		group: 'Repository',
		type: 'string',
		default: '',
		description:
			'สคริปต์ตั้งค่าของคุณเองสำหรับ repository นี้ (Orca: Local setup script) รันใน worktree ใหม่ของงาน ไม่ต้องเชื่อถือเพราะคุณเขียนเอง ใช้คู่กับ scripts.setup ใน kingu.yaml ตาม kingu.repo.scriptSource ตั้งในแท็บ Repository (Your own setup commands for this repository, run in each new task worktree; combined with kingu.yaml scripts.setup per kingu.repo.scriptSource. Set it in the Repository tab.)',
		// It runs commands: never from the repository's own settings file.
		scope: 'local'
	},
	{
		id: 'kingu.repo.archiveScript',
		group: 'Repository',
		type: 'string',
		default: '',
		description:
			'สคริปต์ก่อนลบ worktree ของคุณเองสำหรับ repository นี้ (Orca: Local archive script) ใช้คู่กับ scripts.archive ใน kingu.yaml ตาม kingu.repo.scriptSource (Your own archive commands, run in a task worktree before it is removed.)',
		scope: 'local'
	},
	{
		id: 'kingu.repo.scriptSource',
		group: 'Repository',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'shared-only', 'local-only', 'run-both'],
		enumDescriptions: [
			'ใช้สคริปต์ของคุณถ้ามี ไม่เช่นนั้นใช้ของ repository (Orca default: local when you set one, else shared.)',
			'เฉพาะของ repository: kingu.yaml scripts.* (หรือ .kingu/setup.sh, .kingu/archive.sh) (Only the repository\'s shared scripts.)',
			'เฉพาะสคริปต์ของคุณ ไม่รันคำสั่งจาก kingu.yaml เลย รวมถึง defaultTabs (Only your local scripts; no kingu.yaml commands run, defaultTabs included.)',
			'รันของ repository ก่อนแล้วตามด้วยของคุณ (Shared first, then yours.)'
		],
		description:
			'สคริปต์ setup/archive มาจากไหน (Orca: command source policy) ของ repository ต้องเชื่อถือก่อนทุกครั้งที่เนื้อหาเปลี่ยน (Where setup/archive commands come from; the repository\'s shared ones always need your trust in their exact content.)',
		scope: 'local'
	},
	{
		id: 'kingu.repo.issueCommand',
		group: 'Repository',
		type: 'string',
		default: '',
		description:
			'คำสั่งที่รันใน terminal ของงานที่เริ่มจาก GitHub issue (Orca: Custom GitHub Issue Command) แทนที่ issueCommand ใน kingu.yaml ใช้ {{issue}} แทนเลข issue และ {{artifact_url}} แทน URL ของ issue (Command run in a new terminal of a task started from a GitHub issue; overrides kingu.yaml issueCommand. {{issue}} and {{artifact_url}} are substituted.)',
		scope: 'local'
	},
	{
		id: 'kingu.repo.symlinkPaths',
		group: 'Repository',
		type: 'array',
		items: 'string',
		default: [],
		description:
			'path ใน checkout หลัก (relative) ที่จะลิงก์เข้า worktree ใหม่ทุกอัน เช่น .env หรือ node_modules (Orca: symlink paths) บน macOS คัดลอกแบบ APFS clone สำหรับไฟล์ ลิงก์สำหรับโฟลเดอร์ ห้ามมี .. หรือ .git รวมกับ worktree.sharedDirectories ใน kingu.yaml (Primary-checkout paths linked into each new worktree, e.g. .env; files are APFS-cloned on macOS, folders symlinked. Combined with kingu.yaml worktree.sharedDirectories.)',
		scope: 'local'
	},
	{
		id: 'kingu.worktree.setupAgentStartup',
		group: 'Worktrees',
		type: 'string',
		default: 'start-immediately',
		enum: ['start-immediately', 'wait-for-setup'],
		enumDescriptions: [
			'เริ่ม agent ทันทีพร้อมกับสคริปต์ตั้งค่า (Start the agent right away, alongside setup.)',
			'รอให้สคริปต์ตั้งค่าจบก่อนค่อยเริ่ม agent (Wait for the setup script to finish first.)'
		],
		description:
			'เริ่ม agent เมื่อไรเมื่อ worktree มีสคริปต์ตั้งค่า (Orca: setup agent startup policy) ถ้าไม่ได้ตั้งไว้จะใช้ setupAgentStartupPolicy ใน kingu.yaml (When the agent starts in a worktree that runs a setup script; unset falls back to kingu.yaml setupAgentStartupPolicy.)'
	},
	{
		id: 'kingu.worktree.setupScriptLaunchMode',
		group: 'Worktrees',
		type: 'string',
		default: 'new-tab',
		enum: ['new-tab', 'split-vertical', 'split-horizontal'],
		enumDescriptions: [
			'แท็บ "Setup" แยกที่ไม่แย่งโฟกัส (A background Setup tab.)',
			'แบ่งจอแนวตั้งข้าง terminal ของ agent (A pane beside the agent terminal.)',
			'แบ่งจอแนวนอนใต้ terminal ของ agent (A pane below the agent terminal.)'
		],
		description: 'สคริปต์ตั้งค่า worktree รันที่ไหน (Orca: setup script launch mode) (Where the setup script runs in a new worktree.)'
	},
	{
		id: 'kingu.worktree.alwaysForceDelete',
		group: 'Worktrees',
		type: 'boolean',
		default: false,
		description:
			'ลบ worktree ทิ้งพร้อมการแก้ไขที่ยังไม่ commit โดยไม่ถามซ้ำ (Orca: always force delete) ระวัง: กู้คืนไม่ได้ (Removing a task discards uncommitted changes without asking again. Cannot be undone.)',
		// It disables a protection.
		scope: 'application'
	}
];
