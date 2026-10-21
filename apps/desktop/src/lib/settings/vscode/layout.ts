// VS Code settings: zenMode.* (workbench.zenMode.contribution.ts) and the centered editor layout
// (workbench.editor.centeredLayout*, workbench.contribution.ts). Key, type, enum, default and
// English description are VS Code's; the Thai text is Kingu's. Applied by workbench/layout.svelte.ts.
import type { SettingSchema } from '../registry';

export const LAYOUT_SETTINGS: SettingSchema[] = [
	{
		id: 'workbench.editor.centeredLayoutAutoResize',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'ปิด centered layout เองเมื่อเปิด editor group มากกว่าหนึ่งคอลัมน์ (Controls if the centered layout should automatically resize to maximum width when more than one group is open. Once only one group is open it will resize back to the original centered width.)'
	},
	{
		id: 'workbench.editor.centeredLayoutFixedWidth',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'ให้ centered layout คงความกว้างเดิมเมื่อขนาดหน้าต่างเปลี่ยน (Controls whether the centered layout tries to maintain constant width when the window is resized.)'
	},
	{
		id: 'zenMode.fullScreen',
		group: 'Zen Mode',
		type: 'boolean',
		default: true,
		description: 'เข้า Zen Mode แล้วให้หน้าต่างเต็มจอด้วย (Controls whether turning on Zen Mode also puts the workbench into full screen mode.)'
	},
	{
		id: 'zenMode.centerLayout',
		group: 'Zen Mode',
		type: 'boolean',
		default: true,
		description: 'เข้า Zen Mode แล้วจัด editor ไว้กลางจอ (Controls whether turning on Zen Mode also centers the layout.)'
	},
	{
		id: 'zenMode.showTabs',
		group: 'Zen Mode',
		type: 'string',
		default: 'multiple',
		enum: ['multiple', 'single', 'none'],
		enumDescriptions: [
			'แสดงทุก editor เป็นแท็บ (Each editor is displayed as a tab in the editor title area.)',
			'แสดงเฉพาะ editor ที่ใช้อยู่เป็นแท็บเดียว (The active editor is displayed as a single large tab in the editor title area.)',
			'ไม่แสดงแถบแท็บ (The editor title area is not displayed.)'
		],
		description: 'แท็บของ editor ระหว่าง Zen Mode: หลายแท็บ แท็บเดียว หรือไม่แสดง (Controls whether turning on Zen Mode should show multiple editor tabs, a single editor tab, or hide the editor title area completely.)'
	},
	{
		id: 'zenMode.hideStatusBar',
		group: 'Zen Mode',
		type: 'boolean',
		default: true,
		description: 'เข้า Zen Mode แล้วซ่อนแถบสถานะ (Controls whether turning on Zen Mode also hides the status bar at the bottom of the workbench.)'
	},
	{
		id: 'zenMode.hideActivityBar',
		group: 'Zen Mode',
		type: 'boolean',
		default: true,
		description: 'เข้า Zen Mode แล้วซ่อน activity bar (Controls whether turning on Zen Mode also hides the activity bar either at the left or right of the workbench.)'
	},
	{
		id: 'zenMode.hideLineNumbers',
		group: 'Zen Mode',
		type: 'boolean',
		default: true,
		description: 'เข้า Zen Mode แล้วซ่อนเลขบรรทัดใน editor (Controls whether turning on Zen Mode also hides the editor line numbers.)'
	},
	{
		id: 'zenMode.restore',
		group: 'Zen Mode',
		type: 'boolean',
		default: true,
		description: 'เปิดหน้าต่างใหม่ใน Zen Mode ถ้าปิดไปตอนอยู่ใน Zen Mode (Controls whether a window should restore to Zen Mode if it was exited in Zen Mode.)'
	},
	{
		id: 'zenMode.silentNotifications',
		group: 'Zen Mode',
		type: 'boolean',
		default: true,
		description: 'ระหว่าง Zen Mode เปิดโหมดห้ามรบกวน แสดงเฉพาะการแจ้งเตือนข้อผิดพลาด (Controls whether notifications do not disturb mode should be enabled while in Zen Mode. If true, only error notifications will pop out.)'
	}
];
