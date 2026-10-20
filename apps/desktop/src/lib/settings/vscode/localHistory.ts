// VS Code settings: workbench.localHistory.* (workbench.contribution.ts). Key, type, default,
// minimum and English description are VS Code's; the Thai text is Kingu's. Read by
// scm/localHistory.svelte.ts, applied by Rust local_history.rs.
import type { SettingSchema } from '../registry';

export const LOCAL_HISTORY_SETTINGS: SettingSchema[] = [
	{
		id: 'workbench.localHistory.enabled',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'เก็บประวัติไฟล์ในเครื่อง: ทุกครั้งที่บันทึก จะเก็บสำเนาไว้ดูหรือกู้คืนภายหลัง (Controls whether local file history is enabled. When enabled, the file contents of an editor that is saved will be stored to a backup location to be able to restore or review the contents later. Changing this setting has no effect on existing local file history entries.)'
	},
	{
		id: 'workbench.localHistory.maxFileSize',
		group: 'Workbench',
		type: 'number',
		default: 256,
		minimum: 1,
		description: 'ขนาดไฟล์สูงสุด (KB) ที่เก็บประวัติ ไฟล์ที่ใหญ่กว่าจะไม่ถูกเก็บ (Controls the maximum size of a file (in KB) to be considered for local file history. Files that are larger will not be added to the local file history. Changing this setting has no effect on existing local file history entries.)'
	},
	{
		id: 'workbench.localHistory.maxFileEntries',
		group: 'Workbench',
		type: 'number',
		default: 50,
		minimum: 0,
		description: 'จำนวนรายการประวัติสูงสุดต่อไฟล์ เกินแล้วรายการเก่าสุดจะถูกลบ (Controls the maximum number of local file history entries per file. When the number of local file history entries exceeds this number for a file, the oldest entries will be discarded.)'
	},
	{
		id: 'workbench.localHistory.exclude',
		group: 'Workbench',
		type: 'object',
		values: 'boolean',
		default: {},
		description: 'glob ของไฟล์ที่ไม่เก็บประวัติ (Configure paths or [glob patterns](https://aka.ms/vscode-glob-patterns) for excluding files from the local file history. Glob patterns are always evaluated relative to the path of the workspace folder unless they are absolute paths. Changing this setting has no effect on existing local file history entries.)'
	},
	{
		id: 'workbench.localHistory.mergeWindow',
		group: 'Workbench',
		type: 'number',
		default: 10,
		minimum: 1,
		description: 'ช่วงเวลา (วินาที) ที่การบันทึกจากแหล่งเดียวกันจะแทนรายการล่าสุดแทนการเพิ่มใหม่ (Configure an interval in seconds during which the last entry in local file history is replaced with the entry that is being added. This helps reduce the overall number of entries that are added, for example when auto save is enabled. This setting is only applied to entries that have the same source of origin. Changing this setting has no effect on existing local file history entries.)'
	}
];
