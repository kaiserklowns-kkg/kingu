<script lang="ts">
	// One Monaco editor, one text model per open tab (VS Code keeps a model per resource, so
	// switching tabs preserves undo history and cursor). Saves through Rust `fs_write_file`.
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import type * as Monaco from 'monaco-editor';
	import { clientLog } from '#lib/client-log.ts';
	import { commands } from './commands.svelte';
	import { editors } from './editors.svelte';
	import { quick } from './quick.svelte';
	import { isDiffKey } from './scm';

	type Entry = { model: Monaco.editor.ITextModel; savedVersion: number; view?: Monaco.editor.ICodeEditorViewState | null };

	let host: HTMLDivElement;
	let api: typeof import('#lib/editor/monaco.ts') | undefined;
	let editor = $state<Monaco.editor.IStandaloneCodeEditor | undefined>();
	const models = new Map<string, Entry>();
	let shownPath: string | null = null;

	onMount(() => {
		let disposed = false;
		import('#lib/editor/monaco.ts').then(async (m) => {
			await m.setupTextMate();
			if (disposed) return;
			api = m;
			editor = m.monaco.editor.create(host, {
				theme: m.THEME_ID,
				automaticLayout: true,
				fontFamily: "Menlo, Monaco, 'Courier New', 'IBM Plex Sans Thai', monospace",
				fontSize: 12,
				lineHeight: 18,
				minimap: { enabled: true },
				scrollBeyondLastLine: true,
				renderLineHighlight: 'all'
			});
			editor.onDidChangeCursorPosition((e) => (editors.cursor = { line: e.position.lineNumber, column: e.position.column }));
			clientLog('info', 'editor ready');
		});

		const unregister = [
			commands.register({
				id: 'workbench.action.files.save',
				title: 'Save',
				category: 'File',
				key: 'cmd+s',
				when: () => editors.active !== null,
				run: save
			}),
			commands.register({
				id: 'workbench.action.gotoLine',
				title: 'Go to Line/Column...',
				key: 'ctrl+g',
				when: () => editors.active !== null,
				run: () => quick.show(':')
			})
		];

		return () => {
			disposed = true;
			unregister.forEach((u) => u());
			for (const e of models.values()) e.model.dispose();
			editor?.dispose();
		};
	});

	editors.gotoLine = (line: number, column = 1) => {
		if (!editor) return;
		editor.revealLineInCenter(line);
		editor.setPosition({ lineNumber: line, column });
		editor.focus();
	};

	async function entryFor(path: string): Promise<Entry | undefined> {
		const existing = models.get(path);
		if (existing || !api) return existing;
		const text = await invoke<string>('read_workspace_file', { rel: path });
		const model = api.monaco.editor.createModel(text, api.languageFor(path), api.monaco.Uri.file('/' + path));
		const entry: Entry = { model, savedVersion: model.getAlternativeVersionId() };
		model.onDidChangeContent(() => editors.setDirty(path, model.getAlternativeVersionId() !== entry.savedVersion));
		models.set(path, entry);
		return entry;
	}

	async function save() {
		const path = editors.active;
		const entry = path ? models.get(path) : undefined;
		if (!path || !entry) return;
		await invoke('fs_write_file', { rel: path, content: entry.model.getValue() });
		entry.savedVersion = entry.model.getAlternativeVersionId();
		editors.setDirty(path, false);
	}

	// Show the active tab's model, restoring its scroll and cursor.
	$effect(() => {
		const path = editors.active;
		if (!editor) return;
		if (shownPath) {
			const prev = models.get(shownPath);
			if (prev) prev.view = editor.saveViewState();
		}
		// Diff tabs are shown by DiffHost.
		if (!path || isDiffKey(path)) {
			editor.setModel(null);
			shownPath = null;
			return;
		}
		entryFor(path)
			.then((entry) => {
				if (!entry || editors.active !== path || !editor) return;
				editor.setModel(entry.model);
				if (entry.view) editor.restoreViewState(entry.view);
				shownPath = path;
				editors.language = entry.model.getLanguageId();
				editors.indent = entry.model.getOptions().insertSpaces ? `Spaces: ${entry.model.getOptions().indentSize}` : 'Tab Size: ' + entry.model.getOptions().tabSize;
				editors.eol = entry.model.getEOL() === '\n' ? 'LF' : 'CRLF';
				clientLog('info', `opened ${path} as ${editors.language} (${entry.model.getLineCount()} lines)`);
			})
			.catch((e) => {
				clientLog('error', `open ${path}: ${e}`);
				editors.close(path, { force: true });
			});
	});

	// Dispose models of closed tabs.
	$effect(() => {
		const open = new Set(editors.tabs.map((t) => t.path));
		for (const [path, entry] of models) {
			if (!open.has(path)) {
				entry.model.dispose();
				models.delete(path);
			}
		}
	});
</script>

<div bind:this={host} class="h-full w-full"></div>
