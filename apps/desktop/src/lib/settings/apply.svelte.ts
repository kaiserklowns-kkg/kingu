// Applies settings live, the way VS Code's editor/terminal/window contributions react to
// configuration changes: Monaco options on every editor and model, xterm options, window zoom,
// auto save, the color theme (and the OS scheme), tree and list options, the file watcher's
// excludes and the close guard. The mappings themselves are pure (mappings.ts).

import { untrack } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import type * as Monaco from 'monaco-editor';
import type { Terminal } from '@xterm/xterm';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { theme } from '#lib/theme/theme.svelte.ts';
import { activeTheme } from '#lib/theme/current.ts';
import { isDiffKey } from '#lib/workbench/scm.ts';
import { getEntry, openModels, refreshLanguages, saveFile } from '#lib/workbench/editorModels.ts';
import { isWorkspaceTextFile } from './resources';
import { isUntitled } from '#lib/workbench/untitled.ts';
import { indentLabel } from '#lib/workbench/textFiles.ts';
import { keybindings } from '#lib/workbench/keybindings.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { autoSaves, editorConfigurationFrom, editorOptionsFrom, effectiveTheme, enabledGlobs, indentFrom, modelOptionsFrom, terminalOptionsFrom, type Indent, type SaveReason } from './mappings';
import { setMaxTokenizationLineLength } from '#lib/editor/tokenizationLimit.ts';
import { runFocusChangeCodeActions } from '#lib/workbench/textFileSave.ts';
import { jsonSchema } from './registry';
import { settings } from './settings.svelte';
import { settingSchemas } from './schemas.svelte';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { installUiLanguage } from '#lib/i18n/locale.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { LAUNCH_FILE_MATCH, LAUNCH_SCHEMA_URI, launchSchema } from '#lib/debug/launchSchema.ts';

const SETTINGS_SCHEMA_URI = 'kingu://schemas/settings';
const KEYBINDINGS_SCHEMA_URI = 'kingu://schemas/keybindings';
const get = <T>(id: string) => settings.get<T>(id);

/** Monaco editor options from settings (VS Code: editor.* configuration). */
export const editorOptions = (): Monaco.editor.IEditorOptions & Monaco.editor.IGlobalEditorOptions => {
	const options = editorOptionsFrom(get, themeSemantic());
	// Zen Mode with zenMode.hideLineNumbers turns line numbers off; leaving it restores editor.lineNumbers.
	return layout.zenParts?.lineNumbersOff ? { ...options, lineNumbers: 'off' } : options;
};

/** The color theme's `semanticHighlighting` (for `editor.semanticHighlighting.enabled: configuredByTheme`); reading `theme.current` re-runs effects on a theme change. */
function themeSemantic(): boolean {
	void theme.current;
	return activeTheme()?.flat.semanticHighlighting ?? false;
}

function applyIndent(model: Monaco.editor.ITextModel, i: Indent) {
	if (model.isDisposed()) return;
	if (i.detect) {
		model.detectIndentation(i.insertSpaces, i.tabSize);
		model.updateOptions({ trimAutoWhitespace: i.trimAutoWhitespace });
	} else model.updateOptions(modelOptionsFrom(i));
}

/** The tab key a model shows (a workspace file, or the user settings.json / keybindings.json). */
const pathOf = (model: Monaco.editor.ITextModel) => openModels().find(([, m]) => m === model)?.[0] ?? model.uri.path.slice(1);
const isActiveModel = (model: Monaco.editor.ITextModel) => editors.focusedFile !== null && pathOf(model) === editors.focusedFile;

let monacoApi: typeof Monaco | undefined;

/** Error markers on the open model of `path` (files.autoSaveWhenNoErrors). */
function hasErrors(path: string): boolean {
	const model = getEntry(path)?.model;
	if (!monacoApi || !model || model.isDisposed()) return false;
	return monacoApi.editor.getModelMarkers({ resource: model.uri }).some((m) => m.severity === monacoApi!.MarkerSeverity.Error);
}

async function autoSave(paths: string[], reason: SaveReason) {
	for (const path of paths) {
		if (!path || !editors.isDirty(path) || isDiffKey(path)) continue;
		// files.autoSaveWorkspaceFilesOnly / files.autoSaveWhenNoErrors
		if (!autoSaves(get, { inWorkspace: isWorkspaceTextFile(path) && !isUntitled(path), hasErrors: hasErrors(path) })) continue;
		await saveFile(path, reason).catch((e) => notifications.error(t('settings.apply.autoSaveFailed', { error: String(e) })));
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
	monacoApi = monaco;

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
		// Monaco's configuration service: what its contributions read instead of editor options.
		$effect(() => {
			const values = editorConfigurationFrom(get, themeSemantic());
			// Loaded with Monaco (this runs once Monaco is in), so the workbench start does not pull it in.
			untrack(() => void import('#lib/editor/monacoConfiguration.ts').then(({ updateMonacoConfiguration }) => updateMonacoConfiguration(values)));
		});
		// files.restoreUndoStack: Monaco's model service reads it when a closed file's model is
		// disposed (keep its undo stack for when the file opens again, as VS Code's does).
		$effect(() => {
			const restore = get<boolean>('files.restoreUndoStack');
			untrack(() => void import('#lib/editor/monacoConfiguration.ts').then(({ updateMonacoConfiguration }) => updateMonacoConfiguration([['files.restoreUndoStack', restore]])));
		});
		// Kingu's TextMate tokenizer skips long lines like Monaco's Monarch one.
		$effect(() => setMaxTokenizationLineLength(get<number>('editor.maxTokenizationLineLength')));
		// editor.codeActions.triggerOnFocusChange: the newly active editor's model.
		$effect(() => {
			const path = editors.focusedFile;
			untrack(() => void runFocusChangeCodeActions(openModels().find(([p]) => p === path)?.[1]));
		});
		// settings.json is JSONC; give it completion and validation from the schema registry
		// (contributed Snap settings included, so it follows them).
		$effect(() => {
			const schema = jsonSchema(settingSchemas.all);
			const ids = commands.all.map((c) => c.id).sort();
			// keybindings.json: completion of command ids (and their removal form `-id`).
			const keys = {
				type: 'array',
				items: {
					type: 'object',
					required: ['key', 'command'],
					properties: {
						key: { type: 'string', description: 'คีย์ เช่น cmd+shift+p หรือ cmd+k cmd+t (The key or key sequence.)' },
						command: { type: 'string', enum: [...ids, ...ids.map((id) => `-${id}`)] },
						when: { type: 'string', description: 'ยังไม่ประเมินใน Kingu (Not evaluated yet.)' },
						args: { description: 'อาร์กิวเมนต์ที่ส่งให้คำสั่ง เช่น { "snippet": "console.log($1)" } ของ editor.action.insertSnippet (Arguments passed to the command.)' }
					}
				}
			};
			untrack(() => {
				const opts = monaco.json.jsonDefaults.diagnosticsOptions;
				const ours = new Set([SETTINGS_SCHEMA_URI, KEYBINDINGS_SCHEMA_URI, LAUNCH_SCHEMA_URI]);
				monaco.json.jsonDefaults.setDiagnosticsOptions({
					...opts,
					validate: true,
					allowComments: true,
					trailingCommas: 'ignore',
					schemas: [
						...(opts.schemas ?? []).filter((s) => !ours.has(s.uri)),
						{ uri: SETTINGS_SCHEMA_URI, fileMatch: ['**/settings.json'], schema },
						{ uri: KEYBINDINGS_SCHEMA_URI, fileMatch: ['**/keybindings.json'], schema: keys },
						// launch.json: configuration attributes and Add Configuration's snippets (VS Code: launchSchema).
						{ uri: LAUNCH_SCHEMA_URI, fileMatch: LAUNCH_FILE_MATCH, schema: launchSchema() }
					]
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
					editors.indent = indentLabel(o);
				}
			});
		});
		// files.associations: open files switch language at once (their language server follows on reopen).
		$effect(() => {
			void get('files.associations');
			untrack(() => {
				void import('#lib/editor/monaco.ts').then(refreshLanguages);
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
			const fontRendering = get<string>('terminal.integrated.fontRendering');
			untrack(() => {
				for (const [k, v] of Object.entries(options)) if (v !== undefined) (term.options as Record<string, unknown>)[k] = v;
				if (colors.background) term.options.theme = colors;
				// terminal.integrated.fontRendering: grayscale antialiasing on macOS (`inherit` follows the workbench).
				term.element?.style.setProperty('-webkit-font-smoothing', fontRendering === 'grayscale' && isMacUA() ? 'antialiased' : '');
				refit();
			});
		});
	});
	return () => {
		selection.dispose();
		dispose();
	};
}

const isMacUA = () => typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');

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
/** routes/layout.css's interface font stack, kept behind a kingu.ui.fontFamily choice. */
const UI_FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', 'IBM Plex Sans Thai', 'Thonburi', sans-serif";

export function installSettings(): () => void {
	const uninstallSettings = settings.install();
	const uninstallKeybindings = keybindings.install();
	// kingu.uiLanguage: the language t() answers in, live.
	const uninstallUiLanguage = installUiLanguage();
	const onBlur = () => {
		const mode = settings.get('files.autoSave');
		if (mode === 'onFocusChange' && editors.focusedFile) void autoSave([editors.focusedFile], 'focusChange');
		else if (mode === 'onWindowChange') void autoSave(editors.dirtyPaths(), 'windowChange');
		// editor.codeActions.triggerOnFocusChange: the window lost focus.
		void runFocusChangeCodeActions(openModels().find(([p]) => p === editors.focusedFile)?.[1]);
	};
	window.addEventListener('blur', onBlur);

	// window.autoDetectColorScheme follows the OS while Kingu runs.
	const scheme = window.matchMedia?.('(prefers-color-scheme: dark)');
	let prefersDark = $state(scheme?.matches ?? true);
	const onScheme = (e: MediaQueryListEvent) => (prefersDark = e.matches);
	scheme?.addEventListener('change', onScheme);
	// window.autoDetectHighContrast: macOS "Increase contrast" (prefers-contrast: more) or forced colors.
	const contrast = window.matchMedia?.('(prefers-contrast: more), (forced-colors: active)');
	let highContrast = $state(contrast?.matches ?? false);
	const onContrast = (e: MediaQueryListEvent) => (highContrast = e.matches);
	contrast?.addEventListener('change', onContrast);

	const disposeEffects = $effect.root(() => {
		$effect(() => {
			const id = effectiveTheme(get, prefersDark, highContrast);
			// Wait for the files so the default theme does not flash before the user's.
			if (settings.loaded) untrack(() => void theme.apply(id));
		});
		// workbench.colorCustomizations: colors over the applied theme (chrome, editor and terminal).
		$effect(() => {
			const custom = settings.get('workbench.colorCustomizations');
			untrack(() => theme.setCustomizations(custom));
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
		// kingu.ui.fontFamily (Orca's appFontFamily): the interface font, ahead of the default stack.
		$effect(() => {
			const font = (settings.get<string>('kingu.ui.fontFamily') ?? '').trim();
			document.body.style.fontFamily = font ? `${font}, ${UI_FONT_STACK}` : '';
		});
		// files.watcherExclude: Rust drops matching events before they reach the workbench.
		$effect(() => {
			const globs = enabledGlobs(settings.get('files.watcherExclude'));
			if (settings.loaded) untrack(() => void invoke('watcher_set_exclude', { globs }).catch(() => {}));
		});
		// files.watcherInclude: extra (symlinked) folders the watcher also watches.
		$effect(() => {
			const paths = [...settings.get<string[]>('files.watcherInclude')];
			if (settings.loaded) untrack(() => void invoke('watcher_set_include', { paths }).catch(() => {}));
		});
	});
	return () => {
		uninstallSettings();
		uninstallKeybindings();
		uninstallUiLanguage();
		window.removeEventListener('blur', onBlur);
		scheme?.removeEventListener('change', onScheme);
		contrast?.removeEventListener('change', onContrast);
		disposeEffects();
	};
}
