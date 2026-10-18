// Applies settings live, the way VS Code's editor/terminal/window contributions react to
// configuration changes: Monaco options on every editor and model, xterm options, window zoom,
// files.autoSave, and the color theme. Hooks are small so the editor/terminal hosts stay as they are.

import { untrack } from 'svelte';
import type * as Monaco from 'monaco-editor';
import type { Terminal } from '@xterm/xterm';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { theme } from '#lib/theme/theme.svelte.ts';
import { jsonSchema } from './registry';
import { settings } from './settings.svelte';
import { settingSchemas } from './schemas.svelte';

const SETTINGS_SCHEMA_URI = 'kingu://schemas/settings';

/** Monaco editor options from settings (VS Code: editor.* configuration). */
export function editorOptions(): Monaco.editor.IEditorOptions {
	return {
		fontSize: settings.get<number>('editor.fontSize'),
		fontFamily: settings.get<string>('editor.fontFamily'),
		wordWrap: settings.get<'off' | 'on' | 'wordWrapColumn' | 'bounded'>('editor.wordWrap'),
		minimap: { enabled: settings.get<boolean>('editor.minimap.enabled') },
		stickyScroll: { enabled: settings.get<boolean>('editor.stickyScroll.enabled') },
		renderWhitespace: settings.get<'none' | 'boundary' | 'selection' | 'trailing' | 'all'>('editor.renderWhitespace')
	};
}

type Indent = { tabSize: number; insertSpaces: boolean; detect: boolean };

function indentSettings(): Indent {
	return {
		tabSize: settings.get<number>('editor.tabSize'),
		insertSpaces: settings.get<boolean>('editor.insertSpaces'),
		detect: settings.get<boolean>('editor.detectIndentation')
	};
}

function applyIndent(model: Monaco.editor.ITextModel, i: Indent) {
	if (model.isDisposed()) return;
	if (i.detect) model.detectIndentation(i.insertSpaces, i.tabSize);
	else model.updateOptions({ tabSize: i.tabSize, insertSpaces: i.insertSpaces });
}

/** The model shown for the focused file, an IDE tab or the Agents layout's (models live at `file:///<tab key>`). */
const isActiveModel = (model: Monaco.editor.ITextModel) => editors.focusedFile !== null && model.uri.path === '/' + editors.focusedFile;

function saveActive(model?: Monaco.editor.ITextModel) {
	const path = editors.focusedFile;
	if (!path || !editors.isDirty(path) || (model && !isActiveModel(model))) return;
	void Promise.resolve(commands.run('workbench.action.files.save')).catch((e) => status.error(`บันทึกอัตโนมัติไม่สำเร็จ: ${e}`));
}

let monacoInstalled = false;

/**
 * Call once Monaco is loaded (idempotent). Every editor and model, including ones created later
 * (diff editors too), follows the editor settings.
 */
export function installEditorSettings(monaco: typeof Monaco) {
	if (monacoInstalled) return;
	monacoInstalled = true;

	const timers = new WeakMap<Monaco.editor.ITextModel, ReturnType<typeof setTimeout>>();
	monaco.editor.onDidCreateModel((model) => {
		applyIndent(model, untrack(indentSettings));
		model.onDidChangeContent(() => {
			if (untrack(() => settings.get('files.autoSave')) !== 'afterDelay') return;
			clearTimeout(timers.get(model));
			timers.set(model, setTimeout(() => saveActive(model), untrack(() => settings.get<number>('files.autoSaveDelay'))));
		});
	});
	monaco.editor.onDidCreateEditor((editor) => {
		// After the constructor has applied its own creation options.
		queueMicrotask(() => editor.updateOptions(untrack(editorOptions)));
		editor.onDidBlurEditorText(() => {
			if (untrack(() => settings.get('files.autoSave')) === 'onFocusChange') saveActive(editor.getModel() ?? undefined);
		});
	});

	$effect.root(() => {
		// settings.json is JSONC; give it completion and validation from the schema registry
		// (contributed Snap settings included, so it follows them).
		$effect(() => {
			const schema = jsonSchema(settingSchemas.all);
			untrack(() => {
				const opts = monaco.json.jsonDefaults.diagnosticsOptions;
				monaco.json.jsonDefaults.setDiagnosticsOptions({
					...opts,
					validate: true,
					allowComments: true,
					trailingCommas: 'ignore',
					schemas: [...(opts.schemas ?? []).filter((s) => s.uri !== SETTINGS_SCHEMA_URI), { uri: SETTINGS_SCHEMA_URI, fileMatch: ['**/settings.json'], schema }]
				});
			});
		});
		$effect(() => {
			const options = editorOptions();
			untrack(() => monaco.editor.getEditors().forEach((e) => e.updateOptions(options)));
		});
		$effect(() => {
			const indent = indentSettings();
			untrack(() => {
				monaco.editor.getModels().forEach((m) => applyIndent(m, indent));
				const active = monaco.editor.getModels().find(isActiveModel);
				if (active) {
					const o = active.getOptions();
					editors.indent = o.insertSpaces ? `Spaces: ${o.indentSize}` : `Tab Size: ${o.tabSize}`;
				}
			});
		});
	});
}

/** Keeps an xterm instance on the terminal settings and the theme's terminal colors. */
export function bindTerminalSettings(term: Terminal, refit: () => void): () => void {
	return $effect.root(() => {
		$effect(() => {
			const fontSize = settings.get<number>('terminal.integrated.fontSize');
			const fontFamily = settings.get<string>('terminal.integrated.fontFamily') || settings.get<string>('editor.fontFamily');
			const colors = theme.terminal;
			untrack(() => {
				term.options.fontSize = fontSize;
				term.options.fontFamily = fontFamily;
				if (colors.background) term.options.theme = colors;
				refit();
			});
		});
	});
}

/** `window.zoomLevel`: each level is 20%, like Electron's zoom in VS Code. */
export const zoomFactor = (level: number) => Math.pow(1.2, level);

async function setZoom(level: number) {
	try {
		const { getCurrentWebview } = await import('@tauri-apps/api/webview');
		await getCurrentWebview().setZoom(zoomFactor(level));
	} catch {
		// Outside Tauri (vite preview): CSS zoom is close enough.
		document.documentElement.style.setProperty('zoom', String(zoomFactor(level)));
	}
}

/** Settings service, theme following, zoom, and window-level auto save. Call once from the workbench. */
export function installSettings(): () => void {
	const uninstallSettings = settings.install();
	const onBlur = () => {
		if (settings.get('files.autoSave') === 'onFocusChange') saveActive();
	};
	window.addEventListener('blur', onBlur);
	const disposeEffects = $effect.root(() => {
		$effect(() => {
			const id = settings.get('workbench.colorTheme');
			// Wait for the files so the default theme does not flash before the user's.
			if (settings.loaded) untrack(() => void theme.apply(id));
		});
		$effect(() => {
			const level = settings.get<number>('window.zoomLevel');
			untrack(() => void setZoom(level));
		});
	});
	return () => {
		uninstallSettings();
		window.removeEventListener('blur', onBlur);
		disposeEffects();
	};
}
