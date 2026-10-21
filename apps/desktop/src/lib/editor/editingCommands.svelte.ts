// The editor toggles of VS Code's workbench (contrib/codeEditor: toggleWordWrap, toggleColumnSelection,
// toggleMinimap, toggleRenderWhitespace, toggleRenderControlCharacter, toggleMultiCursorModifier,
// toggleOvertype, and Sticky Scroll's toggle). Monaco's own editor actions (copy/move lines,
// multi-cursor, transform case, sort, join, expand selection, Go to Bracket…) are in the registry
// already (workbench/editorActions.svelte.ts); these are the ones the standalone editor lacks.

import type * as Monaco from 'monaco-editor';
import { SvelteMap } from 'svelte/reactivity';
import { getEntry } from '#lib/workbench/editorModels.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import type { SettingScope } from '#lib/settings/registry.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { activeCodeEditor, monacoApi } from './activeEditor.ts';
import { nextWordWrapOverride, type WordWrapOverride } from './editingToggles.ts';

/** Overtype mode (VS Code's InputMode, one for the whole window): the status bar shows OVR. */
class EditorModes {
	overtype = $state(false);
}
export const editorModes = new EditorModes();

type InputModeImpl = { _inputMode: 'insert' | 'overtype'; _onDidChangeInputMode: { fire(mode: string): void } };

/** Monaco 0.57's InputMode has no setter in its build; the field and the event are what VS Code's
 * setInputMode sets. Loaded on use, so the workbench start does not pull Monaco in. */
async function setInputMode(mode: 'insert' | 'overtype') {
	const { InputMode } = await import('monaco-editor/editor/common/inputMode.js');
	const impl = InputMode as unknown as InputModeImpl;
	if (impl._inputMode === mode) return;
	impl._inputMode = mode;
	impl._onDidChangeInputMode.fire(mode);
	editorModes.overtype = mode === 'overtype';
}

/** The scope a toggle writes: where the setting is set now (VS Code's updateValue picks the
 * target that defines the key), else the user settings. */
function toggleScope(id: string): SettingScope {
	const source = settings.sourceOf(id);
	return source === 'default' ? 'user' : source;
}

function writeSetting(id: string, value: unknown) {
	return settings.set(id, value, toggleScope(id)).catch((e) => notifications.error(t('editing.toggle.failed', { setting: id, error: String(e) })));
}

/** View: Toggle Word Wrap per file (VS Code's transient wordWrapOverride1), shared by every editor of the file. */
const wordWrapByModel = new SvelteMap<string, WordWrapOverride>();

/** Whether the active file wraps (the View menu's Word Wrap check mark). */
export function wordWrapChecked(): boolean {
	const path = editors.focusedFile;
	const model = path ? getEntry(path)?.model : undefined;
	const override = model ? wordWrapByModel.get(model.uri.toString()) : undefined;
	return override && override !== 'inherit' ? override === 'on' : settings.get<string>('editor.wordWrap') !== 'off';
}

function toggleWordWrap() {
	const api = monacoApi();
	const editor = activeCodeEditor();
	const model = editor?.getModel();
	if (!api || !editor || !model) return;
	const key = model.uri.toString();
	const wrapping = editor.getOption(api.editor.EditorOption.wrappingInfo).isViewportWrapping;
	const next = nextWordWrapOverride(wordWrapByModel.get(key) ?? 'inherit', settings.get<string>('editor.wordWrap'), wrapping);
	wordWrapByModel.set(key, next);
	for (const e of api.editor.getEditors()) if (e.getModel() === model) e.updateOptions({ wordWrapOverride1: next });
}

/** Per editor: the file's word wrap toggle follows it into every editor that shows it. */
export function attachEditingModes(editor: Monaco.editor.ICodeEditor) {
	const apply = () => {
		const model = editor.getModel();
		editor.updateOptions({ wordWrapOverride1: (model && wordWrapByModel.get(model.uri.toString())) || 'inherit' });
	};
	editor.onDidChangeModel(apply);
	apply();
}

/** The toggle commands; returns the unregister function. */
export function installEditingCommands(): () => void {
	const hasEditor = () => editors.active !== null;
	const flip = (id: string) => () => writeSetting(id, !settings.get<boolean>(id));
	const unregister = [
		commands.register({ id: 'editor.action.toggleWordWrap', title: 'Toggle Word Wrap', category: 'View', key: 'alt+z', when: hasEditor, run: toggleWordWrap }),
		commands.register({
			id: 'editor.action.toggleColumnSelection',
			title: 'Toggle Column Selection Mode',
			run: async () => {
				const on = !settings.get<boolean>('editor.columnSelection');
				// Leaving a column selection keeps only the primary cursor's selection (VS Code collapses it).
				const editor = activeCodeEditor();
				const sel = editor?.getSelection();
				await writeSetting('editor.columnSelection', on);
				if (!on && editor && sel) editor.setSelection(sel);
			}
		}),
		commands.register({ id: 'editor.action.toggleMinimap', title: 'Toggle Minimap', category: 'View', run: flip('editor.minimap.enabled') }),
		commands.register({ id: 'editor.action.toggleRenderWhitespace', title: 'Toggle Render Whitespace', category: 'View', run: () => writeSetting('editor.renderWhitespace', settings.get<string>('editor.renderWhitespace') === 'none' ? 'all' : 'none') }),
		commands.register({ id: 'editor.action.toggleRenderControlCharacter', title: 'Toggle Control Characters', category: 'View', run: flip('editor.renderControlCharacters') }),
		commands.register({ id: 'editor.action.toggleStickyScroll', title: 'Toggle Editor Sticky Scroll', category: 'View', run: flip('editor.stickyScroll.enabled') }),
		commands.register({
			id: 'workbench.action.toggleMultiCursorModifier',
			title: 'Toggle Multi-Cursor Modifier',
			run: () => writeSetting('editor.multiCursorModifier', settings.get<string>('editor.multiCursorModifier') === 'ctrlCmd' ? 'alt' : 'ctrlCmd')
		}),
		commands.register({
			id: 'editor.action.toggleOvertypeInsertMode',
			title: 'Toggle Overtype/Insert Mode',
			category: 'View',
			key: 'insert',
			mac: 'alt+cmd+o',
			run: () => setInputMode(editorModes.overtype ? 'insert' : 'overtype')
		})
	];
	return () => unregister.forEach((u) => u());
}
