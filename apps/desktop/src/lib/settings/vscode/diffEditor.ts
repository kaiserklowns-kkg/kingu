// VS Code settings: diffEditor.*. Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const DIFF_EDITOR_SETTINGS: SettingSchema[] = [
	{
		id: 'diffEditor.diffAlgorithm',
		group: 'Diff Editor',
		type: 'string',
		default: 'advanced',
		enum: ['legacy', 'advanced', 'advanced-external', 'advanced-wasm'],
		enumDescriptions: [
			'Uses the legacy diffing algorithm.',
			'Uses the advanced diffing algorithm.',
			'Uses the advanced diffing algorithm from the external `@vscode/diff` package (pure JavaScript).',
			'Uses the advanced diffing algorithm from the external `@vscode/diff` package (WebAssembly).'
		],
		description: 'อัลกอริทึมที่ใช้คำนวณ diff (Controls which algorithm computes the diff.)'
	},
	{
		id: 'diffEditor.experimental.showEmptyDecorations',
		group: 'Diff Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงเครื่องหมายว่างตรงตำแหน่งที่มีการแทรกหรือลบอักขระ (Controls whether the diff editor shows empty decorations to see where characters got inserted or deleted.)'
	},
	{
		id: 'diffEditor.experimental.showMoves',
		group: 'Diff Editor',
		type: 'boolean',
		default: false,
		description: 'แสดงโค้ดที่ถูกย้ายตำแหน่ง (Controls whether the diff editor should show detected code moves.)'
	},
	{
		id: 'diffEditor.experimental.useTrueInlineView',
		group: 'Diff Editor',
		type: 'boolean',
		default: false,
		description: 'ในมุมมองแบบ inline ให้แสดงคำที่เปลี่ยนในบรรทัดเดียวกัน (If enabled and the editor uses the inline view, word changes are rendered inline.)'
	},
	{
		id: 'diffEditor.hideOriginalLineNumbers',
		group: 'Diff Editor',
		type: 'json',
		schema: { type: ['boolean', 'null'] },
		default: null,
		description: 'ซ่อนเลขบรรทัดต้นฉบับในมุมมองแบบ inline ค่า null ใช้ค่าเริ่มต้นของ editor (Controls whether original line numbers are hidden in inline diffs. When set to null, uses the editor\'s default: hidden in compact multi diff editors and visible in other diff editors.)'
	},
	{
		id: 'diffEditor.hideUnchangedRegions.contextLineCount',
		group: 'Diff Editor',
		type: 'number',
		default: 3,
		minimum: 1,
		integer: true,
		description: 'จำนวนบรรทัดบริบทรอบส่วนที่ไม่เปลี่ยน (Controls how many lines are used as context when comparing unchanged regions.)'
	},
	{
		id: 'diffEditor.hideUnchangedRegions.enabled',
		group: 'Diff Editor',
		type: 'boolean',
		default: false,
		description: 'ซ่อนส่วนที่ไม่เปลี่ยนใน diff (Controls whether the diff editor shows unchanged regions.)'
	},
	{
		id: 'diffEditor.hideUnchangedRegions.minimumLineCount',
		group: 'Diff Editor',
		type: 'number',
		default: 3,
		minimum: 1,
		integer: true,
		description: 'จำนวนบรรทัดขั้นต่ำของส่วนที่ไม่เปลี่ยนที่จะถูกซ่อน (Controls how many lines are used as a minimum for unchanged regions.)'
	},
	{
		id: 'diffEditor.hideUnchangedRegions.revealLineCount',
		group: 'Diff Editor',
		type: 'number',
		default: 20,
		minimum: 1,
		integer: true,
		description: 'จำนวนบรรทัดที่เปิดเผยเพิ่มต่อครั้งในส่วนที่ไม่เปลี่ยน (Controls how many lines are used for unchanged regions.)'
	},
	{
		id: 'diffEditor.ignoreTrimWhitespace',
		group: 'Diff Editor',
		type: 'boolean',
		default: true,
		description: 'ไม่นับช่องว่างหน้าและท้ายบรรทัดเป็นการเปลี่ยนแปลง (When enabled, the diff editor ignores changes in leading or trailing whitespace.)'
	},
	{
		id: 'diffEditor.maxComputationTime',
		group: 'Diff Editor',
		type: 'number',
		default: 5000,
		description: 'เวลาสูงสุดเป็นมิลลิวินาทีในการคำนวณ diff ค่า 0 คือไม่จำกัด (Timeout in milliseconds after which diff computation is cancelled. Use 0 for no timeout.)'
	},
	{
		id: 'diffEditor.maxFileSize',
		group: 'Diff Editor',
		type: 'number',
		default: 50,
		description: 'ขนาดไฟล์สูงสุดเป็น MB ที่จะคำนวณ diff ค่า 0 คือไม่จำกัด (Maximum file size in MB for which to compute diffs. Use 0 for no limit.)'
	},
	{
		id: 'diffEditor.renderGutterMenu',
		group: 'Diff Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงขอบพิเศษสำหรับคำสั่งย้อนกลับและ stage (When enabled, the diff editor shows a special gutter for revert and stage actions.)'
	},
	{
		id: 'diffEditor.renderIndicators',
		group: 'Diff Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงเครื่องหมาย + และ - หน้าบรรทัดที่เพิ่มและลบ (Controls whether the diff editor shows +/- indicators for added/removed changes.)'
	},
	{
		id: 'diffEditor.renderMarginRevertIcon',
		group: 'Diff Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงลูกศรที่ขอบซ้ายเพื่อย้อนการเปลี่ยนแปลง (When enabled, the diff editor shows arrows in its glyph margin to revert changes.)'
	},
	{
		id: 'diffEditor.renderSideBySide',
		group: 'Diff Editor',
		type: 'boolean',
		default: true,
		description: 'แสดง diff แบบสองฝั่ง (Controls whether the diff editor shows the diff side by side or inline.)'
	},
	{
		id: 'diffEditor.renderSideBySideInlineBreakpoint',
		group: 'Diff Editor',
		type: 'number',
		default: 900,
		description: 'ถ้า diff editor แคบกว่าค่านี้จะใช้มุมมองแบบ inline (If the diff editor width is smaller than this value, the inline view is used.)'
	},
	{
		id: 'diffEditor.useInlineViewWhenSpaceIsLimited',
		group: 'Diff Editor',
		type: 'boolean',
		default: true,
		description: 'ใช้มุมมองแบบ inline เมื่อพื้นที่แคบ (If enabled and the editor width is too small, the inline view is used.)'
	},
	{
		id: 'diffEditor.wordWrap',
		group: 'Diff Editor',
		type: 'string',
		default: 'inherit',
		enum: ['off', 'on', 'inherit'],
		enumDescriptions: [
			'ไม่ตัดบรรทัด (Lines will never wrap.)',
			'ตัดบรรทัดตามความกว้าง (Lines will wrap at the viewport width.)',
			'ตาม editor.wordWrap (Lines will wrap according to the `#editor.wordWrap#` setting.)'
		],
		description: 'การตัดบรรทัดใน diff (Controls how lines wrap in the diff editor.)'
	}
];
