// VS Code settings: output.*. Key, type, default and English description are VS Code's
// (output.contribution.ts); the Thai text is Kingu's. Consumer: src/lib/output/OutputView.svelte.
import type { SettingSchema } from '../registry';

export const OUTPUT_SETTINGS: SettingSchema[] = [
	{
		id: 'output.smartScroll.enabled',
		group: 'Output',
		type: 'boolean',
		default: true,
		description: 'เลื่อนอัตโนมัติแบบฉลาดในมุมมอง Output: เลื่อนขึ้นจะหยุดเลื่อนตาม เลื่อนกลับมาท้ายสุดจะเลื่อนตามอีกครั้ง (Enable/disable the ability of smart scrolling in the output view. Smart scrolling allows you to lock scrolling automatically when you click in the output view and unlocks when you click in the last line.)'
	}
];
