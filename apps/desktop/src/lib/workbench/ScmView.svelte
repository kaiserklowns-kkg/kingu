<script lang="ts">
	// Source Control view (VS Code scmViewPane): commit input, the action button (Commit, Publish
	// Branch or Sync Changes), then the "Staged Changes", "Changes" and "Untracked Changes" groups as
	// a list or a tree. Clicking a file opens its diff against HEAD. VS Code's scm.* and git.* view
	// settings apply (scmSettings.ts).
	import FileIcon from './FileIcon.svelte';
	import Icon, { type IconName } from './Icon.svelte';
	import { fileIcon, folderIcon } from './fileIcons';
	import { editors } from './editors.svelte';
	import { keyLabel } from './keys';
	import { diffKey as headDiffKey, indexDiffKey, mergeKey, splitPath, type Resource, type ScmSource } from './scm';
	import { ask } from './messageBox';
	import { invoke } from '@tauri-apps/api/core';
	import { hasConflictMarkers } from '#lib/scm/conflicts.ts';
	import { t } from '#lib/i18n/index.ts';
	import { scm as folderScm } from './scm.svelte';
	import { actionButton, actionButtonFlags, commitMessageWarnings, inputFontFamily, resourceTree, sortResources, type SortKey } from './scmSettings';
	import { repoDialog } from './repoDialog.svelte.ts';
	import { appMode } from './mode.svelte';
	import { commands } from './commands.svelte';
	import { changesKey } from './viewers';
	import { adeLayout } from '#lib/ade/adeLayout.svelte.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { workspace } from './workspace.svelte.ts';

	/**
	 * `source`: another repository than the open folder's (a task worktree in the ADE's right side
	 * bar); `diffKey` / `fileKey` then name its diff and file tabs.
	 */
	let {
		source,
		diffKey = headDiffKey,
		fileKey = (rel: string) => rel
	}: { source?: ScmSource; diffKey?: (rel: string) => string; fileKey?: (rel: string) => string } = $props();
	const scm = $derived(source ?? folderScm);

	type GroupId = 'merge' | 'staged' | 'changes' | 'untracked';
	type Confirm = { key: string; paths: string[]; untracked: boolean; text: string };

	let open = $state({ merge: true, staged: true, changes: true, untracked: true });
	let selected = $state<string | null>(null);
	let confirming = $state<Confirm | null>(null);
	let collapsed = $state(new Set<string>());
	let input: HTMLTextAreaElement | undefined = $state();

	$effect(() => {
		void scm.refresh();
	});

	const mac = keyLabel('cmd+a').startsWith('⌘');
	const commitKey = mac ? '⌘Enter' : 'Ctrl+Enter';
	const placeholder = $derived(`Message (${commitKey} to commit on '${scm.repo?.branch ?? scm.repo?.head ?? 'HEAD'}')`);

	// scm.input*: font, size and the line counts the input grows between.
	const fontSize = $derived(settings.get<number>('scm.inputFontSize'));
	const lineHeight = $derived(Math.round(fontSize * 1.4));
	const minLines = $derived(Math.max(1, settings.get<number>('scm.inputMinLineCount')));
	const maxLines = $derived(Math.max(minLines, settings.get<number>('scm.inputMaxLineCount')));
	const fontFamily = $derived(inputFontFamily(settings.get<string>('scm.inputFontFamily'), settings.get<string>('editor.fontFamily')));

	$effect(() => {
		void scm.message;
		void lineHeight;
		if (!input) return;
		input.style.height = 'auto';
		input.style.height = `${Math.min(Math.max(input.scrollHeight, minLines * lineHeight + 8), maxLines * lineHeight + 8)}px`;
	});

	// git.inputValidation: lines over git.inputValidationLength / git.inputValidationSubjectLength.
	const warnings = $derived(
		settings.get<boolean>('git.inputValidation')
			? commitMessageWarnings(scm.message, { length: settings.get<number>('git.inputValidationLength'), subjectLength: settings.get<number | null>('git.inputValidationSubjectLength') })
			: []
	);

	function onInputKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && (mac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey) {
			e.preventDefault();
			void scm.commit();
		}
	}

	const untrackedList = $derived(scm.groups.untracked ?? []);
	// VS Code's "Merge Changes" group: conflicted files, apart from the other changes.
	const mergeList = $derived(scm.groups.changes.filter((r) => r.entry.conflict));
	const changeList = $derived(scm.groups.changes.filter((r) => !r.entry.conflict));
	const changeCount = $derived(scm.groups.staged.length + scm.groups.changes.length + untrackedList.length);
	// scm.showActionButton + git.showActionButton: Commit, else Publish Branch, else Sync Changes.
	const button = $derived(
		actionButton(
			{
				changes: changeCount,
				// A task worktree (`source`) has its own push and sync in the ADE side bar: Commit only.
				branch: source ? null : (scm.repo?.branch ?? null),
				upstream: source ? null : (scm.repo?.upstream ?? null),
				upstreamGone: scm.repo?.upstream_gone ?? false,
				remotes: scm.repo?.remotes.length ?? 0,
				ahead: scm.repo?.ahead ?? 0,
				behind: scm.repo?.behind ?? 0
			},
			actionButtonFlags(settings.get('git.showActionButton')),
			settings.get<boolean>('scm.showActionButton')
		)
	);
	const remoteCommand = (id: string) => (source ? undefined : () => commands.run(id));

	const rowKey = (r: Resource) => `${r.staged ? 's' : 'w'}:${r.entry.path}`;
	const toTrash = $derived(settings.get<boolean>('git.discardUntrackedChangesToTrash'));

	function askDiscard(key: string, resources: Resource[]) {
		const untracked = resources.some((r) => r.entry.worktree === '?');
		const paths = resources.map((r) => r.entry.path);
		const name = resources.length === 1 ? splitPath(paths[0])[0] : `${resources.length} ไฟล์`;
		const text = untracked
			? toTrash
				? `ย้าย ${name} ไปถังขยะ? ไฟล์ที่ยังไม่ track จะถูกย้ายไปถังขยะ`
				: `ลบ ${name} ถาวร? ไฟล์ที่ยังไม่ track จะถูกลบและกู้คืนไม่ได้`
			: `ทิ้งการแก้ไขใน ${name}? กู้คืนไม่ได้`;
		confirming = { key, paths, untracked, text };
	}

	async function doDiscard() {
		const c = confirming;
		confirming = null;
		if (c) await scm.discard(c.paths, c.untracked);
	}

	type Action = { icon: IconName; label: string; run: () => unknown; hidden?: boolean };

	// In the Agents layout (the folder's own Changes panel) diffs and files open as ADE tabs.
	const openKey = (key: string, preview: boolean) => (appMode.isAgents ? adeLayout.openFile(adeLayout.key, key, { preview }) : editors.open(key, { preview }));
	/** The diff a row opens: the open folder's staged files HEAD ↔ index, its changes index ↔ working tree (VS Code). */
	const diffOf = (r: Resource) => (r.staged && !source ? indexDiffKey(r.entry.path) : diffKey(r.entry.path));
	const openDiff = (r: Resource, preview: boolean) => openKey(diffOf(r), preview);
	/** The merge editor is a workbench editor (the Agents layout has no merge view). */
	const openMerge = (rel: string) => (appMode.setMode('workbench'), editors.open(mergeKey(rel), { preview: false }));
	const openFile = (rel: string, preview = false) =>
		appMode.isAgents ? adeLayout.openFile(adeLayout.key, fileKey(rel), { preview }) : editors.open(fileKey(rel), { preview });
	// git.openDiffOnClick: a click opens the diff, else the file (deleted files have only the diff).
	// A conflicted file opens itself, or the merge editor with `git.mergeEditor` (VS Code).
	const openResource = (r: Resource, preview: boolean) =>
		r.entry.conflict
			? !source && settings.get<boolean>('git.mergeEditor')
				? openMerge(r.entry.path)
				: openFile(r.entry.path, preview)
			: settings.get<boolean>('git.openDiffOnClick') || r.deleted
				? openDiff(r, preview)
				: openFile(r.entry.path, preview);

	/** Staging a conflicted file marks it resolved; VS Code asks first when it still has markers. */
	async function stageResolved(paths: string[]) {
		const marked: string[] = [];
		for (const p of paths) {
			const text = editors.textModel(p)?.getValue() ?? (await invoke<string>('read_workspace_file', { rel: p }).catch(() => ''));
			if (hasConflictMarkers(text)) marked.push(p);
		}
		if (marked.length) {
			const name = marked.length === 1 ? splitPath(marked[0])[0] : t('scmEditor.merge.nFiles', { count: marked.length });
			const ok = await ask(t('scmEditor.merge.stageWithConflicts', { name }), { title: 'Git', kind: 'warning', okLabel: t('scmEditor.merge.stageAnyway'), cancelLabel: t('common.cancel') });
			if (!ok) return;
		}
		await scm.stage(paths);
	}

	// scm.autoReveal: the row of the active editor's file is selected.
	$effect(() => {
		const active = editors.active;
		if (!active || !settings.get<boolean>('scm.autoReveal')) return;
		const all = [...scm.groups.staged, ...scm.groups.changes, ...untrackedList];
		const hit = all.find((r) => diffOf(r) === active) ?? all.find((r) => fileKey(r.entry.path) === active);
		if (hit) selected = rowKey(hit);
	});

	function rowActions(r: Resource): Action[] {
		const path = r.entry.path;
		if (r.entry.conflict)
			return [
				{ icon: 'goToFile', label: 'Open File', run: () => openFile(path), hidden: !settings.get<boolean>('git.showInlineOpenFileAction') },
				{ icon: 'merge', label: t('scmEditor.merge.resolveInEditor'), run: () => openMerge(path), hidden: !!source },
				{ icon: 'plus', label: 'Stage Changes', run: () => stageResolved([path]) }
			];
		return [
			{ icon: 'goToFile', label: 'Open File', run: () => openFile(path), hidden: r.deleted || !settings.get<boolean>('git.showInlineOpenFileAction') },
			{ icon: 'discard', label: 'Discard Changes', run: () => askDiscard(rowKey(r), [r]), hidden: r.staged },
			r.staged
				? { icon: 'minus', label: 'Unstage Changes', run: () => scm.unstage([path]) }
				: { icon: 'plus', label: 'Stage Changes', run: () => scm.stage([path]) }
		];
	}

	// scm.alwaysShowActions: inline actions without hovering.
	const actionsClass = $derived(settings.get<boolean>('scm.alwaysShowActions') ? 'flex' : 'hidden group-hover/row:flex group-focus-within/row:flex');
	const treeMode = $derived(settings.get<string>('scm.defaultViewMode') === 'tree');
	const sortKey = $derived(settings.get<SortKey>('scm.defaultViewSortKey'));

	function toggleFolder(id: GroupId, path: string) {
		const key = `${id}:${path}`;
		const next = new Set(collapsed);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		collapsed = next;
	}

	/** The rows of a group: sorted (scm.defaultViewSortKey) in list view, folders (scm.compactFolders) in tree view. */
	function rowsOf(id: GroupId, resources: Resource[]) {
		if (!treeMode) return sortResources(resources, sortKey).map((resource) => ({ kind: 'file' as const, resource, depth: 0 }));
		const mine = new Set([...collapsed].filter((k) => k.startsWith(`${id}:`)).map((k) => k.slice(id.length + 1)));
		return resourceTree(resources, { compact: settings.get<boolean>('scm.compactFolders'), collapsed: mine });
	}
</script>

{#snippet actionButtons(actions: Action[])}
	{#each actions as a (a.label)}
		{#if !a.hidden}
			<button
				aria-label={a.label}
				title={a.label}
				disabled={scm.busy}
				class="grid size-5 place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground)"
				onclick={(e) => {
					e.stopPropagation();
					void a.run();
				}}
			>
				<Icon name={a.icon} size={16} />
			</button>
		{/if}
	{/each}
{/snippet}

{#snippet confirmBox(c: Confirm)}
	<div role="alertdialog" aria-label="ยืนยันการทิ้งการแก้ไข" class="mx-2 my-1 flex flex-col gap-1.5 rounded border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) p-2">
		<p>{c.text}</p>
		<div class="flex justify-end gap-1.5">
			<button class="rounded-sm px-2 py-0.5 hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => (confirming = null)}>Cancel</button>
			<!-- svelte-ignore a11y_autofocus -->
			<button
				autofocus
				class="rounded-sm bg-(--vscode-button-background) px-2 py-0.5 text-(--vscode-button-foreground) hover:brightness-110"
				onclick={doDiscard}
			>
				{c.untracked ? (toTrash ? 'Move to Trash' : 'Delete File') : 'Discard Changes'}
			</button>
		</div>
	</div>
{/snippet}

{#snippet group(id: GroupId, title: string, resources: Resource[], actions: Action[])}
	<div class="group/header flex h-(--kg-row-height) shrink-0 items-center pr-2 font-bold text-[11px] uppercase text-(--vscode-sideBarTitle-foreground) hover:bg-(--vscode-list-hoverBackground)">
		<button class="flex h-full min-w-0 flex-1 items-center gap-0.5 pl-0.5 text-left" aria-expanded={open[id]} onclick={() => (open[id] = !open[id])}>
			<Icon name={open[id] ? 'chevronDown' : 'chevronRight'} size={16} />
			<span class="truncate">{title}</span>
		</button>
		<span class="hidden items-center gap-0.5 group-hover/header:flex group-focus-within/header:flex">{@render actionButtons(actions)}</span>
		<span class="ml-1 min-w-[18px] rounded-full bg-(--vscode-badge-background) px-1.5 text-center text-[11px] leading-[18px] font-normal text-(--vscode-badge-foreground)">{resources.length}</span>
	</div>
	{#if confirming?.key === `group:${id}`}{@render confirmBox(confirming)}{/if}
	{#if open[id]}
		{#each rowsOf(id, resources) as row (row.kind === 'file' ? rowKey(row.resource) : `d:${row.path}`)}
			{#if row.kind === 'folder'}
				{@const shut = collapsed.has(`${id}:${row.path}`)}
				<button
					class="flex h-(--kg-row-height) w-full items-center gap-1 pr-2 text-left hover:bg-(--vscode-list-hoverBackground)"
					style:padding-left="{12 + row.depth * 8}px"
					aria-expanded={!shut}
					title={row.path}
					onclick={() => toggleFolder(id, row.path)}
				>
					<Icon name={shut ? 'chevronRight' : 'chevronDown'} size={14} />
					<FileIcon icon={folderIcon(row.path, !shut)} />
					<span class="truncate">{row.label}</span>
				</button>
			{:else}
				{@const r = row.resource}
				{@const key = rowKey(r)}
				{@const [name, dir] = splitPath(r.entry.path)}
				<div
					class={[
						'group/row mx-1.5 flex h-(--kg-row-height) items-center rounded-md pr-2 leading-(--kg-row-height)',
						selected === key
							? 'bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground)'
							: editors.active === diffOf(r)
								? 'bg-(--vscode-list-inactiveSelectionBackground)'
								: 'hover:bg-(--vscode-list-hoverBackground)'
					]}
				>
					<button
						class="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
						style:padding-left="{20 + row.depth * 8 + (treeMode ? 14 : 0)}px"
						title={r.entry.orig_path ? `${r.entry.orig_path} → ${r.entry.path}` : r.entry.path}
						onclick={() => {
							selected = key;
							openResource(r, true);
						}}
						ondblclick={() => openResource(r, false)}
					>
						<FileIcon icon={fileIcon(name)} />
						<span class={['shrink-0 truncate', r.deleted && 'line-through']}>{name}</span>
						{#if dir && !treeMode}<span class="truncate text-[0.9em] text-(--vscode-descriptionForeground)">{dir}</span>{/if}
					</button>
					<span class={['shrink-0 items-center gap-0.5', actionsClass]}>{@render actionButtons(rowActions(r))}</span>
					<span class="w-4 shrink-0 text-center text-xs font-semibold" style:color={r.color} title={r.entry.conflict ? 'Conflict' : undefined}>{r.letter}</span>
				</div>
				{#if confirming?.key === key}{@render confirmBox(confirming)}{/if}
			{/if}
		{/each}
	{/if}
{/snippet}

<section class="flex min-h-0 flex-1 flex-col">
	{#if !scm.loaded}
		<p class="flex items-center gap-2 px-5 py-2 text-(--vscode-descriptionForeground)">
			<span class="size-3 animate-spin rounded-full border-2 border-current border-t-transparent"></span>กำลังอ่านสถานะ git…
		</p>
	{:else if !scm.repo && !source && folderScm.disabled}
		<p class="px-5 py-1 leading-normal text-(--vscode-descriptionForeground)">Git ถูกปิดอยู่ เปิดได้ที่การตั้งค่า git.enabled (Git is disabled.)</p>
	{:else if !scm.repo && !source && !workspace.root}
		<!-- VS Code's welcome view with no folder open. -->
		<div class="flex flex-col items-center gap-2 px-6 py-8 text-center text-(--vscode-descriptionForeground)">
			<p class="text-xs leading-relaxed">{t('scmEditor.noFolder')}</p>
			<button class="mt-1 h-[26px] w-full rounded-md bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:brightness-110" onclick={() => commands.run('workbench.action.files.openFolder')}>{t('scmEditor.openFolder')}</button>
			<button class="h-[26px] w-full rounded-md border border-(--vscode-widget-border) text-(--vscode-foreground) hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => repoDialog.show('clone')}>Clone Repository</button>
		</div>
	{:else if !scm.repo}
		<!-- VS Code's welcome view for a folder without a repository. -->
		<div class="flex flex-col items-center gap-2 px-6 py-8 text-center text-(--vscode-descriptionForeground)">
			<span class="text-(--vscode-foreground) opacity-70"><Icon name="git" size={32} /></span>
			<p class="text-(--vscode-foreground)">โฟลเดอร์นี้ยังไม่เป็น git repository</p>
			<p class="text-xs leading-relaxed">สร้าง repository เพื่อใช้ Source Control (git) ได้ หรือ clone repository จาก URL</p>
			<button
				class="mt-1 h-[26px] w-full rounded-md bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:brightness-110 disabled:opacity-50"
				disabled={folderScm.busy || !!source}
				onclick={() => folderScm.init()}
			>
				Initialize Repository
			</button>
			<button class="h-[26px] w-full rounded-md border border-(--vscode-widget-border) text-(--vscode-foreground) hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => repoDialog.show('clone')}>Clone Repository</button>
		</div>
	{:else}
		<div class="flex shrink-0 flex-col gap-1.5 px-2 pt-1 pb-2">
			{#if settings.get<boolean>('git.showCommitInput')}
				<div class="relative">
					<textarea
						bind:this={input}
						bind:value={scm.message}
						aria-label="Source Control commit message"
						{placeholder}
						rows={minLines}
						spellcheck="false"
						class={[
							'block w-full resize-none rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-1.5 py-[3px] text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground) focus:border-(--vscode-focusBorder)',
							settings.get<boolean>('scm.showInputActionButton') && 'pr-7'
						]}
						style:font-size="{fontSize}px"
						style:line-height="{lineHeight}px"
						style:font-family={fontFamily}
						style:min-height="{minLines * lineHeight + 8}px"
						style:max-height="{maxLines * lineHeight + 8}px"
						onkeydown={onInputKey}
					></textarea>
					{#if settings.get<boolean>('scm.showInputActionButton')}
						<!-- scm.showInputActionButton: VS Code's commit button inside the input. -->
						<button
							class="absolute top-1 right-1 grid size-5 place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-50"
							disabled={scm.busy}
							aria-label="Commit"
							title="Commit ({commitKey})"
							onclick={() => scm.commit()}><Icon name="check" size={16} /></button
						>
					{/if}
				</div>
				{#each warnings.slice(0, 1) as w (w.line)}
					<p class="rounded-sm border border-(--vscode-inputValidation-warningBorder,var(--vscode-editorWarning-foreground)) px-1.5 py-0.5 text-xs text-(--vscode-editorWarning-foreground)">
						บรรทัด {w.line}: {w.message}
					</p>
				{/each}
			{/if}
			{#if button}
				<button
					class="flex h-[26px] items-center justify-center gap-1 rounded-sm bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:brightness-110 disabled:opacity-50"
					disabled={scm.busy || (button.kind !== 'commit' && !remoteCommand('git.sync'))}
					title={button.kind === 'commit' ? `Commit (${commitKey})` : button.kind === 'publish' ? 'Publish Branch' : 'Synchronize Changes'}
					onclick={() => (button.kind === 'commit' ? scm.commit() : remoteCommand(button.kind === 'publish' ? 'git.publish' : 'git.sync')?.())}
				>
					{#if button.kind === 'commit'}
						<Icon name="check" size={16} />Commit
					{:else if button.kind === 'publish'}
						<Icon name="send" size={16} />Publish Branch
					{:else}
						<Icon name="refresh" size={16} />Sync Changes {button.behind}↓ {button.ahead}↑
					{/if}
				</button>
			{/if}
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto" style:scroll-behavior="var(--kg-list-scroll-behavior, auto)">
			{#if mergeList.length}
				{@render group('merge', 'Merge Changes', mergeList, [{ icon: 'plus', label: 'Stage All Merge Changes', run: () => stageResolved(mergeList.map((r) => r.entry.path)) }])}
			{/if}
			{#if scm.groups.staged.length || settings.get<boolean>('git.alwaysShowStagedChangesResourceGroup')}
				{@render group('staged', 'Staged Changes', scm.groups.staged, [
					{ icon: 'minus', label: 'Unstage All Changes', run: () => scm.unstage(scm.groups.staged.map((r) => r.entry.path)), hidden: !scm.groups.staged.length }
				])}
			{/if}
			{@render group('changes', 'Changes', changeList, [
				{ icon: 'files', label: 'ดูการเปลี่ยนแปลงทั้งหมดในหน้าเดียว', run: () => (appMode.setMode('workbench'), editors.open(changesKey(), { preview: false })), hidden: !scm.groups.changes.length && !scm.groups.staged.length },
				{ icon: 'discard', label: 'Discard All Changes', run: () => askDiscard('group:changes', changeList), hidden: !changeList.length },
				{ icon: 'plus', label: 'Stage All Changes', run: () => scm.stage(changeList.map((r) => r.entry.path)), hidden: !changeList.length }
			])}
			{#if untrackedList.length}
				{@render group('untracked', 'Untracked Changes', untrackedList, [
					{ icon: 'discard', label: 'Discard All Untracked Changes', run: () => askDiscard('group:untracked', untrackedList) },
					{ icon: 'plus', label: 'Stage All Untracked Changes', run: () => scm.stage(untrackedList.map((r) => r.entry.path)) }
				])}
			{/if}
		</div>
	{/if}
</section>
