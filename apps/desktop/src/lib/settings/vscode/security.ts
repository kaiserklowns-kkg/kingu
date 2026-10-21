// VS Code settings: security.workspace.trust.* (Workspace Trust, workbench/workspaceTrust.svelte.ts)
// and workbench.trustedDomains.* (outgoing link protection, workbench/trustedDomains.svelte.ts).
// Key, type, enum and default are VS Code's; the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const SECURITY_SETTINGS: SettingSchema[] = [
	{
		id: 'security.workspace.trust.enabled',
		group: 'Security',
		type: 'boolean',
		default: true,
		description: 'เปิดใช้ Workspace Trust: โฟลเดอร์ที่ยังไม่เชื่อถือเปิดใน Restricted Mode ซึ่งไม่รัน task ไม่ debug ไม่ใช้ language server จาก node_modules ของโฟลเดอร์ และไม่ใช้การตั้งค่าที่จำกัดของโฟลเดอร์ (Controls whether or not Workspace Trust is enabled within Kingu.)',
		scope: 'application'
	},
	{
		id: 'security.workspace.trust.startupPrompt',
		group: 'Security',
		type: 'string',
		default: 'never',
		enum: ['always', 'once', 'never'],
		enumDescriptions: [
			'ถามทุกครั้งที่เปิดโฟลเดอร์ที่ยังไม่เชื่อถือ (Ask for trust every time an untrusted workspace is opened.)',
			'ถามครั้งแรกที่เปิดแต่ละโฟลเดอร์ (Ask for trust the first time an untrusted workspace is opened.)',
			'ไม่ถาม เปิดใน Restricted Mode พร้อมแถบแจ้ง (Do not ask for trust when an untrusted workspace is opened.)'
		],
		description: 'เมื่อไรจะถามว่าเชื่อถือโฟลเดอร์ที่เปิดหรือไม่ (Controls when the startup prompt to trust a workspace is shown.)',
		scope: 'application'
	},
	{
		id: 'security.workspace.trust.banner',
		group: 'Security',
		type: 'string',
		default: 'untilDismissed',
		enum: ['always', 'untilDismissed', 'never'],
		enumDescriptions: [
			'แสดงแถบทุกครั้งที่เปิดโฟลเดอร์ที่ยังไม่เชื่อถือ (Show the banner every time an untrusted workspace is open.)',
			'แสดงจนกว่าจะปิดแถบในโฟลเดอร์นั้น (Show the banner when an untrusted workspace is opened until dismissed.)',
			'ไม่แสดงแถบ (Do not show the banner when an untrusted workspace is open.)'
		],
		description: 'เมื่อไรจะแสดงแถบ Restricted Mode (Controls when the restricted mode banner is shown.)',
		scope: 'application'
	},
	{
		id: 'security.workspace.trust.untrustedFiles',
		group: 'Security',
		type: 'string',
		default: 'prompt',
		enum: ['prompt', 'open', 'newWindow'],
		enumDescriptions: [
			'ถามในแต่ละ workspace เมื่อเปิดไฟล์ที่ไม่ได้อยู่ในโฟลเดอร์ที่เชื่อถือ ตอบครั้งเดียวต่อ workspace (Ask how to handle untrusted files for each workspace. Once untrusted files are introduced to a trusted workspace, you will not be prompted again.)',
			'เปิดได้เลยโดยไม่ถาม (Always allow untrusted files to be introduced to a trusted workspace without prompting.)',
			'เปิดในหน้าต่างใหม่แบบ Restricted Mode เสมอ (Always open untrusted files in a separate window in restricted mode without prompting.)'
		],
		description: 'การเปิดไฟล์ที่ไม่ได้อยู่ในโฟลเดอร์ที่เชื่อถือ ในหน้าต่างที่เชื่อถือแล้ว (รวมหน้าต่างว่างที่เชื่อถือตาม `#security.workspace.trust.emptyWindow#`) (Controls how to handle opening untrusted files in a trusted workspace. This setting also applies to opening files in an empty window which is trusted via `#security.workspace.trust.emptyWindow#`.)',
		scope: 'application'
	},
	{
		id: 'security.workspace.trust.emptyWindow',
		group: 'Security',
		type: 'boolean',
		default: true,
		description: 'ถือว่าหน้าต่างว่าง (ไม่มีโฟลเดอร์) เชื่อถือได้ (Controls whether or not the empty window is trusted by default within Kingu. When used with `#security.workspace.trust.untrustedFiles#`, you can enable the full functionality of Kingu without prompting in an empty window.)',
		scope: 'application'
	},
	{
		id: 'workbench.trustedDomains.promptInTrustedWorkspace',
		group: 'Security',
		type: 'boolean',
		default: false,
		description: 'ถามก่อนเปิดลิงก์ภายนอกจาก editor และ Markdown preview แม้ในโฟลเดอร์ที่เชื่อถือแล้ว (ลิงก์จาก terminal และ chat ถามเสมอถ้าโดเมนไม่อยู่ใน Trusted Domains) (When enabled, trusted domain prompts will appear when opening links in trusted workspaces.)',
		scope: 'application'
	}
];
