// VS Code's accessibility signals for the editor, debugger, tasks and saves
// (accessibility.signals.*: a sound and/or a screen reader announcement each). Pure: whether a
// signal's setting plays its sound or announcement, which line signals a cursor move or a marker
// change brings, and the tones. `auto` means "when in screen reader optimized mode", which in
// Kingu is editor.accessibilitySupport `on` (a webview cannot detect a screen reader).

export type AccessibilitySignal = 'lineHasError' | 'lineHasWarning' | 'lineHasBreakpoint' | 'lineHasFoldedArea' | 'onDebugBreak' | 'taskCompleted' | 'taskFailed' | 'save';

export const SIGNAL_IDS: readonly AccessibilitySignal[] = ['lineHasError', 'lineHasWarning', 'lineHasBreakpoint', 'lineHasFoldedArea', 'onDebugBreak', 'taskCompleted', 'taskFailed', 'save'];

/** Each signal's setting. */
export const SIGNAL_SETTINGS: Record<AccessibilitySignal, string> = {
	lineHasError: 'accessibility.signals.lineHasError',
	lineHasWarning: 'accessibility.signals.lineHasWarning',
	lineHasBreakpoint: 'accessibility.signals.lineHasBreakpoint',
	lineHasFoldedArea: 'accessibility.signals.lineHasFoldedArea',
	onDebugBreak: 'accessibility.signals.onDebugBreak',
	taskCompleted: 'accessibility.signals.taskCompleted',
	taskFailed: 'accessibility.signals.taskFailed',
	save: 'accessibility.signals.save'
};

/** The line signals, in the order VS Code plays them when several hold for one line. */
export const LINE_SIGNALS = ['lineHasError', 'lineHasWarning', 'lineHasFoldedArea', 'lineHasBreakpoint'] as const;
export type LineSignal = (typeof LINE_SIGNALS)[number];

/** `{ sound, announcement }` as a settings file has it (anything else counts as the defaults). */
export type SignalSetting = { sound?: unknown; announcement?: unknown };

export type SignalContext = { screenReader: boolean; userGesture?: boolean };

/** Whether `accessibility.signals.<id>` plays its sound and makes its announcement now. */
export function signalModes(id: AccessibilitySignal, setting: unknown, ctx: SignalContext): { sound: boolean; announce: boolean } {
	const s = (setting && typeof setting === 'object' ? setting : {}) as SignalSetting;
	if (id === 'save') {
		// userGesture | always | never (an explicit save is the user gesture; auto save is not).
		const on = (v: unknown) => v === 'always' || (v === 'userGesture' && !!ctx.userGesture);
		return { sound: on(s.sound ?? 'never'), announce: on(s.announcement ?? 'never') };
	}
	const sound = s.sound ?? 'auto';
	const announcement = s.announcement ?? 'auto';
	return {
		sound: sound === 'on' || (sound === 'auto' && ctx.screenReader),
		announce: announcement === 'on' || (announcement === 'auto' && ctx.screenReader)
	};
}

/** What holds for the line the cursor is on. */
export type LineState = { line: number; uri: string; signals: ReadonlySet<LineSignal> };

/**
 * The line signals to play going from `prev` to `next`: moving to another line plays what holds
 * there; staying on a line plays what became true (an error appeared under the cursor), like
 * VS Code's line features.
 */
export function lineSignalsToPlay(prev: LineState | null, next: LineState): LineSignal[] {
	const moved = !prev || prev.line !== next.line || prev.uri !== next.uri;
	return LINE_SIGNALS.filter((s) => next.signals.has(s) && (moved || !prev!.signals.has(s)));
}

/** A folded region starts on `line` when the visible ranges jump over the lines after it. */
export function hasFoldedAreaAt(line: number, visible: readonly { startLineNumber: number; endLineNumber: number }[]): boolean {
	const i = visible.findIndex((r) => r.endLineNumber === line);
	return i >= 0 && i + 1 < visible.length && visible[i + 1].startLineNumber > line + 1;
}

/** Notes as [frequency Hz, start s, length s], short and distinct per signal. */
export const SIGNAL_TONES: Record<AccessibilitySignal, [number, number, number][]> = {
	lineHasError: [
		[392, 0, 0.12],
		[311, 0.1, 0.16]
	],
	lineHasWarning: [
		[523, 0, 0.1],
		[466, 0.09, 0.12]
	],
	lineHasBreakpoint: [[880, 0, 0.09]],
	lineHasFoldedArea: [
		[659, 0, 0.07],
		[784, 0.06, 0.08]
	],
	onDebugBreak: [
		[587, 0, 0.12],
		[587, 0.16, 0.12]
	],
	taskCompleted: [
		[523, 0, 0.14],
		[784, 0.1, 0.2]
	],
	taskFailed: [
		[466, 0, 0.14],
		[349, 0.12, 0.22]
	],
	save: [
		[698, 0, 0.06],
		[1047, 0.05, 0.1]
	]
};

/** `accessibility.signalOptions.volume` (0–100, 70 by default) as the peak gain of a tone. */
export const signalGain = (volume: unknown) => (Math.max(0, Math.min(100, typeof volume === 'number' ? volume : 70)) / 100) * 0.17;
