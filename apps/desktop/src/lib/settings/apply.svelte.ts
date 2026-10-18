// Applies settings live, the way VS Code's editor/terminal/window contributions react to
// configuration changes: Monaco options on every editor and model, xterm options, window zoom,
// auto save, the color theme (and the OS scheme), tree and list options, the file watcher's
// excludes and the close guard. The mappings themselves are pure (mappings.ts).

import { untrack } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import type * as Monaco from 'monaco-editor';
import type { Terminal } from '@xterm/xterm';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { theme } from '#lib/theme/theme.svelte.ts';
import { isDiffKey } from '#lib/workbench/scm.ts';
import { languageOf, openModels, saveFile } from '#lib/workbench/editorModels.ts';
import { editorOptionsFrom, effectiveTheme, enabledGlobs, indentFrom, terminalOptionsFrom, type Indent, type SaveReason } from './mappings';
import { jsonSchema } from './registry';
import { settings } from './settings.svelte';
import { settingSchemas } from './schemas.svelte';

const SETTINGS_SCHEMA_URI = 'kingu://schemas/settings';
const get = <T>(id: string) => settings.get<T>(id);

/** Monaco editor options from settings (VS Code: editor.* configuration). */
export const editorOptions = (): Monaco.editor.IEditorOptions & Monaco.editor.IGlobalEditorOptions => editorOptionsFrom(get);

function applyIndent(model: Monaco.editor.ITextModel, i: Indent) {
	if (model.isDisposed()) return;
	if (i.detect) model.detectIndentation(i.insertSpaces, i.tabSize);
	else model.updateOptions({ tabSize: i.tabSize, insertSpaces: i.insertSpaces });
}

/** The workspace file a model shows (models live at `file:///<tab key>`). */
const pathOf = (model: Monaco.editor.ITextModel) => model.uri.path.slice(1);
const isActiveModel = (model: Monaco.editor.ITextModel) => editors.focusedFile !== null && pathOf(model) === editors.focusedFile;

async function autoSave(paths: string[], reason: SaveReason) {
	for (const path of paths) {
		if (!editors.isDirty(path) || isDiffKey(path)) continue;
		await saveFile(path, reason).catch((e) => status.flash(`บันทึกอัตโนมัติไม่สำเร็จ: ${e}`));
	}
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
		applyIndent(model, untrack(() => indentFrom(get)));
		// files.autoSave afterDelay: each model saves itself once typing pauses (VS Code saves every dirty editor, not just the active one).
		model.onDidChangeContent(() => {
			clearTimeout(timers.get(model));
			if (untrack(() => get('files.autoSave')) !== 'afterDelay') return;
			timers.set(model, setTimeout(() => void autoSave([pathOf(model)], 'afterDelay'), untrack(() => get<number>('files.autoSaveDelay'))));
		});
	});
	monaco.editor.onDidCreateEditor((editor) => {
		// After the constructor has applied its own creation options.
		queueMicrotask(() => editor.updateOptions(untrack(editorOptions)));
		editor.onDidBlurEditorText(() => {
			const model = editor.getModel();
			if (model && untrack(() => get('files.autoSave')) === 'onFocusChange') void autoSave([pathOf(model)], 'focusChange');
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
			const indent = indentFrom(get);
			untrack(() => {
				monaco.editor.getModels().forEach((m) => applyIndent(m, indent));
				const active = monaco.editor.getModels().find(isActiveModel);
				if (active) {
					const o = active.getOptions();
					editors.indent = o.insertSpaces ? `Spaces: ${o.indentSize}` : `Tab Size: ${o.tabSize}`;
				}
			});
		});
		// files.associations: open files switch language at once (their language server follows on reopen).
		$effect(() => {
			void get('files.associations');
			untrack(() => {
				void import('#lib/editor/monaco.ts').then((m) => {
					for (const [path, model] of openModels()) {
						const language = languageOf(m, path);
						if (model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language);
					}
				});
			});
		});
	});
}

/** Keeps an xterm instance on the terminal settings and the theme's terminal colors. */
export function bindTerminalSettings(term: Terminal, refit: () => void): () => void {
	// terminal.integrated.copyOnSelection
	const selection = term.onSelectionChange(() => {
		const text = term.getSelection();
		if (text && untrack(() => get<boolean>('terminal.integrated.copyOnSelection'))) void navigator.clipboard?.writeText(text).catch(() => {});
	});
	const dispose = $effect.root(() => {
		$effect(() => {
			const options = terminalOptionsFrom(get);
			const colors = theme.terminal;
			untrack(() => {
				for (const [k, v] of Object.entries(options)) if (v !== undefined) (term.options as Record<string, unknown>)[k] = v;
				if (colors.background) term.options.theme = colors;
				refit();
			});
		});
	});
	return () => {
		selection.dispose();
		dispose();
	};
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

/** Settings service, theme following, zoom, window-level auto save and the Rust-side settings. Call once from the workbench. */
export function installSettings(): () => void {
	const uninstallSettings = settings.install();
	const onBlur = () => {
		const mode = settings.get('files.autoSave');
		if (mode === 'onFocusChange' && editors.focusedFile) void autoSave([editors.focusedFile], 'focusChange');
		else if (mode === 'onWindowChange') void autoSave(editors.dirtyPaths(), 'windowChange');
	};
	window.addEventListener('blur', onBlur);

	// window.autoDetectColorScheme follows the OS while Kingu runs.
	const scheme = window.matchMedia?.('(prefers-color-scheme: dark)');
	let prefersDark = $state(scheme?.matches ?? true);
	const onScheme = (e: MediaQueryListEvent) => (prefersDark = e.matches);
	scheme?.addEventListener('change', onScheme);

	const disposeEffects = $effect.root(() => {
		$effect(() => {
			const id = effectiveTheme(get, prefersDark);
			// Wait for the files so the default theme does not flash before the user's.
			if (settings.loaded) untrack(() => void theme.apply(id));
		});
		$effect(() => {
			const level = settings.get<number>('window.zoomLevel');
			untrack(() => void setZoom(level));
		});
		// workbench.tree.indent / workbench.list.smoothScrolling: CSS the trees and lists read.
		$effect(() => {
			const root = document.documentElement.style;
			root.setProperty('--kg-tree-indent', `${settings.get<number>('workbench.tree.indent')}px`);
			root.setProperty('--kg-list-scroll-behavior', settings.get<boolean>('workbench.list.smoothScrolling') ? 'smooth' : 'auto');
		});
		// files.watcherExclude: Rust drops matching events before they reach the workbench.
		$effect(() => {
			const globs = enabledGlobs(settings.get('files.watcherExclude'));
			if (settings.loaded) untrack(() => void invoke('watcher_set_exclude', { globs }).catch(() => {}));
		});
	});
	return () => {
		uninstallSettings();
		window.removeEventListener('blur', onBlur);
		scheme?.removeEventListener('change', onScheme);
		disposeEffects();
	};
}
