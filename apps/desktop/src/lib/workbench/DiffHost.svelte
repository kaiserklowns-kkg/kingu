<script lang="ts">
	// Diff for Source Control tabs: `diff:<file>` the index on the left and the working copy on the
	// right (VS Code's "file (Working Tree)" editor), `indexdiff:<file>` HEAD ↔ index ("file
	// (Index)"), `histdiff://` a commit of the Timeline, `conflictcompare:` merge-conflict.compare;
	// and for task diff tabs (`taskdiff://`) the task's
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
	import { fileOf, isConflictCompareKey, isDiffKey, isIndexDiffKey, isTaskDiffKey, parseCommitDiffKey, parseHistoryDiffKey, parseTaskDiffKey } from './scm';
	import { compareSides } from '#lib/scm/conflicts.ts';
	import { addIndexDiffView } from '#lib/scm/quickDiff.svelte.ts';
	import { scm } from './scm.svelte';
	import Icon from './Icon.svelte';
	import PopupMenu, { menuItem, menuSeparator } from './PopupMenu.svelte';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';
	import { diffNotes } from '#lib/ade/diffNotes.svelte.ts';
	import { notesOfFile } from '#lib/ade/diffNotes.ts';
	import { installDiffNotes, type DiffNotesHandle, type NoteFile } from '#lib/ade/diffNoteZones.ts';
	import { hunkReview } from '#lib/ade/hunkReview.svelte.ts';
	import { chatEdits } from '#lib/agent/chatEdits.svelte.ts';
	import { isChatEditKey, parseChatEditKey } from '#lib/agent/chatEdits.ts';
	import { installHunkToolbars, type HunkToolbars } from '#lib/ade/hunkToolbars.ts';

	let { active, onfail, reportLanguage = false }: { active: string | null; onfail: (key: string) => void; reportLanguage?: boolean } = $props();
	const activeKey = $derived(active);
	let shownLanguage = $state('');

	let host: HTMLDivElement;
	let api = $state<typeof import('#lib/editor/monaco.ts') | undefined>();
	let diff = $state.raw<Monaco.editor.IStandaloneDiffEditor | undefined>();
	let notesUi: DiffNotesHandle | undefined;
	/** Accept / reject per hunk on task diffs (hunkReview). */
	let hunksUi: HunkToolbars | undefined;
	let detachHunks: (() => void) | undefined;
	let detachIndexDiff: (() => void) | undefined;
	let shown: { original: Monaco.editor.ITextModel; modified: Monaco.editor.ITextModel } | undefined;
	/** The key whose models are in the editor (the zones belong to it). */
	let shownKey = $state<string | null>(null);
	let seq = 0;

	/** The worktree and file a diff key's notes belong to: the task, or the folder for Source Control diffs. */
	function noteFile(key: string | null): NoteFile | null {
		if (!key || !isDiffKey(key) || isChatEditKey(key)) return null;
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
			// git.unstageSelectedRanges in a Staged Changes tab: the selected index lines.
			detachIndexDiff = addIndexDiffView({
				key: () => (shownKey && isIndexDiffKey(shownKey) ? shownKey : null),
				selections: () => (d.getModifiedEditor().getSelections() ?? []).map((s) => ({ start: s.startLineNumber, end: s.endLineNumber }))
			});
			hunksUi = installHunkToolbars(d, () => (shownKey && isTaskDiffKey(shownKey) ? shownKey : null));
			detachHunks = hunkReview.attach(hunksUi);
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
			detachHunks?.();
			detachIndexDiff?.();
			hunksUi?.dispose();
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

	/** Left side: HEAD for Source Control diffs; the task's fork point for task diffs (`taskdiff://`);
	 * the file before the agent's pending changes for a chat's working set (`chatedit://`). */
	async function original(key: string, rel: string): Promise<{ text: string; path: string }> {
		if (isChatEditKey(key)) return chatEdits.original(key);
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
		const head = async () => ({ text: await invoke<string>('git_show_head', { rel: headPath }), path: headPath });
		// Staged Changes (`indexdiff:`) compare HEAD with the index.
		if (isIndexDiffKey(key)) return head();
		// Changes (`diff:`): the index against the working tree (VS Code's "a.ts (Working Tree)");
		// an untracked file has nothing on the left, a conflicted one (no stage 0) HEAD.
		if (entry?.worktree === '?') return { text: '', path: rel };
		const index = await invoke<string | null>('scm_show_index', { rel }).catch(() => null);
		return index === null ? head() : { text: index, path: `index/${rel}` };
	}

	/** The two sides of the Source Control diff kinds that are not the working copy on the right. */
	async function sides(m: typeof import('#lib/editor/monaco.ts'), key: string, rel: string): Promise<[{ text: string; path: string }, string] | null> {
		const commit = parseCommitDiffKey(key);
		// A commit diff compares the file before and after that commit (empty when added or deleted).
		if (commit)
			return Promise.all([
				invoke<string>('git_show_ref', { slug: commit.slug || null, rev: `${commit.hash}^`, rel: commit.rel }).catch(() => '').then((text) => ({ text, path: `${commit.hash}^/${commit.rel}` })),
				invoke<string>('git_show_ref', { slug: commit.slug || null, rev: commit.hash, rel: commit.rel }).catch(() => '')
			]);
		// Timeline / file history: the commit's parent under the file's earlier name.
		const history = parseHistoryDiffKey(key);
		if (history)
			return Promise.all([
				invoke<string>('git_show_ref', { slug: null, rev: `${history.hash}^`, rel: history.before }).catch(() => '').then((text) => ({ text, path: `${history.hash}^/${history.before}` })),
				invoke<string>('git_show_ref', { slug: null, rev: history.hash, rel: history.rel }).catch(() => '')
			]);
		// Staged Changes: the index on the right.
		if (isIndexDiffKey(key)) return Promise.all([original(key, rel), invoke<string | null>('scm_show_index', { rel }).then((t) => t ?? '')]);
		// merge-conflict.compare: every conflict as its current side ↔ as its incoming side.
		if (isConflictCompareKey(key)) {
			const both = compareSides(await workingCopy(m, rel));
			return [{ text: both.current, path: `current/${rel}` }, both.incoming];
		}
		return null;
	}

	async function show(m: typeof import('#lib/editor/monaco.ts'), key: string) {
		const rel = fileOf(key);
		const my = ++seq;
		try {
			const [orig, work] = (await sides(m, key, rel)) ?? (await Promise.all([original(key, rel), workingCopy(m, rel)]));
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
			if (isTaskDiffKey(key)) void hunkReview.load(key);
			else hunksUi?.refresh();
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
		// A chat's working set changed (another edit, Keep, Undo).
		if (key && isChatEditKey(key)) void chatEdits.views[parseChatEditKey(key)?.chatId ?? ''];
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

	// The hunk toolbars follow the accepted marks of the shown task file.
	$effect(() => {
		const key = shownKey;
		const meta = key && isTaskDiffKey(key) ? hunkReview.meta(key) : undefined;
		void meta?.accepted;
		void meta?.accepted_hunks;
		void (key && hunkReview.files[key]);
		hunksUi?.refresh();
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
	:global(.kg-hunk-bars) {
		position: absolute;
		top: 0;
		left: 0;
		height: 0;
		overflow: visible;
		pointer-events: none;
	}
	:global(.kg-hunk-bar) {
		position: absolute;
		display: flex;
		align-items: center;
		gap: 2px;
		height: 18px;
		padding: 0 2px;
		border: 1px solid var(--vscode-widget-border, transparent);
		border-radius: 4px;
		font-size: 11px;
		line-height: 16px;
		color: var(--vscode-foreground);
		background: var(--vscode-editorWidget-background);
		pointer-events: auto;
		opacity: 0.55;
	}
	:global(.kg-hunk-bar:hover),
	:global(.kg-hunk-bar-current) {
		opacity: 1;
	}
	:global(.kg-hunk-bar button) {
		padding: 0 4px;
		border-radius: 3px;
		cursor: pointer;
	}
	:global(.kg-hunk-bar button:hover) {
		background: var(--vscode-toolbar-hoverBackground);
	}
	:global(.kg-hunk-bar-ok button:first-of-type) {
		color: #73c991;
	}
	:global(.kg-hunk-count) {
		padding: 0 2px;
		color: var(--vscode-descriptionForeground);
	}
	:global(.kg-hunk-current) {
		background: var(--vscode-editor-rangeHighlightBackground, rgba(255, 255, 255, 0.04));
	}
	:global(.kg-hunk-current-gutter) {
		border-left: 2px solid var(--vscode-focusBorder);
	}
	:global(.kg-hunk-accepted-gutter) {
		border-left: 2px solid #73c991;
	}
</style>
