// VS Code settings: keyboard.* and application.*. Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const APPLICATION_SETTINGS: SettingSchema[] = [
	{
		id: 'keyboard.dispatch',
		group: 'Application',
		type: 'string',
		default: 'code',
		enum: ['code', 'keyCode'],
		description: 'จับคู่คีย์ลัดจากตำแหน่งปุ่มบนคีย์บอร์ด หรือจากตัวอักษรที่ปุ่มพิมพ์ตาม layout (Controls the dispatching logic for key presses to use either `code` (recommended) or `keyCode`.)',
		scope: 'application'
	},
	{
		id: 'application.shellEnvironmentResolutionTimeout',
		group: 'Application',
		type: 'number',
		default: 10,
		minimum: 1,
		maximum: 120,
		description: 'เวลาสูงสุดเป็นวินาทีที่รออ่าน PATH จาก login shell ตอนเปิด Kingu จาก Dock หรือ Finder มีผลเมื่อเปิด Kingu ครั้งถัดไป (Controls the timeout in seconds before giving up resolving the shell environment when the application is not already launched from a terminal. See our [documentation](https://go.microsoft.com/fwlink/?linkid=2149667) for more information.)',
		scope: 'application'
	}
];
