// VS Code settings: json.* (vscode-json-language-server). Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const JSON_SETTINGS: SettingSchema[] = [
	{
		id: 'json.validate.enable',
		group: 'JSON',
		type: 'boolean',
		default: true,
		description: 'ตรวจความถูกต้องของ JSON (Enable/disable JSON validation.)'
	},
	{
		id: 'json.format.enable',
		group: 'JSON',
		type: 'boolean',
		default: true,
		description: 'เปิดตัวจัดรูปแบบ JSON (Enable/disable default JSON formatter)'
	},
	{
		id: 'json.format.keepLines',
		group: 'JSON',
		type: 'boolean',
		default: false,
		description: 'คงการขึ้นบรรทัดเดิมตอนจัดรูปแบบ (Keep all existing new lines when formatting.)'
	},
	{
		id: 'json.schemas',
		group: 'JSON',
		type: 'json',
		schema: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					url: { type: 'string' },
					fileMatch: { type: 'array', minItems: 1, items: { type: 'string' } },
					schema: {}
				}
			}
		},
		default: [],
		description: 'จับคู่ schema กับไฟล์ JSON ในโปรเจกต์ (Associate schemas to JSON files in the current project.)'
	},
	{
		id: 'json.maxItemsComputed',
		group: 'JSON',
		type: 'number',
		default: 5000,
		description: 'จำนวนสูงสุดของ symbol outline และ folding ที่คำนวณ (The maximum number of outline symbols and folding regions computed (limited for performance reasons).)'
	},
	{
		id: 'json.trace.server',
		group: 'JSON',
		type: 'string',
		default: 'off',
		enum: ['off', 'messages', 'verbose'],
		description: 'บันทึกข้อความระหว่าง Kingu กับ JSON language server ลงช่อง Output ของ server (Traces the communication between VS Code and the JSON language server.)'
	}
];
