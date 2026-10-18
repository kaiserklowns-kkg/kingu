// Settings schema registry and layering (VS Code: configurationRegistry + ConfigurationModel).
// Pure, so `bun test` can exercise it: defaults < user < workspace, each value checked against
// its schema so a bad value in a file falls back instead of breaking the workbench.

import { DEFAULT_THEME, THEMES } from '../theme/themes';
import { defaultTitleTemplate } from '../workbench/title';
import { PROFILES } from '../ade/agentProfiles';
import { IDE_SETTINGS } from './ideSettings';
import { ADE_SECTION_GROUPS, ADE_SETTINGS, SYSTEM_SECTION_GROUPS } from './ade';

const MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');

/**
 * The settings files, lowest to highest precedence after the defaults: the user's settings.json,
 * the folder's `.kingu/settings.json` (comes with the repository) and the per-repository
 * overrides Kingu keeps for this repository in its own config dir (Orca's per-repo settings; never
 * read from the repository, only written by the user through Kingu).
 */
export type SettingScope = 'user' | 'workspace' | 'repo';

type Base = {
	id: string;
	/** Settings editor group, e.g. "Text Editor". */
	group: string;
	description: string;
	/**
	 * `application` settings are user-only, like VS Code's ConfigurationScope.APPLICATION.
	 * `local`: the user settings or Kingu's per-repository store (both only ever written by the
	 * user through Kingu), never the repository's own `.kingu/settings.json` — for per-repo values
	 * that run programs (local setup scripts) or pick what repository code may do.
	 */
	scope?: 'application' | 'local' | 'window' | 'resource';
};

export type SettingSchema =
	| (Base & { type: 'boolean'; default: boolean })
	| (Base & { type: 'number'; default: number; minimum?: number; maximum?: number; integer?: boolean })
	| (Base & { type: 'string'; default: string; enum?: readonly string[]; enumDescriptions?: readonly string[] })
	| (Base & { type: 'array'; items: 'string' | 'number'; default: readonly (string | number)[] })
	/** A map like `files.exclude` (glob → true). Layers merge key by key, like VS Code's object settings. */
	| (Base & { type: 'object'; values: 'boolean' | 'string' | 'boolean|string'; default: Readonly<Record<string, boolean | string>> });

/** `kingu.agent.args.<profile>`: extra arguments per known agent CLI (agentCli.ts agentCommand). */
function agentArgsSettings(): SettingSchema[] {
	return PROFILES.map((p) => ({
		id: `kingu.agent.args.${p.id}`,
		group: 'Agent',
		type: 'string' as const,
		default: '',
		description: `อาร์กิวเมนต์เพิ่มเติมเมื่อ kingu.agent.cli เป็น ${p.title} (${p.bins.join(', ')}) ต่อท้ายคำสั่งก่อน prompt ห้ามมีอักขระของ shell (Extra arguments for ${p.title} when it is the agent CLI, added before the prompt.)`,
		// User-only: flags such as --dangerously-skip-permissions must not come from a repository.
		scope: 'application' as const
	}));
}

export const DEFAULT_FONT_FAMILY = "Menlo, Monaco, 'Courier New', 'IBM Plex Sans Thai', monospace";

const CORE_SETTINGS: SettingSchema[] = [
	{
		id: 'workbench.colorTheme',
		group: 'Workbench',
		type: 'string',
		default: DEFAULT_THEME,
		enum: THEMES.map((t) => t.id),
		enumDescriptions: THEMES.map((t) => t.label),
		description: 'ธีมสีของ workbench และ editor (Specifies the color theme used in the workbench.)',
		scope: 'application'
	},
	{
		id: 'workbench.editor.enablePreview',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'เปิดไฟล์เป็นแท็บพรีวิว (ตัวเอียง) จนกว่าจะแก้ไขหรือดับเบิลคลิก (Controls whether opened editors show as preview editors.)'
	},
	{
		id: 'window.zoomLevel',
		group: 'Window',
		type: 'number',
		default: 0,
		minimum: -8,
		maximum: 8,
		description: 'ระดับการซูมของหน้าต่าง แต่ละขั้นคือ 20% (Adjust the zoom level of the window; each step is 20% larger or smaller.)',
		scope: 'application'
	},
	{
		id: 'editor.fontSize',
		group: 'Text Editor',
		type: 'number',
		default: 12,
		minimum: 6,
		maximum: 100,
		description: 'ขนาดตัวอักษรเป็นพิกเซล (Controls the font size in pixels.)'
	},
	{
		id: 'editor.fontFamily',
		group: 'Text Editor',
		type: 'string',
		default: DEFAULT_FONT_FAMILY,
		description: 'ฟอนต์ของ editor (Controls the font family.)'
	},
	{
		id: 'editor.tabSize',
		group: 'Text Editor',
		type: 'number',
		default: 4,
		minimum: 1,
		maximum: 32,
		integer: true,
		description: 'จำนวนช่องว่างต่อหนึ่งแท็บ (The number of spaces a tab is equal to.)',
		scope: 'resource'
	},
	{
		id: 'editor.insertSpaces',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แทรกช่องว่างเมื่อกด Tab (Insert spaces when pressing Tab.)',
		scope: 'resource'
	},
	{
		id: 'editor.detectIndentation',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ตรวจหาการเยื้องจากเนื้อหาไฟล์ แทน tabSize/insertSpaces (Detect tab size and insert spaces from the file content.)',
		scope: 'resource'
	},
	{
		id: 'editor.wordWrap',
		group: 'Text Editor',
		type: 'string',
		default: 'off',
		enum: ['off', 'on', 'wordWrapColumn', 'bounded'],
		enumDescriptions: ['ไม่ตัดบรรทัด', 'ตัดบรรทัดตามความกว้าง viewport', 'ตัดที่ editor.wordWrapColumn', 'ตัดที่ค่าที่น้อยกว่าระหว่าง viewport กับ wordWrapColumn'],
		description: 'การตัดบรรทัด (Controls how lines should wrap.)'
	},
	{
		id: 'editor.minimap.enabled',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดง minimap (Controls whether the minimap is shown.)'
	},
	{
		id: 'editor.renderWhitespace',
		group: 'Text Editor',
		type: 'string',
		default: 'selection',
		enum: ['none', 'boundary', 'selection', 'trailing', 'all'],
		description: 'การแสดงอักขระช่องว่าง (Controls how the editor should render whitespace characters.)'
	},
	{
		id: 'kingu.lsp.disabled',
		group: 'Text Editor',
		type: 'string',
		default: '',
		description:
			'language server ที่ไม่ต้องการให้เริ่ม: ชื่อภาษาหรือ server คั่นด้วยจุลภาค เช่น `python, yaml` (Language servers not to start: comma-separated language ids or server keys — rust, typescript, go, svelte, python, json, css, html, yaml, toml.)'
	},
	{
		id: 'files.autoSave',
		group: 'Files',
		type: 'string',
		default: 'off',
		enum: ['off', 'afterDelay', 'onFocusChange', 'onWindowChange'],
		enumDescriptions: [
			'ไม่บันทึกอัตโนมัติ (An editor with changes is never saved automatically.)',
			'บันทึกหลังหยุดพิมพ์ตาม files.autoSaveDelay (Saved after the configured files.autoSaveDelay.)',
			'บันทึกเมื่อ editor เสียโฟกัส (Saved when the editor loses focus.)',
			'บันทึกเมื่อหน้าต่างเสียโฟกัส (Saved when the window loses focus.)'
		],
		description: 'บันทึกไฟล์อัตโนมัติ (Controls auto save of editors that have unsaved changes.)'
	},
	{
		id: 'files.autoSaveDelay',
		group: 'Files',
		type: 'number',
		default: 1000,
		minimum: 0,
		integer: true,
		description: 'หน่วงเวลา (ms) ก่อนบันทึกอัตโนมัติ เมื่อ files.autoSave เป็น afterDelay (Delay in milliseconds after which an editor is saved.)'
	},
	{
		id: 'terminal.integrated.fontSize',
		group: 'Terminal',
		type: 'number',
		default: 12,
		minimum: 6,
		maximum: 100,
		description: 'ขนาดตัวอักษรของ terminal (Controls the font size in pixels of the terminal.)'
	},
	{
		id: 'terminal.integrated.fontFamily',
		group: 'Terminal',
		type: 'string',
		default: '',
		description: 'ฟอนต์ของ terminal เว้นว่างเพื่อใช้ editor.fontFamily (Defaults to editor.fontFamily when empty.)'
	},
	{
		id: 'git.pullRebase',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'Pull และ Sync ด้วย rebase แทน fast-forward อย่างเดียว (Force git to use rebase when running the pull command.)'
	},
	{
		id: 'kingu.agent.model',
		group: 'Agent',
		type: 'string',
		default: 'claude-opus-5-5',
		description:
			'โมเดล Claude ของงานโหมด timeline (agent host) ส่วนโหมด terminal ใช้ค่าของ CLI เอง หรือใส่ --model ใน kingu.agent.args.claude (The Claude model of timeline-mode runs; terminal-mode CLIs use their own, or --model in kingu.agent.args.claude.)'
	},
	{
		id: 'kingu.agent.permissionMode',
		group: 'Agent',
		type: 'string',
		default: 'default',
		enum: ['default', 'acceptEdits', 'plan'],
		enumDescriptions: [
			'ถามก่อนใช้เครื่องมือที่ต้องขออนุญาต (Ask before tools that need approval.)',
			'แก้ไขไฟล์ใน worktree ได้เลย ถามเฉพาะคำสั่งอื่น (Accept file edits automatically.)',
			'วางแผนเท่านั้น ไม่แก้ไขไฟล์ (Plan only; no edits or commands.)'
		],
		description:
			'โหมดการขออนุญาตของงานโหมด timeline ส่วนโหมด terminal CLI ถามเองตาม flag ของมัน (How timeline-mode runs ask for permission to use tools; terminal-mode CLIs follow their own flags.)',
		// User-only: a repository's workspace settings must not loosen the user's permission prompts.
		scope: 'application'
	},
	{
		id: 'kingu.agent.runMode',
		group: 'Agent',
		type: 'string',
		default: 'terminal',
		enum: ['terminal', 'timeline'],
		enumDescriptions: [
			'รัน agent CLI ใน terminal ของ worktree แบบ Orca (Run the agent CLI in a terminal of the worktree, like Orca.)',
			'รันผ่าน agent host แสดงเป็น timeline พร้อมการ์ดขออนุญาต (Run through the agent host as a timeline with permission cards.)'
		],
		description: 'วิธีรัน agent ของงานใหม่ใน Agents เลือกต่องานได้ตอนสร้าง (How new tasks run their agent; each task can pick when it is created.)'
	},
	{
		id: 'kingu.agent.notifications',
		group: 'Agent',
		type: 'boolean',
		default: true,
		description:
			'แจ้งเตือนของระบบเมื่อ agent รอคุณอนุญาต เสร็จรอบ หรือล้มเหลว (Show a system notification when an agent needs you.)',
		scope: 'application'
	},
	{
		id: 'kingu.agent.notifications.suppressWhenFocused',
		group: 'Agent',
		type: 'boolean',
		default: true,
		description:
			'ไม่แจ้งเตือนงานที่คุณเปิดดูอยู่ขณะหน้าต่าง Kingu อยู่ด้านหน้า ปิดเพื่อแจ้งเตือนทุกครั้ง (Avoid notifying about the task on screen while Kingu is focused; off notifies always.)',
		scope: 'application'
	},
	{
		id: 'kingu.agent.notifications.events',
		group: 'Agent',
		type: 'string',
		default: 'all',
		enum: ['all', 'attention'],
		enumDescriptions: [
			'รอคุณอนุญาต เสร็จรอบ และล้มเหลว (Needs permission, finished a turn, failed.)',
			'เฉพาะที่ต้องให้คุณทำอะไร: รอคุณอนุญาตและล้มเหลว (Only needs permission and failed.)'
		],
		description: 'เหตุการณ์ของ agent ที่แจ้งเตือน (Which agent events notify you.)',
		scope: 'application'
	},
	{
		id: 'kingu.agent.notifications.sound',
		group: 'Agent',
		type: 'string',
		default: 'default',
		enum: ['none', 'default', 'Glass', 'Ping', 'Pop', 'Hero', 'Submarine', 'Tink'],
		enumDescriptions: [
			'ไม่มีเสียง (Silent.)',
			'เสียงแจ้งเตือนของระบบ (The system notification sound.)',
			'Glass',
			'Ping',
			'Pop',
			'Hero',
			'Submarine',
			'Tink'
		],
		description:
			'เสียงของการแจ้งเตือน agent (เสียงของ macOS) ลองได้ที่ Agents: ส่งการแจ้งเตือนทดสอบ (Sound of agent notifications; macOS system sounds. Try it with Agents: Send Test Notification.)',
		scope: 'application'
	},
	{
		id: 'kingu.agent.cli',
		group: 'Agent',
		type: 'string',
		default: 'claude',
		description:
			'คำสั่ง agent CLI สำหรับโหมด terminal เช่น claude, codex, gemini, opencode, cursor-agent หรือ claude --model opus — CLI ที่ Kingu รู้จักได้ prompt, resume, MCP และสถานะตามที่ CLI นั้นรองรับ คำสั่งอื่นได้ prompt ต่อท้ายเป็นอาร์กิวเมนต์สุดท้าย ห้ามมีอักขระของ shell เลือกได้จาก Agent: Choose CLI… (The agent CLI for the terminal mode; known CLIs get their own prompt, resume, MCP and status handling, others get the prompt as their last argument.)',
		// User-only: it is a program Kingu runs; a repository's workspace settings must not pick it.
		scope: 'application'
	},
	{
		id: 'kingu.agent.statusHooks',
		group: 'Agent',
		type: 'boolean',
		default: true,
		description:
			'ให้ agent CLI อื่นนอกจาก claude รายงานสถานะ (กำลังทำ รออนุญาต ถามคำถาม เสร็จรอบ) ผ่าน hooks แบบ Orca: Kingu เพิ่ม hook ของตัวเองใน ~/.gemini/settings.json, ~/.cursor/hooks.json, ~/.copilot/hooks/kingu-desktop.json, ~/.factory/settings.json และ $CODEX_HOME/hooks.json (+ [hooks.state] ใน config.toml) ก่อนเริ่ม CLI นั้นครั้งแรก hook ทำงานเฉพาะใน terminal ที่ Kingu เปิด และเก็บไฟล์เดิมไว้ที่ <ไฟล์>.kingu.bak ส่วน opencode ใช้ plugin ต่อ session ไม่แก้ config ปิดเพื่อเอา hook ของ Kingu ออกจากไฟล์เหล่านั้น (Status hooks for non-Claude agent CLIs, like Orca: Kingu adds its own hook entries to those CLI configs; they only report inside Kingu terminals. Turning this off removes them.)',
		// User-only: it edits the user's own CLI config files.
		scope: 'application'
	},
	{
		id: 'kingu.agent.trustWorkspace',
		group: 'Agent',
		type: 'boolean',
		default: true,
		description:
			'เชื่อถือ worktree ของงานให้ agent CLI ก่อนเริ่ม (claude, codex, cursor-agent, copilot) เพื่อไม่ให้คำถาม "trust this folder?" ครั้งแรกกลืน prompt — Kingu เขียนลงไฟล์ config ของ CLI นั้นเฉพาะ path ของ worktree ที่ Kingu สร้าง (~/.claude.json หรือ $CLAUDE_CONFIG_DIR/.claude.json, $CODEX_HOME/config.toml, ~/.cursor/projects, ~/.copilot/config.json) เก็บไฟล์เดิมไว้ที่ <ไฟล์>.kingu.bak (Trust a task worktree for the agent CLI before it starts, so its first-run folder-trust prompt does not swallow the prompt. Edits only that CLI\'s config, only for Kingu worktrees, keeping a .kingu.bak copy.)',
		// User-only: it edits the user's own CLI config files.
		scope: 'application'
	},
	...agentArgsSettings(),
	// --- Worktrees (Orca: worktree branch prefix, base branch, setup script, delete on remove)
	{
		id: 'kingu.worktree.branchPrefix',
		group: 'Worktrees',
		type: 'string',
		default: 'kingu/',
		description:
			'คำนำหน้าชื่อ branch ของงานใหม่ เช่น kingu/ feature/ หรือเว้นว่าง ใช้ได้เฉพาะ a-z A-Z 0-9 . _ / - งานเดิมใช้ branch เดิมต่อ (Prefix of new task branches, e.g. kingu/ or feature/; may be empty. Existing tasks keep their branch.)'
	},
	{
		id: 'kingu.worktree.baseBranch',
		group: 'Worktrees',
		type: 'string',
		default: '',
		description:
			'branch ตั้งต้นของงานใหม่ เช่น main หรือ develop เว้นว่างเพื่อใช้ branch ปัจจุบันของโฟลเดอร์ (ถ้าไม่มี branch นี้ในเครื่องก็ใช้ branch ปัจจุบัน) (Default base branch of new tasks; empty uses the folder\'s current branch, as does a branch that does not exist locally.)'
	},
	{
		id: 'kingu.worktree.setupScript',
		group: 'Worktrees',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'ask', 'off'],
		enumDescriptions: [
			'รันสคริปต์ตั้งค่าใน terminal "Setup" ของ worktree ใหม่ ของ repository ต้องเชื่อถือก่อนครั้งแรกและทุกครั้งที่เนื้อหาเปลี่ยน (Run the setup in a Setup terminal of each new worktree; the repository\'s needs your trust first and whenever it changes.)',
			'ถามทุกครั้งก่อนรัน (Ask every time before running it.)',
			'ไม่รันสคริปต์ตั้งค่า (Never run the setup script.)'
		],
		description:
			'สคริปต์ตั้งค่า worktree (Orca: setup run policy) จาก scripts.setup ใน kingu.yaml (หรือ .kingu/setup.sh แบบเดิม) และ/หรือ kingu.repo.setupScript ตาม kingu.repo.scriptSource เช่น bun install, คัดลอก .env ได้ KINGU_ROOT_PATH, KINGU_WORKTREE_PATH และ KINGU_WORKSPACE_NAME ใน environment automation ไม่ถามและข้ามสคริปต์ที่ยังไม่เชื่อถือ ตั้งต่อ repository ได้ในแท็บ Repository (Worktree setup: kingu.yaml scripts.setup, else the older .kingu/setup.sh, and/or kingu.repo.setupScript per kingu.repo.scriptSource; gets KINGU_ROOT_PATH, KINGU_WORKTREE_PATH and KINGU_WORKSPACE_NAME. Automations never ask and skip an untrusted script. Can be set per repository.)',
		// It decides whether repository code runs: the user's settings or per-repo store only.
		scope: 'local'
	},
	{
		id: 'kingu.worktree.archiveScript',
		group: 'Worktrees',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'off'],
		enumDescriptions: [
			'รันสคริปต์ก่อนลบใน worktree (เช่น หยุด container) ของ repository ต้องเชื่อถือก่อนเหมือน setup ถ้าล้มเหลวจะถามว่าจะลบต่อไหม (Run the archive script in the worktree before it is removed; the repository\'s is trusted like the setup script; a failure asks whether to go on.)',
			'ไม่รันสคริปต์ก่อนลบ (Never run the archive script.)'
		],
		description:
			'สคริปต์ก่อนลบ worktree จาก scripts.archive ใน kingu.yaml (หรือ .kingu/archive.sh) และ/หรือ kingu.repo.archiveScript หยุดเองหลัง 120 วินาที (Archive script — kingu.yaml scripts.archive or .kingu/archive.sh, and/or kingu.repo.archiveScript — run before a task worktree is removed; stopped after 120 seconds.)',
		// It decides whether repository code runs: the user's settings or per-repo store only.
		scope: 'local'
	},
	{
		id: 'kingu.worktree.confirmRemove',
		group: 'Worktrees',
		type: 'boolean',
		default: true,
		description:
			'ถามก่อนลบงานและ worktree (worktree ที่มีงานยังไม่ commit ยังถามเสมอ) (Ask before removing a task and its worktree; a worktree with uncommitted work always asks.)',
		scope: 'application'
	},
	{
		id: 'kingu.worktree.refreshBaseOnCreate',
		group: 'Worktrees',
		type: 'boolean',
		default: false,
		description:
			'ก่อนสร้างงาน fetch branch ตั้งต้นจาก upstream แล้ว fast-forward เมื่อปลอดภัย (ไม่มี commit ในเครื่องที่ยังไม่ push และไม่มีการแก้ไขที่ยังไม่ commit) (Keep the local base up to date: fetch it and fast-forward it when safe before a task forks from it.)',
		// User-only: it talks to the network and moves a local branch.
		scope: 'application'
	},
	{
		id: 'kingu.worktree.deleteBranchOnRemove',
		group: 'Worktrees',
		type: 'string',
		default: 'deleteMerged',
		enum: ['keep', 'deleteMerged', 'delete'],
		enumDescriptions: [
			'เก็บ branch ไว้ (Keep the branch.)',
			'ลบ branch ที่ merge แล้ว (git branch -d หรือรู้ว่า merge ในเครื่อง/PR merged) เก็บ branch ที่ยังไม่ merge ไว้ (Delete it when merged — git sees it merged, or the task was merged locally or its PR was; keep unmerged ones.)',
			'ลบ branch ทุกครั้ง แม้ยังไม่ merge (Always delete it, even unmerged.)'
		],
		description: 'เมื่อลบงาน จะลบ branch ของงานด้วยหรือไม่ (Whether removing a task also deletes its branch.)',
		// User-only: deleting branches is the user's call, not a repository's.
		scope: 'application'
	},
	// --- Pull requests (Orca: PR creation defaults)
	{
		id: 'kingu.pr.draft',
		group: 'Pull Requests',
		type: 'boolean',
		default: false,
		description: 'สร้าง PR ของงานเป็น draft (Create task pull requests as drafts.)'
	},
	{
		id: 'kingu.pr.openAfterCreate',
		group: 'Pull Requests',
		type: 'boolean',
		default: false,
		description: 'เปิด PR ในเบราว์เซอร์หลังสร้าง (Open the pull request in the browser after creating it.)',
		scope: 'application'
	},
	{
		id: 'kingu.automations.enabled',
		group: 'Agent',
		type: 'boolean',
		default: true,
		description:
			'สวิตช์รวมของ Automations: ปิดเพื่อหยุดทุก automation ที่ตั้งเวลาไว้ทุกโฟลเดอร์ (แต่ละอันยังต้องเปิดเองก่อนจะทำงาน) (Global switch for scheduled automations; each one must still be enabled on its own.)',
		// User-only: a repository's workspace settings must not turn scheduled agent runs back on.
		scope: 'application'
	},
	{
		id: 'kingu.issues.commentOnPr',
		group: 'Agent',
		type: 'boolean',
		default: false,
		description:
			'เมื่อสร้าง PR ของงานที่เริ่มจาก GitHub หรือ Linear issue ให้ comment ใน issue ว่า "Kingu เริ่มงานนี้ใน PR …" ด้วยบัญชี gh หรือ Linear API key ของคุณ (Comment on the issue with the PR link when a task started from a GitHub or Linear issue opens its PR.)',
		// User-only: a repository's workspace settings must not post comments under the user's account.
		scope: 'application'
	},
	{
		id: 'kingu.linear.team',
		group: 'Agent',
		type: 'string',
		default: '',
		description:
			'team key ของ Linear (เช่น ENG) ที่ Linear: Start Task from Issue… แสดง issue ว่างไว้เพื่อแสดงทุกทีม ตั้งต่อ repository ได้ (Linear team key to list issues from; empty lists every team.)'
	},
	{
		id: 'kingu.team.serverUrl',
		group: 'Team',
		type: 'string',
		default: '',
		description:
			'URL ของเซิร์ฟเวอร์ทีม Kingu (ต้องเป็น HTTPS ยกเว้น http://localhost) ส่งเฉพาะ metadata ของงาน ไม่ส่งโค้ดหรือความลับ token เก็บใน Keychain เท่านั้น (Kingu team server URL. Only task metadata is synced; the token lives in the macOS Keychain.)',
		// User-only: a repository's workspace settings must not redirect task metadata elsewhere.
		scope: 'application'
	},
	{
		id: 'kingu.snaps.sandbox',
		group: 'Snap Sandbox',
		type: 'string',
		default: 'enforce',
		enum: ['enforce', 'off'],
		enumDescriptions: [
			'บังคับสิทธิ์ที่ snap ประกาศ (sandbox-exec บน macOS, bwrap บน Linux) ถ้าบังคับไม่ได้จะไม่รันงานและ MCP server ของ snap (Enforce declared permissions; refuse when they cannot be enforced.)',
			'ไม่บังคับ: snap รันได้ทุกอย่างที่คุณทำได้ รวมถึงเห็น token ใน environment — ไม่ปลอดภัย (Run snaps unconfined. Unsafe.)'
		],
		description:
			'การบังคับสิทธิ์ ([permissions]) ของงานและ MCP server ของ Snap: จำกัดการเขียนไฟล์ เครือข่าย และ secret ใน environment (Enforcement of Snap permissions for tasks and MCP servers.)',
		// User-only: a repository's workspace settings must not turn the sandbox off for its own snaps.
		scope: 'application'
	},
	{
		id: 'kingu.team.project',
		group: 'Team',
		type: 'string',
		default: '',
		description: 'Project id (uuid) บนเซิร์ฟเวอร์ทีมที่งานของ workspace นี้จะถูกซิงก์ไป เว้นว่างเพื่อปิดการซิงก์ (Team server project id for this workspace; empty disables sync.)'
	},
	// --- Title bar and layout (VS Code: window.*, workbench.layoutControl.*, workbench.activityBar.location …)
	{
		id: 'window.title',
		group: 'Window',
		type: 'string',
		default: defaultTitleTemplate(MAC),
		description:
			'ชื่อหน้าต่างจากตัวแปร: ${activeEditorShort} ${activeEditorMedium} ${activeEditorLong} ${activeFolderShort} ${folderName} ${folderPath} ${rootName} ${rootPath} ${activeRepositoryBranchName} ${dirty} ${appName} ${separator} (Controls the window title based on the current context; the variables are substituted.)',
		scope: 'application'
	},
	{
		id: 'window.titleSeparator',
		group: 'Window',
		type: 'string',
		default: ' — ',
		description: 'ตัวคั่นที่ใช้แทน ${separator} ใน window.title (Separator used by window.title.)',
		scope: 'application'
	},
	{
		id: 'window.commandCenter',
		group: 'Window',
		type: 'boolean',
		default: true,
		description: 'แสดง command center (ช่องค้นหา) กลางแถบชื่อเรื่อง แถบจะสูง 30px เมื่อปิด (Show the command center in the title bar.)',
		scope: 'application'
	},
	{
		id: 'window.menuBarVisibility',
		group: 'Window',
		type: 'string',
		default: 'classic',
		enum: ['classic', 'compact', 'hidden'],
		enumDescriptions: [
			'แสดงเมนูเต็มในแถบชื่อเรื่อง (The menu is displayed at the top of the window.)',
			'รวมเมนูไว้ในปุ่มแฮมเบอร์เกอร์ (The menu is displayed as a compact button.)',
			'ซ่อนเมนู (The menu is hidden.)'
		],
		description: 'การแสดงเมนูในหน้าต่างบน Windows/Linux (macOS ใช้เมนูของระบบ) (Controls the visibility of the in-window menu bar on Windows and Linux.)',
		scope: 'application'
	},
	{
		id: 'workbench.navigationControl.enabled',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงปุ่มย้อนกลับ/ไปข้างหน้าใน command center (Controls whether the navigation controls are shown in the command center.)',
		scope: 'application'
	},
	{
		id: 'workbench.layoutControl.enabled',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงปุ่มควบคุมเลย์เอาต์ในแถบชื่อเรื่อง (Controls whether the layout controls in the title bar are shown.)',
		scope: 'application'
	},
	{
		id: 'workbench.layoutControl.type',
		group: 'Workbench',
		type: 'string',
		default: 'both',
		enum: ['toggles', 'menu', 'both'],
		enumDescriptions: [
			'ปุ่มเปิด/ปิด side bar, panel และ secondary side bar (Shows toggles for the side bars and panel.)',
			'ปุ่มเดียวที่เปิดเมนูเลย์เอาต์ (Shows a single button with a dropdown of layout options.)',
			'แสดงทั้งปุ่มเปิด/ปิดและเมนู (Shows both the toggles and the menu.)'
		],
		description: 'รูปแบบของปุ่มควบคุมเลย์เอาต์ในแถบชื่อเรื่อง (Controls whether the layout control is a single menu button, toggles, or both.)',
		scope: 'application'
	},
	{
		id: 'workbench.activityBar.location',
		group: 'Workbench',
		type: 'string',
		// Kingu puts the view switcher on top of the side bar, unlike VS Code's `default`.
		default: 'top',
		enum: ['default', 'top', 'hidden'],
		enumDescriptions: [
			'แถบแนวตั้งข้าง side bar (Show the activity bar to the side of the primary side bar.)',
			'ไอคอนอยู่บนหัว side bar บัญชีและการตั้งค่าย้ายไปแถบชื่อเรื่อง (Show the activity bar at the top of the primary side bar; Accounts and Manage move to the title bar.)',
			'ซ่อน บัญชีและการตั้งค่าย้ายไปแถบชื่อเรื่อง (Hide the activity bar.)'
		],
		description: 'ตำแหน่งของ activity bar (Controls the location of the activity bar.)'
	},
	{
		id: 'workbench.sideBar.location',
		group: 'Workbench',
		type: 'string',
		default: 'left',
		enum: ['left', 'right'],
		description: 'ตำแหน่งของ primary side bar ซ้ายหรือขวา secondary side bar จะอยู่ฝั่งตรงข้าม (Controls the location of the primary side bar.)'
	},
	{
		id: 'workbench.panel.defaultLocation',
		group: 'Workbench',
		type: 'string',
		default: 'bottom',
		enum: ['bottom', 'top', 'left', 'right'],
		description: 'ตำแหน่งของ panel (terminal, problems, output) (Controls where the panel is shown.)'
	},
	{
		id: 'workbench.panel.alignment',
		group: 'Workbench',
		type: 'string',
		default: 'center',
		enum: ['center', 'justify', 'left', 'right'],
		enumDescriptions: [
			'panel กว้างเท่า editor (The panel spans the editor area only.)',
			'panel กว้างเต็มหน้าต่างระหว่าง side bar ทั้งสอง (The panel spans the full width.)',
			'panel ยื่นไปถึงขอบซ้าย (The panel extends to the left edge.)',
			'panel ยื่นไปถึงขอบขวา (The panel extends to the right edge.)'
		],
		description: 'การจัดแนวของ panel เมื่ออยู่ด้านล่างหรือด้านบน (Controls the alignment of the panel when it is at the bottom or top.)'
	},
	// --- Status bar resources (Orca's footer)
	{
		id: 'kingu.keepAwake',
		group: 'Status Bar',
		type: 'string',
		default: 'off',
		enum: ['off', 'auto', 'on'],
		enumDescriptions: [
			'ให้เครื่องหลับตามปกติ (Allow normal system sleep behavior.)',
			'ไม่หลับขณะ agent กำลังทำงาน (Stay awake while an agent is working.)',
			'ไม่หลับตลอดเวลาที่ Kingu เปิดอยู่ (Keep this computer awake continuously.)'
		],
		description: 'กันเครื่อง Mac หลับ (Keeps the Mac awake; macOS only.)',
		scope: 'application'
	},
	{
		id: 'kingu.statusBar.usage.visible',
		group: 'Status Bar',
		type: 'boolean',
		default: true,
		description: 'แสดง usage ของแพ็กเกจ AI (Claude, Codex) ใน status bar และดึงข้อมูลทุก 15 นาที (Show plan usage of the AI accounts agents use; fetched every 15 minutes.)',
		scope: 'application'
	},
	{
		id: 'kingu.statusBar.usage.mode',
		group: 'Status Bar',
		type: 'string',
		default: 'compact',
		enum: ['compact', 'detailed'],
		enumDescriptions: ['ช่วงเวลาที่ใช้ไปมากที่สุด (The tightest window only.)', 'ทั้ง 5 ชั่วโมงและ 7 วัน (Both the 5-hour and the weekly window.)'],
		description: 'รูปแบบ usage ใน status bar (How usage shows in the status bar.)',
		scope: 'application'
	},
	{
		id: 'kingu.statusBar.usage.display',
		group: 'Status Bar',
		type: 'string',
		default: 'used',
		enum: ['used', 'remaining'],
		enumDescriptions: ['เปอร์เซ็นต์ที่ใช้ไป (Percent used.)', 'เปอร์เซ็นต์ที่เหลือ (Percent remaining.)'],
		description: 'usage ใน status bar แสดงที่ใช้ไปหรือที่เหลือ (Show usage as used or remaining.)',
		scope: 'application'
	},
	{
		id: 'kingu.statusBar.keepAwake.visible',
		group: 'Status Bar',
		type: 'boolean',
		default: true,
		description: 'แสดงปุ่มกันเครื่องหลับใน status bar (Show the keep-awake item in the status bar.)',
		scope: 'application'
	},
	{
		id: 'kingu.statusBar.resources.visible',
		group: 'Status Bar',
		type: 'boolean',
		default: true,
		description: 'แสดงหน่วยความจำและ terminal (Resource Manager) ใน status bar (Show memory and terminals in the status bar.)',
		scope: 'application'
	},
	{
		id: 'kingu.statusBar.ports.visible',
		group: 'Status Bar',
		type: 'boolean',
		default: true,
		description: 'แสดงพอร์ตที่เปิดอยู่ใน status bar (Show listening ports in the status bar.)',
		scope: 'application'
	},
	{
		id: 'kingu.agentsControl.enabled',
		group: 'Agent',
		type: 'string',
		default: 'compact',
		enum: ['hidden', 'badge', 'compact'],
		enumDescriptions: [
			'ไม่แสดงสถานะ agent ในแถบชื่อเรื่อง (Hide the agents status.)',
			'ป้ายสถานะแยกถัดจากช่องค้นหา (Show the agents status as a separate badge next to the search box.)',
			'รวมช่องค้นหากับสถานะ agent เป็นปุ่มเดียว (Merge the search box and the agents status into one pill.)'
		],
		description: 'การแสดงสถานะ agent (รอคุณ / กำลังทำ / ยังไม่อ่าน) ใน command center (Controls the agents status widget in the command center.)',
		scope: 'application'
	},
	{
		id: 'kingu.titleBar.openInAgents.enabled',
		group: 'Agent',
		type: 'boolean',
		default: true,
		description: 'แสดงปุ่ม "Open in Agents" ในแถบชื่อเรื่อง (Show the Open in Agents button in the title bar.)',
		scope: 'application'
	}
];

/** Every static setting: the core ones above plus the VS Code-derived IDE settings (ideSettings.ts). */
export const SETTINGS: SettingSchema[] = [...CORE_SETTINGS, ...ADE_SETTINGS, ...IDE_SETTINGS];

export type SettingsSection = { id: string; label: string; groups: string[] };

/**
 * The system settings page's table of contents: one settings system for the IDE and the ADE,
 * grouped by what they affect. Every group in `SETTINGS` belongs to exactly one section.
 */
export const SETTINGS_SECTIONS: SettingsSection[] = (
	[
		{ id: 'system', label: 'ระบบ (System)', groups: ['Workbench', 'Window', ...SYSTEM_SECTION_GROUPS, 'Status Bar', 'Team', 'Snap Sandbox'] },
		{ id: 'ide', label: 'IDE', groups: ['Text Editor', 'Diff Editor', 'Files', 'Explorer', 'Search', 'Terminal', 'Git', 'Debug'] },
		{ id: 'ade', label: 'ADE (Agents)', groups: ADE_SECTION_GROUPS }
	] satisfies SettingsSection[]
).map((sec) => ({ ...sec, groups: sec.groups.filter((g) => SETTINGS.some((s) => s.group === g)) }));

export const SNAPS_SECTION_ID = 'snaps';

/**
 * The table of contents for `schemas` (the static ones plus contributed ones): the static
 * sections, then "Snaps" holding every contributed group (one per snap, `Snap: <name>`). The
 * Snaps section is always there, for the Snap management view.
 */
export function settingsSections(schemas: SettingSchema[] = SETTINGS): SettingsSection[] {
	const known = new Set(SETTINGS_SECTIONS.flatMap((s) => s.groups));
	const contributed = [...new Set(schemas.map((s) => s.group).filter((g) => !known.has(g)))];
	return [...SETTINGS_SECTIONS, { id: SNAPS_SECTION_ID, label: 'Snaps', groups: contributed }];
}

/** Settings shown for a TOC selection (`null` = all) and a search query (searching spans every group).
 * `@modified` keeps only settings set in a file (`modified` says which), like VS Code's filter. */
export function settingsInView(query: string, group: string | null, schemas: SettingSchema[] = SETTINGS, modified: (id: string) => boolean = () => false): SettingSchema[] {
	const { filters, text } = parseQuery(query);
	return schemas.filter((s) => {
		if (filters.modified && !modified(s.id)) return false;
		if (filters.id && !filters.id.some((id) => s.id.toLowerCase().includes(id))) return false;
		if (text) return matchesQuery(s, text);
		return filters.modified || filters.id ? true : group === null || s.group === group;
	});
}

/** Splits `@modified @id:editor.font size` into filters and the words left to match. */
export function parseQuery(query: string): { filters: { modified: boolean; id: string[] | null }; text: string } {
	let modified = false;
	const ids: string[] = [];
	const words: string[] = [];
	for (const w of query.trim().split(/\s+/).filter(Boolean)) {
		if (w.toLowerCase() === '@modified') modified = true;
		else if (w.toLowerCase().startsWith('@id:')) ids.push(...w.slice(4).toLowerCase().split(',').filter(Boolean));
		else words.push(w);
	}
	return { filters: { modified, id: ids.length ? ids : null }, text: words.join(' ') };
}

export const SCHEMA = new Map(SETTINGS.map((s) => [s.id, s]));

/** The value if it fits the schema, else undefined (so the next layer down applies). */
export function validate(schema: SettingSchema, value: unknown): unknown {
	switch (schema.type) {
		case 'boolean':
			return typeof value === 'boolean' ? value : undefined;
		case 'number': {
			if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
			if (schema.integer && !Number.isInteger(value)) return undefined;
			if (schema.minimum !== undefined && value < schema.minimum) return undefined;
			if (schema.maximum !== undefined && value > schema.maximum) return undefined;
			return value;
		}
		case 'string':
			if (typeof value !== 'string') return undefined;
			return schema.enum && !schema.enum.includes(value) && schema.id !== 'workbench.colorTheme' ? undefined : value;
		case 'array':
			if (!Array.isArray(value)) return undefined;
			return value.every((v) => (schema.items === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === 'string')) ? value : undefined;
		case 'object': {
			if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
			const ok = (v: unknown) => schema.values.split('|').includes(typeof v);
			return Object.values(value).every(ok) ? value : undefined;
		}
	}
}

/**
 * Whether `scope` may set this setting: application settings are user-only; `local` ones also go
 * in Kingu's per-repository store but never in the repository's workspace file.
 */
export function allowedIn(schema: SettingSchema, scope: SettingScope): boolean {
	if (scope === 'user') return true;
	if (scope === 'repo') return schema.scope !== 'application';
	return schema.scope !== 'application' && schema.scope !== 'local';
}

export type Resolved = { value: unknown; source: 'default' | SettingScope };

/**
 * Repo over workspace over user over default, per setting (the per-repository store is the
 * user's own choice for this repository, so it beats the repository's committed file); object
 * settings merge key by key. Unknown keys are ignored.
 */
export function resolveSettings(
	user: Record<string, unknown>,
	workspace: Record<string, unknown>,
	schemas: SettingSchema[] = SETTINGS,
	repo: Record<string, unknown> = {}
): Map<string, Resolved> {
	const out = new Map<string, Resolved>();
	for (const s of schemas) {
		const rp = allowedIn(s, 'repo') ? validate(s, repo[s.id]) : undefined;
		const ws = allowedIn(s, 'workspace') ? validate(s, workspace[s.id]) : undefined;
		const us = validate(s, user[s.id]);
		const source = rp !== undefined ? 'repo' : ws !== undefined ? 'workspace' : us !== undefined ? 'user' : 'default';
		if (s.type === 'object' && source !== 'default') out.set(s.id, { value: { ...s.default, ...(us as object), ...(ws as object), ...(rp as object) }, source });
		else out.set(s.id, { value: rp ?? ws ?? us ?? s.default, source });
	}
	return out;
}

export type SettingProblem = { scope: SettingScope; id: string; message: string };

/** Values in a file that are ignored (VS Code underlines them in settings.json; the editor lists them). */
export function settingProblems(values: Record<string, unknown>, scope: SettingScope, schemas: SettingSchema[] = SETTINGS): SettingProblem[] {
	const byId = new Map(schemas.map((s) => [s.id, s]));
	const out: SettingProblem[] = [];
	for (const [id, value] of Object.entries(values)) {
		const s = byId.get(id);
		if (!s) continue;
		if (!allowedIn(s, scope)) out.push({ scope, id, message: scopeRule(s) });
		else if (validate(s, value) === undefined) out.push({ scope, id, message: `ค่า ${JSON.stringify(value)} ไม่ถูกต้อง จึงใช้ค่าจากชั้นถัดไปแทน (Expected ${describeType(s)}; the value is ignored.)` });
	}
	return out;
}

/** Why a scope may not set this setting, for the editor and the problems list. */
export function scopeRule(s: SettingSchema): string {
	return s.scope === 'local'
		? 'ตั้งได้เฉพาะใน User หรือ Repository (ที่ Kingu เก็บไว้เอง) ไม่ใช่ไฟล์ของ repository (This setting can only be applied in user or repository-local settings, never by the repository itself.)'
		: 'ตั้งได้เฉพาะใน User จึงถูกละไว้ (This setting can only be applied in user settings.)';
}

function describeType(s: SettingSchema): string {
	switch (s.type) {
		case 'string':
			return s.enum ? `one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}` : 'a string';
		case 'number':
			return `${s.integer ? 'an integer' : 'a number'}${s.minimum !== undefined ? ` >= ${s.minimum}` : ''}${s.maximum !== undefined ? ` <= ${s.maximum}` : ''}`;
		case 'boolean':
			return 'true or false';
		case 'array':
			return `an array of ${s.items}s`;
		case 'object':
			return `an object of ${s.values.replace('|', ' or ')} values`;
	}
}

/** Settings editor search: every word must appear in the id, its readable title, or the description. */
export function matchesQuery(schema: SettingSchema, query: string): boolean {
	const { category, label } = settingTitle(schema);
	const hay = `${schema.id} ${category} ${label} ${schema.group} ${schema.description}`.toLowerCase();
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((w) => hay.includes(w));
}

/** VS Code's settings editor title: `editor.minimap.enabled` → "Editor › Minimap" + "Enabled". */
export function settingTitle(schema: SettingSchema): { category: string; label: string } {
	const parts = schema.id.split('.');
	const words = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
	return { category: parts.slice(0, -1).map(words).join(' › '), label: words(parts[parts.length - 1]) };
}

/** A JSON schema for settings.json, so Monaco's JSON support completes and validates it. */
export function jsonSchema(schemas: SettingSchema[] = SETTINGS) {
	const properties: Record<string, unknown> = {};
	for (const s of schemas) {
		const base: Record<string, unknown> = { type: s.type, default: s.default, description: s.description };
		if (s.type === 'string' && s.enum) {
			base.enum = s.enum;
			if (s.enumDescriptions) base.enumDescriptions = s.enumDescriptions;
		}
		if (s.type === 'number') {
			if (s.integer) base.type = 'integer';
			if (s.minimum !== undefined) base.minimum = s.minimum;
			if (s.maximum !== undefined) base.maximum = s.maximum;
		}
		if (s.type === 'array') base.items = { type: s.items };
		if (s.type === 'object') base.additionalProperties = { type: s.values.split('|') };
		properties[s.id] = base;
	}
	return { type: 'object', properties };
}
