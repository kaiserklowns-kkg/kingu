// VS Code settings: problems.*. Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const PROBLEMS_SETTINGS: SettingSchema[] = [
	{
		id: 'problems.visibility',
		group: 'Problems',
		type: 'boolean',
		default: true,
		description: 'แสดงปัญหาใน editor และ workbench (Controls whether the problems are visible throughout the editor and workbench.)'
	},
	{
		id: 'problems.autoReveal',
		group: 'Problems',
		type: 'boolean',
		default: true,
		description: 'ให้มุมมอง Problems เลื่อนไปที่ไฟล์ที่เปิดอยู่เอง (Controls whether Problems view should automatically reveal files when opening them.)'
	},
	{
		id: 'problems.defaultViewMode',
		group: 'Problems',
		type: 'string',
		default: 'tree',
		enum: ['table', 'tree'],
		description: 'รูปแบบเริ่มต้นของมุมมอง Problems เป็นตารางหรือต้นไม้ (Controls the default view mode of the Problems view.)'
	},
	{
		id: 'problems.decorations.enabled',
		group: 'Problems',
		type: 'boolean',
		default: true,
		description: 'แสดง error และ warning บนไฟล์และโฟลเดอร์ใน Explorer ถูกแทนด้วย problems.visibility เมื่อปิดอยู่ (Show Errors & Warnings on files and folder. Overwritten by `#problems.visibility#` when it is off.)'
	},
	{
		id: 'problems.showCurrentInStatus',
		group: 'Problems',
		type: 'boolean',
		default: false,
		description: 'แสดงปัญหาที่ตำแหน่ง cursor ในแถบสถานะ (When enabled shows the current problem in the status bar.)'
	},
	{
		id: 'problems.sortOrder',
		group: 'Problems',
		type: 'string',
		default: 'severity',
		enum: ['severity', 'position'],
		enumDescriptions: [
			'เรียงตามความรุนแรง (Navigate problems ordered by severity)',
			'เรียงตามตำแหน่ง (Navigate problems ordered by position)'
		],
		description: 'ลำดับการไล่ดูปัญหา (Controls the order in which problems are navigated.)'
	}
];
