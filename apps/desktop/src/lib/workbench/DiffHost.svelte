<script lang="ts">
	// Side-by-side diff for Source Control tabs (`diff:<file>`): HEAD on the left, the working
	// copy on the right (VS Code's "file (Working Tree)" editor). Read-only: edits go through the
	// file's own tab. Mounted per editor group only while that group has a diff tab open, and in
	// the Agents layout for its diff tabs. `active` is the shown tab's key; `onfail` closes it.
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import type * as Monaco from 'monaco-editor';
	import { clientLog } from '#lib/client-log.ts';
	import { editors } from './editors.svelte';
	import { fileOf, isDiffKey, isTaskDiffKey, parseCommitDiffKey, parseTaskDiffKey } from './scm';
	import { scm } from './scm.svelte';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';

	let { active, onfail, reportLanguage = false }: { active: string | null; onfail: (key: string) => void; reportLanguage?: boolean } = $props();
	const activeKey = $derived(active);
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

	/** Left side: HEAD for Source Control diffs; the task's fork point for task diffs (`taskdiff://`). */
	async function original(key: string, rel: string): Promise<{ text: string; path: string }> {
		if (isTaskDiffKey(key)) {
			let base = adeTasks.diffBase(key);
			if (!base) {
				const slug = parseTaskDiffKey(key)?.slug;
				if (slug) await adeTasks.refreshStat(slug);
				base = adeTasks.diffBase(key);
			}
			if (!base) throw new Error('task has no diff base');
			const text = await invoke<string>('git_show_ref', { slug: base.slug, rev: base.rev, rel: base.orig });
			return { text, path: `${base.slug}/${base.orig}` };
		}
		// A rename diffs against the source's HEAD contents.
		const entry = scm.repo?.entries.find((e) => e.path === rel);
		const headPath = entry?.orig_path ?? rel;
		return { text: await invoke<string>('git_show_head', { rel: headPath }), path: headPath };
	}

	async function show(m: typeof import('#lib/editor/monaco.ts'), key: string) {
		const rel = fileOf(key);
		const my = ++seq;
		try {
			const commit = parseCommitDiffKey(key);
			// A commit diff compares the file before and after that commit (empty when added or deleted).
			const [orig, work] = commit
				? await Promise.all([
						invoke<string>('git_show_ref', { slug: commit.slug || null, rev: `${commit.hash}^`, rel: commit.rel }).catch(() => '').then((text) => ({ text, path: `${commit.hash}^/${commit.rel}` })),
						invoke<string>('git_show_ref', { slug: commit.slug || null, rev: commit.hash, rel: commit.rel }).catch(() => '')
					])
				: await Promise.all([original(key, rel), workingCopy(m, rel)]);
			const head = orig.text;
			const headPath = orig.path;
			if (my !== seq || !diff || active !== key) return;
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
			onfail(key);
		}
	}

	// Re-read when a diff tab becomes active and whenever git status changes (save, focus, stage).
	$effect(() => {
		const key = activeKey;
		void scm.repo;
		if (key && isTaskDiffKey(key)) void adeTasks.stats[parseTaskDiffKey(key)?.slug ?? ''];
		if (api && key && isDiffKey(key)) void show(api, key);
	});

	// The status bar language follows the active group's diff.
	$effect(() => {
		if (reportLanguage && activeKey && isDiffKey(activeKey) && shownLanguage) editors.language = shownLanguage;
	});
</script>

<div bind:this={host} class="h-full w-full"></div>
