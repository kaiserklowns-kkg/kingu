// Orca's Git page: source-control AI and pull request settings (groups Source Control AI, Pull Requests).
// Behaviour: ade/aiText.ts (prompts, output), ade/aiText.svelte.ts (runs Rust agent/ai_text.rs),
// WorktreeScm.svelte (commit message), PrCreateDialog.svelte (PR details, template),
// tasks.svelte.ts (compare against upstream), PrComments.svelte (bot authors).
import type { SettingSchema } from '../registry';

const AI = 'Source Control AI';
const PR = 'Pull Requests';

/** Agents with a headless mode Rust knows (agent/ai_text.rs AGENTS), plus `custom`. */
export const AI_TEXT_AGENTS = ['', 'claude', 'codex', 'gemini', 'qwen', 'opencode', 'cursor', 'copilot', 'amp', 'custom'];

export const GIT_SETTINGS: SettingSchema[] = [
	{
		id: 'kingu.git.ai.enabled',
		group: AI,
		type: 'boolean',
		default: true,
		description:
			'แสดงปุ่มให้ agent เขียนข้อความ commit และรายละเอียด PR (รันเมื่อคุณกดเท่านั้น แบบอ่านอย่างเดียว) (Orca: sourceControlAi.enabled) (Show the buttons that let an agent draft commit messages and PR details; it only runs when you click, read-only.)'
	},
	{
		id: 'kingu.git.ai.agent',
		group: AI,
		type: 'string',
		default: '',
		enum: AI_TEXT_AGENTS,
		enumDescriptions: [
			'agent ของ kingu.agent.cli (ถ้า Kingu รู้จักโหมด headless ของมัน) ไม่เช่นนั้น claude (The agent of kingu.agent.cli when it has a known headless mode, else claude.)',
			'claude -p ในโหมด plan (claude -p in plan mode.)',
			'codex exec แบบ read-only (codex exec, read-only sandbox.)',
			'gemini -p ในโหมด plan (gemini in plan approval mode.)',
			'qwen -p ในโหมด plan (qwen in plan approval mode.)',
			'opencode run --agent plan (opencode with its plan agent.)',
			'cursor-agent --print --mode ask (cursor-agent in ask mode.)',
			'copilot --prompt (copilot CLI.)',
			'amp --execute (amp in execute mode.)',
			'คำสั่งเองจาก kingu.git.ai.customCommand (Your own command from kingu.git.ai.customCommand.)'
		],
		description: 'agent ที่เขียนข้อความ commit และรายละเอียด PR (Orca: sourceControlAi.agentId) (The agent that drafts commit messages and PR details.)',
		// User-only: it picks the program that runs.
		scope: 'application'
	},
	{
		id: 'kingu.git.ai.model',
		group: AI,
		type: 'string',
		default: '',
		description: 'model ที่ส่งให้ agent ด้วย --model เว้นว่างใช้ค่าของ CLI เอง (Orca: selectedModelByAgent) (Model passed to the agent; empty uses the CLI\'s own default.)',
		scope: 'application'
	},
	{
		id: 'kingu.git.ai.customCommand',
		group: AI,
		type: 'string',
		default: '',
		description:
			'คำสั่งเมื่อ kingu.git.ai.agent เป็น custom ไม่ผ่าน shell {prompt} ในอาร์กิวเมนต์ถูกแทนด้วย prompt ถ้าไม่มี prompt จะส่งทาง stdin (Orca: customAgentCommand) (Command for the custom agent, run without a shell; {prompt} in an argument is replaced by the prompt, otherwise it goes to stdin.)',
		scope: 'application'
	},
	{
		id: 'kingu.git.ai.commitInstructions',
		group: AI,
		type: 'string',
		default: '',
		description:
			'คำสั่งเพิ่มเติมต่อท้าย prompt เขียนข้อความ commit เช่น "ใช้ Conventional Commits" ตั้งต่อ repository ได้ (Orca: instructionsByOperation.commitMessage) (Extra instructions for commit messages, e.g. use Conventional Commits; can be set per repository.)',
		// Prompt text: the user's or the per-repo store's, never the repository's own file.
		scope: 'local'
	},
	{
		id: 'kingu.git.ai.prInstructions',
		group: AI,
		type: 'string',
		default: '',
		description: 'คำสั่งเพิ่มเติมต่อท้าย prompt เขียนชื่อและรายละเอียด PR ตั้งต่อ repository ได้ (Orca: instructionsByOperation.pullRequest) (Extra instructions for PR titles and descriptions; can be set per repository.)',
		scope: 'local'
	},
	{
		id: 'kingu.git.ai.branchNameInstructions',
		group: AI,
		type: 'string',
		default: '',
		description:
			'คำสั่งเพิ่มเติมสำหรับการตั้งชื่อ branch จากงาน (kingu.worktree.autoRenameBranch) วางไว้ก่อน prompt ตั้งต่อ repository ได้ (Orca: instructionsByOperation.branchName) (Naming guidance for branches named from the work, put before the prompt; can be set per repository.)',
		scope: 'local'
	},
	{
		id: 'kingu.git.compareAgainstUpstream',
		group: AI,
		type: 'boolean',
		default: false,
		description:
			'เทียบการเปลี่ยนแปลงของงานกับ upstream ของ base (เช่น origin/main) แทน branch ในเครื่อง มีผลกับรายการไฟล์และ diff เท่านั้น ไม่เปลี่ยน base ของ PR หรือ merge (Orca: sourceControlCompareAgainstUpstream) (Compare a task against its base\'s upstream, e.g. origin/main, instead of the local branch; only the file list and diffs change.)'
	},
	{
		id: 'kingu.pr.useTemplate',
		group: PR,
		type: 'boolean',
		default: false,
		description:
			'เริ่มรายละเอียด PR จาก pull request template ของ repository (.github/pull_request_template.md และที่ GitHub หา) (Orca: prCreationDefaults.useTemplate) (Start the PR description from the repository\'s pull request template.)'
	},
	{
		id: 'kingu.pr.generateDetailsOnOpen',
		group: PR,
		type: 'boolean',
		default: false,
		description:
			'ให้ agent เขียนชื่อและรายละเอียด PR ทันทีที่เปิดหน้าสร้าง PR (ต้องเปิด kingu.git.ai.enabled) (Orca: prCreationDefaults.generateDetailsOnOpen) (Draft the PR title and description with the agent as soon as the create-PR form opens.)'
	},
	{
		id: 'kingu.pr.botAuthors',
		group: PR,
		type: 'array',
		items: 'string',
		default: [],
		description:
			'ชื่อผู้ใช้ GitHub ที่ถือเป็น bot ในคอมเมนต์รีวิว นอกจากที่รู้อยู่แล้ว (เช่น ลงท้ายด้วย [bot]) ใช้กับตัวกรองคน/bot (Orca: prBotAuthorOverrides) (GitHub logins treated as bots in review comments, besides the known ones, for the people / bots filter.)'
	}
];
