<script lang="ts">
	// Diff for Source Control tabs (`diff:<file>`): HEAD on the left, the working copy on the right
	// (VS Code's "file (Working Tree)" editor), and for task diff tabs (`taskdiff://`) the task's
	// fork point on the left. Read-only: edits go through the file's own tab. Mounted per editor
	// group only while that group has a diff tab open, and in the Agents layout for its diff tabs.
	// `active` is the shown tab's key; `onfail` closes it. The header has Orca's diff controls
	// (previous / next change, inline or side by side, and the diffEditor.* toggles) and the
	// review notes of the worktree: notes are added on the modified side's lines (diffNoteZones).
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import type * as Monaco from 'monaco-editor';
	import { clientLog } from '#lib/client-log.ts';
	import { diffEditorOptionsFrom, diffWraps } from '#lib/settings/mappings.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { editors } from './editors.svelte';
	import { fileOf, isDiffKey, isTaskDiffKey, parseTaskDiffKey } from './scm';
	import { scm } from './scm.svelte';
	import Icon from './Icon.svelte';
	import PopupMenu, { menuItem, menuSeparator } from './PopupMenu.svelte';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';
	import { diffNotes } from '#lib/ade/diffNotes.svelte.ts';
	import { notesOfFile } from '#lib/ade/diffNotes.ts';
	import { installDiffNotes, type DiffNotesHandle, type NoteFile } from '#lib/ade/diffNoteZones.ts';

	let { active, onfail, reportLanguage = false }: { active: string | null; onfail: (key: string) => void; reportLanguage?: boolean } = $props();
	const activeKey = $derived(active);
	let shownLanguage = $state('');

	let host: HTMLDivElement;
	let api = $state<typeof import('#lib/editor/monaco.ts') | undefined>();
	let diff = $state.raw<Monaco.editor.IStandaloneDiffEditor | undefined>();
	let notesUi: DiffNotesHandle | undefined;
	let shown: { original: Monaco.editor.ITextModel; modified: Monaco.editor.ITextModel } | undefined;
	/** The key whose models are in the editor (the zones belong to it). */
	let shownKey = $state<string | null>(null);
	let seq = 0;

	/** The worktree and file a diff key's notes belong to: the task, or the folder for Source Control diffs. */
	function noteFile(key: string | null): NoteFile | null {
		if (!key || !isDiffKey(key)) return null;
		const task = parseTaskDiffKey(key);
		return task ? { key: task.slug, file: task.rel } : { key: '', file: fileOf(key) };
	}
	const at = $derived(noteFile(activeKey));

	// This view's inline / side-by-side toggle (Orca keeps it per panel); the setting resets it.
	let sideBySide = $state<boolean | undefined>(undefined);
	let lastDefault: boolean | undefined;
	$effect(() => {
		const def = settings.get<boolean>('diffEditor.renderSideBySide');
		if (lastDefault !== undefined && def !== lastDefault) sideBySide = undefined;
		lastDefault = def;
	});
	const effectiveSide = $derived(sideBySide ?? settings.get<boolean>('diffEditor.renderSideBySide'));

	// diffEditor.* settings apply live to every diff view.
	$effect(() => {
		const opts = diffEditorOptionsFrom((id) => settings.get(id), sideBySide);
		diff?.updateOptions(opts);
	});

	onMount(() => {
		let disposed = false;
		import('#lib/editor/monaco.ts').then(async (m) => {
			await m.setupTextMate();
			if (disposed) return;
			const d = m.monaco.editor.createDiffEditor(host, {
				theme: m.THEME_ID,
				automaticLayout: true,
				readOnly: true,
				originalEditable: false,
				fontFamily: "Menlo, Monaco, 'Courier New', 'IBM Plex Sans Thai', monospace",
				fontSize: 12,
				lineHeight: 18,
				scrollBeyondLastLine: true,
				renderLineHighlight: 'all',
				...diffEditorOptionsFrom((id) => settings.get(id))
			});
			notesUi = installDiffNotes(m.monaco, d, () => noteFile(shownKey));
			d.getModifiedEditor().addAction({
				id: 'kingu.diff.addReviewNote',
				label: 'เพิ่มโน้ตรีวิว (Add Review Note)',
				contextMenuGroupId: 'navigation',
				contextMenuOrder: 0,
				run: () => notesUi?.addFromSelection()
			});
			diff = d;
			api = m;
		});
		return () => {
			disposed = true;
			notesUi?.dispose();
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
			const [orig, work] = await Promise.all([original(key, rel), workingCopy(m, rel)]);
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
			shownKey = key;
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

	// The note cards follow the notes of the shown file (and their sending state).
	const fileNotes = $derived(at ? notesOfFile(diffNotes.list(at.key), at.file) : []);
	$effect(() => {
		void shownKey;
		void fileNotes;
		for (const n of fileNotes) void diffNotes.sending[n.id];
		notesUi?.refresh();
	});

	// A note picked in the notes list: scroll to its line once its file is shown.
	$effect(() => {
		const r = diffNotes.revealRequest;
		if (!r || !notesUi || shownKey !== r.diffKey || shownKey !== activeKey) return;
		diffNotes.revealRequest = null;
		notesUi.reveal(r.line);
	});

	// The status bar language follows the active group's diff.
	$effect(() => {
		if (reportLanguage && activeKey && isDiffKey(activeKey) && shownLanguage) editors.language = shownLanguage;
	});

	const allNotes = $derived(at ? diffNotes.list(at.key) : []);
	const delivery = $derived(at ? diffNotes.delivery(at.key) : 'none');
	let menu = $state<{ kind: 'notes' | 'more'; x: number; y: number } | null>(null);
	function openMenu(kind: 'notes' | 'more', e: MouseEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		menu = { kind, x: kind === 'more' ? r.right - 248 : r.left, y: r.bottom + 2 };
	}
	const menuItems = $derived.by(() => {
		if (menu?.kind === 'more')
			return [
				menuItem('wrap', 'ตัดบรรทัด (Word Wrap)', { checked: diffWraps((id) => settings.get(id)) }),
				menuItem('hide', 'ซ่อนส่วนที่ไม่เปลี่ยน (Hide Unchanged Regions)', { checked: settings.get<boolean>('diffEditor.hideUnchangedRegions.enabled') }),
				menuItem('trim', 'ไม่นับช่องว่างหน้า/ท้ายบรรทัด (Ignore Trim Whitespace)', { checked: settings.get<boolean>('diffEditor.ignoreTrimWhitespace') })
			];
		const verb = delivery === 'none' ? 'คัดลอก' : 'ส่งถึง agent:';
		return [
			menuItem('sendFile', `${verb} โน้ตของไฟล์นี้ (${fileNotes.length})`, { enabled: fileNotes.length > 0 }),
			menuItem('sendAll', `${verb} โน้ตทั้งหมด (${allNotes.length})`, { enabled: allNotes.length > 0 }),
			menuSeparator,
			menuItem('copyAll', 'คัดลอกโน้ตทั้งหมด', { enabled: allNotes.length > 0 })
		];
	});
	function runMenu(id: string, kind: 'notes' | 'more', target: NoteFile | null) {
		const set = (k: string, v: unknown) => settings.set(k, v, 'user').catch((e) => clientLog('error', `${k}: ${e}`));
		if (kind === 'more') {
			if (id === 'wrap') void set('diffEditor.wordWrap', diffWraps((k) => settings.get(k)) ? 'off' : 'on');
			else if (id === 'hide') void set('diffEditor.hideUnchangedRegions.enabled', !settings.get<boolean>('diffEditor.hideUnchangedRegions.enabled'));
			else if (id === 'trim') void set('diffEditor.ignoreTrimWhitespace', !settings.get<boolean>('diffEditor.ignoreTrimWhitespace'));
			return;
		}
		if (!target) return;
		const list = diffNotes.list(target.key);
		if (id === 'sendFile') void diffNotes.send(target.key, notesOfFile(list, target.file));
		else if (id === 'sendAll') void diffNotes.send(target.key, list);
		else if (id === 'copyAll') void diffNotes.copy(list);
	}

	const TOOL = 'grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
</script>

<div class="flex h-full w-full flex-col">
	<div class="flex h-7 shrink-0 items-center gap-0.5 border-b border-(--vscode-editorGroupHeader-tabsBorder,var(--vscode-widget-border)) px-2 text-xs text-(--vscode-descriptionForeground)">
		{#if at}
			<button
				class="inline-flex h-5 items-center gap-1 rounded px-1.5 hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-60"
				title="โน้ตรีวิวของ {at.key ? `งาน ${at.key}` : 'โฟลเดอร์นี้'}: วางเมาส์บนบรรทัดที่เปลี่ยนแล้วกด + เพื่อเพิ่ม"
				disabled={!allNotes.length}
				onclick={(e) => openMenu('notes', e)}
			>
				<Icon name="note" size={13} /> โน้ต {allNotes.length ? `(${allNotes.length})` : ''}
			</button>
		{/if}
		<span class="flex-1"></span>
		<button class={TOOL} aria-label="การเปลี่ยนแปลงก่อนหน้า" title="การเปลี่ยนแปลงก่อนหน้า (Previous Change)" disabled={!diff} onclick={() => diff?.goToDiff('previous')}><Icon name="arrowUp" size={14} /></button>
		<button class={TOOL} aria-label="การเปลี่ยนแปลงถัดไป" title="การเปลี่ยนแปลงถัดไป (Next Change)" disabled={!diff} onclick={() => diff?.goToDiff('next')}><Icon name="arrowDown" size={14} /></button>
		<button
			class={TOOL}
			aria-label={effectiveSide ? 'แสดงแบบ inline' : 'แสดงแบบสองฝั่ง'}
			title={effectiveSide ? 'แสดงแบบ inline (Switch to Inline View)' : 'แสดงแบบสองฝั่ง (Switch to Side by Side View)'}
			onclick={() => (sideBySide = !effectiveSide)}><Icon name={effectiveSide ? 'rows' : 'columns'} size={14} /></button
		>
		<button class={TOOL} aria-label="ตัวเลือก diff" title="ตัวเลือก diff" onclick={(e) => openMenu('more', e)}><Icon name="more" size={14} /></button>
	</div>
	<div bind:this={host} class="min-h-0 flex-1"></div>
</div>

{#if menu}
	<!-- PopupMenu closes (menu = null) before it runs the item, so its kind and file are taken here. -->
	{@const kind = menu.kind}
	{@const target = at}
	<PopupMenu items={menuItems} label={kind === 'more' ? 'ตัวเลือก diff' : 'โน้ตรีวิว'} x={menu.x} y={menu.y} onRun={(node) => node.type === 'item' && runMenu(node.id, kind, target)} onClose={() => (menu = null)} />
{/if}

<style>
	:global(.kg-note-add) {
		position: absolute;
		z-index: 10;
		width: 18px;
		height: 18px;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		color: var(--vscode-button-foreground);
		background: var(--vscode-button-background);
		cursor: pointer;
	}
	:global(.kg-note-zone) {
		z-index: 5;
	}
</style>
