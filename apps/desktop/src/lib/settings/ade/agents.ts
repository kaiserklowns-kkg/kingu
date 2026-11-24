// Orca's Agents, Chat and Notifications pages (groups Agent, Agent Chat, Notifications).
// Behaviour: ade/agentCli.ts (launch options), ade/agentPicker.ts (disabled agents),
// ade/promptCache.ts + CacheTimer.svelte (prompt-cache timer), ade/automations.svelte.ts,
// agent/orchestration.rs (sub-task depth), voice/ + voice.rs (dictation).
import type { SettingSchema } from '../registry';
import { PROFILES } from '../../ade/agentProfiles';

const G = 'Agent';

/** `kingu.agent.env.<profile>` (Orca's agentDefaultEnv): launch environment per known agent CLI. */
function agentEnvSettings(): SettingSchema[] {
	return PROFILES.filter((p) => p.id !== 'custom').map((p) => ({
		id: `kingu.agent.env.${p.id}`,
		group: G,
		type: 'object' as const,
		values: 'string' as const,
		default: {},
		description: `ตัวแปร environment ที่ใส่ให้ ${p.title} เมื่อเริ่มในโหมด terminal เช่น { "DISABLE_AUTOUPDATER": "1" } ชื่อต้องเป็น A-Z 0-9 _ ค่าที่ hook ของ Kingu ตั้งเองชนะเสมอ (Orca: agentDefaultEnv) (Environment variables ${p.title} starts with in terminal mode; Kingu's own hook variables still win.)`,
		// User-only: an env var can change what the CLI may do.
		scope: 'application' as const
	}));
}

export const AGENT_SETTINGS: SettingSchema[] = [
	{
		id: 'kingu.agent.cmdOverrides',
		group: G,
		type: 'object',
		values: 'string',
		default: {},
		description:
			'โปรแกรมที่รันแทนของแต่ละ agent: id ของ profile → คำสั่งหรือ path เช่น { "claude": "/opt/claude-beta/claude" } ห้ามมีอักขระของ shell อาร์กิวเมนต์อื่นยังมาจาก kingu.agent.args.* (Orca: agentCmdOverrides) (The binary to run per agent profile instead of its default; a plain command or path.)',
		// User-only: it is a program Kingu runs.
		scope: 'application'
	},
	...agentEnvSettings(),
	{
		id: 'kingu.agent.cliPermissions',
		group: G,
		type: 'string',
		// Orca starts agents in yolo; Kingu keeps asking unless you choose otherwise.
		default: 'manual',
		enum: ['manual', 'auto', 'yolo'],
		enumDescriptions: [
			'agent CLI ถามคุณก่อนใช้เครื่องมือตามปกติของมัน Kingu ไม่เพิ่ม flag หรือ environment ใด ๆ (The CLI asks before tools, as it normally does; Kingu adds no flag and no environment.)',
			'ให้ CLI ทำสิ่งที่ปลอดภัยเองและถามเฉพาะที่เหลือ มีเฉพาะ claude --permission-mode auto, codex --approve-for-me, cursor-agent --auto-review ส่วน CLI อื่นยังถามตามปกติ (The CLI runs what it judges safe and asks for the rest: claude, codex and cursor-agent only; every other CLI keeps asking.)',
			'เพิ่ม flag ข้ามการขออนุญาตของ CLI นั้น เช่น claude --dangerously-skip-permissions, codex --dangerously-bypass-approvals-and-sandbox, gemini --yolo และ GOOSE_MODE=auto ให้ goose (Add that CLI\'s skip-permissions flag; Goose gets GOOSE_MODE=auto.)'
		],
		description:
			'การขออนุญาตของ agent CLI ในงาน ADE ใช้กับงานใหม่ ไม่ใช้กับ CLI ที่ตั้ง kingu.agent.args.<profile> ไว้เอง หรือคำสั่งที่กำหนดสิทธิ์ไว้แล้ว และ opencode ไม่มี flag นี้ (Orca: Agent Permissions) (Permissions of ADE agent CLIs for new tasks; a CLI whose kingu.agent.args.<profile> you set keeps your arguments, and a command that already sets its permission policy gets no flag.)',
		// User-only: it turns off the CLI's permission prompts.
		scope: 'application'
	},
	{
		id: 'kingu.agent.disabled',
		group: G,
		type: 'array',
		items: 'string',
		default: [],
		description:
			'agent ที่ซ่อนจากตัวเลือก agent CLI ใส่ id ของ profile เช่น ["gemini", "aider"] agent ที่ใช้อยู่ตอนนี้ยังแสดงเสมอ (Orca: disabledTuiAgents) (Agent profiles hidden from the agent CLI picker; the current one always stays.)'
	},
	{
		id: 'kingu.agent.claudeAgentTeams',
		group: G,
		type: 'string',
		default: 'off',
		enum: ['off', 'in-process'],
		enumDescriptions: [
			'ปิด (Off.)',
			'เปิด Agent Teams ของ Claude Code (ทดลอง) teammate ทำงานใน terminal เดียวกัน: --teammate-mode in-process และ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 (Experimental Claude Code agent teams, teammates in the same terminal.)'
		],
		description:
			'ทีม agent (Agent Teams) ของ Claude Code เมื่อ kingu.agent.cli เป็น claude ในโหมด terminal (Orca: claudeAgentTeamsMode; แบบแยก pane ยังไม่รองรับ) (Claude Code agent teams for terminal-mode claude; Orca\'s native-panes mode is not supported.)',
		// User-only: it sets agent flags.
		scope: 'application'
	},
	{
		id: 'kingu.agent.promptCacheTimer',
		group: G,
		type: 'boolean',
		default: false,
		description:
			'แสดงเวลาที่เหลือก่อน prompt cache ของ Claude หมดอายุบนการ์ดและหน้างานเมื่อ agent ทำงานเสร็จแล้วรอคุณ หลังหมดอายุ ข้อความถัดไปจะส่งบทสนทนาทั้งหมดใหม่ (Orca: promptCacheTimerEnabled) (Count down to an idle Claude task\'s prompt-cache expiry on its card and page.)'
	},
	{
		id: 'kingu.agent.promptCacheTtl',
		group: G,
		type: 'string',
		default: '5m',
		enum: ['5m', '1h'],
		enumDescriptions: ['cache มาตรฐาน 5 นาที (The standard 5-minute cache.)', 'cache แบบขยาย 1 ชั่วโมง (The extended 1-hour cache.)'],
		description: 'อายุของ prompt cache ที่ kingu.agent.promptCacheTimer นับถอยหลัง (Orca: promptCacheTtlMs) (Prompt-cache lifetime the timer counts down.)'
	},
	// Agent hibernation (ade/hibernation.ts, attempts.svelte.ts, paneSleep.svelte.ts): experimental, off by default like Orca's; per pane.
	{
		id: 'kingu.agent.hibernation',
		group: G,
		type: 'boolean',
		default: false,
		description:
			'ทดลอง: ปิด agent CLI ที่ทำรอบเสร็จแล้วและว่างนานเกิน kingu.agent.hibernationIdleMinutes เพื่อคืนหน่วยความจำ เฉพาะ CLI ที่ resume session ได้และไม่ได้แสดงอยู่บนจอ ทั้ง agent ของงานและ agent ที่รันในแท็บ terminal ของงาน แยกกันทีละ pane เมื่อกลับมาที่แท็บนั้น agent จะทำงานต่อใน session เดิมเอง (Orca: experimentalAgentHibernation) (Experimental: closes idle agent CLIs whose turn finished, to free memory, each pane on its own: a task’s agent and agents in its terminal tabs; each resumes the same session when you return to its tab.)'
	},
	{
		id: 'kingu.agent.hibernationIdleMinutes',
		group: G,
		type: 'number',
		default: 30,
		minimum: 1,
		maximum: 1440,
		integer: true,
		description: 'ว่างนานกี่นาทีหลังทำรอบเสร็จ agent CLI จึงถูกพักไว้ เมื่อเปิด kingu.agent.hibernation (Orca: agentHibernationIdleMs) (Minutes an agent CLI stays idle after its turn before hibernation closes it.)'
	},
	{
		id: 'kingu.agent.antigravityManagedAgy',
		group: G,
		type: 'boolean',
		default: true,
		description:
			'ให้แชตใช้ agy ชุดที่ Kingu ติดตั้งเองได้ ปิดแล้ว agy ชุดนั้นไม่รันแชตใด ไม่นับว่าติดตั้งแล้ว และไม่ถูกอัปเดตหรือติดตั้งใหม่ แชต Antigravity จะใช้ agy ของคุณเอง ถ้าไม่มีจะขึ้นว่ายังไม่ได้ติดตั้ง (Orca: antigravityManagedAgyEnabled) (Lets chats run the agy Kingu installed. Off, that copy runs no chat, counts as not installed and is neither updated nor installed; Antigravity chats use your own agy.)',
		// User-only: it decides which program runs.
		scope: 'application'
	},
	{
		id: 'kingu.agent.antigravityGoogleSignIn',
		group: G,
		type: 'string',
		enum: ['auto', 'agy', 'kingu'],
		default: 'auto',
		description:
			'แชต Antigravity ใช้การลงชื่อเข้าใช้ Google ของใคร: auto ใช้ agy เว้นแต่ติดตั้งเซิร์ฟเวอร์ ACP ของ Kingu ไว้แล้ว (agy ที่ลงชื่อเข้าใช้อยู่ยังใช้ได้), agy ใช้การลงชื่อเข้าใช้ของ agy เอง (ลงชื่อเข้าใช้ในเทอร์มินัล), kingu ใช้เซิร์ฟเวอร์ ACP ที่ Kingu ติดตั้ง ลงชื่อเข้าใช้ Google จากในแชต Kingu ไม่เห็นรหัสผ่านหรือ token (Orca: antigravityGoogleSignIn) (Whose Google sign-in Antigravity chats use: auto runs agy unless Kingu\'s ACP server is installed; agy uses agy\'s own sign-in, from a terminal; kingu runs Kingu\'s ACP server and signs in to Google from the chat. Kingu never sees the password or token.)',
		// User-only: it decides which program runs.
		scope: 'application'
	},
	{
		id: 'kingu.agent.antigravityChatAuth',
		group: G,
		type: 'json',
		schema: {
			anyOf: [
				{ type: 'object', properties: { method: { const: 'oauth-personal' } }, additionalProperties: false },
				{ type: 'object', properties: { method: { const: 'gemini-api-key' } }, additionalProperties: false },
				{ type: 'object', properties: { method: { const: 'agent-platform' }, gcpProject: { type: 'string', maxLength: 255 }, gcpLocation: { type: 'string', maxLength: 255 } }, additionalProperties: false }
			]
		},
		default: { method: 'oauth-personal' },
		description:
			'แชต Antigravity บนเซิร์ฟเวอร์ ACP ของ Kingu ลงชื่อเข้าใช้ด้วยอะไร (Orca: antigravityChatAuth): oauth-personal บัญชี Google, gemini-api-key คีย์ Gemini API ที่วางไว้ใน Settings › Accounts › Antigravity (เก็บใน macOS Keychain) หรือ GEMINI_API_KEY, agent-platform ใช้ gcloud login (ADC) กับ gcpProject / gcpLocation ถ้าว่างใช้ของ gcloud และ global สองแบบหลังรันบนเซิร์ฟเวอร์ของ Kingu เสมอ (How Antigravity chats on Kingu\'s ACP server sign in: a Google account, a Gemini API key kept in the macOS Keychain or GEMINI_API_KEY, or Google Agent Platform with your gcloud ADC. The last two always run on Kingu\'s server.)',
		// User-only: it decides which credentials a program gets.
		scope: 'application'
	},
	// --- Agent Chat (Orca's nativeChatAppearance): the Agent panel.
	{
		id: 'kingu.chat.fontSize',
		group: 'Agent Chat',
		type: 'number',
		default: 14,
		minimum: 12,
		maximum: 20,
		integer: true,
		description: 'ขนาดตัวอักษรของบทสนทนากับ agent เป็นพิกเซล 12–20 (Orca: nativeChatAppearance.fontSize) (Chat text size in pixels, 12–20.)'
	},
	{
		id: 'kingu.chat.codeFontSize',
		group: 'Agent Chat',
		type: 'number',
		default: 12,
		minimum: 10,
		maximum: 18,
		integer: true,
		description: 'ขนาดตัวอักษรของโค้ดและการเรียกเครื่องมือในบทสนทนา 10–18 (Orca: nativeChatAppearance.codeFontSize) (Code and tool-call text size in the chat, 10–18.)'
	},
	{
		id: 'kingu.chat.width',
		group: 'Agent Chat',
		type: 'string',
		default: 'comfortable',
		enum: ['comfortable', 'wide', 'full'],
		enumDescriptions: ['กว้างพออ่านสบาย 46rem (Comfortable, 46rem.)', 'กว้าง 64rem (Wide, 64rem.)', 'เต็มพื้นที่ (Full width.)'],
		description: 'ความกว้างของบทสนทนา (Orca: nativeChatAppearance.width) (Width of the chat transcript.)'
	},
	{
		id: 'kingu.chat.contrast',
		group: 'Agent Chat',
		type: 'number',
		default: 100,
		minimum: 50,
		maximum: 150,
		integer: true,
		description: 'ความคมชัด (contrast) ของบทสนทนาเป็นเปอร์เซ็นต์ 50–150 (Orca: nativeChatAppearance.contrast) (Chat contrast in percent, 50–150.)'
	},
	{
		id: 'kingu.chat.matchTerminalFont',
		group: 'Agent Chat',
		type: 'boolean',
		default: false,
		description: 'ใช้ฟอนต์ของ terminal (terminal.integrated.fontFamily) ในบทสนทนา (Orca: nativeChatAppearance.matchTerminalInterface) (Use the terminal font in the chat.)'
	},
	{
		id: 'kingu.chat.aiTitles',
		group: 'Agent Chat',
		type: 'boolean',
		default: true,
		description:
			'หลังคำตอบแรก ให้ agent ของ Source Control AI ตั้งชื่อแชตสั้น ๆ 3–6 คำ (ทำงานเฉพาะเมื่อเลือก kingu.git.ai.agent ไว้ และไม่แทนชื่อที่คุณเปลี่ยนเอง) (VS Code: AI chat titles) (After the first answer, the Source Control AI agent names the chat in 3–6 words; only when kingu.git.ai.agent is set, never over a name you chose.)'
	},
	// Orca's AI Provider Accounts pane: Gemini CLI's quota in the usage item (Rust usage.rs).
	{
		id: 'kingu.usage.gemini',
		group: G,
		type: 'boolean',
		default: false,
		description:
			'แสดงโควตาของ Gemini CLI ใน status bar โดยอ่านการลงชื่อเข้าใช้ของ Gemini CLI (~/.gemini/oauth_creds.json) และถาม Google เท่านั้น Kingu ไม่ต่ออายุ token เอง เมื่อหมดอายุจะอัปเดตหลัง Gemini CLI ทำงานครั้งถัดไป (Orca: geminiCliOAuthEnabled) (Show Gemini CLI quota from its own sign-in, sent only to Google; Kingu never refreshes the token.)',
		// User-only: it reads another program's sign-in.
		scope: 'application'
	},
	// Orca's other usage providers (Rust usage/*.rs); pasted keys and cookies live in the Keychain.
	{
		id: 'kingu.usage.antigravity',
		group: G,
		type: 'boolean',
		default: false,
		description:
			'แสดงโควตาของ Antigravity ใน status bar โดยรัน agy -p /usage (agy 1.1.11 ขึ้นไป เป็นคำสั่งที่ไม่เริ่มบทสนทนาและไม่ใช้โควตา) ทุก 15 นาทีเมื่อติดตั้ง agy ไว้ ถ้า agy ตอบเป็นข้อความถึงโมเดล Kingu จะหยุดถามทันที (Orca: Antigravity usage item) (Show Antigravity quota by running agy -p /usage, a command that starts no conversation, every 15 minutes when agy is installed; Kingu stops at once if agy ever answers it as a prompt.)',
		// User-only: it runs a program.
		scope: 'application'
	},
	{
		id: 'kingu.usage.opencode.workspaceId',
		group: G,
		type: 'string',
		default: '',
		pattern: '^((org|wrk|wk)_[A-Za-z0-9]+)?$',
		description:
			'workspace id ของ OpenCode (org_… wrk_… หรือ wk_…) สำหรับดึง usage ของ OpenCode Go ด้วย session cookie ว่างไว้ให้ Kingu หา workspace เอง ใช้เฉพาะเมื่อไม่มี API key ของ OpenCode Go (Orca: opencodeWorkspaceId) (The OpenCode workspace whose OpenCode Go usage the session cookie reads; empty looks it up.)',
		scope: 'application'
	},
	{
		id: 'kingu.usage.minimax.endpoint',
		group: G,
		type: 'string',
		default: 'overseas',
		enum: ['overseas', 'cn'],
		enumDescriptions: ['platform.minimax.io (International.)', 'www.minimaxi.com (Mainland China.)'],
		description: 'ภูมิภาคของบัญชี MiniMax ที่ดึง usage ของ Coding Plan (Orca: minimaxEndpoint) (The MiniMax region whose Coding Plan usage is read.)',
		scope: 'application'
	},
	{
		id: 'kingu.usage.minimax.groupId',
		group: G,
		type: 'string',
		default: '',
		description: 'group id ของ MiniMax ว่างไว้ให้ใช้ minimax_group_id_v2 จาก cookie (Orca: minimaxGroupId) (The MiniMax group id; empty takes minimax_group_id_v2 from the cookie.)',
		scope: 'application'
	},
	{
		id: 'kingu.usage.minimax.models',
		group: G,
		type: 'string',
		default: 'general',
		description: 'ชื่อโมเดลของ MiniMax ที่แสดง usage คั่นด้วยจุลภาค ใช้ตัวแรกที่พบ (Orca: minimaxUsageModels) (Comma-separated MiniMax models whose usage shows; the first found wins.)',
		scope: 'application'
	},
	{
		id: 'kingu.usage.zcode.site',
		group: G,
		type: 'string',
		default: 'zai',
		enum: ['zai', 'bigmodel'],
		enumDescriptions: ['Z.AI (api.z.ai).', 'BigModel (open.bigmodel.cn).'],
		description: 'เว็บของ GLM Coding Plan ที่ API key ที่บันทึกใน Kingu เป็นของ (Orca: zcodePlanSite) (The GLM Coding Plan site the API key saved in Kingu belongs to.)',
		scope: 'application'
	},
	// --- Codex's shared app-server (Orca's Agents pane): ade/codexServer.ts, agent/codex_server.rs.
	{
		id: 'kingu.codex.terminalServerIsolation',
		group: G,
		type: 'boolean',
		default: true,
		description:
			'ให้ codex ของแต่ละงานใช้ app-server ของตัวเอง (เริ่มด้วย --no-daemon เมื่อ codex รุ่นนั้นรองรับ) เพราะเซิร์ฟเวอร์ร่วมของ Codex รัน hook ของทุกแท็บด้วย environment ของแท็บแรก สถานะของ agent จึงผิด และทุก session จบพร้อมเซิร์ฟเวอร์ ปิดเพื่อใช้เซิร์ฟเวอร์ร่วมและ agents overview ของ Codex มีผลกับงานที่เริ่มใหม่ (Orca: codexTerminalServerIsolation) (Run each Codex task on its own server with --no-daemon when the codex binary supports it, so status and closing tabs stay correct; turn off to use Codex\'s shared server and its agents overview. Applies to new launches.)',
		// User-only: it changes how a CLI starts.
		scope: 'application'
	},
	{
		id: 'kingu.codex.sharedServerWarning',
		group: G,
		type: 'boolean',
		default: true,
		description:
			'เตือนหนึ่งครั้งเมื่อ codex ที่คุณพิมพ์เองใน terminal ไปใช้เซิร์ฟเวอร์ร่วมกับแท็บอื่น เพราะสถานะของ agent อาจผิด ทำงานเฉพาะเมื่อเปิด kingu.codex.terminalServerIsolation (Orca: codexSharedServerWarning) (Warn once when a codex you started yourself shares a server with other tabs, since its agent status may be wrong; only while kingu.codex.terminalServerIsolation is on.)',
		scope: 'application'
	},
	// --- Orchestration (Orca's Orchestration pane): agents dispatching sub-tasks with `kingu task create`.
	{
		id: 'kingu.orchestration.maxDepth',
		group: 'Orchestration',
		type: 'number',
		default: 1,
		minimum: 1,
		maximum: 5,
		integer: true,
		description:
			'งานที่ agent ส่งต่อด้วย kingu task create ซ้อนกันได้ลึกเท่าไร งานที่คุณเริ่มเองคือชั้น 0 งานย่อยที่ agent ของมันส่งคือชั้น 1 ค่า 1 คือ agent ของงานย่อยส่งงานย่อยต่อไม่ได้ Kingu ตรวจที่ตัวแอปเองและตอบ agent ให้ทำงานนั้นเอง (Orca: nestedWorkerMaxDepth) (How deep sub-tasks agents dispatch with kingu task create may nest: your tasks are depth 0, the ones their agents dispatch depth 1; 1 means a sub-task cannot dispatch more.)',
		// User-only: it decides how many agents agents may start.
		scope: 'application'
	},
	// --- Voice (Orca's Voice pane): dictation into the focused composer, editor or terminal (voice/).
	{
		id: 'kingu.voice.enabled',
		group: 'Voice',
		type: 'boolean',
		default: false,
		description: 'เปิดการพูดเป็นข้อความ (dictation): กดคีย์ลัด Voice: Dictation แล้วพูด ข้อความจะเข้าไปที่ช่องที่โฟกัสอยู่ เช่นช่องแชต editor หรือ terminal (Orca: voice.enabled) (Dictate into the focused chat box, editor or terminal with the Voice: Dictation shortcut.)'
	},
	{
		id: 'kingu.voice.engine',
		group: 'Voice',
		type: 'string',
		default: 'local',
		enum: ['local', 'openai'],
		enumDescriptions: [
			'whisper.cpp บนเครื่องนี้ เสียงไม่ออกจากเครื่อง ต้องติดตั้ง whisper-cli และเลือกไฟล์โมเดลใน kingu.voice.localModel (whisper.cpp on this computer; the audio never leaves it.)',
			'ส่งเสียงไปถอดที่ OpenAI ด้วย API key ของคุณที่เก็บใน Keychain (ตั้งในหน้า Voice) (Sends the audio to OpenAI with your API key from the Keychain.)'
		],
		description: 'ตัวถอดเสียงเป็นข้อความ (Orca: voice.sttModel) (The speech-to-text engine.)',
		// User-only: a repository must not route your voice to a cloud service.
		scope: 'application'
	},
	{
		id: 'kingu.voice.openaiModel',
		group: 'Voice',
		type: 'string',
		default: 'gpt-4o-mini-transcribe',
		enum: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe'],
		enumDescriptions: ['เร็วและถูกกว่า (Faster and cheaper.)', 'แม่นยำกว่า (More accurate.)'],
		description: 'โมเดลของ OpenAI เมื่อ kingu.voice.engine เป็น openai (Orca: voice.sttModel) (The OpenAI model when the engine is openai.)',
		scope: 'application'
	},
	{
		id: 'kingu.voice.localModel',
		group: 'Voice',
		type: 'string',
		default: '',
		description:
			'path เต็มของไฟล์โมเดล whisper.cpp (ggml-*.bin เช่น ggml-base.bin หรือ ggml-large-v3-turbo.bin) ที่ใช้เมื่อ kingu.voice.engine เป็น local Kingu ไม่ดาวน์โหลดโมเดลเอง (Orca: voice.modelsDir, voice.userModels) (Absolute path of the whisper.cpp ggml model file for the local engine; Kingu does not download models.)',
		// User-only: it is a file a program Kingu runs reads.
		scope: 'application'
	},
	{
		id: 'kingu.voice.whisperPath',
		group: 'Voice',
		type: 'string',
		default: '',
		description: 'path เต็มของ whisper-cli (หรือ whisper-cpp) ถ้าไม่อยู่ใน PATH เว้นว่างเพื่อหาเอง (Absolute path of whisper-cli when it is not on the PATH; empty finds it.)',
		// User-only: it is a program Kingu runs.
		scope: 'application'
	},
	{
		id: 'kingu.voice.language',
		group: 'Voice',
		type: 'string',
		default: 'auto',
		pattern: '^(auto|[a-z]{2,3})$',
		description: 'ภาษาที่พูด เป็นรหัส ISO 639-1 เช่น th หรือ en หรือ auto ให้ตรวจเอง (Orca: voice.language) (The spoken language as an ISO 639-1 code such as th or en, or auto.)'
	},
	{
		id: 'kingu.voice.dictationMode',
		group: 'Voice',
		type: 'string',
		default: 'toggle',
		enum: ['toggle', 'hold'],
		enumDescriptions: ['กดคีย์ลัดครั้งหนึ่งเพื่อเริ่ม อีกครั้งเพื่อหยุด (Press the shortcut to start, again to stop.)', 'พูดขณะกดคีย์ลัดค้างไว้ ปล่อยเพื่อหยุด (Dictate while the shortcut is held.)'],
		description: 'วิธีเริ่มและหยุดการพูด (Orca: voice.dictationMode) (How the shortcut starts and stops dictation.)'
	},
	{
		id: 'kingu.voice.terminalConfirmBeforeInsert',
		group: 'Voice',
		type: 'boolean',
		default: false,
		description: 'ถามก่อนใส่ข้อความที่ถอดได้ลงใน terminal (Orca: voice.terminalConfirmBeforeInsert) (Ask before inserting dictated text into a terminal.)'
	},
	{
		id: 'kingu.voice.microphone',
		group: 'Voice',
		type: 'string',
		default: '',
		description: 'ไมโครโฟนที่ใช้ (id ของอุปกรณ์ เลือกได้ในหน้า Voice) เว้นว่างเพื่อใช้ค่าเริ่มต้นของระบบ ถ้าไม่พบจะใช้ค่าเริ่มต้น (Orca: voice.microphoneDeviceId) (The microphone, chosen on the Voice page; empty or unplugged uses the system default.)'
	},
	{
		id: 'kingu.automations.confirmDelete',
		group: G,
		type: 'boolean',
		default: true,
		description: 'ถามก่อนลบ automation (Orca: skipDeleteAutomationConfirm กลับค่า) (Ask before deleting an automation.)'
	}
];
