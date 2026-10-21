// VS Code settings: accessibility.signals.* and accessibility.signalOptions.* (the signals Kingu
// plays, workbench/accessibilitySignals.svelte.ts). Key, type, default and English description are
// VS Code's (accessibilityConfiguration.ts); the Thai text is Kingu's.
import type { JsonSchema } from '../jsonSchema';
import type { SettingSchema } from '../registry';

const SOUND = ['auto', 'on', 'off'] as const;
const ANNOUNCEMENT = ['auto', 'off'] as const;

/** `{ sound, announcement }` like VS Code's signalFeatureBase; `announce: false` for sound-only signals. */
const signalSchema = (sound: readonly string[] = SOUND, announcement: readonly string[] | null = ANNOUNCEMENT): JsonSchema => ({
	type: 'object',
	properties: { sound: { type: 'string', enum: sound }, ...(announcement ? { announcement: { type: 'string', enum: announcement } } : {}) },
	additionalProperties: false
});

const signal = (id: string, th: string, en: string): SettingSchema => ({
	id: `accessibility.signals.${id}`,
	group: 'Accessibility',
	type: 'json',
	schema: signalSchema(),
	default: { sound: 'auto', announcement: 'auto' },
	description: `${th} เสียง auto เล่นเมื่ออยู่ในโหมดโปรแกรมอ่านหน้าจอ (editor.accessibilitySupport: on) (${en})`
});

export const ACCESSIBILITY_SETTINGS: SettingSchema[] = [
	{
		id: 'accessibility.signalOptions.debouncePositionChanges',
		group: 'Accessibility',
		type: 'boolean',
		default: false,
		description: 'หน่วงสัญญาณเมื่อเคอร์เซอร์ย้ายเร็ว ๆ ให้เล่นเมื่อหยุดที่บรรทัดแล้ว (Whether or not position changes should be debounced)'
	},
	{
		id: 'accessibility.signalOptions.volume',
		group: 'Accessibility',
		type: 'number',
		default: 70,
		minimum: 0,
		maximum: 100,
		description: 'ความดังของเสียงสัญญาณเป็นเปอร์เซ็นต์ 0–100 (The volume of the sounds in percent (0-100).)'
	},
	signal('lineHasBreakpoint', 'เล่นสัญญาณเมื่อบรรทัดที่เคอร์เซอร์อยู่มี breakpoint', 'Plays a signal - sound (audio cue) and/or announcement (alert) - when the active line has a breakpoint.'),
	signal('lineHasError', 'เล่นสัญญาณเมื่อบรรทัดที่เคอร์เซอร์อยู่มี error', 'Plays a signal - sound (audio cue) and/or announcement (alert) - when the active line has an error.'),
	signal('lineHasFoldedArea', 'เล่นสัญญาณเมื่อบรรทัดที่เคอร์เซอร์อยู่มีส่วนที่พับไว้', 'Plays a signal - sound (audio cue) and/or announcement (alert) - the active line has a folded area that can be unfolded.'),
	signal('lineHasWarning', 'เล่นสัญญาณเมื่อบรรทัดที่เคอร์เซอร์อยู่มี warning', 'Plays a signal - sound (audio cue) and/or announcement (alert) - when the active line has a warning.'),
	signal('onDebugBreak', 'เล่นสัญญาณเมื่อ debugger หยุดที่ breakpoint', 'Plays a signal - sound (audio cue) and/or announcement (alert) - when the debugger stopped on a breakpoint.'),
	{
		id: 'accessibility.signals.save',
		group: 'Accessibility',
		type: 'json',
		schema: signalSchema(['userGesture', 'always', 'never'], ['userGesture', 'always', 'never']),
		default: { sound: 'never', announcement: 'never' },
		description:
			'เล่นสัญญาณเมื่อบันทึกไฟล์: userGesture เฉพาะเมื่อสั่งบันทึกเอง always รวม auto save ด้วย never ไม่เล่น (Plays a signal - sound (audio cue) and/or announcement (alert) - when a file is saved.)'
	},
	signal('taskCompleted', 'เล่นสัญญาณเมื่อ task ทำงานเสร็จ', 'Plays a signal - sound (audio cue) and/or announcement (alert) - when a task is completed.'),
	signal('taskFailed', 'เล่นสัญญาณเมื่อ task ล้มเหลว (exit code ไม่เป็นศูนย์)', 'Plays a signal - sound (audio cue) and/or announcement (alert) - when a task fails (non-zero exit code).')
];
