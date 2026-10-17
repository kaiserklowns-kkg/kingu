<script lang="ts">
	// Side-by-side diff for Source Control tabs (`diff:<file>`): HEAD on the left, the working
	// copy on the right (VS Code's "file (Working Tree)" editor). Read-only: edits go through the
	// file's own tab. Mounted per editor group only while that group has a diff tab open.
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import type * as Monaco from 'monaco-editor';
	import { clientLog } from '#lib/client-log.ts';
	import { editors } from './editors.svelte';
	import { fileOf, isDiffKey } from './scm';
	import { scm } from './scm.svelte';

	let { group }: { group: number } = $props();
	const activeKey = $derived(editors.group(group)?.active ?? null);
	let shownLanguage = $state('');

	let host: HTMLDivElement;
	let api = $state<typeof import('#lib/editor/monaco.ts') | undefined>();
	let diff: Monaco.editor.IStandaloneDiffEditor | undefined;
	let shown: { original: Monaco.editor.ITextModel; modified: Monaco.editor.ITextModel } | undefined;
	let seq = 0;

	onMount(() => {
		let disposed = false;
		import('#lib/editor/monaco.ts').then(async (m) => {
			await m.setupTextMate();
			if (disposed) return;
			diff = m.monaco.editor.createDiffEditor(host, {
				theme: m.THEME_ID,
				automaticLayout: true,
				renderSideBySide: true,
				readOnly: true,
				originalEditable: false,
				fontFamily: "Menlo, Monaco, 'Courier New', 'IBM Plex Sans Thai', monospace",
				fontSize: 12,
				lineHeight: 18,
				scrollBeyondLastLine: true,
				renderLineHighlight: 'all'
			});
			api = m;
		});
		return () => {
			disposed = true;
			diff?.dispose();
			shown?.original.dispose();
			shown?.modified.dispose();
		};
	});

	/** Working copy: the open tab's text (unsaved edits included), else the file on disk, else empty (deleted). */
	async function workingCopy(m: typeof import('#lib/editor/monaco.ts'), rel: string): Promise<string> {
		const open = m.monaco.editor.getModel(m.monaco.Uri.file('/' + rel));
		if (open) return open.getValue();
		return invoke<string>('read_workspace_file', { rel }).catch(() => '');
	}

	async function show(m: typeof import('#lib/editor/monaco.ts'), key: string) {
		const rel = fileOf(key);
		const my = ++seq;
		// A rename diffs against the source's HEAD contents.
		const entry = scm.repo?.entries.find((e) => e.path === rel);
		const headPath = entry?.orig_path ?? rel;
		try {
			const [head, work] = await Promise.all([invoke<string>('git_show_head', { rel: headPath }), workingCopy(m, rel)]);
			if (my !== seq || !diff || editors.group(group)?.active !== key) return;
			const language = m.languageFor(rel);
			// Fresh URIs each time: the old pair is disposed only after the new one is shown.
			const next = {
				original: m.monaco.editor.createModel(head, language, m.monaco.Uri.from({ scheme: 'git-head', path: '/' + headPath, query: String(my) })),
				modified: m.monaco.editor.createModel(work, language, m.monaco.Uri.from({ scheme: 'git-working', path: '/' + rel, query: String(my) }))
			};
			const same = shown && shown.modified.uri.path === next.modified.uri.path;
			const view = same ? diff.saveViewState() : null;
			diff.setModel(next);
			if (view) diff.restoreViewState(view);
			shown?.original.dispose();
			shown?.modified.dispose();
			shown = next;
			shownLanguage = language;
		} catch (e) {
			clientLog('error', `diff ${rel}: ${e}`);
			editors.close(key, { force: true, group });
		}
	}

	// Re-read when a diff tab becomes active and whenever git status changes (save, focus, stage).
	$effect(() => {
		const key = activeKey;
		void scm.repo;
		if (api && key && isDiffKey(key)) void show(api, key);
	});

	// The status bar language follows the active group's diff.
	$effect(() => {
		if (editors.activeGroupId === group && activeKey && isDiffKey(activeKey) && shownLanguage) editors.language = shownLanguage;
	});
</script>

<div bind:this={host} class="h-full w-full"></div>
