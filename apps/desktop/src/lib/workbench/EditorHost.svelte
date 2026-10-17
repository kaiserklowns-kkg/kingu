<script lang="ts">
	// One Monaco editor per editor group (VS Code: the group's TextEditor pane). Text models are
	// shared between groups (editorModels.ts), so switching tabs preserves undo history and two
	// groups showing one file edit the same model. Save and LSP commands live in EditorPart.
	// Editor settings reach every group's editor through installEditorSettings' Monaco hooks.
	import { onMount, untrack } from 'svelte';
	import type * as Monaco from 'monaco-editor';
	import { clientLog } from '#lib/client-log.ts';
	import { editors } from './editors.svelte';
	import { modelEntry, saveViewState, viewState } from './editorModels';
	import { navigation } from './navigation.svelte';
	import { isDiffKey } from './scm';
	import { isNonTextEditor } from '#lib/settings/resources.ts';
	import { installEditorSettings } from '#lib/settings/apply.svelte.ts';

	let { group }: { group: number } = $props();

	let host: HTMLDivElement;
	let api: typeof import('#lib/editor/monaco.ts') | undefined;
	let editor = $state<Monaco.editor.IStandaloneCodeEditor | undefined>();
	/** The path whose model is set on the editor (reactive, for the status bar effect). */
	let shown = $state<string | null>(null);
	/** True while a model is being switched in: its cursor moves are not navigation. */
	let switching = false;

	const path = $derived(editors.group(group)?.active ?? null);
	const isActiveGroup = $derived(editors.activeGroupId === group);

	onMount(() => {
		let disposed = false;
		import('#lib/editor/monaco.ts').then(async (m) => {
			await m.setupTextMate();
			if (disposed) return;
			api = m;
			installEditorSettings(m.monaco);
			const ed = m.monaco.editor.create(host, {
				theme: m.THEME_ID,
				automaticLayout: true,
				fontFamily: "Menlo, Monaco, 'Courier New', 'IBM Plex Sans Thai', monospace",
				fontSize: 12,
				lineHeight: 18,
				minimap: { enabled: true },
				scrollBeyondLastLine: true,
				renderLineHighlight: 'all'
			});
			const { CursorChangeReason } = m.monaco.editor;
			ed.onDidChangeCursorPosition((e) => {
				if (editors.activeGroupId !== group) return;
				editors.cursor = { line: e.position.lineNumber, column: e.position.column };
				// Go Back/Forward history: clicks, keys and reveals, not edits (paste, undo) or model loads.
				if (!switching && shown && (e.reason === CursorChangeReason.Explicit || e.reason === CursorChangeReason.NotSet))
					navigation.record({ path: shown, line: e.position.lineNumber, column: e.position.column });
			});
			ed.onDidFocusEditorText(() => editors.activateGroup(group));
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
			selectionText: () => {
				const model = editor?.getModel();
				const sel = editor?.getSelection();
				return model && sel && !sel.isEmpty() ? model.getValueInRange(sel) : '';
			},
			focus: () => editor?.focus(),
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

	// The status bar follows the active group's editor.
	$effect(() => {
		if (!isActiveGroup || !editor || !shown) return;
		const model = editor.getModel();
		if (!model) return;
		const opts = model.getOptions();
		editors.language = model.getLanguageId();
		editors.indent = opts.insertSpaces ? `Spaces: ${opts.indentSize}` : `Tab Size: ${opts.tabSize}`;
		editors.eol = model.getEOL() === '\n' ? 'LF' : 'CRLF';
		const pos = editor.getPosition();
		if (pos) {
			editors.cursor = { line: pos.lineNumber, column: pos.column };
			// A file switch (or a group becoming active) is a navigation entry, at the restored or revealed position.
			const file = shown;
			untrack(() => navigation.record({ path: file, line: pos.lineNumber, column: pos.column }));
		}
	});

	// Show the group's active tab's model, restoring its scroll and cursor.
	$effect(() => {
		const p = path;
		const ed = editor;
		if (!ed) return;
		untrack(() => {
			if (shown) saveViewState(group, shown, ed.saveViewState());
		});
		// Diff tabs are shown by DiffHost.
		if (!p || isDiffKey(p) || isNonTextEditor(p) || !api) {
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
				navigation.remove((path) => path === p);
				editors.close(p, { force: true, group });
			});
	});
</script>

<div bind:this={host} class="h-full w-full"></div>
