<script lang="ts">
	// One notebook cell's Monaco editor (VS Code's CodeCell / MarkupCell editor): as tall as its
	// content, its own undo, Escape back to command mode, ↑ on the first line / ↓ on the last moving
	// to the neighbouring cell. Typing goes into the notebook document (dirty, not on its undo stack).
	import { onMount } from 'svelte';
	import type * as Monaco from 'monaco-editor';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import type { NbCell } from './notebook';
	import type { NotebookState } from './notebookEditors.svelte';

	let { nb, cell, language, label }: { nb: NotebookState; cell: NbCell; language: string; label: string } = $props();

	let host: HTMLDivElement;
	let editor = $state<Monaco.editor.IStandaloneCodeEditor | undefined>();
	let api: typeof Monaco | undefined;
	const lineHeight = 19;
	// svelte-ignore state_referenced_locally
	let height = $state(Math.max(1, cell.source.split('\n').length) * lineHeight + 16);

	/** Edit mode moves to the cell `delta` away, its cursor at the near end. */
	function toNeighbour(delta: -1 | 1) {
		const index = nb.doc.cells.findIndex((c) => c.key === cell.key) + delta;
		const next = nb.doc.cells[index];
		if (!next) return false;
		nb.edit(next.key);
		return true;
	}

	onMount(() => {
		let gone = false;
		let model: Monaco.editor.ITextModel | undefined;
		void import('#lib/editor/monaco.ts').then(async (mod) => {
			await mod.setupTextMate();
			if (gone) return;
			const m = mod.monaco;
			api = m;
			const known = m.languages.getLanguages().some((l) => l.id === language);
			model = m.editor.createModel(cell.source, known ? language : 'plaintext', m.Uri.from({ scheme: 'notebook-cell', path: '/' + nb.path, fragment: cell.key }));
			const ed = m.editor.create(host, {
				model,
				theme: mod.THEME_ID,
				automaticLayout: true,
				ariaLabel: label,
				fontFamily: settings.get<string>('editor.fontFamily'),
				fontSize: settings.get<number>('editor.fontSize'),
				lineHeight,
				lineNumbers: nb.lineNumbers ? 'on' : 'off',
				glyphMargin: false,
				folding: false,
				lineDecorationsWidth: 8,
				lineNumbersMinChars: 3,
				minimap: { enabled: false },
				overviewRulerLanes: 0,
				hideCursorInOverviewRuler: true,
				renderLineHighlight: 'none',
				scrollBeyondLastLine: false,
				scrollbar: { vertical: 'hidden', alwaysConsumeMouseWheel: false, horizontal: 'auto' },
				wordWrap: language === 'markdown' ? 'on' : 'off',
				padding: { top: 8, bottom: 8 },
				fixedOverflowWidgets: true
			});
			editor = ed;
			ed.onDidContentSizeChange((e) => (height = e.contentHeight));
			ed.onDidChangeModelContent(() => nb.setSource(cell.key, ed.getValue()));
			ed.onDidFocusEditorText(() => {
				const index = nb.doc.cells.findIndex((c) => c.key === cell.key);
				if (index >= 0) nb.select(index);
				nb.editing = cell.key;
			});
			const plain = '!suggestWidgetVisible && !findWidgetVisible && !parameterHintsVisible && !inSnippetMode && !renameInputVisible';
			ed.addCommand(m.KeyCode.Escape, () => nb.stopEditing(), plain + ' && !hasMultipleSelections');
			ed.addCommand(
				m.KeyCode.UpArrow,
				() => {
					const pos = ed.getPosition();
					if (pos?.lineNumber === 1 && toNeighbour(-1)) return;
					ed.trigger('keyboard', 'cursorUp', null);
				},
				plain
			);
			ed.addCommand(
				m.KeyCode.DownArrow,
				() => {
					const pos = ed.getPosition();
					if (pos && pos.lineNumber === ed.getModel()?.getLineCount() && toNeighbour(1)) return;
					ed.trigger('keyboard', 'cursorDown', null);
				},
				plain
			);
			nb.cellEditors.set(cell.key, {
				focus: () => ed.focus(),
				cursorOffsets: () => (ed.getSelections() ?? []).map((s) => model!.getOffsetAt(s.getPosition()))
			});
			if (nb.editing === cell.key) ed.focus();
		});
		return () => {
			gone = true;
			nb.cellEditors.delete(cell.key);
			editor?.dispose();
			model?.dispose();
		};
	});

	// A cell op changed the source (split, join, their undo): the editor follows as an undoable edit.
	$effect(() => {
		const source = cell.source;
		const model = editor?.getModel();
		if (!model || model.getValue() === source) return;
		model.pushEditOperations([], [{ range: model.getFullModelRange(), text: source }], () => null);
	});

	$effect(() => {
		const model = editor?.getModel();
		if (model && api && model.getLanguageId() !== language) {
			const known = api.languages.getLanguages().some((l) => l.id === language);
			api.editor.setModelLanguage(model, known ? language : 'plaintext');
		}
	});

	$effect(() => {
		editor?.updateOptions({ lineNumbers: nb.lineNumbers ? 'on' : 'off', wordWrap: language === 'markdown' ? 'on' : 'off' });
	});
</script>

<div bind:this={host} class="w-full" style:height="{height}px"></div>
