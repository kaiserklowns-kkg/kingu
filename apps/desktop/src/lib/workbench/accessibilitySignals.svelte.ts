// Plays VS Code's accessibility signals (accessibilitySignals.ts): the line signals as the cursor
// moves in a focused editor (error, warning, folded area, breakpoint), the debugger stopping, a task
// ending, and saves. Announcements go to a polite live region for screen readers. Also the screen
// reader commands: Toggle Screen Reader Accessibility Mode and Announce Cursor Position.

import type * as Monaco from 'monaco-editor';
import { settings } from '#lib/settings/settings.svelte.ts';
import { debug } from '#lib/debug/debug.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { commands } from './commands.svelte';
import { getEntry, openModels, saveListeners } from './editorModels';
import { playNotes } from './signals.svelte';
import { hasFoldedAreaAt, lineSignalsToPlay, signalGain, signalModes, SIGNAL_SETTINGS, SIGNAL_TONES, type AccessibilitySignal, type LineSignal, type LineState } from './accessibilitySignals';

/** Screen reader optimized mode: editor.accessibilitySupport `on`. */
export const screenReaderMode = () => settings.get<string>('editor.accessibilitySupport') === 'on';

let region: HTMLElement | null = null;

/** Says `text` to a screen reader (VS Code's aria alert): a visually hidden polite live region. */
export function announce(text: string) {
	if (typeof document === 'undefined') return;
	if (!region) {
		region = document.createElement('div');
		region.setAttribute('role', 'status');
		region.setAttribute('aria-live', 'polite');
		region.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap';
		document.body.appendChild(region);
	}
	// Cleared first, so the same message twice is read twice.
	region.textContent = '';
	const el = region;
	setTimeout(() => (el.textContent = text), 30);
}

const MESSAGES: Record<AccessibilitySignal, () => string> = {
	lineHasError: () => t('workbench.signals.error'),
	lineHasWarning: () => t('workbench.signals.warning'),
	lineHasBreakpoint: () => t('workbench.signals.breakpoint'),
	lineHasFoldedArea: () => t('workbench.signals.folded'),
	onDebugBreak: () => t('workbench.signals.debugBreak'),
	taskCompleted: () => t('workbench.signals.taskCompleted'),
	taskFailed: () => t('workbench.signals.taskFailed'),
	save: () => t('workbench.signals.save')
};

/** Plays `id` as accessibility.signals.<id> says (sound, announcement, both or neither). */
export function playAccessibilitySignal(id: AccessibilitySignal, opts: { userGesture?: boolean } = {}) {
	const modes = signalModes(id, settings.get(SIGNAL_SETTINGS[id]), { screenReader: screenReaderMode(), userGesture: opts.userGesture });
	const gain = signalGain(settings.get('accessibility.signalOptions.volume'));
	if (modes.sound && gain > 0) playNotes(SIGNAL_TONES[id], gain);
	if (modes.announce) announce(MESSAGES[id]());
}

/** The relative path of a model for the breakpoint map, if it is a workspace file. */
const pathOf = (model: Monaco.editor.ITextModel) => openModels().find(([, m]) => m === model)?.[0];

function lineState(monaco: typeof Monaco, editor: Monaco.editor.ICodeEditor): LineState | null {
	const model = editor.getModel();
	const pos = editor.getPosition();
	if (!model || !pos) return null;
	const line = pos.lineNumber;
	const signals = new Set<LineSignal>();
	for (const m of monaco.editor.getModelMarkers({ resource: model.uri })) {
		if (m.startLineNumber > line || m.endLineNumber < line) continue;
		if (m.severity === monaco.MarkerSeverity.Error) signals.add('lineHasError');
		else if (m.severity === monaco.MarkerSeverity.Warning) signals.add('lineHasWarning');
	}
	const rel = pathOf(model);
	if (rel && (debug.breakpoints[rel] ?? []).some((b) => b.line === line)) signals.add('lineHasBreakpoint');
	if (hasFoldedAreaAt(line, editor.getVisibleRanges())) signals.add('lineHasFoldedArea');
	return { line, uri: model.uri.toString(), signals };
}

/** Line signals of one editor: on cursor moves (debounced with accessibility.signalOptions.debouncePositionChanges) and marker changes. */
function watchEditor(monaco: typeof Monaco, editor: Monaco.editor.ICodeEditor): () => void {
	let last: LineState | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const check = () => {
		if (!editor.hasTextFocus()) return;
		const next = lineState(monaco, editor);
		if (!next) return;
		const play = lineSignalsToPlay(last, next);
		last = next;
		for (const s of play) playAccessibilitySignal(s);
	};
	const soon = () => {
		clearTimeout(timer);
		timer = setTimeout(check, settings.get<boolean>('accessibility.signalOptions.debouncePositionChanges') ? 300 : 0);
	};
	const subs = [
		editor.onDidChangeCursorPosition(soon),
		editor.onDidFocusEditorText(() => ((last = null), soon())),
		monaco.editor.onDidChangeMarkers((uris) => {
			const model = editor.getModel();
			if (model && uris.some((u) => u.toString() === model.uri.toString())) soon();
		})
	];
	return () => {
		clearTimeout(timer);
		subs.forEach((s) => s.dispose());
	};
}

let installedMonaco = false;

/** Call once Monaco is loaded: every editor (created now or later) plays the line signals. */
export function installEditorSignals(monaco: typeof Monaco) {
	if (installedMonaco) return;
	installedMonaco = true;
	monaco.editor.onDidCreateEditor((editor) => {
		const stop = watchEditor(monaco, editor);
		editor.onDidDispose(stop);
	});
}

/** The workbench-level signals and the screen reader commands; returns the cleanup. */
export function installAccessibilitySignals(): () => void {
	const onSave = (_path: string, reason: string) => playAccessibilitySignal('save', { userGesture: reason === 'explicit' });
	saveListeners.add(onSave);
	const unregister = [
		commands.register({
			id: 'editor.action.toggleScreenReaderAccessibilityMode',
			title: 'Toggle Screen Reader Accessibility Mode',
			key: 'shift+alt+f1',
			run: async () => {
				const on = screenReaderMode();
				await settings.set('editor.accessibilitySupport', on ? 'off' : 'on', 'user');
				announce(on ? t('workbench.signals.screenReaderOff') : t('workbench.signals.screenReaderOn'));
			}
		}),
		commands.register({
			id: 'editor.action.announceCursorPosition',
			title: 'Announce Cursor Position',
			run: async () => {
				const { monaco } = await import('#lib/editor/monaco.ts');
				const editor = monaco.editor.getEditors().find((e) => e.hasTextFocus()) ?? monaco.editor.getEditors().find((e) => e.getModel() && getEntry(pathOf(e.getModel()!) ?? '')?.model === e.getModel());
				const pos = editor?.getPosition();
				if (pos) announce(t('workbench.signals.cursorPosition', { line: pos.lineNumber, column: pos.column }));
			}
		})
	];
	return () => {
		saveListeners.delete(onSave);
		unregister.forEach((u) => u());
	};
}
