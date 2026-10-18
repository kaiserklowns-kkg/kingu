<script lang="ts">
	// One Monaco editor per editor group (VS Code: the group's TextEditor pane). Text models are
	// shared between groups (editorModels.ts), so switching tabs preserves undo history and two
	// groups showing one file edit the same model. Save and LSP commands live in EditorPart.
	// Editor settings reach every group's editor through installEditorSettings' Monaco hooks.
	import { onMount, untrack } from 'svelte';
	import type * as Monaco from 'monaco-editor';
	import { clientLog } from '#lib/client-log.ts';
	import { editors } from './editors.svelte';
	import { getEntry, modelEntry, saveViewState, viewState } from './editorModels';
	import { isReadonly } from './readonly';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { workspace } from './workspace.svelte';
	import { navigation } from './navigation.svelte';
	import { isDiffKey } from './scm';
	import { isNonTextEditor } from '#lib/settings/resources.ts';
	import { editorOptions, installEditorSettings } from '#lib/settings/apply.svelte.ts';
	import { attachDebugEditor, type DebugDecorations } from '#lib/debug/editorDebug.ts';
	import { indentLabel } from './textFiles';
	import { textFiles } from './textFileService.svelte';
	import { installEditorActions } from './editorActions.svelte';

	let { group }: { group: number } = $props();

	let host: HTMLDivElement;
	let api: typeof import('#lib/editor/monaco.ts') | undefined;
	let editor = $state<Monaco.editor.IStandaloneCodeEditor | undefined>();
	/** The path whose model is set on the editor (reactive, for the status bar effect). */
	let shown = $state<string | null>(null);
	/** True while a model is being switched in: its cursor moves are not navigation. */
	let switching = false;
	/** Breakpoint glyphs and the stopped line for the shown file. */
	let debugDecorations = $state<DebugDecorations | undefined>();

	const path = $derived(editors.group(group)?.active ?? null);
	const isActiveGroup = $derived(editors.activeGroupId === group);

	onMount(() => {
		let disposed = false;
		import('#lib/editor/monaco.ts').then(async (m) => {
			await m.setupTextMate();
			if (disposed) return;
			api = m;
			installEditorSettings(m.monaco);
			// The editor settings from the first paint; installEditorSettings keeps them live.
			const ed = m.monaco.editor.create(host, { ...editorOptions(), theme: m.THEME_ID, automaticLayout: true });
			installEditorActions(m.monaco, ed);
			const { CursorChangeReason } = m.monaco.editor;
			ed.onDidChangeCursorPosition((e) => {
				if (editors.activeGroupId !== group) return;
				editors.cursor = { line: e.position.lineNumber, column: e.position.column };
				// Go Back/Forward history: clicks, keys and reveals, not edits (paste, undo) or model loads.
				if (!switching && shown && (e.reason === CursorChangeReason.Explicit || e.reason === CursorChangeReason.NotSet))
					navigation.record({ path: shown, line: e.position.lineNumber, column: e.position.column, group });
			});
			ed.onDidFocusEditorText(() => editors.activateGroup(group));
			debugDecorations = attachDebugEditor(m.monaco, ed, () => shown);
			editor = ed;
			clientLog('info', `editor ready (group ${group})`);
		});

		const unregister = editors.registerHost(group, {
			gotoLine: (line, column = 1) => {
				if (!editor) return;
				editor.revealLineInCenter(line);
				editor.setPosition({ lineNumber: line, column });
				editor.focus();
			},
			selectionText: (nearestWord) => {
				const model = editor?.getModel();
				const sel = editor?.getSelection();
				if (!model || !sel) return '';
				if (!sel.isEmpty()) return model.getValueInRange(sel);
				return nearestWord ? (model.getWordAtPosition(sel.getPosition())?.word ?? '') : '';
			},
			focus: () => editor?.focus(),
			peek: (line, column) => {
				if (!editor) return;
				const range = { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column };
				editor.revealRangeInCenter(range);
				editor.setSelection(range);
			},
			trigger: (actionId) => {
				if (!editor?.getModel()) return false;
				editor.focus();
				editor.trigger('menu', actionId, null);
				return true;
			}
		});

		return () => {
			disposed = true;
			unregister();
			debugDecorations?.dispose();
			if (editor && shown) saveViewState(group, shown, editor.saveViewState());
			// Models are shared and outlive this editor; only detach.
			editor?.setModel(null);
			editor?.dispose();
		};
	});

	/** Applies `editors.pendingReveal` when it targets this group and its file is shown (selects the range, like VS Code's search). */
	function applyReveal() {
		const r = editors.pendingReveal;
		if (!editor || !r || r.group !== group || r.path !== shown) return;
		editors.pendingReveal = null;
		const range = { startLineNumber: r.line, startColumn: r.column, endLineNumber: r.line, endColumn: r.endColumn ?? r.column };
		editor.setSelection(range);
		editor.revealRangeInCenterIfOutsideViewport(range);
		if (r.focus) editor.focus();
	}

	// A reveal for the file already shown; otherwise the model-switch effect applies it after loading.
	$effect(() => {
		if (editors.pendingReveal && editor && shown) applyReveal();
	});

	// Focus requested by a group command (split, focus group, move editor).
	$effect(() => {
		if (editors.focusRequest === group && editor && shown) {
			editors.focusRequest = null;
			editor.focus();
		}
	});

	// files.readonlyInclude / files.readonlyExclude / files.readonlyFromPermissions: the shown file is
	// read-only when they say so (Monaco then refuses edits with its read-only message).
	$effect(() => {
		const file = shown;
		if (!editor || !file) return;
		const readOnly = isReadonly(
			file,
			`${workspace.root ?? ''}/${file}`,
			{
				include: settings.get('files.readonlyInclude'),
				exclude: settings.get('files.readonlyExclude'),
				fromPermissions: settings.get<boolean>('files.readonlyFromPermissions')
			},
			getEntry(file)?.stat?.readonly ?? false
		);
		editor.updateOptions({ readOnly });
	});

	// Breakpoints and the stopped line follow the breakpoint store, the session and the shown file.
	$effect(() => {
		void shown;
		debugDecorations?.render();
	});

	// The status bar follows the active group's editor.
	$effect(() => {
		if (!isActiveGroup || !editor || !shown) return;
		const model = editor.getModel();
		if (!model) return;
		const update = () => {
			editors.language = model.getLanguageId();
			editors.indent = indentLabel(model.getOptions());
			editors.eol = model.getEOL() === '\n' ? 'LF' : 'CRLF';
		};
		update();
		// Change Language Mode, indentation and EOL changes (also by undo) show at once.
		const subs = [model.onDidChangeLanguage(update), model.onDidChangeOptions(update), model.onDidChangeContent((e) => e.isEolChange && update())];
		const pos = editor.getPosition();
		if (pos) {
			editors.cursor = { line: pos.lineNumber, column: pos.column };
			// A file switch (or a group becoming active) is a navigation entry, at the restored or revealed position.
			const file = shown;
			untrack(() => navigation.record({ path: file, line: pos.lineNumber, column: pos.column, group }));
		}
		return () => subs.forEach((d) => d.dispose());
	});

	// Show the group's active tab's model, restoring its scroll and cursor.
	$effect(() => {
		const p = path;
		const ed = editor;
		if (!ed) return;
		untrack(() => {
			if (shown) saveViewState(group, shown, ed.saveViewState());
		});
		// Diff tabs are shown by DiffHost; binary, large and unreadable files by a placeholder.
		if (!p || isDiffKey(p) || isNonTextEditor(p) || !api || textFiles.placeholder(p)) {
			ed.setModel(null);
			shown = null;
			return;
		}
		modelEntry(api, p)
			.then((entry) => {
				if (editors.group(group)?.active !== p || editor !== ed || entry.model.isDisposed()) return;
				switching = true;
				try {
					ed.setModel(entry.model);
					const view = viewState(group, p);
					if (view) ed.restoreViewState(view);
					shown = p;
					applyReveal();
				} finally {
					switching = false;
				}
				clientLog('info', `opened ${p} in group ${group} as ${entry.model.getLanguageId()} (${entry.model.getLineCount()} lines)`);
			})
			.catch((e) => {
				clientLog('error', `open ${p}: ${e}`);
				// VS Code keeps the tab and shows why (binary, too large, an error) with "Open Anyway".
				textFiles.openFailed(p, e);
			});
	});
</script>

<div bind:this={host} class="h-full w-full"></div>

<style>
	/* Breakpoint glyphs (VS Code debug.contribution.css); theme colors when the theme defines them. */
	:global(.kg-bp),
	:global(.kg-debug-arrow) {
		display: flex;
		align-items: center;
		justify-content: center;
	}
	:global(.kg-bp)::before {
		content: '';
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--vscode-debugIcon-breakpointForeground, #e51400);
	}
	:global(.kg-bp-unverified)::before {
		background: transparent;
		border: 1.5px solid var(--vscode-debugIcon-breakpointUnverifiedForeground, #848484);
	}
	:global(.kg-bp-disabled)::before {
		background: var(--vscode-debugIcon-breakpointDisabledForeground, #848484);
	}
	:global(.kg-bp-conditional)::before {
		box-shadow: inset 0 0 0 2.5px var(--vscode-debugIcon-breakpointForeground, #e51400), inset 0 0 0 10px var(--vscode-editor-background, #1e1e1e);
	}
	:global(.kg-bp-log)::before {
		width: 8px;
		height: 8px;
		border-radius: 1px;
		transform: rotate(45deg);
		background: var(--vscode-debugIcon-breakpointForeground, #e51400);
	}
	:global(.kg-bp-triggered)::before {
		background: transparent;
		border: 1.5px dashed var(--vscode-debugIcon-breakpointForeground, #e51400);
	}
	/* debug.inlineValues */
	:global(.kg-debug-inline-value) {
		color: var(--vscode-editor-inlineValuesForeground, rgba(255, 255, 255, 0.5));
		background: var(--vscode-editor-inlineValuesBackground, rgba(255, 200, 0, 0.2));
		margin-left: 8px;
		padding: 0 4px;
	}
	:global(.kg-debug-arrow)::after {
		content: '';
		width: 0;
		height: 0;
		border-top: 5px solid transparent;
		border-bottom: 5px solid transparent;
		border-left: 8px solid var(--vscode-debugIcon-breakpointCurrentStackframeForeground, #ffcc00);
	}
	:global(.kg-debug-arrow-focused)::after {
		border-left-color: var(--vscode-debugIcon-breakpointStackframeForeground, #89d185);
	}
	:global(.kg-debug-line) {
		background: var(--vscode-editor-stackFrameHighlightBackground, rgba(255, 255, 0, 0.2));
	}
	:global(.kg-debug-line-focused) {
		background: var(--vscode-editor-focusedStackFrameHighlightBackground, rgba(122, 189, 122, 0.3));
	}
</style>
